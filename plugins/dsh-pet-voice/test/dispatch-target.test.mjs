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

// 每个用例前清一次「会话+原句 2.5s 去重」：这些用例故意复用同一句文本，
// 不清的话后一个用例会被前一个的去重记号吞成 deduped（去重是线上行为，不改）。
test.beforeEach(() => D.resetDedupe())

const PET_PATH = '/tmp/pet-lab'
const ACTIVE = 'session-74575c14-ef72-45c0-8d6e-44e1fc0010d8'
const PINNED = 'session-f389c442-7926-4ab0-beba-db6aadfbbfca'

const writePet = (value) => writeFileSync(petFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
const fakeReq = { headers: {} }

/** 宿主替身：workspace 有专属项目；list() 可以故意漏掉会话（就是这次 bug 的场景）。 */
function host({ rows = [], prompt = async () => ({ ok: true }), create = async () => ({ sessionId: 'session-created-1' }), get } = {}) {
  const calls = { prompt: [], create: [], cancel: [], emit: [], ended: [] }
  const ctx = {
    get: (name) => {
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', title: D.petWorkspaceName(), path: PET_PATH }] }
      if (name === 'sessionController') {
        return {
          list: async () => rows,
          get: get ?? (async () => { throw new Error('get 不支持') }),
          create: async (request) => { calls.create.push(request); return create(request) },
          prompt: async (request) => { calls.prompt.push(request); return prompt(request) },
          cancel: async (request) => { calls.cancel.push(request); return { cancelled: true } },
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
    armEndFallback: (id, reason, graceMs) => calls.ended.push({ id, reason, graceMs }),
  }
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
  // 这里让宿主「认得」这个 id（get 能取到），走到的是 prompt 报错那条路——和上面提前
  // 判死不同，这条专门盯去重回滚。
  const ok = host({ rows: [], get: async () => ({ sessionId: gone }), prompt: async () => ({ ok: true }) })
  const second = await D.dispatchToSession(ok.ctx, { preset: '' }, { text: '收到', sessionId: gone, requestId: 'rid-missing-1' }, fakeReq, ok.deps)
  assert.equal(second.status, 200)
  assert.equal(ok.calls.prompt.length, 1, '失败的派发不该占用 requestId')
})

test('②b 宿主三层都不认这个 id → 提前 404，连 prompt 都不调', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: PINNED })
  const ghost = 'session-00000000-0000-4000-8000-00000000dead'
  const { ctx, deps, calls } = host({ rows: [] })
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '收到', sessionId: ghost }, fakeReq, deps)
  assert.equal(result.status, 404)
  assert.match(result.body.error, /会话不存在/)
  assert.equal(calls.prompt.length, 0, '不存在的会话不该真的派出去')
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

test('③ 电脑那轮在跑 → 不取消它，手机这句排队（回执带 queued）', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: PINNED })
  const { ctx, deps, calls } = host({ rows: [{ id: PINNED, title: '宠物', cwd: PET_PATH }] })
  // 宿主里这条会话正在跑，且那一轮是电脑上敲的（没有我们的 abort、来源标成 desktop）。
  // 以前这里会 controller.cancel 把电脑上的活掐掉，主人看到的就是「手机这句没进队列，
  // 电脑那边也不出结果」。现在只排队，不动别人的轮次。
  deps.liveTurns.set(PINNED, Date.now())
  deps.turnOrigin.set(PINNED, 'desktop')
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '说点别的', sessionId: PINNED }, fakeReq, deps)
  assert.equal(result.status, 200)
  assert.equal(calls.cancel.length, 0, '电脑那轮不能取消')
  assert.equal(result.body.queued, true, '回执要告诉手机这句排在电脑那轮后面')
  assert.equal(calls.prompt.length, 1, '照常派新的一句，让它排在队里')
  const queuedFrame = calls.emit.find(([sid, event]) => sid === PINNED && event === 'queued')
  assert.ok(queuedFrame, '要推一帧 queued，手机才知道是排队而不是在跑')
  assert.equal(queuedFrame[2]?.origin, undefined, 'queued 帧不能带 origin：带了会被手机当成电脑那轮的帧丢掉')
})

