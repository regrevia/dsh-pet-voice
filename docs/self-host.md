# 自己接入（不经过任何第三方服务器）

这个插件只做两件事：把 DSH 的 `/pet-voice/` 页面挂到宿主上，以及把配对链接生成好。
**它不往任何第三方服务器发数据**，也不需要你注册任何服务。手机能打开页面，靠的是你自己选的一条通路：
自己的服务器、隧道工具，或者同一个 WiFi。

## 第一次用：三步连上

1. 电脑上把 DSH 开起来，侧栏点「大肥鱼」。
2. 有公网服务器就在「经自己的服务器转发」里填三格、点「连接」（推荐）；否则在「连上手机」里选一种连法（见下面的表），确认地址，点「复制链接」。
3. 手机装好 APK 打开，扫码或粘贴这条链接——绑上了，以后不用再配。

换电脑、换隧道域名、换令牌，手机上都要重新绑一次。绑定信息只存在手机本地，
所以**每个人都得配自己那台电脑**，没有能让所有人共用的默认服务器。

「检查更新」读的是手机上绑定的那台电脑里的版本：你自己发了新版，手机才收得到。
开源仓库的 Release 页面只是给第一次装的人下载用的。

四种连法，按省事程度排序。有公网服务器就走第一种，在面板那张卡里配，连上后地址自动填好。

| 方案 | 适用 | 需要 | 面板里选 |
|---|---|---|---|
| 自己的服务器转发（首选） | 已有公网服务器，长期用、不想买域名 | 一台能 SSH 的服务器 + 私钥 | 卡片「经自己的服务器转发」，见下面 |
| A 内网穿透（零配置） | 外面也想用、不想碰路由器/证书 | 装 `cloudflared` 或 `ngrok` | `自建域名`，填工具给的 https 地址 |
| B 自建域名 + 反向代理 | 长期用、有自己的域名 | 一台能跑 nginx/caddy 的机器 + 证书 | `自建域名`，填自己的域名 |
| C 纯局域网 | 手机和电脑同一个 WiFi | 无 | `局域网` |

## 三个档位分别填什么

| 面板里的档位 | 地址从哪来 | 什么时候用 |
|---|---|---|
| `内网穿透` | 你自己隧道工具的 https 地址（`cloudflared` / `ngrok` 给的），由本机隧道进程回报 | 在外面也想用手机连 |
| `局域网` | 本机网卡的 `http://<内网IP>:<端口>/pet-voice/`，自动算出来 | 手机和电脑同一个 WiFi |
| `自建域名` | 你手填的域名，走你自己的 nginx/caddy 和证书；用「经自己的服务器转发」连上后自动填好 | 长期用、有自己的域名 |

默认档是 `局域网`。**代码里没有硬编码任何人的 IP 或域名，也不会自动连任何第三方服务**——
`内网穿透` 这一档之所以有地址，是因为你这台机器上跑着隧道进程，它把地址报给了插件；没跑就是空的。

自检：`~/.dsh/pet-voice/panel.json` 里除了你自己填的 `customUrl`，不该出现任何不属于你的域名。
看到别人的域名就把 `mode` 改回 `lan`，或者删掉这个文件回到默认。

用「经自己的服务器转发」连上后，`mode` 会被写成 `自建域名`、`customUrl` 填你的地址，这是预期行为。

## 经自己的服务器转发（推荐，面板里配）

手边有一台能 SSH 登录的服务器（VPS），就走这张卡：DSH 网页侧栏「大肥鱼 → 经自己的服务器转发」。

### 你的服务器要满足两件事

1. sshd 允许客户端指定绑定地址（不改的话，`ssh -R 0.0.0.0:` 会被悄悄改成只听 `127.0.0.1`）：

```bash
echo "GatewayPorts clientspecified" | sudo tee /etc/ssh/sshd_config.d/99-pet-gatewayports.conf
sudo sshd -t && sudo systemctl reload ssh
```

2. 云安全组/防火墙放行你选的那个公网端口（TCP）。源地址能限定就限定成手机出口 IP。

两件缺一，可能隧道起得来但手机打不开。

### 本机先有证书

