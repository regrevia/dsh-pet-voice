#!/usr/bin/env bash
# 悬浮窗「大小固定」回归闸：出包前跑一次，别让卡片尺寸又跟着字数/连点变。
#
# 两个证据面：
#   1) 真机运行时窗口 frame 是否恒定（待机 / 提示 / 思考 / 回复 各态都量一遍）；
#   2) 装进包里的 asset 是否还是「62px 固定卡 + 3 行截断 + 只跟窗口高有关的 --shift/--shrink」。
#
# 用法：
#   scripts/pet-size-check.sh                     # 量当前前台，对比上次记录的尺寸
#   scripts/pet-size-check.sh --n 20 --step 0.16  # 连点/多态期间连采（默认 12 次 × 0.2s）
#   scripts/pet-size-check.sh --apk <path>        # 顺便校验 APK 内的 asset
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
N=12
STEP=0.2
APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
while [ $# -gt 0 ]; do
  case "$1" in
    --n) N=$2; shift 2 ;;
    --step) STEP=$2; shift 2 ;;
    --apk) APK=$2; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

sizes=$(python3 "$ROOT/local/winwatch.py" --n "$N" --step "$STEP" 2>/dev/null \
  | sed -n 's/.*size=\([0-9]*x[0-9]*\).*/\1/p')
if [ -z "$sizes" ]; then
  echo "✗ 量不到悬浮窗：先确认 App 在跑、悬浮窗没被历史页挡住" >&2
  exit 1
fi
uniq_sizes=$(printf '%s\n' "$sizes" | sort -u)
count=$(printf '%s\n' "$sizes" | grep -c .)
if [ "$(printf '%s\n' "$uniq_sizes" | grep -c .)" -eq 1 ]; then
  echo "· 窗口尺寸 ${count}/${count} 次一致：$(printf '%s' "$uniq_sizes")"
else
  echo "✗ 窗口尺寸变了（${count} 次采样）：" >&2
  printf '  %s\n' $uniq_sizes >&2
fi

fail=0
# 卡片高度只有一个真相：template.html 里 #bubble 的 height。boot.js 的 bubH 必须跟它相等，
# 否则 --shift/--shrink 会按两个不同的数算，舞台缩放跟着字数抖。这里现读现值，不再写死数字。
EXPECT_H=$(sed -n '/#bubble[ {]/,/}/p' "$ROOT/android/app/src/main/assets/pet/template.html" \
  | sed -n 's/.*height: *\([0-9]\{1,3\}\)px.*/\1/p' | head -1)
BOOT_H=$(sed -n 's/.*const bubH *= *\([0-9]\{1,3\}\).*/\1/p' "$ROOT/android/app/src/main/assets/pet/boot.js" | head -1)
if [ -z "$EXPECT_H" ] || [ -z "$BOOT_H" ]; then
  echo "✗ 读不到卡片高度（template.html height / boot.js bubH）" >&2
  fail=1
elif [ "$EXPECT_H" != "$BOOT_H" ]; then
  echo "✗ 两处高度不一致：template.html ${EXPECT_H}px vs boot.js bubH=${BOOT_H}" >&2
  fail=1
else
  echo "· 源码两处高度一致：${EXPECT_H}px"
fi

if [ -f "$APK" ]; then
  asset=$(unzip -p "$APK" assets/pet/index.html 2>/dev/null)
  for pat in "const bubH = ${EXPECT_H:-0}" "height: ${EXPECT_H:-0}px" 'line-clamp: 3'; do
    if printf '%s' "$asset" | grep -qF "$pat"; then
      echo "· APK asset 含固定尺寸约束：$pat"
    else
      echo "✗ APK asset 缺固定尺寸约束：$pat" >&2
      fail=1
    fi
  done
  # 让位/缩小只能由窗口高算出来，出现「按气泡高度算」就是把字数接回了尺寸。
  if printf '%s' "$asset" | grep -qF 'bubble.offsetHeight'; then
    echo "✗ asset 里又按气泡实测高度算让位了（会随字数变）" >&2
    fail=1
  fi
else
  echo "· 跳过 APK 校验（没找到 $APK）"
fi

if [ "$(printf '%s\n' "$uniq_sizes" | grep -c .)" -ne 1 ] || [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "· 通过：窗口恒定 + 卡片固定"
