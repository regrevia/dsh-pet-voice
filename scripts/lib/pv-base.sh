#!/usr/bin/env bash
# 找准宿主 /pet-voice 的地址：DSH Web 端口每次启动都可能变，别把端口写死。
#
#   source scripts/lib/pv-base.sh
#   BASE=$(pv_base)            # http://127.0.0.1:54013/pet-voice
#
# 查找顺序：$PV_BASE → $PV_PORT → ~/.dsh/pet-voice/host-port.json（插件挂载时写的）
#          → 本机监听端口挨个试。
# 判定标准是「带令牌能拿到含 versionCode 的 JSON」。别用 /api/state：它要汇总项目与会话，冷启动 4s，
# 超时就会误认到别的服务；也别只认 "ok"，DSH 的 404 响应体里也有 "ok":false。
# 探测一定要带一个「已登记」的设备 id，并且别用 node/curl 自己的 UA 去登记新设备：
# 插件对自报 id 的设备才执行「最多 N 台」的上限，没登记的请求会被当成第 4 台挡成 429，
# 响应里没有 versionCode，于是每个端口都被判成「不是宿主」，脚本静默退回写死的旧端口。
pv_dev_id() {
  node -e 'try{const s=require(process.argv[1]);const d=(s.devices||[]).filter(x=>x&&x.id).sort((a,b)=>(b.lastSeen||0)-(a.lastSeen||0));process.stdout.write(d[0]?d[0].id:"")}catch(e){}' \
    "$HOME/.dsh/pet-voice/devices.json" 2>/dev/null
}

# 端口上是不是「我们的宿主」：/pet-voice/ 只要回一个 HTTP 码就算（401/403/200 都行），
# 连不上才是 false。不校验令牌，所以很便宜。
pv_port_alive() {
  curl -s -m 1 -o /dev/null "http://127.0.0.1:$1/pet-voice/" 2>/dev/null
}

# 探到之后自己写缓存：插件那份要等热重载才生效，脚本不该跟着等。
# 只写探明可用的端口，失败静默（缓存只是加速，不是唯一来源）。
pv_cache_port() {
  local port="$1" dir="$HOME/.dsh/pet-voice"
  [ -n "$port" ] && [ -d "$dir" ] || return 0
  ( umask 077; printf '{\n  "port": "%s",\n  "origin": "http://127.0.0.1:%s",\n  "at": "%s",\n  "by": "pv-base.sh"\n}\n' \
      "$port" "$port" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$dir/host-port.json" ) 2>/dev/null || true
}

pv_base() {
  if [ -n "${PV_BASE:-}" ]; then printf '%s\n' "${PV_BASE%/}"; return 0; fi
  if [ -n "${PV_PORT:-}" ]; then printf 'http://127.0.0.1:%s/pet-voice\n' "$PV_PORT"; return 0; fi

  local pf="$HOME/.dsh/pet-voice/host-port.json" port
  # 缓存要验活再信：DSH 重启后端口会变，旧缓存会把人指到死端口上，
  # 而「探到了但静默失败」比「探不到」更难查。命中就用一次极轻的 HEAD 验一下。
  if [ -f "$pf" ]; then
    port=$(node -e 'try{const p=require(process.argv[1]);process.stdout.write(String(p.port||p))}catch(e){}' "$pf" 2>/dev/null)
    if [ -n "$port" ] && pv_port_alive "$port"; then
      printf 'http://127.0.0.1:%s/pet-voice\n' "$port"
      return 0
    fi
  fi

  local tok ck body dev
  dev=$(pv_dev_id)
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
      body=$(curl -s -m 2 -H "Cookie: $ck" ${dev:+-H "x-pet-device-id: $dev"} "http://127.0.0.1:${port}/pet-voice/api/update" 2>/dev/null)
      case "$body" in
        *'"versionCode"'*) pv_cache_port "$port"; printf 'http://127.0.0.1:%s/pet-voice\n' "$port"; return 0 ;;
      esac
    else
      case "$(curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/pet-voice/api/state" 2>/dev/null)" in
        401|403) pv_cache_port "$port"; printf 'http://127.0.0.1:%s/pet-voice\n' "$port"; return 0 ;;
      esac
    fi
  done
  return 1
}

# 模拟器里访问宿主用 10.0.2.2，把 pv_base 的结果换个主机名
pv_base_for_emulator() {
  pv_base | sed -e 's#//127\.0\.0\.1:#//10.0.2.2:#'
}
