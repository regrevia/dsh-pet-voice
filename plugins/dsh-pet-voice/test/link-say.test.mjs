import test from 'node:test'
import assert from 'node:assert/strict'

const { __linkInternals: L } = await import('../index.js')

const now = 1_800_000_000_000
const on = { link: true, bubble: true }

test('联动和气泡都开、会话刚碰过才说话', () => {
  assert.equal(L.linkSayAllowed({ cfg: on, key: 'abc', line: '好，停了', touchedAt: now - 60_000, now }), true)
})

test('任一面板开关关掉就闭嘴', () => {
  for (const cfg of [{ link: false, bubble: true }, { link: true, bubble: false }, {}, null]) {
    assert.equal(L.linkSayAllowed({ cfg, key: 'abc', line: '好，停了', touchedAt: now - 60_000, now }), false)
  }
})

test('没碰过的会话不插话', () => {
  assert.equal(L.linkSayAllowed({ cfg: on, key: 'abc', line: '好，停了', touchedAt: 0, now }), false)
  assert.equal(L.linkSayAllowed({ cfg: on, key: '', line: '好，停了', touchedAt: now, now }), false)
})

test('超过 30 分钟的会话算过去了', () => {
  const watch = 30 * 60_000
  assert.equal(L.linkSayAllowed({ cfg: on, key: 'abc', line: '好，停了', touchedAt: now - watch - 1, now }), false)
  assert.equal(L.linkSayAllowed({ cfg: on, key: 'abc', line: '好，停了', touchedAt: now - watch + 1_000, now }), true)
})

test('空话不发', () => {
  assert.equal(L.linkSayAllowed({ cfg: on, key: 'abc', line: '   ', touchedAt: now, now }), false)
})
