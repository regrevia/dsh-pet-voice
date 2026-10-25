#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LLM 网关首 token 延迟实测（仅测试用，token 只从 ~/.dsh 内存读取，绝不打印/落盘）

用法: python3 bench/llm_bench.py [--n 5]
输出: bench/results/llm_bench.json
"""
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

BASE = "http://192.168.11.18:30055"
DEFAULT_MODEL = "anthropic/DeepSeek-V4.1-Flash"
MODELS = ["anthropic/DeepSeek-V4.1-Flash", "openai/gpt-5.6-luna"]
CRED = os.path.expanduser("~/.dsh/.credentials.yaml")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")

PROMPTS = [
    ("short", "用一句话回答：语音管线的首字延迟主要花在哪一段？"),
    ("long", "请用 120 字左右介绍实时语音交互里 barge-in（打断）的作用和处理要点。"),
]


def read_token():
    """只取 refs.COMPANY_LLM_TOKEN；不打印、不回显、不写文件。"""
    with open(CRED) as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            k, _, v = s.partition(":")
            if k.strip() == "COMPANY_LLM_TOKEN":
                return v.strip().strip("'\"")
    raise SystemExit("token not found in credentials")


def stream_once(token, prompt, model=None, max_tokens=200):
    """返回 (ttfb_ms, total_ms, n_chunks, chars, model)。"""
    body = {
        "model": model or DEFAULT_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "max_tokens": 512,
        "temperature": 0.3,
    }
    req = urllib.request.Request(
        BASE + "/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )
    t0 = time.perf_counter()
    ttfb = None       # 首个 content delta（真正能送去 TTS 的文本）
    ttfb_any = None   # 首个任意 delta（含 reasoning_content，CoT 模型常见）
    chunks = 0
    chars = 0
    used_model = None
    with urllib.request.urlopen(req, timeout=60) as r:
        for raw in r:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                obj = json.loads(payload)
            except json.JSONDecodeError:
                continue
            used_model = obj.get("model", used_model)
            delta = (obj.get("choices") or [{}])[0].get("delta") or {}
            piece = delta.get("content") or ""
            if ttfb_any is None and (piece or delta.get("reasoning_content")):
                ttfb_any = (time.perf_counter() - t0) * 1000.0
            if piece:
                if ttfb is None:
                    ttfb = (time.perf_counter() - t0) * 1000.0
                chunks += 1
                chars += len(piece)
    total = (time.perf_counter() - t0) * 1000.0
    return ttfb, ttfb_any, total, chunks, chars, used_model


def main():
    n = 5
    if "--n" in sys.argv:
        n = int(sys.argv[sys.argv.index("--n") + 1])
    token = read_token()
    os.makedirs(OUT, exist_ok=True)
    rows = []
    for model_id in MODELS:
        for name, prompt in PROMPTS:
            ttfb, ttfb_any, tot, ch, chars, model = [], [], [], [], [], None
            for _ in range(n):
                try:
                    a, a2, b, c, d, m = stream_once(token, prompt, model=model_id)
                except urllib.error.HTTPError as e:
                    print("HTTPError", e.code, e.read()[:200], file=sys.stderr)
                    break
                except Exception as e:
                    print("ERR", type(e).__name__, str(e)[:120], file=sys.stderr)
                    continue
                if a is not None:
                    ttfb.append(a)
                if a2 is not None:
                    ttfb_any.append(a2)
                tot.append(b); ch.append(c); chars.append(d)
                model = m or model
            if tot:
                rows.append({
                    "case": name, "model": model or model_id, "n": len(tot),
                    "ttfb_content_ms": _st(ttfb) if ttfb else None,
                    "ttfb_any_ms": _st(ttfb_any) if ttfb_any else None,
                    "total_ms": _st(tot), "chunks": _st(ch), "chars": _st(chars),
                })
    res = {"endpoint": BASE + "/v1/chat/completions", "token_read_from": "~/.dsh (not printed)",
           "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "rows": rows}
    with open(os.path.join(OUT, "llm_bench.json"), "w") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    print(json.dumps(res, ensure_ascii=False, indent=2))


def _st(xs):
    xs = sorted(xs)
    return {"min": round(xs[0], 1), "median": round(statistics.median(xs), 1), "max": round(xs[-1], 1)}


if __name__ == "__main__":
    main()
