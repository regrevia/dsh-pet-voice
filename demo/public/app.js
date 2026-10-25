/**
 * 鲸灵 · 前端交互
 * 音频链路：MediaRecorder → /api/asr → /api/chat(SSE) → 句级 /api/tts → WebAudio 播放 + 口型
 */
import { createPet } from './pet.js'

const $ = (id) => document.getElementById(id)
const pet = createPet($('pet'))

const el = {
  bubble: $('bubble'),
  bubbleText: $('bubble-text'),
  typing: $('typing'),
  state: $('state'),
  stateText: $('state-text'),
  led: $('led'),
  log: $('log'),
  chips: $('chips'),
  mic: $('mic'),
  text: $('text'),
  send: $('send'),
  hint: $('hint'),
  voiceBtn: $('btn-voice'),
  sheet: $('sheet'),
  sheetBackdrop: $('sheet-backdrop'),
  sheetMeta: $('sheet-meta'),
  petWrap: $('pet-wrap'),
}

const settings = {
  voice: true,
  cont: false,
  tone: 'cute',
  log: false,
  ...JSON.parse(localStorage.getItem('whalepet.settings') || '{}'),
}
const saveSettings = () => localStorage.setItem('whalepet.settings', JSON.stringify(settings))

/* ------------------------------------------------------------------ *
 * 背景：像素气泡
 * ------------------------------------------------------------------ */
const sea = $('sea')
const sctx = sea.getContext('2d')
let bubbles = []
function resizeSea () {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  sea.width = Math.floor(innerWidth * dpr)
  sea.height = Math.floor(innerHeight * dpr)
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const count = Math.round((innerWidth * innerHeight) / 26000)
  bubbles = Array.from({ length: Math.min(46, count) }, () => spawnBubble(true))
}
function spawnBubble (anywhere) {
  return {
    x: Math.random() * innerWidth,
    y: anywhere ? Math.random() * innerHeight : innerHeight + 10,
    r: Math.random() < 0.65 ? 1 : 2,
    v: 6 + Math.random() * 18,
    a: 0.06 + Math.random() * 0.22,
    w: 0.4 + Math.random() * 1.2,
    p: Math.random() * 6.28,
  }
}
let lastSea = performance.now()
function seaFrame (now) {
  const dt = Math.min(0.05, (now - lastSea) / 1000)
  lastSea = now
  sctx.clearRect(0, 0, innerWidth, innerHeight)
  for (const b of bubbles) {
    b.y -= b.v * dt
    b.x += Math.sin(now / 1000 * b.w + b.p) * 6 * dt
    if (b.y < -8) Object.assign(b, spawnBubble(false))
    sctx.fillStyle = `rgba(170, 238, 255, ${b.a})`
    sctx.fillRect(Math.round(b.x), Math.round(b.y), b.r, b.r)
  }
  requestAnimationFrame(seaFrame)
}
resizeSea()
addEventListener('resize', resizeSea)
requestAnimationFrame(seaFrame)

/* ------------------------------------------------------------------ *
 * 音频输出
 * ------------------------------------------------------------------ */
const AudioCtx = window.AudioContext || window.webkitAudioContext
const ac = new AudioCtx()
const analyser = ac.createAnalyser()
analyser.fftSize = 512
analyser.smoothingTimeConstant = 0.6
analyser.connect(ac.destination)
const waveData = new Uint8Array(analyser.fftSize)

let speaking = false
let currentSource = null
const speechQueue = []

function audioLevel () {
  analyser.getByteTimeDomainData(waveData)
  let sum = 0
  for (let i = 0; i < waveData.length; i++) {
    const v = (waveData[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / waveData.length)
}

function lipLoop () {
  const level = audioLevel()
  const amp = Math.min(1, level * 6.5)
  pet.setMouth(speaking ? amp : 0)
  document.documentElement.style.setProperty('--amp', amp.toFixed(2))
  requestAnimationFrame(lipLoop)
}
requestAnimationFrame(lipLoop)

async function pumpSpeech () {
  if (speaking) return
  const item = speechQueue.shift()
  if (!item) {
    if (mode === 'talking') setMode('idle')
    if (settings.cont && !recording && lastWasSpeech) scheduleAutoListen()
    return
  }
  speaking = true
  setMode('talking')
  try {
    const buffer = await item.promise
    if (!buffer) throw new Error('tts failed')
    const audio = await ac.decodeAudioData(buffer)
    await new Promise((resolve) => {
      const source = ac.createBufferSource()
      source.buffer = audio
      source.connect(analyser)
      source.onended = resolve
      currentSource = source
      source.start()
      const guard = setTimeout(resolve, (audio.duration + 1.2) * 1000)
      source.addEventListener('ended', () => clearTimeout(guard))
    })
  } catch (error) {
    console.warn('[tts]', error)
  } finally {
    currentSource = null
    speaking = false
    pumpSpeech()
  }
}

function clearSpeech () {
  speechQueue.length = 0
  if (currentSource) {
    try { currentSource.stop() } catch {}
    currentSource = null
  }
  speaking = false
  pet.setMouth(0)
}

function enqueueSpeech (text) {
  if (!settings.voice) return
  const clean = text.trim()
  if (!clean) return
  const promise = fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean, voice: settings.tone }),
  }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
  speechQueue.push({ text: clean, promise })
  if (!speaking) pumpSpeech()
}

