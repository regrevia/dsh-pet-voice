/**
 * xiaoai-selftest.mjs — 小爱技能 handler 的端到端自测。
 *
 * 全部打本地 http stub（`createXiaoaiHandler` 挂在一个真的 node:http 上），
 * 不连小爱服务器、不连真机器、不需要隧道。`pet` 用假适配器，
 * 所以每个用例都能确定性断言「路由命中哪个意图、回了哪句话、动作字段对不对」。
 *
 * 跑：node mcp/pet-bridge/xiaoai-selftest.mjs
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BYE_REPLY,
  DEFAULT_WAIT_MS,
  ENDING_REPLY,
  MAX_NOT_UNDERSTAND,
  TIMEOUT_REPLY,
  UNKNOWN_REPLY,
  buildAction,
  createXiaoaiHandler,
  greetingOf,
  routeIntent,
  secretOf,
  signRequest,
  speakable,
  verifySignature,
} from './xiaoai.mjs'

const SECRET = 'selftest-secret-0123456789abcdef'
const URL_SECRET = 'selftest-urlsecret-0123456789'
const KEY_ID = 'selftest-key-id'
const SIGN_SECRET_B64 = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')

const results = []
let failures = 0

function check(name, condition, detail) {
  if (condition) {
    results.push(`  ✓ ${name}`)
    return true
  }
  failures += 1
  results.push(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  return false
}

/** 造一个假鲸灵：记录被调了什么，返回预设好的东西。 */
function makePet(overrides = {}) {
  const calls = { ask: [], status: 0, switchProject: [], stop: 0, latestFinal: [] }
  const pet = {
    name: '鲸灵',
    async status() {
      calls.status += 1
      return {
        sessionId: 'S-CUR',
        title: '当前会话',
        projects: [
          { id: 'w-rea', title: 'REA', path: '/tmp/rea-lab' },
          { id: 'w-dsh', title: 'DSH', path: '/Applications/DeepSeek Harness.app' },
          { id: 'w-pet', title: 'Pet', path: '/tmp/pet-lab' },
        ],
      }
    },
    async ask(text, opts) {
      calls.ask.push({ text, opts })
      return { text: `收到：${text}`, timedOut: false, sessionId: 'S-CUR', sinceSeq: 1 }
    },
    async latestFinal(opts) {
      calls.latestFinal.push(opts)
      return { text: '上一轮我说的话。', seq: 9 }
    },
    async switchProject(name) {
      calls.switchProject.push(name)
      return { title: name, sessionId: 'S-REA' }
    },
    async stop() {
      calls.stop += 1
      return { ok: true, sessionId: 'S-CUR' }
    },
    ...overrides,
  }
  return { pet, calls }
}

/** 把一个 handler 挂到随机端口的 http 上，返回 {base, close}。 */
async function serve(handler) {
  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 小爱文档里那条原样报文。 */
function docEvent(query, sessionId = 'sess-doc-1', type = 1) {
  return {
    version: '1.0',
    query,
    session: {
      session_id: sessionId,
      application: { app_id: '123' },
      user: { user_id: '456' },
    },
    request: {
      type,
      request_id: `req-${Math.random().toString(16).slice(2, 10)}`,
      timestamp: 452453534523,
      locale: 'zh-CN',
    },
  }
}

const PATH = '/pet-voice/api/xiaoai'

async function post(base, event, { secret = SECRET, method = 'POST' } = {}) {
  const url = `${base}${PATH}${secret ? `?k=${encodeURIComponent(secret)}` : ''}`
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(event) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 时保留 text 供断言 */
  }
  return { status: res.status, headers: res.headers, json, text }
}

const speakOf = (json) => json?.response?.to_speak?.text ?? ''

/** 按官方签名文档造一组 header（`?k=` 用 URL_SECRET）。 */
function signedHeaders(bodyText, { urlSecret = URL_SECRET, signBody = bodyText, query } = {}) {
  const md5 = createHash('md5').update(signBody).digest('base64')
  const date = new Date().toUTCString()
  const host = '127.0.0.1'
  const contentType = 'application/json'
  const canonicalQuery = query ?? `k=${urlSecret}`
  const [signature] = signRequest({
    method: 'POST',
    path: PATH,
    query: canonicalQuery,
    date,
    host,
    contentType,
    contentMd5: md5,
    secret: SIGN_SECRET_B64,
  })
  return {
    'content-type': contentType,
    date,
    'content-md5': md5,
    'x-original-host': host,
    authorization: `MIAI-HmacSHA256-V1 ${KEY_ID}:default:${signature}`,
  }
}

