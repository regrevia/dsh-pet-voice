# 手机端 ↔ `dsh-pet-voice` 接口契约（v1.2，2026-10-25；v1.2 加 `/api/render`、朗读剥离、人设/长度/气泡配置）

这份文档是**唯一**的跨端约定。背景：`dsh-pet-voice` 要作为独立插件脱离出来，插件与手机 App
各自演进——所以只允许按本文档约定的 HTTP 接口互相说话，**App 不得依赖插件内部实现**
（内部文件、内部函数、宿主 `sessionController` 的返回形状、静态资源路径等）。

所有字段、类型、错误码都**按 `plugins/dsh-pet-voice/index.js` 现有实现逐条核对**写成；
冒烟校验脚本见 [`scripts/contract-check.mjs`](../scripts/contract-check.mjs)。
若文档与实现冲突，**以实现为准并改文档**。

- 基址：`{base}/pet-voice`，其中 `{base}` 是宿主 origin（本机 `http://127.0.0.1:52356`，
  手机走隧道域名（推荐自有域名的命名隧道 `https://pet.example.com`；临时用快速隧道
  `https://xxx.trycloudflare.com`，域名每次重启都变），局域网走 `http://<内网IP>:52356`）。
  公网**必须 https**：客户端 `PetSettings.plaintextHostAllowed()` 拒绝明文 http 的公网地址。
- 除 `xiaoai*` 外**全部端点都必须鉴权**；未鉴权一律 `401`。
- 所有响应都是 UTF-8 JSON（`/api/tts` 成功时是音频流，`/api/stream` 是 SSE）。
- JSON 响应头固定 `cache-control: no-store`。

---

## 1. 鉴权与密钥

### token 从哪来

- 宿主启动插件时若 `~/.dsh/pet-voice/token` 不存在（或内容短于 16 字节），会生成
  `randomBytes(24).toString('hex')`（48 个 hex 字符）写入该文件，`chmod 600`。
- 每次请求都会 `stat` 一次 token 文件：**删掉文件 = 换密码**，下一个请求会重建并立即生效，
  App 不需要重启，只需重新配对。
- 文档、日志、截图里**一律写 `<token>` 占位，禁止出现真实 token**。需要比对「现在生效的是
  哪一把」时，用 `GET /api/state` 的 `tokenHint`（前 8 位）。

### 三种出示 token 的方式

| 方式 | 用法 | 说明 |
| --- | --- | --- |
| Cookie（App 推荐） | `Cookie: pkv_<token[0:8]>=<token>` | Cookie 名 = `pkv_` + token 前 8 位；`Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`，TLS 下额外加 `Secure`。值经过 URL encode |
| Bearer | `Authorization: Bearer <token>` | 给脚本/服务端调用用，浏览器页面不用 |
| `?k=`（**只在配对时用一次**） | `GET {base}/pet-voice/?k=<token>` | 校验通过返 `303 Location: {base}/pet-voice/` 并 `Set-Cookie`；跳转后 URL 里不再有 `?k=`。也接受别名 `?token=` |

### 配对的两种入口（都属于 core）

1. **二维码/链接**：`{base}/pet-voice/?k=<token>`，扫到就是上面那个 303 + Set-Cookie，一次完成。
2. **手输令牌**：先打开 `{base}/pet-voice/`（不带 `?k=`）会拿到一个 401 的 HTML 输入页，
   把 48 位 token 粘进去，同样种 Cookie。

`GET /api/pair`（见下）**故意不回 token**：它只回答「手机上该敲哪个地址」，配对仍靠扫码或手输。

### 不许进文档/日志的东西

`~/.dsh/pet-voice/xiaoai.json` 的 `urlSecret`、`keyId`、小爱签名密钥，以及任何 `?k=` 里的值。
文档与脚本只写 `<token>` / `<secret>` 占位。

---

## 2. core 端点（15 个，v1.2 加 `/api/render`）

手机端只依赖下面 14 个端点（第 4 节另有 core/experimental 分级）。`/api/workspaces`、`/api/switch`、`/api/command` 是 v1.1 新增，App 从 v1.1 起依赖它们。
每个端点都给出：鉴权、请求、响应、错误。

### GET /api/state

探活 + 拉一次全量上下文。App 冷启动、下拉刷新、切回前台时调。

鉴权：Cookie 或 Bearer

请求：无参数

响应 200：

