"""管路網の要素とソルバー。

単位: 圧力 MPa（ゲージ）、流量 L/min、動力 kW。

考え方
- 回路を「節点（同じ圧力の点）」と「要素（節点間に流量を流すもの）」に分ける。
- 各要素は、端子の圧力から「節点から要素へ流れ出る流量」を返す（flows）。
- 節点ごとに流量の和が 0 になる圧力を、減衰つきニュートン法（擬似時間進行）で求める。

式の出典は README.md の「出典」を参照。
"""
from __future__ import annotations

import math

import numpy as np

# --- 数値定数 ---------------------------------------------------------------
_EPS2 = 1e-8          # 平方根特性を 0 付近でなめらかにする幅 (1e-4 MPa)²
G_LEAK = 1e-6         # 全節点からタンクへの微小な漏れ L/min/MPa（孤立節点の特異性を防ぐ）
P_VAC = -0.098        # これより下がらない圧力 MPa（ほぼ絶対真空）
G_CAV = 1e4           # P_VAC を下回ったときに補う流量の傾き L/min/MPa
DP_STEP_MAX = 8.0     # 1 回の反復で動かす圧力の上限 MPa


def sqrt_flow(dp: float, k: float) -> float:
    """q = k·sign(dp)·√|dp|（0 付近は直線でつなぐ）。"""
    return k * dp / (dp * dp + _EPS2) ** 0.25


def pos_sqrt_flow(dp: float, k: float) -> float:
    return k * dp / (dp * dp + _EPS2) ** 0.25 if dp > 0.0 else 0.0


def clamp01(x: float) -> float:
    return 0.0 if x <= 0.0 else (1.0 if x >= 1.0 else x)


def k_from_rated(q0: float, dp0: float) -> float:
    """定格流量 q0 で圧力損失 dp0 の機器の流量係数。ΔP = ΔP0·(Q/Q0)²（東京計器 技術資料 22）。"""
    if q0 <= 0.0 or dp0 <= 0.0:
        return 0.0
    return q0 / math.sqrt(dp0)


def k_from_diameter(d_mm: float, cd: float, rho: float) -> float:
    """絞り径 d の流量係数。Q = 60·k·A·√(2ΔP/ρ)（A mm²、同 27）。"""
    if d_mm <= 0.0:
        return 0.0
    area = math.pi * d_mm * d_mm / 4.0
    return 60.0 * cd * area * math.sqrt(2.0 / rho)


def deadband(x: float, lo: float, hi: float) -> float:
    """lo ≤ x ≤ hi の間は 0、外側ははみ出した分を返す。"""
    if lo > hi:
        lo = hi = 0.5 * (lo + hi)
    if x > hi:
        return x - hi
    if x < lo:
        return x - lo
    return 0.0


# ---------------------------------------------------------------------------
# 要素
# ---------------------------------------------------------------------------
class Element:
    """管路網の要素。terms は流量が出入りする端子、sense は圧力だけを見る端子。"""

    kind = "element"

    def __init__(self, comp: str, name: str, terms, sense=()):
        self.comp = comp
        self.name = name
        self.terms = list(terms)
        self.sense = list(sense)
        self.idx: list[int] = []   # terms + sense の節点番号（-1 はタンク = 0 MPa）

    # p は terms + sense の順の圧力。戻り値は terms の順に「節点から要素へ流れ出る流量」
    def flows(self, p):  # pragma: no cover - 派生クラスで実装
        raise NotImplementedError

    def power(self, p, q) -> dict:
        """要素が受け取る流体動力 kW と、その行き先。受動要素はすべて熱。"""
        hyd = sum(pi * qi for pi, qi in zip(p, q)) / 60.0
        return {"hyd": hyd, "heat": hyd, "mech": 0.0, "shaft": 0.0}


class Orifice(Element):
    kind = "orifice"

    def __init__(self, comp, name, a, b, k):
        super().__init__(comp, name, (a, b))
        self.k = k

    def flows(self, p):
        q = sqrt_flow(p[0] - p[1], self.k)
        return (q, -q)


