# 不买域名也能 https：自签 CA 打进 App

> 适用：手机要连自己机器（局域网 IP，或自己服务器的转发端口），但不想买域名 / 不想备案。
> 版本：鲸灵 **0.2.2** 起内置这张 CA。证据日期 2026-10-24，等级标注见每节。
> 首选路径：DSH 面板「经自己的服务器转发」，见 §9。

## 1. 为什么必须 https

Android 上「明文 http」只对 loopback（`127.0.0.1` / `localhost`）放行；填 `http://192.168.x.x:8443` 会被 App 的
`openGui()`/网络层按设计拦掉。而公网 IP 拿不到受信任证书（Let's Encrypt 等都不给裸 IP 签）。

所以办法只有两条：**买域名**，或者**自己当 CA 并把根证书打包进 App**。后者 0 元，本文就是它。

## 2. 三步走

```bash
# ① 生成 CA + 叶证书（IP 换成你服务器的那一个；只有局域网就用本机内网 IP）
bash scripts/tls-ca.sh --ip <你的服务器公网IP>
#   可选：再加域名 SAN  bash scripts/tls-ca.sh --ip <你的服务器公网IP> --dns pet.home.arpa
#   它同时会把根证书拷进 App：android/app/src/main/res/raw/pet_ca.pem（公开证书，不是私钥）

# ② 本机 https 反代：https://127.0.0.1:8443/pet-voice/* → DSH Web（端口自动探）
#    走面板的「经自己的服务器转发」时这段插件自己起，不用手跑；下面是命令行替代用。
#    上游不写死：先试 --upstream，再读 DSH_WEB_URL，最后把 dsh web 实际在听的端口挨个试一遍。
node scripts/tls-proxy.mjs            # 前台跑；只在「局域网直连」时才加 --bind 0.0.0.0

# ③ 重新出包（App 内置 CA）并装到手机
JAVA_HOME=~/jdk17/Contents/Home ~/.gradle/wrapper/dists/gradle-8.13-bin/*/gradle-8.13/bin/gradle \
  -p android :app:assembleRelease --offline \
  -Pandroid.aapt2FromMavenOverride=/opt/homebrew/share/android-commandlinetools/build-tools/35.0.0/aapt2
adb install -r dist/jingling-0.2.2.apk
```

手机里填的地址：`https://<你的服务器>:8443/pet-voice/`（局域网直连就填本机局域网 IP）。**换了 CA 就必须重新出包装机**，只换叶证书（`--renew-leaf`）不用。

## 3. 经自己的服务器转发（两种拓扑）

**拓扑 A：TLS 在本机终止（推荐，最少配置，证书不出本机）**

面板里点「连接」就是这条：本机 https 反代 + `ssh -R`，两段一起起停（§9）。手写的话等价于：

```bash
# 本机：起 https 反代（只监听本机），再把服务器端口牵回来
node scripts/tls-proxy.mjs --quiet &
ssh -N -R 0.0.0.0:8443:127.0.0.1:8443 \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    账号@<你的服务器>
```

你的服务器要满足两件事（缺一，手机连不上）：

```bash
# ① sshd 允许客户端指定绑定地址（否则 -R 0.0.0.0:8443 会被悄悄改成只听 127.0.0.1）
echo "GatewayPorts clientspecified" | sudo tee /etc/ssh/sshd_config.d/99-pet-gatewayports.conf
sudo sshd -t && sudo systemctl reload ssh

# ② 云安全组/防火墙放行你选的那个公网端口（下面按 8443 举例；源地址填手机出口 IP 最稳）
```

不装 Caddy、不装 nginx。

> **「443 开不了 / 要备案」的真相**：外网连不上高端口，先看**安全组/防火墙有没有放行**，这多半不是备案拦截
>（备案拦截会先建连再返回一个拦截页，TCP 是通的）。「裸 IP + 高端口」不涉及备案，加一条端口规则即可。

**拓扑 B：Caddy 在你的服务器上终止 TLS**（想把证书和进程都放服务器时）

