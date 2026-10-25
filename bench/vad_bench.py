#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""VAD / 断句延迟实测（纯标准库，无第三方依赖）

构造：0.6s 静音 + 语音 + 0.6s 静音，16kHz mono s16le。
用 20ms 帧 + RMS 能量阈值做端点检测，统计：
  - onset_latency_ms : 真实起点 -> 判定起点（越小越好，决定"说话就打断"的灵敏度）
  - endpoint_latency_ms: 真实终点 -> 判定终点（受 hangover 尾静音窗口支配）
输出 bench/results/vad_bench.json

注意：这里测的是"算法判定延迟"（不含麦克风采集缓冲）。生产建议换 Silero VAD
（torch/onnx，质量更好），但端点延迟量级由 hangover 决定，与实现无关。
"""
import json
import math
import os
import struct
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "results")
AUD = os.path.join(HERE, "audio")

FRAME_MS = 20
HANGOVERS_MS = [300, 500, 700, 1000]


def make_wav(path, lead_sil=0.6, tail_sil=0.6, speech="mid_20_0.aiff"):
    """静音 + 预生成 TTS 语音 + 静音 拼成 16k mono wav。"""
    src = os.path.join(AUD, speech)
    raw = os.path.join(AUD, "_speech16k.raw")
    os.system("ffmpeg -y -v error -i '%s' -ar 16000 -ac 1 -f s16le '%s'" % (src, raw))
    pcm = open(raw, "rb").read()
    # 先去掉 TTS 文件自带的首尾静音，否则"真实首尾"无从定义
    spf = int(16000 * FRAME_MS / 1000)
    nb = spf * 2
    n = len(pcm) // nb
    rms = []
    for i in range(n):
        b = pcm[i * nb:(i + 1) * nb]
        s16 = struct.unpack("<%dh" % spf, b)
        rms.append(math.sqrt(sum(x * x for x in s16) / spf))
    nz = sorted(rms)[max(1, len(rms) // 10)]
    thr0 = max(nz * 3.0, sorted(rms)[-1] * 0.04, 150.0)
    first = next(i for i, v in enumerate(rms) if v > thr0)
    last = max(i for i, v in enumerate(rms) if v > thr0)
    pcm = pcm[first * nb:(last + 1) * nb]
    zeros = b"\x00\x00" * int(16000 * lead_sil)
    zeros2 = b"\x00\x00" * int(16000 * tail_sil)
    data = zeros + pcm + zeros2
    w = wave.open(path, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(data)
    w.close()
    return lead_sil, lead_sil + len(pcm) / 2.0 / 16000.0, len(data) / 2.0 / 16000.0


def frames(path):
    w = wave.open(path, "rb")
    spf = int(16000 * FRAME_MS / 1000)
    out = []
    while True:
        b = w.readframes(spf)
        if len(b) < spf * 2:
            break
        s = struct.unpack("<%dh" % spf, b)
        rms = math.sqrt(sum(x * x for x in s) / spf)
        out.append(rms)
    w.close()
    return out


def calibrate(rms):
    """用前 0.3s 静音估底噪，阈值 = max(底噪*3, 静音段最大值*2, 120)。"""
    noise = sorted(rms[:15])[len(rms[:15]) // 2]
    return max(noise * 3.0, 120.0)


def detect(rms, thr, hangover_frames):
    start = next((i for i, v in enumerate(rms) if v > thr), None)
    if start is None:
        return None, None
    end = start
    quiet = 0
    for i in range(start, len(rms)):
        if rms[i] > thr:
            quiet = 0
            end = i
        else:
            quiet += 1
            if quiet >= hangover_frames:
                break
    return start, end


def main():
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(AUD, "vad_input.wav")
    t_lead, t_speech_end, dur = make_wav(path)
    rms = frames(path)
    thr = calibrate(rms)
    rows = []
    for h in HANGOVERS_MS:
        t0 = time.perf_counter()
        s, e = detect(rms, thr, int(h / FRAME_MS))
        cpu_ms = (time.perf_counter() - t0) * 1000.0
        onset = (s * FRAME_MS) - t_lead * 1000.0 if s is not None else None
        endpoint = (e * FRAME_MS) - t_speech_end * 1000.0 if e is not None else None
        rows.append({
            "hangover_ms": h,
            "onset_latency_ms": round(onset, 1) if onset is not None else None,
            "endpoint_latency_ms": round(endpoint, 1) if endpoint is not None else None,
            "detect_cpu_ms": round(cpu_ms, 2),
            "frames": len(rms),
            "audio_s": round(dur, 2),
            "realtime_factor": round(cpu_ms / (dur * 1000.0), 6),
        })
    res = {
        "env": {"frame_ms": FRAME_MS, "sample_rate": 16000, "threshold_rms": round(thr, 1),
                "note": "纯 stdlib RMS VAD；生产用 Silero VAD，端点延迟由 hangover 决定"},
        "rows": rows,
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    with open(os.path.join(OUT, "vad_bench.json"), "w") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
