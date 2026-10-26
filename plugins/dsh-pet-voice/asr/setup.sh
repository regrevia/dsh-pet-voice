#!/usr/bin/env bash
# 建一个专属 venv 并装 openai-whisper（本机识别，可选）。
# 手机上默认用系统语音识别，这条只是给「想在这台电脑上识别」的人用：不装也能用，只是识别走手机。
#
#   bash plugins/dsh-pet-voice/asr/setup.sh            # 默认 large-v3-turbo
#   DSH_PET_ASR_MODEL=small bash plugins/dsh-pet-voice/asr/setup.sh
#
# venv 落在 ~/.dsh/pet-voice/asr-venv（不放插件目录，插件目录要随仓库同步）。
# 注意：whisper 会把 torch 一起拉下来（首次几 GB），CPU 也能跑，慢一点。
set -euo pipefail

VENV="${DSH_PET_ASR_VENV:-$HOME/.dsh/pet-voice/asr-venv}"
PYTHON="${PYTHON:-/usr/bin/python3}"
MODEL="${DSH_PET_ASR_MODEL:-large-v3-turbo}"

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

if "$VENV/bin/python" -c 'import whisper' >/dev/null 2>&1; then
  say "✓ openai-whisper 已就绪，跳过安装"
else
  say "· 安装 openai-whisper（会连带 torch，首次可能几 GB，慢）"
  if ! "$VENV/bin/python" -m pip install -q --disable-pip-version-check --upgrade pip >/dev/null 2>&1; then
    say "（pip 自更新失败，继续用自带的）"
  fi
  if ! "$VENV/bin/python" -m pip install -q --disable-pip-version-check openai-whisper; then
    say "✗ pip install openai-whisper 失败：检查网络 / 代理，或手动执行"
    say "  $VENV/bin/pip install openai-whisper"
    exit 1
  fi
fi

say "· 预下载模型：$MODEL（第一次要在网上拉，之后离线可用）"
if ! "$VENV/bin/python" - "$MODEL" <<'PY'
import sys
import whisper
whisper.load_model(sys.argv[1])
PY
then
  say "✗ 模型下载失败：检查网络 / 代理；装好了也能用，只是第一次识别会现拉"
  exit 1
fi

VER="$("$VENV/bin/python" - <<'PY'
try:
    import importlib.metadata as m
    print(m.version("openai-whisper"))
except Exception:
    print("unknown")
PY
)"
say "✓ 本机识别已装好：openai-whisper $VER · 模型 $MODEL"
say "  python: $VENV/bin/python"
say "  验证：面板「更多 → 自检」，或直接跟精灵说一句话"
