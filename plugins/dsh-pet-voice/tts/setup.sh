#!/usr/bin/env bash
# 建一个专属 venv 并装 edge-tts（微软 Edge 神经 TTS，免 key 免账号）。
# 幂等：已经能用就直接退出；重复跑不会重装。
#
#   bash plugins/dsh-pet-voice/tts/setup.sh
#
# venv 落在 ~/.dsh/pet-voice/tts-venv（不放插件目录，插件目录可能要随仓库同步）。
set -euo pipefail

VENV="${DSH_PET_TTS_VENV:-$HOME/.dsh/pet-voice/tts-venv}"
PYTHON="${PYTHON:-/usr/bin/python3}"

say() { printf '%s\n' "$*"; }

if [ ! -x "$PYTHON" ]; then
  say "✗ 找不到 python3：$PYTHON"
  say "  用 PYTHON=/path/to/python3 bash $0 指定一个（需要 3.9+ 且带 venv 模块）"
  exit 1
fi

if [ ! -x "$VENV/bin/python" ]; then
  say "· 建 venv：$VENV"
  mkdir -p "$(dirname "$VENV")"
  if ! "$PYTHON" -m venv "$VENV" >/dev/null 2>&1; then
    say "✗ 建 venv 失败。多半是缺 venv 模块：Debian/Ubuntu 上 apt install python3-venv"
    exit 1
  fi
fi

if "$VENV/bin/python" -c 'import edge_tts' >/dev/null 2>&1; then
  say "✓ edge-tts 已就绪，跳过安装"
else
  say "· 安装 edge-tts（首次约 10–30 秒，会拉 aiohttp 等依赖）"
  if ! "$VENV/bin/python" -m pip install -q --disable-pip-version-check --upgrade pip >/dev/null 2>&1; then
    say "（pip 自更新失败，继续用自带的）"
  fi
  if ! "$VENV/bin/python" -m pip install -q --disable-pip-version-check edge-tts; then
    say "✗ pip install edge-tts 失败：检查网络 / 代理，或手动执行"
    say "  $VENV/bin/pip install edge-tts"
    exit 1
  fi
fi

VER="$("$VENV/bin/python" - <<'PY'
try:
    import importlib.metadata as m
    print(m.version("edge-tts"))
except Exception:
    print("unknown")
PY
)"
say "✓ 神经语音已装好：edge-tts $VER"
say "  python: $VENV/bin/python"
say "  验证：node plugins/dsh-pet-voice/tts/check.mjs"
