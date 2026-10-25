import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 专属会话文件指到临时目录：/new 的用例可能重建会话，不能碰用户真身绑定。
const dir = mkdtempSync(join(tmpdir(), 'pet-net-'))
const petFile = join(dir, 'pet-session.json')
process.env.DSH_PET_VOICE_PET_SESSION = petFile

const { __netInternals: N, __dispatchInternals: D } = await import('../index.js')

const PET_PATH = '/tmp/pet-lab'
const WRITE_ERROR = Object.assign(new Error('write after end'), { code: 'ERR_STREAM_DESTROYED' })

/** 端到端能记录写入的假 res。 */
function fakeRes(overrides = {}) {
  const record = { status: 0, headers: null, body: '', heads: 0, ends: 0 }
  const res = {
    writableEnded: false,
    destroyed: false,
    closed: false,
    writeHead(status, headers) {
      record.heads += 1
      record.status = status
      record.headers = headers
    },
    end(body) {
      record.ends += 1
      record.body = body ?? ''
    },
    ...overrides,
  }
  return { res, record }
}

test('① 已结束/已销毁/写到一半抛错的 res：sendJson 不抛，返回 false', () => {
  const ended = fakeRes({ writableEnded: true })
  assert.equal(N.sendJson(ended.res, 200, { ok: true }), false)
  assert.equal(ended.record.heads, 0)

  const destroyed = fakeRes({ destroyed: true })
  assert.equal(N.sendJson(destroyed.res, 200, { ok: true }), false)
  assert.equal(destroyed.record.heads, 0)

  const broken = fakeRes({
    writeHead() { throw WRITE_ERROR },
  })
  assert.equal(N.sendJson(broken.res, 200, { ok: true }), false)
  assert.equal(N.writeHead(broken.res, 200, {}), false)
  assert.equal(N.sendHtml(broken.res, 200, '<p>x</p>'), false)

  // 正常 res 仍要写成功（别为了防崩把响应吞了）
  const live = fakeRes()
  assert.equal(N.sendJson(live.res, 200, { ok: true }), true)
  assert.equal(live.record.status, 200)
  assert.equal(live.record.ends, 1)
  assert.equal(JSON.parse(live.record.body).ok, true)

  // headersSent 但没 ended：还能 end()，不能当成已结束丢掉
  const headersOnly = fakeRes({ headersSent: true })
  assert.equal(N.resGone(headersOnly.res), false)
  assert.equal(N.sendJson(headersOnly.res, 200, { ok: true }), true)
})

