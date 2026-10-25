#!/usr/bin/env node
/**
 * 鲸灵 MCP 服务端 (pet-bridge)
 *
 * 把宿主插件 dsh-pet-voice 挂在 DSH webServer 上的 /pet-voice/api/* 端点，
 * 包装成标准 MCP（Model Context Protocol, JSON-RPC 2.0）工具，供任意 MCP 客户端调用。
 *
 * 传输：
 *   - stdio（默认）：一行一个 JSON-RPC 消息
 *   - --http [port]：Streamable HTTP，POST /mcp（默认端口 7788），只绑 127.0.0.1
 *
 * 零第三方依赖，Node >= 20（本机 Node 24 实测）。
 *
 * 安全约定（务必遵守）：
 *   - 访问令牌只允许从环境变量 PET_TOKEN 或 ~/.dsh/pet-voice/token 读进内存；
 *     绝不打印、绝不写日志、绝不写仓库文件。
 *   - 上游 /api/state 响应体里本身就带一个 token 字段，输出前必须抹掉。
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.0.0'
const SERVER_NAME = 'pet-bridge'
const PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_PROTOCOLS = [PROTOCOL_VERSION, '2025-03-26', '2024-11-05']

const DEFAULT_HTTP_PORT = 7788
const CANDIDATE_PORTS = [58686, 62981, 3080]
const PROBE_TIMEOUT_MS = 1500
const DEFAULT_WAIT_MS = 45000
const MAX_WAIT_MS = 300000

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function homeDir() {
  return process.env.HOME || os.homedir()
}

function petVoiceDir() {
  return path.join(homeDir(), '.dsh', 'pet-voice')
}

/** 把上游返回里可能出现的敏感字段抹掉（state 响应里真的带 token）。 */
function redact(value, depth = 0) {
  if (depth > 12) return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (/^(token|apiKey|api_key|secret|password|authorization|cookie)$/i.test(k)) {
        out[k] = typeof v === 'string' ? '<redacted>' : true
      } else {
        out[k] = redact(v, depth + 1)
      }
    }
    return out
  }
  return value
}

function truncate(text, max) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max} 字)`
}

/* ------------------------------------------------------------------ */
/* 令牌与端口发现                                                      */
/* ------------------------------------------------------------------ */

function readToken() {
  const fromEnv = (process.env.PET_TOKEN || '').trim()
  if (fromEnv) return fromEnv
  try {
    const raw = fs.readFileSync(path.join(petVoiceDir(), 'token'), 'utf8').trim()
    return raw || ''
  } catch {
    return ''
  }
}

/** 从 ~/.dsh/pet-voice/state.json 还原端口（宿主插件若写入） */
function portsFromStateFile() {
  const ports = []
  try {
    const raw = fs.readFileSync(path.join(petVoiceDir(), 'state.json'), 'utf8')
    const st = JSON.parse(raw)
    for (const key of ['port', 'base', 'baseUrl', 'origin', 'url']) {
      const v = st?.[key]
      if (typeof v === 'number' && Number.isInteger(v)) ports.push(v)
      if (typeof v === 'string') {
        const m = v.match(/127\.0\.0\.1:(\d{2,5})/)
        if (m) ports.push(Number(m[1]))
      }
    }
  } catch {
    /* 不存在或不是 JSON：忽略 */
  }
  return ports
}

/** 从 remote-web-ui-tunnel-child.json 的 command 字符串里抠 127.0.0.1:<port> */
function portsFromTunnelFile() {
  const ports = []
  try {
    const raw = fs.readFileSync(path.join(homeDir(), '.dsh', 'remote-web-ui-tunnel-child.json'), 'utf8')
    const j = JSON.parse(raw)
    const cmd = String(j?.command || '')
    for (const m of cmd.matchAll(/127\.0\.0\.1:(\d{2,5})/g)) ports.push(Number(m[1]))
  } catch {
    /* 忽略 */
  }
  return ports
}

function candidateBases() {
  const explicit = (process.env.PET_BASE || '').trim()
  if (explicit) {
    const base = explicit.replace(/\/+$/, '')
    return { explicit: true, bases: [base], source: 'env:PET_BASE' }
  }
  const ports = [
    ...portsFromStateFile(),
    ...CANDIDATE_PORTS,
    ...portsFromTunnelFile(),
    Number(process.env.PET_PORT) || 0,
  ].filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
  const seen = new Set()
  const bases = []
  for (const p of ports) {
    if (seen.has(p)) continue
    seen.add(p)
    bases.push(`http://127.0.0.1:${p}`)
  }
  return { explicit: false, bases, source: 'auto-detect' }
}

class PetError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'PetError'
    this.detail = detail
  }
}

let cached = null // { base, token, at }

