"""FreeCAD が書き出した DXF を、製造・外注先に渡せる形に整える

- FreeCAD は日本語を UTF-8 で書くのに文字コードの宣言が ANSI_1252 なので、
  Shift_JIS（ANSI_932）として書き直す。JW_CAD や日本語版 AutoCAD で文字化けしない
- 線の種類ごとにレイヤーを分ける（外形・寸法・文字・図枠）
- TechDraw の図枠と表題欄は DXF に出ないので、ここで描く
- 仕上げた DXF から PDF を作る（外注先に渡す DXF と中身がそろう）
"""
import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, pymupdf

PAPER_W, PAPER_H = 420.0, 297.0  # A3 横
MARGIN = 10.0
FONT = "msgothic.ttc"

LAYERS = {
    # 名前: (色, 線の太さ [1/100 mm])
    "OUTLINE": (7, 50),
    "DIM": (3, 25),
    "TEXT": (2, 25),
    "FRAME": (7, 70),
    "TITLE": (7, 25),
}


def _layer_for(entity):
    kind = entity.dxftype()
    if kind == "DIMENSION":
        return "DIM"
    if kind in ("TEXT", "MTEXT"):
        return "TEXT"
    return "OUTLINE"


def _setup(doc):
    for name, (color, lineweight) in LAYERS.items():
        if name not in doc.layers:
            doc.layers.add(name, color=color, lineweight=lineweight)
    doc.styles.get("Standard").dxf.font = FONT


def _text(msp, x, y, text, height, layer="TITLE"):
    msp.add_text(text, height=height, dxfattribs={"layer": layer, "style": "Standard"}) \
        .set_placement((x, y))


def _draw_frame(msp, info):
    x0, y0 = MARGIN, MARGIN
    x1, y1 = PAPER_W - MARGIN, PAPER_H - MARGIN
    msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True,
                       dxfattribs={"layer": "FRAME"})

    # 表題欄（右下 170 × 40）
    w, row = 170.0, 10.0
    left = x1 - w
    label_w, half = 18.0, w / 2
    msp.add_lwpolyline([(left, y0), (x1, y0), (x1, y0 + 4 * row), (left, y0 + 4 * row)],
                       close=True, dxfattribs={"layer": "FRAME"})
    for i in range(1, 4):
        msp.add_line((left, y0 + i * row), (x1, y0 + i * row), dxfattribs={"layer": "TITLE"})
    for i in range(4):
        bottom = y0 + i * row
        msp.add_line((left + label_w, bottom), (left + label_w, bottom + row),
                     dxfattribs={"layer": "TITLE"})
        if i < 3:  # 一番上の段（名称）は区切らない
            msp.add_line((left + half, bottom), (left + half, bottom + row),
                         dxfattribs={"layer": "TITLE"})
            msp.add_line((left + half + label_w, bottom), (left + half + label_w, bottom + row),
                         dxfattribs={"layer": "TITLE"})

    rows = [  # 下の段から
        (("作成", info.get("author", "")), ("日付", info.get("date", ""))),
        (("材質", info.get("material", "")), ("重量", info.get("weight", ""))),
        (("図番", info.get("drawing_number", "")), ("尺度", info.get("scale", ""))),
    ]
    for i, cells in enumerate(rows):
        y = y0 + i * row + 3.0
        for j, (label, value) in enumerate(cells):
            x = left + j * half
            _text(msp, x + 2, y, label, 3.5)
            _text(msp, x + label_w + 2, y, str(value), 4.0)
    y = y0 + 3 * row + 3.0
    _text(msp, left + 2, y, "名称", 3.5)
    _text(msp, left + label_w + 2, y, info.get("name", ""), 5.0)
    _text(msp, left, y0 + 4 * row + 3.0, "第三角法", 3.5)


def finish(path, info):
    """path の DXF をその場で書き換える"""
    doc = ezdxf.readfile(path, encoding="utf-8")
    _setup(doc)
    msp = doc.modelspace()
    old_layers = set()
    for entity in msp:
        old_layers.add(entity.dxf.layer)
        entity.dxf.layer = _layer_for(entity)
    for name in old_layers - set(LAYERS) - {"0"}:
        if name in doc.layers:
            doc.layers.remove(name)
    _draw_frame(msp, info)
    doc.encoding = "cp932"
    doc.saveas(path)


def to_pdf(dxf_path, pdf_path):
    """仕上げた DXF を A3 原寸（白黒）の PDF にする"""
    doc = ezdxf.readfile(dxf_path)
    backend = pymupdf.PyMuPdfBackend()
    cfg = config.Configuration(
        background_policy=config.BackgroundPolicy.WHITE,
        color_policy=config.ColorPolicy.BLACK,
    )
    Frontend(RenderContext(doc), backend, config=cfg).draw_layout(doc.modelspace())
    # 図枠は用紙の上下左右に同じ余白で描いているので、中央に置けば原寸の位置になる
    page = layout.Page(PAPER_W, PAPER_H, layout.Units.mm, margins=layout.Margins.all(0))
    pdf = backend.get_pdf_bytes(page, settings=layout.Settings(scale=1, fit_page=False))
    with open(pdf_path, "wb") as f:
        f.write(pdf)
