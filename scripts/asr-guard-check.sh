#!/usr/bin/env bash
# ASR 单实例守护自检：worker 只能有一个、锁不能挂着死 pid。
# 用法：bash scripts/asr-guard-check.sh
set -u
n=$(pgrep -f 'asr-worker.py --host' | wc -l | tr -d ' ')
echo "workers=$n"
[ "$n" -le 1 ] || { echo "FAIL 并发载模型会把系统压崩（2026-10-26 jetsam 12.7GB）"; exit 1; }
lock="$HOME/.dsh/pet-voice/asr/start.lock"
if [ -f "$lock" ]; then
  pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$lock")
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    echo "FAIL 锁里是死 pid=$pid（下次请求会跟着一个僵进程死等）"; exit 1
  fi
  echo "lock=held pid=$pid"
fi
echo OK
