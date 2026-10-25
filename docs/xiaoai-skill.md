# 小爱同学「鲸灵」技能接入

> ⚠️ **平台现状【实测 2026-10-24】**：小爱开放平台首页公告「由于业务调整，即日起，我们将暂时
> 停止开发者的注册服务」。**新账号注册不了开发者 → 拿不到「新建技能」入口**，下面这套流程暂时只能
> 给"已有开发者权限的账号"用。服务端（协议、签名、三态、专属会话、待办补答）已全部就绪且验证通过，
> 平台一放开即可直接用。没有开发者权限时改走
> [voice-without-xiaoai.md](voice-without-xiaoai.md)（系统语音助手当外壳，零审核、当天可用）。

把小爱同学当成鲸灵的**耳朵和嘴**，DSH 只负责动脑子。

```
「小爱同学」→「打开鲸灵」→（小爱做唤醒 + ASR）
        ↓ HTTPS POST + 签名
  https://<隧道域名>/pet-voice/api/xiaoai?k=<urlSecret>
        ↓ 意图路由 → DSH 会话
  回复 {"response":{"to_speak":{"text":"..."}}}  ← 只有文本，没有音频
        ↓
   小爱用自己的音色念出来
```

所以这里**不需要** TTS、不需要播放器、不需要手机页面常驻。手机上唯一要开的
是 DSH 自己（插件挂在宿主 webServer 上），外面套一层隧道即可。

---

## 一、先拿到两个东西

### 1. 一个能被小米服务器访问到的 HTTPS 地址

小爱只接受 `https://`，本地 `127.0.0.1` 必然被拒。仓库里已有的 cloudflared
快速隧道就够用（临时域名，重开会变）：

```bash
# 端口取自当前 DSH Web GUI（本文写作时是 52356，会变）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:52356/pet-voice/api/state
# 401 = 服务活着（这个接口要 cookie，401 是正确的）
```

隧道起来后拿到的形如 `https://xxxx-yyyy.trycloudflare.com`。

> 快速隧道的域名**每次重启都变**，控制台里的服务器地址要跟着改。长期使用请换成
> 有固定域名的具名隧道。

### 2. `urlSecret`（地址里的 `?k=`）

小爱的服务器不带 cookie，也不会带我们自定义的 header，所以门禁只能放在 URL 上。
第一次访问 `/pet-voice/api/xiaoai` 时插件会自动生成：

```
~/.dsh/pet-voice/xiaoai.json     # 0600
{ "urlSecret": "<32 位十六进制>" }
```

查看方式（不要贴到任何聊天窗口/截图里）：

```bash
node -e "console.log(require(process.env.HOME+'/.dsh/pet-voice/xiaoai.json').urlSecret)"
```

于是完整的服务器地址是：

```
https://<隧道域名>/pet-voice/api/xiaoai?k=<urlSecret>
```

### 3.（可选但强烈建议）签名所需的 KeyId / Secret

小爱开放平台在「技能信息 → 签名」里会给你一对 `KeyId` / `Secret`（Secret 是
base64）。填进同一个文件就会**强制验签**：

```json
{
  "urlSecret": "<保持原值>",
  "keyId": "在控制台复制",
  "secret": "在控制台复制的 base64 Secret",
  "appId": "123"
}
```

没填也能跑：此时只校验 `?k=`，并且**每个响应都会多一个头**
`x-warn: signature-not-configured`，方便你在 `curl -i` 时一眼看出当前是降级模式。

查完整串（含 secret）请直接读受保护文件，别在终端里回显：

```bash
cat ~/.dsh/pet-voice/xiaoai-url.txt     # 0600，一行，控制台「服务器地址」直接粘这行
```

### 4. 专属会话：小爱在哪个项目里干活

小爱**不跟着界面走**。它有自己的会话，记在：

```json
// ~/.dsh/pet-voice/pet-session.json      0600
{ "workspaceId": "…", "workspaceTitle": "Pet", "cwd": "/tmp/pet-lab", "sessionId": "session-…" }
```

- 默认落在 **Pet** 项目（`xiaoai.json` 里的 `"workspace": "Pet"` 可改）；
- 每次复用前校验 `cwd === <该项目 path>`，对不上就丢弃重建；
- 只有「切到 X 项目」这条意图会换 workspace（新建一只会话并写回文件），
  之后再问就是在 X 项目里答；
- 早期版本用的是「界面当前活动会话」，会把任务派进你正在看的那个会话（实测串到过
  Envoy / REA / 甚至 Lead 自己的会话），**已废弃**。

---

## 二、控制台配置（小爱开放平台）

入口：<https://developers.xiaoai.mi.com/> → 技能开放平台 → 新建技能。