class Linear(Element):
    """層流の抵抗（フィルタエレメントなど）。q = g·Δp"""
    kind = "linear"

    def __init__(self, comp, name, a, b, g):
        super().__init__(comp, name, (a, b))
        self.g = g

    def flows(self, p):
        q = self.g * (p[0] - p[1])
        return (q, -q)


class Check(Element):
    """逆止め弁。a → b が自由流れ。"""
    kind = "check"

    def __init__(self, comp, name, a, b, k, crack):
        super().__init__(comp, name, (a, b))
        self.k = k
        self.crack = crack

    def flows(self, p):
        q = pos_sqrt_flow(p[0] - p[1] - self.crack, self.k)
        return (q, -q)


class Relief(Element):
    """リリーフ弁。クラッキング圧から開き、設定圧で調整時流量が流れる直線特性。"""
    kind = "relief"

    def __init__(self, comp, name, a, b, p_set, p_crack, q_adj):
        super().__init__(comp, name, (a, b))
        self.p_set = p_set
        self.p_crack = min(p_crack, p_set - 1e-3)
        self.gain = max(q_adj, 1e-3) / (p_set - self.p_crack)

    def flows(self, p):
        d = p[0] - p[1] - self.p_crack
        q = d * self.gain if d > 0.0 else 0.0
        return (q, -q)


class FlowControl(Element):
    """圧力補償付き流量調整弁。差圧が最小作動差圧を超えると設定流量で一定。"""
    kind = "flow_control"

    def __init__(self, comp, name, a, b, q_set, dp_min):
        super().__init__(comp, name, (a, b))
        self.q_set = max(q_set, 0.0)
        self.dp_min = max(dp_min, 0.05)
        self.k = self.q_set / math.sqrt(self.dp_min)

    def flows(self, p):
        d = p[0] - p[1]
        if d <= 0.0:
            return (0.0, 0.0)
        if d < self.dp_min:
            q = sqrt_flow(d, self.k)
        else:
            q = self.q_set * (1.0 + 1e-4 * (d - self.dp_min))
        return (q, -q)


class Reducing(Element):
    """減圧弁。二次側（または sense 端子）の圧力が設定圧に近づくと閉じる。"""
    kind = "reducing"

    def __init__(self, comp, name, a, b, k, p_set, band, sense=None):
        super().__init__(comp, name, (a, b), (sense,) if sense else ())
        self.k = k
        self.p_set = p_set
        self.band = max(band, 1e-3)

    def flows(self, p):
        ps = p[2] if len(p) > 2 else p[1]
        x = clamp01((self.p_set - ps) / self.band)
        q = x * sqrt_flow(p[0] - p[1], self.k)
        return (q, -q)


class Sequence(Element):
    """シーケンス弁・カウンタバランス弁の主弁。パイロット圧が設定圧を超えると a → b に開く。"""
    kind = "sequence"

    def __init__(self, comp, name, a, b, k, p_set, band, pilot=None):
        super().__init__(comp, name, (a, b), (pilot,) if pilot else ())
        self.k = k
        self.p_set = p_set
        self.band = max(band, 1e-3)

    def flows(self, p):
        pp = p[2] if len(p) > 2 else p[0]
        x = clamp01((pp - self.p_set) / self.band)
        q = x * pos_sqrt_flow(p[0] - p[1], self.k)
        return (q, -q)


class PilotCheck(Element):
    """パイロット操作逆止め弁。a → b は自由流れ、b → a はパイロット圧 x で開く。"""
    kind = "pilot_check"

    def __init__(self, comp, name, a, b, x, k, crack, ratio):
        super().__init__(comp, name, (a, b), (x,))
        self.k = k
        self.crack = crack
        self.ratio = max(ratio, 1.0)

    def flows(self, p):
        pa, pb, px = p[0], p[1], p[2]
        d = pa - pb - self.crack
        if d > 0.0:
            q = pos_sqrt_flow(d, self.k)
            return (q, -q)
        opening = clamp01((px * self.ratio - pb - self.crack) / (0.05 * self.ratio + 0.02 * abs(pb)))
        q = -opening * pos_sqrt_flow(pb - pa, self.k)
        return (q, -q)


