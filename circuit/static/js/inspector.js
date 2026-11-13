// 右ペイン。選択したものの設定（スライダー + 数値 + 電卓）と、その計算結果。
// 何も選んでいないときは、回路全体の集計・計算条件・図面情報。
import {
  state, on, typeDef, paramsOf, stateOf, setStateOf, compById, wireById, frameById, textById,
  commit, touch, stepResult, currentStep, fmt, SHEETS, setView,
} from './store.js';
import { evaluate, tidy, openPad } from './calcpad.js';
import { rotateSelection, flipSelection, deleteSelection, duplicateSelection, alignSelection, rerouteSelection } from './editor.js';
import { layerTitle } from './sheet.js';

let root;
let selfEdit = false;
let resultsHost = null;
let resultsFn = null;

// --- DOM の小道具 --------------------------------------------------------------
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  return el;
}

const edit = (fn) => { selfEdit = true; try { fn(); } finally { selfEdit = false; } };

function section(title, body, { open = true, key = '' } = {}) {
  const stored = key ? localStorage.getItem(`hc.sec.${key}`) : null;
  const isOpen = stored == null ? open : stored === '1';
  const sec = h('section', { class: `ins-sec${isOpen ? ' open' : ''}` });
  const head = h('button', { class: 'ins-sec-head', onclick: () => {
    sec.classList.toggle('open');
    if (key) localStorage.setItem(`hc.sec.${key}`, sec.classList.contains('open') ? '1' : '0');
  } }, h('span', { class: 'chev' }), title);
  sec.append(head, h('div', { class: 'ins-sec-body' }, body));
  return sec;
}

/** 数値の入力欄: スライダー + 数値（式も書ける） + 電卓 */
function numberField({ label, unit = '', min = 0, max = 100, step = 1, value = 0, help = '', onChange }) {
  let cur = Number(value) || 0;
  const slider = h('input', { type: 'range', min, max, step, value: Math.max(min, Math.min(max, cur)), class: 'fld-slider', tabindex: '-1' });
  const input = h('input', { type: 'text', class: 'fld-num', value: tidy(cur), inputmode: 'decimal', spellcheck: 'false', autocomplete: 'off' });
  const paint = () => {
    const t = max > min ? (Math.max(min, Math.min(max, cur)) - min) / (max - min) : 0;
    slider.style.setProperty('--fill', `${(t * 100).toFixed(1)}%`);
    input.classList.toggle('out', cur < min - 1e-9 || cur > max + 1e-9);
  };
  const set = (v, final) => {
    cur = v;
    paint();
    onChange(v, final);
  };
  slider.addEventListener('input', () => { const v = parseFloat(slider.value); input.value = tidy(v); set(v, false); });
  slider.addEventListener('change', () => { const v = parseFloat(slider.value); input.value = tidy(v); set(v, true); });
  const fromText = () => {
    const v = evaluate(input.value, { x: cur });
    if (!Number.isFinite(v)) { input.classList.add('bad'); return; }
    input.classList.remove('bad');
    input.value = tidy(v);
    slider.value = Math.max(min, Math.min(max, v));
    if (v !== cur) set(v, true);
  };
  input.addEventListener('change', fromText);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { fromText(); input.select(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
      const v = parseFloat((cur + d).toFixed(6));
      input.value = tidy(v); slider.value = Math.max(min, Math.min(max, v));
      set(v, true);
    }
  });
  input.addEventListener('focus', () => input.select());
  const calc = h('button', { class: 'calc-btn', title: '電卓', tabindex: '-1', onclick: () => {
    openPad(calc, { label, unit, value: cur, onApply: (v) => {
      input.value = tidy(v); slider.value = Math.max(min, Math.min(max, v)); set(v, true);
    } });
  }, html: '<svg viewBox="0 0 16 16"><rect x="3" y="1.5" width="10" height="13" rx="1.5"/><rect x="5" y="3.5" width="6" height="2.5"/><path d="M5.5 8.5h.01M8 8.5h.01M10.5 8.5h.01M5.5 11h.01M8 11h.01M10.5 11h.01"/></svg>' });
  paint();
  return h('div', { class: 'fld' },
    h('div', { class: 'fld-top' },
      h('label', { class: 'fld-label', title: help || null }, label, help ? h('span', { class: 'fld-help', title: help }, '?') : null),
      h('div', { class: 'fld-box' }, input, unit ? h('span', { class: 'fld-unit' }, unit) : null, calc)),
    slider);
}

