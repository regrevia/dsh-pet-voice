# 随身宠物「鲸灵」跑起来（手机端 · 2026-10-24）

> 这份是**操作手册**，只写「怎么开、怎么用、哪里会翻车」。
> 设计与调研见 [architecture.md](architecture.md)、[voice.md](voice.md)、[plugin-integration.md](plugin-integration.md)、[hardware.md](hardware.md)。
> 标注约定：**【实测】** = 本机今天跑过并留下证据；**【未实测】** = 没在真手机上验证；**【估算】** = 推算。

---

## 1. 已经能用的东西在哪

| 东西 | 位置 | 状态 |
|---|---|---|
| 手机端页面（鲸灵 PWA） | DSH 宿主插件 `dsh-pet-voice`，挂在 `http://127.0.0.1:58686/pet-voice/` | 【实测】401 门禁、token 换 cookie、静态资源全 200 |
| 语音宠物本体 | 同一页面的像素鲸鱼娘 + 按住说话 + 唤醒词 + 朗读 | 【实测】页面渲染、状态行、开关正常；语音识别质量【未实测】 |
| 派发到电脑上的 DSH 会话 | `POST /pet-voice/api/dispatch` | 【实测】真跑通：`turn/start → assistant/message("鲸灵在线")`，模型首字 **758 ms** |
| 串流回手机 | `GET /pet-voice/api/stream`（SSE，失败自动降级长轮询） | 【实测】Node 侧 6 帧（hello/start/delta/final/end）；浏览器侧降级原因已交回修 |
| 切换项目 / 人设 | ⚙ 面板 → workspace / preset | 【实测】列出 5 个项目、4 个人设（standard/ptc/minimal/cordis），切项目即在新 workspace 开会话 |
| 外部助手接进来（MCP） | `mcp/pet-bridge/server.mjs` | 【实测】离线 `selftest: 17/18 通过`（1 SKIP），`PET_LIVE=1` 时 `18/18 通过`，含真实 `pet_ask` 往返 |

---

## 2. 手机打开（三步）

前提：Mac 上 DSH 开着（页面是 DSH 的插件，App 关了就没了）。

```bash
# ① 起隧道（走 Cloudflare 免费 quick tunnel，不需要账号）
~/.dsh/profiles/desktop/node_modules/cloudflared/bin/cloudflared \
  tunnel --url http://127.0.0.1:58686 --no-autoupdate --protocol http2
#   日志里会打印 https://<随机词-随机词-随机词>.trycloudflare.com
#   注意：App 重开/隧道重开 → 这个域名会变，必须重新发链接

# ② 生成一次性入口链接（token 从文件读，别贴到群里）
echo "https://<你的隧道域名>/pet-voice/?k=$(cat ~/.dsh/pet-voice/token)"
```

③ 手机浏览器打开 ② 打出来的链接 → 服务器 303 跳转并种下 `HttpOnly; Secure` cookie，之后直接访问 `/pet-voice/` 即可。

- 第一次打开会请求**麦克风权限**（必须 HTTPS，`http://192.168.x.x` 浏览器直接拒）【实测：本地 http 也能用，但手机走 LAN 会被浏览器拦】
- Safari 可「添加到主屏幕」，manifest 已经写了（`display: standalone`）【实测：manifest 200，安装效果未实测】
- ⚠️ 这个链接等于**电脑 DSH 的完整控制权**（能派发任意任务、跑命令）。只能自己用，别转发、别截图外发。泄露了就删 `~/.dsh/pet-voice/token` 再重启 App，旧链接立即失效。

不想开公网，也可以让手机和电脑同一个 Wi-Fi 用 `http://<Mac 局域网 IP>:58686/pet-voice/?k=...`——但**麦克风会不可用**（非安全上下文），只能打字。

---

## 3. 顺手怎么用

| 想干的事 | 怎么说/怎么点 |
|---|---|
| 问我 | 按住大按钮说话，松手 1.1 s 静音自动发送；或直接打字 |
| 不按住也能喊 | 开「常听」，然后说「鲸灵」「小鲸」「嗨鲸灵」「hey whale」「hello whale」唤醒 |
| 我说话太吵 | 关「朗读」（用的是手机自带 `speechSynthesis`，代码块会被念成「（代码块）」） |
| 换项目 | ⚙ → 项目 → 选 Pet / Envoy / creator-studio / REA / DSH，之后发的活都在那个目录下干 |
| 换人设 | ⚙ → 人设 → standard / ptc / minimal / cordis（决定工具集与语气） |
| 重开一个干净的会话 | ⚙ → 新会话（`fresh`） |
| 让它停下 | ⚙ → 取消 |

---

## 3.5 声音：已换成神经语音（不再用系统音）

之前「僵硬」的真因：走的是手机自带 `speechSynthesis`（iOS 上就是 Tingting 那类系统音），必然机械。
现在默认走**宿主侧合成的微软 Edge 神经语音**（`edge-tts`，免 key 免账号），页面收到文本增量后**按句切分、边合边播**；合成失败或没装 venv 才回退系统语音（并提示一次）。

