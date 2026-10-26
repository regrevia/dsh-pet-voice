/**
 * 语音来源：微软在线（edge-tts）/ 本机 say / 自己的接口。
 *
 * 这里只放「怎么把一句话变成一段音频」的纯逻辑，HTTP 路由和缓存都留在 index.js：
 * 换来源只影响合成那一步，鉴权、剥 Markdown、缓存键、回给手机的响应格式都不变。
 */
import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const TTS_PROVIDERS = ['edge', 'local', 'http']

export function normalizeTtsProvider(value) {
  const v = String(value ?? '').trim()
  return TTS_PROVIDERS.includes(v) ? v : 'edge'
}

/** 自己的接口：http(s) 地址，留空表示没填。 */
export function normalizeTtsUrl(value) {
  const v = String(value ?? '').trim()
  if (!v) return ''
  if (!/^https?:\/\//i.test(v)) throw new Error('接口地址要以 http 或 https 开头')
  return v
}

/** `+6%` / `-4%` → 6 / -4，认不出来按 0。 */
export function parseRatePercent(rate) {
  const m = /^([+-]?\d{1,3})%$/.exec(String(rate ?? '').trim())
  return m ? Number(m[1]) : 0
}

/** say 的语速单位是「词/分钟」，中文按默认 175 折算百分比。 */
export function rateToWpm(rate) {
  const wpm = Math.round(175 * (1 + parseRatePercent(rate) / 100))
  return Math.min(400, Math.max(80, wpm))
}

/**
 * `say -v '?'` 的输出里挑出中文音色。
 *
 * 形如：`Tingting (中文（中国大陆）)  zh_CN  # 你好…`
 * id 用 `Tingting`，显示名取「中文（中国大陆）· Tingting」。
 */
export function pickChineseVoices(listing) {
  const out = []
  const seen = new Set()
  for (const line of String(listing ?? '').split('\n')) {
    const m = /^(.+?)\s+\(([^)]*)\)\s+(zh_[A-Z]{2})\s/.exec(line.trim())
    if (!m) continue
    const [, name, label, locale] = m
    const id = name.trim()
    // 同一把声音会在清单里出现两遍（大陆 / 台湾各一行），按 id 去重，省得下拉里看着像两个人。
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: id, label: label.trim(), locale })
  }
  return out
}

/** 系统自带、一定装了的那几把中文声音优先；都不在就退回清单第一个。 */
const LOCAL_VOICE_PREFERENCE = ['Tingting', 'Meijia', 'Sinji', 'Eddy', 'Flo']
export function pickDefaultLocalVoice(voices) {
  const ids = new Set((voices ?? []).map((item) => item.id))
  return LOCAL_VOICE_PREFERENCE.find((id) => ids.has(id)) ?? (voices?.[0]?.id ?? 'Tingting')
}

/** 说一句话出 aiff：体积太小基本等于「这把声音列出来了但其实没下载」。 */
const SILENT_AIFF_BYTES = 8000

/** 本机装了哪些中文音色（瞬时，失败就当没有）。 */
export function listLocalVoices() {
  try {
    const r = spawnSync('say', ['-v', '?'], { encoding: 'utf8', timeout: 3000 })
    return pickChineseVoices(r.stdout)
  } catch {
    return []
  }
}

/** 本机 say 能不能用：命令在不在就够了，音色另算。 */
export function localTtsReady() {
  try {
    const r = spawnSync('say', ['-v', '?'], { encoding: 'utf8', timeout: 3000 })
    return r.status === 0
  } catch {
    return false
  }
}

/**
 * 本机合成：say 出 aiff，再转 mp3。
 *
 * 用 aiff 当中转是因为 say 只会写文件（不支持写标准输出），而手机端一直按 audio/mpeg 播，
 * 缓存文件扩展名也是 .mp3；转一层换来「所有来源对手机是同一种格式」。
 */