/* ------------------------------------------------------------------ *
 * 状态机
 * ------------------------------------------------------------------ */
let mode = 'idle'
function setMode (next) {
  mode = next
  pet.setMode(next === 'thinking' ? 'thinking' : next)
  el.state.classList.toggle('listening', next === 'listening')
  el.state.classList.toggle('thinking', next === 'thinking')
  el.led.className = 'led ' + ({ listening: 'busy', thinking: 'busy', talking: 'talk' }[next] || '')
  el.stateText.textContent = ({ idle: '在线', listening: '我在听', thinking: '想一想', talking: '说话中' }[next] || '在线')
  el.typing.hidden = next !== 'thinking'
  if (next !== 'thinking') el.bubble.classList.remove('streaming')
  document.body.dataset.mode = next
}

function setBubble (text, { streaming = false } = {}) {
  el.bubble.hidden = false
  el.bubbleText.textContent = text
  el.bubble.classList.toggle('streaming', streaming)
}

/* ------------------------------------------------------------------ *
 * 对话
 * ------------------------------------------------------------------ */
const history = []
let chatAbort = null
let sentenceBuf = ''
let fullText = ''
let lastWasSpeech = false
let autoListenTimer = 0

const SENT_END = /[。！？!?…\n]/

function feedSentences (chunk) {
  sentenceBuf += chunk
  let match
  while ((match = sentenceBuf.match(SENT_END))) {
    const cut = match.index + 1
    const sentence = sentenceBuf.slice(0, cut).trim()
    sentenceBuf = sentenceBuf.slice(cut)
    if (sentence) enqueueSpeech(sentence)
  }
  if (sentenceBuf.length > 26) {
    const cut = Math.max(sentenceBuf.lastIndexOf('，'), sentenceBuf.lastIndexOf(','))
    if (cut > 8) {
      enqueueSpeech(sentenceBuf.slice(0, cut + 1))
      sentenceBuf = sentenceBuf.slice(cut + 1)
    }
  }
}

function addLog (who, text) {
  if (!settings.log) return
  const node = document.createElement('div')
  node.className = who === 'me' ? 'me' : 'pet'
  node.textContent = (who === 'me' ? '我：' : '鲸灵：') + text
  el.log.append(node)
  el.log.scrollTop = el.log.scrollHeight
}

async function ask (text) {
  const clean = String(text || '').trim()
  if (!clean) return

  if (chatAbort) chatAbort.abort()
  clearSpeech()
  if (recording) stopRecording()

  hideHint()
  addLog('me', clean)
  history.push({ role: 'user', content: clean })
  if (history.length > 14) history.splice(0, history.length - 14)

  fullText = ''
  sentenceBuf = ''
  lastWasSpeech = false
  setBubble('', { streaming: true })
  setMode('thinking')

  const controller = new AbortController()
  chatAbort = controller

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() || ''
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          let payload
          try { payload = JSON.parse(line.slice(5).trim()) } catch { continue }
          if (payload.error) throw new Error(payload.error)
          if (payload.delta) {
            if (!fullText) setMode('talking')
            fullText += payload.delta
            setBubble(fullText, { streaming: true })
            feedSentences(payload.delta)
          }
          if (payload.done) {
            if (payload.ttft) console.info(`[latency] TTFT ${payload.ttft}ms, total ${payload.ms}ms`)
          }
        }
      }
    }

    if (sentenceBuf.trim()) {
      enqueueSpeech(sentenceBuf.trim())
      sentenceBuf = ''
    }
    el.bubble.classList.remove('streaming')
    if (fullText.trim()) {
      history.push({ role: 'assistant', content: fullText.trim() })
      addLog('pet', fullText.trim())
      lastWasSpeech = true
    }
    if (!speaking && !speechQueue.length) setMode('idle')
  } catch (error) {
    if (error.name === 'AbortError') return
    console.warn('[chat]', error)
    setMode('idle')
    setBubble('呜…信号断了一下，再说一遍好吗？')
    enqueueSpeech('呜，信号断了一下，再说一遍好吗？')
  } finally {
    if (chatAbort === controller) chatAbort = null
  }
}

