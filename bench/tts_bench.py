#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TTS 延迟实测：macOS `say` -> afconvert(m4a) -> ffmpeg(16k mono wav)

只测本机（macOS 26.5.2 / Apple Silicon）。每步 wall time 用 time.perf_counter，
进程启动开销包含在内 —— 这就是真实管线的冷启动代价。

用法: python3 bench/tts_bench.py [--repeat 5]
输出: bench/results/tts_bench.json
"""
import json
import os
import subprocess
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "results")
AUD = os.path.join(HERE, "audio")

# 三档文本：短句(12 字) / 中句(20 字) / 长句(40 字)
TEXTS = {
    "short_12": "你好，今天天气怎么样？",
    "mid_20": "你好，我是小宠，今天想陪你聊聊天。",
    "long_40": "你好，我是小宠。今天天气不错，我们可以一起出门走走，"
               "顺便聊聊你最近在忙的事情，放松一下心情。",
}


def run(cmd):
    t0 = time.perf_counter()
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    dt = (time.perf_counter() - t0) * 1000.0
    if p.returncode != 0:
        raise RuntimeError("%s failed: %s" % (cmd, p.stderr.decode("utf-8", "ignore")[:300]))
    return dt


def probe_duration(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", path],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        return float(p.stdout.decode().strip())
    except ValueError:
        return None


def bench(repeat=5, voice="Tingting"):
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(AUD, exist_ok=True)
    rows = []
    for name, text in TEXTS.items():
        say_ms, afc_ms, ff_ms = [], [], []
        dur = None
        for i in range(repeat):
            aiff = os.path.join(AUD, "%s_%d.aiff" % (name, i))
            m4a = os.path.join(AUD, "%s_%d.m4a" % (name, i))
            wav = os.path.join(AUD, "%s_16k.wav" % name)
            say_ms.append(run(["say", "-v", voice, "-o", aiff, text]))
            afc_ms.append(run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "32000", aiff, m4a]))
            ff_ms.append(run(["ffmpeg", "-y", "-v", "error", "-i", aiff,
                              "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]))
            dur = probe_duration(aiff)
        rows.append({
            "case": name,
            "chars": len(text),
            "voice": voice,
            "say_ms": _stats(say_ms),
            "afconvert_m4a_ms": _stats(afc_ms),
            "ffmpeg_16k_wav_ms": _stats(ff_ms),
            "synth_audio_duration_s": dur,
            "rtf_say": round(statistics.median(say_ms) / 1000.0 / dur, 3) if dur else None,
        })
    result = {
        "env": {"os": _os(), "machine": os.uname().machine, "python": sys.version.split()[0],
                "say": subprocess.run(["say", "-v", "?"], stdout=subprocess.PIPE).stdout.decode().count("\n")},
        "repeat": repeat,
        "rows": rows,
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    with open(os.path.join(OUT, "tts_bench.json"), "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    return result


def _stats(xs):
    xs = sorted(xs)
    return {"min": round(xs[0], 1), "median": round(statistics.median(xs), 1),
            "max": round(xs[-1], 1), "n": len(xs)}


def _os():
    p = subprocess.run(["sw_vers", "-productVersion"], stdout=subprocess.PIPE)
    return "macOS " + p.stdout.decode().strip()


if __name__ == "__main__":
    rep = 5
    if "--repeat" in sys.argv:
        rep = int(sys.argv[sys.argv.index("--repeat") + 1])
    r = bench(rep)
    print(json.dumps(r, ensure_ascii=False, indent=2))
