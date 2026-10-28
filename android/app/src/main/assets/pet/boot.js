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
// 以前待机 900ms 就把 rAF 停掉「省电」，可角色本来就是一直在动的直播画面：
// 停了之后左等右等还是那张静帧，下一次交互再恢复，屏幕上是「卡住→突然动起来」，
// 这就是「动作衔接不流畅」的一半来源。渲染只在熄屏/不可见时才停（见 setActive/visibility）。
function freezeWhenIdle () { /* 不再冻结 rAF */ }

let sayGeomKey = ''
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
// 逗过头之后换着花样炸：连吓两次同一段等于没反应
let lastBurst = ''
// 逗过头的后续反应用一个「不重复袋」轮流抽：袋空了再洗一遍，且洗的时候
// 把刚播过的那段排到最后，连点 8–10 下也不会连着看到同一段。
let burstBag = []
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

// 待机动作只由 anim-pet.js 里的 scheduleIdle 驱动（1.5–3s 一次、带交叉淡化、
// 且会避开上一段）。这里原来是第二套定时器，两套互相 playOnce/playChain 打断，
// 屏幕上就是刚起势就被掐断、再接一段别的——所以这里只清定时器，不再排新的。
function scheduleIdlePlay () {
  clearTimeout(idleTimer)
}
function scheduleIdlePlayLegacy () {
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
    // 这一下是这一轮里的第几下（2.6s 内算同一轮）
    const n = now - lastTapAt < 2600 ? taps + 1 : 1
    if (name === 'wave') {
      // v3 素材有真实挥手；老素材没有就退回点击的挥手变体
      if (!pet.playOnce('wave')) pet.tap()
    } else if (name === 'celebrate') {
      pet.celebrate()
    } else if (now - lastInteract > 120000) {
      // 很久没理她，点一下是「惊醒」而不是元气挥手
      pet.playOnce('wake')
    } else if (n >= 5) {
      // 逗过头：吓一跳。分级只在这里做，随机池里没有生气，
      // 所以「点一下突然生气」不会再有，连点才升级。
      // 第 5 下一定是 startle（能被稳定验证）；再往上就不重复同一段惊吓，
      // 换成甩尾/跳/转圈/欢呼这类更炸的反应，并且避开上一段。
      if (n === 5) {
        lastBurst = 'startle'
        pet.playOnce('startle')
      } else {
        // 这里的名字是 playOnce 的 key（ONCE 表），不是素材名：甩尾的 key 是 tail
        // （ONCE.tail = ['tail_slap']）。写成 tail_slap 会查不到 key，静默退回 startle。
        const burstPool = ['tail', 'jump', 'dance', 'cheer']
        if (!burstBag.length) {
          burstBag = burstPool.slice()
          // 洗牌：Fisher–Yates，然后把上一段挪到末尾
          for (let i = burstBag.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            const t = burstBag[i]; burstBag[i] = burstBag[j]; burstBag[j] = t
          }
          const li = burstBag.indexOf(lastBurst)
          // 注意是 unshift：push 到末尾会被紧接着的 pop() 立刻抽回同一段
          if (li >= 0) { burstBag.splice(li, 1); burstBag.unshift(lastBurst) }
        }
        const k = burstBag.pop() || 'startle'
        lastBurst = k
        if (!pet.playOnce(k)) pet.playOnce('startle')
      }
    } else if (n === 4) {
      pet.playOnce('tap_proud')
    } else if (n === 3) {
      pet.playOnce('tap_pout')
    } else if (n === 2) {
      // 第 2 下是「更开心」：从四个变体里挑一个和当前正在播的不一样的，
      // 否则第一下随机到 tap_joy 时第二下还是 tap_joy，看着像没反应。
      const cur = pet.clip && pet.clip()
      const joy = ['tap_joy', 'tap_wave', 'tap_tickle', 'tap_shy'].filter((k) => k !== cur)
      pet.playOnce(joy[Math.floor(Math.random() * joy.length)] || 'tap_joy')
    } else {
      pet.tap()
    }
    taps = n
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
  /**
   * 气泡让位量的唯一计算处。
   *
   * 气泡出现时原生会把窗口往上加高 30dp（留白），气泡跟着窗口顶上去了，
   * 人物按「没加高时」的窗口居中 —— 于是头顶和气泡下沿自然错开，不用再挪人。
   * 但加高是异步的：留白刚下发时窗口还没重新布局，这一帧量到的还是旧尺寸。
   * 所以窗口每次尺寸变化后（anim-pet.js 的 fit）都要再算一次，别把旧尺寸写死。
   */
  letWay (force) {
    if (!force && !document.body.classList.contains('has-bubble')) return
    const stageH = window.innerHeight
    if (!(stageH > 0)) return
    // 气泡底边：top 2 + 高 72 + 4px 缝（72 与 #bubble 的 height 一致，两处要一起改）
    const bubBottom = 78
    const box = window.__petBodyBox ? window.__petBodyBox() : null
    let shiftPx = Math.round((box && box.h > 0 ? box.h : stageH) * 0.14)
    if (box && box.h > 0 && box.bottom > box.top) {
      // 让位只做一件事：把人物下移到头顶露在气泡下沿之外，永不缩放。
      // 缩放就是「点一下变小」的观感来源；下移过头则脚被窗口切掉，画面上就是「不完整」。
      // 上限 = 脚下到窗口底真正还剩多少（box 是人物墨迹框，不是整块画布）。
      // 以前这里多给了 2% 当「透明留白」，实测那 2% 已经吃进肉里：脚会掉出窗口 4px。
      // 现在只留 1px 亚像素余量，宁可头顶被气泡压住几像素，也不能裁到脚。
      const headClear = Math.max(0, bubBottom - box.top + 2)
      const slack = Math.max(0, box.h - box.bottom - 1)
      shiftPx = Math.round(Math.min(headClear, slack))
      console.warn('[bubble] 让位算 ' + shiftPx + 'px 头顶=' + box.top.toFixed(1) +
        ' 脚底=' + box.bottom.toFixed(1) + ' 主体高=' + box.h.toFixed(1) +
        ' 窗口=' + stageH + ' 留白=' + (box.pad || 0) +
        ' 需求=' + headClear.toFixed(1) + ' 余量=' + slack.toFixed(1))
    }
    document.documentElement.style.setProperty('--shift', shiftPx + 'px')
    document.documentElement.style.setProperty('--shrink', '1')
    // 只在真的变了时才打一行（窗口尺寸换了才会有），平时一条不多；
    // 用 warn 是因为宿主只把 warn/error 转进 logcat（PetJs），info 看不到。
    const key = shiftPx + ''
    if (key !== sayGeomKey) {
      sayGeomKey = key
      console.warn('[bubble] 让位 ' + shiftPx + 'px')
    }
  },
  say (text) {
    const s = String(text || '').trim()
    if (!s) { bubble.classList.remove('show'); document.body.classList.remove('has-bubble'); return false }
    bubbleText.textContent = s.length > 90 ? s.slice(0, 89) + '…' : s
    // 先算好让位再让气泡出现：--shift / --shrink 必须在 has-bubble 生效前就位。
    // 顺序反了的话，第一次说话会先按 CSS 兜底值缩放一帧、再跳到量出来的值，
    // 看起来就是「点一下先缩一下、又缩一下」。stageH 没布局好（0）时保持上一次的值。
    this.letWay(true)
    bubble.classList.add('show')
    document.body.classList.add('has-bubble')
    // 让位实测：气泡可见期间舞台的合成矩阵必须是纯平移（缩放 = 1），
    // 出现缩放就是「点一下变小」的观感来源。520ms 后再量，避开 .42s 过渡。
    setTimeout(() => {
      try {
        const m = getComputedStyle(stage).transform
        let scale = '1'
        if (m && m.startsWith('matrix(')) {
          const p = m.slice(7, -1).split(',').map(Number)
          scale = Math.hypot(p[0], p[1]).toFixed(4)
        }
        console.warn('[bubble] 舞台矩阵 ' + m + ' 缩放 ' + scale)
      } catch (e) {}
    }, 520)
    // 量真实高度再决定身体让位多少：一行、两行、三行都对齐，末字不会被裁。
    // 必须同步量：待机 900ms 后 rAF 会被冻掉，放进 rAF 里这段永远不执行——之前就踩过，
    // --shift 一直是空值、退回默认 52px，120dp 档才会贴头。
    // 视觉缝隙 = 让位量 + 视频帧顶部自带的透明留白（角色内容只占帧高的 40/465 ≈ 8.6%），
    // 所以固定写 18dp 会得到「18 + 0.086×舞台高」的缝：168dp 档 31dp、200dp 档 34dp，太松。
    // 这里按目标 16dp 反解让位量，三档实测 16.0 / 17.1 / 20.0dp。
    // 卡片高度固定 68px（与 #bubble 的 height 一致）：量出来的高度不再随字数变，
    // --shift / --shrink 只跟窗口大小有关，连点不会让小人忽大忽小。
    // 68 是 3 行文字 + padding + 边框的下限，改成别的值时两处必须一起改。
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

// 窗口尺寸变了要重算让位：气泡出现时宿主先把窗口加高，几毫秒后这里才收到浏览器 resize，
// 早算的那一次量到的是旧尺寸（头顶还在气泡底下）。这里只补算，气泡没显示时不动。
window.__petLetWay = function () {
  try { window.PetBridge.letWay() } catch (e) {}
}
window.__PET_READY__ = true
freezeWhenIdle()
