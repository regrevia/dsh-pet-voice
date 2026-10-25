#!/usr/bin/env node
/**
 * 神经语音端到端自检：
 *   1) GET /api/tts/voices 拿到音色和 ready 状态
 *   2) GET /api/tts?text=… 拉一段 mp3 落盘，校验 >5 KB 且是 mp3 帧头
 *   3) 顺带校验鉴权（无 cookie 必须 401）与参数校验（未知音色 400）
 *
 * 用法：
 *   node plugins/dsh-pet-voice/tts/check.mjs
 *   BASE=http://127.0.0.1:58686 PV_TOKEN=<token> node …/check.mjs
 *
 * token 默认从 ~/.dsh/pet-voice/token 读；输出里不会打印完整 token。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const BASE = (process.env.BASE ?? 'http://127.0.0.1:58686').replace(/\/+$/, '')
const API = `${BASE}/pet-voice/api`
const TEXT = process.env.PV_TTS_TEXT ?? '你好，我是鲸灵，一条会写代码的小鲸鱼。'

function token() {
  if (process.env.PV_TOKEN) return process.env.PV_TOKEN
  try {
    return readFileSync(join(homedir(), '.dsh', 'pet-voice', 'token'), 'utf8').trim()
  } catch {
    return ''
  }
}

const TK = token()
const cookie = TK ? `pkv_${TK.slice(0, 8)}=${TK}` : ''
const headers = cookie ? { cookie } : {}

const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!TK) fail('拿不到 token：先在宿主上跑一次插件，或传 PV_TOKEN')

// 1) 音色列表
const voicesRes = await fetch(`${API}/tts/voices`, { headers })
if (!voicesRes.ok) fail(`/api/tts/voices HTTP ${voicesRes.status}`)
const voices = await voicesRes.json()
if (!voices.ok || !Array.isArray(voices.voices) || !voices.voices.length) fail('音色列表为空')
if (!voices.ready) fail('宿主上 edge-tts 未安装：先跑 tts/setup.sh')
const voice = process.env.PV_TTS_VOICE ?? voices.default ?? voices.voices[0].id
console.log(`✓ 音色 ${voices.voices.length} 个，ready=${voices.ready}，用 ${voice}`)

// 2) 鉴权 & 参数校验
const anon = await fetch(`${API}/tts?text=${encodeURIComponent('你好')}`, { headers: {} })
if (anon.status !== 401) fail(`无 cookie 应该 401，实际 ${anon.status}`)
const badVoice = await fetch(`${API}/tts?text=${encodeURIComponent('你好')}&voice=nope`, { headers })
if (badVoice.status !== 400) fail(`未知音色应该 400，实际 ${badVoice.status}`)
const tooLong = await fetch(`${API}/tts?text=${encodeURIComponent('啊'.repeat(700))}`, { headers })
if (tooLong.status !== 400) fail(`超长文本应该 400，实际 ${tooLong.status}`)
console.log('✓ 鉴权 401 / 未知音色 400 / 超长文本 400 都符合预期')

// 3) 合成一段，量首字节和总字节
const t0 = Date.now()
const res = await fetch(`${API}/tts?text=${encodeURIComponent(TEXT)}&voice=${encodeURIComponent(voice)}`, {
  headers,
})
if (!res.ok) fail(`/api/tts HTTP ${res.status}：${await res.text()}`)
const contentType = res.headers.get('content-type') ?? ''
if (!contentType.startsWith('audio/mpeg')) fail(`content-type 不对：${contentType}`)

const reader = res.body.getReader()
const chunks = []
let firstByteAt = null
let total = 0
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  if (!value?.length) continue
  if (firstByteAt === null) firstByteAt = Date.now() - t0
  total += value.length
  chunks.push(value)
}
const elapsed = Date.now() - t0
if (!total) fail('没有拿到音频字节')
if (total < 5120) fail(`音频太小（${total} B < 5120 B），可能不是真的 mp3`)
const body = Buffer.concat(chunks)
const id3 = body.subarray(0, 3).toString('latin1') === 'ID3'
const mpeg = body[0] === 0xff && (body[1] & 0xe0) === 0xe0
if (!id3 && !mpeg) fail(`不是 mp3 帧头：${body.subarray(0, 4).toString('hex')}`)

const out = process.env.PV_TTS_OUT ?? '/tmp/pet-voice-tts.mp3'
writeFileSync(out, body)
console.log(
  `✓ 合成 ${TEXT.length} 字：首字节 ${firstByteAt ?? 0} ms / 共 ${total} B / 全程 ${elapsed} ms → ${out}`,
)
console.log('SUMMARY', JSON.stringify({ ok: true, voice, bytes: total, firstByteMs: firstByteAt, totalMs: elapsed, out }))
