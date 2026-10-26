/**
 * dsh-pet-voice — 把 DSH 变成手机端可语音唤醒的「随身宠物」。
 *
 * 形态：一个只在宿主侧运行的插件，往 harness 的 webServer 上注册三段路由：
 *
 *   GET  /pet-voice/?k=<token>   一次性取出访问 cookie，然后 303 到干净 URL
 *   GET  /pet-voice/             宠物页（像素鲸鱼娘 + 语音 + 项目切换）
 *   *    /pet-voice/assets/*     静态资源（页面自己的 js/css/图标）
 *   *    /pet-voice/api/*        JSON + SSE 接口（cookie 鉴权）
 *
 * 为什么走自己的路由而不是改官方 UI：手机端要的是「全屏宠物 + 唤醒词 + 说话」，
 * 官方页面是给桌面键盘用的。密码/公网暴露面由 token + cookie 控制；同一台机器
 * 上还开着 cloudflared 之类的隧道时，手机就能用 https 打开这个页面。
 *
 * 宿主能力全部走已存在的服务，本插件不复制任何编排逻辑：
 *   webServer           注册路由
 *   sessionController   create / prompt / cancel（官方 @Remote 面，UI 用的就是它）
 *   workspaceRegistry   项目（workspace）列表，用来做「切到某个项目去干活」
 *   agentPresets        人设（agent preset）列表，用来复用现有角色
 *   agent/assistant-stream  助理文本增量，转成 SSE 推给手机做流式 TTS
 *
 * @module dsh-pet-voice
 */

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, extname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
/** zstd 解压：Node 22.15 / 23.8 才加了 zstdDecompressSync。
 *
 * 这里不用静态 import：Node 20 上静态导入会在**加载插件时**直接抛
 * `SyntaxError: The requested module 'node:zlib' does not provide an export named
 * 'zstdDecompressSync'`，整个插件都装不上，面板/语音一起没了。改成可选加载后，
 * 老 Node 上插件照常工作，只是「读会话转录」这类功能降级（面板会提示）。
 */
let zstdDecompressSync = null
try {
  ;({ zstdDecompressSync } = await import('node:zlib'))
} catch {
  zstdDecompressSync = null
}
import { getPanelConfig, normalizeTransport, panelState, qrSvg, setPanelConfig, removeDevice, clearDevices, touchDevice } from './panel.mjs'
import { connectPublic, disconnectPublic, publicState, setPublicConfig, stopPublic } from './public.mjs'
import { startLan, lanState, stopLan } from './lan.mjs'

/** 插件名，必须等于 bundle patch 里的插入 id。 */
export const name = 'dsh-pet-voice'

/**
 * `webServer` 是硬依赖：没有它这个插件没有任何意义。
 * 其余服务（sessionController / workspaceRegistry / agentPresets）用
 * `ctx.get()` 惰性取，缺失时接口返回可读的降级信息，而不是让整个插件起不来。
 */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(HERE, 'public')
const HOME_DIR = join(homedir(), '.dsh', 'pet-voice')
const TOKEN_PATH = join(HOME_DIR, 'token')
const STATE_PATH = join(HOME_DIR, 'state.json')
/** 小爱专用会话（钉死在某个项目里，见 ensurePetSession）。 */
const PET_SESSION_PATH = join(HOME_DIR, 'pet-session.json')
/** 单测用 DSH_PET_VOICE_PET_SESSION 指到临时文件，别动用户真正的专属会话绑定。 */
const petSessionFile = () => process.env.DSH_PET_VOICE_PET_SESSION || PET_SESSION_PATH

/**
 * 宿主自己的会话落盘目录（只读）。
 *
 * App 的「浏览项目 / 会话」需要看到桌面端的全部历史，这些数据不由本插件产生，
 * 也不该由本插件写：`sessions/` 是转录（多帧 zstd 拼接的 JSONL），
 * `session_projcache/` 是宿主算好的会话投影（标题 / 轮数 / goal）。宿主没有
 * sessionQuery 之类的只读服务时，这里就是唯一可信来源；所有读取都做容错，
 * 坏了当「没有」，绝不让接口 500。
 */
const DSH_HOME = join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const PROJCACHE_DIR = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
/** 单条消息 / 工具参数的截断长度：手机屏幕放不下更长内容，也保护响应体积。 */
const MESSAGE_TEXT_LIMIT = 4000
const TOOL_ARGS_LIMIT = 300
const REASONING_PREVIEW_LIMIT = 200
/** 列表分页：默认 20，最多 50（和 App 的契约一致）。 */
const SESSION_LIMIT_DEFAULT = 20
const SESSION_LIMIT_MAX = 50
/** 单次响应允许的 JSON 体积上限（契约要求 ≤200 KB，这里留一点余量）。 */
const BROWSE_RESPONSE_LIMIT = 190 * 1024
/** 超大转录只读尾部；更老的内容按「没有更多」处理，避免一次读几十 MB。 */
const TRANSCRIPT_READ_LIMIT = 32 * 1024 * 1024

const BASE = '/pet-voice'
const API = `${BASE}/api`
const ASSET = `${BASE}/assets`

const TTS_DIR = join(HERE, 'tts')
const TTS_SCRIPT = join(TTS_DIR, 'stream.py')
const TTS_VENV = join(HOME_DIR, 'tts-venv')
const TTS_PYTHON = join(TTS_VENV, 'bin', 'python')

/**
 * 可选音色白名单（edge-tts 的 zh-CN 神经音色）。只允许这里列出的 id 进子进程，
 * 前端的 `<select>` 也只从 `/api/tts/voices` 取，两处同源。
 */