```caddyfile
:8443 {
    tls /etc/caddy/pet-leaf.pem /etc/caddy/pet-leaf.key.pem
    reverse_proxy 127.0.0.1:52356
}
```

```bash
# 本机只转发明文口到服务器本机
ssh -N -R 127.0.0.1:52356:127.0.0.1:52356 账号@<你的服务器>
# 证书从本机拷过去（两张都要，一次 0600）
scp ~/.dsh/pet-voice/tls/pet-leaf.pem ~/.dsh/pet-voice/tls/pet-leaf.key.pem 账号@<你的服务器>:/etc/caddy/
```

资源占用【估算】：sshd 转发本身 CPU 近 0、每个连接几 MB 内存；带宽只算真实流量（一句话几 KB，一条 TTS 语音约 20–40 KB）。

## 4. 续期

- 根证书 3650 天，叶证书 397 天（Android 对证书有效期敏感，别签太长）。
- 到期前跑 `bash scripts/tls-ca.sh --renew-leaf --ip <你的服务器公网IP>`：**复用 CA**，所以 App 不用重装，只要把新叶证书给代理/Caddy 用。
- `bash scripts/tls-ca.sh --check` 会验：私钥权限 600、链能验通、SAN 含 `127.0.0.1`/`10.0.2.2`/`::1`、剩余天数 >30、App 内置的 CA 与本地一致。

## 5. 验收证据

| 检查 | 结果 | 命令 | 等级 |
| --- | --- | --- | --- |
| 证书生成 + 自检 | 全部通过，叶证书 396 天后到期，CA 指纹 `F2:EE:4F:B5…83:D7` | `bash scripts/tls-ca.sh --ip 203.0.113.9`（示例 IP） | 【实测 2026-10-24】 |
| TLS 握手 + 上游连通 | `https://127.0.0.1:8443/pet-voice/api/state` → **200**，TLS 握手 **6.5 ms** | `curl --cacert ~/.dsh/pet-voice/tls/pet-ca.pem https://127.0.0.1:8443/pet-voice/api/state` | 【实测】 |
| 只放行 `/pet-voice/*` | `https://127.0.0.1:8443/api/state` → **404** | 同上换路径 | 【实测】 |
| **App 信任这张 CA** | 装 0.2.2 后把宿主地址换成 `https://10.0.2.2:8443/pet-voice/`：语音指令 **13 通过 / 0 失败**（分流 623 ms） | `PET_HOST=https://10.0.2.2:8443/pet-voice/ bash scripts/verify-commands.sh` | 【实测】模拟器 |
| SSH 反向隧道（本机 → 自己的服务器） | 服务器 `0.0.0.0:8443` 监听成功；服务器本机 `https://127.0.0.1:8443` → **401**（TLS 通、鉴权生效） | `bash scripts/tunnel-ssh.sh --daemon` | 【实测】 |
| 公网访问 8443 | 从外网探测**不通** → 安全组未放行 | `nc -z -G 4 <你的服务器> 8443` | 【实测】需你在控制台放行后才能到真机 |

> 上面成功的那个 `10.0.2.2` 是模拟器看宿主的固定地址；真机上换成你 `--ip` 生成时写的那一个。

## 6. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `curl` 报 `certificate verify failed` | 没用 `--cacert` 指到这张 CA | 加 `--cacert ~/.dsh/pet-voice/tls/pet-ca.pem` |
| App 报证书错误 / `SSLHandshakeException` | App 里内置的还是旧 CA | `bash scripts/tls-ca.sh --check` 看「App 内置的 CA 与本地根证书一致」，不一致就重新出包装机 |
| 手机连 `https://…:8443` 超时 | 端口没到本机 / 安全组没开 | `curl -v --cacert ~/.dsh/pet-voice/tls/pet-ca.pem https://<你的服务器>:8443/pet-voice/api/state` 从外网试；检查 `ssh -R` 与安全组 |
| 浏览器打开警告「不安全」 | 自签证书本来就不在系统信任列表 | 正常；只有鲸灵这个 App 认它 |
| 想换 IP（换了网络） | SAN 里没有新 IP | `bash scripts/tls-ca.sh --ip 新IP --renew-leaf`，重启代理即可（App 不用重装） |

