#!/usr/bin/env bash
# TTS 首字节基准（一条命令重跑）
#
#   ./scripts/tts-bench.sh                    # 宿主路由：?stream=1 与整句各 N 次，量首字节
#   ./scripts/tts-bench.sh --n 8 --mode all   # host + 常驻连接 + 改前直连，三档对比
#   ./scripts/tts-bench.sh --mode daemon      # 常驻 WS（stream.py 自动拉起守护进程）
#   ./scripts/tts-bench.sh --mode legacy      # 改前行为：每次都现建连接（PET_TTS_NO_DAEMON=1）
#   ./scripts/tts-bench.sh --mode concurrency # 同时请求 A/B，ASR 回读验证不串音
#
# 三个数分开记，别混：
#   建连 conn_ms      —— 这一次花在 WebSocket 握手上的时间（常驻连接里应为 0）
#   合成 vendor       —— 文本帧发出去到厂商第一个音频包（真·合成首帧）
#   首字节 first_ms   —— 调用方拿到第一个音频字节，含子进程启动
set -euo pipefail

PY=${PY:-/Users/apple/.dsh/pet-voice/tts-venv/bin/python}
# 宿主端口每次启动都可能变：优先 $HOST_URL，否则用 pv_base 现探（别写死 50802）。
. "$(dirname "$0")/lib/pv-base.sh"
if [ -z "${HOST_URL:-}" ]; then
  base=$(pv_base) || { echo "找不到在跑的宿主 /pet-voice（先确认 DSH 开着、插件已启用）" >&2; exit 2; }
  HOST_URL="$base/api/tts"
