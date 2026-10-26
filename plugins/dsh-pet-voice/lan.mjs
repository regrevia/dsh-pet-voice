// 纯局域网连法：同一个 WiFi 下手机直接连这台电脑，不用服务器、不用域名、不用证书。
//
// 背景：宿主只监听 127.0.0.1，手机从外面打不开。这里在本机再起一层明文 HTTP，
// 监听 0.0.0.0，只把 App 真正要用的 /pet-voice/api/* 和配对页转给宿主回环端口。
//
// 三道闸：
//   1. 只接受私有网段来源（10/8、172.16/12、192.168/16、链路本地、回环）；
//   2. 只放行 api、配对页、静态资源；/panel/*（含令牌、二维码、配对链接）一律 403，
//      否则同一 WiFi 的别人能走代理读到面板，绕过宿主的回环门禁；
//   3. 业务请求本身还要过插件自己的令牌校验。
import { createServer, request as httpRequest } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { normalizeTarget, isProtectedPath, forwardPath } from './guardPath.mjs'

const DIR = join(homedir(), '.dsh/pet-voice')
const CONFIG_PATH = join(DIR, 'lan.json')
const PREFERRED_PORT = 8480
const PORT_TRIES = 10

const state = {
  server: null,
  port: 0,
  hostPort: 0,
  lastError: '',
  reachable: null, // null=还没探过；false=这台电脑自己都连不上（多半是 VPN 改了路由）
  timer: null,
}

function readPort() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const n = Number(raw?.port)
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n
  } catch {
    /* 没起过 */
  }
  return PREFERRED_PORT
}

function rememberPort(port) {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, `${JSON.stringify({ port }, null, 2)}\n`, 'utf8')
    chmodSync(CONFIG_PATH, 0o600)
  } catch {
    /* 记不住端口不影响这次使用 */
  }
}

/** 这台电脑在局域网里的 IPv4；多网卡取第一个非回环的。 */
export function lanAddress() {
  const found = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const item of list ?? []) {
      if ((item.family === 'IPv4' || item.family === 4) && !item.internal) found.push({ name, address: item.address })
    }
  }
  // 装了 VPN 的机器上，utun 往往排在真网卡前面：先挑 Wi-Fi / 有线，别把 VPN 地址发给手机。
  const physical = found.find((item) => /^(en|eth|wl|wlan)/i.test(item.name))
  return (physical ?? found[0])?.address ?? ''
}

function isPrivate(addr) {
  const ip = String(addr ?? '').replace(/^::ffff:/, '')
  if (!ip) return false
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) return true
  if (ip.startsWith('10.')) return true
  if (ip.startsWith('192.168.')) return true
  if (ip.startsWith('169.254.')) return true
  if (ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) return true
  const m = /^172\.(\d+)\./.exec(ip)
  if (m) {
    const second = Number(m[1])
    return second >= 16 && second <= 31
  }
  return false
}

/**
 * App 用得到的路径才转。判定用 guardPath 的规范形，转发也用同一份结果：
 * 官方 DSH 用 new URL(...).pathname 规范化后路由，这里如果拿原始 URL 判断，
 * `/pet-voice/api/../panel/state`、`%2e%2e` 就能骗过白名单被转成面板请求。
 * 下载（/pet-voice/download/*）要放行：宿主侧 downloadHandler 自己校验文件名，
 * 手机更新 APK 走的就是这条，之前默认模式把它误拒成 403。
 */
export function lanAllowedPath(path) {
  if (path === '/pet-voice') return true
  return path.startsWith('/pet-voice/api/')
    || path.startsWith('/pet-voice/asset/')
    || path === '/pet-voice/download'
    || path.startsWith('/pet-voice/download/')
}

/** 返回 {status:0, target} 表示转发；否则 {status, reason} 表示本地拒绝。 */
export function classifyLanPath(raw) {
  const target = normalizeTarget(raw)
  if (!target) return { status: 400, reason: 'bad path' }
  if (isProtectedPath(target.path)) return { status: 403, reason: 'only lan' }
  if (!lanAllowedPath(target.path)) return { status: 403, reason: 'not found' }
  return { status: 0, target }
}

function plain(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

function handler(req, res) {
  if (!isPrivate(req.socket.remoteAddress)) {
    state.lastError = `拒绝了非局域网来源 ${req.socket.remoteAddress ?? '?'}`
    return plain(res, 403, 'only lan')
  }
  const verdict = classifyLanPath(req.url ?? '/')
  if (verdict.status) return plain(res, verdict.status, verdict.reason === 'only lan' ? 'forbidden' : verdict.reason)
  const target = httpRequest(
    {
      host: '127.0.0.1',
      port: state.hostPort,
      method: req.method,
      path: forwardPath(verdict.target),
      headers: { ...req.headers, host: `127.0.0.1:${state.hostPort}` },
      timeout: 120000,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )
  target.on('error', () => {
    if (!res.headersSent) plain(res, 502, 'bad gateway')
    else res.end()
  })
  req.pipe(target)
}

/**
 * 起监听，幂等：已经在跑就直接返回当前状态。
 * 端口从 8480 起试，被占用就往后挪，挪成功就记住，下次开机还是同一个。
 */
export function startLan({ hostPort } = {}) {
  const port = Number(hostPort) || state.hostPort
  if (!port) return Promise.reject(new Error('拿不到宿主端口'))
  state.hostPort = port
  if (state.server) return Promise.resolve(lanState())

  return new Promise((resolve, reject) => {
    let attempt = 0
    const base = readPort()
    const tryListen = () => {
      const candidate = base + attempt
      if (attempt >= PORT_TRIES) {
        state.lastError = `本机 ${base} 起的 ${PORT_TRIES} 个端口都被占用`
        reject(new Error(state.lastError))
        return
      }
      attempt += 1
      const server = createServer(handler)
      server.on('clientError', (_e, socket) => socket.destroy())
      server.once('error', (e) => {
        server.removeAllListeners()
        if (e?.code === 'EADDRINUSE' || e?.code === 'EACCES') tryListen()
        else {
          state.lastError = `局域网监听起不来（${e?.code ?? e?.message}）`
          reject(new Error(state.lastError))
        }
      })
      server.listen(candidate, '0.0.0.0', () => {
        state.server = server
        state.port = candidate
        state.lastError = ''
        if (candidate !== readPort()) rememberPort(candidate)
        probe()
        if (!state.timer) {
          state.timer = setInterval(probe, 60000)
          state.timer.unref?.()
        }
        resolve(lanState())
      })
    }
    tryListen()
  })
}

/** 自己连一下自己的局域网地址：VPN 劫持路由时，面板别给一个打不开的地址。 */
function probe() {
  const ip = lanAddress()
  if (!state.server || !ip) {
    state.reachable = null
    return
  }
  state.reachable = false
  const socket = connect({ host: ip, port: state.port, timeout: 1200 })
  const done = (ok) => {
    try {
      socket.destroy()
    } catch {
      /* 已经断了 */
    }
    if (ok) state.reachable = true
  }
  socket.once('connect', () => done(true))
  socket.once('timeout', () => done(false))
  socket.once('error', () => done(false))
}

export function lanState() {
  const ip = lanAddress()
  return {
    running: Boolean(state.server),
    port: state.port,
    url: state.server && ip && state.reachable !== false ? `http://${ip}:${state.port}/pet-voice/` : '',
    reachable: state.reachable,
    lastError: state.lastError,
  }
}

export function stopLan() {
  const server = state.server
  state.server = null
  state.port = 0
  state.reachable = null
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  if (!server) return
  try {
    server.close()
  } catch {
    /* 已经关了 */
  }
}