```bash
bash scripts/tls-ca.sh --ip <你的服务器公网IP>
# 有域名再加一个 SAN：bash scripts/tls-ca.sh --ip <你的服务器公网IP> --dns pet.example.com
```

证书放在 `~/.dsh/pet-voice/tls/`；面板里没有证书时会提示先跑这条。

### 填三个字段，点「连接」

| 字段 | 填什么 |
|---|---|
| 账号 | `账号@服务器`；SSH 端口不是 22 时写 `账号@服务器:端口`（例 `ubuntu@<你的服务器>:2222`） |
| 公网地址 | `https://服务器:公网端口`，端口和上一步放行的一致（例 `https://<你的服务器>:8443`） |
| 私钥 | 本机私钥路径，默认 `~/.ssh/id_ed25519`；云厂商给的 `.pem` 也填这里 |

点「连接」后，插件进程内起两段：

- 本机 https 反代：只听 `127.0.0.1`，只转发 `/pet-voice/*`；
- 反向隧道：`ssh -R 0.0.0.0:<公网端口>:127.0.0.1:<本机端口>`。

状态行显示正在用的地址。点「断开」两段一起停、服务器端口释放；配过之后插件重载会自动重连。

### 连上之后

面板把地址写进「连上手机 → 自建域名」，二维码变成带 `?k=` 的配对链接，手机扫码即配对。裸 IP 也认。

### 用命令行起停（替代方案）

面板是首选；不想开网页时用 `scripts/pv-public.sh`，起的是同样的两段。

```
手机 ──https──▶ 你的服务器:8443 ──ssh -R──▶ 本机 https 反代:8443 ──▶ DSH $PV_PORT
```

```bash
bash scripts/tls-ca.sh --ip <你的服务器公网IP>   # 证书，面板那张卡也用这张

PV_SSH=账号@<你的服务器> \
PV_SSH_KEY=~/.ssh/id_ed25519 \
PV_REMOTE_PORT=8443 \
PV_PUBLIC=https://<你的服务器>:8443 \
  scripts/pv-public.sh start    # 起两段，已经在跑就跳过；结尾打印公网地址

scripts/pv-public.sh status     # 两段进程 + 公网探测（401 = 通且鉴权生效）
scripts/pv-public.sh restart    # DSH 换端口、或隧道断了之后
scripts/pv-public.sh stop
```

上面几个变量也可以写进 `~/.dsh/pet-voice/public.env`，之后直接 `scripts/pv-public.sh start`。
`PV_PUBLIC` 只给 `status` 的公网探测用。

服务器侧那两件事不变：`GatewayPorts clientspecified` + 安全组放行端口（见上面）。
起好后在「连上手机」选 `自建域名`，填打印出来的地址。

### 验证

```bash
BASE=https://<你的服务器>:8443
curl -s -o /dev/null -w '%{http_code}\n' --cacert ~/.dsh/pet-voice/tls/pet-ca.pem "$BASE/pet-voice/api/state"   # 401 = 通且鉴权生效
```

不带 `--cacert` 会报证书不受信，这是自签证书的正常表现：它不在系统信任链里，只有内置了同一张 CA 的 App 认。

### 证书边界：别人不能照抄这条

- 仓库内置的 CA 是随 App 打包的那张，只有装了**同一个 APK** 的手机才信任。
- 别人要自建：用自己的域名 + 真实证书（Let's Encrypt 等，走系统信任链），或自己重编 APK 内置自己的 CA
  （`scripts/tls-ca.sh` 会把根证书写进 `android/app/src/main/res/raw/pet_ca.pem`）。
- 所以没有「大家共用的默认服务器」：配置只在这台电脑的 `~/.dsh/pet-voice/public.json`（0600），不进仓库、不上传；
  同一个仓库多人各自配各自的服务器，互不继承。

### 常见失败