function selectField({ label, value, options, help = '', onChange }) {
  const sel = h('select', { class: 'fld-select', onchange: () => onChange(sel.value) },
    options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  sel.value = value;
  return h('div', { class: 'fld' }, h('div', { class: 'fld-top' },
    h('label', { class: 'fld-label', title: help || null }, label), sel));
}

function textField({ label, value, placeholder = '', onChange, multiline = false }) {
  const inp = multiline
    ? h('textarea', { class: 'fld-text', rows: 3, placeholder, onchange: () => onChange(inp.value) })
    : h('input', { type: 'text', class: 'fld-text', placeholder, onchange: () => onChange(inp.value) });
  inp.value = value ?? '';
  return h('div', { class: `fld${multiline ? ' col' : ''}` }, h('div', { class: 'fld-top' },
    h('label', { class: 'fld-label' }, label), inp));
}

function boolField({ label, value, help = '', onChange }) {
  const inp = h('input', { type: 'checkbox', checked: value, onchange: () => onChange(inp.checked) });
  return h('label', { class: 'fld-check', title: help || null }, inp, h('span', { class: 'switch' }), label);
}

function segmented(options, value, onPick, base = null) {
  return h('div', { class: 'seg' }, options.map((o) =>
    h('button', { class: `seg-btn${o.value === value ? ' on' : ''}${o.value === base ? ' base' : ''}`, title: o.title || o.label, onclick: () => onPick(o.value) }, o.label)));
}

function valueRows(vals) {
  return h('div', { class: 'vals' }, (vals || []).map((v) => h('div', { class: 'val' },
    h('span', { class: 'val-l' }, v.label),
    v.text != null
      ? h('span', { class: 'val-t' }, v.text)
      : h('span', { class: 'val-v' }, fmt(v.value, v.digits ?? 2), v.unit ? h('span', { class: 'val-u' }, v.unit) : null))));
}

const icon = (d) => `<svg viewBox="0 0 16 16"><path d="${d}"/></svg>`;
function actionBar(multi) {
  const btn = (title, ic, fn) => h('button', { class: 'act', title, onclick: fn, html: icon(ic) });
  const bar = h('div', { class: 'actions' },
    btn('右に 90° 回す（R）', 'M3 8a5 5 0 1 0 2-4M5 1v3.2H1.8', () => rotateSelection(90)),
    btn('左右を反転（F）', 'M8 2v12M6 4.5 2.5 8 6 11.5zM10 4.5 13.5 8 10 11.5z', () => flipSelection()),
    btn('複製（Ctrl+D）', 'M5.5 5.5h8v8h-8zM2.5 10.5v-8h8', () => duplicateSelection()),
    btn('削除（Delete）', 'M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5', () => deleteSelection()));
  if (multi) {
    const al = (title, ic, mode) => btn(title, ic, () => alignSelection(mode));
    bar.append(h('span', { class: 'act-sep' }),
      al('左端をそろえる', 'M2.5 2v12M5 4.5h7v2.5H5zM5 9h4.5v2.5H5z', 'left'),
      al('左右の中心をそろえる', 'M8 2v12M4 4.5h8v2.5H4zM5.5 9h5v2.5h-5z', 'hcenter'),
      al('右端をそろえる', 'M13.5 2v12M4 4.5h7v2.5H4zM6.5 9H11v2.5H6.5z', 'right'),
      al('上端をそろえる', 'M2 2.5h12M4.5 5v7H7V5zM9 5v4.5h2.5V5z', 'top'),
      al('上下の中心をそろえる', 'M2 8h12M4.5 4v8H7V4zM9 5.5v5h2.5v-5z', 'vcenter'),
      al('下端をそろえる', 'M2 13.5h12M4.5 4v7H7V4zM9 6.5V11h2.5V6.5z', 'bottom'));
  }
  return bar;
}

// --- 機器 ------------------------------------------------------------------------
function layersEditor(c, def, pd) {
  const p = paramsOf(c);
  const layers = Array.isArray(c.params.layers) ? c.params.layers : JSON.parse(JSON.stringify(p.layers || []));
  c.params.layers = layers;
  const kinds = def.layerKinds || [];
  const kindOf = (k) => kinds.find((q) => q.kind === k) || kinds[0];
  const lineLabel = (ln) => (ln === 'AB' ? 'A・B' : ln);
  const redo = () => { edit(() => commit()); rebuild(); };

  const box = h('div', { class: 'layers' });
  box.append(h('div', { class: 'layer fixed' }, h('span', { class: 'layer-no' }, '-1'),
    h('div', { class: 'layer-main' }, h('div', { class: 'layer-title' }, '電磁切換弁'), h('div', { class: 'layer-sub' }, 'いちばん上'))));
  layers.forEach((layer, i) => {
    const kd = kindOf(layer.kind);
    const kindSel = h('select', { class: 'fld-select', onchange: () => {
      const nk = kindOf(kindSel.value);
      const next = { kind: nk.kind, line: nk.lines.includes(layer.line) ? layer.line : nk.lines[0] };
      if (nk.modes) next.mode = 'out';
      for (const f of nk.fields) next[f.key] = f.default;
      layers[i] = next;
      redo();
    } }, kinds.map((k) => h('option', { value: k.kind, selected: k.kind === layer.kind }, k.name)));
    const lineSel = h('select', { class: 'fld-select narrow', title: kd.lineLabel || 'ライン', onchange: () => { layer.line = lineSel.value; redo(); } },
      kd.lines.map((ln) => h('option', { value: ln, selected: ln === layer.line }, lineLabel(ln))));
    const row = h('div', { class: 'layer' },
      h('span', { class: 'layer-no' }, `-${i + 2}`),
      h('div', { class: 'layer-main' },
        h('div', { class: 'layer-sel' }, kindSel, lineSel,
          kd.modes ? (() => { const m = h('select', { class: 'fld-select narrow', onchange: () => { layer.mode = m.value; redo(); } },
            kd.modes.map((o) => h('option', { value: o.value, selected: o.value === (layer.mode || 'out') }, o.label))); return m; })() : null),
        kd.fields.map((f) => numberField({
          label: f.label, unit: f.unit, min: f.min, max: f.max, step: f.step, value: layer[f.key] ?? f.default,
          onChange: (v, final) => { layer[f.key] = v; edit(() => (final ? commit() : touch())); },
        }))),
      h('div', { class: 'layer-btns' },
        h('button', { title: '電磁弁側へ', disabled: i === 0, onclick: () => { [layers[i - 1], layers[i]] = [layers[i], layers[i - 1]]; redo(); } }, '▲'),
        h('button', { title: 'ベース側へ', disabled: i === layers.length - 1, onclick: () => { [layers[i + 1], layers[i]] = [layers[i], layers[i + 1]]; redo(); } }, '▼'),
        h('button', { title: 'この段を外す', class: 'danger', onclick: () => { layers.splice(i, 1); redo(); } }, '×')));
    box.append(row);
  });
  box.append(h('div', { class: 'layer fixed' }, h('span', { class: 'layer-no' }, '—'),
    h('div', { class: 'layer-main' }, h('div', { class: 'layer-title' }, 'ベース（マニホールド）'), h('div', { class: 'layer-sub' }, 'P・T・B・A ポート'))));
  const add = h('button', { class: 'btn ghost wide', onclick: () => {
    const k = kinds.find((q) => q.kind === 'tcheck') || kinds[0];
    const next = { kind: k.kind, line: k.lines[k.lines.length - 1] };
    if (k.modes) next.mode = 'out';
    for (const f of k.fields) next[f.key] = f.default;
    layers.push(next);
    redo();
  } }, '＋ 段を足す（ベース側）');
  return h('div', {}, h('div', { class: 'hint' }, '上が電磁弁側、下がベース側。積層の順序は診断で確認できます。'), box, add);
}

function componentPanel(c) {
  const def = typeDef(c.type);
  const p = paramsOf(c);
  const frag = [];
  frag.push(h('div', { class: 'ins-head' },
    h('div', { class: 'ins-kind' }, def.category === '_internal' ? '配管' : (state.lib.categories.find((q) => q.id === def.category) || {}).name || ''),
    h('div', { class: 'ins-title' }, def.name),
    h('div', { class: 'ins-sub' }, def.en || ''),
    def.jis ? h('div', { class: 'ins-jis' }, def.jis) : null));
  if (c.type !== 'junction') frag.push(actionBar(false));

  const basics = [];
  if (def.tag !== '' || c.tag) {
    basics.push(textField({ label: '機器番号', value: c.tag, onChange: (v) => { c.tag = v.trim(); edit(() => commit()); } }));
  }
  if (def.states) {
    const step = currentStep();
    const seg = h('div', { class: 'fld' }, h('div', { class: 'fld-top' },
      h('label', { class: 'fld-label' }, `状態（工程「${step.name}」）`),
      segmented(def.states.options, stateOf(c), (v) => { setStateOf(c, v); edit(() => commit()); rebuild(); }, def.states.default)));
    basics.push(seg);
  }
  if (basics.length) frag.push(section('基本', basics, { key: 'basic' }));

  const groups = new Map();
  for (const pd of def.params) {
    const g = pd.group || '仕様';
    if (!groups.has(g)) groups.set(g, []);
    const setParam = (v, final = true) => {
      c.params[pd.key] = v;
      edit(() => (final ? commit() : touch()));
    };
    let el;
    if (pd.type === 'select') {
      el = selectField({ label: pd.label, value: p[pd.key], options: pd.options, help: pd.help, onChange: (v) => {
        c.params[pd.key] = v;
        const opt = pd.options.find((o) => o.value === v);
        if (opt && opt.set) Object.assign(c.params, opt.set);
        edit(() => commit());
        if (opt && opt.set) rebuild();
      } });
    } else if (pd.type === 'bool') {
      el = boolField({ label: pd.label, value: p[pd.key] === true || p[pd.key] === 'true', help: pd.help, onChange: (v) => setParam(v) });
    } else if (pd.type === 'text') {
      el = textField({ label: pd.label, value: p[pd.key], onChange: (v) => setParam(v) });
    } else if (pd.type === 'layers') {
      el = layersEditor(c, def, pd);
    } else {
      el = numberField({ label: pd.label, unit: pd.unit, min: pd.min, max: pd.max, step: pd.step, value: p[pd.key], help: pd.help, onChange: setParam });
    }
    groups.get(g).push(el);
  }
  for (const [g, els] of groups) {
    frag.push(section(g, els, { key: `g.${g}`, open: g !== '機器表' && g !== '計算' }));
  }

  resultsHost = h('div', {});
  resultsFn = () => {
    const res = stepResult();
    const r = res && res.comps ? res.comps[c.id] : null;
    resultsHost.replaceChildren();
    if (!r) { resultsHost.append(h('div', { class: 'hint' }, '計算結果はまだありません。')); return; }
    resultsHost.append(valueRows(r.values));
    if (r.extra && r.extra.detail && r.extra.detail.length) {
      resultsHost.append(h('div', { class: 'sub-title' }, '各部の流量と損失'),
        h('table', { class: 'mini' },
          h('thead', {}, h('tr', {}, h('th', {}, '部位'), h('th', {}, 'L/min'), h('th', {}, 'ΔP MPa'), h('th', {}, 'W'))),
          h('tbody', {}, r.extra.detail.map((d) => h('tr', {},
            h('td', {}, d.name), h('td', {}, fmt(d.q, 1)), h('td', {}, fmt(d.dp, 2)), h('td', {}, fmt(d.heat, 0)))))));
    }
    const ports = Object.entries(r.ports || {});
    if (ports.length && c.type !== 'junction') {
      resultsHost.append(h('div', { class: 'sub-title' }, 'ポート'),
        h('table', { class: 'mini' },
          h('thead', {}, h('tr', {}, h('th', {}, 'ポート'), h('th', {}, '圧力 MPa'), h('th', {}, '流量 L/min'))),
          h('tbody', {}, ports.map(([name, v]) => h('tr', {},
            h('td', {}, name), h('td', {}, fmt(v.p, 2)),
            h('td', {}, Math.abs(v.q) < 0.005 ? '0.0' : `${v.q > 0 ? '出 ' : '入 '}${fmt(Math.abs(v.q), 1)}`))))));
    }
  };
  resultsFn();
  frag.push(section(`計算結果（工程「${currentStep().name}」）`, resultsHost, { key: 'res' }));
  return frag;
}

// --- 配線 ------------------------------------------------------------------------
const USE_NAME = { suction: '吸込配管', return: '戻り配管', pressure: '圧力配管', pilot: 'パイロット配管', drain: 'ドレン配管' };

function wirePanel(w) {
  const frag = [];
  const pipes = state.lib.standards.pipes;
  const endName = (e) => { const c = compById(e.c); return c ? (c.type === 'junction' ? '分岐点' : `${c.tag || typeDef(c.type).name} ${e.p}`) : '?'; };
  frag.push(h('div', { class: 'ins-head' }, h('div', { class: 'ins-kind' }, '配管'),
    h('div', { class: 'ins-title' }, `${endName(w.a)} → ${endName(w.b)}`),
    h('div', { class: 'ins-jis' }, 'JIS B 0125 表 1 線: 主管路は実線、パイロット・ドレン管路は破線')));
  const pipe = w.pipe || (w.pipe = {});
  const els = [];
  els.push(selectField({ label: '管路の種類', value: w.kind || 'main',
    options: [{ value: 'main', label: '主管路（実線）' }, { value: 'pilot', label: 'パイロット管路（破線）' }, { value: 'drain', label: 'ドレン管路（破線）' }],
    onChange: (v) => { w.kind = v; edit(() => commit()); } }));
  els.push(selectField({ label: '管のサイズ', value: pipe.size || '',
    options: [{ value: '', label: '（未設定・損失なし）' }, ...pipes.map((q) => ({ value: q.id, label: q.label })), { value: 'custom', label: '内径を直接入力（ホースなど）' }],
    onChange: (v) => { pipe.size = v; if (v && v !== 'custom') delete pipe.id_mm; edit(() => commit()); rebuild(); } }));
  if (pipe.size === 'custom') {
    els.push(numberField({ label: '内径', unit: 'mm', min: 3, max: 130, step: 0.1, value: pipe.id_mm || 9.5,
      onChange: (v, f) => { pipe.id_mm = v; edit(() => (f ? commit() : touch())); } }));
  }
  els.push(numberField({ label: '長さ', unit: 'm', min: 0, max: 30, step: 0.1, value: pipe.len || 0,
    help: '0 のときは圧力損失を計算しない（流速だけ出す）',
    onChange: (v, f) => { pipe.len = v; edit(() => (f ? commit() : touch())); } }));
  els.push(numberField({ label: 'エルボの数', unit: '個', min: 0, max: 20, step: 1, value: pipe.bends || 0,
    help: '90° エルボ 1 個につき損失係数 k = 1.2',
    onChange: (v, f) => { pipe.bends = Math.round(v); edit(() => (f ? commit() : touch())); } }));
  if (w.pts) els.push(h('button', { class: 'btn ghost wide', onclick: () => rerouteSelection() }, '経路を自動に戻す'));
  frag.push(section('配管の仕様', els, { key: 'wire' }));

  resultsHost = h('div', {});
  resultsFn = () => {
    const res = stepResult();
    const r = res && res.wires ? res.wires[w.id] : null;
    const sum = state.results && state.results.wires ? state.results.wires[w.id] : null;
    resultsHost.replaceChildren();
    if (!r) { resultsHost.append(h('div', { class: 'hint' }, '計算結果はまだありません。')); return; }
    const vals = [
      { label: '用途（自動判定）', text: sum ? USE_NAME[sum.use] : '' },
      { label: '流量', value: Math.abs(r.q), unit: 'L/min', digits: 1 },
      { label: '圧力', value: Math.max(r.pa, r.pb), unit: 'MPa', digits: 2 },
    ];
    if (r.v != null) {
      vals.push({ label: '流速', value: r.v, unit: 'm/s', digits: 2 });
      vals.push({ label: 'レイノルズ数', text: `${fmt(r.re, 0)}（${r.re <= 2000 ? '層流' : '乱流'}）` });
      vals.push({ label: '圧力損失', value: Math.abs(r.dp), unit: 'MPa', digits: 3 });
      vals.push({ label: '発熱', value: r.heat, unit: 'W', digits: 0 });
    }
    resultsHost.append(valueRows(vals));
    if (sum && sum.guide) {
      const [lo, hi] = sum.guide;
      resultsHost.append(h('div', { class: 'hint' }, `流速の目安 ${lo}～${hi} m/s（全工程の最大 ${fmt(sum.v_max, 1)} m/s、最大流量 ${fmt(sum.q_max, 1)} L/min）`));
      if (sum.suggest) {
        const sp = pipes.find((q) => q.id === sum.suggest);
        resultsHost.append(h('div', { class: 'suggest' },
          h('div', {}, h('span', { class: 'suggest-k' }, '推奨'), sp ? sp.label : sum.suggest),
          h('button', { class: 'btn small', onclick: () => { pipe.size = sum.suggest; delete pipe.id_mm; edit(() => commit()); rebuild(); } }, '適用')));
      }
    }
  };
  resultsFn();
  frag.push(section(`計算結果（工程「${currentStep().name}」）`, resultsHost, { key: 'res' }));
  return frag;
}

// --- 回路全体 ----------------------------------------------------------------------
function tempChart(th, maxTemp, amb) {
  const W = 260, H = 110, L = 30, R = 8, T = 8, B = 22;
  const pts = th.curve || [];
  if (!pts.length) return h('div', {});
  const tmax = pts[pts.length - 1][0] || 1;
  const hi = Math.max(maxTemp + 5, th.steady + 5, amb + 10);
  const lo = Math.min(amb - 2, 20);
  const X = (t) => L + (W - L - R) * t / tmax;
  const Y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const line = pts.map((q, i) => `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)} ${Y(q[1]).toFixed(1)}`).join('');
  const area = `${line}L${X(tmax).toFixed(1)} ${Y(lo).toFixed(1)}L${X(0).toFixed(1)} ${Y(lo).toFixed(1)}Z`;
  const ticks = [];
  const stepY = hi - lo > 80 ? 40 : (hi - lo > 40 ? 20 : 10);
  for (let v = Math.ceil(lo / stepY) * stepY; v <= hi; v += stepY) ticks.push(v);
  const over = th.steady > maxTemp + 0.05;
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart ${over ? 'over' : ''}">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 4}" y="${Y(v) + 3}" class="ax" text-anchor="end">${v}</text>`).join('')}
    <line x1="${L}" x2="${W - R}" y1="${Y(maxTemp)}" y2="${Y(maxTemp)}" class="limit"/>
    <text x="${W - R}" y="${Y(maxTemp) - 3}" class="ax lim" text-anchor="end">許容 ${fmt(maxTemp, 0)} ℃</text>
    <path d="${area}" class="fill"/><path d="${line}" class="curve"/>
    ${[0, 0.25, 0.5, 0.75, 1].map((f) => `<text x="${X(tmax * f)}" y="${H - 8}" class="ax" text-anchor="middle">${(tmax * f).toFixed(tmax < 5 ? 1 : 0)}</text>`).join('')}
    <text x="${W - R}" y="${H - 0.5}" class="ax" text-anchor="end">運転時間 h</text><text x="2" y="9" class="ax">℃</text>
  </svg>`;
  return h('div', { class: 'chart-box', html: svg });
}

function summaryBody() {
  const r = state.results;
  const box = h('div', {});
  if (!r) { box.append(h('div', { class: 'hint' }, '計算中…')); return box; }
  if (!r.ok) { box.append(h('div', { class: 'hint err' }, `計算に失敗しました: ${r.error || ''}`)); return box; }
  const sr = stepResult();
  const cy = r.cycle, th = r.thermal, st = r.settings;
  const card = (label, value, unit, cls = '') => h('div', { class: `card ${cls}` },
    h('div', { class: 'card-l' }, label), h('div', { class: 'card-v' }, value, h('span', { class: 'card-u' }, unit)));
  if (sr) {
    const t = sr.totals;
    box.append(h('div', { class: 'sub-title' }, `工程「${sr.name}」`),
      h('div', { class: 'cards' },
        card('軸入力', fmt(t.shaft, 2), 'kW'),
        card('仕事', fmt(t.mech, 2), 'kW'),
        card('発熱', fmt(t.heat, 2), 'kW', 'heat'),
        card('効率', t.shaft > 1e-6 ? fmt(t.mech / t.shaft * 100, 0) : '—', '%')));
    if (!sr.converged) box.append(h('div', { class: 'hint err' }, 'この工程は計算が収束していません。'));
  }
  const over = th.steady > st.maxTemp + 0.05;
  box.append(h('div', { class: 'sub-title' }, `サイクル全体（${fmt(cy.time, 1)} s）`),
    h('div', { class: 'cards' },
      card('平均発熱', fmt(cy.heat, 2), 'kW', 'heat'),
      card('推定油温', fmt(th.steady, 0), '℃', over ? 'bad' : 'good'),
      card('必要クーラ', fmt(th.coolerNeed, 2), 'kW', th.coolerNeed > 0.005 ? 'warn' : ''),
      card('推奨電動機', cy.motor != null ? String(cy.motor) : '—', 'kW')),
    tempChart(th, st.maxTemp, st.ambTemp),
    valueRows([
      { label: 'ポンプ吐出量（合計）', value: cy.pumpFlow, unit: 'L/min', digits: 1 },
      { label: '軸入力（二乗平均 / 最大）', text: `${fmt(cy.shaftRms, 2)} / ${fmt(cy.shaftPeak, 2)} kW` },
      { label: 'サイクル効率', text: cy.efficiency != null ? `${fmt(cy.efficiency, 0)} %` : '—' },
      { label: 'クーラの交換熱量（平均）', value: cy.cooling, unit: 'kW', digits: 2 },
      { label: `放熱面積${th.areaAuto ? '（油量から見積もり）' : ''}`, value: th.area, unit: 'm²', digits: 2 },
      { label: 'タンクの放熱能力', text: `${fmt(th.ka, 1)} W/K（許容油温で ${fmt(th.tankAllow, 2)} kW）` },
      { label: '油温の時定数', value: th.tau / 3600, unit: 'h', digits: 1 },
      { label: `動粘度（${fmt(r.fluid.temp, 0)} ℃）`, value: r.fluid.nu, unit: 'mm²/s', digits: 1 },
      { label: '密度', value: r.fluid.rho, unit: 'kg/m³', digits: 0 },
    ]));
  return box;
}

function docPanel() {
  const d = state.doc;
  const frag = [];
  frag.push(h('div', { class: 'ins-head' }, h('div', { class: 'ins-kind' }, '回路全体'),
    h('div', { class: 'ins-title' }, d.meta.title || '（無題）'),
    h('div', { class: 'ins-sub' }, '機器や配管をクリックすると、その設定がここに出ます')));

  resultsHost = h('div', {});
  resultsFn = () => resultsHost.replaceChildren(summaryBody());
  resultsFn();
  frag.push(section('集計', resultsHost, { key: 'sum' }));

  const s = d.settings;
  const setS = (k) => (v, f = true) => { s[k] = v; edit(() => (f ? commit() : touch())); };
  frag.push(section('計算条件', [
    selectField({ label: '作動油', value: s.fluid, options: state.lib.standards.fluids.map((f) => ({ value: f.id, label: f.name })), onChange: setS('fluid') }),
    numberField({ label: '油温（計算に使う）', unit: '℃', min: 10, max: 80, step: 1, value: s.oilTemp, help: '粘度と密度をこの温度で求める', onChange: setS('oilTemp') }),
    numberField({ label: '周囲温度', unit: '℃', min: -10, max: 50, step: 1, value: s.ambTemp, onChange: setS('ambTemp') }),
    numberField({ label: '許容油温', unit: '℃', min: 30, max: 80, step: 1, value: s.maxTemp, onChange: setS('maxTemp') }),
    numberField({ label: 'タンク油量', unit: 'L', min: 10, max: 2000, step: 5, value: s.tankVolume, help: 'ポンプ吐出量（L/min）の 3～5 倍が一般的な目安', onChange: setS('tankVolume') }),
    numberField({ label: 'タンクの放熱面積', unit: 'm²', min: 0, max: 30, step: 0.05, value: s.tankArea, help: '0 のときは油量から見積もる: A ≈ 0.065·V^(2/3)', onChange: setS('tankArea') }),
    numberField({ label: 'タンク表面の熱通過率', unit: 'W/m²K', min: 5, max: 30, step: 0.5, value: s.tankK, help: '風通しの悪い場所で 8、ふつうで 12、風が当たる場所で 20 程度', onChange: setS('tankK') }),
  ], { key: 'cond' }));

  const m = d.meta;
  const setM = (k) => (v) => { m[k] = v; edit(() => commit()); };
  frag.push(section('図面情報（表題欄）', [
    textField({ label: '名称', value: m.title, onChange: (v) => { m.title = v; edit(() => commit()); rebuild(); } }),
    textField({ label: '図番', value: m.drawingNo, onChange: setM('drawingNo') }),
    textField({ label: '案件', value: m.project, onChange: setM('project') }),
    textField({ label: '客先', value: m.customer, onChange: setM('customer') }),
    textField({ label: '設計', value: m.author, onChange: setM('author') }),
    textField({ label: '検図', value: m.checker, onChange: setM('checker') }),
    textField({ label: '承認', value: m.approver, onChange: setM('approver') }),
    textField({ label: '日付', value: m.date, onChange: setM('date') }),
    textField({ label: '改訂', value: m.rev, onChange: setM('rev') }),
    selectField({ label: '用紙', value: m.sheet, options: Object.entries(SHEETS).map(([k, v]) => ({ value: k, label: v.name })), onChange: setM('sheet') }),
    boolField({ label: '機器表を図面に載せる', value: m.showBom !== false, onChange: setM('showBom') }),
    textField({ label: '注記（1 行に 1 件）', value: m.notes, multiline: true, onChange: setM('notes') }),
  ], { key: 'meta', open: false }));

  frag.push(section('製図と配管', [
    selectField({ label: '管路の交差', value: s.crossStyle || 'jump',
      options: [{ value: 'jump', label: '半円で飛び越す（JIS B 0125-1984）' }, { value: 'plain', label: '直交させる（接続は点で示す）' }],
      onChange: setS('crossStyle') }),
    h('button', { class: 'btn ghost wide', onclick: applySuggestedPipes }, '全配管に推奨サイズを入れる'),
    h('div', { class: 'hint' }, '流速の目安（吸込 0.5～1.5、圧力 2.5～6、戻り 1.5～4 m/s）から、全工程の最大流量で管を選びます。'),
  ], { key: 'draft', open: false }));
  return frag;
}

function applySuggestedPipes() {
  const sums = state.results && state.results.wires;
  if (!sums) return;
  let n = 0;
  for (const w of state.doc.wires) {
    const s = sums[w.id];
    if (s && s.suggest) { w.pipe = { ...(w.pipe || {}), size: s.suggest }; delete w.pipe.id_mm; n++; }
  }
  if (n) { edit(() => commit()); rebuild(); }
}

function multiPanel(ids) {
  const comps = ids.filter((id) => compById(id)).length;
  const wires = ids.filter((id) => wireById(id)).length;
  return [
    h('div', { class: 'ins-head' }, h('div', { class: 'ins-kind' }, '複数選択'),
      h('div', { class: 'ins-title' }, `${ids.length} 個を選択中`),
      h('div', { class: 'ins-sub' }, `機器 ${comps}、配管 ${wires}`)),
    actionBar(true),
    h('div', { class: 'hint pad' }, 'ドラッグでまとめて動かせます。矢印キーで 2.5 mm ずつ、Shift を押すと 10 mm ずつ動きます。'),
  ];
}

function framePanel(f) {
  return [
    h('div', { class: 'ins-head' }, h('div', { class: 'ins-kind' }, '製図'), h('div', { class: 'ins-title' }, '包囲線'),
      h('div', { class: 'ins-jis' }, 'JIS B 0125 表 1 一点鎖線: 二つ以上の機能をもつユニットを表す包囲線')),
    section('基本', [
      textField({ label: '名称', value: f.label, placeholder: '例: 油圧ユニット', onChange: (v) => { f.label = v; edit(() => commit()); } }),
      h('button', { class: 'btn ghost wide danger', onclick: () => deleteSelection() }, '削除'),
    ]),
  ];
}

function notePanel(t) {
  return [
    h('div', { class: 'ins-head' }, h('div', { class: 'ins-kind' }, '製図'), h('div', { class: 'ins-title' }, '文字')),
    section('基本', [
      textField({ label: '文字', value: t.text, multiline: true, onChange: (v) => { t.text = v; edit(() => commit()); } }),
      numberField({ label: '文字の高さ', unit: 'mm', min: 2, max: 10, step: 0.5, value: t.size || 3, onChange: (v, f) => { t.size = v; edit(() => (f ? commit() : touch())); } }),
      h('button', { class: 'btn ghost wide danger', onclick: () => deleteSelection() }, '削除'),
    ]),
  ];
}

export function rebuild() {
  if (!root || !state.doc) return;
  const scroll = root.scrollTop;
  resultsHost = null; resultsFn = null;
  const ids = [...state.sel];
  let frag;
  if (ids.length === 0) frag = docPanel();
  else if (ids.length > 1) frag = multiPanel(ids);
  else {
    const id = ids[0];
    const c = compById(id), w = wireById(id), f = frameById(id), t = textById(id);
    if (c) frag = componentPanel(c);
    else if (w) frag = wirePanel(w);
    else if (f) frag = framePanel(f);
    else if (t) frag = notePanel(t);
    else frag = docPanel();
  }
  root.replaceChildren(...frag);
  root.scrollTop = scroll;
}

export function initInspector(el) {
  root = el;
  on('sel', () => { root.scrollTop = 0; rebuild(); });
  on('doc', (d) => { if (!selfEdit || (d && (d.restored || d.loaded))) rebuild(); });
  on('results', () => { if (resultsFn) resultsFn(); });
  on('step', () => rebuild());
}