```jsonc
{
  "ok": true,
  "tokenHint": "a1b2c3d4",        // string，token 前 8 位，不含完整 token
  "linkHint": "在电脑上执行 cat ... 可查看完整配对链接里的 token", // string，给用户看的提示
  "projects": [                   // Workspace[]，可能为空数组
    { "id": "string", "title": "string", "path": "string" }
  ],
  "presets": [                    // AgentPreset[]，可能为空数组
    { "id": "string", "title": "string" }
  ],
  "sessions": [                   // Session[]，最多 20 条；宿主缺失时为空数组
    {
      "id": "string",             // 必填，非空
      "title": "string",
      "cwd": "string",
      "workspaceId": "string",
      "updatedAt": "string|null"  // ISO 时间或 null
    }
  ],
  "current": null,                // Session|null，仅用于界面展示（用户最近在用的那只，已排除宠物专属会话）
  "dispatchTarget": "string|null",// 派发默认落点（宠物专属会话 id），恒等于 ~/.dsh/pet-voice/pet-session.json 里那只
  "remembered": { "<workspaceId 或 path>": "<sessionId>" }, // object，project→session 记忆
  "petSession": { /* object|null，pet-session.json 原文，实验性 */ },
  "pet": { "name": "鲸灵", "wakeWords": ["鲸灵", "小鲸", "嗨鲸灵", "hey whale", "hello whale"] },
  "xiaoai": {                     // 实验性（只用于发现，不要依赖）
    "endpoint": "/pet-voice/api/xiaoai",
    "selftest": "/pet-voice/api/xiaoai/selftest",
    "configured": true,
    "configPath": "/Users/.../xiaoai.json"
  }
}
```

错误：`401 {"ok":false,"error":"unauthorized"}`

> 约定：`current` **不参与派发**，App 不要把 `current.id` 当成派发落点；要看落点用
> `dispatchTarget`，派发时也可以显式传 `sessionId`。

### GET /api/pair

**实现是 `GET`**（任务书里写的 `POST /api/pair` 与实现不符，以实现为准）：它不创建任何东西，
只回答「手机上该用哪个地址」，所以调用方用 `GET`；用 `POST` 打会命中兜底 `404`。

鉴权：Cookie 或 Bearer

请求：无 body、无参数

响应 200：

```jsonc
{
  "ok": true,
  "publicBase": "https://pet.example.com/pet-voice/", // string，必填，以 / 结尾（快速隧道则是 https://xxx.trycloudflare.com/pet-voice/）
  "source": "tunnel",             // "tunnel" | "lan" | "local"，必填
  "tunnelAt": "https://…/pet-voice/api/xiaoai?k=<已省略>",    // string，仅 source=tunnel 时存在；k= 已被服务端替换成 <已省略>
  "alive": true,                  // boolean，仅 source=tunnel 时存在：服务端对 publicBase 探活的结果
  "note": "隧道域名可能已过期（cloudflared 重启会换域名）"      // string，仅 alive=false 时存在
}
```

`source` 三档语义（App 只用 publicBase + source + alive + note，别的都别解析）：

| source | 含义 | 手机能不能打开 |
| --- | --- | --- |
| `tunnel` | `~/.dsh/pet-voice/xiaoai-url.txt` 里记着的公网隧道域名 | 流量/别人手机都能开（`alive:false` 时说明域名过期了，提示用户重跑 `scripts/tunnel.sh`） |
| `lan` | 本机非回环 IPv4 + 宿主端口（没有隧道记录时） | 同一个 WiFi 能开，出门不行 |
| `local` | 只剩 `127.0.0.1` | 手机打不开 |

探活细节（属于实现，App 不需要知道，但写下来免得以后被当成契约）：探测目标
`publicBase + "api/pair"`，超时 1.5 s，结果缓存 30 s，同一 base 并发去重；**401/404 也算活着**
（拿不到 cookie 是正常的，有 HTTP 响应就说明隧道通）。探活失败**不会**把 `source` 降级成
`lan`——私网地址在手机上更打不开。

错误：`401 {"ok":false,"error":"unauthorized"}`

### POST /api/dispatch

把一句话派给宠物会话。**会产生真实 turn**，只读脚本不要调它。

鉴权：Cookie 或 Bearer

请求：`Content-Type: application/json`

```jsonc
{
  "text": "帮我看下 Pet 项目的 git status",  // string，必填，trim 后不能为空
  "sessionId": "session-…"                  // string，可选；缺省 = dispatchTarget（宠物专属会话），显式给了就必须存在
}
```

**实现只认 `text` + `sessionId`**，没有 `project` / `preset` 字段（任务书里问了这三个，答案是没有）：
选项目走 `POST /api/new`（`workspaceId` / `projectPath`），选人设用 `POST /api/new` 的 `preset`。

> 另外：`dispatch` 的 body 建议带 `X-Pet-TZ` 请求头会透传成 `clientTimeZone`（可选，不填也行）。

响应 200（宿主 ≥1.2 s 内就返回结果时）：

```jsonc
{ "ok": true, "accepted": true, "sessionId": "session-…", "value": null }
```

响应 202（宿主还在跑，最常见的快路径）：

```jsonc
{ "ok": true, "accepted": true, "sessionId": "session-…" }
```

**本接口不返回 turn id**；要知道这一轮什么时候开始/结束，看 `/api/stream` 的
`start`（带 `turn`/`step`）/ `final` / `end`，或 `/api/poll` 的对应帧。

错误：

- `400 {"ok":false,"error":"text 为空"}`
- `404 {"ok":false,"error":"…"}` 显式 `sessionId` 不存在
- `503 {"ok":false,"error":"宿主缺少 sessionController"}` 宿主服务缺失
- `503 {"ok":false,"error":"…"}` 取默认会话失败
- `401 {"ok":false,"error":"unauthorized"}`