async function resolveEndpoint({ force = false } = {}) {
  if (cached && !force) return cached
  const token = readToken()
  const { explicit, bases, source } = candidateBases()

  if (!token) {
    throw new PetError(
      '找不到访问令牌：请设置环境变量 PET_TOKEN，或确认 ~/.dsh/pet-voice/token 存在且可读。',
      { tried: bases, source },
    )
  }

  const tried = []
  for (const base of bases) {
    const res = await probe(base, token)
    tried.push({ base, ...res })
    if (res.ok) {
      cached = { base, token, at: Date.now(), source, port: new URL(base).port }
      return cached
    }
  }

  if (explicit) {
    throw new PetError(
      `PET_BASE 指向的地址不可用：${bases[0]}（详见 detail）。请确认 DSH 正在运行，或删掉 PET_BASE 让服务端自动探测。`,
      { tried },
    )
  }
  throw new PetError(
    '探测不到「鲸灵」宿主：所有候选端口都没响应（详见 detail）。请确认 DSH 正在运行且已启用 dsh-pet-voice 插件；' +
      '也可以显式设置 PET_BASE=http://127.0.0.1:<端口>（端口见 DSH 窗口地址栏）。',
    { tried },
  )
}

async function probe(base, token) {
  const started = Date.now()
  try {
    const resp = await fetchWithTimeout(`${base}/pet-voice/api/state`, {
      headers: { cookie: cookieFor(token) },
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    const ms = Date.now() - started
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, status: resp.status, ms, reason: '鉴权失败（cookie 不匹配，可能 token 已轮换）' }
    }
    if (resp.status === 404) {
      return { ok: false, status: 404, ms, reason: '该端口没有 /pet-voice/api/state（不是鲸灵宿主）' }
    }
    if (!resp.ok) return { ok: false, status: resp.status, ms, reason: `HTTP ${resp.status}` }
    const json = await resp.json().catch(() => null)
    if (!json || json.ok !== true) return { ok: false, status: resp.status, ms, reason: '返回体不是预期 JSON' }
    return { ok: true, status: resp.status, ms }
  } catch (err) {
    const ms = Date.now() - started
    const code = err?.cause?.code || err?.name || 'ERROR'
    return { ok: false, ms, reason: code === 'ECONNREFUSED' ? '端口未监听' : `连接失败(${code})` }
  }
}

function cookieFor(token) {
  return `pkv_${token.slice(0, 8)}=${token}`
}

/* ------------------------------------------------------------------ */
/* 上游 HTTP 客户端                                                    */
/* ------------------------------------------------------------------ */

async function fetchWithTimeout(url, { headers = {}, timeoutMs = 10000, method = 'GET', body } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
  try {
    return await fetch(url, {
      method,
      headers: { accept: 'application/json', ...headers },
      body,
      signal: ac.signal,
      redirect: 'follow',
    })
  } finally {
    clearTimeout(timer)
  }
}

async function petGet(pathname, { timeoutMs = 10000 } = {}) {
  const { base, token } = await resolveEndpoint()
  const url = `${base}/pet-voice/api/${pathname}`
  let resp
  try {
    resp = await fetchWithTimeout(url, { headers: { cookie: cookieFor(token) }, timeoutMs })
  } catch (err) {
    cached = null
    throw new PetError(`请求 ${pathname} 失败：${err?.cause?.code || err?.message || 'unknown'}`, {})
  }
  const text = await resp.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  if (!resp.ok || !json) {
    throw new PetError(`上游 ${pathname} 返回 HTTP ${resp.status}${json?.error ? `：${json.error}` : ''}`, {
      body: truncate(text, 400),
    })
  }
  return redact(json)
}

async function petPost(pathname, payload, { timeoutMs = 20000 } = {}) {
  const { base, token } = await resolveEndpoint()
  const url = `${base}/pet-voice/api/${pathname}`
  let resp
  try {
    resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { cookie: cookieFor(token), 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      timeoutMs,
    })
  } catch (err) {
    cached = null
    throw new PetError(`请求 ${pathname} 失败：${err?.cause?.code || err?.message || 'unknown'}`, {})
  }
  const text = await resp.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  if (!resp.ok) {
    throw new PetError(`上游 ${pathname} 返回 HTTP ${resp.status}${json?.error ? `：${json.error}` : ''}`, {
      body: truncate(text, 400),
    })
  }
  if (json && json.ok === false) {
    throw new PetError(`上游 ${pathname} 失败：${json.error || '未知错误'}`, { body: truncate(text, 400) })
  }
  return json ? redact(json) : { ok: true, raw: truncate(text, 400) }
}

/* ------------------------------------------------------------------ */
/* SSE 读取（容忍宿主侧 bug：连上但收不到帧）                          */
/* ------------------------------------------------------------------ */

/**
 * 订阅 /api/stream?sessionId=，按帧回调。
 * 会在 deadline 到点或拿到 stop 帧时通过 AbortController 主动断开，绝不挂死。
 */