class Pipe(Element):
    """直管 + エルボ。東京計器 技術資料 23・24 の式。"""
    kind = "pipe"

    def __init__(self, comp, name, a, b, d_mm, length_m, bends, rho, nu, k_bend=1.2):
        super().__init__(comp, name, (a, b))
        self.d = d_mm
        self.length = length_m
        self.rho = rho
        self.nu = nu
        self.cv = 21.22 / (d_mm * d_mm)                       # v = cv·Q  (m/s)
        self.a_lam = 64.0 * nu * rho * length_m / (2.0e6 * d_mm * d_mm) * self.cv
        self.b_turb = (0.3164 * (d_mm * 1e3 / nu) ** -0.25
                       * rho * length_m / (2000.0 * d_mm) * self.cv ** 1.75)
        self.c_loc = bends * k_bend * rho / 2.0 * 1e-6 * self.cv ** 2
        self.q_crit = 2000.0 * nu / (d_mm * 1e3) / self.cv    # Re = 2000 の流量
        qc = self.q_crit
        self.dp_lam_c = self.a_lam * qc + self.c_loc * qc * qc
        self.dp_turb_c = self.b_turb * qc ** 1.75 + self.c_loc * qc * qc

    def dp_of(self, q: float) -> float:
        a = abs(q)
        if a <= self.q_crit:
            d = self.a_lam * a + self.c_loc * a * a
        else:
            d = self.b_turb * a ** 1.75 + self.c_loc * a * a
        return math.copysign(d, q)

    def q_of(self, dp: float) -> float:
        a = abs(dp)
        if a <= 0.0:
            return 0.0
        if a <= self.dp_lam_c:
            if self.c_loc <= 0.0:
                q = a / self.a_lam if self.a_lam > 0 else 0.0
            elif self.a_lam <= 0.0:
                q = math.sqrt(a / self.c_loc)
            else:
                disc = self.a_lam * self.a_lam + 4.0 * self.c_loc * a
                q = (-self.a_lam + math.sqrt(disc)) / (2.0 * self.c_loc)
        elif a <= self.dp_turb_c:
            q = self.q_crit
        else:
            q = max(self.q_crit, 1e-6)
            for _ in range(30):
                f = self.b_turb * q ** 1.75 + self.c_loc * q * q - a
                df = 1.75 * self.b_turb * q ** 0.75 + 2.0 * self.c_loc * q
                step = f / df
                q -= step
                if abs(step) < 1e-10 * max(q, 1.0):
                    break
        return math.copysign(q, dp)

    def flows(self, p):
        q = self.q_of(p[0] - p[1])
        return (q, -q)

    def velocity(self, q: float) -> float:
        return self.cv * abs(q)

    def reynolds(self, q: float) -> float:
        return self.velocity(q) * self.d / self.nu * 1e3


def _cavitation(p_suction: float) -> float:
    """吸込圧が真空に近づくと吐出量が落ちる（解が発散しないための歯止め）。"""
    return clamp01((p_suction + 0.095) / 0.015)


class PumpFixed(Element):
    """定容量形ポンプ。端子は (吸込, 吐出)。"""
    kind = "pump"

    def __init__(self, comp, name, s, p, q_th, k_leak, eta_m):
        super().__init__(comp, name, (s, p))
        self.q_th = q_th
        self.k_leak = k_leak
        self.eta_m = max(eta_m, 0.05)

    def displaced(self, p):
        return self.q_th * _cavitation(p[0])

    def flows(self, p):
        q = self.displaced(p) - self.k_leak * max(p[1] - p[0], 0.0)
        return (q, -q)

    def power(self, p, q):
        dp = p[1] - p[0]
        out = dp * (-q[1]) / 60.0                       # 流体へ渡した動力
        shaft = max(dp, 0.0) * self.displaced(p) / (60.0 * self.eta_m)
        return {"hyd": -out, "heat": max(shaft - out, 0.0), "mech": 0.0, "shaft": shaft}


