/**
 * dsh-web-anysearch-anon
 *
 * A zero-dependency `ctx.web` provider pair (search + fetch) backed by
 * AnySearch's **anonymous** channel: `POST https://api.anysearch.com/v1/search`
 * and `POST https://api.anysearch.com/v1/extract`, sent with no `Authorization`
 * header at all. AnySearch meters anonymous traffic per client IP against the
 * daily free quota, so this provider makes `web_search` / `web_fetch` usable
 * before the user supplies an API key. Once a real key exists, switch the
 * `web` row back to `dsh-web-search-free`; this plugin adds a provider id and
 * never touches that plugin's behaviour.
 *
 * Why a provider instead of a tool: `@deepseek-ai/dsh-web` (service `ctx.web`,
 * row id `web`) resolves one provider per capability at call time. A provider
 * only has to answer `search(request, signal)` / `fetch(request, signal)`, so
 * the shipped `web_search` / `web_fetch` tools keep their schemas, their
 * source caps (the seam truncates `sources[]` to `request.maxResults`) and
 * their prompt text.
 *
 * Result shapes are the seam's own vocabulary (see
 * `@deepseek-ai/dsh-web/lib/index.js` and `dsh-web-fetch-http`):
 *   WebSearchResult { content?: string, sources: [{url, title?, snippet?, publishedAt?}], truncated }
 *   WebFetchResult  { url, statusCode, body: { kind: 'html' | 'text', content }, truncated }
 *
 * Two deliberate choices:
 *   - Errors are thrown, never turned into empty results. An empty
 *     `WebSearchResult` reads as "the web has nothing", which hides a 429 or a
 *     quota refusal and would silently end a caller's fallback chain.
 *   - `signal` is forwarded to `fetch` untouched. The seam and the caller own
 *     cancellation and timeouts; a second internal timer would only cut a
 *     legitimately slow extract short and report a misleading cause.
 *
 * @module dsh-web-anysearch-anon
 */

export const name = 'dsh-web-anysearch-anon'
/** The `web` seam is the only service this plugin talks to. */
export const inject = ['web']

/** Provider id, shared by both halves so one `web` row config pins both. */
const PROVIDER_ID = 'anysearch-anon'
/** Search endpoint. The API host is `api.anysearch.com`, never the docs site. */
const SEARCH_ENDPOINT = 'https://api.anysearch.com/v1/search'
/** Fetch endpoint (returns `data.content` as markdown). */
const EXTRACT_ENDPOINT = 'https://api.anysearch.com/v1/extract'
/** Attribution header; the anonymous channel does not authenticate on it. */
const USER_AGENT = 'dsh-web-anysearch-anon/1.0'
/** AnySearch caps one search at 10 results; also the fallback when unset. */
const MAX_RESULTS_CAP = 10
/** Snippet budget handed to the model; full bodies belong to `web_fetch`. */
const SNIPPET_MAX_CHARS = 300
/** A body at or above this length is reported as truncated. */
const TRUNCATE_AT_CHARS = 50_000
/** Extract refuses pages it cannot render; the fallback asks for the raw HTML as a desktop browser. */
const FALLBACK_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
/** The fallback wants a document, not JSON. */
const FALLBACK_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
/** Only textual responses can be flattened into plain text. */
const TEXTUAL_CONTENT_TYPE = /^(?:text\/|application\/(?:xhtml\+xml|xml))/iu

/**
 * Read a response body as JSON, failing loudly instead of returning `null`.
 * @param {Response} response - the upstream response.
 * @param {string} label - endpoint name for the error message.
 * @returns {Promise<unknown>} the parsed body.
 */
async function readJson(response, label) {
  const text = await response.text()
  if (text.length === 0) throw new Error(`AnySearch ${label}: 上游返回空响应（HTTP ${response.status}）`)
  try {
    return JSON.parse(text)
  } catch {
    const preview = text.replace(/\s+/gu, ' ').slice(0, 200)
    throw new Error(`AnySearch ${label}: 上游返回非 JSON 响应（HTTP ${response.status}）：${preview}`)
  }
}

/**
 * Assert the envelope AnySearch always sends and unwrap `data`.
 * HTTP 200 alone is not success: the payload's `code` must be 0.
 * @param {Response} response - the upstream response.
 * @param {unknown} payload - the parsed envelope.
 * @param {string} label - endpoint name for the error message.
 * @returns {Record<string, unknown>} the `data` object.
 */
