# ASR / TTS 细节基准（脚本级，wav 直喂）

`docs/pet-bench.md` 是 `scripts/pet-bench.mjs --write` 整篇生成的文件，写进去会丢，所以细节基准放这里；那边只留一个指向本文件的脚注。

样本：`/tmp/pvtest/a1.mp3`（0.53 s）、`a2.mp3`（2.93 s）、`a3.mp3`（4.42 s），转 16 kHz 单声道 wav 直喂（`bench/asr-latency/make_samples.sh`）。**这三条不是真人说话**，是按 TTS 合成 + 掺噪声做的代理样本；真人语音的识别率不在这份基准里。

一键重跑：`scripts/asr-bench.sh --mode warm|host|cold|stability|all`（`--n`、`--wav a,b`、`--out`、`--strict`）。
`--strict`：开跑前读一次 worker 的 `/health`，后端不是 `mlx-whisper` 就直接失败（退出码 2）；不开也照样打一行⚠，结果 JSON 里固定记 `backend` / `device`。
解释器：`PY` 默认 canonical asr-venv（worker 解释器也是它）；换 mlx 要 `ASR_PY=<装了 mlx-whisper 的 venv>/bin/python ASR_BACKEND=mlx`；测 RSS/杀 worker 的解释器要带 psutil，用 `BENCH_PY=/tmp/bench-venv/bin/python`（没 psutil 会退回 `pgrep` 杀进程、RSS 量不到）。

## 热路径：直连 worker（`--mode warm`）

| 后端 | a1 (0.53 s) | a2 (2.93 s) | a3 (4.42 s) | 备注 |
| --- | --- | --- | --- | --- |
| 改前 openai-whisper CPU | 1162 ms | 1268 ms | 1272 ms | n=30 中位 1234 / p95 1389 / max 1290 |
| 改后 mlx-whisper（Metal） | **456 ms** | **482 ms** | **508 ms** | 中位 507、p95 509；文本与 whisper 逐字一致 |

30 连打（`--mode stability --n 30`）：whisper 30/30 成功、0 失败、0 空文本，RSS 3869 → 3882 MB（+13 MB，噪声内），中位 1198 / p95 1280 / max 1290 ms；mlx 同样 30/30、0 失败，中位 454 / p95 456 / max 522 ms。

坏输入不挂：空 body 5 ms 返回 `{"ok":true,"text":""}`；非 WAV（全零 / 乱码）1–2 ms 返回 `{"ok":false,"error":"WAV 解析失败：file does not start with RIFF id"}` —— 中文错误、进程不退、后续请求照常。

## 宿主路由（`--mode host`，含插件开销）

- a3 × 10：改前中位 **1366 ms**、p95 1633 ms（n=10，loadavg [4.45,4.69,4.51]）；worker 自报 1351–1627 ms ⇒ 宿主转发开销 ≤ 6 ms，ASR 延迟就是模型延迟。
- 同一个路由打 mlx worker：中位 **508 ms**、p95 526 ms（n=10）—— 手机这一跳从 1.37 s 降到 0.51 s。
- 冷启动（杀掉 worker 后第一次点击，用户真正感受到的那一次）：改前 **9435 ms**（whisper，其中拉起 ~8.4 s）→ 改后 **3196 ms**（mlx，拉起 ~2.7 s + 识别 466 ms）。

## 冷启动（`--mode cold`，拉起 → 首个结果）

| 后端 | ready | 首个结果 | 内存 |
| --- | --- | --- | --- |
| 改前 openai-whisper | 6575 ms | 7776 ms | 常驻 RSS 3869 MB |
| 改后 mlx-whisper | **3850 / 3862 / 3938 / 4082 ms**（四次） | **4385–4457 ms** | 加载完 1644–1756 MB，空闲掉到 ~50 MB |

