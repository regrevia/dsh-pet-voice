/**
 * scripts/lib/pet-http.mjs —— 压测/基准脚本共用的最小 HTTP 客户端。
 *
 * 只做四件事：读出本机已配对的 token 与设备 id、带鉴权发 JSON 请求、
 * 按到达时刻记录 SSE 帧、把时间量成小数毫秒。
 * token 绝不打印，也绝不写进任何产物。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PET_HOME = join(homedir(), '.dsh', 'pet-voice')
const TOKEN_PATH = join(PET_HOME, 'token')
const DEVICES_PATH = join(PET_HOME, 'devices.json')

export const now = () => Number(process.hrtime.bigint() / 1000n) / 1000

export function readToken() {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim()
  } catch {
    throw new Error(`读不到 token：${TOKEN_PATH}（先在插件页配对一次）`)
  }
}

/** 已注册设备 id：不占新名额，不触发 429。 */
export function deviceId() {
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

export function makeClient(base) {
  const API = `${String(base).replace(/\/$/, '')}/pet-voice/api`
  const HEADERS = { authorization: `Bearer ${readToken()}`, 'x-pet-device-id': deviceId(), accept: 'application/json' }

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
      return { status: res.status, headers: res.headers, body, ms, path }
    } catch (error) {
      return { status: 0, headers: new Headers(), body: { error: String(error?.message ?? error) }, ms: now() - t0, path }
    } finally {
      clearTimeout(timer)
    }
  }

  const getJson = (path, timeoutMs) => requestJson(path, { method: 'GET' }, timeoutMs)
  const postJson = (path, body, timeoutMs) =>
    requestJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }, timeoutMs)

  /** 一瞬间发很多请求，全部落定后统一返回（用来压并发，不排队）。 */
  const burst = (thunks) => Promise.all(thunks.map((fn) => fn().catch((error) => ({ status: 0, body: { error: String(error?.message ?? error) }, ms: NaN }))))

  async function openSSE(sessionId) {
    const ctrl = new AbortController()
    const url = `${API}/stream?sessionId=${encodeURIComponent(sessionId)}`
    const res = await fetch(url, { headers: { ...HEADERS, accept: 'text/event-stream' }, signal: ctrl.signal })
    if (res.status !== 200) throw new Error(`SSE 连不上：HTTP ${res.status}`)
    const sse = new SSE(res)
    sse.abort = () => ctrl.abort()
    return sse
  }

  return { API, HEADERS, requestJson, getJson, postJson, burst, openSSE }
}

/** 按到达时刻记帧的 SSE 读端。 */
export class SSE {
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
