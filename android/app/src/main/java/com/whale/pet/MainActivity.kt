package com.whale.pet

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.ClipData
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast

/**
 * 主界面：① 状态卡 ② 扫码绑定 / 叫出宠物 ③ 折叠的「设置」「更多」。
 * 打开就能用：没有配置时状态卡是空状态，两个大按钮引导扫码或直接对话。
 */
class MainActivity : Activity() {

    private lateinit var scroll: ScrollView
    private lateinit var hostInput: EditText
    private lateinit var presetSpinner: Spinner
    private lateinit var wakeCheck: CheckBox
    private lateinit var wakeHint: TextView
    private lateinit var autoStartCheck: CheckBox
    private lateinit var bubbleCheck: CheckBox
    private lateinit var wakeNameInput: EditText
    private lateinit var spriteSpinner: Spinner
    private lateinit var outfitSpinner: Spinner
    private lateinit var displayModeValue: TextView
    private lateinit var historyCount: TextView
    private lateinit var report: TextView
    // 文字通道已并入「对话」页；主界面没有这些控件了，取到就是 null，统一按可空处理。
    private var textInput: EditText? = null
    private var replyView: TextView? = null
    private var sessionLabel: TextView? = null
    private lateinit var updateState: TextView
    private var updater: UpdateManager? = null
    private var installReceiver: BroadcastReceiver? = null
    /** 选了「只在桌面显示」但还没授权时先记下，回到界面再落 */
    private var pendingDisplayMode: String? = null

    private lateinit var statusDot: View
    private lateinit var statusTitle: TextView
    private lateinit var statusHost: TextView
    private lateinit var statusProject: TextView
    /** 项目名当前上屏的是什么（动画只在文字真的变了时做）。 */
    private var projectShown = ""
    private var projectRendered = false
    private var titleFixing = false
    private lateinit var settingsBody: LinearLayout
    private lateinit var moreBody: LinearLayout
    private lateinit var settingsArrow: TextView
    private lateinit var moreArrow: TextView

    private var pendingLaunch = false
    private var awaitingOverlay = false
    private var probing = false
    private var connected: Boolean? = null
    private val presetKeys = PetConfig.PRESETS.map { it.first }

    private var tts: TtsPlayer? = null
    private var textTurn: PetTurn? = null

    private val asrUnavailableMsg =
        "这台机器没有可用的系统识别，请改用「服务端识别」（未上线）或安装语音服务；" +
            "现在可以在「更多 → 文字通道」里直接对话。"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        NetLog.attach(this)

        scroll = findViewById(R.id.rootScroll)
        hostInput = findViewById(R.id.hostInput)
        presetSpinner = findViewById(R.id.presetSpinner)
        wakeCheck = findViewById(R.id.wakeCheck)
        wakeHint = findViewById(R.id.wakeHint)
        autoStartCheck = findViewById(R.id.autoStartCheck)
        bubbleCheck = findViewById(R.id.bubbleCheck)
        wakeNameInput = findViewById(R.id.wakeNameInput)
        spriteSpinner = findViewById(R.id.spriteSpinner)
        outfitSpinner = findViewById(R.id.outfitSpinner)
        displayModeValue = findViewById(R.id.displayModeValue)
        historyCount = findViewById(R.id.historyCount)
        report = findViewById(R.id.report)
        updateState = findViewById(R.id.updateState)

        wakeCheck.setOnCheckedChangeListener { _, checked ->
            wakeHint.visibility = if (checked) View.VISIBLE else View.GONE
            if (checked) toast("耗电会增加")
        }

        statusDot = findViewById(R.id.statusDot)
        statusTitle = findViewById(R.id.statusTitle)
        statusHost = findViewById(R.id.statusHost)
        statusProject = findViewById(R.id.statusProject)
        settingsBody = findViewById(R.id.settingsBody)
        moreBody = findViewById(R.id.moreBody)
        settingsArrow = findViewById(R.id.settingsArrow)
        moreArrow = findViewById(R.id.moreArrow)

