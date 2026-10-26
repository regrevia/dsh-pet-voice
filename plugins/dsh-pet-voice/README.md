# dsh-pet-voice · 鲸灵随身宠物（手机端语音壳）

把 DeepSeek Harness 变成一只**能用嘴使唤**的宠物：手机打开一个页面，喊「鲸灵」，
说完松手，活就派给电脑上的 DSH；回答边生成边读出来，像素鲸鱼娘同步做口型。
可以随时切换项目（workspace）、切换人设（agent preset），基础操作（新建会话 /
打断 / 自检 / 查看配对链接）都在同一个页面里。

- 形态：**宿主侧 Cordis 插件**，自己在 `webServer` 上挂 `/pet-voice/` 一条带 token
  的页面 + 一组 JSON/SSE/长轮询接口。不改官方 Harness 页面，不动 profile 的
  `package.json`（装的时候由 `plugin_manager` 代管）。
- 语音识别：手机浏览器自带的 Web Speech（Chrome / Edge / 安卓可用）；识别不了的
  浏览器自动退回到输入框。
- 语音合成：`speechSynthesis`，按句子切分边生成边读，说话时鲸鱼娘张嘴。
- 没装、没法用时的兜底：一直有输入框，能打字派活。

---

## 安装

```bash
# 1. 把 bundle 放进本地插件目录
rsync -a --delete plugins/dsh-pet-voice/ ~/.dsh/plugins/dsh-pet-voice/

# 2. 装进 desktop profile（也可以在 DSH 里让 agent 调 plugin_manager）
#    plugin_manager action=install_bundle target=~/.dsh/plugins/dsh-pet-voice
```

**首次安装**要让桌面端重新读一遍 `cordis.patch.yml`（重启 App 一次）。
**之后改代码不用重启**：同步文件后把插件关一下再开，宿主会重新加载模块：

```
plugin_manager action=set_plugin target=include:dsh-pet-voice enabled=false
plugin_manager action=set_plugin target=include:dsh-pet-voice enabled=true
```

> 注意 `target` 要用 `include:dsh-pet-voice`；直接写包名会报 `unknown-plugin`。

装好后页面在 `ctx.webServer.getOrigin()` 下，本机就是
`http://127.0.0.1:58686/pet-voice/`（端口按你的宿主实际值）。

### 第一次装需要什么

插件本体零额外依赖（宿主自带 Node 就能跑）。两样东西是**可选件**，不装也能用，只是功能少一块：

| 能力 | 从哪来 | 装法 | 不装的后果 |
|---|---|---|---|
| 神经语音（音色） | 微软 edge-tts，免 key、免账号，联网直接合成 | `bash plugins/dsh-pet-voice/tts/setup.sh`（建 `~/.dsh/pet-voice/tts-venv`） | 面板「音色」下面会有一行提示；照样能打字对话，只是不出声。也可以把「语音来源」换成本机或自己的接口，那两档不依赖这个 venv |
| 本机识别（ASR） | openai-whisper 常驻进程，只监听回环 | `bash plugins/dsh-pet-voice/asr/setup.sh`（建 `~/.dsh/pet-voice/asr-venv`，torch 首次几 GB） | 默认走手机自己的语音识别，电脑端不做识别 |

两个脚本都是幂等的，重复跑只检查不重装；venv 和模型都落在 `~/.dsh/pet-voice/`，不在仓库里，换目录不会丢。

### 手机怎么打开

浏览器**只允许 https 或 localhost 使用麦克风**，所以手机必须走隧道：

```bash
cloudflared tunnel --url http://127.0.0.1:58686 --no-autoupdate --protocol http2
```

拿到地址之后，手机访问（**推荐命名隧道**：`scripts/tunnel.sh --named`，域名固定、可挂 Access；
快速隧道 `--url` 只适合临时试，域名每次重启都变）：

```
https://xxx-xxx.trycloudflare.com/pet-voice/?k=<token>
```

`?k=` 只做一次：校验通过会下发 `HttpOnly` cookie 并 303 跳到 `/pet-voice/`，
以后直接开 `/pet-voice/` 就行。token 在 `~/.dsh/pet-voice/token`（0600），
和任何人分享链接＝把你的 DSH 交出去，别外传。

