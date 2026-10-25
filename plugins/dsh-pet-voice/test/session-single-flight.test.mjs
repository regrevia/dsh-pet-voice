import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 专属会话文件指到临时目录：这里会重建会话，不能碰用户真正的绑定。
const dir = mkdtempSync(join(tmpdir(), 'pet-single-flight-'))
const petFile = join(dir, 'pet-session.json')
process.env.DSH_PET_VOICE_PET_SESSION = petFile

const { __dispatchInternals: D } = await import('../index.js')

const PET_PATH = '/tmp/pet-lab'

/** 宿主替身：list() 故意永远返回空（模拟刚建完、列表还没刷新），get() 认得磁盘上的会话。 */
function host({ createDelay = 30, pinned = null } = {}) {
  const calls = { create: [] }
  const known = new Set(pinned ? [pinned] : [])
  const ctx = {
    get: (name) => {
      if (name === 'workspaceRegistry') {
        return { list: () => [{ id: 'ws-pet', title: D.petWorkspaceName(), path: PET_PATH }] }
      }
      if (name === 'sessionController') {
        return {
          list: async () => [],
          get: async (sessionId) =>
            known.has(sessionId) ? { id: sessionId, workspaceId: 'ws-pet', cwd: PET_PATH } : null,
          create: async (request) => {
            calls.create.push(request)
            await new Promise((resolve) => setTimeout(resolve, createDelay))
            const sessionId = `session-created-${calls.create.length}`
            known.add(sessionId)
            return { sessionId }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, calls }
}

test('两条请求同时要会话，只建一只，两边拿到同一只', async () => {
  const { ctx, calls } = host()
  const [a, b] = await Promise.all([D.petTargetSession(ctx, {}), D.petTargetSession(ctx, {})])
  assert.equal(calls.create.length, 1, '并发时只该 create 一次')
  assert.equal(a.sessionId, b.sessionId, '两边必须是同一只会话')
  const stored = JSON.parse(readFileSync(petFile, 'utf8'))
  assert.equal(stored.sessionId, a.sessionId)
  assert.equal(stored.cwd, PET_PATH)
})

test('已经有钉好的会话就不再建', async () => {
  const pinned = 'session-pinned-1'
  writeFileSync(petFile, `${JSON.stringify({ workspaceId: 'ws-pet', workspaceTitle: 'Pet', cwd: PET_PATH, sessionId: pinned }, null, 2)}\n`)
  const { ctx, calls } = host({ pinned })
  const first = await D.petTargetSession(ctx, {})
  const second = await D.petTargetSession(ctx, {})
  assert.equal(calls.create.length, 0, '钉住的会话可用时一条都不该建')
  assert.equal(first.sessionId, pinned)
  assert.equal(first.sessionId, second.sessionId)
})
