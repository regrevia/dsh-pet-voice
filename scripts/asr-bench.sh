#!/usr/bin/env bash
# ASR 延迟基准（wav 直喂，一条命令重跑）
#
#   ./scripts/asr-bench.sh --mode warm            # 热态：3 条样本 × 10 次，直连 worker
#   ./scripts/asr-bench.sh --mode host            # 走宿主路由 /pet-voice/api/asr（含插件开销）
#   ./scripts/asr-bench.sh --mode cold            # 冷启动：先杀 worker，量「拉起→首个结果」
#   ./scripts/asr-bench.sh --mode stability --n 30  # 连打 30 次，采样 RSS
#   ./scripts/asr-bench.sh --mode all             # warm + host + cold
#
# 样本默认 /tmp/pvtest/a{1,2,3}.mp3（lead 给的现成 3 条），自动转 16k 单声道 wav。
# 也可以 --wav /path/a.wav[,/path/b.wav] 直接喂自己的 wav。
#
# 约束：macOS 上 whisper large-v3-turbo 常驻约 4.3 GB，**全局只允许一个 worker**
#       （见 docs/pet-bench.md 的 ASR 节；并载三个会触发 jetsam）。本脚本杀 worker
#       前会断言「没有别的 worker 在跑」，绝不并发起两个。
set -euo pipefail

PY=${PY:-/Users/apple/.dsh/pet-voice/asr-venv/bin/python}   # 兼容旧用法：默认既是测量解释器也是 worker 解释器
ASR_PY=${ASR_PY:-$PY}       # cold 模式拉起 worker 用的解释器（换 mlx 就指到装了 mlx 的 venv）
BENCH_PY=${BENCH_PY:-$PY}   # 跑本基准自身的解释器（要 psutil；缺了杀不掉 worker、量不到 RSS）
WORKER_URL=${WORKER_URL:-http://127.0.0.1:52399}
# 宿主端口每次启动都可能变：优先 $HOST_URL，否则用 pv_base 现探（别写死 50802）。
. "$(dirname "$0")/lib/pv-base.sh"
if [ -z "${HOST_URL:-}" ]; then
  base=$(pv_base) || { echo "找不到在跑的宿主 /pet-voice（先确认 DSH 开着、插件已启用）" >&2; exit 2; }
  HOST_URL="$base/api/asr"
fi
export HOST_URL
TOKEN_FILE=${TOKEN_FILE:-$HOME/.dsh/pet-voice/token}
OUT=${OUT:-/tmp/asr-bench-$(date +%H%M%S).json}

[[ -x $ASR_PY ]] || { echo "找不到 worker python：$ASR_PY（先跑 plugins/dsh-pet-voice/asr/setup.sh）" >&2; exit 2; }
[[ -x $BENCH_PY ]] || { echo "找不到测量 python：$BENCH_PY" >&2; exit 2; }

TMPPY=$(mktemp /tmp/asr-bench.XXXXXX)
trap 'rm -f "$TMPPY"' EXIT
cat > "$TMPPY" <<'PY'
import argparse, json, os, statistics, subprocess, sys, time, http.client, urllib.parse, urllib.request
from pathlib import Path

VENV_PY = os.environ.get("ASR_PY") or os.environ.get(
    "PY", "/Users/apple/.dsh/pet-voice/asr-venv/bin/python")
WORKER_URL = os.environ.get("WORKER_URL", "http://127.0.0.1:52399")
HOST_URL = os.environ["HOST_URL"]  # 外层 pv_base 现探后导出，这里不再写死端口
TOKEN_FILE = os.environ.get("TOKEN_FILE", os.path.expanduser("~/.dsh/pet-voice/token"))
INSTALLED = os.path.expanduser("~/.dsh/plugins/dsh-pet-voice/asr/asr-worker.py")
# cold 模式默认起「装好的那份」；换后端/换解释器只影响这一次测量。
BACKEND = os.environ.get("ASR_BACKEND", "").strip()   # "" = worker 自己的默认（auto）
WORKER_SRC = os.path.expanduser(os.environ.get("ASR_WORKER_SRC", INSTALLED))
WAV_DIR = Path("/tmp/pvwav")
SRC = {"a1": "/tmp/pvtest/a1.mp3", "a2": "/tmp/pvtest/a2.mp3", "a3": "/tmp/pvtest/a3.mp3"}

try:
    import psutil
except ImportError:
    psutil = None


def wavs(want):
    if want:
        return [Path(p) for p in want.split(",") if p]
    WAV_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for name, src in SRC.items():
        dst = WAV_DIR / f"{name}.wav"
        if not dst.exists() and os.path.exists(src):
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ac", "1",
                            "-ar", "16000", "-c:a", "pcm_s16le", str(dst)], check=True)
        if dst.exists():
            out.append(dst)
    if not out:
        sys.exit("没有可用样本：/tmp/pvtest/a{1,2,3}.mp3 不存在，且没给 --wav")
    return out


