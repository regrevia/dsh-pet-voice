package com.whale.pet

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * 待发队列（durable outbox）：一句话只要用户按了发送，就一定要到电脑上。
 *
 * 为什么必须有这一层：
 * 以前派发失败只是「重试 3 次 + 报一句没发出去」，用户的话就没了——弱网、切网、
 * 电脑休眠、宿主重启都会走到这个分支，表现正是「App 那边发不出去」。现在失败的那一句
 * 直接落盘，联网后自己补发，App 重装/重启都不会丢。
 *
 * 三条铁律：
 * 1. requestId 跟着这一句走到底（落盘也存它），宿主按 id 去重，所以补发不会变成两轮;
 * 2. 只用指数退避 + 抖动 + 网络可用即唤醒，不做「无限立刻重试」把电池和宿主打爆;
 * 3. 队列有上限（[MAX_ITEMS]），满了丢最旧的并说清楚——宁可少一句也不要无声撑爆。
 */
object Outbox {
    private const val PREFS = "pet_outbox"
    private const val KEY_ITEMS = "items"
    private const val MAX_ITEMS = 40
    private const val MAX_ATTEMPTS = 40

    private val lock = Any()
    private val main = Handler(Looper.getMainLooper())

    @Volatile private var worker: Thread? = null
    @Volatile private var netCallback: Any? = null
    @Volatile private var kicked = object : Object() {}

    /** 队列长度的变化（界面上的「N 条待发」）。在主线程回调。 */
    @Volatile
    var onCountChanged: ((Int) -> Unit)? = null

    /** 补发成功后的回调（浮窗说出来、对话页刷新）；可以有多个，主线程回调。 */
    private val deliveredListeners = java.util.concurrent.CopyOnWriteArrayList<(String) -> Unit>()

    fun addDeliveredListener(l: (String) -> Unit) {
        if (!deliveredListeners.contains(l)) deliveredListeners.add(l)
    }

    fun removeDeliveredListener(l: (String) -> Unit) {
        deliveredListeners.remove(l)
    }

    /** 补发成功后捞回来的那轮回话（补发时没人开轮询，回复只会留在电脑上）。主线程回调。 */
    private val replyListeners = java.util.concurrent.CopyOnWriteArrayList<(String) -> Unit>()

    fun addReplyListener(l: (String) -> Unit) {
        if (!replyListeners.contains(l)) replyListeners.add(l)
    }

    fun removeReplyListener(l: (String) -> Unit) {
        replyListeners.remove(l)
    }

    data class Item(
        val requestId: String,
        val text: String,
        val sessionId: String,
        val attachments: List<String>,
        val createdAt: Long,
        val attempts: Int,
        val nextAt: Long,
        val lastError: String,
    )

