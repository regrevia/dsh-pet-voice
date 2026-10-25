// 「经我自己的服务器转发」：全部在面板里配，配置只落这台电脑（~/.dsh/pet-voice/public.json，0600）。
//
// 两件事：
//   1. 本机起一层 https（证书用 ~/.dsh/pet-voice/tls/ 里那张），只代理 /pet-voice/*；
//   2. 开一条 ssh -R 隧道，把服务器上的公网端口牵到本机这层 https。
//
// 服务器侧要什么由使用者自己决定：这里的地址/用户名/端口/私钥全部来自面板输入，仓库里没有任何默认值。
import { spawn } from 'node:child_process'
import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, openSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeTarget, isPetVoicePath, isProtectedPath, forwardPath } from './guardPath.mjs'

export const PUBLIC_DIR = join(homedir(), '.dsh/pet-voice')
const CONFIG_PATH = join(PUBLIC_DIR, 'public.json')
const TLS_DIR = join(PUBLIC_DIR, 'tls')
const CA_PATH = join(TLS_DIR, 'pet-ca.pem')
const LEAF_PATH = join(TLS_DIR, 'pet-leaf.pem')
const LEAF_KEY_PATH = join(TLS_DIR, 'pet-leaf.key.pem')

const LOG_LINES = 4
const state = {
  tls: null,        // https.Server
  tlsPort: 0,
  child: null,      // ssh
  since: 0,
  lastLines: [],
  lastError: '',
}

function readConfig() {
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    /* 没配过 */
  }
  return {
    host: String(raw.host ?? '').trim(),
    user: String(raw.user ?? '').trim(),
    sshPort: Number(raw.sshPort) || 22,
    keyPath: String(raw.keyPath ?? '').trim(),
    remotePort: Number(raw.remotePort) || 8443,
    tlsPort: Number(raw.tlsPort) || 8443,
  }
}

function expandPath(p) {
  if (!p) return ''
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function checkPort(value, fallback) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback
  return n
}

export function getPublicConfig() {
  return readConfig()
}

/** 面板保存：只写用户真填了的东西，没填的保持默认。 */
export function setPublicConfig(patch = {}) {
  const next = readConfig()
  if ('host' in patch) {
    const host = String(patch.host ?? '').trim()
    if (host && !/^[A-Za-z0-9._:\-[\]]+$/.test(host)) throw new Error('服务器地址只能填 IP 或域名')
    next.host = host
  }
  if ('user' in patch) {
    const user = String(patch.user ?? '').trim()
    if (user && !/^[A-Za-z0-9._\-]+$/.test(user)) throw new Error('用户名填错了')
    next.user = user
  }
  if ('sshPort' in patch) next.sshPort = checkPort(patch.sshPort, 22)
  if ('remotePort' in patch) next.remotePort = checkPort(patch.remotePort, 8443)
  if ('tlsPort' in patch) next.tlsPort = checkPort(patch.tlsPort, 8443)
  if ('keyPath' in patch) {
    const key = String(patch.keyPath ?? '').trim()
    if (key) {
      const abs = expandPath(key)
      if (!existsSync(abs)) throw new Error('找不到这个私钥文件')
      next.keyPath = abs
    } else {
      next.keyPath = ''
    }
  }
  saveConfig(next)
  return next
}

function saveConfig(cfg) {
  mkdirSync(PUBLIC_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(CONFIG_PATH, 0o600)
  } catch {
    /* 某些文件系统不支持 */
  }
}

function certStatus() {
  if (!existsSync(LEAF_PATH) || !existsSync(LEAF_KEY_PATH)) return { ok: false }
  try {
    const pem = readFileSync(LEAF_PATH, 'utf8')
    const notAfter = /notAfter=([^\n]+)/.exec(pem)?.[1] ?? ''
    return { ok: true, notAfter }
  } catch {
    return { ok: false }
  }
}

/** 公网地址：面板拿它直接当「自建域名」填进去。 */
export function publicUrl(cfg = readConfig()) {
  if (!cfg.host) return ''
  return `https://${cfg.host}:${cfg.remotePort}`
}

export function publicState() {
  const cfg = readConfig()
  return {
    ok: true,
    configured: Boolean(cfg.host && cfg.user),
    host: cfg.host,
    user: cfg.user,
    sshPort: cfg.sshPort,
    remotePort: cfg.remotePort,
    tlsPort: cfg.tlsPort,
    keyPath: cfg.keyPath,
    keyExists: cfg.keyPath ? existsSync(cfg.keyPath) : false,
    url: publicUrl(cfg),
    running: Boolean(state.child && state.tls),
    tunnelRunning: Boolean(state.child),
    tlsRunning: Boolean(state.tls),
    since: state.since,
    cert: certStatus(),
    log: state.lastLines.slice(-LOG_LINES),
    lastError: state.lastError,
  }
}