### GET /api/stream

SSE 增量通道（本机/直连首选；公网隧道可能被前置代理缓冲，4 s 收不到 hello 就切 `/api/poll`）。

鉴权：Cookie 或 Bearer

请求：`?sessionId=<id>`（可选；缺省 = 宠物专属会话）

响应 200：

- 头：`content-type: text/event-stream; charset=utf-8`、`cache-control: no-cache, no-transform`、
  `connection: keep-alive`、`x-accel-buffering: no`
- 连接建立后立即写 1 行 2 KiB 的 SSE 注释（`:` 开头，按协议必须忽略，作用是把 cloudflared
  之类的缓冲打穿）＋ `retry: 1500`
- 首帧固定：`event: hello` / `data: {"sessionId":"…"}`
- 心跳：每 15 s 一行 `: hb`（注释行，不是事件）

事件表（`event:` 名 + `data:` JSON）：

| 事件 | payload | 语义 |
| --- | --- | --- |
| `start` | `{ "turn": number\|null, "step": number\|null }` | `turn/start`：一轮/一步开始。轮次号在官方事件的 `data.turn` 里（旧版读 `event.turn` 恒为 null） |
| `delta` | `{ "text": string }` | 助理增量文本，多次；用于逐字上屏 |
| `message` | `{ "text": string, "turn": number\|null }` | `assistant/message`：**过程**消息，可展示但**不是**终止——工具任务后面还会继续 |
| `tool` | `{ "name": string }` | 调了个工具 |
| `final` | `{ "text": string, "turn": number\|null }` | 本轮完整正文，**只在 `turn/end` 发** |
| `end` | `{ "reason": string, "turn": number\|null }` | 本轮**唯一**的终止信号，**只在 `turn/end` 发**；`reason` 如 `stop` |
| `error` | `{ "message": string }` | 本轮出错 |
| `say` | `{ "seq": number, "text": string, "voice": string, "at": string, "id": string }` | 全局播报（所有 SSE 订阅者都收到，不分会话），`seq` 单调递增，`id` 可能为空串 |

判定一轮结束**只看 `end`**：`final` 紧挨在 `end` 前发出，但不要用 `final` 或 `message` 判结束。
收到 `finish` 帧也不会立刻发 `end`，而是等官方 `turn/end`（否则工具任务会在「我查一下」那一句就被误判结束）。

断线语义：服务端不补发历史。客户端重连后应用 `/api/poll?cursor=-1` 先对齐，再只收新帧。
每会话的增量缓冲只保留最近 400 帧、最多 40 个会话，超出就丢最旧的——所以「断了很久再重连」
拿不到中间全部内容，只能拿最新状态。

错误：`401 {"ok":false,"error":"unauthorized"}`（鉴权在路由分发之前，返回的是 JSON 而不是 SSE）；
`503 {"ok":false,"error":"…"}`（取默认会话失败）

### GET /api/poll

SSE 的请求-响应等价物，公网兜底用。

鉴权：Cookie 或 Bearer

请求：

- `sessionId`：string，可选，缺省 = 宠物专属会话
- `cursor`：number，可选，默认 `0`；**`cursor=-1` 是「只对齐」**：返回 `frames: []` 和当前最新
  `cursor`（= `buf.seq`），用于刚接上某个会话时问「现在最新到哪了」，避免把历史当新消息重播
- `wait`：number，可选，默认 `20000` ms，服务端夹到 `[0, 25000]`；有新帧立刻返回，没有就最多等这么久

响应 200：

```jsonc
{
  "ok": true,
  "sessionId": "session-…",
  "transport": "auto", // auto | poll，跟随插件面板「传输方式」；poll = 别开 SSE，直接轮询
  "frames": [ { "seq": 12, "event": "delta", "data": { "text": "…" } } ], // 最多 200 帧，按 seq 升序
  "cursor": 12,       // number，回执用的游标；下轮原样带回来
  "done": false       // boolean，本批里出现 end/final 时为 true
}
```

`frames[].event` / `data` 与 SSE 事件表完全一致（同一套帧）。

错误：`503 {"ok":false,"error":"…"}`（取默认会话失败）、`401`

### POST /api/cancel

中断当前 turn。

鉴权：Cookie 或 Bearer

请求：`{"sessionId": "session-…"}`（可选，缺省 = 宠物专属会话）

响应 200：`{ "ok": true, "value": null }`（`value` 是宿主 `sessionController.cancel()` 的返回值，可能是 `null`）

错误：`503 {"ok":false,"error":"宿主缺少 sessionController"}`、`503`（取默认会话失败）、`401`

### POST /api/new

新会话 / 切项目。App 的「换项目」就靠它。

鉴权：Cookie 或 Bearer

请求（全部可选）：

