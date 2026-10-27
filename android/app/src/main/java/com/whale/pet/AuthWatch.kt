package com.whale.pet

import android.content.Context
import android.util.Log
import java.util.concurrent.atomic.AtomicLong

/**
 * 「这台手机的配对失效了」的唯一出口。
 *
 * 宿主那侧只有一个共享 token（~/.dsh/pet-voice/token）。它被删掉、被换掉，
 * 或者这台手机装回了旧数据，宿主的每个接口都会回 401——但 App 以前只写一行
 * `asr http=401`，用户看到的是「按住说话没反应」，既没有提示也不知道要重新扫码。
 *
 * 这里不重试、不自动换绑（换绑会把旧电脑上的设备记录弄脏）：只做两件事——
 * 记一个可查的标志，按节流叫一声，让人知道该去重新配对。
 */
object AuthWatch {
    private const val TAG = "PetAuth"
    private const val PREFS = "pet_prefs"
    private const val KEY_NEED_PAIR = "need_pair"
    private const val MIN_GAP_MS = 60_000L

    private val lastFired = AtomicLong(0L)

    /** 由 FloatingPetService 注入：拿到 401 时用它冒个泡。 */
    @Volatile
    var onUnauthorized: (() -> Unit)? = null

    fun fire() {
        val now = System.currentTimeMillis()
        val prev = lastFired.get()
        if (now - prev < MIN_GAP_MS) return
        if (!lastFired.compareAndSet(prev, now)) return
        Log.i(TAG, "宿主回 401：这台手机的令牌已失效，需要重新配对")
        try {
            onUnauthorized?.invoke()
        } catch (e: Exception) {
            Log.w(TAG, "提示失败：${e.javaClass.simpleName}")
        }
    }

    /** 开机/启动时问一次：上次是不是还欠着一次重新配对。 */
    fun pending(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_NEED_PAIR, false)

    fun remember(ctx: Context) {
        prefs(ctx).edit().putBoolean(KEY_NEED_PAIR, true).apply()
    }

    fun clear(ctx: Context) {
        lastFired.set(0L)
        prefs(ctx).edit().putBoolean(KEY_NEED_PAIR, false).apply()
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
