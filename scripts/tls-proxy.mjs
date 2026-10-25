#!/usr/bin/env node
// 手机自签 https 的落地点：把 https://<本机>:8443/pet-voice/* 反向代理到 http://127.0.0.1:52356。
//
// 为什么需要它：Android 只对 loopback 放明文 http，连局域网/IP 的 http 会被 App 拦掉；
// 又不想买域名 → 本地起一层 https，证书用 scripts/tls-ca.sh 生成的自签 CA，App 里内置这张 CA。
//
//   node scripts/tls-proxy.mjs                       # 127.0.0.1:8443 → 127.0.0.1:52356
//   node scripts/tls-proxy.mjs --bind 0.0.0.0        # 让同一局域网/真机的 IP 也能连（注意暴露面）
//   node scripts/tls-proxy.mjs --port 9443 --upstream 127.0.0.1:52356
//
// 只放行 /pet-voice/*，其它路径 404 —— 它不是通用代理，别拿它开公网。
// SSE 是流式的：响应直接 pipe，不做整体缓冲，所以 /api/ask 的增量回复能原样出来。
import { createServer } from 'node:https'
import { execSync } from 'node:child_process'
import { request } from 'node:http'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const val = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const has = (name) => args.includes(name)

const TLS_DIR = join(homedir(), '.dsh', 'pet-voice', 'tls')
const certPath = val('--cert', join(TLS_DIR, 'pet-leaf.pem'))
const keyPath = val('--key', join(TLS_DIR, 'pet-leaf.key.pem'))
const port = Number(val('--port', '8443'))
const bind = val('--bind', '127.0.0.1')
const upstreamArg = val('--upstream', '')
const prefix = val('--prefix', '/pet-voice')
const quiet = has('--quiet')
const accessLog = val('--access-log', join(TLS_DIR, 'access.jsonl'))

for (const p of [certPath, keyPath]) {
  if (!existsSync(p)) {
    console.error(`缺证书文件：${p}\n先跑：bash scripts/tls-ca.sh --ip <你的IP>`)
    process.exit(1)
  }
}
/**
 * 上游端口不能写死：DSH Web 的端口每次启动都可能变（52356 → 54013 已经发生过一次），
 * 写死之后手机端只会看到「连不上电脑」，用户完全不知道是电脑这边代理指错了地方。
 * 优先用 --upstream，其次用 DSH_WEB_URL，最后把 `dsh web` 实际在听的端口挨个试一遍
 * （/pet-voice/api/pair 不带 cookie 会回 401，能回 401/200 的就是它）。
 */
function envUpstreams () {
  const out = []
  for (const k of ['DSH_WEB_URL', 'DSH_WEB_BASE', 'DSH_URL']) {
    const v = process.env[k]
    if (!v) continue
    try { out.push(new URL(v).host) } catch (e) {}
  }
  return out
}
function listeningPorts () {
  try {
    const out = execSync('lsof -nP -iTCP -sTCP:LISTEN', { encoding: 'utf8', timeout: 4000 })
    const ports = new Set()
    for (const line of out.split('\n')) {
      if (!/\bnode\b/.test(line)) continue
      const m = line.match(/127\.0\.0\.1:(\d+)|\[::1\]:(\d+)/)
      if (m) ports.add(Number(m[1] || m[2]))
    }
    return [...ports]
  } catch (e) { return [] }
}
function probesUpstream (host) {
  return new Promise((resolve) => {
    const [h, p] = host.split(':')
    const req = request({ host: h, port: Number(p || 80), path: `${prefix}/api/pair`, method: 'GET', timeout: 1200 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200 || res.statusCode === 401 || res.statusCode === 403)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}
async function pickUpstream () {
  const seen = []
  const add = (h) => { if (h && !seen.includes(h)) seen.push(h) }
  add(upstreamArg)
  for (const h of envUpstreams()) add(h)
  for (const p of listeningPorts()) add(`127.0.0.1:${p}`)
  add('127.0.0.1:52356')
  for (const h of seen) {
    if (await probesUpstream(h)) return h
  }
  console.error(`找不到 DSH Web 的上游端口，试过：${seen.join(', ') || '（无）'}`)
  console.error('先确认电脑上 DSH 在跑，再重试；或用 --upstream 127.0.0.1:<端口> 指定。')
  process.exit(2)
}
const upstream = await pickUpstream()

const [upHost, upPortRaw] = upstream.split(':')
const upPort = Number(upPortRaw || 80)

const server = createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath), minVersion: 'TLSv1.2' }, (req, res) => {
  const url = req.url || '/'
  const path = url.split('?')[0]
  if (!(path === prefix || path.startsWith(prefix + '/'))) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`只有 ${prefix}/* 会被转发\n`)
    return
  }
  // 访问日志：只记方法/路径/状态/字节，用于核对「检查更新」有没有重复下载
  const t0 = Date.now()
  let sent = 0
  const origWrite = res.write.bind(res)
  res.write = (chunk, ...rest) => {
    if (chunk) sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    return origWrite(chunk, ...rest)
  }
  res.on('finish', () => {
    try {
      appendFileSync(accessLog, JSON.stringify({ ts: new Date().toISOString(), method: req.method, path, status: res.statusCode, bytes: sent, ms: Date.now() - t0 }) + '\n')
    } catch (e) {}
  })
  const headers = { ...req.headers, host: upstream, 'x-forwarded-proto': 'https', 'x-forwarded-for': req.socket.remoteAddress || '' }
  delete headers['content-length'] // 让上游按 chunked/流式处理
  const up = request({ host: upHost, port: upPort, method: req.method, path: url, headers }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers)
    if (typeof res.flushHeaders === 'function') res.flushHeaders() // SSE 要尽快把响应头发出去
    upRes.pipe(res)
  })
  up.on('error', (err) => {
    if (!quiet) console.error(`上游错误：${err.message}`)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('上游不可达（DSH 没开？）\n')
  })
  up.setTimeout(0)
  req.pipe(up)
})
server.setTimeout(0)
server.keepAliveTimeout = 65_000
server.on('error', (err) => {
  console.error(`监听失败 ${bind}:${port} — ${err.message}`)
  process.exit(1)
})
server.listen(port, bind, () => {
  if (!quiet) {
    console.log(`https://${bind === '0.0.0.0' ? '<本机IP>' : bind}:${port}${prefix}/  →  http://${upstream}`)
    console.log(`证书：${certPath}`)
    if (bind !== '127.0.0.1') console.log('⚠️  绑在 0.0.0.0：同一网络的人都能访问，确认你愿意暴露这层')
  }
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