```jsonc
{
  "workspaceId": "ef76a38a-…",   // string，可选；给了就按 workspace 建
  "projectPath": "/abs/path",    // string，可选；没有 workspaceId 时按 cwd 建
  "preset": "preset-id",         // string，可选；agentPreset
  "fresh": true,                 // boolean，可选；true = 强制真新建，不吃记忆/不复用专属会话
  "title": "给个标题"            // string，可选，仅在复用分支回显
}
```

响应 200：

```jsonc
{ "ok": true, "sessionId": "session-…", "reused": true|false, "title": "string" }
```

行为（App 要能接受这两种）：

- `workspaceId` 和 `projectPath` 都没给、且 `fresh` 不是 `true` ⇒ **直接复用宠物专属会话**
  （`reused: true`）；
- 给了 key 且 `remembered[key]` 有记录、且 `fresh` 不是 `true` ⇒ 复用记住的那只（`reused: true`）；
- 否则真建一只（`reused: false`），并把 `remembered[key]` 更新成新 id。

错误：

- `503 {"ok":false,"error":"宿主缺少 sessionController"}`
- `503 {"ok":false,"error":"…"}` 取专属会话失败
- `502 {"ok":false,"error":"创建会话失败：…"}` / `502 {"ok":false,"error":"create() 没有返回 sessionId：…"}`
- `401`

### GET /api/workspaces

给手机列项目、并回答「现在钉在哪个项目」。**别让 App 自己猜 pin**——一切以 `pinned` 为准。

鉴权：Cookie 或 Bearer

请求：无参数。

响应 200：

```jsonc
{
  "ok": true,
  "workspaces": [
    { "id": "ef76a38a-…", "title": "Pet", "path": "/abs/path/Pet", "pinned": true }
  ],
  "pinned": { "title": "Pet", "id": "ef76a38a-…", "sessionId": "session-…" }   // 从没钉过时为 null
}
```

- `workspaces` 来自宿主的项目注册表，可能为空数组，顺序不承诺。
- `pinned` 读的是 `pet-session.json` 的**现状**；只有「从来没钉过」或「那只会话已被用户删掉」时才会重建，
  并且**按原来那个项目重建**，不会因为「这次没传 title」而退回默认项目（这个坑踩过，已修）。
- 不含历史帧、不含 token、不含 sessions 列表。

错误：`401`；宿主取项目注册表失败 → `502 {"ok":false,"error":"…"}`。

### POST /api/switch

切项目：把「专属会话」重新钉到另一个项目（**只影响专属会话**，绝不碰用户其它正在跑的会话）。

鉴权：Cookie 或 Bearer

请求（二选一，都给时 `workspaceId` 优先）：

```jsonc
{ "workspaceId": "ef76a38a-…" }   // 最准，App 从 /api/workspaces 里拿
{ "title": "Envoy" }              // 也吃唯一子串/路径末段，适合语音指令
```

响应 200：

```jsonc
{ "ok": true, "title": "Envoy", "sessionId": "session-…", "workspaceId": "ef76a38a-…" }
```

行为：目标项目下已有可用专属会话就复用（同一只 id 返回），否则新建一只并写回 `pet-session.json`。
切换成功后 `GET /api/state` 的 `dispatchTarget` 立即变成新会话。

错误：

- `400 {"ok":false,"error":"title 或 workspaceId 必须给一个"}`
- `404 {"ok":false,"error":"没有这个项目: X","candidates":["A","B"]}`（`candidates` ≤ 5 个标题，便于念「你说的是 A 还是 B」）
- `502 {"ok":false,"error":"…"}`（宿主创建会话失败）
- `401`

幂等性：同一个目标连切两次，第二次复用同一只会话（`sessionId` 不变），不产生新会话。

### POST /api/command

**语音指令的唯一入口**：把识别出来的原话交给插件判断「是切项目/派任务/停，还是普通聊天」。

鉴权：Cookie 或 Bearer

请求：

```jsonc
{ "text": "切到 Envoy" }   // string，必填；>300 字先截断再解析
```

响应 200（按 `action` 分支）：

| `action` | 含义 | 附带字段 | App 该做什么 |
| --- | --- | --- | --- |
| `switch` | 已切到 `title` | `title`、`sessionId`、`say` | 只念 `say`（如「好，切到《Envoy》了」），**不要再 dispatch** |
| `switch-miss` | 没匹配到项目 | `miss`、`candidates`、`say` | 念 `say`；有 `candidates` 可追问 |
| `dispatch` | 已切到 `title` 并把 `content` 派出去 | `title`、`content`、`sessionId`、`say` | 只念 `say`，**不要再 dispatch**（否则双份） |
| `dispatch-miss` | 派发目标没匹配到 | `miss`、`candidates`、`say` | 同上 |
| `stop` | 已取消当前这轮 | `stopped`、`say` | 只念 `say`（「好，停了」） |
| `chat` | 不是指令 | `say: null` | **这时才走 `POST /api/dispatch {text}`**，回复照旧由 SSE/poll 进来 |

- `chat` 是**零副作用**：不建会话、不派发、不改 pin（`scripts/contract-check.mjs` 用 `/api/poll?cursor=-1`
  前后帧不变来断言）。
