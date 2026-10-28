# dsh-pet-voice · 鲸灵随身宠物

把 DeepSeek Harness 变成一只**能用嘴使唤**的宠物：手机扫码配对后，悬浮窗里住着一只像素鲸鱼娘；喊一声「鲸灵」，活就派给电脑上的 DSH，回复边生成边念出来，动作同步跟上。

- **形态**：宿主侧 Cordis 插件，自己在 `webServer` 上挂 `/pet-voice/`（带 token 的页面 + JSON / SSE / 长轮询接口），不改官方页面、不动 profile 的 `package.json`。
- **App 端**：30 MB Android 自签名包（`android/`），悬浮窗 + 常听麦克风 + 语音唤醒；桌宠玩法与语音对话都在 App 里。
- **三种连法**：局域网 / 自建域名 / 服务器中转，全部用你自己的地址，代码里没有硬编码域名或 IP。
- **零账号**：会话、记忆、配置都在你这台电脑上；项目不运营服务器。

![鲸灵](https://raw.githubusercontent.com/regrevia/dsh-pet-voice/main/assets/pet-hero-white.png)

## 安装

```bash
# 1. 放进本地插件目录
rsync -a --delete plugins/dsh-pet-voice/ ~/.dsh/plugins/dsh-pet-voice/

# 2. 装进 desktop profile（也可以让 agent 调 plugin_manager）
#    plugin_manager action=install_bundle target=~/.dsh/plugins/dsh-pet-voice
```

首次安装要让桌面端重读 `cordis.patch.yml`（重启 App 一次）。之后改代码不用重启，把插件关一下再开即可：

```
plugin_manager action=set_plugin target=include:dsh-pet-voice enabled=false
plugin_manager action=set_plugin target=include:dsh-pet-voice enabled=true
```

> `target` 必须写 `include:dsh-pet-voice`，只写包名会报 `unknown-plugin`。

装好后页面在 `ctx.webServer.getOrigin()` 下，本机是 `http://127.0.0.1:58686/pet-voice/`（端口按宿主实际值）。

### 可选件

插件本体零额外依赖。两样可选件不装也能用，只是少一块能力（venv 都落在 `~/.dsh/pet-voice/`，不在仓库里）：

| 能力 | 从哪来 | 装法 | 不装 |
| --- | --- | --- | --- |
| 神经语音 | 微软 edge-tts，免 key | `bash plugins/dsh-pet-voice/tts/setup.sh` | 不出声，仍可打字对话；也可换本机或自己的接口 |
| 本机识别 | openai-whisper 常驻，只听回环 | `bash plugins/dsh-pet-voice/asr/setup.sh`（torch 首次几 GB） | 默认走手机自己的语音识别 |

两个脚本幂等，重复跑只检查不重装。

## 配对

面板 →「连上手机」→ 选连法 → 出二维码或链接：

```
https://<你的地址>/pet-voice/?k=<token>
```

`?k=` 只做一次：校验通过会下发 `HttpOnly` cookie 并跳到 `/pet-voice/`。token 在 `~/.dsh/pet-voice/token`（0600）——**分享链接等于把 DSH 交出去**。怀疑泄露就 `rm ~/.dsh/pet-voice/token`，下个请求自动生成新 token，旧 cookie 立刻失效。

浏览器只允许 https 或 localhost 用麦克风，所以手机必须走 https：局域网档需要自签证书（App 内置示例 CA 公钥，无私钥），外网档用隧道或自建域名。细节见仓库根目录的 [README](../../README.md) 与 [docs/self-host.md](../../docs/self-host.md)。

## 页面能做什么

| 位置 | 动作 |
| --- | --- |
| 底部大圆键 | 按住说话，松手即发；按住时图标变波形 |
| `常听：开/关` | 持续听，只认「鲸灵 / 小鲸 / 嗨鲸灵 / hey whale / hello whale」 |
| `朗读：开/关` | 语音合成开关 |
| 输入框 | 打字派活，语音不可用时兜底 |
| ⚙ 面板 | 切项目 / 切人设 / 开新会话 / 打断 / 自检 / 复制配对链接 |

唤醒词命中会「叮」一声 + 轻震，停顿约 1.1 秒自动提交。状态行固定：`我在～` / `在听，喊我鲸灵` / `在想…` / `在说…`。语义打断（说「停一下」）不保证，打断请点面板的「打断当前回答」。

## 接口

都在 `/pet-voice/api/` 下，除静态资源外要求 cookie 或 `?k=`。完整字段、帧格式、错误码见 [docs/pet-contract.md](../../docs/pet-contract.md)。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `state` | 项目、人设、最近会话、唤醒词；只回 token 前 8 位 |
| POST | `new` | `{workspaceId?, projectPath?, preset?, fresh?}` → `{sessionId, reused}` |
| POST | `dispatch` | `{text, sessionId?, attachments?}` → 202 受理；不带 sessionId 一律派给专属会话 |
| POST | `upload?name=` | 原图字节（jpeg/png/webp/gif，≤12 MB）→ 落盘路径，可填进 `attachments` |
| POST | `say` | `{text, voice?, id?}` 入播报队列，最多留 20 条 |
| GET | `pair` | 页面引导卡用的可访问地址；不含 token |
| GET | `stream` | SSE：`hello`/`start`/`delta`/`message`/`tool`/`final`/`end`/`error`，15s 心跳 |
| GET | `poll` | 长轮询兜底，语义同 SSE，按 `cursor` 续传 |

## 语音链路

- **TTS 三档**：edge-tts 子进程（免 key，可调音色/语速/音高）/ 本机（macOS `say` + `ffmpeg`，断网可用）/ 自己的接口（`POST {text, voice, speed}`，认音频字节、base64 或 url）。三档共用 `/api/tts`，手机端拿到的永远是 `audio/mpeg`。
- **ASR 两档**：手机系统语音（`SpeechRecognizer`，是否上传音频由系统/厂商决定）/ 本机 whisper（只听回环）。
- 回答第一句出来就开始读，不等全文；代码块读成「（代码块）」。

## 发版与自更新

```bash
# 1. 出包（同一个 keystore 才能覆盖安装且保住配对信息）
cd android && ./gradlew :app:assembleRelease
# 2. 算 sha256、原子写本地 latest.json、推 GitHub Release（草稿 → 正式）
# 3. 想让老用户看到时，再换掉 latest 入口
```

## 已知限制

- Android 14/15 未做实机验证：后台恢复、麦克风前台服务在收紧后的行为待确认。
- 各家 ROM 的权限跳转可能不同；硬件麦克风只在 AOSP 页面验证过。
- iOS 不支持：悬浮窗与常听麦克风是 Android 特性。

## 卸载

```
plugin_manager action=set_plugin target=include:dsh-pet-voice enabled=false
```

删 `~/.dsh/plugins/dsh-pet-voice/` 与 `~/.dsh/pet-voice/` 即可，仓库外无残留。

## 许可

MIT。像素素材由本项目生成，同样 MIT。
