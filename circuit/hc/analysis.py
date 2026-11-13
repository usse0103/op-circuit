"""回路全体の計算。工程ごとに管路網を解き、熱収支と診断をまとめる。"""
from __future__ import annotations

import math
from collections import OrderedDict, defaultdict

from . import models
from . import network as nw
from . import standards as std
from .library import with_defaults

DEFAULT_SETTINGS = {
    "fluid": "VG46",
    "oilTemp": 50.0,       # 計算に使う作動油温度 ℃（粘度・密度）
    "ambTemp": 30.0,       # 周囲温度 ℃
    "maxTemp": 55.0,       # 許容する油温 ℃
    "tankVolume": 100.0,   # タンク油量 L
    "tankArea": 0.0,       # 放熱面積 m²（0 のときは油量から見積もる）
    "tankK": 12.0,         # タンク表面の熱通過率 W/(m²·K)
}

PASS_THROUGH = {"filter": ("IN", "OUT"), "stop_valve": ("IN", "OUT"), "check": ("IN", "OUT"),
                "cooler": ("IN", "OUT")}

_warm: "OrderedDict[tuple, object]" = OrderedDict()


def _key(end: dict) -> str:
    return f"{end.get('c')}:{end.get('p')}"


def tank_area(volume_l: float) -> float:
    """タンクの放熱面積の見積もり m²。A ≈ 0.065·V^(2/3)（V: L、直方体タンクの一般的な近似）。"""
    return 0.065 * max(volume_l, 1.0) ** (2.0 / 3.0)


def _pipe_diameter(pipe: dict) -> float:
    if not pipe:
        return 0.0
    size = pipe.get("size")
    if size and size in std.PIPES:
        return std.PIPES[size]["id_mm"]
    try:
        return max(float(pipe.get("id_mm") or 0.0), 0.0)
    except (TypeError, ValueError):
        return 0.0


def _fnum(v, default=0.0) -> float:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _classify_wires(comps: dict, wires: list) -> dict:
    """配線の用途（吸込・戻り・圧力・パイロット・ドレン）を接続から決める。"""
    adj = defaultdict(list)
    for w in wires:
        a, b = _key(w["a"]), _key(w["b"])
        adj[a].append((b, w["id"]))
        adj[b].append((a, w["id"]))
    for c in comps.values():
        ports = PASS_THROUGH.get(c["type"])
        if ports:
            a, b = f"{c['id']}:{ports[0]}", f"{c['id']}:{ports[1]}"
            adj[a].append((b, None))
            adj[b].append((a, None))

    def reach(starts):
        seen, hit, stack = set(starts), set(), list(starts)
        while stack:
            t = stack.pop()
            for u, wid in adj.get(t, []):
                if wid:
                    hit.add(wid)
                if u not in seen:
                    seen.add(u)
                    stack.append(u)
        return hit

    suction = reach([f"{c['id']}:S" for c in comps.values() if c["type"] in ("pump_fixed", "pump_var")])
    ret = reach([f"{c['id']}:T" for c in comps.values() if c["type"] == "tank"])
    use = {}
    for w in wires:
        kind = w.get("kind", "main")
        if kind in ("pilot", "drain"):
            use[w["id"]] = kind
        elif w["id"] in suction:
            use[w["id"]] = "suction"
        elif w["id"] in ret:
            use[w["id"]] = "return"
        else:
            use[w["id"]] = "pressure"
    return use