def worker_procs():
    if not psutil:
        # 没有 psutil 也能杀：走 pgrep（macOS 自带）。RSS 仍然量不到。
        try:
            out = subprocess.run(["pgrep", "-f", "asr-worker.py"], capture_output=True, text=True, timeout=5)
            skip = {os.getpid(), os.getppid()}
            return sorted({int(x) for x in out.stdout.split() if x.isdigit()} - skip)
        except Exception:
            return []
    me = set()
    skip = {os.getpid(), os.getppid()}
    # 自己的命令行里也可能出现 "asr-worker"（比如 env 里指了 worker 路径），别把自己杀了
    for p in psutil.process_iter(["pid", "cmdline"]):
        try:
            if p.info["pid"] in skip:
                continue
            cmd = " ".join(p.info["cmdline"] or [])
            if "asr-worker.py" in cmd and "-c" not in cmd:
                me.add(p.info["pid"])
        except Exception:
            pass
    return sorted(me)


def rss_mb(pids):
    if not psutil:
        return None
    tot = 0
    for pid in pids:
        try:
            tot += psutil.Process(pid).memory_info().rss
        except Exception:
            pass
    return round(tot / 2**20)


def wait_health(timeout=300.0):
    """轮询 /health 直到 200（worker 先加载模型再 bind，所以 200 即可用）。"""
    t0 = time.perf_counter()
    deadline = t0 + timeout
    while time.perf_counter() < deadline:
        try:
            c = http.client.HTTPConnection("127.0.0.1", 52399, timeout=2)
            c.request("GET", "/health")
            r = c.getresponse()
            body = r.read()
            c.close()
            if r.status == 200:
                try:
                    info = json.loads(body.decode("utf-8"))
                except Exception:
                    info = {}
                return time.perf_counter() - t0, info
        except Exception:
            time.sleep(0.1)
    return None, {}


def post(url, data, token=None, timeout=300):
    u = urllib.parse.urlparse(url)
    # 固定设备 id：宿主按 x-pet-device-id 记设备，UA/端口一变就算新设备，打满上限直接回 429
    # device-limit（本脚本早期就吃过这个亏）。
    h = {"Content-Type": "audio/wav", "x-pet-device-id": os.environ.get("BENCH_DEVICE_ID", "5a6679d55e99")}
    if token:
        h["Authorization"] = "Bearer " + token
    c = http.client.HTTPConnection(u.hostname, u.port, timeout=timeout)
    t0 = time.perf_counter()
    c.request("POST", u.path or "/", body=data, headers=h)
    r = c.getresponse()
    ttfb = time.perf_counter() - t0          # 首个响应字节（headers 到达）
    body = r.read()
    total = time.perf_counter() - t0
    c.close()
    try:
        j = json.loads(body.decode("utf-8"))
    except Exception:
        j = {"ok": False, "error": body[:120].decode("utf-8", "replace")}
    return {"http": r.status, "ttfb_ms": round(ttfb * 1000), "total_ms": round(total * 1000),
            "worker_ms": j.get("ms"), "ok": bool(j.get("ok")), "text": (j.get("text") or ""),
            "textLen": len((j.get("text") or "").strip()), "error": j.get("error")}


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    k = max(0, min(len(s) - 1, int(round((len(s) - 1) * q))))
    return s[k]


def summary(rows, key):
    vals = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
    if not vals:
        return {}
    return {"n": len(vals), "min": min(vals), "median": round(statistics.median(vals)),
            "p95": pct(vals, 0.95), "max": max(vals), "mean": round(statistics.mean(vals))}


def kill_workers():
    killed = []
    for pid in worker_procs():
        try:
            p = psutil.Process(pid)
            p.terminate()
            p.wait(timeout=10)
            killed.append(pid)
        except Exception:
            try:
                psutil.Process(pid).kill()
                killed.append(pid)
            except Exception:
                pass
    for _ in range(50):
        if not worker_procs():
            break
        time.sleep(0.1)
    return killed


