// 起動と全体のつなぎ込み: ライブラリの読み込み、回路の保存、計算の呼び出し、ツールバー。
import {
  state, on, setDoc, newDoc, setResults, setView, loadView, undo, redo, canUndo, canRedo, commit, stepResult, fmt, today,
} from './store.js';
import {
  initEditor, fitView, zoomBy, setTool, onTool, onZoom, rerouteSelection,
} from './editor.js';
import { initInspector, h } from './inspector.js';
import { initPalette } from './palette.js';
import { initDock } from './dock.js';
import { openPrintDialog, openReport, downloadJson, downloadSvg } from './print.js';

const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `サーバーの応答 ${res.status}`);
  return data;
}

// --- 小さな通知 --------------------------------------------------------------------
let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

// --- モーダル ------------------------------------------------------------------------
function showModal(title, body, { wide = false } = {}) {
  const root = $('#modal-root');
  const close = () => { root.replaceChildren(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const box = h('div', { class: `modal${wide ? ' wide' : ''}` },
    h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, title), h('button', { class: 'modal-x', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, body));
  const back = h('div', { class: 'modal-back', onpointerdown: (e) => { if (e.target === back) close(); } }, box);
  root.replaceChildren(back);
  document.addEventListener('keydown', onKey, true);
  return close;
}

// --- 計算 ------------------------------------------------------------------------------
let calcTimer = null, calcSeq = 0, calcCtl = null;
function scheduleCalc(delay = 70) {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(runCalc, delay);
}

async function runCalc() {
  const d = state.doc;
  if (!d) return;
  const seq = ++calcSeq;
  if (calcCtl) calcCtl.abort();
  calcCtl = new AbortController();
  const t0 = performance.now();
  $('#calc-state').className = 'busy';
  try {
    const res = await fetch('/api/calc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: calcCtl.signal,
      body: JSON.stringify({
        id: d.id, settings: d.settings, steps: d.steps,
        components: d.components.map((c) => ({ id: c.id, type: c.type, params: c.params })),
        wires: d.wires.map((w) => ({ id: w.id, a: w.a, b: w.b, kind: w.kind, pipe: w.pipe })),
      }),
    });
    const data = await res.json();
    if (seq !== calcSeq) return;
    setResults(data);
    const el = $('#calc-state');
    const ms = Math.round(performance.now() - t0);
    if (!data.ok) { el.className = 'err'; el.textContent = '計算エラー'; el.title = data.error || ''; }
    else {
      const bad = data.steps.filter((s) => !s.converged).length;
      el.className = bad ? 'warn' : 'ok';
      el.textContent = bad ? `未収束 ${bad} 工程` : `計算済み ${ms} ms`;
      el.title = '回路を変えるたびに自動で計算し直します';
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('#calc-state').className = 'err';
    $('#calc-state').textContent = '計算できません';
    setResults({ ok: false, error: String(err.message || err) });
  }
}

// --- 保存 ------------------------------------------------------------------------------
let saveTimer = null, saving = false, saveAgain = false;
function scheduleSave() {
  $('#save-state').textContent = '未保存';
  $('#save-state').className = 'dirty';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}

async function saveNow() {
  clearTimeout(saveTimer);
  const d = state.doc;
  if (!d) return;
  if (saving) { saveAgain = true; return; }
  saving = true;
  try {
    if (!d.id) {
      const info = await api('/api/circuits', { method: 'POST', body: d });
      d.id = info.id;
    } else {
      await api(`/api/circuits/${d.id}`, { method: 'PUT', body: d });
    }
    localStorage.setItem('hc.last', d.id);
    history.replaceState(null, '', `#${d.id}`);
    state.dirty = false;
    $('#save-state').textContent = '保存済み';
    $('#save-state').className = 'saved';
  } catch (err) {
    $('#save-state').textContent = '保存できません';
    $('#save-state').className = 'err';
    toast(`保存に失敗しました: ${err.message}`, 'err');
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; scheduleSave(); }
  }
}

async function openCircuit(id) {
  const doc = await api(`/api/circuits/${id}`);
  setDoc(doc);
  localStorage.setItem('hc.last', id);
  history.replaceState(null, '', `#${id}`);
  $('#save-state').textContent = '保存済み';
  $('#save-state').className = 'saved';
}

async function createFrom(doc) {
  delete doc.id;
  if (doc.meta && !doc.meta.date) doc.meta.date = today();
  setDoc(doc);
  await saveNow();
}

// --- ファイル画面 ------------------------------------------------------------------------
async function openFileDialog() {
  const [list, samples] = await Promise.all([api('/api/circuits'), api('/api/samples')]);
  let close = () => {};
  const row = (c) => h('div', { class: `file-row${state.doc && c.id === state.doc.id ? ' cur' : ''}` },
    h('button', { class: 'file-open', onclick: async () => { await saveIfDirty(); await openCircuit(c.id); close(); } },
      h('span', { class: 'file-title' }, c.title), h('span', { class: 'file-sub' }, [c.drawingNo, c.project].filter(Boolean).join('　')),
      h('span', { class: 'file-date' }, c.modified)),
    h('button', { class: 'file-act', title: '複製', onclick: async () => {
      const doc = await api(`/api/circuits/${c.id}`);
      doc.meta.title = `${doc.meta.title || '無題'} の複製`;
      await saveIfDirty(); await createFrom(doc); close(); toast('複製して開きました');
    } }, '⧉'),
    h('button', { class: 'file-act danger', title: '削除（data/trash に移す）', onclick: async () => {
      if (!window.confirm(`「${c.title}」を削除しますか？（data/trash フォルダに移します）`)) return;
      await api(`/api/circuits/${c.id}`, { method: 'DELETE' });
      if (state.doc && state.doc.id === c.id) { state.doc.id = null; await createFrom(newDoc()); }
      close(); openFileDialog();
    } }, '×'));
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      if (!doc || !Array.isArray(doc.components)) throw new Error('回路データではありません');
      await saveIfDirty(); await createFrom(doc); close(); toast('読み込みました');
    } catch (err) { toast(`読み込めません: ${err.message}`, 'err'); }
  } });
  const body = h('div', { class: 'file-dialog' },
    h('div', { class: 'file-col' },
      h('div', { class: 'file-h' }, '保存した回路'),
      list.length ? h('div', { class: 'file-list' }, list.map(row)) : h('div', { class: 'hint pad' }, 'まだありません。')),
    h('div', { class: 'file-col side' },
      h('div', { class: 'file-h' }, '新しく作る'),
      h('button', { class: 'btn wide', onclick: async () => { await saveIfDirty(); await createFrom(newDoc()); close(); } }, '白紙から'),
      samples.map((s) => h('button', { class: 'btn wide sample', title: s.notes || '', onclick: async () => {
        const doc = await api(`/api/samples/${s.id}`);
        await saveIfDirty(); await createFrom(doc); close(); toast(`見本「${s.title}」を開きました`);
      } }, h('span', { class: 'sample-k' }, '見本'), s.title)),
      h('div', { class: 'file-h' }, 'ファイル'),
      h('button', { class: 'btn wide', onclick: () => fileInput.click() }, 'JSON を読み込む'), fileInput,
      h('button', { class: 'btn wide', onclick: () => downloadJson() }, 'JSON で書き出す'),
      h('button', { class: 'btn wide', onclick: () => downloadSvg({ values: false }) }, '図面を SVG で書き出す')));
  close = showModal('回路', body, { wide: true });
}

