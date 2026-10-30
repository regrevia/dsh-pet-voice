package com.whale.pet

import android.content.Context
import org.json.JSONObject

/**
 * 一轮还没落地的回合：从「按了发送」到「回复写进历史」之间，页面随时会被退出。
 * 内存里的 sending / 开始时刻一没，回来就只剩一句问话，既没有「深度求索中」也点不到终止。
 *
 * 所以按会话 id 落一份很小的状态：开始时刻、发出去的那一句、排队的那句。
 * 发出去的正文仍在 [Outbox]（补发与重试在那边），这里只记「页面该怎么还原」。
 */
object ChatLive {

    private const val PREFS = "pet_chat_live"
    /** 只留最近几只会话的现场，多出来的按开始时刻最旧的清掉。 */
    private const val LIMIT = 6

    data class Live(val startedAt: Long, val said: String, val queued: String)

    private fun prefs(ctx: Context): android.content.SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun key(sessionId: String) = "live_" + sessionId

    /** 这一轮开始了：记下什么时候发的、发的是哪句。 */
    fun save(ctx: Context, sessionId: String, startedAt: Long, said: String, queued: String) {
        if (sessionId.isBlank() || startedAt <= 0L) return
        runCatching {
            val o = JSONObject()
            o.put("at", startedAt)
            o.put("said", said.take(400))
            o.put("queued", queued.take(400))
            prefs(ctx).edit().putString(key(sessionId), o.toString()).apply()
            prune(ctx)
        }
    }

    fun read(ctx: Context, sessionId: String): Live? {
        if (sessionId.isBlank()) return null
        val raw = runCatching { prefs(ctx).getString(key(sessionId), null) }.getOrNull() ?: return null
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val at = o.optLong("at", 0L)
        if (at <= 0L) return null
        return Live(at, o.optString("said"), o.optString("queued"))
    }

    /** 回复已经落进历史、或者人自己按了终止：现场就该没了。 */
    fun clear(ctx: Context, sessionId: String) {
        if (sessionId.isBlank()) return
        runCatching { prefs(ctx).edit().remove(key(sessionId)).apply() }
    }

    private fun prune(ctx: Context) {
        val p = prefs(ctx)
        val all = p.all.filterKeys { it.startsWith("live_") }
        if (all.size <= LIMIT) return
        val oldest = all.entries
            .sortedBy { (it.value as? String)?.let { s -> runCatching { JSONObject(s).optLong("at") }.getOrDefault(0L) } ?: 0L }
        val edit = p.edit()
        oldest.take(all.size - LIMIT).forEach { edit.remove(it.key) }
        edit.apply()
    }
}
