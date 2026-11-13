"""油圧回路設計（hydraulics/circuit）の計算・データ層。

- standards: 作動油・配管などの共通の表
- library:   機器ライブラリ（library/*.json）の読み込み
- network:   管路網の要素とソルバー
- models:    機器 → 管路網の要素への展開
- analysis:  工程ごとの計算、熱収支、診断
- storage:   回路データの保存と読み込み
"""
