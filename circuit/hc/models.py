"""機器 → 管路網の要素への展開。

機器の種類ごとに「組み立て関数」を 1 つ登録する。新しい機器を足すときは、
library/*.json に定義を書き、ここに @model("名前") の関数を足す。

組み立て関数は ctx.add() で要素を登録し、結果のまとめ方（summary 関数）を返す。
summary は R（計算結果の参照）を受け取り、(値の一覧, 図面に添える短い表示) を返す。
"""
from __future__ import annotations

import math

from . import network as nw

BUILDERS: dict = {}


def model(name: str):
    def deco(fn):
        BUILDERS[name] = fn
        return fn
    return deco


# --- パラメータの読み出し -----------------------------------------------------
def num(c: dict, key: str, default: float = 0.0) -> float:
    v = c.get("params", {}).get(key, default)
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def text(c: dict, key: str, default: str = "") -> str:
    v = c.get("params", {}).get(key, default)
    return default if v is None else str(v)


def flag(c: dict, key: str, default: bool = False) -> bool:
    v = c.get("params", {}).get(key, default)
    if isinstance(v, str):
        return v.lower() in ("1", "true", "yes", "on")
    return bool(v)


def val(label: str, value: float, unit: str = "", digits: int = 2) -> dict:
    return {"label": label, "value": value, "unit": unit, "digits": digits}


class Ctx:
    """1 工程ぶんの組み立ての文脈。"""

    def __init__(self, net: nw.Net, fluid: dict, states: dict, pump_flow: float, connected: set):
        self.net = net
        self.rho = fluid["rho"]
        self.nu = fluid["nu"]
        self.states = states
        self.pump_flow = pump_flow
        self.connected = connected            # 配線がつながっている端子
        self.by_comp: dict[str, dict[str, nw.Element]] = {}
        self.notes: list[dict] = []

    def t(self, c: dict, port: str) -> str:
        return self.net.term(f"{c['id']}:{port}")

    def add(self, el: nw.Element) -> nw.Element:
        self.net.add(el)
        self.by_comp.setdefault(el.comp, {})[el.name] = el
        return el

    def state(self, c: dict, default: str) -> str:
        return str(self.states.get(c["id"], default))

    def note(self, level: str, msg: str, ref: str | None = None) -> None:
        self.notes.append({"level": level, "msg": msg, "ref": ref})


class R:
    """summary 関数に渡す結果の参照。"""

    def __init__(self, comp_id: str, net: nw.Net, p, el_results: dict):
        self.cid = comp_id
        self.net = net
        self._p = p
        self.els = el_results      # name -> {"q": [...], "p": [...], "pw": {...}, "el": Element}

    def p(self, port: str) -> float:
        return self.net.pressure(self._p, f"{self.cid}:{port}")

    def q(self, name: str) -> float:
        e = self.els.get(name)
        return e["q"][0] if e else 0.0

    def el(self, name: str):
        return self.els.get(name)

    def heat(self) -> float:
        return sum(e["pw"]["heat"] for e in self.els.values())


def _rated_k(c: dict) -> float:
    return nw.k_from_rated(num(c, "q_rated", 40.0), num(c, "dp_rated", 0.5))


# ---------------------------------------------------------------------------
# 動力源
# ---------------------------------------------------------------------------
@model("tank")
def _tank(c, ctx):
    ctx.net.ground(ctx.t(c, "T"))
    return lambda r: ([], [])


def _pump_common(c, ctx):
    q_th = num(c, "disp", 10.0) * num(c, "speed", 1800.0) / 1000.0
    eta_v = min(max(num(c, "eta_v", 92.0) / 100.0, 0.3), 1.0)
    eta_t = min(max(num(c, "eta_t", 85.0) / 100.0, 0.2), 1.0)
    p_rated = max(num(c, "p_rated", 21.0), 0.1)
    k_leak = q_th * (1.0 - eta_v) / p_rated
    eta_m = min(eta_t / eta_v, 1.0)
    s, p = ctx.t(c, "S"), ctx.t(c, "P")
    if s not in ctx.connected:
        ctx.net.ground(s)
        ctx.note("info", "吸込口が未接続です。タンクにつながっているものとして計算しました。", c["id"])
    return q_th, k_leak, eta_m, s, p, p_rated


