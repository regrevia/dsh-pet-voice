import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __uploadInternals } from '../index.js'

const { extFor, uploadDir, saveUpload, composeDispatchText, normalizeAttachments, MAX_UPLOAD_BYTES } =
  __uploadInternals

/** 一张最小的假 PNG（只验字节搬运，不解码）。 */
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640806000000', 'hex')

const tempBase = () => mkdtempSync(join(tmpdir(), 'pet-upload-'))

test('content-type 决定扩展名，只认四种图片', () => {
  assert.equal(extFor('image/jpeg'), 'jpg')
  assert.equal(extFor('image/png'), 'png')
  assert.equal(extFor('image/webp'), 'webp')
  assert.equal(extFor('image/gif'), 'gif')
  // 参数、大小写、前后空格都要吃掉
  assert.equal(extFor('IMAGE/PNG; charset=binary'), 'png')
  assert.equal(extFor('  image/jpeg  '), 'jpg')
  // 白名单之外一律空串（调用方据此回 415）
  assert.equal(extFor('text/plain'), '')
  assert.equal(extFor('image/svg+xml'), '')
  assert.equal(extFor(undefined), '')
})

test('上传上限是 12 MiB', () => {
  assert.equal(MAX_UPLOAD_BYTES, 12 * 1024 * 1024)
})

test('超限返回 413，不落盘', () => {
  const base = tempBase()
  try {
    const out = saveUpload(base, 'image/png', Buffer.alloc(MAX_UPLOAD_BYTES + 1))
    assert.equal(out.ok, false)
    assert.equal(out.status, 413)
    assert.match(out.error, /太大/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('类型不对返回 415，不建目录', () => {
  const base = tempBase()
  try {
    const out = saveUpload(base, 'application/pdf', PNG)
    assert.equal(out.ok, false)
    assert.equal(out.status, 415)
    assert.equal(existsSync(join(base, '.pet-uploads')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('落盘内容与请求字节一致，目录与文件名符合约定', () => {
  const base = tempBase()
  try {
    const out = saveUpload(base, 'image/png', PNG)
    assert.equal(out.ok, true)
    assert.equal(out.bytes, PNG.length)
    assert.equal(uploadDir(base), join(base, '.pet-uploads'))
    assert.equal(out.path, join(base, '.pet-uploads', out.name))
    assert.match(out.name, /^\d{8}-\d{6}-[0-9a-f]{6}\.png$/)
    assert.deepEqual(readFileSync(out.path), PNG)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('连传两张不撞名，?name= 只当可读前缀', () => {
  const base = tempBase()
  try {
    const first = saveUpload(base, 'image/png', PNG)
    const second = saveUpload(base, 'image/png', PNG)
    assert.notEqual(first.name, second.name)
    // 目录穿越 / 空格 / 扩展名都别想进文件名，中文字符保留
    const hint = saveUpload(base, 'image/png', PNG, { name: '../../猫 照片.exe' })
    assert.match(hint.name, /^猫-照片-\d{8}-\d{6}-[0-9a-f]{6}\.png$/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('项目目录不可写时退到 fallbackDir，成功路径不丢', () => {
  const base = tempBase()
  const fallback = tempBase()
  try {
    chmodSync(base, 0o500) // 只读：mkdir 必然 EACCES
    const out = saveUpload(base, 'image/png', PNG, { fallbackDir: fallback })
    assert.equal(out.ok, true)
    assert.equal(out.path, join(fallback, out.name))
    assert.deepEqual(readFileSync(out.path), PNG)
  } finally {
    chmodSync(base, 0o700)
    rmSync(base, { recursive: true, force: true })
    rmSync(fallback, { recursive: true, force: true })
  }
})

test('项目是 git 仓库：.pet-uploads 写进本地 exclude，且不重复', () => {
  const base = tempBase()
  try {
    mkdirSync(join(base, '.git', 'info'), { recursive: true })
    writeFileSync(join(base, '.git', 'info', 'exclude'), '# 已有内容\n*.log\n')
    saveUpload(base, 'image/png', PNG)
    saveUpload(base, 'image/png', PNG)
    const text = readFileSync(join(base, '.git', 'info', 'exclude'), 'utf8')
    assert.match(text, /^# 已有内容$/m)
    assert.match(text, /^\*\.log$/m)
    // 只写一次，别每次上传都往用户文件里追加一行
    assert.equal(text.split(/\r?\n/).filter((row) => row.trim() === '.pet-uploads/').length, 1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('worktree：.git 是文件时顺着 gitdir 写到真正的 git 目录', () => {
  const base = tempBase()
  const realGit = tempBase()
  try {
    writeFileSync(join(base, '.git'), `gitdir: ${realGit}\n`)
    saveUpload(base, 'image/png', PNG)
    assert.match(readFileSync(join(realGit, 'info', 'exclude'), 'utf8'), /^\.pet-uploads\/$/m)
    assert.equal(existsSync(join(base, '.git', 'info')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(realGit, { recursive: true, force: true })
  }
})

test('不是仓库：不建 .git，不写文件，图片照常落盘', () => {
  const base = tempBase()
  try {
    const out = saveUpload(base, 'image/png', PNG)
    assert.equal(out.ok, true)
    assert.equal(existsSync(join(base, '.git')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('composeDispatchText：无附件原样返回，有附件逐行追加', () => {
  assert.equal(composeDispatchText('看看这个', []), '看看这个')
  assert.equal(composeDispatchText('看看这个'), '看看这个')
  assert.equal(composeDispatchText('看看这个', ['/tmp/a.png']), '看看这个\n\n[图片] /tmp/a.png')
  assert.equal(
    composeDispatchText('看看', ['/tmp/a.png', '/tmp/b.jpg']),
    '看看\n\n[图片] /tmp/a.png\n[图片] /tmp/b.jpg',
  )
  // 空正文时不留前导空行
  assert.equal(composeDispatchText('', ['/tmp/a.png']), '[图片] /tmp/a.png')
})

test('normalizeAttachments：相对路径/不存在/超 6 张一律拒绝', () => {
  const base = tempBase()
  try {
    const file = join(base, 'a.png')
    writeFileSync(file, PNG)
    assert.deepEqual(normalizeAttachments(undefined), { ok: true, paths: [] })
    assert.deepEqual(normalizeAttachments([file, { path: file, name: 'a.png' }]), {
      ok: true,
      paths: [file, file],
    })
    assert.equal(normalizeAttachments(['relative/a.png']).ok, false)
    assert.equal(normalizeAttachments([join(base, 'missing.png')]).ok, false)
    assert.equal(normalizeAttachments(new Array(7).fill(file)).ok, false)
    assert.equal(normalizeAttachments('not-an-array').ok, false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
