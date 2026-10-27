#!/usr/bin/env python3
"""ASR 基准：本机 whisper 各后端/参数在中文样音上的耗时与字错率（CER）。

用法：
  asr-venv/bin/python run_bench.py --runs 2
  asr-venv/bin/python run_bench.py --samples samples_noisy/snr10 --tag snr10
  asr-venv/bin/python run_bench.py --configs base_cpu_tuned,turbo_cpu_tuned
只用本地已有模型（~/.cache/whisper）：tiny.pt / base.pt / large-v3-turbo.pt，不联网。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import statistics
import time
import wave

import numpy as np
import whisper

HERE = pathlib.Path(__file__).resolve().parent
PROMPT = "以下是简体中文普通话，助手叫鲸灵。"
PUNCT = re.compile(r"[\s，。？、！…—,.?!:;\"'“”‘’（）()【】\[\]~·]")

# 每个配置 = 一个后端 + 一套解码参数。没写的参数用下面 DEFAULTS 里的线上值。
CONFIGS = {
    # 线上现状：turbo + 默认温度回退阶梯（0.0→1.0），噪声大时会整段反复重解码
    "turbo_cpu_current": dict(model="large-v3-turbo", device="cpu", without_timestamps=False),
    # 关温度回退 + 不出时间戳
    "turbo_cpu_tuned": dict(model="large-v3-turbo", device="cpu", without_timestamps=True, temperature=0.0),
    # 对照：只关时间戳，保留温度回退
    "turbo_cpu_no_ts_only": dict(model="large-v3-turbo", device="cpu", without_timestamps=True),
    # 备用后端：base 快一个数量级，看噪声下准确率掉多少
    "base_cpu_tuned": dict(model="base", device="cpu", without_timestamps=True, temperature=0.0),
    "base_cpu_current": dict(model="base", device="cpu", without_timestamps=False),
}
DEFAULTS = dict(language="zh", fp16=False, beam_size=1,
                condition_on_previous_text=False, initial_prompt=PROMPT)


def norm(text: str) -> str:
    return PUNCT.sub("", text or "")


def cer(ref: str, hyp: str) -> float:
    """字错率 = 编辑距离 / 参考字数。"""
    r, h = norm(ref), norm(hyp)
    if not r:
        return 0.0
    prev = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        cur = [i]
        for j, hc in enumerate(h, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc)))
        prev = cur
    return prev[-1] / len(r)


def load_audio(path: pathlib.Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2), path
        pcm = wav.readframes(wav.getnframes())
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--out", default=str(HERE / "result.json"))
    ap.add_argument("--samples", default=str(HERE / "samples"))
    ap.add_argument("--configs", default=",".join(CONFIGS))
    ap.add_argument("--tag", default="")
    args = ap.parse_args()

    sample_dir = pathlib.Path(args.samples)
    refs = json.loads((sample_dir / "refs.json").read_text(encoding="utf-8"))
    files = sorted(p for p in sample_dir.glob("*.wav") if p.name in refs)
    audios = {f.name: load_audio(f) for f in files}
    names = [n for n in args.configs.split(",") if n]

    rows, raw = [], []
    for name in names:
        spec = dict(CONFIGS[name])
        model_name = spec.pop("model")
        device = spec.pop("device")
        t0 = time.monotonic()
        try:
            model = whisper.load_model(model_name, device=device)
        except Exception as error:  # 后端不可用就跳过，别拖垮整轮
            print(f"[skip] {name}: {type(error).__name__}: {error}", flush=True)
            raw.append({"config": name, "error": f"{type(error).__name__}: {error}"})
            continue
        load_ms = int((time.monotonic() - t0) * 1000)
        kwargs = {**DEFAULTS, **spec}
        warm0 = time.monotonic()
        try:
            model.transcribe(np.zeros(16000, dtype=np.float32), **kwargs)
        except Exception as error:
            print(f"[skip] {name} warmup: {type(error).__name__}: {error}", flush=True)
            raw.append({"config": name, "error": f"warmup {type(error).__name__}: {error}"})
            continue
        warm_ms = int((time.monotonic() - warm0) * 1000)
        print(f"== {name}: load {load_ms}ms warmup {warm_ms}ms", flush=True)

        for fname in sorted(audios):
            audio = audios[fname]
            times, texts = [], []
            for _ in range(args.runs):
                t0 = time.monotonic()
                out = model.transcribe(audio, **kwargs)
                times.append((time.monotonic() - t0) * 1000)
                texts.append((out.get("text") or "").strip())
            ms = int(statistics.median(times))
            row = {"config": name, "file": fname, "audio_s": round(len(audio) / 16000, 2),
                   "ms": ms, "rtf": round(ms / 1000 / max(0.01, len(audio) / 16000), 2),
                   "cer": round(cer(refs[fname], texts[-1]), 3), "text": texts[-1]}
            rows.append(row)
            print(f"  {fname:26s} {row['audio_s']:5.2f}s -> {ms:5d}ms cer={row['cer']:.2f} {row['text']}", flush=True)
        del model

    summary = []
    for name in names:
        rs = [r for r in rows if r["config"] == name]
        if not rs:
            continue
        short = [r["ms"] for r in rs if r["audio_s"] <= 2.0]
        mid = [r["ms"] for r in rs if r["audio_s"] > 2.0]
        summary.append({"config": name,
                        "ms_short": int(statistics.median(short)) if short else None,
                        "ms_mid": int(statistics.median(mid)) if mid else None,
                        "ms_all": int(statistics.median([r["ms"] for r in rs])),
                        "cer": round(statistics.mean([r["cer"] for r in rs]), 3)})
    print("\n== SUMMARY")
    for s in summary:
        print(s)
    out_path = pathlib.Path(args.out)
    if args.tag:
        out_path = out_path.with_name(f"{out_path.stem}_{args.tag}{out_path.suffix}")
    out_path.write_text(json.dumps({"samples": len(audios), "runs": args.runs,
                                    "summary": summary, "rows": rows, "raw": raw},
                                   ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"写入 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