async function consumeStream(sessionId, { deadline, onEvent, onAbort }) {
  const { base, token } = await resolveEndpoint()
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, Math.max(50, deadline - Date.now()))
  if (onAbort) onAbort(timer)

  try {
    let resp
    try {
      resp = await fetch(`${base}/pet-voice/api/stream?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { cookie: cookieFor(token), accept: 'text/event-stream' },
        signal: ac.signal,
      })
    } catch (err) {
      if (timedOut) return { timedOut: true }
      throw new PetError(`订阅 stream 失败：${err?.cause?.code || err?.message || 'unknown'}`)
    }
    if (!resp.ok || !resp.body) {
      return { error: `stream 返回 HTTP ${resp.status}` }
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let eventName = 'message'
    let dataLines = []

    /**
     * 关键：宿主一帧常常不带结尾空行（例如 "event: end\ndata: {...}\n\nevent: final\ndata: {...}\n\n"
     * 之后紧跟 ": hb" 注释或干脆停住）。所以除了空行分帧外，还要在「读到新的 event: 行」或
     * 「流结束」时补一次 flush，否则最后一帧永远发不出去。
     */
    const flush = () => {
      if (!dataLines.length) {
        eventName = 'message'
        return null
      }
      const raw = dataLines.join('\n')
      dataLines = []
      const name = eventName
      eventName = 'message'
      let data = null
      try {
        data = JSON.parse(raw)
      } catch {
        data = { text: raw }
      }
      return { event: name, data }
    }

    const cancel = async () => {
      clearTimeout(timer)
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    }

    for (;;) {
      let chunk
      try {
        chunk = await reader.read()
      } catch (err) {
        if (timedOut || ac.signal.aborted) return { timedOut: true }
        throw err
      }
      if (chunk.done) {
        const last = flush()
        if (last) onEvent(last)
        return { ended: true }
      }
      buf += decoder.decode(chunk.value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line === '') {
          const ev = flush()
          if (ev && onEvent(ev)) {
            await cancel()
            return { stopped: true }
          }
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) {
          // 新的 event 行 = 上一帧没有以空行收尾，先补发
          const pendingEv = flush()
          if (pendingEv && onEvent(pendingEv)) {
            await cancel()
            return { stopped: true }
          }
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* 业务：把宿主 state 整理成对模型友好的形状                            */
/* ------------------------------------------------------------------ */

function summarizeState(state) {
  const projects = Array.isArray(state.projects) ? state.projects : []
  const presets = Array.isArray(state.presets) ? state.presets : []
  const sessions = Array.isArray(state.sessions) ? state.sessions : []
  const current = state.current || null
  const remembered = state.remembered && typeof state.remembered === 'object' ? state.remembered : {}
  // petSession：宿主钉死给「鲸灵/小爱」的专属会话（见 dsh-pet-voice 的 pet-session.json）。
  // 有它就别用 current —— current 是 GUI 里最近活跃的那只，派过去会打扰用户。
  const petSession = state.petSession && typeof state.petSession === 'object' ? state.petSession : null
  return { projects, presets, sessions, current, remembered, petSession, pet: state.pet || null }
}

function findProject(state, wanted) {
  const { projects } = summarizeState(state)
  const w = String(wanted ?? '').trim()
  if (!w) return null
  const lower = w.toLowerCase()
  const byId = projects.find((p) => p.id === w)
  if (byId) return byId
  const exact = projects.find((p) => String(p.title || '').toLowerCase() === lower)
  if (exact) return exact
  const baseMatch = projects.find((p) => path.basename(String(p.path || '')).toLowerCase() === lower)
  if (baseMatch) return baseMatch
  const partial = projects.filter((p) => String(p.title || '').toLowerCase().includes(lower))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new PetError(`「${w}」匹配到多个项目：${partial.map((p) => p.title).join('、')}，请写全名。`, {})
  }
  return null
}

function projectListText(state) {
  const { projects } = summarizeState(state)
  return projects.map((p) => `- ${p.title}`).join('\n') || '（无）'
}

function currentLine(current) {
  if (!current) return '当前没有会话'
  const t = current.title ? `「${current.title}」` : '（未命名）'
  return `当前会话 ${current.id} ${t}，cwd=${current.cwd || '未知'}`
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

async function toolPetStatus() {
  let state
  try {
    state = await petGet('state')
  } catch (err) {
    return fail(err)
  }
  const { projects, presets, sessions, current, remembered, pet } = summarizeState(state)
  const lines = []
  lines.push(`鲸灵宿主：在线（${cached?.base || '未知地址'}）`)
  if (pet?.name) lines.push(`宠物：${pet.name}${Array.isArray(pet.wakeWords) && pet.wakeWords.length ? `（唤醒词 ${pet.wakeWords.join(' / ')}）` : ''}`)
  lines.push(currentLine(current))
  if (current?.workspaceId) {
    const wp = projects.find((p) => p.id === current.workspaceId)
    if (wp) lines.push(`绑定项目：${wp.title}（${wp.path}）`)
  }
  lines.push(`项目 ${projects.length} 个：\n${projectListText(state)}`)
  lines.push(`预设：${presets.map((p) => p.id).join(' / ') || '（无）'}`)
  lines.push(`已知会话 ${sessions.length} 个${remembered && Object.keys(remembered).length ? `，其中 ${Object.keys(remembered).length} 个项目记住了会话` : ''}`)
  const recent = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
  if (recent) {
    const ts = recent.updatedAt ? new Date(recent.updatedAt).toLocaleString('zh-CN') : '未知'
    lines.push(`最近活动会话：${recent.id}${recent.title ? `「${recent.title}」` : ''}（${ts}）`)
  }
  lines.push('说明：宿主没有暴露「是否正在生成」的只读字段；用 pet_ask 的返回判断本轮是否已结束。')
  return ok(lines.join('\n'), {
    port: cached?.port,
    current,
    projectCount: projects.length,
    projects: projects.map((p) => ({ id: p.id, title: p.title })),
    presets: presets.map((p) => p.id),
    sessionCount: sessions.length,
  })
}

async function toolSwitchProject({ name }) {
  const stateResult = await petGet('state')
  const project = findProject(stateResult, name)
  const all = summarizeState(stateResult)
  if (!project) {
    return fail(
      new PetError(`找不到项目「${name}」。可用项目：\n${projectListText(stateResult)}`, {
        projects: all.projects.map((p) => p.title),
      }),
    )
  }
  const current = all.current
  const pinned = String(all.petSession?.sessionId ?? '')
  if (current && current.workspaceId === project.id) {
    return ok(`已经在项目「${project.title}」上（会话 ${current.id}），无需切换。`, {
      project,
      workspaceTitle: project.title,
      sessionId: current.id,
      changed: false,
    })
  }
  // 若专属会话已经在这个项目里，直接报它，不去 POST /new 抖动界面
  if (pinned) {
    const row = all.sessions.find((item) => String(item?.id ?? '') === pinned)
    if (row && String(row.workspaceId ?? '') === project.id) {
      return ok(`项目「${project.title}」上已经有专属会话 ${pinned}，没有新建。`, {
        project,
        workspaceTitle: project.title,
        sessionId: pinned,
        changed: false,
        reused: true,
      })
    }
  }

  // 宿主没有独立的「切换」端点：用 new{fresh:false, workspaceId} 复用/新建该项目对应会话。
  let created
  try {
    created = await petPost('new', { workspaceId: project.id, fresh: false })
  } catch (err) {
    return fail(err)
  }
  const sessionId = created.sessionId || created.id || null
  const text = created.reused
    ? `已切到项目「${project.title}」，复用会话 ${sessionId}。`
    : `已切到项目「${project.title}」，新建会话 ${sessionId}。`
  return ok(text, {
    project,
    workspaceTitle: project.title,
    sessionId,
    reused: Boolean(created.reused),
    preset: created.preset ?? null,
  })
}

async function toolNewSession({ project, preset }) {
  const payload = { fresh: true }
  let projectTitle = null
  let workspaceTitle = null
  if (project) {
    const stateResult = await petGet('state')
    const p = findProject(stateResult, project)
    if (!p) {
      return fail(new PetError(`找不到项目「${project}」。可用项目：\n${projectListText(stateResult)}`, {}))
    }
    payload.workspaceId = p.id
    projectTitle = p.title
    workspaceTitle = p.title
    // 纪律：该项目已经有专属会话时复用，避免每次调用都新建、把界面 current 抖来抖去。
    const pinned = String(summarizeState(stateResult).petSession?.sessionId ?? '')
    if (pinned) {
      const row = summarizeState(stateResult).sessions.find((item) => String(item?.id ?? '') === pinned)
      if (row && String(row.workspaceId ?? '') === p.id) {
        return ok(`项目「${p.title}」上已经有专属会话 ${pinned}，已复用（没有新建）。`, {
          sessionId: pinned,
          workspaceTitle: p.title,
          project: p.title,
          preset: preset || null,
          created: false,
          reused: true,
        })
      }
    }
  }
  if (preset) payload.preset = String(preset).trim()

  let created
  try {
    created = await petPost('new', payload)
  } catch (err) {
    if (preset && /preset/i.test(String(err.message))) {
      const st = await petGet('state').catch(() => null)
      const list = st ? summarizeState(st).presets.map((p) => p.id).join(' / ') : '（未知）'
      return fail(new PetError(`${err.message}。可用预设：${list}`, {}))
    }
    return fail(err)
  }
  const sessionId = created.sessionId || created.id || null
  const parts = [`已新建会话 ${sessionId}`]
  if (projectTitle) parts.push(`项目「${projectTitle}」`)
  if (preset) parts.push(`预设 ${preset}`)
  return ok(`${parts.join('，')}。`, {
    sessionId,
    workspaceTitle: workspaceTitle || created.workspaceTitle || null,
    project: projectTitle,
    preset: preset || null,
    created: true,
    reused: false,
  })
}

async function toolAsk({ text, mode = 'queue', wait_ms, sessionId: wanted }) {
  const started = Date.now()
  // 1) 先把会话定位好：显式 session 不存在会直接 404/报错，不如自己先查。
  let state
  try {
    state = await petGet('state')
  } catch (err) {
    return fail(err)
  }
  const { current, sessions, petSession } = summarizeState(state)
  // 目标会话只认两种来源：调用方显式传入，或宿主钉死的小爱专属会话。
  // **绝不**用 current（界面里最近活跃的那只）——那会把任务塞进用户正在看的会话。
  const pinned = String(petSession?.sessionId ?? '')
  const explicit = String(wanted ?? '').trim()
  const known = new Set(sessions.map((item) => String(item?.id ?? '')))
  let targetNote = ''
  if (explicit && known.size && !known.has(explicit)) {
    return fail(new PetError(`指定的会话 ${explicit} 不在宿主会话列表里，没有派发。可用会话：${sessions.map((i) => i.id).join(' / ') || '（无）'}`, { sessions: sessions.length }))
  }
  const sessionIdTarget = explicit || pinned
  if (!sessionIdTarget) {
    return fail(
      new PetError(
        '没有可派发的目标会话：宿主没有钉死小爱专属会话，调用方也没传 sessionId。' +
          '不会派给「界面当前会话」（会打扰用户）。请先 pet_new_session（建议带 project），或用 sessionId 明确指定。',
        { sessions: sessions.length },
      ),
    )
  }
  if (!explicit) targetNote = '（小爱专属会话）'
  const sessionId = sessionIdTarget
  const waitMs = clampWait(wait_ms)
  const deadline = started + waitMs

  // 2) 先订阅 stream，再 dispatch —— 顺序很重要，否则丢失本轮帧。
  const collected = { deltas: [], final: null, tools: [], endReason: null, error: null, sawStart: false }
  let dispatchAccepted = false
  let dispatchResult = null
  let streamNote = null

  const streamPromise = consumeStream(sessionId, {
    deadline,
    onEvent: ({ event, data }) => {
      switch (event) {
        case 'start':
          collected.sawStart = true
          return false
        case 'delta':
          if (data?.text) collected.deltas.push(String(data.text))
          return false
        case 'tool':
          if (data?.name) collected.tools.push(String(data.name))
          return false
        case 'final':
          if (data?.text) collected.final = String(data.text)
          return false
        case 'end':
          collected.endReason = data?.reason || 'stop'
          return true // 主动断开
        case 'error':
          collected.error = data?.message || data?.error || '宿主报错'
          return true
        default:
          return false
      }
    },
  }).catch((err) => {
    streamNote = err?.message || String(err)
    return { error: streamNote }
  })

  // 3) 派发
  try {
    // 显式带上 sessionId：宿主侧不再需要猜「当前会话」
    dispatchResult = await petPost('dispatch', { text, sessionId })
    dispatchAccepted = dispatchResult?.accepted !== false
  } catch (err) {
    return fail(err)
  }

  if (mode === 'steer' || waitMs <= 0) {
    // 不等待：立刻返回受理状态。注意宿主 dispatch 会排队，不是打断。
    return ok(
      mode === 'steer'
        ? `已派发（steer 语义：插队到该会话的输入队列；宿主没有真正的「打断当前回合」接口，需要打断请用 pet_stop）。会话 ${sessionId}。`
        : `已派发并受理（未等待回复，wait_ms=0）。会话 ${sessionId}。`,
      { sessionId, accepted: dispatchAccepted, waited: false, mode },
    )
  }

  // 4) 等 stream 到 end / final，或超时
  const stream = await streamPromise
  const elapsed = Date.now() - started
  const answer = (collected.final || collected.deltas.join('')).trim()

  if (collected.error) {
    return ok(`宿主在执行时返回错误：${collected.error}（会话 ${sessionId}）`, {
      sessionId,
      accepted: true,
      error: collected.error,
      elapsedMs: elapsed,
    })
  }

  if (collected.endReason !== null || collected.final) {
    const textOut = answer || '（本轮已结束，但宿主没有返回任何文本）'
    const toolNote = collected.tools.length ? `\n（本轮用到的工具：${collected.tools.join('、')}）` : ''
    return ok(`${textOut}${toolNote}`, {
      sessionId,
      accepted: true,
      completed: true,
      final: collected.final || null,
      tools: collected.tools,
      elapsedMs: elapsed,
    })
  }

  // 超时 / stream 异常：不挂死，如实说明
  const why = stream?.error
    ? `stream 订阅失败（${stream.error}）`
    : streamNote
      ? `stream 异常（${streamNote}）`
      : `等了 ${Math.round(elapsed / 1000)} 秒没收到结束帧`
  return ok(
    `已受理，回复稍后到。\n${why}。消息已投递给会话 ${sessionId}，鲸灵那边会继续跑；` +
      `过一会儿可再调 pet_status 查看，或在网页端 /pet-voice/ 直接看。` +
      (answer ? `\n已收到的部分文本：${truncate(answer, 500)}` : ''),
    {
      sessionId,
      accepted: true,
      completed: false,
      timedOut: true,
      partial: answer || null,
      elapsedMs: elapsed,
    },
  )
}

async function toolStop() {
  let state
  try {
    state = await petGet('state')
  } catch (err) {
    return fail(err)
  }
  const { current, petSession } = summarizeState(state)
  // 只取消专属会话：current 可能是用户正在用的界面会话，不能乱打断
  const target = String(petSession?.sessionId ?? '') || (String(state.sessionId ?? '').trim() || '')
  if (!target) {
    return fail(new PetError('没有可停止的专属会话：宿主未钉死小爱会话。不会去打断「界面当前会话」。', { current: current?.id ?? null }))
  }
  try {
    const res = await petPost('cancel', { sessionId: target })
    return ok(`已向会话 ${target} 发送取消请求${res?.ok === false ? '（宿主返回失败）' : ''}。`, {
      sessionId: target,
      raw: res,
    })
  } catch (err) {
    return fail(err)
  }
}

/**
 * pet_say：宿主 dsh-pet-voice 的 `POST /pet-voice/api/say` 入队，
 * 由手机页面（在线时）念出来。宿主旧版本没有这条路由 → 404，必须如实失败，
 * 不能假装成功（否则用户以为手机在说话，实际什么都没发生）。
 */
async function toolSay({ text }) {
  const body = String(text ?? "").trim()
  if (!body) {
    return { isError: true, content: [{ type: "text", text: "text 不能为空：请给出要让鲸灵朗读的内容。" }] }
  }
  let json
  try {
    json = await petPost("say", { text: body }, { timeoutMs: 8000 })
  } catch (err) {
    const msg = String(err?.message ?? err)
    const detail = err?.detail && Object.keys(err.detail).length ? `\n${JSON.stringify(redact(err.detail), null, 1)}` : ""
    const missing = /HTTP 404/.test(msg)
    const unauth = /HTTP 40[13]|鉴权|令牌/.test(msg)
    const offline = /ECONNREFUSED|探测不到|不可达|ENOTFOUND|EHOSTUNREACH/.test(msg)
    const why = missing
      ? "宿主不支持播报（没有 /pet-voice/api/say，dsh-pet-voice 需要升级到新版本）"
      : unauth
        ? "鉴权没过（token 可能已轮换，确认 ~/.dsh/pet-voice/token 与页面一致）"
        : offline
          ? "宿主不可达（DSH 没运行，或手机页面不在线）"
          : "请求宿主失败"
    return {
      isError: true,
      content: [{ type: "text", text: `播报未执行：${why}。\n原因：${msg}${detail}\n待播报内容：「${truncate(body, 200)}」` }],
      structuredContent: {
        ok: false,
        delivered: false,
        requiresPhoneOnline: true,
        reason: missing ? "no-say-endpoint" : unauth ? "unauthorized" : offline ? "host-offline" : "upstream-error",
      },
    }
  }
  const seq = Number(json?.seq ?? 0)
  const queued = Number(json?.queued ?? 0)
  const note = typeof json?.note === "string" && json.note ? json.note : "已入队，手机页面在线时会念出来"
  return ok(
    `已入队：seq=${seq}，队列长度=${queued}。${note}\n内容：「${truncate(body, 200)}」`,
    { ok: true, seq, queued, note, delivered: true },
  )
}

function clampWait(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return DEFAULT_WAIT_MS
  if (n <= 0) return 0
  return Math.min(Math.round(n), MAX_WAIT_MS)
}

/* ---- 统一的结果包装 ---- */

function ok(text, structured) {
  const res = { content: [{ type: 'text', text }] }
  if (structured !== undefined) res.structuredContent = redact(structured)
  return res
}

function fail(err) {
  const detail = err?.detail && Object.keys(err.detail).length ? `\n${JSON.stringify(redact(err.detail), null, 1)}` : ''
  return { isError: true, content: [{ type: 'text', text: `${err?.message || String(err)}${detail}` }] }
}

/* ------------------------------------------------------------------ */
/* 工具表                                                              */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'pet_status',
    title: '查看鲸灵当前状态',
    description:
      '查看这台电脑上「鲸灵」助手的状态：宿主是否在线、当前会话与绑定项目、有哪些工作区(项目)和预设、最近活动的会话。' +
      '只读、无副作用，随时可调用。在用户问「鲸灵现在怎么样 / 在哪个项目 / 有哪些项目」时用，' +
      '或在 pet_switch_project 前用它拿到准确的项目名单。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pet_switch_project',
    title: '切换工作项目',
    description:
      '把鲸灵切到指定工作区(项目)。宿主没有独立的切换接口，实现上是让 DSH 复用或新建该项目的会话(workspaceId + fresh:false)，' +
      '因此会产生/切换「当前会话」。name 可以是项目标题(大小写不敏感、唯一子串也可以)、目录名或项目 id。' +
      '项目不存在时会返回可用项目列表。若用户只是问有哪些项目，请用 pet_status。',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          description: '项目名称（标题、目录名或 id），例如 "Pet"、"Envoy"。',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pet_ask',
    title: '对鲸灵说一句话',
    description:
      '把一句话作为用户消息投递给鲸灵的会话，并尽量等它回复完。默认会等待(最多 wait_ms 毫秒)并返回完整回复文本；' +
      '若宿主 SSE 有问题或超时，会返回「已受理，回复稍后到」而不是报错——这时消息确实已经在跑了，不要重复发送同一条。' +
      'mode="steer" 或 wait_ms=0 表示只投递不等待。注意：dispatch 是排队而非打断当前回合，要立即中断请用 pet_stop。' +
      '派发目标只认两种：调用方显式给的 sessionId，或宿主钉死的小爱专属会话（不会派给界面里用户正在看的会话）。' +
      '两者都没有时会报错，此时请先 pet_new_session（建议带 project）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 8000, description: '要发给鲸灵的自然语言指令。' },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          default: 'queue',
          description:
            'queue=排到输入队列(默认)；steer=同样投递，但语义上希望尽快处理，且不等待回复。两者在宿主侧都是排队投递，不会打断正在跑的回合。',
        },
        sessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            '可选：显式指定目标会话 id（必须存在于宿主会话列表）。不给则只用宿主钉死的小爱专属会话；两者都没有就报错，不会回落到「界面当前会话」。',
        },
        wait_ms: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_WAIT_MS,
          default: DEFAULT_WAIT_MS,
          description: `最多等待回复的毫秒数，0 表示不等待(立即返回已受理)。默认 ${DEFAULT_WAIT_MS}，上限 ${MAX_WAIT_MS}。`,
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'pet_new_session',
    title: '新建会话',
    description:
      '为鲸灵新建一个干净会话(fresh)，可指定项目与预设。不指定 project 时沿用当前项目的记忆。' +
      '若该项目已经有小爱专属会话，则直接复用那只（不新建、不动界面当前会话），返回 created:false。' +
      '返回 sessionId 与 workspaceTitle 便于调用方核对。预设非法时返回可选预设列表。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, description: '可选：项目名称（标题/目录名/id）。省略则在当前项目新建。' },
        preset: { type: 'string', minLength: 1, description: '可选：agent 预设 id，例如 standard、minimal、ptc、cordis。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'pet_stop',
    title: '停止当前回合',
    description:
      '取消(打断)鲸灵当前会话正在跑的这一轮。用于用户说「停 / 别说了 / 打断」。' +
      '对没有在跑任务的会话调用是无害的。停止不会删除会话或丢失历史。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'pet_say',
    title: '让手机端播报一句话',
    description:
      '请求鲸灵在手机端朗读一段文字；需要手机页面在线。不在线会如实失败。' +
      '入队成功返回 seq（播报序号）与队列表长度；宿主版本偏旧（无 /pet-voice/api/say）时返回 isError 并说明原因。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000, description: '希望播报的内容。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
]

const HANDLERS = {
  pet_status: toolPetStatus,
  pet_switch_project: toolSwitchProject,
  pet_ask: toolAsk,
  pet_new_session: toolNewSession,
  pet_stop: toolStop,
  pet_say: toolSay,
}

/* ------------------------------------------------------------------ */
/* 参数校验                                                            */
/* ------------------------------------------------------------------ */

function validate(schema, args) {
  const errors = []
  const a = args ?? {}
  if (typeof a !== 'object' || Array.isArray(a)) return { errors: ['arguments 必须是对象'] }

  const props = schema.properties || {}
  for (const key of schema.required || []) {
    if (!(key in a) || a[key] === undefined || a[key] === null || a[key] === '') errors.push(`缺少必填参数 "${key}"`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(a)) {
      if (!(key in props)) errors.push(`不认识的参数 "${key}"`)
    }
  }
  for (const [key, val] of Object.entries(a)) {
    const s = props[key]
    if (!s || val === undefined || val === null) continue
    if (s.type === 'string') {
      if (typeof val !== 'string') errors.push(`"${key}" 必须是字符串`)
      else {
        if (s.minLength != null && val.trim().length < s.minLength) errors.push(`"${key}" 不能为空`)
        if (s.maxLength != null && val.length > s.maxLength) errors.push(`"${key}" 超过最大长度 ${s.maxLength}`)
        if (s.enum && !s.enum.includes(val)) errors.push(`"${key}" 必须是 ${s.enum.join(' | ')} 之一`)
      }
    } else if (s.type === 'integer') {
      if (!Number.isInteger(val)) errors.push(`"${key}" 必须是整数`)
      else {
        if (s.minimum != null && val < s.minimum) errors.push(`"${key}" 不能小于 ${s.minimum}`)
        if (s.maximum != null && val > s.maximum) errors.push(`"${key}" 不能大于 ${s.maximum}`)
      }
    } else if (s.type === 'boolean' && typeof val !== 'boolean') {
      errors.push(`"${key}" 必须是布尔值`)
    }
  }
  return { errors }
}

/* ------------------------------------------------------------------ */
/* JSON-RPC 分发                                                       */
/* ------------------------------------------------------------------ */

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
}

function rpcError(id, code, message, data) {
  const err = { code, message }
  if (data !== undefined) err.data = redact(data)
  return { jsonrpc: '2.0', id: id ?? null, error: err }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

let initialized = false

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, RPC.INVALID_REQUEST, 'Invalid Request')
  }
  const { id, method, params } = msg
  const isNotification = id === undefined || id === null

  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') {
    return isNotification ? null : rpcError(id, RPC.INVALID_REQUEST, 'Invalid Request')
  }

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : PROTOCOL_VERSION
      initialized = true
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions:
          '鲸灵 MCP 桥：把自然语言投递给本机的鲸灵(DSH)助手并读回结果。常用顺序：pet_status → pet_switch_project / pet_new_session → pet_ask。',
      })
    }
    case 'notifications/initialized':
      initialized = true
      return null
    case 'notifications/cancelled':
      return null
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS })
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (typeof name !== 'string') return rpcError(id, RPC.INVALID_PARAMS, 'tools/call 需要 name 参数')
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return rpcError(id, RPC.INVALID_PARAMS, `未知工具 "${name}"`)
      const { errors } = validate(tool.inputSchema, args)
      if (errors.length) return rpcError(id, RPC.INVALID_PARAMS, `参数不合法：${errors.join('；')}`, { tool: name })
      try {
        const result = await HANDLERS[name](args)
        return rpcResult(id, result)
      } catch (err) {
        // 工具内部异常一律转成 isError 结果，而不是协议错误
        return rpcResult(id, fail(err))
      }
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] })
    case 'prompts/list':
      return rpcResult(id, { prompts: [] })
    default:
      if (isNotification) return null
      return rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${method}`)
  }
}