**换密码 / 怀疑泄露**：`rm ~/.dsh/pet-voice/token`，下一个请求会自动生成新 token
（不用重启）；旧 cookie 立刻失效，重新用新的 `?k=` 链接打开即可。页面里
`⚙ → 复制配对链接` 拿到的也是当前生效的完整链接（该接口要求已有 cookie）。

---

## 页面能做什么

| 位置 | 动作 | 说明 |
| --- | --- | --- |
| 底部大圆键 | 按住说话 | 松手即发送；按住时图标变成波形、按钮转红 |
| `常听：开/关` | 免手操作 | 打开后持续听，只认「鲸灵 / 小鲸 / 嗨鲸灵 / hey whale / hello whale」 |
| `朗读：开/关` | 语音合成 | 关掉就只看文字 |
| 中间对话区 | 最近 2–3 轮 | 用户一句话 + 鲸灵回复（最多 3 行，超出裁切），自动滚到最新 |
| 输入框 | 打字派活 | 语音不可用时的兜底，也方便贴着说话 |
| ⚙ 面板 | 切项目 / 切人设 / 开新会话 / 打断 / 自检 / 复制配对链接 | 切项目＝切到那个 workspace 下干活 |

- 开关统一写成「名字：状态」，打开时按钮高亮（不是「看起来像按钮的状态字」）。
- 唤醒词命中后会「叮」一声 + 轻震动，然后进入这一轮的收音；**停顿约 1.1 秒**
  自动提交，不用点发送。
- 状态行固定中文：`我在～` / `在听，喊我鲸灵` / `在想…` / `在说…`。
- 说「停一下」这类语义打断不保证——要打断请点面板里的「打断当前回答」，
  它会调宿主的 `sessionController.cancel`。
- 回答第一句出来就开始读，不等全文；代码块读成「（代码块）」，不念符号。

---

## 接口（自己写客户端时用）

都在 `/pet-voice/api/` 下，除静态资源外全部要求 cookie 或 `?k=`：

