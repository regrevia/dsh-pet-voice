package com.whale.pet

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import java.io.File
import java.security.MessageDigest

/**
 * 自更新：宿主 `GET /api/update` 拿到版本 → 下载 APK → `PackageInstaller` 覆盖安装。
 *
 * 为什么用 PackageInstaller 而不是 `ACTION_VIEW + file://`：
 *  - file:// 从 Android 7 起抛 FileUriExposedException，要 FileProvider，
 *    而本项目零 androidx 依赖（离线构建，只有 zxing 一个 jar），Session API 不要额外库；
 *  - Session API 还能拿到安装结果回调，失败原因能给用户看（「签名不一致」这种必须说清楚）。
 *
 * 覆盖安装的三个前提（缺一个就会失败/丢数据）：
 *  1. 同一个 applicationId（com.whale.pet）——package 名不变；
 *  2. **同一个签名密钥**（android/keystore/pet-release.jks）——换 key 会 INSTALL_FAILED_UPDATE_INCOMPATIBLE；
 *  3. 新包 versionCode 更大。
 * 满足这三条时系统是「就地升级」：`SharedPreferences`（pet_prefs：宿主地址/令牌/唤醒词）
 * 和已授权限都保留，不需要重新配对。**绝对不能先卸载再装**——那样数据会没。
 */
class UpdateManager(private val ctx: Context, private val client: PetClient) {

    data class Info(
        val versionCode: Int,
        val versionName: String,
        val path: String,
        val sha256: String,
        val size: Long,
        val notes: String,
    )

    companion object {
        private const val TAG = "PetUpdate"
        const val ACTION_INSTALL_RESULT = "com.whale.pet.UPDATE_RECEIPT"
        const val EXTRA_STATUS = "status"
        const val EXTRA_MESSAGE = "message"
        private const val PREFS_LAST_CHECK = "last_update_check"
    }