def _pump_summary(c, q_th, p_rated):
    def summary(r):
        e = r.el("pump")
        q = -e["q"][1]
        p_out, p_in = r.p("P"), r.p("S")
        pw = e["pw"]
        vals = [
            val("理論吐出量", q_th, "L/min", 1),
            val("吐出量", q, "L/min", 1),
            val("吐出圧力", p_out, "MPa", 2),
            val("吸込圧力", p_in * 1000.0, "kPa", 1),
            val("油動力", -pw["hyd"], "kW", 2),
            val("軸入力", pw["shaft"], "kW", 2),
            val("発熱", pw["heat"] * 1000.0, "W", 0),
        ]
        labels = [f"{q:.1f} L/min", f"{pw['shaft']:.2f} kW"]
        return vals, labels
    return summary


@model("pump_fixed")
def _pump_fixed(c, ctx):
    q_th, k_leak, eta_m, s, p, p_rated = _pump_common(c, ctx)
    ctx.add(nw.PumpFixed(c["id"], "pump", s, p, q_th, k_leak, eta_m))
    return _pump_summary(c, q_th, p_rated)


@model("pump_var")
def _pump_var(c, ctx):
    q_th, k_leak, eta_m, s, p, p_rated = _pump_common(c, ctx)
    ctx.add(nw.PumpCompensated(c["id"], "pump", s, p, q_th, k_leak, eta_m,
                               num(c, "p_comp", 7.0), num(c, "band", 0.7)))
    return _pump_summary(c, q_th, p_rated)


# ---------------------------------------------------------------------------
# 圧力制御弁
# ---------------------------------------------------------------------------
def _relief_element(c, ctx, name, a, b, p_set, override, q_adj):
    q_ref = q_adj if q_adj > 0 else (ctx.pump_flow if ctx.pump_flow > 0 else 20.0)
    p_crack = p_set * (1.0 - min(max(override, 1.0), 60.0) / 100.0)
    return ctx.add(nw.Relief(c["id"], name, a, b, p_set, p_crack, q_ref))


@model("relief")
def _relief(c, ctx):
    p_set = max(num(c, "p_set", 7.0), 0.05)
    _relief_element(c, ctx, "relief", ctx.t(c, "P"), ctx.t(c, "T"), p_set,
                    num(c, "override", 10.0), num(c, "q_adj", 0.0))

    def summary(r):
        q = r.q("relief")
        vals = [
            val("設定圧力", p_set, "MPa", 2),
            val("入口圧力", r.p("P"), "MPa", 2),
            val("リリーフ流量", q, "L/min", 1),
            val("発熱", r.heat() * 1000.0, "W", 0),
        ]
        return vals, ([f"{q:.1f} L/min"] if q > 0.05 else [])
    return summary


@model("reducing")
def _reducing(c, ctx):
    p_set = max(num(c, "p_set", 3.5), 0.05)
    ctx.add(nw.Reducing(c["id"], "main", ctx.t(c, "P"), ctx.t(c, "A"), _rated_k(c),
                        p_set, max(0.04 * p_set, 0.05)))

    def summary(r):
        q = r.q("main")
        vals = [
            val("設定圧力", p_set, "MPa", 2),
            val("一次圧力", r.p("P"), "MPa", 2),
            val("二次圧力", r.p("A"), "MPa", 2),
            val("流量", q, "L/min", 1),
            val("発熱", r.heat() * 1000.0, "W", 0),
        ]
        return vals, ([f"{r.p('A'):.1f} MPa"] if abs(q) > 0.05 else [])
    return summary


