#!/usr/bin/env bash
# SSH 反向隧道看门狗：ssh 掉了就自己拉起来（这台机器没装 autossh 时的替代）。
#
#   bash scripts/tunnel-keepalive.sh --daemon   # 后台常驻，日志 local/keepalive.log
#   bash scripts/tunnel-keepalive.sh --once     # 只检查/修一次（给 cron/launchd 用）
#   bash scripts/tunnel-keepalive.sh --status   # 打印当前状态
#   bash scripts/tunnel-keepalive.sh --stop
#
# 判据只有一条：local/tunnel.pid 里的进程还活着吗。隧道自己断网时 ssh 会因为
# ServerAliveInterval=30/ServerAliveCountMax=3 在 ~90 s 内退出，pid 变死，这里再拉起。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SELF_DIR/.." && pwd)"
PID_FILE="${ROOT}/local/tunnel.pid"
KPID_FILE="${ROOT}/local/keepalive.pid"
LOG_FILE="${ROOT}/local/keepalive.log"
INTERVAL="${KEEPALIVE_INTERVAL:-20}"
TUNNEL="${ROOT}/scripts/tunnel-ssh.sh"

say() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG_FILE"; }

tunnel_alive() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

ensure() {
  if tunnel_alive; then
    return 0
  fi
  say "隧道不在，拉起…"
  if bash "$TUNNEL" --daemon >>"$LOG_FILE" 2>&1; then
    say "已拉起，pid $(cat "$PID_FILE" 2>/dev/null || echo '?')"
  else
    say "拉起失败，下一轮再试"
  fi
}

case "${1:---daemon}" in
  --status)
    if tunnel_alive; then echo "隧道在跑，pid $(cat "$PID_FILE")"; else echo "隧道没在跑"; fi
    ;;
  --once)
    ensure
    ;;
  --stop)
    if [ -f "$KPID_FILE" ]; then kill "$(cat "$KPID_FILE")" 2>/dev/null || true; rm -f "$KPID_FILE"; fi
    echo "看门狗已停（隧道本身还在跑，用 scripts/tunnel-ssh.sh --stop 收）"
    ;;
  --daemon)
    if [ -f "$KPID_FILE" ] && kill -0 "$(cat "$KPID_FILE")" 2>/dev/null; then
      echo "看门狗已在跑，pid $(cat "$KPID_FILE")"; exit 0
    fi
    ensure
    nohup bash "$SELF_DIR/$(basename "$0")" --loop >>"$LOG_FILE" 2>&1 &
    echo $! >"$KPID_FILE"
    echo "看门狗已启动，pid $(cat "$KPID_FILE")，每 ${INTERVAL}s 检查，日志 local/keepalive.log"
    ;;
  --loop)
    say "看门狗启动，间隔 ${INTERVAL}s"
    while :; do
      ensure
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "用法：$0 [--daemon|--once|--status|--stop]" >&2; exit 2 ;;
esac
