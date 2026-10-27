import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createTokenStore } from '../token.mjs'

const home = () => mkdtempSync(join(tmpdir(), 'pet-token-'))
const read = (p) => readFileSync(p, 'utf8').trim()

test('首次启动生成 token，同时写下备份', () => {
  const dir = home()
  const store = createTokenStore({ homeDir: dir })
  const token = store.current()
  assert.equal(token.length, 48)
  assert.equal(read(store.tokenPath), token)
  assert.equal(read(store.bakPath), token)
})

test('token 文件被删后从备份恢复原值，而不是换密码', () => {
  const dir = home()
  const store = createTokenStore({ homeDir: dir })
  const token = store.current()
  const logs = []
  rmSync(store.tokenPath)
  const again = createTokenStore({ homeDir: dir, log: (m) => logs.push(m) }).current()
  assert.equal(again, token, '恢复出来的必须是同一个 token，否则已配对的手机全部掉线')
  assert.equal(read(store.tokenPath), token)
  assert.ok(logs.some((m) => m.includes('从备份恢复')), `缺少恢复日志：${logs.join(' / ')}`)
})

test('文件和备份都没了才生成新的', () => {
  const dir = home()
  const store = createTokenStore({ homeDir: dir })
  const token = store.current()
  rmSync(store.tokenPath)
  rmSync(store.bakPath)
  const fresh = createTokenStore({ homeDir: dir }).current()
  assert.notEqual(fresh, token)
  assert.equal(fresh.length, 48)
})

test('文件被写空/写坏时也走恢复', () => {
  const dir = home()
  const store = createTokenStore({ homeDir: dir })
  const token = store.current()
  writeFileSync(store.tokenPath, 'short\n')
  assert.equal(createTokenStore({ homeDir: dir }).current(), token)
})

test('rotate 换新值并同步备份', () => {
  const dir = home()
  const store = createTokenStore({ homeDir: dir })
  const old = store.current()
  const next = store.rotate()
  assert.notEqual(next, old)
  assert.equal(read(store.tokenPath), next)
  assert.equal(read(store.bakPath), next)
  // 换过值之后删文件，恢复的应该是新值
  rmSync(store.tokenPath)
  assert.equal(createTokenStore({ homeDir: dir }).current(), next)
})

test('备份文件权限是 0600', () => {
  const dir = home()
  const store = createTokenStore({ homeDir: dir })
  store.current()
  const { mode } = statSync(store.bakPath)
  assert.equal(mode & 0o777, 0o600)
})
