# 手机端 ↔ `dsh-pet-voice` 接口契约（v1.8，2026-10-26；v1.8 面板「音色」接成默认音色（不再只存不用）、`/api/state` 下发 `pet.wakeName` 与 `settings.voice`、`/api/tts` 的 voice 优先级按实现改正；v1.7 加 `/api/upload`、`/api/file`（视频 + Range）、`/api/diag`、dispatch `attachments`/`requestId`/`queued`/`origin`、错误码总表、面板配置生效时机；v1.6 工具行改成桌面那种「标签 · 详情」一行（协议不变）；v1.5 对话页去掉分割线；v1.4 旁听材料改走隐藏提示词、`/api/session` 加 `peek`；v1.3 加 dispatch 旁听材料；v1.2 加 `/api/render`、朗读剥离、人设/长度/气泡配置）

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

### 设备上限与 429（v1.7 补）

每条 `/api/*` 请求都会把调用方记成一台活跃设备（按 token 指纹）。超过面板「设备上限」时
**比任何路由都早**返回：

```json
{"ok":false,"code":"device-limit","maxDevices":2,"error":"这台电脑最多连 2 台设备，先在面板里移出一台"}
```

- `maxDevices` 是当下生效的上限，随时可从面板改（下一次请求就按新值判）。
- App 收到 429 `device-limit` 应提示「去面板移出一台」，**不要退避重试**：重试只会继续 429。

### 不许进文档/日志的东西

`~/.dsh/pet-voice/xiaoai.json` 的 `urlSecret`、`keyId`、小爱签名密钥，以及任何 `?k=` 里的值。
文档与脚本只写 `<token>` / `<secret>` 占位。

---

## 2. core 端点（v1.7 加 `/api/upload`、`/api/file`；v1.2 加 `/api/render`）

手机端只依赖下面这些端点（第 4 节另有 core/experimental 分级）；v1.7 起附件走 `POST /api/upload` 落盘 + `GET|HEAD /api/file` 取字节，两节都属 core。`/api/workspaces`、`/api/switch`、`/api/command` 是 v1.1 新增，App 从 v1.1 起依赖它们。
每个端点都给出：鉴权、请求、响应、错误。

### GET /api/state

探活 + 拉一次全量上下文。App 冷启动、下拉刷新、切回前台时调。

鉴权：Cookie 或 Bearer

请求：无参数

响应 200：

```jsonc
{
  "ok": true,
  "pluginVersion": "1.7.0",       // App 用它判断插件够不够新
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
  "peek": { "title": "…" },       // object|null，5 分钟内旁听过别的会话时给个标题，过期 null
  "turns": { "<sessionId>": { "since": 1690000000000 } }, // 只有「正在跑」的会话在里面，空对象 = 全空闲
  "petSession": { /* object|null，pet-session.json 原文，实验性 */ },
  "pet": {
    "name": "鲸灵",              // string，插件 config.petName
    "wakeName": "大肥鱼",        // string，面板填的唤醒词（默认「大肥鱼」），App 可当自己的默认唤醒词
    "wakeWords": ["鲸灵", "小鲸", "嗨鲸灵", "hey whale", "hello whale"] // string[]，宿主侧常量，不含 wakeName
  },
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
>
> `POST /api/state` 也存在（写面板配置后回同一份快照），但那是面板用的；**手机侧只读 GET**。

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
  "text": "帮我看下 Pet 项目的 git status",     // string，trim 后使用；**可以只带附件不带文字**
  "attachments": ["/abs/a.jpg", "/abs/b.mp4"], // string[]，可选，绝对路径，最多 6 个（见下）
  "sessionId": "session-…",                   // string，可选；缺省 = dispatchTarget（宠物专属会话），显式给了就必须存在
  "requestId": "r-8f3c1a"                     // string，可选；截前 12 位，120 s 内同 id 只落一轮
}
```

**实现只认 `text` / `attachments` / `sessionId` / `requestId`**，没有 `project` / `preset` 字段（任务书里问了这三个，答案是没有）：
选项目走 `POST /api/new`（`workspaceId` / `projectPath`），选人设用 `POST /api/new` 的 `preset`。

> 另外：`dispatch` 的 body 建议带 `X-Pet-TZ` 请求头会透传成 `clientTimeZone`（可选，不填也行）。

响应 200（宿主 ≥1.2 s 内就返回结果时）：

