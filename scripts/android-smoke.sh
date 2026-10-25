#!/usr/bin/env bash
# 安卓端可复现冒烟：装 APK → 注入真实配置（令牌不打印）→ 文字通道跑完整一轮 → 断言回复。
# 依赖：adb、运行中的 AV enulator（或真机）、宿主 /pet-voice 在跑（默认 10.0.2.2:52356，真机用 PV_HOST 覆盖）。
# 用法：bash scripts/android-smoke.sh            # 全流程
#      SKIP_INSTALL=1 bash scripts/android-smoke.sh
set -uo pipefail

# 设备选择：默认尊重 ANDROID_SERIAL（两台模拟器同时在跑时裸 adb 会直接报错）
export ANDROID_SERIAL=${ANDROID_SERIAL:-emulator-5556}
ADB="adb -s $ANDROID_SERIAL"

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
TOKEN_FILE="$HOME/.dsh/pet-voice/token"
source "$(dirname "$0")/lib/pv-base.sh" 2>/dev/null || true
HOST=${PV_HOST:-$(pv_base_for_emulator 2>/dev/null)/}
HOST=${HOST%/}/
# 探活从 Mac 发起：模拟器的 10.0.2.2 在 Mac 上不可达，换成 127.0.0.1（方案与端口照抄）
PROBE=${PV_PROBE:-$(printf %s "$HOST" | sed -e 's#//10\.0\.2\.2:#//127.0.0.1:#')}
PROBE=${PROBE%/}   # 去掉尾部斜杠，避免拼出 //api/state
PKG=com.whale.pet
SENT="android-smoke-$(date +%s)"
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

pass=0; fail=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }
say()  { echo "--- $1"; }

