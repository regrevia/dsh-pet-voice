package com.whale.pet

/**
 * 收尾时判断这段识别结果该不该发给模型。
 *
 * 两类噪声：
 *  1. **回声**——自己刚播报的话被扬声器送进麦克风，识别回来再发一遍，就成了「自己跟自己聊」。
 *  2. **套话**——没人声或只有杂音时，识别模型硬编出来的「请点赞、订阅、转发」。
 *
 * 纯函数，JVM 单测覆盖；不碰 Android API。
 */
object SpeechNoise {
    /** 归一化：去掉空白与标点，只留字母数字与汉字，便于比对。 */
    fun normalize(text: String): String =
        text.lowercase().filter { it.isLetterOrDigit() && it.code !in 0x3000..0x303f }

    /** 识别模型凑字数时的固定套话。别放单字「转发」：用户真会说「帮我转发一下」。 */
    private val JINGLE = listOf(
        "请点赞", "点赞订阅", "订阅转发", "请订阅", "字幕由", "谢谢观看", "谢谢大家观看", "明镜与点点",
    )

    /**
     * 是不是自己刚说过的话（含转录误差）。
     *
     * 判据放宽：互相包含就算；否则按公共字占比 ≥ 75% 也算——识别错的回声照样能认出来。
     */
    fun echoes(text: String, recentSpoken: List<String>): Boolean {
        val probe = normalize(text)
        if (probe.length < 4) return false
        for (said in recentSpoken) {
            if (said.length < 4) continue
            if (said.contains(probe) || probe.contains(said)) return true
            val pool = said.toMutableList()
            var common = 0
            for (ch in probe) {
                val at = pool.indexOf(ch)
                if (at >= 0) {
                    common++
                    pool.removeAt(at)
                }
            }
            if (common.toFloat() / probe.length >= 0.75f) return true
        }
        return false
    }

    /** 模型套话 / 同一小段重复凑字数（「转发、转发、转发、转发」）。 */
    fun jingle(text: String): Boolean {
        val dense = text.filter { !it.isWhitespace() }
        if (dense.length < 2) return true
        if (JINGLE.any { dense.contains(it) }) return true
        // 复读：同一小段出现 4 次以上（「转发、转发、转发、转发」）。正常一句话不会这么重复。
        val plain = normalize(dense)
        for (size in 2..4) {
            if (plain.length < size * 4) continue
            val counts = HashMap<String, Int>()
            for (i in 0..plain.length - size) {
                val unit = plain.substring(i, i + size)
                val seen = (counts[unit] ?: 0) + 1
                counts[unit] = seen
                if (seen >= 4) return true
            }
        }
        return false
    }

    /** 综合判断：true 表示这条识别结果不可信，当这轮没人说话处理。 */
    fun reject(text: String, recentSpoken: List<String>): Boolean {
        if (text.isBlank()) return true
        return echoes(text, recentSpoken) || jingle(text)
    }
}
