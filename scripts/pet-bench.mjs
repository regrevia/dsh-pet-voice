#!/usr/bin/env node
/**
 * scripts/pet-bench.mjs —— 「没有真人麦克风」也能复现的端到端延迟基准。
 *
 * 三条路径全部走真宿主 HTTP（不需要 DSH 内部对象）：
 *   ASR  ：POST /pet-voice/api/asr（body = 预录 wav 原始字节）→ 要「请求→文字」
 *   文本 ：POST /pet-voice/api/dispatch + 同会话 SSE → 要「受理→start / 首个 delta / final / end」
 *   TTS  ：GET /pet-voice/api/tts?text=… → 要首字节（流式 / 文件缓存两种）
 *
 * 跑法（宿主在跑、token 已配对）：
 *   node scripts/pet-bench.mjs                     # 默认 n=10，跑完打印表格
 *   node scripts/pet-bench.mjs --n 5 --write       # 同时写 docs/pet-bench.md
 *   node scripts/pet-bench.mjs --strict            # 与上次结果偏差超过噪声带就退出码 1
 *
 * 约定：
 *   - token 只读 ~/.dsh/pet-voice/token，绝不打印（也不进 markdown）；
 *   - 设备头从本机 devices.json 里挑一个**已注册**的 id：不占新名额、不触发 429；
 *   - 派发只落固定会话（默认 session-9918aec4… 队列复现占位），跑前用 /api/sessions
 *     确认它存在且不在跑，绝不碰用户正在用的会话；
 *   - 每轮派发都换 requestId，避免 120s 去重把第二轮变成 deduped。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLoadLock } from './lib/pet-load-lock.mjs'
import { resolveOrigin } from './lib/pv-base.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PET_HOME = join(homedir(), '.dsh', 'pet-voice')
const TOKEN_PATH = join(PET_HOME, 'token')
const DEVICES_PATH = join(PET_HOME, 'devices.json')
const ASR_SAMPLE = join(REPO_ROOT, 'bench', 'asr-latency', 'samples', 's4_mid_xiayibu.wav')
const DOC_PATH = join(REPO_ROOT, 'docs', 'pet-bench.md')
const JSON_PATH = join(REPO_ROOT, 'docs', 'pet-bench.json')

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
const API = `${BASE}/pet-voice/api`
const N = Math.max(1, Number(argOf('n', '10')) || 10)
const SESSION = argOf('session', 'session-9918aec4-df16-4fb7-93cb-5608db272a04')
/** 会话 id 归一：宿主两种写法（session-<uuid> / <uuid>）都当同一个。 */
const bare = (id) => String(id ?? '').replace(/^session-/, '')
const SAMPLE = argOf('asr-sample', ASR_SAMPLE)
const TEXT = argOf('text', '用五个字回我：基准测试通过。')
const WRITE = hasFlag('write')
const STRICT = hasFlag('strict')
const _lock = acquireLoadLock(REPO_ROOT, 'pet-bench')
if (!_lock.ok) process.exit(3)
// 只跑某几段量噪声：`--only asr` / `--only text` / `--only asr,tts`
const ONLY = String(argOf('only', 'all'))
const wants = (name) => ONLY === 'all' || ONLY.split(',').map((x) => x.trim()).includes(name)
const TTS_SENTENCE = '基准脚本这一句用来量首字节时间。'
// 重跑的噪声带（唯一来源：既用来判漂移，也写进 markdown 说明里，免得文档和代码两套数）。
// ASR 是纯 CPU whisper，delta/final/end 之后是远端模型在生成：机器上有人跑就会整档漂。
// ack/signal 是宿主自己发回执，稳；合成也有进程启动抖动。
const TOL = { asrWall: 40, asrServer: 40, ack: 20, signal: 20, delta: 45, final: 45, end: 45, ttsSynth: 25, ttsCache: 60 }
// 毫秒级指标按百分比判会过敏（1 ms→3 ms 就是 +200%），差不到这个绝对值不算漂。
const ABS_FLOOR = { ttsCache: 10 }
// 每次跑换一个「新句子」量真合成：文本唯一 → 缓存必 miss，量到的才是边合成边出的首字节，
// 不然第二次跑全命中缓存，数字会掉到 1ms，看着像优化了、其实啥也没量到。
const RUN_TAG = String(Date.now()).slice(-6)

