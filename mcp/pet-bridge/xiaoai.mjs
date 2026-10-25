/**
 * xiaoai.mjs — 小爱开放平台「手机自定义技能」的服务器端 handler。
 *
 * 形态：小爱同学负责唤醒 / ASR / TTS，我们只做两件事——
 *   1. 收小爱的意图事件（JSON），解析出「用户到底想干什么」；
 *   2. 秒级返回动作 JSON，把要说的话塞进 `response.to_speak.text`。
 * 声音由小爱自己发，我们**不**合成音频，也不碰 pet_say 那条路。
 *
 * 官方协议（手机自定义技能）：
 *   事件   {version:"1.0", query, session:{session_id, application:{app_id}, user:{user_id}},
 *           request:{type, request_id, timestamp, locale}}
 *   动作   {version:"1.0", response:{to_speak:{type:0,text}, open_mic, not_understand}, is_session_end}
 *
 * `request.type` 三态（照官方 Request 字段定义）：
 *   0 技能进入请求 —— 刚唤醒/进入技能。回欢迎语 + `open_mic:true` + `is_session_end:false`，进多轮。
 *   1 技能进行中请求 —— 多轮里后续的话。走意图路由。
 *   2 请求结束请求 —— 会话收尾。回一句收尾话 + `is_session_end:true`。
 *
 * 硬性要求（踩了就判无效动作 / 断 session）：
 *   - `to_speak` 与 `directives` 至少有一个 → 本实现永远给 to_speak，且保证非空；
 *   - 必须带 `not_understand`，连续 3 轮 true 会被平台强制退出 → 本地也计数并在第 3 轮收尾；
 *   - 接口必须 HTTPS（由隧道负责，本模块只说 http）；
 *   - 唤醒是显式唤醒：调用词 + 技能名 + 动作，动作必须先在 NLP 交互模型里配语料。
 *
 * 鉴权两道门，都要过：
 *   ① `?k=<urlSecret>` —— 小爱的服务器不带 cookie 也不会带自定义 header，
 *      所以 URL query 是**唯一目前可行**的门禁位（控制台里直接填进服务器地址）。
 *   ② `MIAI-HmacSHA256-V1` 签名 —— 配了 KeyId/Secret 就强制校验（见 signRequest）。
 *      `~/.dsh/pet-voice/xiaoai.json` 不存在时降级成「只校验 ?k=」，并在响应头
 *      加 `x-warn: signature-not-configured`，方便认证还没下来时先联调。
 *
 * 零依赖，纯 node:http。`createXiaoaiHandler({ pet, secret })` 拿到的就是 `(req, res)`，
 * 可以直接挂到宿主路由上；`pet` 是一个窄接口（见 PetAdapter），测试时用 stub 替。
 *
 * @module xiaoai
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 小爱要秒级回答：默认最多等这么久拿「这一轮的真回复」。 */
export const DEFAULT_WAIT_MS = 2600
/** 播报文本上限（太长小爱念不完，也没人听）。 */
export const DEFAULT_MAX_SPEAK = 120
/** 连续多少轮「没听懂」后主动收尾。 */
export const MAX_NOT_UNDERSTAND = 3
/** 签名算法前缀（官方附录《签名文档》）。 */
export const SIGN_ALGO = 'MIAI-HmacSHA256-V1'

/** 超时（没拿到回复）时说的话。 */
export const TIMEOUT_REPLY = '我记下了，正在弄；你过一会儿说「鲸灵进度」我就报给你。'
/** 空 query / 认不出意图时说的话。 */
export const UNKNOWN_REPLY = '没听明白，你再说一遍？'
/** 连续没听懂收尾时说的话。 */
export const BYE_REPLY = '那我先退下了，需要的时候再叫我。'
/** type=2（请求结束）时说的话。 */
export const ENDING_REPLY = '好，我先忙去了。'
/** type=0（技能进入）时的欢迎语模板。 */
export const greetingOf = (petName = '鲸灵') => `${petName}在这儿，想让我做什么？`

export const DEFAULT_STORE = join(homedir(), '.dsh', 'pet-voice', 'pending.json')
export const DEFAULT_CONFIG = join(homedir(), '.dsh', 'pet-voice', 'xiaoai.json')

/* ------------------------------------------------------------------ */
/* 小工具                                                             */
/* ------------------------------------------------------------------ */

