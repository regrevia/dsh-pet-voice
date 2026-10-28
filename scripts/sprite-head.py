#!/usr/bin/env python3
"""按「头部宽度」定每段素材的缩放：星星/气泡/举高的手都不该把人物挤小。

主体框(BODY)高度会被蹲姿和头顶特效影响，直接用它会「蹲下被放大 17%」或者
「星星占了空间人就变小」。头部宽度对蹲/举臂/歪头几乎不敏感，是更稳的视觉尺子。

  python3 scripts/sprite-head.py            # 打表：每段头部宽度、相对待机的缩放
  python3 scripts/sprite-head.py --write    # 写回 anim-pet.js 的 SIZE 表
"""
import os, statistics, subprocess, sys, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANIM = os.path.join(ROOT, 'android/app/src/main/assets/anim')
ENGINE = os.path.join(ROOT, 'android/app/src/main/assets/pet/anim-pet.js')
ALPHA_TH, MIN_ROW_PX, BODY_ROW_RATIO = 128, 6, 0.30
HEAD_BAND = 0.20        # 主体框顶部 20% 当作头部区
TARGET_HEAD_W = None    # 由 idle 决定
SCALE_MIN, SCALE_MAX = 0.85, 1.30


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                          '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
                         stdout=subprocess.PIPE, text=True, check=True).stdout.strip()
    w, h = out.split(',')
    return int(w), int(h)


def head_width(path):
    W, H = probe(path)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', path,
                          '-vf', 'format=rgba', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
                         stdout=subprocess.PIPE, check=True).stdout
    fsz = W * H * 4
    frames = len(raw) // fsz
    ws = []
    for i in range(frames):
        off = i * fsz
        counts, xs_min, xs_max = [], [], []
        rows = []
        for y in range(H):
            base = off + y * W * 4
            row = raw[base + 3:base + W * 4:4]
            xs = [x for x in range(W) if row[x] >= ALPHA_TH]
            rows.append(xs)
            counts.append(len(xs))
        ys = [y for y in range(H) if counts[y] >= MIN_ROW_PX]
        if not ys:
            continue
        mx = max(counts)
        body_ys = [y for y in range(H) if counts[y] >= max(MIN_ROW_PX, BODY_ROW_RATIO * mx)]
        if not body_ys:
            continue
        band = body_ys[:max(2, int(len(body_ys) * HEAD_BAND))]
        allx = [x for y in band for x in rows[y]]
        if allx:
            ws.append(max(allx) - min(allx) + 1)
    if not ws:
        sys.exit('%s 量不到头部' % path)
    return statistics.median(ws)


def main():
    write = '--write' in sys.argv
    src = open(ENGINE, encoding='utf-8').read()
    m = re.search(r'const TARGET_HEAD_W = (\d+)', src)
    head = {}
    for name in sorted(os.listdir(ANIM)):
        if name.endswith('.webm'):
            head[name[:-5]] = head_width(os.path.join(ANIM, name))
    ref = head['idle']
    print('%-13s %8s %8s' % ('clip', '头宽', '缩放'))
    lines = []
    for c in sorted(head):
        s = max(SCALE_MIN, min(SCALE_MAX, ref / head[c]))
        lines.append('    %s: [%d, %.3f],' % (c, round(head[c]), s))
        print('%-13s %8.0f %8.3f' % (c, head[c], s))
    block = 'const SIZE = {\n%s\n  }' % '\n'.join(lines)
    if write:
        if re.search(r'const SIZE = \{.*?\n  \}', src, re.S):
            src = re.sub(r'const SIZE = \{.*?\n  \}', block, src, flags=re.S)
        else:
            src = src.replace('  const CW = 420, CH = 465', block + '\n  const CW = 420, CH = 465', 1)
        src = src.replace('const TARGET_HEAD_W = %s' % (m.group(1) if m else '0'),
                          'const TARGET_HEAD_W = %d' % round(ref))
        open(ENGINE, 'w', encoding='utf-8').write(src)
        print('\n已写回 SIZE 表与 TARGET_HEAD_W=%d' % round(ref))
    else:
        print('\nTARGET_HEAD_W = %d（idle）' % round(ref))


if __name__ == '__main__':
    main()
