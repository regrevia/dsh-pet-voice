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
 * 线程模型：start() 只做配置 + 起一条读线程；stop() 停止并 join（最多 1.2s），
 * 返回 WAV；回调 [onAutoStop] 在读线程上触发，调用方自己 post 回主线程。
 */
class VoiceRecorder {

    companion object {
        private const val TAG = "PetVoice"
        const val SAMPLE_RATE = 16_000

        /** 单句上限 12s：比「一口气说完」略宽，超出就当地说完收尾。 */
        private const val MAX_MS = 12_000

        /** 尾静音 1s 收尾：Siri 0.8–1.2s、小爱约 1.5s，取 1s 既不切断尾音也不迟钝。 */
        private const val TAIL_SILENCE_MS = 1_000

        /** 有效人声下限 300ms：更短的「嗯/啊」不算开口，避免噪声触发整轮对话。 */
        private const val MIN_VOICED_MS = 300

        /** 一直没人说话：6s 就放弃，别把麦克风攥着。 */
        private const val NO_SPEECH_MS = 6_000
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

    /** 采到过有效人声吗（决定「没听清」还是「没听到」）。 */
    @Volatile var heardSpeech = false
        private set

    /** 上一段录音的有效人声时长 / 收尾时的尾静音时长（ms），只给日志用。 */
    @Volatile var lastVoicedMs = 0
        private set
    @Volatile var lastEndSilenceMs = 0
        private set

    /** 这次为什么停：说完 / 说太久 / 没人说话。诊断行里直接打出来。 */
    @Volatile var stopReason = VadGate.Stop.NONE
        private set

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (recording) return true
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuf <= 0) {
            Log.w(TAG, "AudioRecord 不支持 16k 单声道（minBuffer=$minBuf）")
            return false
        }
        val buf = maxOf(minBuf * 2, 6_400)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                buf,
            )
        } catch (e: Exception) {
            Log.w(TAG, "AudioRecord 创建失败：${e.javaClass.simpleName}")
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            Log.w(TAG, "AudioRecord 未初始化（多半是没授麦克风）")
            return false
        }
        pcm.reset()
        heardSpeech = false
        lastVoicedMs = 0
        lastEndSilenceMs = 0
        stopReason = VadGate.Stop.NONE
        stopping = false
        record = rec
        recording = true
        try {
            rec.startRecording()
        } catch (e: Exception) {
            Log.w(TAG, "startRecording 失败：${e.javaClass.simpleName}")
            recording = false
            rec.release()
            record = null
            return false
        }
        thread = Thread({ loop(rec) }, "pet-recorder").apply {
            priority = Thread.NORM_PRIORITY + 1
            start()
        }
        return true
    }

    private fun loop(rec: AudioRecord) {
        val frame = ShortArray(320) // 20ms @16k
        val bytes = ByteArray(frame.size * 2)
        val gate = VadGate(
            tailSilenceMs = TAIL_SILENCE_MS,
            minVoicedMs = MIN_VOICED_MS,
            maxMs = MAX_MS,
            noSpeechMs = NO_SPEECH_MS,
        )
        try {
            while (recording && !stopping) {
                val n = rec.read(frame, 0, frame.size)
                if (n <= 0) continue
                var sum = 0.0
                for (i in 0 until n) {
                    val v = frame[i].toInt()
                    sum += (v * v).toDouble()
                    bytes[i * 2] = (v and 0xFF).toByte()
                    bytes[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
                }
                pcm.write(bytes, 0, n * 2)
                val rms = sqrt(sum / n) / 32768.0
                onLevel?.invoke(min(1.0, rms * 8).toFloat())
                // 收尾判定全在 VadGate 里：说什么、怎么算，JVM 单测能按毫秒断言
                val stop = gate.feed(rms, n * 1000 / SAMPLE_RATE)
                if (stop != VadGate.Stop.NONE) {
                    stopReason = stop
                    break
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "录音线程异常：${e.javaClass.simpleName}")
        }
        heardSpeech = gate.heardSpeech
        lastVoicedMs = gate.voicedMs
        lastEndSilenceMs = gate.silenceMs
        // 读线程自己收尾：先关硬件，再通知上层来取 WAV
        recording = false
        try {
            if (rec.recordingState == AudioRecord.RECORDSTATE_RECORDING) rec.stop()
        } catch (_: Exception) {
        }
        try {
            rec.release()
        } catch (_: Exception) {
        }
        if (record === rec) record = null
        onAutoStop?.invoke()
    }

    /** 停录并返回完整 WAV（含 44 字节头）；没录到东西返回 null。要幂等，可能被点两次。 */
    fun stop(): ByteArray? {
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
        if (data.size < SAMPLE_RATE * 2 / 10) return null // < 100ms：当没录到
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
