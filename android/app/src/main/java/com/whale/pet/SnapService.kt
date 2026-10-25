package com.whale.pet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * 截屏时临时存在的前台服务：拿到授权结果 → 截一帧 → 立刻停自己。
 *
 * Android 14 起，`getMediaProjection()` 必须有 mediaProjection 类型的前台服务兜底，
 * 所以哪怕只截一帧也得走这一趟。手机上会闪过一条通知，随服务一起消失。
 */
class SnapService : Service() {

    companion object {
        private const val TAG = "PetSnap"
        const val EXTRA_CODE = "screen_code"
        const val EXTRA_DATA = "screen_data"
        private const val NOTI_ID = 0x5357
        private const val CHANNEL = "pet_snap"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground()
        val code = intent?.getIntExtra(EXTRA_CODE, 0) ?: 0
        @Suppress("DEPRECATION")
        val data = intent?.getParcelableExtra<Intent>(EXTRA_DATA)
        if (data == null) {
            finish(null)
            return START_NOT_STICKY
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        val projection = runCatching { manager.getMediaProjection(code, data) }.getOrNull()
        if (projection == null) {
            Log.w(TAG, "拿不到投影授权")
            finish(null)
            return START_NOT_STICKY
        }
        ScreenSnap.grab(this, projection) { bytes -> finish(bytes) }
        return START_NOT_STICKY
    }

    private fun finish(bytes: ByteArray?) {
        ScreenSnap.deliver(bytes)
        stopSelf()
    }

    private fun goForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "截屏", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle("正在截屏")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()
        runCatching {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTI_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            } else {
                startForeground(NOTI_ID, notification)
            }
        }.onFailure { Log.w(TAG, "前台服务起不来：${it.javaClass.simpleName}") }
    }
}