/* ------------------------------------------------------------------ */
/* 0. 纯函数                                                           */
/* ------------------------------------------------------------------ */

function testPure() {
  results.push('\n[0] 纯函数')

  check('speakable 去掉 markdown 记号', speakable('**重点**：改好了 `app.js`') === '重点：改好了 app.js。', speakable('**重点**：改好了 `app.js`'))
  const long = '啊'.repeat(500)
  const cut = speakable(long)
  check('speakable 截到 120 字以内', cut.length <= 121, `len=${cut.length}`)
  check('speakable 超长也以句号收尾', /[。！？…]$/.test(cut), cut.slice(-3))

  const at = buildAction('好的')
  check(
    'buildAction 结构符合文档',
    at.version === '1.0' &&
      at.response.to_speak.type === 0 &&
      at.response.to_speak.text === '好的' &&
      at.response.not_understand === false &&
      at.response.open_mic === false &&
      at.is_session_end === true,
    JSON.stringify(at),
  )
  check('buildAction 空文本也不会给空 to_speak', buildAction('').response.to_speak.text === UNKNOWN_REPLY)
  check('buildAction openMic 可开麦', buildAction('hi', { openMic: true, end: false }).response.open_mic === true)

  check('空 query → unknown', routeIntent('').intent === 'unknown')
  check('只有唤醒词 → unknown', routeIntent('鲸灵').intent === 'unknown')
  check(
    '「让鲸灵修复登录 bug」→ ask 且剥掉唤醒前缀',
    (() => {
      const r = routeIntent('让鲸灵修复登录 bug')
      return r.intent === 'ask' && r.text === '修复登录 bug'
    })(),
    JSON.stringify(routeIntent('让鲸灵修复登录 bug')),
  )
  check(
    '「问一下鲸灵今天几号」→ ask 「今天几号」',
    (() => {
      const r = routeIntent('问一下鲸灵今天几号')
      return r.intent === 'ask' && r.text === '今天几号'
    })(),
    JSON.stringify(routeIntent('问一下鲸灵今天几号')),
  )
  check('「鲸灵在干嘛」→ progress', routeIntent('鲸灵在干嘛').intent === 'progress')
  check('「好了吗」→ progress', routeIntent('好了吗').intent === 'progress')
  check('「停」→ stop', routeIntent('停').intent === 'stop')
  check('「别说了」→ stop', routeIntent('别说了').intent === 'stop')
  const sw = routeIntent('让鲸灵到 REA 项目干活', {
    projects: [{ id: 'w-rea', title: 'REA', path: '/x/REA' }],
  })
  check('「让鲸灵到 REA 项目干活」→ switch 且认出 REA', sw.intent === 'switch' && sw.project?.title === 'REA', JSON.stringify(sw))
  check('「切到不存在的项目」→ unknown 而不是硬派任务', routeIntent('切到火星项目', { projects: [] }).intent === 'unknown')

  /* 回归：意图优先级（线上实测踩过的两个真 bug） */
  const PROJ = [
    { id: 'w-pet', title: 'Pet', path: '/x/Pet' },
    { id: 'w-rea', title: 'REA', path: '/x/REA' },
  ]
  const petTask = routeIntent('让鲸灵看看 Pet 项目里有什么', { projects: PROJ })
  check(
    '回归：「让鲸灵看看 Pet 项目里有什么」→ ask（不是切 Pet）',
    petTask.intent === 'ask',
    JSON.stringify(petTask),
  )
  check('回归：「让鲸灵看看 Pet 项目里有什么」正文剥干净', petTask.text === 'Pet 项目里有什么', petTask.text)
  const reaSwitch = routeIntent('切到 REA 项目', { projects: PROJ })
  check('回归：「切到 REA 项目」→ switch', reaSwitch.intent === 'switch' && reaSwitch.project?.title === 'REA', JSON.stringify(reaSwitch))
  const reaGo = routeIntent('让鲸灵去 REA 项目', { projects: PROJ })
  check('回归：「让鲸灵去 REA 项目」→ switch', reaGo.intent === 'switch' && reaGo.project?.title === 'REA', JSON.stringify(reaGo))
  const look = routeIntent('帮我看看测试结果', { projects: PROJ })
  check('回归：「帮我看看测试结果」→ ask 且不含「看看」', look.intent === 'ask' && look.text === '测试结果', JSON.stringify(look))
  const open = routeIntent('打开鲸灵', { projects: PROJ })
  check('回归：「打开鲸灵」→ launch（不是派任务）', open.intent === 'launch', JSON.stringify(open))
  check('回归：「启动鲸灵」→ launch', routeIntent('启动鲸灵').intent === 'launch')
  const stop = routeIntent('停下', { projects: PROJ })
  check('回归：「停下」→ stop', stop.intent === 'stop', JSON.stringify(stop))
}

