package com.whale.pet

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaDataSource
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.sin

/**
 * 逐句 TTS 播放器：句子排队 -> 并行预取 -> 主线程严格串行播放 -> 落盘缓存。
 *
 * 调度规则全在 [TtsQueue]（纯逻辑，可单测）；这里只做四件有副作用的事：
 * 真下载（后台线程）、落盘/改名/淘汰（后台线程）、MediaPlayer 出声、把失败变成可控错误。
 *
 * 踩过的四个坑，对应修法：
 *  1. **不能乱序**：下载并行但出声必须按入队顺序，第二句先下完也得等第一句（TtsQueue 保证）。
 *  2. **同一句不能并发写同一个临时文件**：每次下载用自己的临时文件名（seq 唯一），
 *     落盘改名也在后台线程做，绝不让主线程碰 `File`，也绝不出现「另一个任务把临时文件改走了」
 *     之后的 NoSuchFileException（那是在后台线程崩，直接闪退）。
 *  3. **打断后不能卡队列**：旧轮的下载回调照样还槽位、照样驱动新一轮调度（TtsQueue 保证）。
 *  4. **「说完了」要以全部排空为准**：`busy` 包含还在下载/等待的句子，`onDrained` 只在
 *     真正排空（含所有迟到回调）后回调一次，连续对话据此才重新开麦。
 */
