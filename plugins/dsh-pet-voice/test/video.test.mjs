import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'

import { __fileInternals, __uploadInternals } from '../index.js'

const {
  extFor,
  kindForExt,
  kindForType,
  sniffUploadKind,
  uploadLimitFor,
  saveUpload,
  attachmentMark,
  composeDispatchText,
  normalizeAttachments,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_BYTES,
} = __uploadInternals
const { imageContentType, fileTypeFor, checkMediaPath, handleFile, readImageFile } = __fileInternals

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000640806000000', 'hex')
/** 最小可用 mp4 头：box size + 'ftyp' + brand 'isom'，后面填点负载。 */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(64, 0x01),
])

const tempDir = () => mkdtempSync(join(tmpdir(), 'pet-video-'))

test('content-type：三种视频都认，扩展名由类型决定', () => {
  assert.equal(extFor('video/mp4'), 'mp4')
  assert.equal(extFor('video/quicktime'), 'mov')
  assert.equal(extFor('video/x-m4v'), 'm4v')
  assert.equal(extFor('VIDEO/MP4; codecs=avc1'), 'mp4')
  assert.equal(kindForType('video/mp4'), 'video')
  assert.equal(kindForType('image/png'), 'image')
  assert.equal(kindForType('application/octet-stream'), '')
  assert.equal(kindForExt('mov'), 'video')
  assert.equal(kindForExt('jpg'), 'image')
})

test('上限分档：图片 12 MB，视频 200 MB', () => {
  assert.equal(uploadLimitFor('image'), MAX_UPLOAD_BYTES)
  assert.equal(uploadLimitFor('video'), MAX_VIDEO_BYTES)
  assert.equal(MAX_VIDEO_BYTES, 200 * 1024 * 1024)
})

test('文件头嗅探：分得清图片/视频/垃圾', () => {
  assert.equal(sniffUploadKind(PNG), 'image')
  // 太短的 buffer 认不出（< 12 字节一律当垃圾，别靠猜）
  assert.equal(sniffUploadKind(Buffer.from('89504e470d0a1a0a', 'hex')), '')
  assert.equal(sniffUploadKind(Buffer.from('GIF89a0000000000', 'latin1')), 'image')
  assert.equal(sniffUploadKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)])), 'image')
  assert.equal(sniffUploadKind(MP4), 'video')
  assert.equal(sniffUploadKind(Buffer.from('{"not":"a video"}', 'latin1')), '')
  assert.equal(sniffUploadKind(Buffer.alloc(0)), '')
})

