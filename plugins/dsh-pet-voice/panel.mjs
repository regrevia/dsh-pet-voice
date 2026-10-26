/**
 * dsh-pet-voice 的宿主面板：配对信息、设备列表、二维码。
 *
 * 面板只在 DSH Web GUI 里用（已登录），所以二维码可以带令牌；
 * 手机页面自己有 cookie，二维码只负责「第一次怎么进去」。
 * 二维码不依赖第三方库：插件目录是 link 安装的，装不了包，
 * 所以这里自带一套 ISO/IEC 18004 的字节模式编码器（ECC M，版本 1–10）。
 *
 * 数据文件与 index.js 共用 `~/.dsh/pet-voice/`：
 *   token        访问令牌，只读，由 index.js 生成
 *   devices.json 扫过码/来过请求的设备
 *   panel.json   面板上的用户设置
 *
 * @module dsh-pet-voice/panel
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { lanState } from './lan.mjs'
import { publicState, publicUrl } from './public.mjs'
import { join } from 'node:path'

export const PANEL_DIR = join(homedir(), '.dsh/pet-voice')

const TOKEN_PATH = join(PANEL_DIR, 'token')
const DEVICES_PATH = join(PANEL_DIR, 'devices.json')
const CONFIG_PATH = join(PANEL_DIR, 'panel.json')

const PLATFORMS = ['android', 'ios', 'web', 'unknown']
const MODES = ['server', 'lan', 'domain']
const MAXWORDS_LEVELS = ['短', '中', '长']
const DEFAULT_CONFIG = {
  // 默认局域网：开源版不预设任何作者侧基础设施；'server' 只是本人体验用的可删档位
  mode: 'lan',
  customUrl: '',
  maxDevices: 2,
  voice: 'zh-CN-XiaoyiNeural',
  wakeName: '大肥鱼',
  persona: '',
  maxWords: '短',
  bubble: true,
  // auto = 先开流、拿不到立即转轮询；poll = 只在网络挡 SSE 时才用得上，强制锁轮询
  transport: 'auto',
  // 语音来源：edge = 微软在线（默认，装 tts-venv）；local = 这台 Mac 的 say；http = 自己的接口
  ttsProvider: 'edge',
  ttsUrl: '',
  ttsVoice: '',
}

const TRANSPORTS = ['auto', 'poll']
const TTS_PROVIDER_IDS = ['edge', 'local', 'http']
export function normalizeTransport(value) {
  const v = String(value ?? '').trim()
  return TRANSPORTS.includes(v) ? v : DEFAULT_CONFIG.transport
}

/* ------------------------------------------------------------------ */
/* 文件读写                                                            */
/* ------------------------------------------------------------------ */

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 先写临时文件再改名：写一半断电也不会留下一个坏 JSON。 */
function writeJson(path, value) {
  mkdirSync(PANEL_DIR, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 临时文件清不掉也不影响下一次覆盖 */
    }
    throw error
  }
}

function clampMaxDevices(value, fallback) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(10, Math.max(1, number))
}

/* ------------------------------------------------------------------ */
/* 设备表                                                              */
/* ------------------------------------------------------------------ */

function readDeviceStore() {
  const raw = readJson(DEVICES_PATH)
  const devices = []
  for (const item of Array.isArray(raw?.devices) ? raw.devices : []) {
    if (typeof item?.id !== 'string' || !item.id) continue
    devices.push({
      id: item.id,
      label: String(item.label ?? ''),
      platform: PLATFORMS.includes(item.platform) ? item.platform : 'unknown',
      ip: String(item.ip ?? ''),
      firstSeen: Number(item.firstSeen) || 0,
      lastSeen: Number(item.lastSeen) || 0,
    })
  }
  return { maxDevices: clampMaxDevices(raw?.maxDevices, 2), devices }
}

function writeDeviceStore(devices, maxDevices) {
  writeJson(DEVICES_PATH, { maxDevices, devices })
}

