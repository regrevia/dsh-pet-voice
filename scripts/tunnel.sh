#!/usr/bin/env bash
# 起 cloudflared 隧道，把公网地址写回 ~/.dsh/pet-voice/xiaoai-url.txt。
#
# 两种模式：
#   快速隧道（默认，匿名，域名每次变）      scripts/tunnel.sh
#   自己的 Cloudflare 账号 + 自己的域名    scripts/tunnel.sh --named
#
# 命名隧道需要你先把两样东西放好（都不进 git，权限 600）：
#   ~/.dsh/pet-voice/cloudflared.token   → Cloudflare Zero Trust 里那个 tunnel 的 token
#   ~/.dsh/pet-voice/cloudflared.host    → 隧道已绑定的公开主机名，例如 pet.example.com
# 用法：在 Cloudflare 控制台建 tunnel → 添加 Public Hostname
#   （子域 pet、域 example.com、Service http://127.0.0.1:52356），然后复制 token。
#
# 约定：
#   * token 只从文件读进子进程环境变量 TUNNEL_TOKEN，绝不打屏、绝不写进日志/命令行参数；
#   * ?k= 用 xiaoai.json 里已有的 urlSecret —— 只写进文件（chmod 600），绝不打屏；
#   * 隧道进程 nohup 拉起到 ~/.dsh/pet-voice/tunnel.log，脚本只打印 PID + 日志路径，
#     不会把隧道「挂」在脚本里；想收掉：scripts/tunnel.sh --stop；
#   * 写完后手机页面/引导卡的 /api/pair 会读到新域名（探活约 1.5 s 内变绿）。
set -euo pipefail

PV_DIR="${HOME}/.dsh/pet-voice"
URL_FILE="${PV_DIR}/xiaoai-url.txt"
XIAOAI="${PV_DIR}/xiaoai.json"
LOG="${PV_DIR}/tunnel.log"
PID_FILE="${PV_DIR}/tunnel.pid"
TOKEN_FILE="${PV_DIR}/cloudflared.token"
HOST_FILE="${PV_DIR}/cloudflared.host"
BASE_PATH="/pet-voice/api/xiaoai"

usage() {
  cat <<'EOF'
用法: scripts/tunnel.sh [--check] [--stop] [--named|--quick] [端口]

  (无参数)        快速隧道（匿名，https://*.trycloudflare.com，重启就换域名）
  --named        用你自己的 Cloudflare 账号/域名（读 cloudflared.token + cloudflared.host）
  --quick        强制走快速隧道（即使 token 文件存在）
  --check [端口]  只校验依赖/端口/凭据是否齐，不启动、不写文件（冒烟测试）
  --stop         停掉本脚本上次起的隧道（读 tunnel.pid）

环境变量: PV_PORT        默认端口（默认 52356）
          TUNNEL_WAIT    等域名的最长秒数（默认 40；命名隧道默认 20）
          PV_CF_HOST     等价于 cloudflared.host 文件（优先级更高）
EOF
}

find_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return 0
  fi
  local bundled="${HOME}/.dsh/profiles/desktop/node_modules/cloudflared/bin/cloudflared"
  if [ -x "$bundled" ]; then
    printf '%s\n' "$bundled"
    return 0
  fi
  if command -v npx >/dev/null 2>&1; then
    printf 'npx --yes cloudflared\n'
    return 0
  fi
  return 1
}

stop_tunnel() {
  if [ ! -f "$PID_FILE" ]; then
    echo "没有 tunnel.pid，可能不是本脚本起的；手动停：pkill -f 'cloudflared tunnel'"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" && echo "已停掉隧道进程 ${pid} （旧域名随即失效）"
  else
    echo "PID ${pid:-none} 已经不在了"
  fi
  rm -f "$PID_FILE"
  # nohup/包装层可能让记录下来的 PID 和真实 cloudflared 不是同一个，按命令行兜底清一遍。
  pkill -f "cloudflared tunnel --url http://127.0.0.1:" 2>/dev/null || true
  pkill -f "cloudflared tunnel --no-autoupdate run" 2>/dev/null || true
}

