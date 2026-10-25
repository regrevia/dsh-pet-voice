// 进程内 TTS 延迟实测（AVSpeechSynthesizer.write 回调）
// 对比 `say` CLI：CLI 每句有 ~0.6s 固定启动开销，进程内无此开销。
// 编译/运行: swiftc -O bench/tts_avspeech.swift -o /tmp/tts_av && /tmp/tts_av
import AVFoundation
import Foundation

let texts: [(String, String)] = [
    ("short_12", "你好，今天天气怎么样？"),
    ("mid_20", "你好，我是小宠，今天想陪你聊聊天。"),
    ("long_40", "你好，我是小宠。今天天气不错，我们可以一起出门走走，顺便聊聊你最近在忙的事情，放松一下心情。"),
]

func findVoice(_ lang: String, _ namePart: String) -> AVSpeechSynthesisVoice? {
    for v in AVSpeechSynthesisVoice.speechVoices() where v.language.hasPrefix(lang) {
        if namePart.isEmpty || v.name.lowercased().contains(namePart.lowercased()) { return v }
    }
    return nil
}

struct Result: Codable {
    let caseName: String
    let chars: Int
    let voice: String
    let firstBufferMs: Double
    let totalMs: Double
    let audioSeconds: Double
    let chunks: Int
}

var results: [Result] = []
let voice = findVoice("zh-CN", "Tingting") ?? findVoice("zh-CN", "")!

for (name, text) in texts {
    var done = false
    let synth = AVSpeechSynthesizer()
    let utt = AVSpeechUtterance(string: text)
    utt.voice = voice
    utt.rate = AVSpeechUtteranceDefaultSpeechRate
    var firstMs = -1.0
    var frames: AVAudioFramePosition = 0
    var chunks = 0
    var fmt = AVAudioFormat()
    let t0 = DispatchTime.now()
    synth.write(utt) { buf in
        // 回调给的是 AVAudioBuffer（非 optional）；结束信号是一个 frameLength == 0 的空缓冲
        guard let pcm = buf as? AVAudioPCMBuffer else { return }
        if pcm.frameLength == 0 { done = true; return }
        if firstMs < 0 { firstMs = (Double(DispatchTime.now().uptimeNanoseconds) - Double(t0.uptimeNanoseconds)) / 1e6 }
        chunks += 1
        fmt = pcm.format
        frames += AVAudioFramePosition(pcm.frameLength)
    }
    // 回调在主 RunLoop 上投递，不能阻塞主线程等待 —— 用 RunLoop 泵到 done 或超时
    let deadline = Date().addingTimeInterval(30)
    while !done && Date() < deadline { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.005)) }
    let totalMs = (Double(DispatchTime.now().uptimeNanoseconds) - Double(t0.uptimeNanoseconds)) / 1e6
    let secs = fmt.sampleRate > 0 ? Double(frames) / fmt.sampleRate : 0
    results.append(Result(caseName: name, chars: text.count, voice: voice.name,
                          firstBufferMs: (firstMs * 10).rounded() / 10,
                          totalMs: (totalMs * 10).rounded() / 10,
                          audioSeconds: (secs * 1000).rounded() / 1000, chunks: chunks))
}

let enc = JSONEncoder()
enc.outputFormatting = [.prettyPrinted, .sortedKeys]
FileHandle.standardOutput.write(try! enc.encode(results))
