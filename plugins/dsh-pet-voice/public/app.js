/* 鲸灵 · 手机端语音宠物
 *
 * 一句话流程：唤醒词 → 本机浏览器转写 → POST /pet-voice/api/dispatch →
 * 订阅 SSE 拿到助理文本增量 → 按句子喂给 speechSynthesis 边出边说，
 * 同时让像素鲸鱼娘进入 listening/thinking/talking 姿态。
 */

import { createPet } from '/pet-voice/assets/pet.js'

const API = '/pet-voice/api'
const ASSET = '/pet-voice/assets'
const $ = (id) => document.getElementById(id)

const S = {
  projects: [],
  presets: [],
  workspaceId: '',
  projectPath: '',
  preset: '',
  sessionId: '',
  wakeWords: ['鲸灵', '小鲸'],
  wake: false,
  tts: true,
  busy: false,
  speaking: false,
  stream: null,
  tokenHint: '',
}

const pet = createPet($('pet'))

/* ------------------------------------------------------------------ */
/* 基础 UI                                                            */
/* ------------------------------------------------------------------ */

const STATUS = {
  idle: '我在～',
  listening: '在听，喊我鲸灵',
  thinking: '在想…',
  talking: '在说…',
  wake: '在听，喊我鲸灵',
  ptt: '按住说话，松手发送',
}
const MODE_PET = { idle: 'idle', listening: 'listening', thinking: 'thinking', talking: 'talking' }

function setMode(mode) {
  document.body.dataset.mode = mode === 'wake' || mode === 'ptt' ? 'listening' : mode
  pet.setMode(MODE_PET[mode] ?? mode)
  const text = STATUS[mode]
  if (text) $('status').textContent = text
}

function status(text) {
  $('status').textContent = text
}

function dot(state) {
  $('linkDot').dataset.state = state
}

function scrollChat() {
  const chat = $('chat')
  chat.scrollTop = chat.scrollHeight
}

/** 中间只留最近两三轮：用户 3 句 + 回应 3 段，够回看又不挤。 */
function trimChat() {
  const chat = $('chat')
  const dialog = [...chat.children].filter((el) => el.classList.contains('me') || el.classList.contains('pet'))
  for (const el of dialog.slice(0, Math.max(0, dialog.length - 6))) el.remove()
  const noise = [...chat.children].filter((el) => el.classList.contains('sys') || el.classList.contains('err'))
  for (const el of noise.slice(0, Math.max(0, noise.length - 3))) el.remove()
}

function log(kind, text) {
  const el = document.createElement('div')
  el.className = `item ${kind}`
  el.textContent = text
  $('chat').appendChild(el)
  trimChat()
  scrollChat()
  return el
}

function bubble(text, mine) {
  const el = $('say')
  el.hidden = false
  el.textContent = text
  el.classList.toggle('you', !!mine)
}

