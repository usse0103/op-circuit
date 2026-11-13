"""計算エンジンの確認。手計算できる回路で、答えが合うかを見る。

実行:  .venv\\Scripts\\python.exe tests\\test_engine.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hc.analysis import analyze  # noqa: E402
from hc.library import load_library  # noqa: E402
from hc import standards as std  # noqa: E402
from hc import network as nw  # noqa: E402

LIB = load_library()
_failed = 0


def check(name: str, got: float, want: float, tol: float = 0.02) -> None:
    """相対誤差 tol 以内なら合格。"""
    global _failed
    scale = max(abs(want), 1e-9)
    ok = abs(got - want) <= tol * scale + 1e-9
    print(f"  {'OK ' if ok else 'NG '} {name}: {got:.4f}（期待 {want:.4f}）")
    if not ok:
        _failed += 1


def wire(i, a, b, **kw):
    ca, pa = a.split(":")
    cb, pb = b.split(":")
    return {"id": f"w{i}", "a": {"c": ca, "p": pa}, "b": {"c": cb, "p": pb}, **kw}


def basic_doc(steps=None, extra_comps=(), extra_wires=()):
    comps = [
        {"id": "tk", "type": "tank"},
        {"id": "tk2", "type": "tank"},
        {"id": "tk3", "type": "tank"},
        {"id": "pump", "type": "pump_fixed", "params": {"disp": 8, "speed": 1800, "eta_v": 92, "eta_t": 85}},
        {"id": "rv", "type": "relief", "params": {"p_set": 7.0}},
        {"id": "sv", "type": "dcv43", "params": {"center": "closed"}},
        {"id": "cyl", "type": "cyl_double", "params": {"bore": 63, "rod": 35.5, "f_ext": 15, "f_ret": 2}},
        {"id": "j1", "type": "junction"},
    ]
    wires = [
        wire(1, "tk:T", "pump:S"),
        wire(2, "pump:P", "j1:J"),
        wire(3, "j1:J", "rv:P"),
        wire(4, "rv:T", "tk2:T"),
        wire(5, "j1:J", "sv:P"),
        wire(6, "sv:T", "tk3:T"),
        wire(7, "sv:A", "cyl:H"),
        wire(8, "sv:B", "cyl:R"),
    ]
    return {
        "id": "test",
        "components": comps + list(extra_comps),
        "wires": wires + list(extra_wires),
        "steps": steps or [],
    }


def test_relief_only():
    print("■ 中立（クローズドセンタ）: 全量リリーフ")
    res = analyze(basic_doc([{"id": "s1", "name": "中立", "duration": 10, "states": {"sv": "n"}}]), LIB)
    s = res["steps"][0]
    q_th = 8 * 1800 / 1000
    p = s["comps"]["pump"]["ports"]["P"]["p"]
    q = -s["comps"]["pump"]["ports"]["S"]["q"]
    check("収束", float(s["converged"]), 1.0)
    check("吐出圧力 = リリーフ設定", p, 7.0, 0.01)
    k_leak = q_th * 0.08 / 21
    check("吐出量", q, q_th - k_leak * p, 0.01)
    check("発熱 = 軸入力（仕事なし）", s["totals"]["heat"], s["totals"]["shaft"], 0.01)
    check("リリーフの発熱 = P·Q/60", s["comps"]["rv"]["heat"] / 1000, p * q / 60, 0.01)
    check("配線 w3 の流量（リリーフへ）", s["wires"]["w3"]["q"], q, 0.01)
    check("配線 w5 の流量（電磁弁へ）", s["wires"]["w5"]["q"], 0.0, 0.01)


def test_extend():
    print("■ 伸び（SOL a）: 負荷 15 kN")
    res = analyze(basic_doc([{"id": "s1", "name": "伸び", "duration": 0, "states": {"sv": "a"}}]), LIB)
    s = res["steps"][0]
    ah = math.pi * 63 ** 2 / 400
    ar = ah - math.pi * 35.5 ** 2 / 400
    c = s["comps"]["cyl"]
    v = c["extra"]["velocity"]
    q_h = c["ports"]["H"]["q"]            # 機器 → 節点。シリンダへ入るので負
    check("収束", float(s["converged"]), 1.0)
    check("速度 = Q/(6·A)", v, -q_h / (6 * ah), 0.001)
    check("ロッド側流量 = v·Ar", c["ports"]["R"]["q"], 6 * ar * v, 0.001)
    ph, pr = c["ports"]["H"]["p"], c["ports"]["R"]["p"]
    # 東京計器 技術資料 14: P1 = (F/ηc + P2·A2·100) / (A1·100)
    check("ヘッド圧（力のつり合い）", ph, (15000 / 0.9 + pr * ar * 100) / (ah * 100), 0.02)
    k = 30 / math.sqrt(0.4)
    check("ロッド側背圧（B→T の損失）", pr, (6 * ar * v / k) ** 2, 0.02)
    t = s["totals"]
    check("エネルギー収支（軸入力 = 仕事 + 発熱）", t["shaft"], t["mech"] + t["heat"], 0.01)
    check("ストローク時間", c["extra"]["stroke_time"], 300 / (v * 1000), 0.001)
    check("リリーフは閉", s["comps"]["rv"]["ports"]["P"]["q"], 0.0, 0.01)


def test_overload():
    print("■ 負荷が大きすぎて動かない: 全量リリーフ")
    doc = basic_doc([{"id": "s1", "name": "伸び", "duration": 5, "states": {"sv": "a"}}])
    doc["components"][6]["params"]["f_ext"] = 40      # 7 MPa × 31.2 cm² = 21.8 kN では足りない
    s = analyze(doc, LIB)["steps"][0]
    check("速度 0", s["comps"]["cyl"]["extra"]["velocity"], 0.0)
    check("吐出圧力 = リリーフ設定", s["comps"]["pump"]["ports"]["P"]["p"], 7.0, 0.01)


def test_pipe():
    print("■ 配管の圧力損失（東京計器 技術資料 23）")
    fl = std.fluid_props("VG46", 50)
    d, length, q = 9.4, 5.0, 14.0
    pipe = nw.Pipe("w", "pipe", "a", "b", d, length, 0, fl["rho"], fl["nu"])
    v = 2 * q / (3 * math.pi * d * d) * 100
    re = v * d / fl["nu"] * 1e3
    lam = 64 / re if re <= 2000 else 0.3164 * re ** -0.25
    dp = lam * v * v * fl["rho"] * length / (2000 * d)
    check("流速", pipe.velocity(q), v, 0.001)
    check("レイノルズ数", pipe.reynolds(q), re, 0.001)
    check("圧力損失", pipe.dp_of(q), dp, 0.001)
    check("逆算した流量", pipe.q_of(dp), q, 0.001)
    q2 = 60.0
    v2 = 2 * q2 / (3 * math.pi * d * d) * 100
    re2 = v2 * d / fl["nu"] * 1e3
    dp2 = 0.3164 * re2 ** -0.25 * v2 * v2 * fl["rho"] * length / (2000 * d)
    check("乱流域の圧力損失", pipe.dp_of(q2), dp2, 0.001)
    check("乱流域の逆算", pipe.q_of(dp2), q2, 0.001)
    print(f"     動粘度 {fl['nu']:.1f} mm²/s、密度 {fl['rho']:.0f} kg/m³、Re {re:.0f} / {re2:.0f}")


def test_viscosity():
    print("■ 作動油の物性")
    check("VG46 40 ℃", std.viscosity("VG46", 40), 46.0, 0.001)
    check("VG46 100 ℃", std.viscosity("VG46", 100), 6.8, 0.001)
    check("VG46 38 ℃ の密度（東京計器の表: 864）", std.density("VG46", 38), 864, 0.005)


def test_stack():
    print("■ 積層弁: パイロット操作逆止め弁 + メータアウト絞り")
    comps = [
        {"id": "tk", "type": "tank"}, {"id": "tk2", "type": "tank"}, {"id": "tk3", "type": "tank"},
        {"id": "pump", "type": "pump_fixed", "params": {"disp": 8, "speed": 1800}},
        {"id": "rv", "type": "relief", "params": {"p_set": 10.0}},
        {"id": "st", "type": "stack", "params": {"layers": [
            {"kind": "pcheck", "line": "AB", "ratio": 3.0},
            {"kind": "tcheck", "line": "AB", "mode": "out", "d": 1.2}]}},
        {"id": "cyl", "type": "cyl_double", "params": {"bore": 63, "rod": 35.5, "f_ext": 10, "f_ret": 1}},
        {"id": "j1", "type": "junction"},
    ]
    wires = [
        wire(1, "tk:T", "pump:S"), wire(2, "pump:P", "j1:J"), wire(3, "j1:J", "rv:P"),
        wire(4, "rv:T", "tk2:T"), wire(5, "j1:J", "st:P"), wire(6, "st:T", "tk3:T"),
        wire(7, "st:A", "cyl:H"), wire(8, "st:B", "cyl:R"),
    ]
    doc = {"id": "stack", "components": comps, "wires": wires, "steps": [
        {"id": "s1", "name": "伸び", "duration": 0, "states": {"st": "a"}},
        {"id": "s2", "name": "保持", "duration": 5, "states": {"st": "n"}},
        {"id": "s3", "name": "縮み", "duration": 0, "states": {"st": "b"}},
    ]}
    res = analyze(doc, LIB)
    for s in res["steps"]:
        c = s["comps"]["cyl"]
        t = s["totals"]
        print(f"   {s['name']}: 収束 {s['converged']}（{s['iterations']} 回）  v = {c['extra']['velocity'] * 1000:7.1f} mm/s"
              f"  pH = {c['ports']['H']['p']:6.2f}  pR = {c['ports']['R']['p']:6.2f} MPa"
              f"  軸入力 {t['shaft']:.2f} kW  発熱 {t['heat']:.2f} kW")
        check(f"{s['name']}: 収束", float(s["converged"]), 1.0)
        check(f"{s['name']}: エネルギー収支", t["shaft"], t["mech"] + t["heat"], 0.01)
    ext = res["steps"][0]["comps"]["cyl"]["extra"]["velocity"]
    ret = res["steps"][2]["comps"]["cyl"]["extra"]["velocity"]
    check("伸びは正の速度", float(ext > 0.001), 1.0)
    check("縮みは負の速度", float(ret < -0.001), 1.0)
    check("保持中は停止", res["steps"][1]["comps"]["cyl"]["extra"]["velocity"], 0.0)
    th = res["thermal"]
    print(f"   平均発熱 {res['cycle']['heat']:.2f} kW、推定油温 {th['steady']:.0f} ℃、"
          f"必要クーラ {th['coolerNeed']:.2f} kW、推奨電動機 {res['cycle']['motor']} kW")
    for d in res["diagnostics"]:
        print(f"   [{d['level']}] {d['msg']}")

    print("■ 積層順序の誤り（絞りが電磁弁側）を検出する")
    doc["components"][5]["params"]["layers"].reverse()
    res = analyze(doc, LIB)
    hit = any("ノッキング" in d["msg"] for d in res["diagnostics"])
    check("順序の警告が出る", float(hit), 1.0)


if __name__ == "__main__":
    test_viscosity()
    test_pipe()
    test_relief_only()
    test_extend()
    test_overload()
    test_stack()
    print()
    print("すべて合格" if _failed == 0 else f"{_failed} 件の不一致")
    sys.exit(1 if _failed else 0)
