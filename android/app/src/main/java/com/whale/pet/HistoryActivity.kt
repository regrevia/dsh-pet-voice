package com.whale.pet

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.ColorDrawable
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
import java.text.SimpleDateFormat
import java.util.Date
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

    private data class Ws(val id: String, val title: String, val path: String, val pinned: Boolean)
    private data class Sess(val id: String, val title: String, val at: Long)

    private sealed class ChatRow {
        data class Me(val text: String) : ChatRow()
        data class Pet(val text: String, val rich: Boolean) : ChatRow()
        data class Live(val text: String) : ChatRow()
    }

    private sealed class PickerRow {
        data class Head(val text: String) : PickerRow()
        data class Proj(val ws: Ws) : PickerRow()
        data class SessRow(val s: Sess) : PickerRow()
        /** 「新建项目」这类没有现成数据的行。 */
        data class Action(val text: String) : PickerRow()
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
        pickerList.adapter = pickerAdapter
        list.dividerHeight = 0

        findViewById<View>(R.id.historyBack).setOnClickListener { finish() }
        projectBtn.setOnClickListener { openPicker(1) }
        sessionsBtn.setOnClickListener { openPicker(2) }
        findViewById<View>(R.id.historyNew).setOnClickListener { newChat() }
        pickerClose.setOnClickListener { closePicker() }
        pickerScrim.setOnClickListener { closePicker() }
        pickerBack.setOnClickListener { if (pickerLevel == 2) openPicker(1) else closePicker() }
        pickerList.onItemClickListener =
            AdapterView.OnItemClickListener { _, _, pos, _ -> onPickerPick(pos) }

        sendBtn.setOnClickListener { sendChat() }
        emojiBtn.setOnClickListener { showEmojiPicker() }
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
    }

    override fun onResume() {
        super.onResume()
        refreshHeader()
        reload()
    }

    override fun onPause() {
        super.onPause()
        // 离开页面就别再录了，免得麦克风一直攥在手里
        micDown = false
        if (recorder?.isRecording == true) runCatching { recorder?.stop() }
        stopTurn()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
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
    }

    private fun reload() {
        val items = PetHistory.all(this)
        val lastPet = items.indexOfLast { !it.isMe }
        val rows = ArrayList<ChatRow>(items.size + 2)
        items.forEachIndexed { i, item ->
            if (item.isMe) {
                rows.add(ChatRow.Me(item.text))
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
        input.setText("")
        send(text)
    }

    private fun resendLast() {
        val text = lastSent
        if (text.isBlank()) return
        adapter.error = ""
        adapter.errorAction = null
        if (turn != null) return
        send(text)
    }

    private fun send(text: String) {
        lastSent = text
        adapter.error = ""
        adapter.errorAction = null
        adapter.live = ""
        turnStart = System.currentTimeMillis()
        PetHistory.append(this, PetHistory.ROLE_ME, text)
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
        if (requestCode != REQ_SCAN) return
        if (resultCode == RESULT_OK) {
            adapter.error = ""
            adapter.errorAction = null
            reload()
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (turn == null) return
            val ms = System.currentTimeMillis() - turnStart
            // 线程卡在开流/长轮询里时回调可能永远不来：一路没字就自己收工，别让人对着「处理中」发呆
            if (ms > 45_000 && adapter.live.isBlank()) {
                userStopped = false
                turn?.cancel()
                finishTurn(null)
                return
            }
            runText.text = "处理中 ${ms / 1000} s"
            ui.postDelayed(this, 1000)
        }
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
                    PetSettings.saveChatSession(this, id)
                    toast("新对话已开")
                } else {
                    toast("新对话没开成")
                }
                reload()
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
                pickerTitle.text = pickerProject.ifBlank { "会话" }
                loadSessions()
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
        val ok = r.start()
        if (!ok) {
            micBusy = false
            micBtn.alpha = 1f
            micBtn.clearColorFilter()
            runBar.visibility = View.GONE
            sendServiceAction(FloatingPetService.ACTION_WAKE_RESUME)
            toast("麦克风不可用")
        }
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
                v.setOnClickListener { (errorAction ?: onRetry)() }
                return v
            }
            val row = rows[position]
            return when (row) {
                is ChatRow.Me -> bindText(convertView, parent, row.text, mine = true)
                is ChatRow.Pet -> if (row.rich) bindRich(convertView, parent, row.text) else bindText(convertView, parent, row.text, mine = false)
                is ChatRow.Live -> bindText(convertView, parent, row.text, mine = false)
            }
        }

        private fun bindText(convertView: View?, parent: ViewGroup, raw: String, mine: Boolean): View {
            val v = convertView ?: layoutInflater.inflate(R.layout.item_history, parent, false)
            val bubble = v.findViewById<FrameLayout>(R.id.itemBubble)
            val text = v.findViewById<TextView>(R.id.itemText)
            text.visibility = View.VISIBLE
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
            text.setOnLongClickListener { copy(raw); true }
            return v
        }

        private fun bindRich(convertView: View?, parent: ViewGroup, raw: String): View {
            val v = bindText(convertView, parent, raw, mine = false)
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
