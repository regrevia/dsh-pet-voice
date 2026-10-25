#!/usr/bin/env python3
"""查宿主转录：这一轮标记进没进宿主、有没有回复。

用法：pv-transcript.py <base(无尾斜杠)> <sessionId> <标记>
输出两行：
  user=yes|no        宿主转录里有没有带本轮标记的用户消息
  reply=<一行回复>   那条消息之后的第一条助手回复（没有就空）
"""
import json
import os
import subprocess
import sys


def token() -> str:
    p = os.path.expanduser("~/.dsh/pet-voice/token")
    with open(p, "r", encoding="utf-8") as f:
        return f.read().strip()


def fetch(base: str, sid: str, limit: int = 30) -> list:
    tok = token()
    url = "%s/api/session?id=%s&limit=%d" % (base, sid, limit)
    out = subprocess.run(
        ["curl", "-sk", "-m", "8", "-H", "Cookie: pkv_%s=%s" % (tok[:8], tok), url],
        capture_output=True,
        text=True,
    ).stdout
    try:
        d = json.loads(out)
    except Exception:
        return []
    return d.get("messages") or []


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: pv-transcript.py <base> <sessionId> <marker>", file=sys.stderr)
        return 2
    base, sid, marker = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
    msgs = fetch(base, sid)
    hit = [i for i, m in enumerate(msgs) if marker in (m.get("text") or "")]
    users = [i for i in hit if msgs[i].get("role") == "user"]
    print("user=%s" % ("yes" if users else "no"))
    reply = ""
    if users:
        after = [
            m for m in msgs[users[-1] + 1:]
            if m.get("role") == "assistant" and (m.get("text") or "").strip()
        ]
        if after:
            reply = after[0]["text"].replace("\n", " ").strip()[:200]
    print("reply=%s" % reply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
