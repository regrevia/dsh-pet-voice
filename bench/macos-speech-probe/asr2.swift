import Foundation
setbuf(stdout, nil)
import Speech
import AVFoundation

let path = CommandLine.arguments[1]
let localeId = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "zh-CN"
print("initial auth status=\(SFSpeechRecognizer.authorizationStatus().rawValue)")
let sem = DispatchSemaphore(value: 0)

SFSpeechRecognizer.requestAuthorization { st in
    print("auth=\(st.rawValue)")
    sem.signal()
}
_ = sem.wait(timeout: .now() + 60)
print("afterAuth status=\(SFSpeechRecognizer.authorizationStatus().rawValue)")

guard let rec = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    print("NO_RECOGNIZER"); exit(1)
}
print("available=\(rec.isAvailable) onDevice=\(rec.supportsOnDeviceRecognition)")

let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
req.requiresOnDeviceRecognition = true
req.shouldReportPartialResults = false
req.taskHint = .dictation

let out = DispatchSemaphore(value: 0)
var task: SFSpeechRecognitionTask?
task = rec.recognitionTask(with: req) { result, err in
    if let err = err {
        print("ERR: \(err.localizedDescription)")
        out.signal()
        return
    }
    if let r = result, r.isFinal {
        print("SEGMENTS_START")
        for seg in r.bestTranscription.segments {
            print(String(format: "[%.1f-%.1f] %@", seg.timestamp, seg.timestamp + seg.duration, seg.substring))
        }
        print("SEGMENTS_END")
        out.signal()
    }
}
_ = task
let r = out.wait(timeout: .now() + 900)
print("done wait=\(r == .success)")