- 空文本、缺 `text`、只有标点 ⇒ 一律 `200 {action:"chat",say:null}`，**不报错**（语音误触发不该在手机上弹红字）。
- 停止词必须整句相等才认（「取消订阅」不会被当成「取消」）。
- 项目名匹配顺序：标题全等 → id 全等 → 路径末段全等 → 唯一子串；有歧义就回 `candidates`，**不瞎切**。

错误：`401`；宿主异常 → `502 {"ok":false,"error":"…"}`。

App 侧的固定流程（照这条线走，别自创）：

```
识别出文本
   └─ POST /api/command {text}
        ├─ action == "chat"          → POST /api/dispatch {text} → SSE/poll → 气泡
        └─ 其它 action               → 只念 say（+ 必要时念 candidates），结束
```

### POST /api/say

让她直接念一句（不经过模型、不产生 turn）。全局广播，所有订阅者都收到。

鉴权：Cookie 或 Bearer

请求：

```jsonc
{
  "text": "该喝水啦",   // string，必填，trim 后非空；超过 300 字截断
  "voice": "zh-CN-XiaoyiNeural", // string，可选；必须在 /api/tts/voices 的 voices[].id 里，否则回默认
  "id": "w-42"          // string，可选，≤64 字；同一 id 只念一次（幂等重试）
}
```

响应 200：

```jsonc
{
  "ok": true,
  "seq": 7,             // number，全局递增播报序号
  "queued": 3,          // number，队列当前长度（上限 20，超出丢最旧）
  "deduped": true,      // boolean，仅同一 id 重复提交时出现
  "truncated": true,    // boolean，仅超长被截断时出现
  "maxChars": 300,      // number，仅 truncated 时出现
  "dropped": 1          // number，仅队列溢出挤出时出现
}
```

错误：`400 {"ok":false,"error":"text 为空"}`、`401`

配套读接口（core，App 冷启动对齐用）：`GET /api/say?since=<seq>` ⇒
`{ "ok": true, "items": [ {seq,text,voice,at,id} ], "cursor": 7 }`；`since` 缺省或 `<0` ⇒
`items: []`，只回 `cursor=saySeq`（不回放历史）。

### GET /api/tts

合成语音，返回 **MP3 字节流**（`audio/mpeg`，边合成边吐，不攒整段）。

鉴权：Cookie 或 Bearer

**实现只注册了 `GET`**（任务书里写的 `GET/POST /api/tts` 与实现不符，以实现为准）：
`POST /api/tts` 会落到兜底 `404 {"ok":false,"error":"未知接口 POST tts"}`。

请求：**只支持 query 参数**，body 一概不读：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 待合成文本，`trim` 后非空，**≤600 字** |
| `preset` | string | 否 | 四个档位 key 之一；**给了就优先**，档位自带 voice/rate/pitch |
| `voice` | string | 否 | `voices[].id` 之一，默认 `zh-CN-XiaoyiNeural`；给了 preset 时 preset 的 voice 覆盖它 |
| `rate` | string | 否 | 形如 `+6%` / `-4%` / `0%`，服务端只认 `^[+-]?\d{1,3}%$`，否则回落 |
| `pitch` | string | 否 | 形如 `+8Hz` / `-12Hz`，只认 `^[+-]?\d{1,3}Hz$`，否则回落 |

响应 200：`content-type: audio/mpeg`，`cache-control: no-store`，`x-accel-buffering: no`，body 是完整 MP3。

错误：

- `400 {"ok":false,"error":"text 为空"}`
- `400 {"ok":false,"error":"text 过长（N > 600 字）","maxChars":600}`
- `400 {"ok":false,"error":"未知音色档位：xxx","presets":["whale","genki","gentle","cool"]}`
- `400 {"ok":false,"error":"未知音色：xxx","voices":["zh-CN-XiaoyiNeural", …]}`
- `503 {"ok":false,"error":"神经语音还没装好","hint":"在电脑上运行 plugins/dsh-pet-voice/tts/setup.sh…"}`
- `502 {"ok":false,"error":"神经语音合成失败","hint":"<stderr 尾部>"}`
- `401`

### GET /api/tts/voices

音色/档位清单。App 的下拉框**只从它取**，不要硬编码 label。

鉴权：Cookie 或 Bearer

请求：无参数

响应 200：