const LOG = () => {}

/** 常量时间比较，长度不同直接 false（避免 timingSafeEqual 抛错）。 */
function sameSecret(got, want) {
  const a = Buffer.from(String(got ?? ''))
  const b = Buffer.from(String(want ?? ''))
  if (!b.length || a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * 从 `?k=` / `x-xiaoai-secret` / `Authorization: Bearer` 取 URL 门禁。
 *
 * 小爱的服务器不会带 cookie 也不会带自定义 header，所以**唯一可行**的做法是把
 * secret 放进 HTTPS URL 的 query 里（控制台里直接填进「服务器地址」）。
 * 另外两种入口只为本地 curl / 自测方便。
 */
export function secretOf(req, url) {
  const q = url.searchParams.get('k') ?? url.searchParams.get('secret') ?? ''
  if (q) return q.trim()
  const header = String(req?.headers?.['x-xiaoai-secret'] ?? '').trim()
  if (header) return header
  const auth = String(req?.headers?.authorization ?? '')
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return ''
}

/**
 * 把一段 markdown 味的助手回复变成「适合念出来」的一句话。
 *
 * 做三件事：压空白、去 markdown 记号（否则小爱会把 `**` 念成「星号星号」）、
 * 超长时优先在句末截断并补句号。
 */
export function speakable(raw, max = DEFAULT_MAX_SPEAK) {
  let text = String(raw ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  if (text.length > max) {
    const head = text.slice(0, max)
    // 尽量在句末断，但别把整句砍没了
    const cut = Math.max(
      head.lastIndexOf('。'),
      head.lastIndexOf('！'),
      head.lastIndexOf('？'),
      head.lastIndexOf('；'),
      head.lastIndexOf('. '),
      head.lastIndexOf('! '),
      head.lastIndexOf('? '),
    )
    text = cut >= Math.floor(max * 0.45) ? head.slice(0, cut + 1) : head
    if (!/[。！？…]$/.test(text)) text += '。'
    return text
  }
  if (!/[。！？…~」』）)!?]$/.test(text)) text += '。'
  return text
}

/** 构造动作 JSON；`to_speak` 永远非空，绝不让平台判无效动作。 */
export function buildAction(text, { end = true, openMic = false, notUnderstand = false, directives } = {}) {
  const speak = String(text ?? '').trim() || UNKNOWN_REPLY
  const response = {
    // type 0 = 纯文本，交给小爱自己 TTS
    to_speak: { type: 0, text: speak },
    open_mic: Boolean(openMic),
    not_understand: Boolean(notUnderstand),
  }
  if (directives) response.directives = directives
  return { version: '1.0', response, is_session_end: Boolean(end) }
}

/* ------------------------------------------------------------------ */
/* 意图路由                                                           */
/* ------------------------------------------------------------------ */

/** 唤醒词 / 客套前缀，反复剥到不变为止。 */
const LEAD_PATTERNS = [
  /^(?:嗨\s*)?(?:鲸灵|小鲸|嗨鲸灵|hey\s*whale|hello\s*whale)\s*[，,。:：!！~]?\s*/i,
  /^(?:帮我|帮忙|麻烦你?|请你?|给我|替我)\s*/,
  /^(?:问一下|问下|问问|跟鲸灵说|告诉鲸灵|对鲸灵说|让鲸灵|叫鲸灵|请鲸灵|和鲸灵说)\s*/,
  /^(?:看看|看下|看一下|查一下|查查|瞧瞧)\s*/,
  /^(?:那个|这个|嗯+|诶+|喂+)\s*[，,]?\s*/,
]

const STOP_RE = /^(?:停|停下|停止|停一下|打住|别说了|别念了|别讲了|闭嘴|安静|不用了|算了|退下|取消)/
const PROGRESS_RE =
  /(?:进度|在干嘛|在干什么|在忙什么|忙什么呢|好了没|好了吗|做完了吗|做完没|完成了吗|到哪了|干完了吗|弄完了吗|怎么样了)/

/** 「打开鲸灵 / 启动鲸灵 / 唤醒鲸灵」——表示要进入技能，不是派任务。 */
const LAUNCH_RE = /^(?:帮我\s*)?(?:打开|启动|开启|唤醒|叫醒|进入|唤起)\s*(?:一下)?\s*(?:鲸灵|小鲸|嗨鲸灵)/

/**
 * 切项目必须是**动作开头**的句式：`切到 X 项目`、`让鲸灵去 X 项目`、`到 X 项目干活`。
 * 只看「句子里出现 X 项目」会把「让鲸灵看看 Pet 项目里有什么」这种任务句抢走。
 */
const SWITCH_LEAD_RE =
  /^(?:切到|切换到|换到|转到|跳到|改成|去|到|去往|让鲸灵去|让鲸灵到|让小鲸去|让小鲸到)/

/** 出现这些动词说明用户想让鲸灵**干活**，那就不是切项目。 */
const TASK_VERB_RE =
  /(?:看看|看一下|看下|瞧瞧|查一下|查查|查下|帮我|帮忙|问一下|问下|问问|告诉|说一下|念一下|读一下|跑一下|测一下|找一下|搜一下|整理|统计|列出)/

/** 从一句话里剥掉唤醒词和客套话，留下「真正的正文」。 */
export function stripLead(query) {
  let text = String(query ?? '').trim()
  for (let round = 0; round < 5; round += 1) {
    const before = text
    for (const pattern of LEAD_PATTERNS) text = text.replace(pattern, '').trim()
    if (text === before) break
  }
  return text.replace(/^[，,。.!！~、\s]+/, '').trim()
}

/** 项目名归一化：去空白、去「项目/工作区/那边」等尾缀、忽略大小写。 */
function normProjectName(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/[\s"'「」『』]/g, '')
    .replace(/(?:项目|工作区|那边|里面|去|干活|工作|的)+$/g, '')
    .toLowerCase()
}

/** 在项目清单里找：id → 精确标题 → 目录名 → 唯一子串。 */
export function resolveProject(projects, raw) {
  const want = normProjectName(raw)
  if (!want) return null
  const list = Array.isArray(projects) ? projects : []
  const byId = list.find((p) => String(p?.id ?? '').toLowerCase() === want)
  if (byId) return byId
  const byTitle = list.find((p) => normProjectName(p?.title) === want)
  if (byTitle) return byTitle
  const byBase = list.find((p) => {
    const base = String(p?.path ?? '').split('/').filter(Boolean).pop() ?? ''
    return normProjectName(base) === want
  })
  if (byBase) return byBase
  const hits = list.filter((p) => {
    const title = normProjectName(p?.title)
    const base = normProjectName(String(p?.path ?? '').split('/').filter(Boolean).pop() ?? '')
    return (title && title.includes(want)) || (base && base.includes(want))
  })
  return hits.length === 1 ? hits[0] : null
}

/** 「切到 X / 到 X 项目去 / X 项目干活」里的候选项目名（可能多个，按可信度排）。 */
function projectCandidates(query) {
  const out = []
  const push = (value) => {
    const name = String(value ?? '').trim().replace(/^[，,。、\s]+|[，,。、\s]+$/g, '')
    if (name && name.length <= 40 && !out.includes(name)) out.push(name)
  }
  const patterns = [
    /(?:切到|切换到|换到|转到|改成|跳到|去)\s*([^\s，,。！!？?、的]+)/g,
    /([^\s，,。！!？?、的]+?)\s*(?:项目|工作区)\s*(?:去|里|那边)?\s*(?:干活|工作|做)?/g,
    /(?:到|在)\s*([^\s，,。！!？?、的]+?)\s*(?:项目|工作区)/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(query))) push(match[1])
  }
  return out
}

/**
 * 纯函数：把一句话路由成意图，方便单测。
 *
 * 返回 `{intent, text, project}`：
 *   - `stop`     停
 *   - `progress` 进度
 *   - `switch`   切项目（`project` 是命中的项目对象）
 *   - `ask`      派任务（`text` 是剥干净的正文）
 *   - `unknown`  认不出来（空 query、只有唤醒词、项目名对不上）
 */
export function routeIntent(query, { projects = [] } = {}) {
  const raw = String(query ?? '').trim()
  if (!raw) return { intent: 'unknown', text: '', project: null, reason: '空 query' }

  const body = stripLead(raw)

  // 优先级：进入 → 停 → 进度 → 切项目 → 派任务。顺序就是契约，别随手调。
  if (LAUNCH_RE.test(raw) || LAUNCH_RE.test(body)) {
    return { intent: 'launch', text: body, project: null }
  }
  if (!body) return { intent: 'unknown', text: '', project: null, reason: '只有唤醒词' }

  if (STOP_RE.test(body)) return { intent: 'stop', text: body, project: null }
  if (PROGRESS_RE.test(body)) return { intent: 'progress', text: body, project: null }

  // 切项目：必须是「切到/去/到 … 项目」这种动作句式，且句子里没有干活动词。
  // 「让鲸灵看看 Pet 项目里有什么」在这里会被 TASK_VERB_RE 拦下，落到派任务。
  if (SWITCH_LEAD_RE.test(body) && !TASK_VERB_RE.test(body)) {
    for (const candidate of projectCandidates(body)) {
      const hit = resolveProject(projects, candidate)
      if (hit) return { intent: 'switch', text: body, project: hit }
    }
    // 明确说了要去某个项目但对不上：如实说，比闷头派任务好
    const [first] = projectCandidates(body)
    if (first && /项目|工作区/.test(body)) {
      return { intent: 'unknown', text: body, project: null, reason: `没有项目「${first}」` }
    }
  }

  return { intent: 'ask', text: body, project: null }
}

/* ------------------------------------------------------------------ */
/* 签名（MIAI-HmacSHA256-V1）                                          */
/* ------------------------------------------------------------------ */

/**
 * 读 `~/.dsh/pet-voice/xiaoai.json`。
 *
 * 形状（控制台建好技能后拿到 KeyId + Secret，补进来即可）：
 *   { "keyId": "...", "secret": "<base64>", "urlSecret": "...", "appId": "..." }
 * 文件不存在不算错——降级成只校验 `?k=`，并在响应头留告警。
 */
export function loadXiaoaiConfig(file = DEFAULT_CONFIG) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { file, present: false, keyId: '', secret: '', urlSecret: '', appId: '' }
  }
  const pick = (key) => (typeof raw?.[key] === 'string' ? raw[key].trim() : '')
  return {
    file,
    present: true,
    keyId: pick('keyId'),
    secret: pick('secret'),
    urlSecret: pick('urlSecret'),
    appId: pick('appId'),
  }
}

