package com.whale.pet

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.text.InputType
import android.util.Size
import android.view.Gravity
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlin.math.abs
import kotlin.math.min

/**
 * 扫码绑定页：Camera2 + ImageReader(YUV_420_888) + ZXing core 就地解码（无第三方扫码库、无 Play Services）。
 *
 * 三条铁律：
 *  1. 每帧取 Y 平面喂 PlanarYUVLuminanceSource，只试 QR_CODE、开 TRY_HARDER，每 3 帧解一次省电。
 *  2. 解出内容不等于绑定成功：必须带 cookie 打 `GET <base>/api/state`，200 才落盘并回主界面。
 *  3. 没有相机（模拟器）/拒绝权限/解码失败都要能走「粘贴链接」，绝不崩。
 */
class ScanActivity : Activity() {

    private lateinit var preview: SurfaceView
    private lateinit var overlay: ScanOverlayView
    private lateinit var statusText: TextView
    private lateinit var hintText: TextView
    private lateinit var torchBtn: Button
    private lateinit var pasteBtn: Button
    private lateinit var retryBtn: Button

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var cameraId: String? = null
    private var chars: CameraCharacteristics? = null
    private var surfaceReady = false
    private var cameraReady = false
    private var flashAvailable = false
    private var torchOn = false
    private var frameCount = 0
    private var closing = false
    private var verifying = false

    private val zx = MultiFormatReader().apply {
        setHints(
            mapOf(
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.TRY_HARDER to true,
            ),
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK
        buildUi()

        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            fallback("这台设备没有可用相机 · 用下面的粘贴链接")
            return
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            maybeStartCamera()
        } else {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            maybeStartCamera()
        } else {
            fallback("没有相机权限")
        }
    }

    override fun onDestroy() {
        closing = true
        closeCamera()
        thread?.quitSafely()
        thread = null
        super.onDestroy()
    }

    override fun onBackPressed() {
        setResult(RESULT_CANCELED)
        finish()
    }