class PumpCompensated(PumpFixed):
    """圧力補償形の可変容量形ポンプ。設定圧の手前 band から吐出量を絞る。"""
    kind = "pump"

    def __init__(self, comp, name, s, p, q_max, k_leak, eta_m, p_set, band):
        super().__init__(comp, name, s, p, q_max, k_leak, eta_m)
        self.p_set = p_set
        self.band = max(band, 0.05)

    def displaced(self, p):
        x = clamp01((self.p_set - p[1]) / self.band)
        return self.q_th * x * _cavitation(p[0])


class Cylinder(Element):
    """複動片ロッドシリンダ。端子は (ヘッド側, ロッド側)。

    伸び方向を正とする。負荷は「伸びに逆らう力 f_ext」と「縮みに逆らう力 f_ret」[N]。
    流体力が負荷を超えた分に比例して動く（gain は十分大きく、速度はほぼ流量で決まる）。
    """
    kind = "cylinder"

    def __init__(self, comp, name, h, r, a_head, a_rod, f_ext, f_ret, eta, stalled=False):
        super().__init__(comp, name, (h, r))
        self.ah = a_head            # cm²
        self.ar = a_rod             # cm²
        self.f_ext = f_ext
        self.f_ret = f_ret
        self.eta = min(max(eta, 0.05), 1.0)
        self.stalled = stalled
        f_ref = max(abs(f_ext), abs(f_ret), 100.0 * a_head)   # 1 MPa 相当の推力を下限に
        self.gain = 0.5 / (0.01 * f_ref)                      # m/s per N

    def force(self, p) -> float:
        return (p[0] * self.ah - p[1] * self.ar) * 100.0      # N

    def velocity(self, p) -> float:
        if self.stalled:
            return 0.0
        return self.gain * deadband(self.force(p), -self.f_ret / self.eta, self.f_ext / self.eta)

    def flows(self, p):
        v = self.velocity(p)
        return (6.0 * self.ah * v, -6.0 * self.ar * v)

    def power(self, p, q):
        v = self.velocity(p)
        hyd = self.force(p) * v / 1000.0
        load = self.f_ext if v > 0 else (-self.f_ret if v < 0 else 0.0)
        mech = load * v / 1000.0
        return {"hyd": hyd, "heat": max(hyd - mech, 0.0), "mech": mech, "shaft": 0.0}


class Motor(Element):
    """定容量形油圧モータ。端子は (A, B)。A → B に流れる向きを正回転とする。"""
    kind = "motor"

    def __init__(self, comp, name, a, b, disp, torque, eta_v, eta_m, stalled=False):
        super().__init__(comp, name, (a, b))
        self.disp = disp            # cm³/rev
        self.torque = torque        # 負荷トルク N·m（回転に逆らう向き）
        self.eta_v = min(max(eta_v, 0.05), 1.0)
        self.eta_m = min(max(eta_m, 0.05), 1.0)
        self.stalled = stalled
        t_ref = max(abs(torque), disp / (2.0 * math.pi))      # 1 MPa 相当のトルクを下限に
        self.gain = 1000.0 / (0.01 * t_ref)                   # min⁻¹ per N·m

    def torque_out(self, p) -> float:
        return (p[0] - p[1]) * self.disp / (2.0 * math.pi) * self.eta_m

    def speed(self, p) -> float:
        if self.stalled:
            return 0.0
        return self.gain * deadband(self.torque_out(p), -self.torque, self.torque)

    def flows(self, p):
        q = self.disp * self.speed(p) / 1000.0 / self.eta_v
        return (q, -q)

    def power(self, p, q):
        n = self.speed(p)
        hyd = (p[0] - p[1]) * q[0] / 60.0
        mech = self.torque * abs(n) * 2.0 * math.pi / 60.0 / 1000.0
        return {"hyd": hyd, "heat": max(hyd - mech, 0.0), "mech": mech, "shaft": 0.0}


