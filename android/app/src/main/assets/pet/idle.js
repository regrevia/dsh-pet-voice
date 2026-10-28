// 待机小动作的纯逻辑：什么时候来一段、来哪一段。抽出来是为了能在 Node 里单测。
// 每档都给足够多的花样：待机一直重复同一两段最容易看出「动作衔接不顺」。
export function idlePool (hour) {
  // 名字必须是 anim/ 下真有的片段（'look' / 'whale' / 'tail' 这种短名没有对应文件，
  // 以前池子里混着它们，播到就是一次 404 + 空白）。
  if (hour >= 23 || hour < 6) return ['sleep', 'yawn', 'stretch', 'look_around', 'whale_bubble']
  if (hour >= 19) return ['look_around', 'yawn', 'stretch', 'tail_slap', 'curtsy', 'tap_joy']
  return ['look_around', 'dance', 'curtsy', 'whale_bubble', 'tail_slap', 'stretch', 'tap_wave', 'tap_joy', 'tap_shy', 'jump']
}

/** 1.5–3 s 来一次，rand 传 Math.random() 便于测。动作不停顿靠这个密度撑着。 */
export function nextIdleDelay (rand) {
  return 1500 + Math.max(0, Math.min(1, rand)) * 1500
}

/** 从池子里挑一段，尽量和上一段不一样（避免连着播同一个动作）。 */
export function pickIdle (pool, last, rand) {
  if (!pool || !pool.length) return ''
  const rest = pool.filter((x) => x !== last)
  const src = rest.length ? rest : pool
  return src[Math.floor(Math.max(0, Math.min(0.999999, rand)) * src.length)]
}
