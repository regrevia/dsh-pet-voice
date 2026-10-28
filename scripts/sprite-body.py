#!/usr/bin/env python3
"""量每段素材「人物本体」的高度/脚底/中心：只取最大连通轮廓，星星/气泡/碎发这些
分离的特效块不算——按整框归一化会让头顶有星星的那几段把人物挤小。

  python3 scripts/sprite-body.py          # 打表：本体高、脚底、中心、相对待机需要的缩放
"""
import os, statistics, subprocess, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANIM = os.path.join(ROOT, 'android/app/src/main/assets/anim')
SC, ALPHA_TH = 4, 128            # 1/4 降采样再连通，误差 ±4 画布像素
CW, CH = 420, 465


def decode(path):
    W, H = CW // SC, CH // SC
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', path,
                          '-vf', 'scale=%d:%d,format=rgba' % (W, H),
                          '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
                         stdout=subprocess.PIPE, check=True).stdout
    fsz = W * H * 4
    return W, H, [raw[i * fsz:(i + 1) * fsz] for i in range(len(raw) // fsz)]


def largest(mask):
    """最大连通块（4 邻域 BFS），返回它的 (y0, y1, x0, x1)。"""
    H, W = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    best = None
    for sy in range(H):
        for sx in range(W):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            stack = [(sy, sx)]
            seen[sy, sx] = True
            y0 = y1 = sy
            x0 = x1 = sx
            n = 0
            while stack:
                y, x = stack.pop()
                n += 1
                if y < y0: y0 = y
                if y > y1: y1 = y
                if x < x0: x0 = x
                if x > x1: x1 = x
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if best is None or n > best[0]:
                best = (n, y0, y1, x0, x1)
    return best


def measure(path):
    W, H, frames = decode(path)
    hs, bots, cxs, tops = [], [], [], []
    for f in frames:
        a = np.frombuffer(f, dtype=np.uint8).reshape(H, W, 4)[:, :, 3]
        r = largest(a >= ALPHA_TH)
        if not r:
            continue
        _, y0, y1, x0, x1 = r
        hs.append((y1 - y0 + 1) * SC)
        bots.append((y1 + 1) * SC)
        tops.append(y0 * SC)
        cxs.append((x0 + x1 + 1) / 2.0 * SC)
    if not hs:
        sys.exit('%s 量不到人物' % path)
    return (int(statistics.median(hs)), int(max(bots)),
            statistics.median(cxs), int(min(tops)))


def main():
    print('%-13s %6s %6s %6s %6s %7s' % ('clip', '本体高', '脚底', '中心', '头顶', '相对idle'))
    out = {}
    for name in sorted(os.listdir(ANIM)):
        if name.endswith('.webm'):
            out[name[:-5]] = measure(os.path.join(ANIM, name))
    ref = out['idle'][0]
    for c in sorted(out):
        h, bot, cx, top = out[c]
        print('%-13s %6d %6d %6.0f %6d %7.3f' % (c, h, bot, cx, top, ref / h))


if __name__ == '__main__':
    main()
