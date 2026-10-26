import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TTS_PROVIDERS,
  normalizeTtsProvider,
  normalizeTtsUrl,
  parseRatePercent,
  rateToWpm,
  pickChineseVoices,
  pickDefaultLocalVoice,
  synthesizeHttp,
} from '../tts/providers.mjs'

test('语音来源只认三个值，别的回默认', () => {
  assert.deepEqual(TTS_PROVIDERS, ['edge', 'local', 'http'])
  assert.equal(normalizeTtsProvider('local'), 'local')
  assert.equal(normalizeTtsProvider(' http '), 'http')
  assert.equal(normalizeTtsProvider('anything'), 'edge')
  assert.equal(normalizeTtsProvider(undefined), 'edge')
})

test('接口地址要 http(s)，留空照旧是空', () => {
  assert.equal(normalizeTtsUrl(''), '')
  assert.equal(normalizeTtsUrl('  '), '')
  assert.equal(normalizeTtsUrl('http://127.0.0.1:9880/tts'), 'http://127.0.0.1:9880/tts')
  assert.equal(normalizeTtsUrl('https://tts.example.com/say'), 'https://tts.example.com/say')
  assert.throws(() => normalizeTtsUrl('127.0.0.1:9880'), /http/)
})

test('语速百分比转 say 的词/分钟，越界夹住', () => {
  assert.equal(parseRatePercent('+6%'), 6)
  assert.equal(parseRatePercent('-10%'), -10)
  assert.equal(parseRatePercent(''), 0)
  assert.equal(parseRatePercent('fast'), 0)
  assert.equal(rateToWpm('+0%'), 175)
  assert.equal(rateToWpm('+10%'), 193)
  assert.equal(rateToWpm('+999%'), 400)
  assert.equal(rateToWpm('-999%'), 80)
})

test('say 音色清单只挑中文', () => {
  const listing = [
    "Tingting (中文（中国大陆）)  zh_CN  # 你好，我叫Tingting。",
    'Samantha (English (US))  en_US  # Hello',
    "Meijia (中文（台湾）)  zh_TW  # 你好",
    'garbage line',
  ].join('\n')
  const voices = pickChineseVoices(listing)
  assert.deepEqual(voices.map((v) => v.id), ['Tingting', 'Meijia'])
  assert.equal(voices[0].locale, 'zh_CN')
  assert.equal(voices[1].label, '中文（台湾）')
  // 同一把声音两行（大陆 / 台湾）只留一条，不然下拉里像两个人。
  const dup = pickChineseVoices(['Eddy (中文（中国大陆）)  zh_CN  # x', 'Eddy (中文（台湾）)  zh_TW  # y'])
  assert.deepEqual(dup.map((v) => v.id), ['Eddy'])
})

test('默认本机音色避开「列出来但没下载」的新声音', () => {
  assert.equal(pickDefaultLocalVoice([{ id: 'Eddy' }, { id: 'Tingting' }]), 'Tingting')
  assert.equal(pickDefaultLocalVoice([{ id: 'Flo' }, { id: 'Meijia' }]), 'Meijia')
  assert.equal(pickDefaultLocalVoice([{ id: 'Sinji' }]), 'Sinji')
  assert.equal(pickDefaultLocalVoice([{ id: 'SomeNewVoice' }]), 'SomeNewVoice')
  assert.equal(pickDefaultLocalVoice([]), 'Tingting')
})

/** 造一个「像 fetch」的函数：按顺序吐准备好的响应。 */
function fakeFetch(responses) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init })
    const r = responses.shift()
    if (!r) throw new Error('多余的请求')
    return r
  }
  fn.calls = calls
  return fn
}

const res = (body, { status = 200, type = 'audio/mpeg' } = {}) => {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => {
      if (Buffer.isBuffer(body)) throw new Error('不是 json')
      return body
    },
  }
}

test('自己的接口：POST 一句话，直接把回的音频拿回来', async () => {
  const audio = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3])
  const fetchImpl = fakeFetch([res(audio)])
  const out = await synthesizeHttp({ text: '你好', voice: 'v1', rate: '+6%', url: 'http://127.0.0.1:1/tts', fetchImpl })
  assert.equal(out.contentType, 'audio/mpeg')
  assert.deepEqual(out.buffer, audio)
  const [call] = fetchImpl.calls
  assert.equal(call.url, 'http://127.0.0.1:1/tts')
  assert.equal(call.init.method, 'POST')
  const sent = JSON.parse(call.init.body)
  assert.equal(sent.text, '你好')
  assert.equal(sent.voice, 'v1')
  assert.equal(sent.speed, 1.06)
})

test('自己的接口：JSON 里给 base64 也认', async () => {
  const audio = Buffer.from('hello-mp3')
  const fetchImpl = fakeFetch([res({ audio: audio.toString('base64') }, { type: 'application/json' })])
  const out = await synthesizeHttp({ text: '你好', url: 'http://x/tts', fetchImpl })
  assert.deepEqual(out.buffer, audio)
  assert.equal(out.contentType, 'audio/mpeg')
})

test('自己的接口：JSON 里给地址就去下载', async () => {
  const audio = Buffer.from([1, 2, 3, 4])
  const fetchImpl = fakeFetch([
    res({ url: 'https://cdn.example.com/a.mp3' }, { type: 'application/json' }),
    res(audio, { type: 'audio/wav' }),
  ])
  const out = await synthesizeHttp({ text: '你好', url: 'http://x/tts', fetchImpl })
  assert.deepEqual(out.buffer, audio)
  assert.equal(out.contentType, 'audio/wav')
  assert.equal(fetchImpl.calls[1].url, 'https://cdn.example.com/a.mp3')
})

test('自己的接口：四种失败都给出能看的原因', async () => {
  await assert.rejects(
    synthesizeHttp({ text: 'x', url: 'http://x/tts', fetchImpl: fakeFetch([res('no', { status: 500, type: 'audio/mpeg' })]) }),
    /接口返回 500/,
  )
  await assert.rejects(
    synthesizeHttp({ text: 'x', url: 'http://x/tts', fetchImpl: fakeFetch([res({ nope: 1 }, { type: 'application/json' })]) }),
    /没有返回音频/,
  )
  await assert.rejects(
    synthesizeHttp({ text: 'x', url: 'http://x/tts', fetchImpl: fakeFetch([res({ url: 'ftp://x' }, { type: 'application/json' })]) }),
    /没有返回音频/,
  )
  await assert.rejects(
    synthesizeHttp({ text: 'x', url: 'http://x/tts', fetchImpl: async () => { throw new Error('ECONNREFUSED') } }),
    /连不上接口/,
  )
})
