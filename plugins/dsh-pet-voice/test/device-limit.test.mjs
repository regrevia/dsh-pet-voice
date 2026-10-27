import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 设备表指到临时 HOME：这里要反复「写满 / 移除 / 再登记」，绝不能碰用户真正的设备表。
const HOME = mkdtempSync(join(tmpdir(), 'pet-device-limit-'))
mkdirSync(join(HOME, '.dsh', 'pet-voice'), { recursive: true })
process.env.HOME = HOME

const { touchDevice } = await import('../panel.mjs')

const STORE = join(HOME, '.dsh', 'pet-voice', 'devices.json')

/** 造请求：真机会带 x-pet-device-id，本机 curl / 基准脚本不会。 */
const req = (headers) => ({ headers, socket: { remoteAddress: '127.0.0.1' } })
const probe = (ua = 'curl/8.0') => req({ 'user-agent': ua })
const phone = (id) => req({ 'user-agent': 'okhttp/4.12', 'x-pet-device-id': id })

function seed(rows, maxDevices = 3) {
  writeFileSync(STORE, JSON.stringify({ maxDevices, devices: rows }), 'utf8')
}

const row = (id, platform, claimed) => ({
  id,
  label: id,
  platform,
  claimed,
  ip: '127.0.0.1',
  firstSeen: 1,
  lastSeen: 1,
})

test('本机无设备 id 的探测不会被绑定上限挡住', () => {
  // 三台手机已满额。以前这里直接 429，于是 /api/update 也拿不到 versionCode，
  // 外部脚本找不到宿主端口，静默退回写死的旧端口去测（数字全错但看起来正常）。
  seed([row('aaaaaaaa1111', 'android', true), row('bbbbbbbb2222', 'android', true), row('cccccccc3333', 'android', true)])
  for (let i = 0; i < 5; i += 1) {
    const out = touchDevice(probe(`curl/${i}`))
    assert.equal(out.ok, true, `第 ${i + 1} 次本机探测被挡：${JSON.stringify(out)}`)
  }
})

test('上限只管自报设备 id 的手机', () => {
  seed([row('aaaaaaaa1111', 'android', true), row('bbbbbbbb2222', 'android', true)])
  // 额度还剩 1 台
  assert.equal(touchDevice(phone('dddddddd4444')).ok, true)
  // 第 4 台真手机该被挡住
  const full = touchDevice(phone('eeeeeeee5555'))
  assert.equal(full.ok, false)
  assert.equal(full.reason, 'limit')
  assert.equal(full.maxDevices, 3)
})

test('旧数据里占额度的「未知设备」行不算已配对手机', () => {
  // 老版本把本机探测写成 platform=unknown 的行，还占了额度。
  seed([row('aaaaaaaa1111', 'android', true), row('bbbbbbbb2222', 'android', true), row('deadbeef9999', 'unknown', false)])
  assert.equal(touchDevice(phone('dddddddd4444')).ok, true, '第三台真手机应能登记')
})

test('域名绑定的手机移除后额度立刻还回来', () => {
  seed([row('aaaaaaaa1111', 'android', true), row('bbbbbbbb2222', 'android', true), row('cccccccc3333', 'android', true)])
  assert.equal(touchDevice(phone('dddddddd4444')).ok, false, '满额时该挡')

  const store = JSON.parse(readFileSync(STORE, 'utf8'))
  store.devices = store.devices.filter((d) => d.id !== 'aaaaaaaa1111')
  writeFileSync(STORE, JSON.stringify(store), 'utf8')

  assert.equal(touchDevice(phone('dddddddd4444')).ok, true, '移出一台后应该能加进新手机')
})

test('已配对的手机不受上限影响（不能把自己锁在门外）', () => {
  seed([row('aaaaaaaa1111', 'android', true), row('bbbbbbbb2222', 'android', true), row('cccccccc3333', 'android', true)])
  assert.equal(touchDevice(phone('aaaaaaaa1111')).ok, true, '已登记的设备必须一直能用')
})

test('claimed 与 platform 写回后不丢', () => {
  seed([])
  touchDevice(phone('dddddddd4444'))
  touchDevice(probe()) // 本机探测
  const store = JSON.parse(readFileSync(STORE, 'utf8'))
  const claimed = store.devices.find((d) => d.id === 'dddddddd4444')
  const local = store.devices.filter((d) => d.claimed === false)
  assert.equal(claimed.claimed, true)
  assert.equal(claimed.platform, 'android')
  assert.equal(local.length, 1, '本机探测应记为 claimed=false')
})
