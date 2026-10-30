"""油圧シリンダーの部品形状を作る（FreeCAD の Part だけを使い、ドキュメントには依存しない）

hd_cylinder（画面付き FreeCAD のモデル）と hd_parts_job（部品図の出力）の両方から使う。
シリンダー軸は X 方向。ヘッドカバー側が X=0、ロッドは +X 側に出る。上 = +Z。
位置は縮み切り（ピストンがヘッドカバーに当たった状態）。
"""
import FreeCAD as App
import Part

from hd.params import derived, normalize

V = App.Vector
AX = V(1, 0, 0)


def _cyl(d, x0, length, y=0.0, z=0.0):
    return Part.makeCylinder(d / 2, length, V(x0, y, z), AX)


def _zcyl(d, x, z0, length):
    return Part.makeCylinder(d / 2, length, V(x, 0, z0), V(0, 0, 1))


def _ring_groove(outer, inner, x0, width):
    return _cyl(outer + 2, x0, width).cut(_cyl(inner, x0 - 1, width + 2))


def _cover_block(p, d, x0, length):
    a = p["cover_size"]
    s = Part.makeBox(length, a, a, V(x0, -a / 2, -a / 2))
    t = p["tie_rod_pitch"] / 2
    for y in (-t, t):
        for z in (-t, t):
            s = s.cut(_cyl(d["tie_hole"], x0 - 1, length + 2, y, z))
    return s


def head_cover(p, d):
    lh, sp = p["head_cover_len"], p["spigot_depth"]
    s = _cover_block(p, d, 0, lh)
    s = s.cut(_cyl(d["tube_od"], lh - sp, sp + 1))                     # チューブ差し込み
    xp = (lh - sp) / 2                                                   # ポート位置
    top = p["cover_size"] / 2
    s = s.cut(_zcyl(p["port_dia"], xp, top - d["port_depth"], d["port_depth"] + 1))
    s = s.cut(_zcyl(d["passage"], xp, 0, top - d["port_depth"] + 1))    # 縦通路（軸心まで）
    s = s.cut(_cyl(d["passage"], xp, lh - sp - xp + 0.5))               # 軸方向通路
    return s.removeSplitter()


def rod_cover(p, d):
    x0 = p["head_cover_len"] + p["stroke"] + p["piston_width"]
    lr, sp = p["rod_cover_len"], p["spigot_depth"]
    top = p["cover_size"] / 2
    s = _cover_block(p, d, x0, lr)
    s = s.cut(_cyl(d["tube_od"], x0 - 1, sp + 1))                       # チューブ差し込み
    s = s.cut(_cyl(d["rod_hole"], x0 - 1, lr + 2))                      # ロッド穴
    s = s.cut(_cyl(d["bushing_dia"], x0 + d["bushing_from"], d["bushing_to"] - d["bushing_from"]))
    s = s.cut(_cyl(d["dust_seal_dia"], x0 + lr - 7, 8))                 # ダストシール座
    xp, zr = x0 + d["rod_port_x"], d["passage_r"]
    s = s.cut(_zcyl(p["port_dia"], xp, top - d["port_depth"], d["port_depth"] + 1))
    s = s.cut(_zcyl(d["passage"], xp, zr, top - d["port_depth"] - zr + 1))
    s = s.cut(_cyl(d["passage"], x0 + sp - 0.5, xp - x0 - sp + 0.5 + d["passage"] / 2, z=zr))
    return s.removeSplitter()


def tube(p, d):
    x0 = p["head_cover_len"] - p["spigot_depth"]
    return _cyl(d["tube_od"], x0, d["tube_len"]).cut(_cyl(p["bore"], x0 - 1, d["tube_len"] + 2))


def piston(p, d):
    x0, w, b = p["head_cover_len"], p["piston_width"], p["bore"]
    s = _cyl(b, x0, w)
    s = s.cut(_cyl(p["rod_end_dia"], x0 - 1, w + 2))                    # ロッド穴
    s = s.cut(_cyl(d["nut_seat_dia"], x0 - 1, d["nut_seat_depth"] + 1))  # ナット座ぐり（ヘッド側）
    gw = 0.2 * w
    s = s.cut(_ring_groove(b, d["wear_dia"], x0 + 0.1 * w, gw))         # ウェアリング溝
    s = s.cut(_ring_groove(b, d["wear_dia"], x0 + 0.9 * w - gw, gw))
    s = s.cut(_ring_groove(b, d["packing_dia"], x0 + 0.365 * w, 0.27 * w))  # パッキン溝
    return s.removeSplitter()


def rod(p, d):
    x_piston = p["head_cover_len"]
    x_main = x_piston + p["piston_width"]
    x_end = x_main + p["stroke"] + p["rod_cover_len"] + p["rod_extension"]
    x_thread = x_end - p["rod_end_len"]
    s = _cyl(p["rod_end_dia"], x_piston + 2, x_main - x_piston - 2)     # ピストン取付部
    s = s.fuse(_cyl(p["rod_dia"], x_main, x_thread - x_main))
    s = s.fuse(_cyl(p["rod_end_dia"], x_thread, p["rod_end_len"]))      # 先端ねじ部
    return s.removeSplitter()


def tie_rod(p, d, y=None, z=None):
    t = p["tie_rod_pitch"] / 2
    y = t if y is None else y
    z = t if z is None else z
    return _cyl(p["tie_rod_dia"], -1.5 * p["tie_rod_dia"], d["tie_rod_len"], y, z)


# (オブジェクト名, 部品番号, 名称, 個数, 材質（None は図面情報の材質）, 投影図, 形状関数)
PARTS = [
    ("HeadCover", "01", "ヘッドカバー", 1, "S45C", ["front", "top", "right", "left"], head_cover),
    ("Tube",      "02", "チューブ",     1, None,   ["front", "right"], tube),
    ("RodCover",  "03", "ロッドカバー", 1, "S45C", ["front", "top", "right", "left"], rod_cover),
    ("Piston",    "04", "ピストン",     1, "S45C", ["front", "right"], piston),
    ("Rod",       "05", "ロッド",       1, "S45C", ["front", "right"], rod),
    ("TieRod",    "06", "タイロッド",   4, "S45C", ["front", "right"], tie_rod),
]


def shapes(params):
    """{部品のオブジェクト名: 形状}。タイロッドは 4 本とも配置した状態（TieRod1〜4）"""
    p = normalize(params)
    d = derived(p)
    out = {}
    for name, _, _, _, _, _, fn in PARTS:
        if name == "TieRod":
            t = p["tie_rod_pitch"] / 2
            corners = [(y, z) for y in (-t, t) for z in (-t, t)]
            for i, (y, z) in enumerate(corners, start=1):
                out[f"TieRod{i}"] = tie_rod(p, d, y, z)
        else:
            out[name] = fn(p, d)
    return out


def part_shape(params, name):
    """部品図用の単品形状（タイロッドは 1 本）"""
    p = normalize(params)
    fn = {n: f for n, _, _, _, _, _, f in PARTS}[name]
    return fn(p, derived(p))
