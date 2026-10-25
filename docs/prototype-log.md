# 鲸灵 · 随身宠物（可行性调研 + 可跑的原型）

一只住在你电脑里的像素鲸鱼娘：**屏幕和麦克风在你身上，大脑在电脑里，说完 1.2–1.4 秒听到回话。**

```
 旧手机 / ESP32 挂坠  ──Wi-Fi──▶  电脑上的网关(ASR→LLM→TTS)  ──▶  说话 + 像素动画
      随身的那一半                    聪明的那一半
```

## 结论先说

| 问题 | 答案 |
| --- | --- |
| 能不能做？ | **能，而且核心链路已经在本机跑通**（不是 demo 视频，是真接口：`/api/asr` `/api/chat` `/api/tts`）。 |
| 用什么当「随身」的那一半？ | 先用**旧手机 PWA**（今天就能用），想真·随身就做 **ESP32-S3 圆屏挂坠（¥150–260）**。 |
| 智能音箱能不能用？ | **不能**。小爱/天猫精灵/HomePod 都不给你原始麦克风流，只能「被投放」，做不了双向宠物。 |
| 智能手表能不能用？ | **只能当第二屏**。Wear OS 麦克风只在「使用中/前台」可用，拿不到熄屏常听。 |
| 最省事的路径？ | 旧手机 + 现有网关 → 30 分钟上手；接 DSH 插件 → 半天；自己做硬件 → 2–4 周。 |

## 现在就能跑

```bash
cd demo && node server.mjs
# 电脑:  http://127.0.0.1:8787
# 手机:  https://<本机IP>:8788   （自签证书，点「继续访问」，再「添加到主屏幕」）
```

实测（本机，非估算）：

| 环节 | 实测 |
| --- | --- |
| LLM 首字 / 短回复全文 | **265 ms / 488 ms**（`thinking` 关闭） |
| ASR whisper base（3s 中文） | **183.7 ms**；HTTP 端到端 401 ms |
| TTS 常驻进程每句 | **172–337 ms**（`say` CLI 是 640–670 ms） |
| 说完 → 听见第一声 | **≈1.2–1.4 s** |

## 一条命令验收

```bash
bash scripts/verify.sh          # 语法 + 插件/MCP/小爱 三套自测 + 线上探针（不碰配置、不打印密钥）
SKIP_LIVE=1 bash scripts/verify.sh   # 只跑离线部分
```

最近一次【实测 2026-10-24】：**通过 14 项，失败 0 项**

| 检查 | 结果 |
| --- | --- |
| `node --check` × 5 个入口文件 | 全通过 |
| 插件 selftest（模拟 HOME） | 131/131 |
| MCP selftest（离线；`PET_LIVE=1` 时实测 18/18、`pet_say` 175 ms） | 17/18（1 SKIP） |
| 小爱协议 selftest | 94/94 |
| 无 cookie 访问 `/api/state` | 401 |
| 小爱 type=0 进入语 + `open_mic:true` | 0.0006 s |
| 小爱 type=1 派任务拿到真回复 | **0.73–0.85 s**（预算 2.6 s） |
| `dispatchTarget` == 专属会话（不被界面会话抢走） | ✓ |
| 专属会话 cwd == 本仓库 | ✓ |
| `/api/say` 鉴权生效 | 401 |

## 目录

