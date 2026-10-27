#!/usr/bin/env bash
# TTS 首字节基准（一条命令重跑）
#
#   ./scripts/tts-bench.sh                 # 宿主路由：?stream=1 与整句各 N 次，量首字节
#   ./scripts/tts-bench.sh --n 5 --mode both
#   ./scripts/tts-bench.sh --mode direct   # 跳过宿主，直接量 stream.py 子进程（拆固定开销）
#
# 只量「首字节」和「整句」：首字节 = 手机能开始播的时间，整句 = 掐头去尾模式能返回的时间。
# 文本每次不同（带序号），否则宿主缓存（x-tts-cache: hit）会返回 0ms，量不到合成耗时。
set -euo pipefail

PY=${PY:-/Users/apple/.dsh/pet-voice/tts-venv/bin/python}
HOST_URL=${HOST_URL:-http://127.0.0.1:50802/pet-voice/api/tts}
TOKEN_FILE=${TOKEN_FILE:-$HOME/.dsh/pet-voice/token}
OUT=${OUT:-/tmp/tts-bench-$(date +%H%M%S).json}

[[ -x $PY ]] || { echo "找不到 python：$PY（先跑 plugins/dsh-pet-voice/tts/setup.sh）" >&2; exit 2; }

TMPPY=$(mktemp /tmp/tts-bench.XXXXXX)
trap 'rm -f "$TMPPY"' EXIT
cat > "$TMPPY" <<'PY'
import argparse, http.client, json, os, statistics, subprocess, sys, time, urllib.parse
from pathlib import Path

HOST_URL = os.environ.get("HOST_URL", "http://127.0.0.1:50802/pet-voice/api/tts")
TOKEN_FILE = os.environ.get("TOKEN_FILE", os.path.expanduser("~/.dsh/pet-voice/token"))
TTS_PY = os.environ.get("PY", os.path.expanduser("~/.dsh/pet-voice/tts-venv/bin/python"))
STREAM_PY = "/Users/apple/Desktop/work/Pet/plugins/dsh-pet-voice/tts/stream.py"
VOICE = "zh-CN-XiaoyiNeural"
SENTENCES = [
    "这句是为了量首字节写的。",
    "先把延迟降下来再谈体验。",
    "现在测的是合成开始出音的时间。",
    "换一句没被缓存过的普通话。",
    "再补一句看波动有多大。",
    "第六句同样不带缓存。",
]

def pct(vals, q):
    s = sorted(vals); k = max(0, min(len(s) - 1, int(round((len(s) - 1) * q)))); return s[k]

def stats(rows, key, label):
    v = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
    if not v:
        return {}
    return {"case": label, "n": len(v), "min": min(v), "median": round(statistics.median(v)),
            "p95": pct(v, 0.95), "max": max(v)}

def host_once(text, stream):
    u = urllib.parse.urlparse(HOST_URL)
    tok = Path(TOKEN_FILE).read_text().strip()
    q = urllib.parse.urlencode({"text": text, "stream": "1" if stream else "0", "voice": VOICE})
    c = http.client.HTTPConnection(u.hostname, u.port, timeout=120)
    t0 = time.perf_counter()
    c.request("GET", (u.path or "/") + "?" + q,
              headers={"Authorization": "Bearer " + tok, "x-pet-device-id": "5a6679d55e99"})
    r = c.getresponse()
    first = None; n = 0
    while True:
        b = r.read(4096)
        if not b:
            break
        if first is None:
            first = time.perf_counter() - t0
        n += len(b)
    total = time.perf_counter() - t0
    cache = r.getheader("x-tts-cache") or "miss"
    c.close()
    return {"first_ms": None if first is None else round(first * 1000), "total_ms": round(total * 1000),
            "bytes": n, "http": r.status, "cache": cache, "text": text}

def direct_once(text):
    env = dict(os.environ, PET_TTS_RAW="1")
    t0 = time.perf_counter()
    p = subprocess.Popen([TTS_PY, STREAM_PY, VOICE, text, "+0%", "+0Hz"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    first = None; n = 0
    while True:
        b = p.stdout.read(2048)
        if not b:
            break
        if first is None:
            first = time.perf_counter() - t0
        n += len(b)
    err = p.stderr.read().decode("utf-8", "replace").strip().splitlines()
    p.wait()
    vendor = None
    for line in err:
        if "vendor_first_chunk_ms=" in line:
            try:
                vendor = int(line.split("vendor_first_chunk_ms=")[1].split()[0])
            except Exception:
                pass
    return {"first_ms": None if first is None else round(first * 1000),
            "total_ms": round((time.perf_counter() - t0) * 1000), "bytes": n,
            "vendor_first_chunk_ms": vendor, "text": text}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="host", choices=["host", "direct", "both"])
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    result = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "loadavg": [round(x, 2) for x in os.getloadavg()]}
    rows = []

    if a.mode in ("host", "both"):
        for stream in (True, False):
            for i in range(a.n):
                text = SENTENCES[i % len(SENTENCES)] + f"第{i+1}遍。"
                r = host_once(text, stream)
                r["case"] = "stream=1" if stream else "整句"
                rows.append(r)
                print(f"  host {r['case']} first={r['first_ms']}ms total={r['total_ms']}ms "
                      f"bytes={r['bytes']} http={r['http']} cache={r['cache']}", flush=True)
                time.sleep(1.0)   # 宿主/微软都有节流，别自己把自己打成 429

    if a.mode in ("direct", "both"):
        for i in range(a.n):
            text = SENTENCES[i % len(SENTENCES)] + f"直连第{i+1}遍。"
            r = direct_once(text)
            r["case"] = "direct(run stream.py)"
            rows.append(r)
            print(f"  direct first={r['first_ms']}ms total={r['total_ms']}ms "
                  f"vendor={r['vendor_first_chunk_ms']}ms bytes={r['bytes']}", flush=True)

    result["rows"] = rows
    result["stats"] = [stats([r for r in rows if r["case"] == c], "first_ms", c)
                       for c in dict.fromkeys(r["case"] for r in rows)]
    result["stats"] += [stats([r for r in rows if r["case"] == c], "total_ms", c + " (整句)")
                        for c in dict.fromkeys(r["case"] for r in rows)]
    Path(a.out).write_text(json.dumps(result, ensure_ascii=False, indent=1))
    for s in result["stats"]:
        print(f"  {s['case']}: median={s['median']}ms p95={s['p95']} max={s['max']} min={s['min']} n={s['n']}")
    print(f"\nJSON: {a.out}")

main()
PY

exec "$PY" "$TMPPY" --out "$OUT" "$@"