async function saveIfDirty() {
  if (state.dirty) await saveNow();
}

function openHelp() {
  const rows = [
    ['機器を置く', '左の一覧からドラッグ。クリックしてからキャンバスをクリックでも置ける（Shift で続けて置く）'],
    ['配管する', 'ポートの丸からドラッグして、相手のポートか配管の上で離す。配管の上で離すと分岐点ができる'],
    ['配管の途中に分岐点', '配管をダブルクリック'],
    ['配管の経路を直す', '配管の中間の線分をドラッグ。右ペインの「経路を自動に戻す」で元に戻る'],
    ['弁の位置を切り換える', '弁をダブルクリック、または下の工程表で選ぶ'],
    ['回す / 反転', 'R（Shift+R で逆回り） / F'],
    ['動かす', 'ドラッグ、または矢印キー（Shift で 10 mm）'],
    ['複製 / コピー / 貼り付け', 'Ctrl+D / Ctrl+C / Ctrl+V'],
    ['削除', 'Delete'],
    ['元に戻す / やり直す', 'Ctrl+Z / Ctrl+Y'],
    ['画面を動かす', 'Space を押しながらドラッグ、または中ボタン・右ボタンでドラッグ'],
    ['拡大・縮小', 'ホイール。0 キーで用紙全体'],
    ['数値の入力', '式を書ける（例: 15000/0.9）。電卓ボタンで、面積や単位換算もできる'],
  ];
  showModal('操作のしかた', h('table', { class: 'help' }, h('tbody', {}, rows.map(([a, b]) => h('tr', {}, h('th', {}, a), h('td', {}, b))))));
}

