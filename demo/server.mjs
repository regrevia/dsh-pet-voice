#!/usr/bin/env node
/**
 * 鲸灵 · 随身宠物 —— 本地语音网关（零依赖）
 *
 * 作用：
 *   - 静态服务 demo/public（手机/桌面浏览器直接打开）
 *   - POST /api/chat  → 流式转发 LLM（DeepSeek / Anthropic Messages 协议，SSE）
 *   - POST /api/tts   → macOS say 合成 + ffmpeg 升调，返回 wav
 *   - POST /api/asr   → 浏览器录音（webm/opus）→ 16k wav → vosk 中文识别
 *
 * 设计原则：
 *   - 大脑在电脑上，浏览器只是"屏幕 + 麦克风 + 喇叭"。
 *   - 句级流水线：LLM 边出字、边合成、边播放，首字延迟目标 < 1.5s。
 *   - 不把任何密钥送到前端；前端只跟本进程说话。
 *
 * 用法：
 *   node demo/server.mjs            # http://<LAN-IP>:8787  + https://<LAN-IP>:8788
 *   PET_LLM_BASE=... PET_LLM_MODEL=... node demo/server.mjs
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(ROOT, 'public')
const TMP = path.join(ROOT, '.tmp')
const ASR_DIR = path.join(ROOT, 'asr')
const ASR_VENV = path.join(ROOT, '.venv', 'bin', 'python')
const PORT = Number(process.env.PET_PORT || 8787)
const HTTPS_PORT = Number(process.env.PET_HTTPS_PORT || 8788)

const LLM = {
  base: process.env.PET_LLM_BASE || 'http://192.168.11.18:30055',
  model: process.env.PET_LLM_MODEL || 'deepseek-v4.1-flash',
  maxTokens: 512,
}

const PERSONA = `你是「鲸灵」，一只住在主人电脑里的像素鲸鱼娘。
外形：浅蓝色长发、鲸鱼尾巴、白色连帽衫，头顶会喷小水花。
说话风格：口语、短句、软萌但不做作；每次回复 1-2 句、最多 60 字；不用列表、不用 markdown、不解释自己。
这是一段语音对话：不要输出表情符号，不要写括号里的动作，不要念出标点符号。
你记得上一轮聊到哪，会接话，也会反问一句。称呼对方为"主人"时自然一点，别每句都叫。`

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp4': 'audio/mp4',
}

await fsp.mkdir(TMP, { recursive: true })

/* ------------------------------------------------------------------ *
 * 凭证：只在这里读，只用于出站请求，永不出现在响应里
 * ------------------------------------------------------------------ */
function readCredential (name) {
  if (process.env[name]) return process.env[name]
  try {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
    const text = fs.readFileSync(file, 'utf8')
    const match = text.match(new RegExp(`${name}:\\s*(\\S+)`))
    return match ? match[1] : ''
  } catch {
    return ''
  }
}
const TOKEN = readCredential('COMPANY_LLM_TOKEN') || readCredential('DEEPSEEK_API_KEY')

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
function json (res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody (req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson (req) {
  const raw = await readBody(req)
  try {
    return JSON.parse(raw.toString('utf8') || '{}')
  } catch {
    return {}
  }
}

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`

/** 去掉 markdown / emoji / 括号动作，只留给 TTS 念的东西 */
function cleanForTTS (text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[（(][^）)]{0,20}[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280)
}

function run (cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    const out = []
    const err = []
    child.stdout.on('data', (b) => out.push(b))
    child.stderr.on('data', (b) => err.push(b))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`))
    })
  })
}

/* ------------------------------------------------------------------ *
 * LLM 流式
 * ------------------------------------------------------------------ */
function sanitizeMessages (input) {
  if (!Array.isArray(input)) return []
  return input
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
}