- 内存口径：whisper 常驻 3.9 GB；mlx 权重走统一内存按需映射、系统可回收，所以「峰值 1.6 GB、平时几十 MB」。USS 非 root 取不到，别拿某一时刻的单点 RSS 下结论。
- 每次冷启动都带一次 `WARMUP_SECONDS=1.0` 的空转热机，它算在 ready 里，不算在首个结果里。
- 最近一次复测（canonical venv，`auto` 自动选 mlx）：`杀掉 worker：[24849]` → ready 3862 ms、首个结果 521 ms、`to_first_result_ms` 4385、RSS 1756 MB，退出码 0。
- bench 以前会**误杀自己**（它的包装 shell 命令行里带 worker 路径，`pgrep -f asr-worker` 一并命中，背景任务报 `killed SIGTERM`）；现在排除自身 pid/ppid、只匹配 `asr-worker.py` 且不含 `-c`，没有 psutil 时退回 `pgrep` 也不再返回空列表。判读规则：`杀掉 worker：[…]` 必须非空，`ready≈2 ms` 就是没杀成、量的是旧 worker。

## mlx 为什么长期没生效（根因）

1. 发出去的 `asr-worker.py` 里 `MLX_REPOS["large-v3-turbo"]` 写成了 `mlx-community/whisper-large-v3-turbo-mlx`，该仓库不存在（401/Repository Not Found）；`auto` 探测失败后**静默退回 CPU whisper**，日志只出现在 worker.log。正确仓库是 `mlx-community/whisper-large-v3-turbo`（turbo 没有 `-mlx` 后缀）。
2. canonical venv 原来是 3.9.6，装不了 `mlx`（要 ≥3.10），所以即使仓库名对了也起不来。现已按 3.12 重建（旧 venv 挪到 `~/.dsh/pet-voice/asr-venv-py39` 可回滚）。
3. `setup.sh` 第 70 行 `say "· 预下载模型：$MODEL（…"` 里 `$MODEL` 紧跟全角括号，bash 把括号首字节并进变量名，`set -u` 直接 `MODEL�: unbound variable` 退出 —— 模型预下载整段被跳过。已改成 `${MODEL}（`。**这就是「第一次预下载没生效」的直接原因。**
4. 判断有没有真的走 GPU 不能只看 `ready:true`：`GET /pet-voice/api/asr` 现在返回 `backend` / `device`，CPU 态附 `slow:true`。曾经用 canonical venv 跑出 ASR 中位 1184 ms，查 worker.log 才发现是 `IncompleteSnapshotError: weights.safetensors missing` 回退 CPU。

因此 `scripts/pet-bench.mjs` 的 ASR 段和 `scripts/asr-bench.sh` 都会先读一次后端：不是 `mlx-whisper` 就打一行警告，`--strict` 直接失败，别把回退的 1.2 s 当中位数写进表。

## TTS 首字节（`?stream=1`）

命令：`scripts/tts-bench.sh --mode all --n 8`（每条文本加「第 i 遍。」绕开缓存；`--mode` 还支持 `daemon` / `legacy` / `concurrency`）。同一轮、同一 loadavg、n=8：

| 路径 | 首字节中位 | p95 | 备注 |
| --- | --- | --- | --- |
| 常驻 WS（`tts/stream.py` + `tts-daemon.py`） | **239 ms** | **286 ms** | 建连 0 ms，合成首帧 180 / 213 ms（n=8，loadavg 12.05） |
| 每次现建连接（改前行为，`PET_TTS_NO_DAEMON=1`） | 944 ms | 1096 ms | 整句 1254 / 1694 |
| 宿主 `?stream=1`（线上插件仍跑旧 `stream.py`） | 1014 ms | 1957 ms | 整句 1296 / 3104；未命中缓存的 n=8 另测为 229 / 269 |

引数字前先看 `cache=`：宿主路由命中 TTS 缓存时是 1–21 ms（`cache=hit`），那不是合成速度，别当成优化成果；上表宿主行都是 `cache=miss`。

三列要分开记，混着记就说不清钱花在哪：