async function api(path, { method = 'GET', body } = {}) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const res = await fetch(API + path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-pet-tz': timezone },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = { ok: false, error: `HTTP ${res.status}` }
  }
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`
  return data
}

/* ------------------------------------------------------------------ */
/* 状态加载 / 项目切换                                                */
/* ------------------------------------------------------------------ */

async function loadState() {
  const data = await api('/state')
  if (!data.ok) {
    dot('error')
    log('err', `读取宿主状态失败：${data.error ?? '未知错误'}`)
    status('连不上 DSH 宿主')
    return
  }
  S.projects = data.projects ?? []
  S.presets = data.presets ?? []
  S.tokenHint = data.tokenHint ?? ''
  // 对话只落在专属会话（dispatchTarget）；绝不用 current（界面当前会话），
  // 否则手机这边一句「你好」就发进了用户电脑上正打开的那个项目会话。
  S.sessionId = data.dispatchTarget || data.petSession?.sessionId || ''
  if (Array.isArray(data.pet?.wakeWords) && data.pet.wakeWords.length) S.wakeWords = data.pet.wakeWords
  if (data.pet?.name) $('petName').textContent = data.pet.name

  const savedWs = localStorage.getItem('pet.workspace') ?? ''
  const first = S.projects[0] ?? null
  const chosen = S.projects.find((p) => p.id === savedWs) ?? first
  if (chosen) selectProject(chosen.id, { silent: true })

  fillProjects()
  fillPresets()
  dot('live')
  status(S.wake ? '等你说「鲸灵」' : '我在～')
  if (S.sessionId) ensureStream()
}

function fillProjects() {
  const sel = $('projectSel')
  sel.innerHTML = ''
  if (!S.projects.length) {
    const opt = document.createElement('option')
    opt.textContent = '（宿主没有配置 workspace）'
    opt.value = ''
    sel.appendChild(opt)
    return
  }
  for (const p of S.projects) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.title || p.path || p.id
    opt.title = p.path || p.id
    sel.appendChild(opt)
  }
  sel.value = S.workspaceId
}

function fillPresets() {
  const sel = $('presetSel')
  sel.innerHTML = ''
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = '跟随宿主默认'
  sel.appendChild(auto)
  for (const p of S.presets) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.title || p.id
    sel.appendChild(opt)
  }
  S.preset = localStorage.getItem('pet.preset') ?? ''
  sel.value = S.presets.some((p) => p.id === S.preset) ? S.preset : ''
  if (sel.value !== S.preset) S.preset = ''
}

function selectProject(workspaceId, { silent = false } = {}) {
  const project = S.projects.find((p) => p.id === workspaceId) ?? null
  S.workspaceId = workspaceId
  S.projectPath = project?.path ?? ''
  localStorage.setItem('pet.workspace', workspaceId)
  $('projLabel').textContent = project ? project.title || project.path || project.id : '未选项目'
  $('projectSel').value = workspaceId
  if (!silent) {
    // 换项目＝换会话：让宿主为该项目新建/复用一只会话，再重连流。
    void openSessionFor(S.workspaceId, S.projectPath, { announce: true })
  }
}

async function openSessionFor(workspaceId, projectPath, { announce = false, fresh = false } = {}) {
  const data = await api('/new', {
    method: 'POST',
    body: { workspaceId, projectPath, preset: S.preset, fresh },
  })
  if (!data.ok) {
    log('err', `开新会话失败：${data.error ?? '未知错误'}`)
    return
  }
  S.sessionId = data.sessionId
  ensureStream()
  if (announce) log('sys', `已切到「${data.title || projectPath || workspaceId}」`)
}

/* ------------------------------------------------------------------ */
/* 助理文本流：SSE 优先，隧道不支持串流时自动切长轮询                   */
/* ------------------------------------------------------------------ */

let liveEl = null
let buffer = ''
let spoken = 0
let transport = 'sse' // 'sse' | 'poll'
let pollAbort = null
let cursor = 0
let lastSession = ''

/** 一个帧只在这里处理，SSE 和长轮询共用同一套语义。 */
function handleEvent(ev, data) {
  if (ev === 'start') {
    buffer = ''
    spoken = 0
    liveEl = null
    S.busy = true
    dot('busy')
    setMode('thinking')
    bubble('', false)
    $('say').hidden = true
    return
  }
  if (ev === 'delta') {
    if (data?.text) appendAssistant(data.text)
    return
  }
  if (ev === 'final') {
    if (data?.text) finishAssistant(data.text)
    return
  }
  if (ev === 'tool') {
    if (data?.name) status(`在用 ${data.name}…`)
    return
  }
  if (ev === 'end') {
    S.busy = false
    dot('live')
    flushSpeech(true)
    if (!S.speaking) setMode(S.wake ? 'wake' : 'idle')
    return
  }
  if (ev === 'error') {
    if (data?.message) {
      S.busy = false
      dot('error')
      log('err', data.message)
      setMode(S.wake ? 'wake' : 'idle')
    }
  }
}

function stopStream() {
  if (S.stream) {
    S.stream.close()
    S.stream = null
  }
  if (pollAbort) {
    pollAbort.abort()
    pollAbort = null
  }
}

function ensureStream() {
  stopStream()
  if (!S.sessionId) return
  // 换会话要重置游标，否则会把上一个会话的帧当成本会话的回放
  if (S.sessionId !== lastSession) {
    cursor = -1 // -1 = 还没对齐：长轮询先用「当前最新 seq」起步，不回放历史
    lastSession = S.sessionId
  }
  if (transport === 'poll') return startPoll()

  const es = new EventSource(`${API}/stream?sessionId=${encodeURIComponent(S.sessionId)}`)
  S.stream = es
  let gotFrame = false
  // 公网隧道（cloudflared 临时隧道实测 quic/http2 都一样）会把 SSE 整段缓冲：
  // 头 200 立刻到、body 一个字节都不来。4 秒内一帧都没有就切长轮询。
  const probe = setTimeout(() => {
    if (S.stream === es && !gotFrame) {
      gotFrame = true
      es.close()
      S.stream = null
      transport = 'poll'
      log('sys', '这条连接不支持串流推送，已切到长轮询（功能一样，只是推送改为每轮一次请求）')
      startPoll()
    }
  }, 4000)

  const on = (name) => (event) => {
    if (!gotFrame) {
      gotFrame = true
      clearTimeout(probe)
    }
    if (name === 'message') return
    let data = null
    try {
      data = JSON.parse(event.data)
    } catch {
      data = null
    }
    handleEvent(name, data)
  }
  // hello 是服务端推的开场帧：能收到它，就说明这条连接真的在流式传输。
  es.addEventListener('hello', () => {
    if (!gotFrame) {
      gotFrame = true
      clearTimeout(probe)
    }
  })
  for (const name of ['start', 'delta', 'final', 'tool', 'end', 'error']) {
    es.addEventListener(name, on(name))
  }
  // 外部播报（音箱 / 手表 / MCP 调 /api/say）也走这条流；走不了流的地方由轮询兜底。
  es.addEventListener('say', (event) => {
    if (!gotFrame) {
      gotFrame = true
      clearTimeout(probe)
    }
    try {
      onSay(JSON.parse(event.data))
    } catch {
      /* 坏帧丢掉 */
    }
  })
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED && S.stream === es) {
      setTimeout(() => {
        if (S.stream === es) ensureStream()
      }, 1500)
    }
  }
}

/** 长轮询：cursor 断点续传，断网重连也不会丢帧（服务端留了最近 400 帧）。 */
async function startPoll() {
  const sessionId = S.sessionId
  pollAbort = new AbortController()
  const signal = pollAbort.signal
  while (!signal.aborted && S.sessionId === sessionId) {
    if (cursor < 0) {
      try {
        const peek = await (
          await fetch(`${API}/poll?sessionId=${encodeURIComponent(sessionId)}&cursor=-1&wait=0`, { signal })
        ).json()
        if (typeof peek?.cursor === 'number') cursor = peek.cursor
        else cursor = 0
        continue
      } catch (error) {
        if (signal.aborted) return
        await new Promise((r) => setTimeout(r, 800))
        continue
      }
    }
    let data
    try {
      const res = await fetch(`${API}/poll?sessionId=${encodeURIComponent(sessionId)}&cursor=${cursor}&wait=20000`, {
        signal,
        headers: { accept: 'application/json' },
      })
      data = await res.json()
    } catch (error) {
      if (signal.aborted) return
      log('err', `推送连接断开，1.5 秒后重连：${error.message || error}`)
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    for (const frame of data?.frames ?? []) {
      cursor = Math.max(cursor, frame.seq)
      handleEvent(frame.event, frame.data)
    }
    if (typeof data?.cursor === 'number') cursor = Math.max(cursor, data.cursor)
  }
}

function parse(event) {
  try {
    return JSON.parse(event.data)
  } catch {
    return null
  }
}

function appendAssistant(text) {
  buffer += text
  setMode('talking')
  if (!liveEl) {
    $('say').hidden = true
    liveEl = log('pet', '')
  }
  liveEl.textContent = buffer
  scrollChat()
  flushSpeech(false)
}

/** 整段最终文本（SSE 漏掉增量时的兜底）。 */
function finishAssistant(text) {
  if (!buffer || text.length > buffer.length) {
    buffer = text
    appendAssistant('')
  }
  S.busy = false
  flushSpeech(true)
  if (!S.speaking) setMode(S.wake ? 'wake' : 'idle')
}

/* ------------------------------------------------------------------ */
/* 朗读：神经语音优先（宿主侧 edge-tts），失败回退系统语音              */
/* ------------------------------------------------------------------ */

const TTS_KEY = 'pv.ttsVoice'
const TTS_PRESET_KEY = 'pv.ttsPreset'
const TTS_FALLBACK_VOICE = 'zh-CN-XiaoyiNeural'
/** 试听固定句（也用来验证 pitch/rate 真的生效）。 */
const TTS_SAMPLE = '我是鲸灵，今天想让我帮你做点什么？'

/**
 * 神经语音引擎。宿主 `/api/tts` 边合边推 mp3，这里按句串行排队播放：
 * 第一句一到就播，后面的句子在播放期间预取，保证不重叠、不留空档。
 * 任何一步失败 → `unavailable=true`，本次会话后续句子直接走系统语音，
 * 并且只提示一次，不刷屏。
 */
const TTS = {
  voices: [],
  presets: [],
  preset: localStorage.getItem(TTS_PRESET_KEY) || '', // 档位 id（服务端解析成 voice/rate/pitch）
  voice: localStorage.getItem(TTS_KEY) || TTS_FALLBACK_VOICE,
  rate: '+4%',
  pitch: '+0Hz',
  ready: null, // null=没问过 / true=宿主装好了 / false=没装
  unavailable: false,
  warned: false,
  queue: [], // {text, pending, blobUrl}
  running: false,
  audio: null,
  unlocked: false,
}

/** 清掉 markdown 痕迹，避免把 `**`、代码块念出来。 */
// 和服务端 stripForSpeech 同一条规则：标记念不出来，代码块整段不读。
function cleanForSpeech(text) {
  let out = String(text ?? '')
  if (!out.trim()) return ''
  out = out.replace(/```[^\n]*\n[\s\S]*?```/g, ' ')
  out = out.replace(/~~~[^\n]*\n[\s\S]*?~~~/g, ' ')
  out = out.replace(/```[\s\S]*$/, ' ')
  out = out.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm, '')
  out = out.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_all, inner) =>
    String(inner).split('|').map((cell) => cell.trim()).filter(Boolean).join('，'))
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, ' 图片 ')
  out = out.replace(/\[([^\]]*)\]\(\s*<?((?:[^()\s>]|\([^()]*\))*)>?\s*\)/g, (_all, label, href) =>
    /^https?:/i.test(href) ? label : label || '链接')
  out = out.replace(/(?:https?:\/\/|www\.)[^\s)」』，。；、]+/g, '链接 ')
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '')
  out = out.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  out = out.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]*/gm, '')
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  out = out.replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
  out = out.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
  out = out.replace(/__([^_]+)__/g, '$1')
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1$2')
  out = out.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1$2')
  out = out.replace(/~~([^~]+)~~/g, '$1')
  out = out.replace(/`+([^`]*)`+/g, '$1')
  out = out.replace(/[ \t]*\n[ \t]*\n[ \t]*/g, '。')
  out = out.replace(/[ \t]*\n[ \t]*/g, '，')
  out = out
    .replace(/[，,]{2,}/g, '，')
    .replace(/。{2,}/g, '。')
    .replace(/([。！？])[，、]/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[，。！？；：、\s]+/, '')
    .replace(/[，、；：\s]+$/, '')
  return out.replace(/[#*`~]|\[|\]\(/g, '').replace(/[[\]]/g, '').trim()
}

