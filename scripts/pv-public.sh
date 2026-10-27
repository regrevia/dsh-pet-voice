#!/usr/bin/env bash
# 用自己的云服务器转发（拓扑 A：TLS 在本机终止）
#   本机 tls-proxy(8443, 自签 CA)  ←  ssh -R  ←  云服务器 0.0.0.0:8443  →  手机
#
#   scripts/pv-public.sh start     # 起两段；已经在跑就跳过
#   scripts/pv-public.sh status    # 两段进程 + 公网探测
#   scripts/pv-public.sh restart   # DSH 换了端口 / 隧道断了 之后跑这个
#   scripts/pv-public.sh stop
#
# 配置优先级：环境变量 > ~/.dsh/pet-voice/public.env > local/server.env
#   PV_SSH=user@1.2.3.4  PV_SSH_KEY=/path/key.pem  PV_REMOTE_PORT=8443
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
# shellcheck source=lib/pv-base.sh
. "$HERE/lib/pv-base.sh"

RUN_DIR=${PV_RUN_DIR:-$HOME/.dsh/pet-voice/run}
mkdir -p "$RUN_DIR"

for f in "$HOME/.dsh/pet-voice/public.env" "$ROOT/local/server.env"; do
  if [ -f "$f" ]; then set -a; . "$f"; set +a; fi
done

PV_REMOTE_PORT=${PV_REMOTE_PORT:-8443}
PV_SSH=${PV_SSH:-${SERVER_USER:+$SERVER_USER@}${SERVER_HOST:-}}
PV_SSH_KEY=${PV_SSH_KEY:-${SERVER_KEY:-}}
PV_PUBLIC=${PV_PUBLIC:-${SERVER_HOST:+https://$SERVER_HOST:$PV_REMOTE_PORT}}

CA=$HOME/.dsh/pet-voice/tls/pet-ca.pem
PROXY_PID=$RUN_DIR/tls-proxy.pid
TUNNEL_PID=$RUN_DIR/tunnel.pid

die() { echo "$*" >&2; exit 1; }

local_port() {
  local base
  base=$(pv_base) || return 1
  printf '%s' "$base" | sed -n 's#.*:\([0-9][0-9]*\)/pet-voice$#\1#p'
}

port_up() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null; }

proxy_running() { pid_alive "$PROXY_PID" && port_up 8443; }
# 只看 pid 文件会骗人：ssh -R 可能活着但 pid 文件丢了（上次手工起的、或进程重启后没回写），
# 那 status 就说「没跑」、keepalive 再起一个，结果 remote 8443 被占住、新连接立刻失败。
# 所以 pid 文件失效时按命令行找活的 ssh -R，找到就把 pid 写回去（自愈），别重复起。
tunnel_running() {
  local p
  p=$(cat "$TUNNEL_PID" 2>/dev/null)
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then return 0; fi
  p=$(pgrep -f "R 0.0.0.0:${PV_REMOTE_PORT}:127.0.0.1:8443" 2>/dev/null | head -1)
  [ -n "$p" ] || return 1
  mkdir -p "$RUN_DIR" && printf '%s\n' "$p" >"$TUNNEL_PID"
  return 0
}

wait_for() { # wait_for <秒> <命令...>
  local n=$(( $1 * 5 )); shift
  while [ "$n" -gt 0 ]; do "$@" && return 0; n=$((n-1)); sleep 0.2; done
  return 1
}

public_code() {
  [ -n "$PV_PUBLIC" ] && [ -f "$CA" ] || { echo ""; return 0; }
  curl -s -m 8 ${CA:+--cacert "$CA"} -o /dev/null -w '%{http_code}' \
    "${PV_PUBLIC%/}/pet-voice/api/state" 2>/dev/null || echo ""
}

cmd_start() {
  [ -n "$PV_SSH" ] || die "没配云服务器：设 PV_SSH=user@host，或写进 ~/.dsh/pet-voice/public.env"
  local port
  port=$(local_port) || die "找不到在跑的 DSH：先启动 DSH Web"

  if proxy_running; then
    echo "· 本机 8443 反代已在跑（pid $(cat "$PROXY_PID")）"
  else
    echo "· 起本机 8443 反代 → 127.0.0.1:$port"
    nohup node "$ROOT/scripts/tls-proxy.mjs" --quiet --upstream "127.0.0.1:$port" \
      >"$RUN_DIR/tls-proxy.log" 2>&1 &
    echo $! >"$PROXY_PID"
    wait_for 10 port_up 8443 || die "8443 没起来，看 $RUN_DIR/tls-proxy.log"
  fi

  if tunnel_running; then
    echo "· ssh -R 隧道已在跑（pid $(cat "$TUNNEL_PID")）"
  else
    local keyopt=()
    [ -n "$PV_SSH_KEY" ] && keyopt=(-i "$PV_SSH_KEY")
    echo "· 起 ssh -R：$PV_SSH 的 $PV_REMOTE_PORT → 本机 8443"
    nohup ssh -N -T "${keyopt[@]}" \
      -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      -R "0.0.0.0:$PV_REMOTE_PORT:127.0.0.1:8443" "$PV_SSH" \
      >"$RUN_DIR/tunnel.log" 2>&1 &
    echo $! >"$TUNNEL_PID"
    sleep 2
    pid_alive "$TUNNEL_PID" || die "隧道没起来，看 $RUN_DIR/tunnel.log"
  fi

  local code
  code=$(public_code)
  case "$code" in
    401) echo "· 公网 ${PV_PUBLIC%/}/pet-voice/ 通（401 = 鉴权生效，正常）" ;;
    200) echo "· 公网 ${PV_PUBLIC%/}/pet-voice/ 通（200）" ;;
    "") echo "· 没配 PV_PUBLIC 或没有本机 CA，跳过公网探测" ;;
    *) echo "· 公网探测不理想：HTTP ${code}（安全组/防火墙或服务器端口未放行）" ;;
  esac
  echo "面板「连上手机 → 自建域名」填：${PV_PUBLIC%/}"
}

cmd_stop() {
  for pair in "$TUNNEL_PID:ssh 隧道" "$PROXY_PID:8443 反代"; do
    local f=${pair%%:*} name=${pair#*:}
    if pid_alive "$f"; then kill "$(cat "$f")" 2>/dev/null || true; echo "· 已停 $name"; fi
    rm -f "$f"
  done
}

cmd_status() {
  local port code
  port=$(local_port) && echo "· DSH 端口 $port" || echo "· DSH 没在跑"
  if proxy_running; then echo "· 8443 反代 在跑"; else echo "· 8443 反代 没跑"; fi
  if tunnel_running; then echo "· ssh -R 在跑（→ $PV_SSH 的 ${PV_REMOTE_PORT}）"; else echo "· ssh -R 没跑"; fi
  code=$(public_code)
  if [ -z "$code" ]; then echo "· 公网 跳过（缺 PV_PUBLIC 或 CA）"; else echo "· 公网 HTTP $code"; fi
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; sleep 1; cmd_start ;;
  status) cmd_status ;;
  *) die "用法：$0 start|stop|restart|status" ;;
esac
