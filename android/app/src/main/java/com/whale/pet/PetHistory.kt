package com.whale.pet

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 对话记录（App 内查看，悬浮窗不显示）。
 *
 * 存 SharedPreferences 里一个 JSON 数组，只留最近 [MAX] 条；App 与悬浮窗共用一个进程，
 * 所以是同一个单例，不需要跨进程同步。
 */
object PetHistory {

    const val ROLE_ME = "me"
    const val ROLE_PET = "pet"
    /** 系统提示行（比如「跟着电脑切到了另一只会话」），居中、灰色，不属于任何一方说的话。 */
    const val ROLE_NOTE = "note"
    const val MAX = 200

    private const val FILE = "pet_history"
    private const val KEY = "items"

    data class Item(val role: String, val text: String, val ts: Long, val sid: String = "") {
        val isMe: Boolean get() = role == ROLE_ME
        val isNote: Boolean get() = role == ROLE_NOTE
    }

    private val lock = Any()

    /** 记住的是「哪只会话里的对话」：同一只会话的才显示在一起。@return 这条的时间戳 */
    fun append(context: Context, role: String, text: String): Long {
        val t = text.trim()
        if (t.isEmpty()) return 0L
        // 单条太长（整段回复）截到 2000 字，避免 SharedPreferences 无限涨
        val body = if (t.length > 2000) t.take(1999) + "…" else t
        val now = System.currentTimeMillis()
        synchronized(lock) {
            val arr = readArray(context)
            arr.put(
                JSONObject()
                    .put("r", role)
                    .put("t", body)
                    .put("ts", now)
                    .put("s", PetSettings.chatSession(context)),
            )
            val trimmed = JSONArray()
            val from = (arr.length() - MAX).coerceAtLeast(0)
            for (i in from until arr.length()) trimmed.put(arr.get(i))
            prefs(context).edit().putString(KEY, trimmed.toString()).apply()
        }
        return now
    }

    /** 时间正序（最老在前），列表展示时最新在底部。 */
    fun all(context: Context): List<Item> {
        val want = PetSettings.chatSession(context)
        synchronized(lock) {
            val arr = readArray(context)
            val out = ArrayList<Item>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val text = o.optString("t")
                if (text.isBlank()) continue
                // 不再按会话过滤：同一只会话换了 id，用户也不该看到消息凭空消失
                out.add(Item(o.optString("r", ROLE_PET), text, o.optLong("ts", 0L), want))
            }
            return out
        }
    }

    /** 清空对话记录。 */
    fun clear(context: Context) {
        synchronized(lock) {
            prefs(context).edit().putString(KEY, "[]").apply()
        }
    }

    fun timeLabel(ts: Long): String {
        if (ts <= 0L) return ""
        val now = Date()
        val d = Date(ts)
        val sameDay = SimpleDateFormat("yyyyMMdd", Locale.CHINA).format(now) ==
            SimpleDateFormat("yyyyMMdd", Locale.CHINA).format(d)
        val fmt = SimpleDateFormat(if (sameDay) "HH:mm" else "MM-dd HH:mm", Locale.CHINA)
        return fmt.format(d)
    }

    private fun readArray(context: Context): JSONArray {
        val raw = prefs(context).getString(KEY, null) ?: return JSONArray()
        return try {
            JSONArray(raw)
        } catch (e: Exception) {
            JSONArray()
        }
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}