- 装一次：`bash plugins/dsh-pet-voice/tts/setup.sh` → 在 `~/.dsh/pet-voice/tts-venv` 建 venv 装 `edge-tts`【实测：已装好，7.3.1】
- 换音色：页面 ⚙ → **音色（神经语音）**，7 个中文音色：小艺·活泼少女（默认）、晓晓·温暖自然、晓辰·亲和、晓萱·沉稳、晓墨·故事感、晓北·东北话、晓妮·陕西话【实测：下拉已渲染】
- 延迟（同一句 24 字，实测）：本机首字节 **0.93–1.10 s**、整段 1.2–1.7 s；走隧道首字节 **1.8–3.0 s**、整段 2.0–3.3 s → 公网下第一句约晚 2 s 出声，之后按句连播。
- 要豆包本体音色：得用火山引擎（Seed-TTS）的 AppID + AccessToken，或 MiniMax / 阿里百炼 CosyVoice；`/api/tts` 是单一可替换端点，换厂商只改 `tts/stream.py` + 音色白名单。

---

## 3.6 换隧道域名（一条命令）

trycloudflare 的临时域名每次重启都会变，别手抄：

```bash
bash scripts/tunnel.sh --check   # 先探：cloudflared 在不在、宿主端口通不通、xiaoai.json 在不在
bash scripts/tunnel.sh           # 起隧道 → 抓 https://*.trycloudflare.com → 写回 ~/.dsh/pet-voice/xiaoai-url.txt(0600)
bash scripts/tunnel.sh --stop    # 收掉上次那条（读 tunnel.pid）
```

只会打印「新地址已写入 …」+ PID + 日志路径，不常驻前台、不打印 `?k=`。

> **要长期固定域名、用你自己的 Cloudflare 账号**：`bash scripts/tunnel.sh --named`
> （读 `~/.dsh/pet-voice/cloudflared.token` + `cloudflared.host`，绕开 trycloudflare 临时域名与 DNS 抖动）。
> 完整步骤、故障表和凭据存放位置见 [cloudflare-own.md](cloudflare-own.md)。
换完直接开手机页面：引导卡里的地址读的是 `GET /pet-voice/api/pair`，会自动拿到新域名；
卡片还会显示 `alive`（服务端 1.5s 探活 + 30s 缓存）——黄灯 ⚠️ 就是域名过期了，
服务端此时**不会**降级成局域网地址（那在手机流量下更打不开）。

## 4. 让别的 AI 助手（Claude Desktop / 其它 MCP 客户端）指挥鲸灵

```json
{
  "mcpServers": {
    "pet-bridge": {
      "command": "/usr/local/bin/node",
      "args": ["mcp/pet-bridge/server.mjs"]
    }
  }
}
```

工具：`pet_status` / `pet_switch_project` / `pet_ask` / `pet_new_session` / `pet_stop` / `pet_say`。
端口每次 App 启动会变，服务端会自动探测（`PET_BASE` 可强制指定）。`pet_say` 已经可用：宿主新增 `POST /pet-voice/api/say`（鉴权、300 字截断、20 条环形队列、`seq` 游标、`id` 幂等），手机页面通过 SSE `say` 帧或 1.5s 轮询取走并用页面自己的神经语音念出来；宿主没这个接口时工具会**如实报错**，不会假装成功。派发落点固定为专属会话（`pet-session.json`），任何工具都不会写进界面当前会话。

关于「参照小米的规范」：**小米没有发布面向第三方的官方 MCP 规范**（米家/小爱走 MIoT 设备接入 + 小爱技能云对接两套老口径，市面「米家 MCP」都是社区壳）——细节与接入差距见 [mcp/pet-bridge/xiaomi-notes.md](../mcp/pet-bridge/xiaomi-notes.md)。

---

## 5. 已知会翻车的地方（别当 bug 反复查）

1. **quick tunnel 域名每次变**，而且 Cloudflare 明说不保证可用时长；要固定域名得用自己的 Cloudflare 账号建 named tunnel。
2. **App 一关，页面就 404**：这是宿主插件，不是独立服务。
3. **iOS 的语音识别依赖 Safari 的 Web Speech**：中文识别质量、是否需要在设置里开「听写」都【未实测】；不行就退回打字，功能不缺。
4. **唤醒词是「页面里的软唤醒词」**：麦克风必须一直被页面占用、页面得在前台。真·低功耗唤醒要硬件（见 [hardware.md](hardware.md)）。
5. **延迟**：模型首字 0.7–1 s【实测】；加上 VAD（0.5–0.7 s）+ 手机端 ASR + TTS，一轮往返 **1.5–2.5 s**【估算】。想更顺要做流式 ASR 与句级 TTS（`voice.md` 里有实测基线）。
6. **一个 token 管所有**：没有设备级授权、没有限流。公网暴露面 = DSH 全部能力，这是当前设计的最大风险。