/* ---------------- 基础工具 ---------------- */

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000 // ms，小数

function token() {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim()
  } catch {
    throw new Error(`读不到 token：${TOKEN_PATH}（先在插件页配对一次）`)
  }
}

/** 已注册设备 id：不占新名额。没有 devices.json 就用 env 指定。 */
function deviceId() {
  if (process.env.PET_DEVICE_ID) return process.env.PET_DEVICE_ID
  try {
    const raw = JSON.parse(readFileSync(DEVICES_PATH, 'utf8'))
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.devices) ? raw.devices : Object.keys(raw ?? {})
    const id = list.map((d) => (typeof d === 'string' ? d : d?.id)).find((x) => /^[0-9a-f]{8,}$/i.test(String(x ?? '')))
    if (id) return String(id)
  } catch {
    /* 落到下面的报错 */
  }
  throw new Error('没有已注册设备 id：设 PET_DEVICE_ID，或先在 App 里配对一台')
}

const TOKEN = token()
const DEVICE = deviceId()
const HEADERS = { authorization: `Bearer ${TOKEN}`, 'x-pet-device-id': DEVICE, accept: 'application/json' }

async function getJson(path, timeoutMs = 15_000) {
  return requestJson(path, { method: 'GET' }, timeoutMs)
}

async function requestJson(path, init = {}, timeoutMs = 15_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = now()
  try {
    const res = await fetch(`${API}/${path}`, { ...init, headers: { ...HEADERS, ...(init.headers ?? {}) }, signal: ctrl.signal })
    const text = await res.text()
    const ms = now() - t0
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = { _raw: text.slice(0, 200) }
    }
    return { status: res.status, headers: res.headers, body, ms }
  } finally {
    clearTimeout(timer)
  }
}

/** 最近秩 p95 / 中位数（毫秒，保留 1 位小数）。 */
function stats(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return { n: 0, median: NaN, p95: NaN, min: NaN, max: NaN }
  const at = (q) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))]
  return {
    n: xs.length,
    median: Math.round(at(0.5) * 10) / 10,
    p95: Math.round(at(0.95) * 10) / 10,
    min: Math.round(xs[0] * 10) / 10,
    max: Math.round(xs[xs.length - 1] * 10) / 10,
  }
}

/* ---------------- SSE：按到达时刻记帧 ---------------- */

class SSE {
  constructor(res) {
    this.res = res
    this.reader = res.body.getReader()
    this.decoder = new TextDecoder()
    this.buf = ''
    this.frames = []
    this.waiters = []
    this.closed = false
    this._pump()
  }

  async _pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read()
        if (done) break
        this._feed(this.decoder.decode(value, { stream: true }))
      }
    } catch {
      /* abort / 网络断：当结束处理 */
    } finally {
      this.closed = true
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer)
        w.resolve(null)
      }
    }
  }

  _feed(text) {
    this.buf += text
    for (;;) {
      const idx = this.buf.indexOf('\n\n')
      if (idx < 0) return
      const raw = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      let event = ''
      let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!event) continue
      let parsed = null
      try {
        parsed = data ? JSON.parse(data) : {}
      } catch {
        parsed = { _raw: data }
      }
      const frame = { event, data: parsed, t: now() }
      this.frames.push(frame)
      for (const w of this.waiters.slice()) {
        if (!w.done && w.pred(frame)) {
          w.done = true
          clearTimeout(w.timer)
          this.waiters.splice(this.waiters.indexOf(w), 1)
          w.resolve(frame)
        }
      }
    }
  }

  waitFrame(pred, timeoutMs) {
    const hit = this.frames.find((f) => pred(f))
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve) => {
      const w = { pred, resolve, done: false, timer: null }
      w.timer = setTimeout(() => {
        w.done = true
        this.waiters.splice(this.waiters.indexOf(w), 1)
        resolve(null)
      }, timeoutMs)
      this.waiters.push(w)
    })
  }

  close() {
    // body 被 reader 锁着：只取消 reader，别去 cancel res.body（会 ERR_INVALID_STATE）
    this.reader.cancel?.().catch?.(() => {})
  }
}

