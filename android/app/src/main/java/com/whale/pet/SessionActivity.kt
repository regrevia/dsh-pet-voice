package com.whale.pet

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * 一只会话的详情：首屏 20 条、往上翻「加载更早」、底部发一句。
 * 消息按 seq 升序；`system` 与空文本一律不显示。
 */
class SessionActivity : Activity() {

    private data class Msg(
        val seq: Long,
        val role: String,
        val text: String,
        val tool: String,
    )

    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val client by lazy { PetClient { PetSettings.load(this) } }

    private val rows = ArrayList<Msg>()
    private val seen = HashSet<Long>()
    private var sessionId = ""
    private var title = ""
    private var hasMore = false
    private var nextBefore: Long = 0
    private var maxSeq: Long = 0
    private var loading = false
    private var sending = false
    private var errorLine: String = ""

    private lateinit var list: ListView
    private lateinit var emptyBox: View
    private lateinit var emptyText: TextView
    private lateinit var peekLine: TextView
    private lateinit var more: TextView
    private lateinit var input: EditText
    private lateinit var adapter: MsgAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_session)
        sessionId = intent.getStringExtra(EXTRA_ID).orEmpty()
        title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "对话" }
        findViewById<TextView>(R.id.chatTitle).text = title
        list = findViewById(R.id.chatList)
        emptyBox = findViewById(R.id.chatEmpty)
        emptyText = emptyBox as TextView
        input = findViewById(R.id.chatInput)
        peekLine = findViewById(R.id.chatPeek)

        more = TextView(this).apply {
            text = "加载更早"
            setTextColor(getColor(R.color.pet_accent))
            textSize = 13f
            gravity = Gravity.CENTER
            val pad = (10 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            visibility = View.GONE
            setOnClickListener { loadEarlier() }
        }
        list.addHeaderView(more, null, false)

        adapter = MsgAdapter()
        list.adapter = adapter
        findViewById<View>(R.id.chatBack).setOnClickListener { finish() }
        findViewById<View>(R.id.chatSend).setOnClickListener { send() }
        load()
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    /* ---------------- 读 ---------------- */

    private fun load() {
        if (loading || sessionId.isBlank()) return
        loading = true
        emptyText.text = "读取中"
        emptyBox.visibility = View.VISIBLE
        io.execute {
            val r = client.session(sessionId, 20)
            val page = parse(r)
            val more = r.json?.optBoolean("hasMore", false) == true
            val next = r.json?.optLong("nextBefore", 0) ?: 0
            ui.post {
                loading = false
                rows.clear()
                seen.clear()
                rows.addAll(page)
                page.forEach { seen.add(it.seq) }
                maxSeq = page.maxOfOrNull { it.seq } ?: 0
                hasMore = more
                nextBefore = next
                applyPeek(r)
                adapter.notifyDataSetChanged()
                refreshMore()
                if (rows.isEmpty()) {
                    emptyText.text = "还没有消息，说句话开始"
                    emptyBox.visibility = View.VISIBLE
                } else {
                    emptyBox.visibility = View.GONE
                }
                scrollBottom()
            }
        }
    }

    private fun loadEarlier() {
        if (loading || !hasMore || nextBefore <= 0) return
        loading = true
        more.text = "读取中"
        io.execute {
            val r = client.session(sessionId, 20, nextBefore)
            val page = parse(r)
            val moreFlag = r.json?.optBoolean("hasMore", false) == true
            val next = r.json?.optLong("nextBefore", 0) ?: 0
            ui.post {
                loading = false
                val add = page.filter { it.seq !in seen }
                add.forEach { seen.add(it.seq) }
                val atTop = rows.firstOrNull()?.seq
                rows.addAll(0, add.sortedBy { it.seq })
                hasMore = moreFlag
                nextBefore = next
                adapter.notifyDataSetChanged()
                refreshMore()
                if (atTop != null) {
                    val idx = rows.indexOfFirst { it.seq == atTop }
                    if (idx >= 0) list.setSelection(idx)
                }
            }
        }
    }

    private fun refreshMore() {
        more.visibility = if (hasMore) View.VISIBLE else View.GONE
        more.text = "加载更早"
    }

    private fun parse(r: PetClient.Result): List<Msg> {
        val out = ArrayList<Msg>()
        val arr = r.json?.optJSONArray("messages") ?: return out
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val role = o.optString("role")
            if (role == "system") continue
            val text = o.optString("text")
            if (role == "tool") {
                val toolObj = o.optJSONObject("tool")
                val name = toolObj?.optString("name").orEmpty().ifBlank { o.optString("name") }
                val args = toolObj?.optJSONObject("args")
                    ?: runCatching { JSONObject(toolObj?.opt("args")?.toString().orEmpty()) }.getOrNull()
                out.add(Msg(o.optLong("seq", 0), "tool", text, toolLabel(name, args, text)))
                continue
            }
            if (role != "user" && role != "assistant") continue
            // 旧版本把旁听材料拼在这句话后面；读的时候切掉，界面上只留用户原话。
            val shown = stripPeek(text)
            if (TextUtils.isEmpty(shown.trim())) continue
            // 宿主回合开始时塞的时间/运行时上下文是给模型看的，不是用户说的话。
            if (role == "user" && isInjectedText(shown)) continue
            out.add(Msg(o.optLong("seq", 0), role, shown, ""))
        }
        return out.sortedBy { it.seq }
    }

    /**
     * 工具那行只说人话：命令就留命令本身，参数别原样糊出来。
     * 「bash {"command":"git log …"}」这种对看对话的人就是噪音。
     */
    private fun toolLabel(name: String, args: JSONObject?, fallback: String): String {
        val cmd = args?.optString("command").orEmpty().ifBlank { args?.optString("cmd").orEmpty() }
        if (cmd.isNotBlank()) return "跑了 " + cleanCommand(cmd)
        val path = args?.optString("file_path").orEmpty().ifBlank { args?.optString("path").orEmpty() }
        if (path.isNotBlank()) {
            val verb = if (name in setOf("write", "edit", "write_file", "apply_patch", "multiedit")) "改了" else "看了"
            return verb + " " + path.substringAfterLast('/')
        }
        val q = args?.optString("query").orEmpty().ifBlank { args?.optString("pattern").orEmpty() }
        if (q.isNotBlank()) return "搜了 " + q.lineSequence().first().trim()
        val url = args?.optString("url").orEmpty()
        if (url.isNotBlank()) {
            return "查了 " + url.removePrefix("https://").removePrefix("http://").take(40)
        }
        val agent = args?.optString("prompt").orEmpty()
        if (agent.isNotBlank()) return "叫了一只帮忙看"
        return when (name) {
            "list_agents" -> "看了自己在忙什么"
            "todo_write" -> "记了下一步"
            "" -> "动了一下手"
            else -> "用了 $name"
        }
    }

    /** 命令只留第一段：管道、重定向、拼接都是给机器的，念出来没人听得懂。 */
    private fun cleanCommand(raw: String): String {
        var cut = raw.lineSequence().first().trim()
        for (sep in listOf(" && ", " || ", "; ", " | ", " 2>", " >", " 2>&1")) {
            val at = cut.indexOf(sep)
            if (at > 0) cut = cut.substring(0, at)
        }
        cut = cut.trim()
        return if (cut.length <= 48) cut else cut.take(47).trimEnd() + "…"
    }

    /** 老的旁听尾巴：从标记起整段不要，别在对话里露出系统腔。 */
    private fun stripPeek(text: String): String {
        var at = -1
        for (marker in arrayOf("【旁听·不属于这条对话】", "【旁听材料：")) {
            val index = text.indexOf(marker)
            if (index >= 0 && (at < 0 || index < at)) at = index
        }
        return (if (at >= 0) text.substring(0, at) else text).trim()
    }

    /** 宿主塞进来的上下文：对模型有用，对看对话的人没有意义。 */
    private fun isInjectedText(text: String): Boolean {
        val body = text.trim()
        if (body.isEmpty()) return true
        return body.startsWith("Time sampled while preparing turn") ||
            body.startsWith("Current runtime context.") ||
            body.startsWith("<system-reminder>") ||
            body.startsWith("<available_skills>") ||
            body.startsWith("<environment_context>")
    }

    /** 宿主说它正在看另一只的活：标题栏下给一行，没有就收起。 */
    private fun applyPeek(r: PetClient.Result) {
        val peek = r.json?.optJSONObject("peek")
        val name = peek?.optString("title").orEmpty().trim()
        if (name.isBlank()) {
            peekLine.visibility = View.GONE
            return
        }
        peekLine.text = "在旁听：$name"
        peekLine.visibility = View.VISIBLE
    }

    private fun firstLine(raw: String): String =
        raw.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()

    /* ---------------- 写 ---------------- */

    private fun send() {
        val raw = input.text.toString().trim()
        if (raw.isBlank() || sending || sessionId.isBlank()) return
        input.setText("")
        input.clearFocus()
        hideKeyboard()
        errorLine = ""
        sending = true
        findViewById<android.widget.ImageView>(R.id.chatSend).isEnabled = false
        appendEcho(raw)
        val sid = sessionId
        io.execute {
            val r = client.dispatch(raw, sid)
            ui.post {
                if (!r.ok) {
                    finishSending("没发出去，点这里重发")
                } else {
                    adapter.notifyDataSetChanged()
                    pollUntilReply(System.currentTimeMillis() + 45_000)
                }
            }
        }
    }

    private fun appendEcho(text: String) {
        rows.add(Msg(0, "user", text, ""))
        adapter.notifyDataSetChanged()
        emptyBox.visibility = View.GONE
        scrollBottom()
    }

    /** dispatch 之后：先等宿主的长轮询，再补拉一次最新一页；45 s 内没有回复就给一行可点的重试。 */
    private fun pollUntilReply(deadline: Long) {
        if (!sending) return
        val sid = sessionId
        io.execute {
            val cursor = if (maxSeq > Int.MAX_VALUE) -1 else maxSeq.toInt()
            client.poll(sid, cursor, 8_000)
            val r = client.session(sid, 20)
            val page = parse(r)
            val more = r.json?.optBoolean("hasMore", false) == true
            val next = r.json?.optLong("nextBefore", 0) ?: 0
            ui.post {
                var replied = false
                for (m in page) {
                    if (m.seq in seen) continue
                    seen.add(m.seq)
                    rows.add(m)
                    if (m.role == "assistant") replied = true
                }
                maxSeq = maxOf(maxSeq, page.maxOfOrNull { it.seq } ?: 0)
                hasMore = more
                nextBefore = next
                applyPeek(r)
                adapter.notifyDataSetChanged()
                refreshMore()
                if (rows.isNotEmpty()) emptyBox.visibility = View.GONE
                if (replied) {
                    finishSending("")
                    scrollBottom()
                    return@post
                }
                if (System.currentTimeMillis() > deadline) {
                    finishSending("没收到回复，重试")
                    scrollBottom()
                    return@post
                }
                ui.postDelayed({ pollUntilReply(deadline) }, 1200)
            }
        }
    }

    private fun finishSending(error: String) {
        sending = false
        errorLine = error
        findViewById<android.widget.ImageView>(R.id.chatSend).isEnabled = true
        adapter.notifyDataSetChanged()
    }

    /** 贴底：这一帧布局完再滚一次，键盘弹出/收起会改高度，立刻滚会滚到一半。 */
    private fun scrollBottom() {
        if (rows.isEmpty()) return
        list.post { list.setSelection(list.count - 1) }
        list.postDelayed({ list.setSelection(list.count - 1) }, 200)
    }

    /** 发出去就把键盘收起来，回复才有地方露脸。 */
    private fun hideKeyboard() {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(input.windowToken, InputMethodManager.HIDE_NOT_ALWAYS)
    }

    private inner class MsgAdapter : BaseAdapter() {
        override fun getCount(): Int = rows.size + (if (errorLine.isNotBlank()) 1 else 0)
        override fun getItem(position: Int): Any? = rows.getOrNull(position)
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            if (position >= rows.size) {
                val v = convertView ?: layoutInflater.inflate(R.layout.item_message, parent, false)
                val bubble = v.findViewById<View>(R.id.msgBubble)
                val text = v.findViewById<TextView>(R.id.msgText)
                bubble.background = null
                text.maxLines = 2
                text.ellipsize = null
                text.setTextColor(getColor(R.color.pet_accent))
                text.text = errorLine
                v.setOnClickListener {
                    val last = rows.lastOrNull { it.role == "user" && it.seq == 0L }?.text ?: return@setOnClickListener
                    sendAgain(last)
                }
                return v
            }
            val row = rows[position]
            val v = convertView ?: layoutInflater.inflate(R.layout.item_message, parent, false)
            val bubbleRow = v as android.widget.LinearLayout
            // 同一侧连着说的几句贴一起，换人说话留一口气，读起来才是一段对话。
            val gap = if (position == 0 || rows[position - 1].role != row.role) dp(9) else dp(3)
            bubbleRow.setPadding(dp(12), gap, dp(12), dp(3))
            val bubble = v.findViewById<View>(R.id.msgBubble)
            val text = v.findViewById<TextView>(R.id.msgText)
            v.setOnClickListener(null)
            when (row.role) {
                "tool" -> {
                    bubbleRow.gravity = Gravity.START
                    bubble.background = bubble(getColor(R.color.pet_hint_bg))
                    bubble.setPadding(dp(9), dp(5), dp(9), dp(5))
                    text.maxLines = 1
                    text.ellipsize = TextUtils.TruncateAt.END
                    text.textSize = 12f
                    text.setTextColor(getColor(R.color.pet_hint))
                    text.text = row.tool
                }
                "user" -> {
                    bubbleRow.gravity = Gravity.END
                    text.maxLines = Int.MAX_VALUE
                    text.ellipsize = null
                    text.textSize = 15f
                    text.setTextColor(getColor(R.color.pet_bg))
                    bubble.setBackgroundResource(0)
                    bubble.background = bubble(getColor(R.color.pet_accent))
                    bubble.setPadding(dp(12), dp(9), dp(12), dp(9))
                    text.text = row.text
                }
                else -> {
                    bubbleRow.gravity = Gravity.START
                    text.maxLines = Int.MAX_VALUE
                    text.ellipsize = null
                    text.textSize = 15f
                    text.setTextColor(getColor(R.color.pet_text))
                    bubble.background = bubble(getColor(R.color.pet_hint_bg))
                    bubble.setPadding(dp(12), dp(9), dp(12), dp(9))
                    text.text = row.text
                }
            }
            return v
        }
    }

    private fun bubble(color: Int) = android.graphics.drawable.GradientDrawable().apply {
        cornerRadius = 16f * resources.displayMetrics.density
        setColor(color)
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun sendAgain(text: String) {
        if (sending) return
        errorLine = ""
        sending = true
        findViewById<android.widget.ImageView>(R.id.chatSend).isEnabled = false
        adapter.notifyDataSetChanged()
        val sid = sessionId
        io.execute {
            val r = client.dispatch(text, sid)
            ui.post {
                if (!r.ok) finishSending("没发出去，点这里重发")
                else pollUntilReply(System.currentTimeMillis() + 45_000)
            }
        }
    }

    companion object {
        private const val EXTRA_ID = "sessionId"
        private const val EXTRA_TITLE = "sessionTitle"

        fun intent(context: Context, sessionId: String, title: String): Intent =
            Intent(context, SessionActivity::class.java)
                .putExtra(EXTRA_ID, sessionId)
                .putExtra(EXTRA_TITLE, title)
    }
}
