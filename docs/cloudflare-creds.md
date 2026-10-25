# Cloudflare 凭证：安全落盘 + 校验

> 目标：你在 Cloudflare 后台点出来的那几行（帐户 ID / API 令牌 / 访问密钥 ID / 秘密访问密钥 / S3 端点）
> 一条命令解析、验活、按 0600 存好，**全程不打印明文**，也不会进 shell 历史。

## 1. 用法

```bash
# 推荐：先把 Cloudflare 页面上的那几行整段复制，然后
node scripts/cf-creds.mjs --clipboard          # macOS 直接读剪贴板
# 或者：终端里跑 node scripts/cf-creds.mjs ，整段粘贴完按 Ctrl-D

# 已经保存过，想复查（会重新联网验活）
node scripts/cf-creds.mjs --check

# 只看掩码（不联网）
node scripts/cf-creds.mjs --show --offline

# 只做形状校验，不联网（不建议，除非网络确实不通）
node scripts/cf-creds.mjs --offline
```

成功时输出长这样（值已打码）：

```
解析结果（值一律打码）：
  帐户 ID        0123…cdef（32 位）
  API 令牌       Zx9q…_-Ab（41 位）
  访问密钥 ID    ABCD…6789（32 位）
  秘密访问密钥   aaaa…bbbb（64 位）
  S3 API 端点    https://<account>.r2.cloudflarestorage.com

联网验活中…
  ✓ API 令牌有效（状态 active）
  ✓ R2 凭证有效（ListBuckets 200，2 个桶：jingling / jingling-dev）

已写入 /Users/<you>/.dsh/cloudflare/creds.env
  目录权限 700 / 文件权限 600 / 604 B
```

## 2. 它到底做了什么

| 环节 | 行为 |
| --- | --- |
| 解析 | 先按标签行取下一行（中英文标签都认：`帐户 ID` / `Account ID`、`秘密访问密钥` / `Secret Access Key`…）；标签被复制丢了就按形状兜底：32 位小写十六进制=帐户 ID、32 位大写十六进制=访问密钥 ID、64 位十六进制=秘密访问密钥、40 位以上 `A-Za-z0-9_-`=API 令牌 |
| 形状校验 | 帐户 ID `^[0-9a-f]{32}$`；AK 32 位十六进制；SK 64 位十六进制；令牌 ≥40 位；端点必须 `https` 且主机名 == `<帐户ID>.r2.cloudflarestorage.com`（不一致直接拒）。端点没给就由帐户 ID 推导 |
| 联网验活 | ① `GET https://api.cloudflare.com/client/v4/user/tokens/verify`（Bearer）— 验 API 令牌；② R2 S3 `ListBuckets`，用 `node:crypto` 现场算 AWS SigV4（`region=auto`，**不把密钥放进 argv**，所以 `ps` 看不到）— 验 AK/SK 真能开桶 |
| 落盘 | 目录 `~/.dsh/cloudflare` 0700、文件 `creds.env` 0600，同目录临时文件写完 `rename` 原子替换；失败一律不写 |
| 防呆 | 落点若在当前项目目录或任何 git 仓库里 → 拒写（要写必须 `--allow-repo`）：凭证被提交/打包就是把账号送人 |
| 泄密面 | stdout/stderr 只出掩码；不写 shell 历史（`--clipboard` 不经过命令行）；没有 `set -x` |

## 3. 保存后的文件

`~/.dsh/cloudflare/creds.env`：

```bash
export CLOUDFLARE_ACCOUNT_ID=…
export CLOUDFLARE_API_TOKEN=…
export R2_ACCESS_KEY_ID=…
export R2_SECRET_ACCESS_KEY=…
export R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
```

加载：

```bash
set -a; . ~/.dsh/cloudflare/creds.env; set +a
```

`aws s3 ls --endpoint-url "$R2_ENDPOINT"` 之类的 S3 客户端也能直接用这两个键（R2 用 `region=auto`）。

## 4. 轮换与删除

- 轮换：Cloudflare 后台 Roll 一次 → 重跑 `node scripts/cf-creds.mjs --clipboard`（直接覆盖，旧的不会留在本机）。
- 删除：`rm -rf ~/.dsh/cloudflare`（脚本不写别的副本；注意 `/tmp` 里我们没留任何东西）。

## 5. 自测（离线，不需要真凭证）

```bash
node scripts/cf-creds.test.mjs     # 29/29 通过（2026-10-24）
```

覆盖：中文粘贴、英文粘贴、账户与 AK 不混淆、缺字段拒写、端点与帐户不一致拒写、端点推导、幂等覆盖、
文件/目录权限、stdout 不泄露秘密、仓库内拒写、`--check`、空输入。

## 6. 已验证 / 未验证

- 【实测】解析、形状校验、权限 0600/0700、原子落盘、拒写、掩码、`--check --offline`：`scripts/cf-creds.test.mjs` 29/29。
- 【实测】联网验活的**失败路径**：拿假令牌打 `tokens/verify` 返回 `Invalid API Token`，脚本退出码 2 且不落盘；
  S3 那条假帐户的端点 DNS 直接不存在（`fetch failed`），同样不落盘。
- 【未核实】**成功路径**没跑过 —— 我没有你的真凭证，也不应该经手。你跑一次 `--clipboard`，成功就是上面那段打码输出。
- 说明：这对 R2 凭证**不能**当 Cloudflare Tunnel 用。隧道要的是 `cloudflared tunnel token`（`~/.dsh/pet-voice/cloudflared.token`，见
  [`docs/real-device-install.md`](real-device-install.md) §4.2）。R2 我能用来做的是：托管静态资源 / 存 TTS 音频缓存 / 备份宠物数据。
