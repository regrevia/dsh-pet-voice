package com.whale.pet

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * 从电脑上抓图给列表/看图页用：带鉴权、内存 LruCache（按 KB 计）、磁盘缓存。
 *
 * - 同一 (路径, 目标边长) 同时只发一次请求，后来的回调排队复用（去重）。
 * - 后台线程解码，回调统一回主线程；调用方用 View.tag 校验，行复用不会串图。
 * - 失败给 null，由调用方画占位；这里不 toast、不打日志（路径里可能有用户文件名）。
 */
object HostImage {

    /** 一张图最多 12 MB（跟宿主 /api/file 的上限一致）。 */
    private const val MAX_BYTES = 12 * 1024 * 1024
    /** 磁盘缓存的新鲜期：宿主给 Cache-Control: max-age=600。 */
    private const val DISK_TTL_MS = 10 * 60 * 1000L
    private const val DISK_BUDGET = 64L * 1024 * 1024

    private val main = Handler(Looper.getMainLooper())
    private val pool = Executors.newFixedThreadPool(2) { r -> Thread(r, "host-image") }
    private val pending = ConcurrentHashMap<String, MutableList<(Bitmap?) -> Unit>>()
    private val cancelled = ConcurrentHashMap<String, Boolean>()

    private val memory = object : android.util.LruCache<String, Bitmap>(10 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = maxOf(value.byteCount / 1024, 1)
    }

    /** 内存里已有的图；没有返回 null（列表第一次绑定时用来同步占位）。 */
    fun peek(path: String, maxPx: Int): Bitmap? = memory.get(keyOf(path, maxPx))

    /**
     * 加载图片。[maxPx] 是解码后的长边上限（看情况传屏幕长边或缩略图宽度）。
     * 回调在主线程，失败给 null。返回 key，可用于 [cancel]。
     */
    fun load(context: Context, path: String, maxPx: Int, onDone: (Bitmap?) -> Unit): String {
        val key = keyOf(path, maxPx)
        cancelled.remove(key)
        memory.get(key)?.let { hit ->
            main.post { onDone(hit) }
            return key
        }
        val app = context.applicationContext
        var queued = false
        pending.compute(key) { _, list ->
            queued = list != null
            (list ?: ArrayList()).also { it.add(onDone) }
        }
        if (queued) return key
        pool.execute {
            val bitmap = try {
                runCatching { obtain(app, path, maxPx) }.getOrNull()
            } catch (e: Throwable) {
                null
            }
            if (cancelled.remove(key) != null) {
                pending.remove(key)
                return@execute
            }
            if (bitmap != null) memory.put(key, bitmap)
            val waiters = pending.remove(key) ?: emptyList()
            main.post { waiters.forEach { it(bitmap) } }
        }
        return key
    }

    /** 行被复用/页面关了：丢掉这条 key 上还没回来的回调（后台请求本身不打断）。 */
    fun cancel(key: String) {
        cancelled[key] = true
        pending.remove(key)
    }

    private fun keyOf(path: String, maxPx: Int): String = "$path\u0000$maxPx"

    private fun obtain(app: Context, path: String, maxPx: Int): Bitmap? {
        val cfg = PetSettings.load(app)
        if (!cfg.ready) return null
        val file = diskFile(app, path)
        val fresh = file.isFile && file.length() > 0 && System.currentTimeMillis() - file.lastModified() < DISK_TTL_MS
        if (!fresh) {
            val got = fetch(cfg, path, file)
            if (!got) return null
        }
        return decode(file, maxPx)
    }

    private fun diskFile(app: Context, path: String): File {
        val dir = File(app.filesDir, "hostimg")
        if (!dir.isDirectory) dir.mkdirs()
        return File(dir, sha1(path))
    }

    /** 抓字节落盘（原子替换）。失败不抛异常，返回 false。 */
    private fun fetch(cfg: PetConfig, path: String, dest: File): Boolean {
        val query = try {
            URLEncoder.encode(path, "UTF-8")
        } catch (e: Throwable) {
            return false
        }
        var conn: HttpURLConnection? = null
        val tmp = File(dest.absolutePath + ".tmp")
        try {
            conn = URL(cfg.apiBase + "file?path=" + query).openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 8_000
            conn.readTimeout = 20_000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("Cookie", cfg.cookieHeader)
            conn.setRequestProperty("User-Agent", "WhalePet/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.SDK_INT})")
            // 身份头必须跟 [PetClient] 一致：宿主按 x-pet-device-id 认设备，缺了会被当成
            // 一台新设备，满员时整个请求 429，图永远出不来。
            conn.setRequestProperty("X-Pet-Device", PetClient.deviceName())
            conn.setRequestProperty("X-Pet-Device-Id", PetClient.deviceId())
            val code = conn.responseCode
            if (code !in 200..299) return false
            if (conn.contentLengthLong > MAX_BYTES) return false
            var read = 0L
            tmp.delete()
            conn.inputStream.use { input ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        read += n
                        if (read > MAX_BYTES) {
                            tmp.delete()
                            return false
                        }
                        out.write(buf, 0, n)
                    }
                }
            }
            if (read <= 0) {
                tmp.delete()
                return false
            }
            dest.delete()
            if (!tmp.renameTo(dest)) {
                tmp.copyTo(dest, overwrite = true)
                tmp.delete()
            }
            trimDisk(dest.parentFile)
            return true
        } catch (e: Throwable) {
            tmp.delete()
            return false
        } finally {
            conn?.disconnect()
        }
    }

    private fun decode(file: File, maxPx: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        val longest = maxOf(bounds.outWidth, bounds.outHeight)
        while (longest / (sample * 2) >= maxPx) sample *= 2
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return runCatching { BitmapFactory.decodeFile(file.absolutePath, opts) }.getOrNull()
    }

    /** 磁盘上限粗暴但够用：超了删最旧的，删到一半为止。 */
    private fun trimDisk(dir: File?) {
        if (dir == null) return
        val files = dir.listFiles() ?: return
        var total = 0L
        files.filter { it.isFile }.forEach { total += it.length() }
        if (total <= DISK_BUDGET) return
        files.sortedBy { it.lastModified() }.forEach { f ->
            if (total <= DISK_BUDGET / 2) return
            val len = f.length()
            if (f.delete()) total -= len
        }
    }

    private fun sha1(text: String): String {
        val md = MessageDigest.getInstance("SHA-1")
        return md.digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
