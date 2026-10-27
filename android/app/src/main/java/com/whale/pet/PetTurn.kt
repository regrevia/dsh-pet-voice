package com.whale.pet

import android.util.Log

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** 电脑上那一轮还在跑时宿主回的 queued 帧：这句在排队，不是在思考。 */
const val PET_QUEUED_TEXT = "电脑上还在跑，已排队"

/**
 * 一轮对话：SSE 先连上（拿到 hello）再派发，保证 delta 不丢；
 * 隧道/代理把 SSE 掐掉时退回 poll（先取 cursor=-1 基线再派发，同样不丢帧）。
 *
 * 逐句切分后通过 onSentence 交给 TtsPlayer；onAssistant 给字幕。
 */
class PetTurn(
    private val client: PetClient,
    private val text: String,
    private val cb: Callback,
    /** 为空 = 走宿主默认落点（专属会话）；非空 = 钉在这只会话上（「新对话」之后）。 */
    private val requestedSession: String = "",
    /** 宿主回执里的落点和 App 钉的那只不一样时回调（上层持久化新指针 + 提示一次）。 */
    private val onSession: ((String) -> Unit)? = null,
    /** 这一问要带上的图片（宿主上已落盘的绝对路径），交给插件拼在正文后面。 */
    private val attachments: List<String> = emptyList(),
) {

    interface Callback {
        fun onUser(text: String)
        fun onStatus(text: String)
        fun onAssistant(fullText: String, isFinal: Boolean)
        fun onSentence(sentence: String)
        fun onDone()
        fun onError(message: String)
    }

    private val main = Handler(Looper.getMainLooper())
    private val cancelled = AtomicBoolean(false)
    private val finished = AtomicBoolean(false)
    private val ended = AtomicBoolean(false)
    private val helloLatch = CountDownLatch(1)
    private val sawEvent = AtomicBoolean(false)
    private val finalSeen = AtomicBoolean(false)
    /** 谁在喂文本："" 未定 / "sse" / "poll"，避免同一段被喂两遍。 */
    private val feeder = java.util.concurrent.atomic.AtomicReference("")

    /** 这一轮压根没开 SSE（面板锁成只用轮询）：此时 delta 只能来自轮询，别标成 sse。 */
    @Volatile private var pollOnly = false

    /** SSE 最后一次收到字节的时刻：轮询据此决定「让位」还是接管。 */
    @Volatile private var sseLastAt = 0L

    /**
     * 跨通道去重：同一帧会从 SSE 和轮询各来一次。
     *
     * 键必须是「会话 + seq」：不同会话的 seq 各自从 1 开始，只按 seq 去重时，
     * 别的会话的 seq=7 会把本会话刚收到的 seq=7 当成重复丢掉（表现是一整句凭空消失）。
     */
    private val seenSeq = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    @Volatile
    private var endSeenAt = 0L

    /** 是否收到过 end（新协议里它是唯一的终止信号）。 */
    private val endSeen = AtomicBoolean(false)

    private val assistant = StringBuilder()
    private val sentenceBuf = StringBuilder()
    private val sentenceEmitted = AtomicBoolean(false)

    /** 一轮的耗时打点；turnStart = 本次 PetTurn 构造时刻（start() 紧接着被调用）。 */
    private val latency = TurnLatency()
    private val firstSentenceLogged = AtomicBoolean(false)
    private val firstPollSent = AtomicBoolean(false)
    private val firstPollReturned = AtomicBoolean(false)

    @Volatile
    private var sessionId = ""

    /** 本轮真正的落点：拿到 dispatch 回执后才有值，用来把别处会话的 delta 过滤掉。 */
    @Volatile
    private var expectedSession = ""

    @Volatile
    private var stream: PetClient.Stream? = null

    /** 流实际订阅的会话；dispatch 回执改落点时跟着挪，重连也要用它（不能用死的 requestedSession）。 */
    @Volatile
    private var streamSession = ""

    /** 已经报给上层的落点，避免同一只会话反复提示。 */
    @Volatile
    private var reportedSession = ""

    /**
     * 本轮是不是「钉的会话已经不在、改投默认落点」重发过。
     *
     * 这时真实落点有可能正好等于开流前探到的默认会话，看上去「没变」——但对 App 来说
     * 指针确实换了：必须照样上报，否则本地钉的死 id 一直留着，下一句又是 404 再来一遍。
     */
    @Volatile
    private var fellBack = false

    /** 是否已经为「别的会话的帧被丢掉」记过一次日志。 */
    private val foreignDropped = AtomicBoolean(false)

    /** 派发前对齐到的帧序号；SSE 一帧没到也靠它把这一轮的帧补回来。 */
    @Volatile
    private var turnCursor = -1

    /** 宿主给帧打的轮次序号水位：旧轮迟到的 final/end 一律丢，别覆盖新回复。 */
    @Volatile
    private var knownTurn = 0

    /**
     * 这一轮的发送 id：重试**必须**带同一个。
     *
     * 弱网下最常见的不是「没发出去」，而是「电脑收到了、回执在回来的路上丢了」。
     * 换个 id 重试就会在电脑上多开一轮、把回复念两遍；同一个 id 宿主直接判重复，安全。
     */
    private val requestId = java.util.UUID.randomUUID().toString()

    fun start() {
        Thread({ run() }, "pet-turn").apply { isDaemon = true; start() }
    }

    /** 这一轮已经走完（成功/失败/取消）。界面据此判断别把新消息当引导吞掉。 */
    fun isDone(): Boolean = ended.get() || cancelled.get()

    fun cancel() {
        if (!cancelled.compareAndSet(false, true)) return
        // 关流会撞上正在 readLine 的 SSE 线程，可能卡几秒；这调用来自点按，不能占主线程
        Thread({ stream?.close() }, "pet-cancel").apply { isDaemon = true; start() }
        helloLatch.countDown()
        finishOnce()
    }

    private fun run() {
        post { cb.onUser(text) }
        status("连接中…")

        // 先探一刀再开流：断网/切网时开流要干等 30s（读超时）才失败，人就盯着「处理中」发呆；
        // 这条一次性的 /api/poll 顺带给出本轮基线 cursor。
        // 弱网下这一刀没通不代表这句话发不出去：少量重试之后照样往下派发。
        val pre = preflight()
        turnCursor = pre?.json?.optInt("cursor", -1) ?: -1
        // 宿主会把所有会话的帧广播出来；不钉住目标会话，别的会话的 start/end/final 就会被
        // 当成这一轮的（0.8.4 真机「想 4 秒然后没输出」就是被别人的 end 收尾的）。
        val probed = pre?.json?.optString("sessionId").orEmpty()
        if (expectedSession.isBlank() && probed.isNotBlank()) expectedSession = probed
        latency.mark("preflight", "http=${pre?.code ?: 0} cursor=$turnCursor")
        dbg("preflight http=${pre?.code ?: 0} cursor=$turnCursor session=$expectedSession")

        // 插件设置页把传输方式锁成「只用轮询」时，别去开流：有些路由器/代理直接把 SSE 掐掉，
        // 硬开会先干等一个读超时，人看着「处理中」发呆。轮询本来就在，只是提前接管。
        val forcedPoll = pre?.json?.optString("transport").orEmpty() == "poll"
        if (forcedPoll) {
            pollOnly = true
            latency.mark("transport", "panel=poll")
            dbg("transport forced poll by panel")
            post { cb.onStatus("正在想…") }
            pollTurn()
            finishOnce()
            return
        }

        var sse: PetClient.Stream? = null
        streamSession = requestedSession.ifBlank { expectedSession }
        try {
            // 钉了会话就订阅那只：订阅默认落点会收不到别的会话的增量，只能干等
            sse = client.openStream(streamSession, latency)
        } catch (e: Exception) {
            post { cb.onStatus("SSE 不可用，改用轮询") }
        }
        if (sse != null) {
            stream = sse
            val reader = Thread({ readSse(sse) }, "pet-sse").apply { isDaemon = true; start() }
            // 并发兜底：hello 没在 SSE_FALLBACK_MS 内到达就立刻改轮询，不再干等 5s。
            // 下限 SSE_FALLBACK_FLOOR_MS 是防止「连接本身慢」被误判（连上后至少留这点时间收 hello）。
            val helloWaitMs = maxOf(SSE_FALLBACK_FLOOR_MS, SSE_FALLBACK_MS - latency.elapsedMs())
            val helloOk = try {
                helloLatch.await(helloWaitMs, TimeUnit.MILLISECONDS)
            } catch (e: InterruptedException) {
                false
            }
            if (!helloOk && !sawEvent.get()) {
                latency.mark("fallback", "sse hello 未到（wait=${helloWaitMs}ms）→ 轮询")
            }
            if (!cancelled.get() && (helloOk || sawEvent.get())) {
                dispatchAndWait()
                sse.close()
            } else {
                sse.close()
                if (!cancelled.get() && !ended.get()) pollTurn()
            }
        } else if (!cancelled.get()) {
            pollTurn()
        }
        finishOnce()
    }

    /**
     * 收 SSE。断线（30s 没字节、Wi-Fi↔移动网切换、锁屏）不结束这一轮：
     * 按 1/2/4/8/10s 退避重连，期间由轮询把回复补回来。
     */
    private fun readSse(first: PetClient.Stream) {
        var s: PetClient.Stream? = first
        var backoff = 1_000L
        // 断开只在第一次给一行状态；重连上了再收回，避免网络抖一下界面就闪一句话
        var lostNotified = false
        while (!cancelled.get() && !ended.get()) {
            val cur = s
            if (cur == null) {
                try {
                    Thread.sleep(backoff)
                } catch (_: InterruptedException) {
                    return
                }
                backoff = (backoff * 2).coerceAtMost(10_000L)
                s = try {
                    NetLog.reconnect()
                    client.openStream(streamSession)
                } catch (_: Exception) {
                    null
                }
                if (s != null) {
                    stream = s
                    backoff = 1_000L
                    if (lostNotified) {
                        lostNotified = false
                        status("已连上")
                    }
                }
                continue
            }
            try {
                while (!cancelled.get() && !ended.get()) {
                    val ev = cur.nextEvent() ?: break
                    sawEvent.set(true)
                    sseLastAt = System.currentTimeMillis()
                    backoff = 1_000L
                    handleEvent(ev.first, ev.second)
                }
            } catch (_: Exception) {
                // 读超时/连接重置都走重连，别把用户的这一轮判死
            }
            if (cancelled.get() || ended.get()) break
            if (!lostNotified) {
                lostNotified = true
                linkLost("SSE 断开，重连中")
            } else {
                NetLog.record("GET /api/stream", 0, 0, "断开，重连中")
            }
            runCatching { cur.close() }
            s = null
        }
    }

    /**
     * 派发一句话。钉住的会话被删/宿主管不到时（404）**不能把这句话丢掉**：
     * 立刻改投专属会话，这一轮照样有回复；上层收到 404 再清偏好。
     */
    private fun send(text: String): PetClient.Result {
        val first = client.dispatch(text, requestedSession, requestId = requestId, attachments = attachments)
        if (first.code != 404 || requestedSession.isBlank()) return first
        fellBack = true
        NetLog.record("POST /api/dispatch", 404, 0, "钉住的会话失效，改投专属会话")
        post { cb.onStatus("原会话不在了，换回专属会话") }
        return client.dispatch(text, "", requestId = requestId, attachments = attachments)
    }

    /* ---------------- 弱网自愈：一行状态 + 原地重试，不把用户的话丢掉 ---------------- */

    /** 底部那一行状态：只在还没收工的时候更新，别在收工后再冒出来一句。 */
    private fun status(text: String) {
        main.post { if (!cancelled.get() && !finished.get()) cb.onStatus(text) }
    }

    /** 断线一次记一行日志 + 一行提示；调用方负责只在「第一次」调它。 */
    private fun linkLost(why: String) {
        NetLog.reconnect()
        NetLog.record("GET /api/stream", 0, 0, why)
        status(LINK_LOST_TEXT)
    }

    private fun sleepQuietly(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
        }
    }

    /** 值不值得重发：网络层失败（0）和临时性错误值得，4xx 是「话说错了」，重发没用。 */
    private fun retryable(code: Int): Boolean = code == 0 || code == 408 || code == 429 || code >= 500

    /**
     * 开流前的那一刀。弱网下多试几次（总共最多 ~8 秒），通了就拿到本轮基线 cursor；
     * 全不通也**不**在这里判死：直接往下派发，真发不出去再让上层给一行可点的重试。
     */
    private fun preflight(): PetClient.Result? {
        val until = System.currentTimeMillis() + PREFLIGHT_BUDGET_MS
        var last: PetClient.Result? = null
        for (i in 1..PREFLIGHT_TRIES) {
            if (cancelled.get()) return last?.takeIf { it.ok }
            last = try {
                client.poll("", -1, 0)
            } catch (_: Exception) {
                null
            }
            if (last != null && last.ok) return last
            NetLog.record("poll", last?.code ?: 0, latency.elapsedMs(), "预检第 $i 次没通")
            if (i >= PREFLIGHT_TRIES || System.currentTimeMillis() >= until) break
            status(LINK_LOST_TEXT)
            sleepQuietly(400L * i)
        }
        return last?.takeIf { it.ok }
    }

    /**
     * 派发 + 原地重试。同一个 requestId，所以「电脑其实收到了、回执丢了」的情况不会变成两轮。
     */
    private fun sendWithRetry(text: String): PetClient.Result? {
        var last: PetClient.Result? = null
        for (i in 1..DISPATCH_TRIES) {
            if (cancelled.get()) return last
            last = try {
                send(text)
            } catch (e: Exception) {
                NetLog.record("POST /api/dispatch", 0, 0, "第 $i 次失败 ${e.javaClass.simpleName}")
                null
            }
            if (last != null && (last.ok || !retryable(last.code))) return last
            if (i >= DISPATCH_TRIES) break
            status(SEND_RETRY_TEXT)
            sleepQuietly(800L * i)
        }
        return last
    }

    /** 派发回执里的落点：宿主把 `usedSessionId` 当准，老宿主没有它就用 `sessionId`。 */
    private fun resolvedOf(res: PetClient.Result): String {
        val j = res.json ?: return ""
        return j.optString("usedSessionId").orEmpty().ifBlank { j.optString("sessionId").orEmpty() }
    }

    /**
     * 采纳宿主回执里的落点。
     *
     * App 钉的那只可能已经被宿主换掉了（桌面端切了会话、原会话被删、宿主重启后换了默认落点）。
     * 这时候如果还照着旧 id 收帧，就永远收不到——表现正是「明明在跑，手机一直『接收失败』」：
     * 流订阅的是旧会话，别的会话的帧又被过滤掉，最后只能等超时。
     * 所以拿到回执就把订阅、光标、过滤基准一起挪到真实落点，并且只通知上层一次。
     */
    /** 对比基准：钉的会话刚失效重发过，就按钉的那只比，落点相同也要上报一次。 */
    private fun adoptionBaseline(): String =
        if (fellBack && requestedSession.isNotBlank()) requestedSession else expectedSession.ifBlank { streamSession }

    private fun adoptResolved(resolved: String, previous: String) {
        if (resolved.isBlank()) return
        val changed = resolved != previous
        sessionId = resolved
        expectedSession = resolved
        if (streamSession != resolved) {
            streamSession = resolved
            // 光标按会话算：换了会话必须重新对齐，不能拿别的会话的序号当本会话的
            runCatching {
                client.poll(resolved, -1, 0).json?.let {
                    val c = it.optInt("cursor", -1)
                    if (c >= 0) turnCursor = c
                }
            }
            NetLog.record("GET /api/stream", 0, 0, "会话落点变了，重新订阅")
            dbg("resubscribe session=${resolved.take(8)}")
            // 关掉旧流，readSse 会按 streamSession 自动重连到新会话
            runCatching { stream?.close() }
        }
        if (changed && reportedSession != resolved) {
            reportedSession = resolved
            dbg("session adopted ${previous.take(8)} -> ${resolved.take(8)}")
            onSession?.let { cb2 -> main.post { cb2(resolved) } }
        }
    }

    private fun dispatchAndWait() {
        if (cancelled.get()) return
        runCatching {
            client.poll(requestedSession, -1, 0).json?.let { turnCursor = it.optInt("cursor", -1) }
        }
        val res = sendWithRetry(text)
        if (res == null || !res.ok) {
            // 404 = 钉住的那只会话被删了：明说，让上层清掉偏好回到默认落点
            if (res?.code == 404) postError("会话已失效（404），下次自动回到专属会话")
            else if (res == null) postError("连不上电脑，检查网络")
            else postError("没发出去，重试")
            return
        }
        sessionId = resolvedOf(res)
        adoptResolved(sessionId, adoptionBaseline())
        startPollFallback()
        status("正在想…")
        val deadline = System.currentTimeMillis() + 180_000
        while (!cancelled.get() && !ended.get() && System.currentTimeMillis() < deadline) {
            Thread.sleep(120)
        }
        if (!cancelled.get() && !ended.get()) postError(TIMEOUT_TEXT)
    }

    private fun pollTurn() {
        if (firstPollSent.compareAndSet(false, true)) {
            latency.mark("pollSent", "baseline cursor=-1")
        }
        // 对齐基线这一步也扛断网：短重试之后还不行，就是真连不上了（后面派发只会更慢，直接说）
        var base: PetClient.Result? = null
        for (i in 1..3) {
            base = try {
                client.poll("", -1, 0)
            } catch (_: Exception) {
                null
            }
            if (base?.ok == true) break
            if (i < 3) {
                status(LINK_LOST_TEXT)
                sleepQuietly(600L * i)
            }
        }
        if (base?.ok != true) {
            postError("连不上电脑，检查网络")
            return
        }
        var cursor = base.json?.optInt("cursor", -1) ?: -1
        if (firstPollReturned.compareAndSet(false, true)) {
            latency.mark("pollReturned", "http=${base.code} cursor=$cursor")
        }
        val res = sendWithRetry(text)
        if (res == null || !res.ok) {
            if (res == null) postError("连不上电脑，检查网络")
            else postError("没发出去，重试")
            return
        }
        sessionId = resolvedOf(res)
        adoptResolved(sessionId, adoptionBaseline())
        if (sessionId.isBlank()) {
            postError("没发出去，重试")
            return
        }
        status("正在想…")
        val deadline = System.currentTimeMillis() + 185_000
        // 断线不再立刻判死：真断了超过 POLL_DOWN_MS 才收手，中途只更新那一行状态。
        var downStreak = 0
        var downAt = 0L
        while (!cancelled.get() && !ended.get() && System.currentTimeMillis() < deadline) {
            val r = try {
                client.poll(sessionId, cursor, 20_000)
            } catch (_: Exception) {
                null
            }
            if (r == null || !r.ok) {
                // 会话真没了（被删/宿主重启换了落点）重试多少次都没用：交给上层清指针
                if (r?.code == 404) {
                    postError("会话已失效（404），下次自动回到专属会话")
                    return
                }
                downStreak += 1
                if (downAt == 0L) {
                    downAt = System.currentTimeMillis()
                    linkLost("轮询断开，重连中（第 $downStreak 次）")
                }
                NetLog.record("GET /api/poll", r?.code ?: 0, 0, "断开第 $downStreak 次")
                if (System.currentTimeMillis() - downAt > POLL_DOWN_MS) {
                    postError(TIMEOUT_TEXT)
                    return
                }
                sleepQuietly(minOf(1_000L * downStreak, 4_000L))
                continue
            }
            if (downStreak > 0) {
                dbg("轮询恢复，断了 ${System.currentTimeMillis() - downAt}ms")
                downStreak = 0
                downAt = 0L
                status("正在想…")
            }
            val j = r.json ?: continue
            cursor = j.optInt("cursor", cursor)
            val frames = j.optJSONArray("frames")
            if (frames != null) {
                for (i in 0 until frames.length()) {
                    val f = frames.optJSONObject(i) ?: continue
                    val data = f.optJSONObject("data") ?: JSONObject()
                    handleEvent(f.optString("event"), data)
                    if (ended.get()) return
                }
            }
            if (j.optBoolean("done", false)) return
        }
        if (!cancelled.get() && !ended.get()) postError(TIMEOUT_TEXT)
    }


    private fun handleEvent(event: String, data: JSONObject) {
        if (cancelled.get()) return
        // 宿主把电脑上正在跑的那一轮也广播过来（origin=desktop，同一只会话里就会撞上）：
        // 它的 start/delta/message/final 混进来，手机就显示电脑端的操作；它的 end 更糟，
        // 直接把本轮收尾。这里一律丢，不渲染也不结束。旧宿主没有这个字段，按原样放行。
        val origin = data.optString("origin")
        if (origin.isNotBlank() && origin != "pet" && event != "hello") {
            dbg("drop origin=$origin $event sid=${data.optString("sessionId")}")
            return
        }
        if (event != "delta") dbg("event $event seq=${data.optInt("seq", -1)} sid=${data.optString("sessionId")} want=$expectedSession feeder=${feeder.get()}")
        // 宿主会把所有会话的事件广播过来：别的会话（比如电脑上正在用的那只）的 delta 不能串进手机字幕
        val evSession = data.optString("sessionId")
        // 宿主的流同时挂在 '*' 上（谁派发的都往所有连接推），所以这里必须严格按会话过滤：
        // 别人的 start/end/final/delta 混进来就会把这一轮提前收尾（真机「想 4 秒就没输出」）。
        // 顺序要紧：**先按会话过滤，再按 seq 去重**——反过来的话，别的会话的 seq=7
        // 会先把本会话还没到的 seq=7 记成「已收」，本会话那一帧就被当成重复丢掉。
        if (event != "hello" && event != "say" && expectedSession.isNotBlank() && evSession != expectedSession) {
            // 只在第一次落一条：会话绑错时这里会持续吞帧，没有这条日志就看不出「为什么没回复」
            if (foreignDropped.compareAndSet(false, true)) {
                NetLog.record("GET /api/stream", 0, 0, "丢弃 ${evSession.take(8)} 的帧，本轮=${expectedSession.take(8)}")
                dbg("drop foreign session=${evSession.take(8)} want=${expectedSession.take(8)}")
            }
            return
        }
        // 还没派发时不知道目标会话：广播流里别人的 start/end/final 一律不算
        if (expectedSession.isBlank() && event != "hello" && event != "delta") return
        // 同一帧可能从 SSE 和轮询各来一次：带 seq 就按「会话+seq」去重
        val seq = data.optInt("seq", -1)
        if (seq >= 0) {
            NetLog.seq(seq)
            if (!seenSeq.add(evSession.ifBlank { expectedSession } + "|" + seq)) return
        }
        if (staleTurn(event, data)) return
        when (event) {
            "hello" -> {
                sessionId = data.optString("sessionId", sessionId)
                helloLatch.countDown()
            }

            "start" -> post { cb.onStatus("思考中…") }

            // 电脑上那一轮还没跑完，这句进了队列：不是「我们在思考」，别显示成思考中。
            "queued" -> post { cb.onStatus(PET_QUEUED_TEXT) }

            "delta" -> {
                val d = data.optString("text")
                if (d.isEmpty()) return
                // 轮询接管后 SSE 的重复增量要丢掉；纯轮询轮次没有第二条通道，照收
                if (feeder.get() == "poll" && !pollOnly) return
                feeder.set(if (pollOnly) "poll" else "sse")
                assistant.append(d)
                feedSentences(d)
                val full = assistant.toString()
                post { cb.onAssistant(full, false) }
            }

            "message" -> {
                // 一条完整的模型消息：可以显示、可以播，但**不是**这一轮的结束，后面还可能续。
                val t = data.optString("text").ifBlank { assistant.toString() }
                if (t.isBlank()) return
                assistant.setLength(0)
                assistant.append(t)
                post { cb.onAssistant(t, false) }
                flushSentences()
            }

            "final" -> {
                if (finalSeen.get()) return
                finalSeen.set(true)
                val t = data.optString("text").ifBlank { assistant.toString() }
                if (t.isNotBlank()) {
                    assistant.setLength(0)
                    assistant.append(t)
                    post { cb.onAssistant(t, true) }
                    if (!sentenceEmitted.get() && sentenceBuf.isEmpty()) {
                        // 没有 delta 的短回复：整段按句合成
                        val leftover = t
                        if (leftover.isNotBlank()) {
                            sentenceEmitted.set(true)
                            emitSentence(leftover, "final")
                        }
                    } else {
                        flushSentences()
                    }
                } else {
                    flushSentences()
                }
                // 新协议里 final 只是「一条完整的模型消息」，一轮要等 end 才算结束，这里不置 ended。
                // 兼容旧宿主：老版本只发 final、不发 end，1.5s 没等到 end 就按旧式收尾——
                // 否则对旧宿主每一轮都会卡到 180s 判超时。end 一到就由 end 分支立即结束。
                main.postDelayed({
                    if (!cancelled.get() && !ended.get() && !endSeen.get()) {
                        dbg("final 后 ${FINAL_COMPAT_MS}ms 未收到 end，按旧宿主行为收尾")
                        ended.set(true)
                    }
                }, FINAL_COMPAT_MS)
            }

            "end" -> {
                // 这一轮真正的终止信号。宿主保证 final 先于 end，但隧道可能把两个事件拆到不同
                // 批次：end 到了、final 还在路上时给同样长的宽限；等不到就把已收到的增量收尾。
                if (endSeen.get()) return
                endSeen.set(true)
                endSeenAt = System.currentTimeMillis()
                if (finalSeen.get()) {
                    flushSentences()
                    ended.set(true)
                } else {
                    main.postDelayed({
                        if (cancelled.get() || ended.get()) return@postDelayed
                        finalSeen.set(true)
                        val pendingText = assistant.toString()
                        if (pendingText.isNotBlank()) {
                            post { cb.onAssistant(pendingText, true) }
                            flushSentences()
                        }
                        ended.set(true)
                    }, FINAL_COMPAT_MS)
                }
            }

            "error" -> {
                postError(data.optString("message", "宿主返回错误"))
                ended.set(true)
            }

            "say" -> {
                // 主动说一句（例如宿主侧提醒），直接按句播
                val t = data.optString("text")
                if (t.isNotBlank()) emitSentence(t, "say")
            }

            "tool" -> post { cb.onStatus("调用工具：${data.optString("name")}") }
        }
    }

    /**
     * 旧轮的 final/end 帧可能比新一轮的 start 晚到：turn 比已知水位小就丢弃。
     * 只影响带 turn 的帧；不带 turn（0）的老宿主行为不变。
     */
    private fun staleTurn(event: String, data: JSONObject): Boolean {
        val turn = data.optInt("turn", 0)
        if (turn <= 0) return false
        if ((event == "final" || event == "end") && turn < knownTurn) {
            Log.d("PetTurn", "drop stale turn=$turn known=$knownTurn")
            return true
        }
        if (turn > knownTurn) knownTurn = turn
        return false
    }

    private fun feedSentences(delta: String) {
        sentenceBuf.append(delta)
        while (true) {
            val end = sentenceBoundary(sentenceBuf)
            if (end <= 0) break
            val s = sentenceBuf.substring(0, end).trim()
            sentenceBuf.delete(0, end)
            if (s.isBlank()) continue
            sentenceEmitted.set(true)
            emitSentence(s, "delta")
        }
    }

    private fun flushSentences() {
        val s = sentenceBuf.toString().trim()
        sentenceBuf.setLength(0)
        if (s.isNotBlank()) {
            sentenceEmitted.set(true)
            emitSentence(s, "flush")
        }
    }

    /** 返回切点（含标点）。句末标点；太长时退到最后一个逗号。 */
    private fun sentenceBoundary(buf: StringBuilder): Int {
        for (i in 0 until buf.length) {
            val c = buf[i]
            if (c == '。' || c == '！' || c == '？' || c == '!' || c == '?' || c == '；' || c == ';' || c == '\n') {
                if (i + 1 >= 2) return i + 1
            }
        }
        // 首句要早：过 24 字就在最后一个分句处切一刀，第一句 TTS 不必等整段说完。
        if (buf.length > 24) {
            val cut = buf.lastIndexOfAny(charArrayOf('，', ',', '、', ' '))
            if (cut > 12) return cut + 1
        }
        if (buf.length > 90) {
            val idx = buf.lastIndexOfAny(charArrayOf('，', ',', '、', ' '))
            if (idx > 20) return idx + 1
            return 90
        }
        return -1
    }

    /** 首句单独打点（`+Nms sentence src=… chars=…`），其余只原样交给 TTS。 */
    private fun emitSentence(sentence: String, source: String) {
        if (firstSentenceLogged.compareAndSet(false, true)) {
            latency.mark("sentence", "src=$source chars=${sentence.length}")
        }
        post { cb.onSentence(sentence) }
    }

    private fun dbg(msg: String) {
        Log.i("PetTurn", msg)
    }

    private fun post(block: () -> Unit) {
        main.post {
            if (!cancelled.get()) block()
        }
    }

    private fun postError(message: String) {
        main.post {
            if (!finished.get() && !cancelled.get()) cb.onError(message)
        }
    }

    /**
     * SSE 一条 delta 都没落（隧道/代理掐流）时，用 /api/poll 从派发前对齐到的帧序号
     * 把这一轮的文本捞回来。只在这条通道上喂一次，SSE 到了就让位。
     */
    private fun startPollFallback() {
        Thread({
            try {
                // 派发成功后马上兜底拉一轮：SSE 活着时只对齐 cursor，不抢字幕
                Thread.sleep(400)
                val sid = expectedSession.ifBlank { sessionId }
                if (sid.isBlank()) return@Thread
                var cursor = turnCursor
                val deadline = System.currentTimeMillis() + 180_000
                var failed = 0
                var failedSince = 0L
                // 这一行状态只报一次断、一次恢复，别让兜底通道把界面刷成日志
                var statusWasLost = false
                var endSeenAtPoll = 0L
                while (!cancelled.get() && !ended.get() && System.currentTimeMillis() < deadline) {
                    val resPoll = runCatching { client.poll(sid, cursor, 20_000) }.getOrNull()
                    if (resPoll == null || !resPoll.ok) {
                        // 以前是「连挂三次就判死」：Wi-Fi↔移动网切那几秒正好三次，
                        // 用户白丢一轮，看到的就是「接收失败」。现在要求「真断了 20 秒」才收。
                        failed += 1
                        if (failedSince == 0L) {
                            failedSince = System.currentTimeMillis()
                            statusWasLost = true
                            linkLost("轮询兜底断开，重连中")
                        }
                        if (failed >= 3 && System.currentTimeMillis() - failedSince > 20_000) {
                            postError("没收到回复，重试")
                            break
                        }
                        Thread.sleep(if (failed <= 2) 1_000 else 2_000)
                        continue
                    }
                    failed = 0
                    failedSince = 0L
                    if (statusWasLost) {
                        statusWasLost = false
                        status("已连上")
                    }
                    val json = resPoll.json ?: return@Thread
                    val frames = json.optJSONArray("frames")
                    if (frames == null || frames.length() == 0) {
                        if (json.optBoolean("done")) break else continue
                    }
                    var end = false
                    for (i in 0 until frames.length()) {
                        val f = frames.optJSONObject(i) ?: continue
                        val data = f.optJSONObject("data") ?: continue
                        if (staleTurn(f.optString("event"), data)) continue
                        when (f.optString("event")) {
                            "delta" -> {
                                val d = data.optString("text")
                                if (d.isEmpty()) continue
                                // SSE 刚有字节就让位，避免同一句被两条通道各念一遍
                                if (feeder.get() == "sse" && System.currentTimeMillis() - sseLastAt < 8_000) continue
                                feeder.set("poll")
                                assistant.append(d)
                                feedSentences(d)
                                post { cb.onAssistant(assistant.toString(), false) }
                            }
                            "message" -> {
                                val t = data.optString("text").ifBlank { assistant.toString() }
                                if (t.isBlank()) continue
                                feeder.set("poll")
                                assistant.setLength(0)
                                assistant.append(t)
                                post { cb.onAssistant(t, false) }
                                flushSentences()
                            }
                            "final" -> {
                                val t = data.optString("text").ifBlank { assistant.toString() }
                                if (t.isNotBlank()) {
                                    feeder.set("poll")
                                    assistant.setLength(0)
                                    assistant.append(t)
                                    post { cb.onAssistant(t, true) }
                                    if (!sentenceEmitted.get()) {
                                        sentenceEmitted.set(true)
                                        emitSentence(t, "final")
                                    } else {
                                        flushSentences()
                                    }
                                }
                                // final 不是终止：等 end。只发 final 的旧宿主由下面的
                                // endSeenAtPoll 宽限兜底（3s 后收尾）
                                if (endSeenAtPoll == 0L) endSeenAtPoll = System.currentTimeMillis()
                            }
                            // end 只是「这一轮结束了」：final 可能还没进这批帧，
                            // 没正文就不能收工，否则回复永远取不回来；最多再多等 3s
                            "end" -> {
                                if (feeder.get() == "poll" || assistant.isNotBlank()) end = true
                                else if (endSeenAtPoll == 0L) endSeenAtPoll = System.currentTimeMillis()
                            }
                        }
                    }
                    cursor = json.optInt("cursor", cursor)
                    if (!end && endSeenAtPoll > 0 && System.currentTimeMillis() - endSeenAtPoll > 3_000) end = true
                    if (end) break
                    Thread.sleep(150)
                }
                if (!cancelled.get()) {
                    ended.set(true)
                    finishOnce()
                }
            } catch (_: Exception) {
            }
        }, "pet-poll-fallback").apply { isDaemon = true; start() }
    }

    private fun finishOnce() {
        if (!finished.compareAndSet(false, true)) return
        // SSE 只收到 end、一帧 delta 都没落的场合：按帧序号把这一轮从缓冲里捞回来，
        // 否则界面会「处理中」一闪而过、回复凭空消失。
        if (!cancelled.get() && assistant.isEmpty() && turnCursor >= 0) recoverFromBuffer()
        // 捞回来的（或只走了增量没等到 final 的）文本必须交给界面，否则用户看到的是
        // 「思考几秒然后什么都没有」——真机 0.8.4 就栽在这条静默路径上。
        val text = assistant.toString()
        if (!cancelled.get() && text.isNotBlank() && !finalSeen.get()) {
            finalSeen.set(true)
            main.post { cb.onAssistant(text, true) }
            if (!sentenceEmitted.get()) {
                sentenceEmitted.set(true)
                emitSentence(text, "recover")
            }
        }
        main.post { cb.onDone() }
    }

    private fun recoverFromBuffer() {
        val sid = sessionId.ifBlank { expectedSession }
        if (sid.isBlank()) return
        // 宿主刚把字写进会话、帧还没进广播缓冲的那一下也会空手而归：多等一点再捞。
        val frames = runCatching { client.poll(sid, turnCursor, 900).json?.optJSONArray("frames") }.getOrNull() ?: return
        for (i in 0 until frames.length()) {
            val f = frames.optJSONObject(i) ?: continue
            val data = f.optJSONObject("data") ?: continue
            if (staleTurn(f.optString("event"), data)) continue
            when (f.optString("event")) {
                "delta" -> data.optString("text").takeIf { it.isNotEmpty() }?.let {
                    assistant.append(it)
                    feedSentences(it)
                }
                // message / final 带的是整段（累积）文本：以它为准，别把增量拼重了
                "message", "final" -> data.optString("text").takeIf { it.isNotEmpty() }?.let {
                    assistant.setLength(0)
                    assistant.append(it)
                }
            }
        }
    }

    private companion object {
        /** hello 等待上限：落在 800–1200ms 的兜底窗口内，正常宿主 hello 通常 <100ms。 */
        const val SSE_FALLBACK_MS = 900L

        /** 连上之后至少再等这么久，避免慢网络下「连接耗时」把 hello 预算吃光。 */
        const val SSE_FALLBACK_FLOOR_MS = 300L

        /** end 与 final 之间的宽限：新协议等 end；旧宿主只发 final，等不到就按旧式收尾。 */
        const val FINAL_COMPAT_MS = 1_500L

        /** 超过这个时间还没收到结束信号：只给用户一句能懂的提示，不报内部帧名。 */
        const val TIMEOUT_TEXT = "电脑那边没回，再发一次"

        /* ---------------- 弱网自愈 ---------------- */

        /** 开流前探路最多试几次、总共最多花多久：够跨过「切网那几秒」，又不让人干等。 */
        const val PREFLIGHT_TRIES = 3
        const val PREFLIGHT_BUDGET_MS = 8_000L

        /** 派发重试次数：同一个 requestId，重试不会在电脑上多开一轮。 */
        const val DISPATCH_TRIES = 3

        /** 轮询连续断开超过这么久才算真断（期间自动重连，界面只留一行状态）。 */
        const val POLL_DOWN_MS = 30_000L

        /** 界面那一行状态：说人话，不写重试策略、不写内部名词。 */
        const val LINK_LOST_TEXT = "信号不好，正在重连…"
        const val SEND_RETRY_TEXT = "发送没成功，重试中…"
    }
}
