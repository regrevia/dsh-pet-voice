package com.whale.pet

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.os.Process
import android.provider.Settings

/**
 * 「查看使用情况」权限：判断是否已允许，以及跳系统开关。
 *
 * 只有「只在桌面显示」需要它：要判断前台是不是桌面，就得读前台应用。
 * 查不到（个别 ROM 不认这个 op）时按「已允许」处理——宁可按桌面显示，也别把小人整个藏没。
 */
object UsageAccess {

    fun granted(context: Context): Boolean = try {
        val ops = context.getSystemService(AppOpsManager::class.java)
        ops.checkOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            context.packageName,
        ) == AppOpsManager.MODE_ALLOWED
    } catch (_: Exception) {
        true
    }

    fun open(context: Context) {
        try {
            context.startActivity(
                Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: Exception) {
        }
    }
}