/* ------------------------------------------------------------------ */
/* 签名（纯函数部分）                                                   */
/* ------------------------------------------------------------------ */

function testSigning() {
  results.push('\n[0b] 签名纯函数')

  const signer = { keyId: KEY_ID, secret: SIGN_SECRET_B64 }
  const bodyText = JSON.stringify(docEvent('鲸灵在干嘛'))
  const headers = signedHeaders(bodyText)
  const url = new URL(`http://127.0.0.1${PATH}?k=${URL_SECRET}`)
  const req = { method: 'POST', headers }
  check('正确签名通过校验', verifySignature(req, url, signer).ok === true, JSON.stringify(verifySignature(req, url, signer)))

  const bad = { ...headers, authorization: headers.authorization.replace(/.$/, 'f') }
  check('改一个字符就通不过', verifySignature({ method: 'POST', headers: bad }, url, signer).ok === false)
  check('缺 Authorization 通不过', verifySignature({ method: 'POST', headers: {} }, url, signer).ok === false)
  check(
    'KeyId 不匹配通不过',
    verifySignature(
      { method: 'POST', headers: { ...headers, authorization: headers.authorization.replace(KEY_ID, 'someone-else') } },
      url,
      signer,
    ).ok === false,
  )
  check('没配 signer 时不该有签名结论（调用方降级）', verifySignature(req, url, { keyId: '', secret: '' }).ok === false)
}

/* ------------------------------------------------------------------ */
/* 1..N 真 http                                                       */
/* ------------------------------------------------------------------ */