```jsonc
{
  "ok": true, "accepted": true,
  "sessionId": "session-…",
  "usedSessionId": "session-…",   // 宿主实际落点，排查「发出去没进那只会话」只看它
  "value": null,                  // 宿主 prompt 的返回值直传
  "attachments": 2,               // number，实际带上路的附件个数（不是列表）
  "queued": false                 // true = 电脑端那轮还在跑，这句排在它后面
}
```

响应 202（宿主还在跑，最常见的快路径）：

```jsonc
{
  "ok": true, "accepted": true,
  "sessionId": "session-…", "usedSessionId": "session-…",
  "attachments": 2, "queued": false
}
```

**本接口不返回 turn id**；要知道这一轮什么时候开始/结束，看 `/api/stream` 的
`start`（带 `turn`/`step`）/ `final` / `end`，或 `/api/poll` 的对应帧。

错误：

- `400 {"ok":false,"error":"text 为空"}` —— 既没文字也没附件
- `400 {"ok":false,"error":"最多带 6 个附件"}` / `附件路径为空` / `附件路径必须是绝对路径：<path>` / `附件不存在：<path>`
- `404 {"ok":false,"error":"会话不存在：<sessionId>"}` 显式 `sessionId` 不存在 —— App 见到应清掉本地钉住的指针
- `502 {"ok":false,"error":"<宿主 prompt 的原始报错>"}` 派发过程中宿主抛错
- `503 {"ok":false,"error":"宿主缺少 sessionController"}` / `专属会话不可用` —— **绝不回退到「界面当前会话」**
- `401 {"ok":false,"error":"unauthorized"}`

#### 附件（v1.7：图片 + 视频）

- 上限 **6 个**，超了直接 400，**不截断、不静默丢弃**。
- 每个路径必须是**绝对路径**且**当次存在**；任一条不合格，整句在受理前就 400（不会「发一半」）。
- 派发正文 = 用户原话 + 每附件一行，格式固定 `[图片] <绝对路径>` / `[视频] <绝对路径>`；
  多段之间空行分隔。类型只看扩展名：`mp4` / `mov` / `m4v` → 视频，其余 → 图片。
- 附件行**只给模型看**，不上屏：手机气泡里仍只有用户原话。
- 视频不做抽帧、不转码：宿主只把路径写进提示词，模型要看内容自己调工具读。

#### origin、queued 与「掐上一轮」（v1.7 写清）

- `origin` = 「这一帧属于哪一轮」，取值 `pet`（手机派的）或 `desktop`（电脑上跑的），
  随 `start/delta/tool/message/final/end` 帧下发。**App 见到非 `pet` 的整帧丢弃**，
  所以 `queued` 帧故意不带 `origin`，只带 `{"ahead":"desktop"}`。
- 上一轮也是手机派的：**直接掐掉**（主人再开口就是要新的那句），并立刻清活记号 + 把收尾兜底压到 2 s，
  不让手机干等满 90 s。
- 上一轮是电脑端的：**不掐**，交给宿主排队，回执 `queued:true`。
  电脑上正干的活不能因为手机插一句就没了。
- `200` vs `202` 的唯一区别：宿主在 1.2 s 内有没有返回 `value`。两种都是「已受理」。
- `turn/end` 是**唯一**终止信号；`final` 只是「这一轮最后一句」，后面可能还有 `tool`/`end`。

#### 旁听：只读看一眼同项目里另一只（v1.4 重做，插件行为，不改协议）

v1.3 把材料拼在派发正文后面，结果手机对话里出现了「用户：…【旁听材料…】」这种系统腔，
记录里也留了下来。v1.4 起材料**只进隐藏提示词**，正文永远是用户原话；面板「人设 → 旁听」
三档（`ask` 问进展时 / `always` 每一句 / `off` 关，默认 `ask`）。

手机钉的那只用来聊天，但人常想知道「另一边开发到哪了」。往开发会话里发一句会打断
正在跑的活，所以插件**只读**，不 dispatch、不 append、不抢 `current`：

- 触发：看面板 `旁听` 档位。`off` 从不看；`always` 每句都看；`ask`（默认）要 `text` ≤400 字
  且命中「进展 / 进度 / 做到哪（一步）/ 卡在哪 / 最近在干（做、忙）/ 最近怎么样 / 现在怎么样 /
  下一步」。命中才做，普通聊天不花这份钱。
