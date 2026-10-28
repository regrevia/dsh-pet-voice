package com.whale.pet

import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 一轮对话的耗时打点。`turnStart` = 对象出生时刻（`PetTurn` 构造时创建），
 * 每个点都打印「相对 turnStart 的毫秒数」，只写日志、不参与任何判定。
 *
 * 四个点：`connect`（SSE 连接建立/拿到响应头）→ `firstByte`（响应体第一行）
 * → `firstData`（第一行 `data:`）→ `sentence`（首句交给 TTS）。
 */
class TurnLatency {
    private val turnStartNanos = System.nanoTime()
    private val firstByteSeen = AtomicBoolean(false)
    private val firstDataSeen = AtomicBoolean(false)

    fun elapsedMs(): Long = (System.nanoTime() - turnStartNanos) / 1_000_000

    fun mark(point: String, detail: String = "") {
        Log.i(TAG, "+${elapsedMs()}ms $point${if (detail.isBlank()) "" else " $detail"}")
    }

    /** 跨线程、只记第一次的点（首字节 / 首个 `data:`）。 */
    fun markFirst(point: String, detail: String = "") {
        val gate = when (point) {
            "firstByte" -> firstByteSeen
            "firstData" -> firstDataSeen
            else -> return
        }
        if (gate.compareAndSet(false, true)) mark(point, detail)
    }

    companion object {
        const val TAG = "PetLatency"
    }
}

/**
 * 宿主 HTTP 客户端。只用 JDK 自带 HttpURLConnection（离线构建无第三方依赖）。
 *
 * - 鉴权：Cookie `pkv_<token前8位>=<token>`，与插件 index.js 一致。
 * - 不打印 token、不把请求头写进异常信息。
 */
class PetClient(private val config: () -> PetConfig) {

    data class Result(val code: Int, val text: String, val json: JSONObject?) {
        val ok: Boolean get() = code in 200..299
        fun error(): String =
            json?.optString("error").takeUnless { it.isNullOrBlank() } ?: "HTTP $code"
    }

    fun state(): Result = get("state")

    /** 宿主播报队列（`POST /api/say` 入队的句子）：`since` < 0 只对齐光标，不回放历史。 */
    fun say(since: Long): Result = get("say", mapOf("since" to since.toString()))

    /** 换绑前先把旧宿主上的这台设备解绑，别让旧电脑挂着一条假「已连接」。 */
    fun unbind(): Result = postJson("unbind", JSONObject().put("id", deviceId()))


    fun get(path: String, query: Map<String, String> = emptyMap()): Result =
        request(path, query, "GET", null, 10_000)

    fun postJson(path: String, body: JSONObject): Result =
        request(path, emptyMap(), "POST", body.toString().toByteArray(Charsets.UTF_8), 10_000)

    /**
     * 派发一句话。`sessionId` 为空 = 用宿主默认落点（专属会话，跨 App/宿主重启都能接着聊）；
     * 非空 = 钉在这一只上（「新对话」之后用，避免又被默认落点抢回去）。
     */
    fun dispatch(
        text: String,
        sessionId: String = "",
        requestId: String = java.util.UUID.randomUUID().toString(),
        /** 宿主上已落盘的图片绝对路径；插件把路径拼在这一问后面，模型自己去看图。 */
        attachments: List<String> = emptyList(),
        /** true = 插进正在跑的这一轮（桌面端的「引导」），不开新轮、不掐断。 */
        steer: Boolean = false,
    ): Result {
        // requestId 跟着这一次发送走：重发时同一句不会被当成两问，桌面端也不会复读
        val body = JSONObject().put("text", text).put("requestId", requestId)
        if (steer) body.put("steer", true)
        if (sessionId.isNotBlank()) body.put("sessionId", sessionId)
        if (attachments.isNotEmpty()) {
            val arr = org.json.JSONArray()
            attachments.forEach { arr.put(it) }
            body.put("attachments", arr)
        }
        return request(
            "dispatch",
            emptyMap(),
            "POST",
            body.toString().toByteArray(Charsets.UTF_8),
            10_000,
            attempts = 2,
        )
    }

