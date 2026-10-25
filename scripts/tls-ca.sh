#!/usr/bin/env bash
# 自签 CA + 叶证书：给「手机 https 连自己的机器」用，不用买域名、不用备案。
#
#   bash scripts/tls-ca.sh --ip 1.2.3.4                 # 生成（已有 CA 就复用，只补叶证书）
#   bash scripts/tls-ca.sh --ip 1.2.3.4 --dns pet.local # 再加一个域名 SAN
#   bash scripts/tls-ca.sh --check                      # 校验：链、SAN、权限、到期、App 内置是否一致
#   bash scripts/tls-ca.sh --renew-leaf --ip 1.2.3.4    # 只换叶证书（CA 不变 → App 不用重装）
#   bash scripts/tls-ca.sh --no-android                 # 不往仓库里放 App 用的 CA
#
# 产物（都不进 git，权限 600 / 目录 700）：
#   ~/.dsh/pet-voice/tls/pet-ca.pem        根证书（公开，可以给别人）
#   ~/.dsh/pet-voice/tls/pet-ca.key.pem    根私钥（当密码看）
#   ~/.dsh/pet-voice/tls/pet-leaf.pem      服务器叶证书（含 IP/域名 SAN）
#   ~/.dsh/pet-voice/tls/pet-leaf.key.pem  服务器私钥
#
# 默认 SAN 已覆盖：localhost / 127.0.0.1 / ::1 / 10.0.2.2（模拟器看宿主的地址）。
# App 里通过 res/raw/pet_ca.pem + network_security_config 只信这张 CA，所以别的 https 照旧走系统 CA。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SELF_DIR/.." && pwd)"
PV_DIR="${HOME}/.dsh/pet-voice"
TLS_DIR="${PV_DIR}/tls"
CA_KEY="${TLS_DIR}/pet-ca.key.pem"
CA_CERT="${TLS_DIR}/pet-ca.pem"
LEAF_KEY="${TLS_DIR}/pet-leaf.key.pem"
LEAF_CERT="${TLS_DIR}/pet-leaf.pem"
ANDROID_RAW="${ROOT}/android/app/src/main/res/raw/pet_ca.pem"

CA_DAYS=3650
LEAF_DAYS=397
IPS=(127.0.0.1 ::1 10.0.2.2)
DNSS=(localhost)
CN_PRIMARY="127.0.0.1"
MODE=gen
FORCE=0
ANDROID=1
QUIET=0

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ip) IPS+=("$2"); shift 2 ;;
    --dns) DNSS+=("$2"); shift 2 ;;
    --cn) CN_PRIMARY="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --no-android) ANDROID=0; shift ;;
    --renew-leaf) MODE=renew; shift ;;
    --check) MODE=check; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
command -v openssl >/dev/null 2>&1 || { echo "缺 openssl" >&2; exit 1; }

mode_of() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }
days_left() {
  local end epoch now
  end=$(openssl x509 -in "$1" -noout -enddate | cut -d= -f2)
  epoch=$(/usr/bin/python3 - "$end" <<'PY'
import sys, time
end = sys.argv[1]
# openssl 输出形如 "Oct 24 13:00:00 2035 GMT"
try:
    import calendar
    t = time.strptime(end, '%b %d %H:%M:%S %Y GMT')
    print(calendar.timegm(t))
except Exception:
    print(0)
PY
)
  now=$(date +%s)
  [ "${epoch:-0}" -gt 0 ] && echo $(( (epoch - now) / 86400 )) || echo -1
}
fingerprint() { openssl x509 -in "$1" -noout -fingerprint -sha256 | sed 's/^.*=//'; }

write_cnf() {
  local cnf="$1"
  {
    echo '[req]'
    echo 'distinguished_name = dn'
    echo 'prompt = no'
    echo '[dn]'
    echo "CN = ${CN_PRIMARY}"
    echo '[v3_ca]'
    echo 'basicConstraints = critical,CA:TRUE,pathlen:0'
    echo 'keyUsage = critical,keyCertSign,cRLSign'
    echo 'subjectKeyIdentifier = hash'
    echo '[v3_leaf]'
    echo 'basicConstraints = critical,CA:FALSE'
    echo 'keyUsage = critical,digitalSignature,keyEncipherment'
    echo 'extendedKeyUsage = serverAuth'
    echo 'subjectAltName = @alt'
    echo '[alt]'
    local i=1 d
    for d in "${DNSS[@]}"; do echo "DNS.${i} = ${d}"; i=$((i+1)); done
    i=1
    for d in "${IPS[@]}"; do echo "IP.${i} = ${d}"; i=$((i+1)); done
  } > "$cnf"
}

export_android() {
  [ "$ANDROID" = 1 ] || { say "跳过 App 内置（--no-android）"; return 0; }
  mkdir -p "$(dirname "$ANDROID_RAW")"
  cp "$CA_CERT" "$ANDROID_RAW"
  chmod 644 "$ANDROID_RAW"
  say "已把根证书放进 App：${ANDROID_RAW#"$ROOT"/}（公开证书，不是私钥）"
  say "⚠️ 换了 CA 就要重新出包，否则手机不认新证书。"
}