| 方法 | 路径 | 入参 / 出参 |
| --- | --- | --- |
| GET | `state` | 项目列表、人设、最近会话、唤醒词、`petSession` / `dispatchTarget`；**只给 token 前 8 位**（`tokenHint`），永远不回明文 token。`current` 仅用于界面展示 |
| POST | `new` | `{workspaceId?, projectPath?, preset?, fresh?}` → `{sessionId, reused}`；**不给项目时落到专属会话** |
| POST | `dispatch` | `{text, sessionId?, attachments?}`（`attachments` 最多 6 条绝对路径，拼成 `[图片] …` 附在正文后）→ 1.2s 内已受理返回 `202 {accepted:true, sessionId}`，已结束返回 `200`。**不带 `sessionId` 一律派给专属会话**（`pet-session.json` 那只，钉在 Pet 项目），绝不回退到界面当前会话；显式给了但不存在 → `404` |
| POST | `upload?name=` | 请求体是原图字节（`content-type` 只认 `image/jpeg`/`image/png`/`image/webp`/`image/gif`，≤12 MB），回 `{ok, path, name, bytes}`，`path` 可直接填进 `dispatch` 的 `attachments` |
| POST | `say` | `{text, voice?, id?}` → `{ok, seq, queued}`；`text` 超 300 字截断并标 `truncated:true`；队列只留最近 20 条；同 `id` 重复投递只入队一次 |
| GET | `pair` | `{ok, publicBase, source:"tunnel"|"lan"|"local", tunnelAt, alive?, note?}`；页面引导卡用它填「手机上能打开的地址」。**不含 token**：`tunnel` 取 `xiaoai-url.txt` 的 origin，`lan` 用本机非回环 IPv4+宿主端口，`local` 只有 127.0.0.1（手机打不开）。`tunnelAt` 里的 `?k=` 一律替换成 `<已省略>`；`tunnel` 档会**服务端探活**（`publicBase + api/pair`，1.5 s 超时、30 s 缓存、并发去重），401 也算活着；探不通时 `alive:false` + `note:"隧道域名可能已过期（cloudflared 重启会换域名）"`，**不会**降级到 lan（私网地址手机更打不开） |
| GET | `say?since=` | `{items:[{seq,text,voice,at}], cursor}`，按 `seq` 升序，最多 20 条；`since=-1` 只对齐游标不回放（页面刷新不重播） |
| GET | `stream?sessionId=` | SSE：`hello` / `start {turn}` / `delta {text}` / `message {text,turn}` / `tool {name}` / `final {text,turn}` / `end {reason,turn}` / `error {message}`，15s 一次心跳。`message` 是过程消息**不是**终止；`final` / `end` 只在官方的 `turn/end` 发（工具任务不会在「我查一下」那句被误判结束；`turn/end` 90 秒没来才有兜底 `end`，这一轮还活着就一直等到 5 分钟硬上限），判定一轮结束只看 `end`；`start` 的轮次号取自官方 `data.turn` |
| GET | `poll?sessionId=&cursor=&wait=` | 长轮询兜底，语义同 SSE。`cursor` 传帧序号续传，一次最多回 200 帧；`more:true` 表示还有没取完的，按返回的 `cursor` 接着取（游标只推进到**已返回的最后一帧**，不会跳帧）；**`cursor=-1` 是「只对齐」**：立刻回 `{frames:[], cursor:<最新 seq>}`，用来接上会话时不重播历史 |
| POST | `cancel` | `{sessionId}` |
| GET | `link` | 当前生效的完整配对链接（要已登录的 cookie） |
| GET | `selfcheck` | 只读探针；`?prompt=<sessionId>` 时额外跑一次真实 LLM 往返（会计费） |
| GET | `tts/voices` | `{ok, ready, default, defaultPreset, presets[], voices[], hint?}`；`presets` 是 4 个形象档位（见下）；`ready:false` 时页面回退系统语音 |
| GET | `tts?text=&preset=` | 按面板「语音来源」出声，直出 `audio/mpeg`：微软在线走 `edge-tts`（需先跑 `tts/setup.sh`），这台电脑走系统 `say`，自己的接口转发到你填的地址；`preset` 解析成 voice+rate+pitch，也可显式传 `&voice=&rate=+16%&pitch=+22Hz` 覆盖；未知档位 → 400；对应来源没备好 → 503 并说清缺什么 |
| POST | `asr` | 请求体就是 44 字节头 + 16 kHz 单声道 PCM 的 WAV；转发给常驻 worker（`asr/asr-worker.py` → `127.0.0.1:52399`，默认 `large-v3-turbo` + `beam_size=5`）→ `{ok, text, ms}`，响应头带 `X-Asr-Ms`。**识别结果命中最近 5 分钟内播报过的句子时回 `{ok:true,text:"",echo:true}`**（手机外放把自己说的话录回来，不能当成用户发言，见下）。空音频/坏音频 → 400，超过 4 MB → 413；worker 没装 → 503 + `hint`；worker 被杀了下次请求会自动拉起并完成本次识别（冷启动 11 s，预算 25 s） |
| GET | `asr` | 只读探针：`{ok, ready, running, model, pid?}`。`ready:false` 说明缺 venv 或 worker 脚本，`hint` 里给缺的路径 |
| GET | `update` | 更新通道（兜底那一档）：读 `~/.dsh/pet-voice/update/latest.json` → `{ok, versionCode, versionName, size, sha256, file, notes, publishedAt, minPlugin?, url}`；还没发布过 → `versionCode:0` + 可读 `hint` |
| GET / HEAD | `../download/<file>.apk` | 下载已发布的 APK（**同样要 cookie**）；支持 `Range`（206 / 越界 416），`HEAD` 只回头，路径穿越 → 400/404，非 GET/HEAD → 405 |

### 语音识别（ASR）细节

`asr/asr-worker.py` 是常驻的 openai-whisper 进程，只监听回环；没跑 `asr/setup.sh` 就不启动，识别在手机上做。默认模型 `large-v3-turbo`（1.5 GB，权重缓存在
`~/.cache/whisper/`），`beam_size=5`：base 在中文上会稳定错字（「语音识别服务」→「余音时别服务」）并偶尔吐繁体，
turbo 用同一批句子全对，只多花半秒。

两条兜底都在 worker 里做，命中就回空文本（App 侧表现是这一轮没听见，不产生假用户消息、不触发假回复）：

- **幻听/套话**：`请按赞、转发、转发……`、复读、字数密度离谱的整句直接丢，日志写 `丢弃疑似幻听（原因）`。
- **播报回声**：手机外放会把助手自己的话录回去。插件侧记最近 16 句播报（5 分钟内有效），识别结果去标点、
  数字归一后与播报原文双字重合度 ≥ 0.55、或整段落在某句播报里，就判为回声并回 `echo:true`。

