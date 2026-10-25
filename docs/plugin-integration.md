# DSH 插件集成路径与手机端安全上下文约束

> 证据来源：本机 `~/.dsh/profiles/desktop/node_modules/`（dsh-pet 0.3.8、@linxin666/dsh-remote-web-ui 0.4.8）与 DSH 0.2.1-rc.2 随包源码（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/`）。行号对应当前磁盘文件。

## 0 结论速览

1. **最小结构**：一个 npm 包同时挂两侧。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`（一行 `insert`），`dsh.client` 让同一包被扫成浏览器插件；一个 entry 同时装宿主半侧与客户端半侧。
2. **服务名是 `ctx.webServer`**，不是 `ctx.webserver`：`dsh-host-webserver/lib/index.js:287` 即 `super(ctx, "webServer")`，`inject` 写 `"webServer"`。
3. **与 dsh-pet 并列做新插件**：`petApi7340` 只暴露 `balance`，聊天/人设/记忆无对外接口，fork 无收益。
4. **手机端**：局域网 `http://192.168.x.x` **拿不到 getUserMedia**；cloudflared 隧道 https **可行**；自签证书 **不推荐**；Android WebView `onPermissionRequest` **不是绕过**。
5. **安全**：语音 API 注册在 `/api/` 前缀下即落进 remote-web-ui 的门控通道（`/api/` → `/remote`），未配对 403；宿主再加一次 `ctx.connection.admit(req)`；API key 永不下发。

## 1 最小可运行骨架（只存档，不安装）

```
dsh-pet-voice/
├─ package.json
├─ cordis.patch.yml
├─ src/host/index.ts      # 宿主半侧：路由 + LLM
├─ src/client/index.ts    # 浏览器半侧：必须是副作用脚本
├─ src/client/entry.tsx   # 插槽组件（可选）
└─ lib/                   # 构建产物 index.js / client.js
```

### 1.1 package.json

```json
{
  "name": "dsh-pet-voice",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": ["@deepseek-ai/dsh-client-connection"], "platform": "web" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-host-webserver": "^0.2.0-rc.1",
    "@deepseek-ai/dsh-client-connection": "^0.2.0-rc.1",
    "@deepseek-ai/dsh-llm": "^0.2.0-rc.1",
    "@deepseek-ai/dsh-agent-default-model": "^0.2.0-rc.1",
    "@deepseek-ai/dsh-credentials": "^0.2.0-rc.1",
    "@deepseek-ai/dsh-client-ui-slots": "^0.2.0-rc.1",
    "react": "^18.2.0"
  }
}
```

`exports["."]` 是宿主入口、`exports["./client"]` 是浏览器入口（`dsh-pet/package.json` 同款）。升级入口加 `uuid`/`zod` 不必照搬。

### 1.2 cordis.patch.yml

```yaml
- insert:
    - id: dsh-pet-voice
      name: 'dsh-pet-voice'
```

两个必踩坑（见 `dsh-pet/cordis.patch.yml` 注释）：`id` 必须全局唯一且等于包名；`id:` 那一行**绝不能带行尾注释**，否则商城预检 `check-plugin-submission.mjs` 抓不到 entry ID，整份提交判 `SUBMISSION_ENTRY_MISSING`。

### 1.3 宿主半侧 `src/host/index.ts`

```js
export const name = 'pet-voice'
export const inject = ['webServer', 'connection', 'llm', 'agentDefaultModel', 'credentials']

export function apply(ctx) {
  // 页面：静态 HTML、不含秘密。导航请求不经官方准入，故这里不鉴权
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/pet-voice',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return void res.writeHead(405, { allow: 'GET, HEAD' }).end()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE_HTML)
    },
  }), 'pet-voice: page')

  // API：挂在 /api/ 下 → 手机侧被改写到 /remote，未配对直接 403
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/pet-voice',
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req) // Host/Origin 围栏 + 浏览器/API 凭据
      if ('rejection' in admission)
        return void res.writeHead(admission.rejection, { 'content-type': 'application/json' })
          .end('{"error":"unauthorized"}')
      if (req.method !== 'POST' || !req.url.endsWith('/chat'))
        return void res.writeHead(404).end()
      const { text } = JSON.parse(await readBody(req))
      const reply = await chat(ctx, text)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ reply }))
    },
  }), 'pet-voice: api')
}

async function chat(ctx, text) {
  const sel = ctx.agentDefaultModel.currentSelection() // { provider, model, reasoningEffort? }
  let out = ''
  for await (const chunk of ctx.llm.stream({
    provider: sel.provider,
    model: sel.model,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  })) {
    if (chunk.type === 'text-delta') out += chunk.text
  }
  return out // 只要文本；要完整结构化输出用 @deepseek-ai/dsh-llm 的 BlockAssembler
}
```

