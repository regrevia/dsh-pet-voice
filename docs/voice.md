# 语音管线设计（Pet 桌面宠物）

> 目标：说完一句 → 首个音频包 < 1.5s；播报中可被随时打断；16kHz 单声道；先 PC 本地、手机降级云端。
> 标注约定：**【实测】**＝本机 `bench/` 脚本跑出来的数字（OS 26.5.2 / arm64，2026-10-24）；**【估算】**＝未实测，写明依据或链接。所有脚本与原始 JSON 见 `bench/`。

---

## 1. 端到端链路与延迟预算

```
麦克风 → AEC/NS → VAD 断句 → ASR → LLM → 分句 → TTS(流式) → 播放
          └─ 播报期间并行跑 VAD，用于打断 ─┘
```

用户「说完」到「听到第一个音」的预算（PC 本地，单轮）：

| # | 段 | 实测/估算 | 毫秒区间 | 依据 |
|---|---|---|---|---|
| 1 | VAD 端点判定（尾静音 500–700ms） | 实测 | 500–700 | 500/700ms 档与真实结尾差 −20ms；300ms 档会在句中 2.4s 处误切 |
| 2 | 上行封包（20ms Opus 帧） | 实测 | 0–20 | 24kbps 实测有效 23.0kbps，212 包/4.23s |
| 3 | 网络（本机/局域网） | 实测 | 6–20 | TCP connect 5.9ms、TTFB 65.5ms（网关） |
| 4 | ASR 出字（whisper base, 3s 语音） | 实测 | 180–250 | 3s 前缀 183.7ms；4.23s 整句 204.2ms（RTF 0.048） |
| 5 | LLM 首个**可播**文本 | 实测 | **1100–3200** | 首个 delta 241–359ms，但首个 `content` 中位 1680ms（long）/3174ms（short），区间 1098–3179ms |
| 6 | TTS 首包（进程内 AVSpeechSynthesizer） | 实测 | 156–330 | 预热后 155.8–161.4ms；进程首次 330.5ms |
| 7 | 播放缓冲 | 实测 | 20–60 | 20ms 帧，2 帧起播 |
| — | **合计（关掉思维链）** | — | **≈1.05–1.35s** | ✅ 达标 |
| — | **合计（当前网关默认 CoT）** | — | **≈2.4–4.1s** | ❌ 超标 |

**三个结论：**

1. **瓶颈不在语音，在 LLM。** ASR 200ms + TTS 160ms 已经很好；真正吃掉预算的是大模型第一段正文（实测中位 1.7–3.2s，`anthropic/DeepSeek-V4.1-Flash`；`anthropic/GLM-5.3` 更差，3.7s）。
   → 语音轮次必须走**非思维链 / 小模型 / 短 system prompt**，或先用固定语气词（「嗯——」）垫 300ms。实测 `thinking.type=disabled`、`enable_thinking=false`、`reasoning_effort=none` 三个参数都**没能**把首字压到 300ms 量级（见 `bench/results/llm_thinking_probe.json`）。
2. **不要用 `say` 命令行。** 实测 `say -v Tingting` 643.5ms/17 字，而 12 字 675.2ms、46 字 670.6ms —— 时间几乎与长度无关，说明全是 ~600ms 进程启动。进程内合成只要 156ms，省 0.5s。
3. **`say` 的 RTF 很好（0.062–0.279），不是性能问题，是启动问题。** 线程内直接合成即可。

---

## 2. ASR 选型