```
Pet/
├── README.md                  ← 你在这里
├── scripts/verify.sh          一条命令验收：语法 + 三套自测 + 线上探针
├── scripts/verify-commands.sh 手机侧语音指令验收（切项目/派发/停/切不到/闲聊，自带还原）
├── scripts/cf-tunnel-token.mjs 隧道 token 自动解析+校验+落盘（600，不回显原文）
├── plugins/dsh-pet-voice/     DSH 插件：手机页面 /pet-voice/ + 语音闭环 + 小爱接入点
│   ├── index.js               /api/state /dispatch /stream /poll /cancel /new /say /tts /xiaoai
│   ├── public/                像素鲸鱼娘、唤醒词、按住说话、播报
│   ├── selftest.mjs           离线自测（模拟 HOME，不碰真实配置）
│   └── e2e.mjs                本地端到端：一问一答的真帧序列
├── mcp/pet-bridge/            MCP 服务端：把鲸灵能力暴露给外部助手
│   ├── server.mjs             pet_status/ask/switch_project/new_session/stop/say
│   ├── xiaoai.mjs             小爱协议适配（签名、三态、意图路由、待办补答）
│   └── selftest.mjs           离线自测（PET_LIVE=1 才真打宿主）
├── docs/
│   ├── xiaoai-skill.md        小爱手机自定义技能：建技能 → 真机测试全流程
│   ├── xiaoai-cert.md         开发者认证门槛、协议 JSON、签名公式
│   ├── voice-without-xiaoai.md 没有开发者权限时怎么走（Siri/主屏/自建硬件）
│   ├── portable-pet-runbook.md 从零复现：配对、隧道、手机、排错
│   ├── feasibility.md         调研报告：能做什么/不能做什么、BOM、路线图
│   ├── architecture.md        系统架构、三层分工、时延预算、语音协议
│   ├── hardware.md            硬件选型：ESP32-S3 挂坠、屏幕、麦克风、电池
│   ├── plugin-integration.md  怎么把网关塞进 DeepSeek Harness 插件
│   ├── voice.md              语音链路：编解码、VAD、ASR/TTS 选型与成本
│   ├── cloudflare-own.md     用自己的 Cloudflare 账号 + 自己的域名起命名隧道
│   ├── pet-contract.md       手机/音箱对接的接口契约（端点、鉴权、core/experimental 分级）
│   ├── android-app.md        Android 随身端：悬浮窗、四态动画、历史、限制
│   ├── real-device-install.md 装到真机：APK 校验、权限清单、隧道接线、安全口径
│   ├── cloudflare-creds.md   Cloudflare/R2 凭证落盘脚本的用法与校验
│   ├── cloudflare-tunnel-token.md 隧道 token 从哪拿、免费口径、怎么安全落盘
│   └── tls-self-signed.md 不买域名也能 https：自签 CA 打进 App
├── demo/                      零依赖可跑原型（早期版本，仍可单独跑）
│   ├── server.mjs             网关：/api/chat /api/tts /api/asr /api/health
│   ├── tts_worker.swift       常驻 AVSpeechSynthesizer（省 500ms/句）
│   ├── asr_whisper.py         常驻 whisper（带「鲸灵」热词）
│   └── public/                PWA：像素鲸鱼娘 + 句级流式语音
└── bench/                     6 个可复现的时延/编解码测试 + 原始 JSON
```

## 三条落地路线

1. **旧手机当随身屏（今天）** —— 浏览器打开即用，手机只负责屏+麦克风+喇叭，PC 算一切。零成本。
2. **DSH 插件形态（半天）** —— 把网关挂到 `ctx.webServer`，手机用 `adb reverse` 走 `http://localhost:3080`（LAN IP 会被 DSH 的 Origin 校验拦掉）。见 [docs/plugin-integration.md](docs/plugin-integration.md)。
3. **ESP32-S3 圆屏挂坠（2–4 周，¥150–260）** —— 1.28″ 240×240 + 双麦 ES7210 + MAX98357A，固件基于 `xiaozhi-esp32`，Wi-Fi 直连网关。真·随身，续航 3–6h。见 [docs/hardware.md](docs/hardware.md)。

## 关键取舍

- **大脑必须在电脑上**：ASR/TTS 上云每跳 200–800ms，且断网就废；本地化是 1.3s 目标的前提。
- **LLM 必须关思考**：默认开 CoT 首字 2.4–4.1s，还会因 `finish_reason:"length"` 把回复吃掉；网关请求里固定 `thinking:{type:"disabled"}`。
- **打断在本地做**：不等服务端，客户端 <100ms 停播 + 按 `utt_id` 丢包，体感才「像在跟人说话」。
- **ESP32-S3 没有经典蓝牙**：只有 BLE 5，不能当 A2DP 耳机；所以它走 Wi-Fi，不是蓝牙。
- **「手机当路由」= 开热点，不是 BLE 桥**：BLE 桥要你写手机 App（Web Bluetooth 不能后台、iOS 不支持），还多 30–80ms；热点零成本、延迟 10–30ms。
- **1.28 圆屏板不是语音板**：它没有麦/编解码/功放；验证语音买 $15.99 的双麦板，一体原型买 $25.99 的 1.85 圆屏板（详见 [docs/hardware.md](docs/hardware.md)）。
- **凭证只在服务端**：`COMPANY_LLM_TOKEN` 不下发前端、不进日志。

## 下一步（按性价比排）

1. 真机验证 ESP32 双麦 AEC（唯一没实测的关键项）；
2. 本地唤醒词（ESP-SR / sherpa-onnx KWS），摆脱「点一下」；
3. 记忆与主动说话（DSH 侧的工具 + 定时器）；
4. 外壳与佩戴（项链式/夹式，45×45×16mm、45–60g）。
