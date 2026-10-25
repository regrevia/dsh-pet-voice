#!/usr/bin/env python3
"""edge-tts 整句合成器：收到完整音频后一次写到 stdout。

用法：
    stream.py <voice> <text> [rate] [pitch]

- voice 必须是宿主侧白名单里的音色 id（这里是最后一道校验）
- rate/pitch 形如 `+8%` / `-4%`、`+2Hz` / `-2Hz`
- stdout 只有音频字节；stderr 只打一行统计，方便宿主日志排查
- 任何失败都以非 0 退出码结束，并往 stderr 打中文原因

注意两点（别按「本地 TTS / 边合成边播」理解）：
1. edge_tts.Communicate 用的是微软的在线语音服务，这一段必须能出网；音频在
   `communicate.stream()` 里分块到达，但本脚本**收完整句**才写 stdout ——
   因为要先做掐头去尾/压停顿，整句才处理得对。App 侧本来也是下完整个 mp3 再播，
   所以这里没有做逐块转发，`vendor_first_chunk_ms` 只是厂商第一块到达的时间点，
   不是用户听到声音的时间。
2. 真正播放前还有下载、丢弃/排队；首字延迟以端到端实测为准，别引用这个数。
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import os
import tempfile
import sys
import time


def _fail(code: int, message: str) -> int:
    print(message, file=sys.stderr, flush=True)
    return code


async def _run(voice: str, text: str, rate: str, pitch: str) -> int:
    try:
        import edge_tts
    except ImportError:
        return _fail(3, "edge-tts 未安装：请运行 plugins/dsh-pet-voice/tts/setup.sh")

    started = time.monotonic()
    first_at = None
    chunks = 0
    total = 0
    parts: list[bytes] = []
    try:
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        async for chunk in communicate.stream():
            if chunk.get("type") != "audio":
                continue
            data = chunk.get("data") or b""
            if not data:
                continue
            if first_at is None:
                first_at = time.monotonic() - started
            chunks += 1
            total += len(data)
            parts.append(data)
    except Exception as error:  # noqa: BLE001 - 子进程边界，任何异常都要翻译成中文
        return _fail(4, f"合成失败：{type(error).__name__}: {error}")

    if not total:
        return _fail(5, "合成失败：没有拿到音频数据（音色 id 或网络可能不对）")

    raw = b"".join(parts)
    # 掐头去尾：edge-tts 每句结尾固定挂着 0.5s 左右静音（实测 3.26s 的句子尾部 0.56s），
    # App 是一句一句排队播的，这段静音就是听感上的「大喘气」。这里统一裁到 40ms。
    trimmed = _trim_silence(raw)
    sys.stdout.buffer.write(trimmed)
    sys.stdout.buffer.flush()

    elapsed = time.monotonic() - started
    print(
        f"[tts] voice={voice} rate={rate} pitch={pitch} chunks={chunks} bytes={len(trimmed)} "
        f"raw={total} vendor_first_chunk_ms={int((first_at or 0) * 1000)} total_ms={int(elapsed * 1000)}",
        file=sys.stderr,
        flush=True,
    )
    return 0


def _trim_silence(mp3: bytes) -> bytes:
    """掐掉首尾静音，并把句间长停顿压到 120ms。没有 ffmpeg 就原样返回。"""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or len(mp3) < 1024:
        return mp3
    af = (
        "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB,"
        "areverse,"
        "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB,"
        "areverse,"
        "apad=pad_dur=0.04"
    )
    try:
        done = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
             "-af", af, "-f", "mp3", "-b:a", "48k", "pipe:1"],
            input=mp3,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
    except Exception:  # noqa: BLE001 - 裁静音失败不能影响出声
        return mp3
    out = done.stdout or b""
    out = out if done.returncode == 0 and len(out) > 1024 else mp3
    return _cap_pauses(ffmpeg, out)


def _cap_pauses(ffmpeg: str, mp3: bytes) -> bytes:
    """句间停顿压到 120ms：edge-tts 一句一句之间留 0.6s，连着播就是「大喘气」。"""
    try:
        scan = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", "pipe:0", "-af",
             "silencedetect=noise=-38dB:d=0.3", "-f", "null", "-"],
            input=mp3, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
        )
    except Exception:  # noqa: BLE001
        return mp3
    text = (scan.stderr or b"").decode("utf8", "ignore")
    pauses = []
    start = None
    for line in text.splitlines():
        if "silence_start:" in line:
            try:
                start = float(line.split("silence_start:")[1].split()[0])
            except (IndexError, ValueError):
                start = None
        elif "silence_end:" in line and start is not None:
            try:
                end = float(line.split("silence_end:")[1].split()[0])
            except (IndexError, ValueError):
                start = None
                continue
            if end > start + 0.3:
                pauses.append((start, end))
            start = None
    if not pauses:
        return mp3

    total = _duration(ffmpeg, mp3)
    if total <= 0:
        return mp3
    keep = 0.12
    segments = []
    cursor = 0.0
    for (ps, pe) in pauses:
        if ps >= total:
            break
        segments.append((cursor, min(ps + keep, total)))
        cursor = min(pe, total)
    if cursor < total - 0.02:
        segments.append((cursor, total))
    segments = [(a, b) for (a, b) in segments if b - a > 0.05]
    if len(segments) <= 1:
        return mp3

    parts = []
    for idx, (a, b) in enumerate(segments):
        parts.append(f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=N/SR/TB[s{idx}]")
    graph = ";".join(parts)
    pads = "".join(f"[s{i}]" for i in range(len(segments)))
    graph += f";{pads}concat=n={len(segments)}:v=0:a=1[out]"
    try:
        done = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
             "-filter_complex", graph, "-map", "[out]", "-f", "mp3", "-b:a", "48k", "pipe:1"],
            input=mp3, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
        )
    except Exception:  # noqa: BLE001
        return mp3
    out = done.stdout or b""
    return out if done.returncode == 0 and len(out) > 1024 else mp3


def _duration(ffmpeg: str, mp3: bytes) -> float:
    """管子里探长度不可靠，落个临时文件问 ffprobe。"""
    probe = shutil.which("ffprobe")
    if not probe:
        return 0.0
    path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp.write(mp3)
            path = tmp.name
        done = subprocess.run(
            [probe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
        )
        return float((done.stdout or b"0").decode().strip() or 0)
    except Exception:  # noqa: BLE001
        return 0.0
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def main() -> int:
    if len(sys.argv) < 3:
        return _fail(2, "用法：stream.py <voice> <text> [rate] [pitch]")
    voice = sys.argv[1].strip()
    text = sys.argv[2].strip()
    if not voice:
        return _fail(2, "缺少 voice")
    if not text:
        return _fail(2, "缺少 text")
    rate = sys.argv[3].strip() if len(sys.argv) > 3 else ""
    pitch = sys.argv[4].strip() if len(sys.argv) > 4 else ""
    return asyncio.run(_run(voice, text, rate or "+0%", pitch or "+0Hz"))


if __name__ == "__main__":
    sys.exit(main())