gen() {
  umask 077
  mkdir -p "$TLS_DIR"
  chmod 700 "$TLS_DIR"
  local cnf="${TLS_DIR}/openssl.cnf"
  write_cnf "$cnf"

  if [ -f "$CA_CERT" ] && [ -f "$CA_KEY" ] && [ "$FORCE" = 0 ]; then
    say "复用已有根证书（要换就加 --force，注意换完 App 得重装）"
  else
    say "生成根证书（${CA_DAYS} 天）…"
    openssl req -x509 -new -nodes -newkey rsa:3072 -sha256 -days "$CA_DAYS" \
      -keyout "$CA_KEY" -out "$CA_CERT" -config "$cnf" -extensions v3_ca \
      -subj "/O=Whale Pet/CN=Whale Pet Local CA" >/dev/null 2>&1
    chmod 600 "$CA_KEY" "$CA_CERT"
  fi

  say "生成服务器叶证书（${LEAF_DAYS} 天，SAN 见下）…"
  openssl req -new -nodes -newkey rsa:2048 -sha256 \
    -keyout "$LEAF_KEY" -out "${TLS_DIR}/pet-leaf.csr" \
    -config "$cnf" -subj "/O=Whale Pet/CN=${CN_PRIMARY}" >/dev/null 2>&1
  openssl x509 -req -in "${TLS_DIR}/pet-leaf.csr" \
    -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "$LEAF_CERT" -days "$LEAF_DAYS" -sha256 \
    -extfile "$cnf" -extensions v3_leaf >/dev/null 2>&1
  rm -f "${TLS_DIR}/pet-leaf.csr"
  chmod 600 "$LEAF_KEY" "$LEAF_CERT"

  export_android
  say ""
  say "根证书指纹 SHA-256：$(fingerprint "$CA_CERT")"
  say "叶证书到期：$(days_left "$LEAF_CERT") 天后"
  say "文件：${TLS_DIR}（目录 700、私钥 600）"
}

renew_leaf() {
  [ -f "$CA_CERT" ] && [ -f "$CA_KEY" ] || { echo "还没有根证书，先跑一次不带参数的生成" >&2; exit 1; }
  gen
}

check() {
  local fail=0
  echo "自签证书检查"
  for f in "$CA_CERT" "$CA_KEY" "$LEAF_CERT" "$LEAF_KEY"; do
    if [ -f "$f" ]; then
      local m; m=$(mode_of "$f")
      if [ "$m" = "600" ] || [ "$m" = "400" ]; then ok "$(basename "$f") 存在，权限 $m"; else bad "$(basename "$f") 权限 ${m}（应为 600）"; fail=$((fail+1)); fi
    else
      bad "$(basename "$f") 不存在（先跑 bash scripts/tls-ca.sh --ip 你的IP）"; fail=$((fail+1))
    fi
  done
  [ "$fail" -eq 0 ] || { echo; echo "$fail 项不过"; exit 1; }

  if openssl verify -CAfile "$CA_CERT" "$LEAF_CERT" >/dev/null 2>&1; then ok "链校验通过（叶证书由这张 CA 签发）"; else bad "链校验失败"; fail=$((fail+1)); fi

  local san; san=$(openssl x509 -in "$LEAF_CERT" -noout -text | grep -A1 'Subject Alternative Name' | tail -1 | sed 's/^ *//')
  say "  SAN：${san}"
  local d
  for d in 127.0.0.1 10.0.2.2; do
    case "$san" in *"IP Address:${d}"*) ok "SAN 含 IP ${d}";; *) bad "SAN 缺 IP ${d}"; fail=$((fail+1));; esac
  done
  # openssl 有时把 ::1 展开成 0:0:0:0:0:0:0:1，两种写法都认
  case "$san" in *"IP Address:::1"*|*"IP Address:0:0:0:0:0:0:0:1"*) ok "SAN 含 IP ::1";; *) bad "SAN 缺 IP ::1"; fail=$((fail+1));; esac

  local dl; dl=$(days_left "$LEAF_CERT")
  if [ "$dl" -gt 30 ]; then ok "叶证书 ${dl} 天后到期"; else bad "叶证书只剩 ${dl} 天，跑 --renew-leaf"; fail=$((fail+1)); fi

  if [ "$ANDROID" = 1 ] && [ -f "$ANDROID_RAW" ]; then
    if [ "$(fingerprint "$ANDROID_RAW")" = "$(fingerprint "$CA_CERT")" ]; then
      ok "App 内置的 CA 与本地根证书一致（可以出包）"
    else
      bad "App 内置的 CA 和本地根证书不一致 → 换过 CA，请重跑生成 + 重新出包"; fail=$((fail+1))
    fi
  elif [ "$ANDROID" = 1 ]; then
    bad "App 里没有 res/raw/pet_ca.pem（自签 https 会失败）"; fail=$((fail+1))
  fi

  echo
  if [ "$fail" -eq 0 ]; then echo "全部通过：根证书 $(fingerprint "$CA_CERT")"; else echo "$fail 项不过"; exit 1; fi
}

case "$MODE" in
  gen) gen; check ;;
  renew) renew_leaf; check ;;
  check) check ;;
esac