| 项 | 填什么 |
| --- | --- |
| 技能类型 | 自定义技能 |
| 技能名称 | `鲸灵`（这就是「打开**鲸灵**」里的那两个字） |
| 目标设备 | **手机**（本文只覆盖手机；音箱的授权与设备绑定流程不同） |
| 服务器地址 | `https://<隧道域名>/pet-voice/api/xiaoai?k=<urlSecret>` |
| 请求方式 | `POST`，`Content-Type: application/json` |
| 是否需要授权 | 否（自己用；门禁靠 URL secret + 签名） |

然后进**交互模型 / 意图**，建一个动作（比如叫 `干活`），把下面 8 句加进去。
小爱的唤醒是**显式**的：调用词 + 技能名 + 动作，所以「鲸灵」三个字最好直接出现在
样例话术里，识别率会明显高于靠槽位推断。

### 8 条样例话术

| 话术 | 命中的意图 |
| --- | --- |
| 让鲸灵帮我看看登录报错 | `ask` 派任务 |
| 问一下鲸灵今天几号 | `ask` 派任务 |
| 让鲸灵把测试跑一遍 | `ask` 派任务 |
| 鲸灵在干嘛 | `progress` 读进度 |
| 鲸灵好了吗 | `progress` 读进度 |
| 让鲸灵到 REA 项目干活 | `switch` 切项目 |
| 鲸灵切到 Envoy 项目 | `switch` 切项目 |
| 停 | `stop` 打断当前轮 |

> 不在这 8 句里的话术也不会报错：拿不到意图时一律**当成派任务**（把原句去掉唤醒词
> 后交给 DSH），这样「随便说点什么它也能干」的体验最好。

---

## 三、动作协议（平台强制的几条，别省）

事件长这样：

```json
{
  "version": "1.0",
  "query": "鲸灵在干嘛",
  "session": {
    "session_id": "xxx",
    "application": { "app_id": "123" },
    "user": { "user_id": "456" }
  },
  "request": { "type": 1, "request_id": "yyy", "timestamp": 452453534523, "locale": "zh-CN" }
}
```

我们回的动作：

```json
{
  "version": "1.0",
  "response": {
    "to_speak": { "type": 0, "text": "Pet 项目自测 56 项全过。" },
    "open_mic": false,
    "not_understand": false
  },
  "is_session_end": true
}
```

`request.type` 三态，三种都必须回**非空** `to_speak.text`：

| type | 含义 | 我们的回复 | `open_mic` | `is_session_end` |
| --- | --- | --- | --- | --- |
| `0` | 技能进入 | 「鲸灵在这儿，想让我做什么？」 | `true` | `false`（留麦接下一句） |
| `1` | 技能进行中 | 按意图路由（见上） | `false` | `true` |
| `2` | 请求结束 | 「好，我先忙去了。」 | `false` | `true` |

硬性要求（漏一条平台就判无效动作、直接杀会话）：

1. `to_speak` 和 `directives` **至少有一个**，且 `to_speak.text` 不能是空串；
2. **必须**带 `not_understand`。接不住话术时给 `true`，连续 **3** 轮为 `true`
   会被强制退出——所以我们在第 3 轮直接回「那我先退下了，需要的时候再叫我。」
   并把计数清零，避免用户被莫名其妙踢出去；
3. 服务器地址必须是 HTTPS。

---

## 四、签名（`MIAI-HmacSHA256-V1`）

请求头：

```
Authorization: MIAI-HmacSHA256-V1 <KeyId>:<Scope>:<Signature>
```

拼串规则（**每段后面都跟一个 `\n`**，顺序不能动）：

```
METHOD（大写）
URL Path（不含 query）
规范化 query（参数名与值都按字典序，多值展开成一个个 pair）
Date 或 X-Xiaomi-Date（RFC1123 GMT）
x-original-host
Content-Type
Content-MD5（没有就是空串）
额外 header（V1 固定为空串）
```

```js
signature = lowerHex(HmacSHA256(base64decode(secret), utf8(canonical)))
```

实现见 [`mcp/pet-bridge/xiaoai.mjs`](../mcp/pet-bridge/xiaoai.mjs) 的
`signRequest()` / `verifySignature()`。两处现实中的不确定（末尾空 header 段是否
还要补一个 `\n`、query 的百分号编码形式）都做了变体枚举，任一变体算得对就放行——
**不会**削弱「必须持有 secret」这个前提。

另外还校验报文本身：请求若声明了 `Content-MD5`，会对**原始字节**做一次 MD5 比对，
不一致直接 401（`{"error":"bad-content-md5"}`），防中间人改内容。

签名/门禁失败一律 401 并只回极简 JSON，不回显任何业务状态。

---

