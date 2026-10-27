#!/usr/bin/env node
/**
 * scripts/pet-stress.mjs —— 手机语音链路的稳定性压测（不需要麦克风）。
 *
 * 全部走真宿主 HTTP，只打固定的安全会话（默认 session-9918aec4… 队列复现占位）；
 * 用户正在用的桌面会话一律不碰（跨会话那一段只往「不存在的会话」上打，测错误路径并发）。
 *
 * 压测内容：
 *   serial     连发若干轮，每轮要 200/202 + start/delta/final/end
 *   concurrent 同一会话同时发 8 条（等价于用户在手机上连点）
 *   mixed      4 条打真会话 + 4 条打不存在的会话（并发错误路径）
 *   cancel     派发后 150ms 立刻 /api/cancel（快速取消）
 *   interrupt  派发后 250ms 再派一条（新轮挤掉旧轮）
 *   poll       40 个并发轮询/状态请求（App 退化为 poll 时的高频）
 *   reconnect  SSE 连上→派发→中途断线→重连→用 /poll 兜底追到 end
 *
 * 跑法：
 *   node scripts/pet-stress.mjs                    # 默认 all，约 60–90s
 *   node scripts/pet-stress.mjs --only serial,poll  # 只跑某几段
 *   node scripts/pet-stress.mjs --n 8 --write      # 写 docs/pet-stress.md + json
 *
 * 判定：任一段出现 500 / 超时 / 记号残留（/api/state.turns 里还有目标会话）/ end-hold 阶梯 /
 * 流表增长 → 退出码 1，并在表格里标红（✗）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, now, PET_HOME } from './lib/pet-http.mjs'
import { acquireLoadLock } from './lib/pet-load-lock.mjs'
import { resolveOrigin } from './lib/pv-base.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOC_PATH = join(REPO_ROOT, 'docs', 'pet-stress.md')
const JSON_PATH = join(REPO_ROOT, 'docs', 'pet-stress.json')
const TURN_LOG = join(PET_HOME, 'logs', 'turn.log')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const hasFlag = (name) => args.includes(`--${name}`)

// 宿主端口每次启动都可能变，别写死：$PET_BASE → $PV_BASE → host-port.json → 挨个探。
// 探不到就直说，别静默打到死端口上把「测不到」当成「很快」。
// resolveOrigin 已经是「不带 /pet-voice」的宿主根：makeClient / 下面的 API 都会自己拼 /pet-voice，
// 以前这里用 resolvePetBase（带 /pet-voice），拼出来是 /pet-voice/pet-voice/api → 404，
// 又因为兜底逻辑把它报成「目标会话不在 /api/sessions 里」，看着像会话没了，其实是路径错。
const BASE = String(argOf('base', process.env.PET_BASE || (await resolveOrigin()))).replace(/\/$/, '').replace(/\/pet-voice$/, '')
const SESSION = argOf('session', 'session-9918aec4-df16-4fb7-93cb-5608db272a04')
const N = Math.max(2, Number(argOf('n', '8')) || 8)
const ONLY = String(argOf('only', 'all'))
const wants = (name) => ONLY === 'all' || ONLY.split(',').map((x) => x.trim()).includes(name)
const WRITE = hasFlag('write')
const _lock = acquireLoadLock(REPO_ROOT, 'pet-stress')
if (!_lock.ok) process.exit(3)
const MISSING = 'session-00000000-dead-4bad-9bad-000000000000'

const client = makeClient(BASE)
const { getJson, postJson, openSSE, burst } = client

const bare = (id) => String(id ?? '').replace(/^session-/, '')
const textOf = (i) => `压测第${i}条：只回两个字。`

/* ---------------- 记账 ---------------- */

const responses = [] // 每个 HTTP 响应都记：最后统一检查有没有 500 / 连不上
const checks = []
const phases = []

