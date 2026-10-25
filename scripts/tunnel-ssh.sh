#!/usr/bin/env bash
# 用你已有的云服务器做 SSH 反向隧道：把本机 https:8443（tls-proxy）搬到服务器上，端口不变。
#
#   bash scripts/tunnel-ssh.sh --check     # 只测 SSH 能不能连（不改任何东西）
#   bash scripts/tunnel-ssh.sh --dry-run   # 打印要执行的命令（主机/用户掩码）
#   bash scripts/tunnel-ssh.sh --start     # 前台跑，Ctrl-C 停
#   bash scripts/tunnel-ssh.sh --daemon    # 后台跑（优先 autossh），pid 写 local/tunnel.pid
#   bash scripts/tunnel-ssh.sh --stop      # 停掉 --daemon 起的那个
#
# 前置：
#   1) bash scripts/import-server-creds.sh <凭据文件>   → local/server.env（600，已 gitignore）
#   2) bash scripts/tls-ca.sh --ip 你的服务器公网IP      → 证书 + App 内置 CA
#   3) node scripts/tls-proxy.mjs --quiet &              → 本机 https:8443
#   4) 云服务器：安全组放行 8443；sshd 允许 GatewayPorts clientspecified
#      （不配也行，那就把 -R 的 0.0.0.0 去掉、只给服务器本机用）
#
# 443 不需要、域名不需要、备案不需要：裸 IP + 高端口。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SELF_DIR/.." && pwd)"
ENV_FILE="${SERVER_ENV:-${ROOT}/local/server.env}"
PID_FILE="${ROOT}/local/tunnel.pid"
LOG_FILE="${ROOT}/local/tunnel.log"
PORT="${TUNNEL_PORT:-8443}"
LOCAL_PORT="${TUNNEL_LOCAL_PORT:-${PORT}}"
CONNECT_TIMEOUT="${TUNNEL_CONNECT_TIMEOUT:-8}"
MODE=""

die() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$1"; }
mask_host() { local h=$1; case "$h" in *.*.*.*) echo "${h%%.*}.***.***.${h##*.}";; *) echo "${h:0:2}***${h: -3}";; esac; }
mask_user() { local u=$1; echo "${u:0:1}***${u: -1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check; shift ;;
    --dry-run) MODE=dry; shift ;;
    --start) MODE=start; shift ;;
    --daemon) MODE=daemon; shift ;;
    --stop) MODE=stop; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --help|-h) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done
[ -n "$MODE" ] || { echo "用法：bash scripts/tunnel-ssh.sh --check|--dry-run|--start|--daemon|--stop" >&2; exit 2; }

if [ "$MODE" = stop ]; then
  [ -f "$PID_FILE" ] || { echo "没有在跑的隧道（缺 ${PID_FILE}）"; exit 0; }
  PID=$(cat "$PID_FILE")
  if kill "$PID" 2>/dev/null; then echo "已停 pid $PID"; else echo "pid $PID 已经不在了"; fi
  rm -f "$PID_FILE"
  exit 0
fi

[ -f "$ENV_FILE" ] || die "缺 $ENV_FILE → 先跑 bash scripts/import-server-creds.sh <你的凭据文件>"
MODE_FILE=$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE")
[ "$MODE_FILE" = "600" ] || warn "$ENV_FILE 权限是 ${MODE_FILE}（建议 chmod 600）"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

HOST="${SERVER_HOST:-}"; USER="${SERVER_USER:-}"; SPORT="${SERVER_SSH_PORT:-22}"; KEY="${SERVER_KEY:-NEED_FILL}"
[ -n "$HOST" ] && [ "$HOST" != NEED_FILL ] || die "server.env 里 SERVER_HOST 还是空的"
[ -n "$USER" ] && [ "$USER" != NEED_FILL ] || die "server.env 里 SERVER_USER 还是空的"
KEYARGS=()
if [ "$KEY" != NEED_FILL ] && [ -n "$KEY" ]; then
  KEY_EXPANDED="${KEY/#\~/$HOME}"
  [ -f "$KEY_EXPANDED" ] && KEYARGS=(-i "$KEY_EXPANDED") || warn "私钥 $KEY 不存在，先试默认密钥"
