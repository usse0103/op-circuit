"""油圧回路設計（hydraulics/circuit）の画面サーバー。

起動:  .venv\\Scripts\\python.exe app.py [ポート番号]     既定は 5010
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from hc import standards, storage
from hc.analysis import DEFAULT_SETTINGS, analyze
from hc.library import default_params, load_library

ROOT = Path(__file__).resolve().parent
app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False
app.config["TEMPLATES_AUTO_RELOAD"] = True


def _asset_version() -> str:
    """static の更新時刻。ブラウザが古いファイルを使い続けないよう URL に付ける。"""
    latest = 0.0
    for p in (ROOT / "static").rglob("*"):
        if p.is_file():
            latest = max(latest, p.stat().st_mtime)
    return str(int(latest))


@app.get("/")
def index():
    return render_template("index.html", v=_asset_version())


@app.get("/api/library")
def api_library():
    lib = load_library()
    types = {}
    for name, t in lib["types"].items():
        item = dict(t)
        item["defaults"] = default_params(t)
        types[name] = item
    return jsonify({
        "categories": lib["categories"],
        "types": types,
        "errors": lib["errors"],
        "standards": standards.standards_payload(),
        "defaultSettings": DEFAULT_SETTINGS,
    })


@app.post("/api/calc")
def api_calc():
    doc = request.get_json(silent=True) or {}
    try:
        return jsonify(analyze(doc, load_library()))
    except Exception as exc:  # 計算の失敗は画面に出して、編集は続けられるようにする
        traceback.print_exc()
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 200


@app.get("/api/circuits")
def api_list():
    return jsonify(storage.list_circuits())


@app.post("/api/circuits")
def api_create():
    doc = request.get_json(silent=True) or {}
    cid = storage.new_id()
    return jsonify(storage.save(cid, doc))


@app.get("/api/circuits/<cid>")
def api_load(cid):
    try:
        doc = storage.load(cid)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if doc is None:
        return jsonify({"error": "回路が見つかりません"}), 404
    return jsonify(doc)


@app.put("/api/circuits/<cid>")
def api_save(cid):
    doc = request.get_json(silent=True)
    if not isinstance(doc, dict):
        return jsonify({"error": "回路データがありません"}), 400
    try:
        return jsonify(storage.save(cid, doc))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/circuits/<cid>/beacon")
def api_beacon(cid):
    """ページを閉じる直前の保存（navigator.sendBeacon は POST しか送れない）。"""
    doc = request.get_json(silent=True, force=True)
    if isinstance(doc, dict) and isinstance(doc.get("components"), list):
        try:
            storage.save(cid, doc)
        except ValueError:
            pass
    return "", 204


@app.delete("/api/circuits/<cid>")
def api_delete(cid):
    try:
        return jsonify({"deleted": storage.delete(cid)})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/api/samples")
def api_samples():
    return jsonify(storage.list_samples())


@app.get("/api/samples/<name>")
def api_sample(name):
    doc = storage.load_sample(name)
    if doc is None:
        return jsonify({"error": "見本が見つかりません"}), 404
    return jsonify(doc)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5010
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
