"""TechDraw で 2D 図面を作り、DXF に書き出す（FreeCAD 内で実行）

第三角法で正面図＋右側面図を配置し、全長・カバー角寸法と仕様表、表題欄を自動で入れる。
残りの寸法や注記は FreeCAD 上で手で足す前提。
"""
import os
import time

import FreeCAD as App
import TechDraw

import hd_cylinder

PAGE = "Drawing"
TEMPLATE = os.path.join(App.getResourceDir(), "Mod", "TechDraw", "Templates",
                        "ISO", "A3_Landscape_TD.svg")

# A3 横 [mm]。表題欄を避けた作図領域
PAGE_W = 420.0
AREA_W, AREA_H = 380.0, 190.0
VIEW_GAP = 40.0
DIM_GAP = 10.0  # 図形の外形から寸法線までの距離
SCALES = (1, 2, 5, 10, 20, 50)  # JIS 推奨尺度 1:n
FONT = "Yu Gothic"


def choose_scale(p):
    width = hd_cylinder.overall_length(p) + VIEW_GAP + p["cover_size"]
    height = p["cover_size"]
    for n in SCALES:
        if width / n <= AREA_W and height / n <= AREA_H:
            return n
    return SCALES[-1]


def _remove_page(doc):
    page = doc.getObject(PAGE)
    if page is None:
        return
    # 投影グループを消すと中の投影図も一緒に消えるので、名前で集めてから消す
    names = []
    for view in page.Views:
        names += [child.Name for child in getattr(view, "Views", [])] + [view.Name]
    names += [page.Name] + ([page.Template.Name] if page.Template else [])
    for name in names:
        if doc.getObject(name) is not None:
            doc.removeObject(name)


def _wait_for_views(doc, views, timeout=30.0):
    """TechDraw は投影を別スレッドで計算するので、終わるまで待つ"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if all(v.getVisibleEdges() for v in views):
            return
        if App.GuiUp:
            from PySide import QtWidgets
            QtWidgets.QApplication.processEvents()
        time.sleep(0.1)
        doc.recompute()
    raise RuntimeError("図面の投影計算が終わりませんでした")


def _extreme_vertices(view, axis):
    """投影図の中で、axis 方向に一番端にある頂点 2 つ（左右 or 上下）"""
    verts = view.getVisibleVertexes()
    key = (lambda v: v.x) if axis == "x" else (lambda v: v.y)
    other = (lambda v: v.y) if axis == "x" else (lambda v: v.x)
    lo, hi = min(map(key, verts)), max(map(key, verts))
    # 端にある頂点のうち、もう一方の座標が一番大きいもの（図の上側・右側に寸法を置く）
    pick = lambda value: max((i for i, v in enumerate(verts) if abs(key(v) - value) < 1e-6),
                             key=lambda i: other(verts[i]))
    return pick(lo), pick(hi)


def _add_dimension(doc, page, view, axis, name, offset):
    """offset: 投影図の中心から寸法線までの距離（用紙上 mm）。図形の外側に出す"""
    a, b = _extreme_vertices(view, axis)
    dim = doc.addObject("TechDraw::DrawViewDimension", name)
    dim.Type = "DistanceX" if axis == "x" else "DistanceY"
    dim.References2D = [(view, (f"Vertex{a}", f"Vertex{b}"))]
    dim.FormatSpec = "%.4w"
    page.addView(dim)
    # addView で位置が初期化されるので、その後に置く
    dim.X, dim.Y = (0.0, offset) if axis == "x" else (offset, 0.0)
    return dim


def _add_spec_table(doc, page, p, info):
    rows = [
        "仕様",
        f"ボア径  φ{p['bore']:g}",
        f"ロッド径  φ{p['rod_dia']:g}",
        f"ストローク  {p['stroke']:g}",
        f"材質  {info.get('material', '')}",
    ]
    # DXF には注記の 1 行目しか出力されないので、1 行ずつ別の注記にする
    for i, row in enumerate(rows):
        note = doc.addObject("TechDraw::DrawViewAnnotation", f"Spec{i}")
        note.Text = [row]
        note.Font = FONT
        note.TextSize = 5.0
        page.addView(note)
        note.X, note.Y = 45.0, 80.0 - i * 8.0


def _fill_title(template, p, info, scale_n, weight_kg):
    texts = dict(template.EditableTexts)
    values = {
        "FC-Title": info.get("name", "油圧シリンダー"),
        "Subtitle": f"φ{p['bore']:g} × {p['stroke']:g}st",
        "drawing_number": info.get("drawing_number", ""),
        "AuthorName": info.get("author", ""),
        "CreationDate": time.strftime("%Y/%m/%d"),
        "scale": f"1:{scale_n}",
        "Weight": f"{weight_kg:g} kg",
        "SheetNumber": "1/1",
        "copyright": "",
    }
    for key, value in values.items():
        if key in texts:
            texts[key] = value
    template.EditableTexts = texts


def make(doc, info, out_dir):
    """図面ページを作り直し、DXF を書き出す"""
    p = hd_cylinder.read_params(doc)
    weight_kg = hd_cylinder.weight_kg(doc)
    _remove_page(doc)

    page = doc.addObject("TechDraw::DrawPage", PAGE)
    template = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
    template.Template = TEMPLATE
    page.Template = template
    page.KeepUpdated = True

    scale_n = choose_scale(p)
    group = doc.addObject("TechDraw::DrawProjGroup", "Views")
    page.addView(group)
    group.Source = hd_cylinder.drawing_solids(doc)
    group.ProjectionType = "Third angle"
    group.ScaleType = "Custom"
    group.Scale = 1.0 / scale_n
    group.spacingX = VIEW_GAP
    front = group.addProjection("Front")
    group.Anchor.Direction = App.Vector(0, -1, 0)
    group.Anchor.XDirection = App.Vector(1, 0, 0)
    right = group.addProjection("Right")
    # 正面図＋右側面図の全体が用紙の左右中央に来るよう、正面図の中心位置を決める
    length = hd_cylinder.overall_length(p) / scale_n
    total = length + VIEW_GAP + p["cover_size"] / scale_n
    group.X = PAGE_W / 2 - total / 2 + length / 2
    group.Y = 175.0
    doc.recompute()
    _wait_for_views(doc, [front, right])

    offset = p["cover_size"] / scale_n / 2 + DIM_GAP
    _add_dimension(doc, page, front, "x", "DimOverall", offset)
    _add_dimension(doc, page, right, "y", "DimCover", offset)
    _add_spec_table(doc, page, p, info)
    _fill_title(template, p, info, scale_n, weight_kg)
    doc.recompute()

    # PDF は Flask 側で、仕上げた DXF から作る（DXF と中身をそろえるため）
    os.makedirs(out_dir, exist_ok=True)
    base = os.path.join(out_dir, info.get("drawing_number") or doc.Name)
    files = {"dxf": base + ".dxf"}
    TechDraw.writeDXFPage(page, files["dxf"])
    return {"files": files, "scale": f"1:{scale_n}", "weight_kg": weight_kg}