function unwrap(response, payload, label) {
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`AnySearch ${label}: 响应不是 JSON 对象（HTTP ${response.status}）`)
  }
  const envelope = /** @type {Record<string, unknown>} */ (payload)
  const code = envelope.code
  if (code !== 0) {
    const message = typeof envelope.message === 'string' && envelope.message.length > 0 ? envelope.message : '（无 message）'
    const requestId = typeof envelope.request_id === 'string' ? `，request_id=${envelope.request_id}` : ''
    throw new Error(`AnySearch ${label}: 上游拒绝请求（HTTP ${response.status}，code=${String(code)}）：${message}${requestId}`)
  }
  const data = envelope.data
  if (data === null || typeof data !== 'object') {
    throw new Error(`AnySearch ${label}: 成功响应缺少 data 对象（HTTP ${response.status}）`)
  }
  return /** @type {Record<string, unknown>} */ (data)
}

/** Human-readable cause for the upstream statuses AnySearch actually returns. */
const STATUS_HINTS = new Map([
  [401, '当前 API Key 被上游拒绝，删掉 config.apiKey 可回到匿名通道'],
  [402, '该出口 IP 的匿名当日免费额度已用尽；配置 config.apiKey 后按账号额度继续，或等次日重置'],
  [403, '被上游拒绝（可能命中 IP 风控），稍后重试，或配置 config.apiKey'],
  [422, '目标 URL 无法抽取正文（页面不存在、需要登录或被站点拦截）'],
  [429, '按 IP 限流，稍后重试，或配置 config.apiKey 换账号额度'],
])

/**
 * Optional API key, read from the owning row's `config.apiKey`.
 * Unset (the default) means the anonymous channel: no `Authorization` header at all.
 */
let apiKey = ''

/** Shapes that look like credentials, so an upstream body can never leak one into a log or a reply. */
const SECRET_TOKENS = [
  /\b(?:api_key|apikey|api-key|password|passwd|username)\s*[=:]\s*"?[^"\s,;]+"?/giu,
  /\bas_sk_[A-Za-z0-9_-]+/gu,
]

/**
 * Strip credential-looking tokens out of untrusted text (AnySearch's 402 body
 * auto-provisions an account and prints its username/password/api_key).
 * @param {string} text - untrusted upstream text.
 * @returns {string} the text with every matching value replaced.
 */
function redactSecrets(text) {
  let out = text
  for (const pattern of SECRET_TOKENS) {
    out = out.replace(pattern, (match) => (match.startsWith('as_sk_') ? 'as_sk_<已隐去>' : `${match.split(/[=:]/u)[0].trim()}=<已隐去>`))
  }
  return out
}

/**
 * Throw a readable error for a non-2xx upstream status.
 * @param {Response} response - the upstream response.
 * @param {string} label - endpoint name for the error message.
 * @returns {Promise<void>} resolves when the status is 2xx.
 */
async function assertOk(response, label) {
  if (response.ok) return
  const hint = STATUS_HINTS.get(response.status) ?? '请求未被接受'
  let detail = ''
  try {
    const text = await response.text()
    try {
      const body = JSON.parse(text)
      const message = body !== null && typeof body === 'object' && typeof body.message === 'string' ? body.message : ''
      const code = body !== null && typeof body === 'object' ? body.code : undefined
      detail = message.length > 0 ? `code=${String(code)}，${message}` : text.replace(/\s+/gu, ' ').slice(0, 300)
    } catch {
      detail = text.replace(/\s+/gu, ' ').slice(0, 300)
    }
  } catch {
    detail = ''
  }
  throw new Error(
    `AnySearch ${label}: HTTP ${response.status}（${hint}）${detail.length > 0 ? `：${redactSecrets(detail)}` : ''}`,
  )
}

/**
 * POST a JSON body to one AnySearch endpoint and unwrap the envelope.
 * @param {string} endpoint - absolute endpoint URL.
 * @param {Record<string, unknown>} body - request payload.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @param {string} label - endpoint name for error messages.
 * @returns {Promise<{ response: Response, data: Record<string, unknown> }>} status and payload.
 */
async function postJson(endpoint, body, signal, label) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  await assertOk(response, label)
  return { response, data: unwrap(response, await readJson(response, label), label) }
}

/**
 * Clamp the caller's result budget into AnySearch's documented 1..10 window.
 * @param {number | undefined} maxResults - `request.maxResults`.
 * @returns {number} the `max_results` to send upstream.
 */