def _run_step(doc_id, step, comps, wires, lib, fluid, pump_flow):
    net = nw.Net()
    connected = set()
    for w in wires:
        connected.add(_key(w["a"]))
        connected.add(_key(w["b"]))
    ctx = models.Ctx(net, fluid, step.get("states") or {}, pump_flow, connected)

    summaries = {}
    for c in comps.values():
        type_def = lib["types"][c["type"]]
        for port in type_def.get("ports", []):
            net.term(f"{c['id']}:{port}")
        builder = models.BUILDERS.get(type_def.get("model", "none"), models.BUILDERS["none"])
        summaries[c["id"]] = builder(c, ctx)

    pipe_els = {}
    for w in wires:
        a, b = _key(w["a"]), _key(w["b"])
        pipe = w.get("pipe") or {}
        d = _pipe_diameter(pipe)
        length, bends = _fnum(pipe.get("len")), _fnum(pipe.get("bends"))
        if d > 0 and (length > 0 or bends > 0):
            pipe_els[w["id"]] = net.add(nw.Pipe("wire:" + w["id"], "pipe", a, b, d, max(length, 0.0),
                                               max(bends, 0.0), ctx.rho, ctx.nu, std.K_ELBOW))
        else:
            net.connect_ideal(w["id"], a, b)
    net.finalize()

    cache_key = (doc_id, step.get("id"), net.n, len(net.elements))
    p, info = net.solve(_warm.get(cache_key))
    if not info["converged"]:
        p, info = net.solve(None, max_iter=800)
    _warm[cache_key] = p
    _warm.move_to_end(cache_key)
    while len(_warm) > 128:
        _warm.popitem(last=False)

    el_res = net.element_flows(p)
    inj = defaultdict(float)
    by_comp = defaultdict(dict)
    totals = {"shaft": 0.0, "pump_out": 0.0, "mech": 0.0, "heat": 0.0, "cooling": 0.0}
    for el, loc, q in el_res:
        for k, t in enumerate(el.terms):
            inj[t] -= q[k]
        pw = el.power(loc, q)
        by_comp[el.comp][el.name] = {"el": el, "p": loc, "q": q, "pw": pw}
        totals["shaft"] += pw["shaft"]
        totals["mech"] += pw["mech"]
        totals["heat"] += pw["heat"]
        if el.kind == "pump":
            totals["pump_out"] += -pw["hyd"]
    wire_q = net.wire_flows(inj)

    wire_out = {}
    for w in wires:
        a, b = _key(w["a"]), _key(w["b"])
        d = _pipe_diameter(w.get("pipe") or {})
        pa, pb = net.pressure(p, a), net.pressure(p, b)
        el = pipe_els.get(w["id"])
        if el is not None:
            q = by_comp["wire:" + w["id"]]["pipe"]["q"][0]
            heat = by_comp["wire:" + w["id"]]["pipe"]["pw"]["heat"] * 1000.0
        else:
            q = wire_q.get(w["id"], 0.0)
            heat = 0.0
        item = {"q": q, "pa": pa, "pb": pb, "dp": pa - pb, "heat": heat}
        if d > 0:
            v = 21.22 * abs(q) / (d * d)
            item["v"] = v
            item["re"] = v * d / ctx.nu * 1e3
        wire_out[w["id"]] = item

    comp_out = {}
    for c in comps.values():
        cid = c["id"]
        type_def = lib["types"][c["type"]]
        r = models.R(cid, net, p, by_comp.get(cid, {}))
        res = summaries[cid](r)
        vals, labels = res[0], res[1]
        extra = res[2] if len(res) > 2 else {}
        ports = {}
        for port in type_def.get("ports", []):
            t = f"{cid}:{port}"
            ports[port] = {"p": net.pressure(p, t), "q": inj.get(t, 0.0)}
        heat = r.heat() * 1000.0
        totals["cooling"] += extra.get("cooling", 0.0)
        comp_out[cid] = {"values": vals, "labels": labels, "ports": ports, "heat": heat, "extra": extra}

    return {
        "id": step.get("id"),
        "name": step.get("name", ""),
        "converged": info["converged"],
        "iterations": info["iterations"],
        "residual": info["residual"],
        "wires": wire_out,
        "comps": comp_out,
        "totals": totals,
        "notes": ctx.notes,
        "_net": net,
        "_p": p,
    }


