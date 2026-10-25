/**
 * 悬浮窗形象引擎（画布合成版）——素材是 VP9 + alpha 的角色动画，420×465 @15fps。
 *
 * 为什么不再直接显示 <video>：
 *   1) Android 上透明 <video> 是独立合成层，换 src / 淡入淡出那一瞬合成层重建会露出
 *      一块不透明黑底（就是「点一下悬浮窗附近黑一块」）；素材逐帧查过，没有黑帧；
 *   2) 各段素材裁切锚点不统一（包围盒高 396~465、底边 423~445），直接切层会「大小跳」。
 * 现在：<video> 只当解码器（藏屏幕外），每帧 drawImage 到 canvas，按包围盒统一高度、
 * 统一底边、水平居中 —— 单画布层，没有黑方块，也没有尺寸割裂。
 *
 * 对外接口不变：setMode / setMouth / tap / tapKind / celebrate / playOnce /
 *               setDragging / setActive / destroy
 */
import { idlePool, nextIdleDelay } from './idle.js'

export function createPet (container) {
  const CLIPS = { idle: 'idle', listening: 'idle', thinking: 'thinking', talking: 'talking', happy: 'cheer' }
  const ONCE = {
    tap: ['tap', 'tap_shy', 'tap_tickle', 'tap_pout', 'tap_wave', 'tap_joy'],
    tap_wave: ['tap_wave'],
    tap_joy: ['tap_joy'],
    tap_proud: ['tap_proud'],
    wake: ['wake_up'],
    cheer: ['cheer'],
    drag: ['drag'],
    yawn: ['yawn'],
    look: ['look_around'],
    curtsy: ['curtsy'],
    jump: ['jump'],
    startle: ['startle'],
    stretch: ['stretch'],
    sleep: ['sleep'],
    whale: ['whale_bubble'],
    tail: ['tail_slap'],
    dance: ['dance'],
  }
  // 每段素材的全内容包围盒 [x, y, w, h]：离线逐帧 alpha 统计（含举起的手/尾巴/气泡特效），
  // 只当 drawImage 的源矩形用——取小了会把举高的胳膊裁掉。脚本：scripts/sprite-norm.py
  const NORM = {
    cheer: [0, 0, 420, 445],
    curtsy: [50, 45, 323, 404],
    dance: [72, 82, 281, 345],
    drag: [37, 0, 368, 445],
    idle: [33, 39, 351, 405],
    jump: [82, 24, 266, 404],
    look_around: [44, 43, 348, 401],
    sleep: [63, 64, 288, 358],
    startle: [62, 41, 295, 385],
    stretch: [69, 75, 283, 351],
    tail_slap: [69, 83, 331, 343],
    talking: [50, 41, 321, 403],
    tap: [44, 4, 331, 440],
    tap_joy: [65, 48, 292, 379],
    tap_pout: [44, 46, 329, 399],
    tap_proud: [67, 84, 283, 343],
    tap_shy: [43, 45, 341, 399],
    tap_tickle: [41, 36, 346, 408],
    tap_wave: [66, 47, 286, 379],
    thinking: [31, 30, 339, 414],
    wake_up: [32, 47, 337, 397],
    whale_bubble: [0, 81, 351, 343],
    yawn: [41, 39, 337, 406],
  }
  // 人物主体框 [x, y, w, h]：只用来定缩放和脚底/中心锚点；NORM 是全内容源矩形
  const BODY = {
    cheer: [50, 89, 320, 342],
    curtsy: [62, 99, 306, 345],
    dance: [74, 113, 274, 296],
    drag: [42, 75, 354, 347],
    idle: [52, 77, 317, 346],
    jump: [87, 67, 247, 352],
    look_around: [58, 90, 322, 339],
    sleep: [69, 125, 278, 289],
    startle: [76, 109, 276, 296],
    stretch: [78, 112, 270, 299],
    tail_slap: [70, 120, 288, 304],
    talking: [54, 80, 311, 342],
    tap: [51, 86, 316, 339],
    tap_joy: [74, 127, 273, 284],
    tap_pout: [60, 83, 297, 342],
    tap_proud: [82, 115, 254, 295],
    tap_shy: [47, 100, 324, 337],
    tap_tickle: [50, 89, 322, 341],
    tap_wave: [72, 118, 273, 292],
    thinking: [41, 80, 317, 344],
    wake_up: [44, 99, 322, 340],
    whale_bubble: [60, 116, 280, 292],
    yawn: [56, 86, 319, 348],
  }
  const CW = 420, CH = 465
  // 统一「人物主体」高度：素材历史上有两批渲染，人物在画布里差约 15%，直接按全内容框归一化
  // 会让换动作时人物大小跳（点击缩小一圈就是这个）。所以缩放只按主体框（BODY）算。
  const TARGET_H = 346
  const TARGET_BOTTOM = 444   // 统一脚底基线
  const TARGET_CX = 210       // 统一水平中心

  const src = (name) => '../anim/' + name + '.webm'
  const pick = (list) => list[Math.floor(Math.random() * list.length)]

  const legacy = Array.from(container.querySelectorAll('.pet-video'))
  legacy.forEach((v) => { v.classList.remove('front'); v.style.display = 'none' })

  const vids = [0, 1].map(() => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.setAttribute('muted', '')
    v.setAttribute('playsinline', '')
    v.style.cssText = 'position:absolute;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none'
    v.addEventListener('error', () => { console.warn('[pet] 素材加载失败：' + (v.currentSrc || v.src)) })
    container.appendChild(v)
    return v
  })

  const canvas = document.createElement('canvas')
  canvas.className = 'pet-canvas'
  canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none'
  container.appendChild(canvas)
  const ctx = canvas.getContext('2d', { alpha: true })
  let usingCanvas = !!ctx
  let alphaChecked = false

  function fit () {
    const r = container.getBoundingClientRect()
    const dpr = Math.min(2.5, window.devicePixelRatio || 1)
    const w = Math.max(2, Math.round((r.width || CW) * dpr))
    const h = Math.max(2, Math.round((r.height || CH) * dpr))
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
  }
  fit()
  window.addEventListener('resize', fit)

  let curClip = 'idle'
  let activeVid = null
  let baseMode = 'idle'
  let seq = 0
  let onceTimer = 0
  let onceDeadline = 0          // 原生 __petTick 用同一个截止时刻兜底（setTimeout 被降频也不误事）
  let onceDone = null
  let chainTimer = 0
  let chainDeadline = 0
  let chainNext = null
  let active = true
  let dragging = false
  let destroyed = false
  let pumping = false
  const vidClip = new Map()   // video → 它当前装着哪段素材（过渡时要按各自的包围盒画）
  let fadePrev = null         // { vid, clip, t0, dur }：正在淡出的上一层
  let fadeRaf = 0            // 渐变期间用 rAF 重画，alpha 跟屏幕刷新走，不跟素材帧率走
  let fadeSamples = []        // 一次交接的 alpha 采样，打完日志就清空

  const nowMs = () => (window.performance && performance.now ? performance.now() : Date.now())

  /**
   * 素材真实时长（ms）：帧数 / 帧率。兜底计时只按它走，不再用一个固定的 4.6s，
   * 否则 drag(2.5s)、tap_pout(3.5s) 这类短动作播完会僵在尾帧上。
   * 运行时优先用 video.duration（编码进 webm 的值），拿不到才回这张表。
   */
  const CLIP_DUR = {
    idle: 6000, talking: 6000,
    cheer: 4000, dance: 4000, jump: 4000, sleep: 4000, startle: 4000, stretch: 4000,
    tail_slap: 4000, tap: 4000, tap_joy: 4000, tap_proud: 4000, tap_wave: 4000,
    whale_bubble: 4000, thinking: 4000, wake_up: 4000, look_around: 4000, yawn: 4000,
    curtsy: 3500, tap_pout: 3500, tap_shy: 3500, tap_tickle: 3500, drag: 2500,
  }
  const clipDurMs = (name, v) => {
    if (v && isFinite(v.duration) && v.duration > 0.15) return v.duration * 1000
    return CLIP_DUR[name] || 3000
  }

  /* ===================== Aster 立绘引擎 =====================
   * 5 套服装 × 24 张 420×465 立绘（scripts/build-aster-assets.py 从绿幕原稿抠图生成）。
   * 视频素材是 10–15fps 的逐帧动画，播完就停；立绘改为 canvas 实时合成：
   * 呼吸、点头、眨眼、说话口型、姿势交叉淡化全部按屏幕刷新率插值，因此不会「突然停住」。
   * 原生每帧的 window.__petTick 也会推一次绘制，透明窗被 Chromium 降频时照样能动。
   */
  const AV_MANIFEST = window.ASTER_MANIFEST || null
  const AV_POSE = {
    idle: 'base', listening: 'base', talking: 'base', thinking: 'think', happy: 'happy',
    tap: 'wave', tap_wave: 'wave', tap_joy: 'happy', tap_proud: 'approve', tap_shy: 'shy',
    tap_tickle: 'happy', tap_pout: 'pout', cheer: 'happy', wake_up: 'surprise',
    startle: 'surprise', drag: 'surprise', sleep: 'base', yawn: 'base', stretch: 'base',
    curtsy: 'base', jump: 'happy', dance: 'happy', look_around: 'think',
    tail_slap: 'pout', whale_bubble: 'happy',
  }
  const AV_FADE = 240
  const AV_ONCE = { wave: 1600, happy: 1400, approve: 1200, shy: 1400, pout: 1400, surprise: 1000, think: 1800 }
  const av = {
    on: false, outfit: '', imgs: null, ready: false, pose: 'base', prevPose: '',
    poseT0: 0, speaking: false, quietAt: 0, blinkUntil: 0, nextBlink: 0, lastDraw: 0, timer: 0,
    act: 0, poseHold: 0,
  }
  const avNow = () => (window.performance && performance.now ? performance.now() : Date.now())

  function avImgName (pose, open, blink) {
    if (pose === 'base') {
      if (blink) return open ? '04_base_blink_open' : '03_base_blink_closed'
      return open ? '02_base_open' : '01_base_closed'
    }
    return pose + (open ? '_open' : '_closed')
  }
  function avImg (pose, open, blink) {
    if (!av.imgs) return null
    return av.imgs[avImgName(pose, open, blink)] || av.imgs[avImgName(pose, false, false)] || null
  }

  /** 换装：只加载选中那套的 24 张，其余不占内存。 */
  function avLoad (outfit) {
    const m = AV_MANIFEST && AV_MANIFEST.outfits &&
      AV_MANIFEST.outfits.find((o) => o.id === outfit)
    if (!m) { av.ready = false; return false }
    av.imgs = {}
    av.ready = false
    let left = Object.keys(m.frames).length
    const settle = () => { if (--left <= 0) { av.ready = true; avPlay(baseClip(), {}) } }
    Object.keys(m.frames).forEach((name) => {
      const img = new Image()
      img.onload = settle
      img.onerror = settle
      img.src = '../' + m.frames[name]
      av.imgs[name] = img
    })
    return true
  }

  function avSetPose (pose) {
    if (!pose || pose === av.pose) return
    av.prevPose = av.pose
    av.pose = pose
    av.poseT0 = avNow()
  }

  function avPlay (name, opts) {
    if (!av.on) return false
    const o = opts || {}
    if (!av.ready) return true
    const pose = AV_POSE[name] || 'base'
    avSetPose(pose)
    if (o.once) {
      clearTimeout(onceTimer)
      const done = () => {
        onceDeadline = 0
        onceDone = null
        if (destroyed) return
        avPlay(dragging ? 'drag' : baseClip(), {})
      }
      const wait = AV_ONCE[pose] || 1400
      onceDone = done
      onceDeadline = avNow() + wait
      onceTimer = setTimeout(done, wait)
    }
    avStart()
    return true
  }

  function avStart () {
    if (!av.on || destroyed) return
    if (av.timer) return
    const loop = () => {
      av.timer = 0
      if (destroyed || (!av.on && !v3.on && !v3.pending)) return
      avDraw(avNow())
      av.timer = setTimeout(loop, 33)
    }
    av.timer = setTimeout(loop, 0)
  }

  function avStop () {
    clearTimeout(av.timer)
    av.timer = 0
    av.imgs = null
    av.ready = false
  }

  /* ===================== Aster v3 三动作引擎 =====================
   * v3 素材 = 每套服装 3 段真动画（idle 45 帧 / talk 15 帧 / wave 15 帧，15fps）。
   * 清单优先取 window.ASTER_V3（生成时内联）或 assets/aster/v3/manifest.json；
   * file:// 下读不到清单就按官方规格表（420×465、15fps、45/15/15）按文件名约定加载。
   * 内存红线：只保留当前这一套的 75 张；换装先拍一帧快照当占位，再把旧图逐张释放。
   */
  const AV3_FPS = 15
  const AV3_SPEC = { idle: 45, talk: 15, wave: 15 }
  const AV3_KEYS = ['sailor', 'maid', 'casual', 'winter', 'princess', 'researcher', 'witch', 'pajamas']
  // 现有动作名 → v3 里播一段真实挥手；表里没有的做一小段位移，绝不静默卡住
  const AV3_WAVE = {
    wave: 1, tap: 1, tap_wave: 1, tap_joy: 1, tap_proud: 1, tap_shy: 1, tap_tickle: 1,
    cheer: 1, celebrate: 1, curtsy: 1, jump: 1, dance: 1,
  }
  const v3 = {
    on: false, key: '', pending: false, ready: false, failed: '',
    acts: { idle: [], talk: [], wave: [] }, action: '', t0: 0,
    speaking: false, quietAt: 0, waveUntil: 0, snap: null, lastFrame: '', boostT0: 0,
  }
  let av3Info = window.ASTER_V3 || null
  let av3Fetched = false

  function av3Names (n) {
    const a = []
    for (let i = 0; i < n; i++) a.push((i < 10 ? '0' : '') + i + '.webp')
    return a
  }

  /** 能 fetch 就补读真实清单（file:// 下通常失败，静默忽略，退回规格表）。 */
  function av3FetchManifest () {
    if (av3Fetched || av3Info) return
    av3Fetched = true
    if (typeof window.fetch !== 'function') return
    try {
      window.fetch('../aster/v3/manifest.json')
        .then((r) => (r && r.ok ? r.json() : null))
        .then((j) => { if (j && Array.isArray(j.outfits)) av3Info = j })
        .catch(() => {})
    } catch (e) {}
  }

  /** 这套服装的三动作帧名表；返回 null = 没有 v3 素材，交给老的单套 24 帧逻辑。 */
  function av3Spec (key) {
    if (!key) return null
    if (av3Info && Array.isArray(av3Info.outfits)) {
      const o = av3Info.outfits.find((x) => (x.key || x.id) === key)
      if (!o) return null
      const src = o.actions || o.frames || {}
      const acts = {}
      Object.keys(AV3_SPEC).forEach((name) => {
        acts[name] = Array.isArray(src[name]) ? src[name].slice() : av3Names(AV3_SPEC[name])
      })
      return acts
    }
    if (AV3_KEYS.indexOf(key) < 0) return null
    return { idle: av3Names(AV3_SPEC.idle), talk: av3Names(AV3_SPEC.talk), wave: av3Names(AV3_SPEC.wave) }
  }

  /** 释放当前这套的全部 Image 引用：断回调、清 src，再丢数组，光丢数组不解码内存。 */
  function av3Release () {
    Object.keys(v3.acts).forEach((a) => {
      v3.acts[a].forEach((it) => {
        if (!it || !it.img) return
        it.img.onload = null
        it.img.onerror = null
        try { it.img.src = '' } catch (e) {}
      })
      v3.acts[a] = []
    })
    v3.ready = false
    v3.action = ''
    v3.lastFrame = ''
  }

  /** 换装瞬间拍一张当前画面：新素材解码期间继续显示旧形象最后一帧，不白屏。 */
  function av3Snapshot () {
    try {
      if (!ctx || !canvas.width || !canvas.height) return null
      const c = document.createElement('canvas')
      c.width = CW
      c.height = CH
      const g = c.getContext('2d')
      g.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, CW, CH)
      return c
    } catch (e) { return null }
  }

  function av3Ready () {
    if (!v3.pending) return
    v3.pending = false
    v3.on = true
    v3.ready = true
    v3.action = ''
    v3.t0 = avNow()
    avStart()
  }

  /** 首帧都解码不出来 = 这套没有 v3 素材：退回老的单套立绘 / 视频。 */
  function av3Fail (key) {
    if (!v3.pending) return
    v3.pending = false
    v3.on = false
    v3.failed = key
    v3.snap = null
    console.warn('[pet] v3 三动作素材不可用，退回旧立绘：' + key)
    av3Release()
    av.on = true
    if (!avLoad(key)) {
      av.on = false
      av.outfit = ''
      play(baseClip(), { fade: 0 })
    }
  }

  /** 懒加载一套服装的 75 张：只加载这套，旧套在拍完快照后立即释放。 */
  function av3Load (key) {
    const spec = av3Spec(key)
    if (!spec) return false
    if ((v3.on || v3.pending) && v3.key === key) return true
    const snap = av3Snapshot() || v3.snap
    v3.on = false
    v3.pending = false
    av3Release()
    v3.key = key
    v3.snap = snap
    v3.pending = true
    Object.keys(AV3_SPEC).forEach((act) => {
      v3.acts[act] = spec[act].map((name) => {
        const img = new Image()
        const item = { name: name, img: img, ok: false }
        img.onload = () => {
          item.ok = true
          if (act === 'idle' && !v3.ready) av3Ready()
          avStart()
        }
        img.onerror = () => {
          item.ok = false
          // 连 idle 第一帧都没有 → 这套不是 v3 素材
          if (act === 'idle' && name === '00.webp') av3Fail(key)
        }
        img.src = '../aster/v3/' + key + '/' + act + '/' + name
        return item
      })
    })
    avStart()
    return true
  }

  /** 从 idx 往前找最近一张已解码的帧；缺帧时用 idle 顶上，不黑屏。 */
  function av3Frame (act, idx) {
    const list = v3.acts[act] || []
    if (!list.length) return null
    const n = list.length
    for (let i = Math.min(idx, n - 1); i >= 0; i--) if (list[i] && list[i].ok) return list[i]
    for (let i = 0; i < n; i++) if (list[i] && list[i].ok) return list[i]
    return null
  }

  function av3Draw (ts) {
    if (!ctx || !usingCanvas || !active || destroyed) return
    const k = Math.min(canvas.width / CW, canvas.height / CH)
    if (!(k > 0)) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(k, 0, 0, k, (canvas.width - CW * k) / 2, (canvas.height - CH * k) / 2)
    if (!v3.on) {
      // 加载中：旧形象最后一帧占位
      if (v3.snap) ctx.drawImage(v3.snap, 0, 0, CW, CH)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      return
    }
    const speaking = v3.speaking && ts < v3.quietAt
    let want = 'idle'
    if (speaking && v3.acts.talk.length) want = 'talk'
    else if (!speaking && ts < v3.waveUntil && v3.acts.wave.length) want = 'wave'
    if (want !== v3.action) { v3.action = want; v3.t0 = ts }
    const list = v3.acts[want] || v3.acts.idle
    let idx = Math.floor(((ts - v3.t0) / 1000) * AV3_FPS)
    if (!list.length) idx = 0
    else if (want === 'wave') {
      if (idx >= list.length) { v3.waveUntil = 0; v3.action = 'idle'; v3.t0 = ts; idx = 0 }
    } else idx = idx % list.length
    const frame = av3Frame(want, idx) || av3Frame('idle', idx)
    if (!frame) {
      if (v3.snap) ctx.drawImage(v3.snap, 0, 0, CW, CH)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      return
    }
    v3.lastFrame = frame.name
    v3.snap = null
    // 素材 45 帧里只有眨眼在动，其余完全一样：叠一层程序化呼吸/浮动/微摆补出连续变化。
    // 以脚底 (CW/2, CH) 为锚点，先缩放再按 bob 平移，脚下不漂。
    const breathe = 1 + 0.0083 * Math.sin((ts / 4600) * Math.PI * 2)
    const bob = 1.65 * Math.sin((ts / 3400) * Math.PI * 2)
    const sway = 0.88 * Math.sin((ts / 6100) * Math.PI * 2)
    // 没有对应素材的动作补一点弹跳；wave 不叠加 boost，避免两套位移打架
    const boost = v3.boostT0 ? Math.max(0, 1 - (ts - v3.boostT0) / 420) : 0
    ctx.save()
    ctx.translate(CW / 2 + sway, CH - 6 * boost)
    ctx.scale(breathe * (1 + 0.02 * boost), breathe * (1 + 0.02 * boost))
    ctx.translate(-CW / 2, -CH + bob)
    ctx.drawImage(frame.img, 0, 0, CW, CH)
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** v3 下的动作入口：有 waving 就播一次 wave（1s），其余做一小段位移顶上。 */
  function av3Play (name) {
    if (v3.on || v3.pending) {
      if (AV3_WAVE[name]) {
        v3.waveUntil = avNow() + 1000
        v3.action = 'wave'
        v3.t0 = avNow()
      } else {
        v3.boostT0 = avNow()
      }
      avStart()
      return true
    }
    return false
  }

  /** 每帧合成：呼吸起伏 + 说话点头 + 眨眼 + 姿势交叉淡化，全部按时间插值。 */
  function avDraw (ts) {
    av.tries = (av.tries || 0) + 1
    try { avDrawBody(ts) } catch (e) { av.err = String((e && e.message) || e) }
  }

  function avDrawBody (ts) {
    if (v3.on || v3.pending) { av3Draw(ts); return }
    if (!ctx || !usingCanvas || !av.on || !av.ready || !active || destroyed) {
      av.skip = !ctx ? 'ctx' : !usingCanvas ? 'canvas' : !av.on ? 'off' : !av.ready ? 'ready' : !active ? 'inactive' : 'destroyed'
      return
    }
    av.skip = ''
    if (ts - av.lastDraw < 12) return
    av.lastDraw = ts
    if (ts > av.nextBlink + 260 && av.nextBlink) {
      av.blinkUntil = ts + 110
      av.nextBlink = ts + 2600 + Math.random() * 3800
    } else if (!av.nextBlink) {
      av.nextBlink = ts + 2200 + Math.random() * 2500
    }
    const speaking = av.speaking && ts < av.quietAt
    const open = speaking && (ts % 190) < 118
    const blink = ts < av.blinkUntil
    const cur = avImg(av.pose, open, blink)
    if (!cur) return
    av.lastFrame = avImgName(av.pose, open, blink)
    av.lastOpen = !!open
    av.lastBlink = !!blink

    const k = Math.min(canvas.width / CW, canvas.height / CH)
    if (!(k > 0)) return
    // 待机幅度按「肉眼能看出来」调：呼吸 1.6%+0.6%、浮动 5px、左右微晃 ±0.6°、横向漂移 2px。
    const breathe = Math.sin(ts / 1450) * 0.016 + Math.sin(ts / 2450) * 0.006
    const bob = Math.sin(ts / 780) * (speaking ? 3.4 : 5.0)
    const nod = speaking ? Math.sin(ts / 150) * 0.009 : Math.sin(ts / 2600) * 0.004
    const tilt = av.pose === 'think' ? 0.012 : 0
    const sway = Math.sin(ts / 2300) * 0.010 + Math.sin(ts / 970) * 0.004
    const drift = Math.sin(ts / 1750) * 2.2

    // 每 4–8 秒自己换个姿势（挥手/开心/思考/害羞/惊讶/认可），待机也有戏，不是一张静图。
    if (!av.act) av.act = ts + 3500 + Math.random() * 2500
    if (!speaking && ts > av.act && av.pose === 'base' && !dragging) {
      av.act = ts + 4200 + Math.random() * 3600
      const pickPose = ['wave', 'happy', 'think', 'shy', 'surprise', 'approve'][Math.floor(Math.random() * 6)]
      avSetPose(pickPose)
      av.poseHold = ts + (AV_ONCE[pickPose] || 1400)
    }
    if (av.poseHold && ts > av.poseHold) { av.poseHold = 0; avSetPose('base') }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(k, 0, 0, k, (canvas.width - CW * k) / 2, (canvas.height - CH * k) / 2)
    const paint = (img, alpha) => {
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.translate(CW / 2 + drift, CH)   // 以脚底为锚点：呼吸/点头/晃动不让人物跳位
      ctx.rotate(nod + tilt + sway)
      ctx.translate(0, bob)
      ctx.scale(1 + breathe, 1 + breathe)
      ctx.drawImage(img, -CW / 2, -CH, CW, CH)
      ctx.restore()
    }
    if (av.prevPose && av.prevPose !== av.pose) {
      const t = Math.min(1, (ts - av.poseT0) / AV_FADE)
      const e = t * t * (3 - 2 * t)
      const prev = avImg(av.prevPose, false, false)
      if (prev && e < 1) paint(prev, 1 - e)
      paint(cur, e)
      if (t >= 1) av.prevPose = ''
    } else {
      av.prevPose = ''
      paint(cur, 1)
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** 画一层（按主体框归一化到统一高度/脚底基线/中心），alpha 用于动作间渐变。 */
  function drawLayer (v, clip, alpha) {
    if (!ctx || !v || alpha <= 0.002) return
    const n = NORM[clip] || [0, 0, CW, CH]
    const b = BODY[clip] || n
    const scale = Math.min(1.3, Math.max(0.85, TARGET_H / b[3]))
    // 缩放只看主体高度（细胳膊/尾巴/气泡不吃进高度），落点仍按整段素材的最底边贴地，
    // 这样待机就是原地不动（0.9.28 的位置一像素不差），换动作只换姿势不换大小。
    const bcx = b[0] + b[2] / 2
    const dw = n[2] * scale, dh = n[3] * scale
    let dx = TARGET_CX + (n[0] - bcx) * scale
    const dy = TARGET_BOTTOM - dh
    // 气泡这类特效会伸出画布左右：整体挪回画布内，宁可偏一两像素也不裁掉
    if (dx < 0) dx = 0
    else if (dx > CW - dw) dx = Math.max(0, CW - dw)
    ctx.globalAlpha = alpha
    try {
      ctx.drawImage(v, n[0], n[1], n[2], n[3], dx, dy, dw, dh)
    } catch (e) { /* 帧未就绪，下一帧再画 */ }
  }

  /**
   * 每帧重画画布：旧动作淡出、新动作淡入（一次性动作 200ms，回待机 260ms）。
   * 素材之间本来就有呼吸/重心差异，硬切会「啪」一下跳，渐变之后同一段素材内的动作变化是连续的。
   */
  function fadeTick () {
    fadeRaf = 0
    if (!fadePrev || destroyed || !usingCanvas) return
    draw(activeVid)
    if (fadePrev) fadeRaf = requestAnimationFrame(fadeTick)
  }

  function draw (v) {
    if (!ctx || !usingCanvas) return
    const k = Math.min(canvas.width / CW, canvas.height / CH)
    if (!(k > 0)) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(k, 0, 0, k, (canvas.width - CW * k) / 2, (canvas.height - CH * k) / 2)
    const f = fadePrev
    if (f) {
      const t = Math.min(1, (nowMs() - f.t0) / (f.dur || 150))
      // smoothstep：两端缓起缓落，动作交接不「跳闪」
      const e = t * t * (3 - 2 * t)
      drawLayer(f.vid, f.clip, 1 - e)
      drawLayer(v, curClip, e)
      if (fadeSamples.length < 40) fadeSamples.push([Math.round((nowMs() - f.t0)), +e.toFixed(3), +(1 - e).toFixed(3)])
      if (t >= 1) {
        try { f.vid.pause() } catch (e) {}
        const to = curClip; const from = f.clip; const dur = f.dur
        // 交接过程留最后一份采样，宿主轮询取走（排查「切换跳闪」）
        window.__petLastFade = { from, to, dur: dur || 200, n: fadeSamples.length, samples: fadeSamples }
        fadeSamples = []
        fadePrev = null
      }
    } else {
      drawLayer(v, curClip, 1)
    }
    ctx.globalAlpha = 1
  }

  /** canvas 拿不到 alpha 时（个别机型硬解丢通道）降级回直接显示 video，别让角色变黑框。 */
  function checkAlpha () {
    if (alphaChecked || !ctx || destroyed) return
    alphaChecked = true
    try {
      const d = ctx.getImageData(0, 0, 4, 4).data
      let opaque = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] > 250) opaque++
      if (opaque >= d.length / 4) {
        usingCanvas = false
        canvas.style.display = 'none'
        legacy.forEach((v, i) => { v.style.display = i === 0 ? '' : 'none' })
        console.warn('[pet] canvas 帧没有 alpha，降级为 video 图层')
        if (legacy[0]) { legacy[0].src = src(curClip); legacy[0].classList.add('front'); legacy[0].play().catch(() => {}) }
      }
    } catch (e) { /* 读像素被拦就当正常 */ }
  }

  function pump (v) {
    if (destroyed || !active) { pumping = false; return }
    if (v !== activeVid) { pumping = false; startPump(); return }
    draw(v)
    checkAlpha()
    startPump()
  }
  function startPump () {
    if (av.on) { avStart(); pumping = false; return }
    const v = activeVid
    if (!v || destroyed || !active) { pumping = false; return }
    pumping = true
    if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(() => pump(v))
    else setTimeout(() => pump(v), 66)
  }

  function baseClip () { return CLIPS[baseMode] || 'idle' }

  function play (name, opts) {
    const o = opts || {}
    if (destroyed) return
    if (av.on) { avPlay(name, o); curClip = name; return }
    if (!o.once && name === curClip && activeVid && !activeVid.paused) return
    const id = ++seq
    const prev = activeVid
    const next = vids.find((x) => x !== activeVid) || vids[0]
    curClip = name
    try { next.pause() } catch (e) {}
    next.loop = !o.once
    next.playbackRate = 1
    next.src = src(name)
    let fired = false
    const go = () => {
      if (fired || destroyed || id !== seq) return
      fired = true
      next.removeEventListener('playing', go)
      next.removeEventListener('loadeddata', go)
      if (!usingCanvas) {
        const l = legacy[0]
        if (l) {
          l.loop = !o.once
          if (l.getAttribute('src') !== src(name)) l.src = src(name)
          l.classList.add('front')
          l.play().catch(() => {})
        }
        return
      }
      next.play().catch(() => {})
      activeVid = next
      vidClip.set(next, name)
      // 进动作略快（200ms）让反馈跟手，回待机更慢（260ms）显得稳
      const dur = o.fade === undefined ? (o.once ? 200 : 260) : o.fade
      if (prev && prev !== next && prev.readyState >= 2 && dur > 0) {
        // 旧层继续播完这段渐变（画面在动，不是定格），渐变结束由 draw() 停掉它
        fadePrev = { vid: prev, clip: vidClip.get(prev) || name, t0: nowMs(), dur }
        if (!fadeRaf) fadeRaf = requestAnimationFrame(fadeTick)
        setTimeout(() => { if (fadePrev && fadePrev.vid === prev) return; try { prev.pause() } catch (e) {} }, dur + 260)
      } else {
        fadePrev = null
        if (prev && prev !== next) setTimeout(() => { try { prev.pause() } catch (e) {} }, 60)
      }
      if (!pumping) startPump()
    }
    next.addEventListener('playing', go)
    next.addEventListener('loadeddata', go)
    next.play().catch(() => {})
    if (next.readyState >= 2) go()
    setTimeout(go, 700)
    if (o.once && !o.chain) {
      clearTimeout(onceTimer)
      const done = () => {
        next.removeEventListener('ended', done)
        clearTimeout(onceTimer)
        onceDeadline = 0
        onceDone = null
        if (destroyed || id !== seq) return
        if (dragging) play(pick(ONCE.drag), {})
        else play(baseClip(), {})
      }
      next.addEventListener('ended', done)
      // 按这段素材自己的长度兜底：短动作播完就走，绝不停在尾帧等一个固定值
      const wait = Math.max(120, clipDurMs(name, next) * 0.85)
      onceDeadline = nowMs() + wait
      onceDone = done
      onceTimer = setTimeout(done, wait)
    }
  }

  /**
   * 串起来播：下一段在当前段结束前 overlapMs 起播，中间不留空档。
   * 待机链（idle → 微动作 → idle）和连续小动作都走它。
   */
  function playChain (list, overlapMs) {
    if (destroyed || !list || !list.length) return
    clearTimeout(chainTimer)
    const gap = overlapMs === undefined ? 120 : overlapMs
    const step = (i) => {
      if (destroyed) return
      if (i >= list.length) return
      const name = list[i]
      const last = i === list.length - 1
      if (last) {
        chainDeadline = 0
        chainNext = null
        play(name, {})
        return
      }
      play(name, { once: true, chain: true })
      const wait = Math.max(60, clipDurMs(name, activeVid) - gap)
      chainDeadline = nowMs() + wait
      chainNext = () => step(i + 1)
      chainTimer = setTimeout(chainNext, wait)
    }
    step(0)
  }

  /**
   * 原生每帧调一次。只做一件事：当前段超时了就推进。
   * 透明悬浮窗里的 setTimeout 会被 Chromium 降频到 1s 一跳，原生时钟不受影响。
   */
  window.__petTick = function () {
    if (destroyed) return
    if (onceDeadline && nowMs() >= onceDeadline) {
      const fn = onceDone
      onceDeadline = 0
      onceDone = null
      if (fn) { try { fn() } catch (e) {} }
    }
    if (chainDeadline && nowMs() >= chainDeadline) {
      const fn = chainNext
      chainDeadline = 0
      chainNext = null
      if (fn) { try { fn() } catch (e) {} }
    }
    if (av.on || v3.on || v3.pending) avDraw(avNow())
    // 解码被节流时把当前段拉回播放态，画面继续走
    if (active && activeVid && activeVid.paused && document.visibilityState !== 'hidden') {
      try { activeVid.play() } catch (e) {}
    }
  }

  const onVis = () => {
    if (document.visibilityState === 'hidden') { vids.forEach((v) => { try { v.pause() } catch (e) {} }); pumping = false }
    else if (active) { if (activeVid) activeVid.play().catch(() => {}); startPump() }
  }
  document.addEventListener('visibilitychange', onVis)

  play('idle', {})

  // 待机小动作：白天爱动、晚上犯困，隔十几秒自己来一段，别一直重复同一口气。
  let idleTimer = 0
  const scheduleIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (destroyed) return
      if (baseMode === 'idle' && !dragging && active && document.visibilityState !== 'hidden') {
        // idle → 随机微动作 → idle，用链播保证动作之间不留空
        playChain(['idle', pick(idlePool(new Date().getHours())), 'idle'], 120)
      }
      scheduleIdle()
    }, nextIdleDelay(Math.random()))
  }
  scheduleIdle()

  // 宿主探针读取的现场：走 canvas 还是降级 video、当前是哪段、上次交接采了几帧
  window.__petDebug = () => ({
    canvas: !!usingCanvas,
    outfit: v3.on ? (v3.key || '') : (av.outfit || 'jelly'),
    avatarReady: av.ready || v3.ready,
    v3: {
      on: v3.on,
      key: v3.key,
      action: v3.action,
      frame: v3.lastFrame,
      failed: v3.failed,
    },
    pose: av.pose,
    speaking: av.speaking,
    clip: curClip,
    fade: window.__petLastFade ? window.__petLastFade.n : 0,
    fadeDur: window.__petLastFade ? window.__petLastFade.dur : 0,
    draws: av.tries || 0,
    skip: av.skip || '',
    err: av.err || '',
    frame: av.lastFrame || '',
    open: !!av.lastOpen,
    blink: !!av.lastBlink
  })

  return {
    /** 换形象：'' 或 'jelly' = 原来的鲸鱼娘视频素材；sailor/maid/casual/winter/princess = Aster 立绘。 */
    setOutfit (id) {
      const next = !id || id === 'jelly' ? '' : String(id)
      if (next === av.outfit) return
      av.outfit = next
      // v3 优先：这套有三动作素材就懒加载，期间显示旧形象最后一帧
      if (next && av3Load(next)) {
        av.on = false
        return
      }
      if (v3.on || v3.pending) {
        v3.on = false
        v3.pending = false
        v3.snap = null
        av3Release()
      }
      if (!next) {
        av.on = false
        avStop()
        fadePrev = null
        play(baseClip(), { fade: 0 })
        return
      }
      av.on = true
      av.prevPose = ''
      av.pose = AV_POSE[baseClip()] || 'base'
      if (!avLoad(next)) { av.on = false; av.outfit = ''; play(baseClip(), { fade: 0 }) }
    },
    outfit () { return av.outfit || 'jelly' },
    setMode (mode) {
      const next = CLIPS[mode] ? mode : 'idle'
      baseMode = next
      if (v3.on || v3.pending) {
        // v3：talking 期间循环 talk，退出就回 idle；不碰老视频层
        v3.speaking = next === 'talking'
        v3.quietAt = next === 'talking' ? Infinity : 0
        avStart()
        return
      }
      if (av.on) { av.speaking = next === 'talking'; av.quietAt = next === 'talking' ? Infinity : 0 }
      play(baseClip(), { fade: 200 })
      if (next === 'talking' && activeVid) activeVid.playbackRate = 1.05
    },
    setMouth (value) {
      const v = Math.max(0, Math.min(1, Number(value) || 0))
      if (v3.on || v3.pending) {
        // 说话切 talk 循环；没了（0/false）立刻回 idle；420ms 没新值也算说完
        v3.speaking = v > 0.01
        v3.quietAt = v3.speaking ? avNow() + 420 : 0
        avStart()
        return
      }
      if (av.on) { av.speaking = v > 0.01; if (av.speaking) av.quietAt = avNow() + 420; return }
      if (baseMode !== 'talking' || !activeVid) return
      activeVid.playbackRate = 0.92 + v * 0.26
    },
    tap () {
      if (av3Play('tap')) return
      play(pick(ONCE.tap), { once: true, fade: 90 })
    },
    tapKind (kind) {
      if (av3Play(kind)) return
      const list = ONCE[kind]
      if (!list) return this.tap()
      play(pick(list), { once: true, fade: 90 })
    },
    playOnce (key) {
      if (av3Play(key)) return true
      const list = ONCE[key]
      if (!list) return false
      play(pick(list), { once: true })
      return true
    },
    celebrate () {
      if (av3Play('celebrate')) return
      play(pick(ONCE.cheer), { once: true })
    },
    setDragging (on) {
      const next = !!on
      if (next === dragging) return
      dragging = next
      if (av3Play(next ? 'drag' : 'idle')) return
      if (next) play(pick(ONCE.drag), {})
      else play(baseClip(), {})
    },
    setActive (on) {
      active = !!on
      if (!active) {
        vids.forEach((v) => { try { v.pause() } catch (e) {} }); pumping = false
        clearTimeout(av.timer); av.timer = 0
      } else {
        if (activeVid) activeVid.play().catch(() => {})
        startPump()
        if (v3.on || v3.pending) avStart()
      }
    },
    destroy () {
      destroyed = true
      clearTimeout(onceTimer)
      av3Release()
      v3.on = false
      v3.pending = false
      v3.snap = null
      avStop()
      av.on = false
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('resize', fit)
      vids.forEach((v) => { try { v.pause() } catch (e) {}; v.removeAttribute('src'); v.load() })
      canvas.remove()
    },
  }
}
