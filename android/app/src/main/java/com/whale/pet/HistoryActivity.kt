package com.whale.pet

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.GridLayout
import android.widget.PopupWindow
import android.view.inputmethod.EditorInfo
import android.widget.AdapterView
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.LinkedHashSet
import java.util.Locale

/**
 * 对话页：一级「项目」→ 二级「该项目里的会话」，外加一个输入行。
 *
 * 分层的理由和桌面 DSH 一样：先选在哪干活（项目），再选跟哪条线接着聊（会话）。
 * 选项目默认落进新会话；选会话就绑定那只。层级只在本地渲染，不缓存成第二套真相。
 */
class HistoryActivity : Activity() {

    private companion object {
        /** 扫码页的请求码（首页用的是 42，这里错开）。 */
        const val REQ_SCAN = 43
        /** 从相册挑一张图。 */
        const val REQ_PICK_IMAGE = 44
        /** 说「拍张照」之后开的相机。 */
        const val REQ_CAMERA = 45
        /** 说「截个屏」之后系统收的那次授权。 */
        const val REQ_PROJECTION = 46
        /** 拍照前要的一次相机权限（清单里声明了相机，没授权系统就不让开相机）。 */
        const val REQ_SNAP_PERM = 47

        /** 发出去之前先把长边缩到这个像素以内，再压成 JPEG。 */
        const val SEND_IMAGE_MAX_PX = 1600
        /** 页面开着时多久核一次「这只对话还在不在、叫什么」（不跟电脑切）。 */
        const val HOST_WATCH_MS = 20_000L

        /** 聊天里能看的图：跟宿主 /api/file 的白名单一致。 */
        val IMAGE_EXT = setOf("jpg", "jpeg", "png", "webp", "gif")
        /** markdown 图片 `![alt](/abs/path)`。 */
        val MARKDOWN_IMG = Regex("!\\[[^]]*]\\(\\s*<?([^)\\s>]+)")
        /** 正文里的裸绝对路径（含 `[图片] /abs/path` 这种宿主回显）。 */
        val ABS_IMG = Regex("/[\\w\\u4e00-\\u9fa5 .\\-+/@]+?\\.(?:jpe?g|png|webp|gif)", RegexOption.IGNORE_CASE)
    }


    private lateinit var list: ListView
    private lateinit var empty: TextView
    private lateinit var typing: TextView
    private lateinit var runBar: View
    private lateinit var runText: TextView
    private lateinit var runStop: TextView
    private lateinit var input: EditText
    private lateinit var sendBtn: android.widget.ImageView
    private lateinit var emojiBtn: android.widget.ImageView
    private lateinit var micBtn: android.widget.ImageView
    private lateinit var projectBtn: TextView
    private lateinit var sessionsBtn: android.widget.ImageView
    private lateinit var head: View
    private lateinit var sessionLabel: TextView
    private lateinit var attachBtn: android.widget.ImageView

    private lateinit var pickerScrim: View
    private lateinit var pickerSheet: View
    private lateinit var pickerBack: android.widget.ImageView
    private lateinit var pickerTitle: TextView
    private lateinit var pickerList: ListView
    private lateinit var pickerClose: android.widget.ImageView

    private val ui = Handler(Looper.getMainLooper())
    private val adapter = ChatAdapter()
    private val pickerAdapter = PickerAdapter()

    private var turn: PetTurn? = null
    private var turnStart = 0L
    /** 用户自己点了「停止」：这一轮不该再弹「没收到回复」。 */
    private var userStopped = false
    private var lastSent = ""
    /** 上一次带出去的图片路径：重发要跟着一起重发。 */
    private var lastAttachment = ""
    /** 带着这张图的那条气泡是谁（时间戳）：只给那一条挂缩略图，后面的文字行别跟着沾。 */
    private var lastAttachmentTs = 0L
    /** 屏幕上这只对话的名字（宿主说叫什么就叫什么，查不到就空着）。 */
    private var liveSessionTitle = ""
    private var syncing = false
    private var tts: TtsPlayer? = null
    private var render: ChatRender? = null

    /** 一级=项目列表，二级=某项目的会话列表。 */
    private var pickerLevel = 1
    private var projects: List<Ws> = emptyList()
    private var sessions: List<Sess> = emptyList()
    private var pickerProject = ""
    private var pickerLoading = false
    private val pickerRows = ArrayList<PickerRow>()

    /** 按住说话 */
    private var recorder: VoiceRecorder? = null
    private var micBusy = false
    @Volatile private var micDown = false

    /** 正在等相机／截屏结果：空 = 没有动作在等。 */
    private var snapKind = ""
    /** 相机写哪（Android 10+ 走系统相册，自己不用存储权限）。 */
    private var snapUri: Uri? = null

    private data class Ws(val id: String, val title: String, val path: String, val pinned: Boolean)
    private data class Sess(val id: String, val title: String, val at: Long)

    private sealed class ChatRow {
        data class Me(val text: String, val ts: Long = 0L) : ChatRow()
        data class Pet(val text: String, val rich: Boolean) : ChatRow()
        data class Live(val text: String) : ChatRow()
        /** 居中灰字提示（换过会话之类），不算谁说的话。 */
        data class Note(val text: String) : ChatRow()
    }

    private sealed class PickerRow {
        data class Head(val text: String) : PickerRow()
        data class Proj(val ws: Ws) : PickerRow()
        data class SessRow(val s: Sess) : PickerRow()
        /** 「新建项目」这类没有现成数据的行。 */
        data class Action(val text: String) : PickerRow()
        /** 「新建对话」：就在当前项目里开一只新的。 */
        data class NewChat(val text: String) : PickerRow()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_history)

        list = findViewById(R.id.historyList)
        // 状态栏内边距自己加：fitsSystemWindows 会和键盘 resize 抢高度，底栏被挤掉过
        findViewById<View>(R.id.historyRoot).setOnApplyWindowInsetsListener { v, insets ->
            v.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
            insets
        }
        empty = findViewById(R.id.historyEmpty)
        typing = findViewById(R.id.chatTyping)
        runBar = findViewById(R.id.chatRun)
        runText = findViewById(R.id.chatRunText)
        runStop = findViewById(R.id.chatStop)
        input = findViewById(R.id.chatInput)
        sendBtn = findViewById(R.id.chatSend)
        emojiBtn = findViewById(R.id.chatEmoji)
        micBtn = findViewById(R.id.chatMic)
        projectBtn = findViewById(R.id.historyProject)
        sessionsBtn = findViewById(R.id.historySessions)
        head = findViewById(R.id.historyHead)
        sessionLabel = findViewById(R.id.historySession)
        attachBtn = findViewById(R.id.chatAttach)

        pickerScrim = findViewById(R.id.pickerScrim)
        pickerSheet = findViewById(R.id.pickerSheet)
        pickerBack = findViewById(R.id.pickerBack)
        pickerTitle = findViewById(R.id.pickerTitle)
        pickerList = findViewById(R.id.pickerList)
        pickerClose = findViewById(R.id.pickerClose)

