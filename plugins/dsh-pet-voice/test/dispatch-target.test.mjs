import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 必须先把专属会话文件指到临时目录：后面的用例会重写它，不能碰用户真正的绑定。
const dir = mkdtempSync(join(tmpdir(), 'pet-dispatch-'))
const petFile = join(dir, 'pet-session.json')
process.env.DSH_PET_VOICE_PET_SESSION = petFile

const { __dispatchInternals: D } = await import('../index.js')

const PET_PATH = '/tmp/pet-lab'
const ACTIVE = 'session-74575c14-ef72-45c0-8d6e-44e1fc0010d8'
const PINNED = 'session-f389c442-7926-4ab0-beba-db6aadfbbfca'

const writePet = (value) => writeFileSync(petFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
const fakeReq = { headers: {} }

/** 宿主替身：workspace 有专属项目；list() 可以故意漏掉会话（就是这次 bug 的场景）。 */
function host({ rows = [], prompt = async () => ({ ok: true }), create = async () => ({ sessionId: 'session-created-1' }), get } = {}) {
  const calls = { prompt: [], create: [], emit: [] }
  const ctx = {
    get: (name) => {
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', title: D.petWorkspaceName(), path: PET_PATH }] }
      if (name === 'sessionController') {
        return {
          list: async () => rows,
          get: get ?? (async () => { throw new Error('get 不支持') }),
          create: async (request) => { calls.create.push(request); return create(request) },
          prompt: async (request) => { calls.prompt.push(request); return prompt(request) },
        }
      }
      return undefined
    },
  }
  const deps = { emit: (...args) => calls.emit.push(args), liveTurns: new Map(), liveAbort: new Map() }
  return { ctx, deps, calls }
}

test('② prompt 报不存在 → 404，且不往任何会话发事件、去重记录回滚', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: PINNED })
  const gone = 'session-00000000-dead-beef-0000-000000000000'
  const { ctx, deps, calls } = host({ rows: [], prompt: async () => { throw new Error(`会话不存在：${gone}`) } })
  const first = await D.dispatchToSession(ctx, { preset: '' }, { text: '收到', sessionId: gone, requestId: 'rid-missing-1' }, fakeReq, deps)
  assert.equal(first.status, 404)
  assert.equal(first.body.ok, false)
  assert.match(first.body.error, /会话不存在/)
  assert.equal(calls.emit.length, 0, '404 时不能给别的会话补发任何事件')

  // 同一 requestId 再来一次：失败那次必须已经把去重记录删掉，否则重发会被当成「已收到」。
  const ok = host({ rows: [], prompt: async () => ({ ok: true }) })
  const second = await D.dispatchToSession(ok.ctx, { preset: '' }, { text: '收到', sessionId: gone, requestId: 'rid-missing-1' }, fakeReq, ok.deps)
  assert.equal(second.status, 200)
  assert.equal(ok.calls.prompt.length, 1, '失败的派发不该占用 requestId')
})

test('① list() 漏掉该会话，但 prompt 成功 → 200 且 usedSessionId 就是它', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: PINNED })
  const { ctx, deps, calls } = host({ rows: [], prompt: async () => ({ ok: true }) })
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '回复两个字：收到', sessionId: PINNED, mode: 'queue' }, fakeReq, deps)
  assert.equal(result.status, 200)
  assert.equal(result.body.sessionId, PINNED)
  assert.equal(result.body.usedSessionId, PINNED)
  assert.equal(calls.prompt[0].sessionId, PINNED)
  assert.equal(calls.create.length, 0, '显式钉了会话就不该另建')
  assert.notEqual(result.body.usedSessionId, ACTIVE)
})

test('③ 无 sessionId 且专属会话丢失 → 重建专属会话，绝不落到活动会话', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: 'session-11111111-dead-beef-2222-222222222222' })
  const { ctx, deps, calls } = host({ rows: [], prompt: async () => ({ ok: true }) })
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '收到', mode: 'queue' }, fakeReq, deps)
  assert.equal(result.status, 200)
  assert.equal(result.body.usedSessionId, 'session-created-1')
  assert.notEqual(result.body.usedSessionId, ACTIVE)
  assert.equal(calls.create.length, 1)
  assert.equal(JSON.parse(readFileSync(petFile, 'utf8')).sessionId, 'session-created-1')
})

test('③b 专属会话建不出来 → 明确报错，不用活动会话兜底', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: 'session-33333333-dead-beef-4444-444444444444' })
  const { ctx, deps, calls } = host({ rows: [], create: async () => { throw new Error('create 失败') } })
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '收到', mode: 'queue' }, fakeReq, deps)
  assert.equal(result.status, 503)
  assert.equal(result.body.error, '专属会话不可用')
  assert.equal(calls.prompt.length, 0)
})

test('专属会话被 list() 漏掉时沿用绑定，不重建', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: PINNED })
  const { ctx, deps, calls } = host({ rows: [], prompt: async () => ({ ok: true }) })
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '收到' }, fakeReq, deps)
  assert.equal(result.status, 200)
  assert.equal(result.body.usedSessionId, PINNED)
  assert.equal(calls.create.length, 0)
})
