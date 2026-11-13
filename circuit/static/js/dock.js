// 下のパネル: 工程表（ソレノイド作動表）・診断・機器表。
import {
  state, on, typeDef, compById, wireById, stateOf, setStateOf, commit, select, setStep, uid, fmt,
} from './store.js';
import { bomRows } from './sheet.js';
import { h } from './inspector.js';

let root, body, tabs;
let tab = localStorage.getItem('hc.dock') || 'steps';

const statefulComps = () => state.doc.components.filter((c) => { const d = typeDef(c.type); return d && d.states; });

function stepsView() {
  const d = state.doc;
  const comps = statefulComps();
  const res = state.results && state.results.ok ? state.results.steps : [];
  const table = h('table', { class: 'steps' });
  table.append(h('thead', {}, h('tr', {},
    h('th', { class: 'c-no' }, '#'), h('th', { class: 'c-name' }, '工程'), h('th', { class: 'c-time' }, '時間 s'),
    comps.map((c) => h('th', { class: 'c-state', title: typeDef(c.type).name }, c.tag || typeDef(c.type).name)),
    h('th', { class: 'c-num' }, '軸入力 kW'), h('th', { class: 'c-num' }, '仕事 kW'), h('th', { class: 'c-num' }, '発熱 kW'),
    h('th', { class: 'c-ops' }, ''))));
  const tb = h('tbody');
  d.steps.forEach((s, i) => {
    const r = res.find((q) => q.id === s.id);
    const name = h('input', { type: 'text', class: 'cell-in', value: s.name, onchange: () => { s.name = name.value || `工程 ${i + 1}`; commit(); } });
    const dur = h('input', { type: 'text', class: 'cell-in num', value: s.duration > 0 ? String(s.duration) : '',
      placeholder: r ? `自動 ${fmt(r.duration, 1)}` : '自動', title: '空欄のときはシリンダのストローク時間を使う',
      onchange: () => { const v = parseFloat(dur.value); s.duration = Number.isFinite(v) && v > 0 ? v : 0; commit(); } });
    for (const inp of [name, dur]) inp.addEventListener('keydown', (e) => e.stopPropagation());
    const row = h('tr', { class: i === state.stepIndex ? 'active' : '', onclick: (e) => {
      if (e.target.closest('input,button')) return;
      setStep(i);
    } },
      h('td', { class: 'c-no' }, h('span', { class: 'step-no' }, String(i + 1))),
      h('td', { class: 'c-name' }, name),
      h('td', { class: 'c-time' }, dur),
      comps.map((c) => {
        const def = typeDef(c.type);
        const cur = stateOf(c, s);
        return h('td', { class: 'c-state' }, h('div', { class: 'seg tiny' }, def.states.options.map((o) =>
          h('button', { class: `seg-btn${o.value === cur ? ' on' : ''}${o.value === def.states.default ? ' base' : ''}`, title: o.title || o.label,
            onclick: () => { setStateOf(c, o.value, s); state.stepIndex = i; commit(); setStep(i); } }, o.label))));
      }),
      h('td', { class: 'c-num' }, r ? fmt(r.totals.shaft, 2) : '—'),
      h('td', { class: 'c-num' }, r ? fmt(r.totals.mech, 2) : '—'),
      h('td', { class: `c-num heat${r && !r.converged ? ' bad' : ''}`, title: r && !r.converged ? '収束していません' : null }, r ? fmt(r.totals.heat, 2) : '—'),
      h('td', { class: 'c-ops' },
        h('button', { title: '上へ', disabled: i === 0, onclick: () => { [d.steps[i - 1], d.steps[i]] = [d.steps[i], d.steps[i - 1]]; state.stepIndex = i - 1; commit(); setStep(i - 1); } }, '▲'),
        h('button', { title: '下へ', disabled: i === d.steps.length - 1, onclick: () => { [d.steps[i + 1], d.steps[i]] = [d.steps[i], d.steps[i + 1]]; state.stepIndex = i + 1; commit(); setStep(i + 1); } }, '▼'),
        h('button', { title: 'この工程を複製', onclick: () => {
          d.steps.splice(i + 1, 0, { id: uid('s'), name: `${s.name} の複製`, duration: s.duration, states: { ...s.states } });
          state.stepIndex = i + 1; commit(); setStep(i + 1);
        } }, '⧉'),
        h('button', { title: 'この工程を削除', class: 'danger', disabled: d.steps.length <= 1, onclick: () => {
          d.steps.splice(i, 1); state.stepIndex = Math.max(0, i - 1); commit(); setStep(state.stepIndex);
        } }, '×')));
    tb.append(row);
  });
  table.append(tb);
  const cy = state.results && state.results.ok ? state.results.cycle : null;
  const foot = h('div', { class: 'steps-foot' },
    h('button', { class: 'btn small', onclick: () => {
      const cur = d.steps[state.stepIndex];
      d.steps.push({ id: uid('s'), name: `工程 ${d.steps.length + 1}`, duration: 0, states: { ...(cur ? cur.states : {}) } });
      state.stepIndex = d.steps.length - 1; commit(); setStep(state.stepIndex);
    } }, '＋ 工程を足す'),
    h('span', { class: 'steps-note' }, comps.length ? '弁の位置やシリンダの状態を工程ごとに選びます。図面の弁をダブルクリックしても切り換わります。'
      : '切換弁やシリンダを置くと、ここで工程ごとの状態を選べます。'),
    cy ? h('span', { class: 'steps-sum' }, `1 サイクル ${fmt(cy.time, 1)} s　平均発熱 ${fmt(cy.heat, 2)} kW　軸入力（二乗平均） ${fmt(cy.shaftRms, 2)} kW`) : null);
  return h('div', { class: 'dock-scroll' }, table, foot);
}

