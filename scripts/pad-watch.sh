#!/usr/bin/env bash
# 平板操作回看：真机（或模拟器）屏幕上一直在录，但只留最近 3 分钟。
#
# 为什么不是一直往电脑上传：录像是自己看（排查「点了没反应」「尺寸跳一下」这类
# 只有肉眼看得出的事）。所以录制、裁剪都在设备上做，电脑只在被要求时才拉。
#
# 用法：
#   bash scripts/pad-watch.sh start [serial]   # 后台开始滚录（默认 15ca9736）
#   bash scripts/pad-watch.sh status [serial]
#   bash scripts/pad-watch.sh pull [秒数] [serial]  # 拉最近 N 秒到 local/rec/
#   bash scripts/pad-watch.sh stop [serial]
#
# 成本（720p/30fps/4Mbps，骁龙 8 Gen 3 这类机器）：
#   CPU 约 3–6%（走硬件编码器），电量约 2–4%/小时，设备上占 90MB 左右
#   （20 秒一段 × 9 段 ≈ 3 分钟，旧段自己删）。不上传，所以不耗电脑和流量。
#   想更省：PW_FPS=15 PW_BITRATE=2M bash scripts/pad-watch.sh start

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADB="${ADB:-/opt/homebrew/share/android-commandlinetools/platform-tools/adb}"
SERIAL="${PW_SERIAL:-15ca9736}"
DEV_DIR="${PW_DEV_DIR:-/sdcard/pet-watch}"
SECONDS_KEEP="${PW_KEEP_SECONDS:-180}"
SEG_SECONDS="${PW_SEG_SECONDS:-20}"
BITRATE="${PW_BITRATE:-4M}"
FPS="${PW_FPS:-30}"
SIZE="${PW_SIZE:-1280x854}"
RUN_DIR="$ROOT/local"
PID_FILE="$RUN_DIR/pad-watch.pid"
LOG_FILE="$RUN_DIR/pad-watch.log"
PULL_DIR="$ROOT/local/rec"

say() { printf '%s\n' "$*"; }

device_alive() {
  "$ADB" -s "$SERIAL" shell true >/dev/null 2>&1
}

seg_cmd() {
  # screenrecord 每次最多录 SEG_SECONDS 秒就自己退出，循环接着录下一段：
  # 这样每段都是一个完整 mp4（能直接播放），而且「滚动删除」只要删老文件。
  printf 'mkdir -p %s; screenrecord --time-limit %s --bit-rate %s --size %s %s/seg-$(date +%%s).mp4' \
    "$DEV_DIR" "$SEG_SECONDS" "$BITRATE" "$SIZE" "$DEV_DIR"
}

record_loop() {
  while true; do
    if ! device_alive; then
      say "$(date '+%H:%M:%S') 设备不在，5 秒后重试"
      sleep 5
      continue
    fi
    # 上一轮如果被打断（kill 掉主机侧循环、adb 掉线），设备上会留下还在写的
    # screenrecord：再开一段就有两个在录同一个屏，白耗电。进来先收拾干净。
    "$ADB" -s "$SERIAL" shell "pkill -f 'screenrecord.*$DEV_DIR'" >/dev/null 2>&1 || true
    # 再清旧的（按文件数保留最近 KEEP_SEG 段，兜底按时间删）
    keep_seg=$((SECONDS_KEEP / SEG_SECONDS + 2))
    "$ADB" -s "$SERIAL" shell "ls -1t $DEV_DIR/seg-*.mp4 2>/dev/null | tail -n +\$(( ${keep_seg} + 1 )) | xargs -r rm -f" >/dev/null 2>&1 || true
    "$ADB" -s "$SERIAL" shell "find $DEV_DIR -name 'seg-*.mp4' -mmin +$(( (SECONDS_KEEP + 60) / 60 )) -delete" >/dev/null 2>&1 || true
    say "$(date '+%H:%M:%S') 录一段 ${SEG_SECONDS}s"
    # screenrecord 在前台跑满时间自己退；失败就歇 2 秒，别连着重试打爆 adb
    "$ADB" -s "$SERIAL" shell "$(seg_cmd)" >/dev/null 2>&1 || sleep 2
  done
}