fi

# bash 3.2 在 set -u 下展开空数组会报 unbound，所以分开拼
SSH_COMMON=(-p "$SPORT")
if [ "${#KEYARGS[@]}" -gt 0 ]; then SSH_COMMON+=("${KEYARGS[@]}"); fi
SSH_COMMON+=(-o ConnectTimeout="$CONNECT_TIMEOUT" -o StrictHostKeyChecking=accept-new)
TARGET="${USER}@${HOST}"
FWD="0.0.0.0:${PORT}:127.0.0.1:${LOCAL_PORT}"

echo "服务器：$(mask_user "$USER")@$(mask_host "$HOST"):${SPORT}"
echo "转发：服务器 :${PORT}  →  本机 127.0.0.1:${LOCAL_PORT}"
echo

case "$MODE" in
  dry)
    echo "将执行："
    echo "  ssh -N -R ${FWD} ${SSH_COMMON[*]} -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ${TARGET}"
    echo "（主机/用户已掩码，实际命令由脚本自己拼，不会写进仓库）"
    ;;
  check)
    if [ -n "${SERVER_PASSWORD:-}" ] && [ "${#KEYARGS[@]}" -eq 0 ]; then
      warn "server.env 里有密码但没找到私钥：脚本不会用密码登录（BatchMode）。先 ssh-copy-id 装公钥。"
    fi
    printf '  连接测试…'
    if ssh "${SSH_COMMON[@]}" -o BatchMode=yes "$TARGET" true 2>/tmp/tunnel-ssh-check.err; then
      printf '\r'; ok "SSH 能连（$(mask_host "$HOST"):${SPORT}）"
    else
      printf '\r'; ERR=$(tr '\n' ' ' < /tmp/tunnel-ssh-check.err | cut -c1-180)
      printf '  \033[31m✗\033[0m 连不上：%s\n' "${ERR:-超时}"
      echo
      echo "  常见原因：安全组没放行 ${SPORT}／用户不存在／公钥没装（ssh-copy-id）／IP 变了"
      exit 1
    fi
    if command -v sshpass >/dev/null 2>&1 && [ -n "${SERVER_PASSWORD:-}" ] && [ "${#KEYARGS[@]}" -eq 0 ]; then
      warn "装了 sshpass，但脚本刻意不用密码登录；请改用公钥"
    fi
    ;;
  start|daemon)
    # 隧道指向本机 tls-proxy（https），所以用 https + -k 探活；200/401 都算活着
    code=$(curl -sk -m 5 -o /dev/null -w '%{http_code}' "https://127.0.0.1:${LOCAL_PORT}/pet-voice/api/state" || echo 000)
    if [ "$code" = "200" ] || [ "$code" = "401" ]; then
      ok "本机 tls-proxy 在跑（https:${LOCAL_PORT} → ${code}）"
    else
      warn "本机 https:${LOCAL_PORT} 没响应（${code}）：先 node scripts/tls-proxy.mjs --quiet &"
    fi
    FORWARD_ARGS=(-N -R "$FWD" "${SSH_COMMON[@]}" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 "$TARGET")
    if [ "$MODE" = start ]; then
      echo "前台跑（Ctrl-C 停）：手机填 https://$(mask_host "$HOST"):${PORT}/pet-voice/"
      exec ssh "${FORWARD_ARGS[@]}"
    fi
    if command -v autossh >/dev/null 2>&1; then
      say="autossh"; CMD=(autossh -M 0 "${FORWARD_ARGS[@]}")
    else
      say="ssh（没装 autossh，断了不会自动重连：brew install autossh）"; CMD=(ssh "${FORWARD_ARGS[@]}")
    fi
    nohup "${CMD[@]}" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      ok "已后台启动（${say}），pid $(cat "$PID_FILE")，日志 local/tunnel.log"
      echo "  手机地址：https://$(mask_host "$HOST"):${PORT}/pet-voice/"
      echo "  停掉：bash scripts/tunnel-ssh.sh --stop"
    else
      die "启动失败，看 local/tunnel.log（大概是 GatewayPorts 没开或端口被占）"
    fi
    ;;
esac