/* ------------------------------------------------------------------ *
 * 语音输入
 * ------------------------------------------------------------------ */
let recording = false
let recorder = null
let micStream = null
let micAnalyser = null
let micChunks = []
let micVadTimer = 0
let speechStarted = false
let silenceSince = 0
let micStartedAt = 0

function showHint (text, warn = false) {
  el.hint.textContent = text
  el.hint.classList.toggle('warn', warn)
}
function hideHint () {
  el.hint.textContent = '点麦克风说话 · 也可以直接打字'
  el.hint.classList.remove('warn')
}

function pickMime () {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || ''
}

async function startRecording () {
  if (recording) return
  if (!navigator.mediaDevices?.getUserMedia) {
    showHint('这个浏览器不支持录音，试试 Chrome / Safari', true)
    return
  }
  if (!window.isSecureContext) {
    showHint('麦克风需要 HTTPS：请改用 https:// 地址打开', true)
    return
  }
  try {
    micStream = await micStream || await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (error) {
    const map = {
      NotAllowedError: '麦克风被拒绝了，去浏览器设置里允许一下',
      NotFoundError: '没找到麦克风',
      NotReadableError: '麦克风被别的程序占用了',
    }
    showHint(map[error.name] || `麦克风打不开：${error.name}`, true)
    return
  }

  if (ac.state === 'suspended') await ac.resume().catch(() => {})

  clearSpeech()
  if (chatAbort) chatAbort.abort()

  micChunks = []
  speechStarted = false
  silenceSince = 0
  micStartedAt = performance.now()
  const mime = pickMime()
  recorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined)
  recorder.ondataavailable = (e) => { if (e.data.size) micChunks.push(e.data) }
  recorder.onstop = handleRecordingStop
  recorder.start(250)

  const source = ac.createMediaStreamSource(micStream)
  micAnalyser = ac.createAnalyser()
  micAnalyser.fftSize = 512
  source.connect(micAnalyser)
  const data = new Uint8Array(micAnalyser.fftSize)

  recording = true
  el.mic.classList.add('recording')
  setMode('listening')
  showHint('我在听… 说完停一下就好')
  pet.setMouth(0)

  let lastCheck = performance.now()
  micVadTimer = setInterval(() => {
    if (!recording) return
    micAnalyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    document.documentElement.style.setProperty('--amp', Math.min(1, rms * 9).toFixed(2))
    const now = performance.now()
    if (rms > 0.035) {
      speechStarted = true
      silenceSince = 0
    } else if (speechStarted && rms < 0.018) {
      if (!silenceSince) silenceSince = now
      else if (now - silenceSince > 850) stopRecording()
    } else {
      silenceSince = 0
    }
    if (now - lastCheck > 500) lastCheck = now
    if (now - micStartedAt > 15000) stopRecording()
  }, 90)
}

function stopRecording () {
  if (!recording) return
  recording = false
  clearInterval(micVadTimer)
  el.mic.classList.remove('recording')
  document.documentElement.style.setProperty('--amp', '0')
  try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch {}
  if (!speechStarted) {
    setMode('idle')
    showHint('没听到声音，再试一次？', true)
    setTimeout(hideHint, 2600)
  } else {
    setMode('thinking')
    showHint('听懂了，我想想…')
  }
}

async function handleRecordingStop () {
  const blob = new Blob(micChunks, { type: recorder?.mimeType || 'audio/webm' })
  micChunks = []
  if (!blob.size || !speechStarted) { setMode('idle'); return }
  try {
    const res = await fetch('/api/asr', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob })
    if (res.status === 501) {
      setMode('idle')
      showHint('这台电脑还没装语音识别（见 demo/README），先用打字吧', true)
      return
    }
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    const text = (data.text || '').trim()
    if (!text) {
      setMode('idle')
      showHint('没听清…再说一遍？', true)
      setTimeout(hideHint, 2400)
      return
    }
    hideHint()
    ask(text)
  } catch (error) {
    console.warn('[asr]', error)
    setMode('idle')
    showHint('识别失败了，先打字吧', true)
  }
}