dismiss_perm_dialog() { # pm clear / 全新安装后首启会弹麦克风（或通知）授权框，挡住一切控件
  local i
  for i in 1 2 3; do
    ui_dump || return 0
    if grep -q "permission_allow_foreground_only_button" "$TMPD/ui.xml" 2>/dev/null; then
      local cx cy
      cx=$(/usr/bin/python3 - "$TMPD/ui.xml" <<'PY'
import re,sys
s=open(sys.argv[1],encoding='utf-8',errors='replace').read()
m=re.search(r'resource-id="[^"]*permission_allow_foreground_only_button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',s)
print((int(m.group(1))+int(m.group(3)))//2 if m else '')
PY
)
      cy=$(/usr/bin/python3 - "$TMPD/ui.xml" <<'PY'
import re,sys
s=open(sys.argv[1],encoding='utf-8',errors='replace').read()
m=re.search(r'resource-id="[^"]*permission_allow_foreground_only_button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',s)
print((int(m.group(2))+int(m.group(4)))//2 if m else '')
PY
)
      if [ -n "$cx" ] && [ -n "$cy" ]; then
        $ADB shell input tap "$cx" "$cy" >/dev/null 2>&1
        sleep 1
      fi
    elif grep -q "permissioncontroller" "$TMPD/ui.xml" 2>/dev/null; then
      $ADB shell input keyevent 4 >/dev/null 2>&1
      sleep 1
    else
      return 0
    fi
  done
}

ui_text_all() { # 当前界面所有 text 拼成一串，用来判断某段文字在不在
  /usr/bin/python3 - "$TMPD/ui.xml" <<'PY'
import re,sys
try: x=open(sys.argv[1],encoding='utf-8',errors='replace').read()
except Exception: x=''
print(' '.join(re.findall(r'text="([^"]*)"',x)))
PY
}

ui_dump() { # 取当前界面 XML 到 $TMPD/ui.xml
  # uiautomator 要等界面 idle；桌宠一直在呼吸动画，偶发「could not get idle state」直接不出文件，
  # 所以重试 3 次并确认内容真的是 hierarchy，别拿上次的旧文件当真。
  local out=$TMPD/ui.xml i
  local msg=""
  for i in 1 2 3 4; do
    rm -f "$out"
    $ADB shell rm -f /data/local/tmp/ui.xml >/dev/null 2>&1 || true
    msg=$($ADB shell uiautomator dump /data/local/tmp/ui.xml 2>&1 | tr -d '\r')
    $ADB shell cat /data/local/tmp/ui.xml > "$out" 2>/dev/null || true
    if [ -s "$out" ] && grep -q "<hierarchy" "$out" 2>/dev/null; then return 0; fi
    sleep 2
  done
  echo "    (uiautomator: ${msg:-无输出})"
  return 1
}

center_of() { # $1=resource-id 后缀 → 打印 "x y"
  /usr/bin/python3 - "$TMPD/ui.xml" "$1" <<'PY'
import re,sys,io
f,key=sys.argv[1],sys.argv[2]
s=io.open(f,encoding='utf-8',errors='replace').read()
for m in re.finditer(r'<node[^>]*>',s):
    t=m.group(0)
    rid=re.search(r'resource-id="([^"]*)"',t)
    bd=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',t)
    if rid and rid.group(1).endswith('id/'+key) and bd:
        x1,y1,x2,y2=map(int,bd.groups())
        print((x1+x2)//2,(y1+y2)//2); break
PY
}

text_of() { # $1=resource-id 后缀 → 打印该控件 text
  /usr/bin/python3 - "$TMPD/ui.xml" "$1" <<'PY'
import re,sys,io
f,key=sys.argv[1],sys.argv[2]
s=io.open(f,encoding='utf-8',errors='replace').read()
for m in re.finditer(r'<node[^>]*>',s):
    t=m.group(0)
    rid=re.search(r'resource-id="([^"]*)"',t)
    if rid and rid.group(1).endswith('id/'+key):
        tx=re.search(r'text="([^"]*)"',t)
        print(tx.group(1) if tx else ''); break
PY
}

ensure_visible() { # $1=id 后缀：上下小幅滚动直到该控件出现在可点区域内，最多 8 次
  local key=$1 i xy x y
  for i in 1 2 3 4 5 6 7 8; do
    ui_dump || true
    xy=$(center_of "$key")
    if [ -n "$xy" ]; then return 0; fi
    if [ $((i % 2)) -eq 1 ]; then
      $ADB shell input swipe 540 1500 540 900 200 >/dev/null 2>&1
    else
      $ADB shell input swipe 540 900 540 1500 200 >/dev/null 2>&1
    fi
    sleep 1
  done
  return 1
}

tap_xy() { # $1="x y"
  local x y
  read -r x y <<< "$1"
  [ -n "${x:-}" ] && [ -n "${y:-}" ] || return 1
  $ADB shell input tap "$x" "$y" >/dev/null 2>&1
  return 0
}

tap_id() { # $1=id 后缀：先滚到可见再点
  ensure_visible "$1" || return 1
  tap_xy "$(center_of "$1")"
}

say "0) 环境检查"
command -v adb >/dev/null 2>&1 || { bad "没有 adb"; exit 2; }
ok "adb=$(command -v adb)"
DEV=$(adb devices | awk -v want="$ANDROID_SERIAL" 'NR>1 && $2=="device" && $1==want{print $1; exit}')
[ -n "$DEV" ] || DEV=$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')
[ -n "$DEV" ] && ok "设备在线：$DEV" || { bad "没有在线设备（先起模拟器或插真机）"; exit 2; }
say "机型：$($ADB shell getprop ro.product.model | tr -d '\r') / Android $($ADB shell getprop ro.build.version.release | tr -d '\r') / API $($ADB shell getprop ro.build.version.sdk | tr -d '\r')"
say "屏幕：$($ADB shell wm size | tr -d '\r') / $($ADB shell wm density | tr -d '\r')"
[ -f "$APK" ] && ok "APK 存在（$(wc -c < "$APK") B）" || { bad "APK 不存在：$APK"; exit 2; }
[ -f "$TOKEN_FILE" ] && ok "令牌文件存在（内容不打印）" || { bad "缺 $TOKEN_FILE"; exit 2; }
CURL_CODE=$(curl -sk -m 8 -o /dev/null -w '%{http_code}' "$PROBE/api/state" 2>/dev/null)
case "${CURL_CODE}" in
  200|401|403) : ;;
  *) CURL_CODE=$(curl -sk -m 6 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PV_PORT:-52356}/pet-voice/api/state" 2>/dev/null) ;;
esac
[ -n "${CURL_CODE}" ] || CURL_CODE=000
case "$CURL_CODE" in
  200|401|403) ok "宿主可达 $PROBE/api/state → HTTP $CURL_CODE" ;;
  *) bad "宿主不可达（HTTP ${CURL_CODE}）；模拟器里 10.0.2.2 指向宿主机，确认 /pet-voice 在跑、端口对" ;;