async function openSSE(sessionId) {
  const ctrl = new AbortController()
  const url = `${API}/stream?sessionId=${encodeURIComponent(sessionId)}`
  const res = await fetch(url, { headers: { ...HEADERS, accept: 'text/event-stream' }, signal: ctrl.signal })
  if (res.status !== 200) throw new Error(`SSE 连不上：HTTP ${res.status}`)
  const sse = new SSE(res)
  sse.abort = () => ctrl.abort()
  return sse
}

/* ---------------- 三条路径 ---------------- */

async function benchAsr() {
  if (!existsSync(SAMPLE)) throw new Error(`找不到 wav：${SAMPLE}`)
  const wav = readFileSync(SAMPLE)
  const probe = await getJson('asr')
  const wasRunning = probe.body?.running === true
  // worker 会**静默**退回 CPU whisper（仓库名错、权重缺失都这样），只报 ready:true 时
  // 下面的 1.2s 会被当成中位写进表。所以先读一次后端，不是 mlx 就明说。
  const backend = String(probe.body?.backend ?? '')
  const device = String(probe.body?.device ?? '')
  const slow = probe.body?.slow === true
  if (backend && backend !== 'mlx-whisper') {
    const msg = `ASR 后端是 ${backend}${device ? `/${device}` : ''}${slow ? '（slow:true）' : ''}，不是 mlx-whisper：下面的数字是 CPU 回退态，别当中位写进表（查 worker.log）`
    if (STRICT) throw new Error(msg)
    console.warn(`⚠ ${msg}`)
  }
  const rows = []
  // 预热一轮不计入：首轮常带连接/线程池冷身，算进去就是一个假的尖峰。
  await requestJson('asr', { method: 'POST', body: wav, headers: { 'content-type': 'audio/wav' } }, 120_000)
  for (let i = 0; i < N; i += 1) {
    const r = await requestJson('asr', { method: 'POST', body: wav, headers: { 'content-type': 'audio/wav' } }, 120_000)
    rows.push({ wall: r.ms, server: Number(r.headers.get('x-asr-ms') ?? 0) || null, ok: r.status === 200 && r.body?.ok !== false, text: String(r.body?.text ?? ''), status: r.status })
  }
  return { wasRunning, bytes: wav.length, rows, backend, device, slow }
}

async function benchDispatch() {
  const rows = []
  const sse = await openSSE(SESSION)
  try {
    for (let i = 0; i < N; i += 1) {
      // 上一轮的 end 已经等到，这里再清一次残留帧（心跳/旁听帧不算）
      sse.frames.length = 0
      const rid = `bench-${Date.now()}-${i}`
      const t0 = now()
      const r = await requestJson('dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: TEXT, sessionId: SESSION, requestId: rid }),
      }, 20_000)
      const tAck = now()
      // SSE 会同时收到别的会话的事件（`*` 广播，桌面端在别的会话里聊天就会串进来），
      // 所以每类帧都必须按 sessionId 认领自己那一轮，只看 event 名会把别人的 delta 算成自己的。
      const mine = (event) => (f) =>
        f.event === event &&
        bare(f.data?.sessionId) === bare(SESSION) &&
        (f.data?.origin ?? '') !== 'desktop'
      const start = await sse.waitFrame(mine('start'), 90_000)
      const delta = start ? await sse.waitFrame(mine('delta'), 90_000) : null
      const final = await sse.waitFrame(mine('final'), 120_000)
      const end = final ? await sse.waitFrame(mine('end'), 120_000) : null
      rows.push({
        status: r.status,
        queued: Boolean(r.body?.queued),
        ack: tAck - t0,
        start: start ? start.t - t0 : NaN,
        delta: delta ? delta.t - t0 : NaN,
        final: final ? final.t - t0 : NaN,
        end: end ? end.t - t0 : NaN,
        chars: String(final?.data?.text ?? '').length,
      })
      if (!end) break // 一轮没等到 end：别把后面的轮次全拖死
    }
  } finally {
    sse.close()
    sse.abort()
  }
  return rows
}