每句识别的输入长度、耗时、模型、是否被丢弃都落一行 `~/.dsh/pet-voice/asr/transcripts.log`（512 KB 封顶）；
`~/.dsh/pet-voice/logs/asr.log` 记插件侧的字节数、命中回声的原文。派发到专属会话的每一轮记
`~/.dsh/pet-voice/logs/turn.log`（状态码、耗时、文本前 60 字），「说了却没回复」先看这两个日志。

### 发新版 + 手机自更新

```bash
# 1. 出包（同一个 keystore，才能覆盖安装且保住配对信息）
JAVA_HOME=~/jdk17/Contents/Home ~/.gradle/wrapper/dists/gradle-8.13-bin/*/gradle-8.13/bin/gradle \
  -p android :app:assembleRelease --offline \
  -Pandroid.aapt2FromMavenOverride=/opt/homebrew/share/android-commandlinetools/build-tools/35.0.0/aapt2

# 2. 存档（算 sha256、原子写本地 latest.json、推到 GitHub Release 草稿→正式）。这一步用户看不到。
node scripts/publish-apk.mjs dist/jingling-0.9.46.apk --notes "这一版改了什么"

# 3. 放给用户（想放的时候）：镜像到 cnb.cool + 换掉 CNB 的 latest 入口 + 提交仓库 update/latest.json
node scripts/publish-apk.mjs dist/jingling-0.9.46.apk --notes "…" --promote

# 这一版 App 真用到新插件接口时，加门槛：插件版本不够的机器只显示「先更新插件」，不下载
node scripts/publish-apk.mjs dist/jingling-0.9.46.apk --notes "…" --promote --min-plugin 0.1.9

# 想退回上一版（那版推广过、自带 meta 才能退）
node scripts/publish-apk.mjs --rollback 0.9.44
```

更新通道优先级由高到低：CNB `latest` → 仓库 `update/latest.json`（jsDelivr → raw）→ 宿主这个
`~/.dsh/pet-voice/update/latest.json`（相对地址兜底）。三条都只在 `--promote` 时变，所以「什么时候给用户」
是人的决定：GitHub 上的存档、宿主的兜底目录，都不会把没推广的版本漏出去——包括自家已经绑定的设备。
兜底那条要令牌，只有扫过码的设备问得动，公开渠道的 meta 里也没有任何指向宿主的地址。meta 带 `minPlugin`（`--min-plugin 0.1.8`）时，
App 发现本机插件版本更低就只提示「先更新插件」，不下载；插件版本随 `/api/state` 的 `pluginVersion` 上报。

手机端：`更多 → 检查更新` → `下载并安装`。走的是 `PackageInstaller`（零 androidx 的代价），
同一个包名 + 同一个签名 ⇒ **覆盖安装**，`pet_prefs` 里的地址/token/唤醒词/尺寸全部保留，
不需要重新扫码。想彻底停掉所有服务（含自启动）用 `更多 → 关闭全部服务`。

### 换隧道域名：`scripts/tunnel.sh`

```bash
scripts/tunnel.sh --check          # 只校验 cloudflared / 宿主端口 / xiaoai.json，不起隧道
scripts/tunnel.sh                  # 默认端口 52356：快速隧道 → 抓 https://*.trycloudflare.com（临时）
scripts/tunnel.sh --named          # 自己的域名 + 命名隧道（读 ~/.dsh/pet-voice/cloudflared.token/.host）
                                   # → 写回 ~/.dsh/pet-voice/xiaoai-url.txt（?k= 用已有 urlSecret，chmod 600）
scripts/tunnel.sh --stop           # 停掉本脚本上次起的隧道（读 tunnel.pid）
```

- cloudflared 找不到时依次回退：`PATH` → `~/.dsh/profiles/desktop/node_modules/cloudflared/bin/cloudflared` → `npx --yes cloudflared`；
- 隧道进程 `nohup` 到 `~/.dsh/pet-voice/tunnel.log`，脚本**只打印 PID 与日志路径**就退出（不会把隧道挂在前台）；
- `?k=` 只写进文件，任何输出里都不出现；公网地址（不含令牌）会打印，可以截图；
- 写完后的 30 s 内 `/api/pair` 会读到新域名（探活结果有缓存，30 s 后自动刷新）。

## 旁听（面板「人设 → 旁听」）

手机上钉的是宠物会话，人却常想知道「另一边开发到哪了」。插件只读，不往别的会话里发话：

