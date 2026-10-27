import { test } from 'node:test'
import assert from 'node:assert/strict'

import { __ttsInternals } from '../index.js'

const { pickEdgeVoice, DEFAULT_VOICE, VOICES } = __ttsInternals

test('面板音色是默认值：只存面板值时就真的用它', () => {
  assert.equal(pickEdgeVoice({ panelVoice: 'zh-CN-XiaoxiaoNeural' }), 'zh-CN-XiaoxiaoNeural')
  assert.equal(pickEdgeVoice({ panelVoice: '  zh-CN-liaoning-XiaobeiNeural  ' }), 'zh-CN-liaoning-XiaobeiNeural')
})

test('请求点名的音色压过面板和档位', () => {
  const got = pickEdgeVoice({
    queryVoice: 'zh-CN-YunxiNeural',
    presetVoice: 'zh-CN-XiaoxiaoNeural',
    panelVoice: 'zh-CN-liaoning-XiaobeiNeural',
  })
  assert.equal(got, 'zh-CN-YunxiNeural')
})

test('档位自带的音色压过面板默认', () => {
  const got = pickEdgeVoice({ presetVoice: 'zh-CN-XiaoxiaoNeural', panelVoice: 'zh-CN-liaoning-XiaobeiNeural' })
  assert.equal(got, 'zh-CN-XiaoxiaoNeural')
})

test('空串 / 空白视为没给', () => {
  assert.equal(pickEdgeVoice({ queryVoice: '  ', presetVoice: '', panelVoice: '' }), DEFAULT_VOICE)
  assert.equal(pickEdgeVoice({}), DEFAULT_VOICE)
  assert.equal(pickEdgeVoice(), DEFAULT_VOICE)
})

test('面板存了不认识的值 → 退回常量默认，不让合成 400', () => {
  assert.equal(pickEdgeVoice({ panelVoice: 'zh-CN-WrongNeural' }), DEFAULT_VOICE)
  assert.equal(pickEdgeVoice({ panelVoice: 'bogus' }), DEFAULT_VOICE)
})

test('常量默认和面板默认都在白名单里', () => {
  const ids = VOICES.map((item) => item.id)
  assert.ok(ids.includes(DEFAULT_VOICE))
  assert.ok(ids.includes('zh-CN-XiaoxiaoNeural'))
})
