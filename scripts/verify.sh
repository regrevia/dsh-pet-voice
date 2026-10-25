#!/bin/bash
# 鲸灵随身宠物 · 一键可复现验收
#   用法：bash scripts/verify.sh              （全部跑）
#         SKIP_LIVE=1 bash scripts/verify.sh （只跑离线自测）
#         VERIFY_SELFCHECK=1 bash scripts/verify.sh （额外验证门禁自己拦得住失败）
# 退出码 0 = 全过；任何一项失败 = 1。不会打印任何 token/secret。
#
# 门禁规则（不为任何用例开文本豁免）：
#   1) 被测命令退出码非 0 → 失败，并打印命令与退出码；
#   2) 输出里有 "a/b 通过" 而 a != b → 同样算失败（脚本自己错误地 exit 0 也拦）；
#   3) 失败明细只用于展示，规则用 ^[[:space:]]*- 匹配单/双前导空格都可。
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
FAIL=0
PASS=0

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

LAST_OUT=""
LAST_RC=0
run_capture() { LAST_OUT=$("$@" 2>&1); LAST_RC=$?; }

failure_lines() {
  local lines
  lines=$(printf '%s\n' "$LAST_OUT" | grep -E '^[[:space:]]*- ' | head -3)
  [ -n "$lines" ] && { printf '%s' "$lines"; return; }
  printf '%s\n' "$LAST_OUT" | grep -E '✗' | head -3
}
failure_total() { printf '%s\n' "$LAST_OUT" | grep -cE '^[[:space:]]*- '; }
summary_line()  { printf '%s\n' "$LAST_OUT" | grep -oE '[0-9]+/[0-9]+ 通过' | tail -1; }
# 有 "a/b 通过" 且 a != b 时回显 "a/b"，否则空
count_mismatch() {
  local sum a b
  # 脚本自报的失败数 >0 就算失败（哪怕它 exit 0）
  if printf '%s\n' "$LAST_OUT" | grep -qE '(^|[^0-9])[1-9][0-9]* FAIL'; then
    printf 'FAIL>0'; return
  fi
  # 明确写了 "0 FAIL" 的（含 SKIP 的）按它自己报的失败数为准
  printf '%s\n' "$LAST_OUT" | grep -qE '0 FAIL' && return 0
  sum=$(summary_line)
  [ -n "$sum" ] || return 0
  sum=${sum%% *}
  a=${sum%%/*}; b=${sum##*/}
  [ "$a" = "$b" ] || printf '%s' "$sum"
}

# 统一门禁：$1 名称，其余为命令
run() {
  local name=$1; shift
  run_capture "$@"
  if [ "$LAST_RC" -ne 0 ]; then
    bad "${name}（退出码 ${LAST_RC}）：$*"
    local lines; lines=$(failure_lines)
    [ -n "$lines" ] && printf '%s\n' "$lines" | sed 's/^/      /'
    local total; total=$(failure_total)
    [ "$total" -gt 3 ] && printf '      ……另有 %d 条失败明细\n' "$((total-3))"
    return
  fi
  # 退出码 0，但输出里带了失败明细（例如往输出里追加一条失败记录）也判失败；
  # 脚本自己标了 "0 FAIL" 的（SKIP 不算失败）按它自报的为准。
  local lines; lines=$(failure_lines)
  if [ -n "$lines" ] && ! printf '%s\n' "$LAST_OUT" | grep -qE '0 FAIL'; then
    bad "${name}（退出码 0，但输出含失败明细）：$*"
    printf '%s\n' "$lines" | sed 's/^/      /'
    return
  fi
  local mm; mm=$(count_mismatch)
  if [ -n "$mm" ]; then
    bad "${name}（通过计数 ${mm}，命令却以退出码 0 结束）：$*"
    local lines; lines=$(failure_lines)
    [ -n "$lines" ] && printf '%s\n' "$lines" | sed 's/^/      /'
    return
  fi
  local sum; sum=$(summary_line)
  ok "$name${sum:+（${sum}）}"
}

head_ "1. 语法检查"
for f in plugins/dsh-pet-voice/index.js mcp/pet-bridge/xiaoai.mjs mcp/pet-bridge/server.mjs mcp/pet-bridge/xiaoai-selftest.mjs mcp/pet-bridge/selftest.mjs scripts/cf-creds.mjs scripts/cf-creds.test.mjs; do
  run "node --check $f" node --check "$f"
