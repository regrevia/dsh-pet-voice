package com.whale.pet

import android.content.Context
import android.util.Log

/**
 * 「手机发出去的那一轮」的兜底观察者。
 *
 * 聊天页自己用 SSE 收回复，可人一旦退出 App（只是退到后台，不是杀掉），页面没了、SSE 也没了，
 * 宿主那边这一轮还在跑，回来却看不到回复——用户的原话是「点了发送退出 app 就收不到回复」。
 *
 * 所以发送之后就在常驻服务里挂一只观察者：轮询这只会话的最后一条回复，
 * 按句子边界把新增的部分交给桌宠讲出来，轮次结束再把整段落进对话历史。
 * App 在前台时不说话（页面上已经看得到，避免重复），只记账。
 */
object ChatWatch {
    private const val TAG = "PetChatWatch"
    private const val POLL_MS = 1_500L
    private const val MAX_MS = 12 * 60_000L
    /** 增量攒到这么长就讲，别等句号（长句、代码块里可能一直没有标点）。 */
    private const val SPEAK_MIN = 36
    /** 连续这么多次没变化就当这轮结束了。 */
    private const val STABLE_POLLS = 4

    @Volatile private var gen = 0
    /** 只在日志里说一次「这一轮是页面在讲」，别每句都刷。 */
    private var skippedLogged = false

    /** 同一只会话只保留一只观察者：再发一句就把上一条停掉重开。 */
    fun start(ctx: Context, sessionId: String) {
        val sid = sessionId.trim()
        if (sid.isEmpty()) return
        if (!FloatingPetService.alive) return
        val my = ++gen
        val app = ctx.applicationContext
        Thread({ loop(app, sid, my) }, "pet-chatwatch").apply { isDaemon = true }.start()
        Log.i(TAG, "观察 ${sid.take(18)}")
    }

    fun stop() {
        gen++
    }

    private fun loop(app: Context, sid: String, my: Int) {
        val client = PetClient { PetSettings.load(app) }
        val key = sid.removePrefix("session-")
        val began = System.currentTimeMillis()
        var seq = 0L
        var spoken = 0
        var full = ""
        var stable = 0
        // 基线：发送这一刻已经存在的那条回复，不算新内容
        runCatching {
            val arr = client.session(sid, 2).json?.optJSONArray("messages") ?: return@runCatching
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                if (o.optString("role") == "assistant") {
                    seq = o.optLong("seq")
                    spoken = o.optString("text").length
                }
            }
        }
        while (my == gen && !Thread.currentThread().isInterrupted &&
            System.currentTimeMillis() - began < MAX_MS && FloatingPetService.alive
        ) {
            if (!sleep(POLL_MS)) break
            var text = ""
            var rowSeq = seq
            runCatching {
                val arr = client.session(sid, 1).json?.optJSONArray("messages") ?: return@runCatching
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    if (o.optString("role") != "assistant") continue
                    val t = o.optString("text")
                    if (t.isNotBlank()) {
                        text = t
                        rowSeq = o.optLong("seq", seq)
                    }
                }
            }
            val running = runCatching { turnRunning(client, key) }.getOrNull()
            if (text.isNotEmpty() && (rowSeq != seq || text.length > spoken)) {
                seq = rowSeq
                if (text.length < spoken) spoken = 0
                val fresh = text.substring(spoken.coerceAtMost(text.length))
                val final = running != true
                val cut = if (final) fresh.length else sentenceCut(fresh)
                val piece = if (cut > 0) fresh.substring(0, cut) else ""
                if (piece.isNotBlank()) {
                    spoken += piece.length
                    deliver(app, piece.trim(), final = false)
                }
                if (final) {
                    if (spoken < text.length) {
                        val tail = text.substring(spoken).trim()
                        if (tail.isNotEmpty()) deliver(app, tail, final = false)
                        spoken = text.length
                    }
                    full = text
                }
                stable = 0
            } else if (text.isNotEmpty() && running != true) {
                stable++
                if (stable >= STABLE_POLLS) {
                    if (spoken < text.length) {
                        val tail = text.substring(spoken).trim()
                        if (tail.isNotEmpty()) deliver(app, tail, final = false)
                    }
                    full = text
                    break
                }
            } else if (running == true) {
                stable = 0
            }
            // 宿主已经没有这一轮、也没有新回复：收工
            if (running == false && text.isEmpty()) break
        }
        if (full.isNotBlank()) PetHistory.append(app, PetHistory.ROLE_PET, full.trim())
        Log.i(TAG, "收工 ${sid.take(18)} 讲=${spoken}")
    }

    private fun turnRunning(client: PetClient, key: String): Boolean {
        val turns = client.state().json?.optJSONObject("turns") ?: return false
        val row = turns.optJSONObject(key) ?: turns.optJSONObject("session-$key") ?: return false
        return row.optBoolean("running", true)
    }

    /** 增量里最后一个句末标点的位置；没有就等攒够长度再讲。 */
    private fun sentenceCut(s: String): Int {
        for (i in s.length - 1 downTo 0) {
            val c = s[i]
            if (c == '。' || c == '！' || c == '？' || c == '!' || c == '?' || c == '\n') {
                // 太短的碎片不值得单独合成一句
                if (i >= 6) return i + 1
                if (i + 1 >= s.length / 2) return i + 1
                return 0
            }
        }
        return if (s.length >= SPEAK_MIN + 24) SPEAK_MIN else 0
    }

    private fun deliver(app: Context, piece: String, final: Boolean) {
        if (piece.isBlank()) return
        // 页面停在前面、面板也开着语音：这一轮归页面讲，旁观者只往前记进度，不出第二把嗓子。
        // 人一走开 pageSpeaks 就是 false，这里立刻接上，接着讲没讲过的部分。
        if (VoiceGate.pageSpeaks && PetSettings.feature(app, "voice")) {
            if (!skippedLogged) {
                skippedLogged = true
                Log.i(TAG, "页面自己在讲，旁观只记进度")
            }
            return
        }
        FloatingPetService.deliverWatched(piece, final)
    }

    private fun sleep(ms: Long): Boolean = try {
        Thread.sleep(ms); true
    } catch (_: InterruptedException) {
        false
    }
}
