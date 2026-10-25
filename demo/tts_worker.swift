// 常驻 TTS：stdin 每行一个 JSON 请求，stdout 回一行 JSON（含输出 wav 路径）。
// 用 AVSpeechSynthesizer.write 在进程内合成，避开 `say` CLI 每句 ~600ms 的进程启动开销
// （实测 bench/results/tts_bench.json：CLI 643-670ms，进程内首包 155.8-161.4ms）。
// 编译: swiftc -O demo/tts_worker.swift -o demo/.tmp/tts_worker
import AVFoundation
import Foundation

func findVoice(_ name: String) -> AVSpeechSynthesisVoice? {
    let all = AVSpeechSynthesisVoice.speechVoices()
    if let exact = all.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
        return exact
    }
    if let zh = all.first(where: { $0.language == "zh-CN" && $0.name.contains(name) }) {
        return zh
    }
    return all.first(where: { $0.language == "zh-CN" })
}

func writeWav(_ samples: [Int16], _ sampleRate: Int, to path: String) throws {
    var data = Data()
    let byteRate = sampleRate * 2
    let dataBytes = samples.count * 2
    func le32(_ v: Int) -> Data { var x = UInt32(v).littleEndian; return Data(bytes: &x, count: 4) }
    func le16(_ v: Int) -> Data { var x = UInt16(v).littleEndian; return Data(bytes: &x, count: 2) }
    data.append("RIFF".data(using: .ascii)!)
    data.append(le32(36 + dataBytes))
    data.append("WAVEfmt ".data(using: .ascii)!)
    data.append(le32(16))
    data.append(le16(1))            // PCM
    data.append(le16(1))            // mono
    data.append(le32(sampleRate))
    data.append(le32(byteRate))
    data.append(le16(2))            // block align
    data.append(le16(16))           // bits
    data.append("data".data(using: .ascii)!)
    data.append(le32(dataBytes))
    var pcm = [Int16](repeating: 0, count: samples.count)
    for i in 0..<samples.count { pcm[i] = samples[i].littleEndian }
    pcm.withUnsafeBufferPointer { data.append(Data(buffer: $0)) }
    try data.write(to: URL(fileURLWithPath: path))
}

func speak(_ text: String, voiceName: String, rate: Float, pitch: Float, out: String) throws -> (Int, Double) {
    let utt = AVSpeechUtterance(string: text)
    utt.voice = findVoice(voiceName)
    utt.rate = rate
    utt.pitchMultiplier = pitch
    utt.preUtteranceDelay = 0
    utt.postUtteranceDelay = 0

    var samples: [Int16] = []
    var sampleRate = 22050
    var done = false
    let start = Date()
    // 回调在主 RunLoop 上投递，必须泵 run loop，不能用信号量阻塞等
    let synth = AVSpeechSynthesizer()

    synth.write(utt) { buffer in
        guard let pcm = buffer as? AVAudioPCMBuffer else { return }
        if pcm.frameLength == 0 {
            done = true
            return
        }
        sampleRate = Int(pcm.format.sampleRate)
        let n = Int(pcm.frameLength)
        let ch = Int(pcm.format.channelCount)
        if let f = pcm.floatChannelData {
            for i in 0..<n {
                var acc: Float = 0
                for c in 0..<ch { acc += f[c][i] }
                acc /= Float(ch)
                let clipped = max(-1, min(1, acc))
                samples.append(Int16(clipped * 32767))
            }
        } else if let s = pcm.int16ChannelData {
            for i in 0..<n {
                var acc = 0
                for c in 0..<ch { acc += Int(s[c][i]) }
                samples.append(Int16(acc / ch))
            }
        }
    }
    let deadline = Date().addingTimeInterval(30)
    while !done && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.005))
    }
    let ms = Date().timeIntervalSince(start) * 1000
    try writeWav(samples, sampleRate, to: out)
    return (sampleRate, ms)
}

func emit(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

emit(["ready": true])

let stdin = FileHandle.standardInput
var buf = Data()
while true {
    let chunk = stdin.availableData
    if chunk.isEmpty { break }
    buf.append(chunk)
    while let nl = buf.firstIndex(of: 0x0A) {
        let lineData = buf.subdata(in: buf.startIndex..<nl)
        buf.removeSubrange(buf.startIndex...nl)
        guard let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { continue }
        let text = (obj["text"] as? String) ?? ""
        if text.isEmpty { continue }
        let out = (obj["out"] as? String) ?? "/tmp/tts.wav"
        do {
            let (sr, ms) = try speak(
                text,
                voiceName: (obj["voice"] as? String) ?? "Tingting",
                rate: Float((obj["rate"] as? Double) ?? 0.55),
                pitch: Float((obj["pitch"] as? Double) ?? 1.12),
                out: out
            )
            emit(["ok": true, "out": out, "ms": Int(ms), "rate": sr])
        } catch {
            emit(["ok": false, "error": "\(error)"])
        }
    }
}