- 三档：问进展时（默认）/ 每一句 / 关。默认只在「最近进展怎么样」「做到哪一步」这类问句时
  才看一眼，普通聊天不花这份钱。
- 看谁：同一项目里最近活跃的另一只（排除绑定那只）；同项目只有它自己时，退一步看 `cwd` 的
  git 现状。
- 材料只写进这只会话的隐藏提示词：模型看得见，手机气泡和会话记录里只有你自己的话。
- 手机会话页标题下会出现一行「在旁听：<标题>」，5 分钟后自动收起。

## 语音来源（面板「人设 → 语音来源」）

| 选项 | 谁在出声 | 需要什么 | 说明 |
|---|---|---|---|
| 微软在线（默认） | 本机 `edge-tts` 子进程 | 跑过一次 `tts/setup.sh` | 免 key，联网；音色 / 语速 / 音高档位都按 `TTS_PRESETS` 来 |
| 这台电脑 | macOS `say` + `ffmpeg` | 系统自带，断网也行 | 音色下拉列的是本机真装了的 zh_CN 声音；默认按 Tingting → Meijia → Sinji 顺序挑 |
| 自己的接口 | 你填的 HTTP 地址 | 地址从本机可达 | POST JSON `{text, voice, speed}`，回音频字节 / `{audio: base64}` / `{url}` 三种都认 |

三档共用同一条 `/pet-voice/api/tts`，手机端拿到的永远是 `audio/mpeg`，所以 App 不用改。

> 本机合成有个坑：macOS 的音色清单里会列一些没下载的新声音（Eddy / Flo 这类），
> 用它们念中文出来是 0.1 秒静音。所以合成结果小于 8 KB 就当“没出声”，自动换默认音色重来一次；
> 还是不行就报「这台电脑的「X」发不出声」，不会让手机播一段空白。

> 剪映（JianYingPro）里的音色没有接：它的声音全部走自家云接口 + 私有 `libspeechsdk`，
> 本地没有可调用的端口或 CLI，token 还是每次安装生成的一份 `tts_local_auth_code`。
> 想用那几把嗓子，现实做法是自己搭一个 TTS 服务（GPT-SoVITS / CosyVoice / 火山引擎等），
> 把地址填进「自己的接口」——插件这边只约定 `POST {text, voice, speed}` → 音频。

## 音色档位（形象 = 声音）

页面「设置 → 音色」是 4 个档位，每档 = 一个真实 zh-CN 女声 + 语速 + 音高，
选中写 `localStorage['pv.ttsPreset']`（同时把音色写 `pv.ttsVoice`），刷新后保持：

| id | 音色 | rate | pitch | 听感 |
| --- | --- | --- | --- | --- |
| `whale`（默认） | `zh-CN-XiaoyiNeural` | `+6%` | `+8Hz` | 清亮少女，贴像素蓝发鲸鱼娘 |
| `genki` | `zh-CN-XiaoyiNeural` | `+16%` | `+22Hz` | 元气，语速快调门高 |
| `gentle` | `zh-CN-XiaoxiaoNeural` | `-4%` | `-4Hz` | 温柔，慢一点低一点 |
| `cool` | `zh-CN-XiaoxiaoNeural` | `-10%` | `-12Hz` | 清冷，更慢更低 |

> 2026-10-24 用 `edge_tts.list_voices()` 核过：edge-tts 里的 zh-CN **女声**只有
> Xiaoxiao(Warm) / Xiaoyi(Lively) / Xiaobei(Humorous) / Xiaoni(Bright) 四个（其余 zh-CN 是男声），
> 所以四档是「两只音色 × 四种韵律」，不是八个音色。要换嗓子只改 `TTS_PRESETS`，
> 前端下拉、试听、`/api/say` 播放全部同源。

「试听这句」固定念「我是鲸灵，今天想让我帮你做点什么？」，试听会清掉未播完的排队句。

**验证 pitch/rate 真的透传**（同句、不同档位，音频字节必然不同）：

```bash
# 用任意 URL 编码工具把试听句编码后填到 text=
curl -s -H "Cookie: pkv_<前8位>=<token>" \
  'http://127.0.0.1:<port>/pet-voice/api/tts?text=<编码后的试听句>&preset=genki' -o /tmp/genki.mp3
# 直接看子进程收到的参数（stderr 会打 [tts] voice=... rate=+16% pitch=+22Hz chunks=.. bytes=..）
~/.dsh/pet-voice/tts-venv/bin/python \
  ~/.dsh/plugins/dsh-pet-voice/tts/stream.py zh-CN-XiaoyiNeural 你好 +16% +22Hz >/dev/null
```

