#!/usr/bin/env python3
"""离线量视频素材的包围盒，校核/重写引擎里的 NORM（全内容框）与 BODY（人物主体框）两张表。

背景：悬浮窗把 `assets/anim/*.webm` 当解码器用，每帧 drawImage 到 canvas。素材每帧 420x464
（引擎画布 CH=465），但人物在画布里的大小/位置逐段不同。引擎靠两张表把「人物主体」统一成
同一高度、同一脚底基线、同一水平中心，否则换动作时人物会明显变大变小（0.9.28 点一下从
442 px 掉到 368 px 就是这个：旧表把 `startle`/`tap_joy` 量成画布全高 465，真实内容只有 385/379）。

  NORM[clip] = [x, y, w, h]  全内容框（含举起的手/尾巴/气泡特效），当源矩形用，避免裁掉像素
  BODY[clip] = [x, y, w, h]  人物主体框，只用来定缩放和脚底/中心锚点

用法：
  python3 scripts/sprite-norm.py            # 打表 + 与引擎里的两张表对比
  python3 scripts/sprite-norm.py --check    # 门禁用：表与素材对不上、或人物高偏差超阈值就报错
  python3 scripts/sprite-norm.py --write    # 写回 assets/pet/anim-pet.js 的两张表

  --fps N      取样帧率（默认 0 = 原生帧率；抽帧会漏掉「头发丝/星星特效冲出画布」那几帧，
               框就量小了，播到那几帧会硬裁，所以默认不抽帧）
  --tolerance  允许的人物高度偏差比例（默认 0.03）

帧尺寸取 ffprobe 的真实几何（420x464）。别按画布 465 硬编码：行距错一拍，整段并集框都会虚高。

改完 anim-pet.js 记得重跑 `node scripts/gen-pet-asset.mjs`（构建时会自动跑）再打包。
"""
import os
import re
import statistics
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANIM = os.path.join(ROOT, 'android/app/src/main/assets/anim')
ENGINE = os.path.join(ROOT, 'android/app/src/main/assets/pet/anim-pet.js')
ALPHA_TH = 128          # 二值 alpha 阈值（半透明羽边不算人物）
MIN_ROW_PX = 6          # 一行至少这么多不透明像素才算人物（滤掉零星噪点）
BODY_ROW_RATIO = 0.30        # 主体框：行宽 ≥ 该帧最宽行的 30%
UNION_ROW_PX = 2             # 全内容框：该行至少有 2 个不透明像素（头发丝、星星特效也不算漏）
SCALE_MIN, SCALE_MAX = 0.85, 1.30
TARGET_CX, TARGET_BOTTOM = 210, 444   # 与引擎一致：水平中心 / 脚底基线
# 画布外看不见：CW=420 无左右余量；CH=465 居中后上下各约 37 单位余量
VIS_TOP, VIS_BOTTOM = -37, 502


def read_table(src, name):
    """从引擎源码里读出 NORM/BODY 表：{clip: [x, y, w, h]}。"""
    m = re.search(r'const %s = \{(.*?)\n  \}' % name, src, re.S)
    if not m:
        return None, None
    table = {}
    for line in m.group(1).splitlines():
        mm = re.match(r'\s*(\w+):\s*\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]', line)
        if mm:
            table[mm.group(1)] = [int(mm.group(i)) for i in range(2, 6)]
    return table, m


def read_target(src):
    m = re.search(r'const TARGET_H = (\d+)', src)
    return int(m.group(1)) if m else None


def probe_size(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
        stdout=subprocess.PIPE, text=True, check=True).stdout.strip()
    w, h = out.split(',')
    return int(w), int(h)


