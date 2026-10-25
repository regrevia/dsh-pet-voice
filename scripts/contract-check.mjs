#!/usr/bin/env node
/**
 * dsh-pet-voice 接口契约冒烟校验（只读）。
 *
 *   PV_BASE=https://127.0.0.1:8443/pet-voice NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *     node scripts/contract-check.mjs
 *
 * 只打 GET：state / tts/voices / tts / poll / pair / stream，外加未鉴权的 401 检查。
 * 绝不调用 dispatch / say / cancel / new —— 避免往用户会话里塞东西。
 * token 只从 ~/.dsh/pet-voice/token 读进内存拼 Cookie，任何时候都不打印。
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 端口每次启动都可能变：PV_BASE / PV_PORT 没给就自己找（带令牌能拿到 ok 的那个）
// 判别用 JSON 而不是状态码：本机别的服务（AirPlay 的 5000、静态站）也会回 200/401
const TOKEN_PATH = join(homedir(), '.dsh', 'pet-voice', 'token')
const SETTINGS_KT = join(process.cwd(), 'android/app/src/main/java/com/whale/pet/Settings.kt')
const NEEDED_KEYS = ['whale', 'genki', 'gentle', 'cool']

let token = ''
try {
  token = readFileSync(TOKEN_PATH, 'utf8').trim()
} catch {
  console.error(`读不到 token：${TOKEN_PATH}（宿主至少启动过一次插件才会生成）`)
  process.exit(2)
}
if (token.length < 16) {
  console.error(`token 太短（${token.length} 字节），疑似损坏：${TOKEN_PATH}`)
  process.exit(2)
}
const cookie = `pkv_${token.slice(0, 8)}=${token}`

async function discoverBase() {
  if (process.env.PV_BASE) return process.env.PV_BASE.replace(/\/$/, '')
  if (process.env.PV_PORT) return `http://127.0.0.1:${process.env.PV_PORT}/pet-voice`
  const ports = new Set([54013, 52356])
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
    for (const line of out.split('\n').slice(1)) {
      const m = line.match(/:(\d+)\s+\S*\s*$/)
      if (m) ports.add(Number(m[1]))
    }
  } catch {}
  for (const port of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/pet-voice/api/update`, { headers: { cookie }, signal: AbortSignal.timeout(2000) })
      if ((await r.text()).includes('"versionCode"')) return `http://127.0.0.1:${port}/pet-voice`
    } catch {}
  }
  return null
}

const BASE = await discoverBase()
if (!BASE) {
  console.error('找不到宿主 /pet-voice：用 PV_BASE 或 PV_PORT 指定，或确认插件已启动')
  process.exit(2)
}
const auth = { cookie, authorization: `Bearer ${token}` }

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` ← ${detail}` : ''}`)
}
const brief = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
const json = async (path, headers) => {
  const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    /* 非 JSON 就留 null */
  }
  return { status: res.status, type: res.headers.get('content-type') || '', body, text }
}

/** POST JSON。只给「验证 chat 回退」这种零副作用的请求用。 */
const postJson = async (path, payload, headers) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual',
  })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    /* 非 JSON 就留 null */
  }
  return { status: res.status, type: res.headers.get('content-type') || '', body, text }
}

/* ---------- 1. 未鉴权必须 401（只用 GET，不会产生副作用） ---------- */
for (const path of ['/api/state', '/api/tts/voices', '/api/poll?cursor=-1', '/api/pair', '/api/say?since=-1']) {
  let got
  try {
    got = await json(path)
  } catch (error) {
    check(`未鉴权 GET ${path} → 401`, false, `请求失败：${error?.message ?? error}`)
    continue
  }
  check(
    `未鉴权 GET ${path} → 401`,
    got.status === 401 && got.body?.ok === false && typeof got.body?.error === 'string',
    `${got.status} ${brief(got.text)}`,
  )
}

/* ---------- 2. /api/state 字段齐全 ---------- */
{
  const state = await json('/api/state', auth)
  const body = state.body ?? {}
  const sessionOk =
    Array.isArray(body.sessions) &&
    body.sessions.every((s) => typeof s?.id === 'string' && s.id.length > 0)
  const projectOk =
    Array.isArray(body.projects) &&
    body.projects.every((p) => typeof p?.id === 'string' && typeof p?.path === 'string')
  const presetOk =
    Array.isArray(body.presets) && body.presets.every((p) => typeof p?.id === 'string')
  check('/api/state → 200', state.status === 200 && body.ok === true, `${state.status} ${brief(state.text)}`)
  check(
    '/api/state 字段齐全（tokenHint/pet/projects/presets/sessions/current/dispatchTarget）',
    typeof body.tokenHint === 'string' &&
      body.tokenHint.length === 8 &&
      typeof body.pet?.name === 'string' &&
      Array.isArray(body.pet?.wakeWords) &&
      projectOk &&
      presetOk &&
      sessionOk &&
      'current' in body &&
      'dispatchTarget' in body,
    brief({
      tokenHint: typeof body.tokenHint === 'string' ? body.tokenHint.length : typeof body.tokenHint,
      pet: body.pet,
      projects: Array.isArray(body.projects),
      presets: Array.isArray(body.presets),
      sessions: body.sessions,
      hasCurrent: 'current' in body,
      hasDispatchTarget: 'dispatchTarget' in body,
    }),
  )
  check('/api/state 不回显完整 token', !state.text.includes(token), 'bod里出现了完整 token')
}