@model("sequence")
def _sequence(c, ctx):
    p_set = max(num(c, "p_set", 5.0), 0.05)
    ctx.add(nw.Sequence(c["id"], "main", ctx.t(c, "P"), ctx.t(c, "A"), _rated_k(c),
                        p_set, max(0.05 * p_set, 0.05)))

    def summary(r):
        q = r.q("main")
        vals = [
            val("設定圧力", p_set, "MPa", 2),
            val("一次圧力", r.p("P"), "MPa", 2),
            val("二次圧力", r.p("A"), "MPa", 2),
            val("流量", q, "L/min", 1),
            val("発熱", r.heat() * 1000.0, "W", 0),
        ]
        return vals, ([f"{q:.1f} L/min"] if q > 0.05 else [])
    return summary


@model("counterbalance")
def _counterbalance(c, ctx):
    p_set = max(num(c, "p_set", 5.0), 0.05)
    k = _rated_k(c)
    load, valve = ctx.t(c, "C"), ctx.t(c, "V")
    ctx.add(nw.Sequence(c["id"], "main", load, valve, k, p_set, max(0.05 * p_set, 0.05)))
    ctx.add(nw.Check(c["id"], "check", valve, load, k, num(c, "crack", 0.04)))

    def summary(r):
        q = r.q("main") - r.q("check")
        vals = [
            val("設定圧力", p_set, "MPa", 2),
            val("負荷側圧力", r.p("C"), "MPa", 2),
            val("弁側圧力", r.p("V"), "MPa", 2),
            val("流量（負荷 → 弁）", q, "L/min", 1),
            val("発熱", r.heat() * 1000.0, "W", 0),
        ]
        return vals, []
    return summary


# ---------------------------------------------------------------------------
# 逆止め弁
# ---------------------------------------------------------------------------
@model("check")
def _check(c, ctx):
    ctx.add(nw.Check(c["id"], "check", ctx.t(c, "IN"), ctx.t(c, "OUT"), _rated_k(c),
                     num(c, "crack", 0.04)))

    def summary(r):
        vals = [
            val("流量", r.q("check"), "L/min", 1),
            val("圧力損失", max(r.p("IN") - r.p("OUT"), 0.0) if r.q("check") > 0 else 0.0, "MPa", 3),
            val("発熱", r.heat() * 1000.0, "W", 0),
        ]
        return vals, []
    return summary


@model("pilot_check")
def _pilot_check(c, ctx):
    x = ctx.t(c, "X")
    ctx.add(nw.PilotCheck(c["id"], "check", ctx.t(c, "IN"), ctx.t(c, "OUT"), x, _rated_k(c),
                          num(c, "crack", 0.2), num(c, "ratio", 3.0)))

    def summary(r):
        q = r.q("check")
        state = "自由流れ" if q > 0.01 else ("パイロット開" if q < -0.01 else "閉")
        vals = [
            val("流量（IN → OUT）", q, "L/min", 1),
            val("パイロット圧力", r.p("X"), "MPa", 2),
            val("発熱", r.heat() * 1000.0, "W", 0),
            {"label": "状態", "text": state},
        ]
        return vals, []
    return summary


# ---------------------------------------------------------------------------
# 流量制御弁
# ---------------------------------------------------------------------------
def _throttle_summary(r, with_check=False):
    q = r.q("throttle") - (r.q("check") if with_check else 0.0)
    dp = r.p("IN") - r.p("OUT")
    vals = [
        val("流量（IN → OUT）", q, "L/min", 1),
        val("差圧", dp, "MPa", 2),
        val("発熱", r.heat() * 1000.0, "W", 0),
    ]
    return vals, ([f"{abs(q):.1f} L/min"] if abs(q) > 0.05 else [])


@model("throttle")
def _throttle(c, ctx):
    k = nw.k_from_diameter(num(c, "d", 2.0), num(c, "cd", 0.65), ctx.rho)
    ctx.add(nw.Orifice(c["id"], "throttle", ctx.t(c, "IN"), ctx.t(c, "OUT"), k))
    return lambda r: _throttle_summary(r)


