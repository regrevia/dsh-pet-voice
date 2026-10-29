package com.whale.pet

/**
 * 宿主塞进 user 槽的文字（压缩摘要、Fast mode 提醒、轮内调度提醒、环境块）。
 * 这些是给模型看的，不是主人说的话，任何对话界面都不该把它们当气泡显示。
 */
object InjectedText {

    private val prefixes = arrayOf(
        "Time sampled while preparing turn",
        "Current runtime context.",
        "<system-reminder>",
        "<available_skills>",
        "<available-skills>",
        "<environment_context>",
        "This is an automatically generated checkpoint",
        "The context was just compacted",
        "Fast mode reminder",
        "Auto schedule",
        "</compacted",
        "<compacted",
        "[checkpoint]",
    )

    /** 中英文压缩摘要的小节标题；摘要正文被切成几段时靠它认出来。 */
    private val summaryHeads = arrayOf(
        "## Primary Request and Intent",
        "## Key Technical Concepts",
        "## 主要请求与意图",
        "## 主要请求和意图",
        "## 当前工作",
        "## 关键上下文",
        "## Files and Code",
        "## 待办",
    )

    private val bulletPath = Regex("(?m)^[-*]\\s*`")
    private val summaryTag = Regex("</?compacted[-_ ]?summary>", RegexOption.IGNORE_CASE)

    fun isInjected(text: CharSequence?): Boolean {
        val body = text?.toString()?.trim().orEmpty()
        if (body.isEmpty()) return true
        if (prefixes.any { body.startsWith(it, ignoreCase = true) }) return true
        if (summaryHeads.any { body.contains(it) }) return true
        // 摘要末尾那个孤零零的闭合标签，或者正文被切掉后残留的半个标签
        if (summaryTag.containsMatchIn(body)) return true
        return looksLikeSummaryDump(body)
    }

    /** 摘要碎块：长文 + 一串「- `/绝对路径`」清单；主人自己讲话很少长这样。 */
    private fun looksLikeSummaryDump(body: String): Boolean {
        if (body.length < 600) return false
        return bulletPath.findAll(body).count() >= 4
    }
}
