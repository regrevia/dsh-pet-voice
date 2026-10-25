#!/bin/bash
# 手机侧「语音指令分流」验收：切项目 / 派发任务 / 停 / 切不到 / 闲聊回退。
#
#   bash scripts/verify-commands.sh [serial]
#
# 为什么要临时换 debug 包：只有 debug 构建注册了 adb 广播注入口（ACTION_DEBUG_TURN），
# 而模拟器的 ASR 永远 no-match，喊不出真话。debug/release 签名不同，必须 uninstall 再装，
# 脚本结束会自动装回 dist/jingling-0.2.1.apk（不可调试），不会把机器留在 debug 状态。
#
# ⚠️ adb 坑：`adb shell am broadcast --es text '切到 Pet'` 里的空格会被设备端 shell 再拆一次，
#    变成 text=切到 + package=Pet，广播直接不投递（表现为「没有任何日志」）。
#    所以下面一律把整条 am 命令用引号包成一个参数传进去。
set -u
cd "$(dirname "$0")/.." || exit 1
SERIAL=${1:-emulator-5556}
ADB="adb -s $SERIAL"
PKG=com.whale.pet
DEBUG_APK=android/app/build/outputs/apk/debug/app-debug.apk
REL_APK=dist/jingling-0.2.2.apk
TOKEN_FILE=${PET_TOKEN_FILE:-/tmp/pettok}
source "$(dirname "$0")/lib/pv-base.sh" 2>/dev/null || true
HOST=${PET_HOST:-$(pv_base_for_emulator 2>/dev/null)/}
HOST=${HOST%/}/
TMPD=$(mktemp -d)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -f "$TOKEN_FILE" ] || { echo "缺令牌文件 ${TOKEN_FILE}（48 位 token，不放仓库）"; exit 1; }
[ -f "$DEBUG_APK" ] || { echo "缺 debug 包：先跑 gradle :app:assembleDebug"; exit 1; }
$ADB get-state >/dev/null 2>&1 || { echo "设备 $SERIAL 不在线"; exit 1; }

write_prefs() {
  umask 077
  /usr/bin/python3 - "$TOKEN_FILE" "$HOST" "$TMPD/pet_prefs.xml" <<'PY'
import sys, io, html
tok = io.open(sys.argv[1], encoding='utf-8').read().strip()
xml = '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map>\n'
xml += '    <string name="base_url">%s</string>\n' % html.escape(sys.argv[2])
xml += '    <string name="token">%s</string>\n' % html.escape(tok)
xml += '    <string name="preset">whale</string>\n'
xml += '    <boolean name="wake_enabled" value="false" />\n'
xml += '    <boolean name="auto_start" value="true" />\n</map>\n'
io.open(sys.argv[3], 'w', encoding='utf-8').write(xml)
PY
  $ADB push "$TMPD/pet_prefs.xml" /data/local/tmp/pet_prefs.xml >/dev/null 2>&1
  $ADB shell "run-as $PKG mkdir -p /data/data/$PKG/shared_prefs" >/dev/null 2>&1
  $ADB shell "run-as $PKG cp /data/local/tmp/pet_prefs.xml /data/data/$PKG/shared_prefs/pet_prefs.xml" >/dev/null 2>&1
  $ADB shell rm -f /data/local/tmp/pet_prefs.xml >/dev/null 2>&1
  rm -f "$TMPD/pet_prefs.xml"
}

# 发一句「话」，回包只取关键日志行
say_and_log() {
  $ADB logcat -c >/dev/null 2>&1
  $ADB shell "am broadcast -a com.whale.pet.action.DEBUG_TURN --es text '$1'" 2>&1 | grep -o 'result=[0-9-]*'
  sleep 7
  $ADB logcat -d -s PetCommand:I PetLatency:I 2>/dev/null | tr -d '\r'
}

