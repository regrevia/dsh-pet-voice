# 手机端「流式回复」+「语音延迟」断点定位与改动

目标只有一句：**不让人等。** 下面每条结论都带证据（时间线 / 行号 / 实测毫秒），没有推断当成事实写。

## 一、断点在哪

### 问题 1（回复整段出现）：宿主没问题，断点在 App 的「出字粒度」

宿主侧实测（SSE 探针，`GET /pet-voice/api/stream`，sessionId 过滤）：

```
start   seq 1-2
delta   seq 3..23   21:54:03.931 → 21:54:05.308（21 帧，1.38s 内到齐）
message seq 24/25   （非终结帧，只补累计文本）
final   seq 26
```

- 增量**没有**被攒块、没有 throttle、没有 flush 缓冲：`index.js` 的 `text-delta` 分支就是 `emit(sessionId,'delta',{text})` 后 `return`。
- 手机端 `PetTurn` 也确实每帧都收到（`PetTurn.kt:556` → `feedSentences(d)`、`PetTurn.kt:558` `cb.onAssistant(full,false)`）。

真正把「流」掐成「块」的是渲染侧：

| 位置 | 现状 | 后果 |
|---|---|---|
| `FloatingPetService.kt:1340-1344` | `if (!isFinal \|\| fullText.isBlank()) return` | 非终结帧的完整文本被丢弃 → 只有整条结束时才落 `PetHistory` |
| `PetTurn.kt:679-692` `sentenceBoundary` | 只在 `。！？!?；;\n` 切，逗号要 `>90` 字才退让 | 气泡（`FloatingPetService.kt:1346-1356` → `say()` → `boot.js:231` `PetBridge.say`）**按句换**，长句要等整句才出现在头顶 |
| `MainActivity.kt:822-824` | 每帧都刷 `replyView` | 聊天窗其实是流的（可作对照） |

所以「整段一次性出现」= 回复只有一两句时，第一句边界 ≈ 整条结束；再叠加 TTS 排队，看起来就像整段蹦出来。**不是宿主压着不发。**

### 问题 2（语音要等）：等的是微软的首包，且等的是「整句」

- `tts/stream.py` 原实现把厂商分块全攒起来，收完再做 `_trim_silence`（ffmpeg 掐头去尾）才写 stdout ⇒ 首字节 = 整句合成完。
- 手机 `PetClient.downloadTts`（`PetClient.kt:273-298`）下完整个 body 才交给 `MediaPlayer` ⇒ 首声 = 首字节 + 下载 + prepare。
- 关键实测（`zh-CN-XiaoyiNeural`，whale 档，n=3，取中位）：

| 场景 | 首字节 TTFB | 说明 |
|---|---|---|
| 25 字整句，现网（攒完 + ffmpeg） | **2106 ms**（1708/2106/2384） | 用户现在等的就是它 |
| 25 字整句，`PET_TTS_RAW=1` 边收边写 | **1015 ms**（1015/1281/956） | 厂商首块 850–1800ms 直接转出去 |
| 8 字小句，现网 | **1681 ms** | 短句并不更快 |
| 8 字小句，raw | 1355 ms | 同上 |

**宿主侧 HTTP 实测**（热重载后打真机同一路径，`GET /pet-voice/api/tts?preset=whale`，n=9 每模式、每句全新文本、两种模式交错跑，取中位）：

| 模式 | 首字节 TTFB（中位） | 区间 | 说明 |
|---|---|---|---|
| 现网（不带 `stream=1`） | **3.06 s** | 1.68–10.22 s | 厂商抖动会出 6–10s 尖峰 |
| `stream=1` | **1.60 s** | 1.20–3.09 s | 首字节 −1.46 s / **−48 %** |

`stream=1` 的 `total` 反而比现网长 ~0.4 s（1.60→2.47 s 中位）：raw 不掐句尾静音。这只对「边收边播」有意义，所以必须配合 P3；没升级的 App 不要传 `stream=1`。

**短句不比长句快**：耗时下限是「建连 + 厂商首包」，不是文本长度。这条决定了下面两个设计取舍：

- 请求到达时把整句并发拆成 4 小句现合成：**3748 ms**（中位）vs 整句一次 **2248 ms** → 慢 1.7 倍。**不要在请求路径上发散并发**，会抢带宽。
- 小句**全命中缓存**时拼接：**0.01–0.09 ms**（实测 `Buffer.concat`，4 小句 23KB）。这条是纯赚。

## 二、这次改了什么（只在 `plugins/dsh-pet-voice/`）

### `index.js`
1. `?stream=1` → 给 `stream.py` 传 `PET_TTS_RAW=1`（`x-tts-cache` 之外的唯一行为开关）。
2. 小句快路径：整句请求若能被切成多小句且**每块都已在缓存**，直接 `Buffer.concat` 返回（`x-tts-cache: clause`），不起子进程、不碰网络。缺块一律退回整句合成。
3. `text-delta` 分支注释改成实况（原样转发，不攒块）。
4. **删掉了**之前加的「边吐字边预热小句」：实测它省不掉用户的那次等待（手机请求和预热是同一瞬间触发的），反而会和请求抢带宽（见上表 3.7s vs 2.2s）。保留 `speechClauses()` 纯函数给上面的快路径用。少一条后台路径，就少一个「为什么有时更慢」的解释成本。
5. 缓存键核对：`ttsCacheKey = v2|provider|voice|rate|pitch|text`，**provider / voice 已在键里**，不会串音；小句缓存与整句缓存共用同一个 LRU（48 项 / 16 MiB），如果开小句快路径，建议提到 120 项 / 24 MiB。