function scheduleAutoListen () {
  clearTimeout(autoListenTimer)
  autoListenTimer = setTimeout(() => {
    if (!recording && mode === 'idle' && settings.cont) startRecording()
  }, 700)
}

/* ------------------------------------------------------------------ *
 * 事件绑定
 * ------------------------------------------------------------------ */
el.send.addEventListener('click', () => {
  const value = el.text.value
  el.text.value = ''
  el.text.blur()
  ask(value)
})

el.text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    const value = el.text.value
    el.text.value = ''
    ask(value)
  }
})

el.mic.addEventListener('click', () => {
  if (recording) stopRecording()
  else startRecording()
})

el.chips.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip')
  if (chip) ask(chip.dataset.say)
})

el.petWrap.addEventListener('click', () => {
  pet.tap()
  if (mode === 'idle') {
    const lines = ['咕噜～', '呜…被你摸到了', '嘿嘿，痒', '我在呢，主人']
    setBubble(lines[Math.floor(Math.random() * lines.length)])
    setTimeout(() => {
      if (mode === 'idle' && !speaking && !fullText) setBubble('')
    }, 1600)
  } else if (mode === 'talking') {
    // 打断
    clearSpeech()
    setMode('idle')
  }
})

el.voiceBtn.addEventListener('click', () => {
  settings.voice = !settings.voice
  saveSettings()
  el.voiceBtn.classList.toggle('muted', !settings.voice)
  el.voiceBtn.classList.toggle('on', settings.voice)
  if (!settings.voice) clearSpeech()
})

/* 设置面板 */
function openSheet () {
  el.sheet.hidden = false
  el.sheetBackdrop.hidden = false
  refreshMeta()
}
function closeSheet () {
  el.sheet.hidden = true
  el.sheetBackdrop.hidden = true
}
$('btn-settings').addEventListener('click', openSheet)
$('sheet-close').addEventListener('click', closeSheet)
el.sheetBackdrop.addEventListener('click', closeSheet)

$('opt-voice').addEventListener('change', (e) => {
  settings.voice = e.target.checked
  el.voiceBtn.classList.toggle('muted', !settings.voice)
  if (!settings.voice) clearSpeech()
  saveSettings()
})
$('opt-cont').addEventListener('change', (e) => { settings.cont = e.target.checked; saveSettings() })
$('opt-tone').addEventListener('change', (e) => { settings.tone = e.target.value; saveSettings(); clearSpeech() })
$('opt-log').addEventListener('change', (e) => {
  settings.log = e.target.checked
  el.log.hidden = !settings.log
  saveSettings()
})

function syncSettingsUI () {
  $('opt-voice').checked = settings.voice
  $('opt-cont').checked = settings.cont
  $('opt-tone').value = settings.tone
  $('opt-log').checked = settings.log
  el.log.hidden = !settings.log
  el.voiceBtn.classList.toggle('muted', !settings.voice)
  el.voiceBtn.classList.toggle('on', settings.voice)
}
syncSettingsUI()

async function refreshMeta () {
  try {
    const res = await fetch('/api/health')
    const data = await res.json()
    el.sheetMeta.textContent =
      `模型  ${data.model}\n` +
      `语音  ${data.tts ? 'say 本机合成' : '关闭'}\n` +
      `识别  ${data.asr ? 'vosk 中文（本地）' : '未安装'}\n` +
      `环境  ${window.isSecureContext ? 'secure context ✓' : '非安全上下文（麦克风不可用）'}`
    el.led.className = 'led'
  } catch {
    el.sheetMeta.textContent = '连不上网关：先在本机运行 node demo/server.mjs'
    el.led.className = 'led off'
  }
}
refreshMeta()

/* 首次交互解锁音频 */
const unlock = () => {
  if (ac.state === 'suspended') ac.resume().catch(() => {})
  document.removeEventListener('pointerdown', unlock)
}
document.addEventListener('pointerdown', unlock)

/* 开场白（不自动播，等首次交互） */
setTimeout(() => {
  if (!fullText && mode === 'idle') {
    setBubble('咕噜…主人，你终于上线啦。')
    setTimeout(() => {
      if (mode === 'idle' && !fullText && !speaking) setBubble('')
    }, 4200)
  }
}, 700)

setMode('idle')