/** 规范化 query：name/value 字典序，多值展开成多对。两个变体都算，容错用。 */
function canonicalQueries(url) {
  const pairs = []
  for (const [name, value] of url.searchParams) pairs.push([name, value])
  const sorted = [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  const enc = (list) => list.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')
  const rawJoin = (list) => list.map(([n, v]) => `${n}=${v}`).join('&')
  const out = [enc(sorted), enc(pairs), rawJoin(sorted)]
  return [...new Set(out)]
}

/**
 * 算签名：HmacSHA256(base64decode(secret), utf8(待签名字符串)) → 小写 hex。
 *
 * 待签名字符串按序拼接、每段后加 `\n`：
 *   METHOD → URL Path（不含 query）→ 规范化 query → Date（RFC1123 GMT）
 *   → x-original-host → Content-Type → Content-MD5（无则空串）→ 额外 header（V1 为空串）
 *
 * 官方那“每段后加 \n”对最后一个空段有两种读法，两种都产出来给校验方试。
 */
export function signRequest(fields = {}) {
  const {
    method = 'POST',
    path = '/',
    query = '',
    date = '',
    host = '',
    contentType = '',
    contentMd5 = '',
    secret = '',
  } = fields
  const segments = [
    String(method).toUpperCase(),
    path,
    query,
    date,
    host,
    contentType,
    contentMd5,
  ]
  const payloads = [
    [...segments, ''].map((s) => `${s}\n`).join(''), // 空尾段也占一行
    segments.map((s) => `${s}\n`).join(''), // 空尾段不占行
  ]
  const key = Buffer.from(String(secret), 'base64')
  return payloads.map((payload) => createHmac('sha256', key).update(payload, 'utf8').digest('hex'))
}

/**
 * 校验 `Authorization: MIAI-HmacSHA256-V1 <KeyId>:<Scope>:<Signature>`。
 *
 * 只吃 header（body 由 Content-MD5 单独把关），所以可以在读 body 之前就拒掉。
 * 签名变体逐个试：任一对上即通过——变体只影响编码细节，密钥仍然是硬门槛。
 */
export function verifySignature(req, url, signer) {
  const header = String(req?.headers?.authorization ?? '').trim()
  if (!header) return { ok: false, reason: '缺少 Authorization' }
  if (!header.startsWith(`${SIGN_ALGO} `)) {
    return { ok: false, reason: `Authorization 不是 ${SIGN_ALGO}` }
  }
  const rest = header.slice(SIGN_ALGO.length + 1).trim()
  const parts = rest.split(':')
  if (parts.length < 3) return { ok: false, reason: 'Authorization 段数不对' }
  const keyId = parts[0]
  const signature = parts[parts.length - 1].toLowerCase()
  if (!signature) return { ok: false, reason: '签名为空' }
  if (signer?.keyId && keyId !== signer.keyId) return { ok: false, reason: 'KeyId 不匹配' }

  const date = String(req?.headers?.date ?? req?.headers?.['x-xiaomi-date'] ?? '')
  const host = String(req?.headers?.['x-original-host'] ?? '')
  const contentType = String(req?.headers?.['content-type'] ?? '')
  const contentMd5 = String(req?.headers?.['content-md5'] ?? '')

  for (const query of canonicalQueries(url)) {
    const candidates = signRequest({
      method: String(req?.method ?? 'POST').toUpperCase(),
      path: url.pathname,
      query,
      date,
      host,
      contentType,
      contentMd5,
      secret: signer.secret,
    })
    for (const candidate of candidates) {
      if (candidate.length === signature.length && sameSecret(candidate, signature)) return { ok: true, keyId }
    }
  }
  return { ok: false, reason: '签名对不上' }
}

/* ------------------------------------------------------------------ */
/* 待办存储（超时未回的那次派发）                                       */
/* ------------------------------------------------------------------ */

/**
 * 极简 JSON 文件存储。只留最近 20 条，写失败一律不抛（读多写少，坏了就当空的）。
 * 结构：`{ tasks: [{ id, sessionId, text, at, sinceSeq, state, result, doneAt }] }`
 */
export function createStore(file = DEFAULT_STORE) {
  let cache = null
  const load = () => {
    if (cache) return cache
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      cache = parsed && typeof parsed === 'object' ? parsed : { tasks: [] }
    } catch {
      cache = { tasks: [] }
    }
    if (!Array.isArray(cache.tasks)) cache.tasks = []
    return cache
  }
  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 })
    } catch {
      /* 落盘失败不影响回答 */
    }
  }
  return {
    file,
    add(task) {
      const data = load()
      data.tasks.push(task)
      if (data.tasks.length > 20) data.tasks.splice(0, data.tasks.length - 20)
      save()
    },
    newestPending(sessionId) {
      const data = load()
      const list = [...data.tasks].reverse()
      return list.find((t) => t?.state === 'pending' && (!sessionId || t.sessionId === sessionId)) ?? null
    },
    finish(id, result) {
      const data = load()
      const task = data.tasks.find((t) => t?.id === id)
      if (!task) return false
      task.state = 'done'
      task.result = String(result ?? '')
      task.doneAt = Date.now()
      save()
      return true
    },
    list() {
      return load().tasks
    },
  }
}

