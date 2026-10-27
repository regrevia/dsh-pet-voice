package com.whale.pet

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import java.io.ByteArrayOutputStream
import kotlin.math.min
import kotlin.math.sqrt

/**
 * 按住/点一下说话的录音机：16kHz 单声道 16bit，录完直接给一段完整 WAV 字节。
 *
 * 为什么自己用 AudioRecord 而不是系统 SpeechRecognizer：
 *  - 红米/OEM 机器上经常**没有**系统语音识别服务（`SpeechRecognizer.isAvailable()` 直接 false），
 *    那条链路在真机上是死的；识别改到宿主（whisper）后，手机只负责录，设备无关；
 *  - 也顺带拿到 RMS：静音自动收尾（VAD）不依赖任何第三方库。
 *
 * 真机（小米 Pad 8 / MIUI）上踩到过的坑，这里都有对应兜底：
 *  - `VOICE_RECOGNITION` 源拿到的经常是**全零静音流**：AudioRecord 建得起来、状态也正常，
 *    `read()` 却读不到帧。所以开录后先开一个 1s 探测窗，读到的帧数不足 60% 或全程数字静音，
 *    就把这个源判死，沿 [SOURCE_CHAIN] 换到下一个源重录；
 *  - 唤醒引擎（SpeechRecognizer）刚让出麦克风时立刻开麦，也会读到静音流：见 [MicHandover]；
 *  - 短于一拍的误触不该产生一轮对话：见 [MIN_RECORD_MS]。
 *
 * 线程模型：start() 只做配置 + 起一条读线程；stop() 停止并 join（最多 1.2s），
 * 返回 WAV；回调 [onAutoStop] 在读线程上触发，调用方自己 post 回主线程。
 */
class VoiceRecorder {

    companion object {
        private const val TAG = "PetVoice"
        const val SAMPLE_RATE = 16_000

        /** 单句上限 12s：比「一口气说完」略宽，超出就当地说完收尾。 */
        private const val MAX_MS = 12_000

        /** 尾静音 700ms 收尾：比 Siri（0.8s）再快一点，说完到「在想…」的空档更短。 */
        private const val TAIL_SILENCE_MS = 700

        /** 有效人声下限 300ms：更短的「嗯/啊」不算开口，避免噪声触发整轮对话。 */
        private const val MIN_VOICED_MS = 300

        /** 一直没人说话：4s 就放弃，误触/空场更快回待机，别把麦克风攥着。 */
        private const val NO_SPEECH_MS = 4_000

        /**
         * 最短一轮 800ms：更短的点击是误触，不出 WAV、不上传宿主，避免垃圾轮次。
         * 按住说话（松手即发）由调用方传更小的 [stop] 门槛：松手本身就是结束，300ms 的「好」也算说过。
         */
        const val MIN_RECORD_MS = 800

        /** 开录后的探测窗：这段里读不到帧 / 全是数字静音，就判这个录音源拿不到声音。 */
        private const val PROBE_MS = 1_000

        /** 探测窗内至少要有 60% 的帧是真读到的（20ms 一帧）。 */
        private const val PROBE_MIN_RATIO = 0.6

        /** 等效 VAD 门限：VadGate 内部固定用 0.02（VadGate.VOICED_RMS），
         *  真机 MIC 增益低，0.02 会把正常说话整段判成静音；这里先放大音量再喂它，等效降到 0.009。 */
        private const val VAD_GATE_RMS = 0.009

        /** 喂给 VadGate 前的音量放大倍数（= 0.02 / 0.009 ≈ 2.2）。 */
        private val VAD_GAIN = VadGate.VOICED_RMS / VAD_GATE_RMS

        /** 录音源降级链：VOICE_RECOGNITION 在小米上常被语音助手/唤醒引擎静音，依次退到 VOICE_COMMUNICATION、MIC。 */
        private val SOURCE_CHAIN = intArrayOf(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            MediaRecorder.AudioSource.MIC,
        )

        /** 用户能看懂的失败文案。调用方用 [takeFaultText] 取走上屏，别让这些只活在日志里。 */
        const val MSG_NO_SIGNAL = "麦克风没声音，检查是否被别的应用占着"
        const val MSG_TOO_SHORT = "说得太短了，再说一次"
        const val MSG_NO_SPEECH = "没听到声音，再说一次"

        /** 源名只给日志和诊断用，不上屏。 */
        fun sourceName(src: Int): String = when (src) {
            MediaRecorder.AudioSource.VOICE_RECOGNITION -> "VOICE_RECOGNITION"
            MediaRecorder.AudioSource.VOICE_COMMUNICATION -> "VOICE_COMMUNICATION"
            MediaRecorder.AudioSource.MIC -> "MIC"
            else -> "src$src"
        }
    }