/* ---------- 音色列表 ---------- */

async function loadVoices() {
  const sel = $('voiceSel')
  try {
    const res = await fetch(`${API}/tts/voices`, { credentials: 'same-origin' })
    const data = await res.json()
    TTS.ready = Boolean(data.ready)
    TTS.voices = Array.isArray(data.voices) ? data.voices : []
    TTS.presets = Array.isArray(data.presets) ? data.presets : []
    const presetIds = TTS.presets.map((v) => v.id)
    if (!presetIds.includes(TTS.preset)) TTS.preset = data.defaultPreset || presetIds[0] || ''
    applyPreset(TTS.preset)
    const ids = TTS.voices.map((v) => v.id)
    if (!ids.includes(TTS.voice)) TTS.voice = data.default || TTS_FALLBACK_VOICE
    sel.innerHTML = ''
    if (TTS.presets.length) {
      for (const item of TTS.presets) {
        const option = document.createElement('option')
        option.value = item.id
        option.textContent = item.label || item.id
        sel.append(option)
      }
      sel.value = TTS.preset
      sel.onchange = () => {
        applyPreset(sel.value)
        log('sys', `音色切到「${TTS.presets.find((p) => p.id === sel.value)?.label ?? sel.value}」`)
      }
    } else {
      for (const item of TTS.voices) {
        const option = document.createElement('option')
        option.value = item.id
        option.textContent = item.label || item.id
        sel.append(option)
      }
      sel.value = TTS.voice
    }
    if (!TTS.ready) {
      const option = document.createElement('option')
      option.disabled = true
      option.textContent = '（神经语音未安装，先跑 tts/setup.sh）'
      sel.append(option)
    }
    if (!TTS.presets.length) sel.value = TTS.voice
  } catch (error) {
    TTS.ready = false
    log('sys', `取音色列表失败：${error?.message ?? error}（朗读走系统语音）`)
  }
}