async function testHttp() {
  const dir = mkdtempSync(join(tmpdir(), 'xiaoai-selftest-'))
  const storePath = join(dir, 'pending.json')
  const { pet, calls } = makePet()
  const handler = createXiaoaiHandler({ pet, secret: SECRET, storePath, waitMs: DEFAULT_WAIT_MS })
  const server = await serve(handler)
  try {
    /* 1. 文档原样报文：不认识的话术也不该崩 */
    results.push('\n[1] 文档原样报文（播放海浪的声音）')
    {
      const r = await post(server.base, docEvent('播放海浪的声音'))
      check(
        'HTTP 200 + JSON',
        r.status === 200 && r.headers.get('content-type')?.includes('application/json'),
        `${r.status} ${r.headers.get('content-type')}`,
      )
      check(
        '动作结构齐全（to_speak + not_understand + is_session_end）',
        Boolean(r.json?.response?.to_speak?.text) && r.json?.response?.not_understand === false && r.json?.is_session_end === true,
        JSON.stringify(r.json),
      )
      check('默认当成派任务，原句传给了鲸灵', calls.ask.at(-1)?.text === '播放海浪的声音', calls.ask.at(-1)?.text)
      check('回复里带上了鲸灵的原话', speakOf(r.json) === '收到：播放海浪的声音。', speakOf(r.json))
      check('等待预算被传到适配器', calls.ask.at(-1)?.opts?.waitMs === DEFAULT_WAIT_MS, String(calls.ask.at(-1)?.opts?.waitMs))
      check('未配置签名时给告警头', r.headers.get('x-warn') === 'signature-not-configured', String(r.headers.get('x-warn')))
    }

    /* 2. 派任务：剥前缀 */
    results.push('\n[2] 派任务')
    {
      const r = await post(server.base, docEvent('让鲸灵帮我看看登录报错'))
      check('唤醒词/客套话全剥掉，只留正文', calls.ask.at(-1)?.text === '登录报错', calls.ask.at(-1)?.text)
      check('有话说', Boolean(speakOf(r.json)), speakOf(r.json))
      check('is_session_end 为 true（说完即结束，不留麦）', r.json.is_session_end === true)
      check('不留麦时 open_mic = false', r.json.response.open_mic === false)
    }

    /* 2b. 派任务必须落到真回复上（回归：线上曾 3/3 干等到预算耗尽只回占位语） */
    results.push('\n[2b] 派任务念真回复')
    {
      const r = await post(server.base, docEvent('让鲸灵回复两个字：收到'))
      const spoken = speakOf(r.json)
      check('派任务念的是鲸灵的真回复', spoken.includes('收到') && spoken !== TIMEOUT_REPLY, spoken)
      check('真回复不是占位语', !spoken.includes('我记下了'), spoken)
      check('这一句确实派给了 ask', String(calls.ask.at(-1)?.text ?? '').includes('收到'), calls.ask.at(-1)?.text)
    }

    /* 3. 进度 */
    results.push('\n[3] 进度')
    {
      const r = await post(server.base, docEvent('鲸灵在干嘛'))
      check('读的是上一轮 assistant 文本', speakOf(r.json) === '上一轮我说的话。', speakOf(r.json))
      check('没有误派任务', calls.ask.length === 3, String(calls.ask.length))
    }

    /* 4. 切项目 */
    results.push('\n[4] 切项目')
    {
      const r = await post(server.base, docEvent('让鲸灵到 REA 项目干活'))
      check('调了 switchProject("REA")', calls.switchProject.at(-1) === 'REA', JSON.stringify(calls.switchProject))
      check('回了「已切到 REA。」', speakOf(r.json) === '已切到 REA。', speakOf(r.json))
    }

    /* 5. 停 */
    results.push('\n[5] 停')
    {
      before = calls.stop
      const r = await post(server.base, docEvent('停'))
      check('调了 stop()', calls.stop === before + 1, String(calls.stop))
      check('回了「好，停了。」', speakOf(r.json) === '好，停了。', speakOf(r.json))
    }

    /* 6. 空 query → not_understand */
    results.push('\n[6] 空 query')
    {
      const r = await post(server.base, docEvent('', 'sess-empty'))
      check('not_understand = true', r.json?.response?.not_understand === true, JSON.stringify(r.json))
      check('仍然给了 to_speak（否则平台判无效动作）', Boolean(speakOf(r.json)), speakOf(r.json))
      check('提示语是「没听明白」', speakOf(r.json).startsWith('没听明白'), speakOf(r.json))
    }

    /* 7. 门禁 */
    results.push('\n[7] URL 门禁')
    {
      const bad = await post(server.base, docEvent('鲸灵在干嘛'), { secret: 'wrong-secret' })
      check('错 secret → 401', bad.status === 401, String(bad.status))
      check('错 secret 不泄漏任何业务信息', bad.json?.ok === false && !bad.json?.last, JSON.stringify(bad.json))

      const none = await post(server.base, docEvent('鲸灵在干嘛'), { secret: '' })
      check('不带 secret → 401', none.status === 401, String(none.status))

      const headerRes = await fetch(`${server.base}${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-xiaoai-secret': SECRET },
        body: JSON.stringify(docEvent('鲸灵在干嘛')),
      })
      check('header 方式也放行（本地调试用）', headerRes.status === 200, String(headerRes.status))
    }

    /* 8. 连续 3 轮没听懂 → 强制收尾 */
    results.push('\n[8] 连续没听懂 3 轮强制退出')
    {
      const sid = 'sess-3round'
      const a = await post(server.base, docEvent('', sid))
      const b = await post(server.base, docEvent('', sid))
      const c = await post(server.base, docEvent('', sid))
      check('第 1 轮 not_understand', a.json.response.not_understand === true)
      check('第 2 轮 not_understand', b.json.response.not_understand === true)
      check(`第 ${MAX_NOT_UNDERSTAND} 轮收尾话术`, speakOf(c.json) === BYE_REPLY, speakOf(c.json))
      check('第 3 轮 is_session_end = true', c.json.is_session_end === true)
      check('计数已清零（下轮重新开始）', (await post(server.base, docEvent('', sid))).json.response.to_speak.text === UNKNOWN_REPLY)
    }

    /* 9. 超时 → 记 pending → 进度能补答 */
    results.push('\n[9] 超时与补答')
    {
      const slowPet = {
        ...makePet().pet,
        async ask() {
          return { text: null, timedOut: true, sessionId: 'S-SLOW', sinceSeq: 5 }
        },
        async latestFinal({ sinceSeq }) {
          return sinceSeq >= 5 ? { text: '做完了，登录按钮改好了。', seq: 12 } : { text: '还在改。', seq: 6 }
        },
      }
      const slowStore = join(dir, 'pending-slow.json')
      const slow = createXiaoaiHandler({ pet: slowPet, secret: SECRET, storePath: slowStore })
      const s2 = await serve(slow)
      try {
        const r = await post(s2.base, docEvent('让鲸灵修登录按钮'))
        check('超时回复固定话术', speakOf(r.json) === TIMEOUT_REPLY, speakOf(r.json))
        check('超时也 is_session_end = true', r.json.is_session_end === true)

        const saved = JSON.parse(readFileSync(slowStore, 'utf8'))
        check('pending.json 落了盘', Array.isArray(saved.tasks) && saved.tasks.length === 1, JSON.stringify(saved))
        check('待办记下了任务原文', saved.tasks[0]?.text === '修登录按钮', saved.tasks[0]?.text)
        check('待办记下了 sinceSeq 游标', saved.tasks[0]?.sinceSeq === 5, String(saved.tasks[0]?.sinceSeq))

        const p = await post(s2.base, docEvent('鲸灵进度'))
        check('进度补答回了真结果', speakOf(p.json) === '做完了，登录按钮改好了。', speakOf(p.json))

        const after = JSON.parse(readFileSync(slowStore, 'utf8'))
        check('补答后待办标记 done', after.tasks[0]?.state === 'done', JSON.stringify(after.tasks[0]))
      } finally {
        await s2.close()
      }
    }

    /* 10. request.type 三态 */
    results.push('\n[10] request.type 三态')
    {
      const r0 = await post(server.base, docEvent('', 'sess-type0', 0))
      check('type=0 回欢迎语', speakOf(r0.json) === greetingOf('鲸灵'), speakOf(r0.json))
      check('type=0 开麦进多轮', r0.json.response.open_mic === true)
      check('type=0 不结束会话', r0.json.is_session_end === false)
      check('type=0 不算没听懂', r0.json.response.not_understand === false)

      const r2 = await post(server.base, docEvent('随便说点什么', 'sess-type2', 2))
      check('type=2 回收尾话', speakOf(r2.json) === ENDING_REPLY, speakOf(r2.json))
      check('type=2 结束会话', r2.json.is_session_end === true)
      check('type=2 不误派任务', calls.ask.length === 3, String(calls.ask.length))
    }

    /* 11. selftest 端点不含任何 secret */
    results.push('\n[11] selftest 端点')
    {
      const res = await fetch(`${server.base}${PATH}?k=${encodeURIComponent(SECRET)}`)
      const body = await res.text()
      check('GET → 200', res.status === 200, String(res.status))
      check('不泄漏 URL secret', !body.includes(SECRET), '响应里出现了 secret')
      check('不泄漏 token 形状', !/pkv_[0-9a-f]{8}/.test(body))
      const parsed = JSON.parse(body)
      check('带最近一次事件摘要', Boolean(parsed.last?.query !== undefined && parsed.last?.intent), JSON.stringify(parsed.last))
      check('标明签名是否强制', parsed.signature === 'not-configured', String(parsed.signature))
      check('带 store 路径', typeof parsed.store === 'string' && parsed.store.includes('xiaoai'), parsed.store)
    }

    /* 12. 方法/报文健壮性 */
    results.push('\n[12] 健壮性')
    {
      const put = await post(server.base, {}, { method: 'PUT' })
      check('非 POST/GET → 405', put.status === 405, String(put.status))

      const bad = await fetch(`${server.base}${PATH}?k=${encodeURIComponent(SECRET)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      })
      const badJson = await bad.json()
      check('坏报文也回合法动作（不是 500）', bad.status === 200 && Boolean(badJson?.response?.to_speak?.text), JSON.stringify(badJson))
      check('坏报文标 not_understand', badJson.response.not_understand === true)

      const empty = await fetch(`${server.base}${PATH}?k=${encodeURIComponent(SECRET)}`, { method: 'POST' })
      check('空 body 不崩', empty.status === 200, String(empty.status))
    }
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ */
/* 13. 签名强制的真 http（照 lead 要求的三例）                           */
/* ------------------------------------------------------------------ */

async function testSignatureHttp() {
  results.push('\n[13] 签名强制（配置了 KeyId/Secret）')
  const dir = mkdtempSync(join(tmpdir(), 'xiaoai-sign-'))
  const { pet } = makePet()
  const handler = createXiaoaiHandler({
    pet,
    config: { present: true, keyId: KEY_ID, secret: SIGN_SECRET_B64, urlSecret: URL_SECRET, appId: '123' },
    storePath: join(dir, 'pending.json'),
  })
  const server = await serve(handler)
  try {
    const bodyText = JSON.stringify(docEvent('鲸灵在干嘛'))

    // ① 正确签名 → 200
    {
      const res = await fetch(`${server.base}${PATH}?k=${URL_SECRET}`, {
        method: 'POST',
        headers: signedHeaders(bodyText),
        body: bodyText,
      })
      const json = await res.json()
      check('正确签名 → 200', res.status === 200, String(res.status))
      check('正确签名能拿到动作', Boolean(json?.response?.to_speak?.text), JSON.stringify(json))
      check('签名模式下不再有告警头', res.headers.get('x-warn') === null, String(res.headers.get('x-warn')))
    }

    // ② 篡改 body（Content-MD5 还是按原 body 签的）→ 401
    {
      const tampered = bodyText.replace('鲸灵在干嘛', '把它删了')
      const res = await fetch(`${server.base}${PATH}?k=${URL_SECRET}`, {
        method: 'POST',
        headers: signedHeaders(bodyText),
        body: tampered,
      })
      const json = await res.json()
      check('篡改 body → 401', res.status === 401, String(res.status))
      check('给出的原因是 content-md5', json?.error === 'bad-content-md5', JSON.stringify(json))
    }

    // ③ 有配置但缺 Authorization / 签名错 → 401
    {
      const noAuth = await fetch(`${server.base}${PATH}?k=${URL_SECRET}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyText,
      })
      check('缺 Authorization → 401', noAuth.status === 401, String(noAuth.status))

      const wrongSig = await fetch(`${server.base}${PATH}?k=${URL_SECRET}`, {
        method: 'POST',
        headers: { ...signedHeaders(bodyText), authorization: `MIAI-HmacSHA256-V1 ${KEY_ID}:default:${'0'.repeat(64)}` },
        body: bodyText,
      })
      check('签名对不上 → 401', wrongSig.status === 401, String(wrongSig.status))
    }

    // ④ ?k= 仍然是第一道门：光有正确签名、URL secret 错也不行
    {
      const res = await fetch(`${server.base}${PATH}?k=wrong`, {
        method: 'POST',
        headers: signedHeaders(bodyText, { urlSecret: 'wrong' }),
        body: bodyText,
      })
      check('URL secret 错 → 401（两道门都要过）', res.status === 401, String(res.status))
    }
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ */

let before = 0

async function main() {
  console.log('xiaoai-selftest：小爱技能 handler 自测（本地 stub，不连真设备）\n')
  testPure()
  check('secretOf 优先取 ?k=', secretOf({ headers: {} }, new URL('http://x/pet-voice/api/xiaoai?k=abc')) === 'abc')
  check('secretOf 支持 x-xiaoai-secret', secretOf({ headers: { 'x-xiaoai-secret': 'xyz' } }, new URL('http://x/p')) === 'xyz')
  testSigning()
  await testHttp()
  await testSignatureHttp()
  console.log(results.join('\n'))
  const total = results.filter((line) => /^\s+[✓✗]/.test(line)).length
  console.log(`\nxiaoai-selftest: ${total - failures}/${total} 通过`)
  if (failures) {
    console.error(`\n有 ${failures} 个用例失败`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('selftest 崩了：', error)
  process.exit(1)
})
