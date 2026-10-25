import Foundation
import Speech
import AVFoundation

let path = CommandLine.arguments[1]
let localeId = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "zh-CN"
guard let rec = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    print("NO_RECOGNIZER"); exit(1)
}
print("available=\(rec.isAvailable) onDevice=\(rec.supportsOnDeviceRecognition)")
SFSpeechRecognizer.requestAuthorization { st in
    print("auth=\(st.rawValue)")
    guard st == .authorized else { exit(2) }
    let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    req.requiresOnDeviceRecognition = true
    req.shouldReportPartialResults = false
    var done = false
    let t = rec.recognitionTask(with: req) { result, err in
        if let err = err { print("ERR: \(err)") ; done = true; exit(3) }
        if let r = result, r.isFinal {
            for seg in r.bestTranscription.segments {
                print(String(format: "[%.1f-%.1f] %@", seg.timestamp, seg.timestamp + seg.duration, seg.substring))
            }
            done = true
            exit(0)
        }
    }
    _ = t
    while !done { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.5)) }
}
RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(600))
