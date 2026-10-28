// 待机小动作的纯逻辑：什么时候来一段、来哪一段。抽出来是为了能在 Node 里单测。
// 每档都给足够多的花样：待机一直重复同一两段最容易看出「动作衔接不顺」。
export function idlePool (hour) {
  // 名字必须是 anim/ 下真有的片段（'look' / 'whale' / 'tail' 这种短名没有对应文件，
  // 以前池子里混着它们，播到就是一次 404 + 空白）。
  // 三段素材一共 23 个片段，能当生活化小动作的有 13 个：白天全都排上，
  // 一轮两个动作的话单轮 ≈ 20 s 就走完一遍，不容易看出「老是那几个」。
  if (hour >= 23 || hour < 6) return ['sleep', 'yawn', 'stretch', 'look_around', 'whale_bubble', 'tap_shy']
  if (hour >= 19) return ['look_around', 'yawn', 'stretch', 'tail_slap', 'curtsy', 'tap_joy', 'whale_bubble', 'dance', 'tap_shy']
  return ['look_around', 'dance', 'curtsy', 'whale_bubble', 'tail_slap', 'stretch',
    'tap_wave', 'tap_joy', 'tap_shy', 'jump', 'yawn', 'thinking', 'tap_tickle']
}

/**
 * 有剧情的两连动作：不是随机拼两个，而是「先哈欠再伸懒腰」「跳一下再转个圈」这种
 * 本来就该接在一起的组合。播成一串而不是两段独立小动作，衔接才不像两个片段硬贴。
 */
export function idleCombos (hour) {
  if (hour >= 23 || hour < 6) return [['yawn', 'stretch'], ['stretch', 'yawn'], ['look_around', 'sleep']]
  if (hour >= 19) return [['tail_slap', 'whale_bubble'], ['dance', 'curtsy'], ['curtsy', 'tap_joy'],
    ['look_around', 'yawn'], ['stretch', 'tail_slap']]
  return [['yawn', 'stretch'], ['look_around', 'tail_slap'], ['dance', 'curtsy'], ['tap_shy', 'tap_joy'],
    ['whale_bubble', 'look_around'], ['jump', 'dance'], ['thinking', 'tap_tickle'], ['stretch', 'yawn']]
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

/**
 * 从连招表里挑一组，第一段尽量不是刚播过的（避免 idle→同一段）。
 * 表空就返回 null，调用方退回随机两段。
 */
export function pickCombo (combos, last, rand) {
  if (!combos || !combos.length) return null
  const rest = combos.filter((c) => c[0] !== last)
  const src = rest.length ? rest : combos
  return src[Math.floor(Math.max(0, Math.min(0.999999, rand)) * src.length)]
}
