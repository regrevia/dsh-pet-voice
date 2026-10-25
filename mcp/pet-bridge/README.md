# README — 鲸灵 MCP 桥 (pet-bridge)

把「鲸灵」在 **DSH** 里的能力（切项目、派任务、看状态、停回合）包装成标准
**MCP（Model Context Protocol, JSON-RPC 2.0）** 工具，任何 MCP 客户端都能调用。

零第三方依赖，Node ≥ 20（本机 Node 24 实测）。写作用域：`mcp/pet-bridge/`。

```
mcp/pet-bridge/
├── server.mjs      服务端（stdio + 可选 Streamable HTTP）
├── selftest.mjs    自测：spawn 自己的 stdio server 真跑 JSON-RPC
└── README.md       本文件
```

---

## 1. 架构：为什么是「当宿主插件的 HTTP 客户端」

本机已有宿主插件 **`dsh-pet-voice`**，它挂在 DSH 的 webServer 上提供
`/pet-voice/` 页面和一组 JSON/SSE 接口。所以本服务端**不碰 DSH 内部 RPC**，
只充当它的 HTTP 客户端：

```
MCP 客户端 ──stdio/HTTP──▶ pet-bridge ──HTTP+cookie──▶ 127.0.0.1:<port>/pet-voice/api/*
                                                          (dsh-pet-voice 宿主插件)
```

**选择理由**：这是任务书里方案 (b) 的变体——宿主自己已经把能力暴露成 localhost HTTP 端点，
比逆推 DSH 的 WebSocket RPC 稳得多：协议面小、随 DSH 版本升级不易断、无需 cookie 之外的握手。
上表就是我们依赖的**全部协议**（见 §5）。

---

## 2. 注册到 MCP 客户端

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "pet-bridge": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/Pet/mcp/pet-bridge/server.mjs"],
      "env": {
        "PET_BASE": "http://127.0.0.1:<PORT>"
      }
    }
  }
}
```

> `PET_BASE` 可省略（会自动探测）。**不要**在这里写 `PET_TOKEN`——默认直接读
> `~/.dsh/pet-voice/token`，配置文件里不该出现密钥。

### 任何支持 MCP 的客户端（stdio）

```json
{
  "mcpServers": {
    "pet-bridge": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/pet-bridge/server.mjs"]
    }
  }
}
```

### HTTP 模式（Streamable HTTP）

```bash
node server.mjs --http 7788      # 默认 7788；只绑 127.0.0.1
```

客户端配置 `http://127.0.0.1:7788/mcp`。健康检查：`GET /healthz`。

- `POST /mcp`，`Accept: application/json` → 单个 JSON 响应
- `Accept: text/event-stream` → 单条 SSE 帧（`event: message`）后关闭
- 纯通知（`notifications/initialized` 等）→ `202 Accepted`
- 只想给本机以外的进程用：设置 `PET_HTTP_TOKEN`，请求需带 `Authorization: Bearer <token>`。
  **公网暴露前必须**同时加 TLS 反向代理与 token。

---

## 3. 工具表

> **硬约束**：任何工具都不会把任务派到「界面当前会话」。`pet_ask` 的唯一目标是专属会话
> `~/.dsh/pet-voice/pet-session.json` 里钉死的那只，或调用方显式传入的 `sessionId`；
> 两者都没有时直接报错，不会回落到界面会话、也不会读 `remembered`。

| 工具 | 参数 | 作用 | 何时用 |
|---|---|---|---|
| `pet_status` | — | 宿主是否在线、当前会话/项目、项目与预设清单、最近活动会话 | 问「鲸灵现在怎么样 / 在哪个项目」；切项目前先拿准确名单 |
| `pet_switch_project` | `name` (string, 必填) | 切到指定工作区（`new{fresh:false, workspaceId}`）；专属会话已在该项目则不新建。返回 `sessionId`/`workspaceTitle` | 「切到 Pet 项目」。`name` 可用标题（不区分大小写）、目录名、唯一子串或 id |
| `pet_ask` | `text` (必填), `mode` (`queue`\|`steer`), `wait_ms` (0–300000, 默认 45000), `sessionId?` | 投递给专属会话或显式 `sessionId`，**尽量**等回复 | 「让鲸灵做 X」。超时会返回「已受理，回复稍后到」而不是报错 |
| `pet_new_session` | `project?`, `preset?` | 新建会话；该项目已有专属会话时**复用不新建**。返回 `sessionId`/`workspaceTitle` | 「开个新会话 / 换个话题重来」；`pet_ask` 报「没有目标会话」时用它 |
| `pet_stop` | — | 取消当前会话正在跑的这一轮 | 「停 / 别说了 / 打断」 |
| `pet_say` | `text` (必填) | `POST /pet-voice/api/say` 入队，手机页面在线时念出来 | 「跟手机说句话 / 让它念一遍」。返回 `seq`/`queued`；宿主旧版本（无该路由）如实 `isError`，见 §6 |