### `tts/stream.py`
- 新增 `PET_TTS_RAW=1`：厂商来一块写一块（立刻 `flush`），跳过 `_trim_silence`。
- 默认（不传 env）行为完全不变 —— 线上现有调用方零影响。
- 代价写清楚了：raw 模式做不了整句掐头去尾，句尾约 0.5s 厂商静音会留下，所以只给「边下边播」的客户端用。

验证：`node --check index.js` → SYNTAX OK；`python -c "ast.parse(...)"` → PY SYNTAX OK；切句纯函数性质测试（往返一致 + 任意前缀一致）→ `roundtrip exact: true`、`prefix-consistent: true`。

## 三、App 侧补丁建议（`android/` 只读，未改）

### P1 气泡按增量出字（解问题 1，改动最小）

`FloatingPetService.kt:1340` 换成：

```kotlin
private var lastBubbleAt = 0L      // 类字段

override fun onAssistant(fullText: String, isFinal: Boolean) {
    if (destroyed || fullText.isBlank()) return
    if (isFinal) {
        PetHistory.append(this@FloatingPetService, PetHistory.ROLE_PET, fullText)
        return
    }
    val now = SystemClock.elapsedRealtime()
    if (now - lastBubbleAt < 60) return          // 60ms 节流：60fps 下看不出跳
    lastBubbleAt = now
    // 气泡只显示尾巴，长回复不挤爆（boot.js:234 本来也只留 90 字）
    say(fullText.takeLast(72).trimStart('，', '。', '、', ' ', '\n'))
}
```

### P2 首句更早切口（解问题 2 的「等整句」，`PetTurn.kt:686-690`）

现在要 90 字才在逗号处退让。改成：长度过 24 字就允许在逗号/顿号处切一刀。

```kotlin
if (buf.length > 24) {
    val idx = buf.lastIndexOfAny(charArrayOf('，', ',', '、', ' '))
    if (idx > 12) return idx + 1
}
if (buf.length > 90) { /* 保留原来的兜底 */ }
```

首句从「说完整句」提前到「说完第一个分句」，配合 P3 立刻出声。

### P3 边下边播（解问题 2 的剩余 1 秒）

两处：

1. `PetClient.kt:276` 请求加参数，让宿主讲真流式：

```kotlin
val conn = open("tts", mapOf("text" to text, "preset" to preset, "stream" to "1"), "GET", 60_000)
```
（`open(path, query, method, timeout)` 的第二个参数就是 query map，见 `PetClient.kt:449`；不加这个键则宿主保持现网行为。）

2. `TtsPlayer.kt:349-356` 把 `setDataSource(path)` 换成 `MediaDataSource`，读到多少喂多少：

```kotlin
val src = object : MediaDataSource() {
    override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
        /* 从 downloadTts 的线程安全缓冲里取；还没到就 wait()，流结束返回 -1 */
    }
    override fun getSize(): Long = -1        // 长度未知：MediaPlayer 会一直读到 -1
    override fun close() {}
}
mp.setDataSource(src)
mp.prepareAsync()
```

收益：首声从「整句合成完 + 下载完」变成「厂商首块到达」（实测 1015ms vs 2106ms），句尾静音问题由播放端 `next` 的衔接节奏吸收。

> 注意顺序：P1/P2/P3 都可独立上线；P3 依赖宿主先装上新版 `stream.py`（`PET_TTS_RAW`）。

## 四、生效步骤（需要 lead 做，我这边写不进 `~/.dsh`）

```bash
cp plugins/dsh-pet-voice/index.js      ~/.dsh/plugins/dsh-pet-voice/index.js
cp plugins/dsh-pet-voice/tts/stream.py ~/.dsh/plugins/dsh-pet-voice/tts/stream.py
curl -s -X POST http://127.0.0.1:60930/dsh-unlag/reload    # 不重启宿主（PID 66999）
```

装完已补端到端实测（见上表：首字节 3.06s → 1.60s）。**注意：这份 `index.js` 里带了 lead 的 `liveTurns` 幽灵轮次清理，直接 `cp` 仓库版本不会丢**；两份文件当前 `diff` 为空。

## 五、没做 / 风险

- 没有做「常驻 python worker 复用连接」：能再省 ~150–250ms（解释器 + import + 建连），但要改子进程协议，收益小于 raw 模式，先不动。
- 没有做「整句先合成一半就发」的服务器侧分段：`edge-tts` 的 mp3 是连续流，硬切会爆音；正确做法就是 P3 让客户端边下边播。
- raw 模式会留下句尾静音：只在 `stream=1` 时生效，且必须配合 P3 才有意义，别让没升级的 App 拿到 raw。
- raw 音频**不写共享缓存**：句尾静音没掐，写进去会让之后用普通请求要同一句的设备拿到更长的未修剪版（实测同句 `stream=1` 30816 B，随后普通请求 1.3 ms 命中、同样是 30816 B）。现在 `stream=1` 只读缓存不写，代价是 raw 请求不复用缓存——正确性优先。