    /* ---------------- UI ---------------- */

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun buildUi() {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        preview = SurfaceView(this)
        root.addView(
            preview,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )

        overlay = ScanOverlayView(this)
        root.addView(
            overlay,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )

        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(dp(18), dp(16), dp(18), dp(16))
        }
        val lp = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
            gravity = Gravity.BOTTOM
            setMargins(dp(16), 0, dp(16), dp(28))
        }
        root.addView(bottom, lp)

        statusText = TextView(this).apply {
            text = "扫电脑上的二维码"
            setTextColor(getColor(R.color.pet_text))
            textSize = 15f
        }
        bottom.addView(statusText)

        hintText = TextView(this).apply {
            text = "对准电脑上的配对二维码"
            setTextColor(getColor(R.color.pet_text_dim))
            textSize = 13f
            setPadding(0, dp(6), 0, 0)
        }
        bottom.addView(hintText)

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(14), 0, 0)
        }
        bottom.addView(row)

        torchBtn = button("手电筒").apply {
            visibility = View.GONE
            setOnClickListener { toggleTorch() }
        }
        row.addView(torchBtn, weight())

        pasteBtn = button("粘贴链接").apply {
            setOnClickListener { pastePayload() }
        }
        row.addView(pasteBtn, weight())

        retryBtn = button("重新扫").apply {
            visibility = View.GONE
            setOnClickListener {
                retryBtn.visibility = View.GONE
                pasteBtn.visibility = View.VISIBLE
                setStatus("扫电脑上的二维码", getColor(R.color.pet_text))
                verifying = false
                closing = false
                if (device == null) maybeStartCamera()
            }
        }
        row.addView(retryBtn, weight())

        val cancel = button("返回").apply {
            setOnClickListener {
                setResult(RESULT_CANCELED)
                finish()
            }
        }
        root.addView(
            cancel,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.TOP or Gravity.END
                setMargins(0, dp(36), dp(18), 0)
            },
        )

        setContentView(root)
    }

    private fun weight() = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
        marginStart = dp(6)
        marginEnd = dp(6)
    }

    private fun button(text: String): Button = Button(this).apply {
        this.text = text
        textSize = 14f
        isAllCaps = false
        setTextColor(getColor(R.color.pet_accent))
        setBackgroundResource(R.drawable.bg_btn_ghost)
        minHeight = dp(48)
        stateListAnimator = null
    }

    private fun setStatus(text: String, color: Int) {
        runOnUiThread {
            statusText.text = text
            statusText.setTextColor(color)
        }
    }

    /** 相机不可用时的唯一出路：粘贴（三种载荷都由 PetConfig.parsePairPayload 解析）。 */
    private fun fallback(reason: String) {
        runOnUiThread {
            setStatus(reason, getColor(R.color.pet_accent))
            hintText.text = "也可以直接粘贴配对链接"
            torchBtn.visibility = View.GONE
            retryBtn.visibility = View.GONE
            pasteBtn.visibility = View.VISIBLE
            overlay.showMask = false
            overlay.invalidate()
        }
    }

    /* ---------------- 相机 ---------------- */

    private fun maybeStartCamera() {
        surfaceReady = false
        preview.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                surfaceReady = true
                if (cameraReady && !closing) return
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    openCamera()
                }
            }

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit

            override fun surfaceDestroyed(holder: SurfaceHolder) {
                surfaceReady = false
            }
        })
        if (preview.holder.surface != null && preview.holder.surface.isValid) {
            surfaceReady = true
            openCamera()
        }
    }

    private fun openCamera() {
        if (device != null || closing) return
        val manager = getSystemService(CameraManager::class.java) ?: run {
            fallback("取不到相机服务 · 用下面的粘贴链接")
            return
        }
        val id = try {
            manager.cameraIdList.firstOrNull { cid ->
                manager.getCameraCharacteristics(cid)
                    .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
            } ?: manager.cameraIdList.firstOrNull()
        } catch (e: CameraAccessException) {
            null
        }
        if (id == null) {
            fallback("找不到相机 · 用下面的粘贴链接")
            return
        }
        cameraId = id
        chars = try {
            manager.getCameraCharacteristics(id)
        } catch (e: CameraAccessException) {
            null
        }
        flashAvailable = chars?.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true

        if (thread == null) {
            thread = HandlerThread("scan-camera").also { it.start() }
            handler = Handler(thread!!.looper)
        }

        // 取 1280×720 附近的 YUV 尺寸；没有就退到最接近的。
        val yuvSizes = try {
            chars?.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?.getOutputSizes(android.graphics.ImageFormat.YUV_420_888)
        } catch (e: Exception) {
            null
        }
        val size = pickDecodeSize(yuvSizes)
        try {
            reader?.close()
            reader = ImageReader.newInstance(size.width, size.height, android.graphics.ImageFormat.YUV_420_888, 2)
            reader!!.setOnImageAvailableListener({ r -> onFrame(r) }, handler)
        } catch (e: Exception) {
            fallback("相机初始化失败（${e.javaClass.simpleName}）· 用下面的粘贴链接")
            return
        }

        try {
            manager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    device = camera
                    cameraReady = true
                    if (surfaceReady) startPreview()
                }

                override fun onDisconnected(camera: CameraDevice) {
                    camera.close()
                    device = null
                    cameraReady = false
                }

                override fun onError(camera: CameraDevice, error: Int) {
                    camera.close()
                    device = null
                    cameraReady = false
                    fallback("相机被占用或出错（code $error）· 用下面的粘贴链接")
                }
            }, handler)
        } catch (e: SecurityException) {
            fallback("没有相机权限")
        } catch (e: Exception) {
            fallback("打不开相机（${e.javaClass.simpleName}）· 用下面的粘贴链接")
        }
    }

    private fun pickDecodeSize(sizes: Array<Size>?): Size {
        if (sizes.isNullOrEmpty()) return Size(1280, 720)
        val usable = sizes.filter { it.width >= 640 && it.height >= 480 }.ifEmpty { sizes.toList() }
        return usable.minByOrNull { s ->
            abs(s.width - 1280) + abs(s.height - 720) + if (s.width * 9 == s.height * 16) 0 else 400
        } ?: sizes[0]
    }

    private fun startPreview() {
        val camera = device ?: return
        val imageReader = reader ?: return
        val surface = preview.holder.surface ?: return
        if (!surface.isValid) return
        val targets = listOf(surface, imageReader.surface)
        try {
            camera.createCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    if (closing) {
                        s.close()
                        return
                    }
                    session = s
                    try {
                        val req = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                            targets.forEach { addTarget(it) }
                            set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                            set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                            set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_OFF)
                        }
                        s.setRepeatingRequest(req.build(), null, handler)
                    } catch (e: Exception) {
                        fallback("预览启动失败（${e.javaClass.simpleName}）· 用下面的粘贴链接")
                        return
                    }
                    runOnUiThread {
                        hintText.text = "把二维码放进取景框里"
                        if (flashAvailable) torchBtn.visibility = View.VISIBLE
                    }
                }

                override fun onConfigureFailed(s: CameraCaptureSession) {
                    fallback("相机会话配置失败 · 用下面的粘贴链接")
                }
            }, handler)
        } catch (e: Exception) {
            fallback("预览配置失败（${e.javaClass.simpleName}）· 用下面的粘贴链接")
        }
    }

    private fun toggleTorch() {
        torchOn = !torchOn
        val camera = device ?: return
        val s = session ?: return
        val surface = preview.holder.surface ?: return
        val imageReader = reader ?: return
        try {
            val req = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(surface)
                addTarget(imageReader.surface)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                set(CaptureRequest.FLASH_MODE, if (torchOn) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF)
            }
            s.setRepeatingRequest(req.build(), null, handler)
        } catch (e: Exception) {
            toast("手电筒切换失败")
        }
    }

    /** 相机一帧：取 Y 平面 → PlanarYUVLuminanceSource → ZXing。每 3 帧解一次。 */
    private fun onFrame(r: ImageReader) {
        val image: Image = try {
            r.acquireLatestImage()
        } catch (e: Exception) {
            null
        } ?: return
        try {
            if (verifying || closing) return
            if (frameCount++ % 3 != 0) return
            val result = decode(image) ?: return
            verifying = true
            runOnUiThread {
                setStatus("已识别，正在验证在线状态…", getColor(R.color.pet_accent))
                overlay.showMask = false
                overlay.invalidate()
            }
            closeCamera()
            handlePayload(result)
        } finally {
            try {
                image.close()
            } catch (_: Exception) {
            }
        }
    }

    private fun decode(image: Image): String? {
        val plane = image.planes.firstOrNull() ?: return null
        val buf = plane.buffer
        val w = image.width
        val h = image.height
        val rowStride = plane.rowStride
        val data = ByteArray(w * h)
        try {
            if (rowStride == w && plane.pixelStride == 1) {
                buf.get(data, 0, min(buf.remaining(), data.size))
            } else {
                val row = ByteArray(rowStride)
                var offset = 0
                for (y in 0 until h) {
                    buf.position(y * rowStride)
                    val n = min(rowStride, buf.remaining())
                    buf.get(row, 0, n)
                    System.arraycopy(row, 0, data, offset, w)
                    offset += w
                }
            }
        } catch (e: Exception) {
            return null
        }
        val source = PlanarYUVLuminanceSource(data, w, h, 0, 0, w, h, false)
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        return try {
            zx.decodeWithState(bitmap).text
        } catch (e: Exception) {
            null
        }
    }

    /* ---------------- 解析 + 验证 + 落盘 ---------------- */

    private fun currentBase(): String = PetSettings.load(this).baseUrl

    private fun handlePayload(raw: String) {
        val parsed = PetConfig.parsePairPayload(raw, currentBase())
        if (parsed == null) {
            verifierFailed("二维码内容认不出（既不是配对链接也不是令牌）")
            return
        }
        verify(parsed.first, parsed.second)
    }

    private fun pastePayload() {
        val input = EditText(this).apply {
            hint = "配对链接 / 令牌 / {\"host\":…,\"token\":…}"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setSingleLine(false)
            setTextColor(getColor(R.color.pet_text))
            setHintTextColor(getColor(R.color.pet_hint))
        }
        AlertDialog.Builder(this)
            .setTitle("粘贴配对内容")
            .setView(input)
            .setPositiveButton("解析并验证") { _, _ ->
                val raw = input.text.toString().trim()
                if (raw.isBlank()) return@setPositiveButton
                verifying = true
                closeCamera()
                setStatus("正在验证在线状态…", getColor(R.color.pet_accent))
                handlePayload(raw)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun verify(base: String, token: String) {
        if (base.isBlank() || token.isBlank()) {
            verifierFailed("配对信息不完整")
            return
        }
        val old = PetSettings.load(this)
        val cfg = old.copy(baseUrl = base, token = token)
        setStatus("正在验证在线状态…", getColor(R.color.pet_accent))
        Thread {
            var ok = false
            var reason = ""
            try {
                val r = PetClient { cfg }.state()
                ok = r.ok
                if (!r.ok) {
                    reason = if (r.code == 401) "HTTP 401（令牌不对）" else "HTTP ${r.code} ${r.error()}"
                }
            } catch (e: Exception) {
                reason = "连不上电脑：${e.message ?: e.javaClass.simpleName}"
            }
            runOnUiThread {
                if (ok) {
                    PetSettings.save(this, cfg)
                    setStatus("✓ 已绑定 · 大肥鱼在线", getColor(R.color.pet_accent))
                    hintText.text = "令牌只以掩码保存，不显示明文"
                    retryBtn.visibility = View.GONE
                    pasteBtn.visibility = View.GONE
                    window.decorView.postDelayed({
                        setResult(RESULT_OK)
                        finish()
                    }, 900)
                } else {
                    verifierFailed(reason)
                }
            }
        }.start()
    }

    private fun verifierFailed(reason: String) {
        verifying = false
        runOnUiThread {
            setStatus("✗ 验证失败：$reason", Color.parseColor("#FF6B6B"))
            hintText.text = if (reason.startsWith("连不上电脑")) {
                "确认电脑端在运行，再重新扫码或粘贴链接"
            } else {
                "没有写入配置，重新扫码或粘贴链接就好"
            }
            retryBtn.visibility = View.VISIBLE
            pasteBtn.visibility = View.VISIBLE
            torchBtn.visibility = View.GONE
        }
    }

    private fun closeCamera() {
        try {
            session?.close()
        } catch (_: Exception) {
        }
        session = null
        try {
            device?.close()
        } catch (_: Exception) {
        }
        device = null
        cameraReady = false
        try {
            reader?.close()
        } catch (_: Exception) {
        }
        reader = null
        torchOn = false
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }

    /* ---------------- 取景框：自己画四角 + 半透明遮罩 ---------------- */

    private class ScanOverlayView(context: android.content.Context) : View(context) {
        var showMask = true
        private val mask = Paint().apply { color = 0xA6000000.toInt() }
        private val line = Paint().apply {
            color = Color.WHITE
            style = Paint.Style.STROKE
            strokeWidth = 6f
            isAntiAlias = true
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (!showMask) return
            val side = (min(width, height) * 0.62f).toInt()
            val left = (width - side) / 2f
            val top = (height - side) / 2f - height * 0.04f
            val right = left + side
            val bottom = top + side

            canvas.drawRect(0f, 0f, width.toFloat(), top, mask)
            canvas.drawRect(0f, bottom, width.toFloat(), height.toFloat(), mask)
            canvas.drawRect(0f, top, left, bottom, mask)
            canvas.drawRect(right, top, width.toFloat(), bottom, mask)

            val arm = side * 0.16f
            val r = RectF(left, top, right, bottom)
            canvas.drawLine(r.left, r.top, r.left + arm, r.top, line)
            canvas.drawLine(r.left, r.top, r.left, r.top + arm, line)
            canvas.drawLine(r.right, r.top, r.right - arm, r.top, line)
            canvas.drawLine(r.right, r.top, r.right, r.top + arm, line)
            canvas.drawLine(r.left, r.bottom, r.left + arm, r.bottom, line)
            canvas.drawLine(r.left, r.bottom, r.left, r.bottom - arm, line)
            canvas.drawLine(r.right, r.bottom, r.right - arm, r.bottom, line)
            canvas.drawLine(r.right, r.bottom, r.right, r.bottom - arm, line)
        }
    }

    companion object {
        private const val REQ_CAMERA = 61
    }
}