const TTS_VOICES = [
  { id: 'zh-CN-XiaoyiNeural', label: '小艺 · 活泼少女（默认）' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温暖自然' },
  { id: 'zh-CN-XiaochenNeural', label: '晓辰 · 亲和' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱 · 沉稳' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨 · 故事感' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北话' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西话' },
]
const TTS_DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'

/**
 * 形象档位（页面上「音色」下拉用）：每档 = 音色 + 语速 + 音高，一键切「说话的味道」。
 * 全部落在上面白名单里的真实 zh-CN 女声——2026-10-24 用
 * `edge_tts.list_voices()` 核过，zh-CN 女声只有 Xiaoxiao(Warm) / Xiaoyi(Lively) /
 * Xiaobei / Xiaoni 四个，所以四档是这两只音色×四种韵律（不是八个音色）。
 */
const TTS_PRESETS = [
  { id: 'whale', label: '鲸灵 · 清亮少女（默认）', voice: 'zh-CN-XiaoyiNeural', rate: '+6%', pitch: '+8Hz' },
  { id: 'genki', label: '元气 · 语速快、调门高', voice: 'zh-CN-XiaoyiNeural', rate: '+16%', pitch: '+22Hz' },
  { id: 'gentle', label: '温柔 · 慢一点、低一点', voice: 'zh-CN-XiaoxiaoNeural', rate: '-4%', pitch: '-4Hz' },
  { id: 'cool', label: '清冷 · 更慢、更低', voice: 'zh-CN-XiaoxiaoNeural', rate: '-10%', pitch: '-12Hz' },
  { id: 'sweet', label: '软糯 · 更高更慢（撒娇）', voice: 'zh-CN-XiaoyiNeural', rate: '-6%', pitch: '+24Hz' },
  { id: 'dongbei', label: '东北俏皮 · 自带喜感', voice: 'zh-CN-liaoning-XiaobeiNeural', rate: '+10%', pitch: '+10Hz' },
]
const TTS_DEFAULT_PRESET = 'whale'
const TTS_MAX_CHARS = 600

/* ------------------------------------------------------------------ */
/* 本机语音识别（whisper worker）                                       */
/* ------------------------------------------------------------------ */

/**
 * 手机端语音输入的识别放在本机做：不联网、不烧云端额度，而且「鲸灵」这种自造词
 * 只有靠 initial_prompt 才能稳定认出来。模型常驻在一个独立 worker 进程里
 * （scripts/asr-worker.py，只监听 127.0.0.1:52399），插件只做转发 + 懒启动。
 *
 * 为什么不让每个请求 spawn 一次 python：base 模型加载 + torch 初始化实测 2.4 s，
 * 而一次识别只要 0.27 s —— 每次重载等于把延迟放大一个数量级。所以 worker 常驻，
 * 插件重启/页面刷新都不杀它（与宿主生命周期解耦，日志和 pid 都落在 asr/ 下）。
 */
const ASR_DIR = join(HOME_DIR, 'asr')
const ASR_VENV = join(HOME_DIR, 'asr-venv')
const ASR_PYTHON = join(ASR_VENV, 'bin', 'python')
/**
 * worker 脚本找两处：插件自带目录（单独拷插件安装时可用）→ 仓库根 scripts/。
 * 两处都没有时 asrReady() 为 false，接口回 503 + 可读 hint，而不是把插件拖垮。
 */
const ASR_SCRIPT_CANDIDATES = [
  join(HERE, 'asr', 'asr-worker.py'),
  join(HERE, '..', '..', 'scripts', 'asr-worker.py'),
]
const ASR_HOST = '127.0.0.1'
const ASR_PORT = Number(process.env.DSH_PET_ASR_PORT || 52399)
const ASR_ENDPOINT = `http://${ASR_HOST}:${ASR_PORT}`
const ASR_MODEL = 'large-v3-turbo'
const ASR_LOG_PATH = join(ASR_DIR, 'worker.log')
const ASR_PID_PATH = join(ASR_DIR, 'worker.pid')
/** 10 s 的 16k/16bit 单声道只有 320 KB；4 MB 是给坏客户端的护栏，不是给正常请求的。 */
const ASR_MAX_BYTES = 4 * 1024 * 1024

/**
 * 图片上传（手机拍照/相册直接发原图给电脑，模型再用 read 工具看）。
 * 类型白名单只有四种，扩展名**只由 content-type 决定**：用户传的 ?name= 只当
 * 人类可读前缀，绝不能让 `..%2f` 之类的东西决定落盘路径。
 */
const UPLOAD_MAX_BYTES = 12 * 1024 * 1024
const UPLOAD_MAX_ATTACHMENTS = 6
const UPLOAD_DIR_NAME = '.pet-uploads'
const UPLOAD_EXTS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const UPLOAD_EXT_LIST = 'JPG / PNG / WebP / GIF'
/** 冷启动预算：base 实测 2.4 s（含 torch import）；large-v3-turbo 光载权重就要 5.1 s。 */
/**
 * 冷启动总预算。large-v3-turbo 首次载入实测 187 s（缓存命中约 6 s），
 * 所以这个数必须按「最慢一次」给；进程在后台慢慢载，请求侧另用短预算，不等这么久。
 */
const ASR_COLD_START_MS = 240000
/** 启动锁：跨插件实例（热重载会同时存在两个模块）串行化，防三个 4 GB worker 一起抢内存。 */
const ASR_START_LOCK_PATH = join(ASR_DIR, 'start.lock')
/** 锁超过这个时间还没释放、进程也没了，就当上次启动被强杀，允许接手。 */
const ASR_START_LOCK_TTL_MS = 300000
/** 请求侧最多等这么久看它起没起来，超了就先回「还在准备」，让 App 立刻给用户回话。 */
const ASR_START_WAIT_MS = 15000
const ASR_HEALTH_TIMEOUT = 1500
const ASR_REQUEST_TIMEOUT = 30_000
/** 一次 /api/asr 从头到尾的总预算：冷启动 + 重试都算在内，别让 App 干等两分钟。 */
const ASR_HANDLE_BUDGET_MS = 45_000
/** 预热节流：state 每 20 s 拉一次，别每次都去碰 worker。 */
let asrWarmAt = 0

/* ------------------------------------------------------------------ */
/* APK 自动更新通道                                                     */
/* ------------------------------------------------------------------ */

/**
 * 发布目录 `~/.dsh/pet-voice/update/` 里放 `<file>.apk` + `latest.json`，
 * 由 scripts/publish-apk.mjs 原子写入。插件只读，开两个出口：
 *   GET /pet-voice/api/update             App 问「有没有新版」
 *   GET /pet-voice/download/<file>.apk    真下载（同样 cookie 鉴权）
 *
 * 为什么下载也要鉴权：公网隧道上任何不鉴权的文件直链都等于把机器上的文件服务暴露出去，
 * 而且 APK 的更新地址本身也不该让路人拿到。Range 必须支持：手机会断点重试。
 */
const UPDATE_DIR = process.env.DSH_PET_UPDATE_DIR || join(HOME_DIR, 'update')
const UPDATE_META_PATH = join(UPDATE_DIR, 'latest.json')
/**
 * 客户端诊断日志：手机端安装/启动失败时回传一行原因，落在 logs/client.log。
 * 没有它，「安装失败」这四个字只能靠用户截图，永远猜不到是签名、权限还是系统拦截。
 * 只留最近 200 KB，写失败绝不影响主流程。
 */
const CLIENT_LOG_DIR = join(HOME_DIR, 'logs')
const CLIENT_LOG_PATH = join(CLIENT_LOG_DIR, 'client.log')
const CLIENT_LOG_MAX = 200 * 1024

/**
 * 识别链路日志：`logs/asr.log` 记每次识别（字节数/耗时/回声判定/文本），
 * `logs/turn.log` 记每次派发的结局。手机端「乱码」「没收到回复」这类问题，
 * 事后只能靠这两份现场记录复盘——之前只有内存里的 /api/diag，重启就没了。
 */
const ASR_FLOW_LOG_PATH = join(CLIENT_LOG_DIR, 'asr.log')
const TURN_LOG_PATH = join(CLIENT_LOG_DIR, 'turn.log')
const FLOW_LOG_MAX = 512 * 1024
function flowLog(path, line) {
  try {
    const flat = String(line).replace(/[\r\n]+/g, ' ')
    mkdirSync(CLIENT_LOG_DIR, { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${flat}\n`)
    if (statSync(path).size > FLOW_LOG_MAX) {
      writeFileSync(path, readFileSync(path, 'utf8').slice(-FLOW_LOG_MAX / 2))
    }
  } catch {
    /* 写日志不许影响识别 */
  }
}

/** 只认 update 目录里的 APK 文件名：没有 `/`、不以 `.` 开头，天然挡掉路径穿越。 */
const APK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/i
const APK_MIME = 'application/vnd.android.package-archive'
const DOWNLOAD = `${BASE}/download`

const LOG = (...args) => console.log('[pet-voice]', ...args)

// 送达链路诊断：只留在内存里，供 /api/diag 一次取回。手机端「没收到回复」时
// 只有这里有证据：谁连上了 stream、活了多久、poll 取到几帧、dispatch 落给谁。
// 热重载会重新求值本模块，但宿主里可能还留着上一实例注册的路由；两个实例各有一份
// streams/buffers 时，手机会话订阅在新实例、派发却落到旧实例，于是「电脑回了、手机没收到」。
// 所有跨实例必须共享的状态都挂到 globalThis 上，谁处理请求都写同一份。
const SHARED = (globalThis[Symbol.for('dsh.pet-voice.shared')] ||= {
  streams: new Map(),
  buffers: new Map(),
  netLog: [],
  dispatchSeen: new Map(),
})
const DISPATCH_SEEN = SHARED.dispatchSeen
const NET_LOG = SHARED.netLog
const NET_LOG_MAX = 400
function netLog(ev, extra = {}) {
  try {
    NET_LOG.push({ t: Date.now(), ev, ...extra })
    if (NET_LOG.length > NET_LOG_MAX) NET_LOG.splice(0, NET_LOG.length - NET_LOG_MAX)
  } catch {
    /* 诊断不能影响主链路 */
  }
}

/**
 * 最近播报过的句子。
 *
 * 手机外放播报时，麦克风会把自己的声音录回来；识别出来就是「用户把助手刚说的话又说了一遍」，
 * 再派发一次，助手就开始自问自答。线上真出现过整段对话都是助手台词的回音。
 * 播报过的句子留 5 分钟，识别结果与它高度重合就当回声丢掉（回空文本，App 按「没听到」处理）。
 */
const RECENT_TTS = (SHARED.recentTts ||= [])
const RECENT_TTS_MAX = 16
const RECENT_TTS_TTL = 5 * 60 * 1000
/** 双字重合度阈值：识别回声会有错字，完全相等判不了。 */
const ECHO_DICE = 0.55
/** 太短的句子不判：用户真的会说「好的」，不能当回声吞掉。 */
const ECHO_MIN_CHARS = 6

function rememberTtsText(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return
  RECENT_TTS.push({ text: clean, dense: speechDense(clean), at: Date.now() })
  while (RECENT_TTS.length > RECENT_TTS_MAX) RECENT_TTS.shift()
}

const CN_DIGIT = '零一二三四五六七八九'

/** 去标点、去空白，阿拉伯数字折成中文数字：识别结果和播报原文的标点、数字形态都对不上。 */
function speechDense(text) {
  return String(text ?? '')
    .replace(/[\s\p{P}\p{S}_]+/gu, '')
    .replace(/[0-9]/g, (digit) => CN_DIGIT[Number(digit)])
}

function bigramCounts(dense) {
  const counts = new Map()
  for (let i = 0; i + 1 < dense.length; i += 1) {
    const gram = dense.slice(i, i + 2)
    counts.set(gram, (counts.get(gram) || 0) + 1)
  }
  return counts
}

function diceSimilarity(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const left = bigramCounts(a)
  const right = bigramCounts(b)
  let overlap = 0
  let total = 0
  for (const [gram, n] of left) {
    total += n
    overlap += Math.min(n, right.get(gram) || 0)
  }
  for (const n of right.values()) total += n
  return total ? (2 * overlap) / total : 0
}

/** 命中就返回被回放的那句原文，否则空串。 */
function echoOfRecentTts(text) {
  const probe = speechDense(text)
  if (probe.length < ECHO_MIN_CHARS) return ''
  const now = Date.now()
  for (let i = RECENT_TTS.length - 1; i >= 0; i -= 1) {
    const item = RECENT_TTS[i]
    if (now - item.at > RECENT_TTS_TTL) continue
    if (!item.dense || item.dense.length < ECHO_MIN_CHARS) continue
    // 只录到半句也算回声：整段都落在最近某句播报里，就算只占很小比例，也是扬声器在
    // 喂自己（手机外放把半句话录回来是常态）。逐字重合再兜一层，挡住错字版本。
    if (item.dense.includes(probe)) return item.text
    if (diceSimilarity(probe, item.dense) >= ECHO_DICE) return item.text
  }
  return ''
}

/** 页面用到的静态文件（exact 注册用，见 apply 里的说明）。 */
const PUBLIC_FILES = [
  'index.html',
  'app.js',
  'pet.js',
  'style.css',
  'manifest.webmanifest',
  'icon.svg',
  'pet-preview.html',
]

/** 所有 JSON/SSE 接口名（exact 注册用）。 */
const API_ROUTES = [
  'state',
  'new',
  'dispatch',
  'stream',
  'poll',
  'cancel',
  'selfcheck',
  'link',
  'pair',
  // 手机语音指令：列项目 / 切项目 / 一句话意图解析（只影响专属会话）
  'workspaces',
  'switch',
  'command',
  // 手机 App 浏览历史：项目 / 会话列表 / 单个转录 / 会话目标（契约见 docs/app-dsh-bridge.md）
  'projects',
  'sessions',
  'session',
  'goals',
  'render',
  'tts',
  'tts/voices',
  'say',
  // 聊天里看图：把电脑上的图片字节发给 App（GET/HEAD ?path=绝对路径）
  'file',
  // 本机语音识别 / APK 更新通道（契约见 handlers 上的注释）
  'asr',
  'diag',
  'update',
  // 小爱同学手机自定义技能：不走 cookie，靠 URL 里的 ?k= + MIAI 签名
  'xiaoai',
  'xiaoai/selftest',
]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** 允许静态访问的文件名（白名单形状，杜绝路径穿越）。 */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/* ------------------------------------------------------------------ */
/* 持久化                                                             */
/* ------------------------------------------------------------------ */

/** 读或创建访问 token（0600），第一次启动时生成。 */
/**
 * 当前生效的 token。
 *
 * 每次请求都 stat 一次文件（几百纳秒）：这样删掉 token 文件就等于「换密码」，
 * 用户/助手在终端里 `rm ~/.dsh/pet-voice/token` 之后下一个请求就会重建并立即生效，
 * 不需要重启 App。
 */
let tokenCache = { value: '', mtimeMs: -1 }
function currentToken() {
  let stat
  try {
    stat = statSync(TOKEN_PATH)
  } catch {
    /* 文件没了：重建 */
    tokenCache = { value: ensureToken(), mtimeMs: -1 }
    return tokenCache.value
  }
  if (tokenCache.value && tokenCache.mtimeMs === stat.mtimeMs) return tokenCache.value
  const value = readFileSync(TOKEN_PATH, 'utf8').trim()
  if (value.length < 16) {
    tokenCache = { value: ensureToken(), mtimeMs: -1 }
  } else {
    tokenCache = { value, mtimeMs: stat.mtimeMs }
    LOG(`token 已重新加载：${TOKEN_PATH}`)
  }
  return tokenCache.value
}

function ensureToken() {
  try {
    const existing = readFileSync(TOKEN_PATH, 'utf8').trim()
    if (existing.length >= 16) return existing
  } catch {
    /* 不存在就创建 */
  }
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 })
  const token = randomBytes(24).toString('hex')
  writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 })
  try {
    chmodSync(TOKEN_PATH, 0o600)
  } catch {
    /* Windows 上 chmod 不可用，忽略 */
  }
  LOG(`已生成访问 token：${TOKEN_PATH}`)
  return token
}

/** 换新令牌：写进同一个文件，旧 cookie 与旧配对链接立刻作废，手机要重新扫码。 */
function rotateToken() {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 })
  const token = randomBytes(24).toString('hex')
  writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 })
  try {
    chmodSync(TOKEN_PATH, 0o600)
  } catch {
    /* Windows 上 chmod 不可用，忽略 */
  }
  tokenCache = { value: token, mtimeMs: -1 }
  LOG(`已换新访问 token：${TOKEN_PATH}`)
  return token
}

/** 读状态：记住「哪个项目上次用的是哪个会话」+ 选过的人设。 */
function loadState() {
  const empty = { projects: {}, preset: '', updatedAt: null }
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return {
      projects: raw && typeof raw.projects === 'object' && raw.projects ? raw.projects : {},
      preset: typeof raw?.preset === 'string' ? raw.preset : '',
      updatedAt: raw?.updatedAt ?? null,
    }
  } catch {
    return empty
  }
}

function saveState(state) {
  try {
    mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 })
    state.updatedAt = new Date().toISOString()
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    LOG('保存 state 失败：', error?.message ?? error)
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 小工具                                                         */
/* ------------------------------------------------------------------ */

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function parseCookies(req) {
  const raw = req.headers?.cookie
  if (!raw) return {}
  const out = {}
  for (const piece of String(raw).split(';')) {
    const at = piece.indexOf('=')
    if (at < 0) continue
    out[piece.slice(0, at).trim()] = decodeURIComponent(piece.slice(at + 1).trim())
  }
  return out
}

function isTls(req) {
  if (req.socket?.encrypted) return true
  const proto = String(req.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim()
  return proto === 'https'
}

function cookieName(token) {
  return `pkv_${token.slice(0, 8)}`
}

/** 本机回环判定：面板只给跑着 DSH 的这台机器用。 */
function isLoopback(req) {
  const ip = String(req.socket?.remoteAddress ?? '')
  return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1'
}

/**
 * 请求是不是「反代从别处接进来再转给本机」的。
 *
 * 公网反代（Cloudflare / nginx / frp / ssh -R）把外部请求转给 127.0.0.1 之后，
 * 宿主看到的 `req.socket.remoteAddress` 永远是回环地址——只查它等于「谁接进来
 * 都算本机主人」。审阅实测：外部匿名请求经公网入口转发一次，就能从
 * `/pet-voice/panel/state` 拿到带 `?k=` 的完整配对令牌。
 *
 * 这里把「带着任何转发痕迹」的请求一律当外部：转发头只要出现一个就拒绝。
 * 不是猜来源，是拒绝一切不满足「直连本机」形状的请求。
 */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'x-real-ip',
  'forwarded',
  'via',
  'cf-connecting-ip',
  'cf-ray',
  'true-client-ip',
  'x-client-ip',
  'x-original-forwarded-for',
  'x-cluster-client-ip',
  'x-arr-log-id',
  'x-proxyuser-ip',
]
function isProxied(req) {
  const headers = req?.headers ?? {}
  for (const name of PROXY_HEADERS) {
    if (headers[name] !== undefined) return true
  }
  return false
}

/** 面板请求的 Host 必须是本机名字：反代把 Host 改成公网域名的一律不认。 */
const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i
function isLoopbackHost(req) {
  const host = String(req?.headers?.host ?? '').trim()
  return Boolean(host) && LOOPBACK_HOST_RE.test(host)
}

/**
 * 面板门禁：回环来源 + 没有转发痕迹 + Host 是本机。
 *
 * 三层同时成立才放行。常见公网反代配置（nginx 默认带 X-Forwarded-*、
 * Cloudflare 带 CF-Connecting-IP、隧道会改写 Host）都过不去。
 *
 * 残余风险（如实记）：本机进程、或刻意伪造成「直连形状」的反代仍可进；面板没有
 * 口令式登录，靠的是「本机直连」这一网络事实。要更硬需要用户口令，属下一轮。
 */
function panelRequestAllowed(req) {
  return isLoopback(req) && !isProxied(req) && isLoopbackHost(req)
}

/**
 * 响应还写不写得进去。
 *
 * 客户端在宠物面板点「新对话」后会立刻重载页面，服务端慢半拍再 writeHead 就会抛
 * ERR_STREAM_DESTROYED / ERR_HTTP_HEADERS_SENT。这个错在 async handler 里没人接，
 * 会变成 unhandledRejection，Node ≥15 默认 exit(1)——整个 DSH 应用陪着一起退。
 * 所以凡是写响应的地方都先问一句：对端已经走了就安静丢弃。
 */
function resGone(res) {
  return !res || res.writableEnded === true || res.destroyed === true || res.closed === true
}

/** 写响应头，但绝不抛。返回 false 表示对端已经走了，调用方直接收工。 */
function writeHead(res, status, headers) {
  if (resGone(res)) {
    LOG(`响应已结束，丢弃响应头 ${status}`)
    return false
  }
  try {
    res.writeHead(status, headers)
    return true
  } catch (error) {
    LOG(`写响应头失败 ${status}：`, error?.message ?? error)
    return false
  }
}

/**
 * 写一段流数据，但绝不把「对端已经走了」变成 uncaughtException。
 *
 * `res.write()` 发现响应已 end/destroy 时**不是同步抛**：Node 走
 * `onError()` → `process.nextTick(emitErrorNt)` → `res.emit('error', err)`，
 * 没人监听就在下个 tick 升级成 uncaughtException；宿主对 uncaughtException
 * 是 fail-loud（直接 exit(1)），外壳报 host exited with 1。所以外面的
 * try/catch 挡不住这类错——必须先看状态，再挂 error 监听兜底。
 *
 * @returns {boolean} false 表示这条响应已经死了，调用方该把自己的定时器清掉
 */
function safeWrite(res, chunk) {
  if (resGone(res)) return false
  try {
    if (typeof res.once === 'function' && !res[WROTE_GUARD]) {
      // 只挂一次：多挂会热重载时堆积监听器。
      res[WROTE_GUARD] = true
      res.once('error', () => {})
    }
    res.write(chunk)
    return true
  } catch {
    return false
  }
}

const WROTE_GUARD = Symbol.for('dsh.pet-voice.res-guard')

/** 路由里 await 抛错不许变成 unhandledRejection：兜住、记一行、能回就回 500。 */
function onHandlerError(error, res) {
  const code = String(error?.code ?? '')
  LOG('路由异常：', code || error?.name || '', error?.message ?? error)
  // 写流类错误说明对端已经走了，没有可回的对象。
  if (/^(ERR_STREAM_|ERR_HTTP_HEADERS_SENT|EPIPE$|ECONNRESET$|ABORT_ERR$)/.test(code)) return
  sendJson(res, 500, { ok: false, error: '内部错误' })
}

/** 把 handler 包成「同步、异步都不抛」的版本。注册路由时一律用它。 */
function safeHandler(fn) {
  return (req, res) => {
    try {
      const pending = fn(req, res)
      if (pending && typeof pending.catch === 'function') pending.catch((error) => onHandlerError(error, res))
    } catch (error) {
      onHandlerError(error, res)
    }
  }
}

/**
 * 进程级最后一道网：写流错误（benign）只记一行、绝不 exit；
 * 其它错误记日志 + 堆栈后把主动权还给宿主——先摘掉自己的监听，再重抛，
 * Node 就回到「我们没注册时」的 fatal 语义：宿主要有自己的处理就由它接，
 * 没有就照旧退出。这样我们不替别的代码吞真崩溃。
 *
 * 用 Symbol 标记保证热重载不叠加监听器；错误重抛前会清掉标记，
 * 下次插件加载可以重新挂上。
 */
const NET_GUARD = Symbol.for('dsh.pet-voice.net-guard')
const BENIGN_NET_ERROR = /^(ERR_STREAM_WRITE_AFTER_END|ERR_STREAM_DESTROYED|ERR_STREAM_ALREADY_FINISHED|ERR_HTTP_HEADERS_SENT|EPIPE|ECONNRESET|ABORT_ERR|ETIMEDOUT)$/

/** 注册进程兜底；target/schedule 可注入，单测用假的 process。返回卸载函数。 */
function installNetGuard(target = process, schedule = setImmediate) {
  if (target[NET_GUARD]) return () => {}
  target[NET_GUARD] = true
  const handlers = []

  const uninstall = () => {
    for (const [event, handler] of handlers) target.removeListener(event, handler)
    handlers.length = 0
    delete target[NET_GUARD]
  }

  const makeHandler = (event) => (error) => {
    const code = String(error?.code ?? '')
    LOG(`[${event}] ${code || error?.name || ''}: ${error?.message ?? error}`)
    // benign：对端走了而已，记一行就够，连堆栈都不刷。
    if (BENIGN_NET_ERROR.test(code)) return
    LOG(error?.stack ?? '(no stack)')
    // 非 benign：摘掉我们的监听再抛，避免自我循环，也避免替宿主做决定。
    uninstall()
    schedule(() => { throw error })
  }

  for (const event of ['uncaughtException', 'unhandledRejection']) {
    const handler = makeHandler(event)
    handlers.push([event, handler])
    target.on(event, handler)
  }
  return uninstall
}

installNetGuard()

function sendJson(res, status, payload, extraHeaders = {}) {
  if (resGone(res)) {
    LOG(`响应已结束，丢弃 JSON ${status}`)
    return false
  }
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      ...extraHeaders,
    })
    res.end(body)
    return true
  } catch (error) {
    LOG(`写 JSON 失败 ${status}：`, error?.message ?? error)
    return false
  }
}

function sendHtml(res, status, html) {
  if (!writeHead(res, status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })) return false
  try {
    res.end(html)
    return true
  } catch (error) {
    LOG(`写 HTML 失败 ${status}：`, error?.message ?? error)
    return false
  }
}

function sendFile(res, fileName, extraHeaders = {}) {
  if (!ASSET_NAME.test(fileName)) return sendJson(res, 400, { ok: false, error: 'bad asset name' })
  const full = join(PUBLIC_DIR, fileName)
  if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 400, { ok: false, error: 'bad path' })
  let body
  try {
    body = readFileSync(full)
  } catch {
    return sendJson(res, 404, { ok: false, error: `missing asset ${fileName}` })
  }
  if (!writeHead(res, 200, {
    'content-type': MIME[extname(fileName)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'content-length': body.length,
    ...extraHeaders,
  })) return false
  try {
    res.end(body)
    return true
  } catch (error) {
    LOG(`写资产失败 ${fileName}：`, error?.message ?? error)
    return false
  }
}

/** 神经语音是否可用：venv 里的解释器 + 合成脚本都在才算装好。 */
function ttsReady() {
  try {
    return existsSync(TTS_PYTHON) && existsSync(TTS_SCRIPT)
  } catch {
    return false
  }
}

/** 只接受白名单形状的 rate/pitch，别的一律回默认值（防参数注入）。 */
function normRate(raw, pattern, fallback) {
  const value = String(raw ?? '').trim()
  return pattern.test(value) ? value : fallback
}

async function readJson(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!size) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

const tzOf = (req) => {
  const raw = String(req.headers?.['x-pet-tz'] ?? '').trim()
  return raw && raw.length < 64 ? raw : undefined
}

/**
 * 读原始请求体（音频不是 JSON，不能用 readJson）。
 * 超限直接带 status=413 抛出：调用方只负责翻译成 HTTP，不再自己数长度。
 */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error(`请求体过大（>${limit} B）`)
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

/* ------------------------------------------------------------------ */
/* ASR worker 生命周期                                                  */
/* ------------------------------------------------------------------ */

function asrScriptPath() {
  return ASR_SCRIPT_CANDIDATES.find((path) => existsSync(path)) ?? ASR_SCRIPT_CANDIDATES[0]
}

/** 识别是否可用：venv 解释器 + worker 脚本都在才算装好（和 ttsReady 一个套路）。 */
function asrReady() {
  try {
    return existsSync(ASR_PYTHON) && existsSync(asrScriptPath())
  } catch {
    return false
  }
}

/**
 * 问 worker 的 /health，1.5 s 超时。
 * 连不上/超时/回非 JSON 一律当成「没在跑」（返回 null），由调用方决定是否懒启动。
 */
async function asrHealth(timeout = ASR_HEALTH_TIMEOUT) {
  try {
    const res = await fetch(`${ASR_ENDPOINT}/health`, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return null
    const payload = await res.json()
    return payload?.ok ? payload : null
  } catch {
    return null
  }
}

/* ---- 启动锁：一个模型 4.3 GB，绝不能并载 ---- */

function asrLockRead() {
  try {
    const raw = JSON.parse(readFileSync(ASR_START_LOCK_PATH, 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

/** 锁还在不在「有人正在载」的状态：进程活着且没超时。 */
function asrLockHeld(lock = asrLockRead()) {
  const pid = Number(lock?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (Date.now() - Number(lock?.at ?? 0) > ASR_START_LOCK_TTL_MS) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function asrLockTake(pid) {
  try {
    mkdirSync(ASR_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(ASR_START_LOCK_PATH, JSON.stringify({ pid, at: Date.now() }), { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function asrLockUpdate(pid) {
  try {
    writeFileSync(ASR_START_LOCK_PATH, JSON.stringify({ pid, at: Date.now() }), { mode: 0o600 })
  } catch {
    /* 写不进去也不影响主流程 */
  }
}

function asrLockDrop() {
  try {
    unlinkSync(ASR_START_LOCK_PATH)
  } catch {
    /* 已经不在了 */
  }
}

/**
 * 懒启动 worker（detached）。
 *
 * 为什么要 detached + unref：worker 比请求活得久，也不能拖着宿主进程不退出。
 * stdout/stderr 直接写 `asr/worker.log`（append）：模型加载、坏 WAV、崩溃栈都在那，
 * 排查时只看一个文件就够，不用去翻宿主日志。
 *
 * 并发去重：同一个时刻只允许一次冷启动（手机连点两下不该拉起两个 worker 抢端口）。
 */
let asrStarting = null

/** 等一个正在载入的 worker 就绪；成功顺手把启动锁清掉。 */
async function asrWaitReady(waitMs) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const health = await asrHealth(800)
    if (health?.ok) {
      asrLockDrop()
      return { ok: true, pid: health.pid, cold: true }
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return {
    ok: false,
    error: `ASR worker 还在载模型（>${Math.round(waitMs / 1000)} s）`,
    hint: `看 ${ASR_LOG_PATH} 里的 [asr] 行`,
  }
}

function asrStartWorker(waitMs = ASR_COLD_START_MS) {
  if (asrStarting) return asrStarting
  asrStarting = (async () => {
    if (!asrReady()) return { ok: false, error: `ASR 还没装好：缺 ${ASR_PYTHON} 或 ${asrScriptPath()}` }
    // 第一件事是探活：热重载换了个模块实例，旧 worker 通常还在跑，别重复拉。
    const pre = await asrHealth(800)
    if (pre?.ok) {
      asrLockDrop()
      return { ok: true, pid: pre.pid, cold: false }
    }
    // 别的实例（上一次热重载、另一个并发请求）正在载：跟着等，绝不并载第二个 4.3 GB。
    const lock = asrLockRead()
    if (asrLockHeld(lock)) {
      LOG(`ASR worker 正由 pid ${lock.pid} 载入，跟着等不重拉`)
      const waited = await asrWaitReady(waitMs)
      return waited.ok ? waited : { ...waited, starting: true }
    }
    if (lock) asrLockDrop() // 上次启动被强杀留下的死锁
    try {
      mkdirSync(ASR_DIR, { recursive: true, mode: 0o700 })
    } catch {
      /* 建不了目录也让下面的 spawn 自己报错，这里不抢先抛 */
    }
    // 抢占启动锁：抢不到说明另一个实例刚进来，等它的结果就好。
    if (!asrLockTake(0)) {
      const waited = await asrWaitReady(Math.min(waitMs, ASR_START_WAIT_MS))
      return waited.ok ? waited : { ...waited, starting: true }
    }
    let fd
    try {
      fd = openSync(ASR_LOG_PATH, 'a')
    } catch {
      fd = 'ignore'
    }
    let child
    let spawnError = null
    try {
      child = spawn(
        ASR_PYTHON,
        [asrScriptPath(), '--host', ASR_HOST, '--port', String(ASR_PORT), '--model', ASR_MODEL, '--pid-file', ASR_PID_PATH],
        {
          detached: true,
          stdio: ['ignore', fd, fd],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        },
      )
      child.unref()
      if (child.pid) asrLockUpdate(child.pid)
    } catch (error) {
      asrLockDrop()
      return { ok: false, error: `拉起 ASR worker 失败：${error?.message ?? error}` }
    } finally {
      if (typeof fd === 'number') {
        try {
          closeSync(fd) // 子进程已经继承了这份 fd，父进程这份要还回去
        } catch {
          /* 忽略 */
        }
      }
    }
    // spawn 失败（ENOENT / EACCES）是**异步** emit 的 error 事件：不接住就会升级成
    // uncaughtException，宿主 fail-loud 直接 exit(1)（审阅实测：python 路径写错，
    // 整个 DSH 陪葬）。接住之后冷启动循环立刻带着可读原因返回。
    child.on('error', (error) => {
      spawnError = error
      LOG(`ASR worker 启动失败：${error?.message ?? error}`)
    })
    LOG(`ASR worker 已拉起：pid ${child.pid}，日志 ${ASR_LOG_PATH}`)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (spawnError) {
        asrLockDrop()
        return { ok: false, error: `拉起 ASR worker 失败：${spawnError?.message ?? spawnError}`, hint: `检查 ${ASR_PYTHON} 是否存在` }
      }
      const health = await asrHealth(800)
      if (health?.ok) {
        asrLockDrop()
        LOG(`ASR worker 就绪（${health.model ?? ASR_MODEL}，pid ${health.pid ?? child.pid}）`)
        return { ok: true, pid: health.pid ?? child.pid }
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    // 超时不杀：它还在老老实实载模型，杀了下次还得从零再来。锁继续指着它，
    // 后面来的请求（包括重载后的新实例）只会跟着等，不会再拉第二个。
    return {
      ok: false,
      starting: true,
      pid: child.pid,
      error: `ASR worker 还在载模型（>${Math.round(waitMs / 1000)} s）`,
      hint: `看 ${ASR_LOG_PATH} 里的 [asr] 日志`,
    }
  })().finally(() => {
    asrStarting = null
  })
  return asrStarting
}

/** worker 脚本的修改时间：用来判断常驻进程是不是还在跑旧代码。 */
function asrScriptMtime() {
  try {
    return statSync(asrScriptPath()).mtimeMs
  } catch {
    return 0
  }
}

/** 停掉老 worker：先 SIGTERM 等端口释放，3 s 还不走就 SIGKILL。 */
async function asrKillWorker(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return // 已经不在了
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (!(await asrHealth(600))) return
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    /* 已经退了 */
  }
  await new Promise((resolve) => setTimeout(resolve, 150))
}

/** 脚本换了触发的重启节流：不节流的话每次 ensure 都会「发现旧进程→杀掉→重启」，叠起来又是并载。 */
let asrRestartAt = 0

/** 先探活再决定拉不拉：绝大多数请求会走到「已经在跑」这条快路。 */
async function asrEnsure(waitMs = ASR_COLD_START_MS) {
  const health = await asrHealth()
  if (health?.ok) {
    // 改了 worker 脚本、老进程还活着：不主动重启就永远跑旧代码，补丁等于没打。
    const startedAt = Number.isFinite(health.uptimeMs) ? Date.now() - health.uptimeMs : 0
    if (startedAt && asrScriptMtime() > startedAt + 2000 && Date.now() - asrRestartAt > 60_000) {
      asrRestartAt = Date.now()
      LOG(`ASR worker 比脚本旧，重启一次（pid ${health.pid}）`)
      await asrKillWorker(health.pid)
      asrLockDrop()
      return asrStartWorker(waitMs)
    }
    return { ok: true, pid: health.pid, cold: false }
  }
  return asrStartWorker(waitMs)
}

/**
 * 后台预热：App 一打开页面就会拉 state，这时把 worker 叫醒，
 * 等用户真开口时就不用吃 20 多秒的冷启动（以前第一句常常白说）。
 */
function warmAsrInBackground() {
  if (!asrReady()) return
  const now = Date.now()
  if (asrWarmAt && now - asrWarmAt < 60_000) return
  asrWarmAt = now
  Promise.resolve()
    .then(() => asrEnsure(ASR_COLD_START_MS))
    .then((r) => { if (!r?.ok) LOG('ASR 预热没起来：', r?.error ?? '') })
    .catch((e) => LOG('ASR 预热失败：', e?.message ?? e))
}

/**
 * 把 wav 字节转给 worker。
 *
 * 返回 worker 的 JSON（ok/text/ms）原样内容；网络层失败额外带 `dead:true`，
 * 让 handler 知道该不该重启一次。超时给 30 s：10 s 音频在慢机器上也就 1–2 s，
 * 这个上限只是防止 worker 卡死时宿主一直挂着。
 */
async function asrForward(body, timeoutMs = ASR_REQUEST_TIMEOUT) {
  const started = Date.now()
  try {
    const res = await fetch(`${ASR_ENDPOINT}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, dead: false, error: `ASR worker 回的不是 JSON（HTTP ${res.status}）`, ms: Date.now() - started }
    }
    return {
      ...payload,
      ms: Number.isFinite(payload?.ms) ? payload.ms : Date.now() - started,
    }
  } catch (error) {
    return { ok: false, dead: true, error: `ASR worker 请求失败：${error?.message ?? error}`, ms: Date.now() - started }
  }
}

/* ------------------------------------------------------------------ */
/* APK 更新通道 helper                                                  */
/* ------------------------------------------------------------------ */

/**
 * 读 latest.json。文件不存在、坏了、或者 file 不是合法 APK 名 → null。
 * 这里对 file 做一次白名单校验是**下载路由之外的第二道闸**：发布脚本写坏了也不放行。
 */
function readLatestUpdate() {
  try {
    const raw = JSON.parse(readFileSync(UPDATE_META_PATH, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const file = String(raw.file ?? '')
    if (!APK_NAME_RE.test(file)) return null
    return { ...raw, file }
  } catch {
    return null
  }
}

/**
 * 解析单段 Range。
 *
 * 返回 null = 没有/不认这个 Range（按整文件 200 回），'invalid' = 范围越界（回 416）。
 * 多段 Range（`bytes=0-1,5-6`）故意不支持：手机下载器只会发单段，
 * 支持多段要拼 multipart，收益为零。
 */
function parseRange(header, total) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return 'invalid'
  let start
  let end
  if (!rawStart) {
    // 后缀写法 bytes=-N = 最后 N 字节
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Math.min(Number(rawEnd), total - 1) : total - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return 'invalid'
  return { start, end }
}

/* ------------------------------------------------------------------ */
/* 宿主能力封装（全部容错）                                             */
/* ------------------------------------------------------------------ */

/** 取会话列表行，兼容几种历史返回形状。 */
function rowsOf(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.sessions)) return value.sessions
  if (Array.isArray(value?.rows)) return value.rows
  if (Array.isArray(value?.items)) return value.items
  return []
}

/** 从 assistant/message 事件里尽量捞出纯文本（结构不保证，逐层兜底）。 */
function textOfMessage(data) {
  const message = data?.message ?? data?.event?.message ?? data ?? null
  const parts = message?.content ?? message?.parts ?? data?.content ?? []
  if (typeof parts === 'string') return parts
  if (!Array.isArray(parts)) return ''
  const out = []
  for (const part of parts) {
    if (typeof part === 'string') out.push(part)
    else if (part?.type === 'text' && typeof part.text === 'string') out.push(part.text)
  }
  return out.join('').trim()
}

function normalizeSession(row) {
  const header = row?.header ?? row?.session?.header ?? {}
  const id = String(row?.sessionId ?? row?.id ?? header.id ?? '')
  return {
    id,
    title: String(row?.title ?? header.title ?? ''),
    cwd: String(row?.cwd ?? header.cwd ?? ''),
    workspaceId: String(row?.workspaceId ?? header.workspaceId ?? ''),
    updatedAt: row?.updatedAt ?? header.updatedAt ?? null,
  }
}

function workspaceRows(ctx) {
  const registry = ctx.get?.('workspaceRegistry')
  if (!registry?.list) return []
  try {
    return (registry.list() ?? []).map((w) => ({
      id: String(w?.id ?? ''),
      title: String(w?.title ?? ''),
      path: String(w?.path ?? ''),
    }))
  } catch (error) {
    LOG('workspaceRegistry.list 失败：', error?.message ?? error)
    return []
  }
}

async function presetRows(ctx) {
  const presets = ctx.get?.('agentPresets')
  if (!presets?.list) return []
  try {
    const list = await presets.list()
    return (list ?? []).map((p) => ({
      id: String(p?.id ?? p?.name ?? ''),
      title: String(p?.title ?? p?.displayName ?? p?.id ?? ''),
    }))
  } catch (error) {
    LOG('agentPresets.list 失败：', error?.message ?? error)
    return []
  }
}

async function sessionRows(ctx) {
  const controller = ctx.get?.('sessionController')
  if (!controller?.list) return []
  try {
    const value = await controller.list({}, AbortSignal.timeout(4000))
    return rowsOf(value).map(normalizeSession).filter((row) => row.id)
  } catch (error) {
    LOG('sessionController.list 失败：', error?.message ?? error)
    return []
  }
}

/* ------------------------------------------------------------------ */
/* 浏览项目 / 会话 / 目标（只读）：手机 App 用，数据源全是宿主落盘文件    */
/* ------------------------------------------------------------------ */

/** 毫秒时间戳归一：宿主可能给 number / ISO 字符串 / Date，认不出就是 0。 */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && value) {
    // `before=<seq>` / `before=<updatedAtMs>` 传进来都是数字串，别交给 Date.parse
    if (/^\d+$/.test(value)) return Number(value)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** 截断并留一个省略号，让 App 知道「后面还有，但没下发」。 */
function clipText(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 会话 id 在磁盘上有 `xxx` 和 `session-xxx` 两种写法（宿主版本差异），归一到裸 id。 */
function bareSessionId(id) {
  return String(id ?? '').replace(/^session-/, '')
}

/** 投影缓存文件路径：两种 id 写法都试一遍，找不到返回空串。 */
function projectCachePath(id) {
  for (const name of new Set([String(id ?? ''), bareSessionId(id)])) {
    if (!name) continue
    const file = join(PROJCACHE_DIR, `${name}.json`)
    if (existsSync(file)) return file
  }
  return ''
}

const projCacheMemo = new Map()
const PROJCACHE_MEMO_MAX = 200

/**
 * 读宿主投影缓存里的元信息（标题 / 轮数 / 最近提问时间 / goal）。
 * 这是「会话列表」最便宜的数据源：一个 60 KB 的 JSON 就够填一行列表。
 */
function projectCacheOf(id) {
  const file = projectCachePath(id)
  if (!file) return {}
  let stat
  try {
    stat = statSync(file)
  } catch {
    return {}
  }
  const key = `${file}:${stat.mtimeMs}:${stat.size}`
  const hit = projCacheMemo.get(key)
  if (hit) return hit
  let out = {}
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))?.record ?? {}
    const rows = record.rows ?? {}
    out = {
      title: String(rows.title?.val ?? ''),
      cwd: String(rows.workingDirectory?.val ?? record.identity?.cwd ?? ''),
      turns: Number(rows.sessionStats?.val?.turns ?? 0) || 0,
      updatedAt: toMs(rows.sessionListMetadata?.val?.lastPromptAt) || stat.mtimeMs,
      goal: rows.goal?.val ?? null,
    }
  } catch {
    out = {}
  }
  projCacheMemo.set(key, out)
  if (projCacheMemo.size > PROJCACHE_MEMO_MAX) projCacheMemo.delete(projCacheMemo.keys().next().value)
  return out
}

let projectDirsCache = { at: 0, dirs: [] }

/** 宿主按 cwd 分目录存会话；目录名是把路径里的 `/` 换成 `-`，不可逆，所以只当索引。 */
function sessionProjectDirs() {
  if (Date.now() - projectDirsCache.at < 10_000) return projectDirsCache.dirs
  let dirs = []
  try {
    dirs = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(SESSIONS_ROOT, entry.name))
  } catch {
    dirs = []
  }
  projectDirsCache = { at: Date.now(), dirs }
  return dirs
}

/** 会话 id → 转录文件；磁盘上没有就返回空串。 */
function transcriptPathOf(id) {
  const names = [...new Set([String(id ?? ''), bareSessionId(id)].filter(Boolean))]
  for (const dir of sessionProjectDirs()) {
    for (const name of names) {
      const file = join(dir, name, 'session.v4.jsonl.zstd')
      if (existsSync(file)) return file
    }
  }
  return ''
}

/**
 * 转录文件是「多帧 zstd 拼接」（每轮追加一帧），不是单个 zstd 流：
 * `zstdDecompressSync` 只解第一帧，所以要按帧魔数切段逐帧解。
 * 压缩数据里偶尔也会出现魔数（假阳性），该段解压会失败，跳过即可（不会丢真实帧）。
 */
/** 没有 zstd 时（Node < 22.15）一律返回空，调用方按「读不到转录」处理。 */
function hasZstd() {
  return typeof zstdDecompressSync === 'function'
}

function zstdFrameOffsets(buf) {
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
  }
  return offsets
}

/**
 * 从文件尾部往前解帧，凑够 needLines 行就停（默认页只要最近 20 条消息，
 * 26 MB 的转录也只需解最后几十帧，实测 ~10 ms）。
 * 超大文件只读尾部：比 TRANSCRIPT_READ_LIMIT 更老的内容按「没有更多」处理。
 */
function decodeTranscriptTail(file, needLines) {
  // 没有 zstd（Node < 22.15）时不用去读 26 MB 文件再逐帧失败，直接按「读不到」返回。
  if (!hasZstd()) return { text: '', headText: '', truncated: false, frames: 0, decodedFrames: 0 }
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { text: '', headText: '', truncated: false }
  }
  let buf
  let truncated = false
  try {
    if (stat.size <= TRANSCRIPT_READ_LIMIT) {
      buf = readFileSync(file)
    } else {
      truncated = true
      const fd = openSync(file, 'r')
      try {
        const chunk = Buffer.alloc(TRANSCRIPT_READ_LIMIT)
        const read = readSync(fd, chunk, 0, TRANSCRIPT_READ_LIMIT, stat.size - TRANSCRIPT_READ_LIMIT)
        buf = chunk.subarray(0, read)
      } finally {
        closeSync(fd)
      }
    }
  } catch {
    return { text: '', headText: '', truncated: true }
  }
  const offsets = zstdFrameOffsets(buf)
  if (!offsets.length) return { text: '', headText: '', truncated, frames: 0, decodedFrames: 0 }
  const frameText = (k) => {
    const from = offsets[k]
    const to = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      return zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    } catch {
      return ''
    }
  }
  // 第 0 帧是 session 头（cwd / parentSession），单独解，不混进消息流。
  const headText = offsets[0] === 0 ? frameText(0) : ''
  const chunks = []
  let lines = 0
  let decodedFrames = headText ? 1 : 0
  for (let k = offsets.length - 1; k >= 1 && lines < needLines; k -= 1) {
    const text = frameText(k)
    if (!text) continue
    decodedFrames += 1
    chunks.unshift(text)
    lines += (text.match(/\n/g)?.length ?? 0) + 1
  }
  return { text: chunks.join(''), headText, truncated, frames: offsets.length, decodedFrames }
}

/** 把 message.content 里的文本片段拼起来（图片/音频等非文本片段直接跳过）。 */
function partsText(parts) {
  if (typeof parts === 'string') return parts.trim()
  if (!Array.isArray(parts)) return ''
  const out = []
  for (const part of parts) {
    if (typeof part === 'string') out.push(part)
    else if (part?.type === 'text' && typeof part.text === 'string') out.push(part.text)
  }
  return out.join('').trim()
}

function partsTextOfType(parts, type) {
  if (!Array.isArray(parts)) return ''
  const out = []
  for (const part of parts) {
    if (part?.type === type && typeof part.text === 'string') out.push(part.text)
  }
  return out.join('\n').trim()
}

