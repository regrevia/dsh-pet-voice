# 鲸灵 · 系统架构

> 目标：一只「随身」的像素鲸鱼娘。屏幕和麦克风在你身上，大脑在电脑里，说话延迟≈人说话的反应速度。

## 一句话

**设备层只做三件事（显示、收声、放声），网关层只做转发和编排，大脑层（DSH / LLM）只做思考。**
任何一层都可以换实现，接口不变。

```
┌───────────────┐   ① 音频上行 (Opus/16k)     ┌──────────────────┐   ③ 文本上行 (SSE)   ┌─────────────┐
│  设备层        │ ──────────────────────────▶ │  网关层(demo/)    │ ──────────────────▶ │  大脑层      │
│  · 旧手机/PWA  │                             │  · /api/asr      │                     │  · DSH 插件  │
│  · ESP32 挂坠  │ ◀────────────────────────── │  · /api/chat     │ ◀────────────────── │  · LLM 网关  │
│  · 手表(仅屏)  │   ④ 音频下行 (wav/Opus)      │  · /api/tts      │   ② 文本下行 (SSE)   │  · 记忆/工具 │
└───────────────┘                             └──────────────────┘                     └─────────────┘
        像素画渲染 pet.js                          零依赖 Node，一台电脑                   persona + 流式输出
```

## 三层分工

| 层 | 职责 | 现在是什么 | 换成什么会怎样 |
| --- | --- | --- | --- |
| 设备层 | 屏幕渲染、麦克风采集、VAD、播放、打断按钮 | `demo/public/`（PWA，手机/桌面浏览器） | 换成 ESP32-S3 固件：同一套协议，`pet.js` 的绘制逻辑要用 LVGL 重画 |
| 网关层 | 音频编解码、ASR/TTS 常驻进程、LLM 代理、SSE 拆分句、缓存 | `demo/server.mjs`（零 npm 依赖） | 换到 DSH 插件里：把 `/api/*` 挂到 `ctx.webServer`，见 [plugin-integration.md](plugin-integration.md) |
| 大脑层 | 人格、上下文、记忆、工具调用 | DSH + `deepseek-v4.1-flash` | 换模型只改 `PET_LLM_MODEL` |

**为什么不是「手机 App + 云端」**：ASR/TTS 放云端每一跳 200-800ms，且要处理断网；放电脑本地是唯一能把「说完→出声」压到 1.3s 以内的方案（实测见下）。

## 时延预算（全部本机实测，不是估算）

| 环节 | 实测 | 来源 |
| --- | --- | --- |
| VAD 判停（说完到确认说完） | 500–700 ms（hangover 300ms 会把 2.4s 处的句子切断） | `bench/results/vad_bench.json` |
| ASR（whisper base / CPU / 3s 音频） | 183.7 ms（4.23s 音频 204.2ms，RTF 0.048） | `bench/results/asr_bench.json` |
| ASR HTTP 端到端（含 ffmpeg 解码 webm→16k wav） | 401 ms / 4.2s 音频 | 本机 `POST /api/asr` 实测 |
| LLM 首字（thinking 关闭） | 265 ms；短回复全文 488 ms | 本机 `POST /api/chat` 实测 |
| TTS 常驻进程首包 | 155.8–161.4 ms；守护进程内 172–174 ms/句（冷启 306–337ms） | `bench/results/tts_bench.json` |
| TTS `say` CLI（旧方案） | 643.5 ms / 17字，670.6 ms / 46字 —— 全是进程启动开销 | 同上 |
| **「说完 → 听见第一声」合计** | **≈1.2–1.4 s** | 500+250+265+300 |

关键结论：**瓶颈不在模型，在进程启动和判停参数**。把 `say` 换成常驻 `AVSpeechSynthesizer`、把 `thinking` 关掉，单项就省掉 ~1.3s。

> LLM 侧必须显式 `thinking: { type: "disabled" }`：默认开 CoT 时首字 2.4–4.1s，且常因 `finish_reason:"length"` 被思考 token 吃掉回复。

## 语音协议

语音不是「一路裸流」，而是**控制帧 + 音频帧**混在一个 WebSocket 里（HTTP 版 demo 用三个 POST 代替）：

