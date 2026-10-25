本机（macOS）Speech 框架探针，2026-10-25 13:57–14:00 跑过 6 次，全部在 TCC 隐私校验处 SIGTRAP 崩溃（DiagnosticReports: ASR / asrbin2 / asrbin3，Retired 目录）。
结论：命令行进程拿不到「语音识别 / 麦克风」授权时，SFSpeechRecognizer 会直接把进程 abort，不会回错误码；未打包签名 + 未在系统设置里授权的本机 ASR 走不通，Pet 的本机识别只用 Python whisper worker。

只在需要复核这条结论时按需编译运行，不要把产物留在 /private/tmp 或 LaunchServices 里：
swiftc asr2.swift -o /private/tmp/asrbin && /private/tmp/asrbin <16k.wav> zh-CN
