#!/usr/bin/env bash
# 生成 ASR 基准样音：macOS 本地 TTS（离线），16k 单声道 16bit WAV，和手机录音同格式。
# 样句取自真实使用日志里出现过的句子；口音/远场用「换音色 + 加噪 + 限带」模拟。
set -euo pipefail
cd "$(dirname "$0")"
OUT=samples
mkdir -p "$OUT"

say_wav() { # $1=voice $2=text $3=out
  local tmp
  tmp=$(mktemp -t asrbench).aiff
  say -v "$1" -o "$tmp" "$2"
  ffmpeg -v error -y -i "$tmp" -ar 16000 -ac 1 -c:a pcm_s16le "$3"
  rm -f "$tmp"
}

# 正常句
say_wav Tingting "可以啊。" "$OUT/s1_short_keai.wav"
say_wav Tingting "你在干啥呢？" "$OUT/s2_short_ganma.wav"
say_wav Tingting "新来的人要怎么用呢？" "$OUT/s3_short_xinlairen.wav"
say_wav Tingting "你感觉我们项目下一步要做点什么比较好？" "$OUT/s4_mid_xiayibu.wav"
say_wav Tingting "你不要动了，我只是问你了解一下项目的情况。" "$OUT/s5_mid_xiangmu.wav"
say_wav Tingting "我们现在的配置方式简单吧？如果是局域网，能够扫码直接用吗？" "$OUT/s6_long_peizhi.wav"
# 台湾腔（Meijia，真实不同的普通话变体）
say_wav Meijia "把那个文件传到服务器上，然后告诉我结果。" "$OUT/s7_mid_chuanwenjian.wav"

# 噪声底（粉噪，做远场/弱麦模拟）
ffmpeg -v error -y -f lavfi -i "anoisesrc=d=30:c=pink:a=0.02" -t 30 "$OUT/.tmp_noise.wav"

# 口音 + 电话带宽（300–3400Hz）+ 噪声：台湾腔念同一句
say_wav Meijia "你感觉我们项目下一步要做点什么比较好？" "$OUT/.tmp_s8.wav"
ffmpeg -v error -y -i "$OUT/.tmp_s8.wav" -af "highpass=f=300,lowpass=f=3400" "$OUT/.tmp_s8b.wav"
ffmpeg -v error -y -i "$OUT/.tmp_s8b.wav" -i "$OUT/.tmp_noise.wav" -filter_complex "[1:a]volume=0.07[n];[0:a][n]amix=inputs=2:duration=first:weights=1 1,aresample=16000" "$OUT/s8_mid_kouyin.wav"

# 远场 + 降调（asetrate 降 12% → 近似另一个说话人）+ 噪声
say_wav Tingting "你不要动了，我只是问你了解一下项目的情况。" "$OUT/.tmp_s9.wav"
ffmpeg -v error -y -i "$OUT/.tmp_s9.wav" -af "asetrate=16000*0.88,aresample=16000,atempo=1.136" "$OUT/.tmp_s9b.wav"
ffmpeg -v error -y -i "$OUT/.tmp_s9b.wav" -i "$OUT/.tmp_noise.wav" -filter_complex "[1:a]volume=0.05[n];[0:a][n]amix=inputs=2:duration=first:weights=1 1,aresample=16000" "$OUT/s9_mid_yuanchang.wav"

rm -f "$OUT"/.tmp_*

# 参考文本（打分用；标点不计入 CER）
cat > "$OUT/refs.json" <<'JSON'
{
  "s1_short_keai.wav": "可以啊",
  "s2_short_ganma.wav": "你在干啥呢",
  "s3_short_xinlairen.wav": "新来的人要怎么用呢",
  "s4_mid_xiayibu.wav": "你感觉我们项目下一步要做点什么比较好",
  "s5_mid_xiangmu.wav": "你不要动了，我只是问你了解一下项目的情况",
  "s6_long_peizhi.wav": "我们现在的配置方式简单吧？如果是局域网，能够扫码直接用吗",
  "s7_mid_chuanwenjian.wav": "把那个文件传到服务器上，然后告诉我结果",
  "s8_mid_kouyin.wav": "你感觉我们项目下一步要做点什么比较好",
  "s9_mid_yuanchang.wav": "你不要动了，我只是问你了解一下项目的情况"
}
JSON

for f in "$OUT"/*.wav; do
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  printf "%-28s %ss\n" "$(basename "$f")" "$d"
done