esac

say "1) 安装 APK"
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  if $ADB install -r -t "$APK" 2>&1 | tail -2 | grep -qi "Success"; then ok "安装成功"; else bad "安装失败（见上方输出）"; fi
  # 容错：先授予麦克风/通知，避免「常听唤醒」开着时权限弹窗卡住冒烟（无麦克风的模拟器也一样）
  $ADB shell pm grant $PKG android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
  $ADB shell pm grant $PKG android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
else
  ok "按 SKIP_INSTALL=1 跳过"
fi

say "2) 注入配置（令牌不进命令行、不打印）"
umask 077
/usr/bin/python3 - "$TOKEN_FILE" "$HOST" "$TMPD/pet_prefs.xml" "$HOME/.dsh/pet-voice/pet-session.json" <<'PY'
import sys,io,html,json,os
tok=io.open(sys.argv[1],encoding='utf-8').read().strip()
host=sys.argv[2]; out=sys.argv[3]; sessfile=sys.argv[4]
# 钉死会话：不钉的话 dispatch 会落到宿主「当前活动会话」，冒烟会污染别的会话
sid=''
try:
    sid=(json.load(io.open(sessfile,encoding='utf-8')) or {}).get('sessionId','') or ''
except Exception:
    sid=''
xml='<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map>\n'
xml+='    <string name="base_url">%s</string>\n' % html.escape(host)
xml+='    <string name="token">%s</string>\n' % html.escape(tok)
xml+='    <string name="preset">whale</string>\n'
xml+='    <boolean name="wake_enabled" value="false" />\n'
xml+='    <boolean name="auto_start" value="true" />\n'
if sid:
    xml+='    <string name="chat_session">%s</string>\n' % html.escape(sid)
xml+='</map>\n'
io.open(out,'w',encoding='utf-8').write(xml)
PY
$ADB push "$TMPD/pet_prefs.xml" /data/local/tmp/pet_prefs.xml >/dev/null 2>&1 \
  && $ADB shell "run-as $PKG cp /data/local/tmp/pet_prefs.xml /data/data/$PKG/shared_prefs/pet_prefs.xml 2>/dev/null || (run-as $PKG mkdir -p /data/data/$PKG/shared_prefs && run-as $PKG cp /data/local/tmp/pet_prefs.xml /data/data/$PKG/shared_prefs/pet_prefs.xml)" >/dev/null 2>&1 \
  && ok "写入 shared_prefs/pet_prefs.xml（$(wc -c < "$TMPD/pet_prefs.xml") B）" || bad "写 shared_prefs 失败（debug 包才有 run-as）"
$ADB shell rm -f /data/local/tmp/pet_prefs.xml >/dev/null 2>&1
rm -f "$TMPD/pet_prefs.xml"

# 运行时权限：pm clear / 重装后会被吊销，首启会弹系统框挡住界面（曾导致「配置没读到」误判）
for _p in android.permission.RECORD_AUDIO android.permission.POST_NOTIFICATIONS; do
  $ADB shell pm grant $PKG $_p >/dev/null 2>&1 || true
done
dismiss_perm_dialog

say "3) 重启 App 并读配置"
$ADB shell am force-stop $PKG >/dev/null 2>&1
$ADB shell am start -n $PKG/.MainActivity >/dev/null 2>&1
# 冷启动要验类 + 起 WebView（首帧可能 20s 以上）。uiautomator 要等界面 idle，
# 抢跑会直接不产出文件，所以先等主窗口拿到焦点，再软等标题出现。
for _ in $(seq 1 20); do
  $ADB shell dumpsys window 2>/dev/null | grep -m1 "mCurrentFocus=.*$PKG" >/dev/null && break
  sleep 1
done
dismiss_perm_dialog
ST=""
for _ in $(seq 1 12); do
  sleep 2
  ui_dump || continue
  ST=$(text_of statusTitle)
  [ -n "$ST" ] && break
done
[ -n "$ST" ] && ok "拿到界面" || bad "界面没读到（uiautomator 或系统弹窗挡住）"
# 配置读没读到看顶部状态行（已连接 = 令牌生效）
# 「已配置」= 令牌已落盘但还没验通；也是「配置读到了」，别当成失败
case "$ST" in
  *"已连接"*|*"已配置"*) ok "配置已读到：$ST" ;;
  *) bad "配置没读到（statusTitle=「${ST}」）" ;;
