package com.whale.pet

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * 开机/升级后只恢复「悬浮窗 + 常驻通知」，不申请麦克风。
 *
 * Android 14+ 禁止从后台（含 BOOT_COMPLETED）启动 microphone 类型的前台服务，
 * 直接起会被拒；所以这里发 ACTION_RESTORE，服务端用 specialUse 类型起步，
 * 等用户自己双击悬浮窗再走语音识别。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val cfg = PetSettings.load(context)
        if (!cfg.autoStart || !cfg.ready) return
        if (!Settings.canDrawOverlays(context)) return
        try {
            val i = Intent(context, FloatingPetService::class.java)
                .setAction(FloatingPetService.ACTION_RESTORE)
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(i)
            } else {
                context.startService(i)
            }
        } catch (e: Exception) {
            Log.w("WhalePet", "boot restore failed: ${e.javaClass.simpleName}")
        }
    }
}