fi
export HOST_URL
TOKEN_FILE=${TOKEN_FILE:-$HOME/.dsh/pet-voice/token}
ASR_URL=${ASR_URL:-http://127.0.0.1:52399}
OUT=${OUT:-/tmp/tts-bench-$(date +%H%M%S).json}

[[ -x $PY ]] || { echo "找不到 python：$PY（先跑 plugins/dsh-pet-voice/tts/setup.sh）" >&2; exit 2; }

TMPPY=$(mktemp /tmp/tts-bench.XXXXXX)
trap 'rm -f "$TMPPY"' EXIT
cat > "$TMPPY" <<'PY'
import argparse, http.client, json, os, statistics, subprocess, sys, threading, time, urllib.parse, urllib.request
from pathlib import Path

HOST_URL = os.environ["HOST_URL"]  # 外层 pv_base 现探后导出，这里不再写死端口
TOKEN_FILE = os.environ.get("TOKEN_FILE", os.path.expanduser("~/.dsh/pet-voice/token"))
ASR_URL = os.environ.get("ASR_URL", "http://127.0.0.1:52399")
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
    return {"case": label, "key": key, "n": len(v), "min": min(v),
            "median": round(statistics.median(v)), "p95": pct(v, 0.95), "max": max(v)}

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

def _parse_err(err):
    out = {}
    for line in err:
        if not line.startswith("[tts]"):
            continue
        for token in line.split():
            for key in ("path", "conn_ms", "vendor_first_ms", "stdout_first_ms", "total_ms"):
                if token.startswith(key + "="):
                    val = token.split("=", 1)[1]
                    out[key] = val if key == "path" else int(val) if val.lstrip("-").isdigit() else val
    return out

def stream_once(text, legacy=False):
    env = dict(os.environ, PET_TTS_RAW="1")
    if legacy:
        env["PET_TTS_NO_DAEMON"] = "1"
    t0 = time.perf_counter()
    p = subprocess.Popen([TTS_PY, STREAM_PY, VOICE, text, "+0%", "+0Hz"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    first = None; n = 0; audio = []
    while True:
        b = p.stdout.read(2048)
        if not b:
            break
        if first is None:
            first = time.perf_counter() - t0
        n += len(b); audio.append(b)
    err = p.stderr.read().decode("utf-8", "replace").strip().splitlines()
    p.wait()
    fields = _parse_err(err)
    return {"first_ms": None if first is None else round(first * 1000),
            "total_ms": round((time.perf_counter() - t0) * 1000), "bytes": n,
            "vendor_first_chunk_ms": fields.get("vendor_first_ms"),
            "conn_ms": fields.get("conn_ms", 0), "path": fields.get("path", "?"),
            "text": text, "audio": b"".join(audio),
            "stderr_tail": " | ".join(err[-2:]) if err else "", "exit": p.returncode}

def _asr(wav):
    req = urllib.request.Request(ASR_URL.rstrip("/") + "/asr", data=wav,
                                 headers={"Content-Type": "audio/wav"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode())
    return body.get("text") or ("<err:%s>" % body.get("error"))

def _to_wav(mp3):
    done = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                           "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"],
                          input=mp3, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    return done.stdout or b""

def concurrency_check():
    a_text = "请把窗户关一下，外面在下雨。"
    b_text = "明天早上七点叫我起床，谢谢。"
    out = {}

    def run(tag, text):
        t0 = time.perf_counter()
        out[tag] = stream_once(text)
        out[tag]["wall_ms"] = round((time.perf_counter() - t0) * 1000)

    th_a = threading.Thread(target=run, args=("A", a_text))
    th_b = threading.Thread(target=run, args=("B", b_text))
    th_a.start(); th_b.start()
    th_a.join(); th_b.join()

    verdict = {}
    for tag, text, own, other in (("A", a_text, ("窗户", "下雨"), ("七点", "起床")),
                                  ("B", b_text, ("七点", "起床"), ("窗户", "下雨"))):
        wav = _to_wav(out[tag]["audio"])
        try:
            text_back = _asr(wav) if wav else "<无音频>"
        except Exception as error:  # noqa: BLE001 - ASR 没起就不判内容
            text_back = "<ASR 不可用：%s>" % type(error).__name__
        verdict[tag] = {"expect": text, "asr": text_back,
                        "own_hits": sum(1 for k in own if k in text_back),
                        "other_hits": sum(1 for k in other if k in text_back),
                        "bytes": out[tag]["bytes"], "first_ms": out[tag]["first_ms"],
                        "path": out[tag]["path"]}
    verdict["same_bytes"] = out["A"]["bytes"] == out["B"]["bytes"]
    verdict["start_skew_ms"] = abs(out["A"]["total_ms"] - out["B"]["total_ms"])
    verdict["ok"] = all(verdict[t].get("own_hits", 0) >= 1 and verdict[t].get("other_hits", 0) == 0
                        for t in ("A", "B"))
    return verdict

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="host",
                    choices=["host", "daemon", "legacy", "direct", "both", "all", "concurrency"])
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    result = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "loadavg": [round(x, 2) for x in os.getloadavg()]}
    rows = []

    if a.mode in ("host", "both", "all"):
        for stream in (True, False):
            for i in range(a.n):
                text = SENTENCES[i % len(SENTENCES)] + f"第{i+1}遍。"
                r = host_once(text, stream)
                r["case"] = "host stream=1" if stream else "host 整句"
                rows.append(r)
                print(f"  host {r['case']} first={r['first_ms']}ms total={r['total_ms']}ms "
                      f"bytes={r['bytes']} http={r['http']} cache={r['cache']}", flush=True)
                time.sleep(1.0)   # 宿主/微软都有节流，别自己把自己打成 429

    if a.mode in ("daemon", "direct", "both", "all"):
        warm = stream_once("预热一句，不计入统计。")
        result["warmup"] = {k: v for k, v in warm.items() if k != "audio"}
        print(f"  预热 path={warm['path']} 建连={warm['conn_ms']}ms vendor={warm['vendor_first_chunk_ms']}ms", flush=True)
        for i in range(a.n):
            text = SENTENCES[i % len(SENTENCES)] + f"常驻第{i+1}遍。"
            r = stream_once(text)
            r["case"] = "stream.py 常驻WS" if a.mode != "direct" else "stream.py 直连"
            rows.append(r)
            print(f"  daemon first={r['first_ms']}ms 建连={r['conn_ms']}ms vendor={r['vendor_first_chunk_ms']}ms "
                  f"total={r['total_ms']}ms bytes={r['bytes']} path={r['path']}", flush=True)
            if not r["bytes"]:
                print(f"    !! 没有音频：{r.get('stderr_tail', '')}", flush=True)

    if a.mode in ("legacy", "all"):
        for i in range(a.n):
            text = SENTENCES[i % len(SENTENCES)] + f"改前第{i+1}遍。"
            r = stream_once(text, legacy=True)
            r["case"] = "stream.py 每次建连(改前)"
            rows.append(r)
            print(f"  legacy first={r['first_ms']}ms 建连={r['conn_ms']}ms vendor={r['vendor_first_chunk_ms']}ms "
                  f"total={r['total_ms']}ms bytes={r['bytes']} path={r['path']}", flush=True)

    result["rows"] = [{k: v for k, v in r.items() if k != "audio"} for r in rows]
    allstats = []
    for key, suffix in (("first_ms", ""), ("vendor_first_chunk_ms", " (vendor首帧)"),
                        ("conn_ms", " (建连)"), ("total_ms", " (整句)")):
        allstats += [stats([r for r in rows if r["case"] == c], key, c + suffix)
                     for c in dict.fromkeys(r["case"] for r in rows)]
    result["stats"] = allstats
    for s in allstats:
        if s:
            print(f"  {s['case']}: median={s['median']}ms p95={s['p95']} max={s['max']} min={s['min']} n={s['n']}")

    if a.mode in ("concurrency", "daemon", "all"):
        cf = concurrency_check()
        result["concurrency"] = cf
        for tag in ("A", "B"):
            r = cf[tag]
            print(f"  并发{tag} first={r['first_ms']}ms bytes={r['bytes']} asr={r['asr']!r} "
                  f"own={r['own_hits']} other={r['other_hits']}", flush=True)
        print(f"  同刻并发：字节数相同={cf['same_bytes']} 偏差={cf['start_skew_ms']}ms 不串音={cf['ok']}")

    Path(a.out).write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print(f"\nJSON: {a.out}")

main()
PY

exec "$PY" "$TMPPY" --out "$OUT" "$@"