    /** 单独问一只会话的头（标题、工作目录）；`limit=1` 只取一条转录，够轻。 */
    fun sessionInfo(id: String, limit: Int = 1): Result =
        get("session", mapOf("id" to id, "limit" to limit.toString()))

    /** `fresh=true` 强制新开一只会话；不带 fresh 则复用宿主记住的那只。 */
    fun newSession(fresh: Boolean = false): Result =
        postJson("new", JSONObject().put("fresh", fresh))

    /** 一句话意图：聊天还是指令，由插件解析；chat 的调用方自己再走 dispatch。 */
    fun command(text: String): Result = postJson("command", JSONObject().put("text", text))

    /**
     * 客户端诊断：一行 JSON 落到宿主 ~/.dsh/pet-voice/logs/client.log。
     * 只用于「安装失败到底为什么」这类必须看真机才能答的问题，失败静默、绝不打断主流程。
     */
    fun log(tag: String, msg: String): Result = postJson(
        "log",
        JSONObject()
            .put("tag", tag)
            .put("msg", msg.take(2000))
            .put("ver", BuildConfig.VERSION_NAME)
            .put("code", BuildConfig.VERSION_CODE)
            .put("sdk", android.os.Build.VERSION.SDK_INT)
            .put("model", android.os.Build.MODEL)
            .put("ready", try { config().ready } catch (_: Exception) { false }),
    )

    /** 会话列表 + 现在钉在哪只。 */
    fun sessions(): Result = get("sessions")

    /** 助手 Markdown → HTML 片段；样式由客户端统一包（`ChatRender`）。 */
    fun render(text: String): Result = postJson("render", JSONObject().put("text", text))
    /** 掐掉这只会话正在跑的这一轮（宿主 sessionController.cancel）。 */
    fun cancel(sessionId: String): Result = postJson("cancel", JSONObject().put("sessionId", sessionId))

    /** 还没轮到跑的那几句（桌面端「待输入」）；每句带 id，手机可以撤掉或调顺序。 */
    fun inbox(sessionId: String): Result = get("inbox", mapOf("sessionId" to sessionId))

    /** remove / up / down：改的就是桌面端同一份队列。 */
    fun inboxAction(sessionId: String, action: String, id: String): Result =
        postJson("inbox", JSONObject().put("sessionId", sessionId).put("action", action).put("id", id))

    /** 这只会话当前的目标，没有就空数组。 */
    fun goals(sessionId: String): Result = get("goals", mapOf("sessionId" to sessionId))

    /** 宿主上的图片字节（`/api/file?path=`）：聊天里要直接看到电脑上的图。 */
    fun fileBytes(path: String): ByteArray? {
        val conn = open("file", mapOf("path" to path), "GET", 15_000)
        return try {
            if (conn.responseCode !in 200..299) {
                conn.errorStream?.close()
                null
            } else {
                conn.inputStream.use { it.readBytes() }
            }
        } catch (_: Exception) {
            null
        } finally {
            runCatching { conn.disconnect() }
        }
    }

    /** 把 APP 的对话钉到指定会话（写宿主 pet-session.json，之后 dispatch 都落到它）。 */
    fun bind(sessionId: String): Result = postJson("bind", JSONObject().put("sessionId", sessionId))

    /** 项目列表 + 「现在钉在哪」（pinned）。 */
    fun workspaces(): Result = get("workspaces")

    /* ---------------- 项目 / 会话浏览（App 版 DSH） ---------------- */

    /**
     * `GET /api/projects` → `{ok, projects:[{id,title,path}]}`。
     * 宿主还没上线这个接口时就是 404，调用方按空列表处理，不崩。
     */
    fun projects(): Result = get("projects")

    /** `GET /api/sessions?projectId=&limit=&before=`：before 是上一页最后一条的 updatedAt（毫秒）。 */
    fun sessions(projectId: String, limit: Int = 20, before: Long? = null): Result {
        val q = linkedMapOf("projectId" to projectId, "limit" to limit.toString())
        if (before != null && before > 0) q["before"] = before.toString()
        return get("sessions", q)
    }

