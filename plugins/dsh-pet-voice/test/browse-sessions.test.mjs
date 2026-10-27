import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 专属会话文件指到临时目录：导入 index.js 不能碰用户真正的绑定。
process.env.DSH_PET_VOICE_PET_SESSION = join(mkdtempSync(join(tmpdir(), 'pet-browse-')), 'pet-session.json')

const { __rowsInternals: R, __browseInternals: B } = await import('../index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function host(sessions, delay = 40) {
  const calls = { list: 0 }
  const ctx = {
    get: (name) =>
      name === 'sessionController'
        ? {
            list: async () => {
              calls.list += 1
              await sleep(delay)
              return sessions
            },
          }
        : undefined,
  }
  return { ctx, calls }
}

const row = (i, extra = {}) => ({
  id: `session-${String(i).padStart(3, '0')}`,
  title: `会话 ${i}`,
  cwd: '/tmp/lab',
  workspaceId: 'ws-1',
  updatedAt: 1_700_000_000_000 - i * 1000,
  ...extra,
})

test('列表页走 SWR：缓存暖时先给行，不等慢宿主', async () => {
  R.resetRowsCache()
  const { ctx } = host([row(1), row(2)], 300)
  await R.sessionRowsCached(ctx) // 预热缓存
  const t0 = Date.now()
  const page = await B.browseSessions(ctx, { limit: '5' }, new Map(), { soft: true })
  const ms = Date.now() - t0
  assert.equal(page.ok, true)
  assert.equal(page.sessions.length, 2)
  assert.ok(ms < 100, `软路径应该立刻返回缓存，实际 ${ms} ms`)
})

test('不带 soft 时仍等宿主（派发/解析要准）', async () => {
  R.resetRowsCache()
  const { ctx, calls } = host([row(1)], 150)
  const t0 = Date.now()
  const page = await B.browseSessions(ctx, { limit: '5' }, new Map())
  const ms = Date.now() - t0
  assert.equal(calls.list, 1)
  assert.equal(page.sessions.length, 1)
  assert.ok(ms >= 150, `严格路径应该等宿主，实际 ${ms} ms`)
})

test('缓存空时软路径照样等宿主（不能给空页）', async () => {
  R.resetRowsCache()
  const { ctx, calls } = host([row(1), row(2)], 20)
  const page = await B.browseSessions(ctx, { limit: '5' }, new Map(), { soft: true })
  assert.equal(calls.list, 1, '缓存空时必须真拉一次')
  assert.equal(page.sessions.length, 2)
})

test('按最近活跃排序，limit+1 判 hasMore 并给 nextBefore', async () => {
  R.resetRowsCache()
  // 行本身乱序，宿主返回顺序不保证；接口必须自己按 updatedAt 倒序。
  const rows = [row(7), row(2), row(9), row(1), row(5), row(3), row(8), row(4), row(6)]
  const { ctx } = host(rows, 1)
  const page = await B.browseSessions(ctx, { limit: '3' }, new Map())
  assert.deepEqual(
    page.sessions.map((s) => s.id),
    ['session-001', 'session-002', 'session-003'],
  )
  assert.equal(page.hasMore, true)
  assert.equal(page.nextBefore, page.sessions[2].updatedAt)
})

test('无标题且 0 轮的空壳不占名额（懒加载也只算到够用为止）', async () => {
  R.resetRowsCache()
  // 前 20 条都是没标题的空壳：应该被跳过，真正返回的是后面有标题的 5 条。
  const shells = Array.from({ length: 20 }, (_, i) => row(100 + i, { title: '' }))
  const real = Array.from({ length: 5 }, (_, i) => row(i + 1))
  const { ctx } = host([...shells, ...real], 1)
  const page = await B.browseSessions(ctx, { limit: '5' }, new Map())
  assert.equal(page.sessions.length, 5)
  assert.deepEqual(
    page.sessions.map((s) => s.id),
    ['session-001', 'session-002', 'session-003', 'session-004', 'session-005'],
  )
  assert.equal(page.hasMore, false)
})

test('projectId 过滤与 before 游标照旧生效', async () => {
  R.resetRowsCache()
  const { ctx } = host(
    [
      row(1, { workspaceId: 'ws-1' }),
      row(2, { workspaceId: 'ws-2' }),
      row(3, { workspaceId: 'ws-1', updatedAt: 1_000 }),
    ],
    1,
  )
  const page = await B.browseSessions(ctx, { projectId: 'ws-1', before: '1700000000000' }, new Map())
  assert.deepEqual(
    page.sessions.map((s) => s.id),
    ['session-001', 'session-003'],
  )
})

test('running 记号来自 liveTurns，不影响分页', async () => {
  R.resetRowsCache()
  const { ctx } = host([row(1), row(2)], 1)
  const liveTurns = new Map([['session-002', Date.now()]])
  const page = await B.browseSessions(ctx, { limit: '5' }, liveTurns)
  assert.equal(page.sessions.find((s) => s.id === 'session-002').running, true)
  assert.equal(page.sessions.find((s) => s.id === 'session-001').running, false)
})