    /* ---------------- 持久化 ---------------- */

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun read(ctx: Context): MutableList<Item> {
        val raw = prefs(ctx).getString(KEY_ITEMS, "").orEmpty()
        if (raw.isBlank()) return mutableListOf()
        return try {
            val arr = JSONArray(raw)
            val out = mutableListOf<Item>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val id = o.optString("rid")
                val text = o.optString("text")
                if (id.isBlank() || text.isBlank()) continue
                val atts = mutableListOf<String>()
                o.optJSONArray("attachments")?.let { a ->
                    for (j in 0 until a.length()) a.optString(j).takeIf { it.isNotBlank() }?.let { atts.add(it) }
                }
                out.add(
                    Item(
                        requestId = id,
                        text = text,
                        sessionId = o.optString("sessionId"),
                        attachments = atts,
                        createdAt = o.optLong("createdAt"),
                        attempts = o.optInt("attempts"),
                        nextAt = o.optLong("nextAt"),
                        lastError = o.optString("lastError"),
                    ),
                )
            }
            out
        } catch (_: Exception) {
            mutableListOf()
        }
    }

    private fun write(ctx: Context, list: List<Item>) {
        val arr = JSONArray()
        list.forEach { it ->
            val a = JSONArray()
            it.attachments.forEach { p -> a.put(p) }
            arr.put(
                JSONObject()
                    .put("rid", it.requestId)
                    .put("text", it.text)
                    .put("sessionId", it.sessionId)
                    .put("attachments", a)
                    .put("createdAt", it.createdAt)
                    .put("attempts", it.attempts)
                    .put("nextAt", it.nextAt)
                    .put("lastError", it.lastError),
            )
        }
        prefs(ctx).edit().putString(KEY_ITEMS, arr.toString()).apply()
    }

    /* ---------------- 对外 ---------------- */

    fun count(ctx: Context): Int = synchronized(lock) { read(ctx).size }

    fun items(ctx: Context): List<Item> = synchronized(lock) { read(ctx) }

    /**
     * 把一句话放进待发队列。已在队列里的同一个 requestId 不会重复入队（重试路径会重复调）。
     * 返回入队后队列长度，0 表示这句话已经在队列里或者写盘失败。
     */
    fun add(
        ctx: Context,
        text: String,
        requestId: String = UUID.randomUUID().toString(),
        sessionId: String = "",
        attachments: List<String> = emptyList(),
        lastError: String = "",
    ): Int {
        if (text.isBlank() && attachments.isEmpty()) return 0
        val n = synchronized(lock) {
            val list = read(ctx)
            if (list.any { it.requestId == requestId }) return@synchronized list.size
            val now = System.currentTimeMillis()
            list.add(
                Item(
                    requestId = requestId,
                    text = text,
                    sessionId = sessionId,
                    attachments = attachments,
                    createdAt = now,
                    attempts = 0,
                    nextAt = 0L,
                    lastError = lastError,
                ),
            )
            while (list.size > MAX_ITEMS) {
                val dropped = list.removeAt(0)
                NetLog.record("outbox", 0, 0, "队列满，丢掉最旧的一条 ${dropped.requestId.take(8)}")
            }
            write(ctx, list)
            list.size
        }
        notifyCount(ctx, n)
        NetLog.record("outbox", 0, 0, "入队 ${requestId.take(8)} 共 $n 条")
        Log.i("Outbox", "入队 ${requestId.take(8)} 共 $n 条")
        kick(ctx)
        return n
    }

    fun remove(ctx: Context, requestId: String) {
        val n = synchronized(lock) {
            val list = read(ctx)
            list.removeAll { it.requestId == requestId }
            write(ctx, list)
            list.size
        }
        notifyCount(ctx, n)
    }

    /** 立刻把所有条目排到队头（网络刚恢复时用）。 */
    fun kickNow(ctx: Context) {
        synchronized(lock) {
            val list = read(ctx)
            if (list.isEmpty()) return
            write(ctx, list.map { it.copy(nextAt = 0L, attempts = 0) })
        }
        kick(ctx)
    }

    private fun notifyCount(ctx: Context, n: Int) {
        if (onCountChanged == null) return
        main.post { onCountChanged?.invoke(n) }
    }

    /* ---------------- 补发工人 ---------------- */

    /** 幂等：App 每次启动都可调，只会起一条线程、注册一次网络回调。 */
    fun start(ctx: Context) {
        val app = ctx.applicationContext
        if (worker != null) {
            kick(app)
            return
        }
        synchronized(lock) {
            if (worker != null) return
            val t = Thread({ loop(app) }, "pet-outbox")
            t.isDaemon = true
            worker = t
            t.start()
        }
        registerNetwork(app)
        notifyCount(app, count(app))
    }

    fun kick(ctx: Context) {
        val w = worker ?: run { start(ctx); return }
        synchronized(kicked) { (kicked as Object).notifyAll() }
        if (!w.isAlive) start(ctx)
    }

    private fun registerNetwork(ctx: Context) {
        if (netCallback != null) return
        try {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    NetLog.record("outbox", 0, 0, "网络恢复，立刻补发")
                    kickNow(ctx)
                }
            }
            if (Build.VERSION.SDK_INT >= 24) {
                cm.registerDefaultNetworkCallback(cb)
            } else {
                @Suppress("DEPRECATION")
                cm.registerNetworkCallback(android.net.NetworkRequest.Builder().build(), cb)
            }
            netCallback = cb
        } catch (e: Exception) {
            NetLog.record("outbox", 0, 0, "网络回调注册失败 ${e.javaClass.simpleName}")
        }
    }

    private fun loop(ctx: Context) {
        while (true) {
            try {
                val next = synchronized(lock) {
                    val list = read(ctx)
                    if (list.isEmpty()) {
                        null
                    } else {
                        val now = System.currentTimeMillis()
                        list.filter { it.nextAt <= now }.minByOrNull { it.nextAt }
                    }
                }
                if (next == null) {
                    val soonest = synchronized(lock) { read(ctx).map { it.nextAt }.filter { it > 0 }.minOrNull() }
                    val waitMs = when {
                        soonest == null -> 30_000L
                        else -> (soonest - System.currentTimeMillis()).coerceIn(500L, 30_000L)
                    }
                    synchronized(kicked) { (kicked as Object).wait(waitMs) }
                    continue
                }
                deliver(ctx, next)
            } catch (_: InterruptedException) {
                return
            } catch (e: Exception) {
                NetLog.record("outbox", 0, 0, "补发线程异常 ${e.javaClass.simpleName}")
                try {
                    Thread.sleep(2_000)
                } catch (_: InterruptedException) {
                    return
                }
            }
        }
    }

    private fun sleepQuietly(ms: Long) {
        runCatching { Thread.sleep(ms) }
    }

    /** 在会话里找「item.text 这句之后」的第一条 assistant；没有就是空串。 */
    private fun fetchReply(client: PetClient, sid: String, item: Item): String {
        val res = client.session(sid, 12)
        if (!res.ok) return ""
        val arr = res.json?.optJSONArray("messages") ?: return ""
        val want = item.text.trim()
        var seenMe = false
        var lastAssistant = ""
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val role = o.optString("role")
            val text = o.optString("text").trim()
            if (role == "user") {
                if (!seenMe && text.isNotEmpty() && (text == want || text.contains(want.take(24)))) seenMe = true
                continue
            }
            if (role == "assistant" && text.isNotBlank()) {
                if (seenMe) return text
                lastAssistant = text
            }
        }
        // 会话页只截到最近一页时可能看不到用户那句（被挤出去了）：退而取最后一条回答
        return if (seenMe) lastAssistant else ""
    }

    /**
     * 补发成功后，把这句对应的回答从电脑上捞回来落到本地对话里。
     * 只在「这句话之后、同一会话里」找第一条 assistant，找到就追加并通知界面；
     * 已经存在的同文不再追加，避免和正常回合的落库撞车。
     */
    private fun backfillReply(ctx: Context, item: Item) {
        val sid = item.sessionId.ifBlank { PetSettings.chatSession(ctx) }
        if (sid.isBlank()) return
        val client = PetClient { PetSettings.load(ctx) }
        // 宿主收到这句才开始跑回合，回答要几秒才落库：短轮询等一会儿，别捞一次就放弃
        var reply = ""
        for (tryNo in 1..8) {
            reply = runCatching { fetchReply(client, sid, item) }.getOrElse { "" }
            if (reply.isNotBlank()) break
            if (tryNo < 8) sleepQuietly(2_500L)
        }
        if (reply.isBlank()) {
            NetLog.record("outbox", 200, 0, "补发成功但 20s 内没有回答")
            Log.i("Outbox", "补发成功但没有回答（20s）")
            return
        }
        val exists = PetHistory.all(ctx).any { it.role == PetHistory.ROLE_PET && it.text == reply }
        if (!exists) {
            PetHistory.append(ctx, PetHistory.ROLE_PET, reply)
            NetLog.record("outbox", 200, 0, "补发后捞回回答 ${reply.length} 字")
            Log.i("Outbox", "补发后捞回回答 ${reply.length} 字")
        }
        if (replyListeners.isNotEmpty()) {
            main.post { replyListeners.forEach { l -> runCatching { l(reply) } } }
        }
    }

    private fun deliver(ctx: Context, item: Item) {
        val client = PetClient { PetSettings.load(ctx) }
        val res = try {
            client.dispatch(item.text, item.sessionId, item.requestId, item.attachments)
        } catch (e: Exception) {
            NetLog.record("outbox", 0, 0, "补发 ${item.requestId.take(8)} 失败 ${e.javaClass.simpleName}")
            null
        }
        if (res != null && res.ok) {
            remove(ctx, item.requestId)
            NetLog.record("outbox", 200, 0, "补发成功 ${item.requestId.take(8)}")
            Log.i("Outbox", "补发成功 ${item.requestId.take(8)}")
            if (deliveredListeners.isNotEmpty()) {
                main.post { deliveredListeners.forEach { l -> runCatching { l(item.text) } } }
            }
            // 补发这一下没有回合在轮询：宿主的回答只能在会话里捞回来，否则手机上
            // 只看到「已补发」，正文永远缺着——这就是用户说的「收不到消息」。
            Thread({
                runCatching { backfillReply(ctx, item) }
            }, "pet-backfill").start()
            return
        }
        val code = res?.code ?: 0
        // 4xx（除 408/429）是「这句话本身有问题」，再补发也没用；401 等配对恢复再说。
        val retryable = code == 0 || code == 401 || code == 408 || code == 429 || code >= 500
        if (!retryable) {
            remove(ctx, item.requestId)
            NetLog.record("outbox", code, 0, "补发被拒（$code），不再重试 ${item.requestId.take(8)}")
            Log.i("Outbox", "补发被拒 code=$code ${item.requestId.take(8)}")
            return
        }
        val attempts = item.attempts + 1
        if (attempts > MAX_ATTEMPTS) {
            remove(ctx, item.requestId)
            NetLog.record("outbox", code, 0, "补发 ${MAX_ATTEMPTS} 次仍失败，放弃 ${item.requestId.take(8)}")
            Log.w("Outbox", "补发 ${MAX_ATTEMPTS} 次仍失败，放弃 ${item.requestId.take(8)}")
            return
        }
        val base = minOf(60_000L, 1_500L shl minOf(attempts, 5))
        val delay = base + (Math.random() * 1_200L).toLong()
        synchronized(lock) {
            val list = read(ctx)
            val i = list.indexOfFirst { it.requestId == item.requestId }
            if (i >= 0) {
                list[i] = list[i].copy(attempts = attempts, nextAt = System.currentTimeMillis() + delay, lastError = "code=$code")
                write(ctx, list)
            }
        }
        NetLog.record("outbox", code, 0, "补发 ${item.requestId.take(8)} 第 $attempts 次失败，${delay}ms 后再试")
    }
}