- 看谁：**绑定的那只所在项目里、最近活跃的另一只**（按 `updatedAt` 倒序，排除绑定的
  那只自己）。项目归属先认 `workspaceId`，没有就按 `cwd` 反查。
- 看什么：那只会话转录的最后 30 条（`sessionDetail`，压成「用户：/助手：/（用了 xx）」
  三行式，总量 ≤2600 字，只留尾部）+ 项目 `cwd` 的 `git log --oneline -12`、
  `git status --short`、`git diff --stat`（总量 ≤1200 字，读不到就只给对话）。
- 怎么给：材料拼成一段【旁听·不属于这条对话】…，``syncHiddenPrompt`` 写进这只会话的
  `systemPrompt` 隐藏段（`pet-persona`），和材料一起交代「只当背景、没有就说没看到、别解释
  你怎么看到的」。**不进 dispatch 正文**，所以手机气泡、会话记录里都只有用户原话。
- 同项目里没有第二只时（一个人在一个项目里干活）：退一步只看绑定会话 `cwd` 的代码现状，
  标题写「你这个项目的代码」，「进展怎么样」照样答得出动到哪了。
- 手机怎么知道在旁听：`GET /api/session` 在 5 分钟内有材料时多一个 `peek: { title, at }`，
  App 在标题下显示一行「在旁听：<标题>」，过期自动收起。
- 转录干净：`/api/session` 的 `messages` 不再包含宿主回合注入的上下文（`Time sampled while
  preparing turn…`、`Current runtime context.…`、`<system-reminder>…`、`<available_skills>`），
  历史上的旁听尾巴（两种头一行 `【旁听·…】`／`【旁听材料：`）按标记切掉。
- 工具行：会话详情页（「看这只对话的原文」）把 `tool` 消息排成桌面那种一行——
  `› 运行命令 · git log --oneline -15`，前面是指令名（运行命令／读取文件／修改文件／搜索／
  查找文件／读取网页／子代理／待办／代理列表），`·` 后面是它干的活（命令、路径、查询词，
  优先取工具自己的 `description`），一行截断、**不展开**。参数是没解开的大段 JSON 时只留标签。
  转录里仍是原始 `tool: { name, args }`，排版只发生在手机显示层。
- 消息是懒加载的：进详情页只要最新 20 条（`/api/session?limit=20`），滑到顶出现「加载更早」，
  点了才带 `before=<最早一条的 seq>` 去服务端要上一页（并发保护：读取中再点无效）。
- 不变的部分：`/api/dispatch` 的入参、响应、落点全不变；404/去重/掐上一轮等逻辑不动。
  旁听失败只记一行日志，这句话照原样发出去。
- 实测（2026-10-26 10:32）：手机问「最近进展怎么样」→ 落点仍是绑定的
  `session-70f5abc2…`，`dispatch status=200 … 1219ms`，提示词里出现旁听段落，回复引用了
  另一只会话的未提交改动（`index.js +179`）——那部分只有旁听材料里有。
- 边界：关键词是启发式（「进度条」这类也会命中，只多花一次读）；只有同项目、最近活跃
  的那一只，多只并行时看不到其他的；转录理解靠模型，看不懂的会直说没看到。

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
| `end` | `{ "reason": string, "turn": number\|null }` | 本轮**唯一**的终止信号，**只在 `turn/end` 发**；`reason` 如 `stop`。只有 `turn/end` 90 秒没来、且这一轮已不在跑（或超过 5 分钟硬上限）才有兜底 `end` |
| `error` | `{ "message": string }` | 本轮出错 |
| `say` | `{ "seq": number, "text": string, "voice": string, "at": string, "id": string }` | 全局播报（所有 SSE 订阅者都收到，不分会话），`seq` 单调递增，`id` 可能为空串 |