/** 选中档位 → 落到 TTS.voice/rate/pitch，并各写回 localStorage（下次开页面还是这只嗓子）。 */
function applyPreset(id) {
  const hit = TTS.presets.find((item) => item.id === id) ?? null
  if (!hit) {
    TTS.preset = ''
    TTS.rate = '+4%'
    TTS.pitch = '+0Hz'
    return
  }
  TTS.preset = hit.id
  TTS.voice = hit.voice
  TTS.rate = hit.rate || '+0%'
  TTS.pitch = hit.pitch || '+0Hz'
  localStorage.setItem(TTS_PRESET_KEY, TTS.preset)
  localStorage.setItem(TTS_KEY, TTS.voice)
}

/* ---------- 系统语音（兜底） ---------- */

let sysVoice = null

function pickSystemVoice() {
  const voices = window.speechSynthesis?.getVoices?.() ?? []
  if (!voices.length) return null
  const zh = voices.filter((v) => /^zh/i.test(v.lang))
  return zh.find((v) => /Tingting|婷婷|Xiaoxiao|晓晓|Google 普通话/i.test(v.name)) ?? zh[0] ?? null
}

if (window.speechSynthesis) {
  sysVoice = pickSystemVoice()
  speechSynthesis.onvoiceschanged = () => {
    sysVoice = pickSystemVoice()
  }
}

function speakSystem(text) {
  if (!window.speechSynthesis) return Promise.resolve()
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.rate = 1.06
    utterance.pitch = 1.14
    if (sysVoice) utterance.voice = sysVoice
    const finish = () => {
      S.speaking = false
      resolve()
    }
    utterance.onstart = () => {
      S.speaking = true
      setMode('talking')
    }
    utterance.onend = finish
    utterance.onerror = finish
    speechSynthesis.speak(utterance)
  })
}

/* ---------- 神经语音队列 ---------- */

/** 从 buffer 里切出可读的句子，逐句入队（。！？；\n 断句，60 字兜底）。 */
function flushSpeech(final) {
  if (!S.tts) return
  const pending = buffer.slice(spoken)
  if (!pending.trim()) return

  let cut = -1
  for (let i = 0; i < pending.length; i += 1) {
    if ('。！？!?…\n'.includes(pending[i])) cut = i + 1
    if (cut > 0 && pending.slice(0, cut).trim().length >= 6) break
  }
  if (cut < 0 && final) cut = pending.length
  if (cut < 0 && pending.length >= 60) cut = Math.max(pending.lastIndexOf('，') + 1, 60)
  if (cut <= 0) return

  const chunk = pending.slice(0, cut)
  spoken += cut
  enqueueSpeech(speechFromChunk(chunk))
}