function note(line) {
  const text = String(line ?? '').trim()
  if (!text) return
  state.lastLines.push(text.slice(0, 300))
  if (state.lastLines.length > LOG_LINES * 3) state.lastLines.splice(0, state.lastLines.length - LOG_LINES)
  // ssh 的报错原文对使用者没意义，翻成能照做的一句话
  if (/Permission denied/i.test(text)) state.lastError = '服务器不认这把私钥'
  else if (/remote port forwarding failed|Administratively prohibited|cannot listen to port/i.test(text)) {
    state.lastError = '服务器的这个端口被占用或不许转发'
  } else if (/Could not resolve hostname|Connection timed out|Connection refused|No route to host/i.test(text)) {
    state.lastError = '连不上服务器'
  } else if (/Host key verification failed/i.test(text)) state.lastError = '服务器指纹变了'
}

/**
 * 入口判定：判定与转发都用 normalizeTarget 的同一个结果。
 * 公网请求是从服务器隧道回环进来的，宿主侧会把来源看成 127.0.0.1，
 * 面板门禁（只查 remoteAddress）在这里已经不起作用——所以面板必须在入口就拒掉。
 */
export function classifyPublicPath(raw) {
  const target = normalizeTarget(raw)
  if (!target) return { status: 400, reason: '路径不合法' }
  if (!isPetVoicePath(target.path)) return { status: 404, reason: '只有 /pet-voice/* 会被转发' }
  if (isProtectedPath(target.path)) return { status: 403, reason: '面板只在这台电脑上打开' }
  return { status: 0, target }
}

function startTls(upstream) {
  const key = readFileSync(LEAF_KEY_PATH)
  const cert = readFileSync(LEAF_PATH)
  const port = readConfig().tlsPort
  const server = createServer({ key, cert })
  server.on('request', (req, res) => {
    const verdict = classifyPublicPath(req.url ?? '/')
    if (verdict.status) {
      res.writeHead(verdict.status, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(verdict.status === 403 ? 'forbidden' : 'not found')
    }
    const target = httpRequest(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: forwardPath(verdict.target),
        headers: { ...req.headers, host: req.headers.host ?? `${upstream.host}:${upstream.port}` },
        timeout: 120000,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    target.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad gateway')
    })
    req.pipe(target)
  })
  server.on('clientError', (_e, socket) => socket.destroy())
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(`本机 ${port} 端口起不来（${e.code ?? e.message}）`)))
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function sshArgs(cfg) {
  const args = ['-N', '-T']
  if (cfg.keyPath) args.push('-i', cfg.keyPath)
  args.push(
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(cfg.sshPort),
    '-R', `0.0.0.0:${cfg.remotePort}:127.0.0.1:${cfg.tlsPort}`,
    cfg.user ? `${cfg.user}@${cfg.host}` : cfg.host,
  )
  return args
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 连：先起本机 https，再开隧道；返回前面那个公网地址。 */
export async function connectPublic({ upstream } = {}) {
  const cfg = readConfig()
  if (!cfg.host) throw new Error('先填服务器地址')
  const cert = certStatus()
  if (!cert.ok) throw new Error('这台电脑还没有证书，先在终端跑 scripts/tls-ca.sh')
  if (!upstream?.host || !upstream?.port) throw new Error('拿不到本机端口')
  await disconnectPublic()
  state.lastError = ''
  state.lastLines = []

  let server
  try {
    server = await startTls({ host: upstream.host, port: Number(upstream.port) })
  } catch (e) {
    state.lastError = String(e?.message ?? e)
    throw e
  }
  state.tls = server
  state.tlsPort = cfg.tlsPort

  const child = spawn('ssh', sshArgs(cfg), { stdio: ['ignore', 'ignore', 'pipe'] })
  state.child = child
  state.since = Date.now()
  let errBuf = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => {
    errBuf += chunk
    const lines = errBuf.split('\n')
    errBuf = lines.pop() ?? ''
    for (const line of lines) note(line)
  })
  // ssh 不在 PATH（ENOENT）时，不注册 error 监听会让整个 Node 进程 exit(1)。
  // 这里只让「公网转发」这一个功能失败，并把原因留给 connectPublic 抛出。
  child.on('error', (error) => {
    if (state.child !== child) return
    state.child = null
    const code = String(error?.code ?? '')
    state.lastError = code === 'ENOENT'
      ? '这台电脑没有 ssh，先在终端装好再连'
      : `ssh 起不来（${code || error?.message || '未知原因'}）`
    note(state.lastError)
  })
  child.on('exit', (code) => {
    if (state.child === child) {
      state.child = null
      if (code) note(`ssh 退出（${code}）`)
    }
  })

  // 隧道是否真起来：等 ssh 安静下来 + 进程没退
  for (let i = 0; i < 40; i += 1) {
    await wait(200)
    if (!state.child) break
    const running = state.child
    if (running && i >= 3 && !errBuf) break
  }
  if (!state.child) {
    await disconnectPublic()
    throw new Error(state.lastError || '隧道没起来')
  }
  return { url: publicUrl(cfg), state: publicState() }
}

export async function disconnectPublic() {
  const child = state.child
  state.child = null
  if (child) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已经没了 */
    }
  }
  const server = state.tls
  state.tls = null
  if (server) await new Promise((resolve) => server.close(() => resolve()))
  state.since = 0
  return publicState()
}

/** 插件卸载/宿主退出时清干净，别留孤儿隧道。 */
export async function stopPublic() {
  await disconnectPublic()
}