- **建连**：常驻连接稳态 **0 ms**（一次握手只发生在进程首启或断线重连时，实测 573–716 ms，重连 842 ms）；改前是**每句**都要付 760–900 ms。
- **合成**（文本帧发出 → 厂商第一个音频包）：175–342 ms，这是删掉连接开销后的真·合成时间。
- **首字节**（调用方拿到第一个音频字节）：在合成之上再加进程启动 70–100 ms 与传输。

实现：`plugins/dsh-pet-voice/tts/tts-daemon.py` 常驻 2 条 WS 连接（`PET_TTS_DAEMON_CONNS`），每条连接同一时刻只归一个请求，所以并发两句不会串流；`pool.start()` 只同步等第一条，第二条异步预热。`stream.py` 连 unix socket（`~/.dsh/pet-voice/tts/daemon.sock`，0600），连不上就自己拉起守护进程再重连；守护进程不在就退回原来的直连路径（`PET_TTS_NO_DAEMON=1` 可强制）。**CLI 契约、退出码、`PET_TTS_RAW`、掐头去尾逻辑全不变**：音频仍是原样返回给 `stream.py` 再裁剪，同一句话两条路径输出 mp3 逐字节相同（已 `cmp` 验证）。

并发 A/B（`--mode concurrency`，两句同刻发）：「请把窗户关一下，外面在下雨。」与「明天早上七点叫我起床，谢谢。」→ 首字节 224 / 223 ms，启动偏差 6 ms，各自 mp3 回读 ASR 得 `请把窗户关一下,外面再下雨。` 与 `明天早上七点叫我起床,谢谢。`，互不出现对方关键词，字节数不同 ⇒ 不串音。

保活（空闲不算断）：Edge 侧不合成约 40 s 左右就把 WS 正常关掉（`code=1000`；实测 30 s 还活着、45 s 已死、60 s 已死）。两条路都试过没用：每 20 s 发 `ws.ping()`（8 次）拦不住；每 20 s 真发一句「嗯」做带内保活，8 次全部正常返回，但整条连接仍在 ~150 s 处被判死（可能还有连接总寿命上限），所以不能靠保活续命，只能提前轮换。所以守护进程分三层兜：① 最近 180 s 内还在用的时候，后台每 20 s 把空闲超 20 s 的连接换成新连接，换连接不占回合时延；② 拿到的连接已经放久了的，先重建再发；③ 真撞上死连接（回合「正常」结束但零音频包）就立刻重连重试一次，且只在还没吐出音频时才重试（避免重音）；`stream.py` 收到零音频退回直连，不让用户觉得「点了没声」。实测空闲 100 s / 150 s 后复用：建连 0 ms、vendor 首帧 263 / 345 ms 正常出声；停顿超 3 分钟（轮换已暂停）后首句多付一次建连 ~600 ms。轮换一轮只换一条（另一条保持热），握手那 ~600 ms 万一撞上请求也不会两条都不可用。验版本：`tts-daemon.py --status` 末尾会打 `版本=…`，就绪日志同。

注意：**线上插件跑的是 `~/.dsh/plugins/dsh-pet-voice/tts/stream.py`（旧副本）**，所以宿主路由这一行还没变快；把 `stream.py` 与 `tts-daemon.py` 一起部署到该目录后，宿主即可落到常驻档位，`index.js` 不需要改。

## 噪声与口径

- 所有数字都来自本机（Apple M4 Pro 12 核 / 16 GB / macOS 27.2 arm64），报数字时带 loadavg；机器上有人跑会整档飘。
- 出现过一次 13.73 s 的异常值（loadavg 6.57），判定为争用不是缺陷，未计入中位。
- 冷启动 ready 里包含 1.0 s 空转热机；宿主路由的「总耗时」包含插件 15 s 等待窗口内的拉起。
- 真机端到端秒数（点一下 → 出声）还没验，需要的 logcat 埋点在 `FloatingPetService.kt` 的 `PetLatency` 里。