function remoteAddress(req) {
  const raw = String(req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? '')
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

/** 手机自己报的机型（`X-Pet-Device`）优先；UA 解析只是浏览器兜底。 */
function explicitLabel(req) {
  const raw = String(req?.headers?.['x-pet-device'] ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return raw.slice(0, 40)
}

/** UA 里能稳定认出来的只有 Android 机型和 iOS 大类，其余桌面浏览器都算一个标签。 */
function deviceLabel(ua, explicit = '') {
  if (explicit) return explicit
  const android = ua.match(/Android[^;)]*(?:;\s*[a-z]{2}[-_][a-z]{2})?;\s*([^;)]+)/i)
  if (android) {
    const model = android[1]
      .replace(/\s+Build\/.*$/i, '')
      .replace(/\bwv\b/gi, '')
      .trim()
    // 这些是 UA 的结构占位，不是机型，统一叫 Android 更好认。
    return /^(?:Mobile|Tablet|K)$/i.test(model) ? 'Android' : model || 'Android'
  }
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android'
  if (/Mozilla|Chrome|Safari|Firefox|Edg\//i.test(ua)) return '浏览器'
  return '未知设备'
}

function devicePlatform(ua) {
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Mozilla|Chrome|Safari|Firefox|Edg\//i.test(ua)) return 'web'
  return 'unknown'
}

/**
 * 每个请求都会调一次，所以整段包在 try/catch 里：
 * 磁盘满了、文件被别人改成乱码，都不能把宠物页本身搞挂。
 */
export function touchDevice(req) {
  try {
    const ua = String(req?.headers?.['user-agent'] ?? '')
    const ip = remoteAddress(req)
    const now = Date.now()
    const explicit = explicitLabel(req)
    // App 会给稳定设备 id：同一台手机换 UA、换网络、重装都还是同一行。
    const claimed = String(req?.headers?.['x-pet-device-id'] ?? '').toLowerCase()
    const id = /^[a-f0-9]{8,32}$/.test(claimed)
      ? claimed
      : createHash('sha1').update(`${ua}${ip}`).digest('hex').slice(0, 12)
    const store = readDeviceStore()
    const existing = store.devices.find((item) => item.id === id)
    // 绑定上限以前只是面板上的一个数字：不执行就等于没设。新设备超限不再记录，
    // 由调用方回 429（旧设备继续用不受影响，否则自己把自己锁在门外）。
    if (!existing && store.devices.length >= store.maxDevices) {
      return { ok: false, reason: 'limit', maxDevices: store.maxDevices }
    }
    if (existing) {
      existing.lastSeen = now
      existing.ip = ip
      // 以前只能从 UA 猜，现在手机自己报了机型：把占位标签换成真名字。
      if (explicit && existing.label !== explicit) existing.label = explicit
      else if (!explicit && !existing.label) existing.label = deviceLabel(ua)
      if (explicit) existing.platform = 'android'
    } else {
      store.devices.push({
        id,
        label: deviceLabel(ua, explicit),
        platform: explicit ? 'android' : devicePlatform(ua),
        ip,
        firstSeen: now,
        lastSeen: now,
      })
    }
    // 记录表只留最近 50 台；上限由面板设置管，不在这里删用户可见的设备。
    if (store.devices.length > 50) {
      store.devices
        .sort((a, b) => a.lastSeen - b.lastSeen)
        .splice(0, store.devices.length - 50)
    }
    writeDeviceStore(store.devices, store.maxDevices)
    return { ok: true, id }
  } catch {
    /* 设备记录失败不影响请求本身 */
    return { ok: true, skipped: true }
  }
}

export function listDevices() {
  return readDeviceStore().devices.sort((a, b) => b.lastSeen - a.lastSeen)
}

/**
 * 换主令牌后调用：设备表里那几行已经没有有效凭证了，留着只会让面板声称「这几台还连着」，
 * 还会把绑定上限的额度占满（用户移出一台仍然加不进新手机）。清空记录＝面板不再说谎。
 */
export function clearDevices() {
  try {
    writeDeviceStore([], readDeviceStore().maxDevices)
    return true
  } catch {
    return false
  }
}

export function removeDevice(id) {
  const key = String(id ?? '').trim()
  if (!key) return false
  try {
    const store = readDeviceStore()
    const devices = store.devices.filter((item) => item.id !== key)
    if (devices.length === store.devices.length) return false
    writeDeviceStore(devices, store.maxDevices)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 面板设置                                                            */
/* ------------------------------------------------------------------ */

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? '').trim())
}

/** RFC 2606 的示例域名：文档里当占位符用，面板不拿它当已配好的地址。 */
const PLACEHOLDER_HOST = /(^|\.)example\.(com|net|org)$/i

function isPlaceholderUrl(value) {
  try {
    return PLACEHOLDER_HOST.test(new URL(String(value ?? '').trim()).hostname)
  } catch {
    return false
  }
}

