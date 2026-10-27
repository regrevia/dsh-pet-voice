import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 专属会话文件指到临时目录：这些用例会派发到「钉住的会话」，不能碰用户真正的绑定。
const dir = mkdtempSync(join(tmpdir(), 'pet-turn-registry-'))
const petFile = join(dir, 'pet-session.json')
process.env.DSH_PET_VOICE_PET_SESSION = petFile

const { __dispatchInternals: D } = await import('../index.js')

// 每个用例前清一次「会话+原句 2.5s 去重」：这些用例故意复用同一句文本，
// 不清的话后一个用例会被前一个的去重记号吞成 deduped（去重是线上行为，不改）。
test.beforeEach(() => D.resetDedupe())

const WS = 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a'
const PET_PATH = '/tmp/pet-lab'
const PINNED = 'session-f389c442-7926-4ab0-beba-db6aadfbbfca'
const fakeReq = { headers: {} }

const writePet = (sessionId = PINNED) =>
  writeFileSync(petFile, `${JSON.stringify({ workspaceId: WS, cwd: PET_PATH, sessionId }, null, 2)}\n`, { mode: 0o600 })

function host({ prompt = async () => ({ ok: true }) } = {}) {
  const calls = { prompt: [], emit: [] }
  const ctx = {
    get: (name) => {
      if (name === 'workspaceRegistry') return { list: () => [{ id: WS, title: D.petWorkspaceName(), path: PET_PATH }] }
      if (name === 'sessionController') {
        return {
          list: async () => [{ id: PINNED, title: '宠物', cwd: PET_PATH }],
          get: async (id) => (id === PINNED ? { id: PINNED, workspaceId: WS, cwd: PET_PATH } : null),
          create: async () => ({ sessionId: 'session-created-1' }),
          prompt: async (request) => {
            calls.prompt.push(request)
            return prompt(request)
          },
          cancel: async () => ({ cancelled: true }),
        }
      }
      return undefined
    },
  }
  const deps = {
    emit: (...args) => calls.emit.push(args),
    liveTurns: new Map(),
    liveAbort: new Map(),
    awaitPetTurn: new Map(),
    turnOrigin: new Map(),
    armEndFallback: () => {},
  }
  return { ctx, deps, calls }
}

test('state.turns 投影：两种 id 写法归一条，幽灵条目顺手删掉', () => {
  const now = Date.now()
  const liveTurns = new Map([
    ['session-aaa', now - 5_000],
    ['aaa', now - 4_000], // 同一轮：宿主两个入口各记了一次
    ['session-bbb', now - 3_000],
    ['ccc', now - 121_000], // 超过 TURN_GHOST_MS：被掐断/热重载后永远等不到 turn/end
    ['ddd', 0], // 脏值
  ])
  const turns = D.publicTurns(liveTurns, now)
  assert.deepEqual(Object.keys(turns).sort(), ['aaa', 'bbb'], '同一轮只该出现一次')
  assert.equal(turns.aaa.since, now - 5_000, '取更早的时刻当这一轮的开始')
  assert.equal(liveTurns.has('ccc'), false, '幽灵条目要当场删掉，不能一直卡在「正在执行」')
  assert.equal(liveTurns.has('ddd'), false, '脏值也删')
  assert.equal(D.publicTurns(new Map(), now).constructor, Object, '空表返回空对象')
  assert.deepEqual(D.publicTurns(new Map(), now), {})
})

test('派发被宿主拒掉（502）：认领记号要撤回，别让下一轮电脑端的 turn/start 被当成手机派的', async () => {
  writePet()
  const { ctx, deps, calls } = host({ prompt: async () => { throw new Error('模型忙') } })
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '收到', sessionId: PINNED }, fakeReq, deps)
  assert.equal(result.status, 502)
  assert.equal(calls.prompt.length, 1)
  assert.equal(deps.awaitPetTurn.size, 0, 'awaitPetTurn 不能留：留着就是下一轮 origin 判成 pet')
  assert.equal(deps.turnOrigin.size, 0, 'turnOrigin 也不该留下')
})

test('派发异步失败（202 之后才炸）：没被认领的记号同样撤回', async () => {
  writePet()
  const { ctx, deps, calls } = host({
    prompt: () => new Promise((_, reject) => setTimeout(() => reject(new Error('跑一半挂了')), 1_400)),
  })
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '收到', sessionId: PINNED }, fakeReq, deps)
  assert.equal(result.status, 202, '1.2s 内没结果就先给 202，手机不干等')
  assert.equal(deps.awaitPetTurn.size, 2, '202 时这轮还没起来，记号先留着等 turn/start 认领（两种 id 写法各一条）')
  assert.equal(deps.liveAbort.has(PINNED), true, 'abort 也挂着，好掐上一轮')
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(deps.awaitPetTurn.size, 0, '异步失败后记号必须撤，否则一直挂在这只会话上')
  const errorFrame = calls.emit.find(([sid, event]) => sid === PINNED && event === 'error')
  assert.ok(errorFrame, '失败要推一帧 error 给手机')
})
