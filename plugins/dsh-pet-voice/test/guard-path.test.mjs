// 入口层路径规范化 + 面板拦截：P0 回归测试。
//
// 背景：公网反代/LAN 反代把请求从回环地址转给宿主，宿主的面板门禁只查
// remoteAddress，所以入口层是匿名请求唯一能被拦下的地方。这些用例锁的就是
// 「判定用规范形、转发也用同一份规范形」——原始 URL 判断会被 ../、%2e%2e 绕过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePath,
  normalizeTarget,
  isPanelPath,
  isProtectedPath,
  isPetVoicePath,
  forwardPath,
} from '../guardPath.mjs'
import { classifyPublicPath } from '../public.mjs'
import { classifyLanPath } from '../lan.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

test('normalizePath：点段、编码点段、多重编码都收敛到面板路径', () => {
  assert.equal(normalizePath('/pet-voice/panel/../panel/state'), '/pet-voice/panel/state')
  assert.equal(normalizePath('/pet-voice/panel/%2e%2e/panel/state'), '/pet-voice/panel/state')
  assert.equal(normalizePath('/pet-voice/panel/%2E%2E/panel/state'), '/pet-voice/panel/state')
  assert.equal(normalizePath('/pet-voice/panel/%252e%252e/panel/state'), '/pet-voice/panel/state')
  assert.equal(normalizePath('/pet-voice/api/../panel/state'), '/pet-voice/panel/state')
  assert.equal(normalizePath('/pet-voice/api/%2e%2e%2fpanel/state'), '/pet-voice/panel/state')
  assert.equal(normalizePath('/pet-voice/panel/./state'), '/pet-voice/panel/state')
  // 大小写与结尾斜杠：规范化后仍能认出面板
  assert.equal(normalizePath('/pet-voice/PANEL/state'), '/pet-voice/PANEL/state')
  assert.equal(normalizePath('/pet-voice/panel/'), '/pet-voice/panel')
  // 双斜杠、反斜杠（URL 语义里等同分隔符）
  assert.equal(normalizePath('/pet-voice//panel///state'), '/pet-voice/panel/state')
  assert.equal(normalizePath('/pet-voice/panel\\..\\panel/state'), '/pet-voice/panel/state')
  // 编码过的一级目录名
  assert.equal(normalizePath('/pet-voice/%70anel/state'), '/pet-voice/panel/state')
})

test('normalizePath：不合法输入一律拒绝（不猜）', () => {
  assert.equal(normalizePath(''), null)
  assert.equal(normalizePath(null), null)
  assert.equal(normalizePath(undefined), null)
  assert.equal(normalizePath('/pet-voice/%zz'), null)          // 非法百分号
  assert.equal(normalizePath('/pet-voice/%E0%A4'), null)       // 截断的 UTF-8
  assert.equal(normalizePath('/pet-voice/a\0b'), null)         // NUL 字面量
  assert.equal(normalizePath('/pet-voice/a%00b'), null)        // 编码 NUL
  // 超过 3 层的编码不猜，直接拒
  assert.equal(normalizePath('/pet-voice/panel/%2525252e%2525252e/panel/state'), null)
})

test('isPanelPath / isProtectedPath：只认面板，不误伤普通路径', () => {
  assert.equal(isPanelPath('/pet-voice/panel'), true)
  assert.equal(isPanelPath('/pet-voice/panel/state'), true)
  assert.equal(isPanelPath('/pet-voice/Panel/state'), true) // 大小写不敏感：宁可错拦
  assert.equal(isPanelPath('/pet-voice/panels'), false)
  assert.equal(isPanelPath('/pet-voice/api/state'), false)
  assert.equal(isPanelPath('/pet-voice/download/pet.apk'), false)
  assert.equal(isPanelPath('/pet-voice/'), false)
  assert.equal(isProtectedPath('/pet-voice/panel/state'), true)
})