### 1.4 浏览器半侧

```ts
// src/client/index.ts —— 普通副作用脚本：不能有顶层 import/export
import { makeFactory } from './entry'

window.__ModuleLoader__.load({ id: 'dsh-pet-voice', factory: makeFactory() })
```

```ts
// src/client/entry.tsx
export function makeFactory() {
  return (require) => {
    const { jsx: h } = require('react/jsx-runtime')
    const name = 'pet-voice'
    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register(
          { name: 'shell.overlay', id: 'pet-voice', order: 1001 },
          () => h('button', { onClick: () => window.open('/pet-voice', '_blank') }, '随身宠物'),
        )
      })
    }
    return { name, inject, apply }
  }
}
```

插槽注册范式见 `dsh-pet/src/client/app.ts:171-172`；`name/inject/apply` 由 `__ModuleLoader__` 消费，见同包 `src/client/index.ts`。

### 1.5 页面里的采音

```html
<button id="mic">按住说话</button>
<script>
  mic.onclick = async () => {
    if (!window.isSecureContext) return alert('不是安全上下文：' + location.origin)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // MediaRecorder → Blob → fetch('/api/pet-voice/chat')
  }
</script>
```

## 2 LLM 与 HTTP 路由

- **服务名**：`ctx.webServer`（`:287`）。`register({kind:'exact'|'prefix', path, handler})`（`:327`）返回 disposer，必须用 `ctx.effect(() => ..., 'label')` 包住；重复 `(kind,path)` 抛错；`registerUpgrade`（`:341`）挂 WebSocket；`registerFallback`（`:356`）**不要碰**——已被官方 SPA 静态服务独占，再注册直接抛。
- **匹配顺序**：exact → 最长 prefix → fallback（`dsh-host-webserver/README.zh.md:62`），所以 `/api/pet-voice` 能压过官方 `/api` 前缀。
- **handler 是裸 Node `req/res`**（`writeHead/end`），没有 Express 语义；`PORT`/`host`/`protocol` 读 `:294-306`，本机根地址用 `getOrigin()`（`:315`）。参照实现：`dsh-pet/lib/index.js:5675`、`dsh-experimental-inspector/lib/index.js:2423`。
- **绑定地址**：`host` 只收具体 IP 字面量，通配地址加载即拒（`:252-258`，理由是"绑定全部接口等于把 RCE 暴露到网络"）；对外暴露只能靠隧道。
- **LLM**：`inject` 加 `llm`、`agentDefaultModel`、`credentials`。`ctx.llm.stream({provider, model, messages})` 以 `finish` 收尾（`dsh-llm/README.zh.md:40-60`）；默认模型取 `ctx.agentDefaultModel.currentSelection()`；密钥在宿主侧经 `ctx.credentials.resolve(...)` 解析，不下发。

## 3 与 dsh-pet 的关系

- **唯一公开 seam**：`ctx.provide("petApi7340", { balance: { register, list } })`（`dsh-pet/lib/index.js:3757`）。`register` 返回 disposer、id 撞车抛 `Error`；`list()` 返回 `{builtin, external}`。除余额外没有聊天、人设、记忆接口。
- **人设/记忆不可复用**：`whisperPrompt`、`chatMemoryRounds` 走 `config.jsonc`，历史落 `memory.json`，没有 Cordis 服务导出。硬读 `$DSH_HOME/dsh-pet/` 私有文件可行但脆弱，不建议。
- **建议并列做新插件**，三条理由：① 升级安全——pet 0.3.8 的内部符号不是 API，fork 后每次上游发版都要手工合并；② 手机竖屏适配层会把 `data-dsh-plugin` 归属的桌面插件（含宠物）一律隐藏（remote-web-ui `README.zh.md:42`），语音入口本就要自己的 UI；③ 需要联动的余额，用 `petApi7340.balance.register` 一个 provider 就够。

## 4 手机端约束

