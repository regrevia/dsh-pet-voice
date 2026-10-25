/**
 * dsh-pet-voice 的离线自检。
 *
 * 不启动 DSH，也不需要真模型：用一个假的 ctx 把插件 apply() 起来，把注册到的路由
 * 挂到一个真实 http server 上，然后逐条打请求。这样能验证鉴权、静态资源、状态、
 * 派发、SSE 推送这些真正容易写错的地方。
 *
 * 跑法（用临时 HOME，绝不碰 ~/.dsh 里的真 token）：
 *   HOME=/tmp/pvtest node plugins/dsh-pet-voice/selftest.mjs
 */

import { createServer } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { apply, buildDispatchPrompt, buildHiddenPrompt, normalizeMaxWords, parseCommand, renderMarkdown, stripForSpeech } from './index.js'

const routes = []
const listeners = new Map()
const calls = { create: [], prompt: [], cancel: [] }
let seq = 0

const sessions = [
  { sessionId: 'sess-existing', title: '已有会话', cwd: '/tmp/pet-lab' },
]

const services = {
  sessionController: {
    list: async () => sessions,
    create: async (request) => {
      calls.create.push(request)
      seq += 1
      const value = { sessionId: `sess-new-${seq}`, title: `新会话 ${seq}` }
      // 真宿主会按 workspaceId 定 cwd，这里照做，好让「cwd 必须是 Pet」的断言有意义
      const cwd =
        request.cwd ??
        services.workspaceRegistry.list().find((item) => item.id === request.workspaceId)?.path ??
        ''
      // 用 push 保持稳定顺序：真宿主里「界面当前会话」是用户最近在用的那只，
      // 不该因为自测多建了两只就把 current 变成刚建的会话（那正是要防的 bug）。
      sessions.push({ sessionId: value.sessionId, title: value.title, cwd })
      return value
    },
    prompt: async (request) => {
      calls.prompt.push(request)
      const text = (request.content ?? []).map((part) => part?.text ?? '').join('')
      // 小爱那条回归用例：模拟一轮真实的 start → … → final，
      // 帧必须**分两次**到达，才能覆盖「被 start 唤醒后没命中、必须重新挂回去」。
      if (text.includes('回复两个字')) {
        const sessionId = request.sessionId
        setTimeout(() => {
          fire('session/event', { header: { id: sessionId } }, { type: 'turn/start' })
          setTimeout(() => {
            fire('session/event', { header: { id: sessionId } }, {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: '收到' }] } },
            })
          }, 120)
        }, 30)
      }
      return { accepted: true }
    },
    cancel: (request) => {
      calls.cancel.push(request)
      return { cancelled: true }
    },
  },
  workspaceRegistry: {
    list: () => [
      { id: 'ws-pet', title: 'Pet', path: '/tmp/pet-lab' },
      { id: 'ws-web', title: 'web', path: '/tmp/web-lab' },
    ],
  },
  agentPresets: {
    list: async () => [{ id: 'default', title: '默认' }, { id: 'whale', title: '鲸灵人设' }],
  },
}

const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
    getOrigin: () => origin,
  },
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
    return () => listeners.get(type).delete(fn)
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get: (name) => services[name],
}

const fire = (type, ...args) => {
  const set = listeners.get(type)
  if (!set) throw new Error(`没有监听 ${type}`)
  for (const fn of set) fn(...args)
}

let origin = 'http://127.0.0.1:0'

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  for (const route of routes) {
    const hit = route.kind === 'exact' ? url.pathname === route.path : url.pathname.startsWith(route.path)
    if (!hit) continue
    Promise.resolve(route.handler(req, res)).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('no route')
})

const results = []
function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition), detail })
  const mark = condition ? '✓' : '✗'
  console.log(`${mark} ${label}${condition ? '' : `  ← ${detail ?? ''}`}`)
}

