#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ASR 延迟实测（openai-whisper，Metal/MPS + CPU）

背景：本机 whisper.cpp 不可用（brew 无写权限 + 无 cmake），pip --user 被沙箱拒绝，
外网 ~20KB/s 无法下 ggml 模型。但 ~/.cache/whisper 里已缓存 base.pt 与
large-v3-turbo.pt，且 openai-whisper 已装（需用 bench/vendor 里的新
typing_extensions 覆盖系统旧版）。因此这里测的是**同一套 Whisper 权重 +
PyTorch 实现**的耗时，属于 whisper.cpp 的上界（cpp 版通常更快）。

用法:
  PYTHONPATH=bench/vendor python3 bench/asr_bench.py
输出: bench/results/asr_bench.json
"""
import json
import os
import statistics
import sys
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "results")
AUD = os.path.join(HERE, "audio")
RES = os.path.join(AUD, "mid_20_16k.wav")

CASES = [
    ("base", "cpu"),
    ("base", "mps"),
    ("large-v3-turbo", "mps"),
]
TEXTS = {
    "mid_20_16k.wav": "你好，我是小宠，今天想陪你聊聊天。",
}


def load(whisper, torch, name, device):
    t0 = time.perf_counter()
    m = whisper.load_model(name, device=device)
    return m, (time.perf_counter() - t0) * 1000.0


def transcribe(m, path, prompt=""):
    t0 = time.perf_counter()
    r = m.transcribe(path, language="zh", fp16=False, initial_prompt=prompt,
                     condition_on_previous_text=False, verbose=False)
    return (time.perf_counter() - t0) * 1000.0, r.get("text", "").strip()


def clip_prefix(src, dst, seconds):
    w = wave.open(src, "rb")
    n = int(w.getframerate() * seconds) * w.getsampwidth() * w.getnchannels()
    frames = w.readframes(int(w.getframerate() * seconds))
    o = wave.open(dst, "wb")
    o.setnchannels(w.getnchannels()); o.setsampwidth(w.getsampwidth()); o.setframerate(w.getframerate())
    o.writeframes(frames); o.close(); w.close()
    return dst


def dur_of(p):
    w = wave.open(p, "rb"); d = w.getnframes() / float(w.getframerate()); w.close(); return d


def main():
    import torch
    import whisper
    os.makedirs(OUT, exist_ok=True)
    clip_prefix(RES, os.path.join(AUD, "prefix_1p5s.wav"), 1.5)
    clip_prefix(RES, os.path.join(AUD, "prefix_3s.wav"), 3.0)
    rows = []
    for name, device in CASES:
        if device == "mps" and not torch.backends.mps.is_available():
            continue
        try:
            m, load_ms = load(whisper, torch, name, device)
        except Exception as e:
            print("load fail", name, device, type(e).__name__, str(e)[:120], file=sys.stderr)
            continue
        full = []
        text = ""
        for i in range(3):
            ms, text = transcribe(m, RES)
            full.append(ms)
        warm = None
        # 首包延迟：只喂 1.5s 前缀（模拟"说完一小句就先出字"）
        p15 = []
        for i in range(3):
            ms, t1 = transcribe(m, os.path.join(AUD, "prefix_1p5s.wav"))
            p15.append(ms)
            warm = (statistics.median(p15), t1)
        p3 = []
        for i in range(3):
            ms3, t3 = transcribe(m, os.path.join(AUD, "prefix_3s.wav"))
            p3.append(ms3)
        warm = (statistics.median(p15), warm[1])
        d = dur_of(RES)
        rows.append({
            "model": name, "device": device,
            "load_ms": round(load_ms, 1),
            "transcribe_4_23s_ms": {"min": round(min(full), 1),
                                    "median": round(statistics.median(full), 1),
                                    "max": round(max(full), 1)},
            "rtf": round(statistics.median(full) / 1000.0 / d, 3),
            "prefix_1p5s_ms": round(warm[0], 1),
            "prefix_1p5s_text": warm[1],
            "prefix_3s_ms": round(statistics.median(p3), 1),
            "prefix_3s_text": t3,
            "text": text,
            "correct": text.replace(" ", "") == TEXTS["mid_20_16k.wav"].replace("，", "").replace("。", "") or None,
        })
        del m
    res = {"note": "openai-whisper (PyTorch) 权重与 whisper.cpp 相同；cpp+Metal 通常更快，故本表为上限",
           "env": {"torch": torch.__version__, "mps": torch.backends.mps.is_available(),
                   "python": sys.version.split()[0], "machine": os.uname().machine},
           "reference_text": TEXTS["mid_20_16k.wav"],
           "rows": rows,
           "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    with open(os.path.join(OUT, "asr_bench.json"), "w") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
