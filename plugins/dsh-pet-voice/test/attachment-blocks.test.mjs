import assert from 'node:assert/strict'
import test from 'node:test'

import { __uploadInternals } from '../index.js'

const { buildAttachmentBlocks, imageMediaTypeFor } = __uploadInternals

/** 不读真文件：附件块只关心「读到了什么字节、用什么 mediaType、叫什么名字」。 */
const readers = {
  readFileSync: (path) => Buffer.from(`bytes-of:${path}`),
  basename: (path) => String(path).split('/').pop(),
}

test('图片变成 prompt 入参形状的 base64 image 块', async () => {
  const out = await buildAttachmentBlocks({}, ['/tmp/a.png'], readers)
  assert.equal(out.images.length, 1)
  const [part] = out.images
  assert.equal(part.type, 'image')
  assert.equal(part.mediaType, 'image/png')
  assert.equal(part.name, 'a.png')
  // PromptContentPart 要的是 canonical base64，不是 Buffer、不是历史记录里的 attachment ref
  assert.equal(typeof part.data, 'string')
  assert.equal(part.data, Buffer.from('bytes-of:/tmp/a.png').toString('base64'))
  assert.equal(part.attachment, undefined)
  assert.deepEqual(out.leftover, [])
})

test('两种 jpg 后缀都给 image/jpeg，多张按入参顺序排', async () => {
  const out = await buildAttachmentBlocks({}, ['/tmp/a.jpg', '/tmp/b.JPEG'], readers)
  assert.deepEqual(out.images.map((p) => p.mediaType), ['image/jpeg', 'image/jpeg'])
  assert.deepEqual(out.images.map((p) => p.name), ['a.jpg', 'b.JPEG'])
})

test('视频与未知扩展名回退成路径行', async () => {
  const out = await buildAttachmentBlocks({}, ['/tmp/a.mp4', '/tmp/a.pdf'], readers)
  assert.deepEqual(out.images, [])
  assert.deepEqual(out.leftover, ['/tmp/a.mp4', '/tmp/a.pdf'])
})

test('读不动的图只退那一张，别的照发', async () => {
  const out = await buildAttachmentBlocks({}, ['/tmp/bad.png', '/tmp/good.png'], {
    readFileSync: (path) => {
      if (String(path).includes('bad')) throw new Error('boom')
      return Buffer.from(`bytes-of:${path}`)
    },
    basename: readers.basename,
  })
  assert.equal(out.images.length, 1)
  assert.equal(out.images[0].name, 'good.png')
  assert.deepEqual(out.leftover, ['/tmp/bad.png'])
})

test('空文件不当图片块发出去', async () => {
  const out = await buildAttachmentBlocks({}, ['/tmp/empty.png'], {
    readFileSync: () => Buffer.alloc(0),
    basename: readers.basename,
  })
  assert.deepEqual(out.images, [])
  assert.deepEqual(out.leftover, ['/tmp/empty.png'])
})

test('空入参直接返回空', async () => {
  assert.deepEqual(await buildAttachmentBlocks({}, [], readers), { images: [], leftover: [] })
  assert.deepEqual(await buildAttachmentBlocks({}, undefined, readers), { images: [], leftover: [] })
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
