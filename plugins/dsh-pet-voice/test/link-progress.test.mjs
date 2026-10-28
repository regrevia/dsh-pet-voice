import assert from 'node:assert/strict'
import test from 'node:test'

// 通过环境变量把「手机碰过的会话」指向临时文件，避免动到用户真正的 phone-touch.json
process.env.DSH_PET_VOICE_HOME = (await import('node:fs')).mkdtempSync(
  (await import('node:path')).join((await import('node:os')).tmpdir(), 'pet-link-'),
)

const { __linkInternals: L } = await import('../index.js')

// 中途进度气泡的判据是纯函数：这一条只要守住「什么时候说、一轮说几次」，线上就只受它管。
test('跑得不久就不打扰：不到 25 秒一句不说', () => {
  const now = 1_000_000
  assert.equal(L.progressLineFor(now - 24_999, false, now), '')
})

test('跑了 25 秒以上、这一轮还没说过，就给一句「还在跑」', () => {
  const now = 1_000_000
  assert.equal(L.progressLineFor(now - 25_000, false, now), '还在跑，再等等')
})

test('一轮只给一次：已经说过就不再刷屏', () => {
  const now = 1_000_000
  assert.equal(L.progressLineFor(now - 600_000, true, now), '')
})

test('没有开始时刻（不是手机派出去的活）不说话', () => {
  assert.equal(L.progressLineFor(0, false, 1_000_000), '')
})
