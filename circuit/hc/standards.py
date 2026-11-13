"""規格・物性データ。

数値の出典は README.md の「出典」を参照。
ここに置くのは「回路計算で共通に使う表」だけで、機器ごとの値は library/*.json に置く。
"""
from __future__ import annotations

import math

# ---------------------------------------------------------------------------
# 作動油
# ---------------------------------------------------------------------------
# nu40 / nu100: 動粘度 mm²/s（粘度指数 105 前後の石油系作動油の代表値）
# rho15: 密度 kg/m³（15 ℃）
FLUIDS = {
    "VG32": {"name": "石油系作動油 ISO VG32", "nu40": 32.0, "nu100": 5.4, "rho15": 872.0},
    "VG46": {"name": "石油系作動油 ISO VG46", "nu40": 46.0, "nu100": 6.8, "rho15": 876.0},
    "VG68": {"name": "石油系作動油 ISO VG68", "nu40": 68.0, "nu100": 8.7, "rho15": 880.0},
}

OIL_EXPANSION = 0.00065   # 体膨張係数 1/K（石油系の一般値）
OIL_SPECIFIC_HEAT = 1.88  # 比熱 kJ/(kg·K)（石油系の一般値）
BULK_MODULUS = 1.6        # 体積弾性係数 GPa（石油系。東京計器 技術資料 21）


def _walther(nu: float) -> float:
    return math.log10(math.log10(nu + 0.7))


def viscosity(fluid: str, temp_c: float) -> float:
    """動粘度 mm²/s。ASTM D341（Walther 式）で 40 ℃ と 100 ℃ の 2 点から補間する。"""
    f = FLUIDS.get(fluid) or FLUIDS["VG46"]
    t1, t2 = 313.15, 373.15
    w1, w2 = _walther(f["nu40"]), _walther(f["nu100"])
    b = (w1 - w2) / (math.log10(t2) - math.log10(t1))
    a = w1 + b * math.log10(t1)
    t = max(temp_c, -20.0) + 273.15
    return 10 ** (10 ** (a - b * math.log10(t))) - 0.7


def density(fluid: str, temp_c: float) -> float:
    """密度 kg/m³。"""
    f = FLUIDS.get(fluid) or FLUIDS["VG46"]
    return f["rho15"] * (1.0 - OIL_EXPANSION * (temp_c - 15.0))


def fluid_props(fluid: str, temp_c: float) -> dict:
    return {
        "fluid": fluid if fluid in FLUIDS else "VG46",
        "name": (FLUIDS.get(fluid) or FLUIDS["VG46"])["name"],
        "temp": temp_c,
        "nu": viscosity(fluid, temp_c),
        "rho": density(fluid, temp_c),
        "cp": OIL_SPECIFIC_HEAT,
    }


# ---------------------------------------------------------------------------
# 配管（東京計器 技術資料「油圧配管選定表」付 1-4）
#   JIS G 3454 STPG370 Sch40 / Sch80、JIS G 3455 STS370 Sch160
#   (呼び径 A, 呼び径 B, 外径 mm, {スケジュール: (厚さ mm, 内径 mm)})
# ---------------------------------------------------------------------------
_PIPE_ROWS = [
    (6, "1/8", 10.5, {"40": (1.7, 7.1), "80": (2.4, 5.7)}),
    (8, "1/4", 13.8, {"40": (2.2, 9.4), "80": (3.0, 7.8)}),
    (10, "3/8", 17.3, {"40": (2.3, 12.7), "80": (3.2, 10.9)}),
    (15, "1/2", 21.7, {"40": (2.8, 16.1), "80": (3.7, 14.3), "160": (4.7, 12.3)}),
    (20, "3/4", 27.2, {"40": (2.9, 21.4), "80": (3.9, 19.4), "160": (5.5, 16.2)}),
    (25, "1", 34.0, {"40": (3.4, 27.2), "80": (4.5, 25.0), "160": (6.4, 21.2)}),
    (32, "1-1/4", 42.7, {"40": (3.6, 35.5), "80": (4.9, 32.9), "160": (6.4, 29.9)}),
    (40, "1-1/2", 48.6, {"40": (3.7, 41.2), "80": (5.1, 38.4), "160": (7.1, 34.4)}),
    (50, "2", 60.5, {"40": (3.9, 52.7), "80": (5.5, 49.5), "160": (8.7, 43.1)}),
    (65, "2-1/2", 76.3, {"40": (5.2, 65.9), "80": (7.0, 62.3), "160": (9.5, 57.3)}),
    (80, "3", 89.1, {"40": (5.5, 78.1), "80": (7.6, 73.9), "160": (11.1, 66.9)}),
    (90, "3-1/2", 101.6, {"40": (5.7, 90.2), "80": (8.1, 85.4), "160": (12.7, 76.2)}),
    (100, "4", 114.3, {"40": (6.0, 102.3), "80": (8.6, 97.1), "160": (13.5, 87.3)}),
    (125, "5", 139.8, {"40": (6.6, 126.6), "80": (9.5, 120.8), "160": (15.9, 108.0)}),
]

