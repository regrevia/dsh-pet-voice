# 鲸灵 · demo 使用说明

零 npm 依赖的本地语音网关 + 一个能装到手机主屏的 PWA。**跑在电脑上，手机只当屏和麦克风。**

## 1. 启动

```bash
cd demo
node server.mjs
#   HTTP   http://127.0.0.1:8787
#   HTTPS  https://<本机IP>:8788   ← 手机麦克风必须走这个
```

首次启动会自动：

- 编译 `tts_worker.swift`（`xcrun swiftc -O`，约 1s，产物在 `.tmp/tts_worker`）；
- 拉起 whisper 常驻进程（`asr_whisper.py`，加载 `~/.cache/whisper/base.pt`，约 2s）。

看状态：

```bash
curl -s localhost:8787/api/health
# {"ok":true,"model":"deepseek-v4.1-flash","llm":true,"tts":true,
#  "ttsEngine":"avspeech","asr":true,"asrEngine":"whisper","voices":["cute","soft","mei"]}
```

`asr:false` 或 `ttsEngine:"say"` 只代表降级，不影响文字聊天。

## 2. 手机上打开

1. 电脑和手机同一个 Wi-Fi，用启动日志里的 `https://192.168.x.x:8788`。
2. 自签证书会警告 → 「高级」→「继续访问」（`demo/certs/` 里的证书 CN=whalepet.local，SAN 覆盖 localhost/127.0.0.1 和本机局域网 IP）。
3. Safari/Chrome 菜单 →「添加到主屏幕」→ 从主屏启动即全屏、无地址栏。
4. 点麦克风授权，按住/点一下开始说；连续对话模式在右上角齿轮里开。

> 换网络会换 IP，证书 SAN 就不匹配了。重新生成：
> ```bash
> cd demo/certs && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
>   -keyout key.pem -out cert.pem -subj "/CN=whalepet.local" \
>   -addext "subjectAltName=DNS:localhost,DNS:whalepet.local,IP:127.0.0.1,IP:$(ipconfig getifaddr en0)"
> ```

## 3. 三个接口

| 接口 | 入 | 出 | 说明 |
| --- | --- | --- | --- |
| `POST /api/chat` | `{"messages":[{role,content}…]}` | SSE：`data: {"delta":"…"}` … `data: {"done":true,"ms":488,"ttft":265}` | 服务端注入 persona（鲸灵）、`thinking:disabled`、`max_tokens:512`；客户端断开即 abort 上游 |
| `POST /api/tts` | `{"text":"…","voice":"cute"}` | `audio/wav`（22.05kHz 单声道） | 内存缓存 120 条；`cleanForTTS` 去掉 markdown/emoji/括号动作，最多 280 字 |
| `POST /api/asr` | 原始 webm/opus 字节 | `{"text":"鲸灵，今天天气怎么样？"}` | 服务端 ffmpeg 转 16k wav → whisper；未就绪返回 501 |
| `GET /api/health` | — | 见上 | 前端用它显示「在线/离线」和引擎状态 |

## 4. 引擎与降级

**TTS**（`ttsEngine`）
1. `avspeech` — 常驻 `tts_worker.swift`，进程内合成，**172–337ms/句**；
2. `say` — `say -o aiff` + `ffmpeg` 升调，**640–670ms/句**（全是进程启动）；
3. 都没了就 500，前端会退化成只显示文字。

**ASR**（`asrEngine`）
1. `whisper` — `/usr/bin/python3 demo/asr_whisper.py base`，自带 `initial_prompt` 热词（「鲸灵/小宠」），3s 音频 ~184ms；
2. `vosk` — `demo/.venv/bin/python demo/asr_worker.py <模型目录>`，需要 `demo/asr/vosk-model-small-cn-0.22`；
3. 都没有 → `/api/asr` 返回 501，前端提示「文字聊天不受影响」。

> whisper 依赖新版 `typing_extensions`，系统自带的太旧，所以启动时把 `demo/asr/vendor/` 放进 `PYTHONPATH`。

## 5. 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `PET_PORT` | `8787` | HTTP 端口 |
| `PET_HTTPS_PORT` | `8788` | HTTPS 端口（缺 certs 时自动关闭） |
| `PET_LLM_BASE` | `http://192.168.11.18:30055` | LLM 网关（Anthropic Messages 协议） |
| `PET_LLM_MODEL` | `deepseek-v4.1-flash` | 模型名 |

凭证从 `~/.dsh/.credentials.yaml` 读 `COMPANY_LLM_TOKEN`，其次 `DEEPSEEK_API_KEY`；**只在服务端用，不下发前端、不写日志**。

## 6. 目录

```
demo/
├── server.mjs          # 网关（零依赖）
├── tts_worker.swift    # 常驻 AVSpeechSynthesizer（编译到 .tmp/tts_worker）
├── asr_whisper.py      # 常驻 whisper
├── asr_worker.py       # 常驻 vosk（备选）
├── asr/vendor/         # typing_extensions 垫片
├── certs/              # 自签证书
├── public/             # PWA：index.html / style.css / app.js / pet.js / manifest / icon
├── .venv/              # vosk 用的 python 环境（可选）
└── .tmp/               # 运行时临时文件、日志、截图（已 gitignore）
```

调试像素形象：`http://127.0.0.1:8787/pet-preview.html?m=talking`（8 倍放大 + 模式切换）。

## 7. 已知限制

- 只在 macOS 上验证（`say`/`AVSpeechSynthesizer`/`ffmpeg` 都是 macOS 路径）；Linux 上 TTS 需要改回 `espeak-ng` 或云 TTS。
- 打断（barge-in）目前靠前端 `AudioBufferSource.stop()` + 丢弃未播句子；真正的回声消除依赖系统 AEC，外放音量大会把自己说的话听进去。
- 单进程单文件缓存，重启即失效；多设备同时连没有做并发限流。
- 局域网明文 HTTP（8787）拿不到麦克风权限，必须 HTTPS。
