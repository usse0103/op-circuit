"""回路データの保存と読み込み。1 回路 = data/circuits/<id>.json。"""
from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data" / "circuits"
TRASH_DIR = ROOT / "data" / "trash"
SAMPLE_DIR = ROOT / "samples"

_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


def _path(circuit_id: str) -> Path:
    if not _ID_RE.match(circuit_id or ""):
        raise ValueError("回路 ID が不正です")
    return DATA_DIR / f"{circuit_id}.json"


def new_id() -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    base = time.strftime("c%Y%m%d-%H%M%S")
    cid, n = base, 1
    while (DATA_DIR / f"{cid}.json").exists():
        n += 1
        cid = f"{base}-{n}"
    return cid


def _summary(path: Path) -> dict:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        meta = doc.get("meta") or {}
    except (OSError, json.JSONDecodeError):
        meta = {}
    return {
        "id": path.stem,
        "title": meta.get("title") or "（無題）",
        "drawingNo": meta.get("drawingNo") or "",
        "project": meta.get("project") or "",
        "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(path.stat().st_mtime)),
        "mtime": path.stat().st_mtime,
    }


def list_circuits() -> list[dict]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    items = [_summary(p) for p in DATA_DIR.glob("*.json")]
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items


def load(circuit_id: str) -> dict | None:
    path = _path(circuit_id)
    if not path.exists():
        return None
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["id"] = circuit_id
    return doc


def save(circuit_id: str, doc: dict) -> dict:
    """上書き保存する。書きかけで壊れないよう、一時ファイルに書いてから置き換える。"""
    path = _path(circuit_id)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    doc = dict(doc)
    doc["id"] = circuit_id
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)
    return _summary(path)


def delete(circuit_id: str) -> bool:
    """削除は data/trash への移動にする（あとで戻せる）。"""
    path = _path(circuit_id)
    if not path.exists():
        return False
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(TRASH_DIR / f"{circuit_id}-{int(time.time())}.json"))
    return True


def list_samples() -> list[dict]:
    out = []
    for p in sorted(SAMPLE_DIR.glob("*.json")):
        try:
            meta = json.loads(p.read_text(encoding="utf-8")).get("meta") or {}
        except (OSError, json.JSONDecodeError):
            continue
        out.append({"id": p.stem, "title": meta.get("title") or p.stem, "notes": meta.get("notes") or ""})
    return out


def load_sample(name: str) -> dict | None:
    if not _ID_RE.match(name or ""):
        return None
    path = SAMPLE_DIR / f"{name}.json"
    if not path.exists():
        return None
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc.pop("id", None)
    return doc
