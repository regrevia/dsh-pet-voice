# bench/ — 语音管线延迟实测

配套文档：[`docs/voice.md`](../docs/voice.md)。所有数字均在这些脚本里可复现；机器：macOS 26.5.2 / arm64 / Python 3.9.6，2026-10-24。

## 脚本一览

| 脚本 | 测什么 | 产出 |
|---|---|---|
| `tts_bench.py` | `say` CLI 合成 / `afconvert` 转 m4a / `ffmpeg` 重采样到 16k 的墙钟耗时（每项 5 次取中位数） | `results/tts_bench.json` |
| `tts_avspeech.swift` | **进程内** `AVSpeechSynthesizer.write(_:toBufferCallback:)` 首 buffer 延迟、总耗时、buffer 数 | `results/tts_avspeech.json` |
| `asr_bench.py` | openai-whisper `base`（CPU）加载耗时、整句转写、3s / 1.5s 前缀转写、RTF | `results/asr_bench.json` |
| `vad_bench.py` | 纯 stdlib 能量 VAD：起点判定延迟、端点判定延迟随 hangover(300/500/700/1000ms) 的变化 | `results/vad_bench.json` |
| `codec_bench.py` | Opus 16k@24kbps / 16kbps、AAC 32k 的编解码耗时、实际码率、包数 | `results/codec_bench.json` |
| `llm_bench.py` | 网关 `/v1/chat/completions` 流式：首 delta（含 reasoning）、首个 `content`（可用于 TTS）、总耗时 | `results/llm_bench.json`、`results/llm_thinking_probe.json` |
| `vpio_check.swift` | 检查 `AVAudioEngine` 的 Voice Processing I/O（系统 AEC）是否可用 | `results/vpio_check.txt` |

## 怎么跑

```bash
python3 bench/tts_bench.py
swiftc -O bench/tts_avspeech.swift -o bench/build/tts_av && ./bench/build/tts_av
swiftc -O bench/vpio_check.swift   -o bench/build/vpio    && ./bench/build/vpio
python3 bench/vad_bench.py
python3 bench/codec_bench.py
PYTHONPATH=bench/vendor python3 bench/asr_bench.py
python3 bench/llm_bench.py --n 5
```

依赖：`ffmpeg`（Homebrew）、`say`/`afconvert`（macOS 自带）；ASR 需要本机已装的 `openai-whisper` + `torch`；LLM 需要网关 token（脚本运行时从 `~/.dsh/.credentials.yaml` 读取，**不落盘、不打印**）。

> `bench/vendor/` 里只有一个 `typing_extensions 4.16.0`：系统自带的 4.4.0 太旧，`torch 2.8.0` 导入即 `ImportError: cannot import name 'deprecated'`。用 `PYTHONPATH=bench/vendor` 覆盖即可，不需要动系统 Python。

## 关键结果（节选）

- **TTS 进程内 vs CLI**：AVSpeechSynthesizer 首 buffer **155.8–161.4ms**；`say` CLI 643–675ms 且几乎不随文本长度变化 → 差异全是 ~600ms 进程启动。
- **ASR**：whisper `base` / CPU，3s 前缀 **183.7ms**，4.23s 整句 **204.2ms**（RTF 0.048），模型加载 374.6ms。MPS 不可用（`SparseMPS` 未实现 `aten::_sparse_coo_tensor_with_dims_and_tensors`）。
- **VAD**：起点 0ms（20ms 帧粒度、算法 0.01ms）；端点判定对 hangover 极敏感——**300ms 档会在句中 2.4s 处误切**，500ms 以上才与真实结尾对齐（−20ms）。
- **LLM**：`anthropic/DeepSeek-V4.1-Flash` 首个 delta 243–320ms，但首个 `content` 中位要 **1680ms（long）/3174ms（short）**，区间 1098–3179ms（思维链吃掉了预算）；`anthropic/GLM-5.3` 3.7s，更差。`thinking.type=disabled` / `enable_thinking=false` / `reasoning_effort=none` 三个参数都**没有**把它降到 300ms 量级（实测，见 `results/llm_thinking_probe.json`）。
- **Codec**：Opus 16k/24kbps 有效码率 23.0kbps，4.23s → 12165B / 212 包；编解码 47.5/24.4ms（含 ffmpeg 进程启动，是上界）。

## 没能实测的（原因已确认，不重试）

| 项目 | 原因 |
|---|---|
| whisper.cpp（base/small + Metal） | 本机无 `cmake`；`/opt/homebrew` 与 `/usr/local` 无写权限（沙箱）；ggml 模型从 hf-mirror 下载实测 **0 B/s**、GitHub 约 22KB/s |
| faster-whisper / sherpa-onnx | `pip --user` → `[Errno 1] Operation not permitted`（写 `~/Library/Python` 越界）；工作区 venv 可写但 PyPI 吞吐 ~20KB/s，14 分钟只落了 7.4MB 缓存 |
| 云端 ASR/TTS 首包 | 无云厂商账号 |
| AEC 的 ERLE | 无麦克风 TCC 授权（审批弹窗被禁用），`setVoiceProcessingEnabled(true)` 抛错；API 本身存在（见 `vpio_check.txt`） |

这些在 `docs/voice.md` 的表格里都标成了 **【估算】** 或直接写「未实测」，未标注的才是实测值。
