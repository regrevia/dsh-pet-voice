package com.whale.pet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** 唤醒匹配是纯函数，放 JVM 单测里钉死：命中、同音、标点归一、长句防误触、自定义称呼。 */
class WakeMatchTest {

    private val words = listOf("大肥鱼", "大飞鱼", "大肥渔", "大肥余", "肥鱼", "大肥")

    @Test
    fun hitsPlainName() {
        val hit = NativeSpeechWakeWordEngine.matchText("大肥鱼", words)
        assertNotNull(hit)
        assertEquals("大肥鱼", hit!!.word)
        assertEquals("", hit.rest)
    }

    @Test
    fun hitsWithFullWidthAndPunctuation() {
        // 识别结果常带全角标点/空格
        val hit = NativeSpeechWakeWordEngine.matchText("大肥鱼，", words)
        assertNotNull(hit)
        assertEquals("大肥鱼", hit!!.word)
    }

    @Test
    fun homophoneWakes() {
        assertEquals("大飞鱼", NativeSpeechWakeWordEngine.matchText("大飞鱼", words)!!.word)
        assertEquals("大肥渔", NativeSpeechWakeWordEngine.matchText("大 肥 渔！", words)!!.word)
    }

    @Test
    fun keepsRestOfSentence() {
        val hit = NativeSpeechWakeWordEngine.matchText("大肥鱼讲个笑话", words)!!
        assertEquals("讲个笑话", hit.rest)
    }

    @Test
    fun midSentenceMentionDoesNotWake() {
        // 称呼埋在长句中间 = 聊天里顺口提到，不该醒
        assertNull(NativeSpeechWakeWordEngine.matchText("这个名字是谁给你起的我很好奇大肥鱼你说说看", words))
    }

    @Test
    fun englishCaseInsensitive() {
        assertNotNull(NativeSpeechWakeWordEngine.matchText("DAFEIYU", listOf("dafeiyu")))
    }

    @Test
    fun customNameOnlyMatchesItself() {
        val custom = listOf("小鱼")
        assertNotNull(NativeSpeechWakeWordEngine.matchText("小鱼你好", custom))
        // 自定义后不再认默认同音写法
        assertNull(NativeSpeechWakeWordEngine.matchText("大肥鱼", listOf("小鱼", "小鱼儿")))
    }

    @Test
    fun leadingNameAllowsLongRequest() {
        // 称呼开头，后接一整句请求，必须唤醒并把请求原样带出来
        val hit = NativeSpeechWakeWordEngine.matchText("大肥鱼帮我看看今天天气怎么样", words)
        assertNotNull(hit)
        assertEquals("帮我看看今天天气怎么样", hit!!.rest)
    }

    @Test
    fun leadingPolitenessStillWakes() {
        assertNotNull(NativeSpeechWakeWordEngine.matchText("那个大肥鱼今天几号", words))
    }

    @Test
    fun midSentenceLongStillRejected() {
        // 「大肥鱼」出现在长句中间 —— 当成聊天提到，不唤醒
        assertNull(NativeSpeechWakeWordEngine.matchText("我今天在看一个大肥鱼的照片真的特别好笑啊", words))
    }

    @Test
    fun emptyInputNeverHits() {
        assertNull(NativeSpeechWakeWordEngine.matchText("", words))
        assertNull(NativeSpeechWakeWordEngine.matchText("   ", words))
        assertNull(NativeSpeechWakeWordEngine.matchText("，。！", words))
    }
}
