#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""语音链路编解码/封包开销实测：16k mono -> Opus(20ms 帧) -> 解码 -> 16k wav

测量 ffmpeg 进程内 wall time（含进程启动）与码率，作为上行/下行带宽预算依据。
输出 bench/results/codec_bench.json
"""
import json
import os
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "results")
AUD = os.path.join(HERE, "audio")

CASES = [
    ("opus_16k_24kbps", ["-c:a", "libopus", "-b:a", "24k", "-ar", "16000", "-ac", "1",
                         "-frame_duration", "20", "-application", "voip"]),
    ("opus_16k_16kbps", ["-c:a", "libopus", "-b:a", "16k", "-ar", "16000", "-ac", "1",
                         "-frame_duration", "20", "-application", "voip"]),
    ("aac_16k_32kbps", ["-c:a", "aac", "-b:a", "32k", "-ar", "16000", "-ac", "1"]),
]


def timed(cmd):
    t0 = time.perf_counter()
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    dt = (time.perf_counter() - t0) * 1000.0
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode("utf-8", "ignore")[:200])
    return dt


def main():
    os.makedirs(OUT, exist_ok=True)
    src = os.path.join(AUD, "mid_20_0.aiff")
    rows = []
    dur = 4.232381  # ffprobe 实测
    for name, args in CASES:
        ext = ".opus" if "opus" in name else ".m4a"
        out = os.path.join(AUD, name + ext)
        enc = [timed(["ffmpeg", "-y", "-v", "error", "-i", src] + args + [out]) for _ in range(3)]
        dec_out = os.path.join(AUD, name + "_dec.wav")
        dec = [timed(["ffmpeg", "-y", "-v", "error", "-i", out, "-ar", "16000", "-ac", "1",
                      "-c:a", "pcm_s16le", dec_out]) for _ in range(3)]
        size = os.path.getsize(out)
        rows.append({
            "case": name,
            "encode_ms": {"median": round(sorted(enc)[1], 1)},
            "decode_ms": {"median": round(sorted(dec)[1], 1)},
            "bytes": size,
            "effective_kbps": round(size * 8 / dur / 1000.0, 1),
            "encode_rtf": round(sorted(enc)[1] / 1000.0 / dur, 4),
            "packet_ms": 20,
            "packets_for_4_23s": int(round(dur * 1000 / 20)),
            "note": "含 ffmpeg 进程启动开销，故为上限",
        })
    res = {"source": "mid_20 (17 字, 4.23s)", "rows": rows,
           "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    with open(os.path.join(OUT, "codec_bench.json"), "w") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
