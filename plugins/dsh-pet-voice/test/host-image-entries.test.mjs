import assert from 'node:assert/strict'
import test from 'node:test'

import { __browseInternals } from '../index.js'

const { entriesOfTranscript, imagePartsOf, decorateImageEntries } = __browseInternals

const line = (obj) => JSON.stringify(obj)

test('只发了图的用户消息不再被丢掉，并带上图片身份', () => {
  const text = line({
    type: 'user/message',
    seq: 7,
    time: 1000,
    data: {
      content: [
        { type: 'text', text: '' },
        { type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/jpeg' } },
      ],
    },
  })
  const entries = entriesOfTranscript(text)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].role, 'user')
  assert.equal(entries[0].text, '')
  assert.equal(entries[0].images.length, 1)
  assert.equal(entries[0].images[0].mediaType, 'image/jpeg')
})

test('图 + 文字一起发：文字和图片都在同一条', () => {
  const text = line({
    type: 'user/message',
    seq: 8,
    time: 1000,
    data: {
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', attachment: { attachmentId: 'sha256:' + 'b'.repeat(64), mediaType: 'image/png' } },
      ],
    },
  })
  const [entry] = entriesOfTranscript(text)
  assert.equal(entry.text, '看图')
  assert.equal(entry.images.length, 1)
})

test('注入段仍然不上屏：压缩摘要/系统提醒不因带图就漏出来', () => {
  const text = line({
    type: 'user/message',
    seq: 9,
    time: 1000,
    data: {
      content: [
        { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span' },
        { type: 'image', attachment: { attachmentId: 'sha256:' + 'd'.repeat(64), mediaType: 'image/jpeg' } },
      ],
    },
  })
  // 图在注入段里也一样丢：这条消息整体就是宿主自己写的，不是主人发的
  assert.deepEqual(entriesOfTranscript(text), [])
})

test('imagePartsOf 认不出身份就跳过，不编路径', () => {
  assert.deepEqual(imagePartsOf([{ type: 'image' }]), [])
  assert.deepEqual(imagePartsOf([{ type: 'image', attachment: { mediaType: 'image/png' } }]), [])
  assert.deepEqual(imagePartsOf(undefined), [])
})

test('图片换成 App 认得的 markdown 行，其他条目原样不动', () => {
  const entries = [
    { seq: 1, role: 'assistant', text: '收到' },
    // 假 sha 在对象库里不存在：落不出路径就只留原文，不给坏链接
    { seq: 2, role: 'user', text: '看图', images: [{ id: 'sha256:' + 'c'.repeat(64), mediaType: 'image/jpeg' }] },
  ]
  const out = decorateImageEntries(entries)
  assert.equal(out[0], entries[0])
  assert.equal(out[1].text, '看图')
  assert.equal(out[1].images, undefined)
  // 原始条目不被改写：转录 memo 还要用
  assert.equal(entries[1].images.length, 1)
})

test('没有图片的页原样返回（不新建数组）', () => {
  const entries = [{ seq: 1, role: 'assistant', text: 'hi' }]
  assert.equal(decorateImageEntries(entries), entries)
})
