#!/usr/bin/env python3
"""把各段素材的中间帧按画布 1:1 拼成对照图：肉眼直接比「同一像素缩放下谁大谁小」。
  python3 scripts/sprite-sheet.py out.png [clip ...]
"""
import os, subprocess, sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANIM = os.path.join(ROOT, 'android/app/src/main/assets/anim')
CW, CH = 420, 465
COLS, SCALE = 6, 0.5


def frame(path):
    W, H = CW, CH
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', path,
                          '-vf', 'format=rgba', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
                         stdout=subprocess.PIPE, check=True).stdout
    fsz = W * H * 4
    n = len(raw) // fsz
    i = n // 2
    return Image.frombytes('RGBA', (W, H), raw[i * fsz:(i + 1) * fsz])


def main():
    out = sys.argv[1]
    want = sys.argv[2:]
    clips = [c for c in sorted(os.listdir(ANIM)) if c.endswith('.webm')]
    if want:
        clips = [c for c in clips if c[:-5] in want]
    tw, th = int(CW * SCALE), int(CH * SCALE)
    rows = (len(clips) + COLS - 1) // COLS
    sheet = Image.new('RGB', (COLS * tw, rows * (th + 16)), (28, 32, 40))
    d = ImageDraw.Draw(sheet)
    for i, c in enumerate(clips):
        im = frame(os.path.join(ANIM, c)).resize((tw, th), Image.LANCZOS)
        # 棋盘底：透明区域和浅色头发分开，方便看真实边缘
        bg = Image.new('RGBA', (tw, th))
        for y in range(0, th, 8):
            for x in range(0, tw, 8):
                v = 60 if ((x // 8 + y // 8) % 2) else 44
                ImageDraw.Draw(bg).rectangle([x, y, x + 7, y + 7], fill=(v, v, v + 6, 255))
        bg.alpha_composite(im)
        cx, cy = (i % COLS) * tw, (i // COLS) * (th + 16)
        sheet.paste(bg.convert('RGB'), (cx, cy))
        d.text((cx + 3, cy + th + 2), c[:-5], fill=(230, 240, 255))
    sheet.save(out)
    print(out, sheet.size)


if __name__ == '__main__':
    main()
