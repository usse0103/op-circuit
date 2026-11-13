// 入力欄に付く電卓。式の計算、円の面積、単位換算。
// 式は自前の構文解析で計算する（eval は使わない）。

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
  sin: (d) => Math.sin(d * Math.PI / 180), cos: (d) => Math.cos(d * Math.PI / 180), tan: (d) => Math.tan(d * Math.PI / 180),
  asin: (v) => Math.asin(v) * 180 / Math.PI, acos: (v) => Math.acos(v) * 180 / Math.PI, atan: (v) => Math.atan(v) * 180 / Math.PI,
  min: Math.min, max: Math.max, round: Math.round,
  area: (d) => Math.PI * d * d / 4,            // 直径 → 円の面積
  dia: (a) => Math.sqrt(4 * a / Math.PI),      // 円の面積 → 直径
};
const CONSTS = { pi: Math.PI, e: Math.E, g: 9.80665 };

function normalize(src) {
  return String(src)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[．]/g, '.').replace(/[，,]/g, '')
    .replace(/[×＊]/g, '*').replace(/[÷／]/g, '/').replace(/[－−ー]/g, '-').replace(/[＋]/g, '+')
    .replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/π/g, 'pi').replace(/√/g, 'sqrt')
    .replace(/²/g, '^2').replace(/³/g, '^3');
}