`/api/say` 入队的那条**也走当前档位**：服务端只记 `voice`（可空），页面播放时以本地档位为准
（换档位不必重新喊一次，刷新页面即按新档位念）。

## 加到主屏 / Siri 唤醒

手机页面 dock 上的「加主屏」打开引导卡（**不提供二维码**，只显示地址），3 步：Safari 分享 → 添加到主屏；快捷指令新建「打开 URL」贴页面地址；
捷径改名「打开鲸灵」→「嘿 Siri，打开鲸灵」。卡里显示的地址来自 `GET /pet-voice/api/pair`，按可信度分三档并如实标注：

- `tunnel`：`~/.dsh/pet-voice/xiaoai-url.txt` 的公网地址（小爱隧道落地时写入），显示「✅ 公网隧道地址：手机流量也能直接打开」；
- `lan`：没有隧道时用本机非回环 IPv4 + 宿主端口，显示「⚠️ 同一个 WiFi 能打开，出门打不开」；
- `local`：只剩 127.0.0.1，显示「⚠️ 本机地址：手机打不开，先在电脑上起云隧道」。

`tunnel` 档会探活：通 → 绿色 ✅；不通 → 黄色 ⚠️ +「隧道域名可能已过期（cloudflared 重启会换域名）」，
但**地址仍然是隧道域名**（不降级成私网地址）。换域名走 `scripts/tunnel.sh`（见下）。

地址本身**不含令牌**（`?k=` 在一次 303 跳转后已从 URL 消失），配对靠「复制配对链接」粘贴或首次手输令牌。
二维码图已于 2026-10-24 删除：`/pet-voice/assets/*` 是不鉴权静态路由，而那张图编的是带令牌的完整配对链接 ——
任何能碰到隧道域名的人都能白拿一份令牌。要恢复扫码，必须改成只编地址、令牌手输。
卡默认收起，展开后在 390×844 上内部滚动，不挤压对话区。

## 语音播报（外部喊手机说话）

`POST /pet-voice/api/say` 是给喇叭 / 手表 / MCP 用的：「让手机念这句」。服务端只入队
（内存环形队列，20 条）并广播 `event: say`；页面收到就用**现有神经语音管线**念出来，
正在念的那句不打断，新的一句排队尾。隧道环境收不到 SSE 时，页面每 1.5 秒
`GET /api/say?since=<cursor>` 补拉。页面启动时先用 `since=-1` 对齐游标，所以刷新
不会把历史播报重播一遍。

```bash
curl -s -X POST -H "Cookie: pkv_<前8位>=<token>" -H 'content-type: application/json' \
  -d '{"text":"我是鲸灵，播报测试"}' http://127.0.0.1:<port>/pet-voice/api/say
# {"ok":true,"seq":1,"queued":1}
curl -s -H "Cookie: pkv_<前8位>=<token>" 'http://127.0.0.1:<port>/pet-voice/api/say?since=0'
# {"ok":true,"items":[{"seq":1,"text":"我是鲸灵，播报测试","voice":"zh-CN-XiaoyiNeural","at":"..."}],"cursor":1}
```

### 推送为什么有两套

- **SSE**：本机 / 直连 https 用。服务端先补 2KB 注释padding 再 `event: hello`，避免
  中间层憋着不吐头；页面收到 `hello` 就算「这条连接真在推」。
- **长轮询**：cloudflared 之类**缓冲整段 SSE** 的隧道用（实测 quic/http2 都一样：
  响应头 200 立刻到、body 一个字节都不来）。页面 4 秒内既没有 `hello` 也没有任何帧，
  才切成 `poll` 并提示一句；能推的环境不会走到这条分支。
- 服务端给每个会话留最近 **400 帧**（内存，最多 40 个会话），所以长轮询断线重连
  不丢帧；但**不会**在接上会话时把历史当新消息重播（见 `cursor=-1`）。

---

## 已离线验证（不需要装 DSH）

```bash
HOME=/tmp/pvtest node plugins/dsh-pet-voice/selftest.mjs
# selftest: 131/131 通过
```

