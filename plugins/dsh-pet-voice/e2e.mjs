#!/usr/bin/env node
/**
 * dsh-pet-voice 端到端验收脚本（不需要浏览器，不需要 App 里的任何东西）。
 *
 * 它模拟手机端做的四件事，全部走真实 HTTP：
 *   1. GET  /pet-voice/api/state            —— 拿到项目/人设列表（不要回显 token）
 *   2. POST /pet-voice/api/new              —— 在指定项目下开（或复用）一个会话
 *   3. GET  /pet-voice/api/stream?sessionId —— 订阅助理增量（SSE）
 *   4. POST /pet-voice/api/dispatch         —— 发一句话，等帧
 *
 * 验收标准：至少收到一帧 `delta` 或 `final`，且 firstDeltaMs 有值。
 *
 * 用法（默认打本机 58686，token 从 ~/.dsh/pet-voice/token 读，不打印）：
 *   node plugins/dsh-pet-voice/e2e.mjs
 *   BASE=https://xxx.trycloudflare.com node plugins/dsh-pet-voice/e2e.mjs
 *   BASE=http://127.0.0.1:58686 PV_TOKEN=<48位> node plugins/dsh-pet-voice/e2e.mjs
 *   node plugins/dsh-pet-voice/e2e.mjs --transport poll   # 长轮询通道也验一遍
 *
 * 退出码：0 通过 / 1 失败。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.env.BASE || 'http://127.0.0.1:58686').replace(/\/+$/, '')
const TOKEN =
  process.env.PV_TOKEN || readFileSync(join(homedir(), '.dsh', 'pet-voice', 'token'), 'utf8').trim()
const TRANSPORT = process.argv.includes('--transport')
  ? process.argv[process.argv.indexOf('--transport') + 1]
  : 'auto'
const PROJECT_TITLE = process.env.PV_PROJECT || 'Pet'
const TEXT = process.env.PV_TEXT || '只回复这四个字：鲸灵在线'
const STREAM_TIMEOUT_MS = Number(process.env.PV_TIMEOUT || 90_000)

const cookie = `pkv_${TOKEN.slice(0, 8)}=${TOKEN}`
const H = { cookie, 'content-type': 'application/json' }

const t0 = Date.now()
const at = () => Date.now() - t0
const log = (...a) => console.log(`[+${at()}ms]`, ...a)

function fail(msg) {
  console.error(`\nFAIL: ${msg}`)
  process.exit(1)
}

const frames = []

/* ---------- 1. state ---------- */
const stateRes = await fetch(`${BASE}/pet-voice/api/state`, { headers: H })
if (stateRes.status !== 200) fail(`/api/state HTTP ${stateRes.status}（cookie 无效？token 被换过？）`)
const state = await stateRes.json()
if (state.token) fail('/api/state 泄漏了完整 token（只应给 tokenHint）')
const pet = state.projects.find((p) => p.title === PROJECT_TITLE) ?? state.projects[0]
if (!pet) fail('没有可用的项目（workspace）')
log(`state ok：${state.projects.length} 个项目 / ${state.presets?.length ?? 0} 个人设 / tokenHint=${state.tokenHint}`)

/* ---------- 2. new ---------- */
const created = await (
  await fetch(`${BASE}/pet-voice/api/new`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ workspaceId: pet.id }),
  })
).json()
if (!created.ok || !created.sessionId) fail(`/api/new 失败：${JSON.stringify(created).slice(0, 300)}`)
const sid = created.sessionId
log(`new → ${sid} (reused=${created.reused}, ${created.title ?? ''})`)

/* ---------- 3. 订阅（SSE 优先，隧道缓冲时自动切长轮询） ---------- */
const ac = new AbortController()
const sseAc = new AbortController()
const killer = setTimeout(() => ac.abort(), STREAM_TIMEOUT_MS)
let transportUsed = TRANSPORT
let firstFrame
const firstFrameSeen = new Promise((r) => {
  firstFrame = r
})

