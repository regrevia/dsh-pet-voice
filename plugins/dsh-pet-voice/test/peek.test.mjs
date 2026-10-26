import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __peekInternals } from '../index.js'

const { peekWanted, pickPeekTarget, peekTranscriptLines, gitDigest, buildPeekBlock } = __peekInternals

test('问进展才旁听：几种常见说法认，普通聊天不认', () => {
  for (const text of [
    '最近进展怎么样',
    '那边做到哪一步了',
    '开发进度如何',
    '现在怎么样了',
    '最近在忙什么',
    '下一步打算干嘛',
  ]) {
    assert.equal(peekWanted(text), true, text)
  }
  for (const text of ['帮我截个屏', '把这张图存到项目里', '今天天气不错', '', '    ']) {
    assert.equal(peekWanted(text), false, text)
  }
})

test('问进展的判定有长度上限：长文里偶然带「进度」不触发', () => {
  assert.equal(peekWanted(`${'进度'.repeat(300)}`), false)
})

test('挑目标：同项目里最近活跃的另一只，排除自己钉的那只', () => {
  const rows = [
    { id: 'mine', cwd: '/p', updatedAt: 900 },
    { id: 'older', cwd: '/p', updatedAt: 100 },
    { id: 'newest', cwd: '/p', updatedAt: 800 },
    { id: 'other-project', cwd: '/q', updatedAt: 950 },
  ]
  const projectOf = (row) => (String(row.cwd).startsWith('/p') ? 'proj-p' : 'proj-q')
  const bound = pickPeekTarget(rows, 'mine', { cwd: '/p', projectOf })
  assert.equal(bound.id, 'newest')
})

test('挑目标：workspaceId 认项目时优先用它（cwd 为空也能对上）', () => {
  const rows = [
    { id: 'mine', workspaceId: 'w1', updatedAt: 900 },
    { id: 'b', workspaceId: 'w2', updatedAt: 700 },
    { id: 'a', workspaceId: 'w1', updatedAt: 600 },
  ]
  const picked = pickPeekTarget(rows, 'mine', { projectOf: () => '' })
  assert.equal(picked.id, 'a')
})

test('挑目标：项目里只有自己那一只时返回 null', () => {
  assert.equal(pickPeekTarget([{ id: 'mine', cwd: '/p', updatedAt: 1 }], 'mine', { cwd: '/p' }), null)
  assert.equal(pickPeekTarget([], 'mine'), null)
})

test('转录摘要：只留尾部、按字数截断、工具压成一行', () => {
  const messages = []
  for (let i = 0; i < 40; i++) messages.push({ role: 'user', text: `第${i}句` })
  messages.push({ role: 'assistant', text: '做完了' })
  messages.push({ role: 'tool', text: '', tool: { name: 'bash' } })
  const lines = peekTranscriptLines({ messages }, 200)
  assert.ok(lines.length > 0)
  assert.ok(lines.some((line) => line.startsWith('助手：做完了')), lines.join('|'))
  assert.equal(lines.at(-1), '（用了 bash）')
  assert.ok(lines.join('\n').length <= 200)
  assert.ok(!lines.some((line) => line.startsWith('用户：第0句')), '最老的几句应该已经被丢掉')
})

test('转录摘要：空转录不炸', () => {
  assert.deepEqual(peekTranscriptLines(null), [])
  assert.deepEqual(peekTranscriptLines({ messages: [{ role: 'system' }] }), [])
})

test('git 现状：真仓库里读得到最近提交与未提交改动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-peek-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'peek'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', '第一条'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const digest = gitDigest(dir)
    assert.match(digest, /最新提交/)
    assert.match(digest, /第一条/)
    assert.match(digest, /未提交的改动：1 个文件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git 现状：目录不存在 / 不是仓库都返回空串，不抛', () => {
  assert.equal(gitDigest('/no/such/dir/at/all'), '')
  const dir = mkdtempSync(join(tmpdir(), 'pet-peek-plain-'))
  try {
    mkdirSync(join(dir, 'sub'))
    assert.equal(gitDigest(dir), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旁听材料：边界写清楚，带上来源与「别猜」提醒', () => {
  const block = buildPeekBlock({
    id: 'session-abc',
    title: '修登录',
    updatedAt: 1_700_000_000_000,
    lines: ['用户：先看登录', '助手：改完了'],
    git: '最近提交：\nabc 修登录',
  })
  assert.match(block, /旁听/)
  assert.match(block, /不属于这条对话/)
  assert.match(block, /修登录/)
  assert.match(block, /最近的对话：/)
  assert.match(block, /代码现状：/)
  assert.match(block, /别猜/)
  assert.ok(!block.includes('session-abc'), '有标题时不该把 id 塞进去占地方')
  assert.ok(!block.includes('\n代码现状：\n'), '代码现状要压成一行，不能换行铺开')
  assert.ok(block.length <= 400, `材料不能糊一屏：${block.length}`)
})

test('旁听材料：量要小——转录再多也压到 400 字以内', () => {
  const lines = []
  for (let i = 0; i < 200; i++) lines.push(`助手：${'很长的进展描述'.repeat(10)}${i}`)
  const block = buildPeekBlock({ id: 's', title: '大活', updatedAt: 1_700_000_000_000, lines, git: 'x'.repeat(2000) })
  assert.ok(block.length <= 401, `实际 ${block.length} 字`)
  assert.ok(block.split('\n').length <= 4, '头一行 + 对话一行 + 代码一行 + 别猜一行，超出就被截断')
})

test('git 现状：只留一行（最新一条提交 + 未提交改动计数）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-peek-git-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'peek'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', '第一条'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    writeFileSync(join(dir, 'b.txt'), 'new\n')
    const digest = gitDigest(dir)
    assert.equal(digest.split('\n').length, 1, digest)
    assert.match(digest, /第一条/)
    assert.match(digest, /2 个文件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旁听材料：没标题时用 id 兜底，材料为空也不产出空壳', () => {
  const block = buildPeekBlock({ id: 'session-x', title: '', lines: [], git: '' })
  assert.match(block, /session-x/)
  assert.match(block, /别猜/)
})