# 命名隧道要的主机名：环境变量优先，其次文件；去掉可能带的 scheme 和结尾斜杠。
named_host() {
  local raw="${PV_CF_HOST:-}"
  if [ -z "$raw" ] && [ -f "$HOST_FILE" ]; then
    raw="$(head -1 "$HOST_FILE" | tr -d '\r\n ')"
  fi
  raw="${raw#https://}"; raw="${raw#http://}"; raw="${raw%%/*}"
  printf '%s' "$raw"
}

MODE="run"
TUNNEL_KIND=""
source "$(dirname "$0")/lib/pv-base.sh" 2>/dev/null || true
PORT="${PV_PORT:-$(pv_base 2>/dev/null | sed -n 's#.*:\([0-9][0-9]*\)/pet-voice$#\1#p')}"
PORT="${PORT:-54013}"
for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --check) MODE="check" ;;
    --stop) MODE="stop" ;;
    --named) TUNNEL_KIND="named" ;;
    --quick) TUNNEL_KIND="quick" ;;
    ''|*[!0-9]*) echo "无法识别的参数：$arg" >&2; usage >&2; exit 2 ;;
    *) PORT="$arg" ;;
  esac
done

if [ "$MODE" = "stop" ]; then
  stop_tunnel
  exit 0
fi

# 没显式指定时：有 token 文件就走命名隧道，否则快速隧道。
if [ -z "$TUNNEL_KIND" ]; then
  if [ -s "$TOKEN_FILE" ]; then TUNNEL_KIND="named"; else TUNNEL_KIND="quick"; fi
fi

BIN="$(find_cloudflared || true)"
if [ -z "$BIN" ]; then
  echo "找不到 cloudflared。任选一种装法：" >&2
  echo "  brew install cloudflared" >&2
  echo "  npx --yes cloudflared --version   # 临时用 npx" >&2
  exit 1
fi

CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:${PORT}/pet-voice/" || true)"
case "$CODE" in
  200|303|401) : ;; # 有 response 就算宿主活着（401 = 没带 cookie，正常）
  *) echo "端口 ${PORT} 上没响应（HTTP ${CODE:-000}）：宿主没起？先确认 deepseek harness 在跑。" >&2; exit 1 ;;
esac

HOST=""
if [ "$TUNNEL_KIND" = "named" ]; then
  if [ ! -s "$TOKEN_FILE" ]; then
    echo "缺少 ${TOKEN_FILE}（cloudflared tunnel 的 token，0600）。" >&2
    echo "去 Cloudflare Zero Trust → Networks → Tunnels 建一条，复制 token 存进去：" >&2
    echo "  install -m 600 /dev/stdin ${TOKEN_FILE}   # 然后粘贴 token + 回车 + Ctrl-D" >&2
    exit 1
  fi
  HOST="$(named_host)"
  if [ -z "$HOST" ]; then
    echo "缺少主机名：写进 ${HOST_FILE}，或 export PV_CF_HOST=pet.example.com" >&2
    echo "（必须是这条 tunnel 上已经加好的 Public Hostname）" >&2
    exit 1
  fi
fi

if [ ! -f "$XIAOAI" ]; then
  echo "缺少 ${XIAOAI}（urlSecret 在里面）。先在小爱功能里跑一次让插件生成。" >&2
  exit 1
fi

