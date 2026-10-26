# 手机安装与接线（鲸灵 0.9.7）

> 本文只写「把 APK 装到真机、让手机安全地连回这台 Mac」这一件事。
> 功能清单见 [`docs/android-app.md`](android-app.md)，插件接口见 [`docs/pet-contract.md`](pet-contract.md)。

## 1. 产物

| 项 | 值 |
| --- | --- |
| 安装包 | `dist/jingling-0.9.7.apk`（= `android/app/build/outputs/apk/release/app-release.apk`） |
| 大小 | 29,936,778 B |
| SHA-256 | `3503a903752c028e4261ac1f3793971ea8a63c80b0a9f2e4de5ceff3df7a88dd` |
| 版本 | `versionCode=77`，`versionName=0.9.7`，applicationId `com.whale.pet` |
| 签名 | 自签名（CN=Jingling Pet，证书 SHA-256 `8a2cc532abadd8f0e63bdfe02ade2f528de2fd9b2d02231f192cd698197127ef`），release 构建、未开混淆 |
| 最低系统 | Android 8.0（API 26），targetSdk 35 |

> 0.2.1 相对 0.2.0 只多一个入口：首页「**打开 DSH Web GUI**」——把已配的 `…/pet-voice/` 地址退回站点根
> （remote-web-ui 的 `/`）交给系统浏览器；鲸灵是悬浮窗，开着 GUI 也照样浮在上面。
> 模拟器上没有浏览器时退化为「复制 GUI 地址」，已用截图验证。
> 回滚包仍在：`dist/jingling-0.2.0.apk`（3,388,437 B）。

> 0.2.2 相对 0.2.1：内置一张**本地自签 CA**（`res/raw/pet_ca.pem` + `network_security_config`），
> 目的是「不买域名也能用真 https」——手机连 `https://<你的IP>:8443` 直接认。
> 别的 https 站点照旧走系统 CA，行为不变。详见 [tls-self-signed.md](tls-self-signed.md)。

**签名密钥只此一份**：`android/keystore/pet-release.jks` + `android/keystore.properties`（已 gitignore，别提交、别丢）。
丢了这两个文件就无法再出「能覆盖安装」的新版本，只能卸载重装。

校验（可选）：

```bash
shasum -a 256 dist/jingling-0.9.7.apk   # 应等于上表
```

## 2. 装到手机

**方式 A · 数据线（推荐）**

```bash
adb install dist/jingling-0.9.7.apk
adb shell am start -n com.whale.pet/.MainActivity
```

**方式 B · 传文件**：把 APK 拷到手机存储 → 文件管理器点开 → 允许「安装未知来源应用」→ 安装。

装完不要急着开悬浮窗，先按第 3 节给权限、第 4 节接线。

## 3. 必须给的权限（不给就会出现「点了没反应」）

App 首页 →「更多」→「去授权」，弹四项，点哪项就跳到**这台手机自己的系统页**（不认品牌的固定路径，先探测再跳，跳不到才落应用详情页）：

| 权限 | 点哪项 | 不给会怎样 |
| --- | --- | --- |
| 悬浮窗（显示在其他应用上层） | 悬浮窗权限 | 鲸鱼娘出不来，只留通知 |
| 电池无限制 | 电池不受限 | 息屏几分钟后服务被杀，叫不醒 |
| 自启动 / 后台弹出界面 | 自启动 | 重启手机后叫不醒；小米上还会拦「后台弹出界面」 |
| 通知 | 通知 | 前台服务没有常驻通知，系统更容易杀 |

- 麦克风不在这四项里：首次开悬浮窗说话时弹系统窗，选「始终允许」；拒绝后不再反复弹。
- 通知权限 Android 13 起是运行时权限，App 会自己弹一次，拒绝也不影响前台服务运行。
- 各家跳转落点：小米/红米 → 安全中心自启动（含「后台弹出界面」）、华为/荣耀 → 应用启动管理、
  OPPO/iQOO/vivo → 自启动管理、三星 → 电池后台用量、其他按 AOSP → 应用详情页。
