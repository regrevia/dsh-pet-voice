#!/usr/bin/env python3
"""whisper 常驻识别进程：stdin 收 {"wav": path}，stdout 回 {"ok": true, "text": "..."}。

模型只在启动时加载一次（base，CPU）。首次调用会多花 ~1s（图下沉、缓存预热），
之后每句 3 秒音频约 180-210ms（见 bench/results/asr_bench.json）。

注意：系统 python3.9 自带的 typing_extensions 太旧，openai-whisper 起不来，
所以启动时必须把 asr/vendor（新版 typing_extensions）放到 PYTHONPATH 前面。
"""
import json
import sys

import whisper

# 专名热词：whisper 裸跑会把「鲸灵」听成「精灵/金玲」，initial_prompt 能显著纠正
HOTWORDS = "以下是和虚拟宠物「鲸灵」的普通话对话。鲸灵，小宠，随身宠物。"


def main() -> None:
    model = whisper.load_model(sys.argv[1] if len(sys.argv) > 1 else "base", device="cpu")
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            result = model.transcribe(
                request["wav"],
                language="zh",
                fp16=False,
                initial_prompt=HOTWORDS,
                condition_on_previous_text=False,
                beam_size=1,
                best_of=1,
                temperature=0.0,
            )
            text = (result.get("text") or "").strip().replace(" ", "")
            print(json.dumps({"ok": True, "text": text}, ensure_ascii=False), flush=True)
        except Exception as error:  # noqa: BLE001 - worker 必须活着
            print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