/**
 * 转录事件 → App 能渲染的消息条目（seq 升序）。
 * 工具调用和它的结果按 callId 合并成一条：手机上一张「工具卡片」比两条半截消息好读。
 */
function entriesOfTranscript(text) {
  const entries = []
  const byCallId = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const seq = Number(event?.seq ?? 0)
    if (!seq) continue
    const type = event?.type
    const time = toMs(event?.time)
    const data = event?.data ?? {}
    if (type === 'user/message') {
      const body = partsText(data.content ?? data.message?.content)
      if (body) entries.push({ seq, role: 'user', text: clipText(body, MESSAGE_TEXT_LIMIT), time })
    } else if (type === 'assistant/message') {
      const message = data.message ?? data
      const parts = message?.content ?? data.content
      const body = partsText(parts)
      const reasoning = partsTextOfType(parts, 'reasoning')
      // 只有工具调用 / 只有推理的 assistant 消息不单独上屏：没正文就是空气泡。
      if (!body) continue
      const entry = { seq, role: 'assistant', text: clipText(body, MESSAGE_TEXT_LIMIT), time }
      if (reasoning) entry.reasoningPreview = clipText(reasoning, REASONING_PREVIEW_LIMIT)
      entries.push(entry)
    } else if (type === 'tool/call') {
      const callId = String(data.callId ?? '')
      const entry = {
        seq,
        role: 'tool',
        text: '',
        time,
        tool: { name: String(data.name ?? ''), args: clipText(data.arguments ?? '', TOOL_ARGS_LIMIT) },
      }
      if (callId) byCallId.set(callId, entry)
      entries.push(entry)
    } else if (type === 'tool/result') {
      const callId = String(data.toolCallId ?? data.callId ?? data.message?.toolCallId ?? '')
      const body = partsText(data.content ?? data.message?.content)
      const target = callId ? byCallId.get(callId) : null
      if (target) target.text = clipText(body, MESSAGE_TEXT_LIMIT)
      else if (body) entries.push({ seq, role: 'tool', text: clipText(body, MESSAGE_TEXT_LIMIT), time })
    }
    // system/message 是宿主注入的系统提示词，App 不展示，也不值得占响应体积。
  }
  return entries
}

/** limit 参数：缺省 20，非法值回默认，最大 50。 */
function clampLimit(raw, fallback = SESSION_LIMIT_DEFAULT) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), SESSION_LIMIT_MAX)
}

/** workspaceRegistry 的 path → projectId，用来把会话归到项目（会话自身常不带 workspaceId）。 */
function projectIdByPath(projects) {
  const map = new Map()
  for (const project of projects ?? []) {
    const path = String(project?.path ?? '').replace(/\/+$/, '')
    if (path) map.set(path, project.id)
  }
  return map
}

/** 会话的 cwd 可能在项目子目录里，按最长前缀算归属；找不到返回空串。 */
function projectIdOfPath(byPath, cwd) {
  const value = String(cwd ?? '').replace(/\/+$/, '')
  if (!value) return ''
  let best = ''
  let bestLength = 0
  for (const [path, id] of byPath) {
    if ((value === path || value.startsWith(`${path}/`)) && path.length > bestLength) {
      best = id
      bestLength = path.length
    }
  }
  return best
}

let sessionRowsCache = { at: 0, rows: [] }
const SESSION_ROWS_TTL = 3000

/**
 * `sessionController.list()` 一次 0.5–1 s（会话多时更慢），而 App 翻页、下拉刷新会连着打：
 * 短 TTL 缓存住全量列表（只缓存宿主事实，running 每请求现算），翻页就只剩补标题的成本。
 */
async function sessionRowsCached(ctx) {
  if (Date.now() - sessionRowsCache.at < SESSION_ROWS_TTL) return sessionRowsCache.rows
  const rows = await sessionRows(ctx)
  if (rows.length) sessionRowsCache = { at: Date.now(), rows }
  return rows
}

/**
 * 会话列表。
 * 主路径走宿主 `sessionController.list()`（活的、带 updatedAt），列表页只对最后
 * limit 条补投影缓存（标题 / 轮数），避免一次读上千个缓存文件。
 * 宿主没提供 controller 时退化成扫投影缓存目录（同样只按 mtime 取前 limit 条）。
 */
async function browseSessions(ctx, query, liveTurns) {
  const projectId = String(query?.projectId ?? '').trim()
  const limit = clampLimit(query?.limit)
  const before = toMs(query?.before)
  const byPath = projectIdByPath(workspaceRows(ctx))
  const isRunning = (id) => Boolean(liveTurns?.has?.(id) || liveTurns?.has?.(bareSessionId(id)))
  const rows = await sessionRowsCached(ctx)

  if (rows.length) {
    const picked = []
    for (const row of rows) {
      const id = String(row.id ?? '')
      if (!id) continue
      const projectIdOf = String(row.workspaceId ?? '') || projectIdOfPath(byPath, row.cwd)
      // 不带 projectId 时只列有项目归属的会话：手机上是「进项目看历史」，
      // 散落在 /private/tmp 的临时会话没有归属，列出来只会让人困惑。
      if (projectId ? projectIdOf !== projectId : !projectIdOf) continue
      const meta = projectCacheOf(id)
      const title = String(row.title ?? '') || meta.title || ''
      // 开了没聊的空壳（无标题、0 轮）在手机列表里就是一串「未命名」，直接不列。
      if (!title && (meta.turns ?? 0) === 0) continue
      const updatedAt = toMs(row.updatedAt)
      if (before && updatedAt >= before) continue
      picked.push({ id, updatedAt, projectIdOf, cwd: String(row.cwd ?? ''), title })
    }
    picked.sort((a, b) => b.updatedAt - a.updatedAt)
    const sliced = picked.slice(0, limit + 1)
    const hasMore = sliced.length > limit
    const sessions = sliced.slice(0, limit).map((row) => {
      const meta = projectCacheOf(row.id)
      return {
        id: row.id,
        title: row.title || meta.title || '',
        projectId: row.projectIdOf,
        cwd: row.cwd || meta.cwd || '',
        updatedAt: row.updatedAt || meta.updatedAt || 0,
        turns: meta.turns ?? 0,
        running: isRunning(row.id),
      }
    })
    return {
      ok: true,
      sessions,
      hasMore,
      ...(hasMore && sessions.length ? { nextBefore: sessions[sessions.length - 1].updatedAt } : {}),
    }
  }

  // 降级：没有 sessionController 时直接扫投影缓存（mtime 就是「最近活跃」的近似）。
  let names = []
  try {
    names = readdirSync(PROJCACHE_DIR)
  } catch {
    names = []
  }
  const cached = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(PROJCACHE_DIR, name)
    let stat
    try {
      stat = statSync(file)
    } catch {
      continue
    }
    if (before && stat.mtimeMs >= before) continue
    cached.push({ id: name.slice(0, -5), mtimeMs: stat.mtimeMs })
  }
  cached.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const sessions = []
  for (const row of cached) {
    const meta = projectCacheOf(row.id)
    const projectIdOf = projectIdOfPath(byPath, meta.cwd)
    if (projectId ? projectIdOf !== projectId : !projectIdOf) continue
    sessions.push({
      id: row.id,
      title: meta.title || '',
      projectId: projectIdOf,
      cwd: meta.cwd || '',
      updatedAt: meta.updatedAt || row.mtimeMs,
      turns: meta.turns ?? 0,
      running: isRunning(row.id),
    })
    if (sessions.length > limit) break
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  const hasMore = sessions.length > limit
  const page = sessions.slice(0, limit)
  return {
    ok: true,
    sessions: page,
    hasMore,
    ...(hasMore && page.length ? { nextBefore: page[page.length - 1].updatedAt } : {}),
  }
}

const transcriptMemo = new Map()
const TRANSCRIPT_MEMO_MAX = 12

/** 同一文件同一帧数只解一次：App 轮询 / 下拉刷新同一页时不重复解压。 */
function transcriptEntriesOf(file, needLines) {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { entries: [], headText: '', frames: 0, decodedFrames: 0, truncated: false }
  }
  const key = `${file}:${stat.size}:${stat.mtimeMs}:${needLines}`
  const hit = transcriptMemo.get(key)
  if (hit) return hit
  const decoded = decodeTranscriptTail(file, needLines)
  const out = {
    entries: entriesOfTranscript(decoded.text),
    headText: decoded.headText,
    frames: decoded.frames,
    decodedFrames: decoded.decodedFrames,
    truncated: decoded.truncated,
  }
  transcriptMemo.set(key, out)
  if (transcriptMemo.size > TRANSCRIPT_MEMO_MAX) transcriptMemo.delete(transcriptMemo.keys().next().value)
  return out
}

/**
 * 单个会话的转录（最新一页，或 before=<seq> 往前翻）。
 * 返回结果按 seq 升序；调小 limit 保证 JSON 不超过 200 KB。
 */
function sessionDetail(query) {
  const id = String(query?.id ?? '').trim()
  if (!id) return null
  const limit = clampLimit(query?.limit)
  const before = toMs(query?.before)
  const meta = projectCacheOf(id)
  const file = transcriptPathOf(id)
  if (!file && !meta.title && !meta.cwd) return null

  const head = { title: meta.title || '', cwd: meta.cwd || '' }
  let page = []
  let hasMore = false
  if (file) {
    // 先解尾部一小段；`before` 很老时逐级扩大，直到凑够这一页或解到文件头。
    const base = Math.max(60, (limit + 10) * 5)
    let decoded = null
    for (const needLines of [base, base * 4, base * 16, 12000]) {
      decoded = transcriptEntriesOf(file, needLines)
      const pool = before > 0 ? decoded.entries.filter((entry) => entry.seq < before) : decoded.entries
      page = pool.slice(-limit)
      hasMore = pool.length > page.length
      const reachedStart = decoded.decodedFrames >= decoded.frames - 1
      if (hasMore || reachedStart || decoded.truncated || needLines >= 12000 || !decoded.entries.length) break
    }
    if (decoded?.headText) {
      try {
        const header = JSON.parse(decoded.headText.split('\n')[0] ?? '{}')
        if (!head.cwd && header?.cwd) head.cwd = String(header.cwd)
      } catch {
        /* 头帧坏了就只用投影缓存里的 cwd */
      }
    }
  }
  // 体积兜底：超限就从最老的一条开始丢，并置 hasMore，让 App 继续往前翻。
  while (page.length > 1 && Buffer.byteLength(JSON.stringify({ messages: page })) > BROWSE_RESPONSE_LIMIT) {
    page.shift()
    hasMore = true
  }
  return {
    ok: true,
    session: { id, title: head.title, cwd: head.cwd },
    messages: page,
    hasMore,
    ...(hasMore && page.length ? { nextBefore: page[0].seq } : {}),
  }
}

/** 会话的目标（goal）：投影缓存里有就返回一条，没有就空数组，绝不让 App 因为没目标而报错。 */
function goalsOfSession(sessionId) {
  const id = String(sessionId ?? '').trim()
  if (!id) return { ok: true, goals: [] }
  const meta = projectCacheOf(id)
  const goal = meta.goal?.current?.goal
  if (!goal?.id) return { ok: true, goals: [] }
  return {
    ok: true,
    goals: [
      {
        id: String(goal.id),
        objective: String(goal.objective ?? ''),
        status: String(goal.phase ?? goal.status ?? 'active'),
        updatedAt: toMs(meta.goal?.updatedAt) || meta.updatedAt || 0,
      },
    ],
  }
}

/**
 * 自测钩子：`scripts/*` 可以不启动宿主直接验数据层（生产路径不使用这个导出）。
 * 加它只是为了让「转录解码 / 分页」在真机 curl 之前就能被验证。
 */
export const __browseInternals = {
  toMs,
  clipText,
  bareSessionId,
  projectCacheOf,
  transcriptPathOf,
  decodeTranscriptTail,
  entriesOfTranscript,
  clampLimit,
  browseSessions,
  sessionDetail,
  goalsOfSession,
}

/** 派发落点相关（单测用，见 plugins/dsh-pet-voice/test/dispatch-target.test.mjs）。 */
export const __dispatchInternals = {
  targetSessionId,
  petTargetSession,
  sessionKnownToHost,
  isMissingSessionError,
  dispatchToSession,
  readPetSessionFile,
  petWorkspaceName,
  newSessionRoute,
}

/** 图片上传 / 派发附图（单测用，见 plugins/dsh-pet-voice/test/upload.test.mjs）。 */
/** 读图路由的单测入口（见 test/file.test.mjs）。 */
export const __fileInternals = {
  imageContentType,
  readImageFile,
  handleFile,
  MAX_IMAGE_BYTES: UPLOAD_MAX_BYTES,
}

/** 旁听（问进展只读看一眼同项目另一只）的单测入口（见 test/peek.test.mjs）。 */
export const __peekInternals = {
  peekWanted,
  pickPeekTarget,
  peekTranscriptLines,
  gitDigest,
  buildPeekBlock,
}

export const __uploadInternals = {
  extFor,
  uploadDir,
  saveUpload,
  composeDispatchText,
  normalizeAttachments,
  MAX_UPLOAD_BYTES: UPLOAD_MAX_BYTES,
}

/** 写响应安全网（单测用，见 plugins/dsh-pet-voice/test/response-safety.test.mjs）。 */
export const __netInternals = {
  resGone,
  writeHead,
  sendJson,
  safeWrite,
  sendHtml,
  sendFile,
  safeHandler,
  onHandlerError,
  withTimeout,
  installNetGuard,
  BENIGN_NET_ERROR,
  NET_GUARD,
}


/* ---------- 图片上传 + 派发附图 ---------- */

/**
 * content-type → 扩展名。只认白名单；带 charset 之类的参数先剥掉。
 * 不认识就回空串，调用方回 415。
 */
function extFor(contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  return UPLOAD_EXTS[type] ?? ''
}

/** 落盘目录：<项目 cwd>/.pet-uploads（base 显式传入，单测好造临时目录）。 */
function uploadDir(base) {
  const root = String(base ?? '').trim()
  return join(root || process.cwd(), UPLOAD_DIR_NAME)
}

/** 本地时间戳 yyyyMMdd-HHmmss。 */
function uploadStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * ?name= 只取「人类可读前缀」：去掉目录、扩展名和可疑字符，再截短。
 * 返回空串表示不采用，最终文件名只留时间戳 + 随机段。
 */
function uploadNameHint(raw) {
  const base = String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
  return stem
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * 项目里的 `.pet-uploads/` 不该出现在 `git status` 里。
 *
 * 只写仓库**本地**的 `.git/info/exclude`：不碰 .gitignore（那会被提交、会改别人的仓库），
 * worktree/submodule 的 `.git` 是个文件，顺着 `gitdir:` 一行找真正的 git 目录。
 * 任何一步失败都静默：图片存下来比忽略规则重要。
 */
function ensureUploadIgnored(base) {
  try {
    const root = String(base ?? '').trim()
    if (!root) return
    const gitPath = join(root, '.git')
    const st = statSync(gitPath, { throwIfNoEntry: false })
    if (!st) return
    let gitDir = gitPath
    if (st.isFile()) {
      const text = readFileSync(gitPath, 'utf8')
      const line = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim()
      if (!line) return
      gitDir = isAbsolute(line) ? line : join(root, line)
    }
    const excludePath = join(gitDir, 'info', 'exclude')
    let current = ''
    try {
      current = readFileSync(excludePath, 'utf8')
    } catch {
      /* 还没建过 exclude：下面补 */
    }
    const row = `${UPLOAD_DIR_NAME}/`
    if (current.split(/\r?\n/).some((item) => item.trim() === row)) return
    mkdirSync(join(gitDir, 'info'), { recursive: true })
    const head = current && !current.endsWith('\n') ? `${current}\n` : current
    writeFileSync(excludePath, `${head}${row}\n`)
  } catch (error) {
    LOG('写 git exclude 失败：', error?.message ?? error)
  }
}

/**
 * 保存一张图片（Buffer）。返回 {ok:true, path, name, bytes} 或 {ok:false, status, error}。
 * 纯 IO，不碰 req/res：HTTP 层和单测共用同一份逻辑。
 */
function saveUpload(base, contentType, bytes, opts = {}) {
  const ext = extFor(contentType)
  if (!ext) return { ok: false, status: 415, error: `只支持 ${UPLOAD_EXT_LIST} 图片` }
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  if (data.length > UPLOAD_MAX_BYTES) return { ok: false, status: 413, error: '图片太大（上限 12 MB）' }
  if (!data.length) return { ok: false, status: 400, error: '图片是空的' }
  const hint = uploadNameHint(opts.name)
  const now = opts.now instanceof Date ? opts.now : new Date()
  const name = `${hint ? `${hint}-` : ''}${uploadStamp(now)}-${randomBytes(3).toString('hex')}.${ext}`
  // 优先落在项目目录；项目根不可写（只读挂载 / 权限）时退到插件自己的目录，
  // 否则手机端会看到「图片没存下来」，而模型其实只是少看了一张图。
  const dirs = [uploadDir(base)]
  const fallback = String(opts.fallbackDir ?? '').trim()
  if (fallback && fallback !== dirs[0]) dirs.push(fallback)
  let lastError = null
  let first = true
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true })
      // 落在项目里的那份：顺手让 git 本地忽略这个目录，别污染用户的 git status。
      if (first && base) ensureUploadIgnored(base)
      writeFileSync(join(dir, name), data)
      return { ok: true, path: join(dir, name), name, bytes: data.length }
    } catch (error) {
      lastError = error
    }
    first = false
  }
  LOG('图片落盘失败：', lastError?.message ?? lastError)
  return { ok: false, status: 500, error: '图片没存下来' }
}

/**
 * 派发文本拼装：正文 + 空行 + 每张图一行 `[图片] <绝对路径>`。
 * 没有附件时**原样返回**（老调用方行为不变）。
 */
function composeDispatchText(text, paths = []) {
  const body = String(text ?? '')
  const list = Array.isArray(paths) ? paths.filter(Boolean).map(String) : []
  if (!list.length) return body
  const tail = list.map((path) => `[图片] ${path}`).join('\n')
  return body.trim() ? `${body}\n\n${tail}` : tail
}

/**
 * 校验 attachments 入参：string[]（绝对路径）或 [{path,name}]，最多 6 条，每条必须存在。
 * 返回 {ok:true, paths} / {ok:false, error}。失败由调用方回 400。
 */
function normalizeAttachments(raw) {
  if (raw === undefined || raw === null) return { ok: true, paths: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'attachments 必须是数组' }
  if (raw.length > UPLOAD_MAX_ATTACHMENTS) {
    return { ok: false, error: `最多带 ${UPLOAD_MAX_ATTACHMENTS} 张图片` }
  }
  const paths = []
  for (const item of raw) {
    const value = typeof item === 'string' ? item : String(item?.path ?? '')
    const path = value.trim()
    if (!path) return { ok: false, error: '图片路径为空' }
    if (!isAbsolute(path)) return { ok: false, error: `图片路径必须是绝对路径：${path}` }
    if (!existsSync(path)) return { ok: false, error: `图片不存在：${path}` }
    paths.push(path)
  }
  return { ok: true, paths }
}

/**
 * 图片落在「派发项目」里：优先 pet-session.json 记的 cwd，其次专属会话所属
 * 项目的工作区路径，最后退回进程 cwd（极端情况也不让上传直接 500）。
 */
function petUploadBase(ctx) {
  const stored = readPetSessionFile()
  if (stored.cwd) return stored.cwd
  try {
    const row = workspaceRows(ctx).find((item) => item.id && item.id === stored.workspaceId)
    if (row?.path) return row.path
  } catch (error) {
    LOG('找图片目录失败：', error?.message ?? error)
  }
  return process.cwd()
}

/**
 * POST /pet-voice/api/upload?name=<文件名>
 *
 * body = 原始图片字节（不是 multipart）。content-type 必须是四种图片之一。
 * 超 12 MiB → 413，类型不对 → 415，其余失败一律中文一句话。
 */
async function handleUpload(ctx, req, res, url) {
  const declared = Number(req.headers?.['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) {
    return sendJson(res, 413, { ok: false, error: '图片太大（上限 12 MB）' })
  }
  if (!extFor(req.headers?.['content-type'])) {
    return sendJson(res, 415, { ok: false, error: `只支持 ${UPLOAD_EXT_LIST} 图片` })
  }
  let body
  try {
    body = await readBody(req, UPLOAD_MAX_BYTES)
  } catch (error) {
    const tooBig = error?.status === 413
    return sendJson(res, tooBig ? 413 : 400, {
      ok: false,
      error: tooBig ? '图片太大（上限 12 MB）' : '读不到请求体',
    })
  }
  const saved = saveUpload(petUploadBase(ctx), req.headers?.['content-type'], body, {
    name: url.searchParams.get('name') ?? '',
    fallbackDir: join(HOME_DIR, 'uploads'),
  })
  if (!saved.ok) return sendJson(res, saved.status, { ok: false, error: saved.error })
  netLog('upload', { bytes: saved.bytes, path: saved.path })
  return sendJson(res, 200, { ok: true, path: saved.path, name: saved.name, bytes: saved.bytes })
}

/**
 * GET/HEAD /pet-voice/api/file?path=<绝对路径>
 *
 * 手机聊天里要直接看到电脑上的图：把字节按原样发回去，只认四种图片扩展名。
 * 纯 IO 与 HTTP 分两层：readImageFile 单测直接用，handleFile 只做响应头/HEAD。
 */
const IMAGE_FILE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 扩展名 → content-type；不在白名单返回空串（调用方据此回 415）。 */
function imageContentType(filePath) {
  return IMAGE_FILE_TYPES[extname(String(filePath ?? '')).toLowerCase()] ?? ''
}

/**
 * 读一张图片。返回 {ok:true, body, type, bytes} 或 {ok:false, status, error}。
 * 路径必须是绝对路径、不含 `..`；文件必须存在且是普通文件、≤ 12 MB。
 */
function readImageFile(rawPath) {
  const path = String(rawPath ?? '').trim()
  if (!path) return { ok: false, status: 400, error: 'path 为空' }
  if (!isAbsolute(path)) return { ok: false, status: 400, error: 'path 必须是绝对路径' }
  // 不做目录穿越拼接：直接读用户给的路径，但带 `..` 段的一律拒。
  if (path.split(/[\\/]/).includes('..')) return { ok: false, status: 400, error: 'path 不能包含 ..' }
  const type = imageContentType(path)
  if (!type) return { ok: false, status: 415, error: `只支持 ${UPLOAD_EXT_LIST} 图片` }
  let st
  try {
    st = statSync(path)
  } catch {
    return { ok: false, status: 404, error: '图片不存在' }
  }
  if (!st.isFile()) return { ok: false, status: 404, error: '不是普通文件' }
  if (st.size > UPLOAD_MAX_BYTES) return { ok: false, status: 413, error: '图片太大（上限 12 MB）' }
  let body
  try {
    body = readFileSync(path)
  } catch {
    return { ok: false, status: 404, error: '图片读不到' }
  }
  if (body.length > UPLOAD_MAX_BYTES) return { ok: false, status: 413, error: '图片太大（上限 12 MB）' }
  return { ok: true, body, type, bytes: body.length }
}

/** HTTP 层：鉴权已在 apiHandler 里做过；这里只落响应。HEAD 不回 body。 */
function handleFile(req, res, url) {
  const out = readImageFile(url.searchParams.get('path') ?? '')
  if (!out.ok) return sendJson(res, out.status, { ok: false, error: out.error })
  const headers = {
    'content-type': out.type,
    'content-length': out.bytes,
    // 图片内容按绝对路径缓存 10 分钟：同一句话反复上屏时别再抓一遍。
    'cache-control': 'private, max-age=600',
    'x-content-type-options': 'nosniff',
  }
  if (!writeHead(res, 200, headers)) return false
  if (String(req.method ?? '').toUpperCase() === 'HEAD') {
    try {
      res.end()
      return true
    } catch (error) {
      LOG('写图片 HEAD 失败：', error?.message ?? error)
      return false
    }
  }
  try {
    res.end(out.body)
    return true
  } catch (error) {
    LOG('写图片失败：', error?.message ?? error)
    return false
  }
}

/** 项目里的上一只会话；找不到就新建一个。 */
async function ensureSession(ctx, state, body) {
  const controller = ctx.get?.('sessionController')
  if (!controller?.create || !controller?.prompt) {
    throw new Error('宿主缺少 sessionController（create/prompt），无法派发任务')
  }
  if (body.sessionId) return String(body.sessionId)

  const projectPath = typeof body.projectPath === 'string' ? body.projectPath : ''
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
  const key = workspaceId || projectPath
  const remembered = !body.stateless && key ? state.projects[key] : ''
  // 记忆里的会话可能已经被删掉；这里只做弱信任，prompt 失败会回退到新建。
  if (remembered) return remembered

  const request = {}
  if (workspaceId) request.workspaceId = workspaceId
  else if (projectPath) request.cwd = projectPath
  const preset = typeof body.preset === 'string' && body.preset ? body.preset : state.preset
  if (preset) request.agentPreset = preset

  const created = await controller.create(request)
  const sessionId = String(
    created?.sessionId ?? created?.id ?? created?.session?.id ?? created?.sessionId?.toString?.() ?? '',
  )
  if (!sessionId) {
    throw new Error(`create() 没有返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
  }
  if (key) {
    state.projects[key] = sessionId
    saveState(state)
  }
  return sessionId
}

/* ------------------------------------------------------------------ */
/* 专属会话：所有「没显式指定 sessionId」的派发都落到这里              */
/* ------------------------------------------------------------------ */

/** 专属会话所在项目：只认小爱配置里的 workspace，默认 Pet。 */
function petWorkspaceName() {
  try {
    const raw = JSON.parse(readFileSync(XIAOAI_CONFIG_PATH, 'utf8'))
    const name = typeof raw?.workspace === 'string' ? raw.workspace.trim() : ''
    return name || 'Pet'
  } catch {
    return 'Pet'
  }
}

const XIAOAI_URL_PATH = join(HOME_DIR, 'xiaoai-url.txt')
/**
 * 自建隧道的公网地址（本机 IP:8443 那种，证书是自签 CA）。
 * 小爱那条走 cloudflared 域名；这条路没有域名，只能由脚本把地址写在这里，
 * 否则二维码永远只会给局域网地址——出门就打不开。
 */
const TUNNEL_URL_PATH = join(HOME_DIR, 'tunnel-url.txt')
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$/i

/** 抹掉 URL 里的 `?k=` / `&k=`（配对令牌），用于能给人看的场合。 */
function stripPairKey(url) {
  return String(url ?? '').replace(/([?&])k=[^&]*/g, '$1k=<已省略>').replace(/[?&]$/, '')
}

/**
 * 「手机上打得开哪个地址」——服务端自己知道的三档：
 *   tunnel：小爱隧道落地时把公网 URL 写在 xiaoai-url.txt，取它的 origin
 *   lan   ：没有隧道时，用本机非回环 IPv4 + 宿主端口（同一个 WiFi 能开，出门打不开）
 *   local ：连局域网地址都拿不到（只有 127.0.0.1，手机打不开）
 * 任何一档都**不含 token**：配对靠扫码或首次手输令牌。
 */
const TUNNEL_PROBE_TIMEOUT = 1500 // ms，整条链路（DNS+TLS+首字节）都算在内
const TUNNEL_PROBE_TTL = 30_000 // 结果缓存 30 s，卡片连点不会把隧道打爆
let tunnelProbeCache = { base: '', alive: false, at: 0 }
let tunnelProbePending = null // 并发去重：同一时刻只探一次

/**
 * 隧道探活：只问「这个域名现在还能不能叫通」，不关心内容。
 * 401/404 都算活着（说明 DNS/TLS/HTTP 都通了）；超时、连接失败算死。
 * 走 `publicBase + api/pair`，1.5 s 超时，结果缓存 30 s。
 */
function probeTunnel(base) {
  const now = Date.now()
  if (tunnelProbeCache.base === base && now - tunnelProbeCache.at < TUNNEL_PROBE_TTL) {
    return Promise.resolve(tunnelProbeCache.alive)
  }
  if (tunnelProbePending) return tunnelProbePending
  // 自签证书的隧道：fetch 会因为 CA 不在信任链里直接失败，探活就会永远显示「隧道挂了」。
  // 这里只要能连上、能拿到 HTTP 响应就算活着，所以单独用 https.request 并关掉校验。
  const probeOnce = (target) => new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      const req = httpsRequest(target, { method: 'GET', rejectUnauthorized: false, timeout: TUNNEL_PROBE_TIMEOUT }, (res) => {
        res.resume()
        finish(true)
      })
      req.on('error', () => finish(false))
      req.on('timeout', () => {
        req.destroy()
        finish(false)
      })
      req.end()
    } catch {
      finish(false)
    }
  })
  tunnelProbePending = probeOnce(`${base}api/pair`)
    .then((alive) => {
      tunnelProbeCache = { base, alive, at: Date.now() }
      tunnelProbePending = null
      return alive
    })
  return tunnelProbePending
}

/**
 * 「手机上打得开哪个地址」——服务端自己知道的三档：
 *   tunnel：小爱隧道落地时把公网 URL 写在 xiaoai-url.txt，取它的 origin
 *   lan   ：没有隧道记录时，用本机非回环 IPv4 + 宿主端口（同一个 WiFi 能开，出门打不开）
 *   local ：连局域网地址都拿不到（只有 127.0.0.1，手机打不开）
 * 任何一档都**不含 token**：配对靠扫码或首次手输令牌。
 * 隧道探活失败也**不降级**到 lan——那样手机只会拿到一个更打不开的私网地址，
 * 所以保留 tunnel 地址 + `alive:false` + `note`，由页面标黄提示重新起隧道。
 */
async function pairInfo(origin) {
  let raw = ''
  try {
    raw = readFileSync(TUNNEL_URL_PATH, 'utf8').trim()
  } catch {
    raw = ''
  }
  if (!raw) {
    try {
      raw = readFileSync(XIAOAI_URL_PATH, 'utf8').trim()
    } catch {
      raw = ''
    }
  }
  if (raw) {
    try {
      const parsed = new URL(raw)
      if (!LOCAL_HOST_RE.test(parsed.hostname)) {
        const base = `${parsed.origin}${BASE}/`
        const alive = await probeTunnel(base)
        return {
          publicBase: base,
          source: 'tunnel',
          tunnelAt: stripPairKey(raw),
          alive,
          ...(alive ? {} : { note: '隧道域名可能已过期（cloudflared 重启会换域名）' }),
        }
      }
    } catch {
      /* 文件坏了就当没有 */
    }
  }
  let port = ''
  try {
    port = new URL(origin).port
  } catch {
    port = ''
  }
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) {
        const host = `${item.address}${port ? `:${port}` : ''}`
        return { publicBase: `http://${host}${BASE}/`, source: 'lan', tunnelAt: raw ? stripPairKey(raw) : '' }
      }
    }
  }
  return { publicBase: `${origin}${BASE}/`, source: 'local', tunnelAt: raw ? stripPairKey(raw) : '' }
}