cmd_start() {
  mkdir -p "$RUN_DIR"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    say "已经在录（pid $(cat "$PID_FILE")）"
    return 0
  fi
  device_alive || { say "设备没连上：$SERIAL"; return 1; }
  if ! "$ADB" -s "$SERIAL" shell "command -v screenrecord >/dev/null && echo ok" 2>/dev/null | grep -q ok; then
    say "这台设备没有 screenrecord，录不了"
    return 1
  fi
  "$ADB" -s "$SERIAL" shell "mkdir -p $DEV_DIR" >/dev/null 2>&1
  nohup bash -c "$(declare -f say device_alive seg_cmd record_loop); SERIAL='$SERIAL' ADB='$ADB' DEV_DIR='$DEV_DIR' SEG_SECONDS='$SEG_SECONDS' SECONDS_KEEP='$SECONDS_KEEP' BITRATE='$BITRATE' FPS='$FPS' SIZE='$SIZE'; record_loop" \
    >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  say "开始滚录：${SIZE} ${BITRATE} 每段 ${SEG_SECONDS}s，只留最近 ${SECONDS_KEEP}s"
  say "pid $(cat "$PID_FILE")，日志 $LOG_FILE"
}

cmd_stop() {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  # 后台那层循环死了也可能留下一个正在跑的 screenrecord
  pkill -f "pad-watch" 2>/dev/null || true
  if device_alive; then
    "$ADB" -s "$SERIAL" shell "pkill -f screenrecord" >/dev/null 2>&1 || true
  fi
  say "停了"
}

cmd_status() {
  local alive="没在录"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    alive="在录（pid $(cat "$PID_FILE")）"
  fi
  say "$alive"
  if device_alive; then
    local n total oldest newest
    n=$("$ADB" -s "$SERIAL" shell "ls -1 $DEV_DIR/seg-*.mp4 2>/dev/null | wc -l" 2>/dev/null | tr -d '\r')
    total=$("$ADB" -s "$SERIAL" shell "du -sh $DEV_DIR 2>/dev/null | cut -f1" 2>/dev/null | tr -d '\r')
    oldest=$("$ADB" -s "$SERIAL" shell "ls -1t $DEV_DIR/seg-*.mp4 2>/dev/null | tail -1" 2>/dev/null | tr -d '\r')
    newest=$("$ADB" -s "$SERIAL" shell "ls -1t $DEV_DIR/seg-*.mp4 2>/dev/null | head -1" 2>/dev/null | tr -d '\r')
    say "设备上 ${n:-0} 段，占 ${total:-0}"
    [ -n "$newest" ] && say "最新 $newest"
    [ -n "$oldest" ] && say "最老 $oldest"
  else
    say "设备没连上：$SERIAL"
  fi
}

# pull [秒数] [serial]：把覆盖最近 N 秒的几段拉到 local/rec/，只在被要求时跑。
cmd_pull() {
  local want="${1:-180}"
  local serial="${2:-$SERIAL}"
  SERIAL="$serial"
  device_alive || { say "设备没连上：$serial"; return 1; }
  mkdir -p "$PULL_DIR"
  local keep=$(( (want / SEG_SECONDS) + 2 ))
  local files
  # macOS 自带 bash 3.2 没有 mapfile，用 while read 装数组
  files=()
  while IFS= read -r f; do
    [ -n "$f" ] && files+=("$f")
  done < <("$ADB" -s "$SERIAL" shell "ls -1t $DEV_DIR/seg-*.mp4 2>/dev/null | head -$keep" 2>/dev/null | tr -d '\r')
  if [ ${#files[@]} -eq 0 ]; then
    say "设备上没有录像，先 bash scripts/pad-watch.sh start"
    return 1
  fi
  for f in "${files[@]}"; do
    "$ADB" -s "$SERIAL" pull "$f" "$PULL_DIR/" >/dev/null 2>&1 || say "拉失败：$f"
  done
  say "拉到 ${PULL_DIR}：${#files[@]} 段（覆盖最近约 $(( ${#files[@]} * SEG_SECONDS ))s）"
  ls -1t "$PULL_DIR"/*.mp4 2>/dev/null | head -"$keep"
}

case "${1:-}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  pull)   cmd_pull "${2:-180}" "${3:-$SERIAL}" ;;
  *)      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
esac