@model("throttle_check")
def _throttle_check(c, ctx):
    k = nw.k_from_diameter(num(c, "d", 2.0), num(c, "cd", 0.65), ctx.rho)
    a, b = ctx.t(c, "IN"), ctx.t(c, "OUT")
    ctx.add(nw.Orifice(c["id"], "throttle", a, b, k))
    ctx.add(nw.Check(c["id"], "check", b, a, _rated_k(c), num(c, "crack", 0.04)))
    return lambda r: _throttle_summary(r, True)


@model("flow_control")
def _flow_control(c, ctx):
    a, b = ctx.t(c, "IN"), ctx.t(c, "OUT")
    q_set = num(c, "q_set", 10.0)
    ctx.add(nw.FlowControl(c["id"], "throttle", a, b, q_set, num(c, "dp_min", 1.0)))
    with_check = flag(c, "with_check", True)
    if with_check:
        ctx.add(nw.Check(c["id"], "check", b, a, _rated_k(c), num(c, "crack", 0.04)))

    def summary(r):
        vals, labels = _throttle_summary(r, with_check)
        vals.insert(0, val("設定流量", q_set, "L/min", 1))
        q = r.q("throttle")
        if 0.05 < q < q_set * 0.98:
            vals.append({"label": "状態", "text": "差圧不足（圧力補償が効いていない）"})
        return vals, labels
    return summary


@model("stop_valve")
def _stop_valve(c, ctx):
    a, b = ctx.t(c, "IN"), ctx.t(c, "OUT")
    is_open = flag(c, "open", True)
    if is_open:
        ctx.add(nw.Orifice(c["id"], "main", a, b, _rated_k(c)))

    def summary(r):
        vals = [
            {"label": "状態", "text": "開" if is_open else "閉"},
            val("流量", r.q("main"), "L/min", 1),
            val("発熱", r.heat() * 1000.0, "W", 0),
        ]
        return vals, []
    return summary


# ---------------------------------------------------------------------------
# 方向制御弁
# ---------------------------------------------------------------------------
CENTER_PATHS = {
    "closed": [],
    "tandem": [("P", "T")],
    "float": [("A", "T"), ("B", "T")],
    "open": "hub",
    "pab": [("P", "A"), ("P", "B")],
}


def _dcv_passages(c, ctx, k, state, center, term):
    """4 ポート弁の流路を登録する。term(名前) は端子キーを返す。"""
    cid = c["id"]
    if state == "a":
        paths = [("P", "A"), ("B", "T")]
    elif state == "b":
        paths = [("P", "B"), ("A", "T")]
    else:
        paths = CENTER_PATHS.get(center, [])
    if paths == "hub":
        hub = ctx.net.term(f"{cid}:#hub")
        for port in ("P", "A", "B", "T"):
            ctx.add(nw.Orifice(cid, f"{port}-中立", term(port), hub, k * math.sqrt(2.0)))
        return
    for a, b in paths:
        ctx.add(nw.Orifice(cid, f"{a}→{b}", term(a), term(b), k))


def _dcv_summary(c, state_label):
    def summary(r):
        vals = [{"label": "位置", "text": state_label}]
        for name, e in r.els.items():
            if e["el"].kind != "orifice" or name.startswith("#"):
                continue
            q = e["q"][0]
            dp = e["p"][0] - e["p"][1]
            vals.append(val(f"{name} 流量", q, "L/min", 1))
            vals.append(val(f"{name} 圧力損失", dp, "MPa", 3))
        vals.append(val("発熱", r.heat() * 1000.0, "W", 0))
        return vals, []
    return summary


STATE_LABEL = {"a": "SOL a 励磁", "b": "SOL b 励磁", "n": "中立", "on": "励磁", "off": "非励磁"}


@model("dcv43")
def _dcv43(c, ctx):
    state = ctx.state(c, "n")
    _dcv_passages(c, ctx, _rated_k(c), state, text(c, "center", "closed"), lambda p: ctx.t(c, p))
    for port in ("P", "T", "A", "B"):
        ctx.t(c, port)
    return _dcv_summary(c, STATE_LABEL.get(state, state))