restore_release() {
  head_ "还原成发布的 release 包"
  [ -d "$TMPD" ] || mkdir -p "$TMPD"   # trap 可能跑在临时目录清理之后
  $ADB uninstall $PKG >/dev/null 2>&1
  $ADB install "$REL_APK" >/dev/null 2>&1 && ok "release 0.2.2 已装回" || bad "release 装回失败"
  $ADB shell appops set $PKG SYSTEM_ALERT_WINDOW allow >/dev/null 2>&1
  $ADB shell pm grant $PKG android.permission.POST_NOTIFICATIONS >/dev/null 2>&1
  $ADB shell pm grant $PKG android.permission.RECORD_AUDIO >/dev/null 2>&1
  if [ -f "$TOKEN_FILE" ]; then write_prefs; fi
  $ADB shell am start -n $PKG/.MainActivity >/dev/null 2>&1
  sleep 3
  $ADB shell dumpsys package $PKG | grep -q DEBUGGABLE && bad "装回的是 debug 包" \
    || ok "装回的是 release（不可调试，$( $ADB shell dumpsys package $PKG | grep -m1 versionName | tr -d ' \r')）"
}
trap restore_release EXIT

head_ "1) 换 debug 包（广播注入口只在 debug 构建里）"
$ADB uninstall $PKG >/dev/null 2>&1
$ADB install "$DEBUG_APK" >/dev/null 2>&1 && ok "debug 包已装" || { bad "debug 包安装失败"; exit 1; }
$ADB shell appops set $PKG SYSTEM_ALERT_WINDOW allow >/dev/null 2>&1
$ADB shell pm grant $PKG android.permission.POST_NOTIFICATIONS >/dev/null 2>&1
$ADB shell pm grant $PKG android.permission.RECORD_AUDIO >/dev/null 2>&1
write_prefs && ok "配置已注入（令牌不回显）" || bad "配置注入失败"

head_ "2) 前台服务与悬浮窗"
$ADB shell am start-foreground-service -n $PKG/.FloatingPetService -a com.whale.pet.action.START >/dev/null 2>&1
sleep 4
$ADB shell dumpsys activity services $PKG 2>/dev/null | grep -q "isForeground=true" && ok "前台服务在跑" || bad "前台服务没起来"
$ADB shell dumpsys window windows 2>/dev/null | grep -q "APPLICATION_OVERLAY" && ok "悬浮窗存在（ty=APPLICATION_OVERLAY）" || bad "悬浮窗没出现"

head_ "3) 语音指令（全部走 /api/command 分流）"
OUT=$(say_and_log "切到 Pet")
echo "$OUT" | grep -q "action=switch" && ok "「切到 Pet」→ action=switch" || bad "「切到 Pet」没命中：$(echo "$OUT" | head -2)"
echo "$OUT" | grep -q "/api/dispatch" && bad "switch 之后又 dispatch（双份派发）" || ok "switch 之后没有二次 dispatch"
MS=$(echo "$OUT" | grep -o '指令分流 +[0-9]*ms' | grep -o '[0-9]*' | head -1)
[ -n "${MS:-}" ] && { [ "$MS" -lt 1500 ] && ok "分流耗时 ${MS}ms（<1500ms）" || bad "分流耗时 ${MS}ms（偏慢）"; }

OUT=$(say_and_log "派发 看一下 git status 给 Pet")
echo "$OUT" | grep -q "action=dispatch" && ok "「派发 … 给 Pet」→ action=dispatch" || bad "派发没命中：$(echo "$OUT" | head -2)"
# dispatch 分支按设计**不再**发 /api/dispatch（宿主的 /api/command 已经派过了，再发就是双份），
# 所以这里验的是「念了宿主回的那句话」，而不是握手次数。
echo "$OUT" | grep -q "/api/dispatch" && bad "dispatch 之后又发了一次 /api/dispatch（双份派发）" || ok "dispatch 之后没有二次 dispatch"
echo "$OUT" | grep -qE "TTS (缓存命中|可播)" && ok "念了宿主回包（TTS 出声日志在）" || bad "没看到 TTS 出声"

OUT=$(say_and_log "停")
echo "$OUT" | grep -q "action=stop" && ok "「停」→ action=stop" || bad "「停」没命中：$(echo "$OUT" | head -2)"

OUT=$(say_and_log "切到 没有这个项目的名字")
echo "$OUT" | grep -q "action=switch-miss" && ok "切不到 → action=switch-miss（不建会话、不派发）" || bad "切不到没走 switch-miss：$(echo "$OUT" | head -2)"

OUT=$(say_and_log "今天天气不错")
echo "$OUT" | grep -q "action=chat" && ok "闲聊 → action=chat（交给 /api/dispatch，不误判成指令）" || bad "闲聊没回退 chat：$(echo "$OUT" | head -2)"

rm -rf "$TMPD"
echo
echo "语音指令验收：$PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] || exit 1