// 逐句入队时围栏可能被切断：按块内 ``` 数量翻转状态，围栏内的文本不念。
let inCodeFence = false
function speechFromChunk(chunk) {
  const marks = chunk.match(/```/g) ?? []
  if (inCodeFence) {
    if (marks.length % 2 === 1) inCodeFence = false
    return ''
  }
  if (marks.length) {
    const head = chunk.slice(0, chunk.indexOf('```'))
    if (marks.length % 2 === 1) inCodeFence = true
    return head
  }
  return chunk
}

function enqueueSpeech(text) {
  const clean = cleanForSpeech(text)
  if (!clean) return
  if (TTS.unavailable) {
    void speakSystem(clean)
    return
  }
  TTS.queue.push({ text: clean, pending: null, blobUrl: '' })
  void pumpTts()
}

/** 请求一句的 mp3（blob）。同一句只请求一次。 */
function requestTts(job) {
  if (job.blobUrl) return Promise.resolve(job.blobUrl)
  if (job.pending) return job.pending
  // 档位交给服务端解析（voice/rate/pitch 同步生效）；没有档位列表时退回单音色 + 固定语速。
  const qs = TTS.preset
    ? new URLSearchParams({ text: job.text, preset: TTS.preset })
    : new URLSearchParams({ text: job.text, voice: TTS.voice, rate: TTS.rate, pitch: TTS.pitch })
  job.pending = fetch(`${API}/tts?${qs}`, { credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) {
        let detail = ''
        try {
          detail = (await res.json())?.error ?? ''
        } catch {
          /* 非 JSON */
        }
        const error = new Error(`神经语音 HTTP ${res.status}${detail ? `：${detail}` : ''}`)
        error.status = res.status
        throw error
      }
      const blob = await res.blob()
      if (blob.size < 800) throw new Error('神经语音返回的音频为空')
      job.blobUrl = URL.createObjectURL(blob)
      job.pending = null
      return job.blobUrl
    })
    .catch((error) => {
      job.pending = null
      throw error
    })
  return job.pending
}

/** 播一段 blob URL，返回 Promise（播完/被打断/失败都 resolve 或 reject）。 */
function playAudioUrl(url) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url)
    audio.preload = 'auto'
    TTS.audio = audio
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      audio.onended = null
      audio.onerror = null
      audio.onpause = null
      if (TTS.audio === audio) TTS.audio = null
      resolve()
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      audio.onended = null
      audio.onerror = null
      audio.onpause = null
      if (TTS.audio === audio) TTS.audio = null
      reject(error instanceof Error ? error : new Error('音频播放失败'))
    }
    audio.onended = done
    // stopSpeaking() 会 pause，这里当「本句结束」处理，别让队列卡死
    audio.onpause = done
    audio.onerror = () => fail(new Error('音频解码失败'))
    audio
      .play()
      .then(() => {
        S.speaking = true
        setMode('talking')
      })
      .catch((error) => fail(error))
  })
}

function markTtsUnavailable(error) {
  TTS.unavailable = true
  if (TTS.warned) return
  TTS.warned = true
  const hint =
    error?.status === 503
      ? '在电脑上运行 plugins/dsh-pet-voice/tts/setup.sh 就能用神经语音'
      : '这次先用系统语音'
  log('sys', `神经语音不可用，已回退系统语音（${hint}）`)
}

async function pumpTts() {
  if (TTS.running) return
  TTS.running = true
  startMouth()
  try {
    while (TTS.queue.length) {
      const job = TTS.queue.shift()
      const next = TTS.queue[0]
      // 当前句播放期间把下一句预取好，句间就不留空档。
      const prefetch = !TTS.unavailable && next ? requestTts(next).catch(() => '') : null
      if (TTS.unavailable) {
        await speakSystem(job.text)
      } else {
        try {
          const url = await requestTts(job)
          await playAudioUrl(url)
        } catch (error) {
          markTtsUnavailable(error)
          await speakSystem(job.text)
        }
      }
      if (job.blobUrl) {
        URL.revokeObjectURL(job.blobUrl)
        job.blobUrl = ''
      }
      if (prefetch) await prefetch
    }
  } finally {
    TTS.running = false
    stopMouth()
    if (!S.busy && !S.speaking) setMode(S.wake ? 'wake' : 'idle')
  }
}

/* ---------- 说话时的嘴型动画 ---------- */

let mouthTimer = null

function startMouth() {
  if (mouthTimer) return
  mouthTimer = setInterval(() => pet.setMouth(0.25 + Math.random() * 0.7), 95)
}

function stopMouth() {
  if (mouthTimer) {
    clearInterval(mouthTimer)
    mouthTimer = null
  }
  pet.setMouth(0)
  if (!TTS.running) S.speaking = false
}

function stopSpeaking() {
  // 清队列 + 停当前音频 + 停系统语音；正在跑的 pumpTts 会因为 pause 自行收敛。
  for (const job of TTS.queue) {
    if (job.blobUrl) URL.revokeObjectURL(job.blobUrl)
    job.blobUrl = ''
  }
  TTS.queue.length = 0
  if (TTS.audio) {
    try {
      TTS.audio.pause()
    } catch {
      /* 忽略 */
    }
    TTS.audio = null
  }
  if (window.speechSynthesis) speechSynthesis.cancel()
  S.speaking = false
  stopMouth()
}

