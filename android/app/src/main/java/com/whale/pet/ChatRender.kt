package com.whale.pet

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
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
 * 安全边界：JS 关死、外链资源一概不加载；图只认自己拦的 petimg://（带鉴权读电脑上的图），
 * 链接只放行 http/https 跳浏览器。
 */
class ChatRender(
    context: Context,
    /** 同一屏能同时看到几条富文本：会话页比历史页多，池子按页给。 */
    private val maxViews: Int = MAX_VIEWS,
    private val config: () -> PetConfig,
) {
    private val app = context.applicationContext
    private val host: Context = context
    private val density = app.resources.displayMetrics.density
    private val cache = HashMap<String, String>()
    private val inflight = HashSet<String>()
    private val free = ArrayDeque<WebView>()
    private val all = ArrayList<WebView>()
    /** 硬上限：一屏同时挂着的富文本超过这个数（长消息占满屏）才允许复用屏上那只。 */
    private val hardMax = (maxViews * 2).coerceAtLeast(12)
    private val images = LinkedHashMap<String, ByteArray>()

    fun cached(text: String): String? = cache[text]

    /**
     * 拿一只空闲渲染器。屏上正在显示的那些不能抢：抢过来下一帧就是白框。
     * 优先用池子里没人挂的，都没有就再开一只；到硬上限才退化成复用最早那只。
     */
    fun obtain(): WebView {
        free.removeFirstOrNull()?.let { return it }
        all.firstOrNull { it.parent == null }?.let { return it }
        if (all.size < hardMax) return create().also { all.add(it) }
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

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url ?: return null
                if (uri.scheme != IMG_SCHEME) return null
                val path = uri.getQueryParameter("path")?.takeIf { it.startsWith("/") } ?: return null
                val bytes = imageBytes(path) ?: return null
                return WebResourceResponse(
                    mimeOf(path),
                    null,
                    200,
                    "OK",
                    mapOf("Cache-Control" to "max-age=600"),
                    java.io.ByteArrayInputStream(bytes),
                )
            }

            @Deprecated("旧实现只在 API < 24 上走")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                openHttp(Uri.parse(url))

            override fun onPageFinished(view: WebView, url: String?) {
                remeasure(view)
                // 图片是异步拿字节的，落地后内容才变高：等它解出来再量两次
                view.postDelayed({ remeasure(view) }, 400)
                view.postDelayed({ remeasure(view) }, 1200)
            }
        }
    }

    /** 页面内容多高就把 WebView 定多高；图片解码后还会长，所以可以重复调用。 */
    private fun remeasure(view: WebView) {
        if (view.parent == null) return
        view.measure(
            View.MeasureSpec.makeMeasureSpec(widthOf(), View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
        )
        // contentHeight 本身就是设备像素，别再乘 density，否则气泡会撑高一大片空白
        val h = view.measuredHeight.coerceAtLeast(view.contentHeight)
        if (h <= 0) return
        val lp = view.layoutParams ?: ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        if (lp.height == h) return
        lp.height = h
        view.layoutParams = lp
        view.requestLayout()
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
        val html = wrap(rewriteCodeLang(rewriteImages(rawHtml ?: escape(MdPlain.of(text)).replace("\n", "<br>"))))
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
  table{border-collapse:collapse;display:table;width:100%;max-width:100%;margin:8px 0;font-size:.92em}
  th,td{border:1px solid #2C3B49;padding:6px 10px;text-align:left;white-space:normal;word-break:break-word}
  th{background:#22303D}
  a{color:#3FD0C9}
  ul,ol{margin:0 0 8px;padding-left:22px}
  blockquote{margin:8px 0;padding-left:10px;border-left:2px solid #2C3B49;color:#8FA3B3}
  img{max-width:100%;height:auto;border-radius:8px;display:block;margin:6px 0}
  h1,h2,h3,h4,h5,h6{margin:14px 0 8px;line-height:1.35;font-weight:600}
  h1{font-size:1.5em} h2{font-size:1.4em} h3{font-size:1.3em}
  h4{font-size:1.15em} h5,h6{font-size:1em}
  :first-child{margin-top:0}
  hr{border:0;border-top:1px solid #2C3B49;margin:12px 0}
  pre[data-lang]{padding-top:28px;position:relative}
  pre[data-lang]::before{content:attr(data-lang);position:absolute;top:6px;left:12px;
    font-size:12px;line-height:1;color:#6B7C8C;letter-spacing:.04em}
  pre[data-lang]::after{content:"";position:absolute;left:0;right:0;top:22px;height:1px;background:#2C3B49}
</style></head><body>$fragment</body></html>
""".trimIndent()

    private fun escape(s: String): String = s
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    /** 围栏代码块带上语言：服务端给的是 <pre><code class="language-x">，把 x 提到 pre 上给 CSS 当标题。 */
    private fun rewriteCodeLang(fragment: String): String {
        if (!fragment.contains("language-")) return fragment
        return LANG_CODE.replace(fragment) { m ->
            val lang = m.groupValues[1]
            "<pre data-lang=\"" + lang + "\"><code class=\"language-" + lang + "\""
        }
    }

    /** markdown 图是电脑上的绝对路径：换成自己拦的 petimg://，外链图保持原样（不联网，不加载）。 */
    private fun rewriteImages(fragment: String): String {
        if (!fragment.contains("<img")) return fragment
        return IMG_SRC.replace(fragment) { m ->
            val src = m.groupValues[2]
            if (src.startsWith("/")) m.groupValues[1] + IMG_SCHEME + "://img?path=" +
                Uri.encode(src) + m.groupValues[3] else m.value
        }
    }

    /** 同一张图反复上屏别再抓一遍；最多留 [IMAGE_CACHE] 张。 */
    private fun imageBytes(path: String): ByteArray? {
        synchronized(images) { images[path]?.let { return it } }
        val bytes = runCatching { PetClient(config).fileBytes(path) }.getOrNull() ?: return null
        synchronized(images) {
            if (images.size >= IMAGE_CACHE) images.remove(images.keys.firstOrNull())
            images[path] = bytes
        }
        return bytes
    }

    private fun mimeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "jpg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        else -> "application/octet-stream"
    }

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
        /** 历史页只给最后一条挂富文本，两三只够用。 */
        private const val MAX_VIEWS = 2
        private const val IMAGE_CACHE = 12
        private const val IMG_SCHEME = "petimg"
        private val LANG_CODE = Regex("<pre>\\s*<code\\s+class=\"language-([\\w#+.-]+)\"")
    private val IMG_SRC = Regex("(<img[^>]*?src=\")([^\"]+)(\")")
    }
}
