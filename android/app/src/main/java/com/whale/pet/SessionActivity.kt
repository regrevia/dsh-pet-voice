package com.whale.pet

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ImageView
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
    // 这句是什么时候发出去的、宿主有没有开始跑：都用来判断「这一轮真的结束了」，
    // 否则刚入队那一秒宿主还没 running，会被当成结束，回执回来就没处放。
    private var sentAt = 0L
    // 还贴着底吗：贴底就一直把最新一行顶到最下面，用户翻上去看历史就停手
    private var stickBottom = true
    private var chaseBottom: Runnable? = null
    private var chaseUntil = 0L
    private var sawRunning = false
    /** 这一轮发给宿主的 requestId：人退出页面时拿它补进待发队列，宿主按它去重，不会多跑一轮。 */
    private var running = false
    private var queued = ""
    private var errorLine: String = ""

    // 这一轮几点开始的（0 = 不知道就不摆用时）；发出去的那句，用来在历史里认出这一轮答完没有
    private var liveAt = 0L
    private var liveSaid = ""
    // 「深度求索中 · 用时」贴在输入框上面那行，跟「排队」同一条：跟着 sending/running 显隐，每秒只改这几个字
    private var liveShown = false
    private var liveTick: Runnable? = null
    private lateinit var liveView: TextView
    // 首屏还没到手时先摆骨架：壳子不空着，也不喊「没有消息」
    private lateinit var skeleton: android.view.ViewGroup
    private var skeletonAnim: android.animation.ValueAnimator? = null

    private lateinit var list: ListView
    private lateinit var emptyBox: View
    private lateinit var emptyText: TextView
    private lateinit var peekLine: TextView
    private lateinit var goalLine: TextView
    private lateinit var more: ImageView
    private lateinit var input: EditText
    private lateinit var micBtn: ImageView
    private lateinit var queueLine: TextView
    private lateinit var sendBtn: ImageView
    private lateinit var stopBtn: ImageView
    private lateinit var adapter: MsgAdapter
    private var render: ChatRender? = null

    /* 按住说话：按下录、松手出字并且直接发。VAD 只在按太久时兜底。 */
    private var recorder: VoiceRecorder? = null
    private var micBusy = false
    @Volatile private var micDown = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_session)
        sessionId = intent.getStringExtra(EXTRA_ID).orEmpty()
        title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "对话" }
        findViewById<TextView>(R.id.chatTitle).text = title
        list = findViewById(R.id.chatList)
        emptyBox = findViewById(R.id.chatEmpty)
        emptyText = emptyBox as TextView
        skeleton = findViewById(R.id.chatSkeleton)
        buildSkeleton()
        input = findViewById(R.id.chatInput)
        peekLine = findViewById(R.id.chatPeek)
        goalLine = findViewById(R.id.chatGoal)
        micBtn = findViewById(R.id.chatMic)
        micBtn.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    micDown = true
                    v.animate().scaleX(1.06f).scaleY(1.06f).setDuration(90).start()
                    buzz()
                    startHold()
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    micDown = false
                    v.animate().scaleX(1f).scaleY(1f).setDuration(90).start()
                    finishHold()
                    v.performClick()
                    true
                }
                else -> true
            }
        }

        // 往上翻到底会自动续页，这个箭头只是给想立刻看更早的人留一个手感
        more = ImageView(this).apply {
            setImageResource(R.drawable.ic_back)
            rotation = 90f
            setColorFilter(getColor(R.color.pet_hint))
            scaleType = ImageView.ScaleType.FIT_CENTER
            val pad = dp(12)
            setPadding(pad, pad, pad, pad)
            visibility = View.GONE
            contentDescription = "更早的消息"
            setOnClickListener { loadEarlier() }
        }
        list.addHeaderView(more, null, false)

        adapter = MsgAdapter()
        list.adapter = adapter
        // setSelection 只管「这一行露出来了」，露半截也算露出来；气泡里的 WebView 出高度又更晚。
        // 所以贴底那几秒里反复补差量，把最后一行的底对齐到列表底。
        chaseBottom = object : Runnable {
            override fun run() {
                if (rows.isEmpty() || !stickBottom || System.currentTimeMillis() > chaseUntil) return
                list.setSelection(list.count - 1)
                val last = list.getChildAt(list.childCount - 1)
                if (last != null) {
                    val rest = last.bottom + list.paddingBottom - list.height
                    if (rest > 0) list.scrollListBy(rest)
                }
                ui.postDelayed(this, 120)
            }
        }
        // 只有手指自己拉走了才停手：程序滚动的中间态也会回调 onScroll，按它判会把跟随提前关掉
        list.setOnScrollListener(object : android.widget.AbsListView.OnScrollListener {
            override fun onScrollStateChanged(v: android.widget.AbsListView?, state: Int) {
                if (state == android.widget.AbsListView.OnScrollListener.SCROLL_STATE_IDLE) stickBottom = nearBottom()
            }
            override fun onScroll(v: android.widget.AbsListView?, first: Int, visible: Int, total: Int) {
                // 翻到顶就自己续上一页，不逼人去点那个箭头
                if (first <= 1 && hasMore && !loading) loadEarlier()
            }
        })
        list.setOnTouchListener { _, e ->
            if (e.actionMasked == android.view.MotionEvent.ACTION_DOWN && !nearBottom()) stickBottom = false
            false
        }
        render = ChatRender(this, maxViews = 8) { PetSettings.load(this) }
        findViewById<View>(R.id.chatBack).setOnClickListener { finish() }
        queueLine = findViewById(R.id.chatQueue)
        liveView = findViewById(R.id.chatRun)
        liveView.setOnClickListener { interrupt() }
        sendBtn = findViewById(R.id.chatSend)
        stopBtn = findViewById(R.id.chatStop)
        sendBtn.setOnClickListener { send() }
        stopBtn.setOnClickListener { interrupt() }
        queueLine.setOnClickListener { steerQueued() }
        input.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun afterTextChanged(s: android.text.Editable?) = syncButton()
        })
        Outbox.addReplyListener(outboxReply)
        Outbox.addFailedListener(outboxFailed)
        restoreLive()
        load()
        refreshStatus()
    }

    override fun onDestroy() {
        Outbox.removeReplyListener(outboxReply)
        Outbox.removeFailedListener(outboxFailed)
        ui.removeCallbacksAndMessages(null)
        runCatching { render?.release() }
        render = null
        io.shutdownNow()
        super.onDestroy()
    }

    /**
     * 从别的会话切回来：本页钉的那只已经不是 App 当前那只，就整页换掉。
     * 以前这里什么都没有，页面一直拿着 onCreate 时那份 id/标题，看起来就是「不更新」。
     */
    override fun onResume() {
        super.onResume()
        chatPage(true)
        val wanted = PetSettings.chatSession(this)
        if (wanted.isNotBlank() && wanted != sessionId) adopt(wanted)
    }

    /** singleTop 复用（manifest :115）不会再走 onCreate，新 intent 只能在这里接住。 */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        val id = intent?.getStringExtra(EXTRA_ID).orEmpty()
        if (id.isBlank()) return
        title = intent?.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "对话" }
        findViewById<TextView>(R.id.chatTitle).text = title
        adopt(id)
    }

    /** 换到 [id]：上一只的行、游标、状态一起清掉再重新拉，避免两只会话的内容叠在一页上。 */
    private fun adopt(id: String) {
        if (id.isBlank()) return
        sessionId = id
        // 标题也是上一只的：先退回中性标题，再从会话列表里把这句的真名取回来
        title = "对话"
        findViewById<TextView>(R.id.chatTitle).text = title
        loading = false
        rows.clear()
        seen.clear()
        hasMore = false
        nextBefore = 0
        maxSeq = 0
        errorLine = ""
        queued = ""
        showQueue()
        running = false
        adapter.notifyDataSetChanged()
        load()
        refreshStatus()
        io.execute {
            val arr = runCatching { client.sessions() }.getOrNull()?.json?.optJSONArray("sessions")
                ?: return@execute
            var found = ""
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                if (o.optString("id") == id) {
                    found = o.optString("title").trim()
                    break
                }
            }
            if (found.isBlank()) return@execute
            ui.post {
                if (sessionId != id) return@post
                title = found
                findViewById<TextView>(R.id.chatTitle).text = found
            }
        }
    }

    /* ---------------- 读 ---------------- */

    private fun load() {
        if (loading || sessionId.isBlank()) return
        loading = true
        // 骨架先摆上：这一屏只是还没到，不是没有消息
        emptyBox.visibility = View.GONE
        showSkeleton()
        val sid = sessionId
        io.execute {
            // 首屏只取最近的一小页：每行都要摆一个 WebView，行多了这一屏就慢
            val r = client.session(sid, 12)
            val page = parse(r)
            val more = r.json?.optBoolean("hasMore", false) == true
            val next = r.json?.optLong("nextBefore", 0) ?: 0
            ui.post {
                // 读的过程中切了会话：这一页是上一只的，丢掉，别糊到新会话上
                if (sid != sessionId) return@post
                loading = false
                rows.clear()
                seen.clear()
                rows.addAll(page)
                page.forEach { seen.add(it.seq) }
                maxSeq = page.maxOfOrNull { it.seq } ?: 0
                hasMore = more
                nextBefore = next
                applyPeek(r)
                hideSkeleton()
                adapter.notifyDataSetChanged()
                refreshMore()
                // 回答真的写进历史了：这一轮的「深度求索中」到此为止
                if (turnBusy() && replyLanded(page, liveSaid)) finishSending("")
                if (rows.isEmpty()) {
                    emptyText.text = if (r.ok) "还没有消息，说句话开始" else "没连上，回头再进"
                    emptyBox.visibility = View.VISIBLE
                } else {
                    emptyBox.visibility = View.GONE
                }
                scrollBottom(force = true)
            }
        }
    }

    private fun loadEarlier() {
        if (loading || !hasMore || nextBefore <= 0) return
        loading = true
        more.alpha = 0.35f
        val sid = sessionId
        io.execute {
            val r = client.session(sid, 20, nextBefore)
            val page = parse(r)
            val moreFlag = r.json?.optBoolean("hasMore", false) == true
            val next = r.json?.optLong("nextBefore", 0) ?: 0
            ui.post {
                if (sid != sessionId) return@post
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
        more.alpha = if (loading) 0.35f else 1f
    }

    private fun parse(r: PetClient.Result): List<Msg> {
        val out = ArrayList<Msg>()
        val arr = r.json?.optJSONArray("messages") ?: return out
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val role = o.optString("role")
            if (role == "system") continue
            // 工具、思考过程都不上屏：手机上只看「我说了什么、鱼答了什么」
            if (role != "user" && role != "assistant") continue
            val text = o.optString("text")
            // 旧版本把旁听材料拼在这句话后面；读的时候切掉，界面上只留用户原话。
            val shown = stripPeek(text)
            if (TextUtils.isEmpty(shown.trim())) continue
            // 宿主回合开始时塞的时间/运行时上下文是给模型看的，不是用户说的话。
            if (role == "user" && isInjectedText(shown)) continue
            out.add(Msg(o.optLong("seq", 0), role, shown, ""))
        }
        return out.sortedBy { it.seq }
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

    /** 宿主塞进来的上下文：对模型有用，对看对话的人没有意义（规则见 [InjectedText]）。 */
    private fun isInjectedText(text: String): Boolean = InjectedText.isInjected(text)

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
                if (sid != sessionId) return@post
                running = busy
                if (busy) sawRunning = true
                syncLive()
                val settled = sawRunning || System.currentTimeMillis() - sentAt > 25_000
                // 这一轮结束：排队的那句该自己发出去了（没点排队条的情况）
                if (!busy && sending && settled && Outbox.count(this) == 0) finishSending("")
                goalLine.text = if (objective.isBlank()) "" else "目标 · " + objective
                goalLine.visibility = if (objective.isBlank()) View.GONE else View.VISIBLE
            }
        }
        ui.postDelayed({ if (!isFinishing) refreshStatus() }, 6_000)
    }

    private fun toast(text: String) =
        android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_SHORT).show()

    /* ---------------- 首屏骨架 ---------------- */

    /** 一行行灰块，宽窄不一、左右交替：看着像一屏正在来的话，不像一条加载条。 */
    private fun buildSkeleton() {
        val box = skeleton as? android.widget.LinearLayout ?: return
        if (box.childCount > 0) return
        val widths = intArrayOf(64, 86, 56, 72)
        val heights = intArrayOf(44, 32, 56, 36)
        val onRight = booleanArrayOf(false, true, false, true)
        for (i in widths.indices) {
            val line = android.widget.LinearLayout(this)
            line.orientation = android.widget.LinearLayout.HORIZONTAL
            val lp = android.widget.LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(heights[i])
            )
            if (i > 0) lp.topMargin = dp(9)
            val block = View(this)
            block.background = skBlock()
            val w = widths[i].toFloat()
            val blockLp = android.widget.LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, w)
            val holdLp = android.widget.LinearLayout.LayoutParams(0, 1, 100f - w)
            if (onRight[i]) {
                line.addView(android.widget.Space(this), holdLp)
                line.addView(block, blockLp)
            } else {
                line.addView(block, blockLp)
                line.addView(android.widget.Space(this), holdLp)
            }
            box.addView(line, lp)
        }
        skeletonAnim = android.animation.ValueAnimator.ofFloat(0.4f, 0.8f).apply {
            duration = 1_100
            repeatCount = android.animation.ValueAnimator.INFINITE
            repeatMode = android.animation.ValueAnimator.REVERSE
            addUpdateListener { a -> skeleton.alpha = a.animatedValue as Float }
        }
    }

    private fun skBlock(): android.graphics.drawable.GradientDrawable {
        val d = android.graphics.drawable.GradientDrawable()
        d.shape = android.graphics.drawable.GradientDrawable.RECTANGLE
        d.cornerRadius = dp(14).toFloat()
        d.setColor(getColor(R.color.pet_hint_bg))
        return d
    }

    private fun showSkeleton() {
        if (!::skeleton.isInitialized) return
        skeleton.visibility = View.VISIBLE
        skeletonAnim?.start()
    }

    private fun hideSkeleton() {
        if (!::skeleton.isInitialized) return
        skeletonAnim?.cancel()
        skeleton.visibility = View.GONE
    }

    /* ---------------- 「深度求索中」这一行 ---------------- */

    /** 这一行现在该不该在：跟着 sending/running 走，跟到一个都不在了才收。 */
    private fun syncLive() {
        if (!::adapter.isInitialized) return
        val want = turnBusy()
        if (want == liveShown) {
            if (want) startTick()
            return
        }
        liveShown = want
        liveView.visibility = if (want) View.VISIBLE else View.GONE
        if (want) {
            liveView.text = liveLine()
            startTick()
            if (stickBottom) scrollBottom(force = true)
        } else {
            stopTick()
        }
        adapter.notifyDataSetChanged()
    }

    private fun startTick() {
        if (liveTick != null) return
        val r = object : Runnable {
            override fun run() {
                liveView.text = liveLine()
                if (liveShown) ui.postDelayed(this, 1_000)
            }
        }
        liveTick = r
        ui.post(r)
    }

    private fun stopTick() {
        liveTick?.let { ui.removeCallbacks(it) }
        liveTick = null
    }

    /** 只改这一行的字，不动列表：每秒 notifyDataSetChanged 会把所有 WebView 重新绑一遍。 */
    private fun liveLine(): String {
        if (liveAt <= 0L) return "深度求索中"
        val sec = (System.currentTimeMillis() - liveAt) / 1000
        val mm = sec / 60
        val ss = sec % 60
        return "深度求索中 · 用时 " + String.format("%02d:%02d", mm, ss)
    }

    /**
     * 这一轮答完没有：在历史里找回「我发出去的那句」，它后面有没有一句非空的回答。
     * 退出再进来时 sending 是猜的，只有历史说了算。
     */
    private fun replyLanded(page: List<Msg>, said: String): Boolean {
        if (said.isBlank()) return false
        val at = page.indexOfLast { it.role == "user" && it.text.trim() == said.trim() }
        if (at < 0) return false
        return page.drop(at + 1).any { it.role == "assistant" && it.text.isNotBlank() }
    }

    /** 重新进来：把上次没答完的那一轮接上（含计时起点和排队的那句）。 */
    private fun restoreLive() {
        val live = ChatLive.read(this, sessionId) ?: return
        liveAt = live.startedAt
        liveSaid = live.said
        sending = true
        sentAt = live.startedAt
        if (live.queued.isNotBlank() && queued.isBlank()) {
            queued = live.queued
            showQueue()
        }
        syncButton()
    }

    /* ---------------- 写 ---------------- */

    private fun send() {
        val raw = input.text.toString().trim()
        if (raw.isBlank() || sessionId.isBlank()) return
        // 上一轮还在跑：这句话进排队条，不打断它；想马上进去就点那条（等于桌面的引导）
        if (sending) {
            queued = raw
            input.setText("")
            showQueue()
            return
        }
        input.setText("")
        input.clearFocus()
        hideKeyboard()
        errorLine = ""
        sending = true
        sentAt = System.currentTimeMillis()
        sawRunning = false
        syncButton()
        appendEcho(raw)
        // 交给待发队列：App 在前台它立刻发，退出/切后台它接着补发，回执由 reply 监听补回来。
        // 以前在这儿开 45 s 长轮询，主人一退出就 io.shutdownNow()，回复永远到不了。
        runCatching { Outbox.add(this, raw, sessionId = sessionId) }
    }

    private fun appendEcho(text: String) {
        // 这一轮的用时从这句算起；顺手落一份现场，退出再回来还认得出「还在答」
        liveAt = System.currentTimeMillis()
        liveSaid = text
        ChatLive.save(this, sessionId, liveAt, text, queued)
        rows.add(Msg(0, "user", text, ""))
        adapter.notifyDataSetChanged()
        emptyBox.visibility = View.GONE
        scrollBottom(force = true)
    }

    /** 后台捞回来的回答：只有本页还在等这一轮才插，免得别处的回执糊到这只会话上。 */
    private fun appendReply(text: String) {
        if (!sending || text.isBlank()) return
        // 补发那条路偶尔会把同一句回答再送一次：这条回答已经在列表里就不再插一遍
        if (rows.any { it.role == "assistant" && it.text.trim() == text.trim() }) return
        val stick = nearBottom()
        maxSeq += 1
        rows.add(Msg(maxSeq, "assistant", text, ""))
        emptyBox.visibility = View.GONE
        adapter.notifyDataSetChanged()
        finishSending("")
        if (stick) scrollBottom(force = true)
    }

    /* ---------------- 待发队列回执：退出页面也收得到回复 ---------------- */

    /** 后台把这一轮的回答捞回来了：插进列表并滚到底。 */
    private val outboxReply: (String) -> Unit = { text -> runCatching { appendReply(text) } }
    private val outboxFailed: (String, String, Boolean) -> Unit = { _, reason, _ ->
        runCatching { finishSending(reason) }
    }

    private fun finishSending(error: String) {
        sending = false
        errorLine = error
        liveAt = 0L
        liveSaid = ""
        ChatLive.clear(this, sessionId)
        syncButton()
        adapter.notifyDataSetChanged()
        if (queued.isNotBlank()) {
            val next = queued
            queued = ""
            showQueue()
            input.setText(next)
            ui.postDelayed({ send() }, 120)
        }
    }

    /** 这一轮还在不在跑：本页发出去的那句，或者宿主说这只会话还在跑。 */
    private fun turnBusy(): Boolean = sending || running

    /**
     * 发送位只有一个：这一轮还在跑并且输入框是空的，就摆方块（中断）；
     * 输入框一有字就换回发送，跟桌面端一样——想插话先打字，不想等了按方块。
     */
    private fun syncButton() {
        val hasText = input.text.toString().isNotBlank()
        val wantStop = sending && !hasText
        if (!::stopBtn.isInitialized) return
        stopBtn.visibility = if (wantStop) View.VISIBLE else View.GONE
        sendBtn.visibility = if (wantStop) View.GONE else View.VISIBLE
        sendBtn.isEnabled = !turnBusy() || hasText
        syncLive()
    }

    /** 排队条：这一轮跑完自己会发；等不及就点它。 */
    private fun showQueue() {
        if (!::queueLine.isInitialized) return
        if (queued.isBlank()) {
            queueLine.visibility = View.GONE
            return
        }
        queueLine.text = "排队 · " + queued
        queueLine.visibility = View.VISIBLE
        // 多出来的这一行会把列表顶短，正贴着底就跟着再压一下
        if (stickBottom) scrollBottom()
    }

    /** 点排队条 = 引导：直接插进正在跑的这一轮，不掐断、不等它停。 */
    private fun steerQueued() {
        val text = queued
        if (text.isBlank() || sessionId.isBlank()) return
        val steering = sending
        queued = ""
        showQueue()
        errorLine = ""
        appendEcho(text)
        val sid = sessionId
        if (!steering) {
            // 这一轮其实已经停了（比如刚按过中断）：就当成正常一轮发出去
            sending = true
            sentAt = System.currentTimeMillis()
            sawRunning = false
            syncButton()
        }
        io.execute {
            val r = client.dispatch(text, sid, steer = steering)
            ui.post {
                if (!r.ok) {
                    // 引导没送进去就落盘补发，回答照样靠 reply 监听补回来
                    runCatching { Outbox.add(this, text, sessionId = sid) }
                    finishSending("没发出去，已放进待发队列")
                }
            }
        }
    }

    /** 方块 = 中断这一轮。 */
    private fun interrupt() {
        if (!sending) return
        sending = false
        errorLine = ""
        liveAt = 0L
        liveSaid = ""
        ChatLive.clear(this, sessionId)
        syncButton()
        adapter.notifyDataSetChanged()
        val sid = sessionId
        io.execute { runCatching { client.cancel(sid) } }
    }

    /** 贴底：只在本来就贴着底时跟一下；用户翻上去看历史就别抢滚动。 */
    private fun scrollBottom(force: Boolean = false) {
        if (rows.isEmpty()) return
        if (!force && !nearBottom()) return
        stickBottom = true
        list.setSelection(list.count - 1)
        chaseUntil = System.currentTimeMillis() + 6_000
        chaseBottom?.let { ui.removeCallbacks(it); ui.post(it) }
    }

    /** 离底不到两行就算贴底：键盘弹起/收起会差一两行，别因此判定「用户翻上去了」。 */
    private fun nearBottom(): Boolean {
        if (list.count == 0) return true
        val last = list.lastVisiblePosition
        return last < 0 || last >= list.count - 2
    }

    /** 发出去就把键盘收起来，回复才有地方露脸。 */
    private fun hideKeyboard() {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(input.windowToken, InputMethodManager.HIDE_NOT_ALWAYS)
    }

    private inner class MsgAdapter : BaseAdapter() {
        // 尾巴上只挂错误行：「深度求索中」已经挪到输入框上面那行，不再占列表
        override fun getCount(): Int =
            rows.size + (if (errorLine.isNotBlank()) 1 else 0)

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
                    text.text = MdPlain.of(row.text)
                    val box = render ?: return v
                    if (row.text.isBlank()) {
                        if (bubble.childCount > 1) bubble.removeViews(1, bubble.childCount - 1)
                        return v
                    }
                    val html = box.cached(row.text)
                    if (html != null) {
                        text.visibility = View.GONE
                        // attach 里已有同文 WebView 会直接返回；以前这里先 removeViews 再挂，
                        // 等于每条气泡每刷一次都重新载一遍页面，屏上就是白闪一下。
                        box.attach(bubble, row.text, html)
                    } else {
                        // 只有旧内容确实不是这一条时才摘掉，避免留下上一句的富文本
                        val old = bubble.getChildAt(1)
                        if (old != null && (old.tag as? String) != row.text) {
                            bubble.removeViews(1, bubble.childCount - 1)
                        }
                        text.visibility = View.VISIBLE
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
        sentAt = System.currentTimeMillis()
        sawRunning = false
        syncButton()
        appendEcho(text)
        runCatching { Outbox.add(this, text, sessionId = sessionId) }
    }

    /* ---------------- 按住说话 ---------------- */

    /** 按下那一下就抖 24ms：手指有反馈，也知道自己按对了地方。 */
    private fun buzz() {
        runCatching {
            val v = getSystemService(Vibrator::class.java) ?: return
            v.vibrate(VibrationEffect.createOneShot(24, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }

    private fun startHold() {
        if (micBusy || sessionId.isBlank()) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            return
        }
        micBusy = true
        micBtn.animate().scaleX(1.1f).scaleY(1.1f).setDuration(110).start()
        // 录的时候别让唤醒引擎把这句话吞了
        wakeAction("com.whale.pet.action.WAKE_PAUSE")
        val r = recorder ?: VoiceRecorder().also { recorder = it }
        r.onAutoStop = { ui.post { finishHold() } }
        startRecorder(r, 0)
    }

    private fun startRecorder(r: VoiceRecorder, attempt: Int) {
        if (!micDown) {                          // 手已经松了，别再跟他抢麦
            if (micBusy) finishHold()
            return
        }
        if (r.start()) return
        if (attempt < 3) {
            ui.postDelayed({ if (micBusy) startRecorder(r, attempt + 1) }, 220)
            return
        }
        micBusy = false
        micBtn.animate().scaleX(1f).scaleY(1f).setDuration(110).start()
        wakeAction("com.whale.pet.action.WAKE_RESUME")
        toast("麦克风不可用")
    }

    /** 松手就停：拿 WAV 走现有的识别接口，出来的字直接发出去，不等 VAD 那一秒尾巴。 */
    private fun finishHold() {
        if (!micBusy) return
        micBusy = false
        micBtn.animate().scaleX(1f).scaleY(1f).setDuration(110).start()
        val r = recorder ?: return
        val wav = runCatching { r.stop() }.getOrNull()
        wakeAction("com.whale.pet.action.WAKE_RESUME")
        if (wav == null || wav.size < 1024) {
            toast(r.takeFaultText() ?: "没听清，再说一次")
            return
        }
        io.execute {
            val text = runCatching { client.asr(wav).json?.optString("text").orEmpty().trim() }
                .getOrDefault("")
            ui.post {
                if (isFinishing || isDestroyed) return@post
                if (text.isBlank()) {
                    toast("没听清，再说一次")
                    return@post
                }
                input.setText(text)
                send()
            }
        }
    }

    /** 同 HistoryActivity：这一页也算会话页，开着开关就把小人留在这儿。 */
    private fun chatPage(on: Boolean) {
        if (on && !PetSettings.showInApp(this)) return
        if (!FloatingPetService.alive) return
        runCatching {
            startService(
                Intent(this, FloatingPetService::class.java)
                    .setAction(FloatingPetService.ACTION_CHAT_PAGE)
                    .putExtra(FloatingPetService.EXTRA_ON, on),
            )
        }
    }

    private fun wakeAction(action: String) {
        runCatching { startService(Intent(this, FloatingPetService::class.java).setAction(action)) }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_MIC && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED && micDown) {
            startHold()
        }
    }

    override fun onPause() {
        chatPage(false)
        // 退出前把这一轮的现场落盘：回来时计时和「还在答」都接得上
        if (sending && liveAt > 0L) ChatLive.save(this, sessionId, liveAt, liveSaid, queued)
        super.onPause()
        // 离开页面就别再攥着麦克风；按住中被打断也按松手处理
        micDown = false
        if (micBusy) finishHold()
    }

    companion object {
        private const val EXTRA_ID = "sessionId"
        private const val EXTRA_TITLE = "sessionTitle"
        private const val REQ_MIC = 41

        fun intent(context: Context, sessionId: String, title: String): Intent =
            Intent(context, SessionActivity::class.java)
                .putExtra(EXTRA_ID, sessionId)
                .putExtra(EXTRA_TITLE, title)
    }
}
