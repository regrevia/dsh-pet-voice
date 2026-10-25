// 入口层的路径规范化 + 面板识别。
//
// 为什么单独一层：宿主看到的是「回环地址来的请求」，面板门禁只查 remoteAddress，
// 所以外部入口（public.mjs 的 https 代理、lan.mjs 的局域网代理、scripts/tls-proxy.mjs）
// 是匿名请求唯一能被拦下的地方。官方 DSH 用 new URL(...).pathname 规范化后再路由，
// 入口如果拿*原始* URL 判断，`/pet-voice/api/../panel/state`、`%2e%2e`、`%252e`、
// 反斜杠、双斜杠这些写法就能一边骗过白名单、一边被宿主规范化成面板路径。
//
// 规则：判定和转发必须用同一个 normalizeTarget() 结果。判定看 path（已解码的规范形），
// 转发用 wire（重新百分号编码，保证是合法的请求行）。最多解 3 层编码，解不干净直接拒。

const MAX_DECODE_LAYERS = 3
const PANEL_ROOT = '/pet-voice/panel'
const BASE_ROOT = '/pet-voice'
const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

/** 去掉 . / .. 段、空段，折叠重复斜杠；返回值不带结尾斜杠（根路径除外）。 */
function collapseSegments(decoded) {
  const parts = []
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return `/${parts.join('/')}`
}

/**
 * 规范化请求目标（origin-form 或完整 URL 都收）。
 * 返回 { path, wire, search }；不合法（NUL、非法百分号、解码失败）返回 null。
 *   path  —— 解码后的规范形，用于判定
 *   wire  —— 重新编码后的路径，用于转发
 *   search—— 原样保留的 query（不做解码，只拒 CR/LF）
 */
export function normalizeTarget(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  if (raw.includes('\0')) return null

  let target = raw
  let search = ''
  const q = target.indexOf('?')
  if (q >= 0) {
    search = target.slice(q)
    target = target.slice(0, q)
  }
  const hash = target.indexOf('#')
  if (hash >= 0) target = target.slice(0, hash)
  // 请求行里出现 CR/LF 就是注入，直接拒
  if (/[\r\n]/.test(search) || /[\r\n]/.test(target)) return null

  // 完整 URL：只取 pathname/search，别把 scheme/host 带进转发
  if (ABSOLUTE_URL.test(target)) {
    let parsed
    try {
      parsed = new URL(target.endsWith('?') ? target : target)
    } catch {
      return null
    }
    target = parsed.pathname
    search = parsed.search
  }
  // URL 语义里反斜杠等同分隔符：`/pet-voice/panel\..\panel/state` 也要能被规范化
  target = target.replace(/\\/g, '/')

  let path = target
  for (let layer = 0; layer < MAX_DECODE_LAYERS; layer += 1) {
    let decoded
    try {
      decoded = decodeURIComponent(path)
    } catch {
      return null // 非法百分号（%zz、%E0%A4 截断）：不猜，直接拒
    }
    if (decoded.includes('\0')) return null
    path = collapseSegments(decoded)
    // 解完还留着 %XX 说明是多重编码，继续解；解到没有转义为止
    if (!/%[0-9a-fA-F]{2}/.test(path)) break
    if (layer === MAX_DECODE_LAYERS - 1) return null // 3 层还没解干净：不猜
  }
  if (/%[0-9a-fA-F]{2}/.test(path)) return null

  const wire = path === '/'
    ? '/'
    : `/${path.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/')}`
  return { path, wire, search }
}

/** 只要规范形（判定用）；不合法返回 null。 */
export function normalizePath(raw) {
  return normalizeTarget(raw)?.path ?? null
}

/** 是否 /pet-voice/panel 及其子路径（大小写不敏感：宁可按面板拦，也不给绕过的缝）。 */
export function isPanelPath(normalized) {
  if (typeof normalized !== 'string' || !normalized) return false
  const lower = normalized.toLowerCase()
  return lower === PANEL_ROOT || lower.startsWith(`${PANEL_ROOT}/`)
}

/** 入口层不该转发给宿主的路径（目前就是面板：有令牌、二维码、配对链接）。 */
export function isProtectedPath(normalized) {
  return isPanelPath(normalized)
}

/** 是不是 /pet-voice 这条入口（含根路径与所有子路径）。 */
export function isPetVoicePath(normalized) {
  if (typeof normalized !== 'string' || !normalized) return false
  return normalized === BASE_ROOT || normalized.startsWith(`${BASE_ROOT}/`)
}

/** 规范形 + 原 query，拼成可以写进 http request 的 path。 */
export function forwardPath(target) {
  if (!target) return null
  return `${target.wire}${target.search}`
}