    @Volatile private var recording = false
    @Volatile private var stopping = false
    private var thread: Thread? = null
    private var record: AudioRecord? = null
    private val pcm = ByteArrayOutputStream(64 * 1024)

    /** 读线程上触发：录满/静音/超时后自动收尾（主线程自己 post）。 */
    @Volatile var onAutoStop: (() -> Unit)? = null

    /** 音量回调 0..1（给口型/波形用），高频调用，别在里面做重活。 */
    @Volatile var onLevel: ((Float) -> Unit)? = null

    val isRecording: Boolean get() = recording

    /** 这次实际开的是哪个源（[SOURCE_CHAIN] 里的元素），只给日志/诊断用。 */
    @Volatile var activeSource: Int = 0
        private set

    /** 这次是不是「拿不到声音」收的尾（麦克风被别的应用占着 / 源被静音）。 */
    @Volatile var noSignal = false
        private set

    /** 采到过有效人声吗（决定「没听清」还是「没听到」）。 */
    @Volatile var heardSpeech = false
        private set

    /** 上一段录音的有效人声时长 / 收尾时的尾静音时长（ms），只给日志用。 */
    @Volatile var lastVoicedMs = 0

    @Volatile var lastEndSilenceMs = 0
        private set

    /** 这一轮到底有没有人在说话。全静音就别往上送识别了——白等好几秒。 */
    fun heardVoice(): Boolean = lastVoicedMs > 0

    /** 这次为什么停：说完 / 说太久 / 没人说话。诊断行里直接打出来。 */
    @Volatile var stopReason = VadGate.Stop.NONE
        private set

    /** 给用户看的一句话（麦克风没声音 / 说得太短）；没有失败就是 null。取一次就清掉。 */
    @Volatile private var faultText: String? = null

    fun takeFaultText(): String? = faultText.also { faultText = null }

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (recording) return true

        // 唤醒引擎刚让出麦克风：它跑在系统服务里，cancel() 是 binder + main.post 的异步操作，
        // 这期间开 AudioRecord 会打进去拿到全零 PCM。这里返回 false 交给调用方 220ms 后重试，
        // 而不是在主线程 sleep —— 主线程一睡，排在队里的 cancel() 反而跑不掉。
        val settle = MicHandover.pendingMs()
        if (settle > 0) {
            Log.i(TAG, "唤醒引擎刚让出麦克风，等 ${settle}ms 再开录音")
            return false
        }

        pcm.reset()
        heardSpeech = false
        lastVoicedMs = 0
        lastEndSilenceMs = 0
        stopReason = VadGate.Stop.NONE
        noSignal = false
        faultText = null

