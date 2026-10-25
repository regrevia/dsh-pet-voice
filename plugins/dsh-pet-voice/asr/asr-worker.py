#!/usr/bin/env python3
"""本机 whisper 语音识别常驻 worker：只监听 127.0.0.1，给 dsh-pet-voice 插件当后备。

为什么要有这个进程：
    手机端每次说话都要把 wav 交给识别。whisper 的 base 模型加载一次要 1–3 s，
    如果每个请求都 `python -c "...transcribe..."` 起一个新进程，光加载就把延迟吃光了。
    所以这里把模型常驻在内存里，插件按需懒启动它，冷启动之后每个请求只剩推理时间。

用法（一般由插件 spawn，不需要手动跑）：
    python asr-worker.py [--port 52399] [--model base] [--pid-file <path>]

接口：
    GET  /health  → {"ok":true,"model":"base","pid":123,"uptimeMs":...}
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
import signal
import sys
import threading
import time
import wave

# 16kHz 单声道，和 Android 侧录音参数一致；whisper 内部也按 16k 处理。
SAMPLE_RATE = 16000
# whisper 的 base 模型对「第一次调用」有一次性开销（权重在等），启动时先空跑一次。
WARMUP_SECONDS = 1.0
# 请求体上限：10 s 的 16k/16bit 单声道 = 320000 B，留 8 倍余量挡异常客户端。
MAX_BODY = 8 * 1024 * 1024
# 静音判定阈值：按 s16le 的整数量化算（0–32767），小于这个值就当没说话。
# 注意波形在 decode_wav 里已经归一化到 -1..1，所以真比较时要乘回 32768。
SILENCE_RMS_INT16 = 90.0

STARTED_AT = time.time()


def log(message: str) -> None:
    """stderr 走日志；插件把 stdout/stderr 都重定向到 worker.log。"""
    print(f"[asr] {message}", file=sys.stderr, flush=True)


def load_model(name: str):
    """加载 whisper 模型（只做一次）。device 固定 cpu：这台机器没有 CUDA，fp16=False。"""
    import whisper  # 延迟 import：让 --help / 参数错误不必等 torch 起来

    started = time.monotonic()
    model = whisper.load_model(name, device="cpu")
    log(f"模型 {name} 已载入（{int((time.monotonic() - started) * 1000)} ms，device=cpu）")
    return model


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
    录音里一旦混进 TTS 回声或空调声，base 模型很容易吐「请点赞、订阅、转发」这种话。
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
        if compression > 3.0:
            continue  # 复读机式输出，直接不信
        if logprob > -0.6:
            return True
    return False


class Worker:
    """把「模型 + 锁」封在一起，HTTP 层只负责收发 JSON。"""

    def __init__(self, model_name: str) -> None:
        self.model_name = model_name
        self.model = load_model(model_name)
        self.lock = threading.Lock()
        self.warmup()

    def warmup(self) -> None:
        """空跑一次：把 torch 的首次分配、算子预热掉，第一个真实请求就不用再等。"""
        import numpy as np

        started = time.monotonic()
        try:
            with self.lock:
                self.model.transcribe(
                    np.zeros(int(SAMPLE_RATE * WARMUP_SECONDS), dtype=np.float32),
                    language="zh",
                    fp16=False,
                    beam_size=1,
                    condition_on_previous_text=False,
                    initial_prompt="以下是简体中文普通话，助手叫鲸灵。",
                )
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
        except Exception as error:  # noqa: BLE001
            return {"ok": False, "error": f"WAV 解析失败：{error}"}
        if is_silent(samples):
            return {"ok": True, "text": "", "ms": int((time.monotonic() - started) * 1000)}
        try:
            # 这组参数是实测过的：beam_size=1 + 关闭上下文，3.4 s 音频约 0.17 s；
            # initial_prompt 把输出钉成简体，并且让「鲸灵」这种自造词能被正确认出来。
            with self.lock:
                result = self.model.transcribe(
                    samples,
                    language="zh",
                    fp16=False,
                    beam_size=1,
                    condition_on_previous_text=False,
                    initial_prompt="以下是简体中文普通话，助手叫鲸灵。",
                )
        except Exception as error:  # noqa: BLE001 - 推理异常也要回 200 + ok:false
            return {"ok": False, "error": f"识别失败：{type(error).__name__}: {error}"}
        text = str(result.get("text") or "").strip()
        if text and not keeps_any_speech(result.get("segments")):
            # 整段都被判成「没人声 + 概率低」：模型在杂音上编的套话，宁可返回空
            log(f"丢弃疑似幻听：{text[:40]}")
            text = ""
        return {"ok": True, "text": text, "ms": int((time.monotonic() - started) * 1000)}


def make_handler(worker: Worker):
    from http.server import BaseHTTPRequestHandler

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "pet-asr/1"

        def log_message(self, fmt, *args):  # noqa: A003 - 覆盖基类，日志格式统一
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
                # 插件那边可能已经超时断开（冷启动 8 s 之外），不是错误。
                pass

        def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 的命名
            if self.path.split("?")[0] == "/health":
                self._send_json(
                    {
                        "ok": True,
                        "model": worker.model_name,
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
            # 插件用 HEAD 探活也行，不自量力地回个头就够了。
            self.send_response(200)
            self.send_header("content-length", "0")
            self.end_headers()

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="本机 whisper 识别 worker（只监听 127.0.0.1）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ASR_PORT", "52399")))
    parser.add_argument("--model", default=os.environ.get("ASR_MODEL", "base"))
    parser.add_argument("--pid-file", default=os.environ.get("ASR_PID_FILE", ""))
    args = parser.parse_args()

    from http.server import ThreadingHTTPServer

    worker = Worker(args.model)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(worker))
    server.daemon_threads = True

    if args.pid_file:
        try:
            os.makedirs(os.path.dirname(args.pid_file), exist_ok=True)
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

    log(f"监听 http://{args.host}:{args.port}（pid {os.getpid()}，模型 {args.model}）")
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