/** ssh 隧道自己的地址：旧版连上后会顺手写进 customUrl，不能让它冒充「自己的域名」。 */
function selfTunnelOrigin() {
  try {
    return publicState().running ? new URL(publicUrl()).origin : ''
  } catch {
    return ''
  }
}

function sameOrigin(a, b) {
  try {
    return Boolean(a) && Boolean(b) && new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

function readPanelConfig() {
  const raw = readJson(CONFIG_PATH)
  const storedUrl = String(raw?.customUrl ?? '').trim()
  const customUrl = sameOrigin(storedUrl, selfTunnelOrigin()) ? '' : storedUrl
  return {
    mode: MODES.includes(raw?.mode) ? raw.mode : DEFAULT_CONFIG.mode,
    customUrl: isHttpUrl(customUrl) && !isPlaceholderUrl(customUrl) ? customUrl : '',
    maxDevices: clampMaxDevices(raw?.maxDevices, DEFAULT_CONFIG.maxDevices),
    // 空值交给默认音色：下拉框不能空着，空着等于「看着能选、实际用的是另一把声音」。
    voice: String(raw?.voice ?? '').trim() || DEFAULT_CONFIG.voice,
    wakeName: String(raw?.wakeName ?? DEFAULT_CONFIG.wakeName).trim(),
    persona: String(raw?.persona ?? '').trim().slice(0, 2000),
    maxWords: MAXWORDS_LEVELS.includes(String(raw?.maxWords ?? '').trim())
      ? String(raw.maxWords).trim()
      : DEFAULT_CONFIG.maxWords,
    bubble: raw?.bubble === undefined ? DEFAULT_CONFIG.bubble : raw.bubble !== false,
    transport: normalizeTransport(raw?.transport),
    ttsProvider: TTS_PROVIDER_IDS.includes(String(raw?.ttsProvider ?? '').trim())
      ? String(raw.ttsProvider).trim()
      : DEFAULT_CONFIG.ttsProvider,
    ttsUrl: isHttpUrl(String(raw?.ttsUrl ?? '').trim()) ? String(raw.ttsUrl).trim() : '',
    ttsVoice: String(raw?.ttsVoice ?? '').trim(),
  }
}

export function getPanelConfig() {
  return readPanelConfig()
}

export function setPanelConfig(patch) {
  const next = readPanelConfig()
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}

  if (input.mode !== undefined) {
    const mode = String(input.mode ?? '').trim()
    if (!MODES.includes(mode)) throw new Error('模式只能选服务器、局域网或自建域名')
    next.mode = mode
  }
  if (input.customUrl !== undefined) {
    const customUrl = String(input.customUrl ?? '').trim()
    if (customUrl && !isHttpUrl(customUrl)) throw new Error('自定义地址要是 http(s) 开头')
    if (customUrl && isPlaceholderUrl(customUrl)) throw new Error('换成你自己的域名，example.com 只是示例')
    next.customUrl = customUrl
  }
  if (input.maxDevices !== undefined) {
    const number = Math.round(Number(input.maxDevices))
    if (!Number.isFinite(number)) throw new Error('设备数要是 1 到 10')
    next.maxDevices = clampMaxDevices(number, DEFAULT_CONFIG.maxDevices)
  }
  for (const key of ['voice', 'wakeName']) {
    if (input[key] !== undefined) next[key] = String(input[key] ?? '').trim()
  }
  if (input.persona !== undefined) {
    // 人设是自由文本：留换行，只砍首尾空白并限长
    next.persona = String(input.persona ?? '').trim().slice(0, 2000)
  }
  if (input.maxWords !== undefined) {
    const level = String(input.maxWords ?? '').trim()
    if (!MAXWORDS_LEVELS.includes(level)) throw new Error('输出长度只能选短、中、长')
    next.maxWords = level
  }
  if (input.bubble !== undefined) next.bubble = input.bubble !== false
  if (input.transport !== undefined) {
    const transport = String(input.transport ?? '').trim()
    if (!TRANSPORTS.includes(transport)) throw new Error('传输方式只能选自动或轮询')
    next.transport = transport
  }
  if (input.ttsProvider !== undefined) {
    const provider = String(input.ttsProvider ?? '').trim()
    if (!TTS_PROVIDER_IDS.includes(provider)) throw new Error('语音来源只能选微软、本机或自己的接口')
    next.ttsProvider = provider
  }
  if (input.ttsUrl !== undefined) {
    const url = String(input.ttsUrl ?? '').trim()
    if (url && !isHttpUrl(url)) throw new Error('接口地址要以 http 或 https 开头')
    next.ttsUrl = url
  }
  if (input.ttsVoice !== undefined) next.ttsVoice = String(input.ttsVoice ?? '').trim()

  writeJson(CONFIG_PATH, next)
  // 旧版把上限存在设备表里，两处写同一个值，读哪份都不会互相打脸。
  try {
    const store = readDeviceStore()
    writeDeviceStore(store.devices, next.maxDevices)
  } catch {
    /* 设置已经落盘，设备表同步失败不影响这次保存 */
  }
  return next
}

/* ------------------------------------------------------------------ */
/* 配对面板                                                            */
/* ------------------------------------------------------------------ */

/**
 * 纯局域网地址：宿主只听 127.0.0.1，手机得走 lan.mjs 起的那层明文监听。
 * 监听没起来（端口全被占）就给空串，面板显示「现在用不了」而不是给个打不开的地址。
 */
function lanBase() {
  const info = lanState()
  return info.running && info.url ? info.url : ''
}

/** 不管用户填的是域名根还是已经带路径，最后都要落到插件挂载的 /pet-voice/。 */
function normalizeBase(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    let path = url.pathname.replace(/\/+$/, '')
    if (!path.endsWith('/pet-voice')) path = `${path}/pet-voice`
    return `${url.origin}${path}/`
  } catch {
    return ''
  }
}

