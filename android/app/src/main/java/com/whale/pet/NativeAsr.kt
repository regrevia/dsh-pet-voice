package com.whale.pet

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * 原生语音识别（不用 WebView：Android WebView 没有 webkitSpeechRecognition）。
 *
 * 这里只做「一次识别」；连续唤醒由 NativeSpeechWakeWordEngine 包一层重启循环。
 * 所有方法都在主线程调用；回调也在主线程。
 */
class NativeAsr(context: Context) {

    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var listener: Listener? = null
    private var active = false

    interface Listener {
        fun onReady()
        fun onPartial(text: String)
        fun onFinal(text: String)
        fun onError(message: String, code: Int)
        fun onEnd()
    }

    fun isAvailable(): Boolean = try {
        SpeechRecognizer.isRecognitionAvailable(app)
    } catch (e: Exception) {
        false
    }

    fun start(l: Listener) {
        if (active) return
        if (!isAvailable()) {
            l.onError("本机没有语音识别服务（需 Google/讯飞等识别器；模拟器常缺）", -1)
            l.onEnd()
            return
        }
        active = true
        listener = l
        main.post {
            if (!active) return@post
            // 复用同一个识别器：唤醒循环每 0.3–1 s 重启一轮，反复 create/destroy 会撞 BUSY/CLIENT
            val existing = recognizer
            if (existing != null) {
                try {
                    existing.startListening(buildIntent())
                } catch (e: Exception) {
                    finish("启动识别失败：${e.message ?: e.javaClass.simpleName}", -1)
                }
                return@post
            }
            val r = try {
                SpeechRecognizer.createSpeechRecognizer(app)
            } catch (e: Exception) {
                finish("无法创建识别器：${e.message ?: e.javaClass.simpleName}", -1)
                return@post
            }
            recognizer = r
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    listener?.onReady()
                }

                override fun onBeginningOfSpeech() = Unit

                override fun onRmsChanged(rmsdB: Float) = Unit

                override fun onBufferReceived(buffer: ByteArray?) = Unit

                override fun onEndOfSpeech() = Unit

                override fun onError(error: Int) {
                    if (!active) return
                    val msg = when (error) {
                        SpeechRecognizer.ERROR_AUDIO -> "录音出错"
                        SpeechRecognizer.ERROR_CLIENT -> "识别客户端错误"
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "没有麦克风权限"
                        SpeechRecognizer.ERROR_NETWORK -> "识别网络错误"
                        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "识别网络超时"
                        SpeechRecognizer.ERROR_NO_MATCH -> "没听清"
                        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "识别器忙"
                        SpeechRecognizer.ERROR_SERVER -> "识别服务错误"
                        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有检测到说话"
                        else -> "识别错误($error)"
                    }
                    finish(msg, error)
                }

                override fun onResults(results: Bundle?) {
                    if (!active) return
                    val text = firstResult(results)
                    val l = listener
                    active = false
                    destroyRecognizer()
                    if (text.isBlank()) {
                        l?.onError("没听清", SpeechRecognizer.ERROR_NO_MATCH)
                    } else {
                        l?.onFinal(text.trim())
                    }
                    l?.onEnd()
                }

                override fun onPartialResults(partialResults: Bundle?) {
                    if (!active) return
                    val text = firstResult(partialResults)
                    if (text.isNotBlank()) listener?.onPartial(text.trim())
                }

                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })
            try {
                r.startListening(buildIntent())
            } catch (e: Exception) {
                finish("启动识别失败：${e.message ?: e.javaClass.simpleName}", -1)
            }
        }
    }

    fun cancel() {
        active = false
        listener = null
        // 只取消这一轮，实例留着下一轮复用
        main.post { try { recognizer?.cancel() } catch (_: Exception) {} }
    }

    private fun finish(message: String, code: Int) {
        active = false
        val l = listener
        destroyRecognizer()
        l?.onError(message, code)
        l?.onEnd()
    }

    private fun destroyRecognizer() {
        val r = recognizer ?: return
        recognizer = null
        try {
            r.cancel()
        } catch (_: Exception) {
        }
        try {
            r.destroy()
        } catch (_: Exception) {
        }
    }

    private fun buildIntent(): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-CN")
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, app.packageName)
        // 说完后更快收尾，接近「双击说话」的体感
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L)
    }

    private fun firstResult(bundle: Bundle?): String {
        val list = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return ""
        return list.firstOrNull().orEmpty()
    }
}
