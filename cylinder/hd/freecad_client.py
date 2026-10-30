"""FreeCAD への依頼

- 3D モデル・組立図: FreeCAD の画面の中で動いている hd_rpc_server に XML-RPC で送る
- 部品図: freecadcmd（画面なしの FreeCAD）で hd_parts_job.py を実行する。FreeCAD を起動していなくても動く
"""
import json
import os
import subprocess
import tempfile
import xmlrpc.client
from pathlib import Path

URL = "http://127.0.0.1:9875"

ROOT = Path(__file__).resolve().parent.parent
PARTS_JOB = ROOT / "freecad" / "hd_parts_job.py"
# 共通の投影図エンジン（fc2d.py）の置き場所
FC2D_DIR = Path(os.environ.get("FC2D_DIR", ROOT.parents[1] / "platform" / "drawing"))
FREECADCMD = Path(os.environ.get(
    "FREECADCMD",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "FreeCAD 1.1" / "bin" / "freecadcmd.exe"))


class _Transport(xmlrpc.client.Transport):
    def __init__(self, timeout):
        super().__init__()
        self._timeout = timeout

    def make_connection(self, host):
        conn = super().make_connection(host)
        conn.timeout = self._timeout
        return conn


def _proxy(timeout):
    return xmlrpc.client.ServerProxy(URL, transport=_Transport(timeout), allow_none=True)


class FreeCADError(Exception):
    pass


def _call(method, *args, timeout=300):
    try:
        return getattr(_proxy(timeout), method)(*args)
    except ConnectionRefusedError:
        raise FreeCADError("FreeCAD に接続できません。FreeCAD でサーバーを起動してください")
    except xmlrpc.client.Fault as fault:
        # サーバー側の例外は "<class '...'>:メッセージ" の形で届く
        raise FreeCADError(fault.faultString.split(":", 1)[-1].strip())


def ping():
    """接続できれば FreeCAD のバージョン、できなければ None"""
    try:
        return _call("ping", timeout=1)["freecad"]
    except (FreeCADError, OSError):
        return None


def build_cylinder(params, info):
    return _call("build_cylinder", params, info)


def make_drawing(params, info, out_dir):
    return _call("make_drawing", params, info, out_dir)


def make_part_drawings(params, info, out_dir, timeout=300):
    """部品ごとの投影図 DXF と部品表を out_dir に出力する"""
    if not FREECADCMD.exists():
        raise FreeCADError(f"freecadcmd が見つかりません: {FREECADCMD}（環境変数 FREECADCMD で指定できます）")
    if not (FC2D_DIR / "fc2d.py").exists():
        raise FreeCADError(f"fc2d.py が見つかりません: {FC2D_DIR}（環境変数 FC2D_DIR で指定できます）")
    job = {"params": params, "info": info, "out_dir": str(out_dir), "fc2d_dir": str(FC2D_DIR)}
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as f:
        json.dump(job, f, ensure_ascii=False)
    try:
        proc = subprocess.run(
            [str(FREECADCMD), str(PARTS_JOB)], env={**os.environ, "HD_JOB": f.name},
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        raise FreeCADError("部品図の出力がタイムアウトしました")
    finally:
        os.remove(f.name)
    for line in proc.stdout.splitlines():
        if line.startswith("HD_RESULT "):
            return json.loads(line[len("HD_RESULT "):])
    # freecadcmd はスクリプトの例外でも終了コード 0 のことがあるので、結果行の有無で判定する
    tail = "\n".join((proc.stdout + proc.stderr).strip().splitlines()[-3:])
    raise FreeCADError(f"部品図の出力に失敗しました：{tail}")