/* ------------------------------------------------------------------ */
/* handler                                                            */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} PetAdapter
 * @property {() => Promise<{sessionId?: string, title?: string, projects?: Array<{id:string,title:string,path:string}>}>} status
 *   当前会话 + 项目清单（切项目要对名单）。
 * @property {(text: string, opts: {waitMs: number}) => Promise<{text: string|null, timedOut: boolean, sessionId?: string, sinceSeq?: number}>} ask
 *   派一句话给鲸灵；最多等 `waitMs` 拿本轮 assistant 文本，超时返回 `timedOut:true`（任务已经派出去了）。
 * @property {(opts: {sessionId?: string, sinceSeq?: number}) => Promise<{text: string, seq?: number}|null>} latestFinal
 *   取「sinceSeq 之后」最近一条 assistant 文本，用来补答「进度」。
 * @property {(name: string) => Promise<{title: string, sessionId?: string}>} switchProject
 *   切项目；找不到应抛带 `code:'NOT_FOUND'` 的错。
 * @property {() => Promise<{ok: boolean, sessionId?: string}>} stop
 *   停掉当前回合（失败也别抛，停不掉的停本来就是空操作）。
 */

/**
 * 造一个可以直挂 node:http 的 `(req, res)`。
 *
 * @param {object} options
 * @param {PetAdapter} options.pet          鲸灵适配器（插件里用宿主服务实现，测试里用 stub）
 * @param {string} [options.secret]         URL 门禁串（`?k=`）；不传则取 `config.urlSecret`。
 *                                          两者都没有时**拒绝一切请求**（绝不裸奔）。
 * @param {object} [options.config]         `loadXiaoaiConfig()` 的结果；给了就按它校验签名
 * @param {number} [options.waitMs]         等真回复的上限，默认 2200
 * @param {number} [options.maxSpeak]       播报文本上限，默认 120
 * @param {string} [options.storePath]      pending.json 路径
 * @param {string} [options.petName]        宠物名，默认「鲸灵」
 * @param {(line: string) => void} [options.log]
 */