- 各项都点过之后，用「诊断」看状态行：悬浮窗、麦克风、省电策略、通知逐项列是否已授权。

## 4. 接线：让手机连回这台 Mac

宿主进程只监听 `127.0.0.1:52356`（这是有意的：不往局域网暴露端口）。所以手机要连回来，二选一：

### 4.1 USB 调试直连（临时、最省事）

```bash
adb reverse tcp:52356 tcp:52356
```

App 里宿主地址填 `http://127.0.0.1:52356/pet-voice/`（`127.0.0.1` 在明文 http 白名单里，允许）。
优点：不经公网、零配置；缺点：拔线就断，只适合调机。

### 4.2 自己的域名 + Cloudflare 命名隧道（日常用这个）

安全上也是更好的选择：不开放任何入站端口，cloudflared 主动连出去，链路全程 HTTPS。

一次性准备（需要联网）：

```bash
brew install cloudflared
```

然后在 Cloudflare Zero Trust 控制台：

1. **Networks → Tunnels → Create a tunnel**，类型选 `cloudflared`，起个名（例如 `whale-pet`）
2. 把安装页给你的那一行**整行复制**（`sudo cloudflared service install eyJhIjoi…` 或 `cloudflared tunnel run --token eyJhIjoi…`，
   两行里的 token 是同一个），交给脚本识别、校验、落盘——**不要贴进对话，也不用自己 printf**：

   ```bash
   node scripts/cf-tunnel-token.mjs --clipboard --host pet.example.com   # 粘完 Ctrl-D
   node scripts/cf-tunnel-token.mjs --check                              # 验形状/权限/主机名
   ```

   脚本会：认出 token → base64 解出 `{a,t,s}` 校验 → 写 `~/.dsh/pet-voice/cloudflared.token`（600）和
   `cloudflared.host`（600）；复制少了字符会直接拒写、不留半截文件。细节见
   [Tunnel token 从哪拿、怎么存](cloudflare-tunnel-token.md)。
   坚持手写也行：`printf '%s' '<token>' > ~/.dsh/pet-voice/cloudflared.token && chmod 600 …`。

3. 该 tunnel 里加 **Public Hostname**：
   - Subdomain / Domain：例如 `pet` + `example.com`
   - Service：`http://127.0.0.1:52356`
4. 主机名在第 2 步已经一起写进 `cloudflared.host` 了；单独改就
   `printf '%s' 'pet.example.com' > ~/.dsh/pet-voice/cloudflared.host`。

5. 起隧道（脚本自己 nohup，前台不常驻）：

   ```bash
   scripts/tunnel.sh --named     # 起
   scripts/tunnel.sh --stop      # 停
   ```

6. 手机 App 首页：
   - 宿主地址 `https://pet.example.com/pet-voice/`
   - 访问令牌：在 Mac 上打开 `http://127.0.0.1:52356/pet-voice/`，点「复制配对链接」，把链接粘到 App 的「粘贴配对内容」；或在 App 里直接粘令牌
   - 点「测试连接」→ 点「保存」→ 点「开悬浮窗」

**进阶加固（可选）**：在 Cloudflare Zero Trust 里给这个主机名挂一条 **Access** 策略（邮箱 OTP 或 Service Token）。挂上之后，光有令牌也进不来，还要过 Cloudflare 那道门；代价是 App 走 WebView/接口时需要带 Access 凭据，目前 App 还没做这层，先别开——开了会连不上。

## 5. 链路安全现状（口径：2026-10-24）

已经做到的：

