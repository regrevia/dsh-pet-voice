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
        val toolName: String = "",
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
    private var running = false
    private var queued = ""
    private var errorLine: String = ""

    private lateinit var list: ListView
    private lateinit var emptyBox: View
    private lateinit var emptyText: TextView
    private lateinit var peekLine: TextView
    private lateinit var stopBtn: TextView
    private lateinit var goalLine: TextView
    private lateinit var more: TextView
    private lateinit var input: EditText
    private lateinit var adapter: MsgAdapter
    private var render: ChatRender? = null

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
        stopBtn = findViewById(R.id.chatStop)
        goalLine = findViewById(R.id.chatGoal)
        stopBtn.setOnClickListener { doStop() }

        more = TextView(this).apply {
            text = "加载更早"
            setTextColor(getColor(R.color.pet_accent))
            textSize = 12.5f
            gravity = Gravity.CENTER
            val pad = (10 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            visibility = View.GONE
            setOnClickListener { loadEarlier() }
        }
        list.addHeaderView(more, null, false)

        adapter = MsgAdapter()
        list.adapter = adapter
        render = ChatRender(this, maxViews = 8) { PetSettings.load(this) }
        findViewById<View>(R.id.chatBack).setOnClickListener { finish() }
        findViewById<View>(R.id.chatSend).setOnClickListener { send() }
        load()
        refreshStatus()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        runCatching { render?.release() }
        render = null
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
                val parts = toolParts(name, args, text)
                out.add(Msg(o.optLong("seq", 0), "tool", parts.second, parts.second, parts.first))
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
     * 工具行照桌面那套排：左边一个短标签（运行命令 / 读取文件 / 搜索…），后面跟它干的那句话。
     * 一行看完、不展开，所以命令本身留着，别换成「跑了一下」这种说法。
     */
    private fun toolParts(name: String, args: JSONObject?, fallback: String): Pair<String, String> {
        val label = when (name) {
            "bash", "sh", "shell", "exec", "command", "run" -> "运行命令"
            "read", "read_file", "view" -> "读取文件"
            "write", "edit", "write_file", "multiedit", "apply_patch" -> "修改文件"
            "grep", "search", "rg" -> "搜索"
            "glob", "find", "ls", "list_dir" -> "查找文件"
            "web_fetch", "web_search", "fetch" -> "读取网页"
            "subagent", "subagent_fork", "task", "agent" -> "子代理"
            "todo_write", "todo_read" -> "待办"
            "list_agents", "list_tasks", "team_task_list" -> "代理列表"
            "ask_user_question" -> "问你"
            "update_goal", "create_goal", "get_goal" -> "目标"
            else -> name.ifBlank { "工具" }
        }
        val cmd = args?.optString("command").orEmpty().ifBlank { args?.optString("cmd").orEmpty() }
        val desc = args?.optString("description").orEmpty()
        val path = args?.optString("file_path").orEmpty().ifBlank { args?.optString("path").orEmpty() }
        val q = args?.optString("query").orEmpty().ifBlank { args?.optString("pattern").orEmpty() }
        val url = args?.optString("url").orEmpty()
        val prompt = args?.optString("prompt").orEmpty()
        val detail = when {
            cmd.isNotBlank() -> cmd
            desc.isNotBlank() -> desc
            path.isNotBlank() -> path
            q.isNotBlank() -> q
            url.isNotBlank() -> url
            prompt.isNotBlank() -> prompt
            else -> fallback
        }.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
        // 参数本身是 JSON 的（没解析出来），贴出来就是噪音，不如只留标签。
        if (detail.startsWith("{") || detail.startsWith("[")) return label to ""
        val line = if (detail.length <= 200) detail else detail.take(199).trimEnd() + "…"
        return label to line
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

    /* ---------------- 状态：在不在跑、有没有目标 ---------------- */

    /** 每 6 秒对一次宿主：跑没跑完、目标还在不在。网络都在后台线程，不占界面。 */
    private fun refreshStatus() {
        if (sessionId.isBlank()) return
        val sid = sessionId
        io.execute {
            val list = runCatching { client.sessions() }.getOrNull()
            var busy = sending
            list?.json?.optJSONArray("sessions")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    if (o.optString("id") != sid) continue
                    busy = o.optBoolean("running")
                    break
                }
            }
            val goals = runCatching { client.goals(sid) }.getOrNull()
            val objective = goals?.json?.optJSONArray("goals")
                ?.optJSONObject(0)?.optString("objective").orEmpty().trim()
            ui.post {
                running = busy
                stopBtn.visibility = if (busy || sending) View.VISIBLE else View.GONE
                goalLine.text = if (objective.isBlank()) "" else "目标 · " + objective
                goalLine.visibility = if (objective.isBlank()) View.GONE else View.VISIBLE
            }
        }
        ui.postDelayed({ if (!isFinishing) refreshStatus() }, 6_000)
    }

    /** 这一轮不想要了：让宿主掐掉，界面立刻还回可输入。 */
    private fun doStop() {
        val sid = sessionId
        if (sid.isBlank()) return
        stopBtn.visibility = View.GONE
        io.execute {
            val r = runCatching { client.cancel(sid) }.getOrNull()
            ui.post {
                sending = false
                errorLine = ""
                findViewById<android.widget.ImageView>(R.id.chatSend).isEnabled = true
                adapter.notifyDataSetChanged()
                if (r?.ok == true) toast("已停止") else toast("没接上，再点一次")
            }
        }
    }

    private fun toast(text: String) =
        android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_SHORT).show()

    /* ---------------- 写 ---------------- */

    private fun send() {
        val raw = input.text.toString().trim()
        if (raw.isBlank() || sessionId.isBlank()) return
        // 正在跑：先排队，这一轮完了立刻发（跟电脑端一样，不用等它停）
        if (sending) {
            queued = raw
            input.setText("")
            input.hint = "已排队，这一轮结束就发"
            return
        }
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
        if (queued.isNotBlank()) {
            val next = queued
            queued = ""
            input.hint = "发消息"
            input.setText(next)
            ui.postDelayed({ send() }, 120)
        }
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
                val bubble = v.findViewById<android.widget.FrameLayout>(R.id.msgBubble)
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
            val bubble = v.findViewById<android.widget.FrameLayout>(R.id.msgBubble)
            val text = v.findViewById<TextView>(R.id.msgText)
            v.setOnClickListener(null)
            when (row.role) {
                "tool" -> {
                    bubbleRow.gravity = Gravity.START
                    bubble.background = null
                    bubble.setPadding(0, 0, 0, 0)
                    text.maxLines = 1
                    text.ellipsize = TextUtils.TruncateAt.END
                    text.textSize = 12.5f
                    text.setTextColor(getColor(R.color.pet_hint))
                    val label = row.toolName.ifBlank { "工具" }
                    val ssb = android.text.SpannableStringBuilder("› ")
                    val at = ssb.length
                    ssb.append(label)
                    ssb.setSpan(
                        android.text.style.ForegroundColorSpan(getColor(R.color.pet_text_dim)),
                        at, ssb.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
                    )
                    if (row.tool.isNotBlank()) ssb.append("  ·  ")
                    val from = ssb.length
                    ssb.append(row.tool)
                    ssb.setSpan(
                        android.text.style.ForegroundColorSpan(getColor(R.color.pet_hint)),
                        from, ssb.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
                    )
                    text.text = ssb
                }
                "user" -> {
                    bubbleRow.gravity = Gravity.END
                    text.visibility = View.VISIBLE
                    text.maxLines = Int.MAX_VALUE
                    text.ellipsize = null
                    text.textSize = 15f
                    text.setTextColor(getColor(R.color.pet_bg))
                    bubble.background = bubble(getColor(R.color.pet_accent))
                    bubble.setPadding(dp(12), dp(9), dp(12), dp(9))
                    text.maxWidth = dp(292)
                    if (bubble.childCount > 1) bubble.removeViews(1, bubble.childCount - 1)
                    text.text = row.text
                }
                else -> {
                    // 电脑上鱼说的话不带气泡、占满整行：先按纯文本上屏，渲染结果回来再换成富文本
                    bubbleRow.gravity = Gravity.START
                    text.visibility = View.VISIBLE
                    text.maxLines = Int.MAX_VALUE
                    text.ellipsize = null
                    text.textSize = 15f
                    text.setTextColor(getColor(R.color.pet_text))
                    bubble.background = null
                    bubble.setPadding(0, 0, 0, 0)
                    text.maxWidth = resources.displayMetrics.widthPixels - dp(24)
                    if (bubble.childCount > 1) bubble.removeViews(1, bubble.childCount - 1)
                    text.text = MdPlain.of(row.text)
                    val box = render ?: return v
                    if (row.text.isBlank()) return v
                    val html = box.cached(row.text)
                    if (html != null) {
                        text.visibility = View.GONE
                        box.attach(bubble, row.text, html)
                    } else {
                        box.request(row.text) {
                            ui.post {
                                if (!isFinishing && !isDestroyed && indexOf(row.text) >= 0) notifyDataSetChanged()
                            }
                        }
                    }
                }
            }
            return v
        }
    }

    /** 富文本渲染完只刷还在屏上那条，别整列表重排。 */
    fun indexOf(text: String): Int = rows.indexOfFirst { it.role != "tool" && it.text == text }

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
