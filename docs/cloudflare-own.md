# 用你自己的 Cloudflare 账号 + 自己的域名接通手机

这份文档只讲一件事：**不依赖 trycloudflare 临时域名，改用你自己 Cloudflare 账号下的命名隧道（named tunnel）**，让手机/音箱/手表有一个长期不变的 HTTPS 入口。

写这份的原因：快速隧道（`cloudflared tunnel --url`）给的 `https://<随机词>.trycloudflare.com` 每次重启就换域名，而且**在我们这台开发机上实测 DNS 解析不到**（`dig` 偶发能取到 104.16.x，`curl` 报 `Could not resolve host`，HTTP 000，2026-10-24 20:0x【实测】）。自己的域名走自己的 DNS，这条坑天然不存在。

---

## 1. 你需要准备的三样东西

| # | 东西 | 放哪 | 说明 |
|---|---|---|---|
| 1 | Cloudflare 账号里一条 **Tunnel** | 控制台 | Zero Trust → Networks → Tunnels → Create a tunnel → **Cloudflared** |
| 2 | 这条 tunnel 的 **token** | `~/.dsh/pet-voice/cloudflared.token`（0600） | 控制台安装页里那串 `eyJ...`，**只落文件，别贴聊天/别进 git** |
| 3 | 一个 **Public Hostname** | 同上，DNS 记录 | 例：子域 `pet` + 你的域 `example.com`，Service 指 `http://127.0.0.1:52356` |

第 3 步在控制台 Tunnel → Public Hostname → Add：

```
Subdomain:  pet
Domain:     example.com          ← 你的域名（已托管在 Cloudflare）
Path:       （留空）
Service:    HTTP  →  127.0.0.1:52356
```

保存后 Cloudflare 会自动建一条 `pet.example.com` 的 CNAME 指向 `<tunnel-id>.cfargotunnel.com`。**这一步不成功，后面一定失败**，先在浏览器里确认 `https://pet.example.com/pet-voice/` 能打开（没有 cookie 时应该返回 401 或登录页，不是 502）。

主机名还要写进文件，脚本才能拼地址：

```bash
printf '%s\n' 'pet.example.com' > ~/.dsh/pet-voice/cloudflared.host
chmod 600 ~/.dsh/pet-voice/cloudflared.host
```

## 2. 存 token（别用 echo，别留 shell history）

```bash
# 交互式粘进去，Ctrl-D 结束；权限直接 600
install -m 600 /dev/stdin ~/.dsh/pet-voice/cloudflared.token
# 验证只看到长度，不看到内容
wc -c < ~/.dsh/pet-voice/cloudflared.token
```

脚本读取方式：token 只进子进程环境变量 `TUNNEL_TOKEN`，**不进 argv**（`ps` 看不到）、不进日志、不打屏。`--check` 只报「token 文件存在（内容不打印）」。

## 3. 起隧道

```bash
cd /tmp/pet-lab
bash scripts/tunnel.sh --check --named    # 先自检：cloudflared/端口/xiaoai.json/凭据/主机名
bash scripts/tunnel.sh --named            # 起命名隧道，等到 https://<host>/pet-voice/ 返回 200/303/401 才算成
bash scripts/tunnel.sh --stop             # 收掉（会按命令行兜底清理，不留孤儿进程）
```

成功的输出形如：

```
隧道进程 PID=12345 （命名隧道），日志 /Users/.../tunnel.log
新地址已写入 ~/.dsh/pet-voice/xiaoai-url.txt（chmod 600）
公网地址：https://pet.example.com/pet-voice/   （不含令牌，可以截图）
```

`xiaoai-url.txt` 里是 `https://pet.example.com/pet-voice/api/xiaoai?k=<urlSecret>`，手机侧 `/api/pair` 会读到这个新域名，探活 1.5 s 内变绿。**这个文件带 k，别截图、别提交**；给人看的只用上面那行「公网地址」。

### 参数与开关

