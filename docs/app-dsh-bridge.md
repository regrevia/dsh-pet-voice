# 手机 App 浏览项目 / 会话 / 目标（只读接口）

`plugins/dsh-pet-voice` 暴露的四个只读接口，让手机 App 能像桌面端 DSH 一样翻项目和历史会话。
全部挂在 `https://<host>:8443/pet-voice/api/…` 下，和其余接口同一套鉴权。

## 鉴权

与既有接口一致：登录后拿 cookie `pkv_<token 前 8 位>=<token>`（token 文件 `~/.dsh/pet-voice/token`），
或 `Authorization: Bearer <token>`。未鉴权一律 `401 {"ok":false,"error":"unauthorized"}`。

自签证书，命令行用 `curl -k`：

```sh
TOK=$(cat ~/.dsh/pet-voice/token); C="pkv_${TOK:0:8}=$TOK"
curl -sk -b "$C" "https://127.0.0.1:8443/pet-voice/api/projects"
```

## 数据来源

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 项目 | 宿主 `workspaceRegistry.list()` | 和 `/api/state` 的 `projects` 同源 |
| 会话列表 | 宿主 `sessionController.list()` + 投影缓存 `~/.dsh/storages/session_projcache/sessions/*.json` | 标题 / 轮数 / 最近提问时间从投影缓存补 |
| 转录 | `~/.dsh/sessions/--<cwd>--/<会话id>/session.v4.jsonl.zstd` | 多帧 zstd 拼接，按帧解码，只解尾部 |
| 目标 | 投影缓存里的 `rows.goal` | 读不到就是空数组，绝不报错 |

宿主没有提供会话查询服务，所以以上全部走文件系统只读。任何一环缺失都降级，不让接口 500。

## GET /api/projects

```json
{"ok":true,"projects":[{"id":"ef76a38a-…","title":"Pet","path":"/tmp/pet-lab"}]}
```

## GET /api/sessions

查询参数：

- `projectId`（可选）：按项目过滤。不传时只返回**能归到某个项目**的会话（cwd 反查项目，散落在 `/private/tmp` 的临时会话不列）。
- `limit`：默认 20，最大 50，非法值回默认。
- `before`：上一页最后一条的 `updatedAt`（毫秒），严格小于它才返回，用于往前翻。

```json
{"ok":true,
 "sessions":[{"id":"session-74575c14-…","title":"…","projectId":"ef76a38a-…",
              "cwd":"/tmp/pet-lab","updatedAt":1792908025250,
              "turns":119,"running":false}],
 "hasMore":true,"nextBefore":1792908025250}
```

- 顺序：`updatedAt` 降序。
- `running`：该会话当前有活动轮次（宿主 `liveTurns`，裸 id 与 `session-` 前缀两种写法都认）。
- `hasMore` 为 false 时没有 `nextBefore`。
- 宿主会话列表很贵（0.5–1 s），进程内缓存 3 s；翻页/下拉刷新只有补标题的成本。

## GET /api/session

查询参数：

- `id`（必填）：会话 id，`session-<uuid>` 与裸 `<uuid>` 都接受。
- `limit`：默认 20，最大 50。
- `before`：上一页最早一条的 `seq`，严格小于它才返回。

```json
{"ok":true,
 "session":{"id":"session-74575c14-…","title":"…","cwd":"/tmp/pet-lab"},
 "messages":[{"seq":25192,"role":"assistant","text":"…","time":1792908167269},
             {"seq":25248,"role":"tool","text":"…","time":1792908238110,
              "tool":{"name":"wait_agent","args":"{\"timeout_ms\":240000}"}}],
 "hasMore":true,"nextBefore":25192}
```

- 返回**该页**按 `seq` 升序；`before` 往前翻时同样升序。
- `role` 只有 `user` / `assistant` / `tool`。**system 提示词不下发**（宿主内部上下文，App 不展示）。
- 只有工具调用或只有推理、没有正文的 assistant 消息跳过（避免空气泡）；正文非空时附 `reasoningPreview`（≤200 字）。
- 工具调用与它的结果按 `callId` 合并成一条 `tool` 消息，`tool.args` 截断 300 字。
- `text` 截断 4000 字；整页响应控制在 200 KB 以内，超了从最老的一条开始丢并置 `hasMore`。
- 会话不存在：`404 {"ok":false,"error":"会话不存在"}`；读取异常：`500 {"ok":false,"error":"读取会话失败"}`。

## GET /api/goals

查询参数：`sessionId`（可选）。

