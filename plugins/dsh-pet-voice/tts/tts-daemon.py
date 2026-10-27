#!/usr/bin/env python3
"""edge-tts 常驻连接守护：把「每次现建 WebSocket」换成「进程起就建好、复用」。

为什么值得：一次合成里厂商建连（TLS + WS 握手 + Sec-MS-GEC 票据）实测 683 ms，
而同一连接上第二、三句的首个音频包只要 180~370 ms。原来 stream.py 每次调用
都新建连接，用户等的那 1.2 s 里大头是握手，不是合成。

用法（一般由 stream.py 自动拉起，不建议手跑）：
    tts-daemon.py --serve            # 前台常驻；socket 就绪即代表连接已热
    tts-daemon.py --status           # 打印 socket/连接状态
    tts-daemon.py --stop             # 让它自己退出

协议（本地 Unix socket，帧 = 1 字节类型 + 4 字节大端长度 + 负载）：
    客户端 → 服务端   'J' + {"voice","text","rate","pitch"}
    服务端 → 客户端   'A' + 音频字节（可多帧）→ 'J' + 统计 → 'E'
    出错              'J' + {"error":"中文原因"} → 'E'

并发：连接池默认 2 条，每条同一时刻只服务一个请求（请求期间独占），
所以 A/B 两句同时来会各走一条连接，音频不会交叉——串音在结构上不可能。
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import struct
import sys
import time
import uuid

HOME = os.path.expanduser(os.environ.get("PET_TTS_HOME", "~/.dsh/pet-voice/tts"))
SOCK_PATH = os.path.join(HOME, os.environ.get("PET_TTS_SOCK", "daemon.sock"))
PID_PATH = os.path.join(HOME, "daemon.pid")
LOCK_PATH = os.path.join(HOME, "daemon.lock")
LOG_PATH = os.path.join(HOME, "daemon.log")
POOL = max(1, int(os.environ.get("PET_TTS_DAEMON_CONNS", "2")))
IDLE_TIMEOUT = float(os.environ.get("PET_TTS_DAEMON_IDLE", "600"))
# 厂商侧会回收长时间不说话的 WS：空闲超过这个秒数就提前换一条新连接，
# 免得用户隔一会儿再说话时正好撞在死连接上（换连接放在后台做，不占回合时延）。
KEEPALIVE = float(os.environ.get("PET_TTS_DAEMON_KEEPALIVE", "20"))
# 只在「最近还在用」的时候做后台轮换；长期没人用就不白握手，等下次请求再建。
ACTIVE_WINDOW = float(os.environ.get("PET_TTS_DAEMON_ACTIVE", "180"))

F_J, F_A, F_E = b"J", b"A", b"E"

# 部署核对用：--status 和就绪日志都会打出来，确认线上跑的是哪一版
VERSION = "2-idle-rotate"


def _frame(kind: bytes, payload: bytes = b"") -> bytes:
    return kind + struct.pack(">I", len(payload)) + payload


def _log(message: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {message}"
    print(line, file=sys.stderr, flush=True)


try:
    import aiohttp
    from edge_tts.constants import SEC_MS_GEC_VERSION, WSS_HEADERS, WSS_URL
    from edge_tts.communicate import (
        _SSL_CTX,  # noqa: PLC2701 - 复用官方的 TLS 上下文，避免证书策略分叉
        connect_id,
        date_to_string,
        get_headers_and_data,
        mkssml,
        ssml_headers_plus_data,
    )
    from edge_tts.data_classes import TTSConfig
    from edge_tts.drm import DRM

    EDGE_OK = True
    EDGE_ERR = ""
except Exception as error:  # noqa: BLE001 - 缺依赖时给出中文原因而不是栈
    EDGE_OK = False
    EDGE_ERR = f"脱机依赖不可用：{type(error).__name__}: {error}"

def _config_body() -> str:
    return (
        f"X-Timestamp:{date_to_string()}\r\nContent-Type:application/json; charset=utf-8\r\n"
        "Path:speech.config\r\n\r\n"
        '{"context":{"synthesis":{"audio":{"metadataoptions":{'
        '"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},'
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
    )


class Conn:
    """一条常驻 WS。同一时刻只允许一个回合（caller 必须先 acquire）。"""

    def __init__(self, session: aiohttp.ClientSession) -> None:
        self.session = session
        self.ws = None
        self.connect_ms = 0.0
        self.turns = 0
        self.busy = False
        self.last_used = time.monotonic()

    async def open(self) -> None:
        started = time.monotonic()
        self.ws = await self.session.ws_connect(
            f"{WSS_URL}&ConnectionId={connect_id()}"
            f"&Sec-MS-GEC={DRM.generate_sec_ms_gec()}"
            f"&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}",
            compress=15,
            headers=DRM.headers_with_muid(WSS_HEADERS),
            ssl=_SSL_CTX,
        )
        self.connect_ms = (time.monotonic() - started) * 1000.0
        await self.ws.send_str(_config_body())
        self.turns = 0
        self.last_used = time.monotonic()

    async def close(self) -> None:
        if self.ws is not None and not self.ws.closed:
            try:
                await self.ws.close()
            except Exception:  # noqa: BLE001 - 关连接失败不重要
                pass
        self.ws = None

    async def synthesize(self, voice: str, text: str, rate: str, pitch: str, on_audio):
        """发一个回合，边收边回调 on_audio(bytes)。返回 (first_ms, total_ms, chunks)。"""
        if self.ws is None or self.ws.closed:
            await self.open()
        cfg = TTSConfig(voice=voice, rate=rate, volume="+0%", pitch=pitch,
                        boundary="SentenceBoundary")
        started = time.monotonic()
        first_ms = 0.0
        chunks = 0
        await self.ws.send_str(
            ssml_headers_plus_data(uuid.uuid4().hex, date_to_string(), mkssml(cfg, text))
        )
        async for msg in self.ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                raw = msg.data.encode("utf-8")
                params, _ = get_headers_and_data(raw, raw.find(b"\r\n\r\n"))
                path = params.get(b"Path")
                if path == b"turn.end":
                    break
                if path not in (b"response", b"turn.start", b"audio.metadata"):
                    raise RuntimeError(f"无法识别的事件：{path!r}")
            elif msg.type == aiohttp.WSMsgType.BINARY:
                header_len = int.from_bytes(msg.data[:2], "big")
                audio = msg.data[2 + header_len:]
                if not audio:
                    continue
                if not chunks:
                    first_ms = (time.monotonic() - started) * 1000.0
                chunks += 1
                await on_audio(audio)
            else:
                raise RuntimeError(f"连接被对端关闭（code={self.ws.close_code}）")
        if not chunks:
            # 对端把连接回收了但本地没感知：回合会「正常」结束却一个音频包都没有。
            raise RuntimeError("本回合没有音频（连接可能已被对端回收）")
        self.turns += 1
        self.last_used = time.monotonic()
        return first_ms, (time.monotonic() - started) * 1000.0, chunks


class Pool:
    def __init__(self) -> None:
        self.session = None
        self.free: asyncio.Queue = asyncio.Queue()
        self.all: list[Conn] = []
        self.reconnects = 0
        self.last_request = time.monotonic()

    async def start(self) -> float:
        self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25))
        started = time.monotonic()
        await self._spawn()  # 第一条先热好，就绪即能出声；其余后台补
        for _ in range(POOL - 1):
            asyncio.create_task(self._spawn())
        return (time.monotonic() - started) * 1000.0

    async def _spawn(self) -> None:
        conn = Conn(self.session)
        await conn.open()
        self.all.append(conn)
        self.free.put_nowait(conn)

    async def acquire(self) -> Conn:
        conn = await self.free.get()
        conn.busy = True
        return conn

    def release(self, conn: Conn) -> None:
        conn.busy = False
        conn.last_used = time.monotonic()
        self.free.put_nowait(conn)

    def _drop_from_free(self, conn: Conn) -> bool:
        """把 conn 从空闲队列摘掉；摘不到说明刚好被某个请求拿走了。"""
        queue = getattr(self.free, "_queue", None)
        if queue is None:
            return False
        try:
            queue.remove(conn)
            return True
        except ValueError:
            return False

    async def _replace(self, old: Conn) -> None:
        try:
            fresh = Conn(self.session)
            await fresh.open()
        except Exception as error:  # noqa: BLE001 - 换连接失败就把旧连接放回去
            _log(f"后台换连接失败（{type(error).__name__}: {error}），先用旧的")
            if old in self.all:
                self.free.put_nowait(old)
            return
        self.all.append(fresh)
        self.free.put_nowait(fresh)
        stats_note = f"建连 {int(fresh.connect_ms)}ms"
        await old.close()
        self.reconnects += 1
        _log(f"空闲超过 {int(KEEPALIVE)}s，已后台换新连接（{stats_note}）")

    async def keepalive(self) -> None:
        """空闲连接提前轮换，保证「隔一会儿再说话」也是 0 ms 建连。"""
        while True:
            await asyncio.sleep(min(5.0, max(1.0, KEEPALIVE / 4)))
            now = time.monotonic()
            if now - self.last_request > ACTIVE_WINDOW:
                continue
            for conn in list(self.all):
                if conn.busy or now - conn.last_used <= KEEPALIVE:
                    continue
                if not self._drop_from_free(conn):
                    continue
                if conn.busy:
                    self.free.put_nowait(conn)
                    continue
                self.all.remove(conn)
                # 一轮只换一条：另一条仍是热的，握手那 600ms 万一撞上请求
                # 也不至于两条连接都不可用。
                asyncio.create_task(self._replace(conn))
                break

    async def close(self) -> None:
        await asyncio.gather(*(c.close() for c in self.all), return_exceptions=True)
        if self.session is not None:
            await self.session.close()


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, pool: Pool,
                 stats: dict) -> None:
    peer = "?"
    try:
        head = await reader.readexactly(5)
        kind, size = head[:1], struct.unpack(">I", head[1:])[0]
        payload = json.loads(await reader.readexactly(size)) if kind == F_J else {}
        request = payload if isinstance(payload, dict) else {}
        voice = str(request.get("voice") or "zh-CN-XiaoyiNeural")
        text = str(request.get("text") or "")
        rate = str(request.get("rate") or "+0%")
        pitch = str(request.get("pitch") or "+0Hz")
        if not text:
            raise ValueError("空文本")

        pool.last_request = time.monotonic()
        conn = await pool.acquire()
        connect_ms = 0.0
        try:
            reopened = False
            idle_for = time.monotonic() - conn.last_used
            if idle_for > KEEPALIVE * 1.5:
                # 放太久了（多半已被对端回收），先重建再发，别拿死连接试运气。
                await conn.close()
                await conn.open()
                reopened = True
                _log(f"连接空闲 {int(idle_for)}s 超阈值，发送前重建（建连 {int(conn.connect_ms)}ms）")
            was_warm = conn.ws is not None and not conn.ws.closed
            chunks = 0

            async def on_audio(data: bytes) -> None:
                nonlocal chunks
                chunks += 1
                writer.write(_frame(F_A, data))
                await writer.drain()

            try:
                first_ms, total_ms, chunks = await conn.synthesize(voice, text, rate, pitch, on_audio)
            except Exception as error:  # noqa: BLE001 - 连接坏了就换一条重来一次
                if chunks:  # 已经吐过音频，重来会重音，直接让调用方报错
                    raise
                pool.reconnects += 1
                _log(f"连接失效，重连后重试（{type(error).__name__}: {error}）")
                await conn.close()
                await conn.open()
                connect_ms = conn.connect_ms
                chunks = 0
                first_ms, total_ms, chunks = await conn.synthesize(voice, text, rate, pitch, on_audio)
            else:
                # 这次请求实际付了建连钱就要如实报出来（预热好、也没重建的才是 0）。
                if reopened or not was_warm:
                    connect_ms = conn.connect_ms
        finally:
            pool.release(conn)

        pool.last_request = time.monotonic()
        stats["turns"] += 1
        stats["last_at"] = time.monotonic()
        stats["last"] = f"{int(first_ms)}ms/{chunks}块"
        writer.write(_frame(F_J, json.dumps({
            "ok": True, "conn_ms": int(connect_ms), "first_ms": int(first_ms),
            "total_ms": int(total_ms), "chunks": chunks,
        }).encode()))
        writer.write(_frame(F_E))
        await writer.drain()
    except Exception as error:  # noqa: BLE001 - 单请求失败不能拖垮守护进程
        try:
            writer.write(_frame(F_J, json.dumps({
                "ok": False, "error": f"合成失败：{type(error).__name__}: {error}"[:400],
            }, ensure_ascii=False).encode()))
            writer.write(_frame(F_E))
            await writer.drain()
        except Exception:  # noqa: BLE001
            pass
        _log(f"请求失败（{peer}）：{type(error).__name__}: {error}"[:300])
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass


def _read_pid_file(path: str) -> int:
    try:
        with open(path, encoding="utf-8") as fh:
            return int(fh.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _take_lock() -> bool:
    """独占锁：几个 stream.py 同时冷启动时只许起一个守护进程。

    以前只有「socket 能否连上」这一道判断，而建池要 ~700ms，几个调用挤在
    这段窗口里会各起一个 daemon，互相 unlink 同一个 socket。锁文件里写 pid，
    持有者已经死了（kill -9 / 断电）就清掉重抢，不会把用户卡死。
    """
    for _ in range(2):
        try:
            fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            holder = _read_pid_file(LOCK_PATH)
            if holder and holder != os.getpid() and _pid_alive(holder):
                return False
            try:
                os.unlink(LOCK_PATH)
            except OSError:
                return False
            continue
        try:
            os.write(fd, str(os.getpid()).encode())
        finally:
            os.close(fd)
        return True
    return False


def _release_lock() -> None:
    try:
        if _read_pid_file(LOCK_PATH) == os.getpid():
            os.unlink(LOCK_PATH)
    except OSError:
        pass


async def serve() -> int:
    """对外入口：先抢独占锁，抢不到说明已经有一个在启动/运行，直接成功返回。"""
    if not _take_lock():
        _log("已有守护进程在启动或运行，本次退出")
        return 0
    try:
        return await _serve_locked()
    finally:
        _release_lock()


async def _serve_locked() -> int:
    if not EDGE_OK:
        _log(EDGE_ERR)
        return 3
    os.makedirs(HOME, exist_ok=True)
    if os.path.exists(SOCK_PATH):
        # 已有活着的守护进程就直接复用；残留文件则清掉重建。
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(0.4)
        try:
            probe.connect(SOCK_PATH)
            probe.close()
            _log(f"已有守护进程在 {SOCK_PATH}，本次退出")
            return 0
        except OSError:
            os.unlink(SOCK_PATH)
        finally:
            probe.close()
    pool = Pool()
    warm_ms = await pool.start()
    asyncio.create_task(pool.keepalive())
    stats = {"started": time.time(), "turns": 0, "last": "-", "last_at": time.monotonic()}
    server = await asyncio.start_unix_server(lambda r, w: handle(r, w, pool, stats), path=SOCK_PATH)
    os.chmod(SOCK_PATH, 0o600)
    with open(PID_PATH, "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))
    _log(f"就绪 版本={VERSION} socket={SOCK_PATH} pid={os.getpid()} "
         f"预热 {int(warm_ms)}ms × {POOL} 条连接")
    try:
        while True:
            await asyncio.sleep(15)
            if stats["turns"] and time.monotonic() - stats["last_at"] > IDLE_TIMEOUT:
                _log(f"空闲超过 {int(IDLE_TIMEOUT)}s，退出")
                break
    finally:
        server.close()
    await pool.close()
    # 只清理自己留下的文件：另一个守护进程可能已经接手同一个 socket 路径。
    try:
        if _read_pid() == os.getpid():
            os.unlink(SOCK_PATH)
            os.unlink(PID_PATH)
            _release_lock()
    except OSError:
        pass
    return 0


def main() -> int:
    if "--status" in sys.argv:
        alive = os.path.exists(SOCK_PATH)
        print(f"socket={SOCK_PATH} exists={alive} pid={_read_pid()} "
              f"deps={'ok' if EDGE_OK else EDGE_ERR} 版本={VERSION}")
        return 0 if alive else 1
    if "--stop" in sys.argv:
        pid = _read_pid()
        if not pid:
            return _fail("没有在跑的守护进程")
        try:
            os.kill(pid, 15)
        except OSError as error:
            return _fail(f"停止失败：{error}")
        print(f"已请求退出 pid={pid}")
        return 0
    if "--serve" not in sys.argv:
        return _fail("用法：tts-daemon.py --serve | --status | --stop")
    try:
        return asyncio.run(serve())
    except KeyboardInterrupt:
        return 0


def _read_pid() -> int:
    try:
        return int(open(PID_PATH, encoding="utf-8").read().strip())
    except Exception:  # noqa: BLE001
        return 0


def _fail(message: str) -> int:
    print(message, file=sys.stderr, flush=True)
    return 2



if __name__ == "__main__":
    sys.exit(main())