@model("dcv42")
def _dcv42(c, ctx):
    state = ctx.state(c, "off")
    normal = text(c, "normal", "PB")
    straight = (state == "on") == (normal == "PB")      # 励磁で P→A になるか
    _dcv_passages(c, ctx, _rated_k(c), "a" if straight else "b", "closed", lambda p: ctx.t(c, p))
    for port in ("P", "T", "A", "B"):
        ctx.t(c, port)
    return _dcv_summary(c, STATE_LABEL.get(state, state))


@model("dcv22")
def _dcv22(c, ctx):
    state = ctx.state(c, "off")
    normally_open = text(c, "normal", "closed") == "open"
    is_open = normally_open != (state == "on")
    a, b = ctx.t(c, "P"), ctx.t(c, "A")
    if is_open:
        ctx.add(nw.Orifice(c["id"], "P→A", a, b, _rated_k(c)))
    return _dcv_summary(c, STATE_LABEL.get(state, state) + ("（開）" if is_open else "（閉）"))


# ---------------------------------------------------------------------------
# アクチュエータ
# ---------------------------------------------------------------------------
@model("cyl_double")
def _cyl_double(c, ctx):
    bore, rod = num(c, "bore", 50.0), num(c, "rod", 28.0)
    stroke = num(c, "stroke", 300.0)
    a_head = math.pi * bore * bore / 400.0                       # cm²
    a_rod = max(a_head - math.pi * rod * rod / 400.0, 0.01)      # cm²
    f_ext, f_ret = num(c, "f_ext", 10.0) * 1000.0, num(c, "f_ret", 0.0) * 1000.0
    state = ctx.state(c, "move")
    el = ctx.add(nw.Cylinder(c["id"], "cyl", ctx.t(c, "H"), ctx.t(c, "R"), a_head, a_rod,
                             f_ext, f_ret, num(c, "eta", 90.0) / 100.0, stalled=(state == "stall")))

    def summary(r):
        e = r.el("cyl")
        v = el.velocity(e["p"])
        direction = "伸び" if v > 1e-6 else ("縮み" if v < -1e-6 else "停止")
        if state == "stall":
            direction = "停止（ストロークエンド）"
        vals = [
            {"label": "動作", "text": direction},
            val("速度", abs(v) * 1000.0, "mm/s", 1),
            val("ヘッド側圧力", r.p("H"), "MPa", 2),
            val("ロッド側圧力", r.p("R"), "MPa", 2),
            val("ヘッド側流量", abs(e["q"][0]), "L/min", 1),
            val("ロッド側流量", abs(e["q"][1]), "L/min", 1),
            val("推力（流体力）", el.force(e["p"]) / 1000.0, "kN", 2),
            val("出力", e["pw"]["mech"], "kW", 2),
            val("ヘッド側受圧面積", a_head, "cm²", 2),
            val("ロッド側受圧面積", a_rod, "cm²", 2),
        ]
        time = stroke / (abs(v) * 1000.0) if abs(v) > 1e-6 else None
        if time is not None:
            vals.insert(2, val("ストローク時間", time, "s", 2))
        labels = [f"{direction} {abs(v) * 1000.0:.0f} mm/s"] if abs(v) > 1e-6 else []
        extra = {"velocity": v, "stroke_time": time}
        return vals, labels, extra
    return summary


@model("motor_hyd")
def _motor_hyd(c, ctx):
    state = ctx.state(c, "move")
    el = ctx.add(nw.Motor(c["id"], "motor", ctx.t(c, "A"), ctx.t(c, "B"), num(c, "disp", 50.0),
                          num(c, "torque", 50.0), num(c, "eta_v", 95.0) / 100.0,
                          num(c, "eta_m", 90.0) / 100.0, stalled=(state == "stall")))

    def summary(r):
        e = r.el("motor")
        n = el.speed(e["p"])
        vals = [
            val("回転速度", abs(n), "min⁻¹", 0),
            val("差圧", e["p"][0] - e["p"][1], "MPa", 2),
            val("流量", abs(e["q"][0]), "L/min", 1),
            val("出力トルク", abs(el.torque_out(e["p"])), "N·m", 1),
            val("出力", e["pw"]["mech"], "kW", 2),
            val("発熱", e["pw"]["heat"] * 1000.0, "W", 0),
        ]
        return vals, ([f"{abs(n):.0f} min⁻¹"] if abs(n) > 0.5 else [])
    return summary


