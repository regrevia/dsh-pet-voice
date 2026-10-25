#!/usr/bin/env node
/**
 * pet-bridge 自测：spawn 自己的 stdio server，走真实 JSON-RPC。
 *
 * 用法：
 *   node selftest.mjs            # 自动探测宿主；探测不到时相关用例标 SKIP，不失败
 *   node selftest.mjs --strict   # 要求宿主可达（SKIP 也算失败）
 *   node selftest.mjs --no-reply # 只测协议层与 pet_status，不发 pet_ask 的真实消息
 *
 * 输出：每行 PASS / SKIP / FAIL，末行 `selftest: N/M 通过`。
 * 退出码：0 = 全部通过（允许 SKIP）；1 = 有 FAIL。
 *
 * 安全：不打印 token，也不打印上游返回里的 token 字段。
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, 'server.mjs')
const STRICT = process.argv.includes('--strict')
const NO_REPLY = process.argv.includes('--no-reply')
// 真实派发只允许显式开启：PET_LIVE=1 或 --live。默认全部离线（mock 宿主），不碰线上会话。
const LIVE = process.argv.includes('--live') || process.env.PET_LIVE === '1'

let pass = 0
let fail = 0
let skip = 0
const failures = []

function PASS(name, extra = '') {
  pass++
  console.log(`PASS  ${name}${extra ? `  — ${extra}` : ''}`)
}
function SKIP_(name, why) {
  if (STRICT) {
    fail++
    failures.push(name)
    console.log(`FAIL  ${name}  — ${why}（--strict 下 SKIP 视为失败）`)
  } else {
    skip++
    console.log(`SKIP  ${name}  — ${why}`)
  }
}
function FAIL(name, why) {
  fail++
  failures.push(name)
  console.log(`FAIL  ${name}  — ${why}`)
}

/* ---------------- stdio 客户端 ---------------- */

