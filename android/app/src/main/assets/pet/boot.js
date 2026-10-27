/**
 * 悬浮窗渲染桥：原生只调 window.PetBridge，不关心绘制细节。
 *
 * 原生接口（Kotlin 里 evaluateJavascript 调）：
 *   PetBridge.setMode('idle' | 'listening' | 'thinking' | 'talking' | 'happy')
 *   PetBridge.setMouth(0..1)          // 播放语音时驱动说话节奏
 *   PetBridge.action('tap'|'celebrate')
 *   PetBridge.setDragging(true|false) // 拖动时播「被拎起来」的动作
 *   PetBridge.say('文本')              // 头顶小气泡；传空串收起
 *   PetBridge.setWho('大肥鱼')           // 气泡署名 = App 里自定义的称呼
 *   PetBridge.setOutfit('sailor')     // 换服装：'' 鲸鱼娘 / sailor maid casual winter princess
 *   PetBridge.setAutoPlay(true|false)  // 待机时自己玩的随机动作
 */
import { createPet } from './anim-pet.js'

// 性能：待机静止后停掉 rAF 循环，恢复时才拉起来。
// 注意：视频自己会解码，这里冻的只是「JS 驱动的那部分」，不是全部开销。
const nativeRaf = window.requestAnimationFrame.bind(window)
let rafPaused = false
let rafQueue = []
window.requestAnimationFrame = function (cb) {
  if (rafPaused) { rafQueue.push(cb); return 0 }
  return nativeRaf(cb)
}
function pauseLoop () { rafPaused = true }
function resumeLoop () {
  if (!rafPaused) return
  rafPaused = false
  const queued = rafQueue
  rafQueue = []
  for (const cb of queued) nativeRaf(cb)
}
function freezeWhenIdle () {
  setTimeout(() => { if (mode === 'idle') pauseLoop() }, 900)
}

const stage = document.getElementById('stage')
const pet = createPet(stage)

const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubbleText')
const whoEl = bubble.querySelector('.who')
let bubbleTimer = 0
let autoPlay = true
let idleTimer = 0
let mode = 'idle'
let active = true
let greeted = false
// 距上一次交互（点击/说话/指令）多久了：用来决定「点一下是挥手还是惊醒」
let lastInteract = Date.now()

/* ---------------- 待机行为 ----------------
 * 素材里有二十段生活化动作，待机时按时间段和权重挑着播：早上醒神、白天活泼、
 * 傍晚热闹、深夜懒散。单发、连招（2–3 段接成一串）、睡下不再乱动，三种节奏。
 */
let taps = 0
let lastTapAt = 0
let sleeping = false

const POOL = {
  morning: [['wake', 2], ['stretch', 3], ['yawn', 2], ['look', 3], ['curtsy', 1], ['cheer', 1], ['tap', 2], ['tap_joy', 1]],
  day: [['look', 4], ['stretch', 2], ['curtsy', 1], ['dance', 2], ['whale', 2], ['tail', 2], ['jump', 1], ['tap', 2], ['tap_wave', 1], ['tap_proud', 1]],
  evening: [['dance', 3], ['tail', 2], ['whale', 2], ['curtsy', 1], ['stretch', 1], ['look', 2], ['tap_joy', 2], ['tap', 1]],
  night: [['sleep', 5], ['yawn', 3], ['stretch', 1], ['look', 1]],
}
const CHAIN = {
  morning: [['yawn', 'stretch'], ['wake', 'look'], ['stretch', 'curtsy']],
  day: [['look', 'curtsy'], ['yawn', 'stretch'], ['jump', 'dance', 'cheer'], ['tail', 'whale', 'tap_joy'], ['stretch', 'look'], ['tap', 'tap_proud']],
  evening: [['tail', 'whale'], ['dance', 'cheer'], ['curtsy', 'tap_joy']],
  night: [['yawn', 'sleep'], ['stretch', 'sleep']],
}
function dayPart () {
  const h = new Date().getHours()
  if (h >= 5 && h < 10) return 'morning'
  if (h >= 10 && h < 18) return 'day'
  if (h >= 18 && h < 23) return 'evening'
  return 'night'
}
function isNight () { return dayPart() === 'night' }