```jsonc
{
  "ok": true,
  "ready": true,                 // boolean，venv 与合成脚本都在才算装好
  "default": "zh-CN-XiaoyiNeural",// string
  "defaultPreset": "whale",      // string
  "presets": [                   // 四档，顺序固定；这是 core 的 key 列表
    { "id": "whale",  "label": "鲸灵 · 清亮少女（默认）", "voice": "zh-CN-XiaoyiNeural",  "rate": "+6%",  "pitch": "+8Hz"  },
    { "id": "genki",  "label": "元气 · 语速快、调门高",   "voice": "zh-CN-XiaoyiNeural",  "rate": "+16%", "pitch": "+22Hz" },
    { "id": "gentle", "label": "温柔 · 慢一点、低一点",   "voice": "zh-CN-XiaoxiaoNeural","rate": "-4%",  "pitch": "-4Hz"  },
    { "id": "cool",   "label": "清冷 · 更慢、更低",       "voice": "zh-CN-XiaoxiaoNeural","rate": "-10%", "pitch": "-12Hz" }
  ],
  "voices": [                    // 7 个白名单音色（edge-tts zh-CN）
    { "id": "zh-CN-XiaoyiNeural", "label": "小艺 · 活泼少女（默认）" }, /* … */
  ],
  "hint": "神经语音还没装：运行 plugins/dsh-pet-voice/tts/setup.sh" // string，仅 ready=false 时出现
}
```

四档的差异（就是 `voice` + `rate` + `pitch` 三元组，不是四个不同音色）：

| key | voice | rate | pitch | 听感 |
| --- | --- | --- | --- | --- |
| `whale` | `zh-CN-XiaoyiNeural` | `+6%` | `+8Hz` | 默认，清亮少女 |
| `genki` | `zh-CN-XiaoyiNeural` | `+16%` | `+22Hz` | 快而高、元气 |
| `gentle` | `zh-CN-XiaoxiaoNeural` | `-4%` | `-4Hz` | 慢一点、低一点 |
| `cool` | `zh-CN-XiaoxiaoNeural` | `-10%` | `-12Hz` | 更慢更低、清冷 |

错误：`401`

> 与 Android `Settings.kt` 的 `PRESETS` 对齐：`whale / genki / gentle / cool` 四个 key 必须
> 完全一致（`scripts/contract-check.mjs` 会去正则读 `Settings.kt` 并断言）。

### GET /api/xiaoai

小爱同学（小米手机自定义技能）的语音通道入口，**不走 Cookie**：小米服务器既没有我们的
cookie 也不会带自定义 header，它的门禁是「URL 里的 `?k=` + MIAI-HmacSHA256-V1 签名」。

与手机端的关系（App 只需要知道这么多）：

- 它是**另一个入口**，和 App 共用同一个宿主和同一个宠物会话（同一人设、同一记忆）；
- 手机端**不需要**调用它，也不该解析它的响应；App 要是想「让小爱也能用」，只要保证
  `/api/pair` 的 `tunnelAt` 是活的就行（小爱技能配置填的就是那个地址）；
- 密钥（`urlSecret`、`keyId`、签名密钥）全部在 `~/.dsh/pet-voice/xiaoai.json`，**不进本契约、
  不进日志、不进文档**。

错误：签名/`?k=` 不对时由 `xiaoai.mjs` 自己返 4xx（形状见该模块），不影响 App。

---

### POST /api/render（v1.2 新增，core）

把一段 Markdown 渲染成 App 可直接塞进 WebView 的 HTML 片段。**服务端渲染**，App 不要自己
再实现一套（两边的转义规则不一致就会出 XSS）。

请求：`{"text": "**结论**：改完了。\n\n- 第一点\n- 第二点"}`（≤ 20000 字）

成功：
```json
{ "ok": true, "html": "<p><strong>结论</strong>：改完了。</p><ul><li>第一点</li><li>第二点</li></ul>" }
```

支持：段落、`**粗**`、`*斜*`、`` `行内代码` ``、`~~删除线~~`、`#`~`######`（降级为 h3/h4/h5）、
有序/无序列表（一层嵌套）、`>` 引用、``` 围栏（`<pre><code class="language-xxx">`）、
GFM 表格、`http(s)` 链接（`target="_blank" rel="noopener noreferrer"`）、`---` 水平线。

安全约束（App 可以依赖）：
- 先转义 `& < > " '` 再渲染，原文 HTML 一律当文字，产出里不会出现 `script`/`img`/`iframe`；
- 链接只放行 `http://`、`https://`，其它 scheme（`javascript:`、`data:`）降级成纯文字；
- 只产出白名单标签：`p strong em del code pre h3 h4 h5 ul ol li table thead tbody tr th td blockquote hr a br`。

错误：`401`；`400` `text 为空` / `text 过长（N > 20000 字）`。
GET 不注册（`未知接口 GET render` 404 属正常，别用 GET）。

### 朗读文本：`stripForSpeech`（v1.2 新增，core 行为）

`/api/tts` 和 `/api/say` 在合成/入队**之前**会先把 Markdown 剥成可朗读文本，所以：

- App 把 assistant 原文直接喂给 `/api/tts` 时，听到的是剥离后的文本，不会念出「星号星号」；
- 剥掉：代码围栏（整段不念）、表格分隔行（单元格用「，」连）、链接只留文字、裸 URL 念「链接」、
  标题/引用/列表/任务框的标记、强调/行内代码/删除线的符号；换行变「，」，空行变「。」；
- 幂等：对已经干净的文本再剥一次，结果不变；
- 剥离后为空 ⇒ `400 text 为空（剥离 Markdown 后没有可朗读内容）`，App 应跳过这一条而不是重试。

