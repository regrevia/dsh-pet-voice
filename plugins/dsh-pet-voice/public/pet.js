/**
 * 像素鲸鱼娘渲染器
 * 逻辑分辨率 112×112，CSS 放大 + image-rendering: pixelated。
 * 全部用整数像素绘制，保证放大后依然是"真像素"。
 */

const W = 112
const H = 112

const C = {
  ink: '#08243a',
  hair: '#7adaff',
  hairMid: '#45b6e8',
  hairDark: '#2b86bd',
  hairLight: '#cdf6ff',
  skin: '#ffe4d2',
  skinMid: '#f8c3ac',
  skinLine: '#cf9078',
  hood: '#f2fbff',
  hoodMid: '#c9e9f9',
  hoodDark: '#8cc6e6',
  eye: '#12364f',
  eyeLow: '#3d8fb8',
  white: '#ffffff',
  blush: '#ff9db1',
  mouth: '#7d2839',
  tongue: '#ff92aa',
  spout: '#b6f2ff',
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, k) => a + (b - a) * k

export function createPet (canvas) {
  const ctx = canvas.getContext('2d', { alpha: true })
  ctx.imageSmoothingEnabled = false
  canvas.width = W
  canvas.height = H

  const state = {
    mode: 'idle', // idle | listening | thinking | talking | happy
    mouth: 0,
    mouthTarget: 0,
    blink: 0,
    nextBlink: performance.now() + 2200,
    lookX: 0,
    lookY: 0,
    bob: 0,
    squash: 0,
    t: 0,
    particles: [],
    spoutPhase: -1,
    nextPuff: performance.now() + 3000,
  }

  /* ---------------- 像素画笔 ---------------- */
  const px = (x, y, w, h, color) => {
    ctx.fillStyle = color
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
  }

  const ell = (cx, cy, rx, ry, color) => {
    ctx.fillStyle = color
    rx = Math.max(0.5, rx); ry = Math.max(0.5, ry)
    const y0 = Math.round(cy - ry); const y1 = Math.round(cy + ry)
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / ry
      if (Math.abs(dy) > 1) continue
      const half = rx * Math.sqrt(1 - dy * dy)
      const x0 = Math.round(cx - half); const x1 = Math.round(cx + half)
      if (x1 > x0) ctx.fillRect(x0, y, x1 - x0, 1)
    }
  }

  const poly = (pts, color) => {
    ctx.fillStyle = color
    const ys = pts.map((p) => p[1])
    const y0 = Math.floor(Math.min(...ys)); const y1 = Math.ceil(Math.max(...ys))
    for (let y = y0; y <= y1; y++) {
      const xs = []
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]; const b = pts[(i + 1) % pts.length]
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
        }
      }
      xs.sort((p, q) => p - q)
      for (let i = 0; i < xs.length; i += 2) {
        const x0 = Math.round(xs[i]); const x1 = Math.round(xs[i + 1])
        if (x1 > x0) ctx.fillRect(x0, y, x1 - x0, 1)
      }
    }
  }

  /* ---------------- 尾巴 ---------------- */
  function drawTail (t, amp) {
    const sway = Math.sin(t * 1.35) * 2.2
    const sway2 = Math.sin(t * 1.35 + 0.6) * 2.8

    // 尾鳍：上下两片
    const fx = 15
    const fy = 89
    poly([[fx + 2, fy - 2], [fx - 14, fy - 15 + sway2], [fx - 6, fy - 2], [fx + 1, fy + 2]], C.ink)
    poly([[fx + 1, fy + 2], [fx - 12, fy + 14 - sway2], [fx + 2, fy + 8], [fx + 6, fy + 2]], C.ink)
    poly([[fx + 1, fy - 2], [fx - 12, fy - 12 + sway2], [fx - 5, fy - 2], [fx, fy + 1]], C.hairMid)
    poly([[fx, fy + 2], [fx - 10, fy + 11 - sway2], [fx + 1, fy + 7], [fx + 4, fy + 2]], C.hairMid)
    poly([[fx - 1, fy - 2], [fx - 9, fy - 8 + sway2], [fx - 4, fy - 2]], C.hair)
    px(fx - 8, fy - 7 + sway2, 3, 2, C.hairLight)

    // 尾柄：从身体下缘连出来
    const chain = [
      [44, 99 + sway * 0.15, 9, 6],
      [36, 98 + sway * 0.3, 8.5, 6],
      [28, 95 + sway * 0.5, 8, 6],
      [21, 92 + sway * 0.8, 7, 5.5],
    ]
    for (const [x, y, rx, ry] of chain) ell(x, y, rx + 1, ry + 1, C.ink)
    for (const [x, y, rx, ry] of chain) ell(x, y, rx, ry, C.hairMid)
    ell(44, 98, 8, 4.5, C.hair)
    ell(36, 97, 7, 4, C.hair)
    // 尾纹
    px(30, 92, 5, 1, C.hairDark)
    px(25, 90, 4, 1, C.hairDark)
  }

  /* ---------------- 身体 ---------------- */
  function drawBody (amp, mode) {
    // 兜帽帽檐（只在躯干上缘露出一圈，不用深色描边，避免下巴两侧发黑）
    ell(56, 80, 16, 5.5, C.hoodMid)

    // 躯干
    ell(56, 88, 20, 13.5, C.ink)
    ell(56, 88, 19, 12.5, C.hood)
    ell(56, 93, 14, 8, C.hoodMid)
    ell(56, 95, 11, 5.5, C.white)

    // 袖子（左）
    poly([[35, 80], [45, 82], [43, 96], [34, 94]], C.ink)
    poly([[36, 81], [44, 83], [42, 95], [35, 93]], C.hood)
    ell(38, 96, 3.4, 3.2, C.ink)
    ell(38, 96, 2.5, 2.3, C.skin)

    // 袖子（右）
    poly([[77, 80], [67, 82], [69, 96], [78, 94]], C.ink)
    poly([[76, 81], [68, 83], [70, 95], [77, 93]], C.hood)
    ell(74, 96, 3.4, 3.2, C.ink)
    ell(74, 96, 2.5, 2.3, C.skin)

    // 胸前小鲸鱼（尾鳍徽章）
    const lift = Math.round(amp * 1.2)
    const y0 = 84 - lift
    px(50, y0, 4, 1, C.hairDark)
    px(58, y0, 4, 1, C.hairDark)
    px(52, y0 + 1, 2, 1, C.hairDark)
    px(58, y0 + 1, 2, 1, C.hairDark)
    px(55, y0 + 1, 2, 2, C.hairDark)
    px(54, y0 + 3, 4, 1, C.hoodDark)
    // 口袋线
    px(47, y0 + 8, 18, 1, C.hoodMid)

    // 兜帽小鳍（肩两侧，鲸鱼鳍）
    if (mode !== 'thinking') {
      poly([[39, 77], [32, 73], [34, 80], [39, 81]], C.hoodDark)
      poly([[73, 77], [80, 73], [78, 80], [73, 81]], C.hoodDark)
    }
  }

  /* ---------------- 头 ---------------- */
  function drawHead (t, blink, lookX, lookY, amp, mode) {
    // 后发（外缘用深蓝而不是纯黑，避免下巴两侧出现黑洞）
    ell(56, 49, 29, 26, C.hairDark)
    ell(56, 48, 28, 25, C.hairMid)
    ell(56, 47, 27, 23.5, C.hair)

    // 脸
    ell(56, 58, 22, 19, C.skinLine)
    ell(56, 58, 21, 18, C.skin)

    // 侧发（在脸两侧压住轮廓）
    poly([[26, 41], [38, 46], [37, 66], [31, 77], [25, 70], [23, 46]], C.hairDark)
    poly([[27, 43], [36, 48], [35, 65], [31, 74], [26, 69], [24, 48]], C.hair)
    poly([[86, 41], [74, 46], [75, 66], [81, 77], [87, 70], [89, 46]], C.hairDark)
    poly([[85, 43], [76, 48], [77, 65], [81, 74], [86, 69], [88, 48]], C.hair)

    // 刘海
    ell(41, 37, 11, 10, C.hair)
    ell(56, 34, 13, 11, C.hair)
    ell(71, 37, 11, 10, C.hair)
    poly([[33, 43], [42, 53], [47, 44]], C.hair)
    poly([[48, 42], [56, 57], [64, 42]], C.hair)
    poly([[65, 44], [72, 52], [78, 44]], C.hair)

    // 发缝与发丝
    px(55, 25, 1, 7, C.hairMid)
    px(44, 44, 1, 6, C.hairMid)
    px(67, 44, 1, 6, C.hairMid)

    // 高光
    px(38, 30, 4, 2, C.hairLight)
    px(33, 36, 2, 3, C.hairLight)
    px(70, 28, 2, 1, C.hairLight)

    // 眼睛
    const baseRy = mode === 'listening' ? 6.6 : 6.1
    const eyeRy = baseRy * (1 - blink * 0.9)
    for (const cx of [45, 67]) {
      if (mode === 'happy') {
        px(cx - 3, 58, 7, 1, C.ink)
        px(cx - 4, 59, 2, 1, C.ink)
        px(cx + 3, 59, 2, 1, C.ink)
        continue
      }
      ell(cx, 58, 5.6, eyeRy + 0.8, C.ink)
      ell(cx, 58, 4.7, eyeRy, C.eye)
      ell(cx, 59.6, 3.8, eyeRy * 0.5, C.eyeLow)
      if (blink < 0.45) {
        px(cx - 2.5 + lookX, 55 + lookY, 2.5, 2.5, C.white)
        px(cx + 1 + lookX, 60.5 + lookY, 1.5, 1.5, C.hairLight)
      }
      // 上眼睑
      px(cx - 5, 52.5, 10, 1, C.ink)
    }

    // 腮红
    ctx.globalAlpha = 0.34
    ell(34, 66, 4.6, 2.6, C.blush)
    ell(78, 66, 4.6, 2.6, C.blush)
    ctx.globalAlpha = 1

    // 嘴
    if (mode === 'listening') {
      ell(56, 70, 2.2, 2.8, C.mouth)
    } else if (amp > 0.08 || mode === 'talking') {
      const open = 1.2 + amp * 5
      ell(56, 69, 3.6, open, C.mouth)
      if (open > 3) ell(56, 69 + open * 0.5, 2.4, open * 0.35, C.tongue)
    } else if (mode === 'thinking') {
      px(53, 69, 6, 1, C.mouth)
    } else {
      px(51, 67, 2, 1, C.mouth)
      px(59, 67, 2, 1, C.mouth)
      px(53, 68, 6, 1, C.mouth)
      px(54, 69, 4, 1, C.mouth)
      px(55, 69, 2, 1, C.tongue)
    }

    // 头顶水花
    if (state.spoutPhase >= 0) {
      const phase = state.spoutPhase
      const h = 3 + Math.sin(Math.min(1, phase) * Math.PI) * 7
      px(55, 21 - h, 2, h, C.spout)
      px(52, 21 - h * 0.72, 2, h * 0.72, C.spout)
      px(58, 21 - h * 0.72, 2, h * 0.72, C.spout)
      if (phase > 0.25) {
        const d = Math.round(phase * 3)
        px(48 + d, 19 - h * 0.9, 2, 2, C.spout)
        px(62 - d, 18 - h * 0.9, 2, 2, C.spout)
      }
      if (phase > 0.55) {
        px(45, 23 - h * 0.45, 1, 1, C.spout)
        px(66, 22 - h * 0.45, 1, 1, C.spout)
      }
    }
  }

  function drawParticles () {
    for (const p of state.particles) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1)
      if (p.type === 'heart') {
        const x = Math.round(p.x); const y = Math.round(p.y)
        px(x - 1, y, 1, 1, C.blush); px(x + 1, y, 1, 1, C.blush)
        px(x - 2, y + 1, 5, 1, C.blush)
        px(x - 1, y + 2, 3, 1, C.blush)
        px(x, y + 3, 1, 1, C.blush)
      } else {
        ctx.fillStyle = 'rgba(180,240,255,0.75)'
        ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1)
      }
    }
    ctx.globalAlpha = 1
  }

  /* ---------------- 主循环 ---------------- */
  let raf = 0
  let last = performance.now()

  function frame (now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const t = now / 1000
    state.t = t

    // 眨眼
    if (now > state.nextBlink) {
      state.blink = Math.min(1, state.blink + dt * 9)
      if (state.blink >= 1) state.nextBlink = now + 2200 + Math.random() * 2600
    } else {
      state.blink = Math.max(0, state.blink - dt * 9)
    }

    // 嘴型平滑
    state.mouth = lerp(state.mouth, state.mouthTarget, 0.35)
    if (state.mouth < 0.02) state.mouth = 0

    // 呼吸起伏
    const breathe = Math.sin(t * 1.9) * 1.2
    const bounce = state.mode === 'talking' ? Math.sin(t * 9) * state.mouth * 1.2 : 0
    state.bob = breathe + bounce

    // 水花：随机小喷 + 说话时持续
    if (state.spoutPhase >= 0) {
      state.spoutPhase += dt * 1.7
      if (state.spoutPhase > 1) state.spoutPhase = -1
    } else if (now > state.nextPuff) {
      state.spoutPhase = 0
      state.nextPuff = now + 3600 + Math.random() * 3600
    }
    if (state.mode === 'talking' && state.spoutPhase < 0 && Math.random() < 0.02) state.spoutPhase = 0

    ctx.clearRect(0, 0, W, H)
    ctx.save()
    const s = 1 + state.squash * 0.04
    ctx.translate(56, 100)
    ctx.scale(s, 2 - s)
    ctx.translate(-56, -100)
    ctx.translate(0, state.bob)

    drawTail(t, state.mouth)
    drawBody(state.mouth, state.mode)
    drawHead(t, state.blink, state.lookX, state.lookY, state.mouth, state.mode)
    drawParticles()

    ctx.restore()

    for (const p of state.particles) {
      p.y -= p.vy * dt
      p.x += Math.sin(t * 2 + p.seed) * 0.15
      p.life -= dt
    }
    state.particles = state.particles.filter((p) => p.life > 0).slice(-18)

    state.squash = Math.max(0, state.squash - dt * 4)
    raf = requestAnimationFrame(frame)
  }

  raf = requestAnimationFrame(frame)

  /* ---------------- 外部接口 ---------------- */
  const onPointer = (event) => {
    const rect = canvas.getBoundingClientRect()
    const nx = (event.clientX - rect.left) / rect.width - 0.5
    const ny = (event.clientY - rect.top) / rect.height - 0.5
    state.lookX = clamp(nx * 4, -2, 2)
    state.lookY = clamp(ny * 3, -1.5, 1.5)
  }
  window.addEventListener('pointermove', onPointer, { passive: true })

  return {
    setMode (mode) {
      if (state.mode === mode) return
      state.mode = mode
      if (mode === 'talking' || mode === 'happy') {
        if (state.spoutPhase < 0) state.spoutPhase = 0
      }
      if (mode !== 'listening') { state.lookX = 0; state.lookY = 0 }
    },
    setMouth (value) {
      state.mouthTarget = clamp(value, 0, 1)
    },
    tap () {
      state.squash = 1
      if (state.spoutPhase < 0) state.spoutPhase = 0
      for (let i = 0; i < 4; i++) {
        state.particles.push({
          x: 40 + Math.random() * 32,
          y: 40 + Math.random() * 10,
          vy: 14 + Math.random() * 10,
          life: 1.1,
          max: 1.1,
          seed: Math.random() * 6,
          type: 'heart',
        })
      }
    },
    celebrate () {
      this.setMode('happy')
      setTimeout(() => this.setMode('idle'), 900)
      for (let i = 0; i < 8; i++) {
        state.particles.push({
          x: 30 + Math.random() * 52,
          y: 30 + Math.random() * 30,
          vy: 18 + Math.random() * 16,
          life: 1.4,
          max: 1.4,
          seed: Math.random() * 6,
          type: i % 2 ? 'heart' : 'bubble',
        })
      }
    },
    destroy () {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onPointer)
    },
  }
}
