"""油圧シリンダーの寸法項目の定義

Flask 側と FreeCAD 側の両方から読むので、FreeCAD に依存するものは import しない。
"""
import math

# (キー, 表示名, 既定値 [mm])
CYLINDER_FIELDS = [
    ("bore", "ボア径（チューブ内径）", 63.0),
    ("rod_dia", "ロッド径", 36.0),
    ("stroke", "ストローク", 300.0),
    ("tube_thickness", "チューブ肉厚", 6.0),
    ("cover_size", "カバー角寸法", 90.0),
    ("head_cover_len", "ヘッドカバー長さ", 45.0),
    ("rod_cover_len", "ロッドカバー長さ", 50.0),
    ("piston_width", "ピストン幅", 30.0),
    ("rod_extension", "ロッド突出長さ（縮み切り時）", 40.0),
    ("spigot_depth", "チューブ差し込み深さ", 5.0),
    ("tie_rod_dia", "タイロッド径", 12.0),
    ("tie_rod_pitch", "タイロッド穴ピッチ（□）", 66.0),
    ("port_dia", "ポート下穴径", 18.0),
    ("rod_end_dia", "ロッド先端ねじ径", 27.0),
    ("rod_end_len", "ロッド先端ねじ長さ", 35.0),
]

DEFAULTS = {key: default for key, _, default in CYLINDER_FIELDS}


def normalize(params):
    p = dict(DEFAULTS)
    for key, value in (params or {}).items():
        if key in DEFAULTS:
            p[key] = float(value)
    return p


def derived(p):
    """入力値から決まる細部の寸法（部品形状と入力チェックの両方で使う）"""
    pd = p["port_dia"]
    d = {
        "tube_od": p["bore"] + 2 * p["tube_thickness"],
        "tube_len": p["stroke"] + p["piston_width"] + 2 * p["spigot_depth"],
        "tie_hole": p["tie_rod_dia"] + 1,
        "port_depth": 0.75 * pd,
        "passage": min(8.0, (p["bore"] - p["rod_dia"]) / 4),     # ポートからシリンダー室への通路径
        "passage_r": (p["bore"] + p["rod_dia"]) / 4,              # ロッド側通路の軸心からの距離
        "nut_seat_dia": 1.6 * p["rod_end_dia"],                    # ピストンのナット座ぐり
        "nut_seat_depth": 0.4 * p["piston_width"],
        "packing_dia": 0.76 * p["bore"],                           # ピストンのパッキン溝底径
        "wear_dia": p["bore"] - 4,                                 # ウェアリング溝底径
        "rod_hole": p["rod_dia"] + 0.5,
        "bushing_dia": p["rod_dia"] + 6,
        "dust_seal_dia": p["rod_dia"] + 12,
        "tie_rod_len": (p["head_cover_len"] + p["stroke"] + p["piston_width"]
                        + p["rod_cover_len"] + 3 * p["tie_rod_dia"]),
    }
    # ロッドカバー内の位置（カバー内側端面からの距離）
    d["rod_port_x"] = p["spigot_depth"] + 0.8 * pd
    d["bushing_from"] = d["rod_port_x"] + pd / 2 + 3
    d["bushing_to"] = p["rod_cover_len"] - 8
    return d


def validate(p):
    labels = {key: label for key, label, _ in CYLINDER_FIELDS}
    errors = [f"{labels[key]}は正の値にしてください" for key, value in p.items() if value <= 0]
    if errors:
        return errors
    d = derived(p)
    if p["rod_dia"] >= p["bore"]:
        errors.append("ロッド径はボア径より小さくしてください")
    if d["tube_od"] >= p["cover_size"]:
        errors.append("カバー角寸法はチューブ外径より大きくしてください")
    if 2 * p["spigot_depth"] >= min(p["head_cover_len"], p["rod_cover_len"]):
        errors.append("チューブ差し込み深さはカバー長さの半分より小さくしてください")
    if p["rod_end_dia"] >= p["rod_dia"]:
        errors.append("ロッド先端ねじ径はロッド径より小さくしてください")
    if p["rod_end_len"] >= p["rod_extension"]:
        errors.append("ロッド先端ねじ長さはロッド突出長さより短くしてください")
    if p["tie_rod_pitch"] / 2 + d["tie_hole"] / 2 > p["cover_size"] / 2 - 3:
        errors.append("タイロッド穴がカバーの外形に近すぎます（ピッチかタイロッド径を小さく）")
    if p["tie_rod_pitch"] / math.sqrt(2) - d["tie_hole"] / 2 < d["tube_od"] / 2 + 1:
        errors.append("タイロッド穴がチューブに近すぎます（ピッチを大きく）")
    if d["packing_dia"] - d["nut_seat_dia"] < 4:
        errors.append("ピストンのナット座ぐりとパッキン溝の間が薄すぎます（ロッド先端ねじ径を小さく）")
    if p["cover_size"] / 2 - d["port_depth"] < d["passage_r"] + d["passage"] / 2 + 1:
        errors.append("ポート下穴が深すぎます（ポート下穴径を小さく）")
    if p["port_dia"] > p["head_cover_len"] - p["spigot_depth"] - 4:
        errors.append("ポート下穴径がヘッドカバーに収まりません")
    if d["bushing_to"] - d["bushing_from"] < 5:
        errors.append("ロッドカバーが短くてポートとブッシュが入りません（ロッドカバー長さを大きく）")
    return errors


def overall_length(p):
    """縮み切り時の全長"""
    return (p["head_cover_len"] + p["stroke"] + p["piston_width"]
            + p["rod_cover_len"] + p["rod_extension"])
