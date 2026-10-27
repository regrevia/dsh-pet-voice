#!/usr/bin/env bash
# 按住说话 → 听见第一声：真机端到端实测。
#
# 没法用真人麦克风时，这条链路用 Mac 的 Tingting 中文 TTS 从**平板自己的音箱**放出来，
# 再让平板麦克风收进去，走完整的 按住说话 → ASR → 宿主 → 模型 → TTS → 悬浮窗出声。
# 数字全部来自 App 自己的 PetLatency 埋点（相对松手那一刻），不是估的。
#
# 用法：
#   bash scripts/pet-ptt-latency.sh                 # 5 轮
#   ROUNDS=10 bash scripts/pet-ptt-latency.sh       # 10 轮（给 p95 用）
#   SKIP_LOG_CLEAR=1 bash scripts/pet-ptt-latency.sh
#
# 前提：平板解锁、悬浮窗在、ASR worker ready、Mac 有 Tingting 音色。
set -uo pipefail

# 宿主端口每次启动都可能变，别写死（见 scripts/lib/pv-base.sh）
. "$(dirname "$0")/lib/pv-base.sh"

SERIAL=${ANDROID_SERIAL:-15ca9736}
ADB="adb -s $SERIAL"
ROUNDS=${ROUNDS:-5}
HOLD_MS=${HOLD_MS:-3200}
WAIT_MS=${WAIT_MS:-9000}
VOICE=${VOICE:-Tingting}
# 悬浮窗「按住说话」的落点：input 注入用**逻辑横屏**坐标（这台是 3200x2136），
# 不是 screencap 竖屏系（2136x3200）。竖屏点 (515,2947) 换过来约等于 (536,2947)，
# 但 y=2947 在横屏里已经出屏，事件根本到不了窗口 —— 别再写竖屏坐标。
PET_X=${PET_X:-2947}
PET_Y=${PET_Y:-1600}
SENTENCES=(
  "帮我看看今天天气怎么样"
  "讲个特别短的笑话"
  "你现在在干什么呀"
  "给我推荐一部电影"
  "随便夸我一句"
)
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

die() { echo "❌ $1" >&2; exit 2; }

command -v adb >/dev/null || die "没有 adb"
command -v say >/dev/null || die "没有 say（macOS）"
$ADB shell true 2>/dev/null || die "设备 $SERIAL 不在线"
say -v "$VOICE" "" 2>/dev/null || die "Mac 上没有音色 $VOICE"
BASE=$(pv_base) || die "找不到在跑的宿主 /pet-voice（先确认 DSH 开着、插件已启用）"
curl -s --max-time 5 "$BASE/api/asr" \
  -H "authorization: Bearer $(cat "$HOME/.dsh/pet-voice/token")" \
  -H "x-pet-device-id: f889981fe0f4" 2>/dev/null | grep -q '"ready":true' \
  || echo "⚠️  ASR 看起来没 ready，先跑 scripts/asr-bench.sh 看环境" 
[ -n "$($ADB shell pidof com.whale.pet | tr -d '\r')" ] || die "App 没在跑（先 adb shell am start -n com.whale.pet/.MainActivity）"

[ -z "${SKIP_LOG_CLEAR:-}" ] && $ADB logcat -c
echo "--- $ROUNDS 轮，每轮按住 ${HOLD_MS}ms，音色 $VOICE"
i=0
while [ "$i" -lt "$ROUNDS" ]; do
  s=${SENTENCES[$((i % ${#SENTENCES[@]}))]}
  echo "--- 第 $((i+1)) 轮：$s"
  # 按住：同一坐标 + 时长 = 一直按住不放，期间把话说完。
  # 时长必须 ≥1200ms，否则 App 判成误触（PetTap 开麦 hold=true → 松手：没在录）。
  $ADB shell input swipe "$PET_X" "$PET_Y" "$PET_X" "$PET_Y" "$HOLD_MS" &
  swipe_pid=$!
  sleep 0.5
  say -v "$VOICE" "$s"
  wait "$swipe_pid" 2>/dev/null
  sleep "$(awk -v ms="$WAIT_MS" 'BEGIN{printf "%.1f", ms/1000}')"
  i=$((i+1))
done

$ADB logcat -d -v brief -s PetLatency >"$TMPD/lat.txt" 2>/dev/null
[ -s "$TMPD/lat.txt" ] || die "没抓到 PetLatency 行（App 是 132+ 才有埋点）"

/usr/bin/python3 - "$TMPD/lat.txt" <<'PY'
import re, sys, statistics as st
lines = [l.rstrip() for l in open(sys.argv[1], encoding='utf-8', errors='replace')]
rounds, cur = [], None
for l in lines:
    m = re.search(r'指令分流 \+(\d+)ms', l)
    if m:
        if cur: rounds.append(cur)
        cur = {'分流': int(m.group(1)), '首句': None, '可播': None}
        continue
    if cur is None: continue
    m = re.search(r'首句 \+(\d+)ms', l)
    if m and cur['首句'] is None: cur['首句'] = int(m.group(1))
    m = re.search(r'TTS 可播 (\d+)ms', l)
    if m and cur['可播'] is None: cur['可播'] = int(m.group(1))
if cur: rounds.append(cur)

def col(k):
    return [r[k] for r in rounds if r.get(k)]

def fmt(vals, unit='ms'):
    if not vals: return '—'
    v = sorted(vals)
    p95 = v[min(len(v)-1, int(round(len(v)*0.95))-1 if len(v) > 1 else 0)]
    return '中位 %d%s  p95 %d%s  min %d  max %d（n=%d）' % (
        st.median(v), unit, p95, unit, v[0], v[-1], len(v))

print()
print('松手 → 分流（ASR+问一句）  :', fmt(col('分流')))
print('松手 → 首句文本到手        :', fmt(col('首句')))
print('松手 → 首句真的出声        :', fmt(col('可播')))
fill = sum(1 for l in lines if '填充句命中缓存' in l)
miss = sum(1 for l in lines if '填充句未命中缓存' in l)
print('填充句命中 %d 次 / 未命中 %d 次（未命中=松手后一段时间是静音）' % (fill, miss))
if col('可播'):
    gaps = [r['可播'] - r['首句'] for r in rounds if r.get('首句') and r.get('可播')]
    if gaps: print('首句文本 → 出声（TTS+播放）:', fmt(gaps))
PY
