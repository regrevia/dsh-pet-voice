package com.whale.pet

import android.Manifest
import android.app.ActivityManager
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.speech.SpeechRecognizer
import android.util.Log
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebViewClient
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.hypot

/**
 * 常驻前台服务：桌面上只有一只鲸鱼娘（透明 WebView），点一下唤醒，长按进对话记录。
 *
 * 形象来自 assets/pet/index.html（由 scripts/gen-pet-asset.mjs 把
 * plugins/dsh-pet-voice/public/pet.js 内联进来，file:// 下不能再走 ES module）。
 * 原生只通过 window.PetBridge 驱动渲染，状态变化才发一次 evaluateJavascript。
 *
 * 说话：系统 SpeechRecognizer（WebView 没有 webkitSpeechRecognition）。
 */
class FloatingPetService : Service() {

    private val main = Handler(Looper.getMainLooper())

    private lateinit var cfg: PetConfig
    private lateinit var client: PetClient
    private lateinit var tts: TtsPlayer
    private lateinit var asr: NativeAsr
    private lateinit var wake: WakeWordEngine

    private var root: View? = null
    private var web: WebView? = null
    private var params: WindowManager.LayoutParams? = null

    /** App 自己在前台时悬浮窗是 GONE，这时候来的气泡先存着，等回到桌面再上屏。 */
    @Volatile
    private var appFg = false
    private var pendingSay: String? = null

    /** 本地气泡队列 + 当前这句还要停留多久（跟 JS 的 dwell 公式对齐）。 */
    private val sayQueue = ArrayDeque<String>()
    private var sayBusyUntil = 0L
    private var sayPump: Runnable? = null

    /* ---------------- 显示方式：只在桌面 / 一直显示 ---------------- */
    /** home 模式下正在轮询前台应用（每 1200ms 一次）。 */
    private var homeWatchOn = false
    /** 上一次「桌面 ↔ 其他应用」切换的 elapsedRealtime；0 = 还没切过。 */
    private var lastLauncherFlipAt = 0L
    /** 系统桌面包名缓存（可能有多个 launcher）。 */
    private var launcherPackages: Set<String>? = null

    private var pageReady = false
    private var webPaused = false
    private var currentMode = "idle"

    /** 当前前台服务是否带 microphone 类型：没有这一位，Android 12+ 会把后台录音整段静音成全零。 */
    private var fgsMic = false
    /** 流式气泡节流：60ms 内只刷一次，60fps 下看不出跳。 */
    private var lastBubbleAt = 0L
    /** 嘴型合帧：录音线程 50Hz 推上来，只把最后一个值交给主线程，别把 JS 队列灌满。 */
    @Volatile private var mouthLatest = 0f
    @Volatile private var mouthQueued = false

    private var pttActive = false

    /** 这一次按住是「按住说话」（松手发送），不是唤醒词/指令接续的自动开麦。 */
    @Volatile
    private var pttHolding = false

    /** 按住短于这个时间当误触：不发音频，只提示怎么用。 */
    private val HOLD_MIN_MS = 300L
    /** 对话页按住说话期间为 true：唤醒引擎停着，松手再交回去。 */
    @Volatile private var wakePausedByApp = false

    private var turnActive = false
    private var speaking = false

    /**
     * 服务已销毁：晚到的 TTS/ASR/派发回调一律作废。
     * 不能只看类上的 `alive`——它会在新服务实例起来时又变 true，旧实例的迟到回调会打到新实例的窗口上。
     */
    @Volatile private var destroyed = false

    /* ---------------- 「说到停」连续对话 ---------------- */
    /** 悬浮窗这条路上，一轮说完自动回 listening；连续两轮没听清/被拖动/熄屏/后台超时才退出。 */
    private var continuous = false
    /** 连续空识别轮数（ASR 空 / 全程没人声都算）。 */
    private var emptyRounds = 0
    private var listenStartedAt = 0L
    /** 服务在后台的起始时刻（0 = 前台），连续对话时每 10s 查一次，超 60s 停麦。 */
    private var bgSince = 0L
    /** 这一次开麦的时刻：8s 内一直没人声就回待机（0 = 没开麦）。 */
    private var autoListenSince = 0L
    /** 这一串连续对话里已经自动续上的轮数；满 MAX_AUTO_ROUNDS 就停，别自己跟自己聊。 */
    private var autoRounds = 0
    private var turn: PetTurn? = null
    private var lastMouth = -1f

    /** 每次开口递增：`/api/command` 的回包只在还是同一轮时才生效（用户可能已经重新点我）。 */
    private var commandGen = 0

    /** 上一次「连点打断」的时刻：900ms 内的后续点按只回执，不打断也不新建一轮。 */
    private var lastPreemptAt = 0L

    /** 上一次弹「按住说话」提示的时刻：连点十下不该念十遍。 */
    private var lastHintAt = 0L

    /** 同一句提示的最小间隔：够用户看完一轮，又不至于连点两下就憋着不说。 */
    private val HINT_MIN_GAP = 2000L

    /** 宿主播报队列的拉取间隔；一次最多上屏几条（多了会把气泡挤成走马灯）。 */
    private val SAY_POLL_MS = 1500L
    private val SAY_MAX_PER_POLL = 3

    /**
     * 本地待上屏的句子。连发时别把 3 句塞进同一帧互相覆盖——一句给足气泡停留时间，
     * 说完再上下一句；队列满了就不动游标，让宿主那边留着下轮再取。
     */
    private val SAY_QUEUE_MAX = 6

    /** 本次按下只给回执（连点第二下起）：UP 时不要走 finishPtt。 */
    private var receiptOnly = false

    /** 宿主面板上的称呼（`GET /api/state` → `pet.wakeName`）；空 = 还没拿到，用本地配对时存的值。 */
    private var hostWakeName = ""
    private var hostStateAt = 0L
    private var hostTick: Runnable? = null

    /** 宿主 `POST /api/say` 的播报队列：游标 = 已经上过气泡的最大 seq，-1 = 先对齐不回放。 */
    private var sayCursor = -1L
    private var sayPollOn = false
    private var sayPollBusy = false

    /** 点一下说话：手机只负责录音，识别交给宿主 whisper（真机常没有系统识别器）。 */
    private val recorder by lazy { VoiceRecorder() }

    /** 后台查更新只跑一次（每进程），别每次 START 都发一遍请求。 */
    private var updateJobStarted = false

    /* 触摸 / 拖动（拖动按 ~60fps 合并，不每个 MOVE 都 updateViewLayout） */
    private var downRawX = 0f
    private var downRawY = 0f
    private var downAt = 0L
    private var dragging = false
    private var turnStartAt = 0L
    private var firstSentenceAt = 0L
    private var firstSoundLogged = false
    private var dragBaseX = 0
    private var dragBaseY = 0
    private var pendingX = 0
    private var pendingY = 0
    private var dragFlushScheduled = false

    private val mouthTick = object : Runnable {
        override fun run() {
            if (!speaking) return
            val v = tts.mouth()
            if (abs(v - lastMouth) >= 0.15f || v == 0f) {
                lastMouth = v
                setMouth(v)
            }
            main.postDelayed(this, 200)
        }
    }