| 参数 / 变量 | 作用 |
|---|---|
| `--named` | 强制命名隧道（即使没有 token 也会明确报错，而不是偷偷退回快速隧道） |
| `--quick` | 强制快速隧道（临时域名） |
| 无参数 | 有 `cloudflared.token` 就走命名，否则快速隧道 |
| `--check` | 只自检，不启动、不写文件 |
| `--stop` | 停掉并清理孤儿 cloudflared |
| `PV_PORT` | 宿主端口，默认 52356 |
| `TUNNEL_WAIT` | 等域名/等通的秒数，快速默认 40、命名默认 20 |
| `PV_CF_HOST` | 临时覆盖主机名（优先级高于 `cloudflared.host`） |

## 4. 手机怎么连

1. 手机和电脑要在同一网络，或走这条公网隧道（推荐，省得配内网 IP）。
2. App 主页「扫码绑定鲸灵」：扫插件页/引导卡上的配对二维码（`/api/pair` 生成的 `k=` 只出现在二维码和 `xiaoai-url.txt` 里）。
3. 手填也行：设置 → 服务器地址填 `https://pet.example.com/pet-voice/`，令牌填配对码里的那串。
4. 绑好后主页应显示「鲸灵 · 已连接」。

**注意**：App 的 `base_url` 必须落到 `…/pet-voice/`，`Settings.normalizeBase()` 会自动补；写成根域会 401。

## 5. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `--check` 报「缺少 cloudflared.token」 | 文件没建/是空的 | 回到第 2 步；注意 `install -m 600` 后文件应为几百字节 |
| `--check` 报「缺少主机名」 | 没写 `cloudflared.host` | 第 1 步第 3 小步那个 Public Hostname |
| 起隧道后 20 s 仍 `HTTP 000` | DNS 还没生效 / 路由没指到 `127.0.0.1:52356` | 浏览器直接开域名；控制台确认 Public Hostname 的 Service 端口 |
| `HTTP 502` | 隧道通了但宿主没起 | 先确认 `curl http://127.0.0.1:52356/pet-voice/` 有响应（401 也算活着） |
| `HTTP 403` / Cloudflare 拦截 | 浏览器完整性检查 / WAF | Zero Trust 里对该 hostname 关掉 Browser Integrity Check |
| 手机显示「连不上」但浏览器能开 | App 里地址少了 `/pet-voice/` 或令牌填错 | 重扫码，或手填到 `/pet-voice/` |
| 隧道被 Cloudflare 限速 | 免费 tunnel 有连接数/带宽限制 | 只给一个人用够；多人用要上 Zero Trust Access |

## 6. 与仓库里其它文档的关系

- `scripts/tunnel.sh` 是本仓库**唯一**起隧道的入口，两种模式都在里面，别另写一份。
- 旧文档里凡是写「快速隧道/`trycloudflare`」的地方，都是**开发期临时方案**；长期用请按本文走命名隧道。
- 安全边界不变：`/api/*` 无 cookie 一律 401（`scripts/contract-check.mjs` 会验），公网暴露的只是一层需要令牌的入口；`k=` 与 token 都不进 git、不进聊天。

---

### 实测与未核实（2026-10-24）

- 【实测】`bash -n scripts/tunnel.sh` 通过；`--check --quick` 五项 OK；`--check --named` 在缺 token 时给出明确报错与下一步命令；`--stop` 用假 PID 走完 `rc=0`，且在真隧道启动后能清理干净（`pgrep -fl "cloudflared tunnel"` 计数 0）。
- 【实测】快速隧道能起、能抓到 `https://<随机>.trycloudflare.com`、能写回 `xiaoai-url.txt`（0600）。
- 【实测】本机对 `*.trycloudflare.com` 的解析不稳定：`dig` 可能给 104.16.230.132，`curl` 却 `Could not resolve host` → HTTP 000。**所以公网可达性在这台机器上无法证明**，命名隧道同理未验。
- 【未核实】你自己的域名 + 命名隧道全链路（DNS/证书/401 门禁/手机绑定）。等你把 token 和域名给我，我按本文跑一遍并把截图补进 `docs/img/`。
- 【未核实】HyperOS 4 / Android 15 上的后台网络与省电策略对长连接的影响（无真机）。
