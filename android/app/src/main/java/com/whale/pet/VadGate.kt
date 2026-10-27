package com.whale.pet

/**
 * 「说到停」的判定器：只吃每帧音量与帧长，回答「继续录」还是「收尾、按什么理由收尾」。
 *
 * 之所以从 [VoiceRecorder] 里拆出来，是因为收尾时机直接决定体感（用户说完到看见「识别中」
 * 之间的空档），而它原来混在读线程里、只有真机麦克风才能验。拆成纯函数后，
 * JVM 单测可以按毫秒断言：`VadGateTest` 用合成音量喂进去，断言「最后一个人声帧之后
 * 正好 700ms 收尾」，并且断言不会退化成固定 4s。
 */
class VadGate(
    /** 尾静音多久算说完。Siri 0.8–1.2s、小爱约 1.5s；这里取 700ms——比 Siri 再快一点，
     *  真机听感切尾音就调回 800ms（只改这一处，VadGateTest 同步）。 */
    private val tailSilenceMs: Int = 700,
    /** 有效人声下限：更短的「嗯/啊」不算开口，避免噪声触发整轮对话。 */
    private val minVoicedMs: Int = 300,
    /** 单句上限：比「一口气说完」略宽，超出就当地说完收尾。 */
    private val maxMs: Int = 12_000,
    /** 一直没人说话就放弃，别把麦克风攥着。4s：比原来 6s 少等 2s，误触后回待机更快。 */
    private val noSpeechMs: Int = 4_000,
) {

    enum class Stop {
        /** 还要继续录。 */
        NONE,

        /** 有声音之后静了够久：正常说完。 */
        TAIL_SILENCE,

        /** 说太久，到达单句上限。 */
        MAX_LEN,

        /** 从头到尾没人说话。 */
        NO_SPEECH,
    }

    var elapsedMs = 0
        private set
    var voicedMs = 0
        private set

    /** 当前已经连续静了多久（只在开口之后累加）。 */
    var silenceMs = 0
        private set
    var heardSpeech = false
        private set

    /** 喂一帧，返回这一刻该不该收尾。 */
    fun feed(rms: Double, frameMs: Int): Stop {
        elapsedMs += frameMs
        if (rms > VOICED_RMS) {
            voicedMs += frameMs
            silenceMs = 0
            if (voicedMs >= minVoicedMs) heardSpeech = true
        } else if (heardSpeech) {
            silenceMs += frameMs
        }
        return when {
            elapsedMs >= maxMs -> Stop.MAX_LEN
            heardSpeech && silenceMs >= tailSilenceMs -> Stop.TAIL_SILENCE
            !heardSpeech && elapsedMs >= noSpeechMs -> Stop.NO_SPEECH
            else -> Stop.NONE
        }
    }

    companion object {
        /** 音量阈值（归一化 RMS）：低于它当静音。 */
        const val VOICED_RMS = 0.02
    }
}