const LEVEL = { error: 'エラー', warn: '注意', info: '情報' };

function diagView() {
  const r = state.results;
  if (!r) return h('div', { class: 'dock-empty' }, '計算中…');
  if (!r.ok) return h('div', { class: 'dock-empty err' }, `計算に失敗しました: ${r.error || ''}`);
  const list = r.diagnostics || [];
  if (!list.length) return h('div', { class: 'dock-empty ok' }, '気になる点は見つかりませんでした。');
  return h('div', { class: 'dock-scroll diag' }, list.map((d) => {
    const c = d.ref ? compById(d.ref) : null;
    const w = d.ref && !c ? wireById(d.ref) : null;
    let who = '';
    if (c) who = c.tag || typeDef(c.type).name;
    else if (w) { const a = compById(w.a.c), b = compById(w.b.c); who = `配管 ${a ? a.tag || '分岐' : ''} → ${b ? b.tag || '分岐' : ''}`; }
    return h('button', { class: `diag-item ${d.level}`, onclick: () => { if (c || w) select(d.ref); } },
      h('span', { class: 'diag-level' }, LEVEL[d.level] || d.level),
      who ? h('span', { class: 'diag-who' }, who) : null,
      h('span', { class: 'diag-msg' }, d.msg),
      d.steps && d.steps.length ? h('span', { class: 'diag-steps' }, d.steps.join('、')) : null);
  }));
}

function bomView() {
  const rows = bomRows();
  if (!rows.length) return h('div', { class: 'dock-empty' }, '機器はまだありません。');
  return h('div', { class: 'dock-scroll' }, h('table', { class: 'bom-table' },
    h('thead', {}, h('tr', {}, ['番号', '名称', '形式', '仕様', 'メーカー', '備考'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', { onclick: () => select(r.id) },
      h('td', { class: 'mono' }, r.tag), h('td', {}, r.name), h('td', {}, r.model), h('td', {}, r.spec), h('td', {}, r.maker), h('td', {}, r.note))))));
}

function draw() {
  if (!state.doc) return;
  const diags = state.results && state.results.ok ? state.results.diagnostics || [] : [];
  const nWarn = diags.filter((d) => d.level !== 'info').length;
  tabs.querySelectorAll('button[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const badge = tabs.querySelector('.badge');
  badge.textContent = nWarn ? String(nWarn) : (diags.length ? String(diags.length) : '');
  badge.className = `badge${nWarn ? ' warn' : (diags.length ? ' info' : '')}`;
  const focus = document.activeElement && body.contains(document.activeElement);
  if (focus) return;       // 入力中は作り直さない
  body.replaceChildren(tab === 'steps' ? stepsView() : (tab === 'diag' ? diagView() : bomView()));
}

export function initDock(el) {
  root = el;
  tabs = h('div', { class: 'dock-tabs' },
    h('button', { 'data-tab': 'steps' }, '工程表'),
    h('button', { 'data-tab': 'diag' }, '診断', h('span', { class: 'badge' })),
    h('button', { 'data-tab': 'bom' }, '機器表'),
    h('span', { class: 'dock-space' }),
    h('button', { class: 'dock-fold', title: 'パネルをたたむ / 開く', onclick: () => {
      root.classList.toggle('folded');
      localStorage.setItem('hc.dock.fold', root.classList.contains('folded') ? '1' : '0');
    } }, '▾'));
  body = h('div', { class: 'dock-body' });
  root.replaceChildren(tabs, body);
  if (localStorage.getItem('hc.dock.fold') === '1') root.classList.add('folded');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    localStorage.setItem('hc.dock', tab);
    root.classList.remove('folded');
    if (document.activeElement) document.activeElement.blur();
    draw();
  });
  body.addEventListener('focusout', () => setTimeout(draw, 0));
  on('doc', draw);
  on('results', draw);
  on('step', draw);
}
