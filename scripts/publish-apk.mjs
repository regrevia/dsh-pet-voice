#!/usr/bin/env node
/**
 * 发布一个 APK 到本机更新通道：
 *
 *   node scripts/publish-apk.mjs dist/jingling-0.3.0.apk --notes "修了语音唤醒"
 *
 * 干的事（按顺序）：
 *   1. 校验 APK（存在、是 zip、文件名安全）——不校验就发，等于把 404 页面推给手机；
 *   2. 读出版本号：优先命令行显式给的，其次 aapt2/aapt dump badging，最后 apktool 解包；
 *   3. 复制到发布目录（先写临时名再 rename，手机下到一半不会看到半个文件）；
 *   4. 算 sha256 + 字节数，原子写 latest.json（临时文件 + rename）。
 *
 * 为什么要 sha256：手机端下载完要校验完整性，隧道路径偶尔会被中间层缓存/截断，
 * 有 hash 才能区分「网络坏了」和「服务端发错了」。size 一起带上省一次 HEAD。
 *
 * 公开更新源默认是 GitHub Releases（`latest.json` + `<文件名>.apk` 两个资产），
 * 因为「检查更新」必须谁都能查，不能指着某台电脑。本地目录只当兜底（--dir）。
 * 目录默认 ~/.dsh/pet-voice/update，可用 --dir 或 DSH_PET_UPDATE_DIR 改（自测用）。
 * 零依赖：只用 node:fs / node:crypto / node:child_process。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPDATE_DIR = resolve(process.env.DSH_PET_UPDATE_DIR || join(homedir(), '.dsh', 'pet-voice', 'update'))
/** 公开更新源：和 App 里的 PUBLIC_META_URL 必须一致，换仓库两边一起改。 */
const GITHUB_REPO = process.env.DSH_PET_GITHUB_REPO || 'regrevia/dsh-pet-voice'
const GITHUB_BASE = `https://github.com/${GITHUB_REPO}/releases`
/** 国内镜像：cnb.cool 同名仓库，Release 附件与 GitHub 一一对应；App 先查这里，连不上才回 GitHub。 */
const CNB_REPO = process.env.DSH_PET_CNB_REPO || '2022090087/dsh-pet-voice'
const CNB_WEB = `https://cnb.cool/${CNB_REPO}/-/releases`
const CNB_API = `https://api.cnb.cool/${CNB_REPO}`
/** 固定入口：`latest` 这个 Release 只放一份 latest.json，地址永远不变。 */
const CNB_META_TAG = 'latest'
/** 和插件里的白名单保持一致：没有 `/`、不以 `.` 开头。 */
const APK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/i
const USAGE = `用法：
  node scripts/publish-apk.mjs <apk 路径> [--notes "更新说明"] [--version-code 5] [--version-name 0.3.0]

  --promote         放给用户：同步国内镜像 cnb.cool，并把「当前推广版」改成这版
  --rollback <版本>  用户可见版本退回某个已推广过的版本（如 0.9.44）
  --min-plugin <版本> 这版 App 要求的最低插件版本（App 会先提示更新插件）
  --no-github       只写本地兜底目录，不建 GitHub Release（离线/自测用）
  --dir <目录>      发布到别处（默认 ${UPDATE_DIR}）
  --version-code N  显式指定 versionCode（不给就自己读 APK）
  --version-name S  显式指定 versionName
  --notes TEXT      写进 latest.json 的更新说明，App 更新弹窗直接显示
  -h, --help        看这个

例：
  node scripts/publish-apk.mjs dist/jingling-0.3.0.apk --notes "支持本机语音识别"`

