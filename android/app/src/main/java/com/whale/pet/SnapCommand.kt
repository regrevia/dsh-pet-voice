package com.whale.pet

/**
 * 手机自己就能办的两件事：拍一张、截一张。
 *
 * 这两句不能发给电脑——照相机、屏幕都在手机上。所以先在这里拦一道：
 * 说得像「拍张照」「截个屏」，就直接动手机；其他一律照旧进对话。
 *
 * 只从**句首**认，是为了不误伤「我想学拍照」这种正常聊天。
 */
object SnapCommand {
    const val CAMERA = "camera"
    const val SCREEN = "screen"
    /** 服务把「去拍张照／去截个屏」传给对话页时用的 Intent 键。 */
    const val EXTRA = "snap"

    /** 句首出现就算指令的说法（按长度降序匹配，长的优先）。 */
    private val screenWords = listOf("把屏幕截一下", "截一下屏幕", "屏幕截图", "截一下屏", "截一下图", "截个屏", "截个图", "截屏", "截图")
    private val cameraWords = listOf("拍张照片", "拍个照片", "拍张照", "拍个照", "来张照片", "拍一张", "照一张", "拍一下", "拍照", "自拍")
    /** 客套话前缀：剥掉再认，「帮我拍张照」和「拍张照」是一回事。 */
    private val leadIns = listOf("帮我", "给我", "帮我直接", "麻烦", "请", "你", "现在", "马上", "直接")
    private val trailing = charArrayOf('。', '！', '!', '.', '，', ',', '；', ';', '~', '～', '啊', '呀', '吧', '呢')
    /** 动词后面跟这些字，就是在问或在聊，不是在使唤人（「截图功能怎么用」）。 */
    private val asking = listOf("吗", "怎么", "如何", "为什么", "功能", "能", "可以", "教", "学", "哪", "什么", "支持", "有没有", "发", "给", "是不是", "要不要")

    /** @return [CAMERA] / [SCREEN] / null（不是设备指令，照旧聊天）。 */
    fun parse(raw: String): String? {
        var text = raw.filterNot { it.isWhitespace() }
        if (text.isEmpty() || text.length > 18) return null
        text = text.trimEnd(*trailing)
        for (prefix in leadIns.sortedByDescending { it.length }) {
            if (text.startsWith(prefix) && text.length > prefix.length + 1) {
                text = text.removePrefix(prefix)
                break
            }
        }
        for (word in screenWords) if (match(text, word)) return SCREEN
        for (word in cameraWords) if (match(text, word)) return CAMERA
        return null
    }

    /** 句首认出来之后，尾巴只能是「一下」「吧」这种零碎，不能是在问或在聊。 */
    private fun match(text: String, word: String): Boolean {
        if (!text.startsWith(word)) return false
        val rest = text.removePrefix(word)
        if (rest.length > 4) return false
        return asking.none { rest.contains(it) }
    }

    /** 截屏要问系统一句授权；拍照不用。用来决定开场先说什么。 */
    fun hint(kind: String): String = if (kind == CAMERA) "好，拍照" else "好，截屏"
}