async function main() {
  // 项目记忆如果留着上一次跑的结果，/new 的「首次即新建」就不成立了。
  rmSync(join(homedir(), '.dsh/pet-voice/state.json'), { force: true })
  apply(ctx)

  /* 0. 纯函数：一句话语音指令解析（不碰 HTTP、不碰会话） */
  const WS = [
    { id: 'ws-pet', title: 'Pet', path: '/tmp/pet-lab' },
    { id: 'ws-web', title: 'web', path: '/tmp/web-lab' },
    { id: 'ws-space', title: 'Pet Voice', path: '/tmp/pet-lab Voice' },
    { id: 'ws-voice', title: 'PetVoice', path: '/tmp/pet-labVoice' },
    { id: 'ws-whale', title: '鲸灵项目', path: '/tmp/whale-lab' },
  ]
  const cmd = (text) => parseCommand(text, WS)
  const cases = [
    ['切到 Pet', 'switch', 'Pet'],
    ['打开 web', 'switch', 'web'],
    ['去 Pet Voice', 'switch', 'Pet Voice'],
    ['切换到  pet   voice ！', 'switch', 'Pet Voice'],
    ['切到 鲸灵', 'switch', '鲸灵项目'],
    ['切到 whale', 'switch', '鲸灵项目'],
    ['派发 看下 git status 给 Pet', 'dispatch', 'Pet'],
    ['让 web 做 跑一下测试', 'dispatch', 'web'],
    ['停', 'stop', ''],
    ['别说了', 'stop', ''],
    ['取消', 'stop', ''],
    ['今天天气不错', 'chat', ''],
    ['', 'chat', ''],
    ['   ', 'chat', ''],
  ]
  for (const [text, action, title] of cases) {
    const got = cmd(text)
    check(
      `parseCommand(${JSON.stringify(text)}) → ${action}${title ? ` / ${title}` : ''}`,
      got.action === action && (!title || got.title === title),
      JSON.stringify(got),
    )
  }
  check('派发指令带出 content（内容里还能有「给」）', cmd('派发 把结果给我看看 给 web').content === '把结果给我看看', JSON.stringify(cmd('派发 把结果给我看看 给 web')))
  const ambiguous = cmd('切到 Voice')
  check(
    '子串歧义（Pet Voice / PetVoice）不瞎切：switch-miss + candidates ≤5',
    ambiguous.action === 'switch-miss' && (ambiguous.candidates ?? []).length === 2 && ambiguous.candidates.length <= 5,
    JSON.stringify(ambiguous),
  )
  const missing = cmd('切到 不存在的项目')
  check(
    '项目不存在 → switch-miss，say 可直念',
    missing.action === 'switch-miss' && typeof missing.say === 'string' && missing.say.includes('没找到叫'),
    JSON.stringify(missing),
  )
  const missDispatch = cmd('派发 帮我看看 给 没有这个项目')
  check(
    '派发目标不存在 → dispatch-miss，带 candidates',
    missDispatch.action === 'dispatch-miss' && Array.isArray(missDispatch.candidates) && missDispatch.say.includes('没有这个项目'),
    JSON.stringify(missDispatch),
  )
  const tooLong = cmd(`切到 Pet${'啊'.repeat(400)}`)
  check('超长文本（>300 字）截断后仍解析出 switch', tooLong.action === 'switch' && tooLong.title === 'Pet', JSON.stringify(tooLong).slice(0, 120))
  check('停 → say 就是「好，停了」', cmd('停').say === '好，停了', JSON.stringify(cmd('停')))
  check('闲聊 → say 必须是 null（App 据此走 /api/dispatch）', cmd('今天天气不错').say === null, JSON.stringify(cmd('今天天气不错')))

  // 朗读文本净化：用户听到「星号星号」就是因为 Markdown 直接进了 TTS
  const mdReply = '**结论**：改完了。\n\n- 第一点：`BUFFER_MAX` 调到 400\n- 第二点：见 [契约文档](https://example.com/c)\n\n> 提醒：重载插件。\n\n```js\nconst a = 1\n```\n\n| 端点 | 方法 |\n|---|---|\n| `/api/tts` | GET |'
  const speech = stripForSpeech(mdReply)
  check('stripForSpeech 去掉 md 标记（* # ` ]( 一个不剩）', !/[*#`]|\]\(/.test(speech), speech)
  check('stripForSpeech 保留正文与链接文字', speech.includes('结论：改完了') && speech.includes('契约文档') && speech.includes('/api/tts'), speech)
  check('stripForSpeech 代码块整段不念', !speech.includes('const a') && !speech.includes('js'), speech)
  check('stripForSpeech 表格不分隔行、单元格连成一句', speech.includes('端点，方法'), speech)
  check('stripForSpeech 幂等', stripForSpeech(speech) === speech, stripForSpeech(speech))
  check('stripForSpeech 纯文本原样返回', stripForSpeech('今天天气不错') === '今天天气不错')

  const renderBasic = renderMarkdown('这是 **粗体**、*斜体* 和 `code`。')
  check('renderMarkdown 粗体/斜体/行内代码', ['<strong>粗体</strong>', '<em>斜体</em>', '<code>code</code>'].every((tag) => renderBasic.includes(tag)), renderBasic)
  const renderHead = renderMarkdown('# H1\n###### H6')
  check('renderMarkdown 标题降级到 h3/h5', renderHead.includes('<h3>H1</h3>') && renderHead.includes('<h5>H6</h5>'), renderHead)
  const renderList = renderMarkdown('- A\n  - A1\n- B')
  check('renderMarkdown 列表嵌套一层', renderList.includes('<li>A<ul><li>A1</li></ul></li>'), renderList)
  const renderTable = renderMarkdown('| 名称 | 值 |\n|---|---|\n| a | 1 |')
  check('renderMarkdown GFM 表格', renderTable.includes('<th>名称</th>') && renderTable.includes('<td>1</td>'), renderTable)
  const renderFence = renderMarkdown('```js\nconst a = 1 < 2 && "x"\n```')
  check('renderMarkdown 围栏代码转义 + 等宽块', renderFence.includes('&lt; 2 &amp;&amp;') && renderFence.includes('<pre><code'), renderFence)
  const renderXss = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>')
  check('renderMarkdown 转义 raw HTML（无 <script> / <img）', !renderXss.includes('<script') && !renderXss.includes('<img'), renderXss)
  const renderLink = renderMarkdown('[官网](https://example.com) [坏链](javascript:alert(1))')
  check('renderMarkdown 只放行 http(s) 链接、外链新窗口', renderLink.includes('href="https://example.com" target="_blank"') && !renderLink.includes('javascript:'), renderLink)

  // 人设/长度档走会话级 system prompt（隐藏），正文只发用户原话。
  const plain = buildDispatchPrompt('帮我看看项目')
  check('派发正文只有用户原话', plain === '帮我看看项目', plain)
  const hiddenShort = buildHiddenPrompt({ persona: '你是鲸灵。', maxWords: '短' })
  const hiddenLong = buildHiddenPrompt({ persona: '你是鲸灵。', maxWords: '长' })
  check('隐藏段带人设', hiddenShort.includes('你是鲸灵。'), hiddenShort)
  check('隐藏段短/长两档约束不同', hiddenShort.includes('80 字') && hiddenLong.includes('展开说明') && hiddenShort !== hiddenLong)
  check('隐藏段与正文分离（正文不含人设）', !plain.includes('你是鲸灵。') && !plain.includes('回复长度'))
  check('normalizeMaxWords 缺省/未知都落回「短」', normalizeMaxWords(undefined) === '短' && normalizeMaxWords('超长') === '短')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  // token 是惰性生成的（第一次请求页面时才落盘）：先打一次，保证全新 HOME 也能跑。
  await fetch(`${origin}/pet-voice/`)
  const token = readFileSync(join(homedir(), '.dsh/pet-voice/token'), 'utf8').trim()
  check('token 已生成且足够长', token.length >= 32, token.length)

  const exact = routes.filter((r) => r.kind === 'exact').length
  const prefix = routes.filter((r) => r.kind === 'prefix').length
  check('页面/接口/静态资源都挂了 exact 路由', exact >= 17, `exact=${exact} prefix=${prefix}`)
  check('页面路由可直达', routes.some((r) => r.kind === 'exact' && r.path === '/pet-voice/'), routes.map((r) => r.path).slice(0, 6))

  /* 1. 无 cookie 打开页面 → 401 配对页 */
  const gate = await fetch(`${origin}/pet-voice/`)
  const gateBody = await gate.text()
  check('无 token 打开页面 → 401', gate.status === 401, gate.status)
  check('401 页里有 token 输入框', gateBody.includes('name="k"'), gateBody.slice(0, 120))

  /* 2. 带 ?k= → 303 + Set-Cookie */
  const handoff = await fetch(`${origin}/pet-voice/?k=${token}`, { redirect: 'manual' })
  const setCookie = handoff.headers.get('set-cookie') ?? ''
  check('?k= → 303', handoff.status === 303, handoff.status)
  check(
    '下发了 HttpOnly cookie',
    /HttpOnly/i.test(setCookie) && setCookie.includes(token.slice(0, 8)),
    setCookie.split(';')[0].slice(0, 16) + '…（值已截断，避免把 token 打进日志）',
  )
  const cookie = setCookie.split(';')[0]

  /* 3. 带 cookie → 200 真页面 */
  const page = await fetch(`${origin}/pet-voice/`, { headers: { cookie } })
  const html = await page.text()
  check('带 cookie → 200', page.status === 200, page.status)
  check('页面引用了 app.js 与 pet.js', html.includes('assets/app.js') && html.includes('id="pet"'), html.slice(0, 80))

  /* 4. 静态资源 */
  for (const [file, type] of [
    ['app.js', 'javascript'],
    ['pet.js', 'javascript'],
    ['style.css', 'text/css'],
    ['manifest.webmanifest', 'manifest+json'],
    ['icon.svg', 'image/svg+xml'],
  ]) {
    const res = await fetch(`${origin}/pet-voice/assets/${file}`)
    const body = await res.text()
    check(`静态资源 ${file} 200`, res.status === 200 && body.length > 50, `${res.status} ${body.length}`)
    check(`  内容类型 ${file}`, (res.headers.get('content-type') ?? '').includes(type), res.headers.get('content-type'))
  }

  /* 5. 路径穿越 */
  const evil = await fetch(`${origin}/pet-voice/assets/..%2findex.js`)
  check('拒绝路径穿越', evil.status === 400 || evil.status === 404, evil.status)

  /* 6. API 鉴权 */
  const noAuth = await fetch(`${origin}/pet-voice/api/state`)
  check('API 无 cookie → 401', noAuth.status === 401, noAuth.status)

  /* 7. state */
  const state = await (await fetch(`${origin}/pet-voice/api/state`, { headers: { cookie } })).json()
  check('state.ok', state.ok === true, JSON.stringify(state).slice(0, 120))
  check('state 带项目列表', (state.projects ?? []).length === 2, JSON.stringify(state.projects))
  check('state 带人设列表', (state.presets ?? []).length === 2, JSON.stringify(state.presets))
  check('state 带会话与唤醒词', Boolean(state.current?.id) && (state.pet?.wakeWords ?? []).length > 0, JSON.stringify(state.current))

  /* 8. /new：项目切换与新建 */
  const reused = await (
    await fetch(`${origin}/pet-voice/api/new`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-pet', projectPath: '/tmp/pet-lab' }),
    })
  ).json()
  check('首次 /new 会建会话', reused.ok === true && reused.reused === false, JSON.stringify(reused))
  const firstId = reused.sessionId

  const again = await (
    await fetch(`${origin}/pet-voice/api/new`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-pet', projectPath: '/tmp/pet-lab' }),
    })
  ).json()
  check('再 /new 给新会话', again.sessionId !== firstId && again.reused === false, JSON.stringify(again))

  const fresh = await (
    await fetch(`${origin}/pet-voice/api/new`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-pet', projectPath: '/tmp/pet-lab', fresh: true }),
    })
  ).json()
  check('fresh 强制新会话', fresh.sessionId !== firstId, JSON.stringify(fresh))
  check('create() 收到了 workspaceId', calls.create.at(-1)?.workspaceId === 'ws-pet', JSON.stringify(calls.create.at(-1)))

  /* 9. dispatch：契约形状 + 立即回执 */
  const dispatch = await (
    await fetch(`${origin}/pet-voice/api/dispatch`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-pet-tz': 'Asia/Shanghai' },
      body: JSON.stringify({
        text: '帮我看看 demo 目录',
        workspaceId: 'ws-pet',
        projectPath: '/tmp/pet-lab',
        sessionId: firstId,
      }),
    })
  ).json()
  check('dispatch 被接受', dispatch.ok === true && dispatch.sessionId === firstId, JSON.stringify(dispatch))
  const sent = calls.prompt.at(-1)
  check('prompt 收到纯文本 part', sent?.content?.[0]?.type === 'text' && sent.content[0].text.includes('demo'), JSON.stringify(sent))
  check('prompt 使用 queue 模式', sent?.mode === 'queue', sent?.mode)
  check('prompt 带 requestId 与时区', Boolean(sent?.requestId) && sent.clientTimeZone === 'Asia/Shanghai', JSON.stringify(sent))

  /* 10. 空文本被拒 */
  const empty = await fetch(`${origin}/pet-voice/api/dispatch`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  })
  check('空文本 → 400', empty.status === 400, empty.status)

  /* 11. cancel */
  const cancel = await (
    await fetch(`${origin}/pet-voice/api/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: firstId }),
    })
  ).json()
  check('cancel 转发到宿主', cancel.ok === true && calls.cancel.at(-1)?.sessionId === firstId, JSON.stringify(cancel))

  /* 12. SSE：真实推流 */
  const controller = new AbortController()
  const streamRes = await fetch(`${origin}/pet-voice/api/stream?sessionId=${firstId}`, {
    headers: { cookie },
    signal: controller.signal,
  })
  check('SSE 内容类型', (streamRes.headers.get('content-type') ?? '').includes('text/event-stream'), streamRes.headers.get('content-type'))
  const reader = streamRes.body.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const readUntil = async (needle, timeout = 1500) => {
    const deadline = Date.now() + timeout
    while (!received.includes(needle) && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      received += decoder.decode(value, { stream: true })
    }
    return received.includes(needle)
  }
  check('SSE 开场 hello', await readUntil('event: hello'), received.slice(0, 120))

  fire('agent/assistant-stream', {
    agent: { id: firstId },
    frame: { type: 'chunk', index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: '鲸灵在听' } },
  })
  check('增量帧被转成 delta 事件', await readUntil('鲸灵在听'), JSON.stringify(received.slice(-200)))

  fire('agent/assistant-stream', {
    agent: { id: firstId },
    frame: { type: 'chunk', index: 1, time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  })
  check('finish 帧被转成 end 事件', await readUntil('"reason":"stop"'), JSON.stringify(received.slice(-200)))

  fire('session/event', { header: { id: firstId } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '整段兜底文本' }] } },
  })
  check('assistant/message 兜底成 final 事件', await readUntil('整段兜底文本'), JSON.stringify(received.slice(-200)))

  fire('agent/assistant-stream', {
    agent: { id: 'other-session' },
    frame: { type: 'chunk', index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: '不该出现' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('别的会话的增量不会串台', !received.includes('不该出现'), 'leak')

  controller.abort()

  /* 12b. 小爱派任务必须拿到真回复
   * 回归：waitFinal 被第一帧 start 唤醒却没命中就返回时，会被 emit 的
   * `waiters.clear()` 摘掉，之后的 final 再没人接 → 每次都干等到预算耗尽、
   * 永远回占位语（线上实测 3/3 全部超时）。 */
  // 第一次访问 xiaoai 路由时插件才会懒加载模块并生成 urlSecret，所以先空打一下。
  await fetch(`${origin}/pet-voice/api/xiaoai`)
  const xiaoaiCfg = JSON.parse(readFileSync(join(homedir(), '.dsh/pet-voice/xiaoai.json'), 'utf8'))
  const xiaoaiSelftest = await fetch(`${origin}/pet-voice/api/xiaoai/selftest?k=${xiaoaiCfg.urlSecret}`)
  check('小爱 selftest 端点可用', xiaoaiSelftest.status === 200, xiaoaiSelftest.status)
  const askStart = Date.now()
  const askRes = await fetch(`${origin}/pet-voice/api/xiaoai?k=${xiaoaiCfg.urlSecret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: '1.0',
      query: '让鲸灵回复两个字：收到',
      session: { session_id: 'sel-xiaoai', application: { app_id: '1' }, user: { user_id: '2' } },
      request: { type: 1, request_id: 'sel-xiaoai', timestamp: 1, locale: 'zh-CN' },
    }),
  })
  const askJson = await askRes.json()
  const askText = askJson?.response?.to_speak?.text ?? ''
  const askMs = Date.now() - askStart
  check(
    '派任务拿到真回复（不是「收到，我在做了」这类占位语）',
    askText.includes('收到') && !askText.includes('我记下了'),
    `${askMs}ms ${askText}`,
  )
  check('派任务在预算内返回', askMs < 2600, `${askMs}ms`)

  /* 12c. 小爱必须派给「专属会话」，不许跟着 GUI 当前会话跑 -----------------
   * 回归：旧实现用 currentSessionId()（列表第一条 = 最近活跃），实测把任务
   * 塞进了 Envoy 项目和 Lead 自己的会话，用户在界面上看得见。 */
  const petSessionPath = join(homedir(), '.dsh/pet-voice/pet-session.json')
  const pinned = JSON.parse(readFileSync(petSessionPath, 'utf8'))
  const lastAskSession = calls.prompt.at(-1)?.sessionId
  check('pet-session.json 落盘在 Pet 项目', pinned.workspaceId === 'ws-pet', JSON.stringify(pinned))
  check('派任务用的是专属会话（= pet-session.json）', lastAskSession === pinned.sessionId, `${lastAskSession} vs ${pinned.sessionId}`)
  check('不再挑「最近活跃」的会话派任务', lastAskSession !== 'sess-existing', lastAskSession)
  check(
    '专属会话的 cwd 就是 Pet 项目',
    sessions.find((item) => item.sessionId === pinned.sessionId)?.cwd === '/tmp/pet-lab',
    sessions.find((item) => item.sessionId === pinned.sessionId)?.cwd,
  )
  check('建会话时给的是 Pet 的 workspaceId', calls.create.at(-1)?.workspaceId === 'ws-pet', JSON.stringify(calls.create.at(-1)))

  // 切项目只挪这只专属会话，并同步 pet-session.json
  const switchRes = await fetch(`${origin}/pet-voice/api/xiaoai?k=${xiaoaiCfg.urlSecret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: '1.0',
      query: '让鲸灵到 web 项目干活',
      session: { session_id: 'sel-xiaoai', application: { app_id: '1' }, user: { user_id: '2' } },
      request: { type: 1, request_id: 'sel-switch', timestamp: 1, locale: 'zh-CN' },
    }),
  })
  const switchJson = await switchRes.json()
  const moved = JSON.parse(readFileSync(petSessionPath, 'utf8'))
  check('切项目后 pet-session.json 改到了 web', moved.workspaceId === 'ws-web', JSON.stringify(moved))
  check('切项目确实回了话', Boolean(switchJson?.response?.to_speak?.text), JSON.stringify(switchJson).slice(0, 120))
  await fetch(`${origin}/pet-voice/api/xiaoai?k=${xiaoaiCfg.urlSecret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: '1.0',
      query: '让鲸灵到 Pet 项目干活',
      session: { session_id: 'sel-xiaoai', application: { app_id: '1' }, user: { user_id: '2' } },
      request: { type: 1, request_id: 'sel-back', timestamp: 1, locale: 'zh-CN' },
    }),
  })
  check('切回 Pet 后 pet-session.json 也回来了', JSON.parse(readFileSync(petSessionPath, 'utf8')).workspaceId === 'ws-pet')

  // /api/state 里的 remembered 不许留死 id（旧实现残留过 sess-new-2 这种假会话）
  const stateRes = await fetch(`${origin}/pet-voice/api/state`)
  const stateJson = await stateRes.json()
  const alive = new Set((stateJson.sessions ?? []).map((item) => item.id))
  const dead = Object.values(stateJson.remembered ?? {}).filter((id) => !alive.has(id))
  check('/api/state 的 remembered 没有死 id', dead.length === 0, JSON.stringify(dead))

  /* 13. token 不回显 / 配对链接 / 长轮询回放 */
  const state2 = await (await fetch(`${origin}/pet-voice/api/state`, { headers: { cookie } })).json()
  check(
    'state 不回显完整 token（只给前 8 位）',
    !('token' in state2) && state2.tokenHint === token.slice(0, 8),
    Object.keys(state2).join(','),
  )

  const linkNoAuth = await fetch(`${origin}/pet-voice/api/link`)
  check('/api/link 无 cookie → 401', linkNoAuth.status === 401, linkNoAuth.status)
  const link = await (await fetch(`${origin}/pet-voice/api/link`, { headers: { cookie } })).json()
  check(
    '/api/link 给出现在生效的配对链接',
    link.ok === true && /\/pet-voice\/\?k=/.test(link.url ?? '') && link.url.includes(token),
    link.ok ? 'url 内容不符' : JSON.stringify(link),
  )

  const pollNoAuth = await fetch(`${origin}/pet-voice/api/poll?sessionId=${firstId}`)
  check('/api/poll 无 cookie → 401', pollNoAuth.status === 401, pollNoAuth.status)
  const polled = await (
    await fetch(`${origin}/pet-voice/api/poll?sessionId=${firstId}&cursor=0&wait=200`, { headers: { cookie } })
  ).json()
  const polledText = JSON.stringify(polled.frames)
  check(
    '/api/poll 按 cursor 回放已有帧',
    polled.ok === true && polledText.includes('整段兜底文本') && polledText.includes('"seq":1'),
    polledText.slice(0, 160),
  )
  const pollIdle = await (
    await fetch(`${origin}/pet-voice/api/poll?sessionId=${firstId}&cursor=${polled.cursor}&wait=150`, {
      headers: { cookie },
    })
  ).json()
  check(
    '/api/poll 没有新帧时按 wait 超时空返回',
    pollIdle.ok === true && pollIdle.frames.length === 0 && pollIdle.cursor === polled.cursor,
    JSON.stringify(pollIdle).slice(0, 120),
  )

  const peek = await (
    await fetch(`${origin}/pet-voice/api/poll?sessionId=${firstId}&cursor=-1&wait=0`, { headers: { cookie } })
  ).json()
  check(
    '/api/poll cursor=-1 只对齐不回放（页面接上会话时不重播历史）',
    peek.ok === true && peek.frames.length === 0 && peek.cursor === polled.cursor,
    JSON.stringify(peek).slice(0, 120),
  )

  /* 13.5 配对地址 /api/pair（只读、无 token） */
  const pairNoAuth = await fetch(`${origin}/pet-voice/api/pair`)
  check('/api/pair 无 cookie → 401', pairNoAuth.status === 401, pairNoAuth.status)

  const pairRes = await fetch(`${origin}/pet-voice/api/pair`, { headers: { cookie } })
  const pairBody = await pairRes.json()
  check(
    '/api/pair 返回 publicBase + source 三档之一',
    pairRes.status === 200 &&
      typeof pairBody.publicBase === 'string' &&
      pairBody.publicBase.endsWith('/pet-voice/') &&
      ['tunnel', 'lan', 'local'].includes(pairBody.source),
    `${pairBody.source} ${pairBody.publicBase}`,
  )
  const pairRaw = JSON.stringify(pairBody)
  check(
    '/api/pair 不带 token（也不带 ?k=）',
    !pairRaw.includes(token) && !/[?&]k=/.test(pairRaw) && !pairRaw.includes(token.slice(0, 12)),
    pairRaw.slice(0, 120),
  )

  /* 13.6 隧道探活：不通 → 仍给 tunnel 地址 + alive:false + note；超时 ≤1.5s；30s 缓存 */
  const { writeFileSync: wf, unlinkSync: uf } = await import('node:fs')
  const urlFile = join(homedir(), '.dsh/pet-voice/xiaoai-url.txt')
  const pairOf = async () => {
    const r = await fetch(`${origin}/pet-voice/api/pair`, { headers: { cookie } })
    return { status: r.status, body: await r.json() }
  }

  wf(urlFile, 'https://not-a-real.example/pet-voice/api/xiaoai?k=deadbeefdeadbeef\n', { mode: 0o600 })
  const deadT = await pairOf()
  check(
    '/api/pair 隧道不通 → source 仍 tunnel + alive:false + note',
    deadT.status === 200 &&
      deadT.body.source === 'tunnel' &&
      (deadT.body.alive === true || (/可能已过期/.test(deadT.body.note ?? '') && deadT.body.alive === false)),
    JSON.stringify(deadT.body).slice(0, 150),
  )
  check('/api/pair 隧道不通也不降级成 lan/local', deadT.body.source === 'tunnel', deadT.body.source)

  // 缓存：同 base 再来一次必须秒回（30 s TTL 内不再探）
  const cachedAt = Date.now()
  const cachedP = await pairOf()
  const cachedMs = Date.now() - cachedAt
  // 真隧道在跑时 alive 就是 true；只验「秒回」这条契约
  check('/api/pair 探活结果 30s 内缓存（同 base 秒回）', cachedMs < 400, `${cachedMs}ms`)

  // 超时：黑洞地址，必须被 1.5 s 掐断而不是把请求挂住
  wf(urlFile, 'https://10.255.255.1/pet-voice/api/xiaoai?k=deadbeefdeadbeef\n', { mode: 0o600 })
  const slowAt = Date.now()
  const slowP = await pairOf()
  const slowMs = Date.now() - slowAt
  check(
    '/api/pair 探活超时 ≤1.5s 且不抛错',
    slowP.status === 200 && slowMs < 2600,
    `${slowMs}ms alive=${slowP.body.alive}`,
  )

  uf(urlFile)
  const backP = await pairOf()
  check('/api/pair 删掉隧道记录 → 仍有可用地址', ['lan', 'local', 'tunnel'].includes(backP.body.source), backP.body.source)

  /* 14. 神经语音 /api/tts */
  const voicesNoAuth = await fetch(`${origin}/pet-voice/api/tts/voices`)
  check('/api/tts/voices 无 cookie → 401', voicesNoAuth.status === 401, voicesNoAuth.status)

  const voices = await (await fetch(`${origin}/pet-voice/api/tts/voices`, { headers: { cookie } })).json()
  check(
    '/api/tts/voices 返回音色白名单',
    voices.ok === true && Array.isArray(voices.voices) && voices.voices.length >= 3 &&
      voices.voices.some((v) => v.id === 'zh-CN-XiaoyiNeural'),
    JSON.stringify(voices).slice(0, 140),
  )

  const presetIds = (voices.presets ?? []).map((item) => item.id)
  check(
    '/api/tts/voices 带 6 个形象档位（voice+rate+pitch 齐全、音色都在白名单里）',
    (voices.presets ?? []).length === 6 &&
      voices.defaultPreset === 'whale' &&
      voices.presets.every(
        (item) =>
          presetIds.includes(item.id) &&
          voices.voices.some((v) => v.id === item.voice) &&
          /^[+-]?\d{1,3}%$/.test(item.rate) &&
          /^[+-]?\d{1,3}Hz$/.test(item.pitch),
      ),
    JSON.stringify(voices.presets ?? []).slice(0, 200),
  )
  check(
    '六档韵律确实不同（pitch/rate 组合唯一）',
    new Set((voices.presets ?? []).map((item) => `${item.voice}|${item.rate}|${item.pitch}`)).size === 6,
    (voices.presets ?? []).map((item) => `${item.rate}/${item.pitch}`).join(' '),
  )

  const ttsBadPreset = await fetch(`${origin}/pet-voice/api/tts?text=${encodeURIComponent('你好')}&preset=nope`, {
    headers: { cookie },
  })
  const badPresetBody = await ttsBadPreset.json()
  check(
    '/api/tts 未知档位 → 400 且回可选档位',
    ttsBadPreset.status === 400 && (badPresetBody.presets ?? []).includes('genki'),
    ttsBadPreset.status,
  )

  const ttsNoAuth = await fetch(`${origin}/pet-voice/api/tts?text=${encodeURIComponent('你好')}`)
  check('/api/tts 无 cookie → 401', ttsNoAuth.status === 401, ttsNoAuth.status)

  const ttsEmpty = await fetch(`${origin}/pet-voice/api/tts?text=`, { headers: { cookie } })
  check('/api/tts 空文本 → 400', ttsEmpty.status === 400, ttsEmpty.status)

  const ttsLong = await fetch(`${origin}/pet-voice/api/tts?text=${encodeURIComponent('啊'.repeat(700))}`, {
    headers: { cookie },
  })
  check('/api/tts 超长文本 → 400', ttsLong.status === 400, ttsLong.status)

  const ttsBadVoice = await fetch(
    `${origin}/pet-voice/api/tts?text=${encodeURIComponent('你好')}&voice=zh-CN-不存在`,
    { headers: { cookie } },
  )
  const badVoiceBody = await ttsBadVoice.json()
  check(
    '/api/tts 未知音色 → 400 且回可选列表',
    ttsBadVoice.status === 400 && (badVoiceBody.voices ?? []).includes('zh-CN-XiaoyiNeural'),
    JSON.stringify(badVoiceBody).slice(0, 120),
  )

  // selftest 跑在临时 HOME 下，venv 必然不存在 ⇒ 正好覆盖「没装时给 503 + 中文 hint」
  const ttsMissing = await fetch(`${origin}/pet-voice/api/tts?text=${encodeURIComponent('你好')}`, {
    headers: { cookie },
  })
  // 装了 venv 就回音频（ID3/MPEG），没装才回 503 JSON —— 两种都得认，别硬解析
  const ttsType = ttsMissing.headers.get('content-type') ?? ''
  if (ttsType.includes('json')) {
    const missingBody = await ttsMissing.json()
    check(
      '/api/tts venv 缺失 → 503 + 让用户跑 setup.sh',
      ttsMissing.status === 503 && missingBody.ok === false && /setup\.sh/.test(missingBody.hint ?? ''),
      JSON.stringify(missingBody).slice(0, 160),
    )
  } else {
    const bytes = (await ttsMissing.arrayBuffer()).byteLength
    check(
      '/api/tts 有 venv → 直接回音频',
      ttsMissing.status === 200 && bytes > 1000,
      `${ttsMissing.status} ${ttsType} ${bytes}B`,
    )
  }

  /* 14b. 派发落点：不带 sessionId 必须落到专属会话（用户投诉过串进界面会话） */
  const stateBefore = await (await fetch(`${origin}/pet-voice/api/state`, { headers: { cookie } })).json()
  const petDispatch = await (
    await fetch(`${origin}/pet-voice/api/dispatch`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '落点自测' }),
    })
  ).json()
  const petFile = JSON.parse(readFileSync(join(homedir(), '.dsh/pet-voice/pet-session.json'), 'utf8'))
  check(
    'dispatch 不带 sessionId → 专属会话',
    petDispatch.ok === true && petDispatch.sessionId === petFile.sessionId,
    `${JSON.stringify(petDispatch).slice(0, 120)} file=${petFile.sessionId}`,
  )
  check(
    'dispatch 落点 ≠ 界面当前会话（state.current）',
    petDispatch.sessionId !== stateBefore.current?.id,
    `${petDispatch.sessionId} vs ${stateBefore.current?.id}`,
  )
  check(
    'dispatch 落点不在 remembered 里',
    !Object.values(stateBefore.remembered ?? {}).includes(petDispatch.sessionId),
    JSON.stringify(stateBefore.remembered),
  )
  check('专属会话钉在 Pet 项目', petFile.workspaceId === 'ws-pet', JSON.stringify(petFile))

  const stateAfter = await (await fetch(`${origin}/pet-voice/api/state`, { headers: { cookie } })).json()
  check('state.dispatchTarget 指向专属会话', stateAfter.dispatchTarget === petFile.sessionId, JSON.stringify(stateAfter.dispatchTarget))
  check(
    'dispatch 前后 state.current 不变（不抢界面方向盘）',
    stateBefore.current?.id === stateAfter.current?.id,
    `${stateBefore.current?.id} → ${stateAfter.current?.id}`,
  )
  check(
    'current 永远不是专属会话那只',
    stateAfter.current?.id !== petFile.sessionId,
    `${stateAfter.current?.id} vs ${petFile.sessionId}`,
  )

  const pollPet = await (
    await fetch(`${origin}/pet-voice/api/poll?cursor=-1&wait=0`, { headers: { cookie } })
  ).json()
  check('poll 不带 sessionId 也落专属会话', pollPet.ok === true && pollPet.sessionId === petFile.sessionId, JSON.stringify(pollPet).slice(0, 120))

  const ghost = await fetch(`${origin}/pet-voice/api/dispatch`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '不该派出去', sessionId: 'sess-ghost' }),
  })
  check('显式 sessionId 不存在 → 404，不乱派', ghost.status === 404, ghost.status)

  /* 15. 外部播报 /api/say */
  const sayNoAuth = await fetch(`${origin}/pet-voice/api/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '偷偷念一句' }),
  })
  check('/api/say 无 cookie → 401', sayNoAuth.status === 401, sayNoAuth.status)

  const say1 = await (
    await fetch(`${origin}/pet-voice/api/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '我是鲸灵，播报测试' }),
    })
  ).json()
  check(
    '/api/say 入队成功并回 seq/queued',
    say1.ok === true && say1.seq >= 1 && say1.queued >= 1,
    JSON.stringify(say1),
  )

  const said = await (await fetch(`${origin}/pet-voice/api/say?since=0`, { headers: { cookie } })).json()
  check(
    'GET /api/say?since=0 能拉到刚才那条',
    said.ok === true && (said.items ?? []).some((item) => item.text === '我是鲸灵，播报测试'),
    JSON.stringify(said).slice(0, 160),
  )

  const sayAgain = await (await fetch(`${origin}/pet-voice/api/say?since=${said.cursor}`, { headers: { cookie } })).json()
  check(
    'since=cursor 不再返回旧条目',
    sayAgain.ok === true && (sayAgain.items ?? []).length === 0 && sayAgain.cursor === said.cursor,
    JSON.stringify(sayAgain).slice(0, 120),
  )

  const peekSay = await (await fetch(`${origin}/pet-voice/api/say?since=-1`, { headers: { cookie } })).json()
  check(
    'since=-1 只对齐游标不回放',
    peekSay.ok === true && (peekSay.items ?? []).length === 0 && peekSay.cursor === said.cursor,
    JSON.stringify(peekSay).slice(0, 120),
  )

  const longText = '啊'.repeat(400)
  const sayLong = await (
    await fetch(`${origin}/pet-voice/api/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: longText }),
    })
  ).json()
  const longBack = await (await fetch(`${origin}/pet-voice/api/say?since=${sayLong.seq - 1}`, { headers: { cookie } })).json()
  check(
    '超 300 字截断并标记 truncated',
    sayLong.ok === true && sayLong.truncated === true && (longBack.items?.[0]?.text ?? '').length === 300,
    `${JSON.stringify(sayLong)} len=${(longBack.items?.[0]?.text ?? '').length}`,
  )

  const dedupe1 = await (
    await fetch(`${origin}/pet-voice/api/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '同一条', id: 'once-1' }),
    })
  ).json()
  const dedupe2 = await (
    await fetch(`${origin}/pet-voice/api/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '同一条', id: 'once-1' }),
    })
  ).json()
  check('同 id 重复投递只入队一次', dedupe2.seq === dedupe1.seq && dedupe2.deduped === true, `${JSON.stringify(dedupe1)} / ${JSON.stringify(dedupe2)}`)

  let lastQueued = 0
  for (let i = 0; i < 25; i += 1) {
    const res = await (
      await fetch(`${origin}/pet-voice/api/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ text: `压力 ${i}` }),
      })
    ).json()
    lastQueued = res.queued
  }
  const capped = await (await fetch(`${origin}/pet-voice/api/say?since=0`, { headers: { cookie } })).json()
  check(
    '队列 cap 20：queued 不超 20，拉取也最多 20 条',
    lastQueued === 20 && (capped.items ?? []).length === 20,
    `queued=${lastQueued} items=${(capped.items ?? []).length}`,
  )

  /* 15. selfcheck */
  const self = await (await fetch(`${origin}/pet-voice/api/selfcheck`, { headers: { cookie } })).json()
  check('selfcheck 通过', self.ok === true, JSON.stringify(self.steps))


  /* 17. 手机语音指令三端点：/api/workspaces /api/switch /api/command */
  for (const [method, name] of [
    ['GET', 'workspaces'],
    ['POST', 'switch'],
    ['POST', 'command'],
  ]) {
    const res = await fetch(`${origin}/pet-voice/api/${name}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    })
    check(`未鉴权 ${method} /api/${name} → 401`, res.status === 401, `status=${res.status}`)
  }

  const wsRes = await fetch(`${origin}/pet-voice/api/workspaces`, { headers: { cookie } })
  const wsBody = await wsRes.json()
  const wsText = JSON.stringify(wsBody)
  check(
    '/api/workspaces：workspaces[].id/title/path/pinned + pinned{title,id,sessionId}',
    wsRes.status === 200 &&
      wsBody.ok === true &&
      Array.isArray(wsBody.workspaces) &&
      wsBody.workspaces.length === 2 &&
      wsBody.workspaces.every(
        (w) =>
          typeof w.id === 'string' &&
          typeof w.title === 'string' &&
          typeof w.path === 'string' &&
          typeof w.pinned === 'boolean',
      ) &&
      typeof wsBody.pinned?.title === 'string' &&
      typeof wsBody.pinned?.id === 'string' &&
      typeof wsBody.pinned?.sessionId === 'string',
    wsText.slice(0, 200),
  )
  check('/api/workspaces 不含 token、不含会话历史', !wsText.includes(token) && !wsText.includes('sess-existing'), wsText.slice(0, 200))

  const swBad = await fetch(`${origin}/pet-voice/api/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: '压根没有这个项目' }),
  })
  const swBadBody = await swBad.json()
  check(
    '/api/switch 项目不存在 → 404 + error + candidates',
    swBad.status === 404 &&
      swBadBody.ok === false &&
      swBadBody.error === '没有这个项目: 压根没有这个项目' &&
      Array.isArray(swBadBody.candidates) &&
      swBadBody.candidates.length > 0 &&
      swBadBody.candidates.length <= 5,
    JSON.stringify(swBadBody),
  )

  const swWeb = await fetch(`${origin}/pet-voice/api/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'web' }),
  })
  const swWebBody = await swWeb.json()
  check(
    '/api/switch 成功 → {ok,title,sessionId}，且 pinned 跟着变',
    swWeb.status === 200 &&
      swWebBody.ok === true &&
      swWebBody.title === 'web' &&
      /^sess-/.test(swWebBody.sessionId ?? '') &&
      (await (await fetch(`${origin}/pet-voice/api/workspaces`, { headers: { cookie } })).json()).pinned?.title === 'web',
    JSON.stringify(swWebBody),
  )

  // 闲聊必须零副作用：不建会话、不派发、不改 pin
  const beforeChat = { prompt: calls.prompt.length, create: calls.create.length }
  const chatRes = await fetch(`${origin}/pet-voice/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text: '今天天气不错' }),
  })
  const chatBody = await chatRes.json()
  const pinnedAfterChat = (await (await fetch(`${origin}/pet-voice/api/workspaces`, { headers: { cookie } })).json()).pinned?.title
  check(
    '/api/command 闲聊 → action:chat、say:null、零副作用',
    chatRes.status === 200 &&
      chatBody.action === 'chat' &&
      chatBody.say === null &&
      calls.prompt.length === beforeChat.prompt &&
      calls.create.length === beforeChat.create &&
      pinnedAfterChat === 'web',
    JSON.stringify({ chatBody, beforeChat, after: { prompt: calls.prompt.length, create: calls.create.length }, pinnedAfterChat }),
  )

  const stopRes = await (await fetch(`${origin}/pet-voice/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text: '别说了' }),
  })).json()
  check(
    '/api/command 停 → action:stop + say + stopped',
    stopRes.action === 'stop' && stopRes.say === '好，停了' && stopRes.stopped === true,
    JSON.stringify(stopRes),
  )

  const swCmd = await (await fetch(`${origin}/pet-voice/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text: '切到 Pet' }),
  })).json()
  check(
    '/api/command 切项目 → action:switch + say《Pet》',
    swCmd.action === 'switch' && swCmd.title === 'Pet' && swCmd.say === '好，切到《Pet》了',
    JSON.stringify(swCmd),
  )

  const beforeDispatch = calls.prompt.length
  const disCmd = await (await fetch(`${origin}/pet-voice/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text: '让 web 做 跑一下测试' }),
  })).json()
  const lastPrompt = calls.prompt[calls.prompt.length - 1]
  check(
    '/api/command 派发 → action:dispatch + say + 只派给专属会话',
    disCmd.action === 'dispatch' &&
      disCmd.title === 'web' &&
      disCmd.say === '已经交给《web》去做了' &&
      calls.prompt.length === beforeDispatch + 1 &&
      (lastPrompt?.content ?? []).map((c) => c?.text).join('').includes('跑一下测试') &&
      String(lastPrompt?.sessionId ?? '').startsWith('sess-new') &&
      lastPrompt?.sessionId !== 'sess-existing',
    JSON.stringify({ disCmd, lastPrompt }),
  )
  check(
    '/api/command 全程没碰用户已有会话 sess-existing',
    calls.prompt.every((item) => item.sessionId !== 'sess-existing'),
    JSON.stringify(calls.prompt.map((item) => item.sessionId)),
  )

  const missCmd = await (await fetch(`${origin}/pet-voice/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text: '切到 没有的项目' }),
  })).json()
  check(
    '/api/command 切不到 → 200 + action:switch-miss + candidates（不建会话）',
    missCmd.action === 'switch-miss' && Array.isArray(missCmd.candidates) && missCmd.candidates.length <= 5 && missCmd.say.includes('没找到叫'),
    JSON.stringify(missCmd),
  )

  const emptyCmd = await (await fetch(`${origin}/pet-voice/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text: '' }),
  })).json()
  check('/api/command 空文本 → chat，不报错（语音误触发不该弹红字）', emptyCmd.ok === true && emptyCmd.action === 'chat', JSON.stringify(emptyCmd))

  /* 17.5 服务端渲染 /api/render 与播报净化 */
  const renderRes = await fetch(`${origin}/pet-voice/api/render`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '# 标题\n\n**粗** 和 <script>alert(1)</script>' }),
  })
  const renderJson = await renderRes.json()
  check('/api/render 返回安全 HTML 片段', renderJson.ok === true && renderJson.html.includes('<h3>标题</h3>') && renderJson.html.includes('<strong>粗</strong>') && !renderJson.html.includes('<script'), JSON.stringify(renderJson).slice(0, 160))
  const renderNoAuth = await fetch(`${origin}/pet-voice/api/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) })
  check('/api/render 无 cookie → 401', renderNoAuth.status === 401, renderNoAuth.status)
  const renderEmpty = await fetch(`${origin}/pet-voice/api/render`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: '   ' }) })
  check('/api/render 空文本 → 400', renderEmpty.status === 400, renderEmpty.status)

  const sayMd = await fetch(`${origin}/pet-voice/api/say`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '**好了**：`x` 已改完', id: 'selftest-md' }),
  })
  const sayMdJson = await sayMd.json()
  const sayList = await (await fetch(`${origin}/pet-voice/api/say?since=${Math.max(0, sayMdJson.seq - 1)}`, { headers: { cookie } })).json()
  const sayItem = (sayList.items ?? []).find((item) => item.id === 'selftest-md')
  check('/api/say 播报文本同样剥掉 Markdown', sayMdJson.ok === true && sayItem && !/[*`]/.test(sayItem.text) && sayItem.text.includes('好了'), JSON.stringify(sayItem ?? sayMdJson).slice(0, 160))

  const stateSettings = await (await fetch(`${origin}/pet-voice/api/state`, { headers: { cookie } })).json()
  check(
    '/api/state 带出 maxWords/bubble 默认值',
    stateSettings.settings?.maxWords === '短' && stateSettings.settings?.bubble === true && stateSettings.settings?.hasPersona === false,
    JSON.stringify(stateSettings.settings),
  )

  /* 17.6 面板配置：人设 / 输出长度 / 气泡 / 唤醒名 / 传输方式（回环专用，无 token） */
  const panelGet = await fetch(`${origin}/pet-voice/panel/state`)
  const panelJson = await panelGet.json()
  check(
    'GET /panel/state 带出五项配置，默认 mode=lan / maxWords=短 / bubble=true',
    panelJson.ok === true &&
      panelJson.mode === 'lan' &&
      panelJson.maxWords === '短' &&
      panelJson.bubble === true &&
      panelJson.persona === '' &&
      (panelJson.wakeName === '' || panelJson.wakeName === '大肥鱼') &&
      (panelJson.modes ?? []).map((m) => m.id).join(',') === 'server,lan,domain',
    JSON.stringify({ mode: panelJson.mode, maxWords: panelJson.maxWords, bubble: panelJson.bubble, wakeName: panelJson.wakeName, modes: panelJson.modes?.map((m) => m.id) }),
  )
  const postPanel = async (patch) =>
    (await fetch(`${origin}/pet-voice/panel/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })).json()
  const savedAll = await postPanel({ persona: '你是鲸灵。\n说话短。', maxWords: '长', bubble: false, wakeName: '小鱼' })
  check(
    'POST /panel/state 一次改四项并回显',
    savedAll.ok === true && savedAll.persona.includes('鲸灵') && savedAll.maxWords === '长' && savedAll.bubble === false && savedAll.wakeName === '小鱼',
    JSON.stringify({ persona: savedAll.persona, maxWords: savedAll.maxWords, bubble: savedAll.bubble, wakeName: savedAll.wakeName }),
  )
  const panelAgain = await (await fetch(`${origin}/pet-voice/panel/state`)).json()
  check('面板配置落盘（重新 GET 仍是改后的值）', panelAgain.maxWords === '长' && panelAgain.bubble === false && panelAgain.wakeName === '小鱼', JSON.stringify({ maxWords: panelAgain.maxWords, bubble: panelAgain.bubble, wakeName: panelAgain.wakeName }))
  const domainSaved = await postPanel({ mode: 'domain', customUrl: 'https://pet.example.com' })
  check(
    'domain 档 + 自定义地址 → 生成带 /pet-voice/ 的配对链接',
    domainSaved.mode === 'domain' && domainSaved.customUrl === 'https://pet.example.com' && String(domainSaved.pairingUrl).startsWith('https://pet.example.com/pet-voice/?k='),
    JSON.stringify({ mode: domainSaved.mode, customUrl: domainSaved.customUrl, pairingUrl: String(domainSaved.pairingUrl).slice(0, 70) }),
  )
  const badWords = await fetch(`${origin}/pet-voice/panel/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxWords: '超长' }),
  })
  const badWordsJson = await badWords.json()
  check('非法输出长度 → 400 且带可选值', badWords.status === 400 && badWordsJson.error === '输出长度只能选短、中、长', `${badWords.status} ${badWordsJson.error}`)
  const statePanelSettings = await (await fetch(`${origin}/pet-voice/api/state`, { headers: { cookie } })).json()
  check(
    '/api/state.settings 跟随面板（App 看到的是同一份配置）',
    statePanelSettings.settings?.maxWords === '长' && statePanelSettings.settings?.bubble === false && statePanelSettings.settings?.hasPersona === true,
    JSON.stringify(statePanelSettings.settings),
  )

  const savedPoll = await postPanel({ transport: 'poll' })
  check('传输方式可切到只用轮询并回显', savedPoll.ok === true && savedPoll.transport === 'poll', JSON.stringify({ transport: savedPoll.transport }))
  const pollTransport = await (await fetch(`${origin}/pet-voice/api/poll?cursor=-1`, { headers: { cookie } })).json()
  check('/api/poll 把传输方式带给 App（App 据此跳过开流）', pollTransport.transport === 'poll', JSON.stringify({ transport: pollTransport.transport }))
  const badTransport = await fetch(`${origin}/pet-voice/panel/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transport: 'carrier-pigeon' }),
  })
  const badTransportJson = await badTransport.json()
  check('非法传输方式 → 400 且说明可选值', badTransport.status === 400 && String(badTransportJson.error).includes('传输方式'), `${badTransport.status} ${badTransportJson.error}`)
  const backAuto = await postPanel({ transport: 'auto' })
  check('传输方式可切回自动', backAuto.transport === 'auto', JSON.stringify({ transport: backAuto.transport }))
  const panelNoLoop = await fetch(`${origin}/pet-voice/panel/state`, { headers: { 'x-forwarded-for': '203.0.113.9' } })
  check('面板路由带外网转发头也照样可用（门禁看 socket 不看 header）或 403', panelNoLoop.status === 200 || panelNoLoop.status === 403, panelNoLoop.status)

  /* 18. 卸载要干净 */
  server.close()
  console.log('')
  const failed = results.filter((r) => !r.ok)
  console.log(`selftest: ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('失败项：')
    for (const item of failed) console.log(` - ${item.label}  ${item.detail ?? ''}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('selftest 崩了：', error)
  // 出错时别留着 http server 让进程挂着（tail/CI 里看起来就像卡死）。
  try {
    server.close()
  } catch {
    /* 没起来 */
  }
  process.exitCode = 1
})
