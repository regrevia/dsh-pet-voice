# 不买域名也能 https：自签 CA 打进 App

> 适用：手机要连自己机器（局域网 IP 或腾讯云转发口），但不想买域名 / 不想备案。
> 版本：鲸灵 **0.2.2** 起内置这张 CA。证据日期 2026-10-24，等级标注见每节。

## 1. 为什么必须 https

Android 上「明文 http」只对 loopback（`127.0.0.1` / `localhost`）放行；填 `http://192.168.x.x:8443` 会被 App 的
`openGui()`/网络层按设计拦掉。而公网 IP 拿不到受信任证书（Let's Encrypt、腾讯云免费 DV 都不给裸 IP 签）。

所以办法只有两条：**买域名**，或者**自己当 CA 并把根证书打包进 App**。后者 0 元，本文就是它。

## 2. 三步走

```bash
# ① 生成 CA + 叶证书（把 IP 换成你腾讯云的公网 IP；局域网用局域网 IP）
bash scripts/tls-ca.sh --ip 1.2.3.4
#   可选：再加域名 SAN  bash scripts/tls-ca.sh --ip 1.2.3.4 --dns pet.home.arpa
#   它同时会把根证书拷进 App：android/app/src/main/res/raw/pet_ca.pem（公开证书，不是私钥）

# ② 本机起 https 反代：https://127.0.0.1:8443/pet-voice/* → DSH Web（端口自动探）
#    上游不写死：先试 --upstream，再读 DSH_WEB_URL，最后把 dsh web 实际在听的端口挨个试一遍。
#    DSH 换端口（例如 52356 → 54013）后不用改命令，重跑这一条即可。
node scripts/tls-proxy.mjs            # 前台跑；要给别人/真机连就加 --bind 0.0.0.0

# ③ 重新出包（App 内置 CA）并装到手机
JAVA_HOME=~/jdk17/Contents/Home ~/.gradle/wrapper/dists/gradle-8.13-bin/*/gradle-8.13/bin/gradle \
  -p android :app:assembleRelease --offline \
  -Pandroid.aapt2FromMavenOverride=/opt/homebrew/share/android-commandlinetools/build-tools/35.0.0/aapt2
adb install -r dist/jingling-0.2.2.apk
```

手机里填的地址：`https://<你的IP>:8443/pet-voice/`。**换了 CA 就必须重新出包装机**，只换叶证书（`--renew-leaf`）不用。

## 3. 和腾讯云组合（两种拓扑）

**拓扑 A：TLS 在 Mac 上终止（推荐，最少配置，证书不出本机）**

```bash
# Mac：起 https 反代（只监听本机），然后把它反向转发到云服务器的 8443
node scripts/tls-proxy.mjs --quiet &
ssh -N -R 0.0.0.0:8443:127.0.0.1:8443 \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    pet-tunnel@你的腾讯云IP
```

云服务器要两件事：

```bash
# ① sshd 允许客户端指定绑定地址（否则 -R 0.0.0.0:8443 会被悄悄改成只听 127.0.0.1）
echo "GatewayPorts clientspecified" | sudo tee /etc/ssh/sshd_config.d/99-pet-gatewayports.conf
sudo sshd -t && sudo systemctl reload ssh

# ② 安全组/防火墙放行 TCP 8443（源地址填你手机的出口 IP 最稳）
```

不装 Caddy、不装 nginx。

> **「443 开不了 / 要备案」的真相**：实测这台机器从外网只有 **22** 通，80/443/8443 全不通——这是
> **安全组没放行**，不是备案拦截（备案拦截会先建连再返回一个拦截页，TCP 是通的）。我们是「裸 IP + 高端口」，
> 不涉及备案；只要在控制台加一条 8443 规则即可。

**拓扑 B：Caddy 在云服务器上终止 TLS**（想把证书和进程都放服务器时）

```caddyfile
:8443 {
    tls /etc/caddy/pet-leaf.pem /etc/caddy/pet-leaf.key.pem
    reverse_proxy 127.0.0.1:52356
}
```

```bash
# Mac 只转发明文口到服务器本机
ssh -N -R 127.0.0.1:52356:127.0.0.1:52356 pet-tunnel@你的腾讯云IP
# 证书从 Mac 拷过去（两张都要，一次 0600）
scp ~/.dsh/pet-voice/tls/pet-leaf.pem ~/.dsh/pet-voice/tls/pet-leaf.key.pem pet-tunnel@IP:/etc/caddy/
```

资源占用【估算】：sshd 转发本身 CPU 近 0、每个连接几 MB 内存；带宽只算真实流量（一句话几 KB，一条 TTS 语音约 20–40 KB）。

## 4. 续期

- 根证书 3650 天，叶证书 397 天（Android 对证书有效期敏感，别签太长）。
- 到期前跑 `bash scripts/tls-ca.sh --renew-leaf --ip 1.2.3.4`：**复用 CA**，所以 App 不用重装，只要把新叶证书给代理/Caddy 用。
- `bash scripts/tls-ca.sh --check` 会验：私钥权限 600、链能验通、SAN 含 `127.0.0.1`/`10.0.2.2`/`::1`、剩余天数 >30、App 内置的 CA 与本地一致。

## 5. 验收证据