// 最近播过的不马上重播：随机不等于连着三次都是哈欠
const recentIdle = []
function pickWeighted (list) {
  const fresh = list.filter(([k]) => recentIdle.indexOf(k) < 0)
  const base = fresh.length ? fresh : list
  const total = base.reduce((s, a) => s + a[1], 0)
  let r = Math.random() * total
  for (const [key, w] of base) {
    r -= w
    if (r <= 0) return key
  }
  return base[0][0]
}

// 连招：隔 3.8–4.5s 接下一段，中途被打断（说话/点击/拖动）就停
let chainTimer = 0
function playChain (steps, i) {
  if (mode !== 'idle' || !active || i >= steps.length) return
  pet.playOnce(steps[i])
  if (i + 1 < steps.length) {
    chainTimer = setTimeout(() => playChain(steps, i + 1), 3800 + Math.random() * 700)
  }
}
function wakeUp () {
  sleeping = false
  clearTimeout(chainTimer)
}

function idleDelay () {
  const p = dayPart()
  if (p === 'night') return 20000 + Math.random() * 20000
  if (p === 'evening') return 11000 + Math.random() * 12000
  return 9000 + Math.random() * 12000
}

function scheduleIdlePlay () {
  clearTimeout(idleTimer)
  if (!autoPlay || !active) return
  idleTimer = setTimeout(() => {
    if (mode === 'idle' && active && !document.body.classList.contains('has-bubble')) {
      const part = dayPart()
      if (sleeping) {
        // 睡下了就别反复挑动作：偶尔翻个身，醒了由交互叫起
        if (Math.random() < 0.5) pet.playOnce('sleep')
        scheduleIdlePlay()
        return
      }
      const act = pickWeighted(POOL[part])
      recentIdle.push(act)
      while (recentIdle.length > 3) recentIdle.shift()
      sleeping = act === 'sleep'
      const chains = CHAIN[part]
      const chain = chains[Math.floor(Math.random() * chains.length)]
      if (chain && chain[0] === act && Math.random() < 0.6) playChain(chain, 0)
      else pet.playOnce(act)
      // 十几分钟没人理：白天打哈欠睡下，深夜本来就在睡
      if (Date.now() - lastInteract > 12 * 60000 && !sleeping) {
        sleeping = true
        playChain(['yawn', 'sleep'], 0)
      }
    }
    scheduleIdlePlay()
  }, idleDelay())
}