| 页面来源 | 安全上下文 | getUserMedia |
| --- | --- | --- |
| `http://127.0.0.1:3080`、`http://localhost:3080` | 是 | 可用 |
| `http://192.168.x.x:3080`（局域网直连） | **否** | **不可用** |
| `https://*.trycloudflare.com`（cloudflared 快速隧道） | 是 | 可用 |
| `https://<id>.dsh-market.com`（remote-web-ui 中继） | 是 | 可用 |
| `https://192.168.x.x` 自签证书 | 取决于浏览器信任 | 不推荐 |
| WebView + `onPermissionRequest` | 仍由页面源决定 | 不能绕过 |

- **局域网明文 HTTP 必失败**。非安全上下文里 `navigator.mediaDevices` 是 `undefined`，`getUserMedia` 抛 `TypeError`（[MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)）。remote-web-ui 自己也写："纯 HTTP 的局域网源永远不是安全上下文"（`README.zh.md:185`，源码 `src/routes.ts:302`）。
- **隧道可行**。`autoTunnel` 用随包分发的 cloudflared 起快速隧道，无需账号域名（`README.zh.md:51`）；手工等价 `cloudflared tunnel --url http://127.0.0.1:3080`（`:116`）。代价：`trycloudflare.com` 每次重启换域名（`:191`）；要固定就上中继 `https://<id>.dsh-market.com`，但流量经作者在 Cloudflare 边缘的 Worker（`:192`，可见性等同 Cloudflare 本身）。
- **自签证书不推荐**。规范上 `https` 属 potentially trustworthy（[MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)），但浏览器先给证书错误页，iOS 还得安装并信任描述文件；"扫码即用"的用户不会干这个。仅限自己调试。
- **WebView 不是绕过**。`WebChromeClient.onPermissionRequest` 只是把"准不准用设备"交给宿主 App 批准，不改变页面源的可信级别；`http://` 在 WebView 里同样不是安全上下文，`getUserMedia` 依旧不存在。真正能救的是换源：`WebViewAssetLoader` 的 `https://appassets.androidplatform.net`，或 `adb reverse tcp:3080 tcp:3080` 后用 `http://localhost:3080`（localhost 属安全上下文）。这两条都不是"让局域网 IP 变安全"。
- **推荐路径**：开发期 `adb reverse` + `http://localhost:3080/pet-voice`；交付期用 remote-web-ui 隧道 https 打开 `/pet-voice`。不要为语音去改 webserver 的绑定。

## 5 安全

- **配对设备是 full-control 凭据**（`README.zh.md:179`）：可达 host API 全部能力，撤销按请求生效。语音接口不能比 `/remote` 更宽。
- **自定义 route 不走官方准入**。`/api` 的 Host/Origin 围栏与浏览器认证是 connection 插件在自己路由里做的，插件 handler 不自动继承。反例：`dsh-pet` 的 `/dsh-pet-7340` 路由内**没有任何凭据校验**（`lib/index.js:5675-5693`），一旦绑到局域网就对该网段全开。正确做法两条一起上：
  1. 路径落在 `/api/` 前缀下，借用 remote-web-ui 的改写（`src/remote-channel-rules.ts` 的 `apiPrefix: '/api/'`）→ 手机请求变成 `/remote`，先过配对门（未配对 403）。
  2. handler 第一行 `ctx.connection.admit(req)`（`dsh-client-connection/lib/index.js:742`）：Host 必须 loopback/绑定 IP/trustedHosts、Origin 同源、`sec-fetch-site: cross-site` 拒绝，浏览器 cookie 或 API cookie 缺一不可；升级连接用 `ctx.connection.requestRejection(req)`（`:737`）。
- **API key 不下发**：密钥只经 `ctx.credentials` → `ctx.llm` 在宿主进程内解析，前端只拿文本结果。不要发明 `Authorization` 头把 key 存在浏览器，也不要写进 HTML/JSON。
- **不新增暴露面**：不注册 `registerFallback`；`host` 保持回环，对外只走隧道；语音音频上传沿用同一条 `/api/pet-voice` 前缀，同样先 `admit`。

## 6 施工顺序

1. 建包 → `cordis.patch.yml` → 本地 link 进 profile 验证加载（先别上商城）。
2. 宿主侧跑通 `/pet-voice` 静态页与 `/api/pet-voice/chat` 的两条拒绝分支（`curl` 验 401/403）。
3. 桌面浏览器验 LLM 回包 → `adb reverse` 手机验 `isSecureContext` 与麦克风。
4. 隧道 https 复测，未配对设备必须 403。
5. 最后接余额联动（`petApi7340.balance.register`）。
