package com.whale.pet

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.SpeechRecognizer

data class WakeHit(val word: String, val rest: String)

/**
 * 唤醒词引擎接口。v1 = 系统语音识别循环（在线/系统服务），第二版可整体替换为
 * sherpa-onnx / Vosk 离线 KWS —— 替换时只实现这个接口，不碰悬浮窗/对话链路。
 */
interface WakeWordEngine {
    val id: String
    val displayName: String
    fun isAvailable(): Boolean
    fun setListener(listener: ((WakeHit) -> Unit)?)

    /** 运行期可改称呼（设置里 2–4 字的 wakeName）。默认实现忽略。 */
    fun setWords(words: List<String>) {}

    fun start()
    fun stop()
}

object WakeWordEngines {
    /** 之后加离线实现时，按设置里的 id 在这里选。 */
    fun create(context: Context): WakeWordEngine = NativeSpeechWakeWordEngine(context)
}

/**
 * 用系统 SpeechRecognizer 连续听，命中自定义称呼就回调。
 *
 * 约束（与产品约定一致）：
 * - 只由 [FloatingPetService] 在「wakeEnabled=true 且悬浮窗可见且待机」时 start()，
 *   进入对话/说话/暂停时立刻 stop()，不长期占着麦克风；
 * - 一轮结束回 idle 才重新 start()，避免 TTS 自己的声音把自己唤醒（回声自激）；
 * - 命中后要求整句长度 ≤ 称呼长度 + 10，避免长句里偶然出现称呼就打断。
 *
 * 局限：依赖设备上的识别服务（Google / 讯飞 / 厂商），模拟器上通常永远 no-match；
 * 重启识别在部分机型有提示音/耗电；误唤醒率需真机实测，第二轮换离线 KWS。
 */
class NativeSpeechWakeWordEngine(
    context: Context,
    initialWords: List<String> = listOf("大肥鱼", "肥鱼"),
) : WakeWordEngine {

    override val id: String = "native-speech"
    override val displayName: String = "系统语音识别（在线）"

    private val asr = NativeAsr(context)
    private val main = Handler(Looper.getMainLooper())
    private var running = false
    private var listener: ((WakeHit) -> Unit)? = null
    private var consecutiveErrors = 0

    @Volatile
    private var words: List<String> = initialWords.filter { it.isNotBlank() }.distinct()

    override fun isAvailable(): Boolean = asr.isAvailable()

    override fun setListener(listener: ((WakeHit) -> Unit)?) {
        this.listener = listener
    }

    override fun setWords(words: List<String>) {
        val clean = words.filter { it.isNotBlank() }.distinct()
        if (clean.isNotEmpty() && clean != this.words) this.words = clean
    }

    override fun start() {
        if (running) return
        if (!isAvailable()) return
        running = true
        consecutiveErrors = 0
        listenOnce()
    }

    override fun stop() {
        val wasListening = running
        running = false
        main.removeCallbacksAndMessages(null)
        asr.cancel()
        // 识别器跑在系统服务进程里，cancel() 还要走 binder 才真的把输入设备放掉；
        // 这期间别人开 AudioRecord 拿到的是全零 PCM（真机上表现为「人声0ms」）。
        // 只有「本来在听」才需要冷却：重听路径里 stop() 会连着来好几次，
        // 每次都重新计时会让录音机永远开不了。
        if (wasListening) MicHandover.engineStopped()
    }

    private fun listenOnce() {
        if (!running) return
        var settled = false
        asr.start(object : NativeAsr.Listener {
            override fun onReady() = Unit

            override fun onPartial(text: String) {
                // 边说边匹配：中间结果命中就立刻醒，不用等 final（各省 0.4–1.5 s）。
                // settled 保证后面的 final/onEnd 不会二次触发。
                if (!running || settled) return
                val hit = match(text) ?: return
                settled = true
                consecutiveErrors = 0
                asr.cancel()
                listener?.invoke(hit)
                schedule(400)
            }

            override fun onFinal(text: String) {
                if (!running || settled) return
                settled = true
                consecutiveErrors = 0
                val hit = match(text)
                if (hit != null) listener?.invoke(hit)
                schedule(if (hit != null) 500 else 220)
            }

            override fun onError(message: String, code: Int) {
                if (!running || settled) return
                settled = true
                // 权限被拒也别退场：用户之后再给权限，这一轮就该自己活过来
                if (code == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                    schedule(5000)
                    return
                }
                consecutiveErrors = (consecutiveErrors + 1).coerceAtMost(10)
                val delay = when (code) {
                    SpeechRecognizer.ERROR_NO_MATCH,
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
                    -> 180L
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
                    SpeechRecognizer.ERROR_CLIENT,
                    -> 1500L
                    else -> 800L + consecutiveErrors * 200L
                }
                schedule(delay)
            }

            override fun onEnd() {
                // onFinal/onError 已经安排了下一轮；这里兜底防止静默结束。
                if (!running || settled) return
                settled = true
                schedule(500)
            }
        })
    }

    private fun schedule(delayMs: Long) {
        if (!running) return
        main.postDelayed({ listenOnce() }, delayMs)
    }

    /** 命名匹配：归一化后找称呼，命中且整句不过长才算；剩余部分当一句话。 */
    internal fun match(raw: String): WakeHit? = matchText(raw, words)

    companion object {
        /** 命中后允许的额外字数上限，超了视为聊天里顺口提到，不唤醒。 */
        const val MAX_EXTRA_CHARS = 10

        /** 称呼前允许出现的字数；在前就是这个字数的语气词/口头语，不算「句子中间提到」。 */
        const val LEAD_SLACK = 2

        /** 纯匹配逻辑，方便单测（不依赖 Context / 麦克风）。 */
        fun matchText(raw: String, words: List<String>): WakeHit? {
            val text = normalize(raw)
            if (text.isEmpty()) return null
            var best: WakeHit? = null
            var bestIdx = Int.MAX_VALUE
            for (w in words) {
                val key = normalize(w)
                if (key.isEmpty()) continue
                val idx = text.indexOf(key)
                if (idx < 0 || idx >= bestIdx) continue
                // 防误触：称呼在句子中间时，整句不超过「称呼 + 10 字」；
                // 称呼在开头（含前 2 字的语气词）时允许后接一整句话，别把正常请求挡掉。
                if (idx > LEAD_SLACK && text.length > key.length + MAX_EXTRA_CHARS) continue
                bestIdx = idx
                best = WakeHit(w, text.substring(idx + key.length))
            }
            return best
        }

        private val PUNCT = "，。！？、；：“”‘’（）《》【】…—～·,.;:!?\"'()<>[]{}".toSet()

        /** 全角转半角 + 去掉标点/空白 + 英文小写，避免「鲸 灵」「鯨靈！」之类漏匹配。 */
        internal fun normalize(raw: String): String {
            val sb = StringBuilder(raw.length)
            for (ch in raw) {
                var c = ch
                if (c.code in 0xFF01..0xFF5E) c = (c.code - 0xFEE0).toChar()
                if (c == '\u3000' || c == ' ' || c == '\t' || c == '\n' || c == '\r') continue
                if (c in PUNCT) continue
                if (c.isWhitespace()) continue
                sb.append(c.lowercaseChar())
            }
            return sb.toString()
        }
    }
}