function clampMaxResults(maxResults) {
  if (typeof maxResults !== 'number' || !Number.isFinite(maxResults)) return MAX_RESULTS_CAP
  return Math.min(MAX_RESULTS_CAP, Math.max(1, Math.trunc(maxResults)))
}

/**
 * Build one `sources[]` entry from an AnySearch result row.
 * @param {unknown} row - one `data.results[]` element.
 * @returns {{ url: string, title: string, snippet?: string } | undefined} the entry, or undefined when unusable.
 */
function toSource(row) {
  if (row === null || typeof row !== 'object') return undefined
  const item = /** @type {Record<string, unknown>} */ (row)
  const url = typeof item.url === 'string' ? item.url.trim() : ''
  if (url.length === 0) return undefined
  const title = typeof item.title === 'string' && item.title.trim().length > 0 ? item.title.trim() : url
  // `content` is the longer excerpt when AnySearch returns one; `snippet` is the short one.
  const excerptSource =
    typeof item.content === 'string' && item.content.trim().length > 0
      ? item.content
      : typeof item.snippet === 'string'
        ? item.snippet
        : ''
  const snippet = excerptSource.replace(/\s+/gu, ' ').trim().slice(0, SNIPPET_MAX_CHARS)
  return snippet.length > 0 ? { url, title, snippet } : { url, title }
}

/**
 * Run one anonymous AnySearch query.
 * @param {unknown} request - the seam's `WebSearchRequest`.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<{ content: string, sources: Array<{url: string, title: string, snippet?: string}>, truncated: boolean }>} normalized result.
 */
async function search(request, signal) {
  const query = request !== null && typeof request === 'object' ? /** @type {Record<string, unknown>} */ (request).query : undefined
  if (typeof query !== 'string' || query.trim().length === 0) throw new Error('AnySearch 搜索：调用方没有给出非空 query')
  const maxResults = clampMaxResults(/** @type {Record<string, unknown>} */ (request).maxResults)
  const { data } = await postJson(SEARCH_ENDPOINT, { query, max_results: maxResults }, signal, '搜索')
  const rows = data.results
  if (!Array.isArray(rows)) {
    throw new Error('AnySearch 搜索：成功响应缺少 data.results 数组')
  }
  const sources = []
  const seen = new Set()
  for (const row of rows) {
    const source = toSource(row)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  // A genuinely empty result set is a real answer ("no hits"), not an error;
  // the seam caps `sources[]` itself and sets `truncated` when it cuts.
  return { content: '', sources, truncated: false }
}

/** Named HTML entities common in Chinese and English pages; numeric forms are handled below. */
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['hellip', '…'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['middot', '·'],
  ['times', '×'],
  ['copy', '©'],
  ['reg', '®'],
  ['trade', '™'],
])

/**
 * Decode HTML character references (`&amp;`, `&#39;`, `&#x4e2d;`) without a dependency.
 * Unknown or malformed references are left untouched.
 * @param {string} text - text containing character references.
 * @returns {string} decoded text.
 */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/giu, (match, body) => {
    const key = body.toLowerCase()
    const named = NAMED_ENTITIES.get(key)
    if (named !== undefined) return named
    const radix = key.startsWith('#x') ? 16 : 10
    const digits = key.startsWith('#x') ? key.slice(2) : key.slice(1)
    const codePoint = key.startsWith('#') ? Number.parseInt(digits, radix) : Number.NaN
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return match
    }
  })
}

/**
 * Flatten an HTML document to plain text: drop non-content elements, turn block
 * boundaries into line breaks, strip tags, decode entities, then collapse the
 * blank-line noise that nav/footer leftovers produce.
 * @param {string} html - the raw document.
 * @returns {string} plain text, possibly empty.
 */
function htmlToText(html) {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/giu, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|main|aside|nav|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dt|dd|figcaption|form|title)\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ')
  const lines = decodeEntities(withoutHidden)
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t\f\v]+/gu, ' ')
    .split('\n')
    .map((line) => line.trim())
  const kept = []
  for (const line of lines) {
    if (line.length === 0 && (kept.length === 0 || kept[kept.length - 1] === '')) continue
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  return kept.join('\n')
}

/**
 * GET one URL directly and flatten it to plain text. This is the second tier:
 * extract cannot render some pages (client-rendered, POST-only, bot-guarded),
 * yet a plain desktop GET still returns readable HTML.
 * @param {string} url - absolute URL to retrieve.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<{ statusCode: number, content: string, truncated: boolean }>} the flattened body.
 */
