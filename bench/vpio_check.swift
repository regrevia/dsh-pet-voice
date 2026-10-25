// 检查 macOS 是否提供 AVAudioEngine 的语音处理（VPIO，内置 AEC/AGC/NS）
import AVFoundation
let e = AVAudioEngine()
let inp = e.inputNode
let hasVPIO = inp.responds(to: Selector(("setVoiceProcessingEnabled:error:")))
var ok = false
if hasVPIO { do { try inp.setVoiceProcessingEnabled(true); ok = true } catch { ok = false } }
let out = e.outputNode
let outVPIO = out.responds(to: Selector(("setVoiceProcessingEnabled:error:")))
print("input_setVoiceProcessingEnabled_available=\(hasVPIO) enabled=\(ok) output_available=\(outVPIO)")