function pairingToken() {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim()
  } catch {
    return ''
  }
}

export function panelState({ origin, pairing } = {}) {
  const config = readPanelConfig()
  const source = pairing && typeof pairing === 'object' ? pairing : {}
  // 「自己的服务器」两种来源：面板里连着的 ssh 反向隧道（地址是 ssh 那台机器的公网口），
  // 或者外部隧道脚本留下的域名（cloudflared / 小爱）。谁在用给谁，都没在跑就是空。
  const pub = publicState()
  const serverUrl = pub.running && pub.url ? publicUrl() : ''
  const modes = [
    {
      id: 'server',
      label: '自己的服务器',
      url: serverUrl || (source.source === 'tunnel' ? String(source.publicBase ?? '').trim() : ''),
    },
    { id: 'lan', label: '同一个 Wi-Fi', url: lanBase(origin) },
    { id: 'domain', label: '自己的域名', url: config.customUrl },
  ]
  const base = normalizeBase(modes.find((item) => item.id === config.mode)?.url)
  // 配对走 ?k=：pageHandler 校验后 303 下发 cookie，和 /panel/link 的链接同一形状。
  const token = base ? pairingToken() : ''
  return {
    ok: true,
    modes,
    mode: config.mode,
    customUrl: config.customUrl,
    maxDevices: config.maxDevices,
    devices: listDevices(),
    pairingUrl: base ? `${base}${token ? `?k=${encodeURIComponent(token)}` : ''}` : '',
    alive: Boolean(source.alive),
    voice: config.voice,
    wakeName: config.wakeName,
    persona: config.persona,
    maxWords: config.maxWords,
    bubble: config.bubble,
    transport: config.transport,
    ttsProvider: config.ttsProvider,
    ttsUrl: config.ttsUrl,
    ttsVoice: config.ttsVoice,
  }
}

/* ------------------------------------------------------------------ */
/* 二维码：ISO/IEC 18004，字节模式，纠错等级 M                          */
/* ------------------------------------------------------------------ */

/** 版本 → 每块纠错码字数。 */
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]

/** 版本 → 分组 [块数, 每块数据码字数]（M 级）。 */
const BLOCKS = [
  null,
  [[1, 16]],
  [[1, 28]],
  [[1, 44]],
  [[2, 32]],
  [[2, 43]],
  [[4, 27]],
  [[4, 31]],
  [[2, 38], [2, 39]],
  [[3, 36], [2, 37]],
  [[4, 43], [1, 44]],
]

/** 版本 → 对齐图案中心坐标。 */
const ALIGN = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) {
  GF_EXP[i] = x
  GF_LOG[x] = i
  x <<= 1
  if (x & 0x100) x ^= 0x11d
}
for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]

function gfMul(a, b) {
  return a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0
}

const GENERATORS = new Map()

/** 生成多项式 ∏(x - α^i)，i = 0..degree-1，系数从高次到低次。 */
function rsGenerator(degree) {
  const cached = GENERATORS.get(degree)
  if (cached) return cached
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i])
    }
    poly = next
  }
  GENERATORS.set(degree, poly)
  return poly
}

