package com.whale.pet

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * 「按了发送」到「宿主回执」之间的落盘凭据。
 *
 * 这句已经写进对话历史了，但宿主到底收没收到还不知道。进程在这个窗口里被杀（清理后台、
 * 系统回收、用户划掉），内存里的回合就跟着没了：界面上留着一句问话、宿主那边什么都没有，
 * 用户看到的就是「发出去了却没回」。
 *
 * 所以发之前先把 requestId + 正文落盘，任何一次启动都问一遍有没有遗留；有就交给待发队列，
 * 宿主按 requestId 去重，补发不会变成两轮对话。
 */
object PendingSend {
    private const val PREFS = "pet_pending"
    private const val KEY = "one"

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun begin(ctx: Context, requestId: String, text: String, sessionId: String, attachments: List<String>) {
        runCatching {
            val o = JSONObject()
            o.put("requestId", requestId)
            o.put("text", text)
            o.put("sessionId", sessionId)
            o.put("attachments", JSONArray(attachments))
            o.put("at", System.currentTimeMillis())
            prefs(ctx).edit().putString(KEY, o.toString()).apply()
        }
    }

    fun clear(ctx: Context, requestId: String) {
        runCatching {
            val raw = prefs(ctx).getString(KEY, null) ?: return
            val o = runCatching { JSONObject(raw) }.getOrNull() ?: return
            if (o.optString("requestId") == requestId) prefs(ctx).edit().remove(KEY).apply()
        }
    }

    fun recover(ctx: Context) {
        val raw = runCatching { prefs(ctx).getString(KEY, null) }.getOrNull() ?: return
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val rid = o.optString("requestId")
        if (rid.isBlank()) return
        val text = o.optString("text")
        val atts = o.optJSONArray("attachments")?.let { arr ->
            (0 until arr.length()).map { arr.optString(it) }.filter { it.isNotBlank() }
        } ?: emptyList()
        if (text.isBlank() && atts.isEmpty()) {
            clear(ctx, rid)
            return
        }
        // 那个回合自己已经补发过一次了：同一条不要进两次队列
        if (Outbox.items(ctx).any { it.requestId == rid }) {
            clear(ctx, rid)
            return
        }
        Outbox.add(ctx, text, rid, o.optString("sessionId"), atts, lastError = "进程被杀")
        Log.i("Outbox", "接住被杀那轮 ${rid.take(8)}")
        NetLog.record("outbox", 0, 0, "接住被杀那轮 ${rid.take(8)}")
        clear(ctx, rid)
    }
}