        list.adapter = adapter
        // 新回复、历史翻页都会重排列表，每次数据变化都重新贴底
        adapter.registerDataSetObserver(object : android.database.DataSetObserver() {
            override fun onChanged() = scrollToBottom()
        })
        // 条目点击交给列表自己派发：挂在子视图上的监听在复用行里靠不住
        list.setOnItemClickListener { _, _, pos, _ -> adapter.tap(pos) }
        pickerList.adapter = pickerAdapter
        list.dividerHeight = 0

        findViewById<View>(R.id.historyBack).setOnClickListener { finish() }
        projectBtn.setOnClickListener { openPicker(1) }
        // 标题整块可点：项目名和会话名都走同一个选择层
        head.setOnClickListener { openPicker(if (liveSessionTitle.isBlank()) 1 else 2) }
        sessionsBtn.setOnClickListener { openPicker(2) }
        findViewById<View>(R.id.historyNew).setOnClickListener { newChat() }
        pickerClose.setOnClickListener { closePicker() }
        pickerScrim.setOnClickListener { closePicker() }
        pickerBack.setOnClickListener { if (pickerLevel == 2) openPicker(1) else closePicker() }
        pickerList.onItemClickListener =
            AdapterView.OnItemClickListener { _, _, pos, _ -> onPickerPick(pos) }

        sendBtn.setOnClickListener { sendChat() }
        emojiBtn.setOnClickListener { showEmojiPicker() }
        attachBtn.setOnClickListener { pickImage() }
        runStop.setOnClickListener { stopTurn() }
        input.setOnEditorActionListener { _, actionId, ev ->
            if (actionId == EditorInfo.IME_ACTION_SEND || (ev?.keyCode == KeyEvent.KEYCODE_ENTER && ev.action == KeyEvent.ACTION_DOWN)) {
                sendChat()
                true
            } else {
                false
            }
        }

