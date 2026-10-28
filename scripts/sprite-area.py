#!/usr/bin/env python3
"""按「人物本体不透明面积」估缩放：姿势会变、但同一角色的像素面积差不多，
星星/问号/气泡这些分离特效不计入连通面积。面积比 → 线性尺寸比取平方根。

  python3 scripts/sprite-area.py            # 打表：面积、sqrt 比、需要的缩放
"""
import os, statistics, subprocess, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANIM = os.path.join(ROOT, 'android/app/src/main/assets/anim')
SC, ALPHA_TH = 4, 128
CW, CH = 420, 465


def frames(path):
    W, H = CW // SC, CH // SC
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', path,
                          '-vf', 'scale=%d:%d,format=rgba' % (W, H),
                          '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
                         stdout=subprocess.PIPE, check=True).stdout
    fsz = W * H * 4
    return W, H, [raw[i * fsz:(i + 1) * fsz] for i in range(len(raw) // fsz)]


def largest_area(a):
    H, W = a.shape
    m = a >= ALPHA_TH
    seen = np.zeros((H, W), bool)
    best = 0
    for sy in range(H):
        row = m[sy]
        for sx in range(W):
            if not row[sx] or seen[sy, sx]:
                continue
            stack = [(sy, sx)]
            seen[sy, sx] = True
            n = 0
            while stack:
                y, x = stack.pop()
                n += 1
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and m[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if n > best:
                best = n
    return best


def main():
    out = {}
    for name in sorted(os.listdir(ANIM)):
        if not name.endswith('.webm'):
            continue
        W, H, fr = frames(os.path.join(ANIM, name))
        areas = []
        for f in fr:
            a = np.frombuffer(f, dtype=np.uint8).reshape(H, W, 4)[:, :, 3]
            n = largest_area(a)
            if n > 50:
                areas.append(n)
        out[name[:-5]] = statistics.median(areas)
    ref = out['idle']
    print('%-13s %8s %8s %8s' % ('clip', '面积', '√比', '建议缩放'))
    for c in sorted(out):
        r = (ref / out[c]) ** 0.5
        print('%-13s %8.0f %8.3f %9.3f' % (c, out[c], r, r))


if __name__ == '__main__':
    main()
