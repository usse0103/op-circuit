// 回路データ（doc）と画面の状態。変更はここを通し、イベントで各パネルに知らせる。
//
//   bus のイベント: 'doc'（回路が変わった） 'sel'（選択） 'results'（計算結果） 'view'（表示設定）
//                   'step'（工程の切り換え） 'saved'（保存状態）

export const bus = new EventTarget();
const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

export const SHEETS = {
  A4: { w: 297, h: 210, name: 'A4 横' },
  A3: { w: 420, h: 297, name: 'A3 横' },
  A2: { w: 594, h: 420, name: 'A2 横' },
};

export const state = {
  lib: null,            // /api/library の内容
  doc: null,
  sel: new Set(),       // 選択中の id（機器・配線・包囲線・文字）
  results: null,        // /api/calc の結果
  stepIndex: 0,
  dirty: false,
  view: {
    grid: true,
    values: true,       // 計算値（流量・圧力）を図面に表示
    heat: true,         // 発熱を表示
    flow: true,         // 流れのアニメーション
    color: true,        // 圧力で色分け
    dark: false,        // 図面を暗い色で表示（画面だけ）
  },
};

let seq = 0;
export function uid(prefix) {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

export function today() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export function newDoc() {
  return normalizeDoc({
    meta: { title: '油圧回路図', date: today() },
    steps: [{ id: uid('s'), name: '中立', duration: 0, states: {} }],
  });
}

/** 抜けている項目を既定値で埋める（古いデータや手で書いた JSON を読めるように） */
export function normalizeDoc(doc) {
  const d = doc || {};
  d.format = 'hc-circuit/1';
  d.meta = {
    title: '', drawingNo: '', project: '', customer: '', author: '', checker: '', approver: '',
    date: '', rev: '', sheet: 'A3', scale: 'NTS', notes: '', showBom: true, ...(d.meta || {}),
  };
  if (!SHEETS[d.meta.sheet]) d.meta.sheet = 'A3';
  d.settings = { ...(state.lib ? state.lib.defaultSettings : {}), crossStyle: 'jump', ...(d.settings || {}) };
  d.components = (d.components || []).map((c) => ({
    rot: 0, flip: false, tag: '', params: {}, ...c,
  }));
  d.wires = (d.wires || []).map((w) => ({ kind: 'main', pts: null, pipe: {}, ...w }));
  d.frames = d.frames || [];
  d.texts = d.texts || [];
  d.steps = d.steps && d.steps.length ? d.steps : [{ id: uid('s'), name: '中立', duration: 0, states: {} }];
  for (const s of d.steps) { s.states = s.states || {}; if (!s.id) s.id = uid('s'); }
  return d;
}

// --- 参照 --------------------------------------------------------------------
export const typeDef = (type) => (state.lib ? state.lib.types[type] : null);
export const compById = (id) => state.doc.components.find((c) => c.id === id);
export const wireById = (id) => state.doc.wires.find((w) => w.id === id);
export const frameById = (id) => state.doc.frames.find((f) => f.id === id);
export const textById = (id) => state.doc.texts.find((t) => t.id === id);

export function paramsOf(c) {
  const def = typeDef(c.type);
  return { ...(def ? def.defaults : {}), ...(c.params || {}) };
}

export function currentStep() {
  const steps = state.doc.steps;
  if (state.stepIndex >= steps.length) state.stepIndex = steps.length - 1;
  if (state.stepIndex < 0) state.stepIndex = 0;
  return steps[state.stepIndex];
}

/** 機器の、いまの工程での状態（電磁弁の位置など）。状態を持たない機器は null */
export function stateOf(c, step = currentStep()) {
  const def = typeDef(c.type);
  if (!def || !def.states) return null;
  const v = step.states[c.id];
  return def.states.options.some((o) => o.value === v) ? v : def.states.default;
}

export function setStateOf(c, value, step = currentStep()) {
  const def = typeDef(c.type);
  if (!def || !def.states) return;
  if (value === def.states.default) delete step.states[c.id];
  else step.states[c.id] = value;
}

export function nextTag(prefix) {
  if (!prefix) return '';
  let n = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const c of state.doc.components) {
    const m = re.exec(c.tag || '');
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return `${prefix}${n + 1}`;
}

export function wiresAt(compId, port) {
  return state.doc.wires.filter((w) =>
    (w.a.c === compId && (port == null || w.a.p === port)) || (w.b.c === compId && (port == null || w.b.p === port)));
}

/** いまの工程の計算結果 */
export function stepResult() {
  const r = state.results;
  if (!r || !r.ok || !r.steps) return null;
  const step = currentStep();
  return r.steps.find((s) => s.id === step.id) || r.steps[state.stepIndex] || null;
}

// --- 変更と履歴 ----------------------------------------------------------------
const undoStack = [];
const redoStack = [];
let lastSnap = null;
const MAX_UNDO = 120;

const snap = () => JSON.stringify(state.doc);

export function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  lastSnap = snap();
}