/** 式を計算する。vars には x（いまの値）や ans を渡せる。失敗したら NaN */
export function evaluate(src, vars = {}) {
  const s = normalize(src);
  let i = 0;
  const peek = () => { while (s[i] === ' ') i++; return s[i]; };
  const fail = () => { throw new Error('式を読めません'); };

  function primary() {
    const c = peek();
    if (c === '(') { i++; const v = expr(); if (peek() !== ')') fail(); i++; return v; }
    if (c !== undefined && /[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?|^[0-9]+\.?/.exec(s.slice(i));
      if (!m) fail();
      i += m[0].length;
      return parseFloat(m[0]);
    }
    if (c !== undefined && /[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      i += m[0].length;
      const name = m[0].toLowerCase();
      if (peek() === '(') {
        i++;
        const args = [];
        if (peek() !== ')') { args.push(expr()); while (peek() === ',') { i++; args.push(expr()); } }
        if (peek() !== ')') fail();
        i++;
        if (!FUNCS[name]) fail();
        return FUNCS[name](...args);
      }
      if (name in vars) return vars[name];
      if (name in CONSTS) return CONSTS[name];
      fail();
    }
    return fail();
  }
  function unary() {
    const c = peek();
    if (c === '-') { i++; return -unary(); }
    if (c === '+') { i++; return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (peek() === '^') { i++; return base ** unary(); }
    return base;
  }
  function term() {
    let v = unary();
    for (;;) {
      const c = peek();
      if (c === '*') { i++; v *= unary(); }
      else if (c === '/') { i++; v /= unary(); }
      else if (c === '%') { i++; v /= 100; }
      else return v;
    }
  }
  function expr() {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === '+') { i++; v += term(); }
      else if (c === '-') { i++; v -= term(); }
      else return v;
    }
  }
  try {
    if (!s.trim()) return NaN;
    const v = expr();
    if (peek() !== undefined) return NaN;
    return v;
  } catch (err) {
    return NaN;
  }
}

/** 余計な 0 を付けずに表示する */
export function tidy(v, maxDigits = 6) {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const digits = a >= 1000 ? 2 : (a >= 1 ? 4 : maxDigits);
  return String(parseFloat(v.toFixed(digits)));
}

const CONVERSIONS = [
  { label: 'kgf/cm² → MPa', f: 0.0980665 }, { label: 'MPa → kgf/cm²', f: 1 / 0.0980665 },
  { label: 'bar → MPa', f: 0.1 }, { label: 'psi → MPa', f: 0.00689476 },
  { label: 'kgf → N', f: 9.80665 }, { label: 'tf → kN', f: 9.80665 }, { label: 'N → kN', f: 0.001 },
  { label: 'inch → mm', f: 25.4 }, { label: 'cm² → mm²', f: 100 },
  { label: 'US gal/min → L/min', f: 3.785412 }, { label: 'cc/s → L/min', f: 0.06 },
  { label: 'PS → kW', f: 0.7355 }, { label: 'HP → kW', f: 0.7457 }, { label: 'kcal/h → kW', f: 0.001163 },
  { label: 'rpm 50 Hz 4P', v: 1500 }, { label: 'rpm 60 Hz 4P', v: 1800 },
];

const KEYS = [
  '7', '8', '9', '÷', '⌫',
  '4', '5', '6', '×', '(',
  '1', '2', '3', '−', ')',
  '0', '.', 'π', '+', '^',
  '√', 'x²', 'x', 'C', '=',
];

let pad = null;
let current = null;
let ans = 0;
const history = [];

function build() {
  pad = document.createElement('div');
  pad.className = 'calcpad';
  pad.innerHTML = `
    <div class="cp-head"><span class="cp-title"></span><button class="cp-close" title="閉じる">×</button></div>
    <input class="cp-expr" spellcheck="false" autocomplete="off" placeholder="式を入力（例: 15000/0.9/area(63)*… ）">
    <div class="cp-result"><span class="cp-eq">=</span><span class="cp-value">—</span><span class="cp-unit"></span></div>
    <div class="cp-keys">${KEYS.map((k) => `<button data-k="${k}" class="${/[0-9.]/.test(k) ? 'num' : 'op'}${k === '=' ? ' eq' : ''}">${k}</button>`).join('')}</div>
    <div class="cp-tools">
      <button data-wrap="area" title="直径 mm から円の面積 mm²">φ → 面積</button>
      <button data-wrap="dia" title="円の面積から直径">面積 → φ</button>
      <button data-ins="ans" title="直前の結果">ans</button>
      <select class="cp-conv"><option value="">単位換算…</option>${CONVERSIONS.map((c, i) => `<option value="${i}">${c.label}</option>`).join('')}</select>
    </div>
    <div class="cp-hist"></div>
    <div class="cp-foot">
      <span class="cp-hint">x = いまの値　sin などは度</span>
      <button class="cp-apply">入力する</button>
    </div>`;
  document.body.appendChild(pad);
  const exprEl = pad.querySelector('.cp-expr');

  const insert = (text) => {
    const a = exprEl.selectionStart ?? exprEl.value.length, b = exprEl.selectionEnd ?? a;
    exprEl.value = exprEl.value.slice(0, a) + text + exprEl.value.slice(b);
    const pos = a + text.length;
    exprEl.setSelectionRange(pos, pos);
    refresh();
  };
  const refresh = () => {
    const v = evaluate(exprEl.value, { x: current ? current.value : 0, ans });
    pad.querySelector('.cp-value').textContent = Number.isFinite(v) ? tidy(v) : '—';
    pad.querySelector('.cp-apply').disabled = !Number.isFinite(v);
    return v;
  };
  const apply = () => {
    const v = refresh();
    if (!Number.isFinite(v) || !current) return;
    ans = v;
    history.unshift({ expr: exprEl.value, v });
    if (history.length > 6) history.pop();
    const cb = current.onApply;
    closePad();
    cb(v);
  };

  pad.querySelector('.cp-keys').addEventListener('click', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    if (k === 'C') exprEl.value = '';
    else if (k === '⌫') {
      const a = exprEl.selectionStart ?? exprEl.value.length;
      if (a > 0) { exprEl.value = exprEl.value.slice(0, a - 1) + exprEl.value.slice(a); exprEl.setSelectionRange(a - 1, a - 1); }
    } else if (k === '=') {
      const v = refresh();
      if (Number.isFinite(v)) { ans = v; exprEl.value = tidy(v); }
    } else if (k === '√') insert('sqrt(');
    else if (k === 'x²') insert('^2');
    else insert(k);
    exprEl.focus();
    refresh();
  });
  pad.querySelector('.cp-tools').addEventListener('click', (e) => {
    const b = e.target;
    if (b.dataset.wrap) { exprEl.value = `${b.dataset.wrap}(${exprEl.value || 'x'})`; refresh(); exprEl.focus(); }
    if (b.dataset.ins) insert(b.dataset.ins);
  });
  pad.querySelector('.cp-conv').addEventListener('change', (e) => {
    const c = CONVERSIONS[e.target.value];
    e.target.value = '';
    if (!c) return;
    if (c.v != null) exprEl.value = String(c.v);
    else exprEl.value = `(${exprEl.value || 'x'})*${tidy(c.f, 8)}`;
    refresh();
    exprEl.focus();
  });
  pad.querySelector('.cp-hist').addEventListener('click', (e) => {
    const i = e.target.dataset.i;
    if (i != null) { exprEl.value = history[i].expr; refresh(); exprEl.focus(); }
  });
  exprEl.addEventListener('input', refresh);
  exprEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
    if (e.key === 'Escape') { e.preventDefault(); closePad(); }
    e.stopPropagation();
  });
  pad.querySelector('.cp-apply').addEventListener('click', apply);
  pad.querySelector('.cp-close').addEventListener('click', closePad);
  document.addEventListener('pointerdown', (e) => {
    if (pad.classList.contains('open') && !pad.contains(e.target) && !(e.target.closest && e.target.closest('.calc-btn'))) closePad();
  }, true);
}

export function closePad() {
  if (pad) pad.classList.remove('open');
  current = null;
}

/** anchor の近くに電卓を開く。onApply(v) で値を返す */
export function openPad(anchor, { label = '', unit = '', value = 0, onApply }) {
  if (!pad) build();
  current = { value, onApply };
  pad.querySelector('.cp-title').textContent = label;
  pad.querySelector('.cp-unit').textContent = unit;
  const exprEl = pad.querySelector('.cp-expr');
  exprEl.value = tidy(value);
  pad.querySelector('.cp-value').textContent = tidy(value);
  pad.querySelector('.cp-hist').innerHTML = history.map((h, i) =>
    `<button data-i="${i}" title="この式を使う">${h.expr.replace(/</g, '&lt;')} = ${tidy(h.v)}</button>`).join('');
  pad.classList.add('open');
  const r = anchor.getBoundingClientRect();
  const pw = pad.offsetWidth, ph = pad.offsetHeight;
  let left = r.left - pw - 12;
  if (left < 8) left = Math.min(window.innerWidth - pw - 8, r.right + 12);
  let top = Math.min(Math.max(8, r.top - 60), window.innerHeight - ph - 8);
  pad.style.left = `${left}px`;
  pad.style.top = `${top}px`;
  exprEl.focus();
  exprEl.select();
}