## 五、真机测试

手机技能**只能**在真机上测，网页模拟器不跑语音链路。

1. 手机上确认 DSH 在跑、隧道在跑，浏览器能打开 `https://<域名>/pet-voice/`；
2. 小爱开放平台 → 技能 → 「真机测试」，用**已实名/已通过资质认证**的小米账号
   在小爱 App 里打开测试开关；
3. 对小爱说「打开鲸灵」→ 应听到「鲸灵在这儿，想让我做什么？」，且**说完不退出**
   （`open_mic: true`）；
4. 接着说「让鲸灵帮我看看登录报错」→ 听到任务结论（快任务约 0.8s 就直接念结论；慢任务先回「我记下了，正在弄；你过一会儿说『鲸灵进度』我就报给你。」）；
5. 说「鲸灵在干嘛」→ 听到最新一轮的结论；超时过的那条会在这里被补答；
6. 说「停」→ 当前轮被打断。

### 不用手机也能验的三件事

```bash
# ① 自测端点：最近一次事件 + 回复摘要（不含任何 secret/token）
curl -s "http://127.0.0.1:52356/pet-voice/api/xiaoai/selftest?k=<urlSecret>" | head -c 600

# ② 真正打一发派任务（这就是小爱会做的事）
curl -s -X POST "http://127.0.0.1:52356/pet-voice/api/xiaoai?k=<urlSecret>" \
  -H 'content-type: application/json' \
  -d '{"version":"1.0","query":"让鲸灵看看当前目录有几个文件","session":{"session_id":"manual-1","application":{"app_id":"123"},"user":{"user_id":"456"}},"request":{"type":1,"request_id":"r1","timestamp":452453534523,"locale":"zh-CN"}}'
```

```bash
# ③ 全链路自测（本地 stub，不需要隧道/手机，94 个断言）
node mcp/pet-bridge/xiaoai-selftest.mjs
```

---

## 六、审核与上线注意

- 技能名称、图标、简介、示例话术要能对上；「鲸灵」是自定义技能，仅供自己使用，
  **不要**用「小爱同学」等官方字样做技能名；
- 审核会按示例话术逐条点一遍，所以样例里不要写需要特殊环境才能答的话
  （比如必须连着某个内网服务）；
- 隐私说明要写清楚：语音由小爱云端转成文本后发给自建服务器，我们只落**文本**，
  不存音频；
- 提交上线后域名不能再是 `trycloudflare.com` 的临时域名——一变就全挂。

## 七、已知限制

| 限制 | 影响 | 处置 |
| --- | --- | --- |
| 唤醒是显式的 | 必须先「小爱同学」再「打开鲸灵」，不能直接喊「鲸灵」 | 平台机制，改不了 |
| 话术要进意图模型 | 没加进模型的说法可能压根送不到服务器 | 样例话术写宽一点 |
| 手机技能只能真机测 | 无法在模拟器里调 | 用上面的 `curl` + selftest 兜住 |
| 需要资质认证的小米账号 | 没认证看不到真机测试入口 | 先认证 |
| 快速隧道域名会变 | 控制台地址要跟着改 | 换具名隧道 |
| 2600ms 等待预算 | 慢任务会先回「我记下了，正在弄…」 | 之后说「鲸灵进度」补答 |
| 不主动播报 | 小爱不推消息，只能问一句答一句 | 平台不支持长连接推送 |

---

## 八、涉及文件

| 文件 | 作用 |
| --- | --- |
| [`mcp/pet-bridge/xiaoai.mjs`](../mcp/pet-bridge/xiaoai.mjs) | 纯 `node:http` 的 handler：门禁、签名、意图路由、动作组装、待办补答 |
| [`mcp/pet-bridge/xiaoai-selftest.mjs`](../mcp/pet-bridge/xiaoai-selftest.mjs) | 94 条断言，本地 stub，含签名三例、三轮强制退出、真回复时效 |
| [`plugins/dsh-pet-voice/index.js`](../plugins/dsh-pet-voice/index.js) | 挂 `POST /pet-voice/api/xiaoai` 与 `GET .../selftest`，把宿主会话能力收窄成 `pet` 适配器 |
| `~/.dsh/pet-voice/xiaoai.json` | `urlSecret` / `workspace` / `keyId` / `secret` / `appId`（0600，勿外传） |
| `~/.dsh/pet-voice/pet-session.json` | 小爱专属会话：`workspaceTitle` / `cwd` / `sessionId`（0600） |
| `~/.dsh/pet-voice/xiaoai-url.txt` | 控制台要填的完整 URL（含 secret，0600，勿外传） |
| `~/.dsh/pet-voice/pending.json` | 超时未答的任务，供「鲸灵进度」补答 |