/* ------------------------------------------------------------------ */
/* 传输：stdio                                                         */
/* ------------------------------------------------------------------ */

function writeStdout(obj) {
  const s = JSON.stringify(obj)
  // 用 write 而不是 console：绝不污染协议流
  process.stdout.write(`${s}\n`)
}

function startStdio() {
  let buf = ''
  const inflight = new Set()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      inflight.add(handleLine(line))
    }
  })
  process.stdin.on('end', async () => {
    const tail = buf.trim()
    if (tail) inflight.add(handleLine(tail))
    // 等所有在途请求把响应写完再退出，否则客户端会以为服务端没回话
    await Promise.allSettled([...inflight])
    process.exit(0)
  })
}

function handleLine(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    writeStdout(rpcError(null, RPC.PARSE_ERROR, 'Parse error'))
    return Promise.resolve()
  }
  const jobs = Array.isArray(msg) ? msg.map((m) => handleMessage(m)) : [handleMessage(msg)]
  return Promise.all(jobs)
    .then((out) => {
      for (const r of out) if (r) writeStdout(r)
    })
    .catch((err) => {
      writeStdout(rpcError(msg?.id ?? null, RPC.INTERNAL_ERROR, `内部错误：${err?.message || err}`))
    })
}

/* ------------------------------------------------------------------ */
/* 传输：Streamable HTTP（POST /mcp，单请求-单响应，可选 SSE 响应）     */
/* ------------------------------------------------------------------ */

