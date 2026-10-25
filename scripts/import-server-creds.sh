#!/usr/bin/env bash
# 盲导入服务器凭据：只做「逐字节拷贝 + 掩码汇总」，脚本本身从不打印文件内容。
#
#   bash scripts/import-server-creds.sh <凭据文件路径>
#
# 产物（全部 0600，目录里带 README 说明，已被 .gitignore 忽略）：
#   local/server-creds.src   源文件原样副本（不解析、不改写、不外传）
#   local/server.env         抽出来的字段（host/user/port/key/密码），没抽到的留空由你手填
#   local/README.txt         一句话说明：本地配置文件，别提交、别贴聊天
#
# 打印出来只有：文件指纹、大小、行数、识别到哪些字段（全部掩码）。密码只报长度。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SELF_DIR/.." && pwd)"
DST_DIR="${ROOT}/local"
SRC="${1:-}"
[ -n "$SRC" ] || { echo "用法：bash scripts/import-server-creds.sh <凭据文件路径>" >&2; exit 2; }
[ -f "$SRC" ] || { echo "不是普通文件或不存在：$SRC" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "缺 python3" >&2; exit 1; }

# 源文件如果已经在仓库里且被 git 跟踪，那是已经泄露的状态，必须喊出来（不打印内容）
if git -C "$ROOT" ls-files --error-unmatch "$SRC" >/dev/null 2>&1; then
  printf '\033[31m⚠️  这个文件正被 git 跟踪，可能已经在历史里了。\033[0m\n' >&2
  printf '   建议：git rm --cached "%s" 后重新提交，并考虑轮换这些凭据。\n' "$SRC" >&2
fi

umask 077
mkdir -p "$DST_DIR"
chmod 700 "$DST_DIR"

cp "$SRC" "$DST_DIR/server-creds.src"
chmod 600 "$DST_DIR/server-creds.src"

cat > "$DST_DIR/README.txt" <<'TXT'
本目录是本地私有配置文件，已被 .gitignore 忽略，永远不要提交、不要贴到对话/截图里。
- server-creds.src  你给的凭据文件的原样副本
- server.env        抽出来的 SSH 字段；缺的（写 NEED_FILL）请自己补齐
用完可以整个删掉（rm -rf local/），不影响仓库里的任何东西。
TXT
chmod 600 "$DST_DIR/README.txt"

# 解析在 python 里做，只输出掩码；原始值只写进 server.env
/usr/bin/python3 - "$DST_DIR/server-creds.src" "$DST_DIR/server.env" <<'PY'

import io, os, re, sys, hashlib, time

src, out = sys.argv[1], sys.argv[2]
raw = io.open(src, 'rb').read()
text = raw.decode('utf-8', 'replace')


def mask_ip(m):
    p = m.split('.')
    return '%s.***.***.%s' % (p[0], p[-1]) if len(p) == 4 else '***'


def mask_host(h):
    return (h[0] + '***') if len(h) <= 4 else ('%s***%s' % (h[:2], h[-3:]))


def mask_user(u):
    return (u[0] + '*') if len(u) <= 2 else ('%s***%s' % (u[0], u[-1]))


found = {}

# 1) dotenv 风格：KEY=VALUE（lunamind.local.env / .env 这类）
env = {}
for line in text.splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    k = k.strip()
    v = v.strip().strip('"').strip("'")
    if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) and v:
        env[k.upper()] = v


def pick(*subs, exclude=()):
    for k, v in env.items():
        kl = k.lower()
        if any(s in kl for s in subs) and not any(e in kl for e in exclude):
            return v
    return None


hp = pick('host', 'addr', 'ip', exclude=('user', 'pass', 'port', 'key', 'path', 'url'))
if hp:
    found['SERVER_HOST'] = hp
up = pick('user', 'login', 'account')
if up:
    found['SERVER_USER'] = up
pp = pick('port')
if pp and pp.isdigit():
    found['SERVER_SSH_PORT'] = pp
kp = pick('key_path', 'identity', 'private_key', 'keyfile', 'pem', 'ssh_key')
if kp:
    found['SERVER_KEY'] = kp
pw = pick('pass', 'pwd')
if pw:
    found['SERVER_PASSWORD'] = pw

# 2) 标签风格：host: x / 用户名 = y
m = re.search(r'(?im)^\s*(?:host|主机|ip|地址|服务器)\s*[:：=]\s*`?([A-Za-z0-9_.:\-]+)', text)
if m and 'SERVER_HOST' not in found:
    found['SERVER_HOST'] = m.group(1)
