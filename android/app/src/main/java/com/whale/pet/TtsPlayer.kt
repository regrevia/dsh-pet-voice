package com.whale.pet

import android.content.Context
import android.media.AudioAttributes
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
 * 三条设计约束（都是踩过坑的）：
 *  1. **只能有一路出声**。下载（2 线程池）与播放分离，`ready` 队列只在上一句 `onCompletion`
 *     之后才起下一句；`speaking` 由 `onPrepared` 置位，不会出现两路 MediaPlayer 抢着播。
 *  2. **stop 必须立刻生效**。所有异步回调都带 `epoch`，`stopAll()` 自增；迟到的下载/准备回调
 *     一律丢弃、不播、不留半截文件（旧版 `stopped` 自设自清是空操作，用户点停后还会漏出一句）。
 *  3. **同一句不重复合成**。宿主（edge-tts）每句固定开销 0.85–3.5s 且没有服务端缓存，
 *     客户端按 `sha1(text|preset)` 落盘缓存：重复句 0ms 起播，宿主抖动尖峰也进不了播放链路。
 */
class TtsPlayer(
    private val context: Context,
    private val client: PetClient,
    private val config: () -> PetConfig,
    private val onSpeaking: (Boolean) -> Unit,
    private val onError: (String) -> Unit,
) {
    private class Item(val text: String, val enqueuedAt: Long, val epoch: Int)

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newFixedThreadPool(2) { r -> Thread(r, "pet-tts").apply { isDaemon = true } }
    private val texts = ArrayDeque<Item>()
    private val ready = ArrayDeque<Pair<File, Long>>()
    private var current: MediaPlayer? = null
    private var downloading = 0
    private var epoch = 0

    /** 预取深度：2 够用。再往前看，用户刚说完就点停时会白下载。 */
    private val maxAhead = 2

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

    /* ---------------- 缓存 ---------------- */

    private fun cacheDir(): File = File(context.cacheDir, "tts-cache").also { it.mkdirs() }

    private fun sha1(s: String): String {
        val md = MessageDigest.getInstance("SHA-1")
        return md.digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    private fun cacheKey(text: String, preset: String): String = sha1("$text|$preset").take(32) + ".mp3"

    private fun cacheFile(text: String, preset: String): File = File(cacheDir(), cacheKey(text, preset))

    private fun pruneCache() {
        try {
            val files = cacheDir().listFiles() ?: return
            if (files.size <= cacheMax) return
            files.sortedBy { it.lastModified() }.take(files.size - cacheMax).forEach { it.delete() }
        } catch (_: Exception) {
        }
    }

    /* ---------------- 对外 ---------------- */

    fun enqueue(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        main.post {
            texts.addLast(Item(t, SystemClock.elapsedRealtime(), epoch))
            kickDownload()
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
            if (dest.exists() && dest.length() > 512) return@forEach
            val myEpoch = epoch
            io.execute {
                try {
                    val tmp = File(dest.parentFile, dest.name + ".part")
                    client.downloadTts(t, preset, tmp)
                    if (epoch == myEpoch) {
                        tmp.renameTo(dest)
                        pruneCache()
                    } else {
                        tmp.delete()
                    }
                } catch (_: Exception) {
                    // 预热失败无所谓：真要说这句的时候还会再合成一次
                }
            }
        }
    }

    /** 命中缓存就立刻出声（用于「嗯…」填充句）；没命中返回 false，绝不为它等一次合成。 */
    fun speakCached(text: String): Boolean {
        val t = text.trim()
        if (t.isEmpty() || speaking || current != null) return false
        val file = cacheFile(t, config().preset)
        if (!file.exists() || file.length() < 512) {
            Log.i("PetLatency", "填充句未命中缓存，跳过（不为它等合成）")
            return false
        }
        Log.i("PetLatency", "填充句命中缓存 ${file.length()}B，立刻出声")
        play(file, 0L, filler = true)
        return true
    }

    /**
     * 停掉并释放一个 MediaPlayer，且**先摘掉三个监听器**。
     *
     * 必须摘：`release()` 之后已排队但还没执行的 `onPrepared` 仍会跑完，里面会对已释放的实例
     * 调 `start()` → `IllegalStateException`（崩在监听器里，不在 `play()` 的 try 内）；
     * `onCompletion` 的尾巴还会再拉一次 `tryPlay()`，起出第二路播放器。AOSP 的 EventHandler
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

    fun stopAll() {
        // 主线程上直接停：beginTurn 是「先 stopAll 再 say」，异步排队会让刚起播的填充句被这刀砍掉
        if (Looper.myLooper() == Looper.getMainLooper()) doStop() else main.post { doStop() }
    }

    private fun doStop() {
        run {
            epoch++
            texts.clear()
            ready.clear()
            releaseQuietly(current)
            current = null
            fillerRef = null
            setSpeaking(false)
        }
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

    private fun kickDownload() {
        while (downloading < maxAhead && texts.isNotEmpty()) {
            val item = texts.pollFirst() ?: break
            val preset = config().preset
            val cached = cacheFile(item.text, preset)
            if (cached.exists() && cached.length() > 512) {
                ready.addLast(cached to item.enqueuedAt)
                Log.i("PetLatency", "TTS 缓存命中 ${cached.length()}B「${item.text.take(10)}」")
                cancelFiller()  // 缓存句秒回：别让「嗯…」挡住正文
                tryPlay()
                continue
            }
            downloading++
            val dest = File(cacheDir(), cacheKey(item.text, preset) + ".part")
            val myEpoch = item.epoch
            io.execute {
                var ok = false
                try {
                    client.downloadTts(item.text, preset, dest)
                    ok = true
                } catch (e: Exception) {
                    dest.delete()
                    main.post { if (epoch == myEpoch) onError("语音合成失败：${e.message ?: e.javaClass.simpleName}") }
                }
                main.post {
                    downloading--
                    if (epoch != myEpoch) {
                        dest.delete()
                        return@post
                    }
                    if (ok) {
                        val finalFile = cacheFile(item.text, preset)
                        if (!dest.renameTo(finalFile)) {
                            dest.copyTo(finalFile, overwrite = true)
                            dest.delete()
                        }
                        ready.addLast(finalFile to item.enqueuedAt)
                        pruneCache()
                        cancelFiller()
                        tryPlay()
                    }
                    kickDownload()
                }
            }
        }
    }

    private fun tryPlay() {
        // 门闩必须比「有没有实例占着」更严：正文还在 prepareAsync 时 speaking 仍是 false，
        // 只看 speaking 会起第二路，两路同时出声且旧实例无人停。判在 poll 之前，否则会丢句。
        if (speaking || current != null) return
        val next = ready.pollFirst() ?: return
        play(next.first, next.second)
    }

    private fun play(file: File, enqueuedAt: Long = 0L, filler: Boolean = false) {
        if (!file.exists()) {
            tryPlay()
            return
        }
        if (speaking || current != null) return // 绝不叠音：有实例占着就等它走完
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
                    releaseQuietly(it)
                    if (current === it) current = null
                    if (fillerRef === it) fillerRef = null
                    tryPlay()
                    return@setOnPreparedListener
                }
                if (enqueuedAt > 0L) {
                    Log.i("PetLatency", "TTS 可播 ${SystemClock.elapsedRealtime() - enqueuedAt}ms（入队→出声，含排队）")
                }
                setSpeaking(true)
                it.start()
            }
            mp.setOnCompletionListener {
                releaseQuietly(it)
                if (current === it) current = null
                if (fillerRef === it) fillerRef = null
                setSpeaking(false)
                tryPlay()
                kickDownload()
            }
            mp.setOnErrorListener { p, what, extra ->
                releaseQuietly(p)
                if (current === p) current = null
                if (fillerRef === p) fillerRef = null
                setSpeaking(false)
                onError("播放失败（what=$what extra=$extra）")
                tryPlay()
                true
            }
            current = mp
            if (filler) fillerRef = mp
            mp.prepareAsync()
        } catch (e: Exception) {
            onError("播放失败：${e.message ?: e.javaClass.simpleName}")
            tryPlay()
        }
    }

    private fun setSpeaking(v: Boolean) {
        if (speaking == v) return
        speaking = v
        onSpeaking(v)
    }
}