App 侧若自己有一段流式朗读（`public/app.js` 的 `cleanForSpeech`），规则与服务端一致；围栏未闭合时
围栏内文本不朗读。

### 配置项（v1.2 新增，面板 ↔ 插件）

配置存在 `~/.dsh/pet-voice/panel.json`，网页面板走 `GET/POST /pet-voice/panel/state`（只放行回环地址）。
App 只读 `/api/state` 里的 `settings`：

```json
{
  "settings": {
    "maxWords": "短",      // 短 | 中 | 长（默认 短）
    "bubble": true,        // App 开口气泡的默认值
    "transport": "auto",   // auto | poll（只在网络挡 SSE 时才需要手动锁轮询）
    "hasPersona": false    // 是否配过自定义人设（App 只做展示/开关用，别读正文）
  }
}
```

字段语义：

| 字段 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `persona` | string（≤2000 字，保留换行） | `""` | 自定义人设，挂进该会话的 system prompt（隐藏），不进对话正文、不逐条重复 |
| `maxWords` | `短` / `中` / `长` | `短` | 派发 prompt 的 `【输出要求】` 行（80 字 / 300 字 / 可展开） |
| `bubble` | boolean | `true` | App 是否默认显示对话气泡 |
| `wakeName` | string | `大肥鱼` | 唤醒词 |
| `transport` | `auto` / `poll` | `auto` | `auto` = App 先开长连接、拿不到 hello 再转轮询；`poll` = 直接锁轮询，不开流 |
| `mode` | `lan` / `domain` / `server` | `lan` | 配对链接用的传输方式；`server` 是作者体验档，开源版默认不用 |
| `customUrl` | string（http(s)） | `""` | `domain` 档的地址，插件自动补到 `/pet-voice/` |

POST 任一子集即落盘并回完整快照（同 GET）。非法值 `400`：`输出长度只能选短、中、长`、
`模式只能选服务器、局域网或自建域名`、`自定义地址要是 http(s) 开头`、`传输方式只能选自动或轮询`。

### 语音指令流程（v1.2 补齐）

```
识别文本 ──► POST /api/command {text}
               │
               ├─ action: "switch"       切到某项目（say 播报，不派发）
               ├─ action: "switch-miss"  项目没匹配上（say + candidates，不建会话）
               ├─ action: "dispatch"     已排进队列（say + sessionId/title）
               ├─ action: "dispatch-miss" 项目没匹配上，未派发
               ├─ action: "stop"         停当前会话
               └─ action: "chat"         闲聊 —— 这时 App 才调 POST /api/dispatch
```

规则：`action === "chat"` 才走 `/api/dispatch`；其它动作只念 `say`（`say === null` 时静默）。
`/api/command` 空文本返回 `action:"chat"`（语音误触不该弹红字）。

---

## 3. core 之外的端点

这些是**内部/自由度更大**的接口，App 不要依赖：

| 端点 | 说明 |
| --- | --- |
| `GET /api/link` | 回完整配对链接（含 `<token>`）。只有已带 cookie 的人能取，用于「换台手机/发给另一台设备」。**不要在 UI 上展示原始 token**；`/api/state` 永远只给前 8 位 |
| `GET /api/selfcheck` | 宿主能力自检（sessionController/workspaceRegistry/agentPresets/tts…），给排障用 |
| `GET /pet-voice/assets/<file>` | 静态资源（`index.html`/`app.js`/`pet.js`/`style.css`/`icon.svg`/`manifest.webmanifest`），**不鉴权**，路径不承诺稳定 |
| `GET /api/say?since=` | 已在 `/api/say` 一节写成 core |

---

## 4. 稳定性分级

只有 **core** 字段是 App 可以硬依赖的；改动 core 必须改本文件版本号并通知 App。
**experimental** 字段可能随时改/删，App 必须容忍缺失。