done

head_ "1b. 素材归一化表（每段动作的人物高度必须一致）"
# 需要 ffmpeg 量素材原始包围盒；没有就 SKIP，不算失败
if command -v ffmpeg >/dev/null 2>&1 && [ -f scripts/sprite-norm.py ]; then
  run "素材归一化表" python3 scripts/sprite-norm.py --check
else
  echo "  SKIP  没装 ffmpeg（缺席就不量素材）"
fi

head_ "2. 插件自测（模拟 HOME，不碰真实配置）"
# selftest 要求干净 HOME：上次跑剩的面板文件会让它以为在真机上，直接退出 2
rm -rf /tmp/pvtest && mkdir -p /tmp/pvtest
run "插件 selftest" env HOME=/tmp/pvtest node plugins/dsh-pet-voice/selftest.mjs

head_ "3. MCP 自测"
run "MCP selftest" node mcp/pet-bridge/selftest.mjs

head_ "4. 小爱协议自测"
run "xiaoai selftest" node mcp/pet-bridge/xiaoai-selftest.mjs

head_ "4b. Cloudflare 凭证脚本自测（离线，不碰真凭证）"
run "cf-creds selftest" node scripts/cf-creds.test.mjs

head_ "4c. Tunnel token 落盘脚本自测（离线，假 token）"
run "cf-tunnel-token selftest" node scripts/cf-tunnel-token.test.mjs

head_ "4d. 自签证书（没生成过就 SKIP）"
if [ -f "$HOME/.dsh/pet-voice/tls/pet-ca.pem" ]; then
  run "tls-ca --check" bash scripts/tls-ca.sh --check
else
  echo "  SKIP  还没生成自签证书（需要时跑 bash scripts/tls-ca.sh --ip 你的IP）"
fi

if [ "${SKIP_LIVE:-0}" = "1" ]; then
  head_ "5. 线上探针（已跳过 SKIP_LIVE=1）"
