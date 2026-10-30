"""仕様（図番ごとの入力内容）を JSON ファイルで保存・読み込みする"""
import json
import re
from datetime import datetime
from pathlib import Path

from hd.params import DEFAULTS

SPEC_DIR = Path(__file__).resolve().parent.parent / "data" / "cylinders"
DRAWING_NUMBER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")

INFO_FIELDS = [
    # (キー, 表示名)
    ("drawing_number", "図番"),
    ("name", "名称"),
    ("material", "材質"),
    ("author", "作成者"),
]


def new_spec():
    return {
        "drawing_number": "",
        "name": "油圧シリンダー",
        "material": "STKM13C",
        "author": "",
        "params": dict(DEFAULTS),
    }


def _path(drawing_number):
    if not DRAWING_NUMBER.match(drawing_number or ""):
        raise ValueError("図番は英数字と - _ . で入力してください")
    return SPEC_DIR / f"{drawing_number}.json"


def load(drawing_number):
    path = _path(drawing_number)
    if not path.exists():
        return None
    spec = new_spec()
    spec.update(json.loads(path.read_text(encoding="utf-8")))
    spec["params"] = {**DEFAULTS, **spec["params"]}
    return spec


def save(spec):
    path = _path(spec["drawing_number"])
    path.parent.mkdir(parents=True, exist_ok=True)
    spec = {**spec, "updated": datetime.now().isoformat(timespec="seconds")}
    path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")


def list_all():
    if not SPEC_DIR.exists():
        return []
    specs = [json.loads(p.read_text(encoding="utf-8")) for p in SPEC_DIR.glob("*.json")]
    return sorted(specs, key=lambda s: s.get("updated", ""), reverse=True)