判定一轮结束**只看 `end`**：`final` 紧挨在 `end` 前发出，但不要用 `final` 或 `message` 判结束。
收到 `finish` 帧也不会立刻发 `end`，而是等官方 `turn/end`（否则工具任务会在「我查一下」那一句就被误判结束）。
只为「`turn/end` 根本没来」留了兜底：`finish` 后 90 秒还没等到 `turn/end` 才发 `end`；但这期间只要这一轮
还活着（收到过 `turn/start`、没收到 `turn/end`——长工具步骤就是这样），就继续等，直到 5 分钟硬上限。
这一轮还活着却提前发 `end`，手机就会把还在生成的一轮当成结束：正文只播到一半、气泡停在半句
（2026-10-25 晚上只剩一个「看」就是这个），`logs/turn.log` 里会记一行 `end-hold`。

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
  "frames": [ { "seq": 12, "event": "delta", "data": { "text": "…", "origin": "pet" } } ], // 最多 200 帧，按 seq 升序
  "cursor": 12,       // number，本批**最后一帧**的 seq；积压超 200 帧也不会跳帧
  "more": false,      // true = 还有没发完的帧，立刻再拉一次，别等到下一轮空转
  "gap": false,       // true = 400 帧环形缓冲把中间某帧挤掉了，明确告诉客户端「你漏了」
  "done": false       // 只有本批真的出现 end 帧才为 true；final 不算终止
}
```

`frames[].event` / `data` 与 SSE 事件表完全一致（同一套帧），包括 `origin` 与 `queued`。

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
| `preset` | string | 否 | 档位 key 之一（见 `/api/tts/voices` 的 `presets`）；给了就带上档位自带的 voice/rate/pitch |
| `voice` | string | 否 | `voices[].id` 之一。**优先级（v1.8 按实现写）**：`voice` 参数 > `preset` 自带 voice > 面板存的 `voice`（须在白名单）> 常量默认 `zh-CN-XiaoyiNeural` |
| `rate` | string | 否 | 形如 `+6%` / `-4%` / `0%`，服务端只认 `^[+-]?\d{1,3}%$`，否则回落 |
| `pitch` | string | 否 | 形如 `+8Hz` / `-12Hz`，只认 `^[+-]?\d{1,3}Hz$`，否则回落 |

响应 200：`content-type: audio/mpeg`，`cache-control: private, max-age=86400`，`x-accel-buffering: no`，
`x-tts-cache: hit|miss`（宿主有小句缓存，命中时毫秒级返回），body 是完整 MP3。

错误：

- `400 {"ok":false,"error":"text 为空"}`
- `400 {"ok":false,"error":"text 过长（N > 600 字）","maxChars":600}`
- `400 {"ok":false,"error":"未知音色档位：xxx","presets":["whale","genki","gentle","cool","sweet","dongbei"]}`
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
  "presets": [                   // 六档，顺序固定；前四个 key 是 core（App 必需），后两个是加档
    { "id": "whale",   "label": "鲸灵 · 清亮少女（默认）", "voice": "zh-CN-XiaoyiNeural",           "rate": "+6%",  "pitch": "+8Hz"  },
    { "id": "genki",   "label": "元气 · 语速快、调门高",   "voice": "zh-CN-XiaoyiNeural",           "rate": "+16%", "pitch": "+22Hz" },
    { "id": "gentle",  "label": "温柔 · 慢一点、低一点",   "voice": "zh-CN-XiaoxiaoNeural",         "rate": "-4%",  "pitch": "-4Hz"  },
    { "id": "cool",    "label": "清冷 · 更慢、更低",       "voice": "zh-CN-XiaoxiaoNeural",         "rate": "-10%", "pitch": "-12Hz" },
    { "id": "sweet",   "label": "软糯 · 更高更慢（撒娇）", "voice": "zh-CN-XiaoyiNeural",           "rate": "-6%",  "pitch": "+24Hz" },
    { "id": "dongbei", "label": "东北俏皮 · 自带喜感",     "voice": "zh-CN-liaoning-XiaobeiNeural", "rate": "+10%", "pitch": "+10Hz" }
  ],
  "voices": [                    // 7 个白名单音色（edge-tts zh-CN）
    { "id": "zh-CN-XiaoyiNeural", "label": "小艺 · 活泼少女（默认）" }, /* … */
  ],
  "hint": "神经语音还没装：运行 plugins/dsh-pet-voice/tts/setup.sh" // string，仅 ready=false 时出现
}
```

各档的差异（就是 `voice` + `rate` + `pitch` 三元组，不是六个不同音色）：

