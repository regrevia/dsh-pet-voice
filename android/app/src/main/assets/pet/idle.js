// 待机小动作的纯逻辑：什么时候来一段、来哪一段。抽出来是为了能在 Node 里单测。
export function idlePool (hour) {
  if (hour >= 23 || hour < 6) return ['sleep', 'yawn', 'stretch']
  if (hour >= 19) return ['look', 'yawn', 'stretch', 'tail']
  return ['look', 'dance', 'curtsy', 'whale', 'tail', 'stretch']
}

/** 1.5–3 s 来一次，rand 传 Math.random() 便于测。动作不停顿靠这个密度撑着。 */
export function nextIdleDelay (rand) {
  return 1500 + Math.max(0, Math.min(1, rand)) * 1500
}