/** 変更を確定する。元に戻すための履歴を積み、保存と再計算を促す */
export function commit() {
  const s = snap();
  if (s === lastSnap) return;
  undoStack.push(lastSnap);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  lastSnap = s;
  state.dirty = true;
  emit('doc', { committed: true });
}

/** 途中の変更（ドラッグ中、スライダーを動かしている間）。履歴は積まない */
export function touch() {
  emit('doc', { committed: false });
}

function restore(json) {
  const id = state.doc.id;
  state.doc = normalizeDoc(JSON.parse(json));
  state.doc.id = id;
  lastSnap = json;
  const ids = new Set([...state.doc.components, ...state.doc.wires, ...state.doc.frames, ...state.doc.texts].map((o) => o.id));
  for (const s of [...state.sel]) if (!ids.has(s)) state.sel.delete(s);
  state.dirty = true;
  emit('doc', { committed: true, restored: true });
  emit('sel');
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(lastSnap);
  restore(undoStack.pop());
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(lastSnap);
  restore(redoStack.pop());
  return true;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function setDoc(doc) {
  state.doc = normalizeDoc(doc);
  state.sel.clear();
  state.stepIndex = 0;
  state.results = null;
  state.dirty = false;
  resetHistory();
  emit('doc', { committed: true, loaded: true });
  emit('sel');
  emit('step');
}

// --- 選択 ----------------------------------------------------------------------
export function select(ids, additive = false) {
  if (!additive) state.sel.clear();
  for (const id of [].concat(ids || [])) {
    if (additive && state.sel.has(id)) state.sel.delete(id);
    else state.sel.add(id);
  }
  emit('sel');
}

export function setStep(index) {
  state.stepIndex = Math.max(0, Math.min(state.doc.steps.length - 1, index));
  emit('step');
}

export function setResults(r) {
  state.results = r;
  emit('results');
}

export function setView(patch) {
  Object.assign(state.view, patch);
  try { localStorage.setItem('hc.view', JSON.stringify(state.view)); } catch (e) { /* 保存できなくても続ける */ }
  emit('view');
}

export function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem('hc.view') || 'null');
    if (v) Object.assign(state.view, v);
  } catch (e) { /* 既定のまま */ }
}

// --- 数値の表示 ------------------------------------------------------------------
export function fmt(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  const r = Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v;
  return r.toFixed(digits);
}

/** 機器表の仕様欄。"{disp} cm³/rev" の {キー} をパラメータの値（選択肢なら表示名）に置き換える */
export function specText(c) {
  const def = typeDef(c.type);
  if (!def || !def.spec) return '';
  const p = paramsOf(c);
  return def.spec.replace(/\{(\w+)\}/g, (_, key) => {
    const pd = def.params.find((q) => q.key === key);
    const v = p[key];
    if (pd && pd.options) {
      const o = pd.options.find((q) => q.value === v);
      return o ? o.label : String(v ?? '');
    }
    return v == null ? '' : String(v);
  });
}
