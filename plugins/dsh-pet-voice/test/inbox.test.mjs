// 队列操作（撤掉 / 上移 / 下移）走的是宿主 agent.inbox 的同一套接口。
// 这里用一只假 agent 钉住契约：next-step 在前、next-turn 在后，remove(id) 与
// splice(kind, start, count, items) 的调用形状跟宿主源码一致。
import test from 'node:test'
import assert from 'node:assert/strict'

const { __inboxInternals } = await import('../index.js')
const { liveInbox, inboxActionRoute } = __inboxInternals

function makeAgent(rows) {
  const state = {
    'next-step': rows.filter((r) => r.kind === 'next-step').map((r) => msg(r)),
    'next-turn': rows.filter((r) => r.kind === 'next-turn').map((r) => msg(r)),
  }
  const calls = []
  const inbox = {
    get nextStep() { return state['next-step'] },
    get nextTurn() { return state['next-turn'] },
    remove(id) {
      calls.push(['remove', id])
      state['next-step'] = state['next-step'].filter((m) => m.id !== id)
      state['next-turn'] = state['next-turn'].filter((m) => m.id !== id)
    },
    splice(kind, start, count, items) {
      calls.push(['splice', kind, start, count, items.map((m) => m.id)])
      state[kind] = state[kind].slice(0, start).concat(items, state[kind].slice(start + count))
    },
  }
  return { agent: { inbox }, calls }
}

function msg(row) {
  return { id: row.id, at: new Date(1_700_000_000_000).toISOString(), content: [{ type: 'text', text: row.text }] }
}

function ctxFor(agent) {
  return { get: (key) => (key === 'sessionController' ? { resolveAgent: async () => ({ agent }) } : undefined) }
}

test('liveInbox 按 next-step / next-turn 顺序给出带 id 的行', async () => {
  const { agent } = makeAgent([
    { kind: 'next-step', id: 'a', text: '插一句' },
    { kind: 'next-turn', id: 'b', text: '等一轮' },
  ])
  const rows = await liveInbox(ctxFor(agent), 's1')
  assert.deepEqual(rows.map((r) => [r.kind, r.id, r.text]), [
    ['next-step', 'a', '插一句'],
    ['next-turn', 'b', '等一轮'],
  ])
})

test('remove：撤掉指定那条，剩下的不动', async () => {
  const { agent, calls } = makeAgent([
    { kind: 'next-turn', id: 'a', text: '一' },
    { kind: 'next-turn', id: 'b', text: '二' },
  ])
  const out = await inboxActionRoute(ctxFor(agent), { sessionId: 's1', action: 'remove', id: 'a' })
  assert.equal(out.status, 200)
  assert.deepEqual(calls[0], ['remove', 'a'])
  assert.deepEqual(out.body.inbox.map((r) => r.id), ['b'])
})

test('up：同一条队列里向前挪一格', async () => {
  const { agent, calls } = makeAgent([
    { kind: 'next-turn', id: 'a', text: '一' },
    { kind: 'next-turn', id: 'b', text: '二' },
  ])
  const out = await inboxActionRoute(ctxFor(agent), { sessionId: 's1', action: 'up', id: 'b' })
  assert.equal(out.status, 200)
  assert.deepEqual(calls[0], ['splice', 'next-turn', 0, 2, ['b', 'a']])
  assert.deepEqual(out.body.inbox.map((r) => r.id), ['b', 'a'])
})

test('已经在头上再上移：409，不改队列', async () => {
  const { agent, calls } = makeAgent([{ kind: 'next-turn', id: 'a', text: '一' }])
  const out = await inboxActionRoute(ctxFor(agent), { sessionId: 's1', action: 'up', id: 'a' })
  assert.equal(out.status, 409)
  assert.equal(calls.length, 0)
})

test('那条已经轮到了：409 带回最新队列，不建假成功', async () => {
  const { agent } = makeAgent([{ kind: 'next-turn', id: 'a', text: '一' }])
  const out = await inboxActionRoute(ctxFor(agent), { sessionId: 's1', action: 'remove', id: 'ghost' })
  assert.equal(out.status, 409)
  assert.deepEqual(out.body.inbox.map((r) => r.id), ['a'])
})

test('参数不全不碰宿主', async () => {
  const { agent, calls } = makeAgent([{ kind: 'next-turn', id: 'a', text: '一' }])
  const out = await inboxActionRoute(ctxFor(agent), { sessionId: 's1', action: 'remove' })
  assert.equal(out.status, 400)
  assert.equal(calls.length, 0)
})