esac

say "4) 对话页跑一轮（这是一条真请求）"
tap_id historyRow >/dev/null 2>&1; sleep 3
ui_dump || true
X=$(center_of chatInput); Y=$(center_of chatSend); X=${X:-}; Y=${Y:-}
if [ -n "$X" ] && [ -n "$Y" ]; then
  ok "进到对话页（chatInput=${X} chatSend=${Y}）"
else
  bad "进不去对话页（historyRow/chatInput/chatSend 是否还在）"
fi
tap_xy "$X" || true; sleep 2
$ADB shell input text "$SENT" >/dev/null 2>&1; sleep 1
$ADB shell input keyevent 4 >/dev/null 2>&1 || true   # 收起键盘，避免挡住发送按钮
sleep 1
ui_dump || true
NY=$(center_of chatSend); [ -n "$NY" ] && Y=$NY
tap_xy "$Y" || true
echo "  已发出：${SENT}（等回复，最多 45s）"

ECHO=""
for i in $(seq 1 6); do
  sleep 2; ui_dump || continue
  case "$(ui_text_all)" in *"$SENT"*) ECHO=1; break ;; esac
done
[ -n "$ECHO" ] && ok "对话页回显本轮标记" || bad "对话页没回显本轮标记"

# 宿主真收到没有：转录里要有本轮标记的用户消息，再看助手回复
PET_SESSION=$(/usr/bin/python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('sessionId',''))" "$HOME/.dsh/pet-voice/pet-session.json" 2>/dev/null)
USER_OK=0
REPLY=""
for i in $(seq 1 10); do
  sleep 3
  T=$(/usr/bin/python3 "$ROOT/scripts/pv-transcript.py" "$PROBE" "$PET_SESSION" "$SENT" 2>/dev/null)
  case "$T" in *"user=yes"*) USER_OK=1 ;; esac
  REPLY=$(printf '%s\n' "$T" | sed -n 's/^reply=//p')
  [ -n "$REPLY" ] && break
done
[ "$USER_OK" = 1 ] && ok "宿主已收到本轮请求" || bad "宿主没收到本轮请求（令牌或会话不可用）"
for i in $(seq 1 30); do
  [ -n "$REPLY" ] && break
  sleep 3
  REPLY=$(/usr/bin/python3 "$ROOT/scripts/pv-transcript.py" "$PROBE" "$PET_SESSION" "$SENT" 2>/dev/null | sed -n 's/^reply=//p')
done
if [ -n "$REPLY" ]; then
  ok "宿主侧收到回复"
  echo "----- 回复 -----"
  printf '%s\n' "$REPLY"
  echo "----------------"
else
  bad "90s 内没回复（目标会话是否在跑）"
fi

say "5) 前台服务与悬浮窗（先授权并点一次启动）"
$ADB shell appops set $PKG SYSTEM_ALERT_WINDOW allow >/dev/null 2>&1 && ok "已授予悬浮窗（appops）" || bad "appops 授权失败"
$ADB shell am force-stop $PKG >/dev/null 2>&1; $ADB shell am start -n $PKG/.MainActivity >/dev/null 2>&1; sleep 3
if tap_id launchBtn >/dev/null 2>&1; then
  ok "点了「启动悬浮窗」"; sleep 4
else
  bad "没找到 launchBtn"
fi
# 通知权限：能直接授权的授权，避免系统弹窗挡住控件
$ADB shell pm grant $PKG android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
$ADB shell input keyevent 4 >/dev/null 2>&1 || true
$ADB shell dumpsys activity services $PKG 2>/dev/null | grep -m1 -E "isForeground=true" >/dev/null \
  && ok "前台服务在跑（isForeground=true）" || bad "前台服务没起来"
# 悬浮窗是异步挂上去的：给 15s，别刚点完就断言
OV=""
for _ in $(seq 1 10); do
  if $ADB shell dumpsys window windows 2>/dev/null | grep -m1 "APPLICATION_OVERLAY" >/dev/null; then OV=1; break; fi
  sleep 1.5
done
[ -n "$OV" ] && ok "悬浮窗窗口存在（ty=APPLICATION_OVERLAY）" \
  || bad "没看到悬浮窗（可能需要先点「启动悬浮窗」并授权）"

echo
echo "===== 结果：通过 $pass 项，失败 $fail 项 ====="
[ "$fail" -eq 0 ] || exit 1
