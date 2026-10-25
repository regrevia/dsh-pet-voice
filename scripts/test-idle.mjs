import assert from 'node:assert'
import { idlePool, nextIdleDelay } from '../android/app/src/main/assets/pet/idle.js'

// 白天：爱动，不能出现睡觉
const day = idlePool(12)
assert.ok(!day.includes('sleep') && !day.includes('yawn'))
assert.ok(day.includes('dance') && day.includes('curtsy'))

// 晚上：收敛，出现犯困
const evening = idlePool(20)
assert.ok(evening.includes('yawn') && !evening.includes('dance'))

// 深夜：只犯困/睡
assert.deepStrictEqual(idlePool(2), ['sleep', 'yawn', 'stretch'])
assert.deepStrictEqual(idlePool(23), ['sleep', 'yawn', 'stretch'])

// 间隔 9–22 s，且越界参数被夹住
assert.strictEqual(nextIdleDelay(0), 9000)
assert.strictEqual(nextIdleDelay(1), 22000)
assert.strictEqual(nextIdleDelay(-5), 9000)
assert.strictEqual(nextIdleDelay(9), 22000)
const mid = nextIdleDelay(0.5)
assert.ok(mid > 15000 && mid < 16000, String(mid))

console.log('test-idle: 8/8 pass')