# ---------------------------------------------------------------------------
# 付属機器
# ---------------------------------------------------------------------------
@model("filter")
def _filter(c, ctx):
    a, b = ctx.t(c, "IN"), ctx.t(c, "OUT")
    q0, dp0 = num(c, "q_rated", 60.0), max(num(c, "dp_rated", 0.05), 1e-4)
    ctx.add(nw.Linear(c["id"], "element", a, b, q0 / dp0))
    bypass = num(c, "bypass", 0.0)
    if bypass > 0:
        ctx.add(nw.Check(c["id"], "bypass", a, b, nw.k_from_rated(q0, 0.1), bypass))

    def summary(r):
        q = r.q("element")
        vals = [
            val("流量", abs(q) + abs(r.q("bypass")), "L/min", 1),
            val("圧力損失", abs(r.p("IN") - r.p("OUT")) * 1000.0, "kPa", 1),
            val("発熱", r.heat() * 1000.0, "W", 0),
        ]
        if abs(r.q("bypass")) > 0.01:
            vals.append({"label": "状態", "text": "バイパス弁が開いています"})
        return vals, []
    return summary


@model("cooler")
def _cooler(c, ctx):
    ctx.add(nw.Orifice(c["id"], "main", ctx.t(c, "IN"), ctx.t(c, "OUT"), _rated_k(c)))
    cap = num(c, "capacity", 0.0)

    def summary(r):
        q = r.q("main")
        vals = [
            val("流量", abs(q), "L/min", 1),
            val("圧力損失", abs(r.p("IN") - r.p("OUT")), "MPa", 3),
            val("交換熱量（設定）", cap, "kW", 2),
        ]
        return vals, [], {"cooling": cap if abs(q) > 0.1 else 0.0}
    return summary


@model("gauge")
def _gauge(c, ctx):
    ctx.t(c, "P")
    return lambda r: ([val("圧力", r.p("P"), "MPa", 2)], [f"{r.p('P'):.1f} MPa"])


@model("pressure_switch")
def _pressure_switch(c, ctx):
    ctx.t(c, "P")
    p_set = num(c, "p_set", 5.0)

    def summary(r):
        on = r.p("P") >= p_set
        return ([val("設定圧力", p_set, "MPa", 2), val("圧力", r.p("P"), "MPa", 2),
                 {"label": "接点", "text": "ON" if on else "OFF"}], ["ON" if on else "OFF"])
    return summary


@model("accumulator")
def _accumulator(c, ctx):
    ctx.t(c, "P")
    v0, p0 = num(c, "volume", 1.0), num(c, "precharge", 5.0)
    p_min, p_max = num(c, "p_min", 6.0), num(c, "p_max", 10.0)

    def summary(r):
        vals = [val("圧力", r.p("P"), "MPa", 2)]
        if p_min > 0 and p_max > p_min and p0 > 0:
            # 東京計器 技術資料 19: V = V0·e·ηa·f(a)
            e = min(p0 / p_min, 1.0)
            a = (p_max + 0.1013) / (p_min + 0.1013)
            vals.append(val("放出量（等温）", v0 * e * 0.95 * (1.0 - 1.0 / a), "L", 2))
            vals.append(val("放出量（断熱 m=1.4）", v0 * e * 0.95 * (1.0 - (1.0 / a) ** (1.0 / 1.4)), "L", 2))
        return vals, []
    return summary


@model("junction")
def _junction(c, ctx):
    ctx.t(c, "J")
    return lambda r: ([], [])


@model("none")
def _none(c, ctx):
    return lambda r: ([], [])


# ---------------------------------------------------------------------------
# 積層弁（モジュラー弁）スタック
# ---------------------------------------------------------------------------
LINES = ("P", "T", "A", "B")
LAYER_NAMES = {
    "relief": "リリーフ弁", "reducing": "減圧弁", "check": "逆止め弁", "throttle": "絞り弁",
    "tcheck": "一方向絞り弁", "pcheck": "パイロット操作逆止め弁", "cbal": "カウンタバランス弁",
}


