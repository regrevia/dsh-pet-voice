#!/usr/bin/env node
/**
 * scripts/test-asr-update.mjs —— 「服务端 ASR + APK 更新通道」的离线自检。
 *
 * 不启动 DSH、不需要真宿主：用假 ctx 把真插件 apply() 起来，路由挂到本进程内的
 * 真 http server 上，然后像手机一样打请求。覆盖的是真机上最容易翻车的点：
 *   鉴权、懒启动（冷启动预算）、worker 崩了能不能自愈、Range 断点续传、
 *   路径穿越、latest.json 的 sha256 是否和文件一致。
 *
 * 跑法：
 *   node scripts/test-asr-update.mjs
 *
 * 顺带约定：
 *   - 更新目录用临时目录（DSH_PET_UPDATE_DIR），绝不碰 ~/.dsh/pet-voice/update；
 *   - ASR worker 用随机空闲端口（DSH_PET_ASR_PORT），不跟日常在跑的那个抢 52399；
 *   - token 只读不打印，失败信息里也只出现前 8 位提示。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ENTRY = join(REPO_ROOT, 'plugins', 'dsh-pet-voice', 'index.js')
const PUBLISH_SCRIPT = join(REPO_ROOT, 'scripts', 'publish-apk.mjs')
const ASR_SCRIPT = join(REPO_ROOT, 'scripts', 'asr-worker.py')
const ASR_PYTHON = join(homedir(), '.dsh', 'pet-voice', 'asr-venv', 'bin', 'python')
const TOKEN_PATH = join(homedir(), '.dsh', 'pet-voice', 'token')
const DIST_APK = join(REPO_ROOT, 'dist', 'jingling-0.2.2.apk')

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'pet-asr-update-'))
const UPDATE_DIR = join(TMP_ROOT, 'update')
const AUTO_DIR = join(TMP_ROOT, 'auto')
mkdirSync(UPDATE_DIR, { recursive: true })

const results = []
let skipped = 0

function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition), detail })
  console.log(`${condition ? '✓' : '✗'} ${label}${condition ? '' : `  ← ${detail ?? ''}`}`)
}

function skip(label, why) {
  skipped += 1
  console.log(`- ${label}（跳过：${why}）`)
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const sha256File = (path) => sha256(readFileSync(path))

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createNetServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })
}

async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((done) => setTimeout(done, intervalMs))
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 假 ctx：只实现插件真正用到的四个能力                                */
/* ------------------------------------------------------------------ */

const routes = []
const listeners = new Map()
let origin = 'http://127.0.0.1:0'

const services = {
  sessionController: {
    list: async () => [],
    create: async () => ({ sessionId: 'sess-test', title: 'test' }),
    prompt: async () => ({ accepted: true }),
    cancel: () => ({ cancelled: true }),
  },
  workspaceRegistry: {
    list: () => [{ id: 'ws-pet', title: 'Pet', path: REPO_ROOT }],
  },
  agentPresets: { list: async () => [{ id: 'default', title: '默认' }] },
}

const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
    getOrigin: () => origin,
  },
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
    return () => listeners.get(type)?.delete(fn)
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get: (name) => services[name],
}

/* ------------------------------------------------------------------ */

function runPublish(args) {
  const result = spawnSync(process.execPath, [PUBLISH_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal,
  }
}

/** 原始 POST：413 那条用例要能只发头不发体，fetch 做不到。 */
function rawPost(port, path, headers, body = Buffer.alloc(0)) {
  return new Promise((resolveResult) => {
    let settled = false
    const finish = (value) => {
      if (!settled) {
        settled = true
        resolveResult(value)
      }
    }
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', () => finish({ status: res.statusCode ?? 0, headers: res.headers ?? {}, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(15_000, () => {
      req.destroy()
      finish({ status: 0, headers: {}, body: '', timeout: true })
    })
    req.on('error', (error) => finish({ status: 0, headers: {}, body: '', error: String(error?.code ?? error) }))
    req.end(body)
  })
}

/** 用 macOS 自带 TTS 造一句中文 WAV（16 kHz 单声道 s16le）。 */
function makeSpeechWav(targetPath) {
  const aiff = join(TMP_ROOT, 'speech.aiff')
  execFileSync('say', ['-v', 'Tingting', '-o', aiff, '鲸灵，帮我看看今天天气怎么样？'], { timeout: 60_000 })
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', targetPath], {
    timeout: 60_000,
  })
  return statSync(targetPath).size
}