def _auto_duration(step_res, comps) -> float | None:
    times = []
    for cid, out in step_res["comps"].items():
        t = out["extra"].get("stroke_time")
        if t:
            times.append(t)
    return max(times) if times else None


def analyze(doc: dict, lib: dict) -> dict:
    settings = dict(DEFAULT_SETTINGS)
    settings.update({k: v for k, v in (doc.get("settings") or {}).items() if v is not None})
    for k in ("oilTemp", "ambTemp", "maxTemp", "tankVolume", "tankArea", "tankK"):
        settings[k] = _fnum(settings.get(k), DEFAULT_SETTINGS[k])
    fluid = std.fluid_props(str(settings.get("fluid", "VG46")), settings["oilTemp"])

    comps = OrderedDict()
    unknown = []
    for raw in doc.get("components") or []:
        c = with_defaults(raw, lib)
        if c is None:
            unknown.append(raw.get("type"))
            continue
        comps[c["id"]] = c
    wires = [w for w in (doc.get("wires") or [])
             if w.get("a", {}).get("c") in comps and w.get("b", {}).get("c") in comps]

    steps = doc.get("steps") or []
    if not steps:
        steps = [{"id": "_default", "name": "定常", "duration": 0, "states": {}}]

    pump_flow = 0.0
    for c in comps.values():
        if c["type"] in ("pump_fixed", "pump_var"):
            pump_flow += (models.num(c, "disp", 0) * models.num(c, "speed", 0) / 1000.0
                          * min(models.num(c, "eta_v", 100) / 100.0, 1.0))

    doc_id = str(doc.get("id") or "default")
    diags: list[dict] = []
    seen_diag = {}

    def diag(level, msg, ref=None, step=None):
        key = (level, msg, ref)
        if key in seen_diag:
            if step and step not in seen_diag[key]["steps"]:
                seen_diag[key]["steps"].append(step)
            return
        item = {"level": level, "msg": msg, "ref": ref, "steps": [step] if step else []}
        seen_diag[key] = item
        diags.append(item)

    for t in sorted(set(filter(None, unknown))):
        diag("warn", f"ライブラリにない機器「{t}」は計算から外しました。")

    step_results = []
    for step in steps:
        res = _run_step(doc_id, step, comps, wires, lib, fluid, pump_flow)
        dur = _fnum(step.get("duration"))
        auto = _auto_duration(res, comps)
        res["duration"] = dur if dur > 0 else (auto if auto else 1.0)
        res["durationAuto"] = dur <= 0
        step_results.append(res)

    # ---- 診断 -------------------------------------------------------------
    uses = _classify_wires(comps, wires)
    connected = set()
    for w in wires:
        connected.add(_key(w["a"]))
        connected.add(_key(w["b"]))

    for c in comps.values():
        type_def = lib["types"][c["type"]]
        optional = set(type_def.get("optionalPorts", []))
        if c["type"] == "junction":
            continue
        missing = [p for p in type_def.get("ports", [])
                   if f"{c['id']}:{p}" not in connected and p not in optional]
        if missing and len(missing) == len(type_def.get("ports", [])):
            diag("warn", "どのポートも配管されていません。", c["id"])
        elif missing:
            diag("info", f"未接続のポート: {', '.join(missing)}（閉止として計算）", c["id"])
        if c["type"] == "stack":
            for msg in models.stack_order_notes(c):
                diag("warn", msg, c["id"])

    has_relief = any(c["type"] == "relief" or (c["type"] == "stack" and any(
        l.get("kind") == "relief" and l.get("line") == "P" for l in c["params"].get("layers") or []))
        for c in comps.values())
    relief_sets = [models.num(c, "p_set") for c in comps.values() if c["type"] == "relief"]

    for c in comps.values():
        if c["type"] == "pump_var" and relief_sets:
            if min(relief_sets) <= models.num(c, "p_comp"):
                diag("warn", "リリーフ弁の設定圧力がポンプのカットオフ圧力以下です。"
                             "ポンプが吐出量を絞る前にリリーフ弁が開き、常に発熱します。", c["id"])
        if c["type"] == "pump_fixed" and not has_relief:
            diag("warn", "定容量形ポンプの回路にリリーフ弁がありません。", c["id"])
        if c["type"] == "cyl_double" and models.num(c, "rod") >= models.num(c, "bore"):
            diag("error", "ロッド径がシリンダ内径以上です。", c["id"])

    wire_summary = {}
    for res in step_results:
        name = res["name"]
        if not res["converged"]:
            diag("warn", "計算が収束しませんでした。弁の開閉が定まらない回路の可能性があります"
                         "（パイロット操作逆止め弁と絞りの組合せなど）。", None, name)
        for note in res["notes"]:
            diag(note["level"], note["msg"], note.get("ref"), name)
        for c in comps.values():
            out = res["comps"][c["id"]]
            if c["type"] in ("pump_fixed", "pump_var"):
                p_out = out["ports"]["P"]["p"]
                p_in = out["ports"]["S"]["p"]
                rated = models.num(c, "p_rated", 21.0)
                if p_out > rated * 1.5:
                    diag("error", f"吐出圧力が {p_out:.0f} MPa まで上がります。吐出側が閉じているのに"
                                  "逃がす弁がありません（リリーフ弁の有無と設定圧力を確認）。", c["id"], name)
                elif p_out > rated * 1.001:
                    diag("warn", f"吐出圧力 {p_out:.1f} MPa がポンプの定格圧力 {rated:g} MPa を超えています。",
                         c["id"], name)
                if p_in * 1000.0 < std.SUCTION_MIN_KPA:
                    diag("warn", f"ポンプ吸込圧力が {p_in * 1000:.1f} kPa です。"
                                 f"{std.SUCTION_MIN_KPA} kPa より低いとキャビテーションのおそれがあります。",
                         c["id"], name)
            if c["type"] == "cyl_double":
                v = abs(out["extra"].get("velocity") or 0.0)
                if v > 0.5:
                    diag("info", f"シリンダ速度が {v * 1000:.0f} mm/s です。"
                                 "パッキンとクッションの許容速度を確認してください。", c["id"], name)
        for w in wires:
            wr = res["wires"][w["id"]]
            ws = wire_summary.setdefault(w["id"], {"q_max": 0.0, "p_max": 0.0, "v_max": 0.0})
            ws["q_max"] = max(ws["q_max"], abs(wr["q"]))
            ws["p_max"] = max(ws["p_max"], wr["pa"], wr["pb"])
            ws["v_max"] = max(ws["v_max"], wr.get("v", 0.0))

    for w in wires:
        ws = wire_summary.get(w["id"], {"q_max": 0.0, "p_max": 0.0, "v_max": 0.0})
        use = uses.get(w["id"], "pressure")
        ws["use"] = use
        guide = std.VELOCITY_GUIDE.get(use, std.VELOCITY_GUIDE["pressure"])
        ws["guide"] = list(guide)
        sug = std.suggest_pipe(use, ws["q_max"], ws["p_max"]) if ws["q_max"] > 0.05 else None
        ws["suggest"] = sug["id"] if sug else None
        if ws["v_max"] > guide[1] * 1.001:
            label = {"suction": "吸込", "return": "戻り", "pressure": "圧力",
                     "pilot": "パイロット", "drain": "ドレン"}[use]
            diag("warn", f"{label}配管の流速が {ws['v_max']:.1f} m/s です"
                         f"（目安 {guide[0]:g}～{guide[1]:g} m/s）。管径を上げてください。", w["id"])
        wire_summary[w["id"]] = ws

    # ---- サイクル平均と熱収支 ------------------------------------------------
    total_t = sum(r["duration"] for r in step_results) or 1.0
    heat_avg = sum(r["totals"]["heat"] * r["duration"] for r in step_results) / total_t
    shaft_avg = sum(r["totals"]["shaft"] * r["duration"] for r in step_results) / total_t
    mech_avg = sum(r["totals"]["mech"] * r["duration"] for r in step_results) / total_t
    cool_avg = sum(r["totals"]["cooling"] * r["duration"] for r in step_results) / total_t
    shaft_rms = math.sqrt(sum(r["totals"]["shaft"] ** 2 * r["duration"] for r in step_results) / total_t)
    shaft_peak = max((r["totals"]["shaft"] for r in step_results), default=0.0)

    volume = max(settings["tankVolume"], 1.0)
    area = settings["tankArea"] if settings["tankArea"] > 0 else tank_area(volume)
    ka = max(settings["tankK"], 0.1) * area / 1000.0                  # kW/K
    net_heat = max(heat_avg - cool_avg, 0.0)
    rise = net_heat / ka
    t_steady = settings["ambTemp"] + rise
    capacity = volume / 1000.0 * fluid["rho"] * fluid["cp"]           # kJ/K
    tau = capacity / ka                                               # s
    allow = ka * max(settings["maxTemp"] - settings["ambTemp"], 0.0)  # タンクだけで逃がせる熱 kW
    cooler_need = max(heat_avg - allow, 0.0)
    curve = []
    for i in range(0, 41):
        t = tau * 5.0 * i / 40.0
        curve.append([t / 3600.0, settings["ambTemp"] + rise * (1.0 - math.exp(-t / tau))])

    motor = std.pick_motor(shaft_rms, shaft_peak) if shaft_peak > 0 else None

    if heat_avg > 0.001:
        if t_steady > settings["maxTemp"] + 0.05:
            diag("warn", f"推定油温 {t_steady:.0f} ℃ が許容 {settings['maxTemp']:.0f} ℃ を超えます。"
                         f"クーラの交換熱量を {cooler_need:.2f} kW 以上にするか、発熱を減らしてください。")
    if pump_flow > 0 and volume < 3.0 * pump_flow:
        diag("info", f"タンク油量 {volume:.0f} L はポンプ吐出量 {pump_flow:.0f} L/min の 3 倍未満です"
                     "（一般的な目安は 3～5 倍）。")
    if abs(settings["oilTemp"] - t_steady) > 15 and heat_avg > 0.001:
        diag("info", f"計算に使った油温 {settings['oilTemp']:.0f} ℃ と推定油温 {t_steady:.0f} ℃ が"
                     "離れています。粘度が変わるので、油温の設定を見直してください。")

    for res in step_results:
        res.pop("_net", None)
        res.pop("_p", None)
        res.pop("notes", None)
        t = res["totals"]
        t["balance"] = t["shaft"] - t["mech"] - t["heat"]

    order = {"error": 0, "warn": 1, "info": 2}
    diags.sort(key=lambda d: order.get(d["level"], 3))

    return {
        "ok": True,
        "fluid": fluid,
        "settings": settings,
        "steps": step_results,
        "wires": wire_summary,
        "cycle": {
            "time": total_t,
            "heat": heat_avg,
            "shaft": shaft_avg,
            "mech": mech_avg,
            "cooling": cool_avg,
            "shaftRms": shaft_rms,
            "shaftPeak": shaft_peak,
            "motor": motor,
            "pumpFlow": pump_flow,
            "efficiency": (mech_avg / shaft_avg * 100.0) if shaft_avg > 1e-9 else None,
        },
        "thermal": {
            "area": area,
            "areaAuto": settings["tankArea"] <= 0,
            "ka": ka * 1000.0,           # W/K
            "rise": rise,
            "steady": t_steady,
            "tau": tau,
            "tankDissipation": min(net_heat, ka * rise),
            "tankAllow": allow,
            "coolerNeed": cooler_need,
            "curve": curve,
        },
        "diagnostics": diags,
    }