function record(res) {
  responses.push({ path: res.path, status: res.status, ms: res.ms, error: res.body?.error ?? res.body?._raw ?? '' })
  return res
}

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
  return ok
}

/** 并发批次也要进账本：否则最后的「有没有 5xx / 超时」会漏掉整个并发阶段。 */
async function burstRecorded(tasks) {
  return (await burst(tasks)).map(record)
}

async function timed(name, fn) {
  const t0 = now()
  const result = await fn()
  phases.push({ name, ms: Math.round(now() - t0), ...(result ?? {}) })
  return result
}

/* ---------------- 状态探针 ---------------- */

async function stateTurns() {
  const res = record(await getJson('state'))
  const turns = res.body?.turns ?? {}
  return { turns, hasTarget: Object.prototype.hasOwnProperty.call(turns, bare(SESSION)), keys: Object.keys(turns) }
}

async function streamsCount() {
  const res = record(await getJson('diag'))
  const streams = Array.isArray(res.body?.streams) ? res.body.streams.length : -1
  return streams
}

async function dispatchOnce(sessionId, i, requestId) {
  return record(
    await postJson('dispatch', { text: textOf(i), sessionId, requestId: requestId ?? `stress-${Date.now()}-${i}` }, 20_000),
  )
}

/** 等目标会话的 turn 记号消失（App 侧「还在说」的小圆点就该灭）。 */
async function waitSettled(timeoutMs = 15_000) {
  const t0 = now()
  for (;;) {
    const s = await stateTurns()
    if (!s.hasTarget) return { settled: true, ms: Math.round(now() - t0) }
    if (now() - t0 > timeoutMs) return { settled: false, ms: Math.round(now() - t0) }
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * 等目标会话真的空闲（宿主侧 running=false）。
 * 上一轮压测的 reconnect/cancel 段可能留一条还在生成的轮次，紧接着重跑时安全闸会读到
 * running=true —— 那是自己刚点上、正在收尾的轮次，等它落地就行，别硬拦。
 */
async function waitIdle(timeoutMs = 90_000) {
  const t0 = now()
  for (;;) {
    const res = await getJson('sessions?limit=60', 15_000)
    const rows = res.body?.sessions ?? (Array.isArray(res.body?.items) ? res.body.items : [])
    const hit = rows.find((s) => String(s.id ?? '') === SESSION || `session-${String(s.id ?? '')}` === SESSION)
    if (hit && hit.running !== true) return { idle: true, ms: Math.round(now() - t0) }
    if (now() - t0 > timeoutMs) return { idle: false, ms: Math.round(now() - t0) }
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** 等 SSE 流表回落到基线（自己 close 的连接要等宿主收 socket）。 */
async function waitStreamsBack(baseline, timeoutMs = 8_000) {
  const t0 = now()
  for (;;) {
    const count = await streamsCount()
    if (count <= baseline || now() - t0 > timeoutMs) return { count, ms: Math.round(now() - t0) }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** 一轮完整对话：等 start / delta / final / end。 */
async function awaitRound(sse, timeoutMs = 60_000) {
  const start = await sse.waitFrame((f) => f.event === 'start' && (f.data?.origin ?? '') !== 'desktop', timeoutMs)
  const delta = start ? await sse.waitFrame((f) => f.event === 'delta', timeoutMs) : null
  const final = await sse.waitFrame((f) => f.event === 'final', timeoutMs)
  const end = await sse.waitFrame((f) => f.event === 'end', timeoutMs)
  return { start, delta, final, end }
}

const accepted = (res) => res.status === 200 || res.status === 202
const okStatus = (s) => s === 200 || s === 202

/* ---------------- 各段 ---------------- */

async function phaseSerial() {
  await timed('serial', async () => {
    const sse = await openSSE(SESSION)
    const rows = []
    try {
      for (let i = 0; i < N; i += 1) {
        sse.frames.length = 0
        const ack = await dispatchOnce(SESSION, i)
        const frames = accepted(ack) ? await awaitRound(sse) : { start: null, delta: null, final: null, end: null }
        rows.push({
          status: ack.status,
          ackMs: Math.round(ack.ms),
          endMs: frames.end ? Math.round(frames.end.t - (now() - ack.ms)) : null,
          complete: Boolean(frames.start && frames.final && frames.end),
        })
      }
    } finally {
      sse.close()
      sse.abort()
    }
    const bad = rows.filter((r) => !accepted({ status: r.status }) || !r.complete)
    check('serial：每轮 200/202 且 start→final→end 齐全', !bad.length, bad.length ? JSON.stringify(bad.slice(0, 3)) : `${rows.length}/${rows.length} 轮完整`)
    const settle = await waitSettled()
    check('serial：跑完记号清零', settle.settled, settle.settled ? `${settle.ms} ms 内清空` : '15s 后仍有残留')
    return { rounds: rows.length, complete: rows.length - bad.length }
  })
}

async function phaseConcurrent() {
  await timed('concurrent', async () => {
    const sse = await openSSE(SESSION)
    let frames = { start: null, final: null, end: null }
    let statuses = []
    try {
      sse.frames.length = 0
      const tag = `stress-${Date.now()}`
      const results = await burstRecorded(Array.from({ length: N }, (_, i) => () => dispatchOnce(SESSION, 100 + i, `${tag}-${i}`)))
      statuses = results.map((r) => r.status)
      const acceptedAll = results.every(accepted)
      check('concurrent：8 条同时点全部被受理（无 500/超时）', acceptedAll, `status=${statuses.join(',')}`)
      // 同时点这么多，最后一条应当仍然跑起来：至少要看到一轮完整的 start→end
      frames = await awaitRound(sse, 90_000)
      check('concurrent：挤掉旧轮之后最后一轮仍能跑完', Boolean(frames.start && frames.end), frames.end ? '收到 start→end' : '90s 内没等到 end')
      const settle = await waitSettled(20_000)
      check('concurrent：并发后不残留 live 记号', settle.settled, settle.settled ? `${settle.ms} ms 内清空` : '20s 后仍有残留')
    } finally {
      sse.close()
      sse.abort()
    }
    return { statuses }
  })
}

async function phaseMixed() {
  await timed('mixed', async () => {
    const mine = Math.max(1, Math.floor(N / 2))
    const tag = `stress-mix-${Date.now()}`
    const tasks = [
      ...Array.from({ length: mine }, (_, i) => () => dispatchOnce(SESSION, 200 + i, `${tag}-ok-${i}`)),
      ...Array.from({ length: N - mine }, (_, i) => () => dispatchOnce(MISSING, 300 + i, `${tag}-bad-${i}`)),
    ]
    const results = await burstRecorded(tasks)
    const okStatuses = results.slice(0, mine).map((r) => r.status)
    const badStatuses = results.slice(mine).map((r) => r.status)
    check('mixed：真会话并发仍被受理', okStatuses.every(okStatus), `status=${okStatuses.join(',')}`)
    check('mixed：不存在会话返回 404 且不是 500', badStatuses.every((s) => s === 404), `status=${badStatuses.join(',')}`)
    const settle = await waitSettled(20_000)
    check('mixed：错误路径不把记号挂死', settle.settled, settle.settled ? `${settle.ms} ms 内清空` : '20s 后仍有残留')
  })
}

async function phaseCancel() {
  await timed('cancel', async () => {
    const sse = await openSSE(SESSION)
    const rounds = Math.min(4, N)
    try {
      for (let i = 0; i < rounds; i += 1) {
        sse.frames.length = 0
        const ack = await dispatchOnce(SESSION, 400 + i)
        await new Promise((r) => setTimeout(r, 150))
        const cancel = record(await postJson('cancel', { sessionId: SESSION }, 8_000))
        check(`cancel#${i}：派发后被受理且 cancel 回 200`, accepted(ack) && cancel.status === 200, `dispatch=${ack.status} cancel=${cancel.status}`)
      }
    } finally {
      sse.close()
      sse.abort()
    }
    // 取消之后还能立刻再聊：这是「点了就断、断了还能接着说」的关键
    const sse2 = await openSSE(SESSION)
    let after = { end: null }
    try {
      sse2.frames.length = 0
      const ack = await dispatchOnce(SESSION, 450)
      after = await awaitRound(sse2, 60_000)
      check('cancel：取消后仍能完整聊下一轮', accepted(ack) && Boolean(after.end), after.end ? '收到 end' : '60s 内没等到 end')
    } finally {
      sse2.close()
      sse2.abort()
    }
    const settle = await waitSettled(20_000)
    check('cancel：取消后记号清零', settle.settled, settle.settled ? `${settle.ms} ms 内清空` : '20s 后仍有残留')
  })
}

async function phaseInterrupt() {
  await timed('interrupt', async () => {
    const sse = await openSSE(SESSION)
    const rounds = Math.min(4, N)
    const rows = []
    try {
      for (let i = 0; i < rounds; i += 1) {
        sse.frames.length = 0
        const first = await dispatchOnce(SESSION, 500 + i * 2)
        await new Promise((r) => setTimeout(r, 250))
        const second = await dispatchOnce(SESSION, 501 + i * 2)
        const done = await awaitRound(sse, 60_000)
        rows.push({ first: first.status, second: second.status, end: Boolean(done.end) })
      }
    } finally {
      sse.close()
      sse.abort()
    }
    check('interrupt：新轮挤掉旧轮，每次都还能跑完', rows.every((r) => okStatus(r.first) && okStatus(r.second) && r.end), JSON.stringify(rows))
    const settle = await waitSettled(20_000)
    check('interrupt：交替打断后不残留', settle.settled, settle.settled ? `${settle.ms} ms 内清空` : '20s 后仍有残留')
  })
}

async function phasePoll() {
  await timed('poll', async () => {
    const rounds = 40
    // 四种请求分开记账：只看总 max 说不清是 state 慢还是 backlog 拉取慢。
    const kinds = ['poll-backlog', 'state', 'sessions', 'poll-wait']
    const calls = Array.from({ length: rounds }, (_, i) => {
      if (i % 4 === 0) return () => getJson(`poll?sessionId=${encodeURIComponent(SESSION)}&cursor=-1`, 10_000)
      if (i % 4 === 1) return () => getJson('state', 10_000)
      if (i % 4 === 2) return () => getJson('sessions?limit=5', 10_000)
      return () => getJson(`poll?sessionId=${encodeURIComponent(SESSION)}&cursor=0&wait=0`, 10_000)
    })
    const results = await burstRecorded(calls)
    const byKind = {}
    results.forEach((r, i) => {
      const k = kinds[i % 4]
      const ms = Number(r.ms) || 0
      byKind[k] = Math.max(byKind[k] ?? 0, ms)
    })
    const bad = results.filter((r) => r.status !== 200)
    const max = results.reduce((a, r) => Math.max(a, Number(r.ms) || 0), 0)
    const p95 = results.map((r) => Number(r.ms) || 0).sort((a, b) => a - b)[Math.floor(results.length * 0.95)]
    const breakdown = kinds.map((k) => `\`${k}\` ${Math.round(byKind[k] ?? 0)}ms`).join('、')
    check('poll：40 个并发高频请求全部 200', !bad.length, bad.length ? `${bad.length} 个非 200（${bad.slice(0, 3).map((r) => r.status).join(',')}）` : `p95=${Math.round(p95)}ms max=${Math.round(max)}ms（分类 max：${breakdown}）`)
    check('poll：状态/轮询并发下响应不超过 3s', max < 3000, `max=${Math.round(max)}ms`)
  })
}

const phases_poll_snapshot = []

async function phaseReconnect() {
  await timed('reconnect', async () => {
    const sse = await openSSE(SESSION)
    let start = null
    try {
      sse.frames.length = 0
      const ack = await dispatchOnce(SESSION, 600)
      start = accepted(ack) ? await sse.waitFrame((f) => f.event === 'start' && (f.data?.origin ?? '') !== 'desktop', 60_000) : null
      check('reconnect：连上后能收到 start', Boolean(start), start ? '收到 start' : '60s 内没等到 start')
    } finally {
      // 模拟隧道抖动：读到一半把连接掐了
      sse.close()
      sse.abort()
    }
    // 重连 + 轮询兜底：cursor=-1 先对齐，再等新帧
    const align = record(await getJson(`poll?sessionId=${encodeURIComponent(SESSION)}&cursor=-1`, 10_000))
    const cursor = Number(align.body?.cursor ?? 0)
    let end = null
    const t0 = now()
    while (now() - t0 < 60_000) {
      const res = record(await getJson(`poll?sessionId=${encodeURIComponent(SESSION)}&cursor=${cursor}&wait=5000`, 15_000))
      const frames = Array.isArray(res.body?.frames) ? res.body.frames : []
      if (frames.some((f) => f.event === 'end')) {
        end = frames.find((f) => f.event === 'end')
        break
      }
      if (res.body?.done) break
    }
    check('reconnect：断线重连后靠 /poll 能追到 end', Boolean(end), end ? '收到 end' : '60s 内没追到 end')
    const settle = await waitSettled(20_000)
    check('reconnect：断线不留死连接/记号', settle.settled, settle.settled ? `${settle.ms} ms 内清空` : '20s 后仍有残留')
  })
}

/* ---------------- 收尾检查 ---------------- */

function readTurnLogSince(offset) {
  try {
    const size = statSync(TURN_LOG).size
    if (size <= offset) return ''
    const buf = readFileSync(TURN_LOG)
    return buf.slice(offset).toString('utf8')
  } catch {
    return ''
  }
}

function afterChecks({ streamsBefore, logOffset, t0 }) {
  const text = readTurnLogSince(logOffset)
  const lines = text.split('\n').filter(Boolean)
  // turn.log 是全局的：宿主上别的会话（用户桌面轮）也会写 end-hold。只把本次压测会话
  // 的 end-hold 当失败，别的一律当旁证写出来，免得把别人的长轮算到压测头上。
  const sidOf = (l) => (/\bsid=([0-9a-f-]{8,})/.exec(l) ?? [])[1] ?? ''
  const mineOf = (l) => sidOf(l) === '' || sidOf(l) === bare(SESSION)
  const endHoldAll = lines.filter((l) => l.includes('end-hold'))
  const endHold = endHoldAll.filter(mineOf)
  const foreignEndHold = endHoldAll.filter((l) => !mineOf(l))
  const errors = lines.filter((l) => /错误|失败|异常|TypeError|Error:/.test(l) && !/ipc|logcat/.test(l))
  check(
    '日志：压测期间没有 end-hold 阶梯',
    !endHold.length,
    endHold.length
      ? `${endHold.length} 行：${endHold.slice(0, 2).join(' | ').slice(0, 240)}`
      : `turn.log 新增 ${lines.length} 行，本会话 0 个 end-hold${foreignEndHold.length ? `（别的会话 ${foreignEndHold.length} 个，见旁证）` : ''}`,
  )
  check('日志：压测期间没有服务端异常行', !errors.length, errors.length ? errors.slice(0, 2).join(' | ').slice(0, 240) : '无')
  const durationSec = Math.round((now() - t0) / 1000)
  // 只跑 `--only poll` 时本来就不该有派发流水，别把「没派发」当成失败。
  const expectsDispatch = ['serial', 'concurrent', 'mixed', 'cancel', 'interrupt', 'reconnect'].some((p) => wants(p))
  if (expectsDispatch) {
    check('日志：有派发流水（证明压测真的打到了宿主）', lines.some((l) => l.includes('dispatch status=')), `新增 ${lines.length} 行 / ${durationSec}s`)
  } else {
    check('日志：本轮只跑轮询，不派发（跳过派发流水检查）', true, `新增 ${lines.length} 行 / ${durationSec}s`)
  }
  const streams = streamsBefore
  return { logLines: lines.length, endHold: endHold.length, foreignEndHold: foreignEndHold.length, errors: errors.length, streams }
}

function buildReport({ meta, after }) {
  const failed = checks.filter((c) => !c.ok)
  const lines = []
  lines.push('# 宠物语音链路稳定性压测（无麦克风）')
  lines.push('')
  lines.push('由 [`scripts/pet-stress.mjs`](../scripts/pet-stress.mjs) 生成：一条命令复现，不需要真人说话。')
  lines.push('')
  lines.push(`- 生成时间：${meta.at}`)
  lines.push(`- 宿主机：${meta.base}（插件 ${meta.pluginVersion ?? '?'}）`)
  lines.push(`- 压测落点：\`${meta.session}\`；并发 n=${meta.n}；段：${meta.phases}`)
  lines.push(`- 结果：**${failed.length ? `失败 ${failed.length} 项` : '全部通过'}**（${checks.length} 项检查）`)
  lines.push('')
  lines.push('## 检查项')
  lines.push('')
  lines.push('| 检查 | 结果 | 说明 |')
  lines.push('|---|---|---|')
  for (const c of checks) lines.push(`| ${c.name} | ${c.ok ? '✓' : '✗'} | ${String(c.detail).replace(/\|/g, '\\|')} |`)
  lines.push('')
  lines.push('## 各段耗时')
  lines.push('')
  lines.push('| 段 | 耗时 (ms) |')
  lines.push('|---|---|')
  for (const p of phases) lines.push(`| ${p.name} | ${p.ms} |`)
  lines.push('')
  lines.push('## 旁证')
  lines.push('')
  lines.push(`- turn.log 新增 ${after.logLines} 行，本会话 end-hold ${after.endHold} 行，异常 ${after.errors} 行`)
  if (after.foreignEndHold) lines.push(`- 旁证：宿主上其它会话（非本次压测落点）另有 ${after.foreignEndHold} 行 end-hold，未计入失败`)
  lines.push(`- HTTP：${responses.length} 个请求，非 200/202/206 的 ${responses.filter((r) => r.status >= 400 || r.status === 0).length} 个，5xx ${responses.filter((r) => r.status >= 500).length} 个`)
  lines.push('')
  lines.push('## 没折腾的')
  lines.push('')
  lines.push('- 不碰用户桌面会话：跨会话那一段只往「不存在的会话」上打，验证错误路径并发，不验证别的会话跑不跑得动（那要真人桌面会话配合，压测里不制造）。')
  lines.push('- 断网/隧道丢包：本机回环复现不了，断线只模拟为「客户端主动掐 SSE + 轮询兜底」。')
  lines.push('')
  return { markdown: lines.join('\n'), numbers: { at: meta.at, base: meta.base, n: meta.n, checks: checks.length, failed: failed.length, checksList: checks, phases } }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const list = record(await getJson('sessions?limit=60'))
  const sessions = list.body?.sessions ?? (Array.isArray(list.body?.items) ? list.body.items : [])
  const hit = sessions.find((s) => String(s.id ?? '') === SESSION || `session-${String(s.id ?? '')}` === SESSION)
  if (!hit) throw new Error(`目标会话不在 /api/sessions 里：${SESSION}`)
  if (hit.running === true) {
    const idle = await waitIdle(90_000)
    if (!idle.idle) throw new Error(`目标会话一直在跑（running=true 已等 ${Math.round(idle.ms / 1000)}s）：${SESSION}，换一只或等它结束`)
    console.log(`（目标会话正忙，等了 ${Math.round(idle.ms / 1000)}s 收尾；若是别人在用的会话，请换落点）`)
  }

  const state = record(await getJson('state'))
  const t0 = now()
  const logOffset = (() => {
    try {
      return statSync(TURN_LOG).size
    } catch {
      return 0
    }
  })()
  const streamsBefore = await streamsCount()
  const turnsBefore = Object.keys(state.body?.turns ?? {}).length

  const meta = {
    at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    base: BASE,
    pluginVersion: state.body?.pluginVersion ?? null,
    n: N,
    session: SESSION,
    phases: ONLY,
  }
  console.log(`# 压测 ${meta.at} ${BASE} plugin=${meta.pluginVersion} n=${N} only=${ONLY}`)

  const order = [
    ['serial', phaseSerial],
    ['concurrent', phaseConcurrent],
    ['mixed', phaseMixed],
    ['cancel', phaseCancel],
    ['interrupt', phaseInterrupt],
    ['poll', phasePoll],
    ['reconnect', phaseReconnect],
  ]
  for (const [name, fn] of order) {
    if (!wants(name)) continue
    console.log(`· ${name} …`)
    await fn()
  }

  // 结束后统一等一次稳态再查残留
  if (wants('all')) {
    const settle = await waitSettled(20_000)
    check('收尾：全部压测结束后目标会话无残留记号', settle.settled, settle.settled ? `${settle.ms} ms 内清空` : '20s 后仍有残留')
    const streamsAfter = await streamsCount()
    check('收尾：SSE 流表回到压测前的量', streamsAfter <= streamsBefore, `前 ${streamsBefore} → 后 ${streamsAfter}`)
    // 压测只往目标会话和「不存在的会话」派发，别的会话的记号只可能来自桌面端同时在用
    // （跑压测时人往往也在另一个窗口聊天），所以这项只记录、不判失败；真泄漏由
    // 「目标会话无残留」+ 轮次日志里 sid 的 end-hold 梯子来兜。
    const otherTurns = Object.keys((await stateTurns()).turns).length
    check(
      '收尾：其它会话的 live 记号（桌面端同时在用，仅记录）',
      true,
      `前 ${turnsBefore} → 后 ${otherTurns}${otherTurns > turnsBefore ? '；压测不碰这些会话，是桌面端自己的轮次' : ''}`,
    )
  }
  const fiveHundred = responses.filter((r) => r.status >= 500)
  check('HTTP：全程没有 5xx', !fiveHundred.length, fiveHundred.length ? fiveHundred.slice(0, 3).map((r) => `${r.path} ${r.status}`).join(' | ') : `${responses.length} 个请求`)
  const broken = responses.filter((r) => r.status === 0)
  check('HTTP：全程没有超时/连不上', !broken.length, broken.length ? broken.slice(0, 3).map((r) => `${r.path} ${r.error}`).join(' | ') : '0 个')

  const after = afterChecks({ streamsBefore, logOffset, t0 })
  const { markdown, numbers } = buildReport({ meta, after })

  console.log('')
  console.log(markdown.split('\n').filter((l) => l.startsWith('| ') && l.includes('✓') === false).join('\n'))
  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name} —— ${c.detail}`)
  console.log(`\n结果：${failed.length ? `✗ 失败 ${failed.length} 项` : '✓ 全部通过'}（${checks.length} 项）`)

  if (WRITE) {
    mkdirSync(dirname(DOC_PATH), { recursive: true })
    writeFileSync(DOC_PATH, markdown)
    writeFileSync(JSON_PATH, JSON.stringify(numbers, null, 2) + '\n')
    console.log(`已写 ${DOC_PATH}`)
  }
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(`✗ ${error?.message ?? error}`)
  process.exitCode = 1
})