test('视频落盘：扩展名、kind、字节都对得上', () => {
  const base = tempDir()
  try {
    const out = saveUpload(base, 'video/mp4', MP4)
    assert.equal(out.ok, true)
    assert.equal(out.kind, 'video')
    assert.match(out.name, /\.mp4$/)
    assert.equal(out.bytes, MP4.length)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('13 MB 视频照收（图片那条 12 MB 线不误伤视频）', () => {
  const base = tempDir()
  try {
    const big = Buffer.concat([MP4, Buffer.alloc(13 * 1024 * 1024)])
    const out = saveUpload(base, 'video/quicktime', big)
    assert.equal(out.ok, true)
    assert.equal(out.kind, 'video')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('声明成视频、内容却是图片 → 415 内容与类型对不上', () => {
  const base = tempDir()
  try {
    const out = saveUpload(base, 'video/mp4', PNG)
    assert.equal(out.ok, false)
    assert.equal(out.status, 415)
    assert.match(out.error, /对不上/)
    // 反过来也一样
    const back = saveUpload(base, 'image/png', MP4)
    assert.equal(back.ok, false)
    assert.equal(back.status, 415)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('附件行标记：视频 [视频]，图片 [图片]', () => {
  assert.equal(attachmentMark('/tmp/a.mp4'), '[视频]')
  assert.equal(attachmentMark('/tmp/a.MOV'), '[视频]')
  assert.equal(attachmentMark('/tmp/a.png'), '[图片]')
  assert.equal(
    composeDispatchText('看这两个', ['/tmp/a.png', '/tmp/b.mov']),
    '看这两个\n\n![图片](/tmp/a.png)\n[视频] /tmp/b.mov',
  )
})

test('attachments 文案统一说「附件」，仍限 6 条', () => {
  const base = tempDir()
  try {
    const file = join(base, 'a.png')
    writeFileSync(file, PNG)
    assert.match(normalizeAttachments(new Array(7).fill(file)).error, /最多带 6 个附件/)
    assert.match(normalizeAttachments(['relative/a.png']).error, /附件路径必须是绝对路径/)
    assert.match(normalizeAttachments([join(base, 'missing.png')]).error, /附件不存在/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('file 路由认视频 MIME，图片白名单只回图片', () => {
  assert.deepEqual(fileTypeFor('/v/a.mp4'), { type: 'video/mp4', kind: 'video' })
  assert.deepEqual(fileTypeFor('/v/a.MOV'), { type: 'video/quicktime', kind: 'video' })
  assert.deepEqual(fileTypeFor('/v/a.m4v'), { type: 'video/x-m4v', kind: 'video' })
  assert.equal(imageContentType('/v/a.mp4'), '')
  assert.equal(fileTypeFor('/v/a.txt'), null)
})

test('checkMediaPath：视频按 200 MB 放行，图片仍 12 MB', () => {
  const dir = tempDir()
  try {
    const video = join(dir, 'a.mp4')
    writeFileSync(video, MP4)
    const ok = checkMediaPath(video)
    assert.equal(ok.ok, true)
    assert.equal(ok.kind, 'video')
    assert.equal(ok.type, 'video/mp4')
    assert.equal(ok.size, MP4.length)

    // 视频不能走图片那条读字节的路：readImageFile 必须直接拒
    const asImage = readImageFile(video)
    assert.equal(asImage.ok, false)
    assert.equal(asImage.status, 415)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 收集写出的字节，模拟 ServerResponse（writeHead/end/write 都要有）。 */
function makeRes() {
  const calls = []
  const chunks = []
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  })
  res.writeHead = (status, headers) => calls.push({ status, headers })
  const end = res.end.bind(res)
  res.end = (body, ...rest) => {
    if (body && typeof body !== 'function') chunks.push(Buffer.from(body))
    return end(...rest)
  }
  res.calls = calls
  res.chunks = chunks
  return res
}

const fileUrl = (path) => new URL(`http://localhost/pet-voice/api/file?path=${encodeURIComponent(path)}`)

test('Range：206 + Content-Range + 切片字节，HEAD 也有头', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'clip.mp4')
    writeFileSync(file, MP4)
    const res = makeRes()
    handleFile({ method: 'GET', headers: { range: 'bytes=4-11' } }, res, fileUrl(file))
    const got = res.calls[0]
    assert.equal(got.status, 206)
    assert.equal(got.headers['content-type'], 'video/mp4')
    assert.equal(got.headers['accept-ranges'], 'bytes')
    assert.equal(got.headers['content-length'], 8)
    assert.equal(got.headers['content-range'], `bytes 4-11/${MP4.length}`)
    assert.deepEqual(Buffer.concat(res.chunks), MP4.subarray(4, 12))

    const head = makeRes()
    handleFile({ method: 'HEAD', headers: { range: 'bytes=0-3' } }, head, fileUrl(file))
    assert.equal(head.calls[0].status, 206)
    assert.equal(head.calls[0].headers['content-range'], `bytes 0-3/${MP4.length}`)
    assert.equal(head.chunks.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Range：后缀 bytes=-8 / 越界 416 / 不认的写法回 200', async () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'clip.mov')
    writeFileSync(file, MP4)

    const suffix = makeRes()
    handleFile({ method: 'GET', headers: { range: 'bytes=-8' } }, suffix, fileUrl(file))
    assert.equal(suffix.calls[0].status, 206)
    assert.equal(suffix.calls[0].headers['content-range'], `bytes ${MP4.length - 8}-${MP4.length - 1}/${MP4.length}`)

    const over = makeRes()
    handleFile({ method: 'GET', headers: { range: `bytes=${MP4.length + 10}-` } }, over, fileUrl(file))
    assert.equal(over.calls[0].status, 416)
    assert.equal(over.calls[0].headers?.['content-range'], `bytes */${MP4.length}`)

    const multi = makeRes()
    handleFile({ method: 'GET', headers: { range: 'bytes=0-1,5-6' } }, multi, fileUrl(file))
    assert.equal(multi.calls[0].status, 200)
    assert.equal(multi.calls[0].headers['content-length'], MP4.length)
    // 整份视频走流：等流写完再删临时目录，否则会打出无谓的 ENOENT 日志
    if (!multi.writableFinished) await new Promise((done) => multi.once('finish', done))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HEAD 整份：content-length / accept-ranges 齐全，不回 body', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'clip.m4v')
    writeFileSync(file, MP4)
    const res = makeRes()
    handleFile({ method: 'HEAD' }, res, fileUrl(file))
    assert.equal(res.calls[0].status, 200)
    assert.equal(res.calls[0].headers['content-type'], 'video/x-m4v')
    assert.equal(res.calls[0].headers['content-length'], MP4.length)
    assert.equal(res.calls[0].headers['accept-ranges'], 'bytes')
    assert.equal(res.chunks.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