def measure(path, fps=0):
    """返回该段素材的 (全内容框, 主体框)，框都是 [x, y, w, h]（画布坐标）。

    fps=0 用原生帧率：抽帧会漏掉「头发丝/星星特效冲出画布」那几帧，
    全内容框就会偏小，播到那几帧时人物被硬裁。主体框反正取中位，掉一两帧无所谓。
    """
    W, H = probe_size(path)
    vf = ('fps=%d,' % fps if fps else '') + 'format=rgba'
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', path,
         '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
        stdout=subprocess.PIPE, check=True).stdout
    fsz = W * H * 4
    frames = len(raw) // fsz
    if frames == 0:
        sys.exit('%s 解不出帧' % path)
    if len(raw) % (W * 4):
        # 行距错一拍，后面每帧都会整体错位、并集框虚高（0.9.28 的表就是这么量坏的）
        sys.exit('%s 解码尺寸对不上：%d 字节，按 %dx%d 算不整除' % (path, len(raw), W, H))

    cx0, cy0, cx1, cy1 = W, H, -1, -1
    body_hs, body_bottoms, body_cxs, body_ws = [], [], [], []
    for i in range(frames):
        off = i * fsz
        rows = []
        for y in range(H):
            base = off + y * W * 4
            row = raw[base + 3:base + W * 4:4]
            rows.append([x for x in range(W) if row[x] >= ALPHA_TH])
        counts = [len(xs) for xs in rows]
        ys = [y for y in range(H) if counts[y] >= MIN_ROW_PX]      # 主体/脚底用：够粗的行
        vs = [y for y in range(H) if counts[y] >= UNION_ROW_PX]    # 全内容用：细头发丝也算
        if not ys or not vs:
            continue
        cx0 = min(cx0, min(rows[y][0] for y in vs))
        cy0 = min(cy0, vs[0])
        cx1 = max(cx1, max(rows[y][-1] for y in vs))
        cy1 = max(cy1, vs[-1])
        mx = max(counts)
        body_ys = [y for y in range(H) if counts[y] >= max(MIN_ROW_PX, BODY_ROW_RATIO * mx)]
        xs = [x for y in body_ys for x in rows[y]]
        if not body_ys or not xs:
            continue
        body_hs.append(body_ys[-1] - body_ys[0] + 1)
        body_bottoms.append(body_ys[-1] + 1)
        body_cxs.append((min(xs) + max(xs) + 1) / 2.0)
        body_ws.append(max(xs) - min(xs) + 1)

    if cx1 < 0:
        sys.exit('%s 整段没量到不透明像素' % path)
    bh = int(round(statistics.median(body_hs)))
    bw = int(round(statistics.median(body_ws)))
    bbot = int(round(max(body_bottoms)))          # 脚底取整段最低位置（跳跃段也能落到地面）
    bcx = statistics.median(body_cxs)
    content = [cx0, cy0, cx1 - cx0 + 1, cy1 - cy0 + 1]
    body = [int(round(bcx - bw / 2.0)), bbot - bh, bw, bh]
    return content, body


def draw_rect(content, body, target_h):
    """复算引擎 drawLayer：源矩形取全内容框，缩放取主体高度，落点按内容底边贴地。"""
    scale = min(SCALE_MAX, max(SCALE_MIN, target_h / body[3]))
    bcx = body[0] + body[2] / 2.0
    dx = TARGET_CX + (content[0] - bcx) * scale
    dw, dh = content[2] * scale, content[3] * scale
    dy = TARGET_BOTTOM - dh            # 整段素材最底边贴地（与待机位置一致）
    if dw >= 420:                    # 素材本身就占满画布宽（cheer 那种），左右无可挪
        dx = 0
    elif dx < 0:                     # 引擎会把伸出画布的东西挪回来
        dx = 0
    elif dx > 420 - dw:
        dx = max(0, 420 - dw)
    return scale, dx, dy, dw, dh


