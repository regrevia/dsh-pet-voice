package com.whale.pet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 唤醒词匹配的纯逻辑单测：不碰麦克风，只验归一化 / 长度护栏 / 剩余句。 */
class WakeWordEngineTest {

    private fun match(raw: String): WakeHit? =
        NativeSpeechWakeWordEngine.matchText(raw, listOf("大肥鱼", "肥鱼"))

    @Test
    fun fullWidthAndPunctuationAreNormalized() {
        assertEquals("大肥鱼", NativeSpeechWakeWordEngine.normalize("　大 肥 鱼！"))
        assertEquals("hello大肥鱼", NativeSpeechWakeWordEngine.normalize("ＨＥＬＬＯ，大肥鱼。"))
        assertEquals("大肥鱼今天天气怎么样", NativeSpeechWakeWordEngine.normalize("大肥鱼，今天天气怎么样？"))
    }

    @Test
    fun hitWithRemainderKeepsSentence() {
        val hit = match("大肥鱼，今天天气怎么样？")
        assertEquals("大肥鱼", hit?.word)
        assertEquals("今天天气怎么样", hit?.rest)
    }

    @Test
    fun bareWakeWordLeavesEmptyRest() {
        val hit = match("大 肥 鱼")
        assertEquals("大肥鱼", hit?.word)
        assertEquals("", hit?.rest)
    }

    @Test
    fun leadingNameTakesWholeRequest() {
        // 称呼开头 = 在叫它，后面整句请求原样带出来
        val hit = match("大肥鱼" + "一二三四五六七八九十一")
        assertEquals("一二三四五六七八九十一", hit?.rest)
    }

    @Test
    fun longSentenceMidNameIsRejected() {
        // 称呼埋在长句中间 = 聊天里顺口提到，不唤醒
        assertNull(match("一二三四五六七八九十一" + "大肥鱼" + "一二三四五"))
        // 称呼靠前、句子不长的仍命中
        val hit = match("那个大肥鱼" + "开灯")
        assertEquals("开灯", hit?.rest)
    }

    @Test
    fun otherNameDoesNotMatch() {
        assertNull(match("小海今天真好看"))
    }
}