/* ------------------------------------------------------------------ */

async function main() {
  const asrPort = await freePort()
  // 必须在 import 插件之前设好：这两个常量在模块顶层读取。
  process.env.DSH_PET_UPDATE_DIR = UPDATE_DIR
  process.env.DSH_PET_ASR_PORT = String(asrPort)
  const { apply } = await import(PLUGIN_ENTRY)

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      const hit = route.kind === 'exact' ? url.pathname === route.path : url.pathname.startsWith(route.path)
      if (!hit) continue
      Promise.resolve(route.handler(req, res)).catch((error) => {
        if (!res.headersSent) res.writeHead(500)
        res.end(String(error))
      })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no route')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${server.address().port}`
  apply(ctx)

  /* token 是惰性生成的：先打一次页面，再读文件（只读不打印）。 */
  await fetch(`${origin}/pet-voice/`).catch(() => {})
  const token = existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, 'utf8').trim() : ''
  if (!token) throw new Error('拿不到 token：~/ .dsh/pet-voice/token 没有生成')
  const cookie = `pkv_${token.slice(0, 8)}=${encodeURIComponent(token)}`
  const authed = (path, init = {}) =>
    fetch(`${origin}${path}`, {
      ...init,
      headers: { cookie, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    })

  /* 0. 鉴权：三条新入口都必须和别的接口一样先问 cookie */
  for (const [method, path] of [
    ['GET', '/pet-voice/api/update'],
    ['GET', '/pet-voice/api/asr'],
    ['GET', '/pet-voice/download/jingling-0.3.0.apk'],
  ]) {
    const res = await fetch(`${origin}${path}`, { method, signal: AbortSignal.timeout(10_000) })
    const body = await res.json().catch(() => ({}))
    check(`${method} ${path} 无 cookie → 401`, res.status === 401 && body.error === 'unauthorized', `${res.status} ${JSON.stringify(body)}`)
  }

  /* 1. 还没发布：versionCode 0，不报错 */
  const empty = await authed('/pet-voice/api/update')
  const emptyJson = await empty.json()
  check('没发布过 → {ok:true,versionCode:0}', empty.status === 200 && emptyJson.ok === true && emptyJson.versionCode === 0, JSON.stringify(emptyJson))

  /* 2. 发布脚本：显式版本号 + 自动探测两种都走一遍 */
  const source03 = join(TMP_ROOT, 'jingling-0.3.0.apk')
  copyFileSync(DIST_APK, source03)
  const expectedSha = sha256File(source03)
  const published = runPublish([
    source03,
    '--notes',
    '自测发布：验证更新通道',
    '--version-code',
    '5',
    '--version-name',
    '0.3.0',
    '--dir',
    UPDATE_DIR,
  ])
  check('publish-apk.mjs 显式版本号 → 退出码 0', published.code === 0, published.stderr.slice(0, 300))

  const metaPath = join(UPDATE_DIR, 'latest.json')
  let meta = null
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (error) {
    check('latest.json 可解析', false, String(error))
  }
  if (meta) {
    const sizeOk = meta.size === statSync(source03).size
    const shaOk = meta.sha256 === expectedSha
    const fileOk = meta.file === 'jingling-0.3.0.apk' && existsSync(join(UPDATE_DIR, meta.file))
    check('latest.json: versionCode/versionName', meta.versionCode === 5 && meta.versionName === '0.3.0', JSON.stringify(meta))
    check('latest.json: size 等于真文件大小', sizeOk, `${meta.size}`)
    check('latest.json: sha256 等于真文件哈希', shaOk, `${meta.sha256}`)
    check('latest.json: file 指向目录里真存在的 APK', fileOk, `${meta.file}`)
    check('latest.json: notes / publishedAt 可读', meta.notes.includes('自测') && !Number.isNaN(Date.parse(meta.publishedAt)), JSON.stringify({ notes: meta.notes, at: meta.publishedAt }))
    check('latest.json: 没有残留 .tmp 文件', readdirSync(UPDATE_DIR).every((name) => !name.includes('.tmp')), readdirSync(UPDATE_DIR).join(','))
  }

  const source022 = join(TMP_ROOT, 'jingling-0.2.2.apk')
  copyFileSync(DIST_APK, source022)
  const auto = runPublish([source022, '--dir', AUTO_DIR])
  let autoMeta = null
  try {
    autoMeta = JSON.parse(readFileSync(join(AUTO_DIR, 'latest.json'), 'utf8'))
  } catch {
    autoMeta = null
  }
  if (auto.code === 0 && autoMeta) {
    check(
      'publish-apk.mjs 自动探测版本（aapt2/apktool）→ 0.2.2 / code 4',
      autoMeta.versionCode === 4 && autoMeta.versionName === '0.2.2',
      JSON.stringify(autoMeta),
    )
    check('自动探测的来源写进了输出', /aapt2|aapt|apktool/.test(auto.stdout), auto.stdout.split('\n')[0])
  } else {
    skip('publish-apk.mjs 自动探测版本', auto.stderr.split('\n')[0] || '本机没有 aapt2/apktool')
  }

  const missing = runPublish([join(TMP_ROOT, '不存在.apk'), '--dir', UPDATE_DIR])
  check('publish-apk.mjs 找不到 APK → 非 0 退出并给出原因', missing.code !== 0 && /找不到 APK/.test(missing.stderr), missing.stderr.slice(0, 200))

  /* 3. /api/update 把 latest.json 原样给出，只补一个相对 url */
  const updateRes = await authed('/pet-voice/api/update')
  const updateJson = await updateRes.json()
  check(
    '/api/update 回 versionCode 5 + url',
    updateRes.status === 200 && updateJson.versionCode === 5 && updateJson.url === '/pet-voice/download/jingling-0.3.0.apk',
    JSON.stringify(updateJson),
  )
  check('/api/update 带上 sha256/size/notes/file', updateJson.sha256 === expectedSha && updateJson.size === statSync(source03).size && updateJson.file === 'jingling-0.3.0.apk', JSON.stringify({ sha: updateJson.sha256, size: updateJson.size }))
  check(
    '/api/update 之后补挂了该文件的 exact 下载路由',
    routes.some((route) => route.kind === 'exact' && route.path === '/pet-voice/download/jingling-0.3.0.apk'),
    routes.filter((route) => route.path.startsWith('/pet-voice/download')).map((route) => `${route.kind}:${route.path}`).join(' '),
  )

  /* 4. 下载：整文件 + Range + HEAD + 各种坏请求 */
  const sourceBytes = readFileSync(source03)
  const total = sourceBytes.length
  const downloadUrl = `${origin}/pet-voice/download/jingling-0.3.0.apk`

  const fullRes = await authed('/pet-voice/download/jingling-0.3.0.apk')
  const fullBytes = Buffer.from(await fullRes.arrayBuffer())
  check(
    '下载整文件 → 200 + APK MIME + 长度一致',
    fullRes.status === 200 &&
      fullRes.headers.get('content-type') === 'application/vnd.android.package-archive' &&
      Number(fullRes.headers.get('content-length')) === total,
    `${fullRes.status} ${fullRes.headers.get('content-type')} ${fullRes.headers.get('content-length')}/${total}`,
  )
  check('下载内容 sha256 与发布一致', sha256(fullBytes) === expectedSha, sha256(fullBytes))
  check('下载声明 accept-ranges: bytes', fullRes.headers.get('accept-ranges') === 'bytes', fullRes.headers.get('accept-ranges'))

  const rangeRes = await fetch(downloadUrl, { headers: { cookie, range: 'bytes=0-99' }, signal: AbortSignal.timeout(15_000) })
  const rangeBytes = Buffer.from(await rangeRes.arrayBuffer())
  check(
    'Range bytes=0-99 → 206 + content-range + 100 字节',
    rangeRes.status === 206 && rangeRes.headers.get('content-range') === `bytes 0-99/${total}` && rangeBytes.length === 100 && rangeBytes.equals(sourceBytes.subarray(0, 100)),
    `${rangeRes.status} ${rangeRes.headers.get('content-range')} ${rangeBytes.length}`,
  )

  const tailRes = await fetch(downloadUrl, { headers: { cookie, range: `bytes=${total - 16}-` }, signal: AbortSignal.timeout(15_000) })
  const tailBytes = Buffer.from(await tailRes.arrayBuffer())
  check(
    'Range bytes=(size-16)- → 206 且是文件末尾 16 字节',
    tailRes.status === 206 && tailBytes.length === 16 && tailBytes.equals(sourceBytes.subarray(total - 16)),
    `${tailRes.status} ${tailBytes.length}`,
  )

  const suffixRes = await fetch(downloadUrl, { headers: { cookie, range: 'bytes=-8' }, signal: AbortSignal.timeout(15_000) })
  const suffixBytes = Buffer.from(await suffixRes.arrayBuffer())
  check('Range bytes=-8 → 206 + 末尾 8 字节', suffixRes.status === 206 && suffixBytes.equals(sourceBytes.subarray(total - 8)), `${suffixRes.status} ${suffixBytes.length}`)

  const badRange = await fetch(downloadUrl, { headers: { cookie, range: `bytes=${total + 10}-` }, signal: AbortSignal.timeout(15_000) })
  check('越界 Range → 416 + bytes */size', badRange.status === 416 && badRange.headers.get('content-range') === `bytes */${total}`, `${badRange.status} ${badRange.headers.get('content-range')}`)

  const headRes = await fetch(downloadUrl, { method: 'HEAD', headers: { cookie }, signal: AbortSignal.timeout(15_000) })
  check('HEAD → 200 + 正确 content-length', headRes.status === 200 && Number(headRes.headers.get('content-length')) === total, `${headRes.status} ${headRes.headers.get('content-length')}`)

  const traversal = await fetch(`${origin}/pet-voice/download/..%2f..%2fpackage.json`, { headers: { cookie }, signal: AbortSignal.timeout(15_000) })
  check('路径穿越 ..%2f..%2f → 400/404 且不回文件', traversal.status === 400 || traversal.status === 404, `${traversal.status}`)

  const notFound = await fetch(`${origin}/pet-voice/download/jingling-9.9.9.apk`, { headers: { cookie }, signal: AbortSignal.timeout(15_000) })
  check('不存在的 APK → 404', notFound.status === 404, `${notFound.status}`)

  const postDownload = await fetch(downloadUrl, { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(15_000) })
  check('下载路由 POST → 405', postDownload.status === 405, `${postDownload.status}`)

  /* 5. ASR：探针 → 空 body → 冷启动 → 识别 → 坏音频 → 超大 body */
  const asrReady = existsSync(ASR_PYTHON) && existsSync(ASR_SCRIPT)
  if (!asrReady) {
    skip('ASR 全部用例', `缺 ${ASR_PYTHON} 或 ${ASR_SCRIPT}`)
  } else {
    const probe = await authed('/pet-voice/api/asr')
    const probeJson = await probe.json()
    check('GET /api/asr → ready:true（还没被调用，running:false）', probe.status === 200 && probeJson.ok === true && probeJson.ready === true && probeJson.running === false, JSON.stringify(probeJson))

    const emptyBody = await fetch(`${origin}/pet-voice/api/asr`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(0),
      signal: AbortSignal.timeout(15_000),
    })
    const emptyJson = await emptyBody.json()
    check(
      '空 body → 200 {ok:true,text:""} 且不拉起 worker',
      emptyBody.status === 200 && emptyJson.ok === true && emptyJson.text === '' && emptyBody.headers.get('x-asr-ms') === '0',
      `${emptyBody.status} ${JSON.stringify(emptyJson)}`,
    )

    const wavPath = join(TMP_ROOT, 'speech.wav')
    let wavBytes = null
    try {
      makeSpeechWav(wavPath)
      wavBytes = readFileSync(wavPath)
    } catch (error) {
      skip('ASR 识别用例', `造不出中文 WAV：${String(error?.message ?? error).slice(0, 120)}`)
    }
    if (wavBytes) {
      const startedAt = Date.now()
      const asrRes = await fetch(`${origin}/pet-voice/api/asr`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/octet-stream' },
        body: wavBytes,
        signal: AbortSignal.timeout(120_000),
      })
      const asrJson = await asrRes.json()
      const coldMs = Date.now() - startedAt
      check('首次识别（含冷启动）→ 200 ok:true 且文本非空', asrRes.status === 200 && asrJson.ok === true && String(asrJson.text ?? '').length > 0, `${asrRes.status} ${JSON.stringify(asrJson).slice(0, 200)}`)
      check(`识别结果含「天气」（原文：${String(asrJson.text ?? '').slice(0, 40)}）`, String(asrJson.text ?? '').includes('天气'), asrJson.text)
      check('响应带 X-Asr-Ms 且是数字', /^\d+$/.test(String(asrRes.headers.get('x-asr-ms'))), asrRes.headers.get('x-asr-ms'))
      console.log(`  · 首次识别总耗时 ${coldMs} ms（含懒启动）`)

      const warmAt = Date.now()
      const warmRes = await fetch(`${origin}/pet-voice/api/asr`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/octet-stream' },
        body: wavBytes,
        signal: AbortSignal.timeout(120_000),
      })
      const warmJson = await warmRes.json()
      check('第二次识别（热）→ 200 且同样含「天气」', warmRes.status === 200 && warmJson.ok === true && String(warmJson.text ?? '').includes('天气'), JSON.stringify(warmJson).slice(0, 200))
      console.log(`  · 热识别总耗时 ${Date.now() - warmAt} ms`)

      const running = await (await authed('/pet-voice/api/asr')).json()
      check('GC 后探针 running:true 且给出 pid', running.running === true && Number.isInteger(running.pid), JSON.stringify(running))
      const firstPid = running.pid

      /* worker 被杀掉后：第一次请求应该自动重新拉起，并由手机那一侧照常拿到结果 */
      if (Number.isInteger(firstPid)) {
        try {
          process.kill(firstPid, 'SIGTERM')
        } catch {
          /* 已经没了也算过 */
        }
        const gone = await waitFor(async () => {
          try {
            await fetch(`http://127.0.0.1:${asrPort}/health`, { signal: AbortSignal.timeout(300) })
            return false
          } catch {
            return true
          }
        }, 10_000)
        check('SIGTERM 后 worker 真的退出（端口静默）', gone, `pid ${firstPid}`)

        const revived = await fetch(`${origin}/pet-voice/api/asr`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/octet-stream' },
          body: wavBytes,
          signal: AbortSignal.timeout(120_000),
        })
        const revivedJson = await revived.json()
        check('worker 崩了 → 自动重启并把这次请求跑完', revived.status === 200 && revivedJson.ok === true && String(revivedJson.text ?? '').includes('天气'), `${revived.status} ${JSON.stringify(revivedJson).slice(0, 200)}`)
        const afterRestart = await (await authed('/pet-voice/api/asr')).json()
        check('重启后是新的 pid', Number.isInteger(afterRestart.pid) && afterRestart.pid !== firstPid, `${afterRestart.pid} vs ${firstPid}`)
      } else {
        skip('worker 崩溃自愈用例', '探针没拿到 pid')
      }

      const garbage = await fetch(`${origin}/pet-voice/api/asr`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/octet-stream' },
        body: Buffer.from('这不是 wav'),
        signal: AbortSignal.timeout(30_000),
      })
      const garbageJson = await garbage.json()
      check(
        '坏音频 → 200 但 ok:false（worker 不崩）',
        garbage.status === 200 && garbageJson.ok === false && /WAV/.test(String(garbageJson.error ?? '')),
        `${garbage.status} ${JSON.stringify(garbageJson)}`,
      )

      const big = await rawPost(server.address().port, '/pet-voice/api/asr', {
        cookie,
        'content-length': String(4 * 1024 * 1024 + 1),
        'content-type': 'application/octet-stream',
      })
      check('body 超过 4 MB → 413（不读体直接拒）', big.status === 413, `${big.status} ${big.body.slice(0, 120)}`)

      const afterGarbage = await (await authed('/pet-voice/api/asr')).json()
      check('坏请求之后 worker 还活着（探针 running:true）', afterGarbage.running === true, JSON.stringify(afterGarbage))
    }
  }

  /* 6. 收尾：杀掉自测拉起的 worker，别在后台留进程 */
  const finalProbe = await authed('/pet-voice/api/asr').then((res) => res.json()).catch(() => ({}))
  if (Number.isInteger(finalProbe.pid)) {
    try {
      process.kill(finalProbe.pid, 'SIGTERM')
    } catch {
      /* 已经没了 */
    }
  }
  server.closeAllConnections?.()
  await new Promise((done) => server.close(done))
}

try {
  await main()
} catch (error) {
  check('自测过程未抛异常', false, String(error?.stack ?? error).slice(0, 400))
} finally {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
  const failed = results.filter((item) => !item.ok)
  console.log(`\n${failed.length ? '✗' : '✓'} test-asr-update: ${results.length - failed.length}/${results.length} 通过${skipped ? `，跳过 ${skipped} 项` : ''}`)
  if (failed.length) {
    for (const item of failed) console.log(`  ✗ ${item.label}${item.detail ? `  ← ${item.detail}` : ''}`)
    process.exitCode = 1
  }
}