| key | voice | rate | pitch | 听感 |
| --- | --- | --- | --- | --- |
| `whale` | `zh-CN-XiaoyiNeural` | `+6%` | `+8Hz` | 默认，清亮少女 |
| `genki` | `zh-CN-XiaoyiNeural` | `+16%` | `+22Hz` | 快而高、元气 |
| `gentle` | `zh-CN-XiaoxiaoNeural` | `-4%` | `-4Hz` | 慢一点、低一点 |
| `cool` | `zh-CN-XiaoxiaoNeural` | `-10%` | `-12Hz` | 更慢更低、清冷 |
| `sweet` | `zh-CN-XiaoyiNeural` | `-6%` | `+24Hz` | 软糯撒娇 |
| `dongbei` | `zh-CN-liaoning-XiaobeiNeural` | `+10%` | `+10Hz` | 东北话、俏皮 |

错误：`401`

> 与 Android `Settings.kt` 的 `PRESETS` 对齐：前四个 key `whale / genki / gentle / cool` 必须
> 与服务端 `presets` 的前四项逐位一致（App 只认这四档）；服务端后续可以往后追加档位
> （现在多了 `sweet` / `dongbei`），`scripts/contract-check.mjs` 按「前四项对齐 + 四档必备 key 都在」断言。

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

### POST /api/upload（v1.7 新增，core：附件）

`POST /pet-voice/api/upload?name=<文件名提示>`，**body 是原始字节，不是 multipart**。

鉴权：Cookie 或 Bearer

#### 类型判定：content-type 定扩展名，文件头定真假

| content-type | 落盘扩展名 | kind |
| --- | --- | --- |
| `image/jpeg` / `image/png` / `image/webp` / `image/gif` | `jpg` / `png` / `webp` / `gif` | `image` |
| `video/mp4` | `mp4` | `video` |
| `video/quicktime` | `mov` | `video` |
| `video/x-m4v` / `video/m4v` | `m4v` | `video` |

- 文件头校验：图片认 PNG / GIF / WebP / JPEG magic；视频认 ISO-BMFF 容器族
  （偏移 4 的 box 类型 ∈ `ftyp|moov|mdat|free|wide|skip|pnot`），**不按 brand 白名单**
  （新录的 `.mov` 也得过）。小于 12 字节认不出类型 → 415。
- 声明与实际不一致 → `415 文件内容和类型对不上（声明为视频）` / `（声明为图片）`。

#### 上限与落盘

| kind | 上限 | 超限文案 |
| --- | --- | --- |
| `image` | 12 MiB | `图片太大（上限 12 MB）` |
| `video` | 200 MiB | `视频太大（上限 200 MB）` |

先看 `content-length`，超了直接 413（不收字节）；读的时候再按 kind 限额兜一层。
落盘优先 `<项目根>/.pet-uploads/`（自动写进 `.git/info/exclude`，不污染 `git status`），
项目根不可写时退到 `~/.dsh/pet-voice/uploads/`。
文件名 = `<name 前缀>-<yyyyMMdd-HHmmss>-<6 位随机>.<ext>`；`?name=` 只当前缀，不参与路径。

响应 200：

```jsonc
{ "ok": true, "path": "/abs/.pet-uploads/x.mp4", "name": "x.mp4", "bytes": 8388608, "kind": "video" }
```

`path` 直接拿去 `/api/dispatch` 的 `attachments`。

错误：

- `400 文件是空的` / `读不到请求体`
- `413` 按 kind 的超限文案
- `415 只支持图片（JPG / PNG / WebP / GIF）和视频（MP4 / MOV / M4V）`
- `415 认不出这个文件的格式（…）`
- `415 文件内容和类型对不上（声明为视频|图片）`
- `500 附件没存下来`（两个目录都写不了）

### GET|HEAD /api/file（v1.7 新增，core：附件）

`GET|HEAD /pet-voice/api/file?path=<绝对路径>`。

鉴权：Cookie 或 Bearer

校验顺序：空 → `400 path 为空`；非绝对 → `400 path 必须是绝对路径`；含 `..` 段 →
`400 path 不能包含 ..`；扩展名不在媒体白名单 → `415`；不存在 → `404 文件不存在`；
不是普通文件 → `404 不是普通文件`；超 kind 上限 → `413`。

响应头（200 与 206 都有）：

```
content-type: <媒体类型>
accept-ranges: bytes
cache-control: private, max-age=600
x-content-type-options: nosniff
content-length: <本次字节数>
```

