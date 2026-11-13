// 印刷と書き出し。1 ページ目は図面（用紙ぴったり）、続けて計算書（A4 縦）。
import { state, typeDef, compById, stateOf, fmt } from './store.js';
import { exportSvg } from './editor.js';
import { sheetSize, bomRows } from './sheet.js';
import { esc } from './symbols.js';
import { h } from './inspector.js';

const USE_NAME = { suction: '吸込', return: '戻り', pressure: '圧力', pilot: 'パイロット', drain: 'ドレン' };
const LEVEL = { error: 'エラー', warn: '注意', info: '情報' };

const td = (v, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${v}</td>`;
const th = (v) => `<th>${v}</th>`;

function valText(v) {
  if (v.text != null) return `${esc(v.label)} ${esc(v.text)}`;
  return `${esc(v.label)} ${fmt(v.value, v.digits ?? 2)}${v.unit ? ' ' + esc(v.unit) : ''}`;
}

/** 計算書の HTML */
export function reportHtml() {
  const d = state.doc, r = state.results;
  const m = d.meta;
  let s = `<div class="rp-head"><div><div class="rp-kind">油圧回路 計算書</div><h1>${esc(m.title || '（無題）')}</h1></div>`
    + `<table class="rp-meta"><tr><th>図番</th><td>${esc(m.drawingNo)}</td><th>改訂</th><td>${esc(m.rev)}</td></tr>`
    + `<tr><th>案件</th><td>${esc(m.project)}</td><th>日付</th><td>${esc(m.date)}</td></tr>`
    + `<tr><th>客先</th><td>${esc(m.customer)}</td><th>設計</th><td>${esc(m.author)}</td></tr></table></div>`;
  if (!r || !r.ok) return s + '<p>計算結果がありません。</p>';
  const st = r.settings, fl = r.fluid, cy = r.cycle, tm = r.thermal;

  s += `<h2>1. 計算条件</h2><table class="rp kv"><tr>${th('作動油')}${td(esc(fl.name))}${th('油温（計算に使用）')}${td(`${fmt(st.oilTemp, 0)} ℃`)}</tr>`
    + `<tr>${th('動粘度')}${td(`${fmt(fl.nu, 1)} mm²/s`)}${th('密度')}${td(`${fmt(fl.rho, 0)} kg/m³`)}</tr>`
    + `<tr>${th('周囲温度')}${td(`${fmt(st.ambTemp, 0)} ℃`)}${th('許容油温')}${td(`${fmt(st.maxTemp, 0)} ℃`)}</tr>`
    + `<tr>${th('タンク油量')}${td(`${fmt(st.tankVolume, 0)} L`)}${th('放熱面積 / 熱通過率')}${td(`${fmt(tm.area, 2)} m²${tm.areaAuto ? '（見積もり）' : ''} / ${fmt(st.tankK, 1)} W/m²K`)}</tr></table>`;

  const stateful = d.components.filter((c) => { const def = typeDef(c.type); return def && def.states; });
  s += `<h2>2. 工程表</h2><table class="rp"><thead><tr>${th('#')}${th('工程')}${th('時間 s')}`
    + stateful.map((c) => th(esc(c.tag || typeDef(c.type).name))).join('')
    + `${th('軸入力 kW')}${th('仕事 kW')}${th('発熱 kW')}</tr></thead><tbody>`;
  d.steps.forEach((step, i) => {
    const sr = r.steps.find((q) => q.id === step.id);
    s += `<tr>${td(i + 1, 'c')}${td(esc(step.name))}${td(sr ? `${fmt(sr.duration, 1)}${sr.durationAuto ? '（自動）' : ''}` : '', 'n')}`
      + stateful.map((c) => {
        const def = typeDef(c.type);
        const o = def.states.options.find((q) => q.value === stateOf(c, step));
        const base = o && o.value === def.states.default;
        return td(base ? `<span class="dim">${esc(o.label)}</span>` : `<b>${esc(o ? o.label : '')}</b>`, 'c');
      }).join('')
      + `${td(sr ? fmt(sr.totals.shaft, 2) : '', 'n')}${td(sr ? fmt(sr.totals.mech, 2) : '', 'n')}${td(sr ? fmt(sr.totals.heat, 2) : '', 'n')}</tr>`;
  });
  s += `</tbody></table>`;

  s += `<h2>3. 動力と熱収支</h2><table class="rp kv">`
    + `<tr>${th('サイクル時間')}${td(`${fmt(cy.time, 1)} s`)}${th('ポンプ吐出量（合計）')}${td(`${fmt(cy.pumpFlow, 1)} L/min`)}</tr>`
    + `<tr>${th('軸入力 平均 / 二乗平均 / 最大')}${td(`${fmt(cy.shaft, 2)} / ${fmt(cy.shaftRms, 2)} / ${fmt(cy.shaftPeak, 2)} kW`)}${th('推奨電動機')}${td(cy.motor != null ? `${cy.motor} kW` : '—')}</tr>`
    + `<tr>${th('平均の仕事')}${td(`${fmt(cy.mech, 2)} kW`)}${th('サイクル効率')}${td(cy.efficiency != null ? `${fmt(cy.efficiency, 0)} %` : '—')}</tr>`
    + `<tr>${th('平均発熱')}${td(`<b>${fmt(cy.heat, 2)} kW</b>（${fmt(cy.heat * 3600, 0)} kJ/h）`)}${th('クーラの交換熱量（平均）')}${td(`${fmt(cy.cooling, 2)} kW`)}</tr>`
    + `<tr>${th('タンクの放熱能力')}${td(`${fmt(tm.ka, 1)} W/K`)}${th('推定油温（定常）')}${td(`<b>${fmt(tm.steady, 0)} ℃</b>（周囲 + ${fmt(tm.rise, 0)} K）`)}</tr>`
    + `<tr>${th('許容油温で逃がせる熱')}${td(`${fmt(tm.tankAllow, 2)} kW`)}${th('必要なクーラ容量')}${td(`<b>${fmt(tm.coolerNeed, 2)} kW</b>`)}</tr></table>`;

  s += `<h2>4. 工程ごとの計算値</h2>`;
  for (const sr of r.steps) {
    s += `<h3>工程「${esc(sr.name)}」${sr.converged ? '' : '（収束していません）'}</h3><table class="rp"><thead><tr>${th('番号')}${th('名称')}${th('計算値')}${th('発熱 W')}</tr></thead><tbody>`;
    for (const c of d.components) {
      const def = typeDef(c.type);
      if (!def || def.bom === false) continue;
      const cr = sr.comps[c.id];
      if (!cr) continue;
      const vals = (cr.values || []).filter((v) => v.label !== '発熱' && !/受圧面積|理論/.test(v.label)).slice(0, 8).map(valText).join('　');
      s += `<tr>${td(esc(c.tag), 'mono')}${td(esc(def.name))}${td(vals, 'small')}${td(fmt(cr.heat, 0), 'n')}</tr>`;
    }
    s += `</tbody></table>`;
  }

  const wires = d.wires.filter((w) => r.wires[w.id] && r.wires[w.id].q_max > 0.05);
  if (wires.length) {
    const pipes = state.lib.standards.pipes;
    const end = (e) => { const c = compById(e.c); return c ? (c.type === 'junction' ? '分岐' : `${c.tag} ${e.p}`) : '?'; };
    s += `<h2>5. 配管</h2><table class="rp"><thead><tr>${th('区間')}${th('用途')}${th('最大流量 L/min')}${th('最高圧力 MPa')}${th('管')}${th('長さ m')}${th('流速 m/s')}${th('目安 m/s')}${th('推奨')}</tr></thead><tbody>`;
    for (const w of wires) {
      const ws = r.wires[w.id];
      const pp = w.pipe || {};
      const pd = pipes.find((q) => q.id === pp.size);
      const name = pd ? `${pd.a}A Sch${pd.sch}` : (pp.size === 'custom' ? `内径 ${pp.id_mm}` : '—');
      const sg = pipes.find((q) => q.id === ws.suggest);
      const over = ws.v_max > ws.guide[1] * 1.001;
      s += `<tr>${td(`${esc(end(w.a))} → ${esc(end(w.b))}`)}${td(USE_NAME[ws.use] || '')}${td(fmt(ws.q_max, 1), 'n')}${td(fmt(ws.p_max, 1), 'n')}`
        + `${td(esc(name))}${td(pp.len ? fmt(pp.len, 1) : '', 'n')}${td(ws.v_max > 0 ? `${over ? '<b>' : ''}${fmt(ws.v_max, 1)}${over ? '</b>' : ''}` : '', 'n')}`
        + `${td(`${ws.guide[0]}～${ws.guide[1]}`, 'c')}${td(sg ? `${sg.a}A Sch${sg.sch}` : '')}</tr>`;
    }
    s += `</tbody></table>`;
  }

  if ((r.diagnostics || []).length) {
    s += `<h2>6. 診断</h2><table class="rp"><tbody>`;
    for (const g of r.diagnostics) {
      const c = g.ref ? compById(g.ref) : null;
      s += `<tr>${td(LEVEL[g.level] || g.level, `c lv-${g.level}`)}${td(esc(c ? c.tag || typeDef(c.type).name : ''), 'mono')}${td(esc(g.msg) + (g.steps && g.steps.length ? `<span class="dim">（${esc(g.steps.join('、'))}）</span>` : ''))}</tr>`;
    }
    s += `</tbody></table>`;
  }

  const rows = bomRows();
  if (rows.length) {
    s += `<h2>7. 機器表</h2><table class="rp"><thead><tr>${['番号', '名称', '形式', '仕様', 'メーカー', '備考'].map(th).join('')}</tr></thead><tbody>`;
    for (const b of rows) s += `<tr>${td(esc(b.tag), 'mono')}${td(esc(b.name))}${td(esc(b.model))}${td(esc(b.spec))}${td(esc(b.maker))}${td(esc(b.note))}</tr>`;
    s += `</tbody></table>`;
  }

  s += `<h2>8. 計算式</h2><table class="rp formulas"><tbody>`
    + `<tr>${td('ポンプの軸入力')}${td('L<sub>s</sub> = P·Q / (60·η)　[kW]')}${td('P: MPa、Q: L/min、η: 全効率')}</tr>`
    + `<tr>${td('圧力損失による発熱')}${td('H = P·Q / 60 [kW] = 60·P·Q [kJ/h]')}${td('P: 圧力損失 MPa、Q: L/min')}</tr>`
    + `<tr>${td('機器の圧力損失')}${td('ΔP = ΔP<sub>0</sub>·(Q/Q<sub>0</sub>)²')}${td('基準流量 Q<sub>0</sub> での損失 ΔP<sub>0</sub>')}</tr>`
    + `<tr>${td('絞りの流量')}${td('Q = 60·k·A·√(2ΔP/ρ)　[L/min]')}${td('A: mm²、k = 0.6～0.7')}</tr>`
    + `<tr>${td('管内流速')}${td('v = 2Q / (3π·D²) × 10²　[m/s]')}${td('D: 管内径 mm')}</tr>`
    + `<tr>${td('直管の圧力損失')}${td('ΔP = λ·v²·ρ·ℓ / (2000·D)　[MPa]')}${td('Re ≤ 2000: λ = 64/Re、それ以上: λ = 0.3164·Re<sup>−1/4</sup>')}</tr>`
    + `<tr>${td('エルボの圧力損失')}${td('ΔP = k·ρ·v²/2 × 10<sup>−6</sup>　[MPa]')}${td('90° エルボ k = 1.2')}</tr>`
    + `<tr>${td('シリンダの圧力')}${td('P<sub>1</sub> = (F/η<sub>c</sub> + P<sub>2</sub>·A<sub>2</sub>×10²) / (A<sub>1</sub>×10²)')}${td('F: N、A: cm²、η<sub>c</sub>: 推力効率')}</tr>`
    + `<tr>${td('油温（定常）')}${td('T = T<sub>a</sub> + (H − H<sub>c</sub>) / (k·A)')}${td('k: 熱通過率、A: 放熱面積、H<sub>c</sub>: クーラ')}</tr>`
    + `<tr>${td('電動機の平均動力')}${td('L<sub>e</sub> = √(Σ t<sub>n</sub>·L<sub>n</sub>² / T)')}${td('各工程の時間と軸入力')}</tr>`
    + `</tbody></table><p class="rp-note">図記号は JIS B 0125-1984。計算式は東京計器「技術資料」と NACHI「油圧機器総合カタログ 技術資料」による。機器の圧力損失は入力した基準値からの換算で、実機の値はカタログの線図で確認すること。</p>`;
  return s;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileBase() {
  const m = state.doc.meta;
  return (m.drawingNo || m.title || 'circuit').replace(/[\\/:*?"<>|\s]+/g, '_');
}

export function downloadSvg(opts) {
  download(`${fileBase()}.svg`, `<?xml version="1.0" encoding="UTF-8"?>\n${exportSvg(opts)}`, 'image/svg+xml');
}

export function downloadJson() {
  download(`${fileBase()}.json`, JSON.stringify(state.doc, null, 1), 'application/json');
}

function doPrint(opts) {
  const { w, h: hh } = sheetSize();
  const root = document.getElementById('print-root');
  let html = `<section class="pp pp-sheet" style="width:${w}mm;height:${hh}mm">${exportSvg(opts)}</section>`;
  if (opts.report) html += `<section class="pp pp-report">${reportHtml()}</section>`;
  root.innerHTML = html;
  let style = document.getElementById('page-style');
  if (!style) { style = document.createElement('style'); style.id = 'page-style'; document.head.appendChild(style); }
  style.textContent = `@page{size:${w}mm ${hh}mm;margin:0}@page report{size:A4 portrait;margin:14mm 13mm}`
    + `.pp-sheet{page:auto}.pp-report{page:report}`;
  const done = () => { root.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 60);
}

/** 印刷の設定を選ぶ画面 */
export function openPrintDialog(showModal) {
  const saved = JSON.parse(localStorage.getItem('hc.print') || '{}');
  const o = { values: false, heat: false, color: false, report: true, ...saved };
  const { w, h: hh } = sheetSize();
  const check = (key, label, hint) => {
    const inp = h('input', { type: 'checkbox', checked: o[key], onchange: () => { o[key] = inp.checked; preview(); } });
    return h('label', { class: 'opt' }, inp, h('span', { class: 'switch' }), h('span', {}, h('b', {}, label), h('small', {}, hint)));
  };
  const pv = h('div', { class: 'print-preview' });
  const preview = () => { pv.innerHTML = exportSvg(o); };
  const body = h('div', { class: 'print-dialog' },
    h('div', { class: 'print-opts' },
      h('div', { class: 'print-size' }, `用紙 ${state.doc.meta.sheet} 横（${w} × ${hh} mm）`),
      check('values', '計算値を図面に入れる', '流量・圧力・速度を、いま選んでいる工程の値で書き込む'),
      check('heat', '発熱を図面に入れる', '機器ごとの発熱を書き込む'),
      check('color', '計算値を色で刷る', 'オフのときはすべて黒'),
      check('report', '計算書を付ける', '2 ページ目以降に A4 縦で、条件・工程表・熱収支・配管・機器表'),
      h('div', { class: 'hint' }, '印刷画面では、倍率を「100 %（実際のサイズ）」、余白を「なし」にしてください。A3 の図面を A4 に刷るときは「用紙に合わせる」を選びます。'),
      h('div', { class: 'print-btns' },
        h('button', { class: 'btn primary', onclick: () => { localStorage.setItem('hc.print', JSON.stringify(o)); close(); doPrint(o); } }, '印刷する'),
        h('button', { class: 'btn', onclick: () => downloadSvg(o) }, 'SVG で保存'),
        h('button', { class: 'btn', onclick: () => { close(); openReport(showModal); } }, '計算書を見る'))),
    pv);
  const close = showModal('印刷', body, { wide: true });
  preview();
}

/** 計算書を画面で見る */
export function openReport(showModal) {
  showModal('計算書', h('div', { class: 'report-view' }, h('section', { class: 'pp-report', html: reportHtml() })), { wide: true });
}
