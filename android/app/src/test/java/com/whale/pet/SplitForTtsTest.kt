package com.whale.pet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 长回复被截断的回归：宿主 `/api/say` 对 text 有字数上限（超出返回 400 或直接截断），
 * App 侧必须先把整段回答切到上限以内再逐段合成，否则只有开头会被念出来。
 */
class SplitForTtsTest {

    @Test
    fun shortTextIsOneChunk() {
        assertEquals(listOf("短句"), FloatingPetService.splitForTts("短句"))
    }

    @Test
    fun everyChunkFitsHostLimit() {
        val text = "这是一句很长的回答，".repeat(60) // 600 字
        val chunks = FloatingPetService.splitForTts(text, 160)
        assertTrue("句子被切开了", chunks.size > 1)
        for (c in chunks) assertTrue("分段 ${c.length} 字超上限", c.length <= 160)
    }

    @Test
    fun cutsOnPunctuationInsteadOfMidSentence() {
        val text = "第一句话说完了。" + "第二句话也说完了，" + "第三句话还在后面。"
        assertEquals(
            listOf("第一句话说完了。", "第二句话也说完了，", "第三句话还在后面。"),
            FloatingPetService.splitForTts(text, 10),
        )
    }

    @Test
    fun noTextIsLost() {
        val text = "没有标点的一大段文字".repeat(30) + "结尾。"
        val chunks = FloatingPetService.splitForTts(text, 200)
        assertEquals(text.replace(" ", ""), chunks.joinToString("").replace(" ", ""))
    }

    @Test
    fun blankInputYieldsNothing() {
        assertTrue(FloatingPetService.splitForTts("   ", 160).isEmpty())
    }
}
