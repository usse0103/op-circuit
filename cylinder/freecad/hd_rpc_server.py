"""FreeCAD の画面の中で XML-RPC サーバーを立て、Flask からの依頼を受ける

起動方法（FreeCAD の Python コンソールに貼り付けて Enter）:
    exec(open(r"C:\\Users\\yukit\\projects\\hydraulics\\cylinder\\freecad\\hd_rpc_server.py", encoding="utf-8").read())

もう一度実行すると、前のサーバーを止めてから立て直す。
生成スクリプト（hd_cylinder / hd_drawing）は依頼のたびに読み直すので、
コードを書き換えても FreeCAD を再起動する必要はない。
"""
import importlib
import os
import queue
import re
import sys
import threading
import traceback
import types
from xmlrpc.server import SimpleXMLRPCServer

import FreeCAD as App
from PySide import QtCore

HOST, PORT = "127.0.0.1", 9875
JOB_TIMEOUT = 300  # 秒

try:
    FREECAD_DIR = os.path.dirname(os.path.abspath(__file__))
except NameError:  # exec() で読み込んだときは __file__ が無い
    FREECAD_DIR = r"C:\Users\yukit\projects\hydraulics\cylinder\freecad"
PROJECT_DIR = os.path.dirname(FREECAD_DIR)
for path in (FREECAD_DIR, PROJECT_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

# 再実行しても前のサーバーにたどり着けるよう、状態は sys.modules に置く
STATE = sys.modules.setdefault("_hd_rpc_state", types.ModuleType("_hd_rpc_state"))


def _modules():
    """依頼のたびに最新のコードを読み直す"""
    import hd.params
    import hd_cylinder
    import hd_drawing
    import hd_parts
    importlib.reload(hd.params)
    importlib.reload(hd_parts)
    importlib.reload(hd_cylinder)
    importlib.reload(hd_drawing)
    return hd_cylinder, hd_drawing


def doc_name_for(drawing_number):
    """図番から FreeCAD のドキュメント名を作る（英数字と _ のみ）"""
    name = re.sub(r"[^A-Za-z0-9_]", "_", drawing_number or "Cylinder")
    return name if name[0].isalpha() else "D_" + name


class MainThreadDispatcher:
    """FreeCAD の操作は画面のスレッドでしか安全にできないので、そこへ受け渡す"""

    def __init__(self):
        self.jobs = queue.Queue()
        self.busy = False
        self.timer = QtCore.QTimer()
        self.timer.timeout.connect(self._run_jobs)
        self.timer.start(50)

    def call(self, fn, *args):
        done = threading.Event()
        box = {}
        self.jobs.put((fn, args, done, box))
        if not done.wait(JOB_TIMEOUT):
            raise RuntimeError("FreeCAD の処理がタイムアウトしました")
        if "error" in box:
            raise RuntimeError(box["error"])
        return box["result"]

    def _run_jobs(self):
        # 図面計算の待ち中に processEvents でここへ再入しないようにする
        if self.busy:
            return
        self.busy = True
        try:
            while not self.jobs.empty():
                fn, args, done, box = self.jobs.get_nowait()
                try:
                    box["result"] = fn(*args)
                except Exception as exc:
                    App.Console.PrintError(traceback.format_exc())
                    box["error"] = str(exc)
                finally:
                    done.set()
        finally:
            self.busy = False

    def stop(self):
        self.timer.stop()


# --- Flask から呼ばれる処理（画面のスレッドで実行される） ---

def _build(params, info):
    hd_cylinder, _ = _modules()
    return hd_cylinder.build(params, doc_name_for(info.get("drawing_number")))


def _drawing(params, info, out_dir):
    hd_cylinder, hd_drawing = _modules()
    result = hd_cylinder.build(params, doc_name_for(info.get("drawing_number")))
    doc = App.getDocument(result["doc"])
    drawing = hd_drawing.make(doc, info, out_dir)
    fcstd = os.path.join(out_dir, (info.get("drawing_number") or doc.Name) + ".FCStd")
    doc.saveAs(fcstd)
    drawing["files"]["fcstd"] = fcstd
    result.update(drawing)
    return result


def start():
    stop()
    dispatcher = MainThreadDispatcher()
    server = SimpleXMLRPCServer((HOST, PORT), allow_none=True, logRequests=False)
    server.register_function(lambda: {"freecad": ".".join(App.Version()[:3])}, "ping")
    server.register_function(lambda params, info: dispatcher.call(_build, params, info),
                             "build_cylinder")
    server.register_function(
        lambda params, info, out_dir: dispatcher.call(_drawing, params, info, out_dir),
        "make_drawing")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    STATE.server, STATE.dispatcher = server, dispatcher
    App.Console.PrintMessage(f"hydraulic-designer: http://{HOST}:{PORT} で待ち受け中\n")


def stop():
    server = getattr(STATE, "server", None)
    if server is not None:
        server.shutdown()
        server.server_close()
        STATE.dispatcher.stop()
        STATE.server = STATE.dispatcher = None
        App.Console.PrintMessage("hydraulic-designer: サーバーを停止しました\n")


start()
