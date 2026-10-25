package com.whale.pet

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * 助手消息的富文本渲染。
 *
 * 契约：`POST /api/render {text}` → `{ok, html}`，只给**片段**，样式由这里统一包。
 * 这样宿主换了 Markdown 实现，客户端样式也不会跟着漂。
 */
object MdPlain {
    private val fence = Regex("```[a-zA-Z0-9_+-]*\\n?")
    private val inlineCode = Regex("`([^`]*)`")
    private val bold = Regex("(\\*\\*|__)(.+?)\\1")
    private val strike = Regex("~~(.+?)~~")
    private val heading = Regex("^\\s{0,3}#{1,6}\\s*", RegexOption.MULTILINE)
    private val quote = Regex("^\\s{0,3}>\\s?", RegexOption.MULTILINE)
    private val bullet = Regex("^\\s{0,3}[-*+]\\s+", RegexOption.MULTILINE)
    private val ordered = Regex("^\\s{0,3}\\d+[.)]\\s+", RegexOption.MULTILINE)
    private val image = Regex("!\\[([^\\]]*)]\\(([^)]*)\\)")
    private val link = Regex("\\[([^\\]]+)]\\(([^)]*)\\)")
    private val hr = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$", RegexOption.MULTILINE)
    private val tableRule = Regex("^\\s*\\|?\\s*:?-{2,}.*$", RegexOption.MULTILINE)

    /** 朗读/气泡/降级共用：绝不把 `**`、`##`、代码围栏露给用户。 */
    fun of(raw: String): String {
        if (raw.isBlank()) return ""
        var s = raw.replace("\r\n", "\n")
        s = s.replace(fence, "")
        s = image.replace(s) { m -> if (m.groupValues[1].isBlank()) "" else m.groupValues[1] }
        s = link.replace(s) { m ->
            val url = m.groupValues[2].trim()
            if (url.startsWith("http://") || url.startsWith("https://")) "${m.groupValues[1]}（$url）" else m.groupValues[1]
        }
        s = tableRule.replace(s, "")
        s = hr.replace(s, "")
        s = heading.replace(s, "")
        s = quote.replace(s, "")
        s = bold.replace(s) { it.groupValues[2] }
        s = strike.replace(s) { it.groupValues[1] }
        s = inlineCode.replace(s) { it.groupValues[1] }
        s = bullet.replace(s, "· ")
        s = ordered.replace(s, "")
        s = s.replace("|", " ")
        return s.replace(Regex("\n{3,}"), "\n\n").trim()
    }
}

/**
 * 富文本气泡的**唯一** WebView 渲染器（池化复用，绝不通每条消息 new 一个）。
 *
 * 安全边界：JS 关死、不加载任何网络资源（图片也不加载）、只放行 http/https 链接跳浏览器。
 */
