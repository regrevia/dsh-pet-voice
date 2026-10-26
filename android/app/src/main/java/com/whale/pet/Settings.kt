package com.whale.pet

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri

/**
 * 运行时配置。token 只存在 App 私有 SharedPreferences（MODE_PRIVATE），
 * 永远不会写进日志/文档/代码，UI 只显示掩码。
 *
 * 注意：原计划用 EncryptedSharedPreferences，但 androidx.security-crypto 不在本机
 * 离线 Gradle 缓存里（离线构建要求），因此退到 MODE_PRIVATE；下一步再补加密存储。
 *
 * baseUrl 统一规范成 `https://host/pet-voice/`（带结尾斜杠）。
 */
data class PetConfig(
    val baseUrl: String = "",
    val token: String = "",
    val preset: String = "whale",
    val wakeEnabled: Boolean = false,
    val autoStart: Boolean = false,
    /** 悬浮窗头顶气泡（插件面板里的 `bubble` 是同一个开关）。 */
    val bubble: Boolean = true,
    val wakeName: String = "大肥鱼",
    val spriteSize: Int = 168,
    /** 立绘服装（assets/aster/<outfit>）；空串 = 原来的视频素材。 */
    val outfit: String = "",
    /** 显示方式：home = 只在桌面出现；always = 一直显示。 */
    val displayMode: String = "always",
) {
    val ready: Boolean get() = baseUrl.isNotBlank() && token.isNotBlank()

    /** 宿主鉴权 cookie 名 = pkv_ + token 前 8 位（见插件 index.js cookieName）。 */
    val cookieName: String get() = "pkv_" + token.take(8)

    val cookieHeader: String get() = "$cookieName=$token"

    val apiBase: String get() = baseUrl.trimEnd('/') + "/api/"

    companion object {
        val PRESETS = listOf(
            "whale" to "大肥鱼 · 清亮少女",
            "genki" to "元气 · 快而高",
            "gentle" to "温柔 · 慢而低",
            "cool" to "清冷 · 更慢更低",
        )

        /** 精灵大小三档（dp）：窗口宽 = 该值，高 = 该值 + 32dp 气泡带。默认 168。 */
        val SPRITE_SIZES = listOf(120 to "小 · 120dp", 168 to "中 · 168dp", 200 to "大 · 200dp")
        /** 形象：第一项是原来的鲸鱼娘视频，其余是 Aster 立绘（页面侧 setOutfit 按这个 key 取图）。 */
        val OUTFITS = listOf(
            "" to "鲸鱼娘",
            "sailor" to "水手裙",
            "maid" to "女仆装",
            "casual" to "鲸鱼卫衣",
            "winter" to "冬日斗篷",
            "princess" to "深海公主",
            "researcher" to "深海研究员",
            "witch" to "星潮小魔女",
            "pajamas" to "泡泡睡衣",
        )
        /** 显示方式二选一：键 → 设置页文案。 */
        val DISPLAY_MODES = listOf(
            "home" to "只在桌面显示",
            "always" to "一直显示",
        )
        const val DEFAULT_DISPLAY_MODE = "always"

        const val DEFAULT_SPRITE = 168
        const val DEFAULT_WAKE_NAME = "大肥鱼"

        /** 称呼：去空白、限 2–4 字，非法就回默认「大肥鱼」。 */
        fun cleanWakeName(raw: String): String {
            val s = raw.replace("\\s".toRegex(), "").trim()
            if (s.length in 2..4) return s
            return DEFAULT_WAKE_NAME
        }

        /** 不在表里（含 null、老版本残留值）一律回空串＝视频素材，别让页面拿到坏 key。 */
        fun cleanOutfit(raw: String?): String =
            if (OUTFITS.any { it.first == raw }) raw ?: "" else ""

        fun cleanSpriteSize(raw: Int): Int =
            if (SPRITE_SIZES.any { it.first == raw }) raw else DEFAULT_SPRITE

        /** 不在表里（含 null、老安装没有这个键）回默认「一直显示」。 */
        fun cleanDisplayMode(raw: String?): String =
            if (DISPLAY_MODES.any { it.first == raw }) raw ?: DEFAULT_DISPLAY_MODE else DEFAULT_DISPLAY_MODE

        private val TOKEN_RE = Regex("^[A-Za-z0-9._~+\\-/=]+$")

        /**
         * 配对载荷统一解析（扫码与粘贴共用，只有这一份逻辑）。三种写法都认：
         *  1. 完整配对链接  `https://host/pet-voice/?k=<token>`（也认 `?token=`）
         *  2. 裸 token 串    配上 [currentBase]（扫码时取 App 里已填/已保存的宿主）
         *  3. JSON           `{"host":"https://…/pet-voice/","token":"…"}`（host/baseUrl/url 均可）
         *
         * @return baseUrl(已规范成 …/pet-voice/) to token；解析不出来返回 null。
         */
        fun parsePairPayload(raw: String, currentBase: String = ""): Pair<String, String>? {
            val s = raw.trim()
            if (s.isEmpty()) return null
            if (s.startsWith("{")) return parsePairJson(s)
            PetSettings.parsePairLink(s)?.let { (base, token) -> return base to token }
            if (s.contains("://") || s.contains('/') || s.contains(' ')) return null
            if (s.length < 8 || !TOKEN_RE.matches(s)) return null
            val base = PetSettings.normalizeBase(currentBase)
            if (base.isEmpty()) return null
            return base to s
        }

        private fun parsePairJson(raw: String): Pair<String, String>? {
            val json = try {
                org.json.JSONObject(raw)
            } catch (e: Exception) {
                return null
            }
            val token = json.optString("token").ifBlank { json.optString("k") }.trim()
            val host = json.optString("host").ifBlank { json.optString("baseUrl") }
                .ifBlank { json.optString("base") }
                .ifBlank { json.optString("url") }
                .ifBlank { json.optString("origin") }
            val base = PetSettings.normalizeBase(host)
            if (base.isEmpty() || token.isEmpty()) return null
            return base to token
        }
    }

}

