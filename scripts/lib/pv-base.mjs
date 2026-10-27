// 找准宿主 /pet-voice 的地址（Node 版，和 scripts/lib/pv-base.sh 同一套判据）。
//
// 端口每次启动都可能变，写死就会静默探到 000、把「测不到」当成「很快」。
// 查找顺序：$PV_BASE → $PV_PORT → ~/.dsh/pet-voice/host-port.json（插件挂载时写的）
//          → 本机监听端口挨个试。
// 判据：带令牌能拿到含 versionCode 的 JSON。不用 /api/state：它要汇总项目跟会话，
// 冷启动能到 4s，超时就误认成别的服务。

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME_DIR = join(homedir(), '.dsh', 'pet-voice')
const PORT_FILE = process.env.DSH_PET_PORT_FILE || join(HOME_DIR, 'host-port.json')
const TOKEN_FILE = join(HOME_DIR, 'token')
const DEVICES_FILE = join(HOME_DIR, 'devices.json')

function token() {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

function cookieHeader() {
  const tok = token()
  const headers = tok ? { Cookie: `pkv_${tok.slice(0, 8)}=${tok}` } : {}
  // 一定要用一个「已登记」的设备 id：插件对自报 id 的设备才执行「最多 N 台」，
  // 没登记的本机请求会被当成新设备挡成 429，响应里没有 versionCode，
  // 于是每个端口都判成「不是宿主」，脚本静默退回写死的旧端口。
  const dev = knownDeviceId()
  if (dev) headers['x-pet-device-id'] = dev
  return headers
}

function knownDeviceId() {
  try {
    const store = JSON.parse(readFileSync(DEVICES_FILE, 'utf8'))
    const rows = (Array.isArray(store?.devices) ? store.devices : []).filter((d) => d?.id)
    rows.sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0))
    return rows[0]?.id ?? ''
  } catch {
    return ''
  }
}

function listeningPorts() {
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const ports = out
      .split('\n')
      .slice(1)
      .map((line) => (line.match(/:(\d+)\s+\(LISTEN\)$/) ?? [])[1])
      .filter(Boolean)
    return [...new Set(ports)]
  } catch {
    return []
  }
}

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/pet-voice/api/update`, {
      headers: cookieHeader(),
      signal: AbortSignal.timeout(1500),
    })
    const body = await res.text()
    return body.includes('"versionCode"')
  } catch {
    return false
  }
}

/**
 * 探到之后自己写缓存：插件那份要等热重载才生效，脚本不该跟着等。
 * 失败静默——缓存只是加速，不是唯一来源。
 */
function cachePort(port) {
  try {
    writeFileSync(
      PORT_FILE,
      `${JSON.stringify({ port: String(port), origin: `http://127.0.0.1:${port}`, at: new Date().toISOString(), by: 'pv-base.mjs' }, null, 2)}\n`,
      { mode: 0o600 },
    )
  } catch {
    /* 写不了就算了 */
  }
}

/** 返回 `http://127.0.0.1:<port>`（不带 /pet-voice），找不到抛错。 */
export async function resolveOrigin() {
  const explicit = String(process.env.PV_BASE || '').replace(/\/$/, '')
  if (explicit) return explicit.replace(/\/pet-voice$/, '')
  const pvPort = String(process.env.PV_PORT || '').trim()
  if (pvPort) return `http://127.0.0.1:${pvPort}`

  // 缓存一律验活再信：DSH 重启后端口会变，旧缓存会把人指到死端口上，
  // 而「探到了但静默失败」比「探不到」更难查。
  if (existsSync(PORT_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(PORT_FILE, 'utf8'))
      if (saved?.port && (await probe(saved.port))) return `http://127.0.0.1:${saved.port}`
    } catch {
      /* 文件坏了或端口已换：继续挨个探 */
    }
  }

  for (const port of ['54013', '52356', ...listeningPorts()]) {
    if (await probe(port)) {
      cachePort(port)
      return `http://127.0.0.1:${port}`
    }
  }
  throw new Error(
    '找不到在跑的 DSH Web（带令牌请求 /pet-voice/api/update 都没拿到 versionCode）：先确认 DSH 开着、插件已启用',
  )
}

/** 返回 `http://127.0.0.1:<port>/pet-voice`。 */
export async function resolvePetBase() {
  return `${await resolveOrigin()}/pet-voice`
}

/** 供脚本直接打印用：`node scripts/lib/pv-base.mjs` */
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(await resolvePetBase())
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