        // 状态栏/导航栏：给根容器加内边距（不用 fitsSystemWindows，避免连带吃掉键盘 resize）
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            v.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
            insets
        }

        presetSpinner.adapter = object : ArrayAdapter<String>(
            this,
            android.R.layout.simple_spinner_item,
            PetConfig.PRESETS.map { it.second },
        ) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getView(position, convertView, parent) as TextView).apply {
                    setTextColor(getColor(R.color.pet_text))
                    textSize = 14f
                }

            override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getDropDownView(position, convertView, parent) as TextView).apply {
                    setTextColor(getColor(R.color.pet_text))
                    textSize = 14f
                }
        }

        val spriteLabels = PetConfig.SPRITE_SIZES.map { it.second }
        spriteSpinner.adapter = object : ArrayAdapter<String>(
            this,
            android.R.layout.simple_spinner_item,
            spriteLabels,
        ) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getView(position, convertView, parent) as TextView).apply {
                    setTextColor(getColor(R.color.pet_text))
                    textSize = 14f
                }

            override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getDropDownView(position, convertView, parent) as TextView).apply {
                    setTextColor(getColor(R.color.pet_text))
                    textSize = 14f
                }
        }

        val outfitLabels = PetConfig.OUTFITS.map { it.second }
        outfitSpinner.adapter = object : ArrayAdapter<String>(
            this,
            android.R.layout.simple_spinner_item,
            outfitLabels,
        ) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getView(position, convertView, parent) as TextView).apply {
                    setTextColor(getColor(R.color.pet_text))
                    textSize = 14f
                }

            override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getDropDownView(position, convertView, parent) as TextView).apply {
                    setTextColor(getColor(R.color.pet_text))
                    textSize = 14f
                }
        }
        // 换形象立即生效：只存这一项并让常驻窗口换素材，不用点「保存设置」，也不重启服务。
        outfitSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                val key = PetConfig.OUTFITS.getOrNull(position)?.first ?: ""
                val cfg = PetSettings.load(this@MainActivity)
                if (cfg.outfit == key) return
                PetSettings.save(this@MainActivity, cfg.copy(outfit = key))
                if (FloatingPetService.alive) {
                    try {
                        startService(
                            Intent(this@MainActivity, FloatingPetService::class.java)
                                .setAction(FloatingPetService.ACTION_REFRESH_OUTFIT),
                        )
                    } catch (_: Exception) {
                    }
                }
            }

            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }

        findViewById<LinearLayout>(R.id.historyRow).setOnClickListener { openHistory() }
        findViewById<LinearLayout>(R.id.displayModeRow).setOnClickListener { pickDisplayMode() }
        findViewById<Button>(R.id.scanBtn).setOnClickListener { startScan() }
        findViewById<View>(R.id.launchBtn).setOnClickListener { chatClicked() }
        findViewById<Button>(R.id.saveBtn).setOnClickListener { save() }
        findViewById<Button>(R.id.stopBtn).setOnClickListener { quitAll() }
        findViewById<LinearLayout>(R.id.updateRow).setOnClickListener { checkNow() }
        findViewById<Button>(R.id.checkUpdateBtn).setOnClickListener { checkNow() }
        findViewById<Button>(R.id.diagBtn).setOnClickListener { NetLog.send(this) }
        findViewById<Button>(R.id.scanAgainBtn).setOnClickListener { startScan() }
        findViewById<Button>(R.id.permBtn).setOnClickListener { permissionChooser() }
        findViewById<TextView>(R.id.permOverlay).setOnClickListener { openOverlayPermission() }
        findViewById<TextView>(R.id.permMic).setOnClickListener {
            if (granted(Manifest.permission.RECORD_AUDIO)) {
                toast("麦克风已授权")
            } else {
                requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1009)
            }
        }

        bindSection(findViewById(R.id.settingsHeader), settingsBody, settingsArrow)
        bindSection(findViewById(R.id.moreHeader), moreBody, moreArrow)

        textInput?.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendText()
                true
            } else {
                false
            }
        }
        textInput?.setOnFocusChangeListener { _, hasFocus ->
            if (hasFocus) textInput?.let { revealInput(it) }
        }

        refreshStatus()
        // 启动自检回传：告诉我手机上跑的是哪一版、还绑定着没（重装后要不要重新配对）
        Thread {
            runCatching {
                val cfg = PetSettings.load(this)
                PetClient { cfg }.log(
                    "app-start",
                    "ready=${cfg.ready} session=${PetSettings.chatSession(this).take(6)} " +
                        "base=${if (cfg.baseUrl.isBlank()) "-" else "set"}",
                )
            }
        }.apply { isDaemon = true }.start()
    }

    /** 折叠区：整行可点，▸/▾ 同步。 */
    private fun bindSection(header: View, body: View, arrow: TextView) {
        header.setOnClickListener {
            val open = body.visibility == View.VISIBLE
            body.visibility = if (open) View.GONE else View.VISIBLE
            arrow.text = if (open) "▸" else "▾"
        }
    }

    private fun expand(body: LinearLayout, arrow: TextView) {
        body.visibility = View.VISIBLE
        arrow.text = "▾"
    }

    private fun revealInput(input: View) {
        scroll.postDelayed(
            { input.requestRectangleOnScreen(Rect(0, 0, input.width, input.height + dp(120)), true) },
            250,
        )
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onResume() {
        super.onResume()
        petWindow(show = false)
        refreshStatus()
        pendingDisplayMode?.let { pending ->
            pendingDisplayMode = null
            if (UsageAccess.granted(this)) {
                applyDisplayMode(pending)
            } else {
                toast("没允许查看使用情况，先保持一直显示")
            }
        }
        if (awaitingOverlay && Settings.canDrawOverlays(this)) {
            awaitingOverlay = false
            launchPet(askPermissions = true)
            return
        }
        probeState()
        // 回到前台只静默查有没有新版，绝不自动弹安装页；装不装由用户点
        initUpdater()
        if (PetSettings.load(this).ready) checkUpdate(quiet = true)
    }


    /** 本应用在前台时把悬浮小人收起来（服务与唤醒继续跑），离开再放出来。 */
    private fun petWindow(show: Boolean) {
        if (!FloatingPetService.alive) return
        runCatching {
            startService(
                Intent(this, FloatingPetService::class.java)
                    .setAction(if (show) FloatingPetService.ACTION_SHOW else FloatingPetService.ACTION_HIDE),
            )
        }
    }

    override fun onPause() {
        petWindow(show = true)
        super.onPause()
    }

    override fun onDestroy() {
        installReceiver?.let { runCatching { unregisterReceiver(it) } }
        installReceiver = null
        textTurn?.cancel()
        textTurn = null
        tts?.release()
        tts = null
        super.onDestroy()
    }

    /* ---------------- 状态卡 ---------------- */

    /**
     * 项目名四个动作，和桌面 DSH 一一对应：
     *  - 点项目（对话页一级列表）= DSH 里选中项目，默认落进该项目的新会话；
     *  - 点会话（二级列表）      = DSH 里点开某个历史会话继续；
     *  - 点「新对话」            = DSH 新建会话，项目不变；
     *  - 点返回                  = DSH 收起项目/会话选择，回到当前会话。
     *
     * 名字**先上屏**再谈网络：桌面 DSH 的标题本来就是本地状态，不等后端回来才画。
     * 联网只做「纠正」（[correctProjectTitleAsync]），绝不先清空再等，避免「先消失、卡一下再出现」。
     */
    private fun setProjectTitle(title: String, animate: Boolean = true) {
        val shown = title.trim()
        if (shown.isBlank()) return
        statusProject.visibility = View.VISIBLE
        if (!projectRendered) {
            // 首帧不做动画：进来就闪一下更像故障
            projectRendered = true
            projectShown = shown
            statusProject.text = shown
            statusProject.alpha = 1f
            statusProject.translationY = 0f
            return
        }
        if (shown == projectShown) return
        projectShown = shown
        statusProject.text = shown
        if (!animate) {
            statusProject.alpha = 1f
            statusProject.translationY = 0f
            return
        }
        // 只在文字真的变了时做 180ms 淡入 + 6dp 上移：读起来是「换了个名字」，不是「重新加载」
        statusProject.animate().cancel()
        statusProject.alpha = 0f
        statusProject.translationY = 6f * resources.displayMetrics.density
        statusProject.animate()
            .alpha(1f)
            .translationY(0f)
            .setDuration(180L)
            .start()
    }

    /** 联网纠正项目名：本地名先上屏，这里只负责在对不上时换一下。 */
    private fun correctProjectTitleAsync() {
        if (titleFixing) return
        val cfg = PetSettings.load(this)
        if (!cfg.ready) return
        titleFixing = true
        Thread({
            val title = try {
                PetClient { cfg }.workspaces().json?.optJSONObject("pinned")?.optString("title").orEmpty()
            } catch (_: Exception) {
                ""
            }
            runOnUiThread {
                titleFixing = false
                if (title.isNotBlank() && title != projectShown) {
                    PetSettings.savePinnedTitle(this, title)
                    setProjectTitle(title)
                }
            }
        }, "pet-title").apply { isDaemon = true }.start()
    }

    private fun refreshStatus() {
        val cfg = PetSettings.load(this)
        if (hostInput.text.isNullOrBlank()) hostInput.setText(cfg.baseUrl)
        presetSpinner.setSelection(presetKeys.indexOf(cfg.preset).coerceAtLeast(0))
        wakeCheck.isChecked = cfg.wakeEnabled
        wakeHint.visibility = if (cfg.wakeEnabled) View.VISIBLE else View.GONE
        autoStartCheck.isChecked = cfg.autoStart
        bubbleCheck.isChecked = cfg.bubble
        if (wakeNameInput.text.isNullOrBlank()) wakeNameInput.setText(cfg.wakeName)
        spriteSpinner.setSelection(
            PetConfig.SPRITE_SIZES.indexOfFirst { it.first == cfg.spriteSize }.coerceAtLeast(0),
        )
        outfitSpinner.setSelection(
            PetConfig.OUTFITS.indexOfFirst { it.first == cfg.outfit }.coerceAtLeast(0),
        )
        val homeMode = cfg.displayMode == "home"
        displayModeValue.text = when {
            homeMode && !UsageAccess.granted(this) -> "一直显示（授权后生效）"
            homeMode -> "在桌面时出现"
            else -> "一直显示"
        }
        val count = PetHistory.all(this).size
        historyCount.text = if (count > 0) "$count 条" else ""
        val pinned = PetSettings.chatSession(this)
        sessionLabel?.text = if (pinned.isBlank()) "会话：接着上次" else "会话：新开"
        // 权限不再靠按钮自检：进界面缺麦克风就当场要一次，问过就记住，不反复弹。
        val permPrefs = getSharedPreferences("pet_prefs", MODE_PRIVATE)
        if (!granted(Manifest.permission.RECORD_AUDIO) && !permPrefs.getBoolean("mic_asked", false)) {
            permPrefs.edit().putBoolean("mic_asked", true).apply()
            askMic()
        }

        val dot = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(if (cfg.ready && connected == true) getColor(R.color.pet_accent) else getColor(R.color.pet_line))
        }
        statusDot.background = dot

        val scan = findViewById<Button>(R.id.scanBtn)
        val launch = findViewById<View>(R.id.launchBtn)
        // 按钮上直接写「叫出谁」：用户配的是哪个称呼，就显示哪个，别让人猜「立即对话」是开什么。
        findViewById<TextView>(R.id.launchLabel).text = "叫出${cfg.wakeName}"
        if (!cfg.ready) {
            statusTitle.text = "${PetSettings.load(this).wakeName} · 未绑定"
            statusHost.visibility = View.VISIBLE
            statusHost.text = "扫码绑定"
            scan.visibility = View.VISIBLE
            launch.visibility = View.GONE
        } else {
            // 绑定后就不再出现扫码入口：绑了就是绑了，换绑/解绑去配对页
            statusHost.visibility = View.GONE
            scan.visibility = View.GONE
            launch.visibility = View.VISIBLE
            statusTitle.text = when (connected) {
                true -> "${cfg.wakeName} · 已连接"
                false -> "${cfg.wakeName} · 未连接"
                null -> "${cfg.wakeName} · 已配置"
            }
            // 先用本地记下的项目名上屏，联网结果只做「纠正」，绝不先清空再等网络
            setProjectTitle(PetSettings.pinnedTitle(this))
            correctProjectTitleAsync()
        }

        refreshPerms()
    }

    private fun copyToClipboard(text: String, tip: String) {
        try {
            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("大肥鱼宿主", text))
            toast(tip)
        } catch (e: Exception) {
            toast("复制失败")
        }
    }

    /** 探活：只认 `GET /api/state` 200，不猜；连上顺手刷新「钉在哪个项目」。 */
    private fun probeState() {
        val cfg = PetSettings.load(this)
        if (!cfg.ready || probing) return
        probing = true
        Thread {
            var ok: Boolean? = null
            for (attempt in 0..1) {
                ok = try {
                    PetClient { cfg }.state().ok
                } catch (e: Exception) {
                    false
                }
                // 刚冷启动时隧道/服务可能还没热起来，静默再试一次，别先亮「未连接」
                if (ok == true || attempt == 1) break
                try { Thread.sleep(1200) } catch (_: InterruptedException) { break }
            }
            if (ok == true) {
                try {
                    val pinned = PetClient { cfg }.workspaces()
                        .json?.optJSONObject("pinned")?.optString("title").orEmpty()
                    if (pinned.isNotBlank()) PetSettings.savePinnedTitle(this, pinned)
                } catch (_: Exception) {
                }
            }
            runOnUiThread {
                probing = false
                connected = ok
                refreshStatus()
            }
        }.start()
    }

    /* ---------------- 扫码绑定 ---------------- */

    private fun startScan() {
        val cfg = PetSettings.load(this)
        if (!cfg.ready) expand(settingsBody, settingsArrow) // 裸令牌要配宿主：让设置区露出来
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
            toast("已绑定 · 大肥鱼在线")
            hostInput.setText(PetSettings.load(this).baseUrl)
            connected = true
            refreshStatus()
            probeState()
        }
    }

    /* ---------------- 保存 / 粘贴 ---------------- */

    private fun save() {
        val old = PetSettings.load(this)
        val rawHost = hostInput.text.toString().trim()
        // 新装第一条就是配对：把面板给的那条链接整条粘进地址栏，地址和令牌一起拆出来。
        // 拆不出来再按普通地址处理，两个字段都手填的老路不变。
        val paired = if (rawHost.contains("://") && (rawHost.contains("k=") || rawHost.contains("token="))) {
            PetConfig.parsePairPayload(rawHost, old.baseUrl)
        } else {
            null
        }
        val base = when {
            paired != null -> paired.first
            rawHost.isBlank() -> old.baseUrl
            else -> PetSettings.normalizeBase(rawHost)
        }
        if (base.isBlank()) {
            toast("地址无效：公网必须 https://，只有本机/局域网可用 http://")
            return
        }
        val token = paired?.second?.takeIf { it.isNotBlank() } ?: old.token
        if (token.isBlank()) {
            toast("请填访问令牌")
            return
        }
        val cfg = PetConfig(
            baseUrl = base,
            token = token,
            preset = presetKeys[presetSpinner.selectedItemPosition.coerceIn(0, presetKeys.size - 1)] as String,
            wakeEnabled = wakeCheck.isChecked,
            autoStart = autoStartCheck.isChecked,
            bubble = bubbleCheck.isChecked,
            wakeName = PetConfig.cleanWakeName(wakeNameInput.text.toString()),
            spriteSize = PetConfig.SPRITE_SIZES.getOrNull(spriteSpinner.selectedItemPosition)
                ?.first ?: PetConfig.DEFAULT_SPRITE,
            outfit = PetConfig.OUTFITS.getOrNull(outfitSpinner.selectedItemPosition)?.first ?: "",
        )
        PetSettings.save(this, cfg)
        wakeNameInput.setText(cfg.wakeName)
        hostInput.setText(base)
        connected = null
        toast("已保存")
        refreshStatus()
        probeState()
        notifyPetService()
    }

    /** 设置改完让常驻悬浮窗立刻生效：只走 ACTION_REFRESH，不重新申请麦克风。 */
    private fun notifyPetService() {
        try {
            startService(
                Intent(this, FloatingPetService::class.java).setAction(FloatingPetService.ACTION_REFRESH),
            )
        } catch (_: Exception) {
        }
    }

    /**
     * 显示方式二选一。先给选项；只有选「只在桌面显示」才需要「查看使用情况」权限，
     * 缺权限就跳系统开关并记住这次选择，授权回来自动生效。
     */
    private fun pickDisplayMode() {
        val cfg = PetSettings.load(this)
        val labels = PetConfig.DISPLAY_MODES.map { it.second }
        val checked = PetConfig.DISPLAY_MODES.indexOfFirst { it.first == cfg.displayMode }.coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle("显示方式")
            .setSingleChoiceItems(labels.toTypedArray(), checked) { dialog, which ->
                dialog.dismiss()
                val key = PetConfig.DISPLAY_MODES[which].first
                // 缺权限时先要权限（哪怕设置里已经是 home，也可能被用户撤回了）
                if (key == "home" && !UsageAccess.granted(this)) {
                    pendingDisplayMode = key
                    UsageAccess.open(this)
                    return@setSingleChoiceItems
                }
                if (key == cfg.displayMode) return@setSingleChoiceItems
                applyDisplayMode(key)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun applyDisplayMode(key: String) {
        PetSettings.save(this, PetSettings.load(this).copy(displayMode = key))
        refreshStatus()
        notifyPetService()
    }

    private fun openHistory() {
        try {
            startActivity(Intent(this, HistoryActivity::class.java))
        } catch (e: Exception) {
            toast("打不开对话记录：${e.javaClass.simpleName}")
        }
    }

    /**
     * 打开宿主的网页版 GUI：把已配的 `…/pet-voice/` 地址退回站点根（remote-web-ui 的 `/`）。
     * 大肥鱼是悬浮窗，开 GUI 后照样浮在上面，语音和页面不抢屏幕。
     * 明文 http 只放行本机/模拟器地址；解析不出浏览器就退回复制地址。
     */
    private fun openGui() {
        val base = PetSettings.load(this).baseUrl.trim()
        if (base.isEmpty()) {
            toast("先在上面填宿主地址，或扫码绑定")
            return
        }
        val uri = try {
            Uri.parse(base)
        } catch (e: Exception) {
            toast("地址解析失败：${e.javaClass.simpleName}")
            return
        }
        val host = uri.host
        if (host.isNullOrBlank()) {
            toast("地址里没有主机名")
            return
        }
        val scheme = (uri.scheme ?: "https").lowercase()
        val loopback = host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2" || host.endsWith(".local")
        if (scheme != "https" && !loopback) {
            toast("明文 http 只给本机调试；换成 https 再开")
            return
        }
        val root = Uri.Builder().scheme(scheme).authority(uri.authority).path("/").build()
        val view = Intent(Intent.ACTION_VIEW, root).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (view.resolveActivity(packageManager) == null) {
            copyToClipboard(root.toString(), "没有浏览器，已复制 GUI 地址")
            return
        }
        try {
            startActivity(view)
        } catch (e: Exception) {
            copyToClipboard(root.toString(), "打不开浏览器，已复制地址")
        }
    }

    /* ---------------- 自检 ---------------- */

    /** 三行真实值：isRecognitionAvailable / createSpeechRecognizer 是否非 null / 识别 Activity 命中数。 */
    private fun asrDiagLines(): String {
        val available = try {
            SpeechRecognizer.isRecognitionAvailable(this)
        } catch (e: Exception) {
            false
        }
        var created: String
        try {
            val sr = SpeechRecognizer.createSpeechRecognizer(this)
            created = if (sr == null) "null" else "非 null"
            try {
                sr?.destroy()
            } catch (_: Exception) {
            }
        } catch (e: Exception) {
            created = "抛异常 ${e.javaClass.simpleName}"
        }
        val hits = try {
            packageManager.queryIntentActivities(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH), 0).size
        } catch (e: Exception) {
            -1
        }
        val ok = available && created == "非 null" && hits > 0
        return buildString {
            appendLine("系统识别 isRecognitionAvailable: $available")
            appendLine("createSpeechRecognizer: $created")
            appendLine("RECOGNIZE_SPEECH 命中 Activity: ${if (hits < 0) "查询异常" else "$hits 个"}")
            if (!ok) appendLine("→ $asrUnavailableMsg")
        }
    }

    private fun runSelfCheck() {
        expand(moreBody, moreArrow)
        val cfg = PetSettings.load(this)
        val lines = StringBuilder()
        lines.appendLine("宿主: ${cfg.baseUrl.ifBlank { "(未设置)" }}")
        lines.appendLine("令牌: ${PetSettings.maskedToken(cfg.token)}")
        lines.appendLine("音色: ${cfg.preset}")
        lines.append(asrDiagLines())
        lines.appendLine("WebView: ${WebView.getCurrentWebViewPackage()?.packageName ?: "无"}")
        lines.appendLine("悬浮窗: ${if (Settings.canDrawOverlays(this)) "已授权" else "未授权"}")
        lines.appendLine("麦克风: ${if (granted(Manifest.permission.RECORD_AUDIO)) "已授权" else "未授权"}")
        lines.appendLine(
            "通知: " + if (notificationsAllowed()) "已允许" else "被关闭（常驻通知不可见）",
        )
        lines.appendLine("省电策略: ${if (batteryUnrestricted()) "无限制" else "受限（可能被杀）"}")
        report.text = lines.toString()
        report.post { revealInput(report) }
        if (!cfg.ready) {
            report.append("\n未配置宿主/令牌，跳过联网测试")
            return
        }
        report.append("\n连接中…")
        Thread {
            val text = try {
                val r = PetClient { cfg }.state()
                if (!r.ok) {
                    "HTTP ${r.code} ${r.error()}"
                } else {
                    val j = r.json
                    val presets = j?.optJSONArray("presets")?.length() ?: 0
                    val projects = j?.optJSONArray("projects")?.length() ?: 0
                    val target = j?.optString("dispatchTarget").orEmpty()
                    "state OK｜音色 $presets｜项目 $projects｜派发目标 ${target.ifBlank { "(专用会话)" }}"
                }
            } catch (e: Exception) {
                "连接失败: ${e.message ?: e.javaClass.simpleName}"
            }
            runOnUiThread { report.append("\n$text") }
        }.start()
    }

    /* ---------------- 文字兜底：走完整一轮（dispatch → stream → 逐句 TTS） ---------------- */

    private fun ensureTts(): TtsPlayer {
        tts?.let { return it }
        val p = TtsPlayer(
            this,
            PetClient { PetSettings.load(this) },
            { PetSettings.load(this) },
            { speaking -> runOnUiThread { if (speaking) replyView?.append("  🔊") } },
            { msg -> runOnUiThread { replyView?.append("\nTTS 不可用：$msg") } },
        )
        tts = p
        return p
    }

    private fun sendText() {
        val input = textInput ?: return
        val typed = input.text.toString().trim()
        if (typed.isBlank()) {
            toast("先打一句话")
            return
        }
        val cfg = PetSettings.load(this)
        if (!cfg.ready) {
            toast("先扫码绑定，或在「设置」里填宿主和令牌")
            return
        }
        if (textTurn != null) {
            toast("上一轮还没结束，稍等")
            return
        }
        input.setText("")
        replyView?.text = "我：$typed\n大肥鱼：…"
        val player = ensureTts()
        player.stopAll()
        textTurn = PetTurn(PetClient { PetSettings.load(this) }, typed, object : PetTurn.Callback {
            override fun onUser(text: String) = Unit

            override fun onStatus(text: String) {
                runOnUiThread { report.text = report.text.toString().substringBefore("\n[文字]") + "\n[文字] $text" }
            }

            override fun onAssistant(fullText: String, isFinal: Boolean) {
                runOnUiThread { replyView?.text = "我：$typed\n大肥鱼：$fullText" }
            }

            override fun onSentence(sentence: String) {
                player.enqueue(sentence)
            }

            override fun onDone() {
                runOnUiThread {
                    textTurn = null
                    report.text = report.text.toString().substringBefore("\n[文字]").ifBlank { report.text.toString() }
                }
            }

            override fun onError(message: String) {
                runOnUiThread {
                    replyView?.text = "我：$typed\n出错：$message"
                    if (message.contains("404")) {
                        PetSettings.clearChatSession(this@MainActivity)
                        sessionLabel?.text = "会话：复用专属（接着上次聊）"
                    }
                    textTurn = null
                }
            }
        }, PetSettings.chatSession(this)).also { it.start() }
    }

    /* ---------------- 权限：缺什么就说清楚并当场去授 ---------------- */

    private fun askMic() {
        if (granted(Manifest.permission.RECORD_AUDIO)) {
            toast("麦克风已授权")
            refreshStatus()
            return
        }
        toast("大肥鱼要靠麦克风听你说话，点「允许」")
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
    }

    /* ---------------- 自动更新：检查 → 下载 → 调系统安装器 ---------------- */

    private fun initUpdater() {
        if (updater == null) updater = UpdateManager(this, PetClient { PetSettings.load(this) })
        if (installReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val status = intent?.getStringExtra(UpdateManager.EXTRA_STATUS).orEmpty()
                val message = intent?.getStringExtra(UpdateManager.EXTRA_MESSAGE).orEmpty()
                // 只有装成功才清记录；取消/失败把包留着，下次点「检查更新」再拉一次安装页
                if (status == "ok") {
                    updater?.dropCache() ?: PetSettings.clearPendingApk(this@MainActivity)
                    updateState.text = "已更新"
                } else if (message.isNotBlank()) {
                    updateState.text = message
                }
                pendingUpdate = null
                findViewById<LinearLayout>(R.id.updateRow).visibility = View.GONE
            }
        }
        installReceiver = receiver
        val filter = IntentFilter(UpdateManager.ACTION_INSTALL_RESULT)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(receiver, filter)
        }
    }

    private var pendingUpdate: UpdateManager.Info? = null

    /** 只查不下：进 App 静默查一次，有新版才把入口亮出来（点了才下载安装）。 */
    private fun checkUpdate(quiet: Boolean) {
        val cfg = PetSettings.load(this)
        if (!cfg.ready) return
        initUpdater()
        val u = updater ?: return
        if (quiet && !u.shouldAutoCheck()) return
        u.markChecked()
        Thread {
            val info = try {
                u.check()
            } catch (e: Exception) {
                null
            }
            runOnUiThread {
                pendingUpdate = info
                val row = findViewById<LinearLayout>(R.id.updateRow)
                val txt = findViewById<TextView>(R.id.updateRowText)
                if (info == null || info.versionCode <= u.currentVersionCode()) {
                    pendingUpdate = null
                    row.visibility = android.view.View.GONE
                    if (u.lastCheck == "none") u.dropCache()
                    if (!quiet) updateState.text = if (u.lastCheck == "error") "连接失败" else "已是最新"
                } else {
                    txt.text = "新版本 ${info.versionName}"
                    row.visibility = android.view.View.VISIBLE
                    row.isEnabled = true
                }
            }
        }.apply { isDaemon = true }.start()
    }

    /**
     * 更新链路只有一条：查出有新版 → 下载一次 → 拉起一次系统安装页，之后交给用户。
     * 已在本地存好新包时，点「检查更新」直接再拉起安装页，不重复下载。
     */
    private fun installCached(file: java.io.File) {
        initUpdater()
        val u = updater ?: return
        if (!u.canInstall()) {
            updateState.text = "允许安装未知应用"
            u.openInstallPermission()
            return
        }
        updateState.text = ""
        if (!u.install(file)) updateState.text = "安装失败"
    }

    private fun downloadThenInstall(info: UpdateManager.Info) {
        initUpdater()
        val u = updater ?: return
        updateState.text = "下载中…"
        Thread {
            val apk = try {
                u.download(info) { pct -> runOnUiThread { updateState.text = "下载中 $pct%" } }
            } catch (e: Exception) {
                null
            }
            runOnUiThread {
                if (apk == null) {
                    updateState.text = "下载失败"
                    return@runOnUiThread
                }
                PetSettings.savePendingApk(this, apk.absolutePath, info.versionCode, info.versionName)
                installCached(apk)
            }
        }.apply { isDaemon = true }.start()
    }

    /* ---------------- 会话：默认复用，需要时另开一只 ---------------- */

    private fun newChat() {
        val cfg = PetSettings.load(this)
        if (!cfg.ready) {
            toast("先绑定宿主")
            return
        }
        if (textTurn != null) {
            toast("上一轮还没结束")
            return
        }
        // 点「新对话」项目没变，但名字按本地状态立刻上屏（不回退成空串、不等网络）
        setProjectTitle(PetSettings.pinnedTitle(this))
        sessionLabel?.text = "会话：新开中…"
        Thread {
            val id = try {
                PetClient { cfg }.newSession(fresh = true).json?.optString("sessionId").orEmpty()
            } catch (e: Exception) {
                ""
            }
            runOnUiThread {
                if (id.isBlank()) {
                    sessionLabel?.text = "会话：新开失败（宿主不在线？）"
                    toast("新开失败")
                    return@runOnUiThread
                }
                PetSettings.saveChatSession(this, id)
                sessionLabel?.text = "会话：新开 · ${id.take(6)}"
                replyView?.text = "已新开一只会话，接下来聊的就是它；想回到原来那只，重开 App 后在设置里清掉即可。"
                toast("已新开一个会话")
            }
        }.apply { isDaemon = true }.start()
    }

    /* ---------------- 一键关闭全部服务 ---------------- */

    private fun quitAll() {
        // 悬浮窗 + 前台服务 + 常听唤醒 + 语音播放一起停；顺手把自启动关掉，重启手机也不会自己起来
        runCatching {
            startService(
                Intent(this, FloatingPetService::class.java).setAction(FloatingPetService.ACTION_STOP),
            )
        }
        val cfg = PetSettings.load(this)
        if (cfg.autoStart) PetSettings.save(this, cfg.copy(autoStart = false))
        autoStartCheck.isChecked = false
        textTurn?.cancel()
        textTurn = null
        tts?.stopAll()
        refreshStatus()
        toast("已关闭全部服务（含自启动）")
    }

    /* ---------------- 系统授权跳转（厂商无关：能跳就跳，跳不了才给一句话） ---------------- */

    private fun notificationsAllowed(): Boolean = try {
        getSystemService(NotificationManager::class.java).areNotificationsEnabled()
    } catch (e: Exception) {
        true
    }

    private fun batteryUnrestricted(): Boolean = try {
        getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
    } catch (e: Exception) {
        false
    }

    private data class VendorPage(val pkg: String, val activity: String)

    /** 应用详情页是每家系统都有的最终落点。 */
    private fun appDetailsIntent(): Intent = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.parse("package:$packageName"),
    )

    private fun vendorPage(pkg: String, activity: String): Intent =
        Intent().setComponent(ComponentName(pkg, activity)).putExtra("extra_pkgname", packageName)

    /** 表驱动：逐个 resolveActivity，空就跳过；启动异常也只当这次失败，继续下一个。 */
    private fun openFirst(vararg pages: Intent): Boolean {
        for (page in pages) {
            val launched = try {
                if (page.resolveActivity(packageManager) == null) {
                    false
                } else {
                    startActivity(page.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    true
                }
            } catch (_: Exception) {
                false
            }
            if (launched) return true
        }
        return false
    }

    /** 悬浮窗：带包名 → 不带包名 → 应用详情页。 */
    private fun openOverlayPermission() {
        if (Settings.canDrawOverlays(this)) {
            toast("已有悬浮窗权限")
            return
        }
        val ok = openFirst(
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")),
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION),
            appDetailsIntent(),
        )
        if (!ok) toast("请在设置里允许大肥鱼显示在其他应用上层")
    }

    /** 电池：直接申请豁免 → 电池优化列表 → 应用详情页。 */
    private fun openBattery() {
        if (batteryUnrestricted()) {
            toast("电池已不受限")
            return
        }
        val ok = openFirst(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            appDetailsIntent(),
        )
        if (!ok) toast("请在设置里把大肥鱼设为电池不受限")
    }

    private fun openNotificationSettings() {
        val ok = openFirst(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
            appDetailsIntent(),
        )
        if (!ok) toast("请在设置里允许大肥鱼发通知")
    }

    /** 自启动 / 后台：MIUI 两条在前，其余厂商按表探测，缺失就跳过，最终落到应用详情页。 */
    private fun openAutoStart() {
        val pages = mutableListOf(
            Intent("miui.intent.action.OP_AUTO_START").setPackage("com.miui.securitycenter"),
            vendorPage("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            Intent("miui.intent.action.OP_BACKGROUND_START_ACTIVITY").setPackage("com.miui.securitycenter"),
            vendorPage("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity"),
        )
        for (vendor in STARTUP_PAGES) pages.add(vendorPage(vendor.pkg, vendor.activity))
        pages.add(appDetailsIntent())
        if (!openFirst(*pages.toTypedArray())) toast("请在设置里允许大肥鱼自启动")
    }

    /** 一个入口列全部系统授权；具体落到哪家系统的页面由上面的探测决定。 */
    private fun permissionChooser() {
        val labels = arrayOf("悬浮窗权限", "电池不受限", "自启动", "通知")
        AlertDialog.Builder(this)
            .setTitle("去系统设置授权")
            .setItems(labels) { _, which ->
                when (which) {
                    0 -> openOverlayPermission()
                    1 -> openBattery()
                    2 -> openAutoStart()
                    3 -> openNotificationSettings()
                }
            }
            .show()
    }

    /** 权限逐项申请：状态本身可点，未授权才用强调色。 */
    private fun refreshPerms() {
        val ov = findViewById<TextView>(R.id.permOverlay)
        val mic = findViewById<TextView>(R.id.permMic)
        val ovOk = Settings.canDrawOverlays(this)
        val micOk = granted(Manifest.permission.RECORD_AUDIO)
        ov.visibility = if (ovOk) View.GONE else View.VISIBLE
        mic.visibility = if (micOk) View.GONE else View.VISIBLE
        findViewById<LinearLayout>(R.id.permBox).visibility =
            if (ovOk && micOk) View.GONE else View.VISIBLE
    }

    /**
     * 检查更新的唯一入口：
     *   本地已有下好的新包 → 直接拉起一次安装页；
     *   没有 → 查服务器，比本机新才下载，下完拉起一次安装页；
     *   本机已是最新 → 什么都不弹。
     */
    private fun checkNow() {
        if (!PetSettings.load(this).ready) {
            toast("先扫码绑定")
            return
        }
        initUpdater()
        val u = updater ?: return
        val btn = findViewById<Button>(R.id.checkUpdateBtn)
        u.cachedApk()?.let { cached ->
            pendingUpdate = null
            findViewById<LinearLayout>(R.id.updateRow).visibility = View.GONE
            installCached(cached.first)
            return
        }
        btn.isEnabled = false
        btn.text = "检查中…"
        Thread {
            val info = runCatching { u.check() }.getOrNull()
            runOnUiThread {
                btn.isEnabled = true
                btn.text = "检查更新"
                if (info == null) {
                    pendingUpdate = null
                    findViewById<LinearLayout>(R.id.updateRow).visibility = View.GONE
                    if (u.lastCheck == "none") {
                        u.dropCache()
                        updateState.text = "已是最新"
                    } else {
                        updateState.text = "连接失败"
                    }
                } else {
                    pendingUpdate = info
                    findViewById<TextView>(R.id.updateRowText).text = "新版本 ${info.versionName}"
                    findViewById<LinearLayout>(R.id.updateRow).visibility = View.VISIBLE
                    downloadThenInstall(info)
                }
            }
        }.apply { isDaemon = true }.start()
    }

    /** 扫码/粘贴的唯一落点：绑定了就是绑定了。 */
    private fun applyPair(host: String, tok: String) {
        val old = PetSettings.load(this)
        PetSettings.save(
            this,
            PetConfig(
                baseUrl = host,
                token = tok,
                preset = old.preset,
                wakeEnabled = old.wakeEnabled,
                autoStart = old.autoStart,
                wakeName = old.wakeName,
                spriteSize = old.spriteSize,
                outfit = old.outfit,
            ),
        )
        hostInput.setText(host)
        connected = null
        toast("已绑定")
        refreshStatus()
        probeState()
        notifyPetService()
    }

    /* ---------------- 悬浮窗 / 服务 ---------------- */


    /** 点「叫出<称呼>」：没权限就先去授权页，回来后 onResume 续跑，不弹 Toast 说教。 */
    private fun chatClicked() {
        val cfg = PetSettings.load(this)
        if (!Settings.canDrawOverlays(this)) {
            openOverlayPermission()
            return
        }
        if (!cfg.ready) {
            expand(settingsBody, settingsArrow)
            toast("先扫码绑定，或用「设置」里的宿主 + 令牌")
            return
        }
        if (!Settings.canDrawOverlays(this)) {
            awaitingOverlay = true
            openOverlayPermission()
            return
        }
        launchPet(askPermissions = true)
    }

    private fun launchPet(askPermissions: Boolean) {
        val cfg = PetSettings.load(this)
        if (!cfg.ready) {
            toast("先填好地址和令牌")
            return
        }
        if (!Settings.canDrawOverlays(this)) {
            awaitingOverlay = true
            openOverlayPermission()
            return
        }
        val missing = mutableListOf<String>()
        if (!granted(Manifest.permission.RECORD_AUDIO)) missing.add(Manifest.permission.RECORD_AUDIO)
        // 通知在 33+ 系请求一次；拒绝只是没有通知，悬浮窗照跑
        val needNotif = Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)
        if (missing.isNotEmpty() && askPermissions) {
            if (needNotif) missing.add(Manifest.permission.POST_NOTIFICATIONS)
            pendingLaunch = true
            requestPermissions(missing.toTypedArray(), REQ_PERMISSIONS)
            return
        }
        if (needNotif && askPermissions) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
        }
        val intent = Intent(this, FloatingPetService::class.java)
            .setAction(FloatingPetService.ACTION_START)
        startForegroundService(intent)
        toast("悬浮窗已启动")
        moveTaskToBack(true)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_MIC) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                toast("麦克风已授权")
            } else {
                toast("没授权就听不见")
            }
            refreshStatus()
            return
        }
        if (requestCode == REQ_NOTIF) {
            refreshStatus()
            return
        }
        if (requestCode != REQ_PERMISSIONS) return
        val wanted = pendingLaunch
        pendingLaunch = false
        if (!wanted) return
        if (!granted(Manifest.permission.RECORD_AUDIO)) {
            toast("没有麦克风权限")
        }
        launchPet(askPermissions = false)
    }

    private fun granted(permission: String): Boolean =
        checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }

    companion object {
        private const val REQ_PERMISSIONS = 41
        private const val REQ_MIC = 42
        private const val REQ_SCAN = 42
        private const val REQ_NOTIF = 43

        /** 各家自启动/后台管理页；全部先 resolveActivity，没有就跳过。 */
        private val STARTUP_PAGES = listOf(
            VendorPage("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            VendorPage("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
            VendorPage("com.honor.systemmanager", "com.honor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            VendorPage("com.honor.systemmanager", "com.honor.systemmanager.optimize.process.ProtectActivity"),
            VendorPage("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
            VendorPage("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
            VendorPage("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
            VendorPage("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
            VendorPage("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
            VendorPage("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
            VendorPage("com.meizu.safe", "com.meizu.safe.permission.PermMainActivity"),
            VendorPage("com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity"),
        )
    }
}
