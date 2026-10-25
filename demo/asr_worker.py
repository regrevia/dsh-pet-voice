#!/usr/bin/env python3
"""vosk 常驻识别进程：stdin 收 {"wav": path}，stdout 回 {"ok": true, "text": "..."}。"""
import json
import sys
import wave

from vosk import KaldiRecognizer, Model, SetLogLevel

SetLogLevel(-1)


def main() -> None:
    model = Model(sys.argv[1])
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            with wave.open(request["wav"], "rb") as wf:
                recognizer = KaldiRecognizer(model, wf.getframerate())
                while True:
                    chunk = wf.readframes(4000)
                    if not chunk:
                        break
                    recognizer.AcceptWaveform(chunk)
                result = json.loads(recognizer.FinalResult())
            text = result.get("text", "").replace(" ", "")
            print(json.dumps({"ok": True, "text": text}, ensure_ascii=False), flush=True)
        except Exception as error:  # noqa: BLE001 - worker must stay alive
            print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