test('③b 上一轮是手机派的但没留 abort → 仍然取消，避免手机自己排在自己后面', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: PINNED })
  const { ctx, deps, calls } = host({ rows: [{ id: PINNED, title: '宠物', cwd: PET_PATH }] })
  deps.liveTurns.set(PINNED, Date.now())
  deps.turnOrigin.set(PINNED, 'pet')
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '说点别的', sessionId: PINNED }, fakeReq, deps)
  assert.equal(result.status, 200)
  assert.equal(calls.cancel.length, 1, '自己派的上一轮要取消')
  assert.equal(result.body.queued, false)
  // 取消之后必须自己销账：否则 liveTurns 里这只永远活着，收尾兜底 90s→180s→5min 不敢发 end，
  // 手机就卡在「处理中」（turn.log 里那串 end-hold held=90000ms/180012ms/270012ms 就是它）。
  assert.equal(deps.liveTurns.has(PINNED), false, '取消后 liveTurns 要清掉')
  assert.equal(calls.ended.length, 1, '取消后要主动安排收尾')
  assert.equal(calls.ended[0].reason, 'interrupted')
  assert.equal(calls.ended[0].graceMs, 2000)
})

test('④ 上一轮是自己派的 → 用自己的 abort 掐，不再额外取消', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: PINNED })
  const { ctx, deps, calls } = host({ rows: [{ id: PINNED, title: '宠物', cwd: PET_PATH }] })
  const ac = new AbortController()
  let aborted = false
  ac.signal.addEventListener('abort', () => { aborted = true })
  deps.liveTurns.set(PINNED, Date.now())
  deps.liveAbort.set(PINNED, ac)
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '说点别的', sessionId: PINNED }, fakeReq, deps)
  assert.equal(result.status, 200)
  assert.equal(aborted, true, '自己的 abort 必须真的触发')
  assert.equal(calls.cancel.length, 0, '有 abort 就不该再取消')
  assert.equal(deps.liveTurns.has(PINNED), false, '掐掉之后 liveTurns 也要清掉')
  assert.equal(calls.ended.length, 1, '掐掉之后要主动安排收尾')
  assert.equal(calls.ended[0].graceMs, 2000)
})

test('③c 引导（steer）打在电脑那轮上：不取消、不抢中断把手，prompt 走 steer', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: PINNED })
  const { ctx, deps, calls } = host({ rows: [{ id: PINNED, title: '宠物', cwd: PET_PATH }] })
  deps.liveTurns.set(PINNED, Date.now())
  deps.turnOrigin.set(PINNED, 'desktop')
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '顺手看下日志', sessionId: PINNED, steer: true }, fakeReq, deps)
  assert.equal(result.status, 200)
  assert.equal(calls.cancel.length, 0, '引导不能取消正在跑的那轮')
  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].mode, 'steer', '引导要作为这一轮的一步，不是新排一轮')
  assert.equal(result.body.steered, true, '回执要告诉手机这句已经并进当前轮')
  // 引导没有自己的 abort：登记上去会覆盖主轮的中断把手，取消按钮就掐不到东西了
  assert.equal(deps.liveAbort.has(PINNED), false, '引导不能登记 liveAbort')
  assert.equal(deps.awaitPetTurn.has(PINNED), false, '引导不能把自己标成「手机派的那轮」')
})

test('⑧ 宿主拒收别人的会话（Team 队员）→ 409，不能报成可重试的 502', async () => {
  writePet({ workspaceId: 'ef76a38a-8d4f-40e0-8e7c-f05734c1178a', cwd: PET_PATH, sessionId: PINNED })
  const foreign = 'session-1234abcd-0000-4000-8000-00000000beef'
  const { ctx, deps } = host({
    rows: [{ id: foreign, title: '队员', cwd: PET_PATH }],
    prompt: async () => { throw new Error(`session "${foreign}" is owned by subagent routing`) },
  })
  const result = await D.dispatchToSession(ctx, { preset: '' }, { text: '在吗', sessionId: foreign, requestId: 'rid-foreign-1' }, fakeReq, deps)
  assert.equal(result.status, 409, '永久拒收要给 4xx：5xx 会被手机当成网络问题无限退避重发')
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error, '这个会话不能从手机发')
  // 失败的派发不能留下去重记号，否则用户换会话重发同一句会被吞掉
  const again = await D.dispatchToSession(ctx, { preset: '' }, { text: '在吗', sessionId: foreign, requestId: 'rid-foreign-1' }, fakeReq, deps)
  assert.equal(again.status, 409)
})