```json
{"ok":true,"goals":[{"id":"goal-3e4a5123-…","objective":"…","status":"active","updatedAt":1792908025250}]}
```

没有任何目标、会话未知、投影缓存读不到，都返回 `{"ok":true,"goals":[]}`。

## 限制

- 单次响应 ≤ 200 KB；超长转录只读尾部 32 MB，更老的内容按「没有更多」处理。
- 所有接口串行做文件读 + 解压，26 MB 转录解一页约 45 ms，宿主列表 0.5–1 s（有 3 s 缓存）。
- 不写任何宿主文件；投影缓存只读且按 mtime/大小记忆化（最多 200 条）。

## 已知限制

- `GET /api/sessions` 不带 `projectId` 时只返回**有项目归属**的会话：cwd 按最长前缀匹配 `workspaceRegistry` 的项目目录；`/private/tmp/…` 这类临时目录的会话不列。要看它们得传 `projectId`。
- 转录默认 20 条，上限 **50**（`SESSION_LIMIT_MAX`，与会话列表同一常量；与早期约定的 60 不同，要放宽改一行）。
- `tool.args` 截断 300 字符，`text` 截断 4000 字符，`reasoningPreview` 200 字符；整页超过 200 KB 时从最老的消息开始丢并置 `hasMore`。
- 宿主 `sessionController.list()` 结果缓存 3 s：3 s 内新建的会话、改过的标题 / 轮数 / `updatedAt` 可能滞后；`running` 不走缓存，每请求现算。
- 转录文件只读尾部 32 MB；更老的消息会被当成「没有更多」。
- 全部只读文件系统：宿主没开、投影缓存缺失、会话刚建还没落盘，都只会降级（空列表 / 空数组），不报 500。

## 实测（2026-10-25 14:08 +0800，真实宿主 127.0.0.1:8443，自签证书）

| 请求 | 状态 | 字节 | 耗时 |
| --- | --- | --- | --- |
| `GET /api/projects` | 200 | 546 | 436 ms（插件刚重载，冷） |
| `GET /api/sessions?limit=3` | 200 | 786 | 冷 548 ms / 温 16 ms |
| `GET /api/session?id=session-74575c14-…&limit=8` | 200 | 5 664 | 74 ms |
| 同上 `&before=25331`（第二页） | 200 | 7 375 | 46 ms |
| `GET /api/goals?sessionId=session-74575c14-…` | 200 | 743 | 4 ms |
| `GET /api/goals?sessionId=nope` | 200 | 22 | 1 ms |
| 四个端点不带 cookie | 401 | 38 | — |

- 列表三条 `projectId` 全部非空（`88f651fd` / `be6ba607` / `ef76a38a`），`/private/tmp/fm-bench` 已不出现。
- 转录两页 `roles` 只有 `user` / `tool` / `assistant`，`system` 0 条、空正文 0 条，两页 `seq` 无重叠且升序。
- 老端点结构未变：`GET /api/state` 200 / 5 033 B / 719 ms，顶层键仍是 `ok, tokenHint, linkHint, projects, presets, sessions, current, dispatchTarget, remembered, petSession, pet, turns, settings, xiaoai`；`GET /api/poll?since=0` 200 / 24 918 B，键为 `ok, sessionId, frames, cursor, done`；`POST /api/dispatch` 空 body 仍返回 `400 {"ok":false,"error":"text 为空"}`（不新建会话）。

```sh
TOK=$(cat ~/.dsh/pet-voice/token); C="pkv_${TOK:0:8}=$TOK"
curl -sk -b "$C" -o /dev/null -w 'projects %{http_code} %{size_download}B %{time_total}s\n' \
  "https://127.0.0.1:8443/pet-voice/api/projects"
curl -sk -b "$C" -o /dev/null -w 'sessions %{http_code} %{size_download}B %{time_total}s\n' \
  "https://127.0.0.1:8443/pet-voice/api/sessions?limit=3"
curl -sk -b "$C" -o /dev/null -w 'session %{http_code} %{size_download}B %{time_total}s\n' \
  "https://127.0.0.1:8443/pet-voice/api/session?id=session-74575c14-ef72-45c0-8d6e-44e1fc0010d8&limit=8"
curl -sk -b "$C" -o /dev/null -w 'goals %{http_code} %{size_download}B %{time_total}s\n' \
  "https://127.0.0.1:8443/pet-voice/api/goals?sessionId=session-74575c14-ef72-45c0-8d6e-44e1fc0010d8"
```