假 `ctx` + 真 http server，覆盖：token 门禁（401 / `?k=` 303 + `HttpOnly` cookie）、
静态资源类型与路径穿越、`state` 结构（**不含明文 token**、`tokenHint` 是前 8 位）、
`/api/link` 的 401 与正确链接、`poll` 的 401 / 回放 / `cursor=-1` 对齐、
`new` 的复用与 `fresh`、`dispatch` 的 `prompt` 契约（`mode:'queue'`、
`content[0].type==='text'`、`requestId`、时区）、空文本 400、`cancel` 转发、
SSE 三种帧（`delta` / `end` / `final`）与**会话串台**、`selfcheck`，
以及**派发落点**（不带 `sessionId` → `pet-session.json` 那只，且 ≠ `state.current`
/ `remembered`；显式不存在 → 404）、`/api/say` 的 401 / 入队 / 游标 / 300 字截断 /
幂等 id / 队列 cap 20、神经语音的 401 / 空文本 / 超长 / 未知音色 / 缺 venv 提示。

真机整链路（会真的跑一次模型调用，会计费）：

```bash
# 本机
node plugins/dsh-pet-voice/e2e.mjs
# 走隧道（验证长轮询兜底）
BASE=https://xxx-xxx.trycloudflare.com node plugins/dsh-pet-voice/e2e.mjs
```

`e2e.mjs` 会打印 `SUMMARY {transport, frames, deltas, firstDeltaMs, final}`，
失败时退出码 1。可用环境变量：`BASE`、`PV_TOKEN`、`PV_PROJECT`、`PV_TEXT`、
`PV_TIMEOUT`；`--transport=sse|poll|auto` 强制传输方式。

页面视觉：Chrome headless 在 390×844（DPR 2）下截图核对（一屏放得下、对话气泡
不遮输入区、麦克风是内联 SVG、能推的环境不出现「已切到长轮询」）。

## 还没验证的 / 已知限制

1. **iOS Safari 没有 Web Speech 识别**：页面会明确提示「这个浏览器不支持语音识别」，
   只能用输入框打字；要真机语音得加服务端 STT（SenseVoice 之类）。
2. iOS 每次会话要重新授权麦克风；TTS 需要先有一次用户手势解锁（页面已预热一次）。
3. `sessionController.create(request)` 的真实入参名（`workspaceId` / `cwd` /
   `agentPreset`）——目前按最合理形状发，失败时 `selfcheck` 会带出真实报错。
4. `sessions` 的返回行结构（只做了多路兜底：`sessionId` / `id` / `session.id`）。
5. 长轮询在隧道上的首字延迟明显高于 SSE（隧道每轮一次请求），功能性一致。
6. 会话正被别的客户端占用时，派发的消息会在宿主侧排队，页面看着「没反应」——
   等它排到就好；用 `⚙ → 开新会话` 可以立刻拿一只干净会话。

## 排查

| 现象 | 查什么 |
| --- | --- |
| 打开是 token 输入页 | 正常，粘 `~/.dsh/pet-voice/token`；或直接用 `?k=` 链接 |
| 「连不上 DSH 宿主」 | 插件没装/没重启；`/pet-voice/api/selfcheck` 看哪一步失败 |
| 能打字、按麦没反应 | 页面不是 https；或浏览器没给麦克风权限；面板提示会写明 |
| 有文字没声音 | 手机静音开关 / 「朗读」被关；iOS 需要先点一下页面解锁音频 |
| 派发了没回应 | 点「宿主自检」；`?prompt=` 模式能跑通说明到模型这层是好的；`~/.dsh/pet-voice/logs/turn.log` 看这一轮是不是被 404/503/超时挡了 |
| 识别出来是乱码、听不懂 | `~/.dsh/pet-voice/asr/transcripts.log` 最后一行是不是这一句；`GET /pet-voice/api/asr` 看 `model` 是不是 `large-v3-turbo`（改成 base 会明显变差） |
| 助手把自己说的话当成我说的 | 宿主已按「最近播报过的句子」吞掉（`asr.log` 里 `echo=`），还出现就是 App 侧在播报期间抢了麦克风，属已知遗留 |
| 提示「已切到长轮询」 | 说明当前隧道把 SSE 缓冲了，属于预期兜底；同一提示只出现一次 |

## 卸载

```bash
# 在 DSH 里
plugin_manager action=remove_bundle target=dsh-pet-voice
```

token / 项目记忆留在 `~/.dsh/pet-voice/`，要清就 `rm -rf ~/.dsh/pet-voice`。