async function fetchRawText(url, signal) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'user-agent': FALLBACK_USER_AGENT, accept: FALLBACK_ACCEPT },
    ...(signal === undefined ? {} : { signal }),
  })
  const contentType = response.headers.get('content-type') ?? ''
  const mime = contentType.split(';')[0].trim().toLowerCase()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${mime.length > 0 ? `（${mime}）` : ''}`)
  }
  if (mime.length > 0 && !TEXTUAL_CONTENT_TYPE.test(contentType)) {
    throw new Error(`非文本类型（${mime}）`)
  }
  const bytes = await response.arrayBuffer()
  const charsetMatch = /charset\s*=\s*"?([^";\s]+)"?/iu.exec(contentType)
  let raw
  try {
    raw = new TextDecoder(charsetMatch === null ? 'utf-8' : charsetMatch[1], { fatal: false }).decode(bytes)
  } catch {
    raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
  const text = htmlToText(raw)
  if (text.length === 0) throw new Error('响应正文为空')
  const content = text.slice(0, TRUNCATE_AT_CHARS)
  return { statusCode: response.status, content, truncated: content.length >= TRUNCATE_AT_CHARS }
}

/**
 * Retrieve one URL for the `web` seam in two tiers: AnySearch extract (markdown),
 * then a direct desktop-style GET flattened to plain text. Both failures are
 * reported together so the caller sees why the page is unobtainable.
 * @param {unknown} request - the seam's `WebFetchRequest`.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'text', content: string }, truncated: boolean }>} normalized result.
 */
async function fetchUrl(request, signal) {
  const url = request !== null && typeof request === 'object' ? /** @type {Record<string, unknown>} */ (request).url : undefined
  if (typeof url !== 'string' || url.trim().length === 0) throw new Error('AnySearch 抓取：调用方没有给出非空 url')
  const target = url.trim()

  let extractError
  try {
    const { response, data } = await postJson(EXTRACT_ENDPOINT, { url: target }, signal, '抓取')
    const content = typeof data.content === 'string' ? data.content : ''
    if (content.length === 0) throw new Error(`上游成功但没有返回正文（${target}）`)
    return {
      url,
      statusCode: response.status,
      body: { kind: 'text', content },
      truncated: content.length >= TRUNCATE_AT_CHARS,
    }
  } catch (error) {
    if (signal !== undefined && signal.aborted) throw error
    extractError = error
  }

  try {
    const page = await fetchRawText(target, signal)
    return { url, statusCode: page.statusCode, body: { kind: 'text', content: page.content }, truncated: page.truncated }
  } catch (error) {
    if (signal !== undefined && signal.aborted) throw error
    const extractReason = extractError instanceof Error ? extractError.message : String(extractError)
    const fallbackReason = error instanceof Error ? error.message : String(error)
    throw new Error(`AnySearch 抓取两级都失败（${target}）：extract 阶段：${extractReason}；HTTP 兜底：${fallbackReason}`)
  }
}

/**
 * Register both provider halves with the `ctx.web` seam. The seam wraps each
 * registration in the calling fiber's effect, so unloading the plugin
 * unregisters the ids; a duplicate id throws `WEB_DUPLICATE_PROVIDER`.
 *
 * Two config keys, both optional:
 *   - `apiKey`: switch the same code from the anonymous channel to that
 *     account's quota (`Authorization: Bearer`).
 *   - `providerId`: register under a different id, which lets a second entry
 *     load this file as a fresh ESM instance (e.g. `index.mjs?keyed=1`) while
 *     an older instance of the same path is still mounted, without colliding.
 * @param {{ web: { registerSearchProvider: Function, registerFetchProvider: Function } }} ctx - host context.
 * @param {{ apiKey?: string, providerId?: string } | undefined} config - the owning row's config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  if (typeof settings.apiKey === 'string') apiKey = settings.apiKey.trim()
  const requestedId = typeof settings.providerId === 'string' ? settings.providerId.trim() : ''
  const id = requestedId.length > 0 ? requestedId : PROVIDER_ID
  ctx.web.registerSearchProvider({
    id,
    // Selectable with or without a key: anonymous traffic, or the keyed account quota when `apiKey` is set.
    available: () => true,
    search,
  })
  ctx.web.registerFetchProvider({
    id,
    available: () => true,
    fetch: fetchUrl,
  })
}