/**
 * iOS/Safari 要求音频必须由用户手势解锁。第一次按住说话/发送时播一个
 * 44 字节的静音 wav 把播放权限打开，之后 <audio> 才能自动播。
 */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAiAAAAPoAAAACABAAZGF0YQAAAAA='

function unlockAudio() {
  if (TTS.unlocked) return
  TTS.unlocked = true
  try {
    const audio = new Audio(SILENT_WAV)
    audio.volume = 0
    const result = audio.play()
    if (result?.catch) result.catch(() => {})
  } catch {
    /* 解锁失败就让系统语音兜底 */
  }
}

/* ------------------------------------------------------------------ */
/* 外部播报：/api/say → 走同一条 TTS 管线念出来                       */
/* ------------------------------------------------------------------ */

const saidSeqs = new Set()
let saySince = null // null = 还没对齐；数字 = 已经念到哪一条
let sayTimer = null

/** 去重 + 入队。正在说话时不会抢，新话自然排在队列尾部。 */
function onSay(item) {
  if (!item || typeof item.seq !== 'number') return
  if (saidSeqs.has(item.seq)) return
  saidSeqs.add(item.seq)
  saySince = saySince === null ? item.seq : Math.max(saySince, item.seq)
  if (saidSeqs.size > 200) {
    const floor = item.seq - 100
    for (const seq of saidSeqs) if (seq <= floor) saidSeqs.delete(seq)
  }
  unlockAudio()
  enqueueSpeech(item.text)
  log('sys', `📣 ${item.text}`)
}

/** 轮询兜底：SSE 被隧道缓冲时，每 1.5 s 拉一次。 */
async function pullSay() {
  if (saySince === null) return
  try {
    const res = await fetch(`${API}/say?since=${saySince}`, { credentials: 'same-origin' })
    if (!res.ok) return
    const data = await res.json()
    for (const item of data.items ?? []) onSay(item)
    if (typeof data.cursor === 'number' && data.cursor > (saySince ?? 0)) saySince = data.cursor
  } catch {
    /* 断线时下一轮再来 */
  }
}

async function initSay() {
  try {
    // since=-1 只取当前游标：刷新页面不该把历史播报重念一遍。
    const res = await fetch(`${API}/say?since=-1`, { credentials: 'same-origin' })
    const data = await res.json()
    saySince = typeof data.cursor === 'number' ? data.cursor : 0
  } catch {
    saySince = 0
  }
  if (sayTimer) clearInterval(sayTimer)
  sayTimer = setInterval(() => void pullSay(), 1500)
}

/* ------------------------------------------------------------------ */
/* 派发                                                               */
/* ------------------------------------------------------------------ */

async function submit(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return
  unlockAudio()
  stopSpeaking()
  buffer = ''
  spoken = 0
  liveEl = null
  $('say').hidden = true
  log('me', clean)
  setMode('thinking')
  dot('busy')
  S.busy = true

  const data = await api('/dispatch', {
    method: 'POST',
    body: {
      text: clean,
      workspaceId: S.workspaceId,
      projectPath: S.projectPath,
      preset: S.preset,
      sessionId: S.sessionId || undefined,
    },
  })
  if (!data.ok) {
    S.busy = false
    dot('error')
    log('err', data.error ?? '派发失败')
    setMode(S.wake ? 'wake' : 'idle')
    return
  }
  if (data.sessionId && data.sessionId !== S.sessionId) {
    S.sessionId = data.sessionId
    ensureStream()
  }
}

/* ------------------------------------------------------------------ */
/* 语音识别                                                           */
/* ------------------------------------------------------------------ */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition
let recognizer = null
let recognizerMode = 'idle'
let utteranceText = ''
let silenceTimer = null
let sawWake = false

function srAvailable() {
  return Boolean(SR)
}

function stopRecognizer() {
  if (!recognizer) return
  const rec = recognizer
  recognizer = null
  recognizerMode = 'idle'
  try {
    rec.onend = null
    rec.stop()
  } catch {
    /* 已经停了 */
  }
}

function startWake() {
  if (!srAvailable()) {
    log('err', '这个浏览器不支持语音识别：请用 Chrome / Edge，或直接用下面的输入框打字。')
    setWake(false)
    return
  }
  stopRecognizer()
  const rec = new SR()
  rec.lang = 'zh-CN'
  rec.continuous = true
  rec.interimResults = true
  rec.maxAlternatives = 1
  rec.onresult = onResult
  rec.onerror = onRecError
  rec.onend = () => {
    if (recognizer === rec && S.wake) {
      try {
        rec.start()
      } catch {
        /* 重启过快，忽略 */
      }
    }
  }
  recognizer = rec
  recognizerMode = 'wake'
  sawWake = false
  utteranceText = ''
  try {
    rec.start()
    setMode('wake')
    dot('live')
  } catch (error) {
    log('err', `麦克风启动失败：${error?.message ?? error}`)
    setWake(false)
  }
}

