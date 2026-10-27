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

# Apple Silicon + Python ≥3.10 才能装 mlx-whisper（Metal 实现）：同模型热路径约 0.5 s，CPU whisper 约 1.3 s，
# 冷启动也短一截（3.9 s vs 6.6 s）。装不上就照旧用 CPU whisper，不影响使用。
MLX_OK=0
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  if "$VENV/bin/python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    if "$VENV/bin/python" -c 'import mlx_whisper' >/dev/null 2>&1; then
      MLX_OK=1
      say "· mlx-whisper 已在，跳过安装"
    else
      say "· 安装 mlx-whisper（Metal，同样的模型快 2~2.5 倍）"
      if HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}" HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}" \
         "$VENV/bin/python" -m pip install -q --disable-pip-version-check mlx-whisper >/tmp/pet-asr-mlx-install.log 2>&1; then
        MLX_OK=1
      else
        say "（mlx-whisper 装失败，退回 CPU whisper；日志 /tmp/pet-asr-mlx-install.log）"
      fi
    fi
  else
    say "· 这个 venv 是 $("$VENV/bin/python" -V 2>&1)，mlx-whisper 要 3.10+，跳过（继续用 CPU whisper）"
    say "  想提速：用 3.12 重建，PYTHON=/path/to/python3.12 bash $0"
  fi
fi

say "· 预下载模型：${MODEL}（第一次要在网上拉，之后离线可用）"
PRELOAD_FAIL=0
if [ "$MLX_OK" = 1 ]; then
  # 模型仓库名要和 asr-worker.py 里的 MLX_REPOS 一致（turbo 没有 -mlx 后缀）
  if ! HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}" HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}" \
       "$VENV/bin/python" - "$MODEL" <<'PY'
import sys
import numpy as np
import mlx_whisper

REPOS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}
mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32),
                       path_or_hf_repo=REPOS.get(sys.argv[1], sys.argv[1]), language="zh")
PY
  then
    PRELOAD_FAIL=1
  fi
elif ! "$VENV/bin/python" - "$MODEL" <<'PY'
import sys
import whisper
whisper.load_model(sys.argv[1])
PY
then
  PRELOAD_FAIL=1
fi
if [ "$PRELOAD_FAIL" = 1 ]; then
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
BACKEND="openai-whisper（CPU）"
if [ "$MLX_OK" = 1 ]; then BACKEND="mlx-whisper（Metal）"; fi
say "✓ 本机识别已装好：$BACKEND · 模型 $MODEL"
say "  python: $VENV/bin/python"
say "  验证：面板「更多 → 自检」，或直接跟精灵说一句话"
