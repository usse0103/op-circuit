"""部品図（部品ごとの第三角法投影図 DXF）と部品表を出力する。freecadcmd で実行する

    set HD_JOB=<依頼内容の JSON ファイル>
    freecadcmd.exe hd_parts_job.py

依頼 JSON: {"params": {...}, "info": {...}, "out_dir": "...", "fc2d_dir": "..."}
出力: <out_dir>/<図番>-<部品番号>_<名称>.dxf、overview.png、部品表.csv
結果は標準出力に「HD_RESULT {...}」の 1 行で返す。
寸法・注記は入れない（CAD 側で追記する前提）。
"""
import csv
import json
import os
import sys

FREECAD_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(FREECAD_DIR)

job = json.load(open(os.environ["HD_JOB"], encoding="utf-8"))
for path in (FREECAD_DIR, PROJECT_DIR, job["fc2d_dir"]):
    if path not in sys.path:
        sys.path.insert(0, path)

import fc2d
import hd_parts
from hd.params import normalize, validate

p = normalize(job["params"])
errors = validate(p)
if errors:
    raise ValueError(" / ".join(errors))

info = job["info"]
dn = info.get("drawing_number") or "cylinder"
out_dir = job["out_dir"]
os.makedirs(out_dir, exist_ok=True)
for name in os.listdir(out_dir):  # 部品構成が変わっても古いファイルが残らないように
    if name.lower().endswith((".dxf", ".png", ".csv")):
        os.remove(os.path.join(out_dir, name))

rows, sheets, files = [], [], []
for obj_name, no, label, qty, material, views, _ in hd_parts.PARTS:
    shape = hd_parts.part_shape(p, obj_name)
    if not shape.isValid():
        raise RuntimeError(f"{label}の形状が不正です")
    placed = fc2d.layout(shape, views)
    filename = f"{dn}-{no}_{label}.dxf"
    fc2d.write_dxf(os.path.join(out_dir, filename), placed)
    files.append(filename)
    sheets.append((f"{dn}-{no} {label} ×{qty}", placed))
    rows.append([f"{dn}-{no}", label, material or info.get("material", ""), qty, filename])

fc2d.save_overview(os.path.join(out_dir, "overview.png"), sheets)
with open(os.path.join(out_dir, "部品表.csv"), "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow(["部品図番", "名称", "材質", "個数", "ファイル"])
    w.writerows(rows)

print("HD_RESULT " + json.dumps({"files": files, "count": len(files)}, ensure_ascii=True))
