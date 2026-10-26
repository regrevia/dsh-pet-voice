#!/usr/bin/env bash
# 真机装 APK：普通 adb install 被厂商管家拦下时，用 su 走 pm install 绕过安装界面。
#
#   bash scripts/install-device.sh                 # 装 dist/ 里最新的那个
#   bash scripts/install-device.sh dist/xxx.apk 15ca9736
#
# 为什么需要第二条路：小米/红米平板把安装器换成了「平板管家」，adb install 会报
# INSTALL_FAILED_USER_RESTRICTED（Install canceled by user），即使开发者选项里
# 「USB 安装」已开也可能被安全策略拦掉。设备 root 过时，`su -c pm install` 不经过
# 安装界面，直接由 PackageManager 装，能过。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADB="${ADB:-adb}"
APK="${1:-$(ls -t "$ROOT"/dist/*.apk 2>/dev/null | head -1)}"
SERIAL="${2:-${ANDROID_SERIAL:-}}"

[ -n "$APK" ] && [ -f "$APK" ] || { echo "找不到 APK：$APK" >&2; exit 1; }
[ -n "$SERIAL" ] || { echo "用法：$0 <apk> <序列号>" >&2; exit 2; }

echo "目标 $SERIAL ← $(basename "$APK")"

if out=$("$ADB" -s "$SERIAL" install -r "$APK" 2>&1); then
  echo "$out" | tail -2
  exit 0
fi
echo "$out" | tail -2
case "$out" in
  *INSTALL_FAILED_USER_RESTRICTED*|*INSTALL_FAILED_VERIFICATION_FAILURE*|*INSTALL_CANCELED_BY_USER*) ;;
  *) exit 1 ;;
esac

echo "被系统安装器拦下，改走 root 安装…"
"$ADB" -s "$SERIAL" shell "su -c 'settings put global verifier_verify_adb_installs 0; settings put global package_verifier_enable 0'" >/dev/null 2>&1 || true
"$ADB" -s "$SERIAL" push "$APK" /data/local/tmp/pet-install.apk >/dev/null
"$ADB" -s "$SERIAL" shell "su -c 'pm install -r -t /data/local/tmp/pet-install.apk'" 2>&1 | tail -2
"$ADB" -s "$SERIAL" shell "rm -f /data/local/tmp/pet-install.apk" >/dev/null 2>&1 || true
