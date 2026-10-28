import assert from 'node:assert/strict'
import test from 'node:test'

import { __uploadInternals } from '../index.js'

const { buildAttachmentBlocks, imageMediaTypeFor } = __uploadInternals

/** 假宿主附件服务：记下调用参数，回一个带 attachmentId 的 ref。 */
const fakeCtx = (saveImages) => ({ get: (name) => (name === 'attachments' ? { saveImages } : undefined) })

/** 不读真文件：附件块只关心「读到了什么字节、用什么 mediaType、叫什么名字」。 */
const readers = {
  readFileSync: (path) => Buffer.from(`bytes-of:${path}`),
  basename: (path) => String(path).split('/').pop(),
}

test('图片进宿主附件存储，返回 image 块', async () => {
  const calls = []
  const ctx = fakeCtx(async (inputs) => {
    calls.push(inputs)
    return [{ attachmentId: 'sha256:abc', mediaType: inputs[0].mediaType, bytes: 3 }]
  })
  const out = await buildAttachmentBlocks(ctx, ['/tmp/a.png'], readers)
  assert.equal(out.images.length, 1)
  assert.deepEqual(out.images[0], { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3 } })
  assert.deepEqual(out.leftover, [])
  assert.equal(calls[0][0].mediaType, 'image/png')
  assert.equal(calls[0][0].name, 'a.png')
  assert.equal(String(calls[0][0].data), 'bytes-of:/tmp/a.png')
})

test('视频与未知扩展名回退成路径行', async () => {
  let called = 0
  const ctx = fakeCtx(async (inputs) => {
    called += 1
    return [{ attachmentId: 'x', mediaType: inputs[0].mediaType, bytes: 1 }]
  })
  const out = await buildAttachmentBlocks(ctx, ['/tmp/a.mp4', '/tmp/a.pdf'], readers)
  assert.deepEqual(out.images, [])
  assert.deepEqual(out.leftover, ['/tmp/a.mp4', '/tmp/a.pdf'])
  assert.equal(called, 0)
})

test('宿主没有附件服务时整体回退', async () => {
  const out = await buildAttachmentBlocks({ get: () => undefined }, ['/tmp/a.png'], readers)
  assert.deepEqual(out.images, [])
  assert.deepEqual(out.leftover, ['/tmp/a.png'])
})

test('存图抛错只影响那一张', async () => {
  const ctx = fakeCtx(async (inputs) => {
    if (String(inputs[0].data).includes('bad')) throw new Error('boom')
    return [{ attachmentId: 'ok', mediaType: inputs[0].mediaType, bytes: 1 }]
  })
  const out = await buildAttachmentBlocks(ctx, ['/tmp/bad.png', '/tmp/good.png'], readers)
  assert.equal(out.images.length, 1)
  assert.deepEqual(out.leftover, ['/tmp/bad.png'])
})

test('ref 字段名认不出就回退，不把坏 ref 发给宿主', async () => {
  const ctx = fakeCtx(async (inputs) => [{ mediaType: inputs[0].mediaType, bytes: 1 }])
  const out = await buildAttachmentBlocks(ctx, ['/tmp/a.png'], readers)
  assert.deepEqual(out.images, [])
  assert.deepEqual(out.leftover, ['/tmp/a.png'])
})

test('空入参不碰宿主', async () => {
  let called = 0
  const ctx = fakeCtx(async () => {
    called += 1
    return []
  })
  assert.deepEqual(await buildAttachmentBlocks(ctx, [], readers), { images: [], leftover: [] })
  assert.deepEqual(await buildAttachmentBlocks(ctx, undefined, readers), { images: [], leftover: [] })
  assert.equal(called, 0)
})

test('扩展名 → mediaType 只认四种图片', () => {
  assert.equal(imageMediaTypeFor('/x/a.png'), 'image/png')
  assert.equal(imageMediaTypeFor('/x/a.JPG'), 'image/jpeg')
  assert.equal(imageMediaTypeFor('/x/a.jpeg'), 'image/jpeg')
  assert.equal(imageMediaTypeFor('/x/a.webp'), 'image/webp')
  assert.equal(imageMediaTypeFor('/x/a.gif'), 'image/gif')
  assert.equal(imageMediaTypeFor('/x/a.mp4'), '')
  assert.equal(imageMediaTypeFor('/x/a'), '')
  assert.equal(imageMediaTypeFor(''), '')
})