# ---------------------------------------------------------------------------
# 管路網
# ---------------------------------------------------------------------------
class Net:
    def __init__(self):
        self.elements: list[Element] = []
        self._parent: dict[str, str] = {}
        self._ground: set[str] = set()
        self.ideal_wires: list[tuple[str, str, str]] = []   # (wire id, 端子 a, 端子 b)
        self.node_of: dict[str, int] = {}
        self.n = 0

    # --- 端子と接続 ---
    def term(self, key: str) -> str:
        if key not in self._parent:
            self._parent[key] = key
        return key

    def _find(self, key: str) -> str:
        self.term(key)
        root = key
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[key] != root:
            self._parent[key], key = root, self._parent[key]
        return root

    def union(self, a: str, b: str) -> None:
        ra, rb = self._find(a), self._find(b)
        if ra != rb:
            self._parent[ra] = rb

    def ground(self, key: str) -> None:
        self.term(key)
        self._ground.add(key)

    def is_ground_term(self, key: str) -> bool:
        return key in self._ground

    def same_node(self, a: str, b: str) -> bool:
        return self._find(a) == self._find(b)

    def add(self, el: Element) -> Element:
        for t in el.terms + el.sense:
            self.term(t)
        self.elements.append(el)
        return el

    def connect_ideal(self, wire_id: str, a: str, b: str) -> None:
        self.union(a, b)
        self.ideal_wires.append((wire_id, a, b))

    def finalize(self) -> None:
        ground_roots = {self._find(k) for k in self._ground}
        index: dict[str, int] = {}
        for key in self._parent:
            root = self._find(key)
            if root in ground_roots:
                self.node_of[key] = -1
            else:
                if root not in index:
                    index[root] = len(index)
                self.node_of[key] = index[root]
        self.n = len(index)
        for el in self.elements:
            el.idx = [self.node_of[t] for t in el.terms + el.sense]

    # --- 計算 ---
    def _local(self, el: Element, p: np.ndarray) -> list[float]:
        return [p[i] if i >= 0 else 0.0 for i in el.idx]

    def residual(self, p: np.ndarray) -> np.ndarray:
        f = np.zeros(self.n)
        for el in self.elements:
            q = el.flows(self._local(el, p))
            for k in range(len(el.terms)):
                i = el.idx[k]
                if i >= 0:
                    f[i] -= q[k]
        f -= G_LEAK * p
        low = p < P_VAC
        if low.any():
            f[low] += G_CAV * (P_VAC - p[low])
        return f

    def jacobian(self, p: np.ndarray) -> np.ndarray:
        n = self.n
        jac = np.zeros((n, n))
        h = 1e-7
        for el in self.elements:
            loc = self._local(el, p)
            q0 = el.flows(loc)
            nt = len(el.terms)
            seen = set()
            for j, nj in enumerate(el.idx):
                if nj < 0 or nj in seen:
                    continue
                seen.add(nj)
                pert = list(loc)
                for m, nm in enumerate(el.idx):     # 同じ節点につながる端子はまとめて動かす
                    if nm == nj:
                        pert[m] += h
                q1 = el.flows(pert)
                for k in range(nt):
                    i = el.idx[k]
                    if i >= 0:
                        jac[i, nj] -= (q1[k] - q0[k]) / h
        idx = np.arange(n)
        jac[idx, idx] -= G_LEAK
        low = p < P_VAC
        if low.any():
            jac[idx[low], idx[low]] -= G_CAV
        return jac

    def solve(self, p0: np.ndarray | None = None, tol: float = 2e-6, max_iter: int = 400):
        """節点圧力を求める。戻り値は (圧力, 情報)。"""
        n = self.n
        info = {"converged": True, "iterations": 0, "residual": 0.0}
        if n == 0:
            return np.zeros(0), info
        p = np.array(p0, dtype=float) if p0 is not None and len(p0) == n else np.zeros(n)
        f = self.residual(p)
        nf = float(np.linalg.norm(f))
        mu = 0.0
        eye = np.eye(n)
        it = 0
        for it in range(1, max_iter + 1):
            if float(np.abs(f).max()) < tol:
                break
            jac = self.jacobian(p)
            best = None
            for _ in range(10):
                try:
                    dp = np.linalg.solve(jac - mu * eye, -f)
                except np.linalg.LinAlgError:
                    mu = max(mu * 10.0, 1e-6)
                    continue
                m = float(np.abs(dp).max())
                if m > DP_STEP_MAX:
                    dp *= DP_STEP_MAX / m
                # 直線探索。弁の開き始めやシリンダの動き始めは折れ点なので、
                # 歩幅を細かく縮めながら残差が下がる所を探す。
                alpha = 1.0
                for _ in range(40):
                    p_try = p + alpha * dp
                    f_try = self.residual(p_try)
                    n_try = float(np.linalg.norm(f_try))
                    if n_try < nf * (1.0 - 1e-4 * alpha):
                        if best is None or n_try < best[0]:
                            best = (n_try, p_try, f_try)
                            if n_try < 0.7 * nf:
                                break
                        else:
                            break
                    elif best is not None:
                        break
                    alpha *= 0.6
                if best is not None:
                    break
                mu = max(mu * 10.0, 1e-4)
            if best is None:
                break
            nf, p, f = best
            mu = mu * 0.1 if mu > 1e-9 else 0.0
        info["iterations"] = it
        final = float(np.abs(f).max())
        info["residual"] = final
        info["converged"] = final < max(tol * 50.0, 1e-4)
        return p, info

    # --- 結果の取り出し ---
    def pressure(self, p: np.ndarray, key: str) -> float:
        i = self.node_of.get(key, -1)
        return float(p[i]) if i >= 0 else 0.0

    def element_flows(self, p: np.ndarray):
        """各要素の (局所圧力, 流量) を返す。"""
        out = []
        for el in self.elements:
            loc = self._local(el, p)
            out.append((el, loc, el.flows(loc)))
        return out

    def wire_flows(self, injection: dict[str, float]) -> dict[str, float]:
        """損失なしの配線に流れる流量（a → b を正）。

        injection は「機器から端子へ流れ込む流量」。配線は木になっている前提で、
        葉から順に流量を確定する。輪になっている場合は 1 本を 0 として切る。
        """
        inj = dict(injection)
        adj: dict[str, list[int]] = {}
        edges = list(self.ideal_wires)
        alive = [True] * len(edges)
        for k, (_w, a, b) in enumerate(edges):
            adj.setdefault(a, []).append(k)
            adj.setdefault(b, []).append(k)
        result: dict[str, float] = {}
        degree = {t: len(v) for t, v in adj.items()}

        def peel(start_leaves):
            queue = list(start_leaves)
            while queue:
                v = queue.pop()
                if degree.get(v, 0) != 1 or self.is_ground_term(v):
                    continue
                k = next((e for e in adj[v] if alive[e]), None)
                if k is None:
                    continue
                w, a, b = edges[k]
                u = b if a == v else a
                flow = inj.get(v, 0.0)
                result[w] = flow if a == v else -flow
                inj[u] = inj.get(u, 0.0) + flow
                alive[k] = False
                degree[v] -= 1
                degree[u] -= 1
                if degree[u] == 1:
                    queue.append(u)

        peel([t for t, d in degree.items() if d == 1])
        # タンク端子が葉として残った木、または輪
        for _ in range(len(edges) + 1):
            rest = [k for k in range(len(edges)) if alive[k]]
            if not rest:
                break
            progressed = False
            for k in rest:
                if not alive[k]:
                    continue
                w, a, b = edges[k]
                for v, u in ((a, b), (b, a)):
                    if degree.get(v, 0) == 1 and self.is_ground_term(v) and degree.get(u, 0) == 1:
                        # 両端とも葉: タンクでない側の流量で決める
                        flow = inj.get(u, 0.0)
                        result[w] = flow if a == u else -flow
                        alive[k] = False
                        degree[v] -= 1
                        degree[u] -= 1
                        progressed = True
                        break
                if progressed:
                    break
            if progressed:
                continue
            # 輪を 1 本切る
            k = rest[0]
            w, a, b = edges[k]
            result[w] = 0.0
            alive[k] = False
            degree[a] -= 1
            degree[b] -= 1
            peel([t for t in (a, b) if degree.get(t, 0) == 1])
        return result