def main(argv):
    write = '--write' in argv
    check = '--check' in argv
    fps = 0                        # 0 = 原生帧率
    tol = 0.03
    for i, a in enumerate(argv):
        if a == '--fps':
            fps = int(argv[i + 1])
        elif a == '--tolerance':
            tol = float(argv[i + 1])

    if not os.path.isdir(ANIM):
        sys.exit('找不到素材目录：%s' % ANIM)
    src = open(ENGINE, encoding='utf-8').read()
    target_h = read_target(src)
    if not target_h:
        sys.exit('没在 %s 里找到 TARGET_H' % ENGINE)
    have_norm = read_table(src, 'NORM')[0] or {}
    have_body = read_table(src, 'BODY')[0] or {}

    measured, bad = {}, []
    print('%-13s %-22s %-22s %5s %s' % ('clip', '全内容框[x,y,w,h]', '主体框[x,y,w,h]', '显示高', '结论'))
    for name in sorted(os.listdir(ANIM)):
        if not name.endswith('.webm'):
            continue
        clip = name[:-5]
        content, body = measure(os.path.join(ANIM, name), fps)
        measured[clip] = (content, body)
        scale, dx, dy, dw, dh = draw_rect(content, body, target_h)
        shown = body[3] * scale
        note = []
        if abs(shown / target_h - 1) > tol:
            note.append('人物高 %.0f≠%d' % (shown, target_h))
        for label, got, want in (('NORM', have_norm.get(clip), content),
                                 ('BODY', have_body.get(clip), body)):
            if got is None:
                note.append('%s 缺表项' % label)
            elif any(abs(got[k] - want[k]) > 2 for k in range(4)):
                note.append('%s 表与素材不符' % label)
        too_wide = dw > 420.5   # 素材自己占满画布宽，左右没法挪，不算越界
        if dy < VIS_TOP or dy + dh > VIS_BOTTOM or (not too_wide and (dx < -0.5 or dx + dw > 420.5)):
            note.append('出画布 dy=%.0f..%.0f dx=%.0f..%.0f' % (dy, dy + dh, dx, dx + dw))
        if note:
            bad.append(clip)
        print('%-13s %-22s %-22s %5.0f %s' % (
            clip, ','.join(map(str, content)), ','.join(map(str, body)), shown,
            ' / '.join(note) if note else 'ok'))

    print('\n共 %d 段素材，%d 段需要修；统一人物高度 %d（允许偏差 %.0f%%）'
          % (len(measured), len(bad), target_h, tol * 100))

    if write:
        def text_block(name, pick):
            lines = ['    %s: [%d, %d, %d, %d],' % (c, *pick(measured[c])) for c in sorted(measured)]
            return 'const %s = {\n%s\n  }' % (name, '\n'.join(lines))

        norm_text = text_block('NORM', lambda v: v[0])
        body_text = text_block('BODY', lambda v: v[1])
        out = src
        _, body_m = read_table(src, 'BODY')
        _, norm_m = read_table(src, 'NORM')
        if body_m:
            # 先替换后面的 BODY，再替换前面的 NORM，避免偏移错位
            if body_m.start() > norm_m.start():
                out = out[:body_m.start()] + body_text + out[body_m.end():]
                out = out[:norm_m.start()] + norm_text + out[norm_m.end():]
            else:
                out = out[:norm_m.start()] + norm_text + out[norm_m.end():]
                out = out[:body_m.start()] + body_text + out[body_m.end():]
        else:
            anchor = out.index('\n  const CW = 420')
            comment = ('\n  // 人物主体框 [x, y, w, h]：只用来定缩放和脚底/中心锚点；NORM 是全内容源矩形\n')
            out = out[:anchor] + comment + body_text + out[anchor:]
            out = out[:read_table(out, 'NORM')[1].start()] + norm_text + \
                out[read_table(out, 'NORM')[1].end():]
        open(ENGINE, 'w', encoding='utf-8').write(out)
        print('已写回 %s（记得重跑 node scripts/gen-pet-asset.mjs）' % ENGINE)

    if check and bad:
        print('\n不一致的素材：%s' % ', '.join(bad))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
