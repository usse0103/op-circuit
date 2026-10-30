"""油圧シリンダーの仕様入力画面

    .venv\\Scripts\\python app.py  →  http://127.0.0.1:5000
"""
import secrets
import time
from pathlib import Path

from flask import Flask, abort, flash, redirect, render_template, request, send_from_directory, url_for

from hd import dxf_finish, freecad_client, specs
from hd.params import CYLINDER_FIELDS, normalize, overall_length, validate

ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output"
PARTS_SUBDIR = "parts"  # 部品図の出力先（output/<図番>/parts/）

app = Flask(__name__)
app.secret_key = secrets.token_hex(16)


def _spec_from_form(form):
    spec = {key: form.get(key, "").strip() for key, _ in specs.INFO_FIELDS}
    params, errors = {}, []
    for key, label, _ in CYLINDER_FIELDS:
        try:
            params[key] = float(form.get(key, ""))
        except ValueError:
            errors.append(f"{label}に数値を入力してください")
    if not errors:
        params = normalize(params)
        errors = validate(params)
    spec["params"] = params
    return spec, errors


def _output_files(drawing_number):
    folder = OUTPUT_DIR / drawing_number
    if not drawing_number or not folder.is_dir():
        return []
    # FreeCAD が保存のたびに作るバックアップ（.FCBak）は出さない
    files = sorted(p.name for p in folder.iterdir()
                   if p.is_file() and p.suffix.lower() in (".dxf", ".pdf", ".fcstd"))
    parts = folder / PARTS_SUBDIR
    if parts.is_dir():
        files += sorted(f"{PARTS_SUBDIR}/{p.name}" for p in parts.iterdir()
                        if p.is_file() and p.suffix.lower() in (".dxf", ".csv", ".png"))
    return files


@app.get("/")
def index():
    drawing_number = request.args.get("dn", "")
    spec = (specs.load(drawing_number) if drawing_number else None) or specs.new_spec()
    return render_template(
        "index.html",
        spec=spec,
        saved=specs.list_all(),
        info_fields=specs.INFO_FIELDS,
        cylinder_fields=CYLINDER_FIELDS,
        overall=overall_length(normalize(spec["params"])),
        files=_output_files(spec["drawing_number"]),
        freecad=freecad_client.ping(),
    )


@app.post("/")
def submit():
    spec, errors = _spec_from_form(request.form)
    if not specs.DRAWING_NUMBER.match(spec["drawing_number"]):
        errors.insert(0, "図番は英数字と - _ . で入力してください")
    if errors:
        for error in errors:
            flash(error, "error")
        # 入力し直しやすいよう、入力した値のまま画面を出す
        return render_template(
            "index.html", spec={**spec, "params": {**request.form}}, saved=specs.list_all(),
            info_fields=specs.INFO_FIELDS, cylinder_fields=CYLINDER_FIELDS, overall=None,
            files=_output_files(spec["drawing_number"]), freecad=freecad_client.ping()), 400

    specs.save(spec)
    action = request.form.get("action")
    info = {key: spec[key] for key, _ in specs.INFO_FIELDS}
    try:
        if action == "build":
            result = freecad_client.build_cylinder(spec["params"], info)
            flash(f"3D モデルを更新しました（全長 {result['overall_length']:g} mm、"
                  f"重量 約 {result['weight_kg']:g} kg）", "ok")
        elif action == "drawing":
            out_dir = OUTPUT_DIR / spec["drawing_number"]
            # 部品図は FreeCAD の画面なしで作れるので先に出す（組立図が失敗しても残る）
            parts = freecad_client.make_part_drawings(spec["params"], info, out_dir / PARTS_SUBDIR)
            flash(f"部品図を {parts['count']} 枚出力しました（{PARTS_SUBDIR}/）", "ok")
            result = freecad_client.make_drawing(spec["params"], info, str(out_dir))
            dxf = result["files"]["dxf"]
            dxf_finish.finish(dxf, {
                **info,
                "scale": result["scale"],
                "weight": f"{result['weight_kg']:g} kg",
                "date": time.strftime("%Y/%m/%d"),
            })
            dxf_finish.to_pdf(dxf, str(Path(dxf).with_suffix(".pdf")))
            flash(f"組立図を出力しました（尺度 {result['scale']}）", "ok")
        else:
            flash("保存しました", "ok")
    except freecad_client.FreeCADError as exc:
        flash(f"保存しましたが、FreeCAD の処理に失敗しました：{exc}", "error")
    return redirect(url_for("index", dn=spec["drawing_number"]))


@app.get("/output/<drawing_number>/<path:filename>")
def output_file(drawing_number, filename):
    if not specs.DRAWING_NUMBER.match(drawing_number):
        abort(404)
    return send_from_directory(OUTPUT_DIR / drawing_number, filename, as_attachment=True)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