function startPushToTalk() {
  unlockAudio()
  if (!srAvailable()) {
    log('err', '这个浏览器不支持语音识别，请直接打字。')
    return
  }
  stopRecognizer()
  const rec = new SR()
  rec.lang = 'zh-CN'
  rec.continuous = true
  rec.interimResults = true
  rec.onresult = onResult
  rec.onerror = onRecError
  rec.onend = () => {
    if (recognizer === rec) {
      recognizer = null
      recognizerMode = 'idle'
      const text = utteranceText.trim()
      utteranceText = ''
      if (text) void submit(text)
      else setMode(S.wake ? 'wake' : 'idle')
    }
  }
  recognizer = rec
  recognizerMode = 'ptt'
  utteranceText = ''
  sawWake = true
  try {
    rec.start()
    setRecUI(true)
    setMode('ptt')
  } catch (error) {
    log('err', `麦克风启动失败：${error?.message ?? error}`)
  }
}

function onRecError(event) {
  if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
    log('err', '麦克风权限被拒绝：请在浏览器地址栏允许麦克风，并确认页面是 https。')
    setWake(false)
    return
  }
  if (event.error === 'no-speech' || event.error === 'aborted') return
  status(`识别出错：${event.error}`)
}

/** 唤醒词匹配：容忍「鲸灵，」「小鲸啊」这类粘连。 */
function matchWake(text) {
  const normalized = text.replace(/[\s，,、。.．!！?？]/g, '')
  for (const word of S.wakeWords) {
    const key = word.replace(/[\s，,、。.．!！?？]/g, '')
    if (!key) continue
    const at = normalized.indexOf(key)
    if (at >= 0) {
      return text.slice(Math.min(text.length, at + key.length))
    }
  }
  return null
}

function onResult(event) {
  let text = ''
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    text += event.results[i][0]?.transcript ?? ''
  }
  const chunk = text.trim()
  if (!chunk) return

  if (!sawWake) {
    const rest = matchWake(chunk)
    if (rest === null) return
    sawWake = true
    chime()
    if (navigator.vibrate) navigator.vibrate(18)
    utteranceText = rest
  } else {
    utteranceText += chunk
  }

  bubble(utteranceText || '在听…', true)
  if (!utteranceText) status('在听…')
  if (silenceTimer) clearTimeout(silenceTimer)
  silenceTimer = setTimeout(() => {
    const text = utteranceText.trim()
    utteranceText = ''
    sawWake = false
    $('say').hidden = true
    if (text) void submit(text)
    else if (S.wake) setMode('wake')
  }, 1100)
}

function chime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!AudioCtx) return
    const ac = new AudioCtx()
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ac.currentTime)
    osc.frequency.exponentialRampToValueAtTime(1320, ac.currentTime + 0.12)
    gain.gain.setValueAtTime(0.0001, ac.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.22)
    osc.connect(gain).connect(ac.destination)
    osc.start()
    osc.stop(ac.currentTime + 0.24)
    setTimeout(() => ac.close?.(), 400)
  } catch {
    /* 没有声音也能用 */
  }
}

function setWake(on) {
  S.wake = Boolean(on) && srAvailable()
  const btn = $('wakeBtn')
  btn.dataset.on = S.wake ? '1' : '0'
  btn.setAttribute('aria-pressed', S.wake ? 'true' : 'false')
  btn.textContent = S.wake ? '常听：开' : '常听：关'
  if (S.wake) startWake()
  else {
    stopRecognizer()
    setMode('idle')
  }
}

function setTts(on) {
  S.tts = Boolean(on)
  const btn = $('ttsBtn')
  btn.dataset.on = S.tts ? '1' : '0'
  btn.setAttribute('aria-pressed', S.tts ? 'true' : 'false')
  btn.textContent = S.tts ? '朗读：开' : '朗读：关'
  if (!S.tts) stopSpeaking()
}

/* ------------------------------------------------------------------ */
/* 绑定                                                               */
/* ------------------------------------------------------------------ */

function setRecUI(on) {
  const mic = $('mic')
  mic.dataset.state = on ? 'rec' : 'idle'
  mic.setAttribute('aria-pressed', on ? 'true' : 'false')
}

$('mic').addEventListener('pointerdown', (event) => {
  event.preventDefault()
  if (S.busy) {
    stopSpeaking()
    return
  }
  startPushToTalk()
})
$('mic').addEventListener('pointerup', () => {
  setRecUI(false)
  if (recognizerMode === 'ptt' && recognizer) {
    try {
      recognizer.stop()
    } catch {
      /* 忽略 */
    }
  }
})
$('mic').addEventListener('pointercancel', () => {
  setRecUI(false)
  if (recognizerMode === 'ptt') stopRecognizer()
})

$('voiceSel').addEventListener('change', (event) => {
  TTS.voice = event.target.value
  localStorage.setItem(TTS_KEY, TTS.voice)
  stopSpeaking()
  const label = TTS.voices.find((v) => v.id === TTS.voice)?.label ?? TTS.voice
  log('sys', `音色已切换：${label}（下一句生效）`)
})

$('wakeBtn').addEventListener('click', () => setWake(!S.wake))
$('ttsBtn').addEventListener('click', () => setTts(!S.tts))

$('composer').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $('text')
  const text = input.value
  input.value = ''
  void submit(text)
})

$('openSheet').addEventListener('click', () => {
  $('sheet').hidden = false
  void refreshSheet()
})
$('closeSheet').addEventListener('click', () => {
  $('sheet').hidden = true
})