object PetSettings {
    private const val FILE = "pet_prefs"
    private const val K_BASE = "base_url"
    private const val K_TOKEN = "token"
    private const val K_PRESET = "preset"
    private const val K_WAKE = "wake_enabled"
    private const val K_AUTOSTART = "auto_start"
    private const val K_BUBBLE = "bubble"
    private const val K_WAKE_NAME = "wake_name"
    private const val K_SPRITE = "sprite_size"
    private const val K_OUTFIT = "pet_outfit"
    private const val K_DISPLAY = "display_mode"
    private const val K_PINNED = "pinned_title"
    private const val K_CHAT_SESSION = "chat_session"
    /** 上一次看到的「电脑上开着哪只对话」：用来发现桌面端换过会话。 */
    private const val K_PENDING_APK = "pending_apk_path"
    private const val K_PENDING_CODE = "pending_apk_code"
    private const val K_PENDING_NAME = "pending_apk_name"

    @Volatile
    private var cached: SharedPreferences? = null

    private fun prefs(context: Context): SharedPreferences {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val p = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            cached = p
            return p
        }
    }

    fun load(context: Context): PetConfig {
        val p = prefs(context)
        return PetConfig(
            baseUrl = p.getString(K_BASE, "") ?: "",
            token = p.getString(K_TOKEN, "") ?: "",
            preset = p.getString(K_PRESET, "whale") ?: "whale",
            wakeEnabled = p.getBoolean(K_WAKE, false),
            autoStart = p.getBoolean(K_AUTOSTART, false),
            bubble = p.getBoolean(K_BUBBLE, true),
            wakeName = PetConfig.cleanWakeName(
                // 旧默认称呼随版本改名，老安装里的「鲸灵」跟着改成新默认
                p.getString(K_WAKE_NAME, PetConfig.DEFAULT_WAKE_NAME)
                    ?.takeUnless { it == "鲸灵" } ?: "",
            ),
            spriteSize = PetConfig.cleanSpriteSize(p.getInt(K_SPRITE, PetConfig.DEFAULT_SPRITE)),
            outfit = PetConfig.cleanOutfit(p.getString(K_OUTFIT, "")),
            displayMode = PetConfig.cleanDisplayMode(p.getString(K_DISPLAY, PetConfig.DEFAULT_DISPLAY_MODE)),
        )
    }

    fun save(context: Context, cfg: PetConfig) {
        prefs(context).edit()
            .putString(K_BASE, normalizeBase(cfg.baseUrl))
            .putString(K_TOKEN, cfg.token.trim())
            .putString(K_PRESET, cfg.preset)
            .putBoolean(K_WAKE, cfg.wakeEnabled)
            .putBoolean(K_AUTOSTART, cfg.autoStart)
            .putBoolean(K_BUBBLE, cfg.bubble)
            .putString(K_WAKE_NAME, PetConfig.cleanWakeName(cfg.wakeName))
            .putInt(K_SPRITE, PetConfig.cleanSpriteSize(cfg.spriteSize))
            .putString(K_OUTFIT, PetConfig.cleanOutfit(cfg.outfit))
            .putString(K_DISPLAY, PetConfig.cleanDisplayMode(cfg.displayMode))
            .apply()
    }

    /**
     * 接受这些写法：
     *   https://xxx.trycloudflare.com
     *   https://xxx.trycloudflare.com/pet-voice
     *   https://xxx.trycloudflare.com/pet-voice/
     *   http://192.168.1.5:52356/pet-voice/
     * 统一成 …/pet-voice/。
     */
    fun normalizeBase(raw: String): String {
        var s = raw.trim()
        if (s.isEmpty()) return ""
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://$s"
        val uri = try {
            Uri.parse(s)
        } catch (e: Exception) {
            return ""
        }
        val scheme = (uri.scheme ?: "https").lowercase()
        val authority = uri.authority ?: return ""
        // 明文 http 只允许本机/局域网：公网 http 会把 token 和整段对话内容暴露在链路上。
        if (scheme != "https" && !plaintextHostAllowed(authority)) return ""
        var path = (uri.path ?: "").trimEnd('/')
        if (!path.endsWith("/pet-voice")) path = "/pet-voice"
        return "$scheme://$authority$path/"
    }

    /**
     * 明文 http 的白名单：只有「本机 / 模拟器宿主 / 局域网」才允许不加密。
     * 公网地址必须 https —— trycloudflare 和自定义域名隧道都自带证书，没有理由退让。
     */
    fun plaintextHostAllowed(authority: String): Boolean {
        val host = authority.substringBefore(':').substringAfter('[').substringBefore(']').lowercase()
        if (host.isEmpty()) return false
        if (host == "localhost" || host == "::1" || host == "10.0.2.2" || host == "127.0.0.1") return true
        if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home")) return true
        if (host.startsWith("192.168.") || host.startsWith("10.")) return true
        if (host.startsWith("172.")) {
            val second = host.split('.').getOrNull(1)?.toIntOrNull()
            if (second != null && second in 16..31) return true
        }
        return false
    }

    /** 解析桌面「复制配对链接」得到的 `https://host/pet-voice/?k=<token>`，返回 base+token。 */
    fun parsePairLink(raw: String): Pair<String, String>? {
        val uri = try {
            Uri.parse(raw.trim())
        } catch (e: Exception) {
            return null
        }
        val token = uri.getQueryParameter("k") ?: uri.getQueryParameter("token") ?: return null
        if (token.isBlank()) return null
        val base = normalizeBase(raw)
        if (base.isEmpty()) return null
        return base to token.trim()
    }

    /** 「现在钉在哪个项目」：只存标题给界面显示用；真身以 `/api/workspaces` 的 pinned 为准。 */
    fun pinnedTitle(context: Context): String = prefs(context).getString(K_PINNED, "").orEmpty()

    fun savePinnedTitle(context: Context, title: String) {
        prefs(context).edit().putString(K_PINNED, title.trim()).apply()
    }

    /* ---------------- 会话：默认复用专属会话 ---------------- */

    /**
     * 「新对话」另开的那只会话 id。空 = 交给宿主默认落点（专属会话）。
     * 为什么默认不钉死：专属会话由宿主 `pet-session.json` 管，App 重启、Mac 上 DSH 重启都不影响，
     * 上下文还能接着聊；只有用户明确要「新对话」时才钉一只新的。
     */
    fun chatSession(context: Context): String = prefs(context).getString(K_CHAT_SESSION, "").orEmpty()

    fun saveChatSession(context: Context, sessionId: String) {
        prefs(context).edit().putString(K_CHAT_SESSION, sessionId.trim()).apply()
    }

    fun clearChatSession(context: Context) {
        prefs(context).edit().remove(K_CHAT_SESSION).apply()
    }

    /** 桌面端上一次停在哪只对话上（只用来发现「换过了」，不参与派发）。 */


    /* ---------------- 自动更新：待安装的 APK ---------------- */

    /**
     * 后台把新版 APK 下载好之后记在这里，通知点进 App 就能直接弹安装。
     * 只存路径 + 版本号，不存任何令牌。
     */
    fun savePendingApk(context: Context, path: String, versionCode: Int, versionName: String) {
        prefs(context).edit()
            .putString(K_PENDING_APK, path)
            .putInt(K_PENDING_CODE, versionCode)
            .putString(K_PENDING_NAME, versionName)
            .apply()
    }

    /** @return path / versionCode / versionName；没有待安装包返回 null。 */
    fun pendingApk(context: Context): Triple<String, Int, String>? {
        val p = prefs(context)
        val path = p.getString(K_PENDING_APK, "").orEmpty()
        val code = p.getInt(K_PENDING_CODE, 0)
        if (path.isBlank() || code <= 0) return null
        if (!java.io.File(path).exists()) {
            clearPendingApk(context)
            return null
        }
        return Triple(path, code, p.getString(K_PENDING_NAME, "").orEmpty())
    }

    fun clearPendingApk(context: Context) {
        prefs(context).edit()
            .remove(K_PENDING_APK).remove(K_PENDING_CODE).remove(K_PENDING_NAME).apply()
    }

    /** UI 上只显示这个，不展示明文。 */
    fun maskedToken(token: String): String =
        if (token.isBlank()) "未设置" else "已保存 · " + "•".repeat(8) + "（长度 ${token.length}，不显示明文）"
}