def token():
    try:
        return Path(TOKEN_FILE).read_text().strip()
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="warm", choices=["warm", "host", "cold", "stability", "all"])
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--wav", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--strict", action="store_true", help="后端不是 mlx-whisper 就直接失败（别把 CPU 回退的 1.2s 当中位）")
    a = ap.parse_args()
    # worker 会静默退回 CPU whisper：跑之前先认一次后端，串到结果里也写进输出。
    backend = device = ""
    try:
        h = json.loads(urllib.request.urlopen(WORKER_URL + "/health", timeout=3).read())
        backend = str(h.get("backend") or "")
        device = str(h.get("device") or "")
    except Exception:
        backend = ""
    if backend and backend != "mlx-whisper":
        msg = f"⚠ ASR 后端是 {backend}" + (f"/{device}" if device else "") + "，不是 mlx-whisper —— 下面是 CPU 回退态，别当中位写进表"
        if a.strict:
            sys.exit(msg.replace("⚠ ", ""))
        print(msg, flush=True)
    samples = wavs(a.wav)
    result = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "mode": a.mode, "n": a.n,
              "sample_seconds": {p.name: round(os.path.getsize(p) / 32000.0, 2) for p in samples},
              "loadavg": [round(x, 2) for x in os.getloadavg()], "backend": backend, "device": device,
              "runs": {}}

    def measure(url, data, label, tok=None):
        r = post(url, data, tok)
        r["label"] = label
        return r

    if a.mode in ("warm", "all"):
        before = rss_mb(worker_procs())
        rows = []
        for p in samples:
            data = p.read_bytes()
            for i in range(a.n):
                r = measure(WORKER_URL + "/asr", data, p.stem)
                rows.append(r)
                print(f"  warm {p.stem} #{i+1} total={r['total_ms']}ms worker={r['worker_ms']}ms "
                      f"len={r['textLen']} text={r['text'][:24]!r}", flush=True)
        result["runs"]["warm"] = {"rss_before_mb": before, "rss_after_mb": rss_mb(worker_procs()),
                                  "total": summary(rows, "total_ms"), "ttfb": summary(rows, "ttfb_ms"),
                                  "worker": summary(rows, "worker_ms"),
                                  "empty": sum(1 for r in rows if r["textLen"] == 0),
                                  "per_sample": {k: summary([r for r in rows if r["label"] == k], "total_ms")
                                                 for k in {r["label"] for r in rows}},
                                  "rows": rows}

    if a.mode in ("host", "all"):
        tok = token()
        if not tok:
            sys.exit(f"读不到 token：{TOKEN_FILE}")
        data = samples[-1].read_bytes()
        rows = [measure(HOST_URL, data, "host", tok) for _ in range(a.n)]
        for r in rows:
            print(f"  host total={r['total_ms']}ms http={r['http']} len={r['textLen']}", flush=True)
        result["runs"]["host"] = {"total": summary(rows, "total_ms"),
                                  "ttfb": summary(rows, "ttfb_ms"), "rows": rows}

    if a.mode in ("cold", "all"):
        killed = kill_workers()
        print(f"  杀掉 worker：{killed}", flush=True)
        data = samples[-1].read_bytes()
        t0 = time.perf_counter()
        argv = [VENV_PY, WORKER_SRC, "--host", "127.0.0.1", "--port", "52399",
                "--model", "large-v3-turbo",
                "--pid-file", os.path.expanduser("~/.dsh/pet-voice/asr/worker.pid")]
        if BACKEND:
            argv += ["--backend", BACKEND]
        spawn = subprocess.Popen(argv,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ready_s, info = wait_health(300)
        first = post(WORKER_URL + "/asr", data)
        result["runs"]["cold"] = {"killed": killed, "spawn_pid": spawn.pid,
                                  "ready_ms": None if ready_s is None else round(ready_s * 1000),
                                  "to_first_result_ms": round((time.perf_counter() - t0) * 1000),
                                  "first_request": first,
                                  "rss_mb": rss_mb([spawn.pid]), "health": info}
        print(f"  cold ready={result['runs']['cold']['ready_ms']}ms "
              f"first_result={first['total_ms']}ms rss={result['runs']['cold']['rss_mb']}MB", flush=True)

    if a.mode in ("stability", "stability_only", "all"):
        data = samples[0].read_bytes()
        base = rss_mb(worker_procs())
        rows = []
        for i in range(a.n):
            r = measure(WORKER_URL + "/asr", data, "stability")
            r["rss_mb"] = rss_mb(worker_procs())
            rows.append(r)
            print(f"  st #{i+1} total={r['total_ms']}ms rss={r['rss_mb']}MB len={r['textLen']}", flush=True)
        result["runs"]["stability"] = {"n": a.n, "rss_start_mb": base, "rss_values": [r["rss_mb"] for r in rows],
                                       "rss_end_mb": rows[-1]["rss_mb"] if rows else None,
                                       "failed": [r for r in rows if not r["ok"]],
                                       "total": summary(rows, "total_ms"), "rows": rows}

    Path(a.out).write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk in ("total", "ttfb", "worker", "ready_ms",
                                                                  "to_first_result_ms", "rss_before_mb",
                                                                  "rss_after_mb", "rss_start_mb", "rss_end_mb",
                                                                  "rss_values", "empty")}
                      for k, v in result["runs"].items()}, ensure_ascii=False, indent=1))
    print(f"\nJSON: {a.out}")


main()
PY

exec "$BENCH_PY" "$TMPPY" --out "$OUT" "$@"
