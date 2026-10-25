package com.whale.pet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 回声/套话过滤：这是「自己跟自己聊」的闸门，逻辑错了就会把用户真说的话吞掉。
 *
 * 【实测】2026-10-25 真机日志里出现过两类坏输入：
 *  - 「主人,这是要走了。我这大飞鱼还没被您读透呢?别走啊。」 ← 自己的播报
 *  - 「请按赞、转发、转发、转发…」 ← 模型在杂音上凑字数
 */
class SpeechNoiseTest {
    @Test
    fun `自己的播报被录回来算回声`() {
        val said = listOf(SpeechNoise.normalize("主人，这是要走了。我这大肥鱼还没被您读透呢。"))
        assertTrue(SpeechNoise.echoes("主人,这是要走了。我这大飞鱼还没被您读透呢?别走啊。", said))
    }

    @Test
    fun `句子片段也算回声`() {
        val said = listOf(SpeechNoise.normalize("我在听，你说完停一下"))
        assertTrue(SpeechNoise.reject("你说完停一下", said))
    }

    @Test
    fun `正常提问不误杀`() {
        val said = listOf(SpeechNoise.normalize("好的，查一下今天的会议"))
        assertFalse(SpeechNoise.reject("帮我看看明天的日程", said))
    }

    @Test
    fun `欢迎语不算回声`() {
        assertFalse(SpeechNoise.reject("你好", emptyList()))
    }

    @Test
    fun `模型套话和复读都丢掉`() {
        assertTrue(SpeechNoise.reject("请按赞、转发、转发、转发、转发", emptyList()))
        assertTrue(SpeechNoise.reject("字幕由 Amara org 提供", emptyList()))
        assertTrue(SpeechNoise.reject("谢谢观看", emptyList()))
    }

    @Test
    fun `真说转发要放行`() {
        assertFalse(SpeechNoise.reject("帮我把这个文件转发给老板", emptyList()))
    }

    @Test
    fun `归一化去掉标点但保留汉字数字`() {
        assertEquals("收到abc123", SpeechNoise.normalize("收到，ABC 123！"))
    }
}