else
  head_ "5. 线上探针（本机宿主）"
  # 端口每次启动都可能变：交给 scripts/lib/pv-base.sh 按「带令牌能拿到 ok」自己找
  source scripts/lib/pv-base.sh
  BASE=$(pv_base || printf 'http://127.0.0.1:54013/pet-voice')
  code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$BASE/api/state" || echo 000)
  if [ "$code" = "401" ]; then ok "未带 cookie 的 /api/state → 401（鉴权生效）"; else bad "未带 cookie 的 /api/state → ${code}（期望 401）"; fi

  XJ="$HOME/.dsh/pet-voice/xiaoai.json"
  if [ -f "$XJ" ]; then
    K=$(node -e "process.stdout.write(require(process.env.HOME+'/.dsh/pet-voice/xiaoai.json').urlSecret||'')")
    body='{"version":"1.0","query":"","session":{"session_id":"verify","application":{"app_id":"d"},"user":{"user_id":"u"}},"request":{"type":0,"request_id":"v0","timestamp":1,"locale":"zh-CN"}}'
    resp=$(curl -s -m 10 -w '\n%{time_total}' -X POST -H 'content-type: application/json' -d "$body" "$BASE/api/xiaoai?k=$K")
    t=$(printf '%s' "$resp" | tail -1); json=$(printf '%s' "$resp" | sed '$d')
    if printf '%s' "$json" | grep -q '"open_mic":true'; then ok "小爱 type=0 进入语 + open_mic:true（${t}s）"; else bad "小爱 type=0 回复异常：$(printf '%s' "$json" | head -c 120)"; fi

    # 三次取最快：模型首字时延抖动大（实测同一句 0.88s / 2.20s），单次测速会把抖动当回归
    body1='{"version":"1.0","query":"让鲸灵回复两个字：收到","session":{"session_id":"verify","application":{"app_id":"d"},"user":{"user_id":"u"}},"request":{"type":1,"request_id":"v1","timestamp":1,"locale":"zh-CN"}}'
    best=99; got=0; lastjson=""
    for i in 1 2 3; do
      resp1=$(curl -s -m 15 -w '\n%{time_total}' -X POST -H 'content-type: application/json' -d "$body1" "$BASE/api/xiaoai?k=$K")
      t1=$(printf '%s' "$resp1" | tail -1); json1=$(printf '%s' "$resp1" | sed '$d')
      lastjson="$json1"
      if printf '%s' "$json1" | grep -qE '收到'; then
        got=1
        best=$(node -e 'const a=Number(process.argv[1]),b=Number(process.argv[2]);process.stdout.write(String(Math.min(a,b)))' "${t1:-9}" "$best")
      fi
    done
    if [ "$got" = "1" ]; then
      if node -e "process.exit(Number(process.argv[1])<1.6?0:1)" "$best"; then ok "派任务拿到真回复，3 次最快 ${best}s（<1.6s）"; else bad "派任务 3 次最快仍太慢：${best}s"; fi
    else
      bad "派任务 3 次都没拿到真回复：$(printf '%s' "$lastjson" | head -c 140)"
    fi

    if [ -f "$HOME/.dsh/pet-voice/pet-session.json" ]; then
      T_=$(cat "$HOME/.dsh/pet-voice/token")
      CK="pkv_$(printf %s "$T_" | head -c 8)=$T_"
      DT=$(curl -s -m 8 -H "Cookie: $CK" "$BASE/api/state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.dispatchTarget||""))}catch(e){process.stdout.write("")}})')
      PS=$(node -e "process.stdout.write(require(process.env.HOME+'/.dsh/pet-voice/pet-session.json').sessionId)")
      if [ "$DT" = "$PS" ]; then ok "派发目标 dispatchTarget == 专属会话（不会被界面会话抢走）"; else bad "派发目标 ${DT:-空} != 专属会话 ${PS}"; fi
      cwd=$(node -e "process.stdout.write(String(require(process.env.HOME+'/.dsh/pet-voice/pet-session.json').cwd||''))")
      if [ "$cwd" = "$ROOT" ]; then ok "小爱专属会话 cwd = 本仓库（${cwd}）"; else bad "小爱专属会话 cwd 不是本仓库：${cwd}"; fi
    else
      bad "缺少 ~/.dsh/pet-voice/pet-session.json"
    fi

    # /api/say 是否已上线（宿主新能力）
    sc=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/say" -H 'content-type: application/json' -d '{"text":"probe"}')
    if [ "$sc" = "401" ] || [ "$sc" = "200" ]; then ok "/api/say 已上线（无鉴权探测 → ${sc}）"; else ok "/api/say 尚未上线（${sc}），pet_say 会如实失败"; fi
  else
    bad "缺少 ${XJ}（小爱端点未配置）"
  fi
fi

# 门禁自检：默认不进日常路径，VERIFY_SELFCHECK=1 时证明「失败一定被拦住」
if [ "${VERIFY_SELFCHECK:-0}" = "1" ]; then
  head_ "6. 门禁自检（构造失败，必须判失败）"
  if ( FAIL=0; PASS=0; run "假命令（非 0 退出）" node -e 'process.exit(3)' >/dev/null 2>&1; [ "$FAIL" -eq 1 ] ); then
    ok "自检：退出码 3 的命令被判失败"
  else
    bad "自检：退出码 3 的命令没有把门禁打红"
  fi
  if ( FAIL=0; PASS=0; run "假 selftest（退出码 0 但 3/4）" node -e 'console.log("selftest: 3/4 通过")' >/dev/null 2>&1; [ "$FAIL" -eq 1 ] ); then
    ok "自检：退出码 0 但计数 3/4 也算失败"
  else
    bad "自检：计数不一致没被拦住"
  fi
  if ( FAIL=0; PASS=0; run "假 selftest（退出码 0 但追加失败行）" node -e 'console.log("selftest: 2/2 通过"); console.log("  - 追加的失败记录")' >/dev/null 2>&1; [ "$FAIL" -eq 1 ] ); then
    ok "自检：退出码 0 但输出含失败明细也算失败"
  else
    bad "自检：输出里的失败明细没被拦住"
  fi
  LAST_OUT=$(printf 'selftest: 3/4 通过\n失败项：\n - 单前导空格失败项\n')
  if [ "$(failure_lines)" = " - 单前导空格失败项" ]; then
    ok "自检：失败明细解析认单前导空格"
  else
    bad "自检：失败明细解析没认单前导空格"
  fi
fi

head_ "结果"
printf '  通过 %d 项，失败 %d 项\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && printf '  \033[32m全部通过\033[0m\n' || printf '  \033[31m有失败项\033[0m\n'
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