_SCH_NAME = {
    "40": "STPG370 Sch40",
    "80": "STPG370 Sch80",
    "160": "STS370 Sch160",
}


def pipe_table() -> list[dict]:
    """画面と計算で使う配管の一覧。id は '15A-80' の形。"""
    out = []
    for a, b, od, sch in _PIPE_ROWS:
        for s, (t, d) in sch.items():
            out.append({
                "id": f"{a}A-{s}",
                "a": a, "b": b, "od": od, "sch": s, "t": t, "id_mm": d,
                "label": f"{a}A ({b}B) {_SCH_NAME[s]}  内径 {d:g}",
            })
    return out


PIPES = {p["id"]: p for p in pipe_table()}

# 管内流速の目安 m/s（同 付 1-4 注記）: (下限, 上限, 標準)
VELOCITY_GUIDE = {
    "suction": (0.5, 1.5, 1.0),
    "pressure": (2.5, 6.0, 4.0),
    "return": (1.5, 4.0, 2.5),
    "pilot": (0.0, 6.0, 3.0),
    "drain": (0.0, 1.5, 1.0),
}

# 管継手の損失係数（同 付 1-7 の 24）
K_ELBOW = 1.2
K_TEE = 1.5

# ポンプ吸込口の許容圧力（同 付 1-4 注記。石油系: +35 ～ -16.7 kPa）
SUCTION_MIN_KPA = -16.7

# 電動機の標準出力 kW
MOTOR_KW = [0.2, 0.4, 0.75, 1.5, 2.2, 3.7, 5.5, 7.5, 11, 15, 18.5, 22, 30, 37, 45, 55, 75, 90, 110]
# 短時間の過負荷の目安（同 付 1-6 の表。定格時間 5 分で 150 %）
MOTOR_OVERLOAD = 1.5


def pick_motor(rms_kw: float, peak_kw: float) -> float | None:
    need = max(rms_kw, peak_kw / MOTOR_OVERLOAD)
    for kw in MOTOR_KW:
        if kw >= need - 1e-9:
            return kw
    return None


def pipe_schedule_for(kind: str, pressure_mpa: float) -> str:
    """用途と圧力から、よく使うスケジュールを返す（目安）。"""
    if kind in ("suction", "return", "drain"):
        return "40"
    return "160" if pressure_mpa > 14.0 else "80"


def suggest_pipe(kind: str, flow_lpm: float, pressure_mpa: float) -> dict | None:
    """標準流速以下になる最小の管を返す。"""
    if flow_lpm <= 0:
        return None
    sch = pipe_schedule_for(kind, pressure_mpa)
    v_std = VELOCITY_GUIDE.get(kind, VELOCITY_GUIDE["pressure"])[2]
    for a, _b, _od, schs in _PIPE_ROWS:
        s = sch if sch in schs else "80"
        d = schs[s][1]
        v = 21.22 * flow_lpm / (d * d)
        if v <= v_std:
            return PIPES[f"{a}A-{s}"]
    return PIPES[f"125A-{sch if sch in _PIPE_ROWS[-1][3] else '80'}"]


def standards_payload() -> dict:
    """画面に渡す規格データ。"""
    return {
        "fluids": [{"id": k, "name": v["name"]} for k, v in FLUIDS.items()],
        "pipes": pipe_table(),
        "velocity": VELOCITY_GUIDE,
        "motors": MOTOR_KW,
    }