let stopping = false
function onFrame(ev, data, when) {
  frames.push({ ev, data: typeof data === 'string' ? data : JSON.stringify(data), at: when ?? at() })
  log('frame', ev, String(data).slice(0, 120))
  firstFrame()
  // 收到 final/end 就收工：通道是长连接，不收就永远等下去
  if (!stopping && (ev === 'final' || ev === 'end')) {
    stopping = true
    setTimeout(() => {
      ac.abort()
      sseAc.abort()
    }, 400)
  }
}

async function runSSE(controller) {
  let res
  try {
    res = await fetch(`${BASE}/pet-voice/api/stream?sessionId=${encodeURIComponent(sid)}`, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name !== 'AbortError') log('stream open failed', err.message)
    return
  }
  log(`stream status ${res.status} ${res.headers.get('content-type')}`)
  if (res.status !== 200) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 2)
        for (const line of raw.split('\n')) {
          if (!line.startsWith('event: ')) continue
          const ev = line.slice(7)
          const data = /^data: (.*)$/m.exec(raw)?.[1] ?? ''
          onFrame(ev, data)
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') log('stream closed', err.message)
  }
}

async function runPoll() {
  let cursor = 0
  for (;;) {
    let data
    try {
      const res = await fetch(
        `${BASE}/pet-voice/api/poll?sessionId=${encodeURIComponent(sid)}&cursor=${cursor}&wait=8000`,
        { headers: { cookie }, signal: ac.signal },
      )
      data = await res.json()
    } catch (err) {
      if (err.name === 'AbortError') return
      log('poll error', err.message)
      return
    }
    for (const f of data.frames ?? []) {
      onFrame(f.event, f.data, at())
    }
    if (data.cursor) cursor = Math.max(cursor, data.cursor)
    if (data.done) return
  }
}

let streamDone = TRANSPORT === 'poll' ? runPoll() : runSSE(sseAc)

/* ---------- 4. dispatch ---------- */
await new Promise((r) => setTimeout(r, 300))
const disp = await fetch(`${BASE}/pet-voice/api/dispatch`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ text: TEXT, sessionId: sid }),
})
const dispBody = await disp.text()
log('dispatch', disp.status, dispBody.slice(0, 200))
if (disp.status !== 200) fail(`/api/dispatch HTTP ${disp.status}`)

if (TRANSPORT === 'auto') {
  const verdict = await Promise.race([
    firstFrameSeen.then(() => 'frame'),
    new Promise((r) => setTimeout(() => r('timeout'), 4000)),
  ])
  if (verdict === 'timeout') {
    log('SSE 4 秒 0 帧 → 隧道把串流缓冲住了，切长轮询')
    sseAc.abort()
    transportUsed = 'poll(auto)'
    streamDone = runPoll()
  } else {
    transportUsed = 'sse'
  }
}

await streamDone
clearTimeout(killer)

/* ---------- 判定 ---------- */
const deltas = frames.filter((f) => f.ev === 'delta')
const final = frames.find((f) => f.ev === 'final')
const firstDeltaMs = deltas[0]?.at ?? null
const summary = {
  base: BASE,
  transport: transportUsed,
  sessionId: sid,
  frames: frames.length,
  deltas: deltas.length,
  firstDeltaMs,
  final: final?.data?.slice(0, 200) ?? null,
  kinds: [...new Set(frames.map((f) => f.ev))],
}
console.log('\nSUMMARY ' + JSON.stringify(summary, null, 2))

if (!frames.length) fail('0 帧：SSE/轮询通道没通（公网隧道常见，试 --transport poll）')
if (!deltas.length && !final) fail('没有 delta 也没有 final：宿主事件没映射上')
if (firstDeltaMs == null) fail('firstDeltaMs 为空')

log(`OK：${deltas.length} 个 delta，首字 ${firstDeltaMs}ms${final ? '，兜底 final 也到了' : ''}`)
process.exit(0)