        // 源降级链：建不起来就退下一个，别直接判失败
        val opened = openFrom(0)
        if (opened == null) {
            Log.w(TAG, "AudioRecord 各录音源都打不开")
            return false
        }
        val rec = opened.first
        val idx = opened.second
        stopping = false
        record = rec
        activeSource = SOURCE_CHAIN[idx]
        recording = true
        thread = Thread({ loop(rec, idx) }, "pet-recorder").apply {
            priority = Thread.NORM_PRIORITY + 1
            start()
        }
        return true
    }

    /** 从 [startIdx] 开始沿 [SOURCE_CHAIN] 找一个真的能开录的源；返回 (AudioRecord, 下标)。 */
    @SuppressLint("MissingPermission")
    private fun openFrom(startIdx: Int): Pair<AudioRecord, Int>? {
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuf <= 0) {
            Log.w(TAG, "AudioRecord 不支持 16k 单声道（minBuffer=$minBuf）")
            return null
        }
        val buf = maxOf(minBuf * 2, 6_400)
        for (i in startIdx until SOURCE_CHAIN.size) {
            val src = SOURCE_CHAIN[i]
            val rec = try {
                AudioRecord(
                    src,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    buf,
                )
            } catch (e: Exception) {
                Log.w(TAG, "AudioRecord 创建失败（${sourceName(src)}）：${e.javaClass.simpleName}")
                continue
            }
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                Log.w(TAG, "AudioRecord 未初始化（${sourceName(src)}），退下一个源")
                try {
                    rec.release()
                } catch (_: Exception) {
                }
                continue
            }
            val started = try {
                rec.startRecording()
                true
            } catch (e: Exception) {
                Log.w(TAG, "startRecording 失败（${sourceName(src)}）：${e.javaClass.simpleName}")
                false
            }
            if (!started) {
                try {
                    rec.release()
                } catch (_: Exception) {
                }
                continue
            }
            Log.i(TAG, "录音源 ${sourceName(src)} 已开")
            return rec to i
        }
        return null
    }

    /** 一轮读完（或被换源/被打断）的结果。 */
    private enum class Cycle {
        /** VAD 判停：说完 / 说太久 / 没人说话。 */
        DONE,

        /** 调用方 stop() 了。 */
        STOPPED,

        /** 探测窗里拿不到声音：这个源是死的，换下一个。 */
        SILENT,
    }

    private fun loop(first: AudioRecord, firstIdx: Int) {
        var rec: AudioRecord? = first
        var idx = firstIdx
        while (rec != null) {
            val cur = rec
            val gate = VadGate(
                tailSilenceMs = TAIL_SILENCE_MS,
                minVoicedMs = MIN_VOICED_MS,
                maxMs = MAX_MS,
                noSpeechMs = NO_SPEECH_MS,
            )
            val cycle = readCycle(cur, gate)
            heardSpeech = gate.heardSpeech
            lastVoicedMs = gate.voicedMs
            lastEndSilenceMs = gate.silenceMs
            releaseQuietly(cur)
            if (record === cur) record = null
            rec = null
            if (cycle != Cycle.SILENT) break
            if (stopping || !recording) break

            // 这个源是死的：把它录到的静音数据整段丢掉，换下一个源重新录
            pcm.reset()
            heardSpeech = false
            lastVoicedMs = 0
            lastEndSilenceMs = 0
            idx += 1
            val next = openFrom(idx)
            if (next == null) {
                noSignal = true
                faultText = MSG_NO_SIGNAL
                Log.w(TAG, "录音源都试过了，还是拿不到声音：$MSG_NO_SIGNAL")
                break
            }
            rec = next.first
            idx = next.second
            record = next.first
            activeSource = SOURCE_CHAIN[idx]
        }
        recording = false
        // 读线程自己收尾：硬件已经关了，通知上层来取 WAV
        onAutoStop?.invoke()
    }

    /**
     * 读到 VAD 判停为止。前 [PROBE_MS] 是探测窗：帧数不足 60% 或全程数字静音，
     * 返回 [Cycle.SILENT] 让 [loop] 换源，而不是一路空转到 6s 的 NO_SPEECH。
     */
    private fun readCycle(rec: AudioRecord, gate: VadGate): Cycle {
        val frame = ShortArray(SAMPLE_RATE / 50) // 20ms @16k
        val bytes = ByteArray(frame.size * 2)
        var probeMs = 0
        var probeFrames = 0
        var probeMaxAbs = 0
        var probed = false
        val needFrames = (PROBE_MS / 20) * PROBE_MIN_RATIO
        while (recording && !stopping) {
            val n = rec.read(frame, 0, frame.size)
            if (n > 0) {
                for (i in 0 until n) {
                    val v = frame[i].toInt()
                    val a = if (v < 0) -v else v
                    if (a > probeMaxAbs) probeMaxAbs = a
                    bytes[i * 2] = (v and 0xFF).toByte()
                    bytes[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
                }
                pcm.write(bytes, 0, n * 2)
                probeFrames++
            }
            if (!probed) {
                // 读不到帧也要记账，否则静音流会一直转圈、永远不知道麦克风是死的
                probeMs += if (n > 0) n * 1000 / SAMPLE_RATE else 20
                if (probeMs >= PROBE_MS) {
                    probed = true
                    if (probeFrames < needFrames || probeMaxAbs == 0) {
                        Log.w(
                            TAG,
                            "源 ${sourceName(activeSource)} 拿不到声音：${probeMs}ms 内 ${probeFrames} 帧" +
                                "（应 ≥${needFrames.toInt()}），峰值 $probeMaxAbs",
                        )
                        return Cycle.SILENT
                    }
                    Log.i(TAG, "源 ${sourceName(activeSource)} 有数据：${probeFrames} 帧，峰值 $probeMaxAbs")
                }
            }
            if (n <= 0) continue
            val rms = sqrt(sumOfSquares(frame, n)) / 32768.0
            onLevel?.invoke(min(1.0, rms * 8).toFloat())
            // 收尾判定全在 VadGate 里：说什么、怎么算，JVM 单测能按毫秒断言
            val stop = gate.feed(rms * VAD_GAIN, n * 1000 / SAMPLE_RATE)
            heardSpeech = gate.heardSpeech
            lastVoicedMs = gate.voicedMs
            lastEndSilenceMs = gate.silenceMs
            if (stop != VadGate.Stop.NONE) {
                stopReason = stop
                return Cycle.DONE
            }
        }
        return Cycle.STOPPED
    }

    private fun sumOfSquares(frame: ShortArray, n: Int): Double {
        var sum = 0.0
        for (i in 0 until n) {
            val v = frame[i].toInt()
            sum += (v * v).toDouble()
        }
        return sum
    }

    private fun releaseQuietly(rec: AudioRecord) {
        try {
            if (rec.recordingState == AudioRecord.RECORDSTATE_RECORDING) rec.stop()
        } catch (_: Exception) {
        }
        try {
            rec.release()
        } catch (_: Exception) {
        }
    }

    /**
     * 停录并返回完整 WAV（含 44 字节头）；没录到东西、或短于 [minMs] 返回 null。
     * 要幂等，可能被点两次。
     */
    fun stop(minMs: Int = MIN_RECORD_MS): ByteArray? {
        if (thread == null && !recording) return null
        recording = false
        stopping = true
        val rec = record
        try {
            if (rec != null && rec.recordingState == AudioRecord.RECORDSTATE_RECORDING) rec.stop()
        } catch (_: Exception) {
        }
        try {
            thread?.join(1_200)
        } catch (_: InterruptedException) {
        }
        thread = null
        val data = pcm.toByteArray()
        pcm.reset()
        val ms = data.size * 1_000 / (SAMPLE_RATE * 2)
        // 录了够久但一句人声都没有（对着一屋子安静按了一下）：本地就判掉，
        // 不传上去等识别，省掉好几秒的空等。
        if (ms >= minMs && lastVoicedMs <= 0 && !noSignal) {
            faultText = MSG_NO_SPEECH
            Log.i(TAG, "录音 ${ms}ms 没有人声，不送识别")
            return null
        }
        if (ms < minMs) {
            if (!noSignal) {
                faultText = MSG_TOO_SHORT
                Log.i(TAG, "录音只有 ${ms}ms，当误触，不生成一轮")
            }
            return null
        }
        return wav(data)
    }

    private fun wav(pcmBytes: ByteArray): ByteArray {
        val out = ByteArray(44 + pcmBytes.size)
        val byteRate = SAMPLE_RATE * 2
        fun putInt(off: Int, v: Int) {
            out[off] = (v and 0xFF).toByte()
            out[off + 1] = ((v shr 8) and 0xFF).toByte()
            out[off + 2] = ((v shr 16) and 0xFF).toByte()
            out[off + 3] = ((v shr 24) and 0xFF).toByte()
        }

        fun putShort(off: Int, v: Int) {
            out[off] = (v and 0xFF).toByte()
            out[off + 1] = ((v shr 8) and 0xFF).toByte()
        }

        "RIFF".toByteArray().copyInto(out, 0)
        putInt(4, 36 + pcmBytes.size)
        "WAVE".toByteArray().copyInto(out, 8)
        "fmt ".toByteArray().copyInto(out, 12)
        putInt(16, 16) // PCM 头长度
        putShort(20, 1) // PCM
        putShort(22, 1) // 单声道
        putInt(24, SAMPLE_RATE)
        putInt(28, byteRate)
        putShort(32, 2) // 块对齐
        putShort(34, 16) // 位深
        "data".toByteArray().copyInto(out, 36)
        putInt(40, pcmBytes.size)
        pcmBytes.copyInto(out, 44)
        return out
    }
}
