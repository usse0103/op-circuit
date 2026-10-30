# hydraulics/cylinder（油圧シリンダー設計、旧 hydraulic-designer）

油圧シリンダーの仕様を Flask の画面で入力・管理し、FreeCAD で 3D モデルを作って確認し、
製造・外注先に渡す 2D 図面（DXF / PDF）を出力する。

```
Flask（仕様入力・保存）──XML-RPC──▶ FreeCAD 画面内のサーバー
   │                                  ├─ hd_cylinder: 3D モデル生成（形状は hd_parts）
   │                                  └─ hd_drawing : 組立図（TechDraw）→ DXF
   │                       Flask ◀── DXF を仕上げ（Shift_JIS 化・レイヤー分け・図枠と表題欄）→ PDF
   └─subprocess──▶ freecadcmd hd_parts_job.py（FreeCAD の画面は不要）
                     └─ 部品ごとの投影図 → DXF・部品表（投影は platform/drawing/fc2d.py）
```

## 動かし方

`start.bat` をダブルクリックすれば、下の 1・2 をまとめて行いブラウザで画面を開く
（起動済みのものはそのまま使う。FreeCAD の場所が違うときは環境変数 `FREECAD_EXE` で指定）。
画面を止めるときは「hydraulic-designer」のウィンドウを閉じる。

手で起動する場合:

1. FreeCAD（1.1）を起動し、メニューの **マクロ → マクロ...** で `HD_Server.FCMacro` を選んで「実行」

   レポートビューに「127.0.0.1:9875 で待ち受け中」と出れば OK。
   部品図だけなら、この手順は不要（FreeCAD を起動していなくても出力できる）。

   マクロ本体は `freecad/HD_Server.FCMacro`。FreeCAD のマクロフォルダ
   （`%APPDATA%\FreeCAD\v1-1\Macro`）にコピーして使う。

2. Flask を起動して http://127.0.0.1:5000 を開く

   ```bash
   .venv/Scripts/python app.py
   ```

## 画面のボタン

| ボタン | 動作 |
|---|---|
| 保存 | `data/cylinders/<図番>.json` に保存 |
| 3D モデル更新 | 保存して、FreeCAD のモデルを作成・更新（図番ごとに別ドキュメント） |
| 図面出力 | 保存のあと、部品図を `output/<図番>/parts/` に、組立図（DXF・PDF・FCStd）を `output/<図番>/` に出力 |

## フォルダ構成

| パス | 内容 |
|---|---|
| `app.py` | Flask の画面 |
| `hd/params.py` | 寸法項目・既定値・細部寸法の計算・入力チェック（Flask と FreeCAD の両方で使う） |
| `hd/specs.py` | 仕様の保存・読み込み |
| `hd/freecad_client.py` | FreeCAD への依頼（組立図は XML-RPC、部品図は freecadcmd） |
| `hd/dxf_finish.py` | 組立図 DXF の仕上げ |
| `freecad/hd_rpc_server.py` | FreeCAD 内で動く受付サーバー |
| `freecad/hd_parts.py` | 部品ごとの形状（部品番号・名称・個数・材質・出す投影図の一覧もここ） |
| `freecad/hd_cylinder.py` | シリンダーの 3D モデル生成（hd_parts の形状を Part::Feature で置く） |
| `freecad/hd_drawing.py` | 組立図（TechDraw）の作成と出力 |
| `freecad/hd_parts_job.py` | 部品図と部品表の出力（freecadcmd で実行） |

`freecad/` と `hd/params.py` のコードは依頼のたびに読み直されるので、書き換えても FreeCAD の再起動は不要。

共通の投影図エンジン `fc2d.py` は `../../platform/drawing/` にある。
場所を変えたときは環境変数 `FC2D_DIR` で、freecadcmd の場所は `FREECADCMD` で指定する。

## 3D モデルについて

- シリンダー軸は X 方向。ヘッドカバー（ロッドが出ない側）が X=0、縮み切りの位置で作る
- 部品: ヘッドカバー・チューブ・ロッドカバー・ピストン・ロッド・タイロッド×4
- ポート下穴・通路、タイロッド穴、チューブ差し込み、ブッシュ座・ダストシール座、ピストンの溝などは
  入力値から `hd/params.py` の `derived()` で決めている。ねじは外径の円柱で代用
- スプレッドシート「Params」には寸法を書き出すだけ。値を変えるときは画面から入力して作り直す

## 図面について

### 部品図（`output/<図番>/parts/`）

- 部品ごとに第三角法で投影した外形線＋かくれ線だけ。寸法・注記・図枠は入れない（IJCAD などで追記する前提）
- DXF R12、単位 mm・尺度 1:1、レイヤーは OUTLINE（外形線）と HIDDEN（かくれ線）。線は LINE / ARC / CIRCLE
- ファイル名は `<図番>-<部品番号>_<名称>.dxf`。`部品表.csv` と確認用の `overview.png` も出る

### 組立図（`output/<図番>/`）

- 第三角法で正面図＋右側面図。尺度は 1:1 / 1:2 / 1:5 / 1:10 / 1:20 / 1:50 から用紙に収まるものを自動で選ぶ
- 自動で入る寸法は全長とカバー角寸法だけ。残りは FreeCAD 上で足す前提
- タイロッドはヘッドカバーより外に出て全長寸法がずれるので、組立図には描かない
- DXF の図枠・表題欄は `hd/dxf_finish.py` で描いている
- PDF は FreeCAD からではなく、仕上げた DXF から A3 原寸・白黒で作る（DXF と中身が必ず一致する）