```
上行：{"t":"start","utt":"u1"} → 若干 Opus 20ms 帧(57B) → {"t":"end","utt":"u1"}
下行：{"t":"say","utt":"u1","seq":0,"text":"咕噜…","fmt":"opus"} → 音频帧… → {"t":"done","utt":"u1"}
打断：{"t":"barge","utt":"u1"}   ← 客户端立刻停播并丢弃 utt=u1 的后续帧
```

- 20ms/帧、单声道 16kHz、23.0 kbps ≈ **57 B/帧**，比 PCM 省 17 倍（`bench/results/codec_bench.json`）；蓝牙 A2DP 只有 ~250kbps 可用，Opus 必须开。
- `utt_id` 是打断的唯一依据：服务端每句一个 `seq`，客户端只播当前 `utt` 的包，其余直接丢。**打断判定完全在本地（<100ms），不等服务端。**
- 回声消除（AEC）：手机/笔记本用系统 AEC（`getUserMedia` 默认 + `setVoiceProcessingEnabled`）；ESP32 必须双麦 + 播放参考信号（ES7210 的 MMNR 通道），单麦只能半双工（说完才能听）。

## 代码地图

| 文件 | 作用 |
| --- | --- |
| `demo/server.mjs` | 零依赖网关：静态服务 + `/api/chat`(SSE 代理) + `/api/tts` + `/api/asr` + `/api/health` |
| `demo/public/pet.js` | 112×112 逻辑画布上的像素鲸鱼娘：`createPet(canvas)`，`setMode/setMouth/tap/celebrate` |
| `demo/public/app.js` | 句级流水线：SSE 收字→切句→并行预取 TTS→顺序播放；VAD 录音；打断清理 |
| `demo/public/index.html` · `style.css` | 深海底色 UI、声呐光环、玻璃拟态 dock |
| `demo/tts_worker.swift` | 常驻 `AVSpeechSynthesizer`：stdin 收文本，写 wav，回 JSON（省 500ms/句） |
| `demo/asr_whisper.py` | 常驻 whisper：stdin 收 wav 路径，回文本（`initial_prompt` 带「鲸灵」热词） |
| `demo/asr_worker.py` | 常驻 vosk（离线备选引擎） |
| `bench/` | 6 个可复现的时延/编解码测试 + 原始 JSON 结果 |
| `docs/` | 本文 + [硬件选型](hardware.md) + [插件集成](plugin-integration.md) + [语音链路](voice.md) |

## 三种落地形态

1. **旧手机当随身屏（今天就能用）**：手机浏览器打开 `https://<PC-IP>:8788`，「添加到主屏幕」→ 全屏 PWA。手机只负责屏幕/麦克风/喇叭，PC 负责全部计算。零成本、零固件。
2. **ESP32-S3 圆屏挂坠（¥150–260，推荐的自研形态）**：1.28″ 240×240 + 双麦 ES7210 + MAX98357A，跑 `xiaozhi-esp32` 改的固件，Wi-Fi 直连网关。真正「随身」，续航 3–6h。详见 [hardware.md](hardware.md)。
3. **智能手表（V2，只做第二屏）**：Wear OS 的麦克风只在「使用中/前台」可用，拿不到熄屏常听，所以手表只能当显示器 + 按钮，不能当独立宠物。

## 安全边界

- `COMPANY_LLM_TOKEN` 只在 `server.mjs` 里读（`~/.dsh/.credentials.yaml`），**永不下发前端、永不写日志**；前端只跟本进程说话。
- 局域网内 HTTPS 用自签证书（`demo/certs/`，CN=whalepet.local）；手机首次访问需要点「继续访问」。
- 走 DSH 插件形态时，语音接口要挂 `ctx.connection.admit(req)` 做鉴权，别裸奔在 LAN 上。

## 还没验证的

- ESP32 双麦 AEC 的实际 ERLE（手上没板子）；Marked as 估算 in `voice.md`。
- whisper.cpp / sherpa-onnx 在 ARM 上的真机时延（本机装不上，用的是 PyTorch 版作上界）。
- 云端流式 ASR/TTS 的真实首包（只有官方定价，没有实测）。