        // 按住说话：按下开录、松手出字并且直接发出去。和输入框共用一个发送动作，没有二次确认。
        micBtn.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    micDown = true
                    startHold()
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    micDown = false
                    finishHold()
                    v.performClick()
                    true
                }
                else -> true
            }
        }

        adapter.onRetry = { resendLast() }
        render = ChatRender(this) { PetSettings.load(this) }

        refreshHeader()
        reload()
        takeSharedImage(intent)
        takeSnapIntent(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent == null) return
        setIntent(intent)
        takeSharedImage(intent)
        takeSnapIntent(intent)
    }

    /** 在悬浮窗那边说了「拍张照／截个屏」：页面被拉起来后直接办，不用再点一次。 */
    private fun takeSnapIntent(intent: Intent?) {
        val safe = intent ?: return
        val kind = safe.getStringExtra(SnapCommand.EXTRA).orEmpty()
        if (kind.isBlank()) return
        safe.removeExtra(SnapCommand.EXTRA)
        window.decorView.post { runSnap(kind) }
    }

    /** 外面「分享 → 小精灵」进来的图：直接走发图，不弹相册。 */
    private fun takeSharedImage(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        @Suppress("DEPRECATION")
        val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: return
        // 同一个 Intent 只接一次，转屏/回前台别重发
        intent.removeExtra(Intent.EXTRA_STREAM)
        window.decorView.post { sendImage(uri) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_SNAP_PERM) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) runSnap(SnapCommand.CAMERA)
        else toast("没相机权限，拍不了")
    }

    override fun onResume() {
        super.onResume()
        refreshHeader()
        reload()
        syncSession()
        // 页面开着的时候核一下这只还在不在、名字对不对（20 秒一次，够快也不费电）
        ui.removeCallbacks(hostWatch)
        ui.postDelayed(hostWatch, HOST_WATCH_MS)
    }

    private val hostWatch = object : Runnable {
        override fun run() {
            syncSession()
            ui.postDelayed(this, HOST_WATCH_MS)
        }
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacks(hostWatch)
        // 离开页面就别再录了，免得麦克风一直攥在手里
        micDown = false
        if (recorder?.isRecording == true) runCatching { recorder?.stop() }
        // 只是不再出声：这一轮还在电脑上跑，切回来照样接得住。
        // 以前这里直接取消，用户去看一眼电脑再回来，回复就没了。
        runCatching { tts?.release() }
        tts = null
    }

    override fun onDestroy() {
        ui.removeCallbacks(hostWatch)
        ui.removeCallbacksAndMessages(null)
        turn?.cancel()
        turn = null
        runCatching { tts?.release() }
        tts = null
        runCatching { render?.release() }
        render = null
        super.onDestroy()
    }

    @Deprecated("BackHandler")
    override fun onBackPressed() {
        // 选择层开着时，返回先收层，不退页面
        if (pickerSheet.visibility == View.VISIBLE) {
            if (pickerLevel == 2) openPicker(1) else closePicker()
            return
        }
        super.onBackPressed()
    }

    /* ---------------- 标题与列表 ---------------- */

    private fun refreshHeader() {
        val title = PetSettings.pinnedTitle(this)
        projectBtn.text = title.ifBlank { "项目" }
        // 第二行是「这一问落在哪只会话」。还没拿到会话名（刚开的新会话、名字还没生成）
        // 就直说「新会话」：拿项目名顶上会让人以为自己在旧对话里。
        val line = liveSessionTitle.ifBlank {
            if (PetSettings.chatSession(this).isNotBlank()) "新会话" else ""
        }
        sessionLabel.text = line
        sessionLabel.visibility = if (line.isBlank()) View.GONE else View.VISIBLE
    }

    /**
     * 跟宿主核一次「屏幕上这只对话到底是哪只」。
     *
     * App 发消息会带上自己钉的会话 id，所以落点由这边说了算；但钉的那可能在电脑上被
     * 删了/归档了。核对不上就跟着宿主的落点走，换过一次就在对话里留一行——
     * 不能让人对着一个已经悄悄换了对象的窗口接着说话。
     */
    private fun syncSession(after: (() -> Unit)? = null) {
        if (syncing) {
            after?.invoke()
            return
        }
        syncing = true
        val client = PetClient { PetSettings.load(this) }
        Thread({
            val res = try { client.state() } catch (_: Exception) { null }
            runOnUiThread {
                syncing = false
                if (!isFinishing && !isDestroyed) {
                    res?.json?.let { adoptHostState(it) }
                    after?.invoke()
                }
            }
        }, "pet-session-sync").apply { isDaemon = true }.start()
    }

    /** 宿主现状 → 标题 + 本地指针。只在真的变了的时候动。 */
    private fun adoptHostState(state: JSONObject) {
        val target = state.optString("dispatchTarget").orEmpty()
        val current = state.optJSONObject("current")
        val hostId = target.ifBlank { current?.optString("id").orEmpty() }
        val mine = PetSettings.chatSession(this)
        val shown = mine.ifBlank { hostId }
        val title = titleOf(state, shown)
        if (title.isNotBlank() && niceTitle(title) != liveSessionTitle) {
            liveSessionTitle = niceTitle(title)
            refreshHeader()
        }
        // 本地没钉：从这一刻起明确钉在宿主当前落点上，之后电脑上再换也不会把它带走
        if (mine.isBlank() && hostId.isNotBlank()) PetSettings.saveChatSession(this, hostId)
        // 最近会话表里查不到名字（太老、掉出列表）：单独问这只一句，只补标题
        if (title.isBlank() && shown.isNotBlank()) syncTitle(shown)
    }

    /**
     * 宿主给的名字有时是原始提示词（开头一片「#」和空白），上屏前收拾成一句话。
     * 太长就截断——名字是给人认的，不是给全文的。
     */
    private fun niceTitle(raw: String): String {
        val t = raw.replace(Regex("[#*>`]+"), " ").replace(Regex("\\s+"), " ").trim()
        return if (t.length <= 22) t else t.take(21).trimEnd() + "…"
    }

    /** 会话 id 在 state 里查名字；查不到回空串（宁可不显示，也不把 id 糊到脸上）。 */
    private fun titleOf(state: JSONObject, id: String): String {
        if (id.isBlank()) return ""
        val cur = state.optJSONObject("current")
        if (cur != null && cur.optString("id") == id) {
            cur.optString("title").orEmpty().let { if (it.isNotBlank()) return it }
        }
        val arr = state.optJSONArray("sessions") ?: return ""
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("id") == id) return o.optString("title").orEmpty()
        }
        return ""
    }

    /** 会话表里没这只（多半太老、掉出了最近列表）：单独问一句它的名字。 */
    private fun syncTitle(id: String) {
        val client = PetClient { PetSettings.load(this) }
        Thread({
            val title = try { client.sessionInfo(id).json?.optJSONObject("session")?.optString("title").orEmpty() } catch (_: Exception) { "" }
            if (title.isBlank()) return@Thread
            runOnUiThread {
                if (!isFinishing && !isDestroyed && id == PetSettings.chatSession(this) && niceTitle(title) != liveSessionTitle) {
                    liveSessionTitle = niceTitle(title)
                    refreshHeader()
                }
            }
        }, "pet-session-title").apply { isDaemon = true }.start()
    }

    /**
     * 这一问实际落在宿主的哪只上（[PetTurn] 从回执里读出来的）。
     *
     * 和本地钉的不一样 = 钉的那只不在了，宿主给了新的落点：存下来、留一行提示。
     * 电脑上切到哪只不影响这边——绑定只认 App 里选的那只。
     */
    private fun onSessionResolved(id: String) {
        if (id.isBlank()) return
        val mine = PetSettings.chatSession(this)
        if (id == mine) return
        val wasPinned = mine.isNotBlank()
        PetSettings.saveChatSession(this, id)
        liveSessionTitle = ""
        refreshHeader()
        if (wasPinned) {
            PetHistory.append(this, PetHistory.ROLE_NOTE, "原来那只对话不在了，换了一只继续")
            reload()
        }
        syncSession()
    }

    private fun reload() {
        val items = PetHistory.all(this)
        val lastPet = items.indexOfLast { !it.isMe && !it.isNote }
        val rows = ArrayList<ChatRow>(items.size + 2)
        items.forEachIndexed { i, item ->
            if (item.isNote) {
                rows.add(ChatRow.Note(item.text))
            } else if (item.isMe) {
                rows.add(ChatRow.Me(item.text, item.ts))
            } else {
                // 只有最后一条助手消息挂富文本渲染器：历史长列表里塞多个 WebView 会卡
                rows.add(ChatRow.Pet(item.text, rich = i == lastPet))
            }
        }
        val live = liveText
        if (live.isNotBlank()) rows.add(ChatRow.Live(live))
        adapter.rows = rows
        adapter.notifyDataSetChanged()
        empty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        scrollToBottom()
    }

    private val pinJump = Runnable {
        if (adapter.count == 0 || list.height == 0) return@Runnable
        // 回复气泡先占位、随后富文本渲染回来才长高，setSelection 类接口在长高后不再下走，
        // 所以直接按像素往下滚，滚到底为止
        var guard = 0
        while (guard++ < 40 && list.canScrollVertically(1)) {
            val before = list.firstVisiblePosition
            list.scrollListBy(list.height / 2)
            if (list.firstVisiblePosition == before && !list.canScrollVertically(1)) break
        }
        android.util.Log.i(
            "PetChat",
            "pin count=${adapter.count} h=${list.height} last=${list.lastVisiblePosition} can=${list.canScrollVertically(1)}"
        )
    }

    private fun scrollToBottom() {
        if (adapter.count == 0) return
        // 行高会在随后几秒里变几次（富文本换掉 TextView、气泡折行），
        // 所以不是贴一次就完，要让位几次，最终停在真正的底部
        list.removeCallbacks(pinJump)
        list.post(pinJump)
        for (d in longArrayOf(150, 400, 900, 1600, 2600, 4000)) list.postDelayed(pinJump, d)
    }

    /* ---------------- 表情 ---------------- */

    private fun showEmojiPicker() {
        // 键盘先收起来，否则表情面板压在键盘上、还跟着布局跳
        (getSystemService(InputMethodManager::class.java)).hideSoftInputFromWindow(input.windowToken, 0)
        // 等输入行落回底部再算位置
        input.postDelayed({ placeEmojiPicker() }, 120)
    }

    private fun placeEmojiPicker() {
        if (isFinishing || isDestroyed) return
        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_emoji_sheet)
            setPadding(dp(10), dp(10), dp(10), dp(10))
        }
        val grid = GridLayout(this).apply { columnCount = 8 }
        EMOJIS.forEach { char ->
            val cell = TextView(this).apply {
                text = char
                textSize = 22f
                gravity = Gravity.CENTER
                setPadding(dp(6), dp(8), dp(6), dp(8))
                setOnClickListener { insertEmoji(char) }
            }
            grid.addView(
                cell,
                GridLayout.LayoutParams().apply {
                    width = 0
                    columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f)
                },
            )
        }
        sheet.addView(grid)

        val cols = 8
        val cellWidth = dp(40)
        val width = minOf(cols * cellWidth + dp(20), resources.displayMetrics.widthPixels - dp(24))
        val pop = PopupWindow(sheet, width, ViewGroup.LayoutParams.WRAP_CONTENT, true)
        pop.isOutsideTouchable = true
        pop.setBackgroundDrawable(ColorDrawable(0x00000000))
        sheet.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
        )
        val loc = IntArray(2)
        emojiBtn.getLocationOnScreen(loc)
        val y = (loc[1] - sheet.measuredHeight - dp(8)).coerceAtLeast(dp(64))
        pop.showAtLocation(findViewById(R.id.historyRoot), Gravity.NO_GRAVITY, dp(12), y)
    }

    private fun insertEmoji(char: String) {
        val start = input.selectionStart.coerceAtLeast(0)
        val end = input.selectionEnd.coerceAtLeast(0)
        val from = minOf(start, end)
        val to = maxOf(start, end)
        input.text?.replace(from, to, char)
        input.setSelection(from + char.length)
    }

    /* ---------------- 发送 / 中断 ---------------- */

    private fun sendChat() {
        val text = input.text?.toString()?.trim().orEmpty()
        if (text.isBlank()) return
        if (turn != null) {
            toast("上一轮还没结束")
            return
        }
        // 「拍张照」「截个屏」是手机自己办的事，不进对话
        val snap = SnapCommand.parse(text)
        if (snap != null) {
            input.setText("")
            runSnap(snap)
            return
        }
        input.setText("")
        send(text)
    }

    private fun resendLast() {
        val text = lastSent
        if (text.isBlank() && lastAttachment.isBlank()) return
        adapter.error = ""
        adapter.errorAction = null
        if (turn != null) return
        send(text, lastAttachment, if (text.isBlank()) "图片" else text)
    }

    /**
     * 发一句出去。
     *
     * @param attachment 已经在宿主上落盘的图片路径（没发图就空着），插件把它拼在正文后面
     * @param shownAs 气泡里显示的字：光发图时正文是空的，气泡上得有个「图片」
     */
    private fun send(text: String, attachment: String = "", shownAs: String = "") {
        lastSent = text
        lastAttachment = attachment
        adapter.error = ""
        adapter.errorAction = null
        adapter.live = ""
        turnStart = System.currentTimeMillis()
        lastAttachmentTs = PetHistory.append(this, PetHistory.ROLE_ME, shownAs.ifBlank { text })
        reload()
        typing.visibility = View.VISIBLE
        runBar.visibility = View.VISIBLE
        runText.text = "处理中 0 s"
        ui.post(ticker)
        val client = PetClient { PetSettings.load(this) }
        val t = PetTurn(
            client,
            text,
            object : PetTurn.Callback {
                override fun onUser(text: String) {}
                override fun onStatus(text: String) {
                    runText.text = text
                }

                override fun onAssistant(fullText: String, isFinal: Boolean) {
                    adapter.live = fullText
                    adapter.notifyDataSetChanged()
                    scrollToBottom()
                }

                override fun onSentence(sentence: String) {
                    val cfg = PetSettings.load(this@HistoryActivity)
                    val player = tts ?: TtsPlayer(this@HistoryActivity, client, { cfg }, {}, {}).also { tts = it }
                    player.enqueue(sentence)
                }

                override fun onDone() {
                    finishTurn(null)
                }

                override fun onError(message: String) {
                    finishTurn(message)
                }
            },
            PetSettings.chatSession(this),
            onSession = { id -> onSessionResolved(id) },
            attachments = if (attachment.isBlank()) emptyList() else listOf(attachment),
        )
        turn = t
        t.start()
    }

    private fun finishTurn(error: String?) {
        ui.removeCallbacks(ticker)
        turn = null
        typing.visibility = View.GONE
        runBar.visibility = View.GONE
        val finalText = adapter.live
        adapter.live = ""
        // 连不上电脑（多半是电脑换了端口、地址失效）和「这轮没出字」是两种病，
        // 前者重发多少次都没用，得先换地址：那一行的动作就直接给扫码。
        val offline = error != null && (error.contains("连不上") || error.contains("超时") || error.contains("断开"))
        when {
            error == null && finalText.isNotBlank() -> PetHistory.append(this, PetHistory.ROLE_PET, finalText)
            // 一轮走完了却一个字都没有：不能就这么静默收工，用户只会以为 App 坏了
            error == null && !userStopped -> showRetry("没收到回复，重试", null)
            offline -> showRetry("连不上电脑，重新扫码", { startScan() })
            // 失败给一行可点的动作，不砸对话框：点了就用同一句话再发一次
            else -> showRetry("没收到回复，重试", null)
        }
        reload()
        userStopped = false
    }

    private fun showRetry(text: String, action: (() -> Unit)?) {
        adapter.error = text
        adapter.errorAction = action
    }

    private fun startScan() {
        try {
            startActivityForResult(Intent(this, ScanActivity::class.java), REQ_SCAN)
        } catch (e: Exception) {
            toast("打不开扫码页：${e.javaClass.simpleName}，可用粘贴链接")
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_PICK_IMAGE) {
            val uri = data?.data
            if (resultCode == RESULT_OK && uri != null) sendImage(uri)
            return
        }
        if (requestCode == REQ_CAMERA) {
            snapKind = ""
            val uri = snapUri
            snapUri = null
            @Suppress("DEPRECATION")
            val thumb = data?.extras?.get("data") as? Bitmap
            when {
                resultCode != RESULT_OK -> toast("没拍")
                uri != null -> sendImage(uri)
                thumb != null -> sendShot(ScreenSnap.jpeg(thumb))
                else -> toast("没拍成")
            }
            return
        }
        if (requestCode == REQ_PROJECTION) {
            snapKind = ""
            if (resultCode == RESULT_OK && data != null) {
                runBar.visibility = View.VISIBLE
                runText.text = "截屏"
                ScreenSnap.capture(this, resultCode, data) { bytes ->
                    ui.post {
                        runBar.visibility = View.GONE
                        if (isFinishing || isDestroyed) Unit
                        else if (bytes == null) toast("没截到，再试一次")
                        else sendShot(bytes)
                    }
                }
            } else {
                toast("没给截屏权限")
            }
            return
        }
        if (requestCode != REQ_SCAN) return
        if (resultCode == RESULT_OK) {
            adapter.error = ""
            adapter.errorAction = null
            reload()
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            val t = turn ?: return
            val ms = System.currentTimeMillis() - turnStart
            // 慢不等于坏：电脑上真在跑（长命令、多步任务）就该继续等。
            // 以前这里 45 s 没出字就自己收工，一轮长活干完却没人接了。
            if (ms > 210_000) {
                userStopped = false
                t.cancel()
                finishTurn(null)
                return
            }
            runText.text = if (ms > 90_000) "还在跑 ${ms / 1000} s · 可中断" else "处理中 ${ms / 1000} s"
            ui.postDelayed(this, 1000)
        }
    }

    /* ---------------- 发图片 ---------------- */

    private fun pickImage() {
        if (turn != null) {
            toast("上一轮还没结束")
            return
        }
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        try {
            startActivityForResult(Intent.createChooser(intent, "选一张图"), REQ_PICK_IMAGE)
        } catch (_: Exception) {
            toast("打不开相册")
        }
    }

    /**
     * 挑完图：先在本地缩到 1600 px、压成 JPEG 再传上去，传完的路径就是这一问的附件。
     *
     * 原图三五兆，走隧道传一遍再让电脑读一遍都是白等；模型看 1600 px 足够。
     * 输入框里有字就一起发（那句话当正文），没字就只发图。
     */
    private fun sendImage(uri: Uri) {
        runBar.visibility = View.VISIBLE
        runText.text = "传图片"
        Thread({
            val bytes = try { scaledJpeg(uri) } catch (_: Exception) { null }
            runOnUiThread {
                runBar.visibility = View.GONE
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (bytes == null) toast("这张图读不出来") else sendShot(bytes)
            }
        }, "pet-decode").apply { isDaemon = true }.start()
    }

    /**
     * 图已经在手上（刚拍的、刚截的）：先传到电脑落盘，再把路径当这一问的附件发出去。
     *
     * 电脑那边只能读它自己磁盘上的路径，所以必须先 `/api/upload`，不能直接把位图塞给对话。
     */
    private fun sendShot(bytes: ByteArray) {
        if (isFinishing || isDestroyed) return
        if (bytes.isEmpty()) {
            toast("这张图是空的")
            return
        }
        val caption = input.text?.toString()?.trim().orEmpty()
        val client = PetClient { PetSettings.load(this) }
        runBar.visibility = View.VISIBLE
        runText.text = "传图片"
        Thread({
            val up = try {
                client.uploadImage(bytes, "chat-${System.currentTimeMillis()}", "image/jpeg")
            } catch (_: Exception) {
                null
            }
            val path = up?.json?.optString("path").orEmpty()
            val err = up?.json?.optString("error").orEmpty()
            runOnUiThread {
                runBar.visibility = View.GONE
                if (isFinishing || isDestroyed) return@runOnUiThread
                when {
                    up == null -> toast("图片没传上去，网络不通")
                    path.isBlank() -> toast(err.ifBlank { "图片没传上去" })
                    else -> {
                        input.setText("")
                        send(caption, path, if (caption.isBlank()) "图片" else caption)
                    }
                }
            }
        }, "pet-upload").apply { isDaemon = true }.start()
    }

    /* ---------------- 设备指令：拍一张 / 截一张 ---------------- */

    private fun runSnap(kind: String) {
        if (turn != null) {
            toast("上一轮还没结束")
            return
        }
        if (snapKind.isNotBlank()) return
        when (kind) {
            SnapCommand.CAMERA -> startCamera()
            SnapCommand.SCREEN -> startScreen()
        }
    }

    /** 开系统相机。Android 10+ 写进系统相册，这样不需要存储权限。 */
    private fun startCamera() {
        // 清单里声明了相机权限：没授过的话，系统连相机 App 都不让拉起来
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            snapKind = ""
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_SNAP_PERM)
            return
        }
        snapKind = SnapCommand.CAMERA
        if (Build.VERSION.SDK_INT >= 29) {
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, "pet-${System.currentTimeMillis()}.jpg")
                put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Pet")
            }
            val target = runCatching {
                contentResolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            }.getOrNull()
            snapUri = target
            val intent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
            if (target != null) intent.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, target)
            if (launchCamera(intent)) return
            target?.let { runCatching { contentResolver.delete(it, null, null) } }
            snapUri = null
            snapKind = ""
            return
        }
        // Android 8/9：没有免权限的落盘位置，退回系统给的小图
        if (!launchCamera(Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE))) snapKind = ""
    }

    private fun launchCamera(intent: Intent): Boolean {
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        return try {
            startActivityForResult(intent, REQ_CAMERA)
            true
        } catch (_: Exception) {
            toast("这台手机没有相机")
            false
        }
    }

    /** 截屏：先问系统要一次授权，拿到后再截一帧。 */
    private fun startScreen() {
        snapKind = SnapCommand.SCREEN
        val manager = getSystemService(android.media.projection.MediaProjectionManager::class.java)
        if (manager == null) {
            snapKind = ""
            toast("这台手机不支持截屏")
            return
        }
        try {
            startActivityForResult(manager.createScreenCaptureIntent(), REQ_PROJECTION)
        } catch (_: Exception) {
            snapKind = ""
            toast("打不开截屏授权")
        }
    }

    /** 读图 → 摆正 → 长边缩到 1600 px 以内 → JPEG q80。 */
    private fun scaledJpeg(uri: Uri): ByteArray? {
        val bmp = if (Build.VERSION.SDK_INT >= 28) {
            val src = ImageDecoder.createSource(contentResolver, uri)
            ImageDecoder.decodeBitmap(src) { decoder, info, _ ->
                decoder.isMutableRequired = false
                val long = maxOf(info.size.width, info.size.height)
                if (long > SEND_IMAGE_MAX_PX) {
                    decoder.setTargetSampleSize(Math.max(1, Math.ceil(long.toDouble() / SEND_IMAGE_MAX_PX).toInt()))
                }
            }
        } else {
            contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
        } ?: return null
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 80, out)
        bmp.recycle()
        return out.toByteArray()
    }

    private fun stopTurn() {
        val t = turn ?: return
        userStopped = true
        t.cancel()
        finishTurn(null)
    }

    /* ---------------- 新对话 ---------------- */

    private fun newChat() {
        if (turn != null) {
            toast("上一轮还没结束")
            return
        }
        // 项目不变，命令式地开一只新会话：先按本地状态把标题上屏，不等网络
        refreshHeader()
        val client = PetClient { PetSettings.load(this) }
        Thread({
            val r = try { client.newSession(fresh = true) } catch (_: Exception) { null }
            val id = r?.json?.optString("sessionId").orEmpty()
            runOnUiThread {
                if (id.isNotBlank()) {
                    // 开成功了就把屏幕上的旧消息一并收掉，否则新对话里还挂着上一只的内容。
                    PetSettings.saveChatSession(this, id)
                    // 新会话：名字等宿主给，这里先按「新会话」上屏，别再写项目名。
                    liveSessionTitle = ""
                    refreshHeader()
                    PetHistory.clear(this)
                    liveText = ""
                    reload()
                    toast("新对话已开")
                } else {
                    toast("新对话没开成")
                }
            }
        }, "pet-newchat").apply { isDaemon = true }.start()
    }

    /* ---------------- 选择层 ---------------- */

    private fun openPicker(level: Int) {
        pickerLevel = level
        pickerSheet.visibility = View.VISIBLE
        pickerScrim.visibility = View.VISIBLE
        pickerRows.clear()
        pickerAdapter.notifyDataSetChanged()
        when (level) {
            1 -> {
                pickerBack.visibility = View.GONE
                pickerTitle.text = "项目"
                loadProjects()
            }
            else -> {
                pickerBack.visibility = View.VISIBLE
                pickerTitle.text = pickerProject.ifBlank { PetSettings.pinnedTitle(this) }.ifBlank { "会话" }
                syncPickerProject()
            }
        }
    }

    private fun closePicker() {
        pickerSheet.visibility = View.GONE
        pickerScrim.visibility = View.GONE
    }

    private fun loadProjects() {
        pickerLoading = true
        pickerRows.clear()
        pickerRows.add(PickerRow.Head("载入中"))
        pickerAdapter.notifyDataSetChanged()
        val client = PetClient { PetSettings.load(this) }
        Thread({
            val res = try { client.workspaces() } catch (_: Exception) { null }
            val out = ArrayList<Ws>()
            res?.json?.optJSONArray("workspaces")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    out.add(
                        Ws(
                            o.optString("id"),
                            o.optString("title").ifBlank { o.optString("path") },
                            o.optString("path"),
                            o.optBoolean("pinned"),
                        ),
                    )
                }
            }
            val pinnedTitle = res?.json?.optJSONObject("pinned")?.optString("title").orEmpty()
            runOnUiThread {
                pickerLoading = false
                projects = out
                if (pinnedTitle.isNotBlank()) {
                    PetSettings.savePinnedTitle(this, pinnedTitle)
                    refreshHeader()
                }
                pickerRows.clear()
                if (out.isEmpty()) {
                    pickerRows.add(PickerRow.Head("没有项目"))
                } else {
                    out.forEach { pickerRows.add(PickerRow.Proj(it)) }
                }
                pickerRows.add(PickerRow.Action("新建项目"))
                pickerAdapter.notifyDataSetChanged()
            }
        }, "pet-projects").apply { isDaemon = true }.start()
    }

    /**
     * 三条杠进来时先问宿主「现在钉在哪」，拿项目 id 去查会话。
     * 少了这一步就会拿上一个项目的 id（或空 id）去查，列出来的是别的项目。
     */
    private fun syncPickerProject() {
        val client = PetClient { PetSettings.load(this) }
        Thread({
            val res = try { client.workspaces() } catch (_: Exception) { null }
            val pinned = res?.json?.optJSONObject("pinned")
            val id = pinned?.optString("id").orEmpty()
            val title = pinned?.optString("title").orEmpty()
            runOnUiThread {
                if (!isFinishing && !isDestroyed) {
                    if (id.isNotBlank()) pickerProjectId = id
                    if (title.isNotBlank()) {
                        pickerProject = title
                        PetSettings.savePinnedTitle(this, title)
                        refreshHeader()
                    }
                    pickerTitle.text = pickerProject.ifBlank { "会话" }
                    loadSessions()
                }
            }
        }, "pet-picker-project").apply { isDaemon = true }.start()
    }

    private fun loadSessions() {
        pickerRows.clear()
        pickerRows.add(PickerRow.Head("载入中"))
        pickerAdapter.notifyDataSetChanged()
        val wsId = pickerProjectId
        val client = PetClient { PetSettings.load(this) }
        Thread({
            val res = try {
                client.get("sessions", if (wsId.isBlank()) emptyMap() else mapOf("workspaceId" to wsId))
            } catch (_: Exception) {
                null
            }
            val out = ArrayList<Sess>()
            // 宿主返回的是 sessions（旧字段 rows 兜底），按最近更新排前面
            val arr = res?.json?.optJSONArray("sessions") ?: res?.json?.optJSONArray("rows")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val id = o.optString("id")
                    if (id.isBlank()) continue
                    out.add(Sess(id, o.optString("title"), o.optLong("updatedAt")))
                }
            }
            out.sortByDescending { it.at }
            runOnUiThread {
                sessions = out
                pickerRows.clear()
                pickerRows.add(PickerRow.NewChat("新建对话"))
                if (out.isEmpty()) {
                    pickerRows.add(PickerRow.Head("还没有会话"))
                } else {
                    out.forEach { pickerRows.add(PickerRow.SessRow(it)) }
                }
                pickerAdapter.notifyDataSetChanged()
            }
        }, "pet-sessions").apply { isDaemon = true }.start()
    }

    private var pickerProjectId = ""

    private fun onPickerPick(pos: Int) {
        val row = pickerRows.getOrNull(pos) ?: return
        if (pickerLoading) return
        when (row) {
            is PickerRow.Proj -> {
                pickerProjectId = row.ws.id
                pickerProject = row.ws.title
                pickProject(row.ws)
            }
            is PickerRow.SessRow -> pickSession(row.s)
            is PickerRow.NewChat -> {
                closePicker()
                newChat()
            }
            is PickerRow.Action -> toast("新建项目在电脑上做")
            else -> {}
        }
    }

    /** 选项目 = 定好工作区，并在里面开一只新会话；操作完直接回到对话。 */
    private fun pickProject(ws: Ws) {
        closePicker()
        refreshHeader()
        PetSettings.savePinnedTitle(this, ws.title)
        refreshHeader()
        val client = PetClient { PetSettings.load(this) }
        Thread({
            var id = ""
            try {
                if (ws.id.isNotBlank()) client.switchWorkspace(ws.id)
                id = client.newSession(fresh = true).json?.optString("sessionId").orEmpty()
            } catch (_: Exception) {
            }
            runOnUiThread {
                if (id.isNotBlank()) PetSettings.saveChatSession(this, id)
                reload()
            }
        }, "pet-pick-project").apply { isDaemon = true }.start()
    }

    /** 选会话 = 把 App 的对话钉到那只上。 */
    private fun pickSession(s: Sess) {
        closePicker()
        val client = PetClient { PetSettings.load(this) }
        Thread({
            try { client.bind(s.id) } catch (_: Exception) {
            }
            runOnUiThread {
                PetSettings.saveChatSession(this, s.id)
                liveSessionTitle = s.title
                refreshHeader()
                reload()
            }
        }, "pet-pick-session").apply { isDaemon = true }.start()
    }

    /* ---------------- 按住说话 ---------------- */

    @SuppressLint("MissingPermission")
    private fun startHold() {
        if (micBusy) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 41)
            return
        }
        if (turn != null) {
            toast("上一轮还没结束")
            return
        }
        // 录的时候把唤醒引擎按住，免得它把用户这句话也当成唤醒词
        sendServiceAction(FloatingPetService.ACTION_WAKE_PAUSE)
        micBusy = true
        micBtn.alpha = 0.55f
        micBtn.setColorFilter(getColor(R.color.pet_accent))
        runBar.visibility = View.VISIBLE
        runText.text = "听着"
        val r = recorder ?: VoiceRecorder().also { recorder = it }
        r.onAutoStop = { ui.post { finishHold() } }
        // 开麦可能刚好撞上唤醒引擎松手的那一下，等它一下再开；不能一按就判「不可用」。
        startRecorder(r, 0)
    }

    private fun startRecorder(r: VoiceRecorder, attempt: Int) {
        if (!micDown && attempt > 0) {           // 手已经松了，别再跟他抢麦
            if (micBusy) finishHold()
            return
        }
        if (r.start()) return
        if (attempt < 3) {
            ui.postDelayed({ if (micBusy) startRecorder(r, attempt + 1) }, 220)
            return
        }
        micBusy = false
        micBtn.alpha = 1f
        micBtn.clearColorFilter()
        runBar.visibility = View.GONE
        sendServiceAction(FloatingPetService.ACTION_WAKE_RESUME)
        toast("麦克风不可用")
    }

    private fun finishHold() {
        if (!micBusy) return
        micBusy = false
        micBtn.alpha = 1f
        micBtn.clearColorFilter()
        val r = recorder ?: return
        val wav = try { r.stop() } catch (_: Exception) { null }
        sendServiceAction(FloatingPetService.ACTION_WAKE_RESUME)
        if (wav == null || wav.size < 1024) {
            runBar.visibility = View.GONE
            toast("没听清，再说一次")
            return
        }
        runText.text = "听着"
        val client = PetClient { PetSettings.load(this) }
        Thread({
            val text = try {
                client.asr(wav).json?.optString("text").orEmpty().trim()
            } catch (_: Exception) {
                ""
            }
            runOnUiThread {
                runBar.visibility = View.GONE
                if (text.isBlank()) {
                    // 没听清：不动输入框里已有的字，给一行能照做的短句
                    input.setText("")
                    toast("没听清，再说一次")
                    return@runOnUiThread
                }
                // 听清了直接发：按住说话本来就是要「说一句、发出去」
                input.setText(text)
                sendChat()
            }
        }, "pet-asr").apply { isDaemon = true }.start()
    }

    /* ---------------- 小工具 ---------------- */

    private fun sendServiceAction(action: String) {
        runCatching {
            startService(Intent(this, FloatingPetService::class.java).setAction(action))
        }
    }

    private fun toast(msg: String) {
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
    }

    private fun copy(raw: String) {
        try {
            getSystemService(ClipboardManager::class.java)
                .setPrimaryClip(ClipData.newPlainText("鲸灵", raw))
            toast("已复制")
        } catch (_: Exception) {
        }
    }

    private fun bubble(bg: Int, text: Int): GradientDrawable = GradientDrawable().apply {
        cornerRadius = 16f * resources.displayMetrics.density
        setColor(bg)
    }

    /** 常用表情：够用就好，不做完整表情库（一屏翻不完反而难找）。 */
    private val EMOJIS = listOf(
        "😀", "😄", "😂", "😌", "😊", "😍", "🤔", "😎",
        "😴", "😭", "😮", "🙄", "😅", "🤗", "👍", "👏",
        "🙏", "💪", "❤️", "🔥", "✨", "🎉", "🌙", "☀️",
    )

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /** 路径看着像图（认扩展名，忽略 query 片段）。 */
    private fun isImagePath(path: String): Boolean {
        val clean = path.substringBefore('?').substringBefore('#')
        return IMAGE_EXT.contains(clean.substringAfterLast('.', "").lowercase(Locale.ROOT))
    }

    /**
     * 一条消息里能显示的图：markdown 图片、`[图片] /abs/path` 回显、正文里的裸绝对路径。
     * [extra] 是本进程自己发图时记下的附件路径。
     */
    private fun imagePathsOf(raw: String, extra: List<String> = emptyList()): List<String> {
        val out = LinkedHashSet<String>()
        extra.filter { it.startsWith("/") && isImagePath(it) }.forEach { out.add(it) }
        MARKDOWN_IMG.findAll(raw).forEach { m ->
            val path = m.groupValues[1].trim().trim('<', '>')
            if (path.startsWith("/") && isImagePath(path)) out.add(path)
        }
        ABS_IMG.findAll(raw).forEach { m ->
            val path = m.value.trimEnd('.', ',', ')', ']', '。', '，')
            if (isImagePath(path)) out.add(path)
        }
        return out.toList()
    }

    /**
     * 回复里只有图（markdown 图 / 裸路径 / `[图片]` 回显），没有别的字。
     * 这种行的正文由缩略图代替，气泡里不该再画一截空文本（渲染器会剩一个 `!`）。
     */
    private fun onlyImages(raw: String): Boolean {
        if (imagePathsOf(raw).isEmpty()) return false
        var rest = raw
        MARKDOWN_IMG.findAll(raw).forEach { rest = rest.replace(it.value, "") }
        ABS_IMG.findAll(raw).forEach { rest = rest.replace(it.value, "") }
        rest = rest.replace("[图片]", "")
        return rest.replace(Regex("[\\s\\p{P}]+"), "").isBlank()
    }

    /** 本轮的流式文本（还没落库）。 */
    private var liveText: String
        get() = adapter.live
        set(v) { adapter.live = v }

    /* ---------------- 列表适配器 ---------------- */

    private inner class ChatAdapter : BaseAdapter() {
        var rows: List<ChatRow> = emptyList()
        var live: String = ""
        var error: String = ""
        var errorAction: (() -> Unit)? = null
        var onRetry: () -> Unit = {}

        override fun getCount(): Int = rows.size + (if (error.isNotBlank()) 1 else 0)
        override fun getItem(position: Int): Any? = rows.getOrNull(position)
        override fun getItemId(position: Int): Long = position.toLong()

        /** 点了一行：只有发送失败那行能点（重发），其余不动。 */
        fun tap(position: Int) {
            if (position >= rows.size) (errorAction ?: onRetry)()
        }

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            if (position >= rows.size) {
                // 发送失败的那一行：可点，点一下重发
                val v = convertView ?: layoutInflater.inflate(R.layout.item_history, parent, false)
                val bubble = v.findViewById<FrameLayout>(R.id.itemBubble)
                val text = v.findViewById<TextView>(R.id.itemText)
                text.text = error
                text.setTextColor(getColor(R.color.pet_accent))
                (v as android.widget.LinearLayout).gravity = Gravity.START
                bubble.background = null
                bubble.setPadding(0, 0, 0, 0)
                plainRow(v)
                text.setOnClickListener { (errorAction ?: onRetry)() }
                return v
            }
            val row = rows[position]
            return when (row) {
                is ChatRow.Me -> bindText(convertView, parent, row.text, mine = true, extraImages = meImages(position))
                is ChatRow.Pet -> if (row.rich) bindRich(convertView, parent, row.text) else bindText(convertView, parent, row.text, mine = false)
                is ChatRow.Live -> bindText(convertView, parent, row.text, mine = false)
                is ChatRow.Note -> bindNote(convertView, parent, row.text)
            }
        }

        /** 居中的灰字提示行：换过会话才出现，几行而已，不复用行视图免得串字号。 */
        private fun bindNote(convertView: View?, parent: ViewGroup, raw: String): View {
            val v = convertView ?: layoutInflater.inflate(R.layout.item_history, parent, false)
            plainRow(v)
            val bubble = v.findViewById<FrameLayout>(R.id.itemBubble)
            val text = v.findViewById<TextView>(R.id.itemText)
            if (bubble.childCount > 1) bubble.removeViews(1, bubble.childCount - 1)
            (v as android.widget.LinearLayout).gravity = Gravity.CENTER
            bubble.background = null
            bubble.setPadding(0, dp(3), 0, dp(3))
            text.visibility = View.VISIBLE
            text.text = raw
            text.textSize = 12.5f
            text.setTextColor(getColor(R.color.pet_hint))
            text.maxWidth = resources.displayMetrics.widthPixels - dp(48)
            text.setOnLongClickListener(null)
            return v
        }

        /** 普通气泡不吃点击：复用行上可能还挂着别的监听。 */
        private fun plainRow(v: View) {
            v.setOnClickListener(null)
            v.isClickable = false
            v.findViewById<TextView>(R.id.itemText)?.setOnClickListener(null)
            hideThumbs(v)
        }

        private fun hideThumbs(v: View) {
            val holder = v.findViewById<LinearLayout>(R.id.itemThumbs) ?: return
            holder.removeAllViews()
            holder.visibility = View.GONE
        }

        /** 自己刚发的图：只挂在带图那条气泡上；重启后没记住路径就不显示。 */
        private fun meImages(position: Int): List<String> {
            if (lastAttachment.isBlank()) return emptyList()
            val row = rows.getOrNull(position) as? ChatRow.Me ?: return emptyList()
            if (row.ts != lastAttachmentTs) return emptyList()
            return listOf(lastAttachment)
        }

        private fun bindText(
            convertView: View?,
            parent: ViewGroup,
            raw: String,
            mine: Boolean,
            extraImages: List<String> = emptyList(),
        ): View {
            val v = convertView ?: layoutInflater.inflate(R.layout.item_history, parent, false)
            plainRow(v)
            val bubble = v.findViewById<FrameLayout>(R.id.itemBubble)
            val text = v.findViewById<TextView>(R.id.itemText)
            text.visibility = View.VISIBLE
            // 行视图会复用：字体大小也必须显式回到正文尺寸，否则接着上一条提示行就是小字
            text.textSize = 15f
            text.text = if (mine) raw else MdPlain.of(raw)
            // 复刻桌面端：我说的靠右、短气泡；鱼回的不带气泡、占满整行
            (v as android.widget.LinearLayout).gravity = if (mine) Gravity.END else Gravity.START
            val full = resources.displayMetrics.widthPixels - dp(24)
            text.maxWidth = if (mine) (full * 0.78f).toInt() else full
            if (mine) {
                text.setTextColor(getColor(R.color.pet_bg))
                bubble.background = bubble(getColor(R.color.pet_accent), 0)
                bubble.setPadding(dp(12), dp(9), dp(12), dp(9))
            } else {
                text.setTextColor(getColor(R.color.pet_text))
                bubble.background = null
                bubble.setPadding(0, 0, 0, 0)
            }
            // 列表复用：先把可能挂在上面的渲染器摘掉，别让 WebView 跟着旧行跑
            if (bubble.childCount > 1) bubble.removeViews(1, bubble.childCount - 1)
            val thumbs = bindThumbs(v, raw, extraImages)
            // 只有图的行：正文已经是缩略图了，别在气泡里剩一截空文本
            if (!mine && thumbs > 0 && onlyImages(raw)) text.visibility = View.GONE
            text.setOnLongClickListener { copy(raw); true }
            return v
        }

        /**
         * 气泡下面放缩略图（宽 ≤ 200dp，高按比例、最高 260dp，超高就裁）。
         * 行会复用：回调里用 tag + 是否还在容器里校验，旧请求回来不会贴到新行上。
         *
         * @return 放了几张
         */
        private fun bindThumbs(v: View, raw: String, extra: List<String>): Int {
            val holder = v.findViewById<LinearLayout>(R.id.itemThumbs) ?: return 0
            holder.removeAllViews()
            val paths = imagePathsOf(raw, extra).take(4)
            if (paths.isEmpty()) {
                holder.visibility = View.GONE
                return 0
            }
            holder.visibility = View.VISIBLE
            val density = resources.displayMetrics.density
            val width = minOf((200 * density).toInt(), (resources.displayMetrics.widthPixels - dp(24)) * 3 / 4)
            val height = (width * 0.72f).toInt()
            // 解码要够清楚：最长的边按「宽度 或 最大高度」取大值
            val decodePx = maxOf(width, dp(260))
            paths.forEachIndexed { i, path ->
                val iv = android.widget.ImageView(this@HistoryActivity)
                iv.layoutParams = LinearLayout.LayoutParams(width, height).apply { topMargin = dp(6) }
                iv.scaleType = android.widget.ImageView.ScaleType.CENTER_CROP
                iv.clipToOutline = true
                iv.background = GradientDrawable().apply {
                    // 圆角跟 itemBubble 一致（16dp），不另造一套视觉
                    cornerRadius = 16f * resources.displayMetrics.density
                    setColor(getColor(R.color.pet_hint_bg))
                }
                iv.tag = path
                holder.addView(iv)
                HostImage.peek(path, decodePx)?.let { bmp -> showThumb(iv, bmp, width) }
                HostImage.load(this@HistoryActivity, path, decodePx) { bmp ->
                    if (iv.tag != path || holder.indexOfChild(iv) < 0) return@load
                    if (bmp != null) showThumb(iv, bmp, width)
                }
                iv.setOnClickListener { ImageActivity.open(this@HistoryActivity, paths, i) }
            }
            return paths.size
        }

        /** 固定宽度、按图比例给高度，超高裁掉中间一段（点开看整张）。 */
        private fun showThumb(iv: android.widget.ImageView, bmp: Bitmap, maxWidth: Int) {
            val w = maxWidth.coerceAtMost(bmp.width.coerceAtLeast(dp(48)))
            val h = (w.toFloat() * bmp.height / bmp.width).toInt()
                .coerceIn(dp(72), dp(260))
            iv.layoutParams = LinearLayout.LayoutParams(w, h).apply { topMargin = dp(6) }
            iv.setImageBitmap(bmp)
        }

        private fun bindRich(convertView: View?, parent: ViewGroup, raw: String): View {
            val v = bindText(convertView, parent, raw, mine = false)
            // 只有图的行：缩略图已经表达了，再渲染这段 markdown 只剩一个 `!`
            if (onlyImages(raw)) return v
            val bubble = v.findViewById<FrameLayout>(R.id.itemBubble)
            val text = v.findViewById<TextView>(R.id.itemText)
            val renderer = render ?: return v
            val html = renderer.cached(raw)
            if (html != null) {
                text.visibility = View.GONE
                renderer.attach(bubble, raw, html)
                return v
            }
            // 宿主还没回渲染结果：先纯文本兜底，回来再换
            renderer.request(raw) {
                runOnUiThread {
                    if (positionOf(raw) >= 0) notifyDataSetChanged()
                }
            }
            return v
        }

        /** 只给「渲染完成通知」用：找到仍然显示这条文本的行，没人看就不刷。 */
        fun positionOf(raw: String): Int = rows.indexOfFirst { it is ChatRow.Pet && it.rich && it.text == raw }
    }

    /* ---------------- 选择层适配器 ---------------- */

    private inner class PickerAdapter : BaseAdapter() {
        override fun getCount(): Int = pickerRows.size
        override fun getItem(position: Int): Any? = pickerRows.getOrNull(position)
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val v = convertView ?: layoutInflater.inflate(R.layout.item_history, parent, false)
            v.findViewById<View>(R.id.itemThumbs)?.visibility = View.GONE
            val bubble = v.findViewById<FrameLayout>(R.id.itemBubble)
            val text = v.findViewById<TextView>(R.id.itemText)
            bubble.background = null
            bubble.setPadding(dp(16), dp(14), dp(16), dp(14))
            val row = pickerRows[position]
            when (row) {
                is PickerRow.Head -> {
                    text.text = row.text
                    text.setTextColor(getColor(R.color.pet_hint))
                    text.textSize = 13f
                }
                is PickerRow.Proj -> {
                    text.text = row.ws.title
                    text.setTextColor(getColor(R.color.pet_text))
                    text.textSize = 15f
                }
                is PickerRow.SessRow -> {
                    val when_ = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(row.s.at))
                    text.text = "${row.s.title.ifBlank { "未命名" }}   $when_"
                    text.setTextColor(getColor(R.color.pet_text))
                    text.textSize = 15f
                }
                is PickerRow.NewChat -> {
                    text.text = row.text
                    text.setTextColor(getColor(R.color.pet_accent))
                    text.textSize = 15f
                }
                is PickerRow.Action -> {
                    text.text = row.text
                    text.setTextColor(getColor(R.color.pet_accent))
                    text.textSize = 15f
                }
            }
            return v
        }
    }
}