class TtsPlayer(
    private val context: Context,
    private val client: PetClient,
    private val config: () -> PetConfig,
    private val onSpeaking: (Boolean) -> Unit,
    private val onError: (String) -> Unit,
    private val onDrained: () -> Unit = {},
) {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newFixedThreadPool(2) { r -> Thread(r, "pet-tts").apply { isDaemon = true } }
    private val queue = TtsQueue(maxAhead = 2)
    private var current: MediaPlayer? = null

    /** 正在边下边播的缓冲：打断时先 abort，读线程立刻从 readAt 返回 -1。 */
    @Volatile
    private var liveStream: StreamBuf? = null

    /** 已经边下边播完、等调度来还位的 seq：同一次出声不能放第二遍。 */
    private val streamedPlayed = HashSet<Long>()

    /** 打断轮次：迟到的准备/下载回调据此判废；由 [doStop] 与 [TtsQueue.stopAll] 同时递增。 */
    @Volatile
    private var epoch = 0

    /** 磁盘缓存上限：单句几 KB~几十 KB，60 个文件最多几 MB，超了按最旧淘汰。 */
    private val cacheMax = 60

    /**
     * 正在播的填充句实例。用**引用**而不是布尔：布尔会被 onError 之类的错误路径留脏，
     * 之后一次 cancelFiller() 就会把正在播的正文掐掉。
     */
    private var fillerRef: MediaPlayer? = null

    @Volatile
    var speaking: Boolean = false
        private set

    /** 最后一句播完的时刻（elapsedRealtime）：开麦前要等房间里的回声散掉。 */
    @Volatile
    var lastAudioEndAt: Long = 0L
        private set

    /**
     * 还有没有声音要出：正在播、正等着 prepareAsync、还在下载、队列里还排着句子。
     *
     * 只看 `speaking` 不够——它对句子是「一句一清」，句间那几十毫秒会漏成 false，
     * 下载中的下一句更是完全看不见。悬浮窗连续对话正好在这缝隙里开麦，把自己的下一句录进去。
     */
    val busy: Boolean
        get() = speaking || current != null || queue.busy()

    /** 刚说出口的句子（归一化后），用来认回声。只在主线程读写。 */
    private val recentSpoken = ArrayDeque<String>()

    /** 刚说出口的句子快照：给收尾过滤用，避免把主线程的队列暴露出去。 */
    fun recentSpokenSnapshot(): List<String> = recentSpoken.toList()

    private fun rememberSpoken(text: String) {
        val norm = SpeechNoise.normalize(text)
        if (norm.length < 4) return
        recentSpoken.addLast(norm)
        while (recentSpoken.size > 4) recentSpoken.removeFirst()
    }

    init {
        queue.listener = object : TtsQueue.Listener {
            override fun onDownload(seq: Long, text: String, preset: String, tempTag: Long) {
                download(seq, text, preset, tempTag)
            }

            override fun onSpeak(seq: Long, text: String, preset: String, enqueuedAt: Long) {
                speakNow(seq, text, preset, enqueuedAt)
            }

            override fun onFailed(seq: Long, reason: String) {
                Log.w("PetTts", "跳过一句（seq=$seq）：$reason")
                onError("语音合成失败：$reason")
            }

            override fun onIdle() {
                onDrained()
            }
        }
    }

    /* ---------------- 对外 ---------------- */

    fun enqueue(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        main.post {
            rememberSpoken(t)
            val preset = config().preset
            val cached = cacheFile(t, preset).let { it.exists() && it.length() > 512L }
            if (cached) Log.i("PetLatency", "TTS 缓存命中「${t.take(10)}」")
            queue.enqueue(t, preset, SystemClock.elapsedRealtime(), cached)
        }
    }

    /**
     * 预热：只落缓存不出声。宿主每句固定 0.9s+，把「嗯，我看看」这类口头填充句提前合成好，
     * 用户说完话就能立刻听到一声回应，而不是干等两秒才开口。
     */
    fun prewarm(items: List<String>) {
        val preset = config().preset
        items.forEach { raw ->
            val t = raw.trim()
            if (t.isEmpty()) return@forEach
            val dest = cacheFile(t, preset)
            if (dest.exists() && dest.length() > 512L) return@forEach
            val myEpoch = epoch
            runIo {
                val tmp = File(dest.parentFile, dest.name + ".warm-" + System.nanoTime() + ".part")
                try {
                    client.downloadTts(t, preset, tmp, raw = false)
                    if (tmp.length() > 512L && myEpoch == epoch) {
                        moveInto(tmp, dest)
                        pruneCache()
                    } else {
                        tmp.delete()
                    }
                } catch (_: Exception) {
                    // 预热失败无所谓：真要说这句的时候还会再合成一次
                    try {
                        tmp.delete()
                    } catch (_: Exception) {
                    }
                }
            }
        }
    }

    /** 命中缓存就立刻出声（用于「嗯…」填充句）；没命中返回 false，绝不为它等一次合成。 */
    fun speakCached(text: String): Boolean {
        val t = text.trim()
        if (t.isEmpty() || speaking || current != null) return false
        val file = cacheFile(t, config().preset)
        if (!file.exists() || file.length() < 512L) {
            Log.i("PetLatency", "填充句未命中缓存，跳过（不为它等合成）")
            return false
        }
        Log.i("PetLatency", "填充句命中缓存 ${file.length()}B，立刻出声")
        play(file, seq = -1L, enqueuedAt = 0L, filler = true)
        return true
    }

    fun stopAll() {
        // 主线程上直接停：beginTurn 是「先 stopAll 再 say」，异步排队会让刚起播的填充句被这刀砍掉
        if (Looper.myLooper() == Looper.getMainLooper()) doStop() else main.post { doStop() }
    }

    /**
     * 口型 0..1：按当前 MediaPlayer 播放进度开合（没有音频分析，进度驱动足够自然且零额外开销）。
     * 句尾 300ms 淡出，避免最后一个音突然闭嘴。
     */
    fun mouth(): Float {
        if (!speaking) return 0f
        val mp = current ?: return 0f
        return try {
            val pos = mp.currentPosition
            val dur = mp.duration
            if (dur <= 0) return 0f
            val frac = pos.toFloat() / dur
            val envelope = if (frac > 0.93f) ((1f - frac) / 0.07f).coerceIn(0f, 1f) else 1f
            val wave = abs(sin(pos / 140.0)).toFloat()
            (0.18f + 0.82f * wave) * envelope
        } catch (_: Exception) {
            0f
        }
    }

    fun release() {
        stopAll()
        main.post { io.shutdownNow() }
    }

    /* ---------------- 下载 ---------------- */

    /**
     * 真下载。三件事都在后台线程：取字节、落最终文件、淘汰旧缓存。
     *
    * **临时文件名唯一**（名字里带序号和后缀）：同一句话被并发请求时不会再出现两个任务写同一个
    * 临时文件，先完成的把它改名拿走、后一个 copyTo 抛 NoSuchFileException 的老问题。
     * 异常只记原因，交回 [TtsQueue] 变成「跳过这一句或报一句错」，绝不往上抛。
     */
    /* ---------------- 边下边播 ---------------- */

    /**
     * 边下边播的共享缓冲：io 线程边收边写，MediaPlayer 的读线程 [readAt] 阻塞等数据。
     *
     * `getSize() = -1`（长度未知）→ MediaPlayer 顺序读到 -1 为止。宿主 `?stream=1` 吐的是
     * 裸 mp3 帧（PET_TTS_RAW），没有容器头，所以只顺序读、不 seek。
     */
    private inner class StreamBuf : MediaDataSource() {
        private val lock = Object()
        private var data = ByteArray(96 * 1024)
        private var len = 0

        @Volatile
        private var done = false

        @Volatile
        private var aborted = false

        @Volatile
        var reason: String = ""

        fun write(b: ByteArray, off: Int, n: Int) {
            synchronized(lock) {
                if (aborted || done) return
                if (len + n > data.size) {
                    var cap = data.size
                    while (cap < len + n) cap *= 2
                    data = data.copyOf(cap)
                }
                System.arraycopy(b, off, data, len, n)
                len += n
                lock.notifyAll()
            }
        }

        fun finish() {
            synchronized(lock) {
                done = true
                lock.notifyAll()
            }
        }

        fun abort(why: String) {
            synchronized(lock) {
                if (!aborted) {
                    aborted = true
                    reason = why
                }
                done = true
                lock.notifyAll()
            }
        }

        fun isDone(): Boolean = done

        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            if (size <= 0) return 0
            synchronized(lock) {
                while (!aborted && position >= len && !done) {
                    try {
                        lock.wait(120)
                    } catch (_: InterruptedException) {
                        return -1
                    }
                }
                if (aborted) return -1
                if (position >= len) return -1 // 正常结束：一直读到 -1
                val n = minOf(size.toLong(), len - position).toInt()
                System.arraycopy(data, position.toInt(), buffer, offset, n)
                return n
            }
        }

        override fun getSize(): Long = -1L // 长度未知：不许按 size 预分配/跳读

        override fun close() {
            abort("已关闭")
        }
    }

    /**
     * 边下边播一句：请求头一到就挂播放器，body 边收边喂，同时照旧落盘缓存。
     * 失败/被打断只把下载槽位还回去，不抛异常（规则同 [download]）。
     */
    private fun streamDownload(seq: Long, text: String, preset: String, tempTag: Long, myEpoch: Int) {
        val buf = StreamBuf()
        liveStream = buf
        val startedAt = SystemClock.elapsedRealtime()
        val notified = java.util.concurrent.atomic.AtomicBoolean(false)
        val finish = { ok: Boolean, why: String ->
            if (notified.compareAndSet(false, true)) {
                main.post { queue.onDownloadDone(seq, ok, why) }
            }
        }
        runIo({ finish(false, "已停止") }) {
            val dest = cacheFile(text, preset)
            val tmp = File(dest.parentFile, dest.name + "." + tempTag + ".part")
            var out: java.io.OutputStream? = null
            var got = 0L
            var ok = false
            var why = ""
            try {
                val stream = client.openTtsStream(text, preset)
                Log.i(TurnLatency.TAG, "tts 流已连上 ${stream.headersMs}ms chars=${text.length}")
                out = tmp.outputStream()
                main.post {
                    if (myEpoch == epoch && !buf.isDone()) {
                        attachStream(seq, buf, myEpoch, startedAt)
                    } else {
                        buf.abort("已打断")
                    }
                }
                val chunk = ByteArray(8 * 1024)
                while (true) {
                    if (myEpoch != epoch) {
                        why = "已打断"
                        break
                    }
                    val n = stream.input.read(chunk)
                    if (n < 0) {
                        ok = true
                        break
                    }
                    if (n == 0) continue
                    got += n
                    buf.write(chunk, 0, n)
                    try {
                        out.write(chunk, 0, n)
                    } catch (_: Exception) {
                    }
                }
                buf.finish()
                stream.close()
                if (ok && got > 512L && myEpoch == epoch) {
                    out.flush()
                    out.close()
                    out = null
                    moveInto(tmp, dest)
                    pruneCache()
                }
            } catch (e: Exception) {
                why = e.message ?: e.javaClass.simpleName
                buf.abort(why)
                Log.w("PetTts", "流式 TTS 失败 seq=$seq：$why")
            } finally {
                try {
                    out?.close()
                } catch (_: Exception) {
                }
                if (!ok) {
                    try {
                        tmp.delete()
                    } catch (_: Exception) {
                    }
                }
                Log.i(TurnLatency.TAG, "tts 流结束 bytes=${got} ok=$ok 用时=${SystemClock.elapsedRealtime() - startedAt}ms")
                // 播放器没挂上/中途被打断：槽位在这里还，队列不能饿死
                finish(ok && got > 512L, why)
            }
        }
    }

    /** 流已连上：挂一个 MediaPlayer 读共享缓冲，边到边播。 */
    private fun attachStream(seq: Long, buf: StreamBuf, myEpoch: Int, startedAt: Long) {
        if (epoch != myEpoch || current != null || speaking) {
            buf.abort("播放器被占用")
            return
        }
        try {
            val mp = MediaPlayer()
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            mp.setDataSource(buf)
            mp.setOnPreparedListener {
                if (epoch != myEpoch) {
                    releaseQuietly(it)
                    if (current === it) current = null
                    setSpeaking(false)
                    streamedPlayed.remove(seq)
                    return@setOnPreparedListener
                }
                Log.i(TurnLatency.TAG, "流式首声 ${SystemClock.elapsedRealtime() - startedAt}ms（连上→出声）")
                setSpeaking(true)
                try {
                    it.start()
                } catch (e: Exception) {
                    releaseQuietly(it)
                    if (current === it) current = null
                    setSpeaking(false)
                    queue.onPlayFailed(seq, e.message ?: e.javaClass.simpleName)
                }
            }
            mp.setOnCompletionListener {
                releaseQuietly(it)
                if (current === it) current = null
                setSpeaking(false)
                // 先记账再还调度：onSpeak 会立刻回调过来，speakNow 靠这个集合认出「已经放过了」
                streamedPlayed.add(seq)
                main.post {
                    if (!queue.onDownloadDone(seq, true)) streamedPlayed.remove(seq)
                }
            }
            mp.setOnErrorListener { p, what, extra ->
                releaseQuietly(p)
                if (current === p) current = null
                setSpeaking(false)
                Log.w("PetTts", "流式播放失败 seq=$seq what=$what extra=$extra ${buf.reason}")
                streamedPlayed.remove(seq)
                onError("播放失败（what=$what extra=$extra）")
                queue.onPlayFailed(seq, "播放失败")
                true
            }
            current = mp
            mp.prepareAsync()
        } catch (e: Exception) {
            buf.abort(e.message ?: e.javaClass.simpleName)
            onError("播放失败：${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun download(seq: Long, text: String, preset: String, tempTag: Long) {
        val myEpoch = epoch
        // 边下边播只在「轮到这一句、且现在没人在响」时值得：其余句子老实下完整段，
        // 轮到它时文件已经在盘上（命中缓存比流式省事）。
        if (current == null && !speaking) {
            streamDownload(seq, text, preset, tempTag, myEpoch)
            return
        }
        runIo({ main.post { queue.onDownloadDone(seq, false, "已停止") } }) {
            val dest = cacheFile(text, preset)
            val tmp = File(dest.parentFile, dest.name + "." + tempTag + ".part")
            var ok = false
            var reason = ""
            try {
                client.downloadTts(text, preset, tmp, raw = false)
                if (tmp.length() <= 512L) {
                    reason = "合成结果为空"
                } else if (myEpoch != epoch) {
                    reason = "已打断"
                } else {
                    moveInto(tmp, dest)
                    ok = true
                    pruneCache()
                }
            } catch (e: Exception) {
                reason = e.message ?: e.javaClass.simpleName
                Log.w("PetTts", "TTS 下载失败 seq=$seq：$reason")
            } finally {
                if (!ok) {
                    try {
                        tmp.delete()
                    } catch (_: Exception) {
                    }
                }
            }
            main.post { queue.onDownloadDone(seq, ok, reason) }
        }
    }

    /** 落最终缓存文件；改名失败（跨文件系统/已有同名）就复制覆盖，调用方保证在后台线程。 */
    private fun moveInto(tmp: File, dest: File) {
        if (tmp.renameTo(dest)) return
        tmp.copyTo(dest, overwrite = true)
        tmp.delete()
    }

    private fun pruneCache() {
        try {
            val files = cacheDir().listFiles() ?: return
            if (files.size <= cacheMax) return
            files.sortedBy { it.lastModified() }.take(files.size - cacheMax).forEach { it.delete() }
        } catch (_: Exception) {
        }
    }

    /* ---------------- 播放 ---------------- */

    /** 提交后台任务；线程池已随服务销毁时走兜底，绝不让 RejectedExecutionException 抛回主线程。 */
    private fun runIo(fallback: () -> Unit = {}, block: () -> Unit) {
        try {
            io.execute(block)
        } catch (_: Exception) {
            try {
                fallback()
            } catch (_: Exception) {
            }
        }
    }

    private fun cacheDir(): File = File(context.cacheDir, "tts-cache").also { it.mkdirs() }

    private fun sha1(s: String): String {
        val md = MessageDigest.getInstance("SHA-1")
        return md.digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    private fun cacheKey(text: String, preset: String): String = sha1("$text|$preset").take(32) + ".mp3"

    private fun cacheFile(text: String, preset: String): File = File(cacheDir(), cacheKey(text, preset))

    /** 轮到某一句出声：正文就绪时先掐掉填充句，接缝处听不到空档。 */
    private fun speakNow(seq: Long, text: String, preset: String, enqueuedAt: Long) {
        // 这一句已经在边下边播里放完了：只把调度位置还回去，绝不再放一遍
        if (streamedPlayed.remove(seq)) {
            queue.onPlayDone(seq)
            return
        }
        val file = cacheFile(text, preset)
        if (!file.exists() || file.length() < 512L) {
            // 文件被淘汰或上一轮删掉了：跳过，别让整条队列停在这里
            queue.onPlayFailed(seq, "缓存文件已失效")
            return
        }
        cancelFiller()
        play(file, seq, enqueuedAt)
    }

    /**
     * 停掉并释放一个 MediaPlayer，且**先摘掉三个监听器**。
     *
     * 必须摘：`release()` 之后已排队但还没执行的 `onPrepared` 仍会跑完，里面会对已释放的实例
     * 调 `start()` → `IllegalStateException`（崩在监听器里，不在 `play()` 的 try 内）；
     * `onCompletion` 的尾巴还会再拉一次下一句，起出第二路播放器。AOSP 的 EventHandler
     * 是在执行那一刻才读 `mOnCompletionListener` 等字段，所以置 null 就能让排队回调直接空转。
     */
    private fun releaseQuietly(mp: MediaPlayer?) {
        if (mp == null) return
        try {
            mp.setOnPreparedListener(null)
            mp.setOnCompletionListener(null)
            mp.setOnErrorListener(null)
        } catch (_: Exception) {
        }
        try {
            mp.stop()
        } catch (_: Exception) {
        }
        try {
            mp.release()
        } catch (_: Exception) {
        }
    }

    /** 正文就绪时打断填充句：先停「嗯…」，下一行立刻起播，用户听不到空档。 */
    private fun cancelFiller() {
        val mp = fillerRef ?: return
        fillerRef = null
        if (current !== mp) return // 已经不是填充句了，别误伤
        releaseQuietly(mp)
        current = null
        setSpeaking(false)
        Log.i("PetLatency", "正文就绪，掐掉填充句")
    }

    /**
     * 单个 MediaPlayer 串行出声。[seq] < 0 表示填充句（不在调度队列里，播完不回调队列）。
     * 完成/失败一律先把实例清干净、再交还调度，下一句在同一个回调里起播，句间无缝。
     */
    private fun play(file: File, seq: Long, enqueuedAt: Long = 0L, filler: Boolean = false) {
        if (!file.exists()) {
            if (!filler) queue.onPlayFailed(seq, "音频文件不存在")
            return
        }
        if (speaking || current != null) {
            // 调度保证不会走到这里（填充句已在 speakNow 里掐掉）；真撞上就跳过这句，别叠音
            if (!filler) queue.onPlayFailed(seq, "播放器被占用")
            return
        }
        val myEpoch = epoch
        try {
            val mp = MediaPlayer()
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            mp.setDataSource(file.absolutePath)
            mp.setOnPreparedListener {
                if (epoch != myEpoch) {
                    // 已经点停/换轮：这个实例连 start 都不许调，直接把调度机会还回去
                    releaseQuietly(it)
                    if (current === it) current = null
                    if (fillerRef === it) fillerRef = null
                    setSpeaking(false)
                    if (!filler) queue.onPlayDone(seq)
                    return@setOnPreparedListener
                }
                if (enqueuedAt > 0L) {
                    Log.i("PetLatency", "TTS 可播 ${SystemClock.elapsedRealtime() - enqueuedAt}ms（入队→出声，含排队）")
                }
                setSpeaking(true)
                try {
                    it.start()
                } catch (e: Exception) {
                    releaseQuietly(it)
                    if (current === it) current = null
                    setSpeaking(false)
                    if (!filler) queue.onPlayFailed(seq, e.message ?: e.javaClass.simpleName)
                }
            }
            mp.setOnCompletionListener {
                releaseQuietly(it)
                if (current === it) current = null
                if (fillerRef === it) fillerRef = null
                setSpeaking(false)
                if (!filler) queue.onPlayDone(seq)
            }
            mp.setOnErrorListener { p, what, extra ->
                releaseQuietly(p)
                if (current === p) current = null
                if (fillerRef === p) fillerRef = null
                setSpeaking(false)
                onError("播放失败（what=$what extra=$extra）")
                if (!filler) queue.onPlayFailed(seq, "播放失败")
                true
            }
            current = mp
            if (filler) fillerRef = mp
            mp.prepareAsync()
        } catch (e: Exception) {
            current = null
            if (filler) fillerRef = null
            onError("播放失败：${e.message ?: e.javaClass.simpleName}")
            if (!filler) queue.onPlayFailed(seq, e.message ?: e.javaClass.simpleName)
        }
    }

    private fun doStop() {
        epoch++
        liveStream?.abort("已停止")
        queue.stopAll()
        releaseQuietly(current)
        current = null
        fillerRef = null
        setSpeaking(false)
    }

    private fun setSpeaking(v: Boolean) {
        if (speaking == v) return
        speaking = v
        if (!v) lastAudioEndAt = SystemClock.elapsedRealtime()
        onSpeaking(v)
    }
}
