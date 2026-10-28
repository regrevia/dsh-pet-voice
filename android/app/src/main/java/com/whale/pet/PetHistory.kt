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

    /**
     * 一条消息带的附件。
     *
     * [host] 是宿主磁盘上的绝对路径（发出去的那份，插件按它读文件）；
     * [local] 是本机副本（自己发的图/视频，重进会话还要能看、能播）。
     */
    data class Att(val host: String, val local: String, val kind: String = KIND_IMAGE) {
        val isVideo: Boolean get() = kind == KIND_VIDEO
        /** 显示用：本机有副本就用本机，省一次网络 */
        val shown: String get() = local.ifBlank { host }

        companion object {
            const val KIND_IMAGE = "image"
            const val KIND_VIDEO = "video"
        }
    }

    data class Item(
        val role: String,
        val text: String,
        val ts: Long,
        val sid: String = "",
        val atts: List<Att> = emptyList(),
        /** 宿主转录里的序号；本地新发还没对上宿主时是 0。 */
        val seq: Long = 0L,
    ) {
        val isMe: Boolean get() = role == ROLE_ME
        val isNote: Boolean get() = role == ROLE_NOTE
    }

    private val lock = Any()

    /** 记住的是「哪只会话里的对话」：同一只会话的才显示在一起。@return 这条的时间戳 */
    fun append(context: Context, role: String, text: String): Long =
        append(context, role, text, emptyList())

    /** [atts] = 这条带的图/视频；只发图没写正文时 [text] 是气泡里的替代字。 */
    fun append(context: Context, role: String, text: String, atts: List<Att>, seq: Long = 0L): Long {
        val t = text.trim()
        if (t.isEmpty() && atts.isEmpty()) return 0L
        // 单条太长（整段回复）截到 2000 字，避免 SharedPreferences 无限涨
        val body = if (t.length > 2000) t.take(1999) + "…" else t
        val now = System.currentTimeMillis()
        synchronized(lock) {
            val arr = readArray(context)
            val rec = JSONObject()
                .put("r", role)
                .put("t", body)
                .put("ts", now)
                .put("s", PetSettings.chatSession(context))
            if (seq > 0L) rec.put("q", seq)
            if (atts.isNotEmpty()) {
                val list = JSONArray()
                atts.forEach { a ->
                    list.put(JSONObject().put("h", a.host).put("l", a.local).put("k", a.kind))
                }
                rec.put("a", list)
            }
            arr.put(rec)
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
                val atts = parseAtts(o)
                if (text.isBlank() && atts.isEmpty()) continue
                // 记录里带会话 id 的，只显示属于当前这只会话的：换成别的会话后
                // 上一只的消息不能混在这一只下面（不带 id 的旧记录留着，免得一升级就清空）
                val sid = o.optString("s")
                if (sid.isNotBlank() && want.isNotBlank() && sid != want) continue
                out.add(Item(o.optString("r", ROLE_PET), text, o.optLong("ts", 0L), sid, atts, o.optLong("q", 0L)))
            }
            return out
        }
    }

    /** 最近 [limit] 条（时间正序）：历史按页取，别一次全上屏。 */
    fun recent(context: Context, limit: Int): List<Item> {
        if (limit <= 0) return emptyList()
        val all = all(context)
        if (all.size <= limit) return all
        return ArrayList(all.subList(all.size - limit, all.size))
    }

    /**
     * 把宿主转录的一页并进来（宿主是真相源，手机只是缓存）。
     *
     * 同一句只留一条：宿主序号（q）已经有的跳过；本地刚发、还没对上宿主的那条
     * （q=0、角色与正文都一样）只补上序号，不另插一行。[older]=这一页比本地更早，
     * 整页放前面。@return 这次新增的条数
     */
    fun mergeHost(context: Context, sid: String, page: List<Item>, older: Boolean): Int {
        if (page.isEmpty()) return 0
        synchronized(lock) {
            val arr = readArray(context)
            val kept = ArrayList<JSONObject>(arr.length() + page.size)
            for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { kept.add(it) }
            val fresh = ArrayList<JSONObject>(page.size)
            for (item in page) {
                val q = item.seq
                if (q <= 0L) continue
                // 宿主那边的正文可能后来才补全（例如手机发的图，宿主回填成 `[图片] 路径`）：
                // 老行会一直挡着新正文，所以本地没附件时用宿主版覆盖。
                val known = kept.firstOrNull { it.optLong("q", 0L) == q }
                if (known != null) {
                    val localAtts = known.optJSONArray("a")?.length() ?: 0
                    if (localAtts == 0 && item.text.isNotBlank() && item.text != known.optString("t")) {
                        runCatching { known.put("t", item.text) }
                    }
                    continue
                }
                if (fresh.any { it.optLong("q", 0L) == q }) continue
                // 本地刚发那条：角色、正文相同，补序号即可（省一次插行，也不丢附件）
                val mine = kept.indexOfLast {
                    it.optLong("q", 0L) == 0L && it.optString("r") == item.role &&
                        it.optString("t") == item.text && it.optString("s").let { s -> s.isBlank() || s == sid }
                }
                if (mine >= 0) {
                    runCatching { kept[mine].put("q", q) }
                    continue
                }
                val rec = JSONObject()
                    .put("r", item.role)
                    .put("t", item.text)
                    .put("ts", if (item.ts > 0L) item.ts else System.currentTimeMillis())
                    .put("s", sid)
                    .put("q", q)
                fresh.add(rec)
            }
            if (fresh.isEmpty()) {
                persist(context, kept)
                return 0
            }
            // 补回来的老行可能比已知的还旧（分页往前补、或宿主回填纯图消息）：
            // 一律按宿主序号排，本地还没对上序号的那几条（q=0）留在最后。
            val out = ArrayList<JSONObject>(kept.size + fresh.size)
            if (older) { out.addAll(fresh); out.addAll(kept) } else { out.addAll(kept); out.addAll(fresh) }
            out.sortWith(
                compareBy<JSONObject> { it.optLong("q", 0L) == 0L }
                    .thenBy { if (it.optLong("q", 0L) == 0L) it.optLong("ts", 0L) else it.optLong("q", 0L) },
            )
            val trimmed = if (out.size > MAX) ArrayList(out.subList(out.size - MAX, out.size)) else out
            persist(context, trimmed)
            return fresh.size
        }
    }

    /** 当前会话在本地存着的最早一个宿主序号（0 = 还没跟宿主对上）。 */
    fun oldestSeq(context: Context): Long {
        val want = PetSettings.chatSession(context)
        synchronized(lock) {
            val arr = readArray(context)
            var min = 0L
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val sid = o.optString("s")
                if (sid.isNotBlank() && want.isNotBlank() && sid != want) continue
                val q = o.optLong("q", 0L)
                if (q > 0L && (min == 0L || q < min)) min = q
            }
            return min
        }
    }

    /** 当前会话一共多少条（用来判「还有更早的」）。 */
    fun count(context: Context): Int = all(context).size

    private fun parseAtts(o: JSONObject): List<Att> {
        val arr = o.optJSONArray("a") ?: return emptyList()
        if (arr.length() == 0) return emptyList()
        val out = ArrayList<Att>(arr.length())
        for (i in 0 until arr.length()) {
            val a = arr.optJSONObject(i) ?: continue
            val host = a.optString("h")
            val local = a.optString("l")
            if (host.isBlank() && local.isBlank()) continue
            out.add(Att(host, local, a.optString("k", Att.KIND_IMAGE)))
        }
        return out
    }

    private fun persist(context: Context, items: List<JSONObject>) {
        val arr = JSONArray()
        items.forEach { arr.put(it) }
        prefs(context).edit().putString(KEY, arr.toString()).apply()
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