    /** 仅 debug 构建：adb 广播触发一轮真实对话，用来验收 thinking/talking 动画与气泡。 */
    private val debugReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val text = intent.getStringExtra("text")?.trim().orEmpty()
            when (intent.action) {
                ACTION_DEBUG_TURN -> if (text.isNotBlank()) {
                    tts.stopAll()
                    turn?.cancel()
                    beginTurn(text)
                }

                ACTION_DEBUG_MODE -> if (text.isNotBlank()) setMode(text)
                ACTION_DEBUG_SAY -> say(text)
                ACTION_DEBUG_PAUSE -> if (text == "on") web?.pauseTimers() else web?.resumeTimers()
                ACTION_DEBUG_EVAL -> if (text.isNotBlank()) web?.evaluateJavascript(text) { r -> Log.i("PetEval", r ?: "null") }
            }
        }
    }

        /** 命中缓存就立刻出声的填充句；预取深度 2，等真回答时它已经播完了。 */
    private val FILLERS = listOf("嗯，我看看", "好的呀")

    private val wm by lazy { getSystemService(WindowManager::class.java) }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    pauseRendering()
                    stopSayPoll() // 熄屏不拉播报：省无线电唤醒
                    wake.stop() // 熄屏不常听：麦克风不能长期被占
                    stopContinuous("熄屏")
                }

                Intent.ACTION_SCREEN_ON -> {
                    resumeRendering()
                    startSayPoll()
                    main.postDelayed({ maybeStartWake() }, 1200)
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        alive = true
        inst = this
        cfg = PetSettings.load(this)
        client = PetClient { cfg }
        asr = NativeAsr(this)
        wake = WakeWordEngines.create(this)
        wake.setListener { hit -> main.post { onWake(hit) } }
        tts = TtsPlayer(this, client, { cfg }, ::onSpeakingChanged, ::onTtsError, ::onTtsDrained)
        tts.prewarm(FILLERS) // 口头填充句先合成好，宿主一句要 0.9s+，不能让用户干等
        createChannel()
        AppForeground.onChange = { on -> main.post { applyAppForeground(on) } }
        // 401 = 这台手机的令牌跟宿主对不上：说一句，别让「按住说话没反应」变成哑谜。
        AuthWatch.onUnauthorized = {
            AuthWatch.remember(this)
            main.post { hintOnce("配对失效了 · 打开鲸灵重新扫码") }
        }
        if (AuthWatch.pending(this)) main.post { hintOnce("配对失效了 · 打开鲸灵重新扫码") }
        registerScreenReceiver()
        if (BuildConfig.DEBUG) {
            try {
                val f = IntentFilter().apply {
                    addAction(ACTION_DEBUG_TURN)
                    addAction(ACTION_DEBUG_MODE)
                    addAction(ACTION_DEBUG_SAY)
                    addAction(ACTION_DEBUG_PAUSE)
                    addAction(ACTION_DEBUG_EVAL)
                }
                if (Build.VERSION.SDK_INT >= 33) {
                    registerReceiver(debugReceiver, f, Context.RECEIVER_EXPORTED)
                } else {
                    @Suppress("UnspecifiedRegisterReceiverFlag")
                    registerReceiver(debugReceiver, f)
                }
            } catch (_: Exception) {
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        if (action == ACTION_MIC_RESULT) {
            // 这条分支可能是「进程被系统回收后用户点通知/小人授权」重新拉起的服务：
            // 必须先把前台身份和悬浮窗补上，否则拒绝分支会既没窗口也没前台身份，
            // 服务随即被系统收掉（实测 dumpsys window 里 com.whale.pet} 计数变 0、通知也消失）。
            if (!startAsForeground(mic = false)) {
                stopSelf()
                return START_NOT_STICKY
            }
            applyConfigIfChanged()
            ensureOverlay()
            applyDisplayMode()
            val granted = intent?.getBooleanExtra(EXTRA_MIC_GRANTED, false) == true
            if (granted) {
                updateNotification(getString(R.string.notif_text))
                say("听见你啦，按住说话")
                // 按住说话由手指决定，授权回来不替他开麦（没按住就开麦会录进环境音）
            } else {
                updateNotification("按住说话 · 缺麦克风权限")
                say("没有麦克风")
                openSettings()
            }
            return START_STICKY
        }
        if (action == ACTION_HIDE || action == ACTION_SHOW) {
            // 用户/本应用明确要收起时停掉桌面轮询，否则 1.2s 后又被拉出来
            if (action == ACTION_SHOW) {
                setPetVisible(true)
                applyDisplayMode()
            } else {
                // 用户收起小人（含打开本 App）：立刻结束自动重听，且不偷偷把麦克风再抢回来
                stopContinuous("收起", resumeWake = false)
                stopHomeWatch()
                setPetVisible(false)
            }
            return START_STICKY
        }
        if (action == ACTION_STOP) {
            quitAll()
            return START_NOT_STICKY
        }
        // 对话页按住说话时临时让出麦克风：录音和唤醒引擎不能同时占着
        if (action == ACTION_WAKE_PAUSE) {
            wakePausedByApp = true
            wake.stop()
            return START_STICKY
        }
        if (action == ACTION_WAKE_RESUME) {
            wakePausedByApp = false
            maybeStartWake()
            return START_STICKY
        }
        if (action == ACTION_REFRESH_OUTFIT) {
            // 只推一次换装：pageReady 之前到达的消息丢掉也无所谓，onPageFinished 会补一次。
            // 必须重读配置：这条 action 进来时 cfg 还是启动时的旧快照，直接推会让悬浮窗一直穿旧衣服。
            applyConfigIfChanged()
            Log.i("PetOutfit", "收到换装推送 ready=$pageReady outfit=${cfg.outfit}")
            applyOutfit()
            return START_STICKY
        }
        if (action == ACTION_REFRESH) {
            if (!startAsForeground(mic = false)) {
                stopSelf()
                return START_NOT_STICKY
            }
            applyConfigIfChanged()
            applyPetState()
            ensureOverlay()
            applyDisplayMode()
            return START_STICKY
        }
        // 只有用户自己点「立即对话」才用 microphone 类型；
        // 开机恢复 / 系统 START_STICKY 拉回一律走 specialUse（Android 14+ 禁止后台起麦克风前台服务）。
        val restored = action != ACTION_START
        if (!startAsForeground(mic = !restored)) {
            stopSelf()
            return START_NOT_STICKY
        }
        applyConfigIfChanged()
        ensureOverlay()
        startHostStateTick()
        applyDisplayMode()
        maybeAutoUpdate()
        if (restored) {
            updateNotification("按住说话")
        } else {
            main.postDelayed({ maybeStartWake() }, 600)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (Build.VERSION.SDK_INT < 31 && cfg.ready && Settings.canDrawOverlays(this)) {
            try {
                val pi = PendingIntent.getService(
                    this,
                    7,
                    Intent(this, FloatingPetService::class.java).setAction(ACTION_START),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT,
                )
                val am = getSystemService(AlarmManager::class.java)
                am.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + 2000, pi)
            } catch (_: Exception) {
            }
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        destroyed = true
        alive = false
        if (inst === this) inst = null
        if (AppForeground.onChange != null) AppForeground.onChange = null
        stopContinuous("服务结束")
        stopSayPoll()
        stopTicker()
        try {
            recorder.stop()
        } catch (_: Exception) {
        }
        turn?.cancel()
        asr.cancel()
        wake.stop()
        main.removeCallbacksAndMessages(null)
        tts.release()
        try {
            unregisterReceiver(screenReceiver)
        } catch (_: Exception) {
        }
        if (BuildConfig.DEBUG) {
            try {
                unregisterReceiver(debugReceiver)
            } catch (_: Exception) {
            }
        }
        root?.let { v ->
            try {
                wm.removeView(v)
            } catch (_: Exception) {
            }
        }
        web?.destroy()
        web = null
        root = null
        super.onDestroy()
    }

    /** 只切可见性，不动窗口：重新 addView 会重建 WebView 表面，容易闪一下。 */
    private fun setPetVisible(show: Boolean) {
        if (root == null) return
        if (show) {
            if (root?.visibility == View.VISIBLE) return
            root?.visibility = View.VISIBLE
            maybeStartWake()
        } else {
            if (root?.visibility != View.VISIBLE) return
            root?.visibility = View.GONE
            wake.stop()
        }
    }

    /* ---------------- 显示方式：只在桌面 ---------------- */

    /**
     * home 模式：每 1200ms 看一眼最近的前台应用，是桌面就显示、不是就收起。
     * 只切 visibility（复用 setPetVisible），不 removeView、不停 ticker：
     * 回桌面时动画状态原样接上，不会从第一帧重播，也不会闪。
     * 没有「查看使用情况」权限时按「一直显示」处理，不能把小人整个藏没。
     */
    private fun applyDisplayMode() {
        if (root == null) return
        if (cfg.displayMode != "home" || !UsageAccess.granted(this)) {
            stopHomeWatch()
            setPetVisible(true)
            return
        }
        startHomeWatch()
        foregroundIsLauncher()?.let { onLauncherChanged(it) }
    }

    private fun startHomeWatch() {
        if (homeWatchOn) return
        homeWatchOn = true
        main.post(homeWatch)
    }

    private fun stopHomeWatch() {
        if (!homeWatchOn) return
        homeWatchOn = false
        main.removeCallbacks(homeWatch)
    }

    private val homeWatch = object : Runnable {
        override fun run() {
            if (!homeWatchOn) return
            if (root == null) {
                homeWatchOn = false
                return
            }
            foregroundIsLauncher()?.let { onLauncherChanged(it) }
            main.postDelayed(this, HOME_POLL_MS)
        }
    }

    private fun onLauncherChanged(launcher: Boolean) {
        val nowMs = SystemClock.elapsedRealtime()
        val sinceMs = if (lastLauncherFlipAt == 0L) -1L else nowMs - lastLauncherFlipAt
        lastLauncherFlipAt = nowMs
        if (launcher) {
            if (root?.visibility != View.VISIBLE) Log.i("PetDisplay", "回到桌面 → 显示")
            Log.d("PetDisplay", "回到桌面 ms=$sinceMs")
            setPetVisible(true)
        } else {
            if (root?.visibility == View.VISIBLE) Log.i("PetDisplay", "离开桌面 → 收起")
            Log.d("PetDisplay", "离开桌面 ms=$sinceMs")
            setPetVisible(false)
        }
    }

    /**
     * 最近一条前台事件是不是桌面。
     * null = 5 分钟内查不到前台事件（刚开机 / ROM 限流），保持现状，别乱切。
     */
    private fun foregroundIsLauncher(): Boolean? {
        val usm = getSystemService(UsageStatsManager::class.java) ?: return null
        val end = System.currentTimeMillis()
        val events = try {
            usm.queryEvents(end - 5 * 60_000L, end)
        } catch (_: Exception) {
            return null
        } ?: return null
        val e = UsageEvents.Event()
        var pkg = ""
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            if (e.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND) pkg = e.packageName.orEmpty()
        }
        if (pkg.isEmpty()) return null
        // 本应用自己的 Activity 在前台时也算「不在桌面」
        if (pkg == packageName) return false
        return launchers().contains(pkg)
    }

    private fun launchers(): Set<String> {
        launcherPackages?.let { return it }
        val set = LinkedHashSet<String>()
        try {
            val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
            packageManager.queryIntentActivities(home, 0).forEach { ri ->
                ri.activityInfo?.packageName?.let { set.add(it) }
            }
        } catch (_: Exception) {
        }
        if (set.isEmpty()) Log.w("PetDisplay", "没解析到桌面包名")
        launcherPackages = set
        return set
    }

    /* ---------------- 配置 ---------------- */

    private fun applyConfigIfChanged() {
        val fresh = PetSettings.load(this)
        val tokenChanged = fresh.baseUrl != cfg.baseUrl || fresh.token != cfg.token || fresh.preset != cfg.preset
        val lookChanged = fresh.wakeName != cfg.wakeName || fresh.spriteSize != cfg.spriteSize
        cfg = fresh
        if (tokenChanged) {
            client = PetClient { cfg }
            tts.release()
            tts = TtsPlayer(this, client, { cfg }, ::onSpeakingChanged, ::onTtsError, ::onTtsDrained)
        tts.prewarm(FILLERS)
        }
        if (lookChanged) applyWindowSize()
        syncHostState()
        // 常听开关可能刚被改：关掉立即停麦克风，打开则此刻就起（仍受「待机 + 可见」约束）
        if (!cfg.wakeEnabled) wake.stop() else maybeStartWake()
    }

    /**
     * 面板上的称呼才是真称呼：`GET /api/state` 的 `pet.wakeName` 改了以后，
     * 唤醒词和气泡里的名字都得跟着换，不能只在配对那一刻取一次本地值。
     * 30s 一次，失败下一分钟再试；只读 state，不写任何配置。
     */
    private fun syncHostState() {
        if (!cfg.ready) return
        val now = SystemClock.elapsedRealtime()
        if (now - hostStateAt < 30_000L) return
        hostStateAt = now
        val snapshot = cfg
        Thread({
            val r = try { PetClient { snapshot }.state() } catch (e: Exception) {
                Log.i("PetWake", "读宿主称呼异常 ${e.javaClass.simpleName}: ${e.message?.take(90)}")
                null
            }
            val name = r?.json?.optJSONObject("pet")?.optString("wakeName").orEmpty().trim()
            main.post {
                if (destroyed) return@post
                if (name.isEmpty()) {
                    hostStateAt = 0L
                    if (r == null || !r.ok) Log.i("PetWake", "读宿主称呼失败 code=${r?.code ?: -1}")
                } else {
                    Log.i("PetWake", "读到称呼=$name")
                    applyHostWakeName(name)
                }
            }
        }, "pet-host-state").apply { isDaemon = true }.start()
    }

    /**
     * 气泡说一句：宿主 `POST /api/say` 只把句子放进队列，不往手机推流，所以这里每
     * [SAY_POLL_MS] 拉一次 `GET /api/say?since=`，把游标推到返回值里的 cursor。
     * 首次用 -1 只对齐（不回放历史），同一条不会重复上屏；熄屏/服务结束都停。
     */
    private fun startSayPoll() {
        if (sayPollOn) return
        sayPollOn = true
        Log.i("PetSay", "开始取播报 cursor=$sayCursor")
        main.postDelayed(sayPoll, SAY_POLL_MS)
    }

    private fun stopSayPoll() {
        if (!sayPollOn) return
        sayPollOn = false
        sayPollBusy = false
        main.removeCallbacks(sayPoll)
        Log.i("PetSay", "停止取播报（排队 ${sayQueue.size} 句）")
    }

    private val sayPoll = object : Runnable {
        override fun run() {
            if (!sayPollOn || destroyed) return
            if (!sayPollBusy && pageReady && cfg.ready) pollSay()
            main.postDelayed(this, if (pageReady) SAY_POLL_MS else 3000L)
        }
    }

    private fun pollSay() {
        val snapshot = cfg
        sayPollBusy = true
        Thread({
            val r = try {
                PetClient { snapshot }.say(sayCursor)
            } catch (e: Exception) {
                Log.i("PetSay", "取播报异常 ${e.javaClass.simpleName}: ${e.message?.take(90)}")
                null
            }
            main.post {
                sayPollBusy = false
                if (destroyed) return@post
                val json = r?.json ?: return@post
                val items = json.optJSONArray("items")
                var accepted = 0
                var consumed = -1L
                if (items != null) {
                    for (i in 0 until items.length()) {
                        if (accepted >= SAY_MAX_PER_POLL) break
                        val o = items.optJSONObject(i) ?: continue
                        val text = o.optString("text").orEmpty().trim()
                        if (text.isNotEmpty()) {
                            if (!offerSay(text) && !appFg) break   // 本地队列满：这句留在宿主那边下轮再取
                            if (!appFg) accepted += 1
                        }
                        val seq = o.optLong("seq", -1L)
                        if (seq > consumed) consumed = seq
                    }
                }
                // 游标只推到自己真正取到的那条：宿主返回的 cursor 是整批的尾巴，
                // 连发超过 SAY_MAX_PER_POLL 时直接用它会把没搬的中间几句永久跳过。
                if (consumed > sayCursor) {
                    sayCursor = consumed
                } else if (items == null || items.length() == 0) {
                    val cursor = json.optLong("cursor", sayCursor)
                    if (cursor > sayCursor) sayCursor = cursor
                }
                if (accepted > 0) Log.i("PetSay", "气泡收下 $accepted 条 cursor=$sayCursor")
            }
        }, "pet-say").apply { isDaemon = true }.start()
    }

    /**
     * 面板上改称呼后不该等用户点一下才生效：常驻时每分钟读一次 state
     * （syncHostState 自带宽 30s 闸），失败下一分钟自然重试。
     */
    private fun startHostStateTick() {
        if (hostTick != null) return
        val r = object : Runnable {
            override fun run() {
                if (destroyed) return
                syncHostState()
                main.postDelayed(this, 60_000L)
            }
        }
        hostTick = r
        main.postDelayed(r, 60_000L)
    }

    private fun applyHostWakeName(name: String) {
        if (destroyed || name == hostWakeName) return
        hostWakeName = name
        Log.i("PetWake", "宿主称呼=$name 唤醒词=${wakeWords().joinToString("|")}")
        eval("window.PetBridge&&PetBridge.setWho(${JSONObject.quote(who())})")
        // 唤醒词集合变了：正在常听就重启引擎，否则新称呼叫不动
        if (cfg.wakeEnabled) {
            wake.stop()
            main.postDelayed({ if (!destroyed) maybeStartWake() }, 400)
        }
    }

    /* ---------------- 悬浮窗 ---------------- */

    private fun ensureOverlay() {
        if (root != null) return
        if (!Settings.canDrawOverlays(this)) {
            updateNotification("缺少悬浮窗权限")
            return
        }
        val v = LayoutInflater.from(this).inflate(R.layout.overlay_pet, null)
        v.setBackgroundColor(Color.TRANSPARENT)
        root = v
        web = v.findViewById(R.id.web)
        setupWeb()
        // WebView 会自己吃掉 DOWN（即使 isClickable=false），触摸监听必须挂在它身上；
        // 根 FrameLayout 再兜一层，防止以后加子视图漏事件。
        web?.setOnTouchListener { _, ev -> handleTouch(ev) }
        v.setOnTouchListener { _, ev -> handleTouch(ev) }

        val size = cfg.spriteSize.coerceIn(120, 200)
        // 高度 = 本体 + 48dp：上面这 48dp 是气泡区，保证气泡底边不压发顶
        val p = WindowManager.LayoutParams(
            dp(size),
            dp(size + 48),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            // 输入法弹出时不让系统平移悬浮窗：平移后它会正好压在对话页的输入行上，
            // 把「发送」挡住（点下去被悬浮窗吃掉）。
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
            val dm = resources.displayMetrics
            x = (dm.widthPixels - dp(size) - dp(8)).coerceAtLeast(0)
            y = (dm.heightPixels - dp(size + 48) - dp(112)).coerceAtLeast(0)
        }
        params = p
        applyAppForeground(AppForeground.visible)
        try {
            wm.addView(v, p)
        } catch (e: Exception) {
            root = null
            web = null
            updateNotification("悬浮窗添加失败：${e.javaClass.simpleName}")
            stopSelf()
        }
    }

    /** 自己的界面在前台时把悬浮窗收起，免得盖住对话页的字；同时设成不可触摸，别偷偷吃掉点击。 */
    private fun applyAppForeground(on: Boolean) {
        val v = root ?: return
        appFg = on
        v.visibility = if (on) android.view.View.GONE else android.view.View.VISIBLE
        val p = params ?: return
        p.flags = if (on) {
            p.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        } else {
            p.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        }
        runCatching { wm.updateViewLayout(v, p) }
        // 在 App 里打字问的那句，回答落到桌面上再讲：等窗口真的重新可见再上屏。
        if (!on) pendingSay?.let { text ->
            pendingSay = null
            Log.i("PetSay", "回桌面补上屏 ${text.length} 字")
            main.postDelayed({ offerSay(text) }, 250L)
        } else if (sayQueue.isNotEmpty()) {
            // 切到前台气泡就看不见了，排队的句子不用再补；最新的回答走 pendingSay 那条路。
            Log.i("PetSay", "切到前台，丢掉排队 ${sayQueue.size} 句")
            sayQueue.clear()
            sayPump?.let { main.removeCallbacks(it) }
            sayPump = null
        }
    }

    /**
     * 气泡统一入口：前台时先挂起，回来再上屏，避免「问了看不见」或「回来看不到」。
     * 返回 true 表示收下并且会真的上屏（可能还排在当前这句后面），false 表示挂起/丢弃/队列满。
     */
    private fun offerSay(text: String): Boolean {
        val body = text.trim()
        if (body.isEmpty() || destroyed) return false
        if (appFg) {
            pendingSay = body
            Log.i("PetSay", "气泡挂起 ${body.length} 字（App 在前台，回桌面再上屏）")
            return false
        }
        if (sayQueue.size >= SAY_QUEUE_MAX) {
            // 队列满就让它留在宿主队列里：游标不前推，下一轮还能取到这句。
            Log.i("PetSay", "气球队列满 ${SAY_QUEUE_MAX} 句，这句留到下一轮")
            return false
        }
        sayQueue.addLast(body)
        pumpSay()
        return true
    }

    /** 跟 `boot.js` 里的停留公式一致：短句 3.2 s 起，越长越久，封顶 9 s。 */
    private fun bubbleDwell(len: Int): Long = minOf(9000L, 3200L + len * 90L)

    /**
     * 一句一句上屏：上一句还没到该走的时候，就等它走完再上下一句。
     * 连发多句时这样每句都看得见，而不是 3 句挤在同一帧里只留最后一句。
     */
    private fun pumpSay() {
        if (destroyed || appFg) return
        val now = SystemClock.elapsedRealtime()
        if (now < sayBusyUntil) {
            if (sayPump == null) {
                val r = Runnable { sayPump = null; pumpSay() }
                sayPump = r
                main.postDelayed(r, sayBusyUntil - now + 120L)
            }
            return
        }
        val text = sayQueue.removeFirstOrNull() ?: return
        sayBusyUntil = now + bubbleDwell(text.length)
        Log.i("PetSay", "气泡上屏 ${text.length} 字（还剩 ${sayQueue.size} 句）")
        say(text)
        if (sayQueue.isNotEmpty()) {
            val r = Runnable { sayPump = null; pumpSay() }
            sayPump = r
            main.postDelayed(r, sayBusyUntil - SystemClock.elapsedRealtime() + 120L)
        }
    }

    private fun setupWeb() {
        val w = web ?: return
        w.setBackgroundColor(Color.TRANSPARENT)
        // 透明悬浮窗里的 WebView 会被当后台降频：把渲染进程提到 IMPORTANT 并要求常开计时器，
        // 否则 setTimeout/rAF 会掉到 1s 一跳，看起来就是「动作卡住」。
        runCatching { w.setRendererPriorityPolicy(android.webkit.WebView.RENDERER_PRIORITY_IMPORTANT, false) }
        w.resumeTimers()
        // 透明 WebView 不能挂硬件层：层被重建时先清成不透明黑，就是我们看到的「黑一块」
        w.setLayerType(View.LAYER_TYPE_NONE, null)
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = false
        w.settings.mediaPlaybackRequiresUserGesture = false
        // 系统字号调大不该把气泡撑出卡片：布局像素固定成 100%，跟随系统会让三行变四行再被裁。
        w.settings.textZoom = 100
        w.settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
        w.settings.setSupportZoom(false)
        w.settings.builtInZoomControls = false
        w.isVerticalScrollBarEnabled = false
        w.isHorizontalScrollBarEnabled = false
        w.overScrollMode = View.OVER_SCROLL_NEVER
        // 触摸全部交给原生：WebView 自己不吃点击，否则点不到窗口
        w.isClickable = false
        w.isFocusable = false
        w.isLongClickable = false
        try {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        } catch (_: Exception) {
        }
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                applyPetState()
                startTicker()
                startSayPoll()
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage?): Boolean {
                // 页面里的报错进日志，排查形象不显示用
                val lv = m?.messageLevel()
                if (lv == ConsoleMessage.MessageLevel.ERROR || lv == ConsoleMessage.MessageLevel.WARNING) {
                    Log.w("PetJs", (lv.toString()) + " " + (m?.message() ?: ""))
                }
                return true
            }
        }
        startFadeProbe(w)
        w.loadUrl("file:///android_asset/pet/index.html")
    }

    /**
     * 动作交接探针：每秒问一次页面「刚才那次淡化多久、采了几帧」，
     * 有变化才进日志。只为排查「动作切换跳闪」，不上屏。
     */
    private fun startFadeProbe(w: WebView) {
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        var lastKey = ""
        val probe = object : Runnable {
            override fun run() {
                if (!alive || web == null) return
                // 一次取完整快照：分两次读中间状态会变
                w.evaluateJavascript(
                    "(function(){var d=window.__petDebug?window.__petDebug():null;" +
                        "var f=window.__petLastFade;var v=d&&d.v3?d.v3:null;" +
                        "var p=v?(v.on?'v3 '+v.key+' '+v.action:(v.failed?'fallback '+v.failed:'off')):'off';" +
                        "var fr=v&&v.on?v.frame:'';" +
                        "return JSON.stringify(d?{c:d.canvas,k:d.clip,n:d.fade,d:d.fadeDur,s:f?f.samples:[],o:d.outfit,p:p,f:fr}:null)})()",
                ) { raw ->
                    val json = raw?.trim()?.removeSurrounding("\"")?.replace("\\\"", "\"") ?: ""
                    val o = try { JSONObject(json) } catch (e: Exception) { null }
                    val outfit = o?.optString("o").orEmpty().ifEmpty { "jelly" }
                    val sprite = o?.optString("p").orEmpty().ifEmpty { "off" }
                    val frameName = o?.optString("f").orEmpty()
                    // 逐帧变化不重复打：只按「服装 / 动作 / 片段 / 淡化次数」变化才落一行
                    val key = listOf(outfit, sprite, o?.optString("k").orEmpty(), o?.optString("n").orEmpty())
                        .joinToString("|")
                    if (json.isNotEmpty() && json != "null" && key != lastKey) {
                        lastKey = key
                        Log.i("PetSprite", "sprite o=$outfit v3=$sprite frame=$frameName k=" +
                            (o?.optString("k").orEmpty()) + " fade=" + json)
                    }
                }
                handler.postDelayed(this, 800)
            }
        }
        Log.i("PetSprite", "probe start")
        handler.postDelayed(probe, 1200)
    }

    private fun applyWindowSize() {
        val p = params ?: return
        val v = root ?: return
        val size = cfg.spriteSize.coerceIn(120, 200)
        p.width = dp(size)
        p.height = dp(size + 48)
        val dm = resources.displayMetrics
        p.x = p.x.coerceIn(0, (dm.widthPixels - p.width).coerceAtLeast(0))
        p.y = p.y.coerceIn(0, (dm.heightPixels - p.height).coerceAtLeast(0))
        try {
            wm.updateViewLayout(v, p)
        } catch (_: Exception) {
        }
        applyPetState()
    }

    /* ---------------- 触摸 ---------------- */

    private fun handleTouch(ev: MotionEvent): Boolean {
        val threshold = dp(8).toFloat()
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downRawX = ev.rawX
                downRawY = ev.rawY
                downAt = SystemClock.elapsedRealtime()
                dragging = false
                receiptOnly = false
                params?.let {
                    dragBaseX = it.x
                    dragBaseY = it.y
                }
                // 按下去就有反馈（震动 + 立刻做反应），别等 UP 才动：按住说话要马上进 listening
                haptic(HapticFeedbackConstants.CLOCK_TICK)
                evalAck("按住", "window.PetBridge&&PetBridge.action('tap')")
                if (cfg.ready) {
                    // 微信式按住说话：DOWN 就开录，不等 VAD 判定、也不等 700ms 尾静音
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastPreemptAt < 900L) {
                        // 连点第二下起只给回执：不打断、不新建一轮、也不排进队列
                        Log.i(
                            "PetTap",
                            "连点收口：${now - lastPreemptAt}ms 内第二下只回执 turn=$turnActive speaking=$speaking tts=${tts.busy}",
                        )
                        receiptOnly = true
                        say("等等，还在回")
                        return true
                    }
                    // 记在放行之后、与有没有在回无关：空闲时连点两下同样是「第二下只回执」，
                    // 以前只在打断分支里记时间，空闲连点永远进不了收口，第二下会再起一轮。
                    lastPreemptAt = now
                    if (turnActive || speaking || tts.busy) {
                        Log.i("PetTap", "连点：打断上一轮 turn=$turnActive speaking=$speaking tts=${tts.busy}")
                        turn?.cancel()
                        turnActive = false
                        tts.stopAll()
                        speaking = false
                    }
                    startPtt(hold = true)
                }
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                val dx = ev.rawX - downRawX
                val dy = ev.rawY - downRawY
                if (!dragging && hypot(dx, dy) > threshold) {
                    dragging = true
                    // 拖窗不是说话：把这次按住录的那点声音丢掉，别发一段拖动杂音
                    cancelPtt()
                    stopContinuous("拖动悬浮窗")
                    haptic(HapticFeedbackConstants.LONG_PRESS)
                    evalAck("拖动", "window.PetBridge&&PetBridge.setDragging(true)")
                }
                if (dragging) {
                    queueMove((dragBaseX + dx).toInt(), (dragBaseY + dy).toInt())
                }
                return true
            }

            MotionEvent.ACTION_UP -> {
                val held = SystemClock.elapsedRealtime() - downAt
                val wasDragging = dragging
                dragging = false
                if (wasDragging) {
                    eval("window.PetBridge&&PetBridge.setDragging(false)")
                    snapToEdge()
                } else if (!cfg.ready) {
                    openSettings()
                } else if (receiptOnly) {
                    receiptOnly = false
                    Log.i("PetTap", "松手：这一下只回执，没有新的一轮")
                } else {
                    finishPtt(held)
                }
                return true
            }

            MotionEvent.ACTION_CANCEL -> {
                // 系统把手势收走（来电、通知栏、多指）：安全收尾，别留一条永远在录的音
                dragging = false
                receiptOnly = false
                cancelPtt()
                eval("window.PetBridge&&PetBridge.setDragging(false)")
                return true
            }
        }
        return true
    }

    private fun haptic(kind: Int) {
        try {
            root?.performHapticFeedback(kind)
        } catch (_: Exception) {
        }
    }

    /** 拖到屏幕边上松手：吸附到最近一侧。停在离边 5dp 的地方最难受，要么进要么出。 */
    private fun snapToEdge() {
        val p = params ?: return
        val v = root ?: return
        val dm = resources.displayMetrics
        val edge = dp(16)
        val targetX = when {
            p.x < edge -> 0
            dm.widthPixels - (p.x + p.width) < edge -> dm.widthPixels - p.width
            else -> return
        }
        if (targetX == p.x) return
        val startX = p.x
        val steps = 6
        var i = 1
        val runner = object : Runnable {
            override fun run() {
                val f = i / steps.toFloat()
                val eased = 1f - (1f - f) * (1f - f) // ease-out：收尾不硬撞
                p.x = (startX + (targetX - startX) * eased).toInt()
                try {
                    wm.updateViewLayout(v, p)
                } catch (_: Exception) {
                }
                if (i++ < steps) main.postDelayed(this, 16)
            }
        }
        main.postDelayed(runner, 16)
    }

    private fun queueMove(x: Int, y: Int) {
        pendingX = x
        pendingY = y
        if (dragFlushScheduled) return
        dragFlushScheduled = true
        // 16ms 合并一次 = 最多 ~60fps，拖动时不会每个 MOVE 都 requestLayout
        main.postDelayed({ dragFlushScheduled = false; flushMove() }, 16)
    }

    private fun flushMove() {
        val p = params ?: return
        val v = root ?: return
        val dm = resources.displayMetrics
        p.x = pendingX.coerceIn(-p.width / 3, (dm.widthPixels - p.width * 2 / 3).coerceAtLeast(0))
        p.y = pendingY.coerceIn(0, (dm.heightPixels - p.height / 3).coerceAtLeast(0))
        try {
            wm.updateViewLayout(v, p)
        } catch (_: Exception) {
        }
    }

    /* ---------------- 渲染桥 ---------------- */

    /**
     * 原生每帧时钟。透明悬浮窗被 Chromium 降频时，JS 的 setTimeout 会拖到 1s 一跳，
     * 这里用 Choreographer（跟着屏幕刷新走）每帧推一次 JS 的看门狗，动作才不会定格。
     */
    private val ticker = object : android.view.Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!alive) return
            if (pageReady) web?.evaluateJavascript("window.__petTick&&window.__petTick()", null)
            android.view.Choreographer.getInstance().postFrameCallback(this)
        }
    }

    private fun startTicker() {
        android.view.Choreographer.getInstance().removeFrameCallback(ticker)
        android.view.Choreographer.getInstance().postFrameCallback(ticker)
    }

    private fun stopTicker() {
        android.view.Choreographer.getInstance().removeFrameCallback(ticker)
    }

    private fun eval(code: String) {
        if (!pageReady) return
        // WebView 只能在主线程调。录音线程的 onLevel 会直接走到这里，
        // 不守卫就是 `A WebView method was called on thread 'pet-recorder'`：整个进程崩掉，
        // 悬浮窗随之消失，MIUI 还拒绝自动重启服务（AutoStartManagerService: Reject RestartService）。
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { eval(code) }
            return
        }
        web?.evaluateJavascript(code, null)
    }

    private fun setMode(mode: String) {
        if (mode != currentMode) Log.i("PetVad", "状态 → $mode")
        currentMode = mode
        eval("window.PetBridge&&PetBridge.setMode(${JSONObject.quote(mode)})")
        eval("window.PetBridge&&PetBridge.setAutoPlay(${mode == "idle"})")
    }

    /** 带往返打点的 eval：用来量「点下去 → JS 开始做动作」的真实延迟。 */
    private fun evalAck(label: String, code: String) {
        if (!pageReady) return
        // 和 eval 同一条规矩：WebView 只认主线程，从后台调就是整进程崩。
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { evalAck(label, code) }
            return
        }
        val sentAt = SystemClock.elapsedRealtime()
        web?.evaluateJavascript(code) { _ ->
            Log.i("PetLatency", "$label→JS 往返 ${SystemClock.elapsedRealtime() - sentAt}ms")
        }
    }

    /** 录音线程调：合并成一帧交给主线程。 */
    private fun postMouth(value: Float) {
        mouthLatest = value
        if (mouthQueued) return
        mouthQueued = true
        main.post {
            mouthQueued = false
            setMouth(mouthLatest)
        }
    }

    private fun setMouth(value: Float) {
        eval("window.PetBridge&&PetBridge.setMouth(${String.format(java.util.Locale.US, "%.2f", value)})")
    }

    private fun say(text: String) {
        eval("window.PetBridge&&PetBridge.say(${JSONObject.quote(text)})")
    }

    /**
     * 误触提示的收口版：同一句话 [HINT_MIN_GAP] 内只弹一次。
     *
     * 连点/快速反复操作时每次短按都会走到「按住说话，松手发送」，不节流就会
     * 一直被同一句提示糊脸；这里只保留第一下，后续只写日志（仍算回执，不静默）。
     */
    private fun hintOnce(text: String) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastHintAt < HINT_MIN_GAP) {
            Log.i("PetTap", "提示收口：${now - lastHintAt}ms 内只回执「$text」")
            return
        }
        lastHintAt = now
        say(text)
    }

    private fun applyPetState() {
        if (!pageReady) return
        eval("window.PetBridge&&PetBridge.setWho(${JSONObject.quote(who())})")
        eval("window.PetBridge&&PetBridge.setMode(${JSONObject.quote(currentMode)})")
        eval("window.PetBridge&&PetBridge.setAutoPlay(${currentMode == "idle"})")
        applyOutfit()
    }

    /** 立绘服装：读当前配置推给页面；空串让页面回到原来的视频素材。 */
    private fun applyOutfit() {
        val key = PetConfig.cleanOutfit(cfg.outfit)
        Log.i("PetOutfit", "推给页面：$key")
        // 页面侧可能还没带 setOutfit（boot.js 未更新时）：守卫一下，别在控制台抛错
        eval("window.PetBridge&&PetBridge.setOutfit&&PetBridge.setOutfit(${JSONObject.quote(key)})")
    }

    private fun who(): String =
        hostWakeName.ifBlank { cfg.wakeName }.ifBlank { PetConfig.DEFAULT_WAKE_NAME }

    private fun pauseRendering() {
        if (webPaused) return
        webPaused = true
        main.removeCallbacks(mouthTick)
        web?.onPause()
    }

    private fun resumeRendering() {
        if (!webPaused) return
        webPaused = false
        web?.onResume()
        if (speaking) main.postDelayed(mouthTick, 200)
    }

    /* ---------------- 交互 ---------------- */

    /**
     * 松手：立刻停录并发送，不等 700ms 尾静音——松手本身就是「我说完了」。
     *
     * 短于 [HOLD_MIN_MS] 的按住当误触，整段没人声的也不送识别：两种都只提示怎么用，
     * 别让宿主识别一段空音频再干等几秒。
     */
    private fun finishPtt(heldMs: Long) {
        pttHolding = false
        if (!pttActive) {
            Log.i("PetTap", "松手：没在录 turn=$turnActive tts=${tts.busy} speaking=$speaking")
            // 录音还没起来就松手了（抢麦失败 / 上一轮还在收尾）：给一句提示就回待机
            if (!turnActive && !tts.busy && !speaking) {
                hintOnce("按住说话，松手发送")
                updateNotification(getString(R.string.notif_text))
            }
            return
        }
        if (heldMs < HOLD_MIN_MS) {
            Log.i("PetTap", "松手：按太短 ${heldMs}ms < ${HOLD_MIN_MS}ms，丢弃这段当误触")
            cancelPtt()
            hintOnce("按住说话，松手发送")
            return
        }
        finishRecording(HOLD_MIN_MS.toInt())
    }

    /** 按住说话被打断（拖动 / 系统收走手势）：停录丢弃，别留一条永不结束的录音。 */
    private fun cancelPtt() {
        pttHolding = false
        if (!pttActive) return
        pttActive = false
        recorder.onAutoStop = null
        recorder.onLevel = null
        try {
            recorder.stop()
        } catch (_: Exception) {
        }
        main.removeCallbacks(noVoiceWatch)
        setMode("idle")
        setMouth(0f)
        updateNotification(getString(R.string.notif_text))
    }

    /** 点一下开始说：AudioRecord 录 WAV → 宿主 `POST /api/asr` 识别；本机识别只作兜底。 */
    private fun startPtt(hold: Boolean = false) {
        Log.i("PetTap", "开麦 hold=$hold turn=$turnActive speaking=$speaking tts=${tts.busy}")
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            // 明确说缺什么，并把授权弹窗直接拉起来；万一被 MIUI「后台弹出界面」拦了，
            // 通知栏也留着这句话，点通知进 App 还能授权。
            updateNotification("缺麦克风权限")
            say("还没有麦克风权限")
            requestMicPermission()
            return
        }
        if (!cfg.ready) {
            updateNotification("还没配对 · 点一下进 App")
            openSettings()
            return
        }
        // 按住说话是一次性的：松手就发，发完回待机，不自动续听（续听会让用户以为又开麦了）
        continuous = !hold
        pttHolding = hold
        emptyRounds = 0
        autoRounds = 0
        autoListenSince = 0L
        main.removeCallbacks(resumeListen)
        main.removeCallbacks(noVoiceWatch)
        if (!hold) startBgWatch()
        turn?.cancel()
        tts.stopAll()
        // 常听唤醒会一直握着 SpeechRecognizer 的麦克风，而 cancel() 是异步 destroy。
        // 立刻开 AudioRecord 在真机上常常抢不到麦克风（录音起来但全是静音，或干脆失败），
        // 表现就是「点了一下没反应、也不说话」。所以先停唤醒，再退避重试几次。
        wake.stop()
        updateNotification(if (hold) "在听 · 松手发送" else "在听 · 说完停一下或再点我")
        beginListening(0)
    }

    /** 抢麦克风：唤醒刚停时先等一小会儿，起不来就退避重试，最后才退回本机识别。 */
    private fun beginListening(attempt: Int) {
        if (!cfg.ready) {
            openSettings()
            return
        }
        // 开机恢复 / START_STICKY / REFRESH 起的都是 specialUse 类型的前台服务，
        // 而 Android 12+ 只允许带 microphone 类型的前台服务在后台录音：缺了这一位，
        // AudioRecord 照常开、帧也照常到，但 PCM 全是 0（AudioService 里标 silenced），
        // 三个录音源各 1s 探测窗全判死 → 3.3s 后收麦，用户看到的就是「麦克风只闪一下」。
        if (attempt == 0 && !ensureMicForeground()) {
            updateNotification("麦克风被系统拦住 · 进 App 再按住我")
            say("麦克风被拦住了，进 App 里按住我")
            stopContinuous("前台服务类型升不上去", resumeWake = false)
            return
        }
        // 播报没结束绝不开麦：TTS 声音会被自己录进去，一问一答变成叠音自激。
        // 判 tts.busy 而不是 speaking：句子之间有一个短暂的空档，那缝隙里开麦一样会录到自己。
        if (tts.busy || speaking) {
            scheduleResume(150)
            return
        }
        // 最后一句刚播完的 600ms 里，房间回声还在，等它散掉。
        if (SystemClock.elapsedRealtime() - tts.lastAudioEndAt < 600L) {
            scheduleResume(150)
            return
        }
        // 自动重听时唤醒引擎可能刚被系统重新拉起过：它攥着麦克风时 AudioRecord 常常起不来
        wake.stop()
        if (recorder.start()) {
            pttActive = true
            listenStartedAt = SystemClock.elapsedRealtime()
            armNoVoiceWatch()
            setMode("listening")
            say("")
            updateNotification(if (pttHolding) "在听 · 松手发送" else "在听 · 说完停一下或再点我")
            recorder.onAutoStop = { main.post { finishRecording() } }
            recorder.onLevel = { v -> if (v > 0.35f) postMouth(v) }
            return
        }
        if (attempt < 3) {
            Log.w(PetCommand.TAG, "AudioRecord 第 ${attempt + 1} 次没起来，220ms 后重试")
            main.postDelayed({ beginListening(attempt + 1) }, 220L)
            return
        }
        if (asr.isAvailable()) {
            updateNotification("录音启动失败 · 改用本机识别")
            startNativePtt()
        } else {
            updateNotification("麦克风打不开 · 按住再试")
            say("麦克风好像被占着，等一下再按住我")
            // 自动重听里起不来就不再自己攒重试：退出连续对话，把唤醒词还回去
            if (continuous) stopContinuous("麦克风打不开") else toIdle()
        }
    }

    /** 收尾：停录 → 上传宿主识别 → 进一轮对话。 */
    private fun finishRecording(minMs: Int = VoiceRecorder.MIN_RECORD_MS) {
        if (!pttActive) return
        pttActive = false
        recorder.onLevel = null
        recorder.onAutoStop = null
        // 松手即发：门槛是「按住了 300ms」；VAD 自动收尾仍用 800ms 的老门槛
        val wav = recorder.stop(minMs)
        val heard = recorder.heardSpeech
        val listenedMs = if (listenStartedAt > 0L) SystemClock.elapsedRealtime() - listenStartedAt else 0L
        // 全程没人声（录音自己按静音收的尾）：6s 静音送去识别没有意义，
        // 先别判失败——8s 到点由 noVoiceWatch 统一回待机并还回唤醒词。
        if (!heard && continuous && autoListenSince > 0L) {
            logVad(listenedMs, heard, 0, false)
            updateNotification(getString(R.string.notif_text))
            return
        }
        if (wav == null) {
            logVad(listenedMs, heard, 0, false)
            // 录音这边知道为什么没声（拿不到帧 / 说得太短），别只写日志——用户在等一个说法。
            val fault = recorder.takeFaultText()
            updateNotification(fault ?: "没听到声音 · 点我再说")
            // 按住说话没录到人声：直接教怎么用，别只留在通知栏里
            if (fault == VoiceRecorder.MSG_TOO_SHORT || fault == VoiceRecorder.MSG_NO_SPEECH) {
                hintOnce("按住说话，松手发送")
            }
            // 点一下就抬手：不算一轮，直接回待机，别自动重听（重听会让用户以为卡住了）。
            if (fault == VoiceRecorder.MSG_TOO_SHORT || fault == VoiceRecorder.MSG_NO_SIGNAL ||
                    fault == VoiceRecorder.MSG_NO_SPEECH) {
                if (continuous) stopContinuous(fault) else toIdle()
            } else {
                emptyRound()
            }
            return
        }
        setMode("thinking")
        updateNotification("在想…")
        // 有人开口了：8s 没人声的看门狗到此为止，后面交给正常的一轮对话
        main.removeCallbacks(noVoiceWatch)
        autoListenSince = 0L
        Thread({
            var res: PetClient.Result? = null
            var err: String? = null
            try {
                res = client.asr(wav)
            } catch (e: Exception) {
                err = e.message ?: e.javaClass.simpleName
            }
            val text = res?.json?.optString("text").orEmpty().trim()
            val ok = res != null && res.ok
            Log.i("PetVoice", "asr http=${res?.code ?: -1} textLen=${text.length} err=${err ?: "-"}")
            main.post {
                if (destroyed) return@post
                when {
                    ok && text.isNotBlank() && rejectAsNoise(text) -> {
                        logVad(listenedMs, heard, 0, false)
                        emptyRound()
                    }
                    ok && text.isNotBlank() -> {
                        emptyRounds = 0
                        logVad(listenedMs, heard, text.length, true)
                        beginTurn(text)
                    }
                    ok && text.isBlank() -> {
                        logVad(listenedMs, heard, 0, continuous && emptyRounds < 1)
                        emptyRound()
                    }
                    // 宿主识别不通：本机有识别器就当场兜底，否则把原因说清楚
                    asr.isAvailable() -> {
                        updateNotification("宿主识别不通 · 用本机识别")
                        startNativePtt()
                    }
                    else -> {
                        toIdle()
                        updateNotification("识别失败 · 按住再试（${res?.code ?: "网络"}）")
                    }
                }
            }
        }, "pet-asr").apply { isDaemon = true; start() }
    }

    /** 兜底：原来的系统 SpeechRecognizer 链路（OEM 机器经常没有识别器，只作后备）。 */
    private fun startNativePtt() {
        if (!asr.isAvailable()) {
            updateNotification("本机没有语音识别服务")
            toIdle()
            return
        }
        pttActive = true
        setMode("listening")
        asr.start(object : NativeAsr.Listener {
            override fun onReady() = Unit

            override fun onPartial(text: String) = Unit

            override fun onFinal(text: String) {
                if (destroyed) return
                pttActive = false
                if (text.isBlank() || rejectAsNoise(text)) {
                    emptyRound()
                    return
                }
                beginTurn(text)
            }

            override fun onError(message: String, code: Int) {
                if (destroyed) return
                if (!pttActive) return
                pttActive = false
                val soft = code == SpeechRecognizer.ERROR_NO_MATCH ||
                    code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                if (!soft) updateNotification("识别失败 · 按住再试")
                flashHappy()
            }

            override fun onEnd() = Unit
        })
    }

    /**
     * 后台查更新（6 小时节流一次）。下载好后在通知里说一声，用户点通知进 App 就会直接弹安装。
     * 不做静默安装：那需要系统签名；覆盖安装由系统安装器弹一次确认，用户知情才能装。
     */
    private fun maybeAutoUpdate() {
        if (updateJobStarted) return
        updateJobStarted = true
        val um = UpdateManager(this, client)
        if (!um.shouldAutoCheck()) return
        Thread({
            um.markChecked()
            val info = try {
                um.check()
            } catch (_: Exception) {
                null
            }
            if (info == null) return@Thread
            Log.i("PetUpdate", "发现新版本 ${info.versionName}(${info.versionCode})")
            val apk = try {
                um.download(info)
            } catch (_: Exception) {
                null
            }
            main.post {
                if (apk == null) {
                    updateNotification("新版 ${info.versionName} 下载失败 · 点我进 App 重试")
                } else {
                    PetSettings.savePendingApk(this, apk.absolutePath, info.versionCode, info.versionName)
                    updateNotification("新版 ${info.versionName} 已就绪 · 点我安装")
                }
            }
        }, "pet-update").apply { isDaemon = true; start() }
    }

    /** 「关掉大肥鱼」：常听/唤醒/录音/TTS/悬浮窗全停，并关掉自启动，避免下次开机又自己起来。 */
    private fun quitAll() {
        try {
            wake.stop()
        } catch (_: Exception) {
        }
        try {
            asr.cancel()
        } catch (_: Exception) {
        }
        try {
            recorder.stop()
        } catch (_: Exception) {
        }
        pttActive = false
        try {
            tts.stopAll()
        } catch (_: Exception) {
        }
        try {
            val c = PetSettings.load(this)
            if (c.autoStart) PetSettings.save(this, c.copy(autoStart = false))
        } catch (_: Exception) {
        }
        try {
            web?.loadUrl("about:blank")
        } catch (_: Exception) {
        }
        try {
            root?.let { wm.removeView(it) }
        } catch (_: Exception) {
        }
        root = null
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (_: Exception) {
        }
        try {
            getSystemService(NotificationManager::class.java).cancel(NOTIF_ID)
        } catch (_: Exception) {
        }
        stopSelf()
    }

    private fun onWake(hit: WakeHit) {
        if (destroyed) return
        if (!cfg.wakeEnabled) return
        if (turnActive || pttActive || speaking || tts.busy) {
            Log.i("PetTap", "唤醒：上一轮没结束，忽略 turn=$turnActive ptt=$pttActive speaking=$speaking tts=${tts.busy}")
            return
        }
        wake.stop() // 呼出后立刻停引擎：别把自己 TTS 的声音当唤醒词（回声自激）
        updateNotification("听到「${hit.word}」")
        continuous = true
        emptyRounds = 0
        autoRounds = 0
        autoListenSince = 0L
        main.removeCallbacks(noVoiceWatch)
        startBgWatch()
        if (hit.rest.isNotBlank()) beginTurn(hit.rest) else startPtt()
    }

    private fun beginTurn(text: String) {
        // 「拍张照」「截个屏」是手机自己的事：先收干净，再拉页面去办，这一轮不进对话
        val snap = SnapCommand.parse(text)
        if (snap != null) {
            tts.stopAll()
            main.removeCallbacks(resumeListen)
            wake.stop()
            if (pttActive) {
                pttActive = false
                recorder.onAutoStop = null
                recorder.onLevel = null
                runCatching { recorder.stop() }
            }
            snapTurn(text, snap)
            return
        }
        tts.stopAll()
        // 打断旧轮时队列可能刚刚排空并排了一次「重开麦」：这一轮马上要说话，取消它
        main.removeCallbacks(resumeListen)
        wake.stop()
        // 连续对话里麦可能还开着（唤醒词带内容直接进对话）：先收干净，播报期间绝不留录音
        if (pttActive) {
            pttActive = false
            recorder.onAutoStop = null
            recorder.onLevel = null
            try {
                recorder.stop()
            } catch (_: Exception) {
            }
        }
        pttActive = false
        turnActive = true
        commandGen++
        turnStartAt = SystemClock.elapsedRealtime()
        firstSentenceAt = 0L
        firstSoundLogged = false
        val gen = commandGen
        // 进入一轮正经回复：自动重听的 8s 看门狗先撤掉（等 afterReply 再重新开麦时再数）
        main.removeCallbacks(noVoiceWatch)
        autoListenSince = 0L
        setMode("thinking")
        say("")
        updateNotification("在想…")
        // 命中预热的「嗯…」立刻开口：宿主合成每句固定 0.9s+，空白等待是「反应慢」的最大来源
        tts.speakCached(FILLERS.first())
        // 先问一句「这是聊天还是指令」：只有 chat / 失败才落到 /api/dispatch。
        Thread({ resolveCommand(text, gen) }, "pet-command").apply { isDaemon = true; start() }
    }

    /**
     * 设备指令（拍照／截屏）：念一句、把对话页拉起来，图和这句话由页面发出去。
     *
     * 不 dispatch：宿主在电脑上，照相机和屏幕都在手机上，宿主办不了这件事。
     */
    private fun snapTurn(text: String, kind: String) {
        turnActive = false
        firstSentenceAt = 0L
        val line = SnapCommand.hint(kind)
        PetHistory.append(this, PetHistory.ROLE_ME, text)
        PetHistory.append(this, PetHistory.ROLE_PET, line)
        setMode("talking")
        say(line)
        updateNotification(line)
        tts.enqueue(line)
        val launched = runCatching {
            startActivity(
                Intent(this, HistoryActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(SnapCommand.EXTRA, kind),
            )
        }.isSuccess
        if (!launched) Log.w(PetCommand.TAG, "设备指令：页面拉不起来")
        main.postDelayed({
            if (!destroyed && !pttActive && !turnActive && !speaking && !tts.busy && currentMode == "talking") {
                afterReply()
            }
        }, 4000)
    }

    /**
     * 语音指令分流（`POST /api/command`）。
     *
     * - chat（say:null）或请求失败/5xx → 静默回退到 `/api/dispatch`，不能让用户说话没反应；
     * - switch / dispatch / stop / *-miss → 只念 `say`，**绝不再 dispatch**（否则双份派发）。
     */
    private fun resolveCommand(text: String, gen: Int) {
        var res: PetClient.Result? = null
        var error: String? = null
        try {
            res = client.command(text)
        } catch (e: Exception) {
            error = e.message ?: e.javaClass.simpleName
        }
        val cmd = if (res != null && res.ok) PetCommand.parse(res.json) else null
        Log.i(PetCommand.TAG, "POST command http=${res?.code ?: -1} action=${cmd?.action ?: "fallback"}")
        Log.i("PetLatency", "指令分流 +${SystemClock.elapsedRealtime() - turnStartAt}ms")
        if (cmd == null) {
            Log.w(PetCommand.TAG, "command 不可用，回退 dispatch：${error ?: res?.error()}")
        }
        if (cmd?.action == "switch") {
            // 切成功顺手记下「现在钉在哪」，主界面项目名才不会停在旧项目上
            try {
                val pinned = client.workspaces().json?.optJSONObject("pinned")?.optString("title").orEmpty()
                if (pinned.isNotBlank()) PetSettings.savePinnedTitle(this, pinned)
            } catch (_: Exception) {
            }
        }
        main.post {
            if (destroyed) return@post
            if (gen != commandGen || !turnActive) return@post
            if (cmd == null || cmd.isChat) {
                startChatTurn(text)
            } else {
                speakCommand(text, cmd)
            }
        }
    }

    /** 普通聊天：原来的 SSE + `/api/dispatch` 一条都不能少。 */
    private fun startChatTurn(text: String) {
        Log.i(PetCommand.TAG, "→ /api/dispatch（仅 chat 路径，指令分支不走这里）")
        turn = PetTurn(client, text, object : PetTurn.Callback {
            override fun onUser(text: String) {
                if (destroyed) return
                PetHistory.append(this@FloatingPetService, PetHistory.ROLE_ME, text)
            }

            override fun onStatus(text: String) = Unit

            override fun onAssistant(fullText: String, isFinal: Boolean) {
                if (destroyed || fullText.isBlank()) return
                if (isFinal) {
                    PetHistory.append(this@FloatingPetService, PetHistory.ROLE_PET, fullText)
                    return
                }
                // 增量出字：气泡跟着流走，别等整段（宿主已按帧回调）。60ms 节流免得 JS 被灌爆。
                val now = SystemClock.elapsedRealtime()
                if (now - lastBubbleAt < 60) return
                lastBubbleAt = now
                // 气泡只显示尾巴：长回复不挤爆窗口（boot.js 本来也只留 90 字）。
                say(fullText.takeLast(72).trimStart('，', '。', '、', ' ', '\n'))
            }

            override fun onSentence(sentence: String) {
                if (destroyed) return
                if (sentence.isBlank()) return
                if (firstSentenceAt == 0L) {
                    firstSentenceAt = SystemClock.elapsedRealtime()
                    Log.i("PetLatency", "首句 +${firstSentenceAt - turnStartAt}ms「${sentence.take(10)}」")
                }
                setMode("talking")
                say(sentence)
                tts.enqueue(sentence)
            }

            override fun onDone() {
                if (destroyed) return
                turnActive = false
                // 不能只看 speaking：最后一句可能还在下载/准备，那时开麦会把自己的下一句录进去；
                // afterReply 用「队列彻底排空」判断，没排空就等 onTtsDrained 再收尾
                afterReply()
            }

            override fun onError(message: String) {
                if (destroyed) return
                turnActive = false
                if (!speaking && !tts.busy) flashHappy()
            }
        }).also { it.start() }
    }

    /** 指令回包只需要念一句（切项目/派发/停/没找到）；不占对话轮，念完自然回待机。 */
    private fun speakCommand(userText: String, cmd: PetCommand) {
        val line = cmd.spoken()
        PetHistory.append(this, PetHistory.ROLE_ME, userText)
        if (line.isBlank()) {
            turnActive = false
            afterReply()
            return
        }
        PetHistory.append(this, PetHistory.ROLE_PET, line)
        turnActive = false
        setMode("talking")
        say(line)
        updateNotification(
            when (cmd.action) {
                "switch" -> "已切到《${cmd.title}》"
                "dispatch" -> "已交给《${cmd.title}》"
                "stop" -> "已停"
                else -> "在说话…"
            },
        )
        tts.enqueue(line)
        // TTS 不可用时也要收尾，别卡在 talking；还在下载/准备时不算收尾完成
        main.postDelayed({
            if (!destroyed && !pttActive && !turnActive && !speaking && !tts.busy &&
                currentMode == "talking"
            ) {
                afterReply()
            }
        }, 4000)
    }

    private fun onSpeakingChanged(value: Boolean) {
        if (destroyed) return
        speaking = value
        if (value) {
            if (turnStartAt > 0L) {
                val label = if (firstSoundLogged) "正文出声" else "首帧出声"
                firstSoundLogged = true
                Log.i("PetLatency", label + " +" + (SystemClock.elapsedRealtime() - turnStartAt) + "ms")
            }
            wake.stop()
            setMode("talking")
            lastMouth = -1f
            main.removeCallbacks(mouthTick)
            main.postDelayed(mouthTick, 200)
            updateNotification("在说话…")
        } else {
            main.removeCallbacks(mouthTick)
            setMouth(0f)
            if (pttActive || turnActive) return
            afterReply()
        }
    }

    /** 失败/没听清：让形象开心一下再回待机，不弹任何窗口内文字。 */
    private fun flashHappy() {
        setMode("happy")
        say("")
        updateNotification("待机 · 按住说话")
        main.postDelayed({
            if (!turnActive && !pttActive && !speaking) toIdle()
        }, 900)
    }

    /** 一轮结束：连续对话就稍等再开麦，否则回待机。 */
    private fun afterReply() {
        if (destroyed) return
        // 还没排空就不能收尾：下载中/等着出声的句子还没响，此刻开麦会把它录回来
        if (tts.busy || speaking) {
            scheduleResume(150)
            return
        }
        if (continuous && cfg.ready) {
            if (autoRounds >= MAX_AUTO_ROUNDS) {
                // 连着自动聊满上限就收手：再往下就是自己跟自己说话了
                Log.i("PetVad", "连续自动对话已达 $MAX_AUTO_ROUNDS 轮，回待机")
                stopContinuous("连续 $MAX_AUTO_ROUNDS 轮")
                return
            }
            autoRounds++
            scheduleResume(200)
        } else {
            toIdle()
        }
    }

    /**
     * TTS 真正排空（含下载、准备和上一轮迟到的回包）时回调。
     *
     * 「上一句放完了」不等于「说完了」：最后一句可能还在下载，服务以前就在这个缝里开麦，
     * 把自己的下一句录进去再发给模型，于是自问自答。排空信号是唯一可靠的开麦时机。
     */
    private fun onTtsDrained() {
        if (destroyed) return
        if (pttActive || turnActive) return
        afterReply()
    }

    /**
     * 自动重听的开麦看门狗：8s 内一直没人声就回待机，把唤醒词还回去。
     *
     * 有人声时让位给录音自己的静音 VAD（它说了算）：那样才是「说完 → 识别 → 下一轮」。
     * 只在「开麦 8s 一个字的动静都没有」时由这里收尾，避免服务一遍遍自己开麦。
     */
    private val noVoiceWatch = Runnable {
        if (destroyed || !continuous) return@Runnable
        if (turnActive || speaking || tts.busy) return@Runnable
        if (pttActive && recorder.heardSpeech) return@Runnable
        Log.i("PetVad", "自动重听 ${NO_VOICE_MS}ms 没人声，回待机")
        NetLog.record("/api/asr", 200, 0L, "vad 自动重听没人声")
        stopContinuous("没人声")
    }

    /** 每次开麦重新数 8s：一串连续对话里每一轮都该有完整的一次机会。 */
    private fun armNoVoiceWatch() {
        main.removeCallbacks(noVoiceWatch)
        if (!continuous) {
            autoListenSince = 0L
            return
        }
        autoListenSince = SystemClock.elapsedRealtime()
        main.postDelayed(noVoiceWatch, NO_VOICE_MS)
    }

    private val resumeListen = Runnable {
        if (destroyed) return@Runnable
        if (!continuous || !cfg.ready) {
            continuous = false
            autoRounds = 0
            autoListenSince = 0L
            main.removeCallbacks(noVoiceWatch)
            // 还没排空就别回待机：toIdle 会 say("") 把气泡收掉，此刻句子还在下载/出声，
            // 用户看到的就是「气泡闪一下就没了」。
            if (tts.busy || speaking) {
                scheduleResume(250)
                return@Runnable
            }
            toIdle()
            return@Runnable
        }
        if (tts.busy || speaking || turnActive || pttActive) {
            scheduleResume(250)
        } else {
            beginListening(0)
        }
    }

    private fun scheduleResume(delayMs: Long) {
        main.removeCallbacks(resumeListen)
        main.postDelayed(resumeListen, delayMs)
    }

    /**
     * 退出连续对话：停麦、停定时器、回待机（idle 就是四态里的「退出」）。
     *
     * `resumeWake = false`：用户自己按收起/暂停时不要偷偷把麦克风再抢回来。
     */
    private fun stopContinuous(reason: String, resumeWake: Boolean = true) {
        if (!continuous) return
        continuous = false
        emptyRounds = 0
        autoRounds = 0
        autoListenSince = 0L
        bgSince = 0L
        main.removeCallbacks(resumeListen)
        main.removeCallbacks(noVoiceWatch)
        main.removeCallbacks(bgWatch)
        if (pttActive) {
            pttActive = false
            recorder.onAutoStop = null
            recorder.onLevel = null
            try {
                recorder.stop()
            } catch (_: Exception) {
            }
        }
        Log.i("PetVad", "停止续听：$reason")
        NetLog.record("/api/asr", 200, 0L, "vad 停止续听：$reason")
        setMode("idle")
        setMouth(0f)
        updateNotification(getString(R.string.notif_text))
        if (resumeWake) maybeStartWake() else wake.stop()
    }

    /** 一轮空识别：第一次留在 listening（还能再说一次），第二次退出到 idle 不亮麦。 */
    private fun emptyRound() {
        emptyRounds++
        if (continuous && emptyRounds < 2) {
            updateNotification("没听清 · 再说一次")
            scheduleResume(300)
            return
        }
        if (!continuous) {
            // 按住说话没有「自动再来一次」：识别空就回待机并教怎么用，别停在「在想…」
            updateNotification("没听清 · 按住再说")
            say("没听清，按住再说")
            main.postDelayed({ if (!turnActive && !pttActive) toIdle() }, 1500)
            return
        }
        val reason = if (emptyRounds >= 2) "连续两轮没听清" else "未在连续对话"
        stopContinuous(reason)
        if (emptyRounds >= 2) flashHappy()
    }

    /** 每轮一条：时长、尾静音、识别字数、是否续听（「诊断」里能直接看到）。 */
    /**
     * 这段识别结果该不该发给模型？
     *
     * 自己刚说的话被扬声器送回麦克风（回声）、或模型在杂音上硬编的套话，发出去就成了
     * 「自己跟自己聊」。命中就当这一轮没人说话，继续听。
     */
    private fun rejectAsNoise(text: String): Boolean {
        if (!SpeechNoise.reject(text, tts.recentSpokenSnapshot())) return false
        val kind = if (SpeechNoise.echoes(text, tts.recentSpokenSnapshot())) "回声" else "套话"
        Log.i("PetVoice", "丢掉$kind：${text.take(20)}")
        return true
    }

    private fun logVad(listenedMs: Long, heard: Boolean, textLen: Int, resume: Boolean) {
        val tail = recorder.lastEndSilenceMs
        val voiced = recorder.lastVoicedMs
        val line = "vad ${listenedMs}ms 人声${voiced}ms 尾静音${tail}ms " +
            "stopped=${recorder.stopReason} 字数$textLen " +
            if (heard) (if (resume) "续听" else "结束") else "没人声"
        Log.i("PetVad", line)
        NetLog.record("/api/asr", 200, listenedMs, line)
    }

    private fun startBgWatch() {
        main.removeCallbacks(bgWatch)
        main.postDelayed(bgWatch, 10_000)
    }

    /** 服务不知前台后台：连续对话时每 10s 查一次 App 重要性，后台满 60s 就停麦省电。 */
    private val bgWatch = object : Runnable {
        override fun run() {
            if (!continuous) {
                bgSince = 0L
                return
            }
            val am = getSystemService(ActivityManager::class.java)
            val fg = am?.let { am2 ->
                am2.runningAppProcesses?.firstOrNull { it.pid == android.os.Process.myPid() }
                    ?.importance ?: ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
            } ?: ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
            if (fg >= ActivityManager.RunningAppProcessInfo.IMPORTANCE_BACKGROUND) {
                if (bgSince == 0L) bgSince = SystemClock.elapsedRealtime()
                if (SystemClock.elapsedRealtime() - bgSince >= 60_000L) {
                    stopContinuous("后台超过 1 分钟")
                    return
                }
            } else {
                bgSince = 0L
            }
            main.postDelayed(this, 10_000)
        }
    }

    private fun toIdle() {
        if (turnActive || pttActive || speaking) return
        pttHolding = false
        setMode("idle")
        setMouth(0f)
        say("")
        updateNotification(getString(R.string.notif_text))
        maybeStartWake()
    }

    private fun onTtsError(message: String) {
        if (destroyed) return
        updateNotification("语音不可用 · ${message.take(20)}")
    }

    private fun maybeStartWake() {
        // 服务在收尾（onDestroy 里也会走到这）：别在最后再起一次麦克风
        if (destroyed) {
            wake.stop()
            return
        }
        if (!cfg.wakeEnabled || !cfg.ready) {
            wake.stop()
            return
        }
        if (wakePausedByApp) {
            wake.stop()
            return
        }
        // 只在「设置里开了常听 + 悬浮窗真的挂在屏幕上 + 待机」时开引擎，其余一律停：
        // 不长期攥着麦克风，也避免 TTS 自己的声音把自己唤醒。
        if (root == null || params == null) { wake.stop(); return }
        if (pttActive || turnActive || speaking || tts.busy) { wake.stop(); return }
        if (webPaused) { wake.stop(); return }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            wake.stop()
            return
        }
        if (!wake.isAvailable()) {
            wake.stop()
            return
        }
        wake.setWords(wakeWords())
        try {
            wake.start()
        } catch (e: Exception) {
            // Android 14+ 后台起麦克风前台服务会被拒；这里不崩，通知里能看出来
            wake.stop()
            updateNotification("常听启动失败 · ${e.javaClass.simpleName}")
        }
    }

    /** 称呼 + 同音写法（识别常把「大肥鱼」写成「大飞鱼」）；自定义称呼只认它自己。 */
    private fun wakeWords(): List<String> {
        val name = who()
        val extra = if (name == PetConfig.DEFAULT_WAKE_NAME) {
            listOf("大飞鱼", "大肥渔", "大肥余", "肥鱼", "大肥")
        } else {
            emptyList()
        }
        return (listOf(name) + extra).filter { it.isNotBlank() }.distinct()
    }

    private fun requestMicPermission() {
        try {
            startActivity(
                Intent(this, PermissionProxyActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
            )
        } catch (_: Exception) {
            openSettings()
        }
    }

    private fun openSettings() {
        try {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        } catch (_: Exception) {
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    /* ---------------- 前台通知 ---------------- */

    private fun createChannel() {
        val ch = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        ch.setShowBadge(false)
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun buildNotification(statusText: String = getString(R.string.notif_text)): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, FloatingPetService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val text = if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            "按住说话 · 缺麦克风权限"
        } else {
            statusText
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("${who()} · 桌面精灵")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, R.drawable.ic_notification),
                    "停止",
                    stop,
                ).build(),
            )
            .build()
    }

    /** 录音前确认前台服务带 microphone 类型；不带就当场升一次（同一进程内 startForeground 换类型是允许的）。 */
    private fun ensureMicForeground(): Boolean {
        if (fgsMic) return true
        val ok = startAsForeground(mic = true)
        Log.i(PetCommand.TAG, "前台服务类型升级 microphone → ${if (ok && fgsMic) "成功" else "失败"}")
        return ok && fgsMic
    }

    private fun startAsForeground(mic: Boolean): Boolean {
        val n = buildNotification()
        if (Build.VERSION.SDK_INT < 29) {
            return try {
                startForeground(NOTIF_ID, n)
                fgsMic = mic
                true
            } catch (e: Exception) {
                fgsMic = false
                false
            }
        }
        val preferred =
            if (mic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        try {
            startForeground(NOTIF_ID, n, preferred)
            fgsMic = mic
            return true
        } catch (_: Exception) {
            fgsMic = false
        }
        try {
            startForeground(
                NOTIF_ID,
                buildNotification(if (mic) "麦克风前台服务被拒，降级为常驻" else "常驻（后台恢复模式）"),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
            Log.w(PetCommand.TAG, "前台服务降级为 specialUse：后台录音会被系统静音")
            fgsMic = false
            return true
        } catch (_: Exception) {
            fgsMic = false
        }
        return try {
            startForeground(NOTIF_ID, buildNotification("前台服务受限"))
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun updateNotification(text: String) {
        try {
            getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification(text))
        } catch (_: Exception) {
        }
    }

    private fun registerScreenReceiver() {
        val f = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        }
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(screenReceiver, f, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(screenReceiver, f)
            }
        } catch (_: Exception) {
        }
    }

    companion object {
        const val ACTION_START = "com.whale.pet.action.START"
        const val ACTION_HIDE = "com.whale.pet.action.HIDE"
    const val ACTION_SHOW = "com.whale.pet.action.SHOW"
    const val ACTION_STOP = "com.whale.pet.action.STOP"

    /** 本应用自己的页面在前台时把小人收起来；服务（含唤醒）继续活着。 */
    @Volatile
    var alive = false

    /** 服务实例：App 里的文字轮次也让回复落到气泡上，和宿主 say 共用同一个入口。 */
    @Volatile
    private var inst: FloatingPetService? = null

    /** 桌宠没在跑就什么都不做；在跑就按正常气泡时长上屏（App 在前台则挂起，回桌面再讲）。 */
    fun sayToBubble(text: String) {
        val s = inst ?: return
        val body = text.trim()
        if (body.isEmpty()) return
        s.main.post { s.offerSay(body) }
    }

        /** 开机/升级后只恢复悬浮窗 + 通知，不申请麦克风（Android 14+ 后台禁麦克风前台服务）。 */
        const val ACTION_RESTORE = "com.whale.pet.action.RESTORE"

        /** App 里改完设置（称呼/大小/音色）后让常驻服务立刻生效，不重建 WebView。 */
        const val ACTION_REFRESH = "com.whale.pet.action.REFRESH"

        /** 只换立绘服装：不动录音、不重启服务、不重建 WebView。 */
        const val ACTION_REFRESH_OUTFIT = "com.whale.pet.REFRESH_OUTFIT"

        /** 对话页按住说话前后让出/收回麦克风（录音与唤醒互斥）。 */
        const val ACTION_WAKE_PAUSE = "com.whale.pet.action.WAKE_PAUSE"
        const val ACTION_WAKE_RESUME = "com.whale.pet.action.WAKE_RESUME"

        /** 透明授权页回来的结果（只带「给没给」，不带任何录音数据）。 */
        const val ACTION_MIC_RESULT = "com.whale.pet.action.MIC_RESULT"
        const val EXTRA_MIC_GRANTED = "granted"

        /** 只给 debug 构建做验收用（adb broadcast 触发一轮对话）。 */
        const val ACTION_DEBUG_TURN = "com.whale.pet.action.DEBUG_TURN"
        const val ACTION_DEBUG_MODE = "com.whale.pet.action.DEBUG_MODE"
        const val ACTION_DEBUG_SAY = "com.whale.pet.action.DEBUG_SAY"
        const val ACTION_DEBUG_PAUSE = "com.whale.pet.action.DEBUG_PAUSE"
        const val ACTION_DEBUG_EVAL = "com.whale.pet.action.DEBUG_EVAL"

        /** home 模式看前台应用的间隔：切回桌面 1.5s 内必须回来。 */
        private const val HOME_POLL_MS = 1200L

        /** 自动重听里这么久一直没人声就回待机（不再自己接着开麦）。 */
        private const val NO_VOICE_MS = 8_000L

        /** 连续自动重听最多几轮：到此为止，最后一轮回完就回待机。 */
        private const val MAX_AUTO_ROUNDS = 6

        private const val CHANNEL_ID = "pet_listen"
        private const val NOTIF_ID = 4101
    }
}