window.PetBridge = {
  setMode (next) {
    mode = String(next || 'idle')
    pet.setMode(mode)
    if (mode !== 'idle') {
      wakeUp()
      clearTimeout(idleTimer)
      clearTimeout(bubbleTimer)
      resumeLoop()
      lastInteract = Date.now()
    } else {
      // 每次回到待机先打个招呼（整页生命周期只一次，别每次说话完都行礼）
      if (!greeted) {
        greeted = true
        // 回来后先按时间段打个招呼：白天屈膝礼，深夜是打着哈欠出来
        setTimeout(() => {
          if (mode === 'idle' && active) {
            const part = dayPart()
            pet.playOnce(part === 'night' ? 'yawn' : part === 'morning' ? 'stretch' : 'curtsy')
          }
        }, 300)
      }
      scheduleIdlePlay()
      freezeWhenIdle()
    }
    return true
  },
  /** 换形象：'' = 原来的鲸鱼娘视频素材；其余是 Aster 立绘服装 id。 */
  setOutfit (id) {
    const next = String(id || '')
    pet.setOutfit(next)
    lastInteract = Date.now()
    resumeLoop()
    return true
  },
  setMouth (value) {
    const v = Number(value)
    if (Number.isFinite(v)) pet.setMouth(Math.max(0, Math.min(1, v)))
    return true
  },
  action (name) {
    resumeLoop()
    lastInteract = Date.now()
    wakeUp()
    const now = Date.now()
    if (name === 'wave') {
      // v3 素材有真实挥手；老素材没有就退回点击的挥手变体
      if (!pet.playOnce('wave')) pet.tap()
      taps = now - lastTapAt < 900 ? taps + 1 : 1
      lastTapAt = now
      freezeWhenIdle()
      return true
    }
    if (name === 'celebrate') {
      pet.celebrate()
    } else if (now - lastInteract > 120000) {
      // 很久没理她，点一下是「惊醒」而不是元气挥手
      pet.playOnce('wake')
    } else if (now - lastTapAt < 900 && taps >= 2) {
      // 连点：第 3 下开始被逗急了（每轮最多放大到「吓一跳」）
      pet.playOnce(taps >= 3 ? 'startle' : 'tap_proud')
    } else {
      pet.tap()
    }
    taps = now - lastTapAt < 900 ? taps + 1 : 1
    lastTapAt = now
    freezeWhenIdle()
    return true
  },
  setDragging (on) {
    resumeLoop()
    lastInteract = Date.now()
    wakeUp()
    pet.setDragging(!!on)
    // 放下之后整理一下仪态/得意一下，比直接切回呼吸自然
    if (!on && Math.random() < 0.45) {
      setTimeout(() => { if (mode === 'idle' && active) pet.playOnce(Math.random() < 0.5 ? 'tap_proud' : 'curtsy') }, 260)
    }
    return !!on
  },
  setWho (name) {
    const s = String(name || '').trim()
    if (s) whoEl.textContent = s
    return whoEl.textContent
  },
  say (text) {
    const s = String(text || '').trim()
    if (!s) { bubble.classList.remove('show'); document.body.classList.remove('has-bubble'); return false }
    bubbleText.textContent = s.length > 90 ? s.slice(0, 89) + '…' : s
    bubble.classList.add('show')
    document.body.classList.add('has-bubble')
    lastInteract = Date.now()
    wakeUp()
    // 量真实高度再决定身体让位多少：一行、两行、三行都对齐，末字不会被裁。
    // 必须同步量：待机 900ms 后 rAF 会被冻掉，放进 rAF 里这段永远不执行——之前就踩过，
    // --shift 一直是空值、退回默认 52px，120dp 档才会贴头。
    // 视觉缝隙 = 让位量 + 视频帧顶部自带的透明留白（角色内容只占帧高的 40/465 ≈ 8.6%），
    // 所以固定写 18dp 会得到「18 + 0.086×舞台高」的缝：168dp 档 31dp、200dp 档 34dp，太松。
    // 这里按目标 16dp 反解让位量，三档实测 16.0 / 17.1 / 20.0dp。
    // 卡片高度固定 62px（与 #bubble 的 height 一致）：量出来的高度不再随字数变，
    // --shift / --shrink 只跟窗口大小有关，连点不会让小人忽大忽小。
    const stageH = window.innerHeight
    const bubH = 62
    const pad = 0.086 * (stageH - bubH)
    const margin = Math.max(2, Math.round((16 - pad) / 0.914))
    const shiftPx = Math.min(Math.ceil(bubH) + margin, Math.round(stageH * 0.6))
    document.documentElement.style.setProperty('--shift', shiftPx + 'px')
    // 让位不用「压矮盒子」，改成等比缩小：可见高度正好少掉让位量，宽高比不变。
    const shrink = Math.max(0.55, Math.min(1, (stageH - shiftPx) / stageH))
    document.documentElement.style.setProperty('--shrink', shrink.toFixed(4))
    clearTimeout(bubbleTimer)
    // 气泡停留时间跟字数走，长一点的话有时间读完
    bubbleTimer = setTimeout(() => { bubble.classList.remove('show'); document.body.classList.remove('has-bubble') }, Math.min(9000, 3200 + s.length * 90))
    return true
  },
  setActive (on) {
    active = !!on
    pet.setActive(active)
    if (!active) clearTimeout(idleTimer)
    else scheduleIdlePlay()
    return active
  },
  setAutoPlay (on) {
    autoPlay = !!on
    if (autoPlay) scheduleIdlePlay(); else clearTimeout(idleTimer)
    return autoPlay
  },
}

// 页面就绪信号：原生据此判断 WebView 可以开始驱动了
window.PetBridge.setAutoPlay(true)
window.__PET_READY__ = true
freezeWhenIdle()
