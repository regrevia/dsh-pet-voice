#!/usr/bin/env python3
"""量一段屏幕录像里「桌宠有没有在动」——动效回归用，不靠肉眼。

用法：
  python3 scripts/measure-anim.py 录像.mp4              # 全屏
  python3 scripts/measure-anim.py 录像.mp4 --crop 420x465+620+1140
  python3 scripts/measure-anim.py 录像.mp4 --fps 20 --static 0.25

输出：
  帧间变化中位数（%）、最长静止（秒）、 froze 区间数
判据（经验值，0.9.x 基线）：中位数 ≥ 3%、最长静止 ≤ 0.60s 视为「看不出卡住」。
"""
import os
import shutil
import subprocess
import sys
import tempfile

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit("需要 numpy 和 Pillow（用 load_workspace_dependencies 里的 Python）")

STATIC_EPS = 0.4  # 前后两帧有变化的像素占比低于这个数，算「没动」


def parse(argv):
    opts = {"crop": None, "fps": 10, "static": 0.6, "video": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--crop":
            opts["crop"] = argv[i + 1]; i += 2
        elif a == "--fps":
            opts["fps"] = int(argv[i + 1]); i += 2
        elif a == "--static":
            opts["static"] = float(argv[i + 1]); i += 2
        else:
            opts["video"] = a; i += 1
    return opts


def crop_expr(crop):
    """`WxH+X+Y` → `w:h:x:y`；新版 ffmpeg 不再认 `WxH+X+Y` 写法（会报 Invalid chars）。"""
    import re

    m = re.match(r"^(\d+)x(\d+)\+(\d+)\+(\d+)$", crop)
    if m:
        w, h, x, y = m.groups()
        return "%s:%s:%s:%s" % (w, h, x, y)
    return crop


def frames(video, fps, crop, outdir):
    vf = "fps=%d" % fps
    if crop:
        vf += ",crop=" + crop_expr(crop)
    cmd = ["ffmpeg", "-v", "error", "-i", video, "-vf", vf, os.path.join(outdir, "%04d.png")]
    subprocess.run(cmd, check=True)
    return sorted(f for f in os.listdir(outdir) if f.endswith(".png"))


def main(argv):
    o = parse(argv)
    if not o["video"] or not os.path.exists(o["video"]):
        print(__doc__)
        return 2
    tmp = tempfile.mkdtemp(prefix="anim-")
    try:
        names = frames(o["video"], o["fps"], o["crop"], tmp)
        if len(names) < 3:
            print("帧数太少（%d），录像太短" % len(names))
            return 1
        prev = None
        deltas = []
        for n in names:
            arr = np.asarray(Image.open(os.path.join(tmp, n)).convert("L"), dtype=np.int16)
            if prev is not None:
                diff = np.abs(arr - prev)
                deltas.append(100.0 * float((diff > 6).mean()))
            prev = arr
        run = best = 0
        freezes = 0
        for d in deltas:
            if d < STATIC_EPS:
                run += 1
                best = max(best, run)
            else:
                if run:
                    freezes += 1
                run = 0
        if run:
            freezes += 1
        med = float(np.median(deltas))
        longest = best / o["fps"]
        fps_note = ""
        if med < 3.0 or longest > o["static"]:
            fps_note = " ← 不达标"
        print("帧数 %d / %.1f fps / 时长 %.2fs" % (len(names), o["fps"], len(names) / o["fps"]))
        print("帧间变化中位数 %.2f%%（最大 %.2f%%）" % (med, max(deltas)))
        print("最长静止 %.2fs / 静止区间 %d 处（阈值 %.1f%% 变化）"
              % (longest, freezes, STATIC_EPS))
        print("判定：%s%s" % ("通过" if not fps_note else "不通过", fps_note))
        return 0 if not fps_note else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
