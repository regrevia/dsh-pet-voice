package com.whale.pet

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Handler
import android.os.Looper
import java.util.concurrent.Executors

/**
 * 视频首帧缩略图：气泡里只需要一格封面。
 *
 * 解码放单独一条线程、只留最近 8 张：低端机解不出来的就返回 null（显示文件名，不崩）。
 */
object VideoThumb {
    private val pool = Executors.newSingleThreadExecutor { r ->
        Thread(r, "pet-vthumb").apply { isDaemon = true }
    }
    private val main = Handler(Looper.getMainLooper())
    private val cache = object : LinkedHashMap<String, Bitmap>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Bitmap>?): Boolean = size > 8
    }

    fun peek(path: String): Bitmap? = synchronized(cache) { cache[path] }

    fun load(path: String, onDone: (Bitmap?) -> Unit) {
        peek(path)?.let {
            main.post { onDone(it) }
            return
        }
        pool.execute {
            val bmp = runCatching {
                val r = MediaMetadataRetriever()
                try {
                    r.setDataSource(path)
                    r.getFrameAtTime(1_000_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                } finally {
                    runCatching { r.release() }
                }
            }.getOrNull()
            if (bmp != null) synchronized(cache) { cache[path] = bmp }
            main.post { onDone(bmp) }
        }
    }
}
