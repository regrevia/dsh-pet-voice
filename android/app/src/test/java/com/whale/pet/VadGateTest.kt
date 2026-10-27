package com.whale.pet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「说到停」到底几毫秒停：用合成音量喂 VadGate，按毫秒断言。
 * 这些数字就是用户体感的那段空档，改动前先看这里。
 */
class VadGateTest {

    private val frameMs = 20
    private val loud = 0.2
    private val quiet = 0.001

    private fun run(gate: VadGate, voiceMs: Int, silenceMs: Int): VadGate.Stop {
        var stop = VadGate.Stop.NONE
        var fedVoice = 0
        while (fedVoice < voiceMs && stop == VadGate.Stop.NONE) {
            stop = gate.feed(loud, frameMs)
            fedVoice += frameMs
        }
        var fedQuiet = 0
        while (fedQuiet < silenceMs && stop == VadGate.Stop.NONE) {
            stop = gate.feed(quiet, frameMs)
            fedQuiet += frameMs
        }
        return stop
    }

    /** 说 600ms 然后住嘴：最后一个人声帧之后正好 700ms 收尾。 */
    @Test
    fun stopsSevenHundredMsAfterLastVoicedFrame() {
        val gate = VadGate()
        val stop = run(gate, voiceMs = 600, silenceMs = 3_000)
        assertEquals(VadGate.Stop.TAIL_SILENCE, stop)
        assertEquals(700, gate.silenceMs)
        assertEquals(1_300, gate.elapsedMs)
        assertTrue("听完就该收，不该等满 4s", gate.elapsedMs < 4_000)
    }

    /** 说得久一点，收尾点跟着往后挪，间距始终是 700ms —— 不是固定总时长。 */
    @Test
    fun tailIsRelativeToSpeechEndNotFixedTotal() {
        val short = VadGate().also { run(it, voiceMs = 800, silenceMs = 3_000) }
        val long = VadGate().also { run(it, voiceMs = 4_000, silenceMs = 5_000) }
        assertEquals(700, short.silenceMs)
        assertEquals(700, long.silenceMs)
        assertEquals(1_500, short.elapsedMs)
        assertEquals(4_700, long.elapsedMs)
    }

    /** 只有 200ms 的「嗯」不算开口，静音不再累加，最后按「没人说话」在 4s 放弃。 */
    @Test
    fun tooShortVoiceDoesNotCountAsSpeech() {
        val gate = VadGate()
        val stop = run(gate, voiceMs = 200, silenceMs = 5_000)
        assertEquals(VadGate.Stop.NO_SPEECH, stop)
        assertTrue(!gate.heardSpeech)
        assertTrue("没开口时不该累加尾静音", gate.silenceMs == 0)
    }

    /** 一直说不停：到 12s 单句上限收尾。 */
    @Test
    fun capsVeryLongUtterance() {
        val gate = VadGate()
        val stop = run(gate, voiceMs = 20_000, silenceMs = 0)
        assertEquals(VadGate.Stop.MAX_LEN, stop)
        assertEquals(12_000, gate.elapsedMs)
    }

    /** 噪声抖动（一帧有声一帧静）不该让尾静音计时反复归零到最后说不完。 */
    @Test
    fun shortBlipsBetweenSpeechKeepTailCounting() {
        val gate = VadGate()
        run(gate, voiceMs = 600, silenceMs = 0)
        var stop = gate.feed(quiet, 350)
        assertEquals(VadGate.Stop.NONE, stop)
        stop = gate.feed(quiet, 350)
        // 中间没有新的人声，两段静音累加到 700ms 就该收
        assertEquals(VadGate.Stop.TAIL_SILENCE, stop)
    }
}