- **HEAD 不回 body，但头要全**（含 `content-length` / `accept-ranges`），App 用它探大小、决定能不能续播。
- 无 `Range` → `200` 全量。图片整块读；视频走 `createReadStream`，不整块进内存。
- 单段 `Range` → `206` + `content-range: bytes <s>-<e>/<size>`；支持 `bytes=-N` 后缀写法。
- 多段 `Range` → 不解析，回 `200` 全量（不实现 multipart/byteranges）。
- `Range` 超界 → `416`，body `{"ok":false,"error":"Range 超出文件大小"}`，
  头带 `content-range: bytes */<size>`（播放器靠它知道文件到底多大）。
- 不支持 `If-Range`：不看日期/ETag，只要 Range 合法就给 206。

### GET /api/diag（v1.7 新增，experimental）

现场诊断，只读，不改状态。

鉴权：Cookie 或 Bearer

```jsonc
{
  "ok": true,
  "streams": ["session-…", "*"],                     // 当前挂着的 SSE 订阅键
  "events": [ { "at": 1690000000000, "kind": "dispatch", "data": { } } ] // NET_LOG 最后 200 条
}
```

`kind` ∈ `dispatch` / `dispatch-interrupt` / `dispatch-cancel` / `dispatch-queued` / `poll` /
`stream-open` / `stream-close` / `upload` / `peek` / `turn-start` …
不含 token，正文只截前若干字。

### 错误码总表（v1.7）

| 码 | 含义 | 典型接口 |
| --- | --- | --- |
| 400 | 参数/请求体不合法（空文本、附件路径、`path` 非法、空文件） | dispatch / upload / file |
| 401 | 没通过 cookie/Bearer 鉴权 | 全部 `/api/*` |
| 404 | 会话不存在 / 文件不存在 / 不是普通文件 / 未知接口 | dispatch / file / 任意 |
| 413 | 附件或文件超出该 kind 上限 | upload / file |
| 415 | 类型不支持 / 内容与声明不一致 / 认不出格式 | upload / file |
| 416 | `Range` 超界，带 `content-range: bytes */<size>` | file |
| 429 | 设备数超上限（`code:"device-limit"`） | 全部 `/api/*` |
| 500 | 未捕获异常，body 带 `route` 字段 | 全部 |
| 502 | 宿主 prompt / 切换项目失败 | dispatch / switch / command |
| 503 | 宿主缺 `sessionController`、专属会话不可用、TTS 未就绪 | dispatch / poll / tts |

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
    "voice": "zh-CN-XiaoyiNeural", // 面板「音色」：App 没自己选音色时按它发 voice=<这个值>
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
| `wakeName` | string | `大肥鱼` | 面板填的唤醒词，通过 `/api/state.pet.wakeName` 下发；宿主不做唤醒匹配（匹配在 App 里），App 拿它当默认值 |
| `transport` | `auto` / `poll` | `auto` | `auto` = App 先开长连接、拿不到 hello 再转轮询；`poll` = 直接锁轮询，不开流 |
| `mode` | `lan` / `domain` / `server` | `lan` | 配对链接用的传输方式；`server` 是作者体验档，开源版默认不用 |
| `customUrl` | string（http(s)） | `""` | `domain` 档的地址，插件自动补到 `/pet-voice/` |
| `maxDevices` | number | `2` | 最多同时绑几台设备；超了 `/api/*` 直接 429 |
| `voice` | string | `zh-CN-XiaoyiNeural` | 面板「音色」（edge 音色 id），**当默认音色用**：`/api/tts` 没收到 `voice` 参数、`preset` 也没带 voice 时就用它合成；同时通过 `/api/state.settings.voice` 下发给 App |
| `ttsProvider` | `edge` / `local` / `http` | `edge` | 语音来源，每次 `/api/tts` 现读 |
| `ttsUrl` | string | `""` | `http` 档的接口地址 |
| `ttsVoice` | string | `""` | `local` / `http` 档的音色 |
| `peek` | `ask` / `always` / `off` | `ask` | 旁听档位，每次 dispatch 现读 |
| `newReasoning` | string | `""` | 新建会话用哪档推理；**只影响之后新建的会话** |

POST 任一子集即落盘并回完整快照（同 GET）。非法值 `400`：`输出长度只能选短、中、长`、
`模式只能选服务器、局域网或自建域名`、`自定义地址要是 http(s) 开头`、`传输方式只能选自动或轮询`。

