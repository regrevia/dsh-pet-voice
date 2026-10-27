// 访问 token 的存取：生成、读、换新，以及「文件被误删时先从备份找回」。
// 抽成独立模块是为了能在临时 HOME 下跑单测（test/token.test.mjs），不碰真机配对。
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIN_LEN = 16

export function createTokenStore({ homeDir, log = () => {} }) {
  const tokenPath = join(homeDir, 'token')
  const bakPath = join(homeDir, 'token.bak')
  let cache = { value: '', mtimeMs: -1 }
  let bakChecked = false

  /** 把当前生效的 token 镜像到 token.bak；内容相同就不写盘，写失败不影响鉴权。 */
  function mirror(value) {
    if (!value || value.length < MIN_LEN) return
    try {
      if (readFileSync(bakPath, 'utf8').trim() === value) return
    } catch {
      /* 没有备份就写一份 */
    }
    try {
      mkdirSync(homeDir, { recursive: true, mode: 0o700 })
      writeFileSync(bakPath, `${value}\n`, { mode: 0o600 })
      chmodSync(bakPath, 0o600)
    } catch {
      /* 只读文件系统等情况：备份失败不阻断鉴权 */
    }
  }

  function persist(value) {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 })
    writeFileSync(tokenPath, `${value}\n`, { mode: 0o600 })
    try {
      chmodSync(tokenPath, 0o600)
    } catch {
      /* Windows 上 chmod 不可用，忽略 */
    }
  }

  function ensure() {
    try {
      const existing = readFileSync(tokenPath, 'utf8').trim()
      if (existing.length >= MIN_LEN) {
        mirror(existing)
        return existing
      }
    } catch {
      /* 不存在就创建 */
    }
    // token 文件被删（清理旧文件、还原备份、误 rm）时先找上一次的，别默默换密码：
    // 一旦换掉，手机上的配对全部失效，用户得重新扫码。
    try {
      const backup = readFileSync(bakPath, 'utf8').trim()
      if (backup.length >= MIN_LEN) {
        persist(backup)
        log(`token 文件缺失，已从备份恢复：${tokenPath}（已配对的手机不受影响）`)
        return backup
      }
    } catch {
      /* 没备份就按首次启动处理 */
    }
    const token = randomBytes(24).toString('hex')
    persist(token)
    mirror(token)
    log(`已生成访问 token：${tokenPath}`)
    return token
  }

  /**
   * 当前生效的 token。每次请求 stat 一次文件：删掉 token 文件就等于「换密码」，
   * 下一个请求会重建（有备份则恢复原值）并立即生效，不需要重启 App。
   */
  function current() {
    let stat
    try {
      stat = statSync(tokenPath)
    } catch {
      cache = { value: ensure(), mtimeMs: -1 }
      return cache.value
    }
    if (cache.value && cache.mtimeMs === stat.mtimeMs) {
      // 热加载后第一次命中缓存时补一次镜像，保证删掉 token 时一定找得回来
      if (!bakChecked) {
        bakChecked = true
        mirror(cache.value)
      }
      return cache.value
    }
    const value = readFileSync(tokenPath, 'utf8').trim()
    if (value.length < MIN_LEN) {
      cache = { value: ensure(), mtimeMs: -1 }
    } else {
      cache = { value, mtimeMs: stat.mtimeMs }
      mirror(value)
      log(`token 已重新加载：${tokenPath}`)
    }
    return cache.value
  }

  /** 换新令牌：旧 cookie 与旧配对链接立刻作废，手机要重新扫码。 */
  function rotate() {
    const token = randomBytes(24).toString('hex')
    persist(token)
    cache = { value: token, mtimeMs: -1 }
    mirror(token)
    log(`已换新访问 token：${tokenPath}`)
    return token
  }

  return { tokenPath, bakPath, ensure, current, rotate }
}