    fun currentVersionCode(): Int = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).let {
            @Suppress("DEPRECATION")
            it.versionCode
        }
    } catch (_: Exception) {
        BuildConfig.VERSION_CODE
    }

    fun currentVersionName(): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
    } catch (_: Exception) {
        BuildConfig.VERSION_NAME
    }

    /** 宿主说有没有比本机新的版本；网络/鉴权失败一律当「没有」，静默，不打扰用户。 */
    fun check(): Info? {
        val res = client.update()
        if (!res.ok) {
            lastCheck = "error"
            Log.i(TAG, "check 失败：${res.code}")
            return null
        }
        val j = res.json
        if (j == null || !j.optBoolean("ok", false)) {
            lastCheck = "error"
            return null
        }
        val code = j.optInt("versionCode", 0)
        if (code <= currentVersionCode()) {
            lastCheck = "none"
            return null
        }
        val path = j.optString("url").ifBlank { "/pet-voice/download/" + j.optString("file") }
        if (path.isBlank()) return null
        return Info(
            versionCode = code,
            versionName = j.optString("versionName"),
            path = path,
            sha256 = j.optString("sha256"),
            size = j.optLong("size", 0),
            notes = j.optString("notes"),
        ).also { lastCheck = "ok" }
    }

    fun shouldAutoCheck(): Boolean {
        val prefs = ctx.getSharedPreferences("pet_prefs", Context.MODE_PRIVATE)
        val last = prefs.getLong(PREFS_LAST_CHECK, 0)
        return System.currentTimeMillis() - last > 6 * 3600_000L
    }

    fun markChecked() {
        ctx.getSharedPreferences("pet_prefs", Context.MODE_PRIVATE).edit()
            .putLong(PREFS_LAST_CHECK, System.currentTimeMillis()).apply()
    }

    /** 下载到 cacheDir/update/<version>.apk；sha256 不匹配就当失败（防止下到半截的包）。 */
    fun download(info: Info, onProgress: ((Int) -> Unit)? = null): File? {
        val dir = File(ctx.filesDir, "update").apply { mkdirs() }
        val dest = File(dir, "jingling-${info.versionName}-${info.versionCode}.apk")
        // 只留正在装的那一个包，旧版本下过的都是垃圾
        dir.listFiles()?.forEach { if (it.name != dest.name) it.delete() }
        if (dest.exists() && info.sha256.isNotBlank() && sha256(dest) == info.sha256) return dest
        val written = client.downloadTo(info.path, dest, onProgress)
        if (written <= 0) return null
        if (info.sha256.isNotBlank()) {
            val got = sha256(dest)
            if (!got.equals(info.sha256, ignoreCase = true)) {
                Log.w(TAG, "sha256 不匹配，丢弃本次下载")
                dest.delete()
                return null
            }
        }
        return dest
    }

    /** 最近一次安装失败的真实原因；界面显示 + 回传宿主日志，避免只看到一句「安装失败」。 */
    @Volatile
    var lastError: String = ""
        private set

    fun report(tag: String, msg: String) {
        try {
            client.log(tag, msg)
        } catch (_: Exception) {
        }
    }

    /** 最近一次检查的结果：ok / none / error。 */
    @Volatile
    var lastCheck: String = ""
        private set

    /** 本地已下好、且确实比本机新的包；没有就 null。 */
    fun cachedApk(): Pair<File, Int>? {
        val prefs = ctx.getSharedPreferences("pet_prefs", Context.MODE_PRIVATE)
        val path = prefs.getString("pending_apk_path", "").orEmpty()
        val code = prefs.getInt("pending_apk_code", 0)
        if (path.isBlank() || code <= currentVersionCode()) return null
        val f = File(path)
        if (!f.isFile || f.length() <= 0) return null
        return f to code
    }

    /** 清掉本地已下的包（装成功、或服务器上已经没有更新时）。 */
    fun dropCache() {
        val prefs = ctx.getSharedPreferences("pet_prefs", Context.MODE_PRIVATE)
        prefs.edit()
            .remove("pending_apk_path").remove("pending_apk_code").remove("pending_apk_name")
            .apply()
        try {
            File(ctx.filesDir, "update").listFiles()?.forEach { it.delete() }
        } catch (_: Exception) {
        }
    }

    fun canInstall(): Boolean = try {
        ctx.packageManager.canRequestPackageInstalls()
    } catch (_: Exception) {
        true
    }

    fun openInstallPermission() {
        try {
            ctx.startActivity(
                Intent(
                    android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    android.net.Uri.parse("package:${ctx.packageName}"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (e: Exception) {
            Log.w(TAG, "打不开安装权限页：${e.javaClass.simpleName}")
        }
    }

    /**
     * 真正覆盖安装。结果通过广播回 [ACTION_INSTALL_RESULT]；
     * 调用方（MainActivity）注册一个运行时 receiver 收结果给用户看。
     */
    fun install(file: File): Boolean {
        return try {
            val pi = ctx.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(ctx.packageName)
            val sessionId = pi.createSession(params)
            pi.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val intent = Intent(ctx, InstallResultReceiver::class.java)
                // 必须 MUTABLE：STATUS / STATUS_MESSAGE / EXTRA_INTENT 是系统安装器回填的，
                // IMMUTABLE 会把回填丢掉，回调只剩默认值，看起来永远「安装失败」。
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val pi2 = PendingIntent.getBroadcast(ctx, sessionId, intent, flags)
                session.commit(pi2.intentSender)
            }
            true
        } catch (e: Exception) {
            lastError = "${e.javaClass.simpleName}: ${e.message}"
            Log.w(TAG, "install 失败：$lastError")
            report("install-session-failed", lastError)
            sendResult("failed", e.message ?: e.javaClass.simpleName)
            false
        }
    }

    private fun sendResult(status: String, message: String) {
        ctx.sendBroadcast(
            Intent(ACTION_INSTALL_RESULT).setPackage(ctx.packageName)
                .putExtra(EXTRA_STATUS, status)
                .putExtra(EXTRA_MESSAGE, message),
        )
    }

    private fun sha256(f: File): String = try {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        md.digest().joinToString("") { "%02x".format(it) }
    } catch (_: Exception) {
        ""
    }
}

/** PackageInstaller 的提交结果（系统安装器是另一个进程，结束会广播回来）。 */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()
        // 1 = 系统安装器要用户点「安装」：把确认页拉起来。这不是失败，已下好的包也不清。
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val page: Intent? = if (Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            }
            if (page != null) {
                page.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    context.startActivity(page)
                } catch (e: Exception) {
                    Log.w("PetUpdate", "拉安装页失败：${e.javaClass.simpleName}")
                }
            }
            return
        }
        val ok = status == PackageInstaller.STATUS_SUCCESS
        val text = when {
            ok -> "安装成功 · 马上就是新版本啦"
            status == PackageInstaller.STATUS_FAILURE_ABORTED -> ""
            msg.contains("UPDATE_INCOMPATIBLE", true) || msg.contains("signatures", true) ->
                "签名不一致：新包必须用同一个 pet-release.jks 签"
            else -> "安装失败：$msg"
        }
        android.util.Log.i("PetUpdate", "install result $status $text")
        context.sendBroadcast(
            Intent(UpdateManager.ACTION_INSTALL_RESULT).setPackage(context.packageName)
                .putExtra(UpdateManager.EXTRA_STATUS, if (ok) "ok" else "failed")
                .putExtra(UpdateManager.EXTRA_MESSAGE, text),
        )
    }
}
