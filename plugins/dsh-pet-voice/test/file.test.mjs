import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __fileInternals } from '../index.js'

const { imageContentType, readImageFile, handleFile, MAX_IMAGE_BYTES } = __fileInternals

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640806000000', 'hex')

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pet-file-'))
  return dir
}

test('扩展名白名单：只认 jpg/jpeg/png/webp/gif，大小写都吃', () => {
  assert.equal(imageContentType('/a/b.png'), 'image/png')
  assert.equal(imageContentType('/a/b.JPG'), 'image/jpeg')
  assert.equal(imageContentType('/a/b.jpeg'), 'image/jpeg')
  assert.equal(imageContentType('/a/b.webp'), 'image/webp')
  assert.equal(imageContentType('/a/b.gif'), 'image/gif')
  assert.equal(imageContentType('/a/b.txt'), '')
  assert.equal(imageContentType('/a/b.svg'), '')
  assert.equal(imageContentType('/a/b'), '')
  assert.equal(MAX_IMAGE_BYTES, 12 * 1024 * 1024)
})

test('正常读字节：content-type 与内容一致，中文+空格路径也能读', () => {
  const dir = tempDir()
  try {
    const file = join(dir, '鲸灵 图 1.png')
    writeFileSync(file, PNG)
    const out = readImageFile(file)
    assert.equal(out.ok, true)
    assert.equal(out.type, 'image/png')
    assert.equal(out.bytes, PNG.length)
    assert.deepEqual(out.body, PNG)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不存在的图 → 404；非图片 → 415；相对路径 / 穿越 → 400', () => {
  const dir = tempDir()
  try {
    const missing = readImageFile(join(dir, 'nope.png'))
    assert.equal(missing.ok, false)
    assert.equal(missing.status, 404)

    const txt = join(dir, 'a.txt')
    writeFileSync(txt, 'x')
    const wrong = readImageFile(txt)
    assert.equal(wrong.ok, false)
    assert.equal(wrong.status, 415)

    const rel = readImageFile('relative/pic.png')
    assert.equal(rel.ok, false)
    assert.equal(rel.status, 400)

    const up = readImageFile(`${dir}/../pic.png`)
    assert.equal(up.ok, false)
    assert.equal(up.status, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超 12 MB → 413；目录冒充图片 → 404', () => {
  const dir = tempDir()
  try {
    const big = join(dir, 'big.png')
    // 直接写 12 MiB + 1 字节：一次分配的临时 buffer，用例结束即释放。
    writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1))
    const out = readImageFile(big)
    assert.equal(out.ok, false)
    assert.equal(out.status, 413)

    const sub = join(dir, 'folder.png')
    mkdirSync(sub)
    const dirOut = readImageFile(sub)
    assert.equal(dirOut.ok, false)
    assert.equal(dirOut.status, 404)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP 层：GET 回字节与缓存头，HEAD 只回头不回 body', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'shot gif.gif')
    writeFileSync(file, PNG)
    const calls = []
    const makeRes = () => ({
      writeHead(status, headers) {
        calls.push({ status, headers })
      },
      end(body) {
        calls[calls.length - 1].body = body
      },
    })
    const url = new URL(`http://localhost/pet-voice/api/file?path=${encodeURIComponent(file)}`)

    handleFile({ method: 'GET' }, makeRes(), url)
    const got = calls.pop()
    assert.equal(got.status, 200)
    assert.equal(got.headers['content-type'], 'image/gif')
    assert.equal(got.headers['content-length'], PNG.length)
    assert.equal(got.headers['cache-control'], 'private, max-age=600')
    assert.deepEqual(Buffer.from(got.body), PNG)

    handleFile({ method: 'HEAD' }, makeRes(), url)
    const head = calls.pop()
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-length'], PNG.length)
    assert.equal(head.body, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