### 面板改完什么时候生效（v1.7 README 节）

面板「保存」= `POST /pet-voice/panel/state` → 写 `~/.dsh/pet-voice/panel.json`（mode 0600）。
**宿主没有「启动时快照配置」的缓存：`getPanelConfig()` 每次都重新读文件。**
所以「要不要重载插件」不是问题；问题是**哪个请求会去读它**，以及 App 什么时候再拉一次。

#### 下一次请求就生效（不用刷新、不用重连、不用重载）

| 面板项 | 生效点 |
| --- | --- |
| 人设 `persona` | 每次 `/api/dispatch` 现读并 `syncHiddenPrompt` 重写隐藏提示 → **下一句话**就带上 |
| 长度档 `maxWords` | 同上，随隐藏提示词一起重写 |
| 旁听 `peek` | 每次 dispatch 现读 → 下一句话 |
| 语音来源 `ttsProvider` / 地址 `ttsUrl` / 本机音色 `ttsVoice` | 每次 `/api/tts` 现读 → 下一句合成 |
| 音色 `voice`（v1.8） | 每次 `/api/tts` 现读，作为「没点名 voice、preset 也没带 voice」时的默认音色 → 下一次不带档位的合成立刻用它；App 只要先读 `/api/state.settings.voice` 再按它发 `voice`，App 侧也立刻生效 |
| 唤醒词 `wakeName`（v1.8） | 通过 `/api/state.pet.wakeName` 下发 → App 下次拉 state 就能读到；宿主本身不做唤醒匹配 |
| 设备上限 `maxDevices` | 每次请求 `touchDevice` 执行；改了之后多出来的设备下一次请求就 429 |
| 传输方式 `transport` | `/api/poll` 每次现读（回给 App 的 `transport` 字段）；`/api/state.settings.transport` 也现读。App 下一次 poll/state 就按新值走 |
| 气泡 `bubble` | 只通过 `/api/state.settings.bubble` 下发 → App 下次拉 state 生效 |
| 新会话推理档 `newReasoning` | 只在**新建会话**时用 → 影响之后新建的会话，已在的会话不变 |

#### 需要重新扫码 / 重新配对（不是重载插件）

| 面板项 | 原因 |
| --- | --- |
| 连法 `mode`、自建域名 `customUrl` | `panelState()` 每次现算 `modes` 和 `pairingUrl`，所以**新生成的二维码/链接立刻是新地址**；但已配对的那台手机把旧地址存在自己那边，要切到新地址得重新扫一次（或重新配对） |

#### 面板上已无「改了没反应」的字段（v1.8）

v1.7 时 `voice` / `wakeName` 属于只落盘回显的假开关；v1.8 已接上：
`voice` 进 `/api/tts` 的默认音色，`wakeName` 进 `/api/state.pet.wakeName`。
面板里其余字段都落在上面两张表（即时生效 / 需重新扫码）里，没有留死控件。

#### 例外：小爱技能配置

`~/.dsh/pet-voice/xiaoai.json` 在插件 `apply()` 时读一次并建 handler（`xiaoaiHandler`），
**运行期改这个文件必须重载插件才生效**（面板 `xiaoai.configured` 也据此）。
这是唯一一处「改文件必须重载」的配置。

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
| `state.pet.wakeName` / `state.settings.voice`（v1.8） | core | 面板值下发：App 没自己选唤醒词/音色时当默认 |
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
| `dispatch.usedSessionId` | core | 实际落点 |
| `dispatch.attachments` | core | number，实际带上的附件个数 |
| `dispatch.queued` | core | true = 排在电脑端那轮之后 |
| 附件上限（图 12 MB / 视频 200 MB）、`[图片]`/`[视频]` 行格式 | core | 改上限或格式必须升版本号 |
| `upload.ok/path/name/bytes/kind` | core | `path` 可直接当 `attachments` 用 |
| `file` 的 `accept-ranges` / `206` / `content-range` / `416` + `bytes */size` | core | 断点续播与视频拖动依赖这三样 |
| `poll.more` / `poll.gap` / `poll.transport` | core | App 据此决定「立刻再拉」还是「漏帧」 |
| `state.settings.*` | core | 面板快照，App 当默认值用 |
| `state.turns` | experimental | 只有「正在跑」的会话会出现 |
| `diag.streams/events` | experimental | 排障用，字段随意改 |
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