class ChatRender(
    context: Context,
    private val config: () -> PetConfig,
) {
    private val app = context.applicationContext
    private val host: Context = context
    private val density = app.resources.displayMetrics.density
    private val cache = HashMap<String, String>()
    private val inflight = HashSet<String>()
    private val free = ArrayDeque<WebView>()
    private val all = ArrayList<WebView>()

    fun cached(text: String): String? = cache[text]

    /** 拿一只空闲渲染器；池子满了（滚动时）复用最早那只。 */
    fun obtain(): WebView {
        free.removeFirstOrNull()?.let { return it }
        if (all.size < MAX_VIEWS) return create().also { all.add(it) }
        val recy = all.removeAt(0)
        detach(recy)
        all.add(recy)
        return recy
    }

    fun recycle(view: WebView) {
        detach(view)
        if (!free.contains(view)) free.addLast(view)
    }

    fun detach(view: WebView) {
        (view.parent as? ViewGroup)?.removeView(view)
    }

    /** 有缓存就直接上屏；没有就先纯文本，后台取 HTML 回来再刷新这一条。 */
    fun request(text: String, onReady: () -> Unit) {
        if (cache.containsKey(text) || !inflight.add(text)) return
        Thread {
            var html: String? = null
            try {
                val r = PetClient(config).render(text)
                if (r.ok) html = r.json?.optString("html").orEmpty().takeIf { it.isNotBlank() }
            } catch (_: Exception) {
            }
            synchronized(cache) {
                inflight.remove(text)
                if (html != null) cache[text] = html
            }
            onReady()
        }.apply { isDaemon = true }.start()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun create(): WebView = WebView(host).apply {
        setBackgroundColor(Color.TRANSPARENT)
        settings.apply {
            javaScriptEnabled = false
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            blockNetworkLoads = true
            loadWithOverviewMode = false
            useWideViewPort = false
            textZoom = 100
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        overScrollMode = WebView.OVER_SCROLL_NEVER
        // 手指上下滑交给外面的列表，别被 WebView 吃掉
        setOnTouchListener { v, _ ->
            v.parent?.requestDisallowInterceptTouchEvent(false)
            false
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                openHttp(request.url)

            @Deprecated("旧实现只在 API < 24 上走")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                openHttp(Uri.parse(url))

            override fun onPageFinished(view: WebView, url: String?) {
                view.measure(
                    ViewGroup.LayoutParams.MATCH_PARENT.let { android.view.View.MeasureSpec.makeMeasureSpec(widthOf(), android.view.View.MeasureSpec.EXACTLY) },
                    android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.UNSPECIFIED),
                )
                // contentHeight 本身就是设备像素，别再乘 density，否则气泡会撑高一大片空白
                val h = view.measuredHeight.coerceAtLeast(view.contentHeight)
                if (h > 0) {
                    view.layoutParams = (view.layoutParams ?: ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    )).apply { height = h }
                    view.requestLayout()
                }
            }
        }
    }

    private fun widthOf(): Int = (app.resources.displayMetrics.widthPixels - (48 * density).toInt()).coerceAtLeast(120)

    private fun openHttp(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return true
        if (scheme != "http" && scheme != "https") return true
        return try {
            app.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: ActivityNotFoundException) {
            true
        }
    }

    /** 服务端片段外面套一层固定样式：深色底、16px、1.6 行高、代码块等宽、表格横向滚。 */
    fun load(view: WebView, text: String, rawHtml: String?) {
        val html = wrap(rawHtml ?: escape(MdPlain.of(text)).replace("\n", "<br>"))
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    private fun wrap(fragment: String): String = """
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;padding:0;background:transparent;color:#E6EEF4;
    font-family:-apple-system,"Noto Sans CJK SC",sans-serif;font-size:16px;line-height:1.6;
    -webkit-text-size-adjust:100%;word-break:break-word;overflow-wrap:anywhere}
  p{margin:0 0 8px} p:last-child{margin-bottom:0}
  pre{background:#0F1720;border:1px solid #2C3B49;border-radius:10px;padding:10px 12px;
    overflow-x:auto;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5;margin:8px 0}
  code{font-family:ui-monospace,Menlo,monospace;font-size:14px}
  :not(pre)>code{background:#0F1720;border-radius:4px;padding:1px 4px}
  table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%;margin:8px 0}
  th,td{border:1px solid #2C3B49;padding:6px 10px;text-align:left;white-space:nowrap}
  th{background:#22303D}
  a{color:#3FD0C9}
  ul,ol{margin:0 0 8px;padding-left:22px}
  blockquote{margin:8px 0;padding-left:10px;border-left:2px solid #2C3B49;color:#8FA3B3}
  img{max-width:100%}
</style></head><body>$fragment</body></html>
""".trimIndent()

    private fun escape(s: String): String = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    /**
     * 把渲染结果挂到气泡里。同一个气泡只留一只 WebView（池子里取），
     * 文本没变就不重载，避免列表滑动时整块白闪。
     */
    fun attach(container: ViewGroup, text: String, html: String) {
        val view = container.getChildAt(1) as? WebView ?: run {
            val v = obtain()
            container.addView(
                v,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
            v
        }
        if ((view.tag as? String) == text) return
        view.tag = text
        load(view, text, html)
    }

    fun release() {
        all.forEach { v ->
            detach(v)
            runCatching { v.destroy() }
        }
        all.clear()
        free.clear()
        cache.clear()
        inflight.clear()
    }

    companion object {
        /** 屏幕上能同时看到的助手气泡最多两三只，池子不用大。 */
        private const val MAX_VIEWS = 2
    }
}