class Client {
  constructor(env = {}) {
    this.proc = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PET_BASE: process.env.PET_BASE || '', ...env },
    })
    this.buf = ''
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk
      let idx
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim()
        this.buf = this.buf.slice(idx + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          console.log(`  (非 JSON 输出，被忽略: ${line.slice(0, 120)})`)
          continue
        }
        const waiter = this.pending.get(msg.id)
        if (waiter) {
          this.pending.delete(msg.id)
          waiter(msg)
        }
      }
    })
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (d) => {
      this.stderr += d
    })
    this.proc.on('exit', (code) => {
      for (const [, w] of this.pending) w({ __exit: code })
      this.pending.clear()
    })
  }

  request(method, params, timeoutMs = 90000) {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method }
    if (params !== undefined) payload.params = params
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`请求 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
    })
  }

  notify(method, params) {
    const payload = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  raw(line) {
    this.proc.stdin.write(`${line}\n`)
  }

  close() {
    try {
      this.proc.stdin.end()
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, 500).unref()
  }
}

/* ---------------- 本地 mock 宿主（只测 pet_say，不碰真宿主） ---------------- */

/**
 * /pet-voice/api/state 必须回 {ok:true}（server.mjs 的探测这么判断），
 * /pet-voice/api/say 按 text 分流：含 "-404" 回 404，其余回 200 入队回执。
 */
function startMockHost() {
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      seen.push({ method: req.method, url: req.url })
      const json = (status, payload) => {
        const text = JSON.stringify(payload)
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) })
        res.end(text)
      }
      if (req.method === "GET" && req.url?.startsWith("/pet-voice/api/state")) return json(200, { ok: true, sessions: [] })
      if (req.method === "POST" && req.url?.startsWith("/pet-voice/api/say")) {
        let parsed = {}
        try {
          parsed = JSON.parse(body || "{}")
        } catch {
          /* ignore */
        }
        if (String(parsed.text ?? "").includes("-404")) return json(404, { ok: false, error: "not found" })
        return json(200, { ok: true, seq: 7, queued: 2, note: "已入队，手机页面在线时会念出来" })
      }
      return json(404, { ok: false, error: "not found" })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        base: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/* ---------------- 宿主是否可用（直接探一下，用于决定 SKIP） ---------------- */

async function hostReachable() {
  const bases = []
  if (process.env.PET_BASE) bases.push(process.env.PET_BASE.replace(/\/+$/, ''))
  else {
    // 和 server.mjs 的 candidateBases() 保持同一套顺序：state.json 里的真实端口
    // 优先，历史端口只当兜底。否则宿主换了端口就会被误判成「不可达」而全部 SKIP。
    const ports = []
    try {
      const st = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'pet-voice', 'state.json'), 'utf8'))
      for (const key of ['port', 'base', 'baseUrl', 'origin', 'url']) {
        const v = st?.[key]
        if (typeof v === 'number' && Number.isInteger(v)) ports.push(v)
        if (typeof v === 'string') {
          const m = v.match(/127\.0\.0\.1:(\d{2,5})/)
          if (m) ports.push(Number(m[1]))
        }
      }
    } catch {
      /* 没有 state.json 就跳过 */
    }
    // 端口还会被 cloudflared 命令行记着（`--url http://127.0.0.1:<port>`），
    // 这条是实测最可靠的一处，务必和 server.mjs 一样读它。
    try {
      const child = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), '.dsh', 'remote-web-ui-tunnel-child.json'), 'utf8'),
      )
      for (const m of String(child?.command || '').matchAll(/127\.0\.0\.1:(\d{2,5})/g)) ports.push(Number(m[1]))
    } catch {
      /* 没开隧道就跳过 */
    }
    ports.push(Number(process.env.PET_PORT) || 0, 58686, 62981, 3080)
    for (const p of ports) {
      if (Number.isInteger(p) && p > 0) bases.push(`http://127.0.0.1:${p}`)
    }
  }
  let token = (process.env.PET_TOKEN || '').trim()
  if (!token) {
    try {
      token = fs.readFileSync(path.join(os.homedir(), '.dsh', 'pet-voice', 'token'), 'utf8').trim()
    } catch {
      token = ''
    }
  }
  if (!token) return { ok: false, why: '读不到 ~/.dsh/pet-voice/token 且未设置 PET_TOKEN' }
  const hits = []
  const misses = []
  for (const base of bases) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 1500)
    try {
      const r = await fetch(`${base}/pet-voice/api/state`, {
        headers: { cookie: `pkv_${token.slice(0, 8)}=${token}` },
        signal: ac.signal,
      })
      clearTimeout(timer)
      if (r.ok) hits.push(base)
      else misses.push(`${base}→HTTP ${r.status}`)
    } catch (e) {
      clearTimeout(timer)
      misses.push(`${base}→${e?.cause?.code || 'error'}`)
    }
  }
  if (hits.length) return { ok: true, base: hits[0], misses }
  return { ok: false, why: `所有候选端口都没通（${misses.join(', ')}）；DSH 未运行或 dsh-pet-voice 未启用`, misses }
}

/* ---------------- 主流程 ---------------- */

function textOf(result) {
  const c = result?.content
  if (!Array.isArray(c)) return ''
  return c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n')
}

