# 目标验收对照（鲸灵 · 手机端 MVP）

> 口径：每条都带证据等级和日期。**能一键复现的都给命令**，全部从仓库根跑。
> 等级：【实测】= 本机跑过、有输出/截图/日志；【厂商口径】= 官方文档说的；【未核实】= 没跑过。

## 1. 目标条款 → 证据

| 目标条款 | 证据 | 复现 | 等级 |
| --- | --- | --- | --- |
| 手机打开 DSH Web GUI | 0.2.1 首页「打开 DSH Web GUI」把 `…/pet-voice/` 退回站点根交给系统浏览器；模拟器无浏览器时降级复制地址（截图 + toast） | `adb install -r dist/jingling-0.2.1.apk`，点该行；细节 [android-app.md](android-app.md) §18 | 【实测】模拟器；真机跳转【未核实】 |
| 经 Cloudflare 隧道连回本机 | 命名隧道脚本读 `cloudflared.token/.host`（0600），token 只进子进程环境变量；`--check` 深校验三组（好 token→0、trycloudflare 主机→1、截断→1） | `bash scripts/tunnel.sh --check --named` | 【实测】脚本层；**线上隧道【未核实】**（缺域名/token，cloudflared 未安装） |
| 经自己的服务器转发（面板配置） | 面板「经自己的服务器转发」填账号、公网地址、私钥，点「连接」→ 插件进程内起本机 HTTPS 反代 + `ssh -R 0.0.0.0:公网端口:127.0.0.1:本机端口`；插件重载后自动重连；配置只写本机 `~/.dsh/pet-voice/public.json`（0600） | 公网访问 `https://<你的服务器>:8443/pet-voice/` 应 401，带 `?k=` 应 303 + `Set-Cookie`；面板状态见 `GET /pet-voice/panel/public` | 【实测】2026-10-25 模拟器经公网隧道发出并收到回复；断网/重载自愈【未核实】 |
| 语音唤醒「鲸灵」 | 常驻 `SpeechRecognizer`，`ERROR_NO_MATCH`/`SPEECH_TIMEOUT` 自动重启；唤醒词可改 | 真机说「鲸灵」 | 【未核实】模拟器 ASR 恒 no-match，无法测 |
| 按住说话 / 语音对话（复用会话人设与工具） | `beginTurn` → `/api/command` 分流 → `/api/dispatch` 落专属会话；失败静默回退，不重复派发 | `bash scripts/verify-commands.sh` | 【实测】13/13 |
| 语音播报（TTS） | `/api/tts` + 客户端磁盘缓存 60 条 + 宿主 LRU 48 条 | 见 [android-app.md](android-app.md) 延迟表 | 【实测】缓存命中 0.6 ms / 磁盘 0 ms / 新句 1.9–2.0 s |
| 像素风鲸鱼娘形象 | 13 段 VP9-alpha 420×465 10 fps，共 2,427,042 B；悬浮窗只画形象（无卡片/按钮/文字）；0.9.23 起 App 在前台时收起、不吃点击 | `bash scripts/android-smoke.sh`（18/18，含桌面可见 / 前台收起两态断言） | 【实测】模拟器渲染；真机硬件解码【未核实】 |
| 语音指令：切项目/派发/基础操作 | 5 条 utterance 的 `action` 断言 + 无二次 dispatch | `bash scripts/verify-commands.sh` | 【实测】13/13 |
| MCP 服务端暴露同样能力 | stdio MCP，`ping`/`pet_status`/`pet_ask`/`pet_say` 等；live 模式真打宿主 | `PET_LIVE=1 PET_BASE=http://127.0.0.1:52356 node mcp/pet-bridge/selftest.mjs` | 【实测】18/18 |
| 不买域名也能 https（0 元路线） | 自签 CA + 根证书打进 App（`res/raw/pet_ca.pem` + `network_security_config`）+ 本地 https 反代；模拟器上 https 链路下语音指令全过 | `bash scripts/tls-ca.sh --check`；`PET_HOST=https://10.0.2.2:8443/pet-voice/ bash scripts/verify-commands.sh` | 【实测】模拟器 13/13；真机 + 腾讯云线上【未核实】，见 [tls-self-signed.md](tls-self-signed.md) |
| 文档 + 可复现验证 | 本文 + [real-device-install.md](real-device-install.md) + [android-app.md](android-app.md) + [pet-contract.md](pet-contract.md) + [cloudflare-tunnel-token.md](cloudflare-tunnel-token.md) | 见 §3 | 【实测】 |

## 2. 一次跑完全部离线验收

```bash
SKIP_LIVE=1 bash scripts/verify.sh            # 12/12：构建、插件语法、契约、自测
node scripts/contract-check.mjs               # 25/25：接口契约 + 401 鉴权
node scripts/cf-tunnel-token.test.mjs         # 30/30：token 落盘脚本（假 token、临时 HOME）
node scripts/cf-creds.test.mjs                # 29/29：Cloudflare 凭据解析
node mcp/pet-bridge/selftest.mjs              # 17/18（1 项 live 跳过）
bash scripts/android-smoke.sh                 # 18/18：装包→注入配置→真发一条→悬浮窗两态（桌面在 / App 前台收起）
bash scripts/verify-commands.sh               # 13/13：手机侧语音指令（需 adb + 模拟器/真机）
bash scripts/tls-ca.sh --check                # 自签证书：链/SAN/权限/App 内置一致（没生成过会提示，不失败）
```

`verify.sh` 会先 `assembleRelease`（`--offline`，需要 `JAVA_HOME=~/jdk17/Contents/Home` 与 aapt2 覆盖参数，脚本里已封好）。

## 3. 还差的两件事（都在你手上）

0. **0 元路线已经跑通**：不想买域名就 `bash scripts/tls-ca.sh --ip 你的IP` + `node scripts/tls-proxy.mjs`，
   手机填 `https://你的IP:8443/pet-voice/`，装 `dist/jingling-0.2.2.apk`。细节 [tls-self-signed.md](tls-self-signed.md)。
1. **或者一个主机名**：`pet.你的域名` → `node scripts/cf-tunnel-token.mjs --clipboard --host pet.你的域名`，
   再 `bash scripts/tunnel.sh --check --named && bash scripts/tunnel.sh --named`。
   我只需要 `--check` 的打码输出，**不要贴 token**。
2. **真机装一次**（`dist/jingling-0.2.2.apk`）：确认唤醒灵敏度、按住说话的松手延迟、悬浮窗掉帧/发热。
   这三项我现在只有模拟器证据，所以本文标【未核实】，不会写成「已真机验证」。

## 4. 踩过的坑（都写进脚本/文档了）

- `adb shell am broadcast --es text '切到 Pet'` 会在设备端二次分词 → 断言假阴性；整条命令加引号。
- MCP 的 `PET_BASE` **只写服务根**（`http://127.0.0.1:52356`），带 `/pet-voice` 会 404 → 15/18 假失败。
- debug 包和 release 包签名不同：`install -r` 会静默保留旧包 → 先 `adb uninstall com.whale.pet`。
- 没装 `cloudflared` 时 `tunnel.sh` 会在依赖检查就退出（`brew install cloudflared`）。
- `/pet-voice/assets/*` 不鉴权 ⇒ 静态资源里永不出现令牌；带令牌的二维码已删除。