function readPetSessionFile() {
  try {
    const raw = JSON.parse(readFileSync(petSessionFile(), 'utf8'))
    return {
      workspaceId: String(raw?.workspaceId ?? ''),
      sessionId: String(raw?.sessionId ?? ''),
      cwd: String(raw?.cwd ?? ''),
    }
  } catch {
    return { workspaceId: '', sessionId: '' }
  }
}

const trailPath = (value) => String(value ?? '').replace(/\/+$/, '')

/**
 * 派发落点 = 专属会话（pet-session.json 里那只，钉在专属项目里）。
 *
 * 这里**绝不**回退到「界面当前会话」或 state.projects：用户第二次投诉的就是这个——
 * MCP 的 pet_ask 不带 sessionId，旧逻辑拿 sessions[0]（谁在看界面就是谁），
 * 于是自测任务出现在用户正看着的会话里。找不到/对不上就新建，然后写回文件。
 */
/**
 * 同一时刻只许建一只专属会话。
 *
 * 踩过的坑：手机两条并发请求同时打进 `/api/*`，两边都判「旧会话不可用」，于是各 create 一只。
 * 赢的那只写进 pet-session.json，输的那只成了没人钉、却还接得到消息的野会话——用户看到
 * 两个会话各自回答、各自说话，像「自己跟自己聊」。这里用单飞锁：后来者等第一只落地，
 * 然后按文件里那只走，绝不另建。
 */
let petTargetCreating = null

async function petTargetSession(ctx, state) {
  if (petTargetCreating) {
    try {
      await petTargetCreating
    } catch (_) {
      // 第一只建失败：让它自己按原逻辑重建
    }
    const stored = readPetSessionFile()
    if (stored.sessionId) {
      const rows = await sessionRows(ctx)
      const row = rows.find((item) => item.id === stored.sessionId)
      const known = row ? true : await sessionKnownToHost(ctx, stored.sessionId, rows)
      if (known) {
        return {
          sessionId: stored.sessionId,
          workspace: {
            id: row?.workspaceId || stored.workspaceId,
            title: stored.workspaceTitle || '',
            path: row?.cwd || stored.cwd,
          },
        }
      }
    }
  }
  const job = petTargetSessionUnlocked(ctx, state)
  petTargetCreating = job
  try {
    return await job
  } finally {
    if (petTargetCreating === job) petTargetCreating = null
  }
}

async function petTargetSessionUnlocked(ctx, state) {
  const controller = ctx.get?.('sessionController')
  if (!controller?.create) throw new Error('宿主缺少 sessionController（create），建不了专属会话')
  const want = petWorkspaceName()
  const rows = workspaceRows(ctx)
  const hit =
    rows.find((w) => w.title === want) ||
    rows.find((w) => w.id === want) ||
    rows.find((w) => trailPath(w.path).split('/').filter(Boolean).pop() === want)
  if (!hit) {
    const error = new Error(`找不到项目 ${want}`)
    error.code = 'NOT_FOUND'
    throw error
  }
  const stored = readPetSessionFile()
  if (stored.sessionId) {
    // 手机端可以显式绑定任意一只会话（见 /api/bind）：绑定优先于默认项目，
    // 只校验这只会话还在、cwd 没漂走。
    const rows = await sessionRows(ctx)
    const row = rows.find((item) => item.id === stored.sessionId)
    // `sessionController.list()` 会漏会话（刚建、后台归档、列表过滤都见过）：
    // 之前只信 list()，423 那种「绑定好却查不到」会让专属会话被判定不可用而另建一只，
    // App 钉着的 f389 一条消息都收不到。查不到再问 get()/磁盘，认得就沿用。
    const known = row ? true : await sessionKnownToHost(ctx, stored.sessionId, rows)
    const cwdOk = row?.cwd ? trailPath(row.cwd) === trailPath(stored.cwd || hit.path) : true
    if (known && cwdOk) {
      return {
        sessionId: stored.sessionId,
        workspace: { id: row?.workspaceId || hit.id, title: stored.workspaceTitle || hit.title, path: row?.cwd || hit.path },
      }
    }
    LOG(`专属会话 ${stored.sessionId} 不可用（${known ? 'cwd 对不上' : '宿主和磁盘都不认识它'}），重建一只`)
  }
  const request = hit.id ? { workspaceId: hit.id } : { cwd: hit.path }
  if (state.preset) request.agentPreset = state.preset
  const created = await withTimeout(controller.create(request), CREATE_TIMEOUT_MS, '创建专属会话超时（15s）')
  const sessionId = String(created?.sessionId ?? created?.id ?? created?.session?.id ?? '')
  if (!sessionId) throw new Error(`create() 没有返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
  // 并发兜底：如果这中间已经有人先钉好了一只，就认文件里那只，别把刚建的变成野会话
  const raced = readPetSessionFile()
  // 只认「宿主确实认得」的那只：文件里可能还留着早就死掉的旧 id，别把它捡回来
  if (raced.sessionId && raced.sessionId !== sessionId && (await sessionKnownToHost(ctx, raced.sessionId, []))) {
    LOG(`并发建会话：沿用已钉的 ${raced.sessionId}，忽略刚建的 ${sessionId}`)
    return {
      sessionId: raced.sessionId,
      workspace: {
        id: raced.workspaceId || hit.id,
        title: raced.workspaceTitle || hit.title,
        path: raced.cwd || hit.path,
      },
    }
  }
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(
    petSessionFile(),
    `${JSON.stringify({ workspaceId: hit.id, workspaceTitle: hit.title, cwd: hit.path, sessionId }, null, 2)}\n`,
    { mode: 0o600 },
  )
  LOG(`专属会话已钉到「${hit.title}」：${sessionId}`)
  return { sessionId, workspace: hit }
}

/** 建会话的硬超时：宿主忙时 create() 能挂两分钟，面板不能跟着干等。 */
const CREATE_TIMEOUT_MS = 15_000

/** 给 promise 套一个硬超时；超时 reject（code=ETIMEDOUT），定时器不挡进程退出。 */
function withTimeout(promise, ms, message) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(message), { code: 'ETIMEDOUT' }))
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * /new 的决定阶段：复用专属会话，或按指定项目新建一只。
 *
 * 宠物面板点「新对话」后页面会立刻重载，请求被中断时这里可能还停在 await 上；
 * 所以 await 前后各查一次 resGone()：客户端一走就返回 null——不建孤儿会话、不写响应。
 * 建会话本身也有 15s 硬超时，失败回固定短文案。
 */
async function newSessionRoute(ctx, state, body, res) {
  const controller = ctx.get?.('sessionController')
  if (!controller?.create) return { status: 503, body: { ok: false, error: '宿主缺少 sessionController' } }
  if (resGone(res)) return null

  let workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : ''
  let projectPath = typeof body?.projectPath === 'string' ? body.projectPath : ''
  if (!workspaceId && !projectPath) {
    // 页面没指定项目：默认就是专属会话那只，不要建到宿主默认目录里
    let pet = null
    try {
      pet = await petTargetSession(ctx, state)
    } catch (error) {
      LOG('/new 取专属会话失败：', error?.message ?? error)
      return { status: 503, body: { ok: false, error: '专属会话暂不可用' } }
    }
    if (resGone(res)) return null
    if (!body?.fresh) {
      return { status: 200, body: { ok: true, sessionId: pet.sessionId, reused: true, title: pet.workspace.title ?? '' } }
    }
    workspaceId = pet.workspace.id
    projectPath = pet.workspace.path ?? ''
  }
  if (resGone(res)) return null
  try {
    const request = {}
    if (workspaceId) request.workspaceId = workspaceId
    else if (projectPath) request.cwd = projectPath
    if (body?.preset) request.agentPreset = String(body.preset)
    const created = await withTimeout(controller.create(request), CREATE_TIMEOUT_MS, '创建会话超时（15s）')
    if (resGone(res)) return null
    const sessionId = String(
      created?.sessionId ?? created?.id ?? created?.session?.id ?? '',
    )
    if (!sessionId) {
      return { status: 502, body: { ok: false, error: `create() 没有返回 sessionId：${JSON.stringify(created).slice(0, 200)}` } }
    }
    // 不动项目记忆：它记的是「专属会话」，被新对话覆盖会让后续 switch 指错人
    return { status: 200, body: { ok: true, sessionId, reused: false, title: created?.title ?? created?.session?.header?.title ?? '' } }
  } catch (error) {
    return { status: 502, body: { ok: false, error: `创建会话失败：${error?.message ?? error}` } }
  }
}

/**
 * 显式给了 sessionId 就用它；没给就用专属会话。
 *
 * 这里**不再**拿 `sessionController.list()` 判存在性：list() 是宿主编排层的列表页，
 * 会漏掉刚建、后台归档、被过滤掉的会话（实测 f389 在 /api/sessions 命中、转录也在，
 * 但 list() 没有它，旧逻辑直接 404，App 见 404 就清掉本地钉的会话，下一句落到
 * 「界面当前会话」——用户的话就这样进了别人的会话）。真不存在让 prompt 自己报，
 * 再由 isMissingSessionError 映射成 404。
 */
async function targetSessionId(ctx, state, explicit) {
  const want = String(explicit ?? '').trim()
  if (want) return want
  return (await petTargetSession(ctx, state)).sessionId
}

/** 宿主 prompt 报「会话不存在」的几种说法；只有这种错误才该回 404。 */
function isMissingSessionError(error) {
  const message = String(error?.message ?? error ?? '')
  return /会话不存在|不存在|not found|unknown session|no such session|does not exist/i.test(message)
}

/**
 * 这只会话宿主和磁盘认不认识：list() → controller.get() → 投影缓存/转录。
 * 任何一层认得就算在（宁可让 prompt 去撞一次，也别把能用的会话判死）。
 */
async function sessionKnownToHost(ctx, sessionId, rowsHint) {
  const want = String(sessionId ?? '').trim()
  if (!want) return false
  const rows = rowsHint ?? (await sessionRows(ctx))
  if (rows.some((row) => row.id === want)) return true
  const controller = ctx.get?.('sessionController')
  if (typeof controller?.get === 'function') {
    try {
      const got = await controller.get(want)
      const gotId = String(got?.sessionId ?? got?.id ?? got?.session?.id ?? '')
      if (gotId || got) return true
    } catch {
      /* 没有 get() 或它不认识：继续用磁盘兜底 */
    }
  }
  try {
    return Boolean(sessionDetail({ id: want, limit: '1' }))
  } catch {
    return false
  }
}

/* ── 问进展时「旁听」：只读看一眼同项目里最近活跃的另一只 ──
 *
 * 手机钉的那只用来聊天，但用户常想知道「另一边开发到哪了」。往那只里发一句会打断
 * 正在跑的活，所以这里只读：转录文件 + git 现状，压成一段贴在本轮提示词后面。
 * 不出现在手机上显示的文字里（App 的气泡还是用户自己说的那句），也不写那只会话。
 */

// 材料会整段贴在手机那句话后面，宿主界面上就是这条提问的正文。所以要小：
// 一句话能带的量（三四行），够回答「进展怎么样」，不再糊一屏。
const PEEK_TEXT_MAX = 300
const PEEK_GIT_MAX = 90
const PEEK_LINE_MAX = 100
/** 「在问另一边进展」的几种说法。整句超过 400 字就不认，避免长文里偶然出现「进度」。 */
const PEEK_ASK = /(进展|进度|做到哪|做到什么程度|到哪一步|卡在哪|最近在(干|做|忙)|最近怎么样|现在怎么样|忙什么呢|下一步)/

function peekWanted(text) {
  const body = String(text ?? '').trim()
  if (!body || body.length > 400) return false
  return PEEK_ASK.test(body)
}

/**
 * 同项目里最近活跃的另一只（排除自己钉的那只）。projectOf 由调用方注入，
 * 单测里直接给假的，不用起宿主。
 */
function pickPeekTarget(rows, boundId, opts = {}) {
  const bound = String(boundId ?? '')
  const projectOf = typeof opts.projectOf === 'function' ? opts.projectOf : () => ''
  const raw = Array.isArray(rows) ? rows : []
  const boundRow = raw.find((row) => String(row?.id ?? '') === bound)
  const boundProject =
    String(opts.projectId ?? '') ||
    String(boundRow?.workspaceId ?? '') ||
    projectOf({ id: bound, cwd: String(opts.cwd ?? '') })
  const list = raw
    .map((row) => ({
      id: String(row?.id ?? ''),
      title: String(row?.title ?? ''),
      cwd: String(row?.cwd ?? ''),
      workspaceId: String(row?.workspaceId ?? ''),
      updatedAt: toMs(row?.updatedAt),
    }))
    .filter((row) => row.id && row.id !== bound)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const row of list) {
    if (boundProject) {
      const project = row.workspaceId || projectOf(row)
      if (project !== boundProject) continue
    }
    return row
  }
  return null
}

/** 转录 → 每行一句的摘要，只留尾部到 maxChars（先留最近的）。 */
function peekTranscriptLines(detail, maxChars = PEEK_TEXT_MAX) {
  const msgs = Array.isArray(detail?.messages) ? detail.messages : []
  const lines = []
  for (const m of msgs) {
    const role = String(m?.role ?? '')
    if (role === 'user') lines.push(`用户：${clipText(m?.text ?? '', PEEK_LINE_MAX)}`)
    else if (role === 'assistant') lines.push(`助手：${clipText(m?.text ?? '', PEEK_LINE_MAX)}`)
    else if (role === 'tool' && m?.tool?.name) lines.push(`（用了 ${m.tool.name}）`)
  }
  const kept = []
  let total = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (total + line.length + 1 > maxChars && kept.length) break
    kept.push(line)
    total += line.length + 1
  }
  return kept.reverse()
}

/** 那个项目此刻的代码现状：最近提交 + 未提交改动。读不到就返回空串。 */
function gitDigest(cwd, maxChars = PEEK_GIT_MAX) {
  const dir = String(cwd ?? '').trim()
  if (!dir || !existsSync(dir)) return ''
  const run = (args) => {
    try {
      return String(
        execFileSync('git', args, {
          cwd: dir,
          timeout: 2500,
          maxBuffer: 1 << 20,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }) ?? '',
      ).trim()
    } catch {
      return ''
    }
  }
  // 只要一行：最新一条提交 + 有没有未提交改动。原来贴 12 条提交加 diff --stat，
  // 占了整段材料的一大半，读的人（和手机界面）都只需要知道「动到哪了」。
  const head = run(['log', '--oneline', '-1'])
  const status = run(['status', '--short'])
  const changed = status ? status.split('\n').filter(Boolean).length : 0
  const bits = []
  if (head) bits.push(`最新提交：${head}`)
  if (status) bits.push(`未提交的改动：${changed} 个文件`)
  else if (head) bits.push('未提交的改动：没有')
  if (!bits.length) return ''
  const text = bits.join('；')
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** 把旁听材料拼成一段，边界写清楚，免得模型把它当成这条对话里的内容。 */
function buildPeekBlock(peek) {
  const title = String(peek?.title ?? '')
  const when = toMs(peek?.updatedAt)
    ? new Date(toMs(peek.updatedAt)).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
    : ''
  // 头一行就要说清「这不是这条对话里的内容」，但只用一行。
  const head = `【旁听·不属于这条对话】${title || String(peek?.id ?? '')}${when ? ` · ${when}` : ''}`
  const lines = [head]
  const body = Array.isArray(peek?.lines) ? peek.lines : []
  if (body.length) lines.push(`最近的对话：${body.join(' / ')}`)
  const git = String(peek?.git ?? '').replace(/\s*\n\s*/g, '；')
  if (git) lines.push(`代码现状：${git}`)
  lines.push('材料里没有的就说没看到，别猜。')
  const text = lines.join('\n')
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

/** 派发时调用：不是问进展就返回空串，任何异常都只记日志、不影响这句话发出去。 */
async function peekContext(ctx, boundSessionId, text) {
  if (!peekWanted(text)) return ''
  const startedAt = Date.now()
  try {
    const rows = await sessionRowsCached(ctx)
    const byPath = projectIdByPath(workspaceRows(ctx))
    const bound = String(boundSessionId ?? '')
    const boundMeta = projectCacheOf(bound)
    const boundRow = rows.find((row) => String(row?.id ?? '') === bound)
    const cwd = String(boundRow?.cwd ?? '') || boundMeta.cwd || ''
    const projectOf = (row) => {
      const direct = String(row?.workspaceId ?? '')
      if (direct) return direct
      const path = String(row?.cwd ?? '')
      if (path) return projectIdOfPath(byPath, path)
      const id = String(row?.id ?? '')
      return id ? projectIdOfPath(byPath, projectCacheOf(id).cwd || '') : ''
    }
    const target = pickPeekTarget(rows, bound, { cwd, projectOf })
    if (!target) return ''
    const meta = projectCacheOf(target.id)
    const detail = sessionDetail({ id: target.id, limit: '30' })
    const lines = peekTranscriptLines(detail)
    const git = gitDigest(cwd || target.cwd || meta.cwd)
    if (!lines.length && !git) return ''
    const block = buildPeekBlock({
      id: target.id,
      title: target.title || meta.title || '',
      updatedAt: target.updatedAt || meta.updatedAt || 0,
      lines,
      git,
    })
    netLog('peek', { sessionId: bound, from: target.id, chars: block.length, ms: Date.now() - startedAt })
    return block
  } catch (error) {
    LOG('旁听失败：', error?.message ?? error)
    return ''
  }
}

/**
 * 派发主体：把一句手机话送进指定会话，返回 `{status, body}` 交给路由写响应。
 * 抽出来是为了单测能不起 HTTP 覆盖「会话不存在 / 专属会话丢失」两条路径。
 */
async function dispatchToSession(ctx, state, body, req, deps) {
  // 「没收到回复」只有这里能复盘：手机看到的是一句提示，电脑这边必须留下
  // 这次派发到底 404/202/200、被去重还是被中断。文本只截前 60 字。
  const startedAt = Date.now()
  const text = String(body?.text ?? '').trim()
  const rid = String(body?.requestId ?? '').trim().slice(0, 12)
  let outcome
  try {
    outcome = await dispatchToSessionInner(ctx, state, body, req, deps)
    return outcome
  } finally {
    flowLog(
      TURN_LOG_PATH,
      `dispatch status=${outcome?.status ?? 'throw'} rid=${rid || '-'} chars=${text.length} ` +
        `${outcome?.body?.deduped ? 'deduped ' : ''}${Date.now() - startedAt}ms text=${text.slice(0, 60)}`,
    )
  }
}

async function dispatchToSessionInner(ctx, state, body, req, deps) {
  const text = String(body?.text ?? '').trim()
  // 附件先校验再拼文本：路径不存在/超 6 条要在受理前就 400，别让手机以为发出去了。
  const attachments = normalizeAttachments(body?.attachments)
  if (!attachments.ok) return { status: 400, body: { ok: false, error: attachments.error } }
  const attachmentPaths = attachments.paths
  if (!text && !attachmentPaths.length) return { status: 400, body: { ok: false, error: 'text 为空' } }
  let promptText = composeDispatchText(text, attachmentPaths)
  const controller = ctx.get?.('sessionController')
  if (!controller?.prompt) return { status: 503, body: { ok: false, error: '宿主缺少 sessionController' } }

  let sessionId = ''
  try {
    sessionId = await targetSessionId(ctx, state, body?.sessionId)
  } catch (error) {
    netLog('dispatch-target-failed', { error: String(error?.message ?? error) })
    // 没显式指定、专属会话又建不出来：明说不可用，**绝不**退回「界面当前会话」。
    return { status: 503, body: { ok: false, error: '专属会话不可用' } }
  }

  // 手机钉了一只已经不存在的会话：机械地 404，让 App 清掉本地指针。不要把
  // 「存不存在」寄托在 prompt 的报错文案上——宿主各版本说法不一致，猜不中就变成
  // 「假成功」：界面上已受理，实际上永远没有回复。
  if (String(body?.sessionId ?? '').trim() && !(await sessionKnownToHost(ctx, sessionId))) {
    return { status: 404, body: { ok: false, error: `会话不存在：${sessionId}` } }
  }

  // 「进展怎么样」这类问题：只读看一眼同项目里最近活跃的另一只，材料贴在本轮提示词后面。
  const peekBlock = await peekContext(ctx, sessionId, text)
  if (peekBlock) promptText = `${promptText}\n\n${peekBlock}`

  // 切网重发：同一个 requestId 只落一轮，避免电脑端出现两条相同提问。
  const rid = String(body?.requestId ?? '').trim()
  netLog('dispatch', { sessionId, chars: text.length, attachments: attachmentPaths.length, rid: rid.slice(0, 12) })
  if (rid) {
    const hit = DISPATCH_SEEN.get(rid)
    if (hit && Date.now() - hit.at < 120_000) {
      netLog('dispatch-dedupe', { sessionId: hit.sessionId })
      return { status: 200, body: { ok: true, accepted: true, sessionId: hit.sessionId, usedSessionId: hit.sessionId, deduped: true, attachments: attachmentPaths.length } }
    }
    DISPATCH_SEEN.set(rid, { at: Date.now(), sessionId })
    for (const [key, value] of DISPATCH_SEEN) {
      if (Date.now() - value.at > 120_000) DISPATCH_SEEN.delete(key)
    }
  }

  // 会话里的提问是排队的：上一轮还在跑（或已经卡住）时，手机这一句会一直等。
  // 桌宠要的是「说完就有回应」，所以新一句直接掐掉上一轮。
  //
  // 两种 id 写法都按同一轮算（宿主有的地方带 `session-` 前缀、有的不带），
  // 只认一种写法的话状态对不上，掐不掉。
  const liveTurns = deps.liveTurns
  const liveAbort = deps.liveAbort
  const turnKeys = [...new Set([sessionId, bareSessionId(sessionId)].filter(Boolean))]
  const prevAbort = turnKeys.map((key) => liveAbort.get(key)).find(Boolean)
  const prevRunning = turnKeys.some((key) => liveTurns.has(key))
  if (prevRunning) {
    if (prevAbort) {
      netLog('dispatch-interrupt', { sessionId })
      try { prevAbort.abort() } catch { /* 已经结束 */ }
    } else {
      // 上一轮不是我们派的（用户在电脑上直接发的）：没有我们自己的 abort，就请
      // 宿主取消这条会话的当前轮，否则手机会一直排在后面等。
      netLog('dispatch-cancel', { sessionId })
      try {
        const cancelled = controller.cancel?.({ sessionId }, AbortSignal.timeout(4000))
        Promise.resolve(cancelled).catch((error) => LOG('上一轮取消失败：', error?.message ?? error))
      } catch (error) {
        LOG('上一轮取消失败：', error?.message ?? error)
      }
    }
  }
  const ac = new AbortController()
  const acTimer = setTimeout(() => { try { ac.abort() } catch { /* ignore */ } }, 120_000)
  for (const key of turnKeys) liveAbort.set(key, ac)
  // 人设/长度档挂进这条会话的 system prompt：只有模型看得见，不进对话记录。
  await syncHiddenPrompt(ctx, sessionId, getPanelConfig())
  const prompt = controller.prompt(
    {
      requestId: rid || randomBytes(8).toString('hex'),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: buildDispatchPrompt(promptText) }],
      clientTimeZone: tzOf(req),
    },
    ac.signal,
  ).finally(() => {
    clearTimeout(acTimer)
    for (const key of turnKeys) {
      if (liveAbort.get(key) === ac) liveAbort.delete(key)
    }
  })

  // 立刻回执，别让手机等整轮；若 1.2s 内就报错则如实返回，方便现场定位契约问题。
  const first = await Promise.race([
    prompt.then((value) => ({ settled: true, value }), (error) => ({ failed: true, error })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 1200)),
  ])
  if (first.failed) {
    // 失败就别留去重记录，否则用户重发同一句会被当成「已收到」而永远落不了地。
    if (rid) DISPATCH_SEEN.delete(rid)
    if (isMissingSessionError(first.error)) {
      // 只有 prompt 明说「不存在」才 404：App 见 404 会清掉本地钉的会话，不能乱报。
      return { status: 404, body: { ok: false, error: `会话不存在：${sessionId}` } }
    }
    return { status: 502, body: { ok: false, error: String(first.error?.message ?? first.error) } }
  }
  if (first.settled === false) {
    prompt.catch((error) => {
      LOG('prompt 异步失败：', error?.message ?? error)
      deps.emit(sessionId, 'error', { message: String(error?.message ?? error) })
    })
    return { status: 202, body: { ok: true, accepted: true, sessionId, usedSessionId: sessionId, attachments: attachmentPaths.length } }
  }
  return { status: 200, body: { ok: true, accepted: true, sessionId, usedSessionId: sessionId, value: first.value ?? null, attachments: attachmentPaths.length } }
}

/* ------------------------------------------------------------------ */
/* 语音指令解析（纯函数，单独导出方便单测）                             */
/* ------------------------------------------------------------------ */

/** 一句话指令最多看这么多字，超了就截断（语音识别偶尔会吐一整段）。 */
const COMMAND_MAX_CHARS = 300

/** 停止类：整句等于其中之一才认，避免「取消订阅」这种被误当停。 */
const STOP_WORDS = ['停', '停下', '停止', '停一下', '别说了', '别讲了', '安静', '取消', '不用了', '算了']

/** 切项目前缀，长的放前面（`切换到` 必须先于 `切换`，`切到` 必须先于 `切`）。 */
const SWITCH_PREFIXES = ['切换到', '切到', '切换', '打开项目', '打开', '进入', '转到', '去']

/** 派发型动词：「派发 <内容> 给 <项目>」这一族。 */
const DISPATCH_VERBS = ['派发', '派给', '安排', '交给']

/** 去标点：一次性字符集替换，不分支、不堆正则。 */
function normalizeCommand(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？、；：,.!?;:"'“”‘’（）()《》「」【】〈〉…—~～]/g, ' ')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
}

const bareName = (value) => trailPath(value).split('/').filter(Boolean).pop() ?? ''

/**
 * 在项目列表里找一句话里的「项目名」。
 *
 * 顺序：标题全等 → id 全等 → 路径末段全等 → 唯一子串（标题或路径末段互相包含）。
 * 找不到或有歧义就回 candidates（最多 5 个标题），让手机能反问「你说的是 A 还是 B」。
 */
export function matchWorkspace(rawName, workspaces) {
  const rows = Array.isArray(workspaces) ? workspaces : []
  const want = normalizeCommand(rawName).toLowerCase()
  const raw = String(rawName ?? '').trim()
  if (!want) return { candidates: [] }
  const titleOf = (w) => String(w?.title ?? '').trim()
  const hit =
    rows.find((w) => titleOf(w).toLowerCase() === want) ||
    rows.find((w) => String(w?.id ?? '') === raw) ||
    rows.find((w) => bareName(w?.path).toLowerCase() === want)
  if (hit) return { hit }
  const loose = rows.filter((w) => {
    const title = titleOf(w).toLowerCase()
    const tail = bareName(w?.path).toLowerCase()
    return (title && (title.includes(want) || want.includes(title))) || (tail && (tail.includes(want) || want.includes(tail)))
  })
  if (loose.length === 1) return { hit: loose[0] }
  return { candidates: (loose.length ? loose : rows).map(titleOf).filter(Boolean).slice(0, 5) }
}

const missSay = (name, candidates) =>
  candidates.length ? `没找到叫 ${name} 的项目，你说的是 ${candidates.map((c) => `《${c}》`).join('、')} 吗` : `没找到叫 ${name} 的项目`

/**
 * 把一句语音指令解析成动作。**不执行任何东西、不碰会话**（纯函数）。
 *
 * 返回 `{ action, title?, content?, say, candidates? }`：
 * - `switch`：`title` 是项目列表里的规范标题，`say` 已可念；
 * - `switch-miss`：项目名对不上/有歧义，带 `candidates`；
 * - `dispatch`：`title` + `content`，`say` 由调用方在真正派发成功后再填；
 * - `dispatch-miss`：派发目标项目对不上；
 * - `stop`：`say` 已可念；
 * - `chat`：其余一切（`say:null`），调用方应走原来的 `/api/dispatch`。
 */
export function parseCommand(text, workspaces) {
  const raw = String(text ?? '')
  const body = normalizeCommand(raw.length > COMMAND_MAX_CHARS ? raw.slice(0, COMMAND_MAX_CHARS) : raw)
  const chat = { action: 'chat', say: null }
  if (!body) return chat

  if (STOP_WORDS.includes(body)) return { action: 'stop', say: '好，停了' }

  const dispatchWith = (name, content) => {
    const found = matchWorkspace(name, workspaces)
    if (found.hit) return { action: 'dispatch', title: String(found.hit.title ?? name), content, say: null, miss: '' }
    return {
      action: 'dispatch-miss',
      miss: name,
      content,
      candidates: found.candidates ?? [],
      say: missSay(name, found.candidates ?? []),
    }
  }

  // 「让 <项目> 做/去 <内容>」「让 <项目> 帮我做 <内容>」
  if (body.startsWith('让')) {
    const rest = body.slice(1).trim()
    for (const sep of ['帮我做', '去做', '帮我', '做', '去']) {
      const at = rest.indexOf(sep)
      if (at > 0) {
        const name = rest.slice(0, at).trim()
        const content = rest.slice(at + sep.length).trim()
        if (name && content) return dispatchWith(name, content)
      }
    }
  }

  // 「派发/交给/安排/派给 <内容> 给 <项目>」（用最后一个「给」切，内容里可以有「给」）
  for (const verb of DISPATCH_VERBS) {
    if (!body.startsWith(verb)) continue
    const rest = body.slice(verb.length).trim()
    const at = rest.lastIndexOf('给')
    if (at > 0) {
      const content = rest.slice(0, at).trim()
      const name = rest.slice(at + 1).trim()
      if (content && name) return dispatchWith(name, content)
    }
  }

  for (const prefix of SWITCH_PREFIXES) {
    if (!body.startsWith(prefix)) continue
    const name = body.slice(prefix.length).trim()
    if (!name) break
    const found = matchWorkspace(name, workspaces)
    if (found.hit) {
      const title = String(found.hit.title ?? name)
      return { action: 'switch', title, say: `好，切到《${title}》了` }
    }
    const candidates = found.candidates ?? []
    return { action: 'switch-miss', miss: name, candidates, say: missSay(name, candidates) }
  }

  return chat
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 朗读文本净化：Markdown 不该被念成「星号星号」                        */
/* ------------------------------------------------------------------ */

const SPEECH_LINK = /\[([^\]]*)\]\(\s*<?((?:[^()\s>]|\([^()]*\))*)>?\s*\)/g
const SPEECH_URL = /(?:https?:\/\/|www\.)[^\s)」』，。；、]+/g

/**
 * Markdown → 可直接交给 TTS 的纯口语文本。幂等：已经是纯文本就原样返回。
 * 规则：代码块整段丢；表格分隔行丢、单元格用「，」连；链接留文字、裸 URL 念「链接」；
 * 标题/引用/列表/任务框/水平线的符号前缀去掉；强调、行内代码、删除线的标记去掉；
 * 行内换行与空行压成停顿（「，」），最后兜底清掉任何残留标记符号。
 */
/**
 * 朗读前的表情剥离：emoji 读出来是乱码/静音/怪音，用户也不指望听见「笑脸」。
 * 覆盖表情本体、肤色修饰、ZWJ 连字、变体选择符、按键组合、标签字符。
 */
const EMOJI_CHARS = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu
export function stripEmojiForSpeech(input) {
  return String(input ?? '').replace(EMOJI_CHARS, '')
}

export function stripForSpeech(input) {
  let text = String(input ?? '')
  if (!text.trim()) return ''
  // 表情先摘掉：后面的标点/换行清理会把留下的空档收干净
  text = stripEmojiForSpeech(text)
  if (!text.trim()) return ''
  // 代码围栏：内容读出来是噪音，整段跳过（含未闭合的尾巴）
  text = text.replace(/```[^\n]*\n[\s\S]*?```/g, ' ')
  text = text.replace(/~~~[^\n]*\n[\s\S]*?~~~/g, ' ')
  text = text.replace(/```[\s\S]*$/, ' ')
  // 表格：先删 |---|---| 分隔行，再把其余行拆成「格1，格2」
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm, '')
  text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_all, inner) =>
    String(inner).split('|').map((cell) => cell.trim()).filter(Boolean).join('，'))
  // 图片没有可读文字，说「图片」；链接只留文字
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' 图片 ')
  text = text.replace(SPEECH_LINK, (_all, label, href) => (/^https?:/i.test(href) ? label : label || '链接'))
  text = text.replace(SPEECH_URL, '链接 ')
  // 块级前缀
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '')
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  text = text.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]*/gm, '')
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  text = text.replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
  // 行内标记
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1$2')
  text = text.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1$2')
  text = text.replace(/~~([^~]+)~~/g, '$1')
  text = text.replace(/`+([^`]*)`+/g, '$1')
  // 换行 → 停顿：空行用「。」，单换行用「，」
  text = text.replace(/[ \t]*\n[ \t]*\n[ \t]*/g, '。')
  text = text.replace(/[ \t]*\n[ \t]*/g, '，')
  text = text
    .replace(/[，,]{2,}/g, '，')
    .replace(/。{2,}/g, '。')
    .replace(/([。！？])[，、]/g, '$1')
    .replace(/[。]{2,}/g, '。')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[，、；：]\s*。/g, '。')
    .replace(/^[，。！？；：、\s]+/, '')
    .replace(/[，、；：\s]+$/, '')
  // 兜底：残留的 md 符号（含没闭合的 [x]( ）一个都不许念出来
  text = text.replace(/[#*`~]|\[|\]\(/g, '').replace(/[[\]]/g, '')
  return text.trim()
}

