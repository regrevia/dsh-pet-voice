package com.whale.pet

import android.content.Context
import android.content.Intent
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 最近 200 条网络事件，给「诊断」用：哪次请求慢了、断了几次、最后收到第几帧。
 * 只留路径、状态码、耗时，不落 token、不落正文。
 */
object NetLog {

    private const val MAX = 200
    private const val FILE = "net.log"
    private val lines = ArrayDeque<String>()
    private val lock = Any()
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    @Volatile private var app: Context? = null
    @Volatile var reconnects = 0
        private set
    @Volatile var lastSeq = -1
        private set
    @Volatile var lastStatus = 0
        private set

    fun attach(context: Context) {
        app = context.applicationContext
    }

    /** 被折叠的播报轮询次数：正常 200 的 300ms 轮询不逐条记，只在攒够一批时留一行。 */
    private var sayQuiet = 0
    private const val SAY_QUIET_BATCH = 40

    fun record(path: String, code: Int, ms: Long, note: String = "") {
        lastStatus = code
        // 播报轮询每 300ms 一条：逐条记会把 200 行的环形日志在一分钟内冲干净，
        // 真出问题时现场已经没了。正常的轮询折叠成「×N」，失败/慢请求照常逐条留。
        if (path == "GET /api/say" && code in 200..299 && ms < 3000 && note.isBlank()) {
            val batch = synchronized(lock) { if (++sayQuiet >= SAY_QUIET_BATCH) { sayQuiet = 0; true } else false }
            if (batch) push("${fmt.format(Date())} 播报轮询 ×$SAY_QUIET_BATCH 正常 ${ms}ms")
            return
        }
        flushSayQuiet()
        push("${fmt.format(Date())} $path" + (if (code > 0) " http=$code" else "") + " ${ms}ms" + if (note.isBlank()) "" else " $note")
    }

    /** 有别的网络事件要记：先把折叠着的播报轮询结掉，免得前后顺序看不出来。 */
    private fun flushSayQuiet() {
        val n = synchronized(lock) { val v = sayQuiet; sayQuiet = 0; v }
        if (n > 0) push("${fmt.format(Date())} 播报轮询 ×$n 正常")
    }

    fun reconnect() {
        reconnects += 1
        push("${fmt.format(Date())} 重连 #$reconnects")
    }

    fun seq(v: Int) {
        if (v > lastSeq) lastSeq = v
    }

    fun lastSeqLine(): String = "最后收到第 $lastSeq 帧"
    fun reconnectLine(): String = "重连 $reconnects 次"

    /** 导出用：头部三行说明现状，后面是事件流。 */
    fun dump(context: Context): String {
        attach(context)
        val head = buildString {
            appendLine(reconnectLine())
            appendLine(lastSeqLine())
            appendLine("最近状态 $lastStatus")
        }
        val body = synchronized(lock) { lines.joinToString("\n") }
        return head + body
    }

    fun shareText(context: Context): String = dump(context)

    private fun push(line: String) {
        synchronized(lock) {
            lines.addLast(line)
            while (lines.size > MAX) lines.removeFirst()
        }
        val ctx = app ?: return
        runCatching {
            val f = File(ctx.filesDir, FILE)
            f.appendText(line + "\n")
            if (f.length() > 64 * 1024) {
                val keep = f.readLines().takeLast(MAX)
                f.writeText(keep.joinToString("\n") + "\n")
            }
        }
    }

    /** 设置页「诊断」点开后的动作：把事件流交给系统分享面板，不新开页面。 */
    fun send(context: Context) {
        runCatching {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, dump(context))
            }
            context.startActivity(Intent.createChooser(intent, "诊断"))
        }
    }
}