def layer_title(layer: dict) -> str:
    kind, line = layer.get("kind", ""), layer.get("line", "")
    name = LAYER_NAMES.get(kind, kind)
    line_text = "A・B" if line == "AB" else line
    if kind == "tcheck":
        mode = "メータアウト" if layer.get("mode", "out") == "out" else "メータイン"
        return f"{name}（{line_text} ライン・{mode}）"
    if kind == "reducing":
        return f"{name}（P ライン・{line_text} パイロット）"
    return f"{name}（{line_text} ライン）"


def _lnum(layer: dict, key: str, default: float) -> float:
    try:
        v = float(layer.get(key, default))
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


@model("stack")
def _stack(c, ctx):
    cid = c["id"]
    layers = list(c.get("params", {}).get("layers") or [])
    n = len(layers)
    k = _rated_k(c)
    k_free = nw.k_from_rated(num(c, "q_rated", 40.0), 0.3)

    def node(line: str, level: int) -> str:
        # level 0 = ベース（外部ポート）、level n = 電磁弁側
        return ctx.t(c, line) if level == 0 else ctx.net.term(f"{cid}:#{line}{level}")

    titles = []
    # layers[0] が電磁弁側、layers[-1] がベース側
    for j, layer in enumerate(reversed(layers)):
        lo, hi = j, j + 1
        kind, line = layer.get("kind"), layer.get("line", "P")
        tag = f"#{n - j}"                     # 上から数えた段
        titles.append((tag, layer_title(layer)))
        inline: set[str] = set()
        lines = ["A", "B"] if line == "AB" else [line]
        if kind == "relief":
            for ln in lines:
                _relief_element(c, ctx, f"{tag} {ln}→T リリーフ", node(ln, hi), node("T", hi),
                                max(_lnum(layer, "p_set", 7.0), 0.05), _lnum(layer, "override", 12.0), 0.0)
        elif kind == "reducing":
            p_set = max(_lnum(layer, "p_set", 3.5), 0.05)
            sense = None if line == "P" else node(line, hi)
            ctx.add(nw.Reducing(cid, f"{tag} P 減圧", node("P", lo), node("P", hi), k_free,
                                p_set, max(0.04 * p_set, 0.05), sense))
            inline.add("P")
        elif kind == "check":
            ln = "T" if line == "T" else "P"
            a, b = (node("T", hi), node("T", lo)) if ln == "T" else (node("P", lo), node("P", hi))
            ctx.add(nw.Check(cid, f"{tag} {ln} 逆止め", a, b, k_free, _lnum(layer, "crack", 0.04)))
            inline.add(ln)
        elif kind == "throttle":
            ln = "T" if line == "T" else "P"
            kd = nw.k_from_diameter(_lnum(layer, "d", 2.0), 0.65, ctx.rho)
            ctx.add(nw.Orifice(cid, f"{tag} {ln} 絞り", node(ln, lo), node(ln, hi), kd))
            inline.add(ln)
        elif kind == "tcheck":
            kd = nw.k_from_diameter(_lnum(layer, "d", 2.0), 0.65, ctx.rho)
            out = layer.get("mode", "out") == "out"
            for ln in lines:
                ctx.add(nw.Orifice(cid, f"{tag} {ln} 絞り", node(ln, lo), node(ln, hi), kd))
                # メータアウト: 電磁弁 → アクチュエータが自由流れ
                a, b = (node(ln, hi), node(ln, lo)) if out else (node(ln, lo), node(ln, hi))
                ctx.add(nw.Check(cid, f"{tag} {ln} 逆止め", a, b, k_free, 0.04))
                inline.add(ln)
        elif kind == "pcheck":
            for ln in lines:
                other = "B" if ln == "A" else "A"
                ctx.add(nw.PilotCheck(cid, f"{tag} {ln} パイロット逆止め", node(ln, hi), node(ln, lo),
                                      node(other, hi), k_free, _lnum(layer, "crack", 0.2),
                                      _lnum(layer, "ratio", 3.0)))
                inline.add(ln)
        elif kind == "cbal":
            for ln in lines:
                p_set = max(_lnum(layer, "p_set", 5.0), 0.05)
                ctx.add(nw.Sequence(cid, f"{tag} {ln} カウンタバランス", node(ln, lo), node(ln, hi),
                                    k_free, p_set, max(0.05 * p_set, 0.05)))
                ctx.add(nw.Check(cid, f"{tag} {ln} 逆止め", node(ln, hi), node(ln, lo), k_free, 0.04))
                inline.add(ln)
        for ln in LINES:
            if ln not in inline:
                ctx.net.union(node(ln, lo), node(ln, hi))

    state = ctx.state(c, "n")
    _dcv_passages(c, ctx, k, state, text(c, "center", "closed"), lambda p: node(p, n))
    for ln in LINES:
        ctx.t(c, ln)

    def summary(r):
        vals = [{"label": "電磁弁の位置", "text": STATE_LABEL.get(state, state)}]
        for ln in LINES:
            vals.append(val(f"{ln} ポート圧力", r.p(ln), "MPa", 2))
        detail = []
        for name, e in r.els.items():
            q = e["q"][0]
            if abs(q) < 0.005 and e["pw"]["heat"] < 1e-6:
                continue
            detail.append({
                "name": name, "q": q, "dp": e["p"][0] - e["p"][1], "heat": e["pw"]["heat"] * 1000.0,
            })
        vals.append(val("発熱（スタック合計）", r.heat() * 1000.0, "W", 0))
        return vals, [], {"detail": detail, "layers": [{"tag": t, "title": s} for t, s in reversed(titles)]}
    return summary