/** 读第一块 body 的时间 = 首字节；顺便把剩下读完（中途 cancel 会让服务端写不成缓存）。 */
async function ttfb(url) {
  const t0 = now()
  const res = await fetch(url, { headers: HEADERS })
  const reader = res.body.getReader()
  const first = await reader.read()
  const ms = now() - t0
  let bytes = first.done ? 0 : first.value?.byteLength ?? 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value?.byteLength ?? 0
  }
  return { ms, status: res.status, cache: res.headers.get('x-tts-cache') ?? '', bytes }
}

async function benchTts() {
  const reps = Math.max(2, Math.min(N, 6))
  // ① 真合成：每轮一句没出现过的话（时长相近），逼它走 stream.py 现合成
  const synthRows = []
  for (let i = 0; i < reps; i += 1) {
    const q = encodeURIComponent(`基准${RUN_TAG}第${i}号这一句用来量首字节时间。`)
    synthRows.push(await ttfb(`${API}/tts?text=${q}&stream=1`))
  }
  // ② 文件缓存：固定一句，先非流式取一次（写缓存），之后量命中
  const q = encodeURIComponent(TTS_SENTENCE)
  const warm = await ttfb(`${API}/tts?text=${q}`)
  const cacheRows = []
  for (let i = 0; i < reps; i += 1) {
    cacheRows.push(await ttfb(`${API}/tts?text=${q}`))
  }
  return { synthRows, warm, cacheRows }
}

/* ---------------- 汇总 / 表格 ---------------- */

const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '—')