function startHttp(port) {
  const server = http.createServer((req, res) => {
    const acToken = (process.env.PET_HTTP_TOKEN || '').trim()
    const cors = {
      'access-control-allow-origin': 'http://127.0.0.1',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'content-type, accept, mcp-session-id, authorization',
      'access-control-max-age': '600',
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/healthz') {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: VERSION, transport: 'http' }))
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: RPC.INVALID_REQUEST, message: 'Not Found' } }))
    }
    if (acToken) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
      if (got !== acToken) {
        res.writeHead(401, { ...cors, 'content-type': 'application/json' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }))
      }
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...cors, allow: 'POST, OPTIONS', 'content-type': 'application/json' })
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: RPC.INVALID_REQUEST, message: 'Method Not Allowed' } }))
    }

    let body = ''
    let tooBig = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 4 * 1024 * 1024) {
        tooBig = true
        req.destroy()
      }
    })
    req.on('end', async () => {
      if (tooBig) return
      let msg
      try {
        msg = JSON.parse(body)
      } catch {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' })
        return res.end(JSON.stringify(rpcError(null, RPC.PARSE_ERROR, 'Parse error')))
      }

      const wantsSse = String(req.headers.accept || '').includes('text/event-stream')
      const out = Array.isArray(msg) ? await Promise.all(msg.map((m) => handleMessage(m))) : [await handleMessage(msg)]
      const payloads = out.filter(Boolean)

      if (payloads.length === 0) {
        // 纯通知：按 Streamable HTTP 约定回 202
        res.writeHead(202, cors)
        return res.end()
      }
      if (wantsSse) {
        res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        for (const p of payloads) res.write(`event: message\ndata: ${JSON.stringify(p)}\n\n`)
        return res.end()
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify(Array.isArray(msg) ? payloads : payloads[0]))
    })
  })
  server.on('error', (err) => {
    // 端口占用等：写 stderr（不影响 stdio 协议），退出码 1
    process.stderr.write(`pet-bridge: HTTP 监听 ${port} 失败：${err?.code || err?.message}\n`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`pet-bridge: Streamable HTTP 已就绪 http://127.0.0.1:${port}/mcp （仅回环）\n`)
  })
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