function fail(message, hint) {
  console.error(`✗ ${message}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { notes: '', versionCode: null, versionName: null, dir: UPDATE_DIR, apk: null, github: true, promote: false, minPlugin: '', rollback: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined) fail(`${arg} 后面缺参数`)
      index += 1
      return value
    }
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else if (arg === '--notes') {
      options.notes = String(next()).trim()
    } else if (arg === '--version-code') {
      const value = Number(next())
      if (!Number.isInteger(value) || value <= 0) fail(`--version-code 要正整数，收到 ${value}`)
      options.versionCode = value
    } else if (arg === '--version-name') {
      options.versionName = String(next()).trim()
      if (!options.versionName) fail('--version-name 不能为空')
    } else if (arg === '--dir') {
      options.dir = resolve(next())
    } else if (arg === '--no-github') {
      options.github = false
    } else if (arg === '--promote') {
      options.promote = true
    } else if (arg === '--min-plugin') {
      options.minPlugin = String(next()).trim()
    } else if (arg === '--rollback') {
      options.rollback = String(next()).trim()
      if (!/^\d+\.\d+\.\d+$/.test(options.rollback)) fail(`--rollback 要版本号，例如 0.9.44，收到 ${options.rollback}`)
    } else if (arg.startsWith('-')) {
      fail(`不认识的参数 ${arg}`, USAGE)
    } else if (options.apk) {
      fail(`只能发布一个 APK（已经拿到 ${options.apk}）`)
    } else {
      options.apk = arg
    }
  }
  if (options.rollback) {
    if (options.apk) fail('--rollback 不带 APK', USAGE)
    return options
  }
  if (!options.apk) fail('缺 APK 路径', USAGE)
  return options
}

// ---------------------------------------------------------------------------
// 版本号探测：aapt2 → aapt → apktool，都没有就要求显式传参
// ---------------------------------------------------------------------------

function isExecutableFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 在 PATH 里找可执行文件（不走 shell，避免引号问题）。 */
function findOnPath(name) {
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

/** 可能的 Android SDK 根目录：环境变量 → 本仓库 android/local.properties → 常见安装位置。 */
function sdkRoots() {
  const roots = []
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[key]) roots.push(process.env[key])
  }
  try {
    const props = readFileSync(join(REPO_ROOT, 'android', 'local.properties'), 'utf8')
    const match = /^sdk\.dir=(.+)$/m.exec(props)
    if (match) roots.push(match[1].trim())
  } catch {
    /* 没有 local.properties 就跳过 */
  }
  roots.push(join(homedir(), 'Library', 'Android', 'sdk'))
  roots.push('/opt/homebrew/share/android-commandlinetools')
  roots.push('/usr/local/share/android-commandlinetools')
  return roots.filter(Boolean)
}

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 在 SDK 的 build-tools/<version>/ 里找工具，取版本号最大的那个。 */
function findInBuildTools(name) {
  for (const root of sdkRoots()) {
    const buildTools = join(root, 'build-tools')
    let versions = []
    try {
      versions = readdirSync(buildTools)
    } catch {
      continue
    }
    versions.sort((a, b) => compareVersions(b, a))
    for (const version of versions) {
      const candidate = join(buildTools, version, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

function readWithAapt(tool, apkPath) {
  let output
  try {
    output = execFileSync(tool, ['dump', 'badging', apkPath], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return { ok: false, error: `${basename(tool)} 读不出来：${error?.stderr?.toString?.().trim() || error?.message || error}` }
  }
  const code = /versionCode='(\d+)'/.exec(output)
  const name = /versionName='([^']*)'/.exec(output)
  if (!code || !name) return { ok: false, error: `${basename(tool)} 输出里没有 versionCode/versionName` }
  return { ok: true, versionCode: Number(code[1]), versionName: name[1] }
}

/**
 * apktool 兜底：解出明文 AndroidManifest.xml 再正则读。
 * 比解析二进制 AXML 简单得多，而且 apktool 本来就装在开发机上。
 */
function readWithApktool(apkPath) {
  const tool = findOnPath('apktool')
  if (!tool) return { ok: false, error: '没装 apktool' }
  const workDir = join(process.env.TMPDIR || '/tmp', `pet-apk-${process.pid}-${Date.now()}`)
  try {
    execFileSync(tool, ['d', '-f', '-s', '-o', workDir, apkPath], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const manifest = readFileSync(join(workDir, 'AndroidManifest.xml'), 'utf8')
    const code = /android:versionCode="(\d+)"/.exec(manifest)
    const name = /android:versionName="([^"]*)"/.exec(manifest)
    if (!code || !name) return { ok: false, error: 'apktool 解出来的 manifest 里没有版本号' }
    return { ok: true, versionCode: Number(code[1]), versionName: name[1] }
  } catch (error) {
    return { ok: false, error: `apktool 解包失败：${error?.message ?? error}` }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响发布 */
    }
  }
}

function detectVersion(apkPath) {
  const attempts = []
  const aapt2 = process.env.AAPT2 || findInBuildTools('aapt2') || findOnPath('aapt2')
  if (aapt2) {
    const result = readWithAapt(aapt2, apkPath)
    if (result.ok) return { ...result, via: `aapt2 ${aapt2}` }
    attempts.push(result.error)
  } else {
    attempts.push('找不到 aapt2')
  }
  const aapt = process.env.AAPT || findInBuildTools('aapt') || findOnPath('aapt')
  if (aapt) {
    const result = readWithAapt(aapt, apkPath)
    if (result.ok) return { ...result, via: `aapt ${aapt}` }
    attempts.push(result.error)
  } else {
    attempts.push('找不到 aapt')
  }
  const viaApktool = readWithApktool(apkPath)
  if (viaApktool.ok) return { ...viaApktool, via: 'apktool 解包' }
  attempts.push(viaApktool.error)
  return { ok: false, error: attempts.join('；') }
}

// ---------------------------------------------------------------------------
// 文件操作
// ---------------------------------------------------------------------------

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectHash)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

/** 临时名 + rename：任何时刻 latest.json 要么是旧的完整版，要么是新的完整版。 */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 })
  renameSync(tmp, path)
}

function assertZipMagic(apkPath) {
  // 只读前 4 个字节：判断 zip 头不需要把整个 APK 拉进内存。
  const buffer = Buffer.alloc(4)
  const fd = openSync(apkPath, 'r')
  try {
    readSync(fd, buffer, 0, 4, 0)
  } finally {
    closeSync(fd)
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    fail(`${apkPath} 看起来不是 APK（zip 头不对）`, '构建失败时经常把错误页/空文件当产物，先确认文件本身')
  }
}

// ---------------------------------------------------------------------------
// GitHub Releases：用 gh CLI，仓库要提前登录（gh auth login）
// ---------------------------------------------------------------------------

function runGh(args) {
  try {
    // 30 MB 上行遇到慢网要十几分钟，超时按小时算，别让传到一半被掐。
    return execFileSync('gh', args, { encoding: 'utf8', timeout: 3_600_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    fail(
      `gh ${args.slice(0, 2).join(' ')} 失败：${String(error?.stderr ?? error?.message ?? error).trim()}`,
      '公开更新源发布不了，手机就查不到新版；确认 gh 已登录、仓库有写权限',
    )
  }
}

function hasRelease(tag) {
  try {
    execFileSync('gh', ['release', 'view', tag, '-R', GITHUB_REPO], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

function hasAsset(tag, name, size) {
  try {
    const out = execFileSync(
      'gh',
      ['release', 'view', tag, '-R', GITHUB_REPO, '--json', 'assets', '-q', `.assets[] | select(.name=="${name}") | .size`],
      { encoding: 'utf8', timeout: 30_000 },
    )
    return Number(String(out).trim()) === size
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 国内镜像：cnb.cool 同名仓库（附件上传 = 申请地址 → PUT → 确认三步）
// ---------------------------------------------------------------------------

/** 凭据：优先 CNB_TOKEN，其次系统钥匙串里 cnb.cool 的 git 密码（也是个人访问令牌）。 */
function cnbToken() {
  const fromEnv = String(process.env.CNB_TOKEN ?? '').trim()
  if (fromEnv) return fromEnv
  try {
    const out = execFileSync('git', ['credential-osxkeychain', 'get'], {
      input: 'protocol=https\nhost=cnb.cool\n\n',
      encoding: 'utf8',
      timeout: 10_000,
    })
    const line = out.split('\n').find((item) => item.startsWith('password='))
    if (line) return line.slice('password='.length).trim()
  } catch {
    /* 交给调用方报 */
  }
  return ''
}

async function cnbApi(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${CNB_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.cnb.api+json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, ok: res.ok, json }
}

/** 按 tag 找 Release，没有就建一个；返回 release id。 */
async function cnbEnsureRelease(token, tag, name, body) {
  const listed = await cnbApi(token, '/-/releases?page=1&page_size=100')
  if (!listed.ok) fail(`CNB 查 Release 失败：HTTP ${listed.status} ${JSON.stringify(listed.json)}`)
  const list = Array.isArray(listed.json) ? listed.json : (listed.json?.releases ?? [])
  const hit = list.find((item) => item.tag_name === tag)
  if (hit) return String(hit.id)
  const created = await cnbApi(token, '/-/releases', {
    method: 'POST',
    body: { tag_name: tag, name, target_commitish: 'main', body, make_latest: 'false' },
  })
  if (!created.ok || !created.json?.id) {
    fail(`CNB 建 Release ${tag} 失败：HTTP ${created.status} ${JSON.stringify(created.json)}`)
  }
  return String(created.json.id)
}

/** 附件已在且字节数一致就不重传（30 MB 重发一次就是白等）。 */
async function cnbHasAsset(token, releaseId, fileName, size) {
  const detail = await cnbApi(token, `/-/releases/${releaseId}`)
  if (!detail.ok) return false
  const assets = detail.json?.assets ?? []
  return assets.some((item) => item.name === fileName && Number(item.size) === size)
}

async function cnbUploadAsset(token, releaseId, fileName, bytes) {
  const signed = await cnbApi(token, `/-/releases/${releaseId}/asset-upload-url`, {
    method: 'POST',
    body: { asset_name: fileName, size: bytes.length, overwrite: true },
  })
  if (!signed.ok || !signed.json?.upload_url || !signed.json?.verify_url) {
    fail(`CNB 申请上传地址失败：HTTP ${signed.status} ${JSON.stringify(signed.json)}`)
  }
  const put = await fetch(signed.json.upload_url, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
    signal: AbortSignal.timeout(600_000),
  })
  if (!put.ok) fail(`CNB 上传 ${fileName} 失败：HTTP ${put.status}`)
  const confirmed = await fetch(signed.json.verify_url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.cnb.api+json' },
    signal: AbortSignal.timeout(120_000),
  })
  if (!confirmed.ok) fail(`CNB 确认上传 ${fileName} 失败：HTTP ${confirmed.status}`)
}

function cnbMetaFor({ fileName, size, sha256, versionCode, versionName, notes, minPlugin, base }) {
  return {
    versionCode,
    versionName,
    size,
    sha256,
    file: fileName,
    url: `${base}/${fileName}`,
    notes,
    ...(minPlugin ? { minPlugin } : {}),
    publishedAt: new Date().toISOString(),
  }
}

/** 改 CNB 的固定入口：这一份换了，用户「检查更新」才算看到新版。 */
async function cnbPointLatest(token, meta) {
  const metaRelease = await cnbEnsureRelease(token, CNB_META_TAG, CNB_META_TAG, '检查更新入口')
  await cnbUploadAsset(token, metaRelease, 'latest.json', Buffer.from(`${JSON.stringify(meta, null, 2)}\n`))
  console.log(`✓ 检查更新地址 → ${CNB_WEB}/download/${CNB_META_TAG}/latest.json`)
}

/** 推广记录进仓库（update/latest.json）：App 在 CNB 不可达时用 jsDelivr/raw 读同一份。 */
function writePromotionRecord(githubMeta, versionName) {
  const file = join(REPO_ROOT, 'update', 'latest.json')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeJsonAtomic(file, { ...githubMeta, promotedAt: new Date().toISOString() })
  try {
    execFileSync('git', ['add', 'update/latest.json'], { cwd: REPO_ROOT, stdio: 'ignore', timeout: 60_000 })
    execFileSync('git', ['commit', '-m', `推广 ${versionName}`, '--no-verify'], { cwd: REPO_ROOT, stdio: 'ignore', timeout: 120_000 })
  } catch {
    console.warn('⚠ 推广记录没有新提交（内容没变或 git 失败），继续')
  }
  try {
    execFileSync('git', ['push', 'origin', 'main'], { cwd: REPO_ROOT, stdio: 'ignore', timeout: 300_000 })
    console.log('✓ 推广记录已推送 → update/latest.json')
  } catch {
    console.warn('⚠ update/latest.json 没推上去：CNB 那条通道仍然有效，GitHub 兜底查不到这版')
  }
}

/** 放给用户：CNB 传包 + 每版自带一份 meta（回滚要用）+ 换固定入口 + 改仓库里的推广记录。 */
async function promote({ apkPath, fileName, size, sha256, versionCode, versionName, notes, minPlugin, github }) {
  const token = cnbToken()
  if (!token) {
    fail('没有 CNB 凭据，放不出去', 'CNB_TOKEN=... 或确认 git credential 里有 cnb.cool 的密码')
  }
  const tag = `v${versionName}`
  const releaseId = await cnbEnsureRelease(token, tag, `鲸灵 ${versionName}`, notes || `鲸灵 ${versionName}`)
  if (await cnbHasAsset(token, releaseId, fileName, size)) {
    console.log(`· 国内镜像 ${tag} 已有同名同大小附件，跳过重传`)
  } else {
    console.log(`· 同步国内镜像 ${CNB_REPO} ${tag}（cnb.cool 比 GitHub 快得多，几秒就好）`)
    await cnbUploadAsset(token, releaseId, fileName, readFileSync(apkPath))
  }
  const cnbMeta = cnbMetaFor({ fileName, size, sha256, versionCode, versionName, notes, minPlugin, base: `${CNB_WEB}/download/${tag}` })
  // 每版 Release 自己留一份 meta：--rollback 直接取回来，不依赖本机缓存。
  await cnbUploadAsset(token, releaseId, 'latest.json', Buffer.from(`${JSON.stringify(cnbMeta, null, 2)}\n`))
  await cnbPointLatest(token, cnbMeta)
  if (github) {
    // 本机这份兜底 meta 是 App 走宿主 /pet-voice/api/update 时读的，它里面的 url 就是
    // 用户真正下载的地址。国内直连 GitHub Release 经常几十 KB/s，所以这里跟公开通道
    // 一样指 CNB（公开 release，免登录）。GitHub 只当存档，不再写进 url。
    writePromotionRecord(cnbMeta, versionName)
  }
  console.log(`✓ 用户现在能看到 ${versionName} → ${cnbMeta.url}`)
}

/** 回滚：把固定入口指回某个已推广过的版本；那版的 meta 存在它自己的 Release 里。 */
async function rollback(versionName) {
  const token = cnbToken()
  if (!token) fail('没有 CNB 凭据，退不回去', 'CNB_TOKEN=... 或确认 git credential 里有 cnb.cool 的密码')
  const tag = `v${versionName}`
  const res = await fetch(`${CNB_WEB}/download/${tag}/latest.json`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    fail(`CNB 上没有 ${tag} 的推广记录（HTTP ${res.status}）`, '只能退回推广过的版本；第一次推广之前没有记录')
  }
  const old = JSON.parse(await res.text())
  const cnbMeta = { ...old, url: `${CNB_WEB}/download/${tag}/${old.file}` }
  await cnbPointLatest(token, cnbMeta)
  writePromotionRecord(cnbMeta, versionName)
  console.log(`✓ 用户可见版本退回 ${versionName}（versionCode ${old.versionCode}）`)
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.rollback) {
    await rollback(options.rollback)
    return
  }
  const apkPath = resolve(options.apk)
  if (!existsSync(apkPath)) fail(`找不到 APK：${apkPath}`)
  const stat = statSync(apkPath)
  if (!stat.isFile()) fail(`${apkPath} 不是文件`)
  assertZipMagic(apkPath)

  const fileName = basename(apkPath)
  if (!APK_NAME_RE.test(fileName)) {
    fail(`文件名不合法：${fileName}`, '只允许字母数字开头、由 [A-Za-z0-9._-] 组成、以 .apk 结尾（下载路由按这个白名单校验）')
  }

  let versionCode = options.versionCode
  let versionName = options.versionName
  let via = '命令行参数'
  if (!versionCode || !versionName) {
    const detected = detectVersion(apkPath)
    if (!detected.ok) {
      fail(
        '读不出 APK 的 versionCode/versionName',
        `试过 aapt2/aapt/apktool 都不行：${detected.error}\n` +
          '  直接显式传：--version-code 5 --version-name 0.3.0（App 拿 versionCode 比大小，必须比线上大）',
      )
    }
    if (!versionCode) versionCode = detected.versionCode
    if (!versionName) versionName = detected.versionName
    if (!options.versionCode && !options.versionName) via = detected.via
  }
  if (!Number.isInteger(versionCode) || versionCode <= 0) fail(`versionCode 不合法：${versionCode}`)
  if (!versionName) fail('versionName 为空')

  // 文件名里的版本号对不上时提醒一句：拼错会让用户装到「显示 0.3.0 实际 0.2.9」的包。
  if (!fileName.includes(versionName)) {
    console.warn(`⚠ 文件名 ${fileName} 里没有 versionName ${versionName}，确认不是拿错包了`)
  }

  mkdirSync(options.dir, { recursive: true, mode: 0o700 })
  const targetPath = join(options.dir, fileName)
  const sha256 = await sha256File(apkPath)
  const size = stat.size

  // 宿主兜底目录（~/.dsh/pet-voice/update）只跟「推广」走：没推广的版本在哪儿都拿不到，
  // 连自己绑定的设备也一样。否则存档就等于对自家设备提前放版。
  // --no-github（离线自测）没有别的出口，才退回只写本地目录。
  const localFallback = options.promote || !options.github
  let copied = false
  let same = false
  if (localFallback) {
    try {
      same = statSync(targetPath).size === size && (await sha256File(targetPath)) === sha256
    } catch {
      same = false
    }
    if (!same) {
      // 先写临时名再 rename：手机正在下载时重发同一版，不会看到被截断的文件。
      const tmp = `${targetPath}.tmp-${process.pid}`
      copyFileSync(apkPath, tmp)
      renameSync(tmp, targetPath)
      copied = true
    }
  }

  const meta = {
    ok: true,
    versionCode,
    versionName,
    size,
    sha256,
    file: fileName,
    notes: options.notes,
    ...(options.minPlugin ? { minPlugin: options.minPlugin } : {}),
    publishedAt: new Date().toISOString(),
  }
  if (localFallback) writeJsonAtomic(join(options.dir, 'latest.json'), meta)

  console.log(`✓ 版本 ${versionName}（versionCode ${versionCode}）${via ? `· 来源 ${via}` : ''}`)
  if (localFallback) {
    console.log(copied ? `✓ 已复制 → ${targetPath}` : `✓ 已在发布目录（内容一致，跳过复制）→ ${targetPath}`)
  }
  console.log(`✓ ${size} B · sha256 ${sha256}`)
  if (localFallback) console.log(`✓ 本地兜底 latest.json → ${join(options.dir, 'latest.json')}`)

  if (options.github) {
    const tag = `v${versionName}`
    const assetUrl = `${GITHUB_BASE}/download/${tag}/${fileName}`
    const githubMeta = { ...meta, url: assetUrl, publishedAt: meta.publishedAt }
    console.log(`· 存档到 GitHub ${GITHUB_REPO} ${tag}（30 MB 左右，慢是正常的；这一步用户还看不到）`)
    // 先建草稿再传：上传的几分钟里 /releases/latest 不会指向「资产还没齐」的版本（那会让 App 拿到 404）。
    if (!hasRelease(tag)) {
      runGh(['release', 'create', tag, '-R', GITHUB_REPO, '-t', `鲸灵 ${versionName}`, '-n', options.notes || `鲸灵 ${versionName}`, '--draft'])
    }
    if (!hasAsset(tag, fileName, size)) {
      runGh(['release', 'upload', tag, apkPath, '--clobber', '-R', GITHUB_REPO])
    }
    const githubMetaPath = join(options.dir, 'latest.json')
    writeJsonAtomic(githubMetaPath, githubMeta)
    runGh(['release', 'upload', tag, githubMetaPath, '--clobber', '-R', GITHUB_REPO])
    try {
      runGh(['release', 'edit', tag, '-R', GITHUB_REPO, '--draft=false'])
    } catch {
      console.warn('⚠ 切成正式 Release 失败（可能已经是正式的了），继续')
    }
    mkdirSync(join(REPO_ROOT, 'dist', 'mirror', 'github'), { recursive: true, mode: 0o700 })
    writeJsonAtomic(join(REPO_ROOT, 'dist', 'mirror', 'github', 'latest.json'), githubMeta)
    console.log(`✓ GitHub 存档 → ${assetUrl}`)
  }

  if (options.promote) {
    await promote({
      apkPath,
      fileName,
      size,
      sha256,
      versionCode,
      versionName,
      notes: options.notes,
      minPlugin: options.minPlugin,
      github: options.github,
    })
  } else {
    console.log('· 用户还看不到这版；要放出去再跑一次同一条命令加 --promote')
  }
}

main().catch((error) => {
  fail(`发布失败：${error?.stack ?? error}`)
})