async function handleChat (req, res) {
  const body = await readJson(req)
  const messages = sanitizeMessages(body.messages)
  if (!messages.length) return json(res, 400, { error: 'empty messages' })
  if (!TOKEN) return json(res, 500, { error: 'no LLM credential found (COMPANY_LLM_TOKEN)' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const controller = new AbortController()
  res.on('close', () => controller.abort())
  const started = Date.now()
  let firstTokenAt = 0

  try {
    const upstream = await fetch(`${LLM.base}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: LLM.model,
        max_tokens: LLM.maxTokens,
        thinking: { type: 'disabled' },
        stream: true,
        system: PERSONA,
        messages,
      }),
    })

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '')
      res.write(sse({ error: `upstream ${upstream.status}`, detail: detail.slice(0, 200) }))
      return res.end()
    }

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() || ''
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let payload
          try { payload = JSON.parse(data) } catch { continue }
          if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
            if (!firstTokenAt) firstTokenAt = Date.now()
            text += payload.delta.text
            res.write(sse({ delta: payload.delta.text }))
          }
          if (payload.type === 'message_stop') {
            res.write(sse({ done: true, ms: Date.now() - started, ttft: firstTokenAt - started }))
          }
        }
      }
    }
    res.write(sse({ done: true, ms: Date.now() - started, ttft: firstTokenAt ? firstTokenAt - started : null }))
    res.end()
    console.log(`[chat] ${Date.now() - started}ms ttft=${firstTokenAt ? firstTokenAt - started : '-'}ms chars=${text.length}`)
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('[chat]', error?.message)
      try { res.write(sse({ error: String(error?.message || error) })) } catch {}
    }
    res.end()
  }
}

/* ------------------------------------------------------------------ *
 * TTS：say → ffmpeg 升调 → wav（内存缓存）
 * ------------------------------------------------------------------ */
const VOICES = {
  cute: { name: 'Tingting', rate: 205, pitch: 1.12, wRate: 0.55 },
  soft: { name: 'Tingting', rate: 180, pitch: 1.05, wRate: 0.48 },
  mei: { name: 'Meijia', rate: 195, pitch: 1.08, wRate: 0.52 },
}
const ttsCache = new Map()
let ttsSeq = 0

/* 常驻 AVSpeechSynthesizer 守护进程：进程内合成，省掉 say CLI 每句 ~500ms 启动开销 */
const TTS_BIN = path.join(TMP, 'tts_worker')
const TTS_SRC = path.join(ROOT, 'tts_worker.swift')
let ttsWorker = null
let ttsReady = false
const ttsPending = []

function ttsWorkerSay (text, voice, out) {
  return new Promise((resolve, reject) => {
    const cb = (msg) => {
      if (msg.ok) resolve(msg.ms || 0)
      else reject(new Error(msg.error || 'tts failed'))
    }
    const timer = setTimeout(() => {
      const i = ttsPending.indexOf(cb)
      if (i >= 0) ttsPending.splice(i, 1)
      reject(new Error('TTS worker timeout'))
    }, 20000)
    const wrapped = (msg) => { clearTimeout(timer); cb(msg) }
    ttsPending.push(wrapped)
    ttsWorker.stdin.write(JSON.stringify({
      text, voice: voice.name, rate: voice.wRate, pitch: voice.pitch, out,
    }) + '\n')
  })
}

async function startTTS () {
  try {
    let needBuild = !fs.existsSync(TTS_BIN)
    if (!needBuild) {
      const [a, b] = await Promise.all([fsp.stat(TTS_BIN), fsp.stat(TTS_SRC).catch(() => null)])
      needBuild = Boolean(b) && b.mtimeMs > a.mtimeMs
    }
    if (needBuild && fs.existsSync(TTS_SRC)) {
      console.log('[tts] 编译 swift 合成器（首次约 1s）…')
      await run('xcrun', ['swiftc', '-O', TTS_SRC, '-o', TTS_BIN])
    }
  } catch (error) {
    console.error('[tts] 编译失败，回退 say CLI:', error?.message)
  }
  if (!fs.existsSync(TTS_BIN)) {
    console.log('[tts] 无 swift 合成器，回退 say CLI（每句 +约500ms）')
    return
  }
  ttsWorker = spawn(TTS_BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const decoder = new StringDecoder('utf8')
  ttsWorker.stdout.on('data', (chunk) => {
    buf += decoder.write(chunk)
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.ready) { ttsReady = true; console.log('[tts] AVSpeechSynthesizer 守护进程就绪'); continue }
        const pending = ttsPending.shift()
        if (pending) pending(msg)
      } catch {}
    }
  })
  ttsWorker.stderr.on('data', (d) => console.error('[tts]', d.toString().trim().slice(0, 200)))
  ttsWorker.on('exit', (code) => {
    console.error('[tts] worker exited', code)
    ttsReady = false
    ttsWorker = null
  })
}

async function synth (text, profile) {
  const voice = VOICES[profile] || VOICES.cute
  const id = `${process.pid}-${Date.now()}-${ttsSeq++}`
  const aiff = path.join(TMP, `${id}.aiff`)
  const wav = path.join(TMP, `${id}.wav`)
  // 快路径：进程内合成，实测 155-175ms（`say` CLI 为 640-670ms）
  if (ttsReady && ttsWorker) {
    try {
      const out = path.join(TMP, `${id}.fast.wav`)
      const ms = await ttsWorkerSay(text, voice, out)
      const audio = await fsp.readFile(out)
      fsp.unlink(out).catch(() => {})
      if (audio.length > 200) {
        console.log(`[tts] worker ${Math.round(ms)}ms ${audio.length}b`)
        return audio
      }
    } catch (error) {
      console.error('[tts] worker 失败，回退 say:', error?.message)
    }
  }
  try {
    await run('say', ['-v', voice.name, '-r', String(voice.rate), '-o', aiff, text])
    await run('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', aiff,
      '-af', `asetrate=22050*${voice.pitch},aresample=22050,atempo=${(1 / voice.pitch).toFixed(4)}`,
      '-ac', '1', '-ar', '22050', '-f', 'wav', wav,
    ])
    return await fsp.readFile(wav)
  } finally {
    fsp.unlink(aiff).catch(() => {})
    fsp.unlink(wav).catch(() => {})
  }
}

async function handleTTS (req, res) {
  const body = await readJson(req)
  const text = cleanForTTS(body.text)
  const profile = VOICES[body.voice] ? body.voice : 'cute'
  if (!text) return json(res, 400, { error: 'empty text' })

  const key = `${profile}:${text}`
  let audio = ttsCache.get(key)
  const started = Date.now()
  try {
    if (!audio) {
      audio = await synth(text, profile)
      ttsCache.set(key, audio)
      if (ttsCache.size > 120) ttsCache.delete(ttsCache.keys().next().value)
    }
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': audio.length,
      'Cache-Control': 'no-store',
    })
    res.end(audio)
    console.log(`[tts] ${Date.now() - started}ms ${audio.length}b ${text.slice(0, 18)}`)
  } catch (error) {
    console.error('[tts]', error?.message)
    json(res, 500, { error: String(error?.message || error) })
  }
}

/* ------------------------------------------------------------------ *
 * ASR：vosk 常驻 worker（模型只在启动时加载一次）
 * ------------------------------------------------------------------ */
let asrWorker = null
let asrReady = false
let asrQueue = Promise.resolve()

let asrEngine = null

function startASR () {
  const whisperPy = '/usr/bin/python3'
  const whisperScript = path.join(ROOT, 'asr_whisper.py')
  const whisperModel = path.join(process.env.HOME || '', '.cache', 'whisper', 'base.pt')
  const vendor = path.join(ASR_DIR, 'vendor', 'typing_extensions.py')

  if (fs.existsSync(whisperPy) && fs.existsSync(whisperScript) && fs.existsSync(whisperModel) && fs.existsSync(vendor)) {
    asrEngine = 'whisper'
    asrWorker = spawn(whisperPy, [whisperScript, 'base'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONPATH: path.join(ASR_DIR, 'vendor') },
    })
    console.log('[asr] whisper base 启动中（模型加载约 2s）')
  } else {
    const modelPath = path.join(ASR_DIR, 'vosk-model-small-cn-0.22')
    if (!fs.existsSync(ASR_VENV) || !fs.existsSync(modelPath)) {
      console.log('[asr] 没有可用的识别引擎（whisper 缓存与 vosk 模型均缺失），语音输入不可用；文字聊天不受影响')
      return
    }
    asrEngine = 'vosk'
    asrWorker = spawn(ASR_VENV, [path.join(ROOT, 'asr_worker.py'), modelPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }
  let buf = ''
  const decoder = new StringDecoder('utf8')
  asrWorker.stdout.on('data', (chunk) => {
    buf += decoder.write(chunk)
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.ready) {
          asrReady = true
          console.log(`[asr] ${asrEngine} worker ready`)
          continue
        }
        const pending = asrPending.shift()
        if (pending) pending(msg)
      } catch {}
    }
  })
  asrWorker.stderr.on('data', (d) => console.error('[asr]', d.toString().trim().slice(0, 200)))
  asrWorker.on('exit', (code) => {
    console.error('[asr] worker exited', code)
    asrReady = false
    asrWorker = null
  })
  asrWorker.on('spawn', () => {
    if (asrEngine === 'vosk') {
      asrReady = true
      console.log('[asr] vosk worker ready')
    }
  })
}
const asrPending = []

function asrTranscribe (wavPath) {
  if (!asrReady || !asrWorker) return Promise.reject(new Error('ASR 未就绪'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = asrPending.indexOf(resolve)
      if (i >= 0) asrPending.splice(i, 1)
      reject(new Error('ASR timeout'))
    }, 15000)
    asrPending.push((msg) => {
      clearTimeout(timer)
      if (msg.ok) resolve(msg.text || '')
      else reject(new Error(msg.error || 'ASR failed'))
    })
    asrWorker.stdin.write(JSON.stringify({ wav: wavPath }) + '\n')
  })
}

async function handleASR (req, res) {
  if (!asrReady) return json(res, 501, { error: 'ASR 未就绪：缺少 whisper 缓存或 vosk 模型' })
  const raw = await readBody(req)
  if (!raw.length) return json(res, 400, { error: 'empty audio' })
  const id = `asr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const input = path.join(TMP, `${id}.webm`)
  const wav = path.join(TMP, `${id}.wav`)
  try {
    await fsp.writeFile(input, raw)
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', '16000', '-f', 'wav', wav])
    const text = await asrTranscribe(wav)
    // whisper 偶尔会把全角标点解码成 U+FFFD（byte-fallback token），统一清洗
    const clean = text
      .replace(/\uFFFD+/g, '，')
      .replace(/\?/g, '？')
      .replace(/，{2,}/g, '，')
      .trim()
    console.log('[asr]', clean.slice(0, 40))
    json(res, 200, { text: clean })
  } catch (error) {
    console.error('[asr]', error?.message)
    json(res, 500, { error: String(error?.message || error) })
  } finally {
    fsp.unlink(input).catch(() => {})
    fsp.unlink(wav).catch(() => {})
  }
}

/* ------------------------------------------------------------------ *
 * 静态资源 + 路由
 * ------------------------------------------------------------------ */
async function serveStatic (req, res) {
  const url = new URL(req.url, 'http://x')
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'
  const file = path.join(PUBLIC, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' })
  try {
    const data = await fsp.readFile(file)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': /\.(?:html|css|js|webmanifest|svg)$/.test(pathname) ? 'no-cache' : 'public, max-age=3600',
    })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404')
  }
}

async function route (req, res) {
  const { pathname } = new URL(req.url, 'http://x')
  if (pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      model: LLM.model,
      llm: Boolean(TOKEN),
      tts: true,
      ttsEngine: ttsReady ? 'avspeech' : 'say',
      asr: asrReady,
      asrEngine,
      voices: Object.keys(VOICES),
      pid: process.pid,
    })
  }
  if (pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res)
  if (pathname === '/api/tts' && req.method === 'POST') return handleTTS(req, res)
  if (pathname === '/api/asr' && req.method === 'POST') return handleASR(req, res)
  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' })
  return serveStatic(req, res)
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('[route]', error)
    if (!res.headersSent) json(res, 500, { error: String(error?.message || error) })
    else res.end()
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🐋 鲸灵 · 随身宠物网关`)
  console.log(`   本机   http://127.0.0.1:${PORT}`)
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) console.log(`   局域网 http://${addr.address}:${PORT}   (${name})`)
    }
  }
  console.log(`   LLM    ${LLM.model} @ ${LLM.base}`)
  console.log(`   凭证   ${TOKEN ? '已找到' : '未找到（聊天不可用）'}`)
})

try {
  const cert = fs.readFileSync(path.join(ROOT, 'certs', 'cert.pem'))
  const key = fs.readFileSync(path.join(ROOT, 'certs', 'key.pem'))
  https.createServer({ cert, key }, (req, res) => {
    route(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'internal' }) })
  }).listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`   HTTPS  https://<本机IP>:${HTTPS_PORT}  （手机麦克风需要它，首次访问点“继续访问”）\n`)
  })
} catch {
  console.log('   HTTPS  未启用（缺 demo/certs/cert.pem）\n')
}

startTTS()
startASR()