/* ------------------------------------------------------------------ */
/* 服务端 Markdown → 安全 HTML（App 用 WebView 渲染助手回复）           */
/* ------------------------------------------------------------------ */

const RENDER_MAX_CHARS = 20000
const RENDER_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => RENDER_ESCAPES[char])

function renderInline(escaped) {
  let out = escaped
  // 行内代码先抽走，免得内部被当成粗体
  const codes = []
  out = out.replace(/`([^`]+)`/g, (_all, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  // 链接：只放行 http(s)，其余降级成纯文字
  out = out.replace(/\[([^\]]*)\]\(\s*<?((?:[^()\s>]|\([^()]*\))*)>?\s*\)/g, (_all, label, href) => {
    if (!/^https?:\/\//i.test(href)) return label
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label || href}</a>`
  })
  out = out.replace(/\u0000(\d+)\u0000/g, (_all, index) => `<code>${codes[Number(index)] ?? ''}</code>`)
  return out
}

/**
 * Markdown → 可塞进 WebView 的 HTML 片段。先转义再渲染，raw HTML 一律当文字。
 * 支持：段落/换行、粗斜体、行内代码、#~######（降级 h3/h4/h5）、有序/无序列表（一层嵌套）、
 * 引用、``` 围栏（等宽块）、GFM 表格、http(s) 链接（target=_blank）、水平线、删除线。
 */
