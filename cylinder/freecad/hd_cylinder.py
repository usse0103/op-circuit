"""油圧シリンダーの3Dモデルを生成する（FreeCAD 内で実行）

部品の形状は hd_parts で作り、部品ごとに Part::Feature として置く。
寸法はスプレッドシート「Params」にも書き出す（確認用。値を変えるときは画面から入力して作り直す）。
同じドキュメントに再度 build() すると、同じ名前のオブジェクトの形状を差し替える。
シリンダー軸は X 方向。ヘッドカバー側が X=0。
"""
import FreeCAD as App

import hd_parts
from hd.params import DEFAULTS, normalize, overall_length, validate

STEEL_DENSITY = 7.85e-6  # kg/mm3

SHEET = "Params"
# 部品を作り直すと消えないよう、名前を固定しておく
PARTS = ("HeadCover", "Tube", "RodCover", "Piston", "Rod",
         "TieRod1", "TieRod2", "TieRod3", "TieRod4")


def _write_params(doc, p):
    sheet = doc.getObject(SHEET)
    if sheet is None:
        sheet = doc.addObject("Spreadsheet::Sheet", SHEET)
    for row, (key, value) in enumerate(p.items(), start=1):
        sheet.set(f"A{row}", key)
        sheet.set(f"B{row}", f"{value:g}")
        if sheet.getAlias(f"B{row}") != key:
            sheet.setAlias(f"B{row}", key)
    sheet.recompute()


def _is_current(doc):
    """部品がすべて Part::Feature で揃っているか（旧版の式連動モデルなら作り直す）"""
    objs = [doc.getObject(name) for name in PARTS]
    return all(o is not None and o.TypeId == "Part::Feature" for o in objs)


def build(params, doc_name="Cylinder"):
    """モデルを作成（既存なら更新）して結果を返す"""
    p = normalize(params)
    errors = validate(p)
    if errors:
        raise ValueError(" / ".join(errors))

    doc = App.listDocuments().get(doc_name) or App.newDocument(doc_name)
    _write_params(doc, p)
    if not _is_current(doc):
        for obj in list(doc.Objects):
            if obj.Name != SHEET and doc.getObject(obj.Name) is not None:
                doc.removeObject(obj.Name)
    for name, shape in hd_parts.shapes(p).items():
        obj = doc.getObject(name) or doc.addObject("Part::Feature", name)
        obj.Shape = shape
    doc.recompute()

    if App.GuiUp:
        import FreeCADGui as Gui
        App.setActiveDocument(doc.Name)
        view = Gui.getDocument(doc.Name).ActiveView
        view.viewIsometric()
        view.fitAll()

    return {
        "doc": doc.Name,
        "overall_length": overall_length(p),
        "weight_kg": weight_kg(doc),
        "params": p,
    }


def read_params(doc):
    sheet = doc.getObject(SHEET)
    return normalize({key: sheet.get(key) for key in DEFAULTS if sheet.getCellFromAlias(key)})


def weight_kg(doc):
    volume = sum(obj.Shape.Volume for obj in solids(doc))
    return round(volume * STEEL_DENSITY, 2)


def solids(doc):
    return [doc.getObject(name) for name in PARTS]


def drawing_solids(doc):
    """組立図に描く部品。タイロッドはヘッドカバーより外に出て全長寸法を狂わせるので除く"""
    return [obj for obj in solids(doc) if not obj.Name.startswith("TieRod")]