/* ---------- 3. /api/tts/voices 四档 key 与 Settings.kt 一致 ---------- */
let voices = null
{
  voices = await json('/api/tts/voices', auth)
  const presets = voices.body?.presets
  const keys = Array.isArray(presets) ? presets.map((p) => p?.id) : []
  check(
    '/api/tts/voices → 四个档位 key = whale/genki/gentle/cool',
    // 档位会随版本增加（现在多了 sweet/dongbei），只要求四档必备 key 都在
    keys.length >= NEEDED_KEYS.length && NEEDED_KEYS.every((k) => keys.includes(k)),
    brief({ status: voices.status, keys }),
  )
  let ktKeys = null
  try {
    const src = readFileSync(SETTINGS_KT, 'utf8')
    const block = src.slice(src.indexOf('val PRESETS'), src.indexOf(')', src.indexOf('val PRESETS')) + 1)
    ktKeys = [...block.matchAll(/"([a-z]+)"\s+to\s+"/g)].map((m) => m[1])
  } catch (error) {
    ktKeys = null
    check('读 Settings.kt 的 PRESETS', false, `${SETTINGS_KT}：${error?.message ?? error}`)
  }
  if (ktKeys) {
    check(
      'Settings.kt PRESETS 的 key 与服务端完全一致',
      ktKeys.length === 4 && ktKeys.every((k, i) => k === keys[i]),
      brief({ kt: ktKeys, server: keys }),
    )
  }
  const ready = voices.body?.ready === true
  check('/api/tts/voices ready=true（神经语音已装）', ready, brief(voices.body?.hint ?? voices.text))
  check(
    '/api/tts/voices 声明了 defaultPreset 且在白名单内',
    typeof voices.body?.defaultPreset === 'string' &&
      Array.isArray(voices.body?.voices) &&
      voices.body.voices.some((v) => v?.id === voices.body.default),
    brief({ default: voices.body?.default, defaultPreset: voices.body?.defaultPreset }),
  )
}

/* ---------- 4. /api/tts 四档各合成一次（>5000 字节 + audio/*） ---------- */
for (const key of NEEDED_KEYS) {
  const url = `${BASE}/api/tts?preset=${encodeURIComponent(key)}&text=${encodeURIComponent('鲸灵契约自检，听得到吗')}`
  try {
    const res = await fetch(url, { headers: auth })
    const type = res.headers.get('content-type') || ''
    const buf = Buffer.from(await res.arrayBuffer())
    check(
      `/api/tts preset=${key} → audio/* 且 >5000 B`,
      res.status === 200 && type.startsWith('audio/') && buf.length > 5000,
      `${res.status} ${type} ${buf.length}B ${buf.length <= 5000 ? brief(buf.toString('utf8')) : ''}`,
    )
  } catch (error) {
    check(`/api/tts preset=${key} → audio/* 且 >5000 B`, false, `请求失败：${error?.message ?? error}`)
  }
}

/* ---------- 5. /api/poll?cursor=-1 结构可解析 ---------- */
{
  const poll = await json('/api/poll?cursor=-1', auth)
  const body = poll.body ?? {}
  check(
    '/api/poll?cursor=-1 → frames:[] + 数字 cursor + done:false',
    poll.status === 200 &&
      body.ok === true &&
      Array.isArray(body.frames) &&
      body.frames.length === 0 &&
      typeof body.cursor === 'number' &&
      body.done === false,
    `${poll.status} ${brief(poll.text)}`,
  )
  const full = await json('/api/poll?cursor=0&wait=0', auth)
  const frames = full.body?.frames
  check(
    '/api/poll 普通批次结构（frames[].seq/event/data + cursor）',
    full.status === 200 &&
      Array.isArray(frames) &&
      frames.every(
        (f) => typeof f?.seq === 'number' && typeof f?.event === 'string' && 'data' in f,
      ) &&
      typeof full.body?.cursor === 'number',
    `${full.status} ${brief(full.text)}`,
  )
}

/* ---------- 6. /api/pair 结构 + 不泄漏 ?k= ---------- */
{
  const pair = await json('/api/pair', auth)
  const body = pair.body ?? {}
  const tri = ['tunnel', 'lan', 'local'].includes(body.source)
  check(
    '/api/pair → publicBase + source 三档之一 + 无 token',
    pair.status === 200 &&
      body.ok === true &&
      typeof body.publicBase === 'string' &&
      body.publicBase.endsWith('/') &&
      tri &&
      !pair.text.includes(token),
    `${pair.status} ${brief(pair.text)}`,
  )
  if (body.source === 'tunnel') {
    check(
      '/api/pair 隧道档带 alive:boolean，隧道记录里的 k= 已脱敏',
      typeof body.alive === 'boolean' && !/k=(?!<已省略>)/.test(pair.text),
      brief(pair.text),
    )
  } else {
    check(`/api/pair source=${body.source}（没有隧道记录，跳过 alive 断言）`, true)
  }
}

/* ---------- 7. /api/stream 能收到 hello 帧 ---------- */
{
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  let ok = false
  let head = ''
  try {
    const res = await fetch(`${BASE}/api/stream`, { headers: auth, signal: controller.signal })
    const type = res.headers.get('content-type') || ''
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    while (head.length < 4096) {
      const { value, done } = await reader.read()
      if (done) break
      head += decoder.decode(value, { stream: true })
      if (head.includes('event: hello') && head.includes('data: {"sessionId"')) break
    }
    ok = type.startsWith('text/event-stream') && head.includes('event: hello')
    try {
      await reader.cancel()
    } catch {
      /* 已取消 */
    }
  } catch (error) {
    if (!ok) head += ` / ${error?.name ?? ''} ${error?.message ?? error}`
  } finally {
    clearTimeout(timer)
  }
  check('/api/stream → text/event-stream 且首帧是 hello', ok, brief(head))
}

/* ---------- 8. /api/workspaces 结构 + 不泄漏 token ---------- */
{
  const ws = await json('/api/workspaces', auth)
  const body = ws.body ?? {}
  const rows = Array.isArray(body.workspaces) ? body.workspaces : []
  const shapeOk = rows.every(
    (w) =>
      typeof w?.id === 'string' &&
      typeof w?.title === 'string' &&
      typeof w?.path === 'string' &&
      typeof w?.pinned === 'boolean',
  )
  const pinnedOk =
    (body.pinned === null ||
      (typeof body.pinned?.title === 'string' &&
        typeof body.pinned?.id === 'string' &&
        typeof body.pinned?.sessionId === 'string')) &&
    rows.filter((w) => w.pinned === true).length <= 1
  check(
    '/api/workspaces → {ok,workspaces[].{id,title,path,pinned},pinned{title,id,sessionId}}，无 token',
    ws.status === 200 &&
      body.ok === true &&
      rows.length > 0 &&
      shapeOk &&
      pinnedOk &&
      !ws.text.includes(token) &&
      !/sessions/i.test(ws.text),
    `${ws.status} ${brief(ws.text)}`,
  )
  const unauth = await json('/api/workspaces')
  check('未鉴权 GET /api/workspaces → 401', unauth.status === 401, `${unauth.status} ${brief(unauth.text)}`)
}

/* ---------- 9. /api/command 闲聊回退 chat（零副作用） ---------- */
{
  const before = await json('/api/poll?cursor=-1', auth)
  const cmd = await postJson('/api/command', { text: '今天天气不错' }, auth)
  const after = await json('/api/poll?cursor=-1', auth)
  const body = cmd.body ?? {}
  const untouched =
    (before.body?.cursor ?? -1) === (after.body?.cursor ?? -2) &&
    JSON.stringify(before.body?.frames ?? []) === JSON.stringify(after.body?.frames ?? [])
  check(
    '/api/command {text:"今天天气不错"} → action:chat + say:null，且不产生任何帧',
    cmd.status === 200 &&
      body.ok === true &&
      body.action === 'chat' &&
      body.say === null &&
      untouched &&
      !('sessionId' in body) &&
      !('title' in body),
    `${cmd.status} ${brief(cmd.text)}`,
  )
  const unauth = await postJson('/api/command', { text: '今天天气不错' })
  check('未鉴权 POST /api/command → 401', unauth.status === 401, `${unauth.status} ${brief(unauth.text)}`)
}

/* ---------- 汇总 ---------- */
const passed = results.filter((r) => r.ok).length
console.log(`\n通过 ${passed}/${results.length}`)
if (passed !== results.length) {
  for (const r of results.filter((x) => !x.ok)) console.log(`失败：${r.name} ← ${r.detail ?? ''}`)
  process.exit(1)
}