- **私钥被拒**：私钥路径指到本机 pem，权限 600；账号写成 `账号@服务器`。
- **服务器说端口被占 / 不许转发**：`GatewayPorts clientspecified` 没生效（`sudo sshd -t` 查），或该端口已被占用。
- **隧道在跑，手机还是打不开**：安全组/防火墙没放行；从外网试 `nc -z <你的服务器> 8443`。
- **手机报证书错误**：证书里的 IP/域名和你填的公网地址不一致，`bash scripts/tls-ca.sh --ip <你的服务器公网IP> --renew-leaf` 重签，App 不用重装。
- **DSH 重启后手机连不上**：插件重载会自动重连；没连上就点一次「断开」再「连接」。

## 方案 A：内网穿透（零配置）

### 先确定端口
DSH 每次启动的端口可能不同，先让脚本自己找一条能用的地址：

```bash
cd Pet && source scripts/lib/pv-base.sh && pv_base
# → http://127.0.0.1:54013/pet-voice
PV_PORT=$(pv_base | sed -n 's#.*:\([0-9][0-9]*\)/pet-voice$#\1#p')
```

下面命令里的 `$PV_PORT` 就是它；配置文件（Caddy/nginx）里要写成数字。

### 前置
- 本机 DSH 在跑，宿主端口默认 `$PV_PORT`：`curl -s http://127.0.0.1:$PV_PORT/pet-voice/api/state` 应回 401（没令牌就该被拒）。
- 装一个隧道工具（任选一个）。

### cloudflared（推荐，免费、随机域名、无需账号）
```bash
# macOS
brew install cloudflared
# 或直接用官方二进制 / npx
cloudflared tunnel --url http://127.0.0.1:$PV_PORT
```
输出里会出现 `https://<随机>.trycloudflare.com`。**这个域名每次重启隧道都会变**。

### ngrok
```bash
brew install ngrok
ngrok http $PV_PORT
```
输出里的 `https://<随机>.ngrok-free.app` 就是公网地址。

### 填到插件里
1. 侧栏「大肥鱼」→「连上手机」→ 选 `自建域名`。
2. 地址填上一步拿到的 `https://...`（带不带 `/pet-voice` 都行，插件会自己补到 `/pet-voice/`）。
3. 二维码会变成带 `?k=` 的配对链接，手机扫码即配对。

### 验证
```bash
BASE=https://<你的隧道域名>
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/pet-voice/"        # 401（没带 key，正常）
curl -s "$BASE/pet-voice/api/state"                                # 401 JSON：鉴权正常工作
# 带 key 验证（key 就是 ~/.dsh/pet-voice/token，别外传）
curl -s "$BASE/pet-voice/api/state?k=$(cat ~/.dsh/pet-voice/token)" | head -c 200
```

### 常见失败
- **页面能开但语音不回复、消息要等一大段才出**：隧道把 SSE 缓冲了。插件已经内置长轮询兜底（`/api/poll`），手机上会自动退化，不需要你处理；仍想修可换方案 B。
- **扫码后 401 / 一直转圈**：`?k=` 没带上（手输地址时容易丢）。重新扫码，或手动补 `?k=<token>`。
- **域名过期**：cloudflared 快速隧道重启即换域名，回面板重新填一次。

## 方案 B：自建域名 + 反向代理（长期用）

### 前置
- 一个域名，A/AAAA 记录指到你的机器（下面统一叫 `PET_ORIGIN`，例如 `pet.example.com`）。
- 证书（caddy 自动签，nginx 用 certbot）。
- 宿主端口 `$PV_PORT` 只监听本机或内网，**不要直接暴露到公网**。
- 反代和 DSH 不在同一台机器（反代在服务器、DSH 在本机）时，用上面的「经自己的服务器转发」。

### caddy（最省事，自动 TLS + 默认不缓冲 SSE）
`/etc/caddy/Caddyfile`：
```
PET_ORIGIN {
    encode zstd gzip
    reverse_proxy 127.0.0.1:$PV_PORT {
        flush_interval -1
    }
}
```
```bash
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### nginx（注意 SSE 不缓冲）
`/etc/nginx/conf.d/pet.conf`：
```nginx
server {
    listen 443 ssl http2;
    server_name PET_ORIGIN;

    ssl_certificate     /etc/letsencrypt/live/PET_ORIGIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/PET_ORIGIN/privkey.pem;

    client_max_body_size 8m;

    location /pet-voice/ {
        proxy_pass http://127.0.0.1:$PV_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / 流式回复必须关闭缓冲，否则手机上是一段一段蹦
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }
}

