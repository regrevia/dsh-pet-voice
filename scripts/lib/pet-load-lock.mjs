// 负载类脚本（bench / stress）互斥锁：两条都要往同一个安全会话里真派发，
// 同时跑会把彼此的 ack→delta 拉出 20s 级假尾（实际是排队，不是链路慢）。
// 用 pid 文件判活：持有者进程还在 → 后到的直接退出 3；进程没了 → 视为陈旧锁覆盖。
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export function acquireLoadLock(repoRoot, label) {
  const file = join(repoRoot, 'local', 'pet-load.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, label, at: Date.now() }))
      closeSync(fd)
      const release = () => { try { unlinkSync(file) } catch {} }
      process.on('exit', release)
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130) })
      return { ok: true, file }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let holder = null
      try { holder = JSON.parse(readFileSync(file, 'utf8')) } catch {}
      const alive = holder?.pid && (() => { try { process.kill(holder.pid, 0); return true } catch { return false } })()
      if (alive) {
        console.error(`✗ 另一个负载脚本正在跑（pid ${holder.pid}，${holder.label ?? '未知'}）——等它结束再跑；同时跑会互相排队，测出来的延迟是假的。`)
        return { ok: false, file, holder }
      }
      try { unlinkSync(file) } catch {}
    }
  }
  console.error('✗ 拿不到负载锁（local/pet-load.lock）')
  return { ok: false, file }
}
