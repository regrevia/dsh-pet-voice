package com.whale.pet

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import java.io.ByteArrayOutputStream

/**
 * 截一张当前屏幕（用户先点系统弹窗授权）。
 *
 * 为什么要绕一个前台服务：Android 14 起，调 `getMediaProjection()` 之前必须先有
 * `foregroundServiceType="mediaProjection"` 的前台服务在跑，否则直接 SecurityException。
 * 低版本照走同一条路，只是没有强校验。
 *
 * 只截一帧就收工：不录屏、不留常驻虚拟屏。
 */
object ScreenSnap {
    private const val TAG = "PetSnap"
    /** 截完把 JPEG 交给谁（同进程回调；页面已经关了就当没截）。 */
    @Volatile
    private var sink: ((ByteArray?) -> Unit)? = null

    fun capture(context: Context, resultCode: Int, data: Intent, done: (ByteArray?) -> Unit) {
        sink = done
        try {
            context.startForegroundService(
                Intent(context, SnapService::class.java)
                    .putExtra(SnapService.EXTRA_CODE, resultCode)
                    .putExtra(SnapService.EXTRA_DATA, data),
            )
        } catch (e: Exception) {
            sink = null
            Log.w(TAG, "起不了截屏服务：${e.javaClass.simpleName}")
            done(null)
        }
    }

    /** 服务侧调用：投影 → 虚拟屏 → 读一帧 → JPEG（长边 ≤ 1600）。 */
    fun grab(context: Context, projection: MediaProjection, done: (ByteArray?) -> Unit) {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        val screen = (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay
        @Suppress("DEPRECATION")
        screen.getRealMetrics(metrics)
        val width = metrics.widthPixels.coerceAtLeast(1)
        val height = metrics.heightPixels.coerceAtLeast(1)
        val dpi = metrics.densityDpi

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        val thread = HandlerThread("pet-snap").apply { start() }
        val handler = Handler(thread.looper)
        var virtual: VirtualDisplay? = null
        var finished = false

        fun finish(bytes: ByteArray?) {
            if (finished) return
            finished = true
            runCatching { virtual?.release() }
            runCatching { reader.close() }
            runCatching { projection.stop() }
            runCatching { thread.quitSafely() }
            done(bytes)
        }

        // Android 14 起必须挂 callback，否则 createVirtualDisplay 会被拒
        if (Build.VERSION.SDK_INT >= 34) {
            runCatching {
                projection.registerCallback(object : MediaProjection.Callback() {
                    override fun onStop() = finish(null)
                }, handler)
            }
        }

        reader.setOnImageAvailableListener({ r ->
            val image: Image? = runCatching { r.acquireLatestImage() }.getOrNull()
            if (image == null) return@setOnImageAvailableListener
            val bytes = try {
                toJpeg(image, width, height)
            } catch (e: Exception) {
                Log.w(TAG, "转换截图失败：${e.javaClass.simpleName}")
                null
            } finally {
                runCatching { image.close() }
            }
            finish(bytes)
        }, handler)

        runCatching {
            virtual = projection.createVirtualDisplay(
                "pet-snap",
                width,
                height,
                dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.surface,
                null,
                handler,
            )
        }.onFailure {
            Log.w(TAG, "建不了虚拟屏：${it.javaClass.simpleName}")
            finish(null)
        }
    }

    /** 服务截完把结果交给页面，交完即清（避免旧页面吃到下一次的图）。 */
    fun deliver(bytes: ByteArray?) {
        val cb = sink
        sink = null
        runCatching { cb?.invoke(bytes) }
    }

    private fun toJpeg(image: Image, width: Int, height: Int): ByteArray? {
        val plane = image.planes[0]
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val padding = rowStride - pixelStride * width
        val rawWidth = width + if (pixelStride > 0) padding / pixelStride else 0
        val raw = Bitmap.createBitmap(rawWidth, height, Bitmap.Config.ARGB_8888)
        raw.copyPixelsFromBuffer(plane.buffer)
        val cropped = if (rawWidth == width) raw else Bitmap.createBitmap(raw, 0, 0, width, height)
        val bytes = jpeg(cropped)
        if (cropped !== raw) cropped.recycle()
        raw.recycle()
        return bytes
    }

    /** 摆正／缩到长边 1600 以内再压 JPEG q90：原图几兆，走隧道传一遍是白等。 */
    fun jpeg(bitmap: Bitmap, max: Int = 1600): ByteArray {
        val scaled = scaleDown(bitmap, max)
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 90, out)
        if (scaled !== bitmap) scaled.recycle()
        return out.toByteArray()
    }

    private fun scaleDown(bitmap: Bitmap, max: Int): Bitmap {
        val longest = maxOf(bitmap.width, bitmap.height)
        if (longest <= max) return bitmap
        val ratio = max.toFloat() / longest
        val w = (bitmap.width * ratio).toInt().coerceAtLeast(1)
        val h = (bitmap.height * ratio).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, w, h, true)
    }
}