test('② safeHandler：async await 抛错不产生 unhandledRejection，只回一次 500', async () => {
  let unhandled = 0
  const onUnhandled = () => { unhandled += 1 }
  process.on('unhandledRejection', onUnhandled)
  try {
    const { res, record } = fakeRes()
    const handler = N.safeHandler(async (req, out) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error('boom')
    })
    handler({}, res)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(unhandled, 0, 'await 抛错变成了 unhandledRejection')
    assert.equal(record.heads, 1)
    assert.equal(record.status, 500)
    assert.deepEqual(JSON.parse(record.body), { ok: false, error: '内部错误' })

    // 第二个 handler 同步抛错：同样只记一次，不炸
    const sync = fakeRes()
    N.safeHandler(() => { throw new Error('sync boom') })({}, sync.res)
    assert.equal(sync.record.status, 500)

    // 对端已经走了：不再写第二次
    const gone = fakeRes({ writableEnded: true })
    const late = N.safeHandler(async () => { throw new Error('late') })
    late({}, gone.res)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(gone.record.heads, 0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('③ /new 客户端提前断开：不 create，也不消费专属会话', async () => {
  writeFileSync(petFile, `${JSON.stringify({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: 'session-f389c442-7926-4ab0-beba-db6aadfbbfca' })}\n`, { mode: 0o600 })
  const calls = { create: 0, list: 0, prompt: 0 }
  const ctx = {
    get: (name) => {
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', title: D.petWorkspaceName(), path: PET_PATH }] }
      if (name === 'sessionController') {
        return {
          list: async () => { calls.list += 1; return [] },
          create: async () => { calls.create += 1; return { sessionId: 'session-should-not-exist' } },
          prompt: async () => { calls.prompt += 1 },
        }
      }
      return undefined
    },
  }
  const gone = fakeRes({ writableEnded: true })
  const out = await D.newSessionRoute(ctx, { preset: '' }, { fresh: true }, gone.res)
  assert.equal(out, null)
  assert.equal(calls.create, 0, '客户端走了还 create 了一只会话')
  assert.equal(calls.list, 0, '客户端走了还去问宿主列表')

  // 正常路径仍然能复用专属会话（别把 /new 修死了）
  const pet = {
    get: () => {
      throw new Error('not supported')
    },
  }
  void pet
  const live = fakeRes()
  const okOut = await D.newSessionRoute(
    {
      get: (name) => (name === 'sessionController' ? { create: async () => ({ sessionId: 'x' }), list: async () => [], get: async () => ({ sessionId: 'session-f389c442-7926-4ab0-beba-db6aadfbbfca', cwd: PET_PATH }) } : name === 'workspaceRegistry' ? { list: () => [{ id: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', title: D.petWorkspaceName(), path: PET_PATH }] } : undefined),
    },
    { preset: '' },
    {},
    live.res,
  )
  assert.equal(okOut.status, 200)
  assert.equal(okOut.body.reused, true)
  assert.equal(okOut.body.sessionId, 'session-f389c442-7926-4ab0-beba-db6aadfbbfca')
})

test('④ 进程兜底：benign 只记日志，非 benign 摘监听后重抛给宿主', () => {
  const fake = new EventEmitter()
  const thrown = []
  // 注入假的 process 与假的 setImmediate：捕获重抛，别真把测试进程炸掉。
  const uninstall = N.installNetGuard(fake, (fn) => {
    try { fn() } catch (error) { thrown.push(error) }
  })
  assert.equal(fake.listenerCount('uncaughtException'), 1)
  assert.equal(fake.listenerCount('unhandledRejection'), 1)

  // benign 写流错误：不抛、不摘监听
  const benign = Object.assign(new Error('write after end'), { code: 'ERR_STREAM_DESTROYED' })
  fake.emit('uncaughtException', benign)
  assert.deepEqual(thrown, [])
  assert.equal(fake.listenerCount('uncaughtException'), 1)
  assert.equal(fake.listenerCount('unhandledRejection'), 1)

  // 重复安装不叠加监听器
  N.installNetGuard(fake, () => {})
  assert.equal(fake.listenerCount('uncaughtException'), 1)

  // 非 benign：先摘监听，再把错误原样抛回宿主（不自我循环）
  const fatal = Object.assign(new Error('real bug'), { code: 'EBOOM' })
  fake.emit('unhandledRejection', fatal)
  assert.deepEqual(thrown, [fatal])
  assert.equal(fake.listenerCount('unhandledRejection'), 0)
  assert.equal(fake.listenerCount('uncaughtException'), 0)

  // 卸载后再装仍然只有一条；卸载函数可重复调用
  uninstall()
  const again = N.installNetGuard(fake, () => {})
  assert.equal(fake.listenerCount('uncaughtException'), 1)
  again()
  again()
  assert.equal(fake.listenerCount('uncaughtException'), 0)
})

test('withTimeout：超时报 ETIMEDOUT，正常 promise 原样返回', async () => {
  await assert.rejects(
    N.withTimeout(new Promise(() => {}), 20, '超时了'),
    (error) => error.code === 'ETIMEDOUT' && error.message === '超时了',
  )
  assert.equal(await N.withTimeout(Promise.resolve('v'), 50, '超时了'), 'v')
})