$('projectSel').addEventListener('change', (event) => selectProject(event.target.value))
$('presetSel').addEventListener('change', (event) => {
  S.preset = event.target.value
  localStorage.setItem('pet.preset', S.preset)
  log('sys', S.preset ? `人设已切换：${S.preset}（下一个会话生效）` : '人设跟随宿主默认')
})

$('newSession').addEventListener('click', () => {
  $('sheet').hidden = true
  void openSessionFor(S.workspaceId, S.projectPath, { announce: true, fresh: true })
})

$('cancelBtn').addEventListener('click', async () => {
  stopSpeaking()
  const data = await api('/cancel', { method: 'POST', body: { sessionId: S.sessionId } })
  log('sys', data.ok ? '已打断当前回答' : `打断失败：${data.error ?? '未知错误'}`)
})

$('selfcheck').addEventListener('click', async () => {
  const pre = $('report')
  pre.hidden = false
  pre.textContent = '自检中…'
  const data = await api('/selfcheck')
  pre.textContent = JSON.stringify(data, null, 2)
})

$('copyLink').addEventListener('click', async () => {
  // 完整 token 只在服务端按需给（/api/link 需要已登录的 cookie），页面状态里没有。
  let link = ''
  try {
    const data = await api('/link')
    link = data?.url ?? ''
  } catch {
    /* 下面提示 */
  }
  if (!link) {
    log('err', `取不到配对链接；在电脑上执行 cat ~/.dsh/pet-voice/token 查看（当前生效前 8 位：${S.tokenHint || '未知'}）`)
    return
  }
  try {
    await navigator.clipboard.writeText(link)
    log('sys', '分享链接已复制（同一个 token，别外传）')
  } catch {
    log('sys', link)
  }
})

async function refreshSheet() {
  fillProjects()
  fillPresets()
}

/* iOS 要求用户手势后才能出声：第一次点屏幕就把音频通道解锁。 */
window.addEventListener('pointerdown', () => unlockAudio(), { once: true })

/* 背景气泡 */
;(function bubbles() {
  const host = $('bubbles')
  for (let i = 0; i < 16; i += 1) {
    const b = document.createElement('i')
    const size = 5 + Math.random() * 11
    b.style.left = `${Math.random() * 100}%`
    b.style.width = `${size}px`
    b.style.height = `${size}px`
    b.style.animationDuration = `${13 + Math.random() * 15}s`
    b.style.animationDelay = `${-Math.random() * 20}s`
    host.appendChild(b)
  }
})()

$('petWrap').addEventListener('click', () => pet.tap())

void loadState()
void loadVoices()
void initSay()
initGuide()
setTts(true)


/* ------------------------------------------------------------------ */
/* 加到主屏 / Siri 唤醒引导卡                                          */
/* ------------------------------------------------------------------ */

/**
 * 卡片里的地址必须是「手机打得开」的那条：优先服务端知道的公网隧道地址，
 * 退而求其次局域网地址，最后一档本机地址并如实说明手机打不开。
 * 地址本身不含令牌（配对靠二维码/首次手输），所以可以放心展示。
 */
async function refreshPairAddress() {
  const urlBox = $('pairUrl')
  const note = $('pairSource')
  let info = null
  try {
    const res = await fetch(`${API}/pair`, { credentials: 'same-origin' })
    if (res.ok) info = await res.json()
  } catch {
    /* 取不到就用兜底地址 */
  }
  const base = info?.publicBase || `${location.origin}/pet-voice/`
  if (urlBox) urlBox.textContent = base
  if (note) {
    const source = info?.source ?? 'local'
    const alive = info?.alive
    note.dataset.source = source
    note.dataset.alive = String(alive)
    note.textContent =
      source === 'tunnel'
        ? alive === false
          ? `⚠️ ${info?.note ?? '隧道域名可能已过期（cloudflared 重启会换域名）'}，地址先按下面这条试`
          : '✅ 公网隧道地址：手机流量、别人手机都能直接打开'
        : source === 'lan'
          ? '⚠️ 局域网地址：同一个 WiFi 能打开，出门打不开（要在外面用，先在电脑上起隧道）'
          : '⚠️ 本机地址：手机打不开（先在电脑上起 cloudflared 隧道，再回来看这张卡）'
  }
  return info
}

function initGuide() {
  const sheet = $('guideSheet')
  if (!sheet) return
  void refreshPairAddress()
  $('guideBtn')?.addEventListener('click', () => {
    void refreshPairAddress()
    sheet.hidden = false
  })
  $('closeGuide')?.addEventListener('click', () => {
    sheet.hidden = true
  })
  // 故意不提供二维码图：assets 走的是不鉴权静态路由，图里若编了带 token 的配对链接，
  // 任何能碰到隧道域名的人都能白拿一份。配对统一走「复制配对链接」或 App 里手输令牌。
  $('voiceTry')?.addEventListener('click', () => {
    unlockAudio()
    TTS.queue.length = 0 // 试听优先：丢掉没念完的排队句，别让用户等
    enqueueSpeech(TTS_SAMPLE)
  })
}