/** 用移位寄存器做多项式取余，得到该块的纠错码字。 */
function rsEcc(data, degree) {
  const generator = rsGenerator(degree)
  const remainder = new Uint8Array(degree)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[degree - 1] = 0
    if (factor) {
      for (let i = 0; i < degree; i++) remainder[i] ^= gfMul(generator[i + 1], factor)
    }
  }
  return remainder
}

function countBits(version) {
  // 字节模式字符计数：1–9 版 8 位，10 版起 16 位。
  return version < 10 ? 8 : 16
}

function dataCodewords(version) {
  let total = 0
  for (const [count, length] of BLOCKS[version]) total += count * length
  return total
}

function byteCapacity(version) {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8)
}

function pickVersion(length) {
  for (let version = 1; version <= 10; version++) {
    if (length <= byteCapacity(version)) return version
  }
  throw new Error('内容太长，二维码放不下')
}

function encodeData(version, bytes) {
  const bits = []
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, countBits(version))
  for (const byte of bytes) push(byte, 8)

  const capacity = dataCodewords(version) * 8
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0)
  while (bits.length % 8) bits.push(0)

  const data = []
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j]
    data.push(value)
  }
  // 标准填充字节：0xEC / 0x11 交替。
  for (let i = 0; data.length < dataCodewords(version); i++) {
    data.push(i % 2 === 0 ? 0xec : 0x11)
  }
  return data
}

function splitBlocks(data, version) {
  const ecLength = EC_PER_BLOCK[version]
  const blocks = []
  let offset = 0
  for (const [count, length] of BLOCKS[version]) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(offset, offset + length)
      offset += length
      blocks.push({ data: chunk, ecc: rsEcc(chunk, ecLength) })
    }
  }
  return { blocks, ecLength }
}

function interleave(blocks, ecLength) {
  const output = []
  const longest = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) {
      if (i < block.data.length) output.push(block.data[i])
    }
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of blocks) output.push(block.ecc[i])
  }
  return output
}

const MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
]

/** 格式信息：M 级的 2 位值是 00，后面接 3 位掩码，再加 BCH(15,5)。 */
function formatBits(mask) {
  const data = mask // 0b000 << 3 | mask
  let remainder = data
  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  }
  return ((data << 10) | remainder) ^ 0x5412
}

function versionBits(version) {
  let remainder = version
  for (let i = 0; i < 12; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
  }
  return (version << 12) | remainder
}

function drawFormat(grid, mask) {
  const size = grid.length
  const bits = formatBits(mask)
  const put = (row, col, bit) => {
    grid[row][col] = bit
  }
  for (let i = 0; i <= 5; i++) put(i, 8, (bits >>> i) & 1)
  put(7, 8, (bits >>> 6) & 1)
  put(8, 8, (bits >>> 7) & 1)
  put(8, 7, (bits >>> 8) & 1)
  for (let i = 9; i < 15; i++) put(8, 14 - i, (bits >>> i) & 1)
  for (let i = 0; i < 8; i++) put(8, size - 1 - i, (bits >>> i) & 1)
  for (let i = 8; i < 15; i++) put(size - 15 + i, 8, (bits >>> i) & 1)
  put(size - 8, 8, 1) // 固定的暗模块
}