m = re.search(r'(?im)^\s*(?:user|username|用户|用户名|账号|登录用户|login)\s*[:：=]\s*`?([A-Za-z0-9_.@\-]+)', text)
if m and 'SERVER_USER' not in found:
    found['SERVER_USER'] = m.group(1)
if 'SERVER_USER' not in found:
    m = re.search(r'\bssh\s+(?:-i\s+\S+\s+)?([A-Za-z0-9_.\-]+)@([A-Za-z0-9_.:\-]+)', text)
    if m:
        found['SERVER_USER'] = m.group(1)
        found.setdefault('SERVER_HOST', m.group(2))
m = re.search(r'(?im)(?:port|端口|-p)\s*[:：=\s]\s*(\d{1,5})', text)
if m and 'SERVER_SSH_PORT' not in found:
    found['SERVER_SSH_PORT'] = m.group(1)
m = re.search(r'((?:~|/)[\w./\-]*(?:id_rsa|id_ed25519|id_ecdsa)[\w.]*)', text)
if m and 'SERVER_KEY' not in found:
    found['SERVER_KEY'] = m.group(1)
elif 'SERVER_KEY' not in found:
    m = re.search(r'ssh\s+-i\s+(\S+)', text)
    if m:
        found['SERVER_KEY'] = m.group(1)
m = re.search(r'(?im)^\s*(?:password|passwd|密码|pwd)\s*[:：=]\s*`?(\S+)', text)
if m and 'SERVER_PASSWORD' not in found:
    found['SERVER_PASSWORD'] = m.group(1)

# 3) 兜底：文件里出现的第一个 IP / 域名
if 'SERVER_HOST' not in found:
    ips = re.findall(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', text)
    doms = re.findall(r'\b(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+(?:com|cn|net|org|io|xyz|top|dev|app)\b', text, re.I)
    if ips:
        found['SERVER_HOST'] = ips[0]
    elif doms:
        found['SERVER_HOST'] = doms[0]

found.setdefault('SERVER_SSH_PORT', '22')

lines = [
    '# 本地配置文件 —— 已被 .gitignore 忽略，不要提交、不要贴到对话里',
    '# 源文件 SHA-256: %s' % hashlib.sha256(raw).hexdigest(),
    '# 生成时间: %s' % time.strftime('%Y-%m-%d %H:%M:%S'),
    '',
]
order = ['SERVER_HOST', 'SERVER_USER', 'SERVER_SSH_PORT', 'SERVER_KEY', 'SERVER_PASSWORD']
for k in order:
    v = found.get(k) or 'NEED_FILL'
    lines.append('%s=%s' % (k, v))
io.open(out, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
os.chmod(out, 0o600)

print('源文件：%d 字节，%d 行，SHA-256 %s…' % (len(raw), text.count('\n') + 1, hashlib.sha256(raw).hexdigest()[:16]))
print('识别到的字段（掩码）：')
for k in order:
    v = found.get(k)
    if not v:
        print('  - %s: 没找到 → 需要你手填' % k)
        continue
    if k == 'SERVER_HOST':
        looks_ip = re.fullmatch(r'(?:\d{1,3}\.){3}\d{1,3}', v) is not None
        print('  - %s: %s' % (k, mask_ip(v) if looks_ip else mask_host(v)))
    elif k == 'SERVER_USER':
        print('  - %s: %s' % (k, mask_user(v)))
    elif k == 'SERVER_PASSWORD':
        print('  - %s: <%d 字符>（只写进 server.env，不显示）' % (k, len(v)))
    elif k == 'SERVER_KEY':
        print('  - %s: %s' % (k, v if v != 'NEED_FILL' else '没找到'))
    else:
        print('  - %s: %s' % (k, v))

PY

chmod 600 "$DST_DIR/server.env"
echo
echo "已写入："
echo "  local/server-creds.src  （原样副本，600）"
echo "  local/server.env        （抽出的字段，600）"
echo "  local/README.txt        （本地文件说明）"
echo "确认忽略："
git -C "$ROOT" check-ignore -v local/server.env || echo "  ⚠️ local/ 还没被 .gitignore 覆盖，请补上"
echo
echo "下一步（443 开不了也没关系，用 8443）："
echo "  sqlite 不需要；把 SERVER_HOST/USER 补进 server.env 后，隧道只需要高端口，不需要备案。"
