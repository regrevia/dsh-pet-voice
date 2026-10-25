package com.whale.pet

import org.json.JSONObject

/**
 * `POST /api/command` 的返回：一句话是「聊天」还是「指令」。
 *
 * 只认插件 index.js 里 command 路由真正会返回的字段，缺字段当 chat，
 * 不猜、不补、不自己编项目名（`title` 一律用服务端给的规范标题）。
 *
 * - chat：`say:null`，调用方继续走 `/api/dispatch`（唯一的派发入口）；
 * - switch / dispatch / stop：`say` 就是要念的那句，**绝不再 dispatch**；
 * - switch-miss / dispatch-miss：带 `candidates`，两个时反问「《A》还是《B》？」。
 */
data class PetCommand(
    val action: String,
    val say: String,
    val title: String,
    val content: String,
    val sessionId: String,
    val candidates: List<String>,
    val stopped: Boolean,
) {
    val isChat: Boolean get() = action.isBlank() || action == "chat"

    val isMiss: Boolean get() = action == "switch-miss" || action == "dispatch-miss"

    /** 实际念出口的那句：歧义恰好两个时反问，其余用服务端给的 say。 */
    fun spoken(): String = when {
        isMiss && candidates.size == 2 -> "你说的《${candidates[0]}》还是《${candidates[1]}》？"
        else -> say
    }

    companion object {
        /** logcat 过滤用：`adb logcat -s PetCommand`。 */
        const val TAG = "PetCommand"

        fun parse(json: JSONObject?): PetCommand? {
            json ?: return null
            val list = ArrayList<String>()
            val arr = json.optJSONArray("candidates")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val v = arr.optString(i, "").trim()
                    if (v.isNotEmpty()) list.add(v)
                }
            }
            // say 在 chat 分支是 JSON null，optString 会给出字符串 "null"，必须单独判
            val say = if (json.has("say") && !json.isNull("say")) json.optString("say", "").trim() else ""
            return PetCommand(
                action = json.optString("action", "chat").trim(),
                say = say,
                title = json.optString("title", "").trim(),
                content = json.optString("content", "").trim(),
                sessionId = json.optString("sessionId", "").trim(),
                candidates = list,
                stopped = json.optBoolean("stopped", false),
            )
        }
    }
}