function buildReport(result) {
  const { asr, dispatch, tts, meta } = result
  const asrWall = stats(asr.rows.map((r) => r.wall))
  const asrSrv = stats(asr.rows.map((r) => r.server).filter(Boolean))
  const ack = stats(dispatch.map((r) => r.ack))
  const start = stats(dispatch.map((r) => r.start))
  // 手机感知的「第一个信号」：SSE 首帧和 POST 200 谁先到算谁。两者常常几乎同时，
  // 中间的先后由宿主事件循环决定（同一轮里 start 可能先于 200 回执），单看任一条
  // 都会在两个模式间跳变，跑两遍差 50%~90%，看着像回归其实只是调度先后。
  const signal = stats(dispatch.map((r) => Math.min(r.ack, r.start)))
  const delta = stats(dispatch.map((r) => r.delta))
  const final = stats(dispatch.map((r) => r.final))
  const end = stats(dispatch.map((r) => r.end))
  const synth = stats(tts.synthRows.map((r) => r.ms))
  const cache = stats(tts.cacheRows.map((r) => r.ms))

  const lines = []
  lines.push('# 宠物语音链路延迟基准（无麦克风）')
  lines.push('')
  lines.push('由 [`scripts/pet-bench.mjs`](../scripts/pet-bench.mjs) 生成：一条命令重跑，不需要真人对着麦克风说话。')
  lines.push(
    `数字全部走真宿主 HTTP（本机回环）；重跑偏差按噪声带判：ASR ${TOL.asrWall}%、模型侧 \`delta\`/\`final\`/\`end\` ${TOL.delta}%、合成 ${TOL.ttsSynth}%、缓存命中 ${TOL.ttsCache}%（绝对差 <${ABS_FLOOR.ttsCache} ms 不算）、其余 ${TOL.ack}% —— 机器上还有别人在跑，whisper 是纯 CPU、\`delta\` 之后是远端模型在生成，收紧只会把噪声当回归。`,
  )
  lines.push('')
  lines.push(`- 生成时间：${meta.at}`)
  lines.push(`- 宿主机：${meta.base}（插件 ${meta.pluginVersion ?? '?'}）`)
  lines.push(`- 轮次：n=${N}；ASR 样本 \`${meta.sample}\`（${meta.sampleBytes} B）；派发落点 \`${meta.session}\``)
  lines.push(`- ASR worker 开跑前${asr.wasRunning ? '已在跑（量为热路径）' : '**没在跑**：第一轮含冷启动'}；后端 \`${asr.backend || '未知'}\`${asr.device ? ` / ${asr.device}` : ''}${asr.slow ? '（**slow:true，CPU 回退态**）' : ''}`)
  lines.push('')
  lines.push('## 结果')
  lines.push('')
  lines.push('| 路径 | 指标 | 中位 (ms) | p95 (ms) | min | max | n |')
  lines.push('|---|---|---|---|---|---|---|')
  const row = (path, label, s) => lines.push(`| ${path} | ${label} | ${fmt(s.median)} | ${fmt(s.p95)} | ${fmt(s.min)} | ${fmt(s.max)} | ${s.n} |`)
  row('ASR', '请求 → 文字（墙钟）', asrWall)
  if (asrSrv.n) row('ASR', 'worker 自报识别耗时', asrSrv)
  row('文本', '首个信号（首帧 / 200 先到者）', signal)
  row('文本', '受理 200（ack）', ack)
  row('文本', '受理 → 首个 `start`', start)
  row('文本', '受理 → 首个 `delta`', delta)
  row('文本', '受理 → `final`', final)
  row('文本', '受理 → `end`', end)
  row('TTS', '首字节（新句真合成，`?stream=1`）', synth)
  row('TTS', '首字节（文件缓存命中）', cache)
  lines.push('')
  const missCount = tts.cacheRows.filter((r) => r.cache !== 'hit').length
  const synthMiss = tts.synthRows.filter((r) => r.cache !== 'hit').length
  lines.push(`> TTS 缓存：新句 ${tts.synthRows.length} 次 miss ${synthMiss} 次（应是全部）；固定句首次 ${tts.warm.cache || '?'} ${fmt(tts.warm.ms)} ms，随后 ${tts.cacheRows.length} 次里 ${tts.cacheRows.length - missCount} 次 \`x-tts-cache: hit\`。`)
  lines.push('')
  lines.push('## 说明')
  lines.push('')
  lines.push('- `start`/`delta`/`final`/`end` 都是相对**同一次 POST 发出前**的墙钟，SSE 帧按到达时刻记，不含客户端渲染。')
  lines.push('- 「首个信号」= min(SSE 首帧, HTTP 200)：这才是手机能开始动作的时刻；`ack` 与 `start` 单看会在两种调度先后之间跳变（同一次跑里能差 300ms 以上），不宜当回归指标。')
  lines.push('- 文本路径是**真派发一轮**（会跑模型、花 token）；只落固定的安全会话，不含用户会话。')
  lines.push('- ASR 冷启动单列：worker 没在跑时 `/api/asr` 的 `running=false`，第一轮会把它拉起来（十几秒量级）；本机 worker 常驻时量到的都是热路径。')
  lines.push('- TTS 两行是两种事：新句走 stream.py 现合成（量首字节），固定句量缓存命中；后者 1ms 是预期。')
  lines.push('- 复现：`node scripts/pet-bench.mjs --n ' + N + ' --write`（宿主端口变了就加 `--base http://127.0.0.1:<port>`）。')
  lines.push('')
  lines.push('> 本文件整篇由脚本生成，`--write` 会覆盖。更细的 ASR / TTS 脚本级基准（冷启动、后端对比、mlx 根因）在 [`docs/pet-bench-asr.md`](pet-bench-asr.md)，那一份不归脚本管。')
  lines.push('')
  return {
    markdown: lines.join('\n'),
    numbers: {
      generator: 'scripts/pet-bench.mjs',
      at: meta.at,
      base: meta.base,
      n: N,
      asrWall: asrWall.median,
      asrServer: asrSrv.median,
      ack: ack.median,
      signal: signal.median,
      start: start.median,
      delta: delta.median,
      final: final.median,
      end: end.median,
      ttsSynth: synth.median,
      ttsCache: cache.median,
    },
  }
}

