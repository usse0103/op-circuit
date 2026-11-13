"""機器ライブラリ（library/*.json）の読み込み。

機器を足すときは library/ に JSON を足す（または既存のファイルに追記する）。
1 つの機器の定義:
  type     … 機器の種類の名前（回路データに保存される）
  name/en  … 表示名
  jis      … 図記号の根拠（JIS B 0125 の表番号など）
  tag      … 機器番号の接頭辞（P1, SV2 …）
  model    … 計算モデルの名前（hc/models.py の @model）
  symbol   … 図記号の名前（static/js/symbols.js の登録名）
  ports    … ポート名
  states   … 工程ごとに切り換える状態（電磁弁の位置など）
  params   … 右ペインに出すパラメータ
  spec     … 機器表の仕様欄の書式。{キー} がパラメータの値に置き換わる
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parent.parent / "library"

COMMON_PARAMS = [
    {"key": "model_code", "label": "形式", "type": "text", "default": "", "group": "機器表"},
    {"key": "maker", "label": "メーカー", "type": "text", "default": "", "group": "機器表"},
    {"key": "note", "label": "備考", "type": "text", "default": "", "group": "機器表"},
]

JUNCTION = {
    "type": "junction", "name": "分岐点", "en": "Junction", "jis": "JIS B 0125 表 1 点（管路の接続）",
    "tag": "", "model": "junction", "symbol": "junction", "ports": ["J"], "params": [],
    "hidden": True, "bom": False, "category": "_internal",
}

_cache: dict | None = None
_cache_stamp: float = -1.0


def _stamp() -> float:
    return max((p.stat().st_mtime for p in LIB_DIR.glob("*.json")), default=0.0)


def load_library(force: bool = False) -> dict:
    """ライブラリを読む。JSON が更新されていれば読み直す。"""
    global _cache, _cache_stamp
    stamp = _stamp()
    if _cache is not None and not force and stamp == _cache_stamp:
        return _cache
    categories, types, errors = [], {}, []
    for path in sorted(LIB_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{path.name}: {exc}")
            continue
        cat = data.get("category") or {"id": path.stem, "name": path.stem, "order": 999}
        categories.append(cat)
        for comp in data.get("components", []):
            if "type" not in comp:
                errors.append(f"{path.name}: type のない機器があります")
                continue
            comp = copy.deepcopy(comp)
            comp["category"] = cat["id"]
            comp.setdefault("params", [])
            comp.setdefault("ports", [])
            comp.setdefault("model", "none")
            comp.setdefault("symbol", comp["type"])
            if comp.get("bom", True):
                comp["params"] = comp["params"] + copy.deepcopy(COMMON_PARAMS)
            types[comp["type"]] = comp
    types["junction"] = copy.deepcopy(JUNCTION)
    categories.sort(key=lambda c: c.get("order", 999))
    _cache = {"categories": categories, "types": types, "errors": errors}
    _cache_stamp = stamp
    return _cache


def default_params(type_def: dict) -> dict:
    return {p["key"]: copy.deepcopy(p.get("default")) for p in type_def.get("params", [])}


def with_defaults(comp: dict, lib: dict) -> dict | None:
    """パラメータの抜けを既定値で埋めた機器を返す。知らない種類は None。"""
    type_def = lib["types"].get(comp.get("type"))
    if type_def is None:
        return None
    out = dict(comp)
    params = default_params(type_def)
    params.update(comp.get("params") or {})
    out["params"] = params
    return out