    /** `GET /api/session?id=&limit=&before=`：before 是上一页最早一条的 seq。 */
    fun session(id: String, limit: Int = 20, before: Long? = null): Result {
        val q = linkedMapOf("id" to id, "limit" to limit.toString())
        if (before != null && before > 0) q["before"] = before.toString()
        return get("session", q)
    }

    /** 目标操作：暂停 / 继续 / 标记完成。走的是桌面端同一套宿主接口。 */
    fun goalAction(sessionId: String, action: String, id: String, revision: Int): Result =
        postJson(
            "goal",
            JSONObject()
                .put("sessionId", sessionId)
                .put("action", action)
                .put("id", id)
                .put("revision", revision),
        )

    /** 切项目：把专属会话钉到目标项目上。 */
    fun switchWorkspace(workspaceId: String): Result =
        postJson("switch", JSONObject().put("workspaceId", workspaceId))

    fun poll(sessionId: String, cursor: Int, waitMs: Int): Result = request(
        "poll",
        mapOf(
            "sessionId" to sessionId,
            "cursor" to cursor.toString(),
            "wait" to waitMs.toString(),
        ),
        "GET",
        null,
        45_000,
    ).also { r -> r.json?.optInt("cursor", -1)?.let { if (it >= 0) NetLog.seq(it) } }