export function createXiaoaiHandler(options = {}) {
  const cfg = options.config ?? null
  const {
    pet,
    secret = cfg?.urlSecret ?? '',
    waitMs = DEFAULT_WAIT_MS,
    maxSpeak = DEFAULT_MAX_SPEAK,
    storePath = DEFAULT_STORE,
    petName = '鲸灵',
    log = LOG,
  } = options
  const signer = {
    keyId: String(options.keyId ?? cfg?.keyId ?? ''),
    secret: String(options.signingSecret ?? cfg?.secret ?? ''),
  }
  const urlSecret = String(secret ?? '')

  if (!pet) throw new Error('createXiaoaiHandler 需要 pet 适配器')
  const store = createStore(storePath)
  /** session_id -> {count, at}：连续没听懂计数（平台第 3 轮会强退，本地先收尾）。 */
  const notUnderstand = new Map()
  /** 最近一次事件/响应摘要，给 /selftest 看。 */
  let last = null

  const bump = (sessionId) => {
    const key = String(sessionId || '-')
    const entry = notUnderstand.get(key) ?? { count: 0, at: 0 }
    entry.count += 1
    entry.at = Date.now()
    notUnderstand.set(key, entry)
    if (notUnderstand.size > 200) {
      // 只留最近 200 个会话，别把内存吃掉
      const oldest = [...notUnderstand.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) notUnderstand.delete(oldest[0])
    }
    return entry.count
  }
  const resetBump = (sessionId) => notUnderstand.delete(String(sessionId || '-'))

  /** 无论 pet 卡住还是抛错，都在这个预算内给出人话。 */
  async function guard(promise, budgetMs, fallback) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(fallback), budgetMs)
        }),
      ])
    } catch (error) {
      log(`xiaoai: ${error?.message ?? error}`)
      return fallback
    } finally {
      clearTimeout(timer)
    }
  }

  /** 核心：事件 → 人话。返回 `{text, notUnderstand, end, openMic, intent}`。 */
  async function answer(event) {
    const query = String(event?.query ?? '').trim()
    const sessionId = String(event?.session?.session_id ?? '')
    const type = Number(event?.request?.type ?? 1)

    // type=2：请求结束请求 —— 收尾，说完就走
    if (type === 2) {
      return { text: ENDING_REPLY, notUnderstand: false, end: true, openMic: false, intent: 'bye' }
    }

    // type=0：技能进入请求 —— 欢迎 + 开麦，交给多轮
    if (type === 0) {
      resetBump(sessionId)
      return { text: greetingOf(petName), notUnderstand: false, end: false, openMic: true, intent: 'launch' }
    }

    if (!query) {
      const count = bump(sessionId)
      if (count >= MAX_NOT_UNDERSTAND) {
        resetBump(sessionId)
        return { text: BYE_REPLY, notUnderstand: true, end: true, openMic: false, intent: 'unknown', exit: true }
      }
      return { text: UNKNOWN_REPLY, notUnderstand: true, end: true, openMic: false, intent: 'unknown' }
    }

    let projects = []
    if (pet.status) {
      const state = await guard(pet.status(), 1200, {})
      projects = Array.isArray(state?.projects) ? state.projects : []
    }

    const routed = routeIntent(query, { projects })

    // 「打开鲸灵 / 启动鲸灵」：等同进入技能——欢迎 + 开麦，不结束会话
    if (routed.intent === 'launch') {
      resetBump(sessionId)
      return { text: greetingOf(petName), notUnderstand: false, end: false, openMic: true, intent: 'launch' }
    }

    if (routed.intent === 'stop') {
      resetBump(sessionId)
      await guard(pet.stop?.() ?? Promise.resolve({ ok: true }), 1500, { ok: false })
      return { text: '好，停了。', notUnderstand: false, end: true, openMic: false, intent: 'stop' }
    }

    if (routed.intent === 'progress') {
      resetBump(sessionId)
      const state = await guard(pet.status?.() ?? Promise.resolve({}), 1200, {})
      const currentId = String(state?.sessionId ?? '')
      const pending = store.newestPending(currentId) ?? store.newestPending()
      if (pending) {
        const hit = await guard(
          pet.latestFinal?.({ sessionId: pending.sessionId, sinceSeq: pending.sinceSeq ?? 0 }) ?? Promise.resolve(null),
          1500,
          null,
        )
        if (hit?.text) {
          store.finish(pending.id, hit.text)
          return { text: speakable(hit.text, maxSpeak), notUnderstand: false, end: true, openMic: false, intent: 'progress' }
        }
        return { text: '还在弄，弄好了我叫你。', notUnderstand: false, end: true, openMic: false, intent: 'progress' }
      }
      const lastText = await guard(
        pet.latestFinal?.({ sessionId: currentId, sinceSeq: 0 }) ?? Promise.resolve(null),
        1200,
        null,
      )
      return {
        text: lastText?.text ? speakable(lastText.text, maxSpeak) : '我刚才没在干活，你说吧。',
        notUnderstand: false,
        end: true,
        openMic: false,
        intent: 'progress',
      }
    }

    if (routed.intent === 'switch') {
      resetBump(sessionId)
      try {
        const done = await guard(pet.switchProject(routed.project.title), 2500, null)
        if (!done) {
          return { text: '切项目没成功，稍后再试。', notUnderstand: false, end: true, openMic: false, intent: 'switch' }
        }
        return {
          text: `已切到 ${done.title || routed.project.title}。`,
          notUnderstand: false,
          end: true,
          openMic: false,
          intent: 'switch',
        }
      } catch (error) {
        return {
          text: `没切过去：${error?.message ?? '项目找不到'}。`,
          notUnderstand: false,
          end: true,
          openMic: false,
          intent: 'switch',
        }
      }
    }

    if (routed.intent === 'unknown') {
      const count = bump(sessionId)
      const suffix = routed.reason ? `（${routed.reason}）` : ''
      if (count >= MAX_NOT_UNDERSTAND) {
        resetBump(sessionId)
        return { text: BYE_REPLY, notUnderstand: true, end: true, openMic: false, intent: 'unknown', exit: true }
      }
      return { text: `${UNKNOWN_REPLY}${suffix}`, notUnderstand: true, end: true, openMic: false, intent: 'unknown' }
    }

    /* ---- 派任务（默认意图）---- */
    resetBump(sessionId)
    let result
    try {
      result = await guard(pet.ask(routed.text, { waitMs }), waitMs + 800, { text: null, timedOut: true })
    } catch (error) {
      // 专属会话钉的项目没了（默认 Pet）：如实说，别装成「我在做了」
      const reason = String(error?.message ?? '').trim() || '派不出去了'
      return { text: `${reason}。`, notUnderstand: false, end: true, openMic: false, intent: 'ask' }
    }
    if (result?.text) {
      const text = speakable(result.text, maxSpeak)
      return { text: text || TIMEOUT_REPLY, notUnderstand: false, end: true, openMic: false, intent: 'ask' }
    }
    // 超时：任务已经派出去了，记一笔，等「进度」来补答
    store.add({
      id: randomBytes(6).toString('hex'),
      sessionId: String(result?.sessionId ?? ''),
      text: routed.text,
      at: Date.now(),
      sinceSeq: Number(result?.sinceSeq ?? 0),
      state: 'pending',
    })
    return { text: TIMEOUT_REPLY, notUnderstand: false, end: true, openMic: false, intent: 'ask', timedOut: true }
  }

  const sendJson = (res, status, payload, extraHeaders = {}) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      ...extraHeaders,
    })
    res.end(body)
  }

  /** 读原始 body（Content-MD5 必须对字节算，所以不能边读边 JSON.parse）。 */
  const readRaw = async (req, limit = 64 * 1024) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  /** 挂到路由上的那个 handler。 */
  async function handler(req, res) {
    const started = Date.now()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = String(req.method ?? 'GET').toUpperCase()

    // ① URL 门禁：secret 为空等于不开放，绝不裸奔
    if (!sameSecret(secretOf(req, url), urlSecret)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized', hint: 'URL 里带 ?k=<secret>' })
    }

    // ② 签名门禁：配了 KeyId/Secret 就强制；没配则降级并留告警头
    const warn = []
    if (signer.keyId && signer.secret) {
      const verdict = verifySignature(req, url, signer)
      if (!verdict.ok) {
        log(`xiaoai 签名校验失败：${verdict.reason}`)
        return sendJson(res, 401, { ok: false, error: 'bad-signature', reason: verdict.reason })
      }
    } else {
      warn.push('signature-not-configured')
    }
    const extra = warn.length ? { 'x-warn': warn.join(' ') } : {}

    if (method === 'GET') {
      return sendJson(
        res,
        200,
        {
          ok: true,
          service: 'dsh-pet-voice/xiaoai',
          pet: petName,
          waitMs,
          maxSpeak,
          notUnderstandWindow: MAX_NOT_UNDERSTAND,
          signature: signer.keyId ? 'enforced' : 'not-configured',
          store: store.file,
          last: last
            ? {
                at: last.at,
                ms: last.ms,
                intent: last.intent,
                query: String(last.query ?? '').slice(0, 200),
                sessionId: last.sessionId,
                requestType: last.requestType,
                reply: last.reply,
                notUnderstand: last.notUnderstand,
                end: last.end,
                openMic: last.openMic,
                timedOut: Boolean(last.timedOut),
              }
            : null,
          pending: store.list().filter((t) => t?.state === 'pending').length,
        },
        extra,
      )
    }

    if (method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: '只接受 POST' }, extra)
    }

    let raw
    try {
      raw = await readRaw(req)
    } catch (error) {
      return sendJson(res, 413, { ok: false, error: String(error?.message ?? error) }, extra)
    }

    // ③ Content-MD5：header 声明了就一定核对字节（防 body 被改）
    const declaredMd5 = String(req.headers?.['content-md5'] ?? '').trim()
    if (declaredMd5) {
      const actual = createHash('md5').update(raw).digest('base64')
      if (!sameSecret(actual, declaredMd5)) {
        log('xiaoai Content-MD5 不匹配：报文可能被篡改')
        return sendJson(res, 401, { ok: false, error: 'bad-content-md5' }, extra)
      }
    }

    let event = {}
    if (raw.length) {
      try {
        event = JSON.parse(raw.toString('utf8'))
      } catch {
        // 即便报文坏了也回一个合法动作，避免平台侧看到空响应
        return sendJson(res, 200, buildAction('我没收到内容，你再说一遍？', { notUnderstand: true }), extra)
      }
    }

    let outcome
    try {
      outcome = await answer(event)
    } catch (error) {
      log(`xiaoai 兜底：${error?.message ?? error}`)
      outcome = { text: '我这边出了点问题，等下再试。', notUnderstand: false, end: true, openMic: false, intent: 'error' }
    }

    const action = buildAction(outcome.text, {
      end: outcome.end !== false,
      openMic: Boolean(outcome.openMic),
      notUnderstand: Boolean(outcome.notUnderstand),
    })
    last = {
      at: Date.now(),
      ms: Date.now() - started,
      intent: outcome.intent,
      query: String(event?.query ?? ''),
      sessionId: String(event?.session?.session_id ?? ''),
      requestType: event?.request?.type ?? null,
      reply: action.response.to_speak.text,
      notUnderstand: action.response.not_understand,
      end: action.is_session_end,
      openMic: action.response.open_mic,
      timedOut: Boolean(outcome.timedOut),
    }
    log(
      `xiaoai ${outcome.intent} ${last.ms}ms 「${String(event?.query ?? '').slice(0, 40)}」→ 「${action.response.to_speak.text.slice(0, 40)}」`,
    )
    return sendJson(res, 200, action, extra)
  }

  handler.answer = answer
  handler.store = store
  handler.selftest = () => ({ last, notUnderstand: [...notUnderstand.values()] })
  return handler
}