## 7. 安全边界

- 根私钥只在本机 `~/.dsh/pet-voice/tls/`（目录 700、文件 600），**永不进仓库**；进仓库的只有公开的 `pet_ca.pem`。
- `scripts/tls-proxy.mjs` 不是通用代理：只转发 `/pet-voice/*`，默认只绑 `127.0.0.1`。
- 别把 CA 私钥拷到服务器上（拓扑 A 压根不需要）；真要拷，只拷叶证书 + 叶私钥。
- 这套方案的信任范围 = 装了**内置同一张 CA** 的 App 的手机；手机丢了就换 CA 重新出包。
- 别人要自建，不能直接沿用仓库这张 CA：用**自己的域名 + 真实证书**（Let's Encrypt 等，走系统信任链），
  或自己重编 APK 内置自己的 CA。自签 + 裸 IP 只对内置了这张 CA 的 APK 有效。

## 8. 端到端已验证：自有服务器 + 公网端口（2026-10-24）

用户在自己的服务器上放行 TCP 8443 后，整条链路在**公网**上跑通（不再是局域网/模拟器环回）：

| 检查 | 结果 | 证据 |
|---|---|---|
| 安全组放行前 | `TCP 8443` 不通，服务器 `ss` 里只有 `127.0.0.1:8443` | `nc -z` / `ss -ltnp` 【实测】 |
| 安全组放行后 | `nc` 通、`ss` 里 `0.0.0.0:8443` | 【实测】 |
| 用内置 CA 校验证书 | `GET /pet-voice/api/state` → **401**，TLS 握手 **48.8 ms** | `curl --cacert pet-ca.pem` 【实测】 |
| 不带 CA（模拟浏览器） | 直接失败，证书不受信 | 自签的预期行为 【实测】 |
| 带 Cookie `pkv_<前8位>=<token>` | `/api/state` → **200**；`/pet-voice/` → **200**，5642 字节 | 【实测】 |
| 模拟器全走公网地址 | `PET_HOST=https://<你的服务器>:8443/pet-voice/` 跑完 **13/13** 指令用例，分流 922 ms | `scripts/verify-commands.sh` 【实测】 |

结论：**裸 IP + 8443 + 自签 CA** 这条路在真实公网上成立（仅限内置这张 CA 的 App），不需要域名、不需要备案、不需要 443。

### 配对（不把 token 打进仓库）

```bash
# 生成一次性配对二维码（600 权限，local/ 已被 .gitignore 忽略）
# 内容就是 App「粘贴配对内容」认的 JSON：{"host":"https://<你的服务器>:8443/pet-voice/","token":"<48 位>"}
open local/pair-qr.png     # 手机 App → 扫码
```

- `local/pair.json`、`local/pair-qr.png` 都是**本机临时物**，绝不入库、绝不贴对话；
- token 在 `~/.dsh/pet-voice/token`（48 位），怀疑泄露就轮换 → 重启宿主 → 重新生成二维码；
- 隧道进程：`bash scripts/tunnel-ssh.sh --daemon` 起、`--stop` 停、`local/tunnel.log` 看日志；
  断线不会自动重连（没装 autossh），实测建议 `brew install autossh` 后脚本会自动用它。

## 9. 在面板里配置（推荐）

DSH 网页侧栏「大肥鱼 → 经自己的服务器转发」。拓扑 A 的两段（本机 https 反代 + `ssh -R`）由这张卡一起管，不用开终端。

### 先有证书

```bash
bash scripts/tls-ca.sh --ip <你的服务器公网IP>
# 有域名：bash scripts/tls-ca.sh --ip <你的服务器公网IP> --dns pet.example.com
```

证书在 `~/.dsh/pet-voice/tls/`；面板里没证书时会提示先跑这条。

### 你的服务器要满足两件事

1. sshd 允许客户端指定绑定地址（否则 `-R 0.0.0.0:` 会被悄悄改成只听 `127.0.0.1`）：

```bash
echo "GatewayPorts clientspecified" | sudo tee /etc/ssh/sshd_config.d/99-pet-gatewayports.conf
sudo sshd -t && sudo systemctl reload ssh
```