function compareWithPrevious(numbers) {
  if (!existsSync(JSON_PATH)) return { diffs: [], previous: null }
  let prev
  try {
    prev = JSON.parse(readFileSync(JSON_PATH, 'utf8'))
  } catch {
    return { diffs: [], previous: null }
  }
  // start 不进对比：它在「帧先到」和「回执先到」两态间跳，是调度顺序不是回归。
  const diffs = []
  for (const [key, limit] of Object.entries(TOL)) {
    const a = Number(prev?.[key])
    const b = Number(numbers?.[key])
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) continue
    const abs = Math.abs(b - a)
    const pct = Math.round(((b - a) / a) * 1000) / 10
    const floor = ABS_FLOOR[key] ?? 0
    diffs.push({ key, previous: a, current: b, pct, limit, over: abs > floor && Math.abs(pct) > limit })
  }
  return { diffs, previous: prev }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  // 安全闸：只打固定会话，且先确认它存在、不在跑
  const list = await getJson('sessions?limit=40')
  const sessions = list.body?.sessions ?? bothSessionLists(list.body)
  const hit = sessions.find((s) => String(s.id ?? '') === SESSION || `session-${String(s.id ?? '')}` === SESSION)
  if (!hit) throw new Error(`目标会话不在 /api/sessions 里：${SESSION}`)
  if (hit.running === true) throw new Error(`目标会话正在跑（running=true），换一只或等它结束：${SESSION}`)
  const state = await getJson('state')

  const meta = {
    at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    base: BASE,
    pluginVersion: state.body?.pluginVersion ?? null,
    sample: SAMPLE.slice(REPO_ROOT.length + 1),
    sampleBytes: readFileSync(SAMPLE).length,
    only: ONLY,
    session: SESSION,
  }
  console.log(`# 基准 ${meta.at} ${BASE} plugin=${meta.pluginVersion} n=${N}`)

  console.log('· ASR …')
  const asr = wants('asr') ? await benchAsr() : { rows: [], wasRunning: null, bytes: 0 }
  console.log('· 文本（dispatch + SSE）…')
  const dispatch = wants('text') ? await benchDispatch() : []
  console.log('· TTS …')
  const tts = wants('tts') ? await benchTts() : { synthRows: [], cacheRows: [], warm: { ms: NaN, cache: '' } }

  const { markdown, numbers } = buildReport({ asr, dispatch, tts, meta })
  const { diffs } = compareWithPrevious(numbers)

  console.log('')
  console.log(markdown.split('\n').filter((l) => l.startsWith('|')).join('\n'))
  if (diffs.length) {
    console.log('')
    console.log('重跑偏差（对比 docs/pet-bench.json）：')
    for (const d of diffs) console.log(`  ${d.key.padEnd(10)} ${fmt(d.previous)} → ${fmt(d.current)} ms  ${d.pct > 0 ? '+' : ''}${d.pct}%${d.over ? `  ⚠ 超过 ${d.limit}%` : ''}`)
  } else {
    console.log('（首次跑：没有上次数字可比；再跑一次就能看到偏差）')
  }

  if (WRITE) {
    mkdirSync(dirname(DOC_PATH), { recursive: true })
    writeFileSync(DOC_PATH, markdown)
    writeFileSync(JSON_PATH, JSON.stringify(numbers, null, 2) + '\n')
    console.log(`\n已写 ${DOC_PATH}`)
  }

  const bad = dispatch.filter((r) => r.status !== 200 || !Number.isFinite(r.end))
  if (bad.length) {
    console.error(`\n✗ ${bad.length}/${dispatch.length} 轮派发异常：${JSON.stringify(bad.slice(0, 3))}`)
    process.exitCode = 1
  }
  if (STRICT && diffs.some((d) => d.over)) {
    console.error('\n✗ --strict：有指标偏差超过各自的噪声带（见上表的 tol）')
    process.exitCode = 1
  }
}

function bothSessionLists(body) {
  // /sessions 的形状：{ ok, sessions:[…] } 或 { items:[…] }
  if (Array.isArray(body?.items)) return body.items
  return []
}

main().catch((error) => {
  console.error(`✗ ${error?.message ?? error}`)
  process.exitCode = 1
})
