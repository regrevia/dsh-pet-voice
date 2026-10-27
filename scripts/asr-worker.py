#!/usr/bin/env python3
"""本机 whisper 语音识别常驻 worker：只监听 127.0.0.1，给 dsh-pet-voice 插件当后备。

为什么要有这个进程：
    手机端每次说话都要把 wav 交给识别。模型加载一次要几百毫秒到几秒，
    如果每个请求都 `python -c "...transcribe..."` 起一个新进程，光加载就把延迟吃光了。
    所以这里把模型常驻在内存里，插件按需懒启动它，冷启动之后每个请求只剩推理时间。

v3（延迟专项，2026-10）改了什么、为什么：
    线上体验是「说完半天没反应 / 识别不准」。bench/asr-latency/ 用 9 条中文样本 × 原音/SNR10/SNR5
    三档在 M4 Pro(CPU) 上实测，两个元凶：
      1. whisper 默认 temperature=(0, 0.2, …, 1.0) 回退阶梯：一句正常的「可以啊」被噪声一糊，
         前几档都判不过，会把 5 档全试一遍——短句实测 8.2 / 8.7 / 14.4 s，而且高温那几档
         直接开始胡编（「那可以呀……據悅 씨가 來了 Angels」「這 wichtige Spider Romo」）。
         固定 temperature=0.0 后同一批样本 1.5–1.7 s、全部正确，不再有秒级长尾。
      2. beam_size=5 比 1 慢约 40%，而温度固定 0 之后两者在这批样本上错字率没差别
         （都是 0.01 量级），所以降到 1。
      3. without_timestamps=True：只要文本，不再为每个 token 解时间戳，短句再省一点。
    模型不降级：base 快 10 倍但杂音下错字率 0.11–0.27（「局域网」→「举与往」、「扫码直接用」→
    「小马时间」），用户说的「识别不准」会更严重，所以仍用插件传的 large-v3-turbo。

    另外：装了 mlx-whisper（Apple Silicon Metal 实现，同样的模型通常 <1 s）就自动优先用它；
    没装或模型没缓存就退回 openai-whisper，行为与现在完全一致（本机没网时验证过：
    只多一行「mlx-whisper 不可用，改用 openai-whisper」日志，服务照常）。

用法（一般由插件 spawn，不需要手动跑）：
    python asr-worker.py [--port 52399] [--model large-v3-turbo] [--pid-file <path>]

接口：
    GET  /health  → {"ok":true,"model":"large-v3-turbo","backend":"openai-whisper",
                     "device":"cpu","pid":123,"uptimeMs":...}
    POST /asr     body = WAV 原始字节（16kHz 单声道 s16le）
                  → {"ok":true,"text":"...","ms":123}
                  → {"ok":false,"error":"..."}（HTTP 仍然 200，别让调用方把业务错误当网络错误）

约束：
    - 只 bind 127.0.0.1：公网侧永远只有插件那一条鉴权过的路由，worker 自己不开外网口。
    - 零新增依赖：只用 stdlib + venv 里已有的 whisper/torch/numpy。
    - 单实例串行推理：whisper 的模型对象不是线程安全的，并发跑会互相踩内存；
      这里用一把锁把 /asr 串起来（手机端本来就是「一次一句话」，串起来没有副作用）。
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import signal
import sys
import threading
import time
import wave

# 16kHz 单声道，和 Android 侧录音参数一致；whisper 内部也按 16k 处理。
SAMPLE_RATE = 16000
# 默认模型：base（139 MB）在中文上会稳定错字（「语音识别服务」→「余音时别服务」、「截图」→「截圖」），
# 而且时不时吐繁体。large-v3-turbo（1.5 GB，M4 Pro 上加载 5.0 s、一次请求 1.5–2.9 s）
# 实测同一批句子全对，只在超短句上偶尔错一个字，所以默认用它。
DEFAULT_MODEL = "large-v3-turbo"
# 解码参数（所有后端共用）。逐项理由见文件头 v3 说明：
#   temperature=0.0         关掉温度回退阶梯：不再连试 5 档（8–14 s），也不会高温胡编
#   without_timestamps=True 只要文本，不解时间戳 token
#   beam_size=1             温度固定后与 beam5 准确率持平，但快约 40%
#   condition_on_previous_text=False 一句一句独立识别，不让上一句的错字带偏这一句
#   initial_prompt          把输出钉成简体（线上出过「截圖」「據悅」这种繁体）
DECODE_OPTIONS = {
    "language": "zh",
    "fp16": False,
    "beam_size": 1,
    "condition_on_previous_text": False,
    "initial_prompt": "以下是简体中文普通话。",
    "without_timestamps": True,
    "temperature": 0.0,
}
# 助手名字的听写变体：TTS 实测「鲸灵」稳定被识别成「精灵」，这几种同音写法统一改回本名。
# 只做整词替换，且这是宠物应用里唯一高频专名，误伤面很小。
NAME_FIXES = (
    ("精灵", "鲸灵"),
    ("京灵", "鲸灵"),
    ("晶灵", "鲸灵"),
    ("精玲", "鲸灵"),
    ("鲸玲", "鲸灵"),
    ("精零", "鲸灵"),
)
# 第一次调用有一次性开销（权重在等、算子没编译），启动时先空跑一次。
WARMUP_SECONDS = 1.0
# 请求体上限：10 s 的 16k/16bit 单声道 = 320000 B，留 8 倍余量挡异常客户端。
MAX_BODY = 8 * 1024 * 1024
# 静音判定阈值：按 s16le 的整数量化算（0–32767），小于这个值就当没说话。
# 注意波形在 decode_wav 里已经归一化到 -1..1，所以真比较时要乘回 32768。
SILENCE_RMS_INT16 = 90.0

# mlx-whisper 用的是 HF 仓库名而不是本机 .pt 文件名；装了才走这条路。
MLX_REPOS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    # 注意：turbo 的 mlx 仓库名没有 -mlx 后缀（带后缀的是 401/不存在），
    # 写错会静默退回 openai-whisper——本机就是这么一直跑 CPU 的。
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}

STARTED_AT = time.time()


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def log(message: str) -> None:
    """stderr 走日志；插件把 stdout/stderr 都重定向到 worker.log。"""
    print(f"[asr] {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- 转写记录
# 出问题（识别成乱码、把助手自己的播报当用户说话）时，唯一能复盘的就是「当时喂了什么、
# 吐出来什么」。只记文本和耗时，不落音频：一句话几十字节，几百 KB 够查很久。
TRANSCRIPT_LOG = os.environ.get(
    "ASR_TRANSCRIPT_LOG",
    os.path.join(os.path.expanduser("~"), ".dsh", "pet-voice", "asr", "transcripts.log"),
)
TRANSCRIPT_LOG_MAX = 512 * 1024


def log_transcript(line: str) -> None:
    """一行一句；写失败绝不影响识别。超过上限就砍掉前一半（老的先走）。"""
    try:
        os.makedirs(os.path.dirname(TRANSCRIPT_LOG), exist_ok=True)
        with open(TRANSCRIPT_LOG, "a", encoding="utf-8") as handle:
            handle.write(line.rstrip("\n") + "\n")
        if os.path.getsize(TRANSCRIPT_LOG) > TRANSCRIPT_LOG_MAX:
            with open(TRANSCRIPT_LOG, "r", encoding="utf-8", errors="replace") as handle:
                keep = handle.read()[TRANSCRIPT_LOG_MAX // 2 :]
            with open(TRANSCRIPT_LOG, "w", encoding="utf-8") as handle:
                handle.write(keep)
    except Exception:  # noqa: BLE001 - 日志永远不该拦住主流程
        pass


# whisper 在静音/噪声/回声上最爱编的几句套话。命中就直接当没听见。
BOILERPLATE = (
    "请点赞",
    "请按赞",
    "记得点赞",
    "点赞转发",
    "转发转发",
    "点赞订阅",
    "订阅频道",
    "订阅转发",
    "转发给",
    "打赏",
    "字幕由",
    "字幕组",
    "感谢观看",
    "谢谢观看",
    "明镜与点点",
    "下集再见",
    "关注我",
    "amara.org",
)
# 「这句话说得太快」：中文正常语速 4–8 字/秒，超过这个数基本是复读机或幻听。
MAX_CHARS_PER_SECOND = 11.0


def fix_names(text: str) -> str:
    """把助手名字的同音错写改回「鲸灵」。"""
    for wrong, right in NAME_FIXES:
        text = text.replace(wrong, right)
    return text


def degenerate_reason(text: str, seconds: float) -> str:
    """识别结果像不像幻听/复读。返回理由，空串表示正常。

    base 模型在杂音上会吐「请按赞、转发、转发、转发……」这种；回声音量一大，
    光靠 avg_logprob 判不掉，用户看到的就是整段乱码。这里按「文本长得不像人话」再兜一层。
    """
    dense = re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE)
    if not dense:
        return ""
    lowered = text.lower()
    for phrase in BOILERPLATE:
        if phrase in lowered:
            return f"套话「{phrase}」"
    # 长片段连 3 次、两个字连 4 次，都是复读机；两个字的放松到 4 次，免得把「哈哈哈哈」误杀。
    repeated = re.search(r"(.{3,8})\1{2,}", dense) or re.search(r"(.{2})\1{3,}", dense)
    if repeated:
        return f"复读「{repeated.group(1)}」"
    if seconds >= 1.0:
        rate = len(dense) / seconds
        if rate > MAX_CHARS_PER_SECOND:
            return f"字数太密（{rate:.0f} 字/秒）"
    return ""


def decode_wav(body: bytes) -> "object":
    """WAV 字节 → float32 单声道波形。

    用 stdlib 的 wave 解，不用 ffmpeg：客户端本来就承诺 16k/单声道/s16le，
    形状不对就该明确报错，而不是让 ffmpeg 在后台偷偷重采样（延迟不可控）。
    """
    import numpy as np

    with wave.open(io.BytesIO(body), "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())
    if width != 2:
        raise ValueError(f"只支持 s16le（当前 {width * 8} bit）")
    if channels != 1:
        raise ValueError(f"只支持单声道（当前 {channels} 声道）")
    if rate != SAMPLE_RATE:
        raise ValueError(f"只支持 {SAMPLE_RATE} Hz（当前 {rate} Hz）")
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    return samples


def is_silent(samples) -> bool:
    """RMS 低于阈值 → 静音。空数组也算静音。"""
    import numpy as np

    if samples.size == 0:
        return True
    rms = float(np.sqrt(np.mean(np.square(samples)))) * 32768.0
    return rms < SILENCE_RMS_INT16


def keeps_any_speech(segments) -> bool:
    """每段要靠「有人声」或「置信度够」站住脚，一条都不剩就当整段是幻听。

    阈值取 whisper 自己的默认口径（no_speech 0.6 / avg_logprob -1.0），压得比默认更严一点：
    录音里一旦混进 TTS 回声或空调声，模型很容易吐「请点赞、订阅、转发」这种话。
    """
    if not segments:
        return True  # 老版本没有 segments 字段时别误杀
    for seg in segments:
        try:
            no_speech = float(seg.get("no_speech_prob") or 0.0)
            logprob = float(seg.get("avg_logprob") or 0.0)
            compression = float(seg.get("compression_ratio") or 0.0)
        except (TypeError, ValueError):
            return True
        if no_speech < 0.6 and logprob > -1.0:
            return True
        # 超短句（0.5–1 s）只有两三个 token，avg_logprob 天然偏低：实测「可以啊」在 SNR10 噪声里
        # 文本完全正确，avg_logprob 却是 -1.068，被 -1.0 这一刀砍掉 → 用户看到「说了没反应」。
        # 所以补一条：no_speech 极低（模型很确定有人在说话）且 compression 正常时，放宽到 -1.3。
        if no_speech < 0.2 and compression < 2.4 and logprob > -1.3:
            return True
        if compression > 3.0:
            continue  # 复读机式输出，直接不信
        if logprob > -0.6:
            return True
    return False


class WhisperBackend:
    """openai-whisper（venv 里本来就有）：CPU 推理，模型常驻。"""

    name = "openai-whisper"

    def __init__(self, model_name: str) -> None:
        import whisper  # 延迟 import：让 --help / 参数错误不必等 torch 起来

        self.model_name = model_name
        # 这台机器没有 CUDA；MPS 上 sparse 算子缺失，large-v3-turbo 跑不起来。
        self.device = "cpu"
        started = time.monotonic()
        self._model = whisper.load_model(model_name, device=self.device)
        log(f"模型 {model_name} 已载入（{int((time.monotonic() - started) * 1000)} ms，"
            f"backend={self.name} device={self.device}）")

    def transcribe(self, samples) -> dict:
        return self._model.transcribe(samples, **DECODE_OPTIONS)


class MlxBackend:
    """mlx-whisper（Apple Silicon Metal 实现）：装了才用，一条请求通常 <1 s。"""

    name = "mlx-whisper"

    def __init__(self, model_name: str) -> None:
        import mlx_whisper  # 没装会 ImportError，由 create_backend 兜住

        self._api = mlx_whisper
        self.model_name = model_name
        self.device = "gpu"
        self.repo = MLX_REPOS.get(model_name, model_name)
        # mlx-whisper 不认 beam_size / fp16：它只有贪心（等价 temperature=0）
        self._kwargs = {
            key: DECODE_OPTIONS[key]
            for key in ("language", "initial_prompt", "condition_on_previous_text",
                        "without_timestamps", "temperature")
        }
        started = time.monotonic()
        # 第一次调用就是加载权重（本机缓存过就很快）；加载失败直接抛给上层回退
        import numpy as np

        self.transcribe(np.zeros(int(SAMPLE_RATE * WARMUP_SECONDS), dtype=np.float32))
        log(f"模型 {self.repo} 已载入（{int((time.monotonic() - started) * 1000)} ms，"
            f"backend={self.name}）")

    def transcribe(self, samples) -> dict:
        return self._api.transcribe(samples, path_or_hf_repo=self.repo, **self._kwargs)


def create_backend(model_name: str, choice: str = "auto"):
    """按 --backend 选后端；auto 时优先 mlx-whisper，不可用就退回 openai-whisper。"""
    if choice in ("auto", "mlx"):
        try:
            return MlxBackend(model_name)
        except Exception as error:  # noqa: BLE001 - 未安装 / 模型没缓存 / 无 Metal
            if choice == "mlx":
                raise
            log(f"mlx-whisper 不可用（{type(error).__name__}: {error}），改用 openai-whisper")
    return WhisperBackend(model_name)


class Worker:
    """把「后端 + 锁」封在一起，HTTP 层只负责收发 JSON。"""

    def __init__(self, model_name: str, backend: str = "auto") -> None:
        self.model_name = model_name
        self.backend = create_backend(model_name, backend)
        self.lock = threading.Lock()
        self.warmup()

    def warmup(self) -> None:
        """空跑一次：把首次分配、算子预热掉，第一个真实请求就不用再等。"""
        import numpy as np

        started = time.monotonic()
        try:
            with self.lock:
                self.backend.transcribe(
                    np.zeros(int(SAMPLE_RATE * WARMUP_SECONDS), dtype=np.float32))
        except Exception as error:  # noqa: BLE001 - 预热失败不该拦住服务启动
            log(f"预热失败（不影响使用）：{type(error).__name__}: {error}")
            return
        log(f"预热完成（{int((time.monotonic() - started) * 1000)} ms）")

    def transcribe(self, body: bytes) -> dict:
        started = time.monotonic()
        if not body:
            return {"ok": True, "text": "", "ms": 0}
        try:
            samples = decode_wav(body)
        except Exception as error:  # noqa: BLE001 - 坏 WAV 是业务错误，回 200 + ok:false
            return {"ok": False, "error": f"WAV 解析失败：{error}"}
        seconds = len(samples) / float(SAMPLE_RATE)
        if is_silent(samples):
            log_transcript(f"{iso_now()} {len(body)}B {seconds:.2f}s silent")
            return {"ok": True, "text": "", "ms": int((time.monotonic() - started) * 1000)}
        try:
            with self.lock:
                result = self.backend.transcribe(samples)
        except Exception as error:  # noqa: BLE001 - 推理异常也要回 200 + ok:false
            return {"ok": False, "error": f"识别失败：{type(error).__name__}: {error}"}
        text = fix_names(str(result.get("text") or "").strip())
        drop = ""
        if text and not keeps_any_speech(result.get("segments")):
            # 整段都被判成「没人声 + 概率低」：模型在杂音上编的套话，宁可返回空
            drop = "置信度太低"
        elif text:
            drop = degenerate_reason(text, seconds)
        if drop:
            log(f"丢弃疑似幻听（{drop}）：{text[:40]}")
        ms = int((time.monotonic() - started) * 1000)
        log_transcript(
            f"{iso_now()} {len(body)}B {seconds:.2f}s {ms}ms {self.model_name} "
            f"{'DROP:' + drop if drop else 'ok'} {text}"
        )
        return {"ok": True, "text": "" if drop else text, "ms": ms}


def make_handler(worker: Worker):
    from http.server import BaseHTTPRequestHandler

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "pet-asr/1"

        def log_message(self, fmt, *args):
            log(f"{self.address_string()} {fmt % args}")

        def _send_json(self, payload: dict, status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("content-type", "application/json; charset=utf-8")
                self.send_header("content-length", str(len(body)))
                self.send_header("cache-control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                # 插件那边可能已经超时断开，不是错误。
                pass

        def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 的命名
            if self.path.split("?")[0] == "/health":
                self._send_json(
                    {
                        "ok": True,
                        "model": worker.model_name,
                        "backend": worker.backend.name,
                        "device": getattr(worker.backend, "device", "cpu"),
                        "pid": os.getpid(),
                        "uptimeMs": int((time.time() - STARTED_AT) * 1000),
                    }
                )
                return
            self._send_json({"ok": False, "error": f"未知路径 {self.path}"}, status=404)

        def do_POST(self):  # noqa: N802
            if self.path.split("?")[0] != "/asr":
                self._send_json({"ok": False, "error": f"未知路径 {self.path}"}, status=404)
                return
            try:
                length = int(self.headers.get("content-length") or 0)
            except ValueError:
                self._send_json({"ok": False, "error": "content-length 非法"})
                return
            if length < 0 or length > MAX_BODY:
                # 先回错误再关连接：不读 body 的话 keep-alive 会把下一段请求吃脏。
                self._send_json({"ok": False, "error": f"请求体过大（{length} > {MAX_BODY}）"})
                self.close_connection = True
                return
            body = self.rfile.read(length) if length else b""
            self._send_json(worker.transcribe(body))

        def do_HEAD(self):  # noqa: N802
            # 插件用 HEAD 探活也行：只要有响应头就说明端口活着。
            self.send_response(200)
            self.send_header("content-length", "0")
            self.end_headers()

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="本机 whisper 识别 worker（只监听 127.0.0.1）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ASR_PORT", "52399")))
    parser.add_argument("--model", default=os.environ.get("ASR_MODEL", DEFAULT_MODEL))
    parser.add_argument("--backend", default=os.environ.get("ASR_BACKEND", "auto"),
                        choices=("auto", "mlx", "whisper"),
                        help="auto：装了 mlx-whisper 就用它，否则 openai-whisper")
    parser.add_argument("--pid-file", default=os.environ.get("ASR_PID_FILE", ""))
    args = parser.parse_args()

    from http.server import ThreadingHTTPServer

    # 先建 worker（模型加载 + 预热）再开端口：插件健康检查通过时模型一定已经就绪。
    worker = Worker(args.model, args.backend)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(worker))
    server.daemon_threads = True

    if args.pid_file:
        try:
            with open(args.pid_file, "w", encoding="utf-8") as fh:
                fh.write(f"{os.getpid()}\n")
        except OSError as error:
            log(f"写 pid 文件失败（不影响服务）：{error}")

    def stop(signum, _frame):
        log(f"收到信号 {signum}，退出")
        threading.Thread(target=server.shutdown, daemon=True).start()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, stop)
        except (ValueError, OSError):
            pass

    log(f"监听 http://{args.host}:{args.port}（pid {os.getpid()}，模型 {args.model}，"
        f"后端 {worker.backend.name}）")
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        if args.pid_file:
            try:
                os.unlink(args.pid_file)
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
