#!/usr/bin/env python3
"""把任意一套新形象包导入 App（可多次追加，不动已有服装）。

用法：
  python3 scripts/import-outfit-pack.py <zip或目录> [选项]

选项：
  --label 中文名      服装显示名（单套包不给就取目录名/文件名）
  --id slug           服装 id（默认由目录名推：只留字母数字，小写）
  --replace           同 id 已存在时覆盖（默认跳过并提示）
  --allow-partial     帧数不足也导入（默认要求 24 帧全齐）
  --dry-run           只检查、不写盘
  --no-key            原图已经是透明背景，跳过绿幕抠像
  --quality 82        WebP 质量

约定（与 build-aster-assets.py 完全一致，换包不会让角色变大变小）：
  - 画布 420×465，角色统一高 407、脚底贴 444、水平居中；
  - 同一套 24 帧共用 union bbox，换姿势不跳位；
  - 产物写 assets/aster/<id>/*.webp，manifest.json 合并后排序。

导入完记得重新生成内联页：node scripts/gen-pet-asset.mjs
"""
import importlib.util
import json
import os
import re
import sys
import zipfile
from io import BytesIO

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "android/app/src/main/assets/aster")
MANIFEST = os.path.join(OUT_DIR, "manifest.json")
CANON = 24

# 复用 build-aster-assets.py 里的抠像/裁切/合成，避免两处画布常数漂移
_spec = importlib.util.spec_from_file_location(
    "aster_builder", os.path.join(ROOT, "scripts/build-aster-assets.py")
)
A = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(A)


def slugify(name):
    s = re.sub(r"[^0-9a-zA-Z]+", "-", name).strip("-").lower()
    return s or "outfit"


def collect(src, no_key):
    """返回 {outfit_key: {frame_name: Image}}；outfit_key 是包内的原始目录名。"""
    packs = {}
    if src.endswith(".zip"):
        base = os.path.splitext(os.path.basename(src))[0]
        with zipfile.ZipFile(src) as z:
            for info in z.infolist():
                if not info.filename.lower().endswith(".png"):
                    continue
                parts = [p for p in info.filename.split("/") if p]
                if not parts:
                    continue
                key = parts[0] if len(parts) > 1 else base
                rel = parts[-1]
                packs.setdefault(key, {})[rel] = Image.open(BytesIO(z.read(info)))
    else:
        base = os.path.basename(os.path.abspath(src))
        for dirpath, _dirs, files in os.walk(src):
            pngs = [f for f in sorted(files) if f.lower().endswith(".png")]
            if not pngs:
                continue
            rel_dir = os.path.relpath(dirpath, src)
            key = base if rel_dir == "." else rel_dir.split(os.sep)[0]
            for f in pngs:
                packs.setdefault(key, {})[f] = Image.open(os.path.join(dirpath, f))
    return {k: v for k, v in packs.items() if v}


def describe(imgs):
    """量一下内容高度/宽度，用来判断换包后角色有没有变大小。"""
    box = A.union_bbox(imgs.values())
    if not box:
        return None
    w, h = box[2] - box[0], box[3] - box[1]
    return w, h


def main(argv):
    if not argv or argv[0].startswith("-"):
        print(__doc__)
        return 2
    src = argv[0]
    opts = {"key": True, "quality": A.WEBP_QUALITY, "dry": False, "replace": False,
            "partial": False, "label": None, "id": None}
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--label":
            opts["label"] = argv[i + 1]; i += 2
        elif a == "--id":
            opts["id"] = argv[i + 1]; i += 2
        elif a == "--quality":
            opts["quality"] = int(argv[i + 1]); i += 2
        elif a == "--replace":
            opts["replace"] = True; i += 1
        elif a == "--allow-partial":
            opts["partial"] = True; i += 1
        elif a == "--dry-run":
            opts["dry"] = True; i += 1
        elif a == "--no-key":
            opts["key"] = False; i += 1
        else:
            print("不认识的参数：%s" % a)
            return 2

    if not os.path.exists(src):
        print("找不到：%s" % src)
        return 2
    packs = collect(src, not opts["key"])
    if not packs:
        print("包里没找到 PNG")
        return 1

    manifest = {"canvas": [A.CANVAS_W, A.CANVAS_H], "outfits": []}
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            manifest = json.load(f)
    by_id = {o["id"]: o for o in manifest.get("outfits", [])}
    # 同一个原稿目录导过就用原 id，别让 01_sailor 又生成一套 01-sailor
    by_source = {o.get("source"): o["id"] for o in manifest.get("outfits", []) if o.get("source")}

    single = len(packs) == 1
    print("发现 %d 套素材" % len(packs))
    added, skipped, failed = [], [], []

    for key, frames in sorted(packs.items()):
        oid = opts["id"] if (single and opts["id"]) else (by_source.get(key) or slugify(key))
        label = opts["label"] if (single and opts["label"]) else None
        if oid in by_id and not opts["replace"]:
            skipped.append("%s（已存在，要覆盖加 --replace）" % oid)
            continue
        label = label or by_id.get(oid, {}).get("label") or key
        if len(frames) < CANON and not opts["partial"]:
            failed.append("%s 只有 %d 帧（要求 %d，确实少就加 --allow-partial）"
                          % (oid, len(frames), CANON))
            continue

        print("\n[%s] %s · %d 帧" % (oid, label, len(frames)))
        keyed = {k: (A.key_green(v) if opts["key"] else v.convert("RGBA"))
                 for k, v in frames.items()}
        wh = describe(keyed)
        if wh:
            print("  内容尺寸 %d×%d（合成后统一 407 高、脚底 444）" % wh)
        box = A.union_bbox(keyed.values())
        if not box:
            failed.append("%s 全透明，抠像后没有内容（换 --no-key 试试）" % oid)
            continue

        names = {}
        for rel, im in keyed.items():
            name = os.path.splitext(os.path.basename(rel))[0]
            names[name] = "aster/%s/%s.webp" % (oid, name)
        if len(names) != len(keyed):
            print("  ! 有重名帧，已按路径去重前的同名文件合并")

        if opts["dry"]:
            print("  dry-run：会写 %d 张到 assets/aster/%s/" % (len(names), oid))
        else:
            outdir = os.path.join(OUT_DIR, oid)
            os.makedirs(outdir, exist_ok=True)
            total = 0
            for rel, im in keyed.items():
                name = os.path.splitext(os.path.basename(rel))[0]
                path = os.path.join(outdir, name + ".webp")
                A.compose(im, box).save(path, "WEBP", quality=opts["quality"], method=6)
                total += os.path.getsize(path)
            print("  写入 %s · %d KB" % (outdir, total // 1024))
        entry = {"id": oid, "label": label, "source": key, "frames": dict(sorted(names.items()))}
        manifest["outfits"] = [o for o in manifest.get("outfits", []) if o["id"] != oid] + [entry]

    if not opts["dry"]:
        manifest["outfits"].sort(key=lambda o: o["id"])
        manifest["canvas"] = [A.CANVAS_W, A.CANVAS_H]
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(MANIFEST, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)

    print("\n服装清单（%d 套）：" % len(manifest.get("outfits", [])))
    for o in manifest.get("outfits", []):
        print("  %-9s %-8s %2d 帧" % (o["id"], o["label"], len(o["frames"])))
    if skipped:
        print("跳过：" + "；".join(skipped))
    if failed:
        print("失败：" + "；".join(failed))
        return 1
    if opts["dry"]:
        print("\n（dry-run，没有写盘）")
    else:
        print("\n下一步：node scripts/gen-pet-asset.mjs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