| 检查 | 结果 | 命令 | 等级 |
| --- | --- | --- | --- |
| 证书生成 + 自检 | 全部通过，叶证书 396 天后到期，CA 指纹 `F2:EE:4F:B5…83:D7` | `bash scripts/tls-ca.sh --ip 203.0.113.9`（示例 IP） | 【实测 2026-10-24】 |
| TLS 握手 + 上游连通 | `https://127.0.0.1:8443/pet-voice/api/state` → **200**，TLS 握手 **6.5 ms** | `curl --cacert ~/.dsh/pet-voice/tls/pet-ca.pem https://127.0.0.1:8443/pet-voice/api/state` | 【实测】 |
| 只放行 `/pet-voice/*` | `https://127.0.0.1:8443/api/state` → **404** | 同上换路径 | 【实测】 |
| **App 信任这张 CA** | 装 0.2.2 后把宿主地址换成 `https://10.0.2.2:8443/pet-voice/`：语音指令 **13 通过 / 0 失败**（分流 623 ms） | `PET_HOST=https://10.0.2.2:8443/pet-voice/ bash scripts/verify-commands.sh` | 【实测】模拟器 |
| SSH 反向隧道（Mac → 腾讯云） | 服务器 `0.0.0.0:8443` 监听成功；服务器本机 `https://127.0.0.1:8443` → **401**（TLS 通、鉴权生效） | `bash scripts/tunnel-ssh.sh --daemon` | 【实测】 |
| 公网访问 8443 | 从 Mac/服务器探测均**不通** → 安全组未放行（22 通，80/443/8443 不通） | `nc -z -G 4 <IP> 8443` | 【实测】需你在控制台放行后才能到真机 |

> 上面成功的那个 `10.0.2.2` 是模拟器看宿主的固定地址；真机上换成你 `--ip` 生成时写的那一个。

## 6. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `curl` 报 `certificate verify failed` | 没用 `--cacert` 指到这张 CA | 加 `--cacert ~/.dsh/pet-voice/tls/pet-ca.pem` |
| App 报证书错误 / `SSLHandshakeException` | App 里内置的还是旧 CA | `bash scripts/tls-ca.sh --check` 看「App 内置的 CA 与本地根证书一致」，不一致就重新出包装机 |
| 手机连 `https://…:8443` 超时 | 端口没到 Mac / 安全组没开 | `curl -v https://IP:8443/pet-voice/api/state` 从外网试；检查 `ssh -R` 与安全组 |
| 浏览器打开警告「不安全」 | 自签证书本来就不在系统信任列表 | 正常；只有鲸灵这个 App 认它 |
| 想换 IP（换了网络） | SAN 里没有新 IP | `bash scripts/tls-ca.sh --ip 新IP --renew-leaf`，重启代理即可（App 不用重装） |

## 7. 安全边界

- 根私钥只在本机 `~/.dsh/pet-voice/tls/`（目录 700、文件 600），**永不进仓库**；进仓库的只有公开的 `pet_ca.pem`。
- `scripts/tls-proxy.mjs` 不是通用代理：只转发 `/pet-voice/*`，默认只绑 `127.0.0.1`。
- 别把 CA 私钥拷到云服务器上（拓扑 A 压根不需要）；真要拷，只拷叶证书 + 叶私钥。
- 这套方案的信任范围 = 装了这个 App 的手机；手机丢了就换 CA 重新出包。

## 8. 端到端已验证：腾讯云轻量 + 公网 8443（2026-10-24）

用户在自己那台轻量服务器上放行 TCP 8443 后，整条链路在**公网**上跑通（不再是局域网/模拟器环回）：

| 检查 | 结果 | 证据 |
|---|---|---|
| 安全组放行前 | `TCP 8443` 不通，服务器 `ss` 里只有 `127.0.0.1:8443` | `nc -z` / `ss -ltnp` 【实测】 |
| 安全组放行后 | `nc` 通、`ss` 里 `0.0.0.0:8443` | 【实测】 |
| 用内置 CA 校验证书 | `GET /pet-voice/api/state` → **401**，TLS 握手 **48.8 ms** | `curl --cacert pet-ca.pem` 【实测】 |
| 不带 CA（模拟浏览器） | 直接失败，证书不受信 | 自签的预期行为 【实测】 |
| 带 Cookie `pkv_<前8位>=<token>` | `/api/state` → **200**；`/pet-voice/` → **200**，5642 字节 | 【实测】 |
| 模拟器全走公网地址 | `PET_HOST=https://<IP>:8443/pet-voice/` 跑完 **13/13** 指令用例，分流 922 ms | `scripts/verify-commands.sh` 【实测】 |

结论：**裸 IP + 8443 + 自签 CA** 这条路在真实公网上成立，不需要域名、不需要备案、不需要 443。

### 配对（不把 token 打进仓库）

```bash
# 生成一次性配对二维码（600 权限，local/ 已被 .gitignore 忽略）
# 内容就是 App「粘贴配对内容」认的 JSON：{"host":"https://<IP>:8443/pet-voice/","token":"<48 位>"}
open local/pair-qr.png     # 手机 App → 扫码
```

- `local/pair.json`、`local/pair-qr.png` 都是**本机临时物**，绝不入库、绝不贴对话；
- token 在 `~/.dsh/pet-voice/token`（48 位），怀疑泄露就轮换 → 重启宿主 → 重新生成二维码；
- 隧道进程：`bash scripts/tunnel-ssh.sh --daemon` 起、`--stop` 停、`local/tunnel.log` 看日志；
  断线不会自动重连（没装 autossh），实测建议 `brew install autossh` 后脚本会自动用它。