server {
    listen 80;
    server_name PET_ORIGIN;
    return 301 https://$host$request_uri;
}
```
```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 填到插件里
「连上手机」里选 `自建域名`，地址填 `https://PET_ORIGIN`（插件会自动补 `/pet-voice/`）。

### 验证
```bash
BASE=https://PET_ORIGIN
curl -sI "$BASE/pet-voice/" | head -1                 # 401 或 200
curl -s "$BASE/pet-voice/api/state" | head -c 120     # 401 JSON
# 关键：SSE 没被缓冲（应该立刻吐帧，而不是攒 10 秒）
curl -sN --max-time 5 "$BASE/pet-voice/api/stream?k=$(cat ~/.dsh/pet-voice/token)" | head -3
```

### 常见失败
- **消息攒一大段才出**：`proxy_buffering off` 没生效，或中间还有一层 CDN/负载均衡在缓冲。逐层关，或依赖插件自带的长轮询。
- **自签证书手机不认**：iOS/Android 对自签证书很苛刻，用 Let's Encrypt 正式证书；实在只能自签，就在手机上装根证书（不推荐）。
- **502 / 连接被拒**：宿主只监听 `127.0.0.1`，代理要用 `127.0.0.1:$PV_PORT` 而不是域名回环；或 DSH 没在跑。
- **大请求 413**：把 `client_max_body_size` 调到 8m（图片/长文本上传）。

## 方案 C：纯局域网（默认）

### 前置
- 手机和电脑同一个 WiFi（同网段，且路由器没开「AP 隔离 / 客户端隔离」）。
- 电脑防火墙放行 `$PV_PORT`（macOS 首次会弹「是否允许 Python/node 接入网络」，选允许）。

### 步骤
1. 「连上手机」里选 `局域网`。
2. 面板里显示的就是 `http://<电脑内网 IP>:$PV_PORT/pet-voice/`。
3. 手机扫码（同一个 WiFi），首次打开会下发 cookie，之后直接进。

### 验证
```bash
# 在电脑上
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PV_PORT/pet-voice/api/state   # 401
# 在手机上用浏览器打开面板里那条 http://<内网IP>:$PV_PORT/pet-voice/?k=...
```

### 常见失败
- **手机打不开、电脑能开**：路由器 AP 隔离；或电脑有多张网卡（VMware/utun），面板挑了错的那张。看 `ifconfig` 里手机同网段的 `inet`。
- **换 WiFi / 重启后 IP 变了**：`局域网` 档的地址是实时算的，回面板重新扫码即可。
- **电脑重启后连不上了**：DSH 每次启动的端口可能不一样（`$PV_PORT` 要重新算），手机里存的是旧端口。不用解绑，App 「更多 → 重新扫码」扫一次就行；想彻底免掉这一步，用方案 A 或 B，地址是固定的。
- **HTTP 被浏览器拦截（语音/麦克风需要安全上下文）**：`http://<内网IP>` 在部分浏览器里麦克风权限受限。要语音唤醒就用方案 A/B 的 https，或 `lan` 下用 Chrome 的 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 把该地址加白（仅调试）。

## 安全须知（各种连法都适用）

- 配对靠 `?k=<token>` 换 cookie；token 在 `~/.dsh/pet-voice/token`，**当密码对待**。泄露就删掉该文件，插件会重新生成。
- 面板里点「换新链接」等价于删掉该文件：旧 cookie、旧配对链接立刻作废，所有手机都要重新扫一次。
- 公网暴露后，`/pet-voice/api/*` 除了页面/静态资源全部要鉴权；面板路由（`/pet-voice/panel/*`）只放行回环地址，公网永远是 403。
- 设备有上限（默认 2 台）。「移出列表」只是把那一行从面板划掉，不会让手机失效；要真正断开某台手机就用「换新链接」。
- 不要在公网反代上加「免鉴权白名单」：页面免鉴权是设计（靠 `?k=` 换 cookie），接口不是。