// --- ツールバー --------------------------------------------------------------------------
function bindToolbar() {
  const click = (id, fn) => $(id).addEventListener('click', fn);
  click('#btn-file', () => openFileDialog().catch((e) => toast(e.message, 'err')));
  click('#btn-undo', () => undo());
  click('#btn-redo', () => redo());
  click('#btn-print', () => openPrintDialog(showModal));
  click('#btn-report', () => openReport(showModal));
  click('#btn-help', openHelp);
  click('#btn-fit', () => fitView());
  click('#btn-zoom-in', () => zoomBy(1.25));
  click('#btn-zoom-out', () => zoomBy(0.8));
  click('#btn-reroute', () => { rerouteSelection(); toast('配管の経路を引き直しました'); });
  for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  onTool((t) => {
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
    $('#hint').textContent = t === 'frame' ? '包囲線: 対角にドラッグして囲む' : (t === 'text' ? '文字: 置く場所をクリック' : '');
  });
  for (const b of document.querySelectorAll('[data-view]')) {
    b.addEventListener('click', () => setView({ [b.dataset.view]: !state.view[b.dataset.view] }));
  }
  const paintView = () => {
    for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', !!state.view[b.dataset.view]);
  };
  on('view', paintView);
  paintView();
  onZoom((scale) => { $('#zoom').textContent = `${Math.round(scale / 3.7795 * 100)} %`; });   // 96 dpi で実寸のとき 100 %

  const title = $('#doc-title');
  title.addEventListener('change', () => { state.doc.meta.title = title.value; commit(); });
  title.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') title.blur(); });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveNow().then(() => toast('保存しました')); return; }
    if (ctrl && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openPrintDialog(showModal); return; }
    if (typing) return;
    if (ctrl && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); }
    else if (ctrl && (e.key === 'y' || e.key === 'Y' || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) { e.preventDefault(); redo(); }
  });
  window.addEventListener('beforeunload', () => { if (state.dirty && state.doc && state.doc.id) {
    navigator.sendBeacon(`/api/circuits/${state.doc.id}/beacon`, new Blob([JSON.stringify(state.doc)], { type: 'application/json' }));
  } });
}

function paintStatus() {
  $('#btn-undo').disabled = !canUndo();
  $('#btn-redo').disabled = !canRedo();
  const d = state.doc;
  if (document.activeElement !== $('#doc-title')) $('#doc-title').value = d.meta.title || '';
  const sr = stepResult();
  const step = d.steps[state.stepIndex];
  $('#step-chip').textContent = step ? `工程 ${state.stepIndex + 1}/${d.steps.length}　${step.name}` : '';
  $('#step-heat').textContent = sr ? `軸入力 ${fmt(sr.totals.shaft, 2)} kW　発熱 ${fmt(sr.totals.heat, 2)} kW` : '';
}

async function start() {
  loadView();
  state.lib = await api('/api/library');
  if (state.lib.errors && state.lib.errors.length) console.warn('ライブラリの読み込みで問題:', state.lib.errors);
  initEditor($('#canvas'));
  initInspector($('#inspector-body'));
  initPalette($('#palette'));
  initDock($('#dock'));
  bindToolbar();

  on('doc', (d) => {
    paintStatus();
    scheduleCalc(d && d.committed ? 30 : 90);
    if (d && d.committed && !d.loaded) scheduleSave();
  });
  on('results', paintStatus);
  on('step', paintStatus);

  const wanted = location.hash.slice(1) || localStorage.getItem('hc.last');
  let opened = false;
  if (wanted) {
    try { await openCircuit(wanted); opened = true; } catch (e) { /* なくなっていたら次へ */ }
  }
  if (!opened) {
    const list = await api('/api/circuits');
    if (list.length) { await openCircuit(list[0].id); }
    else {
      const samples = await api('/api/samples');
      const doc = samples.length ? await api(`/api/samples/${samples[0].id}`) : newDoc();
      await createFrom(doc);
    }
  }
  document.body.classList.add('ready');
}

start().catch((err) => {
  console.error(err);
  document.body.classList.add('ready');
  toast(`起動できません: ${err.message}`, 'err');
});
