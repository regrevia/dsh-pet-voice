# Cloudflare Tunnel token：从哪拿、算什么、怎么安全落盘

> 口径：Cloudflare 控制台行为按 **2026-10** 实际界面记录；「免费」按官方 Zero Trust 定价页口径，标注【厂商口径】。
> 本机当前状态：`cloudflared` **未安装**、`~/.dsh/pet-voice/cloudflared.token` **未配置**，所以命名隧道还没跑过真链路（【未核实】）。

## 1. 控制台上那两行，哪一行是 token

建好隧道（Zero Trust → **Networks → Tunnels** → Create a tunnel → Cloudflared → 起名 → Save）后，
安装页给的是同一串东西的两种用法：

```
sudo cloudflared service install eyJhIjoi…NCJ9      ← 装成系统服务（root、开机自启）
cloudflared tunnel run --token eyJhIjoi…NCJ9        ← 手动/用户态跑
```

**`eyJhIjoi…` 就是 tunnel token，两行里是同一个值**，区别只是「装服务」还是「前台跑」。
它 base64 解开是一个 JSON：

```json
{ "a": "<32 位账户 ID>", "t": "<隧道 UUID>", "s": "<隧道密钥>" }
```

拿到 token ≈ 拿到「往这台机器内网打洞」的权限，所以它和个人 API 令牌、R2 的 Access Key/Secret 是**三套互不通用**的凭证。

## 2. 要不要 `sudo cloudflared service install`

**不建议。** 那会把隧道装成一个 **root 权限、开机自启** 的系统服务，token 落在系统服务配置里；
本项目的做法是用户态起进程、token 只放用户目录 0600 文件、命令行参数里不出现：

```bash
node scripts/cf-tunnel-token.mjs --clipboard --host pet.example.com   # 粘/读 token，自动校验+落盘
node scripts/cf-tunnel-token.mjs --check                              # 再验一遍（权限/形状/主机名）
bash scripts/tunnel.sh --named                                        # 起隧道
```

## 3. `scripts/cf-tunnel-token.mjs` 干什么

| 行为 | 说明 |
| --- | --- |
| 认形态 | `service install <tok>` / `tunnel run --token <tok>` / 裸 token / 整段控制台文本都行；出现多个 `eyJ…` 时取最长的那个（截断片段会被淘汰） |
| 校验 | base64 解 → JSON 必须含 `a`（32 位 hex）/`t`（UUID）/`s`（≥40 位）；复制少了字符会被 base64/JSON 挡下 |
| 认主机名 | 从粘贴里抓域名，`https://Pet.Example.com:443/x` → `pet.example.com`；`localhost`、`trycloudflare.com`、`cfargotunnel.com` 直接拒 |
| 落盘 | 目录 0700、文件 0600、同目录临时文件 + `rename` 原子写；写 `cloudflared.token`（和 `cloudflared.host`） |
| 打码 | 全程只打印 `eyJhIj…XkQ9（N 位）` + 账户/隧道/密钥长度，**从不回显原文** |
| 护栏 | 落点在当前项目目录或 git 仓库里 → 退出码 2 拒写（`--allow-repo` 才放行） |
| 只读模式 | `--check`（验已存的两份）、`--show`（掩码展示）、`--check-cloudflared`（看 cloudflared 装没装） |

对应验收：`node scripts/cf-tunnel-token.test.mjs` → **30/30 通过**（离线、假 token、临时 HOME、不碰真凭证），
已挂进 `scripts/verify.sh` 的 `4c` 段。

### 3.1 和 `scripts/tunnel.sh --check` 打通

起隧道前的冒烟检查现在会**顺手深校验**这两份文件（不用另开一条命令）：

```bash
bash scripts/tunnel.sh --check --named
```

在原来的「cloudflared / 端口 / xiaoai.json / 文件存在」之外多一行
`OK token/host 深校验通过（cf-tunnel-token.mjs --check）`；不合格则列出 `✗` 明细并以退出码 1 结束。

【实测 2026-10-24，假 `cloudflared` + 临时 HOME，不碰真凭证】

| 场景 | 结果 |
| --- | --- |
| 合法 token（`{a,t,s}` 齐全）+ `pet.example.com` | 全部 `OK`，`rc=0` |
| 主机名写成 `pet.trycloudflare.com` | `✗ 主机名不合法：trycloudflare 是临时隧道域名…`，`rc=1` |
| token 只贴了前 40 字符 | `✗ token 不合法：token 解不开…`，`rc=1` |

## 4. 还要在控制台补一步：Public Hostname

token 只说明「这条隧道归谁」，**不说明域名指哪**。同一个隧道下要加：

- 子域 `pet`、域 `example.com` → `pet.example.com`
- Service 类型 HTTP → `http://127.0.0.1:52356`（本机插件端口；端口变了就跟着改）

少了这一步，访问 `https://pet.example.com` 会拿到 Cloudflare 的 **1033（隧道没路由）** 页，
`scripts/tunnel.sh --named` 也起得来但外层 404/1033 —— 这不是 App 的问题。

## 5. 免费吗（2026-10 口径）

| 项 | 结论 |
| --- | --- |
| 隧道数量 / 连接器 | 免费，不按隧道收费【厂商口径，[官方文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)】 |
| Zero Trust 免费版 | ≤ 50 个用户【厂商口径】 |
| 临时隧道 `*.trycloudflare.com` | 免费、免登录、免 token，但每次重启换随机域名，只适合试机 |
| 自定义主机名 | 唯一花钱项：**域名本身的注册费**；域名必须托管在 Cloudflare |
| 带宽上限 | 【未核实】没找到针对个人用途的硬性数值 |

## 6. 泄了怎么办

token = 「能让任何人替这条隧道起连接器、把流量导进你这台机器的本地端口」。所以：

1. 控制台 → 该隧道 → **Refresh token**（立刻作废旧值）；
2. 本机重跑 `node scripts/cf-tunnel-token.mjs --clipboard` 覆盖写入；
3. `bash scripts/tunnel.sh --stop && bash scripts/tunnel.sh --named` 换新进程；
4. 别把 token 贴进任何对话/Issue/截图 —— 需要核对时给 `--show` 的掩码输出就够。