export function renderMarkdown(input) {
  const source = String(input ?? '').replace(/\r\n?/g, '\n')
  if (!source.trim()) return ''
  const lines = source.split('\n')
  const out = []
  let index = 0
  const isTableRow = (line) => /^[ \t]*\|.*\|[ \t]*$/.test(line)
  const isTableDivider = (line) => /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/.test(line)
  const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())

  while (index < lines.length) {
    const line = lines[index]
    // 围栏代码
    const fence = /^[ \t]*(```|~~~)[ \t]*([\w+#.-]*)[ \t]*$/.exec(line)
    if (fence) {
      const body = []
      const marker = fence[1]
      index += 1
      while (index < lines.length && !new RegExp(`^[ \\t]*${marker}`).test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      const lang = fence[2] ? ` class="language-${escHtml(fence[2])}"` : ''
      out.push(`<pre><code${lang}>${escHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      index += 1
      continue
    }
    // 标题：统一降到 h3/h4/h5，别让助手回复把页面结构顶飞
    const heading = /^[ \t]{0,3}(#{1,6})[ \t]+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(5, Math.max(3, heading[1].length + 1))
      out.push(`<h${level}>${renderInline(escHtml(heading[2]))}</h${level}>`)
      index += 1
      continue
    }
    // 水平线
    if (/^[ \t]*(?:[-*_][ \t]*){3,}$/.test(line)) {
      out.push('<hr>')
      index += 1
      continue
    }
    // 引用（连续行合并成一段）
    if (/^[ \t]{0,3}>/.test(line)) {
      const body = []
      while (index < lines.length && /^[ \t]{0,3}>/.test(lines[index])) {
        body.push(lines[index].replace(/^[ \t]{0,3}>[ \t]?/, ''))
        index += 1
      }
      out.push(`<blockquote><p>${body.map((item) => renderInline(escHtml(item))).join('<br>')}</p></blockquote>`)
      continue
    }
    // GFM 表格：表头 + 分隔行 + 若干行
    if (isTableRow(line) && isTableDivider(lines[index + 1] ?? '')) {
      const head = splitRow(line)
      index += 2
      const body = []
      while (index < lines.length && isTableRow(lines[index])) {
        body.push(splitRow(lines[index]))
        index += 1
      }
      const thead = `<thead><tr>${head.map((cell) => `<th>${renderInline(escHtml(cell))}</th>`).join('')}</tr></thead>`
      const tbody = `<tbody>${body.map((row) => `<tr>${head.map((_h, i) => `<td>${renderInline(escHtml(row[i] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody>`
      out.push(`<table>${thead}${tbody}</table>`)
      continue
    }
    // 列表：支持一层嵌套，项内可带续行
    const listStart = /^[ \t]*([-*+]|\d+[.)])[ \t]+/
    if (listStart.test(line)) {
      const ordered = /^[ \t]*\d+[.)][ \t]+/.test(line)
      const items = []
      const nestedStart = /^[ \t]{2,}([-*+]|\d+[.)])[ \t]+/
      while (index < lines.length && (listStart.test(lines[index]) || /^[ \t]{2,}\S/.test(lines[index]))) {
        if (nestedStart.test(lines[index]) && items.length) {
          items[items.length - 1].children.push(lines[index].replace(nestedStart, ''))
        } else if (listStart.test(lines[index])) {
          items.push({ text: lines[index].replace(listStart, ''), children: [] })
        } else if (items.length) {
          items[items.length - 1].text += ` ${lines[index].trim()}`
        }
        index += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      const html = items
        .map((item) => {
          const nested = item.children.length
            ? `<${tag}>${item.children.map((child) => `<li>${renderInline(escHtml(child))}</li>`).join('')}</${tag}>`
            : ''
          return `<li>${renderInline(escHtml(item.text))}${nested}</li>`
        })
        .join('')
      out.push(`<${tag}>${html}</${tag}>`)
      continue
    }
    // 段落：连续非空、非块级起始的行合并
    const para = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^[ \t]*(```|~~~)/.test(lines[index]) &&
      !/^[ \t]{0,3}#{1,6}[ \t]/.test(lines[index]) &&
      !/^[ \t]{0,3}>/.test(lines[index]) &&
      !listStart.test(lines[index]) &&
      !(isTableRow(lines[index]) && isTableDivider(lines[index + 1] ?? '')) &&
      !/^[ \t]*(?:[-*_][ \t]*){3,}$/.test(lines[index])
    ) {
      para.push(lines[index])
      index += 1
    }
    if (!para.length) {
      // 万一前面条件全 false 又没推进，强制吃掉一行，绝不空转
      out.push(`<p>${renderInline(escHtml(line))}</p>`)
      index += 1
      continue
    }
    out.push(`<p>${para.map((item) => renderInline(escHtml(item))).join('<br>')}</p>`)
  }
  return out.join('\n')
}

/* ------------------------------------------------------------------ */
/* 人设 / 输出长度：派发前拼进 prompt                                    */
/* ------------------------------------------------------------------ */

const MAXWORDS_LEVELS = ['短', '中', '长']
const MAXWORDS_LINES = {
  短: '回复控制在 80 字内，先说结论，像聊天一样自然。',
  中: '回复控制在 300 字内，先说结论，再自然补充几句。',
  长: '可以展开说明，先说结论，再自然补充细节。',
}

/** 说话方式：对话要像真人聊天，不要输出测试报告式的清单（状态/延迟/下一句之类）。 */
export const TONE_RULE = [
  '【最高优先级的说话方式，覆盖此前一切汇报习惯】',
  '你现在是在手机上跟主人聊天，不是干活，也不是汇报进度：用一两句口语接话，最多三句，像朋友那样。',
  '禁止列表、编号、项目符号、表格、字段名（状态/延迟/进度/下一句/收到），禁止测试报告口吻；不许提工具、任务、会话、重启、空闲、派活。',
  '主人发来表情就顺着接住它的情绪，不用描述或解释这个表情。',
  '除非主人明确要清单，否则只说人话。',
].join('\n')

export function normalizeMaxWords(value) {
  const text = String(value ?? '').trim()
  return MAXWORDS_LEVELS.includes(text) ? text : '短'
}

/**
 * 派发正文只有用户原话。
 *
 * 早期把「人设 + 长度档」拼在正文前面，理由是「宿主 prompt 没有 system 角色」——
 * 那条前提是错的：宿主 `systemPrompt.section()` 能挂一段只作用于这一条会话的
 * 系统提示，既不进会话记录，也不会让用户在对话里看到自己的话被加前缀。人设和
 * 长度档现在走 buildHiddenPrompt() + syncHiddenPrompt()，正文保持原样。
 */
export function buildDispatchPrompt(text) {
  return String(text ?? '').trim()
}

/** 隐藏段：人设 + 长度档，挂进会话的 system prompt，不落进对话正文。 */
export function buildHiddenPrompt(config = {}) {
  const blocks = []
  const persona = String(config?.persona ?? '').trim()
  if (persona) blocks.push(`角色设定（用户配置的人设，覆盖默认语气）：\n${persona.slice(0, 2000)}`)
  blocks.push(TONE_RULE)
  blocks.push(MAXWORDS_LINES[normalizeMaxWords(config?.maxWords)])
  return blocks.join('\n\n')
}

/**
 * sessionId -> { text, agent, dispose }：这条会话现在挂着哪段隐藏提示。
 *
 * 作用域的关键：`systemPrompt.section()` 按**服务实例自己的 ctx** 分层
 * （dsh-system-prompt 里 `this.layers.effect(this.ctx, …)`），而 `ctx.get()` 返回的是
 * 绑在**访问方** ctx 上的代理。所以 `agent.ctx.get('systemPrompt').section()` 落在这
 * 只 agent 的层上：别的会话、别的项目都看不见，agent 卸载时效果自动摘掉。
 *
 * 别改用 `agentPresets.serviceFor(agent,'systemPrompt')`：它返回预设挂载作用域里的
 * **裸实例**，`this.ctx` 不是这只 agent；一旦某个预设自己提供 systemPrompt，这段就会
 * 挂到同一预设版本的全部会话上（`serviceForMount` 只看 fiber 归属，不做 per-agent 隔离）。
 */
const hiddenSections = new Map()

export async function syncHiddenPrompt(ctx, sessionId, config) {
  if (!sessionId) return false
  const text = buildHiddenPrompt(config)
  const controller = ctx?.get?.('sessionController')
  if (!controller?.resolveAgent) {
    netLog('hidden-skip', { reason: 'no-scope-api' })
    return false
  }
  try {
    const resolved = await controller.resolveAgent(sessionId)
    const agent = resolved?.agent
    if (!agent) {
      netLog('hidden-skip', { reason: resolved?.error?.kind ?? 'no-agent' })
      return false
    }
    // 文本没变**且还是同一只 agent** 才是真的已经挂好了。只比文本会漏一种情况：
    // 宿主重开会话/重建 agent 后效果已随旧 agent 摘掉，映射却还留着旧 dispose，
    // 之后便一直“早就挂好了”，人设静默丢失。
    const current = hiddenSections.get(sessionId)
    if (current?.text === text && current.agent === agent) return true
    if (current) {
      try { current.dispose() } catch { /* 已经摘掉了 */ }
      hiddenSections.delete(sessionId)
    }
    let service
    try {
      service = agent.ctx?.get?.('systemPrompt')
    } catch {
      service = undefined
    }
    if (!service?.section) {
      netLog('hidden-skip', { reason: 'no-system-prompt' })
      return false
    }
    const dispose = service.section({ name: 'pet-persona', order: 100, text })
    hiddenSections.set(sessionId, { text, agent, dispose })
    netLog('hidden-section', { sessionId, via: 'agent-ctx', chars: text.length })
    return true
  } catch (error) {
    netLog('hidden-failed', { error: String(error?.message ?? error) })
    return false
  }
}

/** 插件卸载时把挂上去的段都摘掉，重载后不会重复注册。 */
export function disposeHiddenPrompts() {
  for (const { dispose } of hiddenSections.values()) {
    try { dispose() } catch { /* 已经摘掉了 */ }
  }
  hiddenSections.clear()
}


/* 插件本体                                                           */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const settings = config ?? {}
  const petName = typeof settings.petName === 'string' && settings.petName.trim() ? settings.petName.trim() : '鲸灵'
  const stateless = Boolean(settings.stateless)
  // token 走 currentToken()，文件被删/改会自动跟随（见该函数注释）
  const state = loadState()
  // 每只会话现在是不是在跑：App 的对话页要据此显示「处理中 / 中断」
  const liveTurns = new Map()
  /** sessionId -> AbortController：新一句派发时掐掉上一轮，别让手机排在队尾干等。 */
  const liveAbort = new Map()
  /**
   * sessionId -> { stamp, reason, timer }：**等 final 发完再补 end**。
   *
   * `assistant-stream` 的 finish 比 `session/event` 的 assistant/message 早到，早先
   * 直接发 end，手机端就收到「end 了但没 final」；隧道一慢，两件事的间隔超过客户端
   * 的 1.5s 宽限，界面停在「思考中」然后归零——0.8.4 真机上宿主明明生成了回复、
   * App 一个气泡都没有，就是这个。现在 finish 只登记，final 到了再补 end；真没有
   * 正文（报错/中断）时由定时器兜底发。
   */
  const pendingEnd = new Map()
  /**
   * sessionId -> { text, turn }：这一轮最后一条 assistant 正文。
   *
   * 官方语义里一轮可能有多条 `assistant/message`（说了「我查一下」→ 调工具 → 再
   * 说话），终止信号**只有** `turn/end`。所以中间消息只发非终止的 `message` 帧，
   * 正文记在这里，等 `turn/end` 到了才当 `final` 发出去。
   */
  const turnText = new Map()
  /**
   * 等 `turn/end` 的兜底窗口。
   *
   * 以前是 2.5 秒：工具任务要跑十几秒，兜底先到 → 手机判「这一轮结束」，后半段
   * 全丢。这不是「等正文的宽限」，而是「turn/end 根本没来」时的最后保险，所以必须
   * 长到能覆盖正常工具调用（实测本机工具任务多在 30s 内），取 90s。
   */
  const END_GRACE_MS = 90_000
  /**
   * 硬上限：一轮「还活着」（turn/start 之后、turn/end 之前）超过这么久，就当它卡死，
   * 兜底发 end。正常工具任务不会跑到这里。
   */
  const HARD_GRACE_MS = 5 * 60_000
  /**
   * 登记「该收尾了」，END_GRACE_MS 后再发 end——但**这一轮还活着就别发**。
   *
   * 长工具步骤（编译、装包）能跑几分钟，这期间只有 finish、等不到 turn/end。提前发
   * end，手机会把还在生成的这一轮当成结束：正文只播到一半，气泡停在半句（2026-10-25
   * 晚上手机只剩一个「看」，就是这个形状）。所以只要 liveTurns 里还有它，就再等一轮
   * 宽限，直到 HARD_GRACE_MS 才认定它真的卡死。
   */
  function armEndFallback(sessionId, reason) {
    const prev = pendingEnd.get(sessionId)
    if (prev?.timer) clearTimeout(prev.timer)
    const stamp = prev ? prev.stamp + 1 : 1
    const since = prev?.since ?? Date.now()
    const arm = () => {
      const timer = setTimeout(() => {
        const now = pendingEnd.get(sessionId)
        if (!now || now.stamp !== stamp) return
        const live = liveTurns.get(sessionId) ?? liveTurns.get(bareSessionId(sessionId))
        const held = Date.now() - now.since
        if (live && held < HARD_GRACE_MS) {
          flowLog(TURN_LOG_PATH, `end-hold sid=${bareSessionId(sessionId)} held=${held}ms live=${Date.now() - live}ms`)
          arm()
          return
        }
        pendingEnd.delete(sessionId)
        emit(sessionId, 'end', { reason: now.reason })
      }, END_GRACE_MS)
      if (typeof timer?.unref === 'function') timer.unref()
      pendingEnd.set(sessionId, { stamp, reason, timer, since })
    }
    arm()
  }
  /** sessionId -> Set<ServerResponse>：SSE 订阅者。 */
  const streams = SHARED.streams
  /** 本实例开的 SSE 响应：卸载时只收自己的，别把新实例的也 end 了。 */
  const myStreams = new Set()
  /** res -> cleanup：拿到响应就能把它的心跳定时器一起清掉。 */
  const streamGuards = new Map()
  /**
   * sessionId -> { frames: [{seq,event,data}], seq, waiters: Set<fn> }
   *
   * cloudflared 的临时隧道（quic / http2 都试过）会把 SSE 响应整段缓冲，手机上
   * 一个字节都收不到；但「一次请求一次响应」的长轮询不受影响。所以每个会话的帧
   * 额外留一份环形缓冲，`/api/poll` 按 cursor 回放，页面在 SSE 4 秒内没 hello
   * 时自动切到长轮询。缓冲只留最近 400 帧，纯内存，不落盘。
   */
  const buffers = SHARED.buffers
  const BUFFER_MAX = 400
  const BUFFER_SESSIONS = 40

  function bufferOf(sessionId) {
    let buf = buffers.get(sessionId)
    if (!buf) {
      buf = { frames: [], seq: 0, waiters: new Set() }
      buffers.set(sessionId, buf)
      // 只留最近若干个会话，避免长期挂着把内存吃掉
      while (buffers.size > BUFFER_SESSIONS) buffers.delete(buffers.keys().next().value)
    }
    return buf
  }

  const authed = (req) => {
    const token = currentToken()
    const header = String(req.headers?.authorization ?? '')
    if (header.startsWith('Bearer ') && safeEqual(header.slice(7).trim(), token)) return true
    const cookies = parseCookies(req)
    return safeEqual(cookies[cookieName(token)] ?? '', token)
  }

  /** 把一个增量帧记进缓冲，并推给该会话的所有 SSE 订阅者。 */
  function emit(sessionId, event, payload) {
    const buf = bufferOf(sessionId)
    buf.seq += 1
    // 每条帧都带上 sessionId：SSE 是广播的，客户端靠它把别的会话的帧滤掉
    const wire = { ...(payload ?? {}), sessionId, seq: buf.seq }
    buf.frames.push({ seq: buf.seq, event, data: wire })
    if (buf.frames.length > BUFFER_MAX) buf.frames.splice(0, buf.frames.length - BUFFER_MAX)
    const wake = [...buf.waiters]
    buf.waiters.clear()
    for (const notify of wake) {
      try {
        notify()
      } catch {
        /* 等待方已经放弃 */
      }
    }
    const frame = `event: ${event}\ndata: ${JSON.stringify(wire)}\n\n`
    // 订阅时没钉会话（follow 活动会话）的客户端也要收：否则它派发到服务端自己挑的会话后
    // 永远等不到增量，界面上就是一直「处理中」。'' 和 '*' 都算通配。
    // 同一条连接既挂在会话键上又挂在 '*' 上，逐键写会把一帧发两遍；先去重
    const targets = new Set()
    for (const key of new Set([sessionId, '', '*'])) {
      const set = streams.get(key)
      if (!set) continue
      for (const res of set) targets.add(res)
    }
    for (const res of targets) {
      if (safeWrite(res, frame)) continue
      for (const key of new Set([sessionId, '', '*'])) streams.get(key)?.delete(res)
      // 这条连接已经死了：连带把它的心跳定时器收掉，别再对着尸体写
      streamGuards.get(res)?.()
      streamGuards.delete(res)
    }
  }

  /* ---------- 语音播报队列（让外面的助手/手表/MCP 也能让手机念话） ---------- */

  const SAY_MAX = 20
  const SAY_MAX_CHARS = 300
  const sayQueue = []
  let saySeq = 0

  const sayItem = (item) => ({
    seq: item.seq,
    text: item.text,
    voice: item.voice,
    at: item.at,
    id: item.id,
  })

  /** say 是全局播报：所有 SSE 订阅者都推一遍，不分会话。 */
  function broadcastSay(item) {
    const frame = `event: say\ndata: ${JSON.stringify(sayItem(item))}\n\n`
    for (const set of streams.values()) {
      for (const res of set) {
        if (safeWrite(res, frame)) continue
        set.delete(res)
        streamGuards.get(res)?.()
        streamGuards.delete(res)
      }
    }
  }

  /* ---------- 助理文本流 ---------- */

  ctx.effect(() =>
    ctx.on('agent/assistant-stream', (payload) => {
      const sessionId = String(payload?.agent?.id ?? payload?.agent?.sessionId ?? '')
      if (!sessionId) return
      const frame = payload?.frame
      if (frame?.type === 'start') {
        emit(sessionId, 'start', { turn: frame.turn ?? null, step: frame.step ?? null })
        return
      }
      if (frame?.type !== 'chunk') return
      const chunk = frame.chunk
      if (!chunk) return
      if (chunk.type === 'text-delta' && chunk.text) {
        emit(sessionId, 'delta', { text: chunk.text })
        return
      }
      if (chunk.type === 'finish') {
        // 先别发 end：正文的 final 还没来（见 pendingEnd / armEndFallback 注释）。
        armEndFallback(sessionId, chunk.reason?.kind ?? 'stop')
        return
      }
      if (chunk.type === 'tool-call-delta' && chunk.name) {
        emit(sessionId, 'tool', { name: chunk.name })
      }
    }),
  )

  /* ---------- 整段兜底：增量丢了也不至于没声音 ---------- */

  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      const sessionId = String(session?.header?.id ?? session?.id ?? '')
      if (!sessionId) return
      // start 只有这里有生产者（assistant-stream 只发 delta/tool/end），删了会把
      // waitFinal 的 started 判断饿死 → 小爱每次干等成占位语；重复帧的根因是同一条
      // SSE 连接被逐键写两遍，已在 emit 里修掉。end 交给 assistant-stream 的 finish。
      if (event?.type === 'turn/start') {
        for (const key of new Set([sessionId, bareSessionId(sessionId)].filter(Boolean))) {
          liveTurns.set(key, Date.now())
        }
        turnText.delete(sessionId)
        // 官方事件的 turn 在 `data.turn` 里，旧代码读 `event.turn` 永远是 null：
        // App 拿不到轮次号，就没法把「这一轮的 end」和上一轮的迟到帧区分开。
        emit(sessionId, 'start', { turn: event.data?.turn ?? event.turn ?? null, step: event.data?.step ?? event.step ?? null })
        return
      }
      if (event?.type === 'turn/end') {
        for (const key of new Set([sessionId, bareSessionId(sessionId)].filter(Boolean))) {
          liveTurns.delete(key)
        }
        const turn = event.data?.turn ?? event.turn ?? null
        const pend = pendingEnd.get(sessionId)
        if (pend?.timer) clearTimeout(pend.timer)
        pendingEnd.delete(sessionId)
        const last = turnText.get(sessionId)
        turnText.delete(sessionId)
        // `turn/end` 是一轮**唯一**的终止信号：先把这一轮最后一条正文当 final 发，
        // 再发 end。工具任务因此不会在「我查一下」那一句就被判结束。
        if (last?.text) emit(sessionId, 'final', { text: last.text, turn: last.turn ?? turn })
        emit(sessionId, 'end', { reason: pend?.reason ?? 'stop', turn })
        return
      }
      if (event?.type !== 'assistant/message') return
      const text = textOfMessage(event.data)
      if (!text) return
      const turn = event.data?.turn ?? event.turn ?? null
      turnText.set(sessionId, { text, turn })
      // 中间消息发 `message`：可以展示，但**不是**终止。只有 `end` 才是。
      emit(sessionId, 'message', { text, turn })
    }),
  )

  /* ---------- 小爱同学（手机自定义技能） ---------- */

  /**
   * 小爱的配置：`~/.dsh/pet-voice/xiaoai.json`
   *   { "urlSecret": "...", "keyId": "...", "secret": "<base64>" }
   * urlSecret 就是服务器地址里的 `?k=`；keyId/secret 是控制台签名用的那对，
   * 补上之后签名校验会**强制**生效，没补时降级为只校验 `?k=`。
   */
  const XIAOAI_CONFIG_PATH = join(HOME_DIR, 'xiaoai.json')
  let xiaoaiHandler = null
  let xiaoaiReady = null

  /**
   * 懒加载 xiaoai.mjs：仓库里在 `mcp/pet-bridge/`，装到 `~/.dsh/plugins/dsh-pet-voice/`
   * 后是同一个目录。两个位置都试，谁在就用谁（装错版本时不至于整页打不开）。
   */
  async function loadXiaoaiModule() {
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      join(here, 'xiaoai.mjs'),
      join(here, '..', '..', 'mcp', 'pet-bridge', 'xiaoai.mjs'),
    ]
    let lastError = null
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      try {
        return await import(pathToFileURL(candidate).href)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('找不到 xiaoai.mjs（应在插件目录或 mcp/pet-bridge/ 下）')
  }

  /** 当前活跃会话（列表按最近活跃排序，取第一条）。 */
  async function currentSessionId() {
    const sessions = await sessionRows(ctx).catch(() => [])
    return sessions[0]?.id ? String(sessions[0].id) : ''
  }

  /**
   * 把宿主现有的能力收窄成 xiaoai.mjs 要的那个小接口。
   *
   * 关键点：派任务前**先记 `sinceSeq` 游标**，再 prompt。这样这一轮产生的
   * final 帧一定在游标之后，超时后回头补答「进度」也不会串到上一轮的旧话。
   */
  function makeXiaoaiPet() {
    const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'

    /**
     * 在缓冲里挑「我们这一轮」的 final。
     *
     * 会话是共用的：队列里排在我们前面的那一轮，它的 final 同样落在 sinceSeq
     * 之后。只按 seq 挑会把别人的结论当成这次任务的答案（实测踩过）。所以
     * `sinceSeq > 0` 时要求先看到一帧 `start`——那是**我们这一轮**开始跑的信号，
     * 之后的第一条 final 才是我们的。
     */
    function pickFinal(buf, sinceSeq, requireStart) {
      let started = !requireStart
      let hit = null
      for (const frame of buf.frames) {
        if (frame.seq <= sinceSeq) continue
        if (frame.event === 'start') {
          started = true
          continue
        }
        if (frame.event === 'final' && frame.data?.text && started) {
          hit = { text: frame.data.text, seq: frame.seq }
        }
      }
      return hit
    }

    /** 有就立刻返回，没有就等（等到 `waitMs` 上限）。 */
    function waitFinal(sessionId, sinceSeq, waitMs) {
      const buf = bufferOf(sessionId)
      const find = () => pickFinal(buf, sinceSeq, true)?.text ?? ''
      const hit = find()
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve) => {
        let timer = null
        let settled = false
        // emit() 每来一帧就把 waiters 整体清空（消费者自己负责重新登记），
        // 而我们的 final 前面一定还有 start / delta 若干帧：所以「醒了但还没等到
        // final」必须把自己重新挂回去，否则第一条 start 就把自己摘掉了，
        // 之后的 final 永远没人接（实测：每次都干等到预算耗尽）。
        const notify = () => {
          if (settled) return
          const text = find()
          if (text) {
            done(text)
            return
          }
          buf.waiters.add(notify)
        }
        const done = (value) => {
          settled = true
          if (timer) clearTimeout(timer)
          buf.waiters.delete(notify)
          resolve(value)
        }
        buf.waiters.add(notify)
        timer = setTimeout(() => done(''), waitMs)
      })
    }

    /* ---------- 小爱专属会话 ---------- */

    /** 小爱配置里的 workspace（默认 Pet）；只认这一个字段，不依赖小爱模块。 */
    function xiaoaiWorkspaceName() {
      try {
        const raw = JSON.parse(readFileSync(XIAOAI_CONFIG_PATH, 'utf8'))
        const name = typeof raw?.workspace === 'string' ? raw.workspace.trim() : ''
        return name || 'Pet'
      } catch {
        return 'Pet'
      }
    }

    function readPetSession() {
      try {
        const raw = JSON.parse(readFileSync(petSessionFile(), 'utf8'))
        return { workspaceId: String(raw?.workspaceId ?? ''), sessionId: String(raw?.sessionId ?? '') }
      } catch {
        return { workspaceId: '', sessionId: '' }
      }
    }

    function writePetSession(value) {
      mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 })
      writeFileSync(petSessionFile(), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    }

    const normPath = (value) => String(value ?? '').replace(/\/+$/, '')

    function workspaceByTitle(title) {
      const want = String(title ?? '').trim()
      const rows = workspaceRows(ctx)
      const hit =
        rows.find((w) => w.title === want) ||
        rows.find((w) => w.id === want) ||
        rows.find((w) => String(w.path ?? '').split('/').filter(Boolean).pop() === want)
      if (!hit) {
        const error = new Error(`找不到项目 ${want}`)
        error.code = 'NOT_FOUND'
        throw error
      }
      return hit
    }

    async function createInWorkspace(ws) {
      const controller = ctx.get?.('sessionController')
      if (!controller?.create) throw new Error('宿主缺少 sessionController（create），建不了小爱会话')
      const request = ws.id ? { workspaceId: ws.id } : { cwd: ws.path }
      if (state.preset) request.agentPreset = state.preset
      const created = await controller.create(request)
      const sessionId = String(created?.sessionId ?? created?.id ?? created?.session?.id ?? '')
      if (!sessionId) throw new Error(`create() 没有返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
      return sessionId
    }

    /**
     * 小爱专用会话：钉死在配置的项目里，**绝不**复用 GUI 当前会话。
     *
     * 旧实现用 currentSessionId()（会话列表第一条 = 最近活跃的那只），谁在用界面
     * 就把任务塞进谁的会话：实测串进过 Envoy 项目、甚至 Lead 自己的会话，用户在
     * 界面上直接看得见。现在只认 pet-session.json 里那只，cwd 对不上就重建。
     */
    async function ensurePetSession({ title } = {}) {
      const want = workspaceByTitle(title ?? xiaoaiWorkspaceName())
      const stored = readPetSession()
      if (stored.sessionId && stored.workspaceId === want.id) {
        const row = (await sessionRows(ctx)).find((item) => item.id === stored.sessionId)
        // cwd 读得到就必须对得上；读不到只信 workspaceId，免得无意义地反复重建
        const usable = row && (!row.cwd || normPath(row.cwd) === normPath(want.path))
        if (usable) return { sessionId: stored.sessionId, workspace: want }
        LOG(`小爱专用会话 ${stored.sessionId} 不可用（cwd/workspace 对不上），重建一只`)
      }
      const sessionId = await createInWorkspace(want)
      writePetSession({ workspaceId: want.id, workspaceTitle: want.title, cwd: want.path, sessionId })
      LOG(`小爱专用会话已钉到「${want.title}」：${sessionId}`)
      return { sessionId, workspace: want }
    }

    return {
      async status() {
        const { sessionId, workspace } = await ensurePetSession()
        return {
          sessionId,
          workspaceId: workspace.id,
          workspaceTitle: workspace.title,
          cwd: workspace.path,
          projects: workspaceRows(ctx),
        }
      },

      async ask(text, { waitMs: budget } = {}) {
        const controller = ctx.get?.('sessionController')
        if (!controller?.prompt) throw new Error('宿主缺少 sessionController')
        // 只派给小爱专用会话：不再看 currentSessionId()，也不读 state.projects
        const { sessionId } = await ensurePetSession()
        await syncHiddenPrompt(ctx, sessionId, getPanelConfig())
        // 先拿游标再派发，否则这一轮的 final 可能落在游标之前而读不到
        const sinceSeq = bufferOf(sessionId).seq
        const prompt = controller.prompt(
          {
            requestId: randomBytes(8).toString('hex'),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: buildDispatchPrompt(text) }],
            clientTimeZone: tz(),
          },
          AbortSignal.timeout(120_000),
        )
        prompt.catch((error) => LOG('小爱 prompt 异步失败：', error?.message ?? error))
        const reply = await waitFinal(sessionId, sinceSeq, budget)
        return { text: reply || null, timedOut: !reply, sessionId, sinceSeq }
      },

      async latestFinal({ sessionId, sinceSeq = 0 } = {}) {
        const id = sessionId || (await ensurePetSession()).sessionId
        if (!id) return null
        // sinceSeq > 0 表示在补答某个具体任务：同样要过 start 归属校验
        return pickFinal(bufferOf(id), sinceSeq, sinceSeq > 0)
      },

      async switchProject(title) {
        const want = String(title ?? '').trim()
        const { sessionId, workspace } = await ensurePetSession({ title: want })
        return { title: workspace.title || want, sessionId }
      },

      async stop() {
        const controller = ctx.get?.('sessionController')
        if (!controller?.cancel) return { ok: false }
        const sessionId = await ensurePetSession().then((pet) => pet.sessionId)
        if (!sessionId) return { ok: false }
        try {
          await controller.cancel({ sessionId }, AbortSignal.timeout(8000))
          return { ok: true, sessionId }
        } catch (error) {
          LOG('小爱 cancel 失败：', error?.message ?? error)
          return { ok: false, sessionId }
        }
      },
    }
  }

  /**
   * 专属会话核心（ensurePetSession / switchProject / stop / status）。
   *
   * 只懒建一次，HTTP 的 /api/workspaces、/api/switch、/api/command 和小爱技能共用
   * 同一份，所以「手机上切了项目」小爱也立刻跟着走，不会各拿一只会话。
   */
  let petCore = null
  const petCoreOf = () => (petCore ??= makeXiaoaiPet())

  /** 第一次用到时才建 handler：补配置、懒加载模块，失败就抛给调用方回 503。 */
  async function xiaoaiHandlerOf() {
    if (xiaoaiHandler) return xiaoaiHandler
    if (!xiaoaiReady) {
      xiaoaiReady = (async () => {
        const mod = await loadXiaoaiModule()
        let config = mod.loadXiaoaiConfig(XIAOAI_CONFIG_PATH)
        if (!config.urlSecret) {
          // 没有 urlSecret 等于没有门禁：第一次用到时生成一把写进文件（只写不打印），
          // 认证下来后把 keyId/secret 补进同一个文件，签名校验就会自动强制生效。
          const generated = randomBytes(18).toString('hex')
          const next = { urlSecret: generated }
          if (config.keyId) next.keyId = config.keyId
          if (config.secret) next.secret = config.secret
          if (config.appId) next.appId = config.appId
          try {
            mkdirSync(HOME_DIR, { recursive: true })
            writeFileSync(XIAOAI_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
            LOG(`小爱配置已生成：${XIAOAI_CONFIG_PATH}（urlSecret 在文件里，别外传）`)
            config = mod.loadXiaoaiConfig(XIAOAI_CONFIG_PATH)
          } catch (error) {
            LOG('写小爱配置失败：', error?.message ?? error)
            config = { ...config, urlSecret: generated }
          }
        }
        xiaoaiHandler = mod.createXiaoaiHandler({
          pet: makeXiaoaiPet(),
          config,
          petName,
          log: (line) => LOG(line),
        })
        LOG(`小爱技能已挂载：${API}/xiaoai（签名 ${config.keyId ? '强制' : '未配置，降级为只校验 ?k='}）`)
        return xiaoaiHandler
      })().catch((error) => {
        xiaoaiReady = null
        throw error
      })
    }
    return xiaoaiReady
  }

  /* ---------- 路由 ---------- */

  const pageHandler = (req, res) => {
    const url = new URL(req.url ?? BASE, 'http://localhost')
    const queryToken = url.searchParams.get('k') ?? url.searchParams.get('token') ?? ''
    const token = currentToken()
    if (queryToken && safeEqual(queryToken, token)) {
      const secure = isTls(req) ? '; Secure' : ''
      if (!writeHead(res, 303, {
        location: `${BASE}/`,
        'set-cookie': `${cookieName(token)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
        'cache-control': 'no-store',
      })) return
      try {
        res.end()
      } catch { /* 客户端已经走了 */ }
      return
    }
    if (!authed(req)) {
      sendHtml(res, 401, gatePage())
      return
    }
    sendFile(res, 'index.html', { 'cache-control': 'no-store' })
  }

  const assetHandler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const fileName = url.pathname.slice(ASSET.length + 1)
    if (!fileName) return sendJson(res, 404, { ok: false, error: 'missing asset' })
    sendFile(res, fileName)
  }

  /* ---------- 神经语音（edge-tts 子进程，mp3 直通） ---------- */

  /**
   * 合成结果缓存（进程内 LRU，键 = 音色|语速|音调|文本）。
   *
   * 为什么必须有：edge-tts 每句要新起 python + 新 WebSocket 握手到微软，实测一句固定
   * 0.85–3.5s（与字数几乎无关），而且宿主侧抖动会出现 3s 级尖峰。同一句第二次必须 0ms
   * 返回，否则每台设备都得替这 1–3s 付一遍账。
   *
   * 客户端（Android）自己还有一层落盘缓存；这里是**跨设备、跨客户端重启**都生效的那一层：
   * App 启动时的预热请求会把「嗯，我看看」这类高频句灌进来，之后任何设备要它都是内存直出。
   */
  const TTS_CACHE_MAX_ITEMS = 48
  const TTS_CACHE_MAX_BYTES = 16 * 1024 * 1024
  const ttsCache = new Map() // Map 的插入序就是 LRU 序：命中时删了再写回
  let ttsCacheBytes = 0

  // v2：句间停顿压到 120ms 之后的老缓存听着还喘，带版本号让它自然过期
  const ttsCacheKey = (voice, text, rate, pitch) => `v2|${voice}|${rate}|${pitch}|${text}`

  function ttsCacheGet(key) {
    const buf = ttsCache.get(key)
    if (!buf) return null
    ttsCache.delete(key)
    ttsCache.set(key, buf)
    return buf
  }

  function ttsCachePut(key, buf) {
    if (!buf?.length || ttsCache.has(key)) return
    ttsCache.set(key, buf)
    ttsCacheBytes += buf.length
    while (ttsCache.size > TTS_CACHE_MAX_ITEMS || ttsCacheBytes > TTS_CACHE_MAX_BYTES) {
      const oldest = ttsCache.entries().next().value
      if (!oldest) break
      ttsCache.delete(oldest[0])
      ttsCacheBytes -= oldest[1].length
    }
  }

  const handleTts = (req, res, url) => {
    // 合成前先剥 Markdown：缓存键、长度校验、edge-tts 入参全用剥离后的文本
    const text = stripForSpeech(String(url.searchParams.get('text') ?? '')).trim()
    if (!text) return sendJson(res, 400, { ok: false, error: 'text 为空（剥离 Markdown 后没有可朗读内容）' })
    if (text.length > TTS_MAX_CHARS) {
      return sendJson(res, 400, {
        ok: false,
        error: `text 过长（${text.length} > ${TTS_MAX_CHARS} 字）`,
        maxChars: TTS_MAX_CHARS,
      })
    }
    // 档位参数优先（服务端解析，浏览器只要传 preset 就行）
    const presetId = String(url.searchParams.get('preset') ?? '').trim()
    const preset = presetId ? TTS_PRESETS.find((item) => item.id === presetId) : null
    if (presetId && !preset) {
      return sendJson(res, 400, {
        ok: false,
        error: `未知音色档位：${presetId}`,
        presets: TTS_PRESETS.map((item) => item.id),
      })
    }
    const voice = String(url.searchParams.get('voice') ?? '').trim() || preset?.voice || TTS_DEFAULT_VOICE
    // 记下「马上要塞进用户耳朵的话」：手机麦克风可能把它录回来（见 echoOfRecentTts）。
    rememberTtsText(text)
    if (!TTS_VOICES.some((item) => item.id === voice)) {
      return sendJson(res, 400, {
        ok: false,
        error: `未知音色：${voice}`,
        voices: TTS_VOICES.map((item) => item.id),
      })
    }
    const rate = normRate(url.searchParams.get('rate'), /^[+-]?\d{1,3}%$/, preset?.rate ?? '+0%')
    const pitch = normRate(url.searchParams.get('pitch'), /^[+-]?\d{1,3}Hz$/, preset?.pitch ?? '+0Hz')
    if (!ttsReady()) {
      return sendJson(res, 503, {
        ok: false,
        error: '神经语音还没装好',
        hint: '在电脑上运行 plugins/dsh-pet-voice/tts/setup.sh（建 ~/.dsh/pet-voice/tts-venv 并装 edge-tts）',
      })
    }

    const cacheKey = ttsCacheKey(voice, text, rate, pitch)
    const cached = ttsCacheGet(cacheKey)
    if (cached) {
      LOG(`神经语音：${voice} ${text.length} 字 → 缓存命中 ${cached.length} B`)
      try {
        writeHead(res, 200, {
          'content-type': 'audio/mpeg',
          'content-length': String(cached.length),
          'cache-control': 'private, max-age=86400',
          'x-tts-cache': 'hit',
        })
        res.end(cached)
      } catch {
        /* 断开 */
      }
      return
    }

    let child
    try {
      child = spawn(TTS_PYTHON, [TTS_SCRIPT, voice, text, rate, pitch], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      })
    } catch (error) {
      return sendJson(res, 503, {
        ok: false,
        error: `启动神经语音失败：${error?.message ?? error}`,
        hint: '运行 plugins/dsh-pet-voice/tts/setup.sh',
      })
    }

    let started = false
    let bytes = 0
    let stderrTail = ''
    const buffered = [] // 只有整段都没超上限才值得缓存；超了就不占内存
    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
    }
    res.on('close', kill)
    child.on('error', (error) => {
      if (started) {
        try {
          res.end()
        } catch {
          /* 断开 */
        }
        return
      }
      started = true
      sendJson(res, 503, {
        ok: false,
        error: `神经语音启动失败：${error?.message ?? error}`,
        hint: '运行 plugins/dsh-pet-voice/tts/setup.sh',
      })
    })
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600)
    })
    // 关键：拿到第一块就写响应头，之后每块直接往下吐，绝不攒整段。
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes <= TTS_CACHE_MAX_BYTES) buffered.push(chunk)
      if (!started) {
        started = true
        if (!writeHead(res, 200, {
          'content-type': 'audio/mpeg',
          'cache-control': 'private, max-age=86400',
          'x-accel-buffering': 'no',
          'x-tts-cache': 'miss',
        })) {
          kill()
          return
        }
        try { res.flushHeaders?.() } catch { /* 已断开 */ }
      }
      if (!safeWrite(res, chunk)) kill()
    })
    child.on('close', (code) => {
      if (!started) {
        started = true
        const missing = code === 3 || /未安装/.test(stderrTail)
        sendJson(res, missing ? 503 : 502, {
          ok: false,
          error: missing ? '神经语音没装好' : '神经语音合成失败',
          hint: missing
            ? '运行 plugins/dsh-pet-voice/tts/setup.sh'
            : stderrTail.trim() || '看宿主日志里 [tts] 那一行',
        })
        return
      }
      if (code === 0 && bytes > 0 && buffered.length) {
        ttsCachePut(cacheKey, Buffer.concat(buffered, bytes))
      }
      LOG(`神经语音：${voice} ${text.length} 字 → ${bytes} B（退出码 ${code}，缓存 ${ttsCache.size} 条）`)
      try {
        res.end()
      } catch {
        /* 断开 */
      }
    })
  }

  /* ---------- 本机语音识别（whisper worker，/api/asr 转发） ---------- */

  /**
   * `POST /pet-voice/api/asr`
   *
   * body = WAV 原始字节（16 kHz 单声道 s16le），客户端保证 ≤10 s。
   * 契约：永远回 JSON —— 200 成功、400 坏音频、413 太大、502 worker 异常、503 没装好/起不来。
   * 成功时把 worker 的 {ok,text,ms} 原样透传，另外加一个 `X-Asr-Ms` 头方便 App 打点。
   *
   * 失败重启一次：worker 是 detached 拉起的（宿主重启、插件重载都不会杀它），所以
   * 「端口上没人」通常意味着它自己崩了。第一次失败再拉一次，第二次还失败才回 502。
   */
  const handleAsr = async (req, res) => {
    const declared = Number(req.headers?.['content-length'] ?? NaN)
    if (Number.isFinite(declared) && declared > ASR_MAX_BYTES) {
      return sendJson(res, 413, {
        ok: false,
        error: `音频太大（${declared} > ${ASR_MAX_BYTES} B）`,
        maxBytes: ASR_MAX_BYTES,
      })
    }
    let body
    try {
      body = await readBody(req, ASR_MAX_BYTES)
    } catch (error) {
      const tooBig = error?.status === 413
      return sendJson(res, tooBig ? 413 : 400, {
        ok: false,
        error: String(error?.message ?? error),
        ...(tooBig ? { maxBytes: ASR_MAX_BYTES } : {}),
      })
    }
    // 空 body = 按了麦克风但没出声：直接回空文本，不为 0 字节去吵 worker。
    if (!body.length) return sendJson(res, 200, { ok: true, text: '', ms: 0 }, { 'x-asr-ms': '0' })
    if (!asrReady()) {
      return sendJson(res, 503, {
        ok: false,
        error: '本机语音识别还没装好',
        hint: `需要 ${ASR_PYTHON} 和 scripts/asr-worker.py（venv 里要有 openai-whisper）`,
      })
    }
    // 请求侧不等满整个载入时间：15 s 还没好就先让 App 拿到回话，进程继续在后台载。
    const startup = await asrEnsure(Math.min(ASR_HANDLE_BUDGET_MS, ASR_START_WAIT_MS))
    if (!startup.ok) {
      return sendJson(res, 503, {
        ok: false,
        starting: startup.starting === true,
        error: startup.starting ? '识别在准备，等十几秒再说' : (startup.error ?? 'ASR worker 起不来'),
        hint: startup.hint ?? `看 ${ASR_LOG_PATH} 里的 [asr] 那几行`,
        coldStartMs: ASR_COLD_START_MS,
      })
    }
    // 总预算：冷启动 + 首次转发 + 重试都算在里面，超了就直说再试，不让 App 挂两分钟。
    const budget = Date.now() + ASR_HANDLE_BUDGET_MS
    const left = () => Math.max(4_000, budget - Date.now())
    let result = await asrForward(body, Math.min(ASR_REQUEST_TIMEOUT, left()))
    // 进程刚重启/刚被换掉的那一下就绪和端口之间有空档：给两次机会，中间等一下再发，
    // 这样用户第一句不会白说（只重试两轮，还不通才让他「再说一次」）。
    for (let attempt = 0; attempt < 2 && result.dead; attempt += 1) {
      if (Date.now() > budget) break
      LOG(`ASR worker 无响应，第 ${attempt + 1} 次重试：${result.error}`)
      await asrStartWorker(Math.min(12_000, left()))
      await new Promise((resolve) => setTimeout(resolve, 250))
      result = await asrForward(body, Math.min(12_000, left()))
    }
    if (result.dead) {
      return sendJson(res, 502, {
        ok: false,
        error: result.error ?? 'ASR worker 不可用',
        hint: `看 ${ASR_LOG_PATH} 里的 [asr] 日志`,
      })
    }
    const ms = Number.isFinite(result.ms) ? result.ms : 0
    const ok = result.ok !== false
    const text = ok ? String(result.text ?? '') : ''
    const echo = text ? echoOfRecentTts(text) : ''
    flowLog(
      ASR_FLOW_LOG_PATH,
      `bytes=${body.length} ms=${ms} ${echo ? `echo=${echo.slice(0, 24)}` : 'ok'} text=${text.slice(0, 80)}`,
    )
    if (echo) {
      netLog('asr-echo', { chars: text.length, heard: text.slice(0, 24) })
      return sendJson(res, 200, { ok: true, text: '', echo: true, ms }, { 'x-asr-ms': String(ms) })
    }
    netLog('asr', { bytes: body.length, ms, chars: text.length })
    return sendJson(
      res,
      200,
      { ok, text, ...(ok ? {} : { error: result.error ?? '识别失败' }), ms },
      { 'x-asr-ms': String(ms) },
    )
  }

  /* ---------- APK 自动更新通道 ---------- */

  /**
   * `GET /pet-voice/api/update`
   *
   * 把 publish-apk.mjs 写的 latest.json 原样给 App，只多补一个 `url`（相对路径）。
   * 没发布过就 versionCode:0 —— App 据此显示「没有更新」而不是弹错。
   */
  const handleUpdate = (req, res) => {
    const meta = readLatestUpdate()
    if (!meta) {
      return sendJson(res, 200, {
        ok: true,
        versionCode: 0,
        hint: `还没有发布过 APK：node scripts/publish-apk.mjs <apk>（目录 ${UPDATE_DIR}）`,
      })
    }
    // 这次查询之后 App 一定会来下载：顺手把这一版文件名的 exact 路由补上
    // （宿主前缀匹配不可靠，见 ensureDownloadRoute 的注释）。
    ensureDownloadRoute(meta.file)
    LOG(`更新查询：v${meta.versionName}（code ${meta.versionCode}）→ ${meta.file}`)
    return sendJson(res, 200, {
      ...meta,
      versionCode: Number(meta.versionCode) || 0,
      url: `${DOWNLOAD}/${encodeURIComponent(meta.file)}`,
    })
  }

  /**
   * `GET/HEAD /pet-voice/download/<file>.apk`
   *
   * 独立路由（不在 apiHandler 里），所以**自己再查一遍 cookie**：这个路径同样走公网隧道，
   * 漏一次鉴权就等于开了个匿名文件下载口。
   *
   * 支持单段 Range：手机下载管理器断网重试、以及「下了一半」都会发 `bytes=start-`；
   * 多段/畸形 Range 一律按整文件回 200，比 416 更容易让客户端自己恢复。
   */
  const downloadHandler = (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: '只支持 GET/HEAD' }, { allow: 'GET, HEAD' })
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const raw = url.pathname.slice(DOWNLOAD.length + 1)
    if (!raw) return sendJson(res, 404, { ok: false, error: '缺少文件名' })
    let name
    try {
      name = decodeURIComponent(raw)
    } catch {
      return sendJson(res, 400, { ok: false, error: '文件名编码不对' })
    }
    // 两道闸：文件名形状白名单 + 拼出来的绝对路径必须还在 update 目录里。
    if (!APK_NAME_RE.test(name)) return sendJson(res, 400, { ok: false, error: '文件名不合法' })
    const full = join(UPDATE_DIR, name)
    if (!full.startsWith(`${UPDATE_DIR}${sep}`)) return sendJson(res, 400, { ok: false, error: 'bad path' })
    let stat
    try {
      stat = statSync(full)
    } catch {
      return sendJson(res, 404, { ok: false, error: `没有这个 APK：${name}` })
    }
    if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: `没有这个 APK：${name}` })
    const total = stat.size
    const range = parseRange(req.headers?.range, total)
    if (range === 'invalid') {
      return sendJson(
        res,
        416,
        { ok: false, error: 'Range 不合法' },
        { 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes' },
      )
    }
    const start = range?.start ?? 0
    const end = range?.end ?? Math.max(0, total - 1)
    const length = total === 0 ? 0 : end - start + 1
    const headers = {
      'content-type': APK_MIME,
      'content-length': String(length),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${name}"`,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${total}` } : {}),
    }
    if (method === 'HEAD' || !length) {
      if (!writeHead(res, range ? 206 : 200, headers)) return
      try { return res.end() } catch { return }
    }
    // 流式下发：APK 会涨到十几 MB，读进内存再回不是好习惯；Range 也正好用 start/end。
    const stream = createReadStream(full, { start, end })
    stream.on('error', (error) => {
      LOG(`下载中断：${name} ${error?.message ?? error}`)
      try {
        res.destroy()
      } catch {
        /* 已经断开 */
      }
    })
    res.on('close', () => stream.destroy())
    if (!writeHead(res, range ? 206 : 200, headers)) {
      stream.destroy()
      return
    }
    // pipe 到已销毁的流会异步抛 EPIPE，进程兜底会接住；这里先关掉读流更干净。
    try {
      stream.pipe(res)
    } catch (error) {
      LOG(`下载 pipe 失败：${name} ${error?.message ?? error}`)
      stream.destroy()
    }
  }

  /** 裸 `/pet-voice/download`（缺文件名）：明确 404，别落到官方 SPA 上。 */
  const downloadMiss = (req, res) =>
    sendJson(res, 404, { ok: false, error: '用法：/pet-voice/download/<file>.apk' })

  /**
   * 给「当前 latest.json 指到的那个文件」补一条 exact 路由。
   *
   * 为什么这么绕：这套宿主的前缀路由匹配不可靠（连 `/pet-voice/assets/app.js` 打前缀
   * 路由都打不开，所以上面每个静态文件都显式挂了 exact）。下载路径带文件名、没法在
   * apply 时穷举，于是双保险：
   *   1) apply 时把 update 目录里已有的 APK 全挂上 exact；
   *   2) App 每次更新前一定先问 /api/update，那里再把当次文件名挂上 exact。
   * 前缀路由仍然挂着当兜底——将来宿主把前缀匹配修好，这两步也不碍事。
   */
  const downloadRoutes = new Map()
  function ensureDownloadRoute(name) {
    if (!APK_NAME_RE.test(name) || downloadRoutes.has(name)) return
    const path = `${DOWNLOAD}/${name}`
    try {
      downloadRoutes.set(name, ctx.webServer.register({ kind: 'exact', path, handler: safeHandler(downloadHandler) }))
    } catch {
      // 重复 (kind,path) 会抛：说明已经挂过，当无事发生。
      LOG(`下载路由已存在：${path}`)
    }
  }

  // 面板路由独立于 apiHandler：网页侧走 /pet-voice/panel/*，不是 /pet-voice/api/*。
  // 门禁是回环地址——网页没有也不该有手机令牌，公网侧永远 403。
  const panelHandler = async (req, res) => {
    // 只认「真·直连本机」：回环来源 + 无转发头 + Host 是本机（见 panelRequestAllowed）。
    if (!panelRequestAllowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    const reqUrl = new URL(req.url ?? '/', 'http://localhost')
    const route = reqUrl.pathname.slice(PANEL.length + 1).replace(/\/+$/, '')
    const method = String(req.method ?? 'GET').toUpperCase()
    const origin = ctx.webServer.getOrigin?.() ?? ''
    const snapshot = async () => panelState({ origin, pairing: await pairInfo(origin) })
    try {
    // 面板：DSH 网页里那一页（配对码 / 设备 / 参数）。网页既没有也不该有手机令牌,
    // 门禁换成回环地址——只有本机打得开，公网侧永远 403。
        try {
        // 「经自己的服务器转发」：配置只存这台电脑，仓库里没有任何默认服务器。
        if (route === 'public' && method === 'GET') return sendJson(res, 200, publicState())

        if (route === 'public' && method === 'POST') {
          const raw = String((await readBody(req, 16 * 1024)) ?? '')
          let patch = {}
          try {
            patch = JSON.parse(raw || '{}')
          } catch {
            return sendJson(res, 400, { ok: false, error: 'bad json' })
          }
          setPublicConfig(patch)
          return sendJson(res, 200, publicState())
        }

        if (route === 'public/connect' && method === 'POST') {
          const originUrl = new URL(origin || 'http://127.0.0.1:1')
          const upstream = { host: originUrl.hostname, port: originUrl.port || (originUrl.protocol === 'https:' ? 443 : 80) }
          const got = await connectPublic({ upstream })
          try {
            setPanelConfig({ mode: 'domain', customUrl: got.url })
          } catch {
            /* 地址写不进去也让隧道保持连着，面板会显示状态 */
          }
          return sendJson(res, 200, { ...publicState(), url: got.url })
        }

        if (route === 'public/disconnect' && method === 'POST') {
          return sendJson(res, 200, await disconnectPublic())
        }

        if (route === 'state' && method === 'GET') return sendJson(res, 200, await snapshot())

        if (route === 'state' && method === 'POST') {
          const raw = String((await readBody(req, 16 * 1024)) ?? '')
          let patch = {}
          try {
            patch = JSON.parse(raw || '{}')
          } catch {
            return sendJson(res, 400, { ok: false, error: 'bad json' })
          }
          setPanelConfig(patch)
          return sendJson(res, 200, await snapshot())
        }

        if (route === 'rotate-token' && method === 'POST') {
          // body 里 `{dry:true}` 只回当前快照、不换令牌：自检/排障要能确认这条路由
          // 真的接上了，又不能每跑一次自检就把用户已经配好的手机踢下线。
          let dry = false
          try {
            const raw = String((await readBody(req, 1024)) ?? '')
            dry = JSON.parse(raw || '{}')?.dry === true
          } catch {
            /* 空 body = 真换 */
          }
          if (!dry) {
            rotateToken()
            // 旧令牌一换，表里每一台都失效了；记录一起清掉，别让面板还挂着「已连上」。
            clearDevices()
          }
          return sendJson(res, 200, { ...(await snapshot()), rotated: !dry })
        }

        if (route === 'unbind' && method === 'POST') {
          const raw = String((await readBody(req, 4 * 1024)) ?? '')
          let id = ''
          try {
            id = String(JSON.parse(raw || '{}')?.id ?? '')
          } catch {
            /* 没有 id 就当没这个设备 */
          }
          const removed = removeDevice(id)
          // 只删一行记录是假撤销：审阅实测旧令牌照样 200，那台手机下次请求又把自己
          // 写回列表。设备表里每台设备用的都是同一枚主令牌，没有逐设备凭证，所以
          // 「移出」必须是真撤销：换掉主令牌，这台和别的设备都要重新扫码。
          // （逐设备凭证在计划里，属下一轮；先把安全性做对，代价是全体重配。）
          if (removed) {
            rotateToken()
            // 同上：主令牌只有一枚，移出一台＝全体失效，设备表清空才和实际一致。
            clearDevices()
          }
          return sendJson(res, 200, { ...(await snapshot()), rotated: removed })
        }

        if (route === 'qr.svg' && method === 'GET') {
          const text = String(reqUrl.searchParams.get('text') ?? '')
          // 只画配对链接，别把这里变成通用二维码服务
          if (!/^https?:\/\/[^\s]+\/pet-voice\//.test(text)) {
            return sendJson(res, 400, { ok: false, error: 'bad text' })
          }
          const svg = qrSvg(text)
          if (!writeHead(res, 200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })) return
          try { return res.end(svg) } catch { return }
        }

        return sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }

  const PANEL = `${BASE}/panel`
  const apiHandler = async (req, res) => {
    // url/route/method 必须先算：小爱那条路由要跳过 cookie 鉴权
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(API.length + 1).replace(/\/+$/, '')
    const method = String(req.method ?? 'GET').toUpperCase()

    // 小爱同学：请求方是小米的服务器，既没有我们的 cookie，也不会带自定义 header。
    // 它的门禁在 xiaoai.mjs 里（?k= + MIAI-HmacSHA256-V1 签名），所以这里放行。
    if (route === 'xiaoai' || route === 'xiaoai/selftest') {
      try {
        const handler = await xiaoaiHandlerOf()
        return await handler(req, res)
      } catch (error) {
        LOG('小爱接口异常：', error?.message ?? error)
        return sendJson(res, 503, { ok: false, error: String(error?.message ?? error) })
      }
    }

    if (!authed(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    // 通过令牌的请求都算这台设备还活着，列表里按最近活跃排；超出绑定上限就回收
    // 凭据（以前上限只存在面板里，不执行，等于没设）。
    const deviceTouch = touchDevice(req)
    if (deviceTouch?.reason === 'limit') {
      return sendJson(res, 429, {
        ok: false,
        code: 'device-limit',
        maxDevices: deviceTouch.maxDevices,
        error: `这台电脑最多连 ${deviceTouch.maxDevices} 台设备，先在面板里移出一台`,
      })
    }

    // 任何一次带令牌的请求（App 打开页面就会拉 state）都顺手把识别 worker 叫醒，
    // 这样用户第一句不用吃冷启动。内部有 60 s 节流，不额外增加负担。
    warmAsrInBackground()

    try {
      // 手机端回传诊断（安装失败原因、启动自检）。这条也要 cookie，公网上不留匿名写入口。
      if (route === 'log' && method === 'POST') {
        let line = ''
        try {
          const raw = await readBody(req, 64 * 1024)
          line = String(raw ?? '').trim()
        } catch { /* 读不到就当空行 */ }
        if (line) {
          try {
            mkdirSync(CLIENT_LOG_DIR, { recursive: true })
            appendFileSync(CLIENT_LOG_PATH, `${new Date().toISOString()} ${line}\n`)
            if (statSync(CLIENT_LOG_PATH).size > CLIENT_LOG_MAX) {
              writeFileSync(CLIENT_LOG_PATH, readFileSync(CLIENT_LOG_PATH, 'utf8').slice(-CLIENT_LOG_MAX / 2))
            }
          } catch (error) {
            LOG('客户端日志写失败：', error?.message ?? error)
          }
          LOG('客户端：', line.slice(0, 300))
        }
        return sendJson(res, 200, { ok: true })
      }

      // 聊天里看图：图片字节直出（GET 取 body / HEAD 只取头）
      if (route === 'file' && (method === 'GET' || method === 'HEAD')) {
        return handleFile(req, res, url)
      }

      if (route === 'state' && method === 'GET') {
        const [sessions, presets] = await Promise.all([sessionRows(ctx), presetRows(ctx)])
        // 小爱专属会话不参与「界面当前会话」的推算：宿主 list() 按活跃度排序，我们自己
        // 往专属会话 prompt 一次就会把它顶到第一位。若直接把 sessions[0] 当 current，
        // 用户会看到界面上的当前会话被小爱「抢方向盘」。所以这里跳过专属会话那只。
        const petNow = readPetSessionFile()
        const current = sessions.find((item) => item.id && item.id !== petNow.sessionId) ?? null
        // 记忆里的会话可能早被删了（自测残留的 sess-new-2 就是死 id），活着才算数
        if (sessions.length) {
          const alive = new Set(sessions.map((item) => item.id))
          let dirty = false
          for (const [key, id] of Object.entries(state.projects)) {
            if (!alive.has(String(id))) {
              delete state.projects[key]
              dirty = true
            }
          }
          if (dirty) saveState(state)
        }
        return sendJson(res, 200, {
          ok: true,
          // 绝不回显完整 token：只给前 8 位，让用户能比对「现在生效的是哪一把」。
          tokenHint: currentToken().slice(0, 8),
          linkHint: `在电脑上执行 cat ${TOKEN_PATH} 可查看完整配对链接里的 token`,
          projects: workspaceRows(ctx),
          presets,
          sessions: sessions.slice(0, 20),
          // current 只用于界面展示（用户最近在用的那只，已排除专属会话），**不参与派发**；
          // 派发落点看 dispatchTarget，它恒等于 pet-session.json 里那只。
          current,
          dispatchTarget: petNow.sessionId || null,
          remembered: state.projects,
          petSession: (() => {
            try {
              return JSON.parse(readFileSync(petSessionFile(), 'utf8'))
            } catch {
              return null
            }
          })(),
          pet: { name: petName, wakeWords: WAKE_WORDS },
          // 只有「正在跑」的会话会出现在这里；空对象表示全空闲
          turns: Object.fromEntries([...liveTurns].map(([id, since]) => [id, { since }])),
          // 插件页面里配的人设/长度档/气泡开关：App 读这里当默认值
          settings: (() => {
            const config = getPanelConfig()
            return {
              maxWords: normalizeMaxWords(config.maxWords),
              bubble: config.bubble !== false,
              transport: normalizeTransport(config.transport),
              hasPersona: Boolean(String(config.persona ?? '').trim()),
            }
          })(),
          // 小爱技能入口：给页面/自测脚本一个可发现的地址（不含 secret）
          xiaoai: {
            endpoint: `${API}/xiaoai`,
            selftest: `${API}/xiaoai/selftest`,
            configured: Boolean(xiaoaiHandler),
            configPath: XIAOAI_CONFIG_PATH,
          },
        })
      }

      /* ---- 浏览项目 / 会话 / 目标（手机 App 要像桌面端一样翻历史） ---- */

      if (route === 'projects' && method === 'GET') {
        return sendJson(res, 200, { ok: true, projects: workspaceRows(ctx) })
      }

      if (route === 'sessions' && method === 'GET') {
        try {
          return sendJson(
            res,
            200,
            await browseSessions(
              ctx,
              {
                // App 传的是 workspaceId（项目 = 工作区），桌面端传 projectId，两边都认。
                projectId: url.searchParams.get('projectId') ?? url.searchParams.get('workspaceId') ?? '',
                limit: url.searchParams.get('limit') ?? '',
                before: url.searchParams.get('before') ?? '',
              },
              liveTurns,
            ),
          )
        } catch (error) {
          LOG('会话列表读取失败：', error?.message ?? error)
          return sendJson(res, 500, { ok: false, error: '读取会话列表失败' })
        }
      }

      if (route === 'session' && method === 'GET') {
        try {
          const payload = sessionDetail({
            id: url.searchParams.get('id') ?? '',
            limit: url.searchParams.get('limit') ?? '',
            before: url.searchParams.get('before') ?? '',
          })
          if (!payload) return sendJson(res, 404, { ok: false, error: '会话不存在' })
          return sendJson(res, 200, payload)
        } catch (error) {
          LOG('会话转录读取失败：', error?.message ?? error)
          return sendJson(res, 500, { ok: false, error: '读取会话失败' })
        }
      }

      if (route === 'goals' && method === 'GET') {
        try {
          return sendJson(res, 200, goalsOfSession(url.searchParams.get('sessionId') ?? ''))
        } catch (error) {
          LOG('目标读取失败：', error?.message ?? error)
          // 目标只是锦上添花：读不到就空数组，别让 App 因此报错。
          return sendJson(res, 200, { ok: true, goals: [] })
        }
      }

      if (route === 'new' && method === 'POST') {
        const body = await readJson(req)
        const out = await newSessionRoute(ctx, state, body, res)
        // null = 客户端已经走了：不建会话、不写响应。
        if (!out) return
        return sendJson(res, out.status, out.body)
      }

      if (route === 'dispatch' && method === 'POST') {
        const body = await readJson(req)
        // 派发细节（存在性判定、去重、prompt）都在 dispatchToSession 里，单测直接调它。
        const result = await dispatchToSession(ctx, state, body, req, { emit, liveTurns, liveAbort })
        netLog('dispatch-result', { status: result.status, usedSessionId: result.body?.usedSessionId ?? '' })
        return sendJson(res, result.status, result.body)
      }

      if (route === 'stream' && method === 'GET') {
        let sessionId = url.searchParams.get('sessionId') ?? ''
        if (!sessionId) {
          try {
            sessionId = (await petTargetSession(ctx, state)).sessionId
          } catch (error) {
            return sendJson(res, 503, { ok: false, error: String(error?.message ?? error) })
          }
        }
        if (!writeHead(res, 200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })) return
        try { res.flushHeaders?.() } catch { /* 已断开 */ }
        // cloudflared 之类的前置代理会先攒够一小段字节才往下游吐（实测公网隧道里
        // 连 hello 都收不到），先塞一条 2 KiB 的 SSE 注释把缓冲打穿；注释行按协议
        // 必须被客户端忽略，不影响解析。
        if (!safeWrite(res, `: ${' '.repeat(2048)}\n\nretry: 1500\n\n`)) return
        if (!safeWrite(res, `event: hello\ndata: ${JSON.stringify({ sessionId })}\n\n`)) return
        const set = streams.get(sessionId) ?? new Set()
        streams.set(sessionId, set)
        set.add(res)
        const openedAt = Date.now()
        netLog('stream-open', { sessionId, ua: String(req.headers?.['user-agent'] ?? '').slice(0, 40) })
        // 同时挂到 '*'：手机派发后服务端可能落到另一只会话（新对话/默认落点），
        // 订阅只认一个 id 就会一直「处理中」收不到任何增量。
        if (!url.searchParams.get('nofollow')) {
          const all = streams.get('*') ?? new Set()
          streams.set('*', all)
          all.add(res)
        }
        const cleanup = () => {
          if (!cleanup.done) netLog('stream-close', { sessionId, ms: Date.now() - openedAt })
          cleanup.done = true
          clearInterval(heartbeat)
          streamGuards.delete(res)
          myStreams.delete(res)
          set.delete(res)
          if (!set.size) streams.delete(sessionId)
          const all = streams.get('*')
          if (all) {
            all.delete(res)
            if (!all.size) streams.delete('*')
          }
        }
        // 心跳和写入都必须过 safeWrite：响应被别处 end 掉之后再写，会在下个 tick
        // 变成 uncaughtException，把整个宿主带走。写不出去就当场收摊。
        const heartbeat = setInterval(() => {
          if (!safeWrite(res, ': hb\n\n')) cleanup()
        }, 15_000)
        heartbeat.unref?.()
        streamGuards.set(res, cleanup)
        myStreams.add(res)
        req.on('close', cleanup)
        req.on('error', cleanup)
        res.on('close', cleanup)
        res.on('error', cleanup)
        return undefined
      }

      if (route === 'poll' && method === 'GET') {
        // 与 SSE 等价的「请求-响应」通道：公网隧道缓冲 SSE 时靠它兜底。
        let sessionId = url.searchParams.get('sessionId') ?? ''
        if (!sessionId) {
          try {
            sessionId = (await petTargetSession(ctx, state)).sessionId
          } catch (error) {
            return sendJson(res, 503, { ok: false, error: String(error?.message ?? error) })
          }
        }
        const cursor = Number(url.searchParams.get('cursor') ?? 0) || 0
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 20_000) || 0, 0), 25_000)
        const buf = bufferOf(sessionId)
        // cursor=-1 是「只对齐」：页面刚接上某个会话时问一句「现在最新到哪了」，
        // 拿到 seq 后只收新帧，避免把历史对话当成新消息重新播一遍。
        // 传输方式由插件设置页决定：auto 让 App 先试长连接，poll 强制锁轮询（网络挡 SSE 时用）
        const transport = normalizeTransport(getPanelConfig().transport)
        if (cursor < 0) return sendJson(res, 200, { ok: true, sessionId, transport, frames: [], cursor: buf.seq, done: false })
        const since = () => buf.frames.filter((f) => f.seq > cursor)
        let pending = since()
        if (!pending.length && wait > 0) {
          await new Promise((resolve) => {
            let timer = setTimeout(finish, wait)
            function finish() {
              clearTimeout(timer)
              buf.waiters.delete(finish)
              resolve()
            }
            buf.waiters.add(finish)
            req.on('close', finish)
            req.on('error', finish)
          })
          pending = since()
        }
        // 游标必须指向**这一批实际发出去的最后一帧**。以前按 pending 的最后一帧
        // 推进：一次积压超过 200 帧时，第 201..N 帧永远读不到，而 done 已经被置成
        // true——审阅用 300 帧积压实测，客户端拿到「完成」却丢了 100 帧。
        const batch = pending.slice(0, 200)
        const nextCursor = batch.length ? batch[batch.length - 1].seq : cursor
        // 缓冲里最早的帧都比游标新 → 中间至少有一帧被 400 帧环形缓冲挤掉了，
        // 明确告诉客户端「你漏了」，别让它以为对话就是断的。
        const oldest = buf.frames.length ? buf.frames[0].seq : 0
        const gap = Boolean(oldest && cursor > 0 && oldest > cursor + 1)
        netLog('poll', { sessionId, cursor, got: pending.length, sent: batch.length, gap })
        return sendJson(res, 200, {
          ok: true,
          sessionId,
          transport,
          frames: batch,
          cursor: nextCursor,
          // 还有没发完的帧：客户端应该立刻再拉一次，不要等到下一轮空转。
          more: pending.length > batch.length,
          gap,
          // 只有真的把 end 发出去了才算这一轮结束。final 现在是「这一轮的最后一句
          // 话」，不是终止信号（工具任务里它后面还可能有 tool/end 帧）。
          done: batch.some((f) => f.event === 'end'),
        })
      }

      if (route === 'link' && method === 'GET') {
        // 只有已经拿着 cookie 的人才能取回完整配对链接（用于「换台手机/发给另一台设备」）。
        // /state 里永远只有前 8 位。
        const origin = ctx.webServer.getOrigin?.() ?? ''
        // 二维码里必须是手机真能访问的地址：优先隧道/局域网，绝不能是 127.0.0.1。
        const info = await pairInfo(origin)
        const base = String(info?.publicBase ?? '').trim() || `${origin}${BASE}/`
        return sendJson(res, 200, {
          ok: true,
          source: info?.source ?? 'local',
          url: `${base}?k=${encodeURIComponent(currentToken())}`,
        })
      }

      if (route === 'pair' && method === 'GET') {
        // 只读：告诉页面「手机上该用哪个地址」。绝不回 token（配对走扫码/手输）。
        const origin = ctx.webServer.getOrigin?.() ?? ''
        return sendJson(res, 200, { ok: true, ...(await pairInfo(origin)) })
      }

      if (route === 'sessions' && method === 'GET') {
        const wantWorkspace = String(url.searchParams.get('workspaceId') ?? '')
        // 会话行本身几乎从不带 workspaceId，只带 cwd；按项目路径反查归属，长路径优先。
        const spaces = workspaceRows(ctx)
          .filter((w) => w.path)
          .sort((a, b) => b.path.length - a.path.length)
        const ownerOf = (row) => {
          if (row.workspaceId) return row.workspaceId
          const cwd = String(row.cwd ?? '')
          if (!cwd) return ''
          const hit = spaces.find((w) => cwd === w.path || cwd.startsWith(`${w.path}/`))
          return hit?.id ?? ''
        }
        const rows = (await sessionRows(ctx))
          .filter((row) => row.id)
          .map((row) => ({ ...row, workspaceId: ownerOf(row) }))
          .filter((row) => !wantWorkspace || row.workspaceId === wantWorkspace)
        rows.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        const pinned = readPetSessionFile()
        return sendJson(res, 200, {
          ok: true,
          current: pinned.sessionId ?? '',
          rows: rows.slice(0, 40).map((row) => ({
            id: row.id,
            title: row.title || row.cwd?.split('/').filter(Boolean).pop() || '',
            at: Number(row.updatedAt) || 0,
            workspaceId: row.workspaceId,
            cwd: row.cwd,
          })),
        })
      }

      if (route === 'bind' && method === 'POST') {
        // 手机端点选一只会话并要求「以后 APP 对话就用它」：写 pet-session.json，
        // 之后的 dispatch/stream/poll 全部落到这只会话上。
        const body = await readJson(req)
        const want = String(body.sessionId ?? '').trim()
        if (!want) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
        const row = (await sessionRows(ctx)).find((item) => item.id === want)
        if (!row) return sendJson(res, 404, { ok: false, error: 'no such session' })
        mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 })
        writeFileSync(
          PET_SESSION_PATH,
          `${JSON.stringify({
            workspaceId: row.workspaceId || '',
            workspaceTitle: row.cwd?.split('/').filter(Boolean).pop() || '',
            cwd: row.cwd || '',
            sessionId: row.id,
          }, null, 2)}\n`,
          { mode: 0o600 },
        )
        LOG(`已绑定会话：${row.id}`)
        return sendJson(res, 200, { ok: true, sessionId: row.id })
      }

      if (route === 'workspaces' && method === 'GET') {
        // 只列项目 + 专属会话钉在哪。不返回会话历史、不返回任何密钥。
        const rows = workspaceRows(ctx)
        let pinned = null
        // 只读 pet-session.json 报「现在钉在哪」，**不能**顺手把 pin 拉回默认项目
        // （那样手机上刚切的 web 会被一次列项目请求打回 Pet）。
        const stored = readPetSessionFile()
        const row = rows.find((w) => w.id === stored.workspaceId)
        try {
          if (row && stored.sessionId) {
            const alive = (await sessionRows(ctx)).some((item) => item.id === stored.sessionId)
            if (alive) {
              pinned = { title: row.title, id: row.id, sessionId: stored.sessionId }
            } else {
              // 会话被用户删了：按原来那个项目重建，不要跳到默认项目。
              const again = await petCoreOf().switchProject(row.title)
              pinned = { title: again.title || row.title, id: row.id, sessionId: again.sessionId }
            }
          } else if (!stored.sessionId) {
            // 从来没钉过：这时才建第一只专属会话（幂等，只会发生一次）。
            const status = await petCoreOf().status()
            if (status?.sessionId) {
              pinned = { title: status.workspaceTitle, id: status.workspaceId, sessionId: status.sessionId }
            }
          }
        } catch (error) {
          LOG('取 pinned 失败：', error?.message ?? error)
        }
        return sendJson(res, 200, {
          ok: true,
          workspaces: rows.map((w) => ({
            id: w.id,
            title: w.title,
            path: w.path,
            pinned: Boolean(pinned && w.id === pinned.id),
          })),
          pinned,
          ...(pinned ? {} : { hint: '还没有专属会话（宿主缺少 sessionController 或专属项目不存在）' }),
        })
      }

      if (route === 'switch' && method === 'POST') {
        // 切项目 = 把「专属会话」重新钉到目标项目。绝不动用户其它会话。
        const body = await readJson(req)
        const byId = String(body.workspaceId ?? '').trim()
        const byTitle = String(body.title ?? '').trim()
        if (!byId && !byTitle) {
          return sendJson(res, 400, { ok: false, error: 'title 或 workspaceId 必须给一个' })
        }
        const rows = workspaceRows(ctx)
        const found = byId ? { hit: rows.find((w) => w.id === byId) } : matchWorkspace(byTitle, rows)
        if (!found.hit) {
          const want = byId || byTitle
          const candidates = (found.candidates ?? []).length
            ? found.candidates
            : rows.map((w) => w.title).slice(0, 5)
          return sendJson(res, 404, {
            ok: false,
            error: `没有这个项目: ${want}`,
            candidates,
          })
        }
        try {
          const pinned = await petCoreOf().switchProject(found.hit.title)
          return sendJson(res, 200, {
            ok: true,
            title: pinned.title || found.hit.title,
            sessionId: pinned.sessionId,
            workspaceId: found.hit.id,
          })
        } catch (error) {
          return sendJson(res, 502, { ok: false, error: `切换失败：${String(error?.message ?? error)}` })
        }
      }

      if (route === 'command' && method === 'POST') {
        // 一句话意图：解析是纯函数，执行只落在专属会话上。
        // chat 分支**不碰会话、不派发**，调用方自己走 /api/dispatch。
        const body = await readJson(req)
        const text = String(body.text ?? '').trim()
        const rows = workspaceRows(ctx)
        const parsed = parseCommand(text, rows)
        if (parsed.action === 'chat') {
          return sendJson(res, 200, { ok: true, action: 'chat', say: null })
        }
        if (parsed.action === 'switch-miss' || parsed.action === 'dispatch-miss') {
          return sendJson(res, 200, {
            ok: true,
            action: parsed.action,
            say: parsed.say,
            ...(parsed.miss ? { miss: parsed.miss } : {}),
            candidates: parsed.candidates ?? [],
          })
        }
        if (parsed.action === 'stop') {
          let value = null
          try {
            value = await petCoreOf().stop()
          } catch (error) {
            LOG('停止失败：', error?.message ?? error)
          }
          return sendJson(res, 200, {
            ok: true,
            action: 'stop',
            say: parsed.say,
            stopped: Boolean(value?.ok),
            sessionId: value?.sessionId ?? null,
          })
        }
        // switch / dispatch：先把专属会话钉到目标项目（可能新建，但只写 pet-session.json）
        let pinned
        try {
          pinned = await petCoreOf().switchProject(parsed.title)
        } catch (error) {
          return sendJson(res, 502, {
            ok: false,
            action: parsed.action,
            error: `切换失败：${String(error?.message ?? error)}`,
          })
        }
        const title = pinned.title || parsed.title
        if (parsed.action === 'switch') {
          return sendJson(res, 200, {
            ok: true,
            action: 'switch',
            title,
            sessionId: pinned.sessionId,
            say: parsed.say,
          })
        }
        const controller = ctx.get?.('sessionController')
        if (!controller?.prompt) {
          return sendJson(res, 503, { ok: false, action: 'dispatch', error: '宿主缺少 sessionController' })
        }
        try {
          await syncHiddenPrompt(ctx, pinned.sessionId, getPanelConfig())
          const prompt = controller.prompt(
            {
              requestId: randomBytes(8).toString('hex'),
              sessionId: pinned.sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: buildDispatchPrompt(parsed.content) }],
              clientTimeZone: tzOf(req),
            },
            AbortSignal.timeout(120_000),
          )
          prompt.catch((error) => LOG('command 派发异步失败：', error?.message ?? error))
        } catch (error) {
          return sendJson(res, 502, {
            ok: false,
            action: 'dispatch',
            error: `派发失败：${String(error?.message ?? error)}`,
          })
        }
        return sendJson(res, 200, {
          ok: true,
          action: 'dispatch',
          title,
          sessionId: pinned.sessionId,
          text: parsed.content,
          say: `已经交给《${title}》去做了`,
        })
      }

      if (route === 'cancel' && method === 'POST') {
        const body = await readJson(req)
        const controller = ctx.get?.('sessionController')
        let sessionId = String(body.sessionId ?? '')
        if (!sessionId) {
          try {
            sessionId = (await petTargetSession(ctx, state)).sessionId
          } catch (error) {
            return sendJson(res, 503, { ok: false, error: String(error?.message ?? error) })
          }
        }
        if (!controller?.cancel) return sendJson(res, 503, { ok: false, error: '宿主缺少 sessionController' })
        const value = controller.cancel({ sessionId })
        return sendJson(res, 200, { ok: true, value: value ?? null })
      }

      if (route === 'render' && method === 'POST') {
        // 助手回复的 Markdown → 可直接塞进 WebView 的 HTML 片段。
        // 先转义再渲染，raw HTML 不会透传；链接只放行 http(s)。
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text : ''
        if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'text 为空' })
        if (text.length > RENDER_MAX_CHARS) {
          return sendJson(res, 400, {
            ok: false,
            error: `text 过长（${text.length} > ${RENDER_MAX_CHARS} 字）`,
            maxChars: RENDER_MAX_CHARS,
          })
        }
        return sendJson(res, 200, { ok: true, html: renderMarkdown(text) })
      }

      if (route === 'say' && method === 'POST') {
        const body = await readJson(req)
        const raw = stripForSpeech(String(body.text ?? '')).trim()
        if (!raw) return sendJson(res, 400, { ok: false, error: 'text 为空' })
        const truncated = raw.length > SAY_MAX_CHARS
        const text = truncated ? raw.slice(0, SAY_MAX_CHARS) : raw
        const voice = TTS_VOICES.some((item) => item.id === body.voice)
          ? String(body.voice)
          : TTS_DEFAULT_VOICE
        const id = typeof body.id === 'string' ? body.id.slice(0, 64) : ''
        // 同一个 id 只念一次：重试请求不会让手机重复播报。
        if (id) {
          const same = sayQueue.find((item) => item.id === id)
          if (same) {
            return sendJson(res, 200, {
              ok: true,
              seq: same.seq,
              queued: sayQueue.length,
              deduped: true,
              ...(truncated ? { truncated: true } : {}),
            })
          }
        }
        saySeq += 1
        const item = { seq: saySeq, text, voice, id, at: new Date().toISOString() }
        sayQueue.push(item)
        let dropped = 0
        while (sayQueue.length > SAY_MAX) {
          sayQueue.shift()
          dropped += 1
        }
        broadcastSay(item)
        LOG(`播报入队 #${item.seq}：${text.length} 字（队列 ${sayQueue.length}${dropped ? `，挤出 ${dropped} 条` : ''}）`)
        return sendJson(res, 200, {
          ok: true,
          seq: item.seq,
          queued: sayQueue.length,
          ...(truncated ? { truncated: true, maxChars: SAY_MAX_CHARS } : {}),
          ...(dropped ? { dropped } : {}),
        })
      }

      if (route === 'say' && method === 'GET') {
        // since 缺省或负数 = 只对齐：页面刚打开时问「现在最新到哪了」，不回放历史。
        const rawSince = url.searchParams.get('since')
        const since = rawSince === null ? -1 : Number(rawSince)
        if (!Number.isFinite(since) || since < 0) {
          return sendJson(res, 200, { ok: true, items: [], cursor: saySeq })
        }
        const items = sayQueue.filter((item) => item.seq > since).slice(-SAY_MAX).map(sayItem)
        return sendJson(res, 200, {
          ok: true,
          items,
          cursor: items.length ? items[items.length - 1].seq : Math.max(since, saySeq),
        })
      }

      if (route === 'tts/voices' && method === 'GET') {
        const ready = ttsReady()
        return sendJson(res, 200, {
          ok: true,
          ready,
          default: TTS_DEFAULT_VOICE,
          presets: TTS_PRESETS,
          defaultPreset: TTS_DEFAULT_PRESET,
          voices: TTS_VOICES,
          ...(ready ? {} : { hint: '神经语音还没装：运行 plugins/dsh-pet-voice/tts/setup.sh' }),
        })
      }

      if (route === 'tts' && method === 'GET') return handleTts(req, res, url)

      // 本机语音识别：POST 识别，GET 是只读探针（方便 curl 自检「装没装/在不在跑」）。
      if (route === 'diag' && method === 'GET') {
        return sendJson(res, 200, { ok: true, streams: [...streams.keys()], events: NET_LOG.slice(-200) })
      }
      if (route === 'upload' && method === 'POST') return handleUpload(ctx, req, res, url)
      if (route === 'asr' && method === 'POST') return handleAsr(req, res)
      if (route === 'asr' && method === 'GET') {
        const health = await asrHealth()
        const ready = asrReady()
        return sendJson(res, 200, {
          ok: true,
          ready,
          running: Boolean(health?.ok),
          model: health?.model ?? ASR_MODEL,
          pid: health?.pid ?? null,
          ...(ready ? {} : { hint: `需要 ${ASR_PYTHON} 和 scripts/asr-worker.py` }),
        })
      }

      // APK 自动更新：只读发布目录里的 latest.json
      if (route === 'update' && method === 'GET') return handleUpdate(req, res)

      if (route === 'selfcheck' && method === 'GET') {
        const report = await selfcheck(ctx, url, state)
        return sendJson(res, 200, report)
      }

      return sendJson(res, 404, { ok: false, error: `未知接口 ${method} ${route}` })
    } catch (error) {
      LOG('接口异常：', route, error?.message ?? error)
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error), route })
    }
  }

  ctx.effect(() => {
    // 这套宿主里 `prefix` 路由的匹配语义不可靠（实测 `/pet-voice/assets/app.js`
    // 打不开前缀路由），所以每个真实路径都显式挂一次 exact；prefix 只当兜底，
    // 将来宿主把前缀匹配修好了也不需要改这里。
    //
    // 更新目录里的 APK 文件名没法在编译期枚举，所以先把「已经发布过的」全挂上 exact；
    // 之后每发一版，/api/update 会补挂当次文件名（ensureDownloadRoute）。
    try {
      for (const entry of readdirSync(UPDATE_DIR)) {
        if (APK_NAME_RE.test(entry)) ensureDownloadRoute(entry)
      }
    } catch {
      /* update 目录还不存在：第一次 publish 之后由 /api/update 补挂 */
    }
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: BASE, handler: safeHandler(pageHandler) }),
      ctx.webServer.register({ kind: 'exact', path: `${BASE}/`, handler: safeHandler(pageHandler) }),
      ...PUBLIC_FILES.map((file) =>
        ctx.webServer.register({ kind: 'exact', path: `${ASSET}/${file}`, handler: safeHandler(assetHandler) }),
      ),
      ...API_ROUTES.map((route) =>
        ctx.webServer.register({ kind: 'exact', path: `${API}/${route}`, handler: safeHandler(apiHandler) }),
      ),
      ...['state', 'rotate-token', 'unbind', 'qr.svg', 'public', 'public/connect', 'public/disconnect'].map((route2) =>
        ctx.webServer.register({ kind: 'exact', path: `${PANEL}/${route2}`, handler: safeHandler(panelHandler) }),
      ),
      // 下载路由：裸路径明确 404；文件名的 exact 由 ensureDownloadRoute 慢慢补。
      ctx.webServer.register({ kind: 'exact', path: DOWNLOAD, handler: safeHandler(downloadMiss) }),
      ctx.webServer.register({ kind: 'prefix', path: DOWNLOAD, handler: safeHandler(downloadHandler) }),
      ctx.webServer.register({ kind: 'prefix', path: `${DOWNLOAD}/`, handler: safeHandler(downloadHandler) }),
      ctx.webServer.register({ kind: 'prefix', path: ASSET, handler: safeHandler(assetHandler) }),
      ctx.webServer.register({ kind: 'prefix', path: `${ASSET}/`, handler: safeHandler(assetHandler) }),
      ctx.webServer.register({ kind: 'prefix', path: API, handler: safeHandler(apiHandler) }),
      ctx.webServer.register({ kind: 'prefix', path: `${API}/`, handler: safeHandler(apiHandler) }),
    ]
    // 配过就自己接上，省得每次重开都要点一次。
    try {
      const cfg = publicState()
      if (cfg.configured) {
        const originUrl = new URL(ctx.webServer.getOrigin?.() ?? '')
        connectPublic({ upstream: { host: originUrl.hostname, port: originUrl.port || '80' } }).catch((e) => {
          LOG(`服务器转发没连上：${e?.message ?? e}`)
        })
      }
    } catch {
      /* 没配过 */
    }
    // 纯局域网连法：宿主只听回环，本机再起一层 0.0.0.0 明文监听给同一 WiFi 的手机用。
    // 起不来不影响别的连法，面板里「局域网」那行会显示「现在用不了」。
    try {
      const originUrl = new URL(ctx.webServer.getOrigin?.() ?? '')
      startLan({ hostPort: originUrl.port || '80' }).catch((e) => {
        LOG(`局域网监听没起来：${e?.message ?? e}`)
      })
    } catch {
      /* 拿不到宿主端口 */
    }

    LOG(`路由已挂载：${BASE}/（token 文件 ${TOKEN_PATH}）`)
    return () => {
      try {
        stopPublic()
      } catch {
        /* 没起过隧道 */
      }
      try {
        stopLan()
      } catch {
        /* 没起过监听 */
      }
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已经卸载 */
        }
      }
      for (const dispose of downloadRoutes.values()) {
        try {
          dispose()
        } catch {
          /* 已经卸载 */
        }
      }
      downloadRoutes.clear()
      try {
        disposeHiddenPrompts()
      } catch {
        /* 已经卸载 */
      }
      // 先收定时器：插件被热重载时这些 interval 还活着，对着已经 end 的响应写
      // 就会在下一个 tick 抛 uncaughtException，把宿主整个带走（0.9.24 前的事故）。
      //
      // 顺序陷阱：cleanup() 自己会 `myStreams.delete(res)`，所以必须在收定时器
      // **之前**拍快照；否则循环时集合已经空了，一条 res.end() 都不会发
      // （实测 0 次、对端 writableEnded=false，一直挂到超时）。
      const leftoverStreams = [...myStreams]
      for (const cleanup of [...streamGuards.values()]) {
        try {
          cleanup()
        } catch {
          /* 已经收过 */
        }
      }
      streamGuards.clear()
      let ended = 0
      for (const res of leftoverStreams) {
        try {
          if (!resGone(res)) {
            res.end()
            ended += 1
          }
        } catch {
          /* 忽略 */
        }
      }
      myStreams.clear()
      netLog('unload-streams', { snapshot: leftoverStreams.length, ended })
      LOG('路由已卸载')
    }
  })
}

