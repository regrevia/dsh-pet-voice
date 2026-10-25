#!/usr/bin/env bash
# 找准宿主 /pet-voice 的地址：DSH Web 端口每次启动都可能变，别把端口写死。
#
#   source scripts/lib/pv-base.sh
#   BASE=$(pv_base)            # http://127.0.0.1:54013/pet-voice
#
# 查找顺序：$PV_BASE → $PV_PORT → ~/.dsh/profiles/desktop/pet-voice.port → 本机监听端口挨个试。
# 判定标准是「带令牌能拿到含 versionCode 的 JSON」。别用 /api/state：它要汇总项目与会话，冷启动 4s，
# 超时就会误认到别的服务；也别只认 "ok"，DSH 的 404 响应体里也有 "ok":false。

pv_base() {
  if [ -n "${PV_BASE:-}" ]; then printf '%s\n' "${PV_BASE%/}"; return 0; fi
  if [ -n "${PV_PORT:-}" ]; then printf 'http://127.0.0.1:%s/pet-voice\n' "$PV_PORT"; return 0; fi

  local pf="$HOME/.dsh/profiles/desktop/pet-voice.port" port
  if [ -f "$pf" ]; then
    port=$(node -e 'try{const p=require(process.argv[1]);process.stdout.write(String(p.port||p))}catch(e){}' "$pf" 2>/dev/null)
    if [ -n "$port" ]; then printf 'http://127.0.0.1:%s/pet-voice\n' "$port"; return 0; fi
  fi

  local tok ck body
  tok=$(cat "$HOME/.dsh/pet-voice/token" 2>/dev/null)
  ck="pkv_$(printf %s "$tok" | cut -c1-8)=$tok"

  local cands
  cands=$(
    {
      printf '54013\n52356\n'
      lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p'
    } | awk '!seen[$0]++'
  )
  for port in $cands; do
    if [ -n "$tok" ]; then
      # 探 /api/update：读一个小 json，3~15ms；/api/state 要汇总项目会话，冷启动能到 4s
      body=$(curl -s -m 2 -H "Cookie: $ck" "http://127.0.0.1:${port}/pet-voice/api/update" 2>/dev/null)
      case "$body" in
        *'"versionCode"'*) printf 'http://127.0.0.1:%s/pet-voice\n' "$port"; return 0 ;;
      esac
    else
      case "$(curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/pet-voice/api/state" 2>/dev/null)" in
        401|403) printf 'http://127.0.0.1:%s/pet-voice\n' "$port"; return 0 ;;
      esac
    fi
  done
  return 1
}

# 模拟器里访问宿主用 10.0.2.2，把 pv_base 的结果换个主机名
pv_base_for_emulator() {
  pv_base | sed -e 's#//127\.0\.0\.1:#//10.0.2.2:#'
}