if [ "$MODE" = "check" ]; then
  echo "OK cloudflared=${BIN}"
  echo "OK 端口 ${PORT} 有响应"
  echo "OK xiaoai.json 存在（urlSecret 不打印）"
  if [ "$TUNNEL_KIND" = "named" ]; then
    echo "OK 命名隧道：token 文件存在（内容不打印），主机名 ${HOST}"
    # 深校验：token 结构（base64 JSON: a/t/s）+ 主机名格式，复用落盘脚本的 --check。
    SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
    DEEP="$SELF_DIR/cf-tunnel-token.mjs"
    if [ -f "$DEEP" ] && command -v node >/dev/null 2>&1; then
      if node "$DEEP" --check --quiet --dest-token "$TOKEN_FILE" --dest-host "$HOST_FILE" >/dev/null 2>&1; then
        echo "OK token/host 深校验通过（cf-tunnel-token.mjs --check）"
      else
        echo "FAIL token 或 host 不合格，明细：" >&2
        node "$DEEP" --check --dest-token "$TOKEN_FILE" --dest-host "$HOST_FILE" >&2 || true
        exit 1
      fi
    else
      echo "SKIP 深校验（缺 node 或 scripts/cf-tunnel-token.mjs）"
    fi
  else
    echo "OK 快速隧道（匿名 trycloudflare，域名每次变；要固定就用 --named）"
  fi
  echo "OK 将写入 ${URL_FILE}（chmod 600）"
  exit 0
fi

mkdir -p "$PV_DIR"
if [ "$TUNNEL_KIND" = "named" ]; then
  # token 走子进程环境变量，不进 argv（ps 看不到），也不进日志。
  TUNNEL_TOKEN="$(cat "$TOKEN_FILE")" nohup $BIN tunnel --no-autoupdate run \
    > "$LOG" 2>&1 &
  WAIT="${TUNNEL_WAIT:-20}"
else
  nohup $BIN tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate --protocol http2 \
    > "$LOG" 2>&1 &
  WAIT="${TUNNEL_WAIT:-40}"
fi
TUNNEL_PID=$!
printf '%s\n' "$TUNNEL_PID" > "$PID_FILE"
chmod 600 "$PID_FILE"
echo "隧道进程 PID=${TUNNEL_PID} （$([ "$TUNNEL_KIND" = named ] && echo 命名隧道 || echo 快速隧道)），日志 ${LOG}"

DOMAIN=""
if [ "$TUNNEL_KIND" = "named" ]; then
  # 命名隧道不会把域名打进日志；直接探自己的主机名，通了就算起来。
  for _ in $(seq 1 "$WAIT"); do
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo "隧道进程退出了，看日志：$LOG" >&2
      tail -n 3 "$LOG" >&2 || true
      exit 1
    fi
    DCODE="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "https://${HOST}/pet-voice/" || true)"
    case "$DCODE" in
      200|303|401) DOMAIN="https://${HOST}"; break ;;
    esac
    sleep 1
  done
  [ -z "$DOMAIN" ] && { echo "等了 ${WAIT}s，https://${HOST}/pet-voice/ 还没通（HTTP ${DCODE:-000}）。检查 DNS/证书/隧道路由是否指到 127.0.0.1:${PORT}。日志：$LOG" >&2; exit 1; }
else
  for _ in $(seq 1 "$WAIT"); do
    DOMAIN="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1 || true)"
    [ -n "$DOMAIN" ] && break
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo "隧道进程退出了，看日志：$LOG" >&2
      tail -n 3 "$LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done
  [ -z "$DOMAIN" ] && { echo "等了 ${WAIT}s 没抓到 trycloudflare 域名，日志：$LOG" >&2; exit 1; }
fi

# urlSecret 只在子 shell 里读一次，直接拼进文件；任何路径都不 echo 它。
( umask 077; python3 - "$XIAOAI" "$URL_FILE" "$DOMAIN" "$BASE_PATH" <<'PY'
import json, sys, pathlib
cfg, out, domain, base = sys.argv[1:5]
secret = json.load(open(cfg)).get('urlSecret') or ''
if not secret:
    sys.exit('xiaoai.json 里没有 urlSecret')
pathlib.Path(out).write_text(f"{domain}{base}?k={secret}\n", encoding='utf-8')
PY
)
chmod 600 "$URL_FILE"

echo "新地址已写入 ${URL_FILE}（chmod 600），手机页面/引导卡会读到新域名"
echo "公网地址：${DOMAIN}/pet-voice/   （不含令牌，可以截图）"
echo "收掉隧道：scripts/tunnel.sh --stop"
