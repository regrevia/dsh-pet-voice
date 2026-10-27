#!/usr/bin/env bash
# SSH 反向隧道看门狗：ssh 掉了就自己拉起来（这台机器没装 autossh 时的替代）。
#
#   bash scripts/tunnel-keepalive.sh --daemon   # 后台常驻，日志 local/keepalive.log
#   bash scripts/tunnel-keepalive.sh --once     # 只检查/修一次（给 cron/launchd 用）
#   bash scripts/tunnel-keepalive.sh --status   # 打印当前状态
#   bash scripts/tunnel-keepalive.sh --stop
#
# 判据只有一条：公网探测（curl 打公网 /pet-voice/api/pair）回 401/200 就算通。
# 断了就调 pv-public.sh start 把 8443 反代 + ssh -R 一起拉起来。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SELF_DIR/.." && pwd)"
KPID_FILE="${ROOT}/local/keepalive.pid"
LOG_FILE="${ROOT}/local/keepalive.log"
INTERVAL="${KEEPALIVE_INTERVAL:-20}"
TUNNEL="${ROOT}/scripts/tunnel-ssh.sh"

say() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG_FILE"; }

# 隧道、8443 反代、公网口子一起看：都在且公网回 401/200 才算健康。
# （pid 文件归 pv-public.sh 管，这里不再自己记一份，免得两边对不上。）
relay_status() { bash "$ROOT/scripts/pv-public.sh" status 2>/dev/null || true; }

# 判据走 pv-public.sh 的机器可读出口（code / proxy），别 grep 人话。
# 之前这里 sed 的是「公网 HTTP N」，可健康时那行文案是「公网 … 通（401 = 鉴权生效，正常）」，
# 永远匹配不上 → healthy 恒假 → 看门狗每 20s 就「拉起」一次隧道，白折腾还伤链路。
healthy() {
  local code
  # pv-public.sh code：任何 HTTP 状态码都说明链路通（401 = 鉴权生效）；000 = 真不通。
  # 用 || true 兜住 set -e：这里返回非 0 是正常分支，不是脚本错误。
  code=$(bash "$ROOT/scripts/pv-public.sh" code 2>/dev/null) || true
  [ -n "$code" ] && [ "$code" != "000" ]
}

relay_alive() {
  [ "$(bash "$ROOT/scripts/pv-public.sh" proxy 2>/dev/null)" = "ok" ] &&
    bash "$ROOT/scripts/pv-public.sh" status 2>/dev/null | grep -q 'ssh -R 在跑'
}

ensure() {
  if healthy; then
    return 0
  fi
  say "公网不通，拉起 8443 反代 + ssh -R…"
  if bash "$ROOT/scripts/pv-public.sh" start >>"$LOG_FILE" 2>&1; then
    say "已拉起：$(bash "$ROOT/scripts/pv-public.sh" status 2>/dev/null | tr '\n' ' ')"
  else
    say "拉起失败，下一轮再试"
  fi
}

case "${1:---daemon}" in
  --status)
    relay_status
    if healthy; then echo "· 中转链路通（手机能连）"; else echo "· 中转链路不通，下一轮会自己拉起"; fi
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