/* ------------------------------------------------------------------ */
/* 自检                                                               */
/* ------------------------------------------------------------------ */

const WAKE_WORDS = ['鲸灵', '小鲸', '嗨鲸灵', 'hey whale', 'hello whale']

async function probe(steps, label, run) {
  const started = Date.now()
  try {
    const value = await run()
    steps.push({ label, ok: true, ms: Date.now() - started, value: value ?? null })
    return value
  } catch (error) {
    steps.push({ label, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) })
    return undefined
  }
}

/**
 * 现场自检：把这条链路上每个宿主能力单独探一遍，返回 ok/error 明细。
 * `?prompt=<sessionId>` 才会真的发一句话（默认只读，避免误触发模型调用）。
 */
async function selfcheck(ctx, url, state) {
  const steps = []
  const controller = ctx.get?.('sessionController')

  const origin = await probe(steps, 'webServer.getOrigin', () => ctx.webServer.getOrigin())
  const projects = await probe(steps, 'workspaceRegistry.list', () => workspaceRows(ctx))
  const presets = await probe(steps, 'agentPresets.list', () => presetRows(ctx))
  const sessions = await probe(steps, 'sessionController.list', () => sessionRows(ctx))

  // 默认只做只读探测：真的发一轮 prompt 会往用户会话里插东西，必须显式 ?prompt=<sessionId>。
  if (controller?.prompt) {
    const sessionId = url.searchParams.get('prompt') || ''
    if (sessionId) {
      await probe(steps, `sessionController.prompt(${sessionId})`, () =>
        controller.prompt(
          {
            requestId: randomBytes(8).toString('hex'),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: '自检：请只回复「鲸灵在线」四个字。' }],
            clientTimeZone: tzOf({ headers: {} }),
          },
          AbortSignal.timeout(60_000),
        ),
      )
    } else {
      steps.push({
        label: 'sessionController.prompt',
        ok: false,
        skipped: true,
        error: '只读模式：要真发一轮就加 ?prompt=<sessionId>（会往该会话插一条消息）',
      })
    }
  } else {
    steps.push({ label: 'sessionController.prompt', ok: false, error: 'inject 里没有 sessionController' })
  }

  const ttsOk = ttsReady()
  steps.push(
    ttsOk
      ? { label: 'tts.edge-tts', ok: true }
      : { label: 'tts.edge-tts', ok: false, skipped: true, error: '可选：运行 plugins/dsh-pet-voice/tts/setup.sh 启用神经语音' },
  )

  // 本机识别是可选的（没装 whisper 也能用云端兜底），所以没装只标 skipped，不算失败。
  const asrOk = asrReady()
  steps.push(
    asrOk
      ? { label: 'asr.whisper', ok: true, value: { endpoint: ASR_ENDPOINT, model: ASR_MODEL, lazyStart: true } }
      : {
          label: 'asr.whisper',
          ok: false,
          skipped: true,
          error: `可选：${ASR_PYTHON} + scripts/asr-worker.py 装好后启用本机识别`,
        },
  )
  const updateMeta = readLatestUpdate()

  const failed = steps.filter((step) => step.ok === false && !step.skipped).length
  return {
    ok: failed === 0,
    origin: origin ?? null,
    counts: {
      projects: projects?.length ?? 0,
      presets: presets?.length ?? 0,
      sessions: sessions?.length ?? 0,
    },
    tts: { ready: ttsOk, default: TTS_DEFAULT_VOICE, voices: TTS_VOICES.length },
    asr: { ready: asrOk, model: ASR_MODEL, endpoint: `${API}/asr`, worker: ASR_ENDPOINT },
    update: {
      dir: UPDATE_DIR,
      versionCode: Number(updateMeta?.versionCode) || 0,
      versionName: String(updateMeta?.versionName ?? ''),
    },
    rememberedProjects: Object.keys(state.projects).length,
    steps,
    at: new Date().toISOString(),
  }
}

