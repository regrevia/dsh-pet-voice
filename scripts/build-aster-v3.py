#!/usr/bin/env python3
"""把 Aster Studio v3 总包（8 套服装 × 待机/说话/挥手）转成 App 用的透明 WebP 帧。

用法：
  python3 scripts/build-aster-v3.py /tmp/asterv3/Aster_Studio_v3_All_In_One
  python3 scripts/build-aster-v3.py <包根目录> --only 01_sailor 06_researcher
  python3 scripts/build-aster-v3.py <包根目录> --quality 78 --height 380

产物：
  android/app/src/main/assets/aster/v3/<key>/<action>/<NN>.webp
  android/app/src/main/assets/aster/v3/manifest.json

约定（沿用 build-aster-assets.py，换形象时人物不跳位不缩放）：
  - 每套服装的所有动作共用同一个裁切框（union bbox），三套动作之间也共用。
  - 画布 420×465，角色统一高 TARGET_H、脚底 TARGET_BOTTOM、水平居中。
  - 绿幕判定 d = G - max(R,B)，alpha = clip((52-d)/40, 0, 1)，保留 8 级渐变防锯齿。
  - 帧率按包内说明 15fps；idle_blink 45 帧（3s 循环）、talk 15 帧、wave 15 帧。
"""
import argparse
import json
import os
import sys

from PIL import Image
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "android/app/src/main/assets/aster/v3")

CANVAS_W, CANVAS_H = 420, 465
TARGET_H = 407
TARGET_BOTTOM = 444
FPS = 15

# 包内目录 id → App 里的形象 key + 显示名（key 与 Settings.kt 的 OUTFITS 对应）
OUTFITS = [
    ("01_sailor", "sailor", "水手裙"),
    ("02_maid", "maid", "女仆装"),
    ("03_casual", "casual", "鲸鱼卫衣"),
    ("04_winter", "winter", "冬日斗篷"),
    ("05_princess", "princess", "深海公主"),
    ("06_researcher", "researcher", "深海研究员"),
    ("07_witch", "witch", "星潮小魔女"),
    ("08_pajamas", "pajamas", "泡泡睡衣"),
]
ACTIONS = [
    ("idle_blink", "idle"),
    ("talk", "talk"),
    ("wave", "wave"),
]


def key_green(img):
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    d = g - np.maximum(r, b)
    alpha = np.clip((52 - d) / 40.0, 0.0, 1.0)
    g2 = np.minimum(g, np.maximum(r * 0.9, b * 0.9) + 6)
    return Image.fromarray(
        np.dstack([r, g2, b, alpha * 255]).clip(0, 255).astype(np.uint8), "RGBA"
    )


def union_bbox(images):
    box = None
    for im in images:
        a = np.asarray(im.getchannel("A"))
        ys, xs = np.nonzero(a > 8)
        if not len(xs):
            continue
        bb = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        box = bb if box is None else (
            min(box[0], bb[0]), min(box[1], bb[1]),
            max(box[2], bb[2]), max(box[3], bb[3]),
        )
    return box


def compose(im, box, height):
    crop = im.crop(box)
    h = height
    w = max(1, round(crop.width * h / crop.height))
    crop = crop.resize((w, h), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    x = (CANVAS_W - w) // 2
    canvas.alpha_composite(crop, (max(0, x), TARGET_BOTTOM - h))
    return canvas


def load_outfit(pkg, oid):
    out = {}
    for dirname, action in ACTIONS:
        d = os.path.join(pkg, "assets/outfits", oid, "animations", dirname, "sequence")
        if not os.path.isdir(d):
            continue
        files = sorted(f for f in os.listdir(d) if f.endswith(".png"))
        if files:
            out[action] = [Image.open(os.path.join(d, f)) for f in files]
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("package", help="解压后的 Aster_Studio_v3_All_In_One 目录")
    ap.add_argument("--only", nargs="*", default=None, help="只转这几套（包内 id 或 key）")
    ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--height", type=int, default=TARGET_H)
    o = ap.parse_args(argv)

    if not os.path.isdir(o.package):
        print("目录不存在：%s" % o.package)
        return 2
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {
        "version": 3,
        "canvas": [CANVAS_W, CANVAS_H],
        "fps": FPS,
        "outfits": [],
    }
    total_bytes = 0
    for oid, key, label in OUTFITS:
        if o.only and oid not in o.only and key not in o.only:
            continue
        acts = load_outfit(o.package, oid)
        if not acts:
            print("跳过 %s：没有帧" % oid)
            continue
        keyed = {a: [key_green(im) for im in frames] for a, frames in acts.items()}
        box = union_bbox([im for frames in keyed.values() for im in frames])
        entry = {"key": key, "label": label, "actions": {}}
        size = 0
        for action, frames in keyed.items():
            outdir = os.path.join(OUT_DIR, key, action)
            os.makedirs(outdir, exist_ok=True)
            names = []
            for i, im in enumerate(frames):
                name = "%02d.webp" % i
                path = os.path.join(outdir, name)
                compose(im, box, o.height).save(
                    path, "WEBP", quality=o.quality, method=6
                )
                size += os.path.getsize(path)
                names.append(name)
            entry["actions"][action] = names
        total_bytes += size
        print("%-10s %-8s 帧 %-3d 体积 %.1f KB  bbox=%s" % (
            key, label, sum(len(v) for v in entry["actions"].values()),
            size / 1024.0, box))
        manifest["outfits"].append(entry)

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print("合计 %.1f MB → %s" % (total_bytes / 1048576.0, OUT_DIR))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