- **公网明文 http 直接拒绝**：`PetSettings.plaintextHostAllowed()` 只放行本机 / 模拟器宿主 / 局域网段（`192.168.*`、`10.*`、`172.16–31.*`、`*.local|.lan|.home`），其余必须 `https://`，否则保存时就提示「地址无效：公网必须 https://」。
- **令牌不出设备**：只存 App 私有 `SharedPreferences`（`MODE_PRIVATE`），UI 只显示掩码，日志不打；Swift/Kotlin 侧不拼进 URL 查询串，走 Cookie 请求头。
- **静态资源不放秘密**：早期那张 `qr-pairing.png` 里编了带令牌的完整配对链接，而 `/pet-voice/assets/*` 是不鉴权路由 —— 已于 0.2.0 删掉，页面不再引用（任何能碰到域名的人本来都能白拿一份令牌）。
- **语音合成响应不进共享缓存**：`/api/tts` 返回 `cache-control: private, max-age=86400`，因为 URL 里带原文，不能被 CDN / 代理留存。
- **服务端合成缓存**只在宿主进程内存里（48 条 / 16 MB），不落盘。

还没做到、要知道的：

- 令牌存的是明文 SharedPreferences（离线 Gradle 缓存里没有 `androidx.security-crypto`，暂时上不了 EncryptedSharedPreferences）⇒ 手机被 root 或拿到 adb 备份才可能读到，普通丢失风险低；建议定期在 GUI 页「轮换令牌」。
- 没有做 Cloudflare Access 的双因子接入（见上面「进阶加固」）。
- 没有证书固定（pinning）：走 Cloudflare 的证书链，靠系统信任库。
- `assets` 路由本来就不鉴权 —— **别往 `plugins/dsh-pet-voice/public/` 放任何带令牌、隐私文本的文件**。

## 6. 还没验证的部分（别当成已通过）

- 【未核实】真机（HyperOS 4 / Android 15）上的悬浮窗、硬件视频解码、息屏唤醒、省电策略；目前所有证据来自模拟器 `emulator-5556`（API 30）。
- 【未核实】真机 CPU 占用与耗电（模拟器量的是 `18.2 %` 单核，真机通常更低但要实测）。
- 【未核实】真麦克风下的唤醒词识别率（模拟器 ASR 恒为 no-match，只能用调试广播注入）。
- 命名隧道端到端尚未跑通：本机没装 `cloudflared`，也没有你的域名 / tunnel token。

装好后把这两样发我，我逐个调：

```bash
adb logcat -s PetLatency:I PetService:I AndroidRuntime:E > /tmp/jingling.log
```

## 装好之后：以后怎么更新（0.3.0 起）

- `更多 → 检查更新` 手动查；App 每 6 小时也会自己查一次（`last_update_check`）。
- 查到新版点「下载并安装」：下载到 `cacheDir/update/`、校验 sha256、再用 `PackageInstaller`
  覆盖安装。**同包名 + 同签名**，所以 `pet_prefs`（地址 / token / 唤醒词 / 尺寸）和系统权限都保留，
  不用重新扫码配对。装完悬浮窗会自动回来。
- 更新通道就是插件本身：`GET /pet-voice/api/update` + `GET /pet-voice/download/<file>.apk`
  （要 cookie），发布用 `node scripts/publish-apk.mjs`，细节见 `plugins/dsh-pet-voice/README.md`。
- 想彻底停：`更多 → 关闭全部服务`（停唤醒 / 录音 / TTS / 播放，取消自启动，移除悬浮窗，退出前台服务）。
  下次从桌面图标打开即可重新开启。

## 被「平板管家」拦下时怎么装（root 设备）

小米/红米平板（HyperOS）把安装器换成了平板管家，`adb install` 经常直接返回
`Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]`——即使开发者选项里
「USB 安装」「USB 调试（安全设置）」都开了。设备 root 过（Magisk 的 `su` 能用）时不用折腾
安全中心，绕开安装界面即可：

```bash
bash scripts/install-device.sh dist/jingling-0.9.36.apk 15ca9736
```

脚本先试普通 `adb install`；被拦下就 `adb push` 到 `/data/local/tmp/`，再用
`su -c pm install -r -t` 由 PackageManager 直接装（不弹安装界面，管家拦不到）。
顺手把 `verifier_verify_adb_installs` / `package_verifier_enable` 关掉，后续 adb 安装也顺一点。
**这是本机调试口子，不是给最终用户的路**——普通用户仍走 App 内「检查更新」。

平板连着线做真机调试时记得别让它睡：

```bash
adb -s <序列号> shell svc power stayon true
```
