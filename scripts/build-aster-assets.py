#!/usr/bin/env python3
"""把绿幕原稿（Aster 五套服装 × 24 张 PNG）转成 App 用的透明 WebP 帧。

用法：
  python3 scripts/build-aster-assets.py /tmp/aster          # 已解压目录
  python3 scripts/build-aster-assets.py --zip <file.zip>     # 直接从 zip 读

产物：android/app/src/main/assets/aster/<outfit>/<name>.webp
      android/app/src/main/assets/aster/manifest.json

约定：
  - 每套 24 帧共用同一个裁切框（union bbox），保证换姿势时人物不跳位、不缩放。
  - 画布统一 420×465（与 dsh-pet 的 webm 帧同尺寸），脚底对齐底部留 6px。
  - 绿幕用「G 明显高于 R/B」判定，带去溢色，边缘保留 8 级渐变，避免锯齿和白边。
"""
import json
import os
import sys
import zipfile
from io import BytesIO

from PIL import Image
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "android/app/src/main/assets/aster")

OUTFITS = [
    ("01_sailor", "sailor", "水手裙"),
    ("02_maid", "maid", "女仆装"),
    ("03_casual", "casual", "鲸鱼卫衣"),
    ("04_winter", "winter", "冬日斗篷"),
    ("05_princess", "princess", "深海公主"),
]
CANVAS_W, CANVAS_H = 420, 465
# 与 anim-pet.js 里视频素材的归一化常数一致：角色统一高 407、脚底 444、水平中心 210。
# 换形象时人物不会突然变大变小（视频素材和立绘共用同一块画布坐标）。
TARGET_H = 407
TARGET_BOTTOM = 444
WEBP_QUALITY = 82


def key_green(img: Image.Image) -> Image.Image:
    """绿幕转透明 + 去溢色。img 为 RGB。"""
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    d = g - np.maximum(r, b)
    alpha = np.clip((52 - d) / 40.0, 0.0, 1.0)  # d<=12 全透明，d>=52 全不透明
    g2 = np.minimum(g, np.maximum(r * 0.9, b * 0.9) + 6)  # 溢色：G 不许高过 R/B
    return Image.fromarray(
        np.dstack([r, g2, b, alpha * 255]).clip(0, 255).astype(np.uint8), "RGBA"
    )


def union_bbox(frames):
    box = None
    for im in frames:
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


def compose(im: Image.Image, box) -> Image.Image:
    crop = im.crop(box)
    h = TARGET_H
    w = max(1, round(crop.width * h / crop.height))
    crop = crop.resize((w, h), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    x = (CANVAS_W - w) // 2
    canvas.alpha_composite(crop, (max(0, x), TARGET_BOTTOM - h))
    return canvas


def load_frames(src):
    """返回 {outfit_id: {rel_name: Image}}，src 是目录或 zip 路径。"""
    out = {}
    if src.endswith(".zip"):
        with zipfile.ZipFile(src) as z:
            for name in z.namelist():
                if not name.endswith(".png") or "/" not in name:
                    continue
                oid = name.split("/")[0]
                if not oid.startswith("0"):
                    continue
                out.setdefault(oid, {})[name.split("/", 1)[1]] = Image.open(
                    BytesIO(z.read(name))
                )
    else:
        for entry in sorted(os.listdir(src)):
            d = os.path.join(src, entry)
            if not (entry.startswith("0") and os.path.isdir(d)):
                continue
            for sub in ("base", "poses", "shots"):
                sd = os.path.join(d, sub)
                if not os.path.isdir(sd):
                    continue
                for f in sorted(os.listdir(sd)):
                    if f.endswith(".png"):
                        out.setdefault(entry, {})[f"{sub}/{f}"] = Image.open(
                            os.path.join(sd, f)
                        )
    return out


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    src = argv[0]
    if src == "--zip":
        src = argv[1]
    data = load_frames(src)
    if not data:
        print("没找到素材 PNG")
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = {"canvas": [CANVAS_W, CANVAS_H], "outfits": []}
    total = 0
    for oid, short, label in OUTFITS:
        frames = data.get(oid)
        if not frames:
            print(f"跳过 {oid}：没有帧")
            continue
        keyed = {k: key_green(v) for k, v in frames.items()}
        box = union_bbox(keyed.values())
        outdir = os.path.join(OUT_DIR, short)
        os.makedirs(outdir, exist_ok=True)
        names = {}
        for rel, im in keyed.items():
            name = os.path.splitext(os.path.basename(rel))[0]
            path = os.path.join(outdir, name + ".webp")
            compose(im, box).save(path, "WEBP", quality=WEBP_QUALITY, method=6)
            total += os.path.getsize(path)
            names[name] = f"aster/{short}/{name}.webp"
        manifest["outfits"].append(
            {"id": short, "label": label, "source": oid, "frames": names}
        )
        print(f"{short}: {len(names)} 帧 · {sum(os.path.getsize(os.path.join(outdir, i+'.webp')) for i in names)//1024} KB")

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f"合计 {total//1024} KB → {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