工具描述、`inputSchema` 都是给模型看的，`additionalProperties: false`，多余参数直接
`-32602`；枚举/长度/范围都在 schema 里，模型侧可提前自查。

### 典型调用顺序

```
pet_status → pet_switch_project{name:"Pet"} → pet_ask{text:"修一下构建"} → （需要时）pet_stop
```

---

## 4. 端口探测与排错

**解析顺序**：

1. 环境变量 `PET_BASE`（如 `http://127.0.0.1:58686`）——设了就只用它
2. `~/.dsh/pet-voice/state.json` 里的 `port` / `base` / `origin` / `url` 字段（若存在）
3. 常见候选端口：`127.0.0.1:58686`、`62981`、`3080`
4. `~/.dsh/remote-web-ui-tunnel-child.json` 中 `command` 字符串里的 `127.0.0.1:<port>`
5. 环境变量 `PET_PORT`

对每个候选打 `GET /pet-voice/api/state`（1.5s 超时），第一个返回 `200` 且 `ok:true` 的胜出。

> 端口每次启动 DSH 都可能变，所以**别写死**。真正稳定的是 `~/.dsh/remote-web-ui-tunnel-child.json`
> 里的 command（cloudflared 目标地址就是当前端口）。

**报错对照**：

| 现象 | 原因 | 处理 |
|---|---|---|
| `探测不到「鲸灵」宿主：所有候选端口都没响应` | DSH 没开 / 插件没启用 | 打开 DSH；确认 `dsh-pet-voice` 插件启用；或显式设 `PET_BASE` |
| detail 里某个端口 `鉴权失败` | token 轮换过 | 重启 DSH 让 `~/.dsh/pet-voice/token` 刷新，或重设 `PET_TOKEN` |
| detail 里 `该端口没有 /pet-voice/api/state` | 那个端口是别的服务 | 正常，忽略；看下一个候选 |
| `找不到访问令牌` | 文件不存在 | 设 `PET_TOKEN`，或确认 `~/.dsh/pet-voice/token` 可读（0600） |
| `已受理，回复稍后到` | SSE 断流/超时 | **消息已经投进去了**，不要重发；稍后用 `pet_status` 或网页端查看 |
| `PET_BASE` 写成 `…/pet-voice` → 全 404 | 探测会拼 `${PET_BASE}/pet-voice/api/state` | **`PET_BASE` 只写到服务根**：`http://127.0.0.1:52356`（【实测 2026-10-24】带 `/pet-voice` 时 15/18、3 SKIP；改回根 18/18） |

自测：

```bash
node selftest.mjs              # 默认全离线：pet_say 走本地 mock，pet_ask 不派发（1 SKIP）
PET_LIVE=1 node selftest.mjs   # 只有加它才真打宿主（GET state + 一次 dispatch 到专属会话）
node selftest.mjs --strict     # 要求宿主可达（SKIP 记 FAIL）
node selftest.mjs --no-reply   # 兼容旧参数；现在默认就不打宿主，无需再加
```

末行格式：`selftest: N/M 通过`。

---

## 5. 依赖的宿主协议（供排查用）

所有请求都要 cookie：`pkv_<token 前8位>=<token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/pet-voice/api/state` | `{ok, projects[], presets[], sessions[], current, remembered, pet}` |
| POST | `/pet-voice/api/new` | `{workspaceId?, projectPath?, preset?, fresh?}` → `{ok, sessionId, reused}` |
| POST | `/pet-voice/api/dispatch` | `{text, sessionId?, workspaceId?, projectPath?, preset?}` → `{ok, accepted:true}` |
| GET | `/pet-voice/api/stream?sessionId=` | SSE：`hello` / `start` / `delta{text}` / `tool{name}` / `final{text}` / `end{reason}` / `error{message}` |
| POST | `/pet-voice/api/cancel` | `{sessionId}` |
| GET | `/pet-voice/api/selfcheck` | 宿主自检 |

**两个实测坑（已在代码里规避）**：