function main() {
  const argv = process.argv.slice(2)
  const httpIdx = argv.findIndex((a) => a === '--http')
  const wantHttp = httpIdx >= 0
  let port = DEFAULT_HTTP_PORT
  if (wantHttp) {
    const next = argv[httpIdx + 1]
    if (next && /^\d+$/.test(next)) port = Number(next)
    else if (process.env.PET_HTTP_PORT && /^\d+$/.test(process.env.PET_HTTP_PORT)) port = Number(process.env.PET_HTTP_PORT)
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_NAME} ${VERSION}\n`)
    return
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        '用法: node server.mjs [--http [port]]',
        '',
        '  (无参数)        stdio 传输（MCP 客户端默认方式）',
        '  --http [port]  Streamable HTTP，POST /mcp，默认端口 ' + DEFAULT_HTTP_PORT + '，仅绑 127.0.0.1',
        '',
        '环境变量：',
        '  PET_BASE        宿主基地址，如 http://127.0.0.1:58686（默认自动探测）',
        '  PET_TOKEN       访问令牌（默认读 ~/.dsh/pet-voice/token）',
        '  PET_HTTP_TOKEN  可选：--http 模式下要求的 Bearer token',
        '',
      ].join('\n'),
    )
    return
  }

  if (wantHttp) {
    startHttp(port)
  } else {
    startStdio()
  }
}

main()