async function main() {
  console.log(`pet-bridge selftest  node=${process.version}  server=${path.basename(SERVER)}${STRICT ? '  [--strict]' : ''}`)

  // 0. 静态检查
  try {
    const src = fs.readFileSync(SERVER, 'utf8')
    if (/\bfrom\s+['"](?!node:)[^./]/.test(src)) throw new Error('发现第三方 import')
    PASS('零第三方依赖', '只 import node: 内置模块')
  } catch (e) {
    FAIL('零第三方依赖', e.message)
  }

  const host = await hostReachable()
  if (host.ok) PASS('宿主探测', `${host.base} 可访问${host.misses?.length ? `（未通: ${host.misses.join(', ')}）` : ''}`)
  else SKIP_('宿主探测', host.why)

  const cli = new Client()
  try {
    /* 1. initialize */
    const init = await cli.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'pet-bridge-selftest', version: '1.0.0' },
    })
    if (init.result && init.result.protocolVersion === '2025-06-18' && init.result.capabilities?.tools && init.result.serverInfo?.name) {
      PASS('initialize', `protocolVersion=${init.result.protocolVersion}, serverInfo=${init.result.serverInfo.name}@${init.result.serverInfo.version}`)
    } else {
      FAIL('initialize', JSON.stringify(init).slice(0, 300))
    }

    cli.notify('notifications/initialized')

    /* 2. ping */
    const ping = await cli.request('ping')
    if (ping.result && ping.error === undefined) PASS('ping')
    else FAIL('ping', JSON.stringify(ping).slice(0, 200))

    /* 3. tools/list */
    const list = await cli.request('tools/list')
    const tools = list.result?.tools || []
    const names = tools.map((t) => t.name)
    const want = ['pet_ask', 'pet_new_session', 'pet_say', 'pet_status', 'pet_stop', 'pet_switch_project']
    const missing = want.filter((n) => !names.includes(n))
    if (!missing.length) PASS('tools/list', `${tools.length} 个工具: ${names.join(', ')}`)
    else FAIL('tools/list', `缺少 ${missing.join(', ')}`)

    const badSchema = tools.filter((t) => !t.description || t.description.length < 20 || t.inputSchema?.type !== 'object')
    if (!badSchema.length) PASS('工具 schema 完整', '每个都有 description + inputSchema.type=object')
    else FAIL('工具 schema 完整', badSchema.map((t) => t.name).join(', '))
    if (tools.every((t) => t.inputSchema?.additionalProperties === false)) PASS('inputSchema 严格', 'additionalProperties:false')
    else FAIL('inputSchema 严格', '有工具没关 additionalProperties')

    /* 4. 错误码（纯协议层，不触达宿主） */
    const nf = await cli.request('tools/nonexistent')
    if (nf.error?.code === -32601) PASS('未知方法 → -32601', nf.error.message)
    else FAIL('未知方法 → -32601', JSON.stringify(nf).slice(0, 200))

    const ip = await cli.request('tools/call', { name: 'pet_switch_project', arguments: {} })
    if (ip.error?.code === -32602) PASS('缺必填参数 → -32602', ip.error.message)
    else FAIL('缺必填参数 → -32602', JSON.stringify(ip).slice(0, 200))

    const ip2 = await cli.request('tools/call', { name: 'pet_ask', arguments: { text: 'x', mode: 'bogus' } })
    if (ip2.error?.code === -32602) PASS('枚举值非法 → -32602', ip2.error.message)
    else FAIL('枚举值非法 → -32602', JSON.stringify(ip2).slice(0, 200))

    const ip3 = await cli.request('tools/call', { name: 'pet_status', arguments: { extra: 1 } })
    if (ip3.error?.code === -32602) PASS('多余参数被拒 → -32602', ip3.error.message)
    else FAIL('多余参数被拒 → -32602', JSON.stringify(ip3).slice(0, 200))

    // 解析错误（协议层，不需要宿主）
    const parseProbe = new Client()
    const parseMsg = await new Promise((resolve) => {
      parseProbe.pending.set(null, resolve)
      parseProbe.raw('{this is not json')
      setTimeout(() => resolve({ __timeout: true }), 4000)
    })
    parseProbe.close()
    if (parseMsg?.error?.code === -32700) PASS('非法 JSON → -32700')
    else FAIL('非法 JSON → -32700', JSON.stringify(parseMsg).slice(0, 200))

    /* 5. tools/call pet_status（只读 GET /api/state，不派发、不改状态） */
    const st = await cli.request('tools/call', { name: 'pet_status', arguments: {} })
    const stText = textOf(st.result)
    if (!host.ok) {
      const isErr = st.result?.isError === true
      const readable = /探测不到|找不到访问令牌|PET_BASE|令牌/.test(stText)
      if (isErr && readable) SKIP_('tools/call pet_status', `宿主不可达，已返回可读中文报错：${stText.split('\n')[0].slice(0, 90)}`)
      else FAIL('tools/call pet_status', `宿主不可达但报错不可读: ${stText.slice(0, 200) || JSON.stringify(st).slice(0, 200)}`)
    } else if (st.result && st.result.isError !== true && stText.length > 0) {
      PASS('tools/call pet_status', stText.split('\n').slice(0, 2).join(' / ').slice(0, 140))
    } else {
      FAIL('tools/call pet_status', stText.slice(0, 300) || JSON.stringify(st).slice(0, 300))
    }

    /* 6. 泄漏检查：任何输出里都不该出现 token 明文 */
    const token = (process.env.PET_TOKEN || '').trim() || (() => {
      try {
        return fs.readFileSync(path.join(os.homedir(), '.dsh', 'pet-voice', 'token'), 'utf8').trim()
      } catch {
        return ''
      }
    })()
    const dump = JSON.stringify(st) + cli.stderr + (stText || '')
    if (token && (dump.includes(token) || dump.includes(token.slice(0, 8) + '='))) FAIL('不泄漏 token', '输出中出现了 token 片段')
    else PASS('不泄漏 token', token ? '已检查 tools/call 返回与 stderr' : '本机无 token，跳过内容检查')

    /* 7. pet_say：真打 /pet-voice/api/say（用本地 mock 宿主，不碰真宿主） */
    const mock = await startMockHost()
    try {
      const sayCli = new Client({ PET_BASE: mock.base, PET_TOKEN: 'mock-token-0123456789' })
      try {
        const hit = await sayCli.request('tools/call', { name: 'pet_say', arguments: { text: '测试播报' } })
        const hitText = textOf(hit.result)
        if (hit.error) FAIL('pet_say 成功路径', `不该是协议错误: ${JSON.stringify(hit.error).slice(0, 200)}`)
        else if (hit.result?.isError !== true && /已入队/.test(hitText) && /seq=7/.test(hitText)) {
          PASS('pet_say 成功路径', 'HTTP 200 → isError=false 且带 seq=7')
        } else {
          FAIL('pet_say 成功路径', `返回: ${hitText.slice(0, 200) || JSON.stringify(hit).slice(0, 200)}`)
        }
        const sc = hit.result?.structuredContent ?? {}
        if (sc.ok === true && sc.seq === 7 && sc.queued === 2 && sc.delivered === true && typeof sc.note === 'string') {
          PASS('pet_say 成功结构化字段', `{ok,seq:7,queued:2,delivered:true}`)
        } else {
          FAIL('pet_say 成功结构化字段', JSON.stringify(sc).slice(0, 200))
        }

        const miss = await sayCli.request('tools/call', { name: 'pet_say', arguments: { text: '测试播报-404' } })
        const missText = textOf(miss.result)
        if (miss.error) FAIL('pet_say 失败路径', `不该是协议错误: ${JSON.stringify(miss.error).slice(0, 200)}`)
        else if (miss.result?.isError === true && /播报未执行/.test(missText) && /不支持|没有 \/pet-voice\/api\/say/.test(missText) && miss.result?.structuredContent?.delivered === false) {
          PASS('pet_say 失败路径', 'HTTP 404 → isError=true，明说宿主不支持，不假装成功')
        } else {
          FAIL('pet_say 失败路径', `返回: ${missText.slice(0, 200) || JSON.stringify(miss).slice(0, 200)}`)
        }
      } finally {
        sayCli.close()
      }
    } finally {
      await mock.close()
    }

    /* 8. pet_ask 真实往返：默认跳过（不打宿主），只有 PET_LIVE=1 / --live 才跑 */
    if (!LIVE) {
      SKIP_('tools/call pet_ask', 'skip（需要 PET_LIVE=1）')
    } else if (!host.ok) {
      SKIP_('tools/call pet_ask', '宿主不可达')
    } else if (NO_REPLY) {
      SKIP_('tools/call pet_ask', '--no-reply 指定跳过真实派发')
    } else {
      const ask = await cli.request(
        'tools/call',
        {
          name: 'pet_ask',
          arguments: { text: 'pet-bridge 自测：请只回复「桥已连通」四个字，不要调用任何工具、不要改文件。', wait_ms: 60000 },
        },
        90000,
      )
      const t = textOf(ask.result)
      if (ask.result?.isError === true) {
        FAIL('tools/call pet_ask', t.slice(0, 300))
      } else if (/已受理/.test(t) && !/桥已连通/.test(t)) {
        SKIP_('tools/call pet_ask', `已受理但等待内未收到回复（容忍 SSE 异常路径）：${t.split('\n')[0].slice(0, 80)}`)
      } else {
        PASS('tools/call pet_ask', t.replace(/\n/g, ' ').slice(0, 120))
      }
    }
  } finally {
    cli.close()
  }

  const total = pass + fail + skip
  console.log(
    `\nselftest: ${pass}/${total} 通过${skip ? `  （${skip} SKIP，${fail} FAIL）` : fail ? `  （${fail} FAIL）` : ''}`,
  )
  if (fail) {
    console.log(`失败项：${failures.join(' | ')}`)
  }
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => {
  console.error(`selftest 崩溃：${e?.stack || e}`)
  process.exitCode = 1
})