2. 云安全组/防火墙放行你选的那个公网端口（TCP）。源地址能限定就限定成手机出口 IP。

### 填三个字段，点「连接」

| 字段 | 填什么 |
|---|---|
| 账号 | `账号@服务器`；SSH 端口不是 22 时写 `账号@服务器:端口` |
| 公网地址 | `https://服务器:公网端口`，例如 `https://<你的服务器>:8443` |
| 私钥 | 本机 pem 路径，默认 `~/.ssh/id_ed25519` |

点「连接」后插件进程内起两段：本机 `127.0.0.1` 的 https 反代（只转发 `/pet-voice/*`），
以及 `ssh -R 0.0.0.0:<公网端口>:127.0.0.1:<本机端口>`。
状态行显示正在用的地址，ssh 的报错会被翻成一句能照做的提示（私钥不对、端口不许转发、连不上服务器）。
点「断开」两段一起停、服务器端口释放；配过之后插件重载会自动重连。

配置只落在这台电脑：`~/.dsh/pet-voice/public.json`（0600），不进仓库、不上传。
同一个仓库多人，各自配各自的服务器，互不继承。

连上后地址自动写进「连上手机 → 自建域名」，二维码变成带 `?k=` 的配对链接，手机扫码即可；裸 IP 也认。

### 命令行起停（替代方案）

面板是首选；不想开网页时用 `scripts/pv-public.sh`，起的是同样的两段。
配置用环境变量或 `~/.dsh/pet-voice/public.env`：

```bash
PV_SSH=账号@<你的服务器> \
PV_SSH_KEY=~/.ssh/id_ed25519 \
PV_REMOTE_PORT=8443 \
PV_PUBLIC=https://<你的服务器>:8443 \
  scripts/pv-public.sh start     # 起两段，已经在跑就跳过；结尾打印公网地址
scripts/pv-public.sh status      # 端口 / 两段进程 / 公网探测（401 = 通且鉴权生效）
scripts/pv-public.sh restart     # DSH 换了端口、或隧道断了之后跑这个
scripts/pv-public.sh stop
```

`PV_PUBLIC` 只给 `status` 的公网探测用。`tls-proxy` 只在**启动时**探一次 DSH 端口，
DSH 换端口后要 `restart`（不重启就还往旧端口转发，手机表现为连不上）。

### 验证

```bash
BASE=https://<你的服务器>:8443
curl -s -o /dev/null -w '%{http_code}\n' --cacert ~/.dsh/pet-voice/tls/pet-ca.pem "$BASE/pet-voice/api/state"   # 401
```

不带 `--cacert` 会报证书不受信：自签 CA 不在系统信任列表，只有内置这张 CA 的 App 认。

### 实测记录（2026-10-25 20:40 +0800，用户自己的服务器，ubuntu）

| 检查 | 结果 |
|---|---|
| `scripts/pv-public.sh status` | 8443 反代在跑、ssh -R 在跑、公网 HTTP **401** 【实测】 |
| 公网 `GET /pet-voice/api/state`（带内置 CA） | **401**，鉴权生效 【实测】 |
| 公网 `GET /pet-voice/?k=<token>` | **303**（下发 cookie 后跳转）【实测】 |
| App 设成 `https://<你的服务器>:8443/pet-voice/` | 首页 **已连接** 【实测】 |
| 对话页发一句 | 收到回复「主人，我在呢~ 有什么想让我帮你做的？」【实测】 |
| 公网 `GET /pet-voice/api/update?versionCode=92` | 返回 0.9.22（29947050 B，sha256 `b402b52c…`）【实测】 |

### 自签 CA 的适用范围

- 只有装了**内置同一张 CA** 的 APK 的手机才认这张证书。
- 别人要用，必须自己的域名 + 真实证书（Let's Encrypt 等，走系统信任链），或自己重编 APK 换内置 CA；详见 §7。
- 自签 + 裸 IP 这条路只对内置了这张 CA 的 App 成立，不构成对外可复用的默认服务器。
