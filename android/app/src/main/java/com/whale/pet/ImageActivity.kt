package com.whale.pet

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.RectF
import android.os.Bundle
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.min

/**
 * 全屏看图：纯 Activity + 自定义 View，不引图片库。
 *
 * 同一句话里可能有多张图：左右滑切换。双击在「适应屏幕 / 2.5 倍」之间切，放大后拖动。
 * 图从电脑上现抓（见 HostImage），抓不到就留黑底 + 一行「看不了」。
 */
class ImageActivity : Activity() {

    companion object {
        private const val EXTRA_PATHS = "paths"
        private const val EXTRA_INDEX = "index"

        /** 打开全屏看图。列表里点缩略图时调这个。 */
        fun open(host: Activity, paths: List<String>, index: Int) {
            if (paths.isEmpty()) return
            val intent = Intent(host, ImageActivity::class.java)
            intent.putStringArrayListExtra(EXTRA_PATHS, ArrayList(paths))
            intent.putExtra(EXTRA_INDEX, index.coerceIn(0, paths.size - 1))
            host.startActivity(intent)
        }
    }

    private lateinit var stage: FrameLayout
    private lateinit var counter: TextView
    private lateinit var zoom: ZoomView

    private var paths: List<String> = emptyList()
    private var index = 0
    /** 同一条消息里第几张 → 加载 key，用于取消上一个还没回来的请求。 */
    private var loadingKey = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_image)
        stage = findViewById(R.id.imageStage)
        counter = findViewById(R.id.imageCounter)
        zoom = ZoomView(this)
        stage.addView(
            zoom,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        findViewById<TextView>(R.id.imageBack).setOnClickListener { finish() }

        val given = intent?.getStringArrayListExtra(EXTRA_PATHS)?.filter { it.isNotBlank() } ?: emptyList()
        if (given.isEmpty()) {
            finish()
            return
        }
        paths = given
        index = intent?.getIntExtra(EXTRA_INDEX, 0)?.coerceIn(0, given.size - 1) ?: 0
        counter.visibility = if (paths.size > 1) View.VISIBLE else View.INVISIBLE
        show()
    }

    override fun onDestroy() {
        if (loadingKey.isNotBlank()) HostImage.cancel(loadingKey)
        zoom.setBitmap(null)
        super.onDestroy()
    }

    private fun show() {
        if (loadingKey.isNotBlank()) HostImage.cancel(loadingKey)
        zoom.setBitmap(null)
        counter.text = if (paths.size > 1) "${index + 1} / ${paths.size}" else ""
        val path = paths[index]
        val maxPx = maxOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
        val shownIndex = index
        loadingKey = HostImage.load(this, path, maxPx) { bitmap ->
            // 滑得太快时旧请求可能后到：只认当前这张
            if (shownIndex != index || isFinishing || isDestroyed) return@load
            if (bitmap == null) {
                zoom.setBitmap(null)
                counter.text = "看不了"
                return@load
            }
            zoom.setBitmap(bitmap)
            counter.text = if (paths.size > 1) "${index + 1} / ${paths.size}" else ""
        }
    }

    private fun next() {
        if (paths.size <= 1) return
        index = (index + 1) % paths.size
        show()
    }

    private fun prev() {
        if (paths.size <= 1) return
        index = (index - 1 + paths.size) % paths.size
        show()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /** 自绘：只有一张 Bitmap + 一个 Matrix，缩放/拖动都是 postScale/postTranslate。 */
    private inner class ZoomView(context: Context) : View(context) {

        private var bitmap: Bitmap? = null
        private val matrix = Matrix()
        private var scale = 1f
        private var lastX = 0f
        private var lastY = 0f
        private var downX = 0f
        private var downY = 0f
        private var downAt = 0L

        private val scaleDet = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val target = (scale * detector.scaleFactor).coerceIn(1f, 4f)
                val factor = target / scale
                matrix.postScale(factor, factor, detector.focusX, detector.focusY)
                scale = target
                clamp()
                invalidate()
                return true
            }
        })

        private val tapDet = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: MotionEvent): Boolean {
                val target = if (scale > 1.2f) 1f else 2.5f
                if (target == 1f) {
                    fit()
                } else {
                    val factor = target / scale
                    matrix.postScale(factor, factor, e.x, e.y)
                    scale = target
                    clamp()
                }
                invalidate()
                return true
            }
        })

        fun setBitmap(value: Bitmap?) {
            bitmap = value
            fit()
            invalidate()
        }

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            super.onSizeChanged(w, h, oldw, oldh)
            fit()
        }

        /** 适应屏幕并居中。 */
        private fun fit() {
            val b = bitmap ?: return
            matrix.reset()
            scale = 1f
            val vw = width.toFloat()
            val vh = height.toFloat()
            if (vw <= 0f || vh <= 0f || b.width <= 0 || b.height <= 0) return
            val base = min(vw / b.width, vh / b.height)
            matrix.postScale(base, base)
            matrix.postTranslate((vw - b.width * base) / 2f, (vh - b.height * base) / 2f)
        }

        /** 拖动时别让图整个飞出屏幕。 */
        private fun clamp() {
            val b = bitmap ?: return
            if (scale <= 1.01f) {
                // 没放大就固定居中，避免拖出黑边
                val rect = RectF(0f, 0f, b.width.toFloat(), b.height.toFloat())
                matrix.mapRect(rect)
                matrix.postTranslate((width - rect.width()) / 2f - rect.left, (height - rect.height()) / 2f - rect.top)
                invalidate()
                return
            }
            val rect = RectF(0f, 0f, b.width.toFloat(), b.height.toFloat())
            matrix.mapRect(rect)
            val w = width.toFloat()
            val h = height.toFloat()
            var dx = 0f
            var dy = 0f
            if (rect.width() <= w) dx = (w - rect.width()) / 2f - rect.left else {
                if (rect.left > 0f) dx = -rect.left
                if (rect.right < w) dx = w - rect.right
            }
            if (rect.height() <= h) dy = (h - rect.height()) / 2f - rect.top else {
                if (rect.top > 0f) dy = -rect.top
                if (rect.bottom < h) dy = h - rect.bottom
            }
            if (dx != 0f || dy != 0f) matrix.postTranslate(dx, dy)
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            scaleDet.onTouchEvent(event)
            tapDet.onTouchEvent(event)
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    lastX = event.x
                    lastY = event.y
                    downX = event.x
                    downY = event.y
                    downAt = System.currentTimeMillis()
                }
                MotionEvent.ACTION_MOVE -> {
                    if (!scaleDet.isInProgress && scale > 1.01f) {
                        matrix.postTranslate(event.x - lastX, event.y - lastY)
                        clamp()
                        invalidate()
                    }
                    lastX = event.x
                    lastY = event.y
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    // 没放大时横向拖一下 = 换下一张（放大状态留给拖动看图）
                    if (scale <= 1.01f && System.currentTimeMillis() - downAt < 700) {
                        val dx = event.x - downX
                        val dy = event.y - downY
                        if (abs(dx) > dp(72) && abs(dy) < dp(96)) {
                            if (dx < 0) next() else prev()
                        }
                    }
                    lastX = event.x
                    lastY = event.y
                }
            }
            return true
        }

        override fun onDraw(canvas: android.graphics.Canvas) {
            canvas.drawColor(android.graphics.Color.BLACK)
            val b = bitmap ?: return
            canvas.drawBitmap(b, matrix, null)
        }
    }
}