1. **`/api/state` 响应体自带一个 `token` 字段** —— 本服务端对所有上游数据做 `redact()`，
   输出前抹成 `<redacted>`。
2. **SSE 必须在 `dispatch` 之前订阅**，否则会漏掉整轮。`pet_ask` 先建流再派发。
   另外帧**可能不以空行收尾**（`end` 和 `final` 会挤在同一 chunk 且末尾无 `\n\n`），
   解析器在「遇到新 `event:` 行」和「流结束」时都补一次 flush。
3. `/api/stream` 有 `retry: 1500` 和 `: hb` 心跳；无会话时只发 `hello` 不回错误帧，
   所以**不要靠 stream 判断会话是否存在**——先查 `state.current`。

---

## 6. pet_say：入队播报，需手机页面在线

`pet_say` 真调用宿主的 `POST /pet-voice/api/say`（body `{"text": ...}`），宿主把话放进播报队列，
**手机页面在线时**念出来；成功返回 `{"ok":true,"seq":N,"queued":N,"note":...}`（`seq` 是播报序号，
可用于 `GET /pet-voice/api/say?since=<seq>` 对账）。

**依赖宿主 ≥ 新版本（有 `/api/say`）。** 老宿主的该路由是 404，此时 `pet_say` 如实返回
`isError: true`（「宿主不支持播报…需要升级」），绝不假装成功；`ECONNREFUSED` / 401 也各有明确文案。
手机不在线时消息留在队列里，等页面回来再念。

### 最近一次实测（2026-10-24 18:32 +08，宿主已改 `/api/dispatch` 落点隔离后）

| 项目 | 结果 |
|---|---|
| `PET_LIVE=1 node selftest.mjs` | **18/18 通过**（0 SKIP / 0 FAIL），`pet_ask` 真往返收到「桥已连通」（【实测 2026-10-24】`PET_BASE=http://127.0.0.1:52356`） |
| 落点核对 | `state.dispatchTarget` = `session-edfae6ec…` = `pet-session.json`；`state.current` 全程是另一只（`session-1ee3a310…`，cwd `…/DSH`），前后不变，该会话帧里对标记文本命中 **0** |
| `pet_say`（经 MCP stdio） | 端到端 **175 ms**（含 Node 启动 + MCP 握手；单次工具调用本身约 90 ms），返回 `seq=1, queued=1, delivered=true` |
| 入队对账 | `GET /pet-voice/api/say?since=0` → `{seq:1, text:"鲸灵播报自测，桥已接通", voice:"zh-CN-XiaoyiNeural", at:"2026-10-24T10:32:29.219Z"}` |
| 手机端是否真念出来 | **未证实**（本机没有开放 CDP 端口，取不到页面侧 `speechSynthesis` 证据）；只能确认已入队且 TTS ready（`selfcheck.tts.ready=true`，7 个音色） |

> 复测时只跑一轮 `PET_LIVE=1`：它会真发一次 `pet_ask` 到专属会话。

---

## 7. 安全说明

- **只绑 127.0.0.1**。HTTP 模式 listen 在 `127.0.0.1`，CORS 只放行 `http://127.0.0.1`。
- **令牌只在内存里**：从环境变量 `PET_TOKEN` 或 `~/.dsh/pet-voice/token`（0600）读入；
  不打印、不写日志、不写任何仓库文件。`selftest.mjs` 里有专门的泄漏检查用例。
- **输出必脱敏**：上游 JSON 里 `token` / `apiKey` / `secret` / `password` / `authorization` /
  `cookie` 字段一律替换为 `<redacted>`。
- **公网暴露**：默认不支持。必须走 HTTPS 反向代理 + `PET_HTTP_TOKEN`（Bearer），
  并自行加 IP 白名单与速率限制。`PET_BASE` 也不该指向公网地址。
- 工具本身能操作这台电脑上的助手（切项目、派任务），等于**执行权限**——
  只注册给可信客户端。

---

## 8. 已知限制

- DSH 没暴露「是否正在生成」的只读字段，`pet_status` 只能给出「最近活动会话」；
  本轮是否结束以 `pet_ask` 的返回为准。
- `mode:"steer"` 只是不再等待，宿主侧 `dispatch` 是**排队**而非打断；要打断用 `pet_stop`。
- HTTP 模式为单请求-单响应，无 `Mcp-Session-Id`、无服务端主动推送的长期 SSE 流。
  对 MCP 工具调用场景足够；需要服务端推送时走 stdio。