    /** SSE：返回体自己按行解析；调用方负责 close。传 latency 时打 connect/firstByte/firstData 三个点。 */
    fun openStream(sessionId: String, latency: TurnLatency? = null): Stream {
        val query = if (sessionId.isBlank()) emptyMap() else mapOf("sessionId" to sessionId)
        // 30s 内一个字节都没有（断开的心跳也算）就当链路死了：抛 SocketTimeout，交给上层重连
        val conn = open("stream", query, "GET", 30_000)
        val code = conn.responseCode
        latency?.mark("connect", "path=/api/stream http=$code")
        if (code !in 200..299) {
            val text = conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            conn.disconnect()
            throw IOException("SSE HTTP $code ${text.take(160)}")
        }
        val reader = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8))
        return Stream(conn, reader, latency)
    }

    class Stream internal constructor(
        private val conn: HttpURLConnection,
        private val reader: BufferedReader,
        private val latency: TurnLatency? = null,
    ) {
        /** 解析下一条 SSE 事件；流结束返回 null。心跳注释行会被跳过。 */
        fun nextEvent(): Pair<String, JSONObject>? {
            val event = StringBuilder()
            val data = StringBuilder()
            while (true) {
                val line = reader.readLine() ?: return null
                latency?.markFirst("firstByte", "line=${line.take(24)}")
                if (line.isEmpty()) {
                    if (data.isNotEmpty()) {
                        val json = data.toString().toJsonOrNull() ?: JSONObject()
                        return event.toString().ifBlank { "message" } to json
                    }
                    event.setLength(0)
                    continue
                }
                if (line.startsWith(":")) continue
                if (line.startsWith("retry:")) continue
                when {
                    line.startsWith("event:") -> {
                        event.setLength(0)
                        event.append(line.removePrefix("event:").trim())
                    }

                    line.startsWith("data:") -> {
                        latency?.markFirst(
                            "firstData",
                            "event=${event.toString().ifBlank { "message" }}",
                        )
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(line.removePrefix("data:").trimStart())
                    }
                }
            }
        }

        fun close() {
            // 先断连接让阻塞中的 readLine 立刻返回，再交给后台收尾，调用方（含主线程）不等
            try {
                conn.disconnect()
            } catch (_: Exception) {
            }
            try {
                Thread({ try { reader.close() } catch (_: Exception) {} }, "pet-stream-close")
                    .apply { isDaemon = true; start() }
            } catch (_: Exception) {
            }
        }
    }

    /** 拉一段 mp3 到本地文件；非音频/过短视为失败（TTS 缺 edge-tts 时服务端 503）。 */
    fun downloadTts(text: String, preset: String, dest: File, raw: Boolean = true) {
        // 拆分「宿主合成(到响应头)」与「拉音频体」两段耗时，用来判断 TTS 慢在服务端还是链路。
        val t0 = System.nanoTime()
        // stream=1：宿主来一块吐一块（PET_TTS_RAW），不攒完整句、不跑 ffmpeg 掐头去尾
        val conn = open("tts", mapOf("text" to text, "preset" to preset, "stream" to if (raw) "1" else "0"), "GET", 60_000)
        try {
            val code = conn.responseCode
            val headersMs = (System.nanoTime() - t0) / 1_000_000
            if (code !in 200..299) {
                val msg = conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                throw IOException("TTS HTTP $code ${msg.take(160)}")
            }
            val type = conn.contentType.orEmpty()
            if (!type.startsWith("audio/")) throw IOException("TTS 返回的不是音频：$type")
            dest.parentFile?.mkdirs()
            conn.inputStream.use { input -> dest.outputStream().use { input.copyTo(it) } }
            if (dest.length() < 512) throw IOException("TTS 音频过短（${dest.length()}B）")
            val totalMs = (System.nanoTime() - t0) / 1_000_000
            Log.i(
                TurnLatency.TAG,
                "tts headers=${headersMs}ms body=${totalMs - headersMs}ms total=${totalMs}ms " +
                    "bytes=${dest.length()} chars=${text.length}",
            )
        } finally {
            conn.disconnect()
        }
    }

    /** 流式 TTS 会话：响应头已到手，body 由调用方边读边喂播放器。 */
    class TtsStream(
        private val conn: HttpURLConnection,
        val input: java.io.InputStream,
        val headersMs: Long,
    ) {
        fun close() {
            try {
                input.close()
            } catch (_: Exception) {
            }
            try {
                conn.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    /**
     * 打开流式 TTS：拿到响应头就返回（`?stream=1`），不做整段下载。
     * 非 200 / 不是音频立刻抛，调用方自行回退成整段下载。
     */
    fun openTtsStream(text: String, preset: String): TtsStream {
        val t0 = System.nanoTime()
        val conn = open("tts", mapOf("text" to text, "preset" to preset, "stream" to "1"), "GET", 60_000)
        try {
            val code = conn.responseCode
            if (code !in 200..299) {
                val msg = conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                throw IOException("TTS HTTP $code ${msg.take(160)}")
            }
            val type = conn.contentType.orEmpty()
            if (!type.startsWith("audio/")) throw IOException("TTS 返回的不是音频：$type")
            return TtsStream(conn, conn.inputStream, (System.nanoTime() - t0) / 1_000_000)
        } catch (e: Exception) {
            try {
                conn.disconnect()
            } catch (_: Exception) {
            }
            throw e
        }
    }

    /**
     * 语音识别：把一整段 WAV（16k 单声道）丢给宿主 `POST /api/asr`，返回 `{"ok":true,"text":"…"}`。
     *
     * 为什么走宿主：OEM 机器经常没有系统 `SpeechRecognizer`（`isAvailable()` 直接 false），
     * 宿主机上的 whisper base 实测 3.4s 音频 0.17s 出结果，比手机本地识别更稳也更准。
     */
    fun asr(wav: ByteArray): Result {
        val t0 = System.nanoTime()
        val conn = open("asr", emptyMap(), "POST", 40_000)
        try {
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(wav.size)
            conn.setRequestProperty("Content-Type", "audio/wav")
            conn.outputStream.use { it.write(wav) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            Log.i(
                TurnLatency.TAG,
                "asr ${(System.nanoTime() - t0) / 1_000_000}ms wav=${wav.size}B http=$code",
            )
            noteAuth(code)
            return Result(code, text, text.toJsonOrNull())
        } finally {
            conn.disconnect()
        }
    }

    /**
     * 发图：原始字节丢给宿主 `POST /api/upload`，宿主落到项目目录里并回绝对路径。
     * 走原始字节而不是 multipart —— 宿主那边不用解析表单，App 这边也不用拼边界。
     */
    fun uploadImage(bytes: ByteArray, name: String, mime: String): Result {
        val t0 = System.nanoTime()
        val conn = open("upload", mapOf("name" to name), "POST", 60_000)
        try {
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.setRequestProperty("Content-Type", mime)
            conn.outputStream.use { it.write(bytes) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            val ms = (System.nanoTime() - t0) / 1_000_000
            NetLog.record("POST /api/upload", code, ms, "${bytes.size / 1024}KB $mime")
            noteAuth(code)
            return Result(code, text, text.toJsonOrNull())
        } finally {
            conn.disconnect()
        }
    }

    /**
     * 传一个文件（视频/图片都走这条）：边读边发，不把 200 MB 的片子读进内存。
     *
     * [onProgress] 在发数据的线程里回调 0–100，调用方自己转主线程。
     */
    fun uploadMedia(file: java.io.File, name: String, mime: String, onProgress: (Int) -> Unit): Result {
        val t0 = System.nanoTime()
        val total = file.length()
        val conn = open("upload", mapOf("name" to name), "POST", 600_000)
        try {
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(total)
            conn.setRequestProperty("Content-Type", mime)
            conn.outputStream.use { out ->
                file.inputStream().use { input ->
                    val buf = ByteArray(64 * 1024)
                    var sent = 0L
                    var last = -1
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        sent += n
                        val pct = if (total > 0) ((sent * 100) / total).toInt() else 100
                        if (pct != last) {
                            last = pct
                            onProgress(pct)
                        }
                    }
                }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
            val ms = (System.nanoTime() - t0) / 1_000_000
            NetLog.record("POST /api/upload", code, ms, "${total / 1024}KB $mime")
            noteAuth(code)
            return Result(code, text, text.toJsonOrNull())
        } finally {
            conn.disconnect()
        }
    }

    /** 宿主端有没有比本机新的 APK（`GET /api/update`）。 */
    fun update(): Result = get("update", emptyMap())

    /**
     * 把宿主上的 APK 拉到本地。`path` 是 `/api/update` 里给的绝对路径
     * （`/pet-voice/download/xxx.apk`），所以不能用 [open] 那套 `apiBase + path`。
     */
    fun downloadTo(path: String, dest: File, onProgress: ((Int) -> Unit)? = null): Long {
        val cfg = config()
        val uri = java.net.URI(cfg.baseUrl)
        val abs = if (path.startsWith("/")) path else "/$path"
        val conn = URL("${uri.scheme}://${uri.rawAuthority}$abs").openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.connectTimeout = 2_500
        conn.readTimeout = 180_000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("Cookie", cfg.cookieHeader)
        conn.setRequestProperty("User-Agent", "WhalePet/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.SDK_INT}; ${deviceName()})")
        conn.setRequestProperty("X-Pet-Device", deviceName())
        conn.setRequestProperty("X-Pet-Device-Id", deviceId())
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IOException("APK HTTP $code")
            val total = conn.contentLengthLong
            dest.parentFile?.mkdirs()
            var read = 0L
            val buf = ByteArray(64 * 1024)
            conn.inputStream.use { input ->
                dest.outputStream().use { out ->
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        read += n
                        if (total > 0) onProgress?.invoke(((read * 100) / total).toInt())
                    }
                }
            }
            if (read <= 0) {
                dest.delete()
                return 0
            }
            return read
        } finally {
            conn.disconnect()
        }
    }

    /** 401 只有一个含义：令牌对不上。统一在这里冒泡，别每条路径各写一遍。 */
    private fun noteAuth(code: Int) {
        if (code == 401) AuthWatch.fire()
    }

    private fun request(
        path: String,
        query: Map<String, String>,
        method: String,
        body: ByteArray?,
        readTimeoutMs: Int,
        attempts: Int = 1,
    ): Result {
        var last: Exception? = null
        var quickRetried = false
        var attempt = 1
        while (attempt <= attempts) {
            val t0 = System.currentTimeMillis()
            try {
                val conn = open(path, query, method, readTimeoutMs)
                try {
                    if (body != null) {
                        conn.doOutput = true
                        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                        conn.outputStream.use { it.write(body) }
                    }
                    val code = conn.responseCode
                    val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                    val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                    NetLog.record(
                        "$method /api/$path",
                        code,
                        System.currentTimeMillis() - t0,
                        if (attempt > 1) "第 $attempt 次" else "",
                    )
                    // 401 = 这台手机的令牌和宿主对不上了（宿主那边换过 token / 重装过）。
                    // 以前只打一行日志，用户看到的是「点一下没反应」，必须说出来。
                    noteAuth(code)
                    return Result(code, text, text.toJsonOrNull())
                } finally {
                    conn.disconnect()
                }
            } catch (e: Exception) {
                last = e
                val connectFail = e is SocketTimeoutException || e is ConnectException
                val willRetry = attempt < attempts || (connectFail && !quickRetried)
                NetLog.record(
                    "$method /api/$path",
                    0,
                    System.currentTimeMillis() - t0,
                    "失败 ${e.javaClass.simpleName}" + if (willRetry) " 重试" else "",
                )
                if (connectFail && !quickRetried) {
                    // 建连失败多半是握手包丢了：立刻重新握手，不等 600ms、更不等满建连超时
                    quickRetried = true
                    continue
                }
                if (attempt >= attempts) break
                attempt++
                // 网络切换的那一瞬间最容易失败：同一请求原地等 600ms 再试
                try {
                    Thread.sleep(600)
                } catch (_: InterruptedException) {
                }
            }
        }
        throw last as? java.io.IOException ?: IOException(last?.message ?: "请求失败")
    }

    private fun open(
        path: String,
        query: Map<String, String>,
        method: String,
        readTimeoutMs: Int,
    ): HttpURLConnection {
        val cfg = config()
        val sb = StringBuilder(cfg.apiBase).append(path)
        if (query.isNotEmpty()) {
            sb.append('?')
            sb.append(
                query.entries.joinToString("&") { (k, v) ->
                    URLEncoder.encode(k, "UTF-8") + "=" + URLEncoder.encode(v, "UTF-8")
                },
            )
        }
        val conn = URL(sb.toString()).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 2_500
        conn.readTimeout = readTimeoutMs
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("Cookie", cfg.cookieHeader)
        conn.setRequestProperty("Accept", "application/json, text/event-stream")
        conn.setRequestProperty("User-Agent", "WhalePet/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.SDK_INT}; ${deviceName()})")
        conn.setRequestProperty("X-Pet-Device", deviceName())
        conn.setRequestProperty("X-Pet-Device-Id", deviceId())
        return conn
    }

    companion object {
        /**
         * 面板「已连上的手机」里显示的名字：厂商 + 机型（`Xiaomi Redmi K80 Pro`）。
         * 走请求头而不是 UA 解析，国产 ROM 的 UA 常常只有 `Android` 或一串 Build 号。
         */
        fun deviceName(): String {
            val manu = Build.MANUFACTURER.orEmpty().trim()
            val model = Build.MODEL.orEmpty().trim()
            val name = when {
                model.isBlank() -> manu.ifBlank { "Android" }
                manu.isBlank() || model.startsWith(manu, true) -> model
                else -> "$manu $model"
            }
            return name.replace(Regex("\\s+"), " ").take(40)
        }

        /** 同一台机器换 UA / 换 IP 也要认成同一台：用机型 + 系统指纹做稳定 id。 */
        fun deviceId(): String {
            val seed = "${Build.MANUFACTURER}|${Build.MODEL}|${Build.FINGERPRINT}|${Build.DEVICE}"
            val digest = java.security.MessageDigest.getInstance("SHA-1").digest(seed.toByteArray())
            return digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }.take(12)
        }
    }
}

private fun String.toJsonOrNull(): JSONObject? = try {
    JSONObject(this)
} catch (_: Exception) {
    null
}
