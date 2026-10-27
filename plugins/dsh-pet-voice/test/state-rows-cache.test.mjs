import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 专属会话文件指到临时目录：导入 index.js 不能碰用户真正的绑定。
process.env.DSH_PET_VOICE_PET_SESSION = join(mkdtempSync(join(tmpdir(), 'pet-rows-')), 'pet-session.json')

const { __rowsInternals: R } = await import('../index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假宿主：list() 慢 40 ms，并记下到底被调了几次。 */
function host({ sessions = [{ id: 'session-a', title: 'A', cwd: '/tmp/lab' }], presets = [{ id: 'whale', title: '鲸灵' }], delay = 40 } = {}) {
  const calls = { list: 0, presets: 0 }
  const ctx = {
    get: (name) => {
      if (name === 'sessionController') {
        return {
          list: async () => {
            calls.list += 1
            await sleep(delay)
            return sessions
          },
        }
      }
      if (name === 'agentPresets') {
        return {
          list: async () => {
            calls.presets += 1
            await sleep(delay)
            return presets
          },
        }
      }
      return undefined
    },
  }
  return { ctx, calls }
}

test('并发拉会话列表只打一次宿主（single-flight），结果共享', async () => {
  R.resetRowsCache()
  const { ctx, calls } = host()
  const rows = await Promise.all(Array.from({ length: 8 }, () => R.sessionRowsCached(ctx)))
  assert.equal(calls.list, 1, '8 个并发请求只应该落到宿主一次')
  for (const item of rows) assert.deepEqual(item, rows[0])
  assert.equal(rows[0][0].id, 'session-a')
})

test('TTL 内复用缓存，过期后重新拉', async () => {
  R.resetRowsCache()
  const { ctx, calls } = host({ delay: 1 })
  await R.sessionRowsCached(ctx)
  await R.sessionRowsCached(ctx)
  await R.sessionRowsCached(ctx)
  assert.equal(calls.list, 1, 'TTL 内不应该再打宿主')

  await sleep(120)
  await R.sessionRowsCached(ctx, 60)
  assert.equal(calls.list, 2, '过了 TTL 要重新拉一次')
})

test('宿主返回空列表不写缓存（宿主刚起来时会话可能还没落盘）', async () => {
  R.resetRowsCache()
  const empty = host({ sessions: [] })
  assert.deepEqual(await R.sessionRowsCached(empty.ctx), [])
  assert.deepEqual(await R.sessionRowsCached(empty.ctx), [])
  assert.equal(empty.calls.list, 2, '空结果不能缓存住，否则第一次拉的 App 会一直看到空')
})

test('一次在飞失败不会把 pending 卡死：后续请求还能重新拉', async () => {
  R.resetRowsCache()
  let attempt = 0
  const ctx = {
    get: () => ({
      list: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('宿主还没准备好')
        return [{ id: 'session-b', title: 'B' }]
      },
    }),
  }
  // sessionRows 自己会吞掉异常返回 []，这里断言的是「吞掉之后 pending 已清空、能再拉」。
  assert.deepEqual(await R.sessionRowsCached(ctx), [])
  const retried = await R.sessionRowsCached(ctx)
  assert.equal(retried[0].id, 'session-b')
  assert.equal(attempt, 2, '失败之后要允许重试')
})

test('预设列表同样并发合并', async () => {
  R.resetRowsCache()
  const { ctx, calls } = host()
  const rows = await Promise.all(Array.from({ length: 8 }, () => R.presetRowsCached(ctx)))
  assert.equal(calls.presets, 1)
  assert.equal(rows[0][0].id, 'whale')
})

test('/api/state 用的软缓存：过期也立刻回旧列表，刷新在后台跑', async () => {
  R.resetRowsCache()
  const { ctx, calls } = host({ delay: 120 })
  // 先填满一次
  await R.sessionRowsCached(ctx, 1)
  assert.equal(calls.list, 1)
  await sleep(20) // 让 TTL=1 过期
  const t0 = Date.now()
  const rows = await R.sessionRowsSoft(ctx, 1)
  const cost = Date.now() - t0
  assert.equal(rows[0].id, 'session-a', '过期也要把旧列表发出去')
  assert.ok(cost < 60, `软缓存不该等宿主（等了 ${cost} ms），022 是 120 ms 的 list()`)
  await sleep(200) // 等后台刷新落地
  assert.equal(calls.list, 2, '过期之后要在后台补一次')
})

test('软缓存没有旧列表时才等宿主', async () => {
  R.resetRowsCache()
  const { ctx, calls } = host({ delay: 40 })
  const rows = await R.sessionRowsSoft(ctx)
  assert.equal(rows[0].id, 'session-a')
  assert.equal(calls.list, 1)
})