export async function synthesizeLocal({ text, voice, rate, ffmpeg = 'ffmpeg', fallbackVoice = 'Tingting' }) {
  const wanted = String(voice ?? '').trim() || fallbackVoice
  const first = await sayToMp3({ text, voice: wanted, rate, ffmpeg })
  if (first.buffer.length && !first.silent) return { buffer: first.buffer, contentType: 'audio/mpeg' }
  // 清单里有、实际没下载的声音说出来是 0.1 秒静音。换系统自带的那把再说一遍，别让手机播一片空白。
  if (wanted !== fallbackVoice) {
    const retry = await sayToMp3({ text, voice: fallbackVoice, rate, ffmpeg })
    if (retry.buffer.length && !retry.silent) return { buffer: retry.buffer, contentType: 'audio/mpeg' }
  }
  throw new Error(`这台电脑的「${wanted}」发不出声，换一个音色试试`)
}

/** say → aiff → mp3，一次尝试；silent=true 表示「出声了但内容是静音」。 */
async function sayToMp3({ text, voice, rate, ffmpeg }) {
  const dir = mkdtempSync(join(tmpdir(), 'pet-tts-'))
  const aiff = join(dir, 'a.aiff')
  try {
    const argv = ['-v', voice, '-r', String(rateToWpm(rate)), '-o', aiff, '--', text]
    const ok = await new Promise((resolve) => {
      const child = spawn('say', argv, { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      child.stderr.on('data', (c) => {
        err = (err + c.toString('utf8')).slice(-400)
      })
      child.on('error', () => resolve(err || 'say 起不来'))
      child.on('close', (code) => resolve(code === 0 ? '' : err || `say 退出码 ${code}`))
    })
    if (ok) throw new Error(ok)
    const mp3 = await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ['-v', 'error', '-i', aiff, '-f', 'mp3', '-codec:a', 'libmp3lame', '-q:a', '5', '-'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const chunks = []
      let err = ''
      child.stdout.on('data', (c) => chunks.push(c))
      child.stderr.on('data', (c) => {
        err = (err + c.toString('utf8')).slice(-400)
      })
      child.on('error', (e) => reject(new Error(`转 mp3 失败：${e?.message ?? e}`)))
      child.on('close', (code) => {
        const buf = Buffer.concat(chunks)
        if (code !== 0 || !buf.length) reject(new Error(err.trim() || `转 mp3 失败（退出码 ${code}）`))
        else resolve(buf)
      })
    })
    const aiffBytes = statSync(aiff).size
    return { buffer: mp3, silent: aiffBytes < SILENT_AIFF_BYTES }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响出声 */
    }
  }
}

/**
 * 自己的接口：POST 一句话，拿回音频。
 *
 * 三种回法都认：
 *  - 直接回音频字节（content-type 是 audio/*）
 *  - JSON `{ audio: "<base64>" }`
 *  - JSON `{ url: "<音频地址>" }`（再去下载，http/https 都行）
 */
export async function synthesizeHttp({ text, voice, rate, url, fetchImpl = fetch }) {
  const body = JSON.stringify({ text, voice, speed: (100 + parseRatePercent(rate)) / 100 })
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30000),
    })
  } catch (e) {
    throw new Error(`连不上接口：${e?.message ?? e}`)
  }
  if (!res.ok) throw new Error(`接口返回 ${res.status}`)
  const type = String(res.headers.get('content-type') ?? '')
  if (type.startsWith('audio/')) {
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: type.split(';')[0] }
  }
  let json
  try {
    json = await res.json()
  } catch {
    throw new Error('接口既不是音频也不是 JSON')
  }
  if (typeof json?.audio === 'string' && json.audio) {
    return { buffer: Buffer.from(json.audio, 'base64'), contentType: 'audio/mpeg' }
  }
  if (typeof json?.url === 'string' && /^https?:\/\//i.test(json.url)) {
    const audio = await fetchImpl(json.url, { signal: AbortSignal.timeout(30000) })
    if (!audio.ok) throw new Error(`音频地址返回 ${audio.status}`)
    const audioType = String(audio.headers.get('content-type') ?? 'audio/mpeg').split(';')[0]
    return { buffer: Buffer.from(await audio.arrayBuffer()), contentType: audioType }
  }
  throw new Error('接口没有返回音频、audio 或 url')
}

/** 读临时文件这种小工具留给测试用，免得测试里重复实现。 */
export function readIfExists(path) {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}
