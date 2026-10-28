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
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Calendar
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
        /** 从相册挑一段视频。 */
        const val REQ_PICK_VIDEO = 48

        /** 发出去之前先把长边缩到这个像素以内，再压成 JPEG。 */
        const val SEND_IMAGE_MAX_PX = 1600
        /** 一次最多挑几张图：宿主那头也是 6。 */
        const val SEND_IMAGE_MAX = 6
        /** 一段视频的上限：宿主那头也是 200 MB。 */
        const val SEND_VIDEO_MAX_BYTES = 200L * 1024 * 1024
        /** 历史一页多少条：翻上去再取下一页。 */
        const val HISTORY_PAGE = 30
        /** 一次向宿主要多少条：一页多一点，翻两下刚好一小段。 */
        const val HOST_PAGE = 40
        /** 页面开着时多久核一次「这只对话还在不在、叫什么」（不跟电脑切）。 */
        const val HOST_WATCH_MS = 20_000L

        /** 聊天里能看的图：跟宿主 /api/file 的白名单一致。 */
        val IMAGE_EXT = setOf("jpg", "jpeg", "png", "webp", "gif")
        /** markdown 图片 `![alt](/abs/path)`。 */
        val MARKDOWN_IMG = Regex("!\\[[^]]*]\\(\\s*<?([^)\\s>]+)")
        /** 正文里的裸绝对路径（含 `[图片] /abs/path` 这种宿主回显）。 */
        val ABS_IMG = Regex("/[\\w\\u4e00-\\u9fa5 .\\-+/@]+?\\.(?:jpe?g|png|webp|gif)", RegexOption.IGNORE_CASE)
        val MARKDOWN_IMG_FULL = Regex("!\\[[^]]*]\\(\\s*<?[^)\\s>]+>?\\s*\\)")
    }


    private lateinit var list: ListView
    private lateinit var empty: TextView
    private lateinit var typing: TextView
    private lateinit var toBottom: TextView
    private lateinit var runBar: View
    private lateinit var runText: TextView
    private lateinit var runStop: TextView
    private lateinit var runSteer: TextView
    private lateinit var input: EditText
    private lateinit var sendBtn: android.widget.ImageView
    private lateinit var emojiBtn: android.widget.ImageView
    private lateinit var micBtn: android.widget.ImageView
    private lateinit var projectBtn: TextView
    private lateinit var sessionsBtn: android.widget.ImageView
    private lateinit var head: View
    private lateinit var sessionLabel: TextView
    private lateinit var peekLabel: TextView
    private lateinit var attachBtn: android.widget.ImageView

    // 目标和待输入队列：和桌面端一样看得见，也能直接暂停 / 继续
    private lateinit var goalBar: View
    private lateinit var goalState: TextView
    private lateinit var goalText: TextView
    private lateinit var goalAction: TextView
    private lateinit var goalQueue: TextView
    private lateinit var queueBar: LinearLayout
    /** 队列里那几句：id 是宿主给的，撤掉/调顺序都按它认。 */
    private data class Queued(val id: String, val text: String)
    @Volatile private var goalId = ""
    @Volatile private var goalRevision = 0
    @Volatile private var goalPhase = ""
    @Volatile private var goalPending = false

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

    /**
     * 轮的代号。切会话/收尾都会把它 +1：旧轮晚到的 onDone/onError 回来时对不上号就直接丢，
     * 不会把新会话的界面当成旧轮的收尾来刷（否则切过去就被一句「没收到回复」盖住）。
     */
    private var turnSeq = 0
    private var turnToken = 0
    /** 用户自己点了「停止」：这一轮不该再弹「没收到回复」。 */
    private var userStopped = false
    /** 这一轮在宿主上排队（电脑上还在跑）：状态行别被计时器改成「处理中」抢掉。 */
    private var queuedNote = false

    /**
     * 排队不是「这一轮已经跑了多久」：电脑那轮可能还要跑十分钟。
     * 所以排队期间不计时（计时器不超时），等真的轮到我们了再把起点挪到现在，
     * 否则手机上会出现「刚排上队就被判超时收工」。
     */
    private fun leaveQueue() {
        if (!queuedNote) return
        queuedNote = false
        turnStart = System.currentTimeMillis()
    }
    private var lastSent = ""
    /** 上一次带出去的图片路径：重发要跟着一起重发。 */
    private var lastAttachment = ""
    /** 带着这张图的那条气泡是谁（时间戳）：只给那一条挂缩略图，后面的文字行别跟着沾。 */
    private var lastAttachmentTs = 0L
    /** 选好还没发的图（最多 6 张）：先在托盘里摆着，能删单张再发。 */
    private val pending = ArrayList<PetHistory.Att>()
    /** 历史一屏摆多少条。 */
    private var historyLimit = HISTORY_PAGE
    /** 宿主那边还有更早的没有取回来（历史懒加载的第二段来源）。 */
    private var hostMore = false
    private var hostPaging = false
    private var hostSid = ""
    private var lastHostPageAt = 0L
    /** 列表自己的滚动状态：只有手指拖/甩到顶才自动补页。 */
    private var scrollState = android.widget.AbsListView.OnScrollListener.SCROLL_STATE_IDLE
    /** 加页时别贴底：翻上去看的是旧的，回到底部会把人踢回去。 */
    private var keepScroll = false
    /** 用户是不是还贴着底：自己往上翻的时候别被新回复拽回去。 */
    private var nearBottom = true
    /** 翻上去看历史时的锚点：新回复进来后按它把画面放回原处。 */
    private var anchorPos = -1
    private var anchorTop = 0
    private var trayScroll: View? = null
    private var tray: LinearLayout? = null
    private var videoLayer: View? = null
    private var videoView: android.widget.VideoView? = null
    /** 屏幕上这只对话的名字（宿主说叫什么就叫什么，查不到就空着）。 */
    private var liveSessionTitle = ""
    /** 电脑上这只正在跑回合（`/api/state.turns`）；手机自己发起的回合另有进度条。 */
    @Volatile private var hostBusy = false
    /** 这一轮是手机自己发的：进度条已经在说话，标题行不再重复。 */
    @Volatile private var localBusy = false
    private var peekTitle = ""
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
    private data class Sess(
        val id: String,
        val title: String,
        val at: Long,
        val running: Boolean = false,
        val proj: String = "",
    )

    private sealed class ChatRow {
        data class Me(val text: String, val ts: Long = 0L, val media: List<PetHistory.Att> = emptyList()) : ChatRow()
        data class Pet(val text: String, val rich: Boolean) : ChatRow()
        data class Live(val text: String) : ChatRow()
        /** 居中灰字提示（换过会话之类），不算谁说的话。 */
        data class Note(val text: String) : ChatRow()
        /** 顶上那行「加载更早」：还有多少条压在下面。 */
        data class More(val older: Int) : ChatRow()
    }

    private sealed class PickerRow {
        data class Head(val text: String) : PickerRow()
        data class Proj(val ws: Ws) : PickerRow()
        data class SessRow(val s: Sess) : PickerRow()
        /** 「新建项目」这类没有现成数据的行。 */
        data class Action(val text: String) : PickerRow()
        /** 「新建对话」：就在当前项目里开一只新的。 */
        data class NewChat(val text: String) : PickerRow()

        /** 看这只会话在宿主那边的原文（工具调用、长回复都在里面）。 */
        data class Detail(val text: String) : PickerRow()
    }

    /** 待发队列把某句补发成功后，这儿把会话再拉一遍，用户能直接看到回复。 */
    private val outboxDelivered: (String) -> Unit = { runCatching { reload() } }
    // 补发成功把回答捞回来时也要刷一次：否则页面上「已补发」有了、正文要等下次进页面
    private val outboxReply: (String) -> Unit = { runCatching { reload() } }
    // 补发被宿主拒了不会自己再发：留一行看得懂的话，能重试的给一次重试
    private val outboxFailed: (String, String, Boolean) -> Unit = { text, reason, again ->
        runCatching {
            adapter.error = reason
            adapter.errorAction = if (again) ({ send(text, shownAs = text) }) else null
            reload()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_history)
        Outbox.addDeliveredListener(outboxDelivered)
        Outbox.addReplyListener(outboxReply)
        Outbox.addFailedListener(outboxFailed)

        list = findViewById(R.id.historyList)
        // 状态栏内边距自己加：fitsSystemWindows 会和键盘 resize 抢高度，底栏被挤掉过
        findViewById<View>(R.id.historyRoot).setOnApplyWindowInsetsListener { v, insets ->
            v.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
            insets
        }
        empty = findViewById(R.id.historyEmpty)
        typing = findViewById(R.id.chatTyping)
        toBottom = findViewById(R.id.chatToBottom)
        runBar = findViewById(R.id.chatRun)
        runText = findViewById(R.id.chatRunText)
        runStop = findViewById(R.id.chatStop)
        runSteer = findViewById(R.id.chatSteer)
        input = findViewById(R.id.chatInput)
        sendBtn = findViewById(R.id.chatSend)
        emojiBtn = findViewById(R.id.chatEmoji)
        micBtn = findViewById(R.id.chatMic)
        projectBtn = findViewById(R.id.historyProject)
        sessionsBtn = findViewById(R.id.historySessions)
        head = findViewById(R.id.historyHead)
        sessionLabel = findViewById(R.id.historySession)
        peekLabel = findViewById(R.id.historyPeek)
        attachBtn = findViewById(R.id.chatAttach)

        goalBar = findViewById(R.id.historyGoalBar)
        goalState = findViewById(R.id.goalState)
        goalText = findViewById(R.id.goalText)
        goalAction = findViewById(R.id.goalAction)
        goalQueue = findViewById(R.id.goalQueue)
        queueBar = findViewById(R.id.chatQueue)
        goalAction.setOnClickListener { toggleGoal() }
        // 删除跟桌面端那个 🗑 一样：长按整行才出现，避免误触
        goalBar.setOnLongClickListener {
            confirmClearGoal()
            true
        }

        pickerScrim = findViewById(R.id.pickerScrim)
        pickerSheet = findViewById(R.id.pickerSheet)
        pickerBack = findViewById(R.id.pickerBack)
        pickerTitle = findViewById(R.id.pickerTitle)
        pickerList = findViewById(R.id.pickerList)
        pickerClose = findViewById(R.id.pickerClose)

        list.adapter = adapter
        // 新回复、历史翻页都会重排列表，每次数据变化都重新贴底
        adapter.registerDataSetObserver(object : android.database.DataSetObserver() {
            override fun onChanged() {
                if (keepScroll) return
                if (nearBottom) {
                    scrollToBottom()
                } else if (anchorPos >= 0) {
                    // 用户在看上面的历史：新回复只进列表，不动他的位置
                    list.setSelectionFromTop(anchorPos, anchorTop)
                    toBottom.visibility = View.VISIBLE
                }
            }
        })
        // 条目点击交给列表自己派发：挂在子视图上的监听在复用行里靠不住
        list.setOnItemClickListener { _, _, pos, _ -> adapter.tap(pos) }
        list.setOnItemLongClickListener { _, _, pos, _ ->
            onRowLongPress(pos)
            true
        }
        // 贴着底就跟着新回复走；翻上去看历史时就停住，底部给一个「回到底部」
        list.setOnScrollListener(object : android.widget.AbsListView.OnScrollListener {
            override fun onScrollStateChanged(v: android.widget.AbsListView?, state: Int) {
                scrollState = state
            }
            override fun onScroll(
                v: android.widget.AbsListView?,
                first: Int,
                visible: Int,
                total: Int,
            ) {
                val atBottom = first + visible >= total - 1 || total == 0
                if (atBottom) {
                    anchorPos = -1
                } else if (nearBottom) {
                    // 刚从底部翻上来：记住这一刻的位置，后面新回复不许把它顶走
                    anchorPos = first
                    anchorTop = list.getChildAt(0)?.top ?: 0
                }
                if (atBottom != nearBottom) {
                    nearBottom = atBottom
                    toBottom.visibility = if (atBottom) View.GONE else View.VISIBLE
                }
                // 手指拖到顶就自己取更早的一页（程序和布局引起的 0 位不算，不然一进会话就全load完）。
                val dragging = scrollState == android.widget.AbsListView.OnScrollListener.SCROLL_STATE_TOUCH_SCROLL ||
                    scrollState == android.widget.AbsListView.OnScrollListener.SCROLL_STATE_FLING
                val soon = System.currentTimeMillis() - lastHostPageAt < 600L
                if (dragging && !soon && first == 0 && total > 0 && !hostPaging && hostMore && adapter.rows.size > 0) {
                    loadHostPage(older = true)
                }
            }
        })
        toBottom.setOnClickListener { scrollToBottom(force = true) }
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
        attachBtn.setOnClickListener { showAttachMenu() }
        runStop.setOnClickListener { stopTurn() }
        // 引导：这一轮还没说完时补一句。框里已经有字就直接插进去，没有就把光标放回输入框。
        runSteer.setOnClickListener {
            val say = input.text?.toString()?.trim().orEmpty()
            if (say.isNotEmpty()) {
                steer(say)
            } else {
                input.requestFocus()
                input.setHint("说一句，插进这一轮")
            }
        }
        input.setOnEditorActionListener { _, actionId, ev ->
            if (actionId == EditorInfo.IME_ACTION_SEND || (ev?.keyCode == KeyEvent.KEYCODE_ENTER && ev.action == KeyEvent.ACTION_DOWN)) {
                sendChat()
                true
            } else {
                false
            }
        }

        // 多行输入下回车默认是换行，这里把裸回车收回成「发送」；Shift+回车留给他们换行
        input.setOnKeyListener { _, code, e ->
            if (code == KeyEvent.KEYCODE_ENTER && e.action == KeyEvent.ACTION_DOWN && !e.isShiftPressed) {
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
        adapter.onMore = { loadEarlier() }
        trayScroll = findViewById(R.id.chatTrayScroll)
        tray = findViewById(R.id.chatTray)
        render = ChatRender(this, maxViews = 8) { PetSettings.load(this) }

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

    /** 外面「分享 → 小精灵」进来的图或视频：直接走发送，不弹相册。 */
    private fun takeSharedImage(intent: Intent?) {
        val safe = intent ?: return
        android.util.Log.i("PetPick", "share entry act=${safe.action}")
        val many = safe.action == Intent.ACTION_SEND_MULTIPLE
        if (!many && safe.action != Intent.ACTION_SEND) return
        @Suppress("DEPRECATION")
        val uris: List<Uri> = if (many) {
            safe.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty().filterNotNull()
        } else {
            listOfNotNull(safe.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        }
        android.util.Log.i("PetPick", "share act=${safe.action} n=${uris.size} first=${uris.firstOrNull()}")
        if (uris.isEmpty()) return
        // 同一个 Intent 只接一次，转屏/回前台别重发
        safe.removeExtra(Intent.EXTRA_STREAM)
        val clip = uris.firstOrNull { isVideoUri(it) }
        val imgs = uris.filterNot { isVideoUri(it) }
        window.decorView.post {
            if (clip != null) pickVideoResult(clip)
            if (imgs.isNotEmpty()) addImages(imgs)
        }
    }

    private fun isVideoUri(uri: Uri): Boolean =
        runCatching { contentResolver.getType(uri)?.startsWith("video/") == true }.getOrDefault(false)

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
        // 进来先只拉最新一页（宿主是真相源，手机只是缓存）；翻上去再要更早的
        if (hostSid != PetSettings.chatSession(this) || PetHistory.count(this) == 0) {
            hostMore = true
            loadHostPage(older = false)
        }
        // 进来先补一次「只有我问、没有回答」的缺口：上一轮可能因断网断在一半
        repairMissingReply()
        // 页面开着的时候核一下这只还在不在、名字对不对（20 秒一次；有回合在跑就 3 秒）
        ui.removeCallbacks(hostWatch)
        ui.postDelayed(hostWatch, if (hostBusy || localBusy) 3_000L else HOST_WATCH_MS)
    }

    @Volatile private var repairing = false

    /**
     * 本地最后一条是我、而且已经过了还在跑的窗口，就去电脑上把这句的回答捞回来。
     * 只补最后这一处缺口：整段历史来回对账既慢又容易插重。
     */
    private fun repairMissingReply() {
        val items = PetHistory.recent(this, 4)
        val last = items.lastOrNull() ?: return
        if (!last.isMe) return
        // 3 秒是给「刚按发送、回合才起步」留的窗；不到就晚点再看，别把这次机会直接丢掉
        if (System.currentTimeMillis() - last.ts < 3_000L) {
            ui.removeCallbacks(repairLater)
            ui.postDelayed(repairLater, 3_500L)
            return
        }
        if (repairing) return
        repairing = true
        val text = last.text
        val sid = PetSettings.chatSession(this)
        Thread({
            try {
                if (sid.isBlank()) return@Thread
                val client = PetClient { PetSettings.load(this) }
                val want = text.trim()
                var reply = ""
                // 那句是先发出去的，回答可能还在跑：等一会儿再看，最多 3 次
                for (tryNo in 1..3) {
                    val res = runCatching { client.session(sid, 12) }.getOrNull()
                    if (res != null && res.ok) {
                        val arr = res.json?.optJSONArray("messages")
                        if (arr != null) {
                            var seenMe = false
                            for (i in 0 until arr.length()) {
                                val o = arr.optJSONObject(i) ?: continue
                                val role = o.optString("role")
                                val t = o.optString("text").trim()
                                if (role == "user") {
                                    if (!seenMe && t.isNotEmpty() && (t == want || t.contains(want.take(24)))) seenMe = true
                                    continue
                                }
                                if (seenMe && role == "assistant" && t.isNotBlank()) {
                                    reply = t
                                    break
                                }
                            }
                        }
                    }
                    if (reply.isNotBlank()) break
                    if (tryNo < 3) runCatching { Thread.sleep(3_000L) }
                }
                if (reply.isBlank()) {
                    // 电脑那边这一轮没留下回答：多半是中途断了。别装没事，也别反复自动重发——
                    // 在末尾留一行状态，给一句能点的重发。
                    val idle = System.currentTimeMillis() - last.ts > 60_000L
                    if (idle && turn == null) {
                        ui.post(Runnable {
                            if (isFinishing || isDestroyed || turn != null) return@Runnable
                            runCatching {
                                adapter.error = "上次回复中断"
                                adapter.errorAction = { send(text, shownAs = text) }
                                reload()
                            }
                        })
                    }
                    return@Thread
                }
                val exists = PetHistory.all(this).any { it.role == PetHistory.ROLE_PET && it.text == reply }
                if (exists) return@Thread
                PetHistory.append(this, PetHistory.ROLE_PET, reply)
                NetLog.record("history", 200, 0, "补回缺的回答 ${reply.length} 字")
                runCatching { android.util.Log.i("Repair", "补回缺的回答 ${reply.length} 字") }
                ui.post { runCatching { reload() } }
            } catch (_: Exception) {
            } finally {
                repairing = false
            }
        }, "pet-repair").start()
    }

    private val repairLater = Runnable { runCatching { repairMissingReply() } }

    private val hostWatch = object : Runnable {
        override fun run() {
            syncSession()
            // 一分钟对齐一次宿主最新一页：电脑上刚说的话也能在这只对话里出现
            if (System.currentTimeMillis() - lastHostPageAt > 60_000L) loadHostPage(older = false)
            ui.postDelayed(this, if (hostBusy || localBusy) 3_000L else HOST_WATCH_MS)
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
        Outbox.removeDeliveredListener(outboxDelivered)
        Outbox.removeReplyListener(outboxReply)
        Outbox.removeFailedListener(outboxFailed)
        closeVideo()
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
        // 面板关掉「语音对话」时这一页就别留着话筒：留着点了也没用
        micBtn.visibility = if (PetSettings.feature(this, "voice")) View.VISIBLE else View.GONE
        val title = PetSettings.pinnedTitle(this)
        projectBtn.text = title.ifBlank { "项目" }
        // 第二行是「这一问落在哪只会话」。还没拿到会话名（刚开的新会话、名字还没生成）
        // 就直说「新会话」：拿项目名顶上会让人以为自己在旧对话里。
        val base = liveSessionTitle.ifBlank {
            if (PetSettings.chatSession(this).isNotBlank()) "新会话" else ""
        }
        // 电脑那边这一轮还没跑完（比如上一条是从别处发的、或本地回合被系统掐了）：
        // 名字行末尾挂一句状态，不用盯着屏幕猜它是不是还在想。
        val line = when {
            base.isBlank() -> ""
            hostBusy && !localBusy -> "$base · 正在回复"
            else -> base
        }
        sessionLabel.text = line
        sessionLabel.visibility = if (line.isBlank()) View.GONE else View.VISIBLE
        // 「在旁听：别的那只」只在 5 分钟内有材料时出现，过期自己收起来。
        peekLabel.text = if (peekTitle.isBlank()) "" else "在旁听：$peekTitle"
        peekLabel.visibility = if (peekTitle.isBlank()) View.GONE else View.VISIBLE
    }

    /**
     * 目标行：有目标才出现，没目标就整块收起（不占地方、不说空话）。
     * 右边那个动作跟桌面端一致——在跑的给「暂停」，停下的给「继续」。
     */
    private fun renderGoal(detail: JSONObject) {
        val goal = detail.optJSONObject("goal")
        if (goal == null || goal.optString("id").isBlank()) {
            goalPending = false
            goalId = ""
            goalPhase = ""
            goalBar.visibility = View.GONE
            return
        }
        goalPending = false
        val id = goal.optString("id")
        val phase = goal.optString("status").ifBlank { "active" }
        goalId = id
        goalPhase = phase
        goalRevision = goal.optInt("revision", 0)
        val objective = goal.optString("objective").trim()
        goalText.text = objective.ifBlank { "目标" }
        goalState.text = when (phase) {
            "active" -> "目标进行中"
            "paused" -> "目标已暂停"
            "blocked" -> "目标受阻"
            "complete" -> "目标已完成"
            else -> "目标"
        }
        val rounds = goal.optInt("roundsStarted", 0)
        val cap = goal.optInt("maxGoalRounds", 0)
        if (phase == "active" && rounds > 0 && cap > 0) {
            goalAction.text = "第 $rounds/$cap 轮 · 暂停"
        } else {
            goalAction.text = if (phase == "complete") "" else if (phase == "active") "暂停" else "继续"
        }
        goalAction.visibility = if (goalAction.text.isBlank()) View.GONE else View.VISIBLE
        val inbox = detail.optJSONArray("inbox")
        val queued = (0 until (inbox?.length() ?: 0)).mapNotNull { i ->
            val row = inbox?.optJSONObject(i) ?: return@mapNotNull null
            val text = row.optString("text").trim().replace('\n', ' ')
            val id = row.optString("id").trim()
            if (text.isBlank() || id.isBlank()) null else Queued(id, text)
        }
        renderQueue(queued)
        goalQueue.visibility = View.GONE
        goalBar.visibility = View.VISIBLE
    }

    /** 队列：一句一行，右侧点掉；长按调顺序或撤掉。 */
    private fun renderQueue(items: List<Queued>) {
        queueBar.removeAllViews()
        if (items.isEmpty()) {
            queueBar.visibility = View.GONE
            return
        }
        queueBar.visibility = View.VISIBLE
        for (item in items) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            row.addView(TextView(this).apply {
                text = "待输入 · ${item.text}"
                setTextColor(getColor(R.color.pet_hint))
                textSize = 12f
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(0, dp(4), 0, dp(4))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            row.addView(TextView(this).apply {
                text = "撤掉"
                setTextColor(getColor(R.color.pet_accent))
                textSize = 12f
                setPadding(dp(10), dp(4), dp(4), dp(4))
                setOnClickListener { queueAct("remove", item.id) }
            })
            row.setOnLongClickListener { showQueueMenu(item); true }
            queueBar.addView(row)
        }
    }

    private fun showQueueMenu(item: Queued) {
        android.app.AlertDialog.Builder(this)
            .setItems(arrayOf("上移", "下移", "撤掉")) { _, which ->
                queueAct(arrayOf("up", "down", "remove")[which], item.id)
            }
            .show()
    }

    /** 队列改动走宿主：桌面端看到的是同一份，手机上点完立刻回读一遍。 */
    private fun queueAct(action: String, id: String) {
        val sid = PetSettings.chatSession(this)
        if (sid.isBlank()) return
        Thread({
            val res = try {
                PetClient { PetSettings.load(this) }.inboxAction(sid, action, id)
            } catch (_: Exception) { null }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                val body = res?.json
                if (body?.optBoolean("ok") != true && action != "remove") {
                    toast(body?.optString("error").orEmpty().ifBlank { "队列没改成" })
                }
                syncSession()
            }
        }, "pet-queue").apply { isDaemon = true }.start()
    }

    /** 点目标行右侧的按钮：在跑就暂停，停下了就继续。执行完立刻跟宿主对一次。 */
    private fun toggleGoal() {
        val id = goalId
        if (id.isBlank() || goalPending) return
        val action = if (goalPhase == "active") "pause" else "resume"
        if (goalPhase == "complete") return
        goalPending = true
        goalAction.text = if (action == "pause") "暂停中…" else "继续中…"
        val sid = PetSettings.chatSession(this)
        val rev = goalRevision
        Thread({
            val res = try {
                PetClient { PetSettings.load(this) }.goalAction(sid, action, id, rev)
            } catch (_: Exception) { null }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                val body = res?.json
                if (body?.optBoolean("ok") != true) {
                    // 版本对不上（桌面刚改过）也算正常：把最新状态拉回来，按钮就能再点
                    toast(body?.optString("error").orEmpty().ifBlank { "没改成，稍后再试" })
                    goalPending = false
                    syncSession()
                    return@runOnUiThread
                }
                val view = body.optJSONObject("goal")
                if (view != null) {
                    goalPhase = view.optString("status").ifBlank { goalPhase }
                    goalRevision = view.optInt("revision", goalRevision)
                }
                goalPending = false
                syncSession()
            }
        }, "pet-goal-action").apply { isDaemon = true }.start()
    }

    /** 长按目标行：确认后清掉这个目标（宿主留墓碑，历史里还能查到）。 */
    private fun confirmClearGoal() {
        val id = goalId
        if (id.isBlank() || goalPending) return
        android.app.AlertDialog.Builder(this)
            .setMessage("删除这个目标？")
            .setNegativeButton("取消", null)
            .setPositiveButton("删除") { _, _ -> clearGoal(id) }
            .show()
    }

    private fun clearGoal(id: String) {
        goalPending = true
        goalAction.text = "删除中…"
        val sid = PetSettings.chatSession(this)
        val rev = goalRevision
        Thread({
            val res = try {
                PetClient { PetSettings.load(this) }.goalAction(sid, "clear", id, rev)
            } catch (_: Exception) { null }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                val body = res?.json
                if (body?.optBoolean("ok") != true) {
                    toast(body?.optString("error").orEmpty().ifBlank { "没删成，稍后再试" })
                    goalPending = false
                    syncSession()
                    return@runOnUiThread
                }
                goalPending = false
                goalBar.visibility = View.GONE
                goalId = ""
                goalPhase = ""
                syncSession()
            }
        }, "pet-goal-clear").apply { isDaemon = true }.start()
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
            // 目标与待输入队列挂在会话详情上：一次请求就能把两块都拿到
            val sid = PetSettings.chatSession(this)
            val detail = if (sid.isNotBlank()) {
                try { client.session(sid, 1) } catch (_: Exception) { null }
            } else null
            runOnUiThread {
                syncing = false
                if (!isFinishing && !isDestroyed) {
                    res?.json?.let { adoptHostState(it) }
                    detail?.json?.let { renderGoal(it) }
                    after?.invoke()
                }
            }
        }, "pet-session-sync").apply { isDaemon = true }.start()
    }

    /** 宿主现状 → 标题 + 本地指针。只在真的变了的时候动。 */
    private fun adoptHostState(state: JSONObject) {
        // 桌面面板的开关是唯一来源：读到就落一份，下次冷启动也照这个来
        PetSettings.saveFeatures(this, state.optJSONObject("features"))
        val target = state.optString("dispatchTarget").orEmpty()
        // turns 的键是裸 uuid（宿主两种写法都存，投影时归一过）
        val turns = state.optJSONObject("turns")
        val myKey = PetSettings.chatSession(this).ifBlank { target }.removePrefix("session-")
        val busy = turns != null && myKey.isNotBlank() && turns.has(myKey)
        if (busy != hostBusy) {
            hostBusy = busy
            refreshHeader()
            ui.removeCallbacks(hostWatch)
            ui.postDelayed(hostWatch, if (busy) 3_000L else HOST_WATCH_MS)
        }
        val current = state.optJSONObject("current")
        val hostId = target.ifBlank { current?.optString("id").orEmpty() }
        val mine = PetSettings.chatSession(this)
        val shown = mine.ifBlank { hostId }
        val pk = state.optJSONObject("peek")
        val nextPeek = niceTitle(pk?.optString("title").orEmpty())
        if (nextPeek != peekTitle) {
            peekTitle = nextPeek
            refreshHeader()
        }
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
        var cut = raw
        for (marker in arrayOf("【旁听·不属于这条对话】", "【旁听材料：")) {
            val index = cut.indexOf(marker)
            if (index >= 0) cut = cut.substring(0, index)
        }
        val t = cut.replace(Regex("[#*>`]+"), " ").replace(Regex("\\s+"), " ").trim()
        // 宿主把「运行时上下文」这类注入内容当成第一句时，会话名就是一段系统提示词——不上屏。
        if (t.isBlank() || isInjectedText(t)) return ""
        return if (t.length <= 22) t else t.take(21).trimEnd() + "…"
    }

    /** 宿主塞进来的上下文：对看对话的人没有意义，标题和气泡里都不出现。 */
    private fun isInjectedText(text: String): Boolean {
        val body = text.trim()
        if (body.isEmpty()) return true
        return body.startsWith("Time sampled while preparing turn") ||
            body.startsWith("Current runtime context.") ||
            body.startsWith("<system-reminder>") ||
            body.startsWith("<available_skills>") ||
            body.startsWith("<environment_context>")
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
        // 一屏只摆最近一页，翻上去再按页取：不从第一次就把几百条全塞进列表
        val items = PetHistory.recent(this, historyLimit)
        val older = PetHistory.count(this) - items.size
        val rows = ArrayList<ChatRow>(items.size + 2)
        if (older > 0 || hostMore) rows.add(ChatRow.More(older))
        items.forEachIndexed { i, item ->
            if (item.isNote) {
                rows.add(ChatRow.Note(item.text))
            } else if (item.isMe) {
                rows.add(ChatRow.Me(item.text, item.ts, item.atts))
            } else {
                // 只有最后一条助手消息挂富文本渲染器：历史长列表里塞多个 WebView 会卡
                rows.add(ChatRow.Pet(item.text, rich = true))
            }
        }
        val live = liveText
        if (live.isNotBlank()) rows.add(ChatRow.Live(live))
        adapter.rows = rows
        adapter.notifyDataSetChanged()
        empty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        if (!keepScroll) scrollToBottom()
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

    /**
     * 网上翻一页：先记住屏幕上第一行是哪条、偏了多少，取完下一页再贴回同一处，
     * 不然加完行列表会自己跳。
     */
    private fun loadEarlier() {
        android.util.Log.i("PetChat", "more rows=${adapter.rows.size} count=${PetHistory.count(this)} limit=$historyLimit hostMore=$hostMore")
        if (hostPaging) return
        // 缓存里还有没摆出来的行就先摆本地；本地到底了才去宿主取更早的一页。
        if (historyLimit >= PetHistory.count(this) && hostMore) {
            loadHostPage(older = true)
            return
        }
        val first = list.firstVisiblePosition
        val top = list.getChildAt(0)?.top ?: 0
        val before = adapter.rows.size
        keepScroll = true
        historyLimit += HISTORY_PAGE
        reload()
        keepScroll = false
        val added = (adapter.rows.size - before).coerceAtLeast(0)
        ui.post { list.setSelectionFromTop((first + added).coerceAtLeast(0), top) }
    }

    /**
     * 取一页宿主转录并进本地记录。
     *
     * 进会话先只取最新一页（[older]=false），用户往上翻到本地缓存尽头再按
     * `before=<最早 seq>` 取更早的——跟桌面端一样，不带整段历史。
     */
    private fun loadHostPage(older: Boolean) {
        if (hostPaging) return
        if (older && !hostMore) return
        val sid = PetSettings.chatSession(this)
        if (sid.isBlank()) return
        hostPaging = true
        android.util.Log.i("PetChat", "hostpage start older=$older sid=${sid.takeLast(8)}")
        val first = list.firstVisiblePosition
        val top = list.getChildAt(0)?.top ?: 0
        val beforeRows = adapter.rows.size
        Thread({
            val client = PetClient { PetSettings.load(this) }
            var added = 0
            try {
                val before = if (older) PetHistory.oldestSeq(this) else 0L
                if (older && before <= 0L) {
                    hostMore = false
                    return@Thread
                }
                val res = client.session(sid, HOST_PAGE, if (before > 0L) before else null)
                val json = res.json
                android.util.Log.i("PetChat", "hostpage res ok=${res.ok} code=${res.code} before=$before json=${json != null}")
                if (res.ok && json != null) {
                    val arr = json.optJSONArray("messages") ?: JSONArray()
                    val page = ArrayList<PetHistory.Item>(arr.length())
                    for (i in 0 until arr.length()) {
                        val o = arr.optJSONObject(i) ?: continue
                        val text = o.optString("text").trim()
                        if (text.isEmpty()) continue
                        // 运行时注入的上下文（<goal_round> 之类）不是人说的话，对话里不摆
                        if (text.startsWith("<")) continue
                        val role = when (o.optString("role")) {
                            "user" -> PetHistory.ROLE_ME
                            "assistant" -> PetHistory.ROLE_PET
                            else -> continue
                        }
                        page.add(
                            PetHistory.Item(
                                role, text, o.optLong("time", 0L), sid, emptyList(), o.optLong("seq", 0L)
                            )
                        )
                    }
                    added = PetHistory.mergeHost(this, sid, page, older)
                    hostSid = sid
                    hostMore = json.optBoolean("hasMore", false)
                    lastHostPageAt = System.currentTimeMillis()
                    android.util.Log.i("PetChat", "hostpage merged page=${page.size} added=$added hasMore=$hostMore")
                }
            } catch (e: Exception) {
                android.util.Log.i("PetChat", "hostpage fail ${e.javaClass.simpleName}: ${e.message}")
            } finally {
                hostPaging = false
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    if (!older && adapter.rows.size == 0) historyLimit = HISTORY_PAGE
                    if (older && beforeRows >= historyLimit) historyLimit += HISTORY_PAGE
                    keepScroll = true
                    reload()
                    keepScroll = false
                    if (older) {
                        ui.post { list.setSelectionFromTop((first + added).coerceAtLeast(0), top) }
                    }
                }
            }
        }, "pet-host-page").apply { isDaemon = true }.start()
    }

    private fun scrollToBottom(force: Boolean = false) {
        if (adapter.count == 0) return
        // 用户翻到上面看历史时，新来的回复不该把他拽回底部（桌面端也是这个手感）
        if (!force && !nearBottom) {
            toBottom.visibility = View.VISIBLE
            return
        }
        nearBottom = true
        toBottom.visibility = View.GONE
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
        if (pending.isNotEmpty()) {
            if (turn != null) {
                toast("上一轮还没结束")
                return
            }
            sendPending(text)
            return
        }
        if (text.isBlank()) return
        // 正在回复时发的这句不是「等下一轮」：交给宿主当引导（steer），
        // 跟桌面端一样插进这一轮，不打断正在流的回复。
        if (turn != null) {
            steer(text)
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

    /**
     * 这一轮还在跑时补一句：走宿主的派发口插进当前回合（桌面端叫引导），
     * 本地先落一条带「排队中」尾巴的气泡，宿主真收了就等转录把它认回来。
     */
    /** 上一次引导用的 (requestId, 原文)：重试沿用同一个，避免宿主那边落成两条。 */
    private var steerRetry: Pair<String, String>? = null

    private fun steer(text: String, append: Boolean = true, ridOverride: String? = null) {
        val sid = PetSettings.chatSession(this)
        if (sid.isBlank()) {
            toast("还没连上")
            return
        }
        input.setText("")
        runText.text = "引导中"
        if (append) PetHistory.append(this, PetHistory.ROLE_ME, text)
        reload()
        scrollToBottom(force = true)
        // 重试要沿用同一个 requestId：宿主按它去重，所以「其实已经到了、只是回包丢了」不会变成两条
        val rid = ridOverride ?: java.util.UUID.randomUUID().toString()
        steerRetry = rid to text
        Thread({
            val res = try {
                PetClient { PetSettings.load(this) }.dispatch(text, sid, rid, steer = true)
            } catch (_: Exception) { null }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (res?.ok != true) {
                    // 没送到的这句留在列表里，给一行能点的重试；不弹框、不吞话
                    queuedNote = false
                    adapter.error = "这句没送到"
                    adapter.errorAction = { steerAgain(text) }
                    reload()
                    return@runOnUiThread
                }
                // 宿主把它插进了正在跑的这一轮：这一轮照常接下去，别按「排队」算时间
                steerRetry = null
                val steered = res.json?.optBoolean("steered") == true
                if (!steered) queuedNote = true
                runText.text = if (steered) "引导中" else "排队中"
                ui.removeCallbacks(hostWatch)
                ui.postDelayed(hostWatch, 600L)
            }
        }, "pet-steer").apply { isDaemon = true }.start()
    }

    /** 引导那句没送到：点错误行用同一句再派一次。 */
    private fun steerAgain(text: String) {
        adapter.error = ""
        adapter.errorAction = null
        reload()
        val same = steerRetry?.takeIf { it.second == text }?.first
        steer(text, append = false, ridOverride = same)
    }

    /**
     * 长按一条消息：复制、或者把这条再说一遍。
     *
     * 助手那条没有原文，就取它上面最近的一句自己说的话重发——跟桌面端「重试」是一个意思。
     */
    private fun onRowLongPress(pos: Int) {
        val row = adapter.rows.getOrNull(pos) ?: return
        val text = when (row) {
            is ChatRow.Me -> row.text
            is ChatRow.Pet -> row.text
            is ChatRow.Live -> row.text
            else -> return
        }
        if (text.isBlank()) return
        val again = if (row is ChatRow.Me) row.text else userTextBefore(pos)
        val labels = if (again.isBlank()) arrayOf("复制") else arrayOf("复制", "重发")
        android.app.AlertDialog.Builder(this)
            .setItems(labels) { _, which ->
                if (which == 0) {
                    getSystemService(ClipboardManager::class.java)
                        .setPrimaryClip(ClipData.newPlainText("鲸灵", text))
                    toast("已复制")
                } else if (turn != null) {
                    toast("这一轮还没结束")
                } else {
                    send(again, shownAs = again)
                }
            }
            .show()
    }

    /** 往上找最近一句自己说的话（附件一起带上，重发才不会丢图）。 */
    private fun userTextBefore(pos: Int): String {
        for (i in pos - 1 downTo 0) {
            val r = adapter.rows.getOrNull(i)
            if (r is ChatRow.Me && r.text.isNotBlank()) return r.text
        }
        return ""
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
    private fun send(
        text: String,
        attachment: String = "",
        shownAs: String = "",
        atts: List<PetHistory.Att> = emptyList(),
    ) {
        // 附件走一条道：老的单图参数也折成媒体列表，历史里才记得住、重进会话还在
        val media = if (atts.isNotEmpty()) {
            atts
        } else if (attachment.isNotBlank()) {
            listOf(PetHistory.Att(attachment, "", PetHistory.Att.KIND_IMAGE))
        } else {
            emptyList()
        }
        lastSent = text
        lastAttachment = attachment.ifBlank { media.firstOrNull()?.host.orEmpty() }
        adapter.error = ""
        adapter.errorAction = null
        adapter.live = ""
        turnStart = System.currentTimeMillis()
        // 这句已经进历史了，宿主到底收没收到还不知道：先落盘，进程被杀也能接着发
        val rid = java.util.UUID.randomUUID().toString()
        PendingSend.begin(this, rid, text, PetSettings.chatSession(this),
            media.map { it.host }.filter { it.isNotBlank() })
        localBusy = true
        ui.removeCallbacks(hostWatch)
        ui.postDelayed(hostWatch, 3_000L)
        // 每次发都换一个代号：切会话时也换，旧轮的回调就认不出自己了
        turnToken = ++turnSeq
        val token = turnToken
        queuedNote = false
        lastAttachmentTs = PetHistory.append(this, PetHistory.ROLE_ME, shownAs.ifBlank { text }, media)
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
                    if (token != turnToken) return
                    // queued 是宿主说「排着队」，跟「思考中」不是一回事：计时器别去改它
                    if (text == PET_QUEUED_TEXT) {
                        queuedNote = true
                    } else {
                        leaveQueue()
                    }
                    runText.text = text
                }

                override fun onAssistant(fullText: String, isFinal: Boolean) {
                    if (token != turnToken) return
                    leaveQueue()
                    adapter.live = fullText
                    adapter.notifyDataSetChanged()
                    scrollToBottom()
                    if (isFinal) {
                        PendingSend.clear(this@HistoryActivity, rid)
                        FloatingPetService.sayToBubble(fullText)
                    }
                }

                override fun onSentence(sentence: String) {
                    if (token != turnToken) return
                    // 面板关了语音：只出字不出声
                    if (!PetSettings.feature(this@HistoryActivity, "voice")) {
                        NetLog.record("TTS", 0, 0, "面板关了语音，这句不出声")
                        return
                    }
                    NetLog.record("TTS", 0, 0, "再排一句「${sentence.take(14)}」")
                    val cfg = PetSettings.load(this@HistoryActivity)
                    val player = tts ?: TtsPlayer(this@HistoryActivity, client, { cfg }, {}, {}).also { tts = it }
                    player.enqueue(sentence)
                }

                override fun onDone() {
                    if (token != turnToken) return
                    if (turn?.isDelivered() == true) PendingSend.clear(this@HistoryActivity, rid)
                    finishTurn(null)
                }

                override fun onError(message: String) {
                    if (token != turnToken) return
                    // 宿主明确拒收：这句不会再补发，落盘凭据清掉，别让它下次启动又排队一轮
                    if (turn?.isPermanent() == true) PendingSend.clear(this@HistoryActivity, rid)
                    finishTurn(message)
                }
            },
            PetSettings.chatSession(this),
            onSession = { id -> onSessionResolved(id) },
            attachments = media.map { it.host }.filter { it.isNotBlank() },
            requestIdOverride = rid,
            appCtx = this,
        )
        turn = t
        t.start()
    }

    private fun finishTurn(error: String?) {
        ui.removeCallbacks(ticker)
        localBusy = false
        sendBtn.contentDescription = "发送"
        input.setHint("发消息")
        // 先留住这一轮：终局要按「宿主到底收没收到」决定补发，turn 清早了就没处问了
        val ended = turn
        turn = null
        // 这轮到此为止：代号换掉，后续迟到的帧/回调一律不认识
        turnToken = ++turnSeq
        queuedNote = false
        typing.visibility = View.GONE
        runBar.visibility = View.GONE
        val finalText = adapter.live
        adapter.live = ""
        // 连不上电脑（多半是电脑换了端口、地址失效）和「这轮没出字」是两种病，
        // 前者重发多少次都没用，得先换地址：那一行的动作就直接给扫码。
        val offline = error != null && (error.contains("连不上") || error.contains("超时") || error.contains("断开"))
        // 已落进待发队列：这句没丢，别给「重试」按钮（再点一次就是第二轮），只告诉用户它会自己发
        val queued = error != null && error.contains("已排队")
        when {
            queued -> showRetry("已排队，联网后自动发出", null)
            // 拒收类（会话不归手机管、配对失效）重发无用：直接说，不给会失败的重试
            error != null && (error.contains("不能从手机发") || error.contains("没认出")) ->
                showRetry(error, null)
            error == null && finalText.isNotBlank() -> PetHistory.append(this, PetHistory.ROLE_PET, finalText)
            // 一轮走完了却一个字都没有：不能就这么静默收工，用户只会以为 App 坏了
            // 断网/开流失败走完一轮、宿主其实一个字都没收到：直接落盘补发，别再让人手动重试
            !userStopped && error?.contains("404") != true && error?.contains("会话已失效") != true &&
                ended != null && ended.requeueIfLost() -> showRetry("已排队，联网后自动发出", null)
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
            val us = pickedUris(data)
            android.util.Log.i("PetPick", "img res=$resultCode n=${us.size} clip=${data?.clipData?.itemCount} uri=${us.firstOrNull()}")
            if (resultCode == RESULT_OK) addImages(us)
            return
        }
        if (requestCode == REQ_PICK_VIDEO) {
            val uri = data?.data
            android.util.Log.i("PetPick", "vid res=$resultCode uri=$uri clip=${data?.clipData?.itemCount}")
            if (resultCode == RESULT_OK && uri != null) pickVideoResult(uri)
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
                uri != null -> addImages(listOf(uri))
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
            // 还排在电脑那轮后面：不算超时，等轮到我们
            if (queuedNote) {
                ui.postDelayed(this, 1000)
                return
            }
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
            // 正在回复时按发送不是「再排一轮」，是插一句引导：按钮说法跟着变
            sendBtn.contentDescription = "发送引导"
            ui.postDelayed(this, 1000)
        }
    }

    /* ---------------- 发图 / 发视频 ---------------- */

    /** 加号：先问发图还是发视频。 */
    private fun showAttachMenu() {
        if (turn != null) {
            toast("上一轮还没结束")
            return
        }
        android.app.AlertDialog.Builder(this)
            .setItems(arrayOf("图片", "视频")) { _, which ->
                if (which == 0) pickImage() else pickVideo()
            }
            .show()
    }

    private fun pickImage() {
        if (turn != null) {
            toast("上一轮还没结束")
            return
        }
        if (pending.size >= SEND_IMAGE_MAX) {
            toast("一次最多 6 张")
            return
        }
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
            addCategory(Intent.CATEGORY_OPENABLE)
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try {
            startActivityForResult(Intent.createChooser(intent, "选图（最多 6 张）"), REQ_PICK_IMAGE)
        } catch (_: Exception) {
            toast("打不开相册")
        }
    }

    private fun pickVideo() {
        if (turn != null) {
            toast("上一轮还没结束")
            return
        }
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "video/*"
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        try {
            startActivityForResult(Intent.createChooser(intent, "选一段视频"), REQ_PICK_VIDEO)
        } catch (_: Exception) {
            toast("打不开相册")
        }
    }

    /** 相册回来的一批 Uri：多选在 clipData 里，单选在 data 里。 */
    private fun pickedUris(data: Intent?): List<Uri> {
        if (data == null) return emptyList()
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) {
            return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
        }
        return listOfNotNull(data.data)
    }

    /**
     * 挑完图：先在本地缩到 [SEND_IMAGE_MAX_PX]、压成 JPEG，并落到本机一份
     * （重进会话还能看，不用为了显图再走一趟网络）。
     */
    private fun addImages(uris: List<Uri>) {
        if (uris.isEmpty()) return
        val room = SEND_IMAGE_MAX - pending.size
        if (room <= 0) {
            toast("一次最多 6 张")
            return
        }
        if (uris.size > room) toast("一次最多 6 张")
        val take = uris.take(room)
        android.util.Log.i("PetPick", "add n=${take.size} room=$room")
        runBar.visibility = View.VISIBLE
        runText.text = "读图"
        Thread({
            val made = ArrayList<PetHistory.Att>()
            take.forEachIndexed { i, u ->
                val bytes = try { scaledJpeg(u) } catch (e: Exception) {
                    android.util.Log.i("PetPick", "decode fail $u ${e.javaClass.simpleName}:${e.message}")
                    null
                } ?: return@forEachIndexed
                val dir = mediaDir("images")
                val f = java.io.File(dir, "img-${System.currentTimeMillis()}-$i.jpg")
                val w = runCatching { f.writeBytes(bytes) }
                android.util.Log.i("PetPick", "i=$i bytes=${bytes.size} dir=$dir ok=${w.isSuccess} err=${w.exceptionOrNull()} out=${f.absolutePath}")
                if (w.isSuccess) {
                    made.add(PetHistory.Att("", f.absolutePath, PetHistory.Att.KIND_IMAGE))
                }
            }
            runOnUiThread {
                runBar.visibility = View.GONE
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (made.isEmpty()) {
                    toast("这张图读不出来")
                    return@runOnUiThread
                }
                pending.addAll(made)
                renderTray()
            }
        }, "pet-decode").apply { isDaemon = true }.start()
    }

    /** 待发托盘：一张一个缩略图，右上角 × 去掉，不用重选。 */
    private fun renderTray() {
        val row = tray ?: return
        val scroll = trayScroll ?: return
        row.removeAllViews()
        if (pending.isEmpty()) {
            scroll.visibility = View.GONE
            return
        }
        scroll.visibility = View.VISIBLE
        pending.forEachIndexed { i, att ->
            val side = dp(56)
            val cell = FrameLayout(this)
            cell.layoutParams = LinearLayout.LayoutParams(side, side).apply { marginEnd = dp(8) }
            val iv = android.widget.ImageView(this)
            iv.layoutParams = FrameLayout.LayoutParams(side, side)
            iv.scaleType = android.widget.ImageView.ScaleType.CENTER_CROP
            iv.clipToOutline = true
            iv.background = GradientDrawable().apply {
                cornerRadius = 12f * resources.displayMetrics.density
                setColor(getColor(R.color.pet_hint_bg))
            }
            iv.tag = att.shown
            HostImage.peek(att.shown, side)?.let { iv.setImageBitmap(it) }
            HostImage.load(this, att.shown, side) { bmp ->
                if (bmp != null && iv.tag == att.shown) iv.setImageBitmap(bmp)
            }
            cell.addView(iv)
            val x = TextView(this)
            x.text = "×"
            x.textSize = 12f
            x.setTextColor(getColor(R.color.pet_bg))
            x.gravity = Gravity.CENTER
            x.background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0x99000000.toInt())
            }
            val box = dp(18)
            val lp = FrameLayout.LayoutParams(box, box)
            lp.gravity = Gravity.END or Gravity.TOP
            lp.topMargin = dp(2)
            lp.marginEnd = dp(2)
            cell.addView(x, lp)
            x.setOnClickListener {
                if (i < pending.size) {
                    pending.removeAt(i)
                    renderTray()
                }
            }
            row.addView(cell)
        }
    }

    /** 把托盘里的图一起发出去：先一张张传，全上去再合成一条消息进历史。 */
    private fun sendPending(text: String) {
        val shots = ArrayList(pending)
        if (shots.isEmpty()) return
        pending.clear()
        renderTray()
        input.setText("")
        runBar.visibility = View.VISIBLE
        runText.text = "传图 0/${shots.size}"
        Thread({
            val client = PetClient { PetSettings.load(this) }
            val done = ArrayList<PetHistory.Att>()
            var err = ""
            var failedAt = -1
            for ((i, a) in shots.withIndex()) {
                if (err.isNotBlank()) break
                var path = ""
                try {
                    val up = client.uploadMedia(
                        java.io.File(a.local),
                        "chat-${System.currentTimeMillis()}-$i.jpg",
                        "image/jpeg",
                    ) { pct ->
                        runOnUiThread {
                            if (runBar.visibility == View.VISIBLE) runText.text = "传图 ${i + 1}/${shots.size} $pct%"
                        }
                    }
                    path = up.json?.optString("path").orEmpty()
                    if (path.isBlank()) err = up.json?.optString("error").orEmpty().ifBlank { "图片没传上去" }
                } catch (_: Exception) {
                    err = "图片没传上去，网络不通"
                }
                if (path.isNotBlank()) {
                    done.add(PetHistory.Att(path, a.local, PetHistory.Att.KIND_IMAGE))
                } else {
                    failedAt = i
                }
            }
            runOnUiThread {
                runBar.visibility = View.GONE
                if (isFinishing || isDestroyed) return@runOnUiThread
                when {
                    // 一张都没上去：图放回托盘，重试不用再选一遍
                    done.isEmpty() -> {
                        pending.addAll(shots)
                        renderTray()
                        toast(err.ifBlank { "图片没传上去" })
                    }
                    // 上去了一部分：剩下的放回托盘，先把这半条发出去
                    failedAt >= 0 -> {
                        pending.addAll(shots.drop(failedAt))
                        renderTray()
                        toast("有些图没传上去")
                        send(text, atts = done, shownAs = captionOf(text, done))
                    }
                    else -> send(text, atts = done, shownAs = captionOf(text, done))
                }
            }
        }, "pet-upload").apply { isDaemon = true }.start()
    }

    private fun captionOf(text: String, media: List<PetHistory.Att>): String =
        text.ifBlank { if (media.size > 1) "${media.size}张图" else "图片" }

    /** 手上已经有 JPEG 字节（刚拍的、刚截的）：落本机一份，再走同一条发送。 */
    private fun sendShot(bytes: ByteArray) {
        if (isFinishing || isDestroyed) return
        if (bytes.isEmpty()) {
            toast("这张图是空的")
            return
        }
        val caption = input.text?.toString()?.trim().orEmpty()
        Thread({
            val f = java.io.File(mediaDir("images"), "shot-${System.currentTimeMillis()}.jpg")
            val ok = runCatching { f.writeBytes(bytes) }.isSuccess
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (!ok) {
                    toast("这张图存不下来")
                    return@runOnUiThread
                }
                pending.add(PetHistory.Att("", f.absolutePath, PetHistory.Att.KIND_IMAGE))
                sendPending(caption)
            }
        }, "pet-decode").apply { isDaemon = true }.start()
    }

    /** 挑完视频：先看大小，再落到本机一份（重进会话还能播），最后才传。 */
    private fun pickVideoResult(uri: Uri) {
        if (querySize(uri) > SEND_VIDEO_MAX_BYTES) {
            toast("视频太大（上限 200 MB）")
            return
        }
        runBar.visibility = View.VISIBLE
        runText.text = "读视频"
        Thread({
            val local = copyVideoLocal(uri)
            runOnUiThread {
                runBar.visibility = View.GONE
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (local == null) {
                    toast("读不到这段视频")
                    return@runOnUiThread
                }
                uploadVideo(PetHistory.Att("", local.absolutePath, PetHistory.Att.KIND_VIDEO))
            }
        }, "pet-video").apply { isDaemon = true }.start()
    }

    /** 视频边读边落到 files/videos：超了就删掉当没选过，别把手机塞满。 */
    private fun copyVideoLocal(uri: Uri): java.io.File? {
        val f = java.io.File(mediaDir("videos"), "v-${System.currentTimeMillis()}.mp4")
        var read = 0L
        return try {
            contentResolver.openInputStream(uri).use { input ->
                if (input == null) return null
                f.outputStream().use { out ->
                    val buf = ByteArray(256 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        read += n
                        if (read > SEND_VIDEO_MAX_BYTES) {
                            out.close()
                            f.delete()
                            toast("视频太大（上限 200 MB）")
                            return null
                        }
                        out.write(buf, 0, n)
                    }
                }
            }
            if (read <= 0) {
                f.delete()
                null
            } else {
                f
            }
        } catch (e: Throwable) {
            android.util.Log.i("PetPick", "vidcopy fail ${e.javaClass.simpleName}:${e.message}")
            f.delete()
            null
        }
    }

    /** 相册给的视频大小：拿不到就当 0（拷贝时还有一道上限）。 */
    private fun querySize(uri: Uri): Long {
        try {
            contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                if (afd.length > 0) return afd.length
            }
        } catch (_: Throwable) {
        }
        return try {
            contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else 0L
            } ?: 0L
        } catch (_: Throwable) {
            0L
        }
    }

    private fun mediaDir(kind: String): java.io.File {
        val dir = java.io.File(getExternalFilesDir(null) ?: filesDir, kind)
        if (!dir.isDirectory) dir.mkdirs()
        return dir
    }

    /** 传视频：进度摆在跑马灯那一行，失败留着本机副本，点重试就再传一次。 */
    private fun uploadVideo(att: PetHistory.Att) {
        if (turn != null) {
            toast("上一轮还没结束")
            return
        }
        val caption = input.text?.toString()?.trim().orEmpty()
        adapter.error = ""
        adapter.errorAction = null
        runBar.visibility = View.VISIBLE
        runText.text = "传视频 0%"
        Thread({
            val client = PetClient { PetSettings.load(this) }
            var path = ""
            var err = ""
            try {
                val up = client.uploadMedia(
                    java.io.File(att.local),
                    "chat-${System.currentTimeMillis()}.mp4",
                    "video/mp4",
                ) { pct ->
                    runOnUiThread {
                        if (runBar.visibility == View.VISIBLE) runText.text = "传视频 $pct%"
                    }
                }
                path = up.json?.optString("path").orEmpty()
                if (path.isBlank()) {
                    err = when (up.code) {
                        413 -> "视频太大（上限 200 MB）"
                        else -> up.json?.optString("error").orEmpty().ifBlank { "视频没传上去" }
                    }
                }
            } catch (_: Exception) {
                err = "视频没传上去，网络不通"
            }
            runOnUiThread {
                runBar.visibility = View.GONE
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (path.isNotBlank()) {
                    input.setText("")
                    send(
                        caption,
                        atts = listOf(PetHistory.Att(path, att.local, PetHistory.Att.KIND_VIDEO)),
                        shownAs = caption.ifBlank { "视频" },
                    )
                } else {
                    toast(err.ifBlank { "视频没传上去" })
                    showRetry("视频没传上去，点这里重试", { uploadVideo(att) })
                    reload()
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
        historyLimit = HISTORY_PAGE
        pending.clear()
        renderTray()
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
        sizePicker()
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

    /**
     * 浮层高度按行数算：ListView 不认 maxHeight，不自己算就会整屏铺满。
     * 最高占屏幕 62%，剩下的让列表自己滚。
     */
    private fun sizePicker() {
        val rowPx = dp(56)
        val headPx = dp(52)
        var h = 0
        for (row in pickerRows) h += if (row is PickerRow.Head) headPx else rowPx
        h += dp(2) // 最后一条的收尾线
        val cap = (resources.displayMetrics.heightPixels * 0.62f).toInt()
        val listH = h.coerceIn(rowPx, cap)
        val lp = pickerList.layoutParams
        if (lp != null && lp.height != listH) {
            lp.height = listH
            pickerList.layoutParams = lp
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
                sizePicker()
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

    /**
     * 列当前项目里的会话。
     * 宿主没钉项目时（刚建过项目就会出现），拿当前这只会话所属的项目当项目，
     * 否则一进来是所有项目的会话混在一起。
     */
    private fun loadSessions() {
        pickerRows.clear()
        pickerRows.add(PickerRow.Head("载入中"))
        pickerAdapter.notifyDataSetChanged()
        val client = PetClient { PetSettings.load(this) }
        val cur = PetSettings.chatSession(this)
        Thread({
            val res = try {
                client.get("sessions", mapOf("limit" to "100"))
            } catch (_: Exception) {
                null
            }
            val all = ArrayList<Sess>()
            // 宿主返回的是 sessions（旧字段 rows 兜底）
            val arr = res?.json?.optJSONArray("sessions") ?: res?.json?.optJSONArray("rows")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val id = o.optString("id")
                    if (id.isBlank()) continue
                    all.add(
                        Sess(
                            id = id,
                            title = niceTitle(o.optString("title")).ifBlank { "未命名对话" },
                            at = o.optLong("updatedAt"),
                            running = o.optBoolean("running"),
                            proj = o.optString("projectId"),
                        ),
                    )
                }
            }
            all.sortByDescending { it.at }
            // 项目优先级：钉住的 > 当前会话所属的 > 列表里钉过的 > 全部（都不认识时才放宽）
            var wsId = pickerProjectId
            if (wsId.isBlank()) wsId = all.firstOrNull { it.id == cur }?.proj.orEmpty()
            if (wsId.isBlank()) wsId = projects.firstOrNull { it.pinned }?.id.orEmpty()
            val out = if (wsId.isBlank()) all else all.filter { it.proj == wsId }
            val wsTitle = projects.firstOrNull { it.id == wsId }?.title.orEmpty()
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (wsId.isNotBlank()) pickerProjectId = wsId
                if (wsTitle.isNotBlank()) pickerProject = wsTitle
                sessions = out
                // 顶上那行写「这只对话在哪个项目」：不能拿旧的钉住名字凑，
                // 否则项目换了名（或人把会话挪了项目）顶上还是旧项目，看着像是在串项目。
                val curWs = all.firstOrNull { it.id == cur }?.proj.orEmpty()
                val curTitle = projects.firstOrNull { it.id == curWs }?.title.orEmpty()
                    .ifBlank { if (curWs.isNotBlank() && curWs == wsId) wsTitle else "" }
                if (curWs.isNotBlank() && curTitle.isNotBlank() &&
                    curTitle != PetSettings.pinnedTitle(this)
                ) {
                    PetSettings.savePinnedTitle(this, curTitle)
                    refreshHeader()
                }
                pickerTitle.text = pickerProject.ifBlank { PetSettings.pinnedTitle(this) }.ifBlank { "会话" }
                pickerRows.clear()
                pickerRows.add(PickerRow.NewChat("+ 新建对话"))
                if (out.isEmpty()) {
                    pickerRows.add(PickerRow.Head(if (wsId.isBlank()) "还没有对话" else "这个项目还没有对话"))
                } else {
                    out.forEach { pickerRows.add(PickerRow.SessRow(it)) }
                    if (cur.isNotBlank()) pickerRows.add(PickerRow.Detail("看这只对话的原文"))
                }
                pickerAdapter.notifyDataSetChanged()
                sizePicker()
            }
        }, "pet-sessions").apply { isDaemon = true }.start()
    }

    /** 列表里只精确到分钟：今天、昨天、更早给日期。 */
    private fun timeLabel(ts: Long): String {
        if (ts <= 0L) return ""
        val then = Calendar.getInstance().apply { timeInMillis = ts }
        val today = Calendar.getInstance()
        val hm = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ts))
        if (then.get(Calendar.YEAR) == today.get(Calendar.YEAR) &&
            then.get(Calendar.DAY_OF_YEAR) == today.get(Calendar.DAY_OF_YEAR)
        ) {
            return "今天 $hm"
        }
        today.add(Calendar.DAY_OF_YEAR, -1)
        if (then.get(Calendar.YEAR) == today.get(Calendar.YEAR) &&
            then.get(Calendar.DAY_OF_YEAR) == today.get(Calendar.DAY_OF_YEAR)
        ) {
            return "昨天 $hm"
        }
        return SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(ts))
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
            is PickerRow.Detail -> openSessionDetail()
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
    /** 跳到这只会话的原文页：工具调用、长回复、更早的记录都在那边。 */
    private fun openSessionDetail() {
        val id = PetSettings.chatSession(this)
        if (id.isBlank()) {
            toast("先选一只对话")
            return
        }
        closePicker()
        startActivity(SessionActivity.intent(this, id, liveSessionTitle.ifBlank { projectBtn.text.toString() }))
    }

    private fun pickSession(s: Sess) {
        closePicker()
        // 切会话前先把旧会话上那一轮收掉：不 cancel 的话 turn 一直非空，新会话里连一个字
        // 都发不出去（提示永远是「上一轮还没结束」），跑着的那轮还会往新会话里写状态。
        turn?.cancel()
        turn = null
        turnToken = ++turnSeq
        ui.removeCallbacks(ticker)
        queuedNote = false
        userStopped = false
        liveText = ""
        typing.visibility = View.GONE
        runBar.visibility = View.GONE
        // 指针先落库再 reload：列表按新会话重排，旧会话的消息一条都不留在屏上
        PetSettings.saveChatSession(this, s.id)
        liveSessionTitle = s.title
        refreshHeader()
        reload()
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
            toast(r.takeFaultText() ?: "没听清，再说一次")
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

    /* ---------------- 视频播放 ---------------- */

    /** 在页面里盖一层播放：不另开 Activity（清单不动），也没有额外依赖。 */
    private fun playVideo(att: PetHistory.Att) {
        val path = att.shown
        if (path.isBlank() || !java.io.File(path).isFile) {
            toast("这段视频只在电脑上")
            return
        }
        closeVideo()
        val rootV = findViewById<ViewGroup>(R.id.historyRoot)
        val layer = FrameLayout(this)
        layer.setBackgroundColor(0xF0000000.toInt())
        layer.isClickable = true
        val vv = android.widget.VideoView(this)
        val match = ViewGroup.LayoutParams.MATCH_PARENT
        layer.addView(vv, FrameLayout.LayoutParams(match, match))
        rootV.addView(layer, FrameLayout.LayoutParams(match, match))
        videoLayer = layer
        videoView = vv
        layer.setOnClickListener { closeVideo() }
        vv.setMediaController(android.widget.MediaController(this).also { it.setAnchorView(vv) })
        vv.setOnErrorListener { _, _, _ ->
            toast("这段视频播不了")
            closeVideo()
            true
        }
        vv.setOnCompletionListener { closeVideo() }
        try {
            vv.setVideoPath(path)
            vv.setOnPreparedListener { mp ->
                mp.isLooping = false
                vv.start()
            }
        } catch (_: Throwable) {
            toast("这段视频播不了")
            closeVideo()
        }
    }

    private fun closeVideo() {
        val vv = videoView ?: return
        runCatching { if (vv.isPlaying) vv.stopPlayback() }
        (videoLayer?.parent as? ViewGroup)?.removeView(videoLayer)
        videoView = null
        videoLayer = null
    }

    /* ---------------- 列表适配器 ---------------- */

    private inner class ChatAdapter : BaseAdapter() {
        var rows: List<ChatRow> = emptyList()
        var live: String = ""
        var error: String = ""
        var errorAction: (() -> Unit)? = null
        var onRetry: () -> Unit = {}
        var onMore: () -> Unit = {}

        override fun getCount(): Int = rows.size + (if (error.isNotBlank()) 1 else 0)
        override fun getItem(position: Int): Any? = rows.getOrNull(position)
        override fun getItemId(position: Int): Long = position.toLong()

        /** 点了一行：「加载更早」翻页、发送失败那行重发，其余不动。 */
        fun tap(position: Int) {
            if (rows.getOrNull(position) is ChatRow.More) {
                onMore()
                return
            }
            if (position >= rows.size) (errorAction ?: onRetry)()
        }

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            if (rows.getOrNull(position) is ChatRow.More) return bindMore(convertView, parent)
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
                is ChatRow.Me -> bindText(convertView, parent, row.text, mine = true, media = row.media)
                is ChatRow.Pet -> if (row.rich) bindRich(convertView, parent, row.text) else bindText(convertView, parent, row.text, mine = false)
                is ChatRow.Live -> bindText(convertView, parent, row.text, mine = false)
                is ChatRow.Note -> bindNote(convertView, parent, row.text)
                is ChatRow.More -> bindMore(convertView, parent)
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

        /** 这一条带的图/视频：路径早写进历史了，重进会话照旧能看。 */
        private fun mediaOf(position: Int): List<PetHistory.Att> =
            (rows.getOrNull(position) as? ChatRow.Me)?.media ?: emptyList()

        private fun bindText(
            convertView: View?,
            parent: ViewGroup,
            raw: String,
            mine: Boolean,
            media: List<PetHistory.Att> = emptyList(),
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
            val imgs = media.filter { !it.isVideo }.map { it.shown }
            val clips = media.filter { it.isVideo }
            val thumbs = bindThumbs(v, raw, imgs, clips)
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
        private fun bindThumbs(
            v: View,
            raw: String,
            extra: List<String>,
            clips: List<PetHistory.Att> = emptyList(),
        ): Int {
            val holder = v.findViewById<LinearLayout>(R.id.itemThumbs) ?: return 0
            holder.removeAllViews()
            val paths = imagePathsOf(raw, extra).take(4)
            if (paths.isEmpty() && clips.isEmpty()) {
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
            clips.forEach { clip -> holder.addView(videoRow(clip, holder)) }
            return paths.size + clips.size
        }

        /** 视频在气泡里给一格：首帧 + 文件名，点开就在这儿播。 */
        private fun videoRow(clip: PetHistory.Att, holder: LinearLayout): View {
            val density = resources.displayMetrics.density
            val width = minOf(
                (200 * density).toInt(),
                (resources.displayMetrics.widthPixels - dp(24)) * 3 / 4,
            )
            val box = LinearLayout(this@HistoryActivity)
            box.orientation = LinearLayout.VERTICAL
            box.layoutParams = LinearLayout.LayoutParams(width, LinearLayout.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = dp(6) }
            val iv = android.widget.ImageView(this@HistoryActivity)
            iv.layoutParams = LinearLayout.LayoutParams(width, (width * 0.56f).toInt())
            iv.scaleType = android.widget.ImageView.ScaleType.CENTER_CROP
            iv.clipToOutline = true
            iv.background = GradientDrawable().apply {
                cornerRadius = 16f * density
                setColor(getColor(R.color.pet_hint_bg))
            }
            iv.tag = clip.shown
            box.addView(iv)
            VideoThumb.peek(clip.shown)?.let { iv.setImageBitmap(it) }
            VideoThumb.load(clip.shown) { bmp ->
                if (bmp != null && iv.tag == clip.shown && holder.indexOfChild(box) >= 0) iv.setImageBitmap(bmp)
            }
            val name = TextView(this@HistoryActivity)
            name.text = clip.shown.substringAfterLast('/')
            name.textSize = 12f
            name.maxLines = 1
            name.ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            name.setTextColor(getColor(R.color.pet_hint))
            name.layoutParams = LinearLayout.LayoutParams(width, LinearLayout.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = dp(4) }
            box.addView(name)
            box.setOnClickListener { playVideo(clip) }
            return box
        }

        /** 顶上那行「加载更早」：只标一句，点了往前取一页。 */
        private fun bindMore(convertView: View?, parent: ViewGroup): View {
            val v = convertView ?: layoutInflater.inflate(R.layout.item_history, parent, false)
            plainRow(v)
            val bubble = v.findViewById<FrameLayout>(R.id.itemBubble)
            bubble.background = null
            bubble.setPadding(0, dp(6), 0, dp(6))
            val text = v.findViewById<TextView>(R.id.itemText)
            text.visibility = View.VISIBLE
            text.textSize = 13f
            text.text = "加载更早"
            text.setTextColor(getColor(R.color.pet_accent))
            (v as android.widget.LinearLayout).gravity = Gravity.CENTER
            text.setOnLongClickListener(null)
            v.setOnClickListener { loadEarlier() }
            return v
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
            val v = convertView ?: layoutInflater.inflate(R.layout.item_picker, parent, false)
            val title = v.findViewById<TextView>(R.id.pickerRowTitle)
            val meta = v.findViewById<TextView>(R.id.pickerRowMeta)
            val chevron = v.findViewById<TextView>(R.id.pickerRowChevron)
            val line = v.findViewById<View>(R.id.pickerRowLine)
            v.setBackgroundColor(getColor(R.color.pet_surface))
            v.setPadding(0, 0, 0, 0)
            title.visibility = View.VISIBLE
            meta.visibility = View.GONE
            chevron.visibility = View.GONE
            line.visibility = View.VISIBLE
            title.setTextColor(getColor(R.color.pet_text))
            title.textSize = 15f
            when (val row = pickerRows[position]) {
                is PickerRow.Head -> {
                    title.visibility = View.GONE
                    line.visibility = View.GONE
                    meta.visibility = View.VISIBLE
                    meta.text = row.text
                    meta.setTextColor(getColor(R.color.pet_hint))
                    meta.textSize = 13f
                    v.setPadding(0, dp(18), 0, dp(10))
                }
                is PickerRow.NewChat -> {
                    title.text = row.text
                    title.setTextColor(getColor(R.color.pet_accent))
                }
                is PickerRow.Proj -> {
                    title.text = row.ws.title
                    // 只有「当前这只对话在哪个项目」值得写；其余行不再挂一句解释动作的话
                    if (row.ws.id.isNotBlank() && row.ws.id == pickerProjectId) {
                        meta.visibility = View.VISIBLE
                        meta.text = "当前"
                    } else {
                        meta.visibility = View.GONE
                    }
                }
                is PickerRow.SessRow -> {
                    val s = row.s
                    title.text = s.title.ifBlank { "未命名对话" }
                    val current = s.id == PetSettings.chatSession(this@HistoryActivity)
                    val bits = ArrayList<String>(3)
                    val when_ = timeLabel(s.at)
                    if (when_.isNotBlank()) bits.add(when_)
                    if (current) bits.add("当前")
                    if (s.running) bits.add("正在执行")
                    meta.visibility = View.VISIBLE
                    meta.text = bits.joinToString(" · ")
                    meta.setTextColor(getColor(if (s.running) R.color.pet_accent else R.color.pet_hint))
                    if (current) v.setBackgroundColor(getColor(R.color.pet_hint_bg))
                }
                is PickerRow.Action -> {
                    title.text = row.text
                    title.setTextColor(getColor(R.color.pet_accent))
                }
                is PickerRow.Detail -> {
                    title.text = row.text
                    title.setTextColor(getColor(R.color.pet_text_dim))
                    chevron.visibility = View.VISIBLE
                    line.visibility = View.GONE
                }
            }
            return v
        }
    }
}