/** 关闭唤醒时的占位实现，方便以后在设置里做开关/对比。 */
class DisabledWakeWordEngine : WakeWordEngine {
    override val id: String = "disabled"
    override val displayName: String = "关闭"
    override fun isAvailable(): Boolean = false
    override fun setListener(listener: ((WakeHit) -> Unit)?) = Unit
    override fun start() = Unit
    override fun stop() = Unit
}

/**
 * 麦克风交接：唤醒引擎（系统 SpeechRecognizer，跑在别的进程里）和 PTT 录音（AudioRecord）
 * 抢同一个输入设备。`cancel()` 要经 binder 到识别服务进程才真正释放输入，
 * 紧接着开 AudioRecord 会绑上一条已经被停掉的音轨，`read()` 永远读不到帧 → 全零 PCM
 * （真机日志里就是「人声0ms」）。
 *
 * 所以这里只记一个「最早可以开麦的时刻」，录音机开麦前查 [pendingMs]，
 * 没到点就返回 false 交给调用方重试 —— 千万不要在主线程 sleep：
 * 主线程一睡，排在队里的 `cancel()` 反而跑不掉。
 */
object MicHandover {
    /** 让出麦克风之后的冷却窗口（ms）。实测 <100ms 会读到静音流，取 160ms。 */
    const val SETTLE_MS = 160L

    /** 到这个时刻之前，别的组件不要开麦。0 = 从来没让出过/冷却早就过了。 */
    @Volatile private var allowedAt = 0L

    /** 唤醒引擎真的停止了一轮监听，从此刻起算冷却。 */
    fun engineStopped() {
        allowedAt = SystemClock.elapsedRealtime() + SETTLE_MS
    }

    /** 还要等多少 ms 才能开麦；0 表示现在就可以。 */
    fun pendingMs(): Long {
        val left = allowedAt - SystemClock.elapsedRealtime()
        return if (left > 0) left else 0L
    }
}
