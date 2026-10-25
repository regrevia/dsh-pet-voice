# 小爱同学接入：认证 → 建技能 → 真机测试（含我们这边要准备什么）

目标形态：**手机上说「小爱同学，打开鲸灵，让鲸灵看看 Pet 项目的测试结果」→ 小爱自己做唤醒/ASR/TTS，我们只在 HTTPS 服务器返回一句 `to_speak.text`，由小爱用自己的声音念出来。**
这条路等于**直接复用小爱的语音能力**：不用我们的 ASR、不用 edge-tts、不用手机保持页面在前台。

---

## 1. 账号认证（你现在缺的那一步）

小爱开放平台的技能创建要求账号是**「已完成资格认证的开发者」**，认证在小米开放平台（不是小爱站内单独做）。

| 身份 | 需要什么 | 时长 |
| --- | --- | --- |
| 个人 | 身份证实名 + 人脸核验 | 通常当场到 1 个工作日【估算】 |
| 企业 | 营业执照、对公账户（对公打款验证）、管理员信息采集 → 人工审核 | 平台口径 **3 个工作日**完成审核【厂商口径，[小米开放平台·开发者账号注册认证](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1145)】 |

操作路径【厂商口径，[小爱开放平台首页](https://developers.xiaoai.mi.com/)】：
1. 用**你要拿来测试的那台手机的同一个小米账号**注册/登录。
2. 完成「注册小米账号 → 实名认证为小米小爱开放平台开发者」。
3. 认证通过后，右上角 **控制台 → 技能开发 → 开始创建技能**。

> 个人身份就够做自定义技能；企业认证主要是对公验证那套流程，做 demo 不必走。
> 认证是否要求企业资质、是否需要域名备案：**文档没写死，【未核实】**——按个人实名 + HTTPS 即可先试。

---

## 2. 建技能时要填什么

- 技能名称：`鲸灵`
- 对象（承载设备）：**手机**（手机自定义技能；音箱技能是同一套协议，换设备对象而已）
- 服务器：选择 **HTTPS 配置服务器**，填
  `https://<你的公网域名>/pet-voice/api/xiaoai?k=<skill-secret>`
  - 必须是 **HTTPS + 有效证书**；quick tunnel 的 `*.trycloudflare.com` 证书是有效的，测试阶段能通【未核实：平台是否接受临时域名，审核大概率不接受】
  - secret 必须放在 URL 里：小爱服务器调用我们时不带 cookie，也不会带我们的自定义 header
- **NLP 交互模型**：唤醒是「显式唤醒」，必须先把动作语料配进去，否则喊名字不会进技能。至少配：
  - `打开鲸灵` / `启动鲸灵`
  - `让鲸灵看看 {任务}` / `叫鲸灵帮我 {任务}`
  - `鲸灵进度` / `鲸灵做得怎么样了`
  - `让鲸灵去 {项目} 项目` / `切到 {项目} 项目`
  - `让鲸灵停下`
- 账号授权：手机技能可以不接 OAuth（我们按无账号管理配置）。

---

## 3. 协议（我们服务器要满足的硬性要求）

事件（小爱 → 我们，POST JSON）：

```json
{
  "version": "1.0",
  "query": "让鲸灵看看 Pet 项目的测试结果",
  "session": { "session_id": "xxx", "application": { "app_id": "123" }, "user": { "user_id": "456" } },
  "request": { "type": 1, "request_id": "yyy", "timestamp": 452453534523, "locale": "zh-CN" }
}
```

动作（我们 → 小爱）：

```json
{
  "version": "1.0",
  "response": {
    "to_speak": { "type": 0, "text": "Pet 项目的自测全过了，56 项全绿。" },
    "open_mic": false,
    "not_understand": false
  },
  "is_session_end": true
}
```

三条硬性规则【厂商口径，[手机自定义技能](https://developers.xiaoai.mi.com/documents/Home?type=/api/doc/render_markdown/SkillAccess/skill/VoiceAssistantSkill/VoiceAssistantSkillMain)】：
1. `to_speak` 与 `directives` 至少给一个，否则平台视为无效动作并结束会话；
2. 必须带 `not_understand`，连续 3 轮为 true 会被强制退出；
3. 接口必须 HTTPS。

`request.type` 三态【厂商口径，同文档 Request 字段定义】：

| type | 含义 | 我们怎么回 |
| --- | --- | --- |
| 0 | 技能进入请求 | 欢迎语 + `open_mic:true` + `is_session_end:false`（进入多轮） |
| 1 | 技能进行中请求 | 走意图路由（派任务 / 进度 / 切项目 / 停） |
| 2 | 请求结束请求 | 「好，我先忙去了」+ `is_session_end:true` |

**签名验证**（附录《签名文档》，建技能后控制台会给 KeyId + Secret）：
`Authorization: MIAI-HmacSHA256-V1 <KeyId>:<Scope>:<Signature>`，
待签名字符串按序 `\n` 拼接：`METHOD` / `URL Path` / 规范化 query（name、value 均字典序）/ `Date` 或 `X-Xiaomi-Date`（RFC1123 GMT）/ `x-original-host` / `Content-Type` / `Content-MD5`（无则空串）/ 额外 header（V1 为空），
签名 = `HmacSHA256(base64decode(secret), 待签名串)` 的小写 hex【厂商口径，[签名文档](https://developers.xiaoai.mi.com/documents/Home?type=/api/doc/render_markdown/SkillAccess/skill/fulu/Signature)】。
我们同时校验 URL 里的 `?k=`（小爱服务器不带 cookie）；未配置 Secret 时降级为只校验 `?k=` 并回 `x-warn: signature-not-configured`。

---

## 4. 真机测试

1. 控制台里技能状态为「测试中」后，用**同一小米账号**登录的手机对小爱说唤醒语（`小爱同学，打开鲸灵`）。
2. 手机技能**只能在真机上测**，没有模拟器；HyperOS 4 + 小爱 8.x 已满足【用户环境，已确认】。
3. 每次交互都会打到我们的 HTTPS 端点，宿主侧能立刻看到事件——用 `GET /pet-voice/api/xiaoai/selftest` 看最近一次事件摘要。

---

## 5. 审核上线

- 功能完整、有明确唤醒语料、不会无故沉默/超时，才好过审；审核时长【未核实】。
- 长期跑的话把 quick tunnel 换成**自有域名 + Cloudflare named tunnel**（域名固定，证书自动），审核也更像正经服务。

---

## 6. 我们现在就能做的（不等认证）

- 服务器端已经按上面协议实现（`mcp/pet-bridge/xiaoai.mjs` + 宿主路由 `/pet-voice/api/xiaoai`），可以先用 `curl` 假造事件验证。
- 隧道一起来就能把真实 HTTPS 地址填进控制台——认证审核那几天正好用来调语料。