/* ------------------------------------------------------------------ */
/* 兜底页：手机第一次打开但没有 token 时用                              */
/* ------------------------------------------------------------------ */

function gatePage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>鲸灵 · 需要配对</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
    background:radial-gradient(120% 80% at 50% 0%, #12374f 0%, #071722 60%, #04101a 100%);
    font:16px/1.6 -apple-system, "PingFang SC", system-ui, sans-serif; color:#dff3ff; }
  main { width:min(92vw,420px); background:#0a2131cc; border:1px solid #1d5470;
    border-radius:18px; padding:22px; box-shadow:0 18px 60px #0008; }
  h1 { margin:0 0 6px; font-size:20px; }
  p { margin:8px 0; color:#9fc9dd; font-size:14px; }
  input, button { width:100%; box-sizing:border-box; border-radius:12px; padding:12px;
    font-size:16px; border:1px solid #235c78; background:#081b28; color:#e8f7ff; }
  button { margin-top:10px; background:#1a86b8; border-color:#28a8e0; font-weight:600; }
  code { color:#8fe4ff; word-break:break-all; }
</style></head>
<body><main>
  <h1>鲸灵需要配对</h1>
  <p>把电脑上 <code>~/.dsh/pet-voice/token</code> 里的那一串贴进来；或者在电脑上门打开带 <code>?k=</code> 的链接。</p>
  <form method="get" action="${BASE}/">
    <input name="k" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="粘贴访问 token" />
    <button type="submit">进入</button>
  </form>
</main></body></html>`
}