def stack_order_notes(c: dict) -> list[str]:
    """積層順序の制約を調べる（東京計器 集積弁カタログ G-12、NACHI 総合カタログ D-5）。

    layers[0] が電磁弁側。同じラインで、
      - メータアウトの一方向絞り弁は、パイロット操作逆止め弁よりベース（シリンダ）側に置く
      - メータアウトの一方向絞り弁は、A・B ラインパイロットの減圧弁よりベース側に置く
      - パイロット操作逆止め弁は、A・B ラインパイロットの減圧弁よりベース側に置く
    """
    layers = list(c.get("params", {}).get("layers") or [])
    notes = []

    def on(layer, ln):
        line = layer.get("line", "")
        return line == ln or line == "AB"

    for ln in ("A", "B"):
        idx_tc = [i for i, l in enumerate(layers)
                  if l.get("kind") == "tcheck" and l.get("mode", "out") == "out" and on(l, ln)]
        idx_pc = [i for i, l in enumerate(layers) if l.get("kind") == "pcheck" and on(l, ln)]
        idx_rd = [i for i, l in enumerate(layers) if l.get("kind") == "reducing" and l.get("line") == ln]
        if idx_tc and idx_pc and min(idx_tc) < max(idx_pc):
            notes.append(f"{ln} ライン: メータアウトの一方向絞り弁がパイロット操作逆止め弁より電磁弁側にあります。"
                         "絞りの背圧で逆止め弁が開閉を繰り返し、シリンダがノッキングします。"
                         "一方向絞り弁をベース側に置いてください。")
        if idx_tc and idx_rd and min(idx_tc) < max(idx_rd):
            notes.append(f"{ln} ライン: メータアウトの一方向絞り弁が減圧弁（{ln} ラインパイロット）より電磁弁側にあります。"
                         "絞りの背圧で減圧弁が閉じ、出力と速度が落ちます。減圧弁を電磁弁側に置いてください。")
        if idx_pc and idx_rd and min(idx_pc) < max(idx_rd):
            notes.append(f"{ln} ライン: パイロット操作逆止め弁が減圧弁（{ln} ラインパイロット）より電磁弁側にあります。"
                         "減圧弁のパイロットから漏れて位置を保持できません。減圧弁を電磁弁側に置いてください。")
    return notes