| 端点 / 字段 | 级别 | 备注 |
| --- | --- | --- |
| 鉴权：Cookie 名 `pkv_<前8位>`、Bearer、401 body | core | 401 body 固定 `{"ok":false,"error":"unauthorized"}` |
| `state.ok` / `state.tokenHint` / `state.pet.name` / `state.pet.wakeWords` | core | |
| `state.projects[].id/title/path` | core | 数组可能为空 |
| `state.presets[].id/title` | core | |
| `state.sessions[].id/title/cwd/workspaceId/updatedAt` | core | `id` 非空；最多 20 条 |
| `state.current.id` | core（只读展示） | **不参与派发** |
| `state.dispatchTarget` | core | 派发默认落点 |
| `state.remembered` | experimental | 只用于「上次用哪只」的展示 |
| `state.petSession` | experimental | 原文透传 |
| `state.linkHint` | experimental | 纯文案，别解析 |
| `state.xiaoai.*` | experimental | 发现用 |
| `pair.ok/publicBase/source/tunnelAt/alive/note` | core | `alive`/`note` 只在 `tunnel` 档出现；`note` 文案可能微调，别做等值判断 |
| `dispatch.ok/accepted/sessionId` | core | 200/202 都可能，两种都要接受 |
| `dispatch.value` | experimental | 宿主返回值直传 |
| `stream` 事件 `hello/start/delta/final/end/tool/say/error` + 上表 payload | core | 新增事件名必须容忍（忽略未知事件） |
| `poll.frames[].seq/event/data`、`poll.cursor`、`poll.done` | core | 未知 `event` 忽略 |
| `poll` 的 `wait` 上限 25000 / 每批 200 帧 | core | 截断属正常 |
| `cancel.ok` | core | `cancel.value` experimental |
| `new.sessionId/reused` | core | `title` experimental |
| `workspaces.workspaces[].id/title/path/pinned` | core | 数组可能为空 |
| `workspaces.pinned.{title,id,sessionId}` | core | 可能为 `null`（从没钉过） |
| `switch.ok/title/sessionId/workspaceId`、`switch` 的 400/404 形状 | core | `candidates` ≤ 5；404 的 `error` 文案可能微调，别做等值判断 |
| `command.ok/action/say` + 各 action 附带字段 | core | 未知 `action` 一律当 `chat` 处理（前向兼容） |
| `say.seq/queued/deduped/truncated` | core | `dropped`/`maxChars` experimental |
| `tts` 音频 `audio/mpeg` | core | 字节流的**具体码率/时长不承诺** |
| `tts/voices.presets[].id`（四个 key） | core | 与 `Settings.kt` 的 `PRESETS` 必须一致 |
| `tts/voices.presets[].label/rate/pitch/voice` | core（只读） | App 只展示，不要自己拼 |
| `tts/voices.voices[].id` | core | 白名单，可能增减 ⇒ App 用 `default` 兜底 |
| 静态资源路径、`/api/link`、`/api/selfcheck`、`/api/xiaoai*` | experimental | 不属于 App 契约 |

---

## 5. 「独立插件」的实质

- 手机端只通过 HTTP 访问上表 **14 个 core 端点**：`state`、`pair`、`dispatch`、`stream`、
  `poll`、`cancel`、`new`、`workspaces`、`switch`、`command`、`say`、`tts`、`tts/voices`、`xiaoai`。
- 不依赖：插件内部文件名、内部状态文件（`pet-session.json` / `state.json` / `xiaoai-url.txt`）、
  宿主的 `sessionController` / `workspaceRegistry` / `agentPresets` 内部形状、静态资源路径、
  SSE 的注释/心跳细节、`?k=` 之外任何带 token 的 URL。
- 反过来插件也可以换实现（换 TTS、换隧道、换存储），只要这 14 个端点的 core 字段不变，
  App 不用改一行。
- 版本策略：破坏 core ⇒ 本文档升 `v2` 并在 `docs/` 留迁移说明；只加可选字段/新增事件名
  ⇒ 保持 `v1`（App 必须忽略未知字段与未知事件）。

---

## 6. 冒烟校验

```bash
PV_PORT=52356 node scripts/contract-check.mjs      # 只读，不调 dispatch/say/cancel
```

它会（不打印 token）：未鉴权 GET 是否 401 → `/api/state` 字段齐全 → `/api/tts/voices` 四档 key
与 `Settings.kt` 的 `PRESETS` 一致 → 四个档位各合成一次（字节数 > 5000 且 `content-type: audio/*`）
→ `/api/poll?cursor=-1` 结构可解析 → `/api/pair` 结构且不泄漏 `k=` → `/api/stream` 能收到
`hello` 帧。输出 `通过 N/共 M`，任一失败退出码非 0。

---

## 7. 与任务书（2026-10-24 下午）的四处分歧 —— 一律以实现为准

写这份文档时按代码逐条核过，任务书里有四处与实现不同，已按实现写进上文，并在下面单独列出：

1. **`/api/pair` 是 `GET`，不是 `POST`**。`POST /api/pair` 会落到兜底
   `404 {"ok":false,"error":"未知接口 POST pair"}`。
2. **`/api/tts` 只注册了 `GET`**（任务书写「GET/POST」）。`POST /api/tts` 同样 `404`；
   body 一概不读，参数全在 query。
3. **`/api/dispatch` 没有 `project` / `preset` 字段，也**不返回 turn id**。请求体只有
   `text`（必填）+ `sessionId`（可选）；想知道某一轮从哪开始/结束，用 `stream` 的
   `start`/`final`/`end` 或 `poll` 的帧（`start` 里带 `turn`/`step`）。选项目/人设走 `/api/new`。
4. **`dispatch` 成功有两种状态码**：宿主在 1.2 s 内返回 ⇒ `200`；否则先回 `202`（更常见）。
   App 必须把两者都当成功，不能只判 `200`。

另外两处「任务书没提、但实现有」的细节，也一并写进了上文：`poll` 的 `wait` 上限是 25 s
（不是无限），`/api/say` 的 `GET` 用 `since` 对齐（`since` 缺省或 `<0` 不回放历史）。
