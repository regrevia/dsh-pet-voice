#!/usr/bin/env python3
"""把 Aster 立绘引擎补进 anim-pet.js（幂等：已打过补丁就跳过）。"""
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = os.path.join(ROOT, "android/app/src/main/assets/pet/anim-pet.js")
s = open(P).read()
if "AV_POSE" in s:
    print("已经是打过补丁的版本"); sys.exit(0)

ANCHOR = "  const clipDurMs = (name, v) => {"
assert s.count(ANCHOR) == 1

ENGINE = r"""    return CLIP_DUR[name] || 3000
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
      if (destroyed || !av.on) return
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

  /** 每帧合成：呼吸起伏 + 说话点头 + 眨眼 + 姿势交叉淡化，全部按时间插值。 */
  function avDraw (ts) {
    if (!ctx || !usingCanvas || !av.on || !av.ready || !active || destroyed) return
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

    const k = Math.min(canvas.width / CW, canvas.height / CH)
    if (!(k > 0)) return
    const breathe = Math.sin(ts / 1450) * 0.006
    const bob = Math.sin(ts / 780) * (speaking ? 2.6 : 1.8)
    const nod = speaking ? Math.sin(ts / 150) * 0.006 : 0
    const tilt = av.pose === 'think' ? 0.012 : 0

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(k, 0, 0, k, (canvas.width - CW * k) / 2, (canvas.height - CH * k) / 2)
    const paint = (img, alpha) => {
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.translate(CW / 2, CH)          // 以脚底为锚点：呼吸/点头不让人物跳位
      ctx.rotate(nod + tilt)
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
"""

TAIL = '    return CLIP_DUR[name] || 3000\n  }\n'
assert ENGINE.startswith(TAIL), 'ENGINE 头部对不上'
assert s.count(TAIL) == 1, '锚点在源文件里不唯一'
s = s.replace(TAIL, TAIL + ENGINE[len(TAIL):], 1)

# 1) play() 里让路给立绘引擎
old = """  function play (name, opts) {
    const o = opts || {}
    if (destroyed) return"""
new = """  function play (name, opts) {
    const o = opts || {}
    if (destroyed) return
    if (av.on) { avPlay(name, o); curClip = name; return }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) startPump 在立绘模式下不再碰 video
old = """  function startPump () {
    const v = activeVid"""
new = """  function startPump () {
    if (av.on) { avStart(); pumping = false; return }
    const v = activeVid"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 原生时钟也推立绘
old = """    // 解码被节流时把当前段拉回播放态，画面继续走
    if (active && activeVid && activeVid.paused && document.visibilityState !== 'hidden') {"""
new = """    if (av.on) avDraw(avNow())
    // 解码被节流时把当前段拉回播放态，画面继续走
    if (active && activeVid && activeVid.paused && document.visibilityState !== 'hidden') {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 4) 对外 API：setOutfit / setMouth 说话口型 / destroy 清理
old = """  return {
    setMode (mode) {"""
new = """  return {
    /** 换形象：'' 或 'jelly' = 原来的鲸鱼娘视频素材；sailor/maid/casual/winter/princess = Aster 立绘。 */
    setOutfit (id) {
      const next = !id || id === 'jelly' ? '' : String(id)
      if (next === av.outfit) return
      av.outfit = next
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
    setMode (mode) {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    setMouth (value) {
      const v = Math.max(0, Math.min(1, Number(value) || 0))
      if (baseMode !== 'talking' || !activeVid) return"""
new = """    setMouth (value) {
      const v = Math.max(0, Math.min(1, Number(value) || 0))
      if (av.on) { av.speaking = v > 0.01; if (av.speaking) av.quietAt = avNow() + 420; return }
      if (baseMode !== 'talking' || !activeVid) return"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    setActive (on) {
      active = !!on
      if (!active) { vids.forEach((v) => { try { v.pause() } catch (e) {} }); pumping = false }
      else { if (activeVid) activeVid.play().catch(() => {}); startPump() }
    },"""
new = """    setActive (on) {
      active = !!on
      if (!active) {
        vids.forEach((v) => { try { v.pause() } catch (e) {} }); pumping = false
        clearTimeout(av.timer); av.timer = 0
      } else { if (activeVid) activeVid.play().catch(() => {}); startPump() }
    },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    destroy () {
      destroyed = true
      clearTimeout(onceTimer)"""
new = """    destroy () {
      destroyed = true
      clearTimeout(onceTimer)
      avStop()
      av.on = false"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 5) 探针带上形象状态
old = """  window.__petDebug = () => ({
    canvas: !!usingCanvas,
    clip: curClip,"""
new = """  window.__petDebug = () => ({
    canvas: !!usingCanvas,
    outfit: av.outfit || 'jelly',
    avatarReady: av.ready,
    pose: av.pose,
    speaking: av.speaking,
    clip: curClip,"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

open(P, "w").write(s)
print("anim-pet.js 已打补丁：%d 字节" % len(s))