function penalty(grid) {
  const size = grid.length
  let score = 0

  // 规则 1：同色连续 5 个起，每多 1 个加 1。
  for (let i = 0; i < size; i++) {
    let rowRun = 1
    let colRun = 1
    for (let j = 1; j < size; j++) {
      if (grid[i][j] === grid[i][j - 1]) rowRun++
      else {
        if (rowRun >= 5) score += 3 + rowRun - 5
        rowRun = 1
      }
      if (grid[j][i] === grid[j - 1][i]) colRun++
      else {
        if (colRun >= 5) score += 3 + colRun - 5
        colRun = 1
      }
    }
    if (rowRun >= 5) score += 3 + rowRun - 5
    if (colRun >= 5) score += 3 + colRun - 5
  }

  // 规则 2：2×2 同色块，每块 3 分。
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const value = grid[row][col]
      if (value === grid[row][col + 1] && value === grid[row + 1][col] && value === grid[row + 1][col + 1]) {
        score += 3
      }
    }
  }

  // 规则 3：1:1:3:1:1 的类定位图案，两侧算上静区（补 4 个白格）。
  const patterns = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ]
  for (let i = 0; i < size; i++) {
    const rowLine = [0, 0, 0, 0]
    const colLine = [0, 0, 0, 0]
    for (let j = 0; j < size; j++) {
      rowLine.push(grid[i][j])
      colLine.push(grid[j][i])
    }
    rowLine.push(0, 0, 0, 0)
    colLine.push(0, 0, 0, 0)
    for (const pattern of patterns) {
      for (let j = 0; j <= rowLine.length - pattern.length; j++) {
        let match = true
        for (let k = 0; k < pattern.length; k++) {
          if (rowLine[j + k] !== pattern[k]) {
            match = false
            break
          }
        }
        if (match) score += 40
      }
      for (let j = 0; j <= colLine.length - pattern.length; j++) {
        let match = true
        for (let k = 0; k < pattern.length; k++) {
          if (colLine[j + k] !== pattern[k]) {
            match = false
            break
          }
        }
        if (match) score += 40
      }
    }
  }

  // 规则 4：深色比例每偏离 50% 满 5% 加 10 分。
  let dark = 0
  for (const row of grid) {
    for (const value of row) dark += value
  }
  const total = size * size
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10
  return score
}

function buildMatrix(version, codewords) {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Uint8Array(size))
  const fixed = Array.from({ length: size }, () => new Uint8Array(size))
  const set = (row, col, dark) => {
    if (row < 0 || row >= size || col < 0 || col >= size) return
    modules[row][col] = dark ? 1 : 0
    fixed[row][col] = 1
  }

  // 三个定位图案 + 分隔符。
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const dark =
          (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
          (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
        set(top + dr, left + dc, dark)
      }
    }
  }

  // 定时图案。
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  // 对齐图案；落在定位图案上的组合跳过。
  for (const row of ALIGN[version]) {
    for (const col of ALIGN[version]) {
      if ((row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
        }
      }
    }
  }

  // 格式信息位置先占住，掩码定了再填值。
  for (const [row, col] of [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ]) {
    fixed[row][col] = 1
  }
  for (let i = 0; i < 8; i++) fixed[8][size - 1 - i] = 1
  for (let i = 8; i < 15; i++) fixed[size - 15 + i][8] = 1
  fixed[size - 8][8] = 1

  // 版本信息只在 7 版及以上出现，两个 3×6 块。
  if (version >= 7) {
    const bits = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(b, a, bit)
      set(a, b, bit)
    }
  }

  // 数据位：从右下角蛇形往上/下走，跳过第 6 列和所有功能模块。
  const bits = []
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1)
  }
  // 2–6 版末尾有 7 个余位，补 0 后正好填满矩阵。
  const remainder = version >= 2 && version <= 6 ? 7 : 0
  for (let i = 0; i < remainder; i++) bits.push(0)

  const cells = []
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vert : vert
        if (fixed[row][col]) continue
        cells.push([row, col, bits[index] ?? 0])
        index++
      }
    }
  }

  // 8 个掩码都算一遍罚分，取最低的；同分时保留小掩码。
  let best = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const grid = modules.map((row) => Uint8Array.from(row))
    const maskFn = MASKS[mask]
    for (const [row, col, bit] of cells) {
      grid[row][col] = bit ^ (maskFn(row, col) ? 1 : 0)
    }
    drawFormat(grid, mask)
    const score = penalty(grid)
    if (score < bestScore) {
      bestScore = score
      best = grid
    }
  }
  return best
}

function renderSvg(grid) {
  const size = grid.length
  const quiet = 4
  const extent = size + quiet * 2
  const path = []
  for (let row = 0; row < size; row++) {
    let col = 0
    while (col < size) {
      if (!grid[row][col]) {
        col++
        continue
      }
      let end = col + 1
      while (end < size && grid[row][end]) end++
      const length = end - col
      path.push(`M${col + quiet} ${row + quiet}h${length}v1h-${length}z`)
      col = end
    }
  }
  // 白底黑码：相位色是固定的，跟着主题走会在深色下糊成一片
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges" fill="#111111"><path d="${path.join('')}"/></svg>`
}

export function qrSvg(text) {
  const bytes = [...Buffer.from(String(text ?? ''), 'utf8')]
  if (!bytes.length) return ''
  const version = pickVersion(bytes.length)
  const data = encodeData(version, bytes)
  const { blocks, ecLength } = splitBlocks(data, version)
  return renderSvg(buildMatrix(version, interleave(blocks, ecLength)))
}
