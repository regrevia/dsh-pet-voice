#!/usr/bin/env python3
"""在基准样音上叠加可复现的噪声，模拟真实手机录音（远场/底噪/弱麦）。

用法：asr-venv/bin/python degrade.py
输出 samples_noisy/{snr15,snr10,snr5}/<原文件名> + refs.json 副本。
"""
from __future__ import annotations

import json
import pathlib
import shutil
import wave

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "samples"
OUT = HERE / "samples_noisy"
SNRS = (15, 10, 5)


def read_wav(path: pathlib.Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wav:
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768.0


def write_wav(path: pathlib.Path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(x, -1.0, 1.0)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes((pcm * 32767.0).astype("<i2").tobytes())


def main() -> None:
    refs = json.loads((SRC / "refs.json").read_text(encoding="utf-8"))
    for snr in SNRS:
        (OUT / f"snr{snr}").mkdir(parents=True, exist_ok=True)
        for name in refs:
            speech = read_wav(SRC / name)
            rng = np.random.default_rng(abs(hash((name, snr))) % (2**32))
            noise = rng.standard_normal(speech.shape[0]).astype(np.float32)
            speech_rms = float(np.sqrt(np.mean(speech**2))) or 1e-6
            noise_rms = float(np.sqrt(np.mean(noise**2))) or 1e-6
            target_snr = 10 ** (snr / 20.0)
            noise *= speech_rms / (noise_rms * target_snr)
            write_wav(OUT / f"snr{snr}" / name, speech + noise)
        shutil.copy(SRC / "refs.json", OUT / f"snr{snr}" / "refs.json")
        print(f"snr{snr}: {len(refs)} 条")


if __name__ == "__main__":
    main()