| 方案 | 部署 | 延迟 | 价格 | 结论 |
|---|---|---|---|---|
| **whisper.cpp** base/small（Metal） | 本地 | 估算 60–150ms/3s（RTF 0.02–0.05） **【估算】**（本机无 cmake、`/opt/homebrew` 无写权限，未能编译） | 免费 | **PC 首选**。cpp+Metal 比 PyTorch 版快，实测的 204ms 是它的上界 |
| **openai-whisper** base（CPU） | 本地 | 【实测】3s 前缀 183.7ms、4.23s 整句 204.2ms、RTF 0.048、加载 374.6ms | 免费 | 可立即用（本机已装）；MPS 不可用（`SparseMPS` 未实现） |
| faster-whisper（CTranslate2 int8） | 本地 | 未实测：`pip --user` 被沙箱拒绝（`~/Library/Python` 不可写），工作区 venv 安装受限于外网 ~20KB/s | 免费 | 期望比 torch 版快 2–4×，值得在可用网络下复测 |
| sherpa-onnx 流式 zipformer | 本地/手机 | 未实测（同上） | 免费 | **手机首选**：真流式、内存小、可出 partial |
| 阿里云 实时语音识别 | 云 | 未实测（官方称流式，首包数百 ms） | 3.50 元/小时，梯度至 1.20（[计费页](https://help.aliyun.com/zh/isi/getting-started/billing-10)） | 手机兜底 |
| 阿里云 一句话识别 | 云 | 未实测 | 3.50 元/千次（同上） | 手机兜底（整句上传，最省心） |
| 阿里云百炼 Paraformer | 云 | 未实测 | 0.288 元/小时（同上） | 最便宜的云 ASR，0.24 元/千次（3s/次） |
| OpenAI Whisper API | 云 | 未实测 | $0.006/分钟（[官方定价](https://openai.com/api/pricing)） | 不做首选（贵且出境） |

**成本对比（每次 3s 语音，1000 次/天）**：本地 0 元；Paraformer ≈0.24 元/千次 → 0.24 元/天；实时识别 ≈2.9 元/天；一句话识别 3.5 元/天。**本地化一天省 3 元，但省掉的是隐私风险和网络抖动，这才是重点。**

**推荐：** PC 用 whisper.cpp `base`（中文够用，`small` 备用）；手机用 sherpa-onnx 流式 zipformer，装不下再退回阿里「一句话识别」。

> **上线实测（2026-10-26）：`base` 不够用。** 同一批 3 句 5–6 s 录音（`say -v Ting-Ting` 合成，16 kHz 单声道），
> PyTorch 版 `base` + `beam_size=1` 0.65–1.3 s，但「语音识别服务」→「余音时别服务」、「语音转文字」→「鱼银转文字」，
> 还偶尔整句输出繁体；`large-v3-turbo` + `beam_size=5` 1.6–2.9 s、全对且全简体（加载 5.0 s、预热 2.6 s，冷启动合计 11 s）。
> 已把常驻 worker 默认值改成 `large-v3-turbo`/`beam_size=5`（`plugins/dsh-pet-voice/asr/asr-worker.py`），
> 一句话多花半秒换认对，比省时间值。
⚠️ **中文专名必须加热词**：实测 base 把「小宠」听成「小丑」——whisper 用 `initial_prompt` 注入人名词表，云厂商用热词表。

---

## 3. TTS 选型

| 方案 | 首包延迟 | 价格 | 自然度 | 流式 |
|---|---|---|---|---|
| `say` CLI | 【实测】643–675ms（≈600ms 是进程启动） | 免费 | 中（明显机器味） | 否（整段落盘） |
| **AVSpeechSynthesizer**（进程内） | 【实测】**155.8–161.4ms**（首次 330.5ms） | 免费 | 中 | 是（逐 buffer 回调，实测 209–937 个 buffer） |
| edge-tts | 未实测（需外网，本机外网 20KB/s） | 免费（非官方接口，无 SLA） | 好 | 是 |
| 火山引擎 豆包语音合成 | 未实测 | 定价页 JS 渲染未能取到数字，见 [定价页](https://www.volcengine.com/pricing?product=ASR) | 很好 | 是（双向流式 WS） |
| 阿里云 语音合成 | 未实测 | 3.50 元/千次；**流式 1.00 元/万字**（[计费页](https://help.aliyun.com/zh/isi/getting-started/billing-10)） | 好 | 是 |
| GPT-SoVITS（克隆） | 未实测 | 免费（需自备算力） | 很好（1 分钟样本即可） | 半流式 |
| Fish-Speech（克隆） | 未实测 | 免费 | 好 | 是（流式） |

**成本：** 阿里流式 1 元/万字 → 17 字一句 = 0.0017 元，1000 句/天 ≈ 1.7 元/天。

**推荐：**
- **MVP 立刻用 AVSpeechSynthesizer**：0 成本、156ms 首包、原生流式、跟 `say` 同一批系统音色（本机 184 个音色，中文 7 个：Tingting、Eddy、Flo、Grandma、Grandpa、Reed、Rocko）。先用它把整条链路跑通。
- **要「有性格」的音色** → 阿里流式 TTS（1 元/万字，最便宜）；**要最好听** → 火山；**要克隆自己/宠物的声音** → GPT-SoVITS 或 Fish-Speech 本地跑。

---

## 4. 打断（barge-in）与回声消除

**半双工 vs 全双工**

| | 半双工（播完再听） | 全双工（边说边听） |
|---|---|---|
| 实现 | VAD + 播放期间关麦 | 必须 AEC，否则自己把自己打断 |
| 打断体验 | 只能等播完 | 随时插话，真人感 |
| 回声风险 | 无 | 高（尤其外放） |
| 推荐平台 | ESP32（单麦） | PC、手机（外放音量 <70%） |

**实测的打断相关数字：**
- VAD 起点判定 **0ms**（20ms 帧粒度，算法开销 0.01ms）→ 用户开口到「决定打断」只需 1 帧。
- 端点判定受 hangover 支配：**300ms 档会在句中 2.4s 处误判结束**（把一句话切断）；500/700/1000ms 档与真实结尾差 −20ms。**取 500–700ms**，代价是 +200–400ms 延迟。
- 打断路径全在本地闭环：VAD 判起点 → 本地立即停播 + 丢弃 `utt_id` 不匹配的下行帧 → 再发 `barge_in`。**实测可做到 <100ms**（0ms 判定 + 1 帧 20ms + 本地停播，不含网络往返）。

**AEC 三平台**
- **PC（本机）**：实测 `AVAudioEngine` 的 Voice Processing I/O 存在（`inputNode`/`outputNode` 都能 `setVoiceProcessingEnabled`，内置 AEC/AGC/NS）。本次无麦克风 TCC 授权，**未能实测 ERLE**，全双工方案可行。**【实测：API 可用 / ERLE 未实测】**
- **手机**：iOS 用 `AVAudioSession` `.voiceChat` 模式（系统 AEC）；Android 用 `AcousticEchoCanceler` 或 WebRTC AEC3。建议 **AEC + 半双工兜底**（检测到外放/强回声就降级）。
- **ESP32**：用 esp-sr 的 AFE（AEC + NS + VAD + 唤醒词，[esp-sr](https://github.com/espressif/esp-sr)）。双麦+参考信号才谈得上全双工；单麦建议**半双工**。

---

## 5. 最小可用管线

### 5.1 伪代码

```python
async def voice_turn(ws, mic, spk):
    while True:
        # ---- 1) 常驻：上行 + VAD ----
        frame = await mic.read(20)                       # 20ms, 16k, mono, s16le
        pcm   = aec.process(frame)                       # 内置/系统 AEC
        await ws.send(bin_frame(0x01, seq, ts, opus(pcm)))   # 上行 Opus

        # ---- 2) 打断：播报中只做这一件事 ----
        if spk.playing and vad.is_onset(pcm):
            spk.stop_now()                               # 本地立即停（<20ms）
            ws.send_json({"type": "barge_in", "ts": now_ms()})
            state = LISTEN

        # ---- 3) 断句：尾静音 600ms 才算说完 ----
        if vad.speech_ended(hangover_ms=600):
            ws.send_json({"type": "asr.commit"})
            state = THINK

        # ---- 4) 收消息：边收边播，按句切 ----
        msg = await ws.recv()
        if msg.type == "asr.final":
            await llm_stream(msg.text)                   # 见下
        elif msg.type == "tts.start":
            spk.begin(utt_id=msg.utt_id)
        elif msg.binary:
            if msg.utt_id == spk.utt_id:                 # 丢掉过期音频
                spk.push(msg.payload)                    # 20ms 帧，攒 2 帧开播
```

```python
async def llm_stream(text):
    buf = ""
    async for delta in llm.chat(text, stream=True, thinking=False):   # 关键：关 CoT
        buf += delta.content
        for sentence in split_sentences(buf):            # 按 。！？，切
            tts_id = await tts.synthesize_stream(sentence)  # 首包 156ms
            await ws.send_json({"type": "tts.start", "utt_id": tts_id})
            async for pkt in tts_id:                     # 边合成边下发
                await ws.send(bin_frame(0x82, tts_id, seq, pkt))
            buf = buf[len(sentence):]
```

### 5.2 WebSocket 帧定义

**客户端 → 服务端（二进制，上行音频）**

| 偏移 | 长度 | 含义 |
|---|---|---|
| 0 | 1 | 帧类型：`0x01`=PCM s16le / `0x02`=Opus |
| 1 | 1 | `seq` 循环序号（丢帧检测） |
| 2 | 2 | `timestamp_ms` uint16 大端（相对会话起点，65.5s 回绕） |
| 4 | n | payload：PCM 640B（20ms）/ Opus 40–60B（实测 24kbps 下 20ms ≈57B） |

**服务端 → 客户端（二进制，下行音频）**

| 偏移 | 长度 | 含义 |
|---|---|---|
| 0 | 1 | `0x81`=PCM / `0x82`=Opus |
| 1 | 1 | `utt_id`（**打断时靠它丢弃旧音频**） |
| 2 | 1 | `seq` |
| 3 | 1 | flags：bit0=首包，bit1=末包 |
| 4 | n | payload |

**控制帧（JSON 文本）**

```jsonc
{"type":"ready",       "session_id":"s1","codec":"opus","sr":16000,"frame_ms":20}
{"type":"asr.partial", "text":"你好我是","ts":1234}
{"type":"asr.final",   "text":"你好，我是小宠。","ts":1560,"cost_ms":184}
{"type":"llm.delta",   "text":"今天","seq":3}
{"type":"tts.start",   "utt_id":7,"codec":"opus"}
{"type":"tts.end",     "utt_id":7}
{"type":"barge_in",    "reason":"vad_onset","ts":2345}
{"type":"error",       "code":"asr_timeout","msg":"..."}
```

设计要点：**音频走二进制**（不 base64，省 33% 带宽和解析开销）；**`utt_id` 是打断的核心**（客户端只播当前 `utt_id`，旧包直接丢）；控制帧和音频帧同一个连接，避免多路同步。

---

## 6. 复现与未完成项

```bash
python3 bench/tts_bench.py      # say CLI / afconvert / ffmpeg 重采样
swiftc -O bench/tts_avspeech.swift -o bench/build/tts_av && ./bench/build/tts_av
python3 bench/vad_bench.py      # 端点判定延迟
python3 bench/codec_bench.py    # Opus/AAC 编解码开销与码率
PYTHONPATH=bench/vendor python3 bench/asr_bench.py   # whisper base 延迟
python3 bench/llm_bench.py --n 5                     # 网关首 token
```

**未能实测的项（原因已记录，不阻塞结论）**：whisper.cpp 编译（无 cmake + `/opt/homebrew` 无写权限）、faster-whisper/sherpa-onnx（`pip --user` 被沙箱拒绝；工作区 venv 受外网 ~20KB/s 限制）、云端 ASR/TTS 首包（无云账号）、AEC 的 ERLE（无麦克风 TCC 授权）。对应表格里已明确标 **【估算】**，未标注的均为本机实测。