test('normalizeTarget / forwardPath：判定用规范形，转发也用它，query 原样保留', () => {
  const target = normalizeTarget('/pet-voice//api/%2e%2e/panel/state?device=abc')
  assert.equal(target.path, '/pet-voice/panel/state')
  assert.equal(target.search, '?device=abc')
  assert.equal(forwardPath(target), '/pet-voice/panel/state?device=abc')

  const range = normalizeTarget('/pet-voice/download/pet.apk?x=1')
  assert.equal(range.path, '/pet-voice/download/pet.apk')
  assert.equal(forwardPath(range), '/pet-voice/download/pet.apk?x=1')
  // 转发路径必须是合法请求行：空格/中文要重新编码
  const spaced = normalizeTarget('/pet-voice/download/%E5%AE%A0%E7%89%A9%20v1.apk')
  assert.equal(spaced.path, '/pet-voice/download/宠物 v1.apk')
  assert.match(forwardPath(spaced), /^\/pet-voice\/download\/[^ ]+$/)
  assert.equal(isPetVoicePath('/pet-voice'), true)
  assert.equal(isPetVoicePath('/pet-voice-x'), false)
})

test('public 入口：匿名面板请求 403，点段变体同样 403，普通 api/download 放行', () => {
  for (const raw of [
    '/pet-voice/panel/state',
    '/pet-voice/panel',
    '/pet-voice/panel/../panel/state',
    '/pet-voice/panel/%2e%2e/panel/state',
    '/pet-voice/PANEL/state',
    '/pet-voice//panel/state',
    '/pet-voice/%70anel/state',
    '/pet-voice/api/../panel/state',
  ]) {
    const verdict = classifyPublicPath(raw)
    assert.equal(verdict.status, 403, `应拦下：${raw}`)
    assert.equal(verdict.target, undefined)
  }
  assert.equal(classifyPublicPath('/pet-voice/api/state').status, 0)
  assert.equal(classifyPublicPath('/pet-voice/asset/panel.css').status, 0)
  assert.equal(classifyPublicPath('/pet-voice/download/pet.apk').status, 0)
  assert.equal(classifyPublicPath('/pet-voice/').status, 0)
  assert.equal(classifyPublicPath('/other/thing').status, 404)
  assert.equal(classifyPublicPath('/pet-voice/%zz').status, 400)
})

test('lan 入口：面板 403，下载放行（Range 走同一条转发路径），普通路径不误杀', () => {
  for (const raw of [
    '/pet-voice/panel/state',
    '/pet-voice/panel/../panel/state',
    '/pet-voice/panel/%2e%2e/panel/state',
    '/pet-voice/PANEL/state',
    '/pet-voice/api/../panel/state',
    '/pet-voice/asset/..//panel/state',
  ]) {
    assert.equal(classifyLanPath(raw).status, 403, `应拦下：${raw}`)
  }
  // 修复点：此前默认 LAN 模式把下载误拒成 403
  const apk = classifyLanPath('/pet-voice/download/pet-1.2.3.apk')
  assert.equal(apk.status, 0)
  assert.equal(forwardPath(apk.target), '/pet-voice/download/pet-1.2.3.apk')
  const ranged = classifyLanPath('/pet-voice/download/pet-1.2.3.apk?from=update')
  assert.equal(ranged.status, 0)
  assert.equal(forwardPath(ranged.target), '/pet-voice/download/pet-1.2.3.apk?from=update')
  // 逆向：仍拒绝面板以外不该被转的路径
  assert.equal(classifyLanPath('/pet-voice/README.md').status, 403)
  assert.equal(classifyLanPath('/pet-voice/').status, 0) // 根路径本来就是 App 的入口页
  assert.equal(classifyLanPath('/pet-voice/%zz').status, 400)
  assert.equal(classifyLanPath('/pet-voice/api/state').status, 0)
  assert.equal(classifyLanPath('/pet-voice/asset/panel.css').status, 0)
})

test('转发层只认 guardPath 的结果：不再拿原始 URL 当转发目标，Range 头原样透传', () => {
  for (const file of ['public.mjs', 'lan.mjs']) {
    const src = readFileSync(join(HERE, '..', file), 'utf8')
    // 判定/转发链路：必须出现 forwardPath(verdict.target)
    assert.match(src, /path:\s*forwardPath\(verdict\.target\)/, `${file} 应转发规范形`)
    // 绝不能把原始 req.url 直接塞给上游
    assert.equal(/path:\s*req\.url/.test(src), false, `${file} 不能转发原始 URL`)
  }
  // LAN 代理的头处理必须原样透传（Range 靠这个到宿主）：
  const lanSrc = readFileSync(join(HERE, '..', 'lan.mjs'), 'utf8')
  assert.match(lanSrc, /headers:\s*\{\s*\.\.\.req\.headers,\s*host:/)
  assert.equal(/delete .*range/i.test(lanSrc), false)
})
