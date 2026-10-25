package com.whale.pet

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager

/**
 * 透明承接页：悬浮窗（Service）不能自己弹运行时权限，只能起一个 Activity。
 * 只申请 RECORD_AUDIO，拿到结果立刻把「给没给」回传给 FloatingPetService 并结束，
 * 界面上什么都不画，不打断用户桌面操作。
 */
class PermissionProxyActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            finishWith(true)
            return
        }
        try {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
        } catch (_: Exception) {
            finishWith(false)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        finishWith(granted)
    }

    private fun finishWith(granted: Boolean) {
        try {
            startService(
                Intent(this, FloatingPetService::class.java)
                    .setAction(FloatingPetService.ACTION_MIC_RESULT)
                    .putExtra(FloatingPetService.EXTRA_MIC_GRANTED, granted),
            )
        } catch (_: Exception) {
        }
        finish()
        overridePendingTransition(0, 0)
    }

    private companion object {
        const val REQ_MIC = 9001
    }
}
