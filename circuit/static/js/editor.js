// 回路エディタ。SVG の上で、機器の配置・移動・回転、配線、選択を扱う。
// 座標はすべて用紙上の mm。画面への拡大縮小は viewBox で行う。
import {
  state, on, typeDef, paramsOf, stateOf, setStateOf, compById, wireById, frameById, textById,
  wiresAt, commit, touch, select, uid, nextTag, stepResult,
} from './store.js';
import { buildSymbol, makeTf, primsToSvg, esc } from './symbols.js';
import { Router, G, simplify, stretch, findCrossings, pathD, longestSegment, nearestOnPath } from './router.js';
import { renderSheet, sheetSize, textWidth } from './sheet.js';

export const DRAWING_CSS = `
.dw{font-family:"BIZ UDGothic","Yu Gothic UI","Meiryo","Hiragino Sans",sans-serif}
.dw line,.dw polyline,.dw polygon,.dw path,.dw circle,.dw rect{fill:none;stroke:var(--ink);stroke-width:.35;stroke-linecap:round;stroke-linejoin:round}
.dw text{fill:var(--ink);stroke:none}
.dw .s-thin{stroke-width:.25}
.dw .s-dash{stroke-width:.25;stroke-dasharray:1.7 1.1}
.dw .s-chain{stroke-width:.25;stroke-dasharray:6 1.2 1 1.2}
.dw .f-ink{fill:var(--ink)}
.dw .f-paper{fill:var(--paper)}
.dw .s-hl{stroke:none;fill:var(--hl)}
.dw .paper{fill:var(--paper);stroke:none}
.dw .frame{stroke-width:.7}
.dw .center-mark{stroke-width:.5}
.dw .tb-bg{fill:var(--paper);stroke:none}
.dw .tb-line{stroke-width:.25}
.dw .tb-hair{stroke-width:.12}
.dw .tb-outer{stroke-width:.5}
.dw .tb-label,.dw .tb-label2{opacity:.72}
.dw .tb-bold{font-weight:700}
.dw .wire{stroke-width:.4;fill:none}
.dw .wire.pilot{stroke-width:.25;stroke-dasharray:3.2 1.3}
.dw .wire.drain{stroke-width:.25;stroke-dasharray:1.5 1.1}
.dw .tag{font-weight:700}
.dw .frame-box{stroke-width:.25;stroke-dasharray:6 1.2 1 1.2}
.dw .res{fill:var(--res);paint-order:stroke;stroke:var(--paper);stroke-width:.7;stroke-linejoin:round}
.dw .res.heat{fill:var(--heat)}
.dw .res.dim{opacity:.75}
.dw .flow-arrow{fill:var(--res);stroke:none}
`;

const PRINT_VARS = '--ink:#000;--paper:#fff;--hl:none;--res:#0b4fb3;--heat:#b3410b';

let svg, L = {};
let geoms = new Map();
const routes = new Map();
let router = null, routerKey = '';
const view = { x: 0, y: 0, w: 420, h: 297 };
let drag = null;
let tool = 'select';
let placing = null;
let spaceDown = false;
let clipboard = null;
const listeners = { tool: [], zoom: [] };

const doc = () => state.doc;
const snap = (v) => Math.round(v / G) * G;
const R2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// 形状の計算
// ---------------------------------------------------------------------------
export function geomOf(c, opts = {}) {
  const def = typeDef(c.type);
  if (!def) return null;
  const sym = buildSymbol(def, paramsOf(c), {
    state: opts.noState ? null : stateOf(c), cross: doc().settings.crossStyle,
  });
  const tf = makeTf({ x: c.x, y: c.y, rot: c.rot || 0, flip: !!c.flip });
  const ports = {};
  for (const [name, p] of Object.entries(sym.ports)) {
    const [x, y] = tf.pt(p.x, p.y);
    const [dx, dy] = tf.dir(p.dx, p.dy);
    ports[name] = { x: R2(x), y: R2(y), dx, dy };
  }
  const b = sym.bbox;
  const cs = [tf.pt(b.x0, b.y0), tf.pt(b.x1, b.y0), tf.pt(b.x1, b.y1), tf.pt(b.x0, b.y1)];
  const xs = cs.map((q) => q[0]), ys = cs.map((q) => q[1]);
  return {
    sym, tf, ports, def,
    bbox: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
  };
}

function computeGeoms() {
  geoms = new Map();
  for (const c of doc().components) {
    const g = geomOf(c);
    if (g) geoms.set(c.id, g);
  }
}

function endpoint(end) {
  const g = geoms.get(end.c);
  return g ? g.ports[end.p] || null : null;
}

function isOrtho(pts) {
  for (let i = 0; i + 1 < pts.length; i++) {
    if (Math.abs(pts[i][0] - pts[i + 1][0]) > 1e-6 && Math.abs(pts[i][1] - pts[i + 1][1]) > 1e-6) return false;
  }
  return true;
}

function ensureRouter() {
  const { w, h } = sheetSize();
  const key = `${w}x${h}`;
  if (!router || routerKey !== key) {
    router = new Router({ x0: -30, y0: -30, x1: w + 30, y1: h + 30 });
    routerKey = key;
    routes.clear();
  }
}

/** 配線の経路を決める。only を渡すと、その配線だけを引き直す（ドラッグ中） */
function routeAll(only = null) {
  ensureRouter();
  const rects = [];
  for (const c of doc().components) {
    if (c.type === 'junction') continue;
    const g = geoms.get(c.id);
    if (g) rects.push(g.bbox);
  }
  router.setObstacles(rects);
  router.clearWires();
  const live = new Set();
  const auto = [];
  for (const w of doc().wires) {
    const a = endpoint(w.a), b = endpoint(w.b);
    if (!a || !b) { routes.delete(w.id); continue; }
    live.add(w.id);
    if (w.pts && w.pts.length >= 2) {
      let pts = w.pts.map((q) => [q[0], q[1]]);
      const n = pts.length;
      const same = Math.abs(pts[0][0] - a.x) < 1e-6 && Math.abs(pts[0][1] - a.y) < 1e-6
        && Math.abs(pts[n - 1][0] - b.x) < 1e-6 && Math.abs(pts[n - 1][1] - b.y) < 1e-6;
      if (!same || !isOrtho(pts)) pts = stretch(pts, a, b);
      if (pts && isOrtho(pts)) {
        w.pts = pts;
        routes.set(w.id, pts);
        router.addWire(pts);
        continue;
      }
      w.pts = null;
    }
    if (only && !only.has(w.id) && routes.has(w.id)) {
      const pts = routes.get(w.id);
      const n = pts.length;
      if (Math.abs(pts[0][0] - a.x) < 1e-6 && Math.abs(pts[0][1] - a.y) < 1e-6
        && Math.abs(pts[n - 1][0] - b.x) < 1e-6 && Math.abs(pts[n - 1][1] - b.y) < 1e-6) {
        router.addWire(pts);
        continue;
      }
    }
    auto.push([w, a, b]);
  }
  for (const [w, a, b] of auto) {
    const pts = router.route(a, b);
    routes.set(w.id, pts);
    router.addWire(pts);
  }
  for (const id of [...routes.keys()]) if (!live.has(id)) routes.delete(id);
}

export function routeOf(id) { return routes.get(id); }
export function geometry(id) { return geoms.get(id); }

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------
function mapAnchor(anchor, tf) {
  if (anchor === 'middle') return 'middle';
  const [dx] = tf.dir(anchor === 'start' ? 1 : -1, 0);
  return dx > 0.5 ? 'start' : (dx < -0.5 ? 'end' : 'middle');
}

function compSvg(c, g, cls = '') {
  const { shapes, texts } = primsToSvg(g.sym.prims);
  const tfAttr = `translate(${c.x} ${c.y})${c.rot ? ` rotate(${c.rot})` : ''}${c.flip ? ' scale(-1 1)' : ''}`;
  let s = `<g class="comp ${cls}" data-id="${c.id}"><g transform="${tfAttr}">${shapes}</g>`;
  for (const t of texts) {
    const [x, y] = g.tf.pt(t.x, t.y - t.size * 0.35);
    s += `<text x="${R2(x)}" y="${R2(y)}" font-size="${t.size}" text-anchor="${mapAnchor(t.anchor, g.tf)}"`
      + ` dominant-baseline="central" class="sym-text">${esc(t.s)}</text>`;
  }
  return s + '</g>';
}

function heatText(w) {
  return w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${w.toFixed(0)} W`;
}

/** 機器番号と計算値のラベル */
function labelSvg(c, g, res, opts) {
  const p = paramsOf(c);
  const lines = [];
  if (c.tag) lines.push({ t: c.tag, size: 3, cls: 'tag' });
  if (p.model_code) lines.push({ t: p.model_code, size: 2.2, cls: '' });
  const r = res && res.comps ? res.comps[c.id] : null;
  if (r && opts.values) for (const t of r.labels || []) lines.push({ t, size: 2.3, cls: 'res' });
  if (r && opts.heat && r.heat >= 1 && c.type !== 'junction') {
    lines.push({ t: `発熱 ${heatText(r.heat)}`, size: 2.3, cls: 'res heat' });
  }
  if (!lines.length) return '';
  const side = g.sym.labelSide;
  const b = g.bbox;
  let x, y, anchor = 'start', up = false;
  if (side === 'left') { x = b.x0 - 2; y = b.y0 + 2.5; anchor = 'end'; }
  else if (side === 'top') { x = b.x0; y = b.y0 - 2; up = true; }
  else { x = b.x1 + 2; y = b.y0 + 2.5; }
  const off = c.label || { dx: 0, dy: 0 };
  x += off.dx || 0; y += off.dy || 0;
  let s = `<g class="clabel" data-kind="label" data-id="${c.id}">`;
  const total = lines.reduce((a, ln) => a + ln.size * 1.25, 0);
  let yy = up ? y - total + lines[0].size * 1.0 : y;
  for (const ln of lines) {
    s += `<text x="${R2(x)}" y="${R2(yy)}" font-size="${ln.size}" text-anchor="${anchor}" class="${ln.cls}">${esc(ln.t)}</text>`;
    yy += ln.size * 1.25;
  }
  return s + '</g>';
}

function wireEndCounts() {
  const n = new Map();
  for (const w of doc().wires) {
    if (!routes.has(w.id)) continue;
    for (const e of [w.a, w.b]) {
      const k = `${e.c}:${e.p}`;
      n.set(k, (n.get(k) || 0) + 1);
    }
  }
  return n;
}

function wiresSvg(interactive) {
  const jump = doc().settings.crossStyle !== 'plain';
  const crossings = jump ? findCrossings(routes) : new Map();
  let s = '', hits = '';
  for (const w of doc().wires) {
    const pts = routes.get(w.id);
    if (!pts) continue;
    const sel = interactive && state.sel.has(w.id) ? ' sel' : '';
    s += `<path class="wire ${w.kind || 'main'}${sel}" d="${pathD(pts, crossings.get(w.id))}"/>`;
    if (interactive) hits += `<path class="wire-hit" data-kind="wire" data-id="${w.id}" d="${pathD(pts)}"/>`;
  }
  // 接続点: 3 本以上が集まる所
  const counts = wireEndCounts();
  for (const [key, n] of counts) {
    const [cid, port] = key.split(':');
    const c = compById(cid);
    const g = geoms.get(cid);
    if (!c || !g || !g.ports[port]) continue;
    const need = c.type === 'junction' ? 3 : 2;
    if (n >= need) s += `<circle cx="${g.ports[port].x}" cy="${g.ports[port].y}" r="0.75" class="f-ink"/>`;
  }
  return s + hits;
}

function framesSvg(interactive) {
  let s = '';
  for (const f of doc().frames) {
    const sel = interactive && state.sel.has(f.id) ? ' sel' : '';
    s += `<rect class="frame-box${sel}" x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}"/>`;
    if (interactive) s += `<rect class="frame-hit" data-kind="frame" data-id="${f.id}" x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}"/>`;
    if (f.label) {
      s += `<text x="${f.x + 2}" y="${f.y - 1.5}" font-size="2.8" class="tag" data-kind="frame" data-id="${f.id}">${esc(f.label)}</text>`;
    }
  }
  return s;
}

function textsSvg(interactive) {
  let s = '';
  for (const t of doc().texts) {
    const sel = interactive && state.sel.has(t.id) ? ' sel' : '';
    const size = t.size || 3;
    const lines = String(t.text || '').split(/\r?\n/);
    s += `<text class="note${sel}" data-kind="text" data-id="${t.id}" x="${t.x}" y="${t.y}" font-size="${size}">`;
    lines.forEach((ln, i) => { s += `<tspan x="${t.x}" dy="${i ? size * 1.3 : 0}">${esc(ln) || ' '}</tspan>`; });
    s += '</text>';
  }
  return s;
}

function pressureColor(t) {
  const h = 215 * (1 - Math.max(0, Math.min(1, t)));
  return `hsl(${h.toFixed(0)} 85% 50%)`;
}

/** 計算値の重ね描き（流量・圧力のラベル、流れの向き、色分け） */
function overlaySvg(res, opts) {
  if (!res || !res.wires) return { under: '', over: '' };
  let under = '', over = '';
  let pmax = 1, qmax = 0.1;
  for (const w of doc().wires) {
    const r = res.wires[w.id];
    if (!r) continue;
    pmax = Math.max(pmax, r.pa, r.pb);
    qmax = Math.max(qmax, Math.abs(r.q));
  }
  const placed = [];
  for (const g of geoms.values()) placed.push(g.bbox);
  for (const f of doc().frames) {               // 包囲線の上にも書かない
    placed.push({ x0: f.x - 0.6, y0: f.y - 0.6, x1: f.x + f.w + 0.6, y1: f.y + 0.6 });
    placed.push({ x0: f.x - 0.6, y0: f.y + f.h - 0.6, x1: f.x + f.w + 0.6, y1: f.y + f.h + 0.6 });
    placed.push({ x0: f.x - 0.6, y0: f.y, x1: f.x + 0.6, y1: f.y + f.h });
    placed.push({ x0: f.x + f.w - 0.6, y0: f.y, x1: f.x + f.w + 0.6, y1: f.y + f.h });
  }
  const hitRect = (b) => placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0);
  const written = [];                           // 同じ値を近くに繰り返さない

  for (const w of doc().wires) {
    const pts = routes.get(w.id);
    const r = res.wires[w.id];
    if (!pts || !r) continue;
    const q = r.q;
    const p = Math.max(r.pa, r.pb);
    const flowing = Math.abs(q) > 0.05;
    const col = pressureColor(p / pmax);
    const d = pathD(pts);
    if (opts.color && (flowing || p > 0.05)) {
      under += `<path d="${d}" class="p-glow" style="stroke:${col}"/>`;
    }
    if (opts.flow && flowing) {
      const dur = (2.6 / (0.25 + 0.75 * Math.abs(q) / qmax)).toFixed(2);
      over += `<path d="${d}" class="flow-dash${q < 0 ? ' rev' : ''}" style="stroke:${col};animation-duration:${dur}s"/>`;
    }
    if (!opts.values) continue;
    if (!flowing && p < 0.05) continue;
    let text = flowing ? `${Math.abs(q).toFixed(1)} L/min` : '';
    if (p >= 0.05) text += `${text ? ' · ' : ''}${p.toFixed(1)} MPa`;
    if (flowing && r.v != null) text += ` · ${r.v.toFixed(1)} m/s`;
    if (opts.heat && r.heat >= 1) text += ` · 発熱 ${heatText(r.heat)}`;
    const size = 2.2;
    const tw = textWidth(text, size);
    // 置き場所の候補: 長い線分から順に、線の両側
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const len = Math.abs(pts[i][0] - pts[i + 1][0]) + Math.abs(pts[i][1] - pts[i + 1][1]);
      segs.push({ i, len });
    }
    segs.sort((a, b) => b.len - a.len);
    let spot = null;
    for (const sg of segs.slice(0, 4)) {
      const [x0, y0] = pts[sg.i], [x1, y1] = pts[sg.i + 1];
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const horizontal = Math.abs(y0 - y1) < 1e-6;
      const cands = horizontal
        ? [{ x: mx, y: my - 1.3, a: 'middle' }, { x: mx, y: my + 3.0, a: 'middle' }]
        : [{ x: mx + 1.6, y: my + 0.8, a: 'start' }, { x: mx - 1.6, y: my + 0.8, a: 'end' }];
      for (const c of cands) {
        const bx0 = c.a === 'middle' ? c.x - tw / 2 : (c.a === 'start' ? c.x : c.x - tw);
        const b = { x0: bx0 - 0.4, y0: c.y - size, x1: bx0 + tw + 0.4, y1: c.y + 0.5 };
        if (!hitRect(b)) { spot = { ...c, b, seg: sg.i }; break; }
      }
      if (spot) break;
    }
    if (!spot) continue;
    const total = segs.reduce((a, sg) => a + sg.len, 0);
    const repeat = written.some((q) => q.text === text && Math.hypot(q.x - spot.x, q.y - spot.y) < 45);
    const showText = !repeat && total >= 7.5;
    if (showText) {
      placed.push(spot.b);
      written.push({ text, x: spot.x, y: spot.y });
      over += `<text x="${R2(spot.x)}" y="${R2(spot.y)}" font-size="${size}" text-anchor="${spot.a}" class="res${flowing ? '' : ' dim'}">${esc(text)}</text>`;
    }
    if (flowing && total >= 5) {
      const [x0, y0] = pts[spot.seg], [x1, y1] = pts[spot.seg + 1];
      const sgn = q > 0 ? 1 : -1;
      const dx = Math.sign(x1 - x0) * sgn, dy = Math.sign(y1 - y0) * sgn;
      const horizontal = Math.abs(y0 - y1) < 1e-6;
      // 矢じりはラベルの少し手前に置く
      const ax = horizontal ? (x0 + x1) / 2 - Math.sign(x1 - x0) * Math.min(tw / 2 + 3, Math.abs(x1 - x0) / 2 - 1) : x0;
      const ay = horizontal ? y0 : (y0 + y1) / 2 - Math.sign(y1 - y0) * Math.min(4, Math.abs(y1 - y0) / 2 - 1);
      const L2 = 2.2, W2 = 0.85;
      const tipx = ax + dx * L2 / 2, tipy = ay + dy * L2 / 2;
      const bx = ax - dx * L2 / 2, by = ay - dy * L2 / 2;
      over += `<polygon class="flow-arrow" points="${R2(tipx)},${R2(tipy)} ${R2(bx - dy * W2)},${R2(by + dx * W2)} ${R2(bx + dy * W2)},${R2(by - dx * W2)}"/>`;
    }
  }
  return { under, over };
}

function uiSvg() {
  let s = '';
  const counts = wireEndCounts();
  for (const c of doc().components) {
    const g = geoms.get(c.id);
    if (!g) continue;
    const b = g.bbox;
    const selected = state.sel.has(c.id);
    if (c.type === 'junction') {
      const n = counts.get(`${c.id}:J`) || 0;
      s += `<circle class="junction-handle${selected ? ' sel' : ''}${n < 3 ? ' bend' : ''}" data-kind="junction" data-id="${c.id}" cx="${c.x}" cy="${c.y}" r="1.5"/>`;
      continue;
    }
    s += `<rect class="comp-hit" data-kind="comp" data-id="${c.id}" x="${b.x0 - 0.8}" y="${b.y0 - 0.8}" width="${b.x1 - b.x0 + 1.6}" height="${b.y1 - b.y0 + 1.6}"/>`;
    if (selected) {
      s += `<rect class="sel-box" x="${b.x0 - 1.5}" y="${b.y0 - 1.5}" width="${b.x1 - b.x0 + 3}" height="${b.y1 - b.y0 + 3}" rx="1"/>`;
    }
  }
  for (const c of doc().components) {
    if (c.type === 'junction') continue;
    const g = geoms.get(c.id);
    if (!g) continue;
    for (const [name, p] of Object.entries(g.ports)) {
      const open = !(counts.get(`${c.id}:${name}`) > 0);
      s += `<circle class="port${open ? ' open' : ''}" data-kind="port" data-c="${c.id}" data-p="${name}" cx="${p.x}" cy="${p.y}" r="1.25"/>`;
    }
  }
  for (const f of doc().frames) {
    if (!state.sel.has(f.id)) continue;
    for (const [hx, hy, k] of [[f.x, f.y, 'nw'], [f.x + f.w, f.y, 'ne'], [f.x, f.y + f.h, 'sw'], [f.x + f.w, f.y + f.h, 'se']]) {
      s += `<rect class="handle" data-kind="frame-h" data-id="${f.id}" data-corner="${k}" x="${hx - 1.2}" y="${hy - 1.2}" width="2.4" height="2.4"/>`;
    }
  }
  return s;
}

let renderQueued = false;
/** 画面を描き直す。reroute = false のときは配線の経路を保つ */
export function render({ reroute = true, only = null } = {}) {
  if (!state.doc || !svg) return;
  computeGeoms();
  if (reroute) routeAll(only);
  const res = stepResult();
  const v = state.view;
  L.sheet.innerHTML = renderSheet().svg;
  L.frames.innerHTML = framesSvg(true);
  L.wires.innerHTML = wiresSvg(true);
  let comps = '', labels = '';
  for (const c of doc().components) {
    const g = geoms.get(c.id);
    if (!g) continue;
    if (c.type !== 'junction') comps += compSvg(c, g);
    labels += labelSvg(c, g, res, v);
  }
  L.comps.innerHTML = comps + labels;
  L.notes.innerHTML = textsSvg(true);
  const ov = overlaySvg(res, v);
  L.under.innerHTML = ov.under;
  L.over.innerHTML = ov.over;
  L.ui.innerHTML = uiSvg();
  svg.classList.toggle('dark-sheet', !!v.dark);
  svg.classList.toggle('no-grid', !v.grid);
}

function queueRender(opts) {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(opts); });
}

/** 印刷・書き出し用の SVG（用紙ぴったり、画面用の部品なし） */
export function exportSvg({ values = false, heat = false, color = false } = {}) {
  computeGeoms();
  routeAll();
  const { w, h } = sheetSize();
  const res = values || heat ? stepResult() : null;
  const opts = { values, heat, flow: false, color: false };
  let body = renderSheet().svg + framesSvg(false) + wiresSvg(false);
  let labels = '';
  for (const c of doc().components) {
    const g = geomOf(c, { noState: true });
    if (!g) continue;
    if (c.type !== 'junction') body += compSvg(c, g);
    labels += labelSvg(c, g, res, opts);
  }
  body += labels + textsSvg(false);
  if (res) body += overlaySvg(res, opts).over;
  const vars = color ? PRINT_VARS : PRINT_VARS.replace('#0b4fb3', '#000').replace('#b3410b', '#000');
  return `<svg xmlns="http://www.w3.org/2000/svg" class="dw" viewBox="0 0 ${w} ${h}" width="${w}mm" height="${h}mm" style="${vars}">`
    + `<style>${DRAWING_CSS}</style>${body}</svg>`;
}

// ---------------------------------------------------------------------------
// 表示範囲
// ---------------------------------------------------------------------------
function applyView() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  const rect = svg.getBoundingClientRect();
  const scale = rect.width / view.w;           // px / mm
  svg.style.setProperty('--px', (1 / scale).toFixed(4));
  listeners.zoom.forEach((fn) => fn(scale));
}

export function fitView() {
  const { w, h } = sheetSize();
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pad = 14;
  const aspect = rect.width / rect.height;
  let vw = w + pad * 2, vh = h + pad * 2;
  if (vw / vh < aspect) vw = vh * aspect; else vh = vw / aspect;
  view.w = vw; view.h = vh;
  view.x = w / 2 - vw / 2; view.y = h / 2 - vh / 2;
  applyView();
}

export function zoomBy(factor, cx, cy) {
  const rect = svg.getBoundingClientRect();
  const aspect = rect.width / rect.height;
  const nw = Math.max(30, Math.min(3000, view.w / factor));
  const nh = nw / aspect;
  const px = cx == null ? view.x + view.w / 2 : cx;
  const py = cy == null ? view.y + view.h / 2 : cy;
  view.x = px - (px - view.x) * (nw / view.w);
  view.y = py - (py - view.y) * (nh / view.h);
  view.w = nw; view.h = nh;
  applyView();
}

export function toWorld(e) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: p.x, y: p.y };
}

export function onTool(fn) { listeners.tool.push(fn); }
export function onZoom(fn) { listeners.zoom.push(fn); }
export function setTool(t) {
  tool = t;
  svg.dataset.tool = t;
  listeners.tool.forEach((fn) => fn(t));
}

// ---------------------------------------------------------------------------
// 編集操作
// ---------------------------------------------------------------------------
function newComponent(type, x, y) {
  const def = typeDef(type);
  const params = {};
  for (const p of def.params) {
    if (p.type === 'layers') params[p.key] = JSON.parse(JSON.stringify(p.default || []));
  }
  return { id: uid('c'), type, x: snap(x), y: snap(y), rot: 0, flip: false, tag: nextTag(def.tag), params };
}

export function addComponent(type, x, y) {
  const c = newComponent(type, x, y);
  doc().components.push(c);
  select(c.id);
  commit();
  return c;
}

function pruneJunctions() {
  const d = doc();
  const ids = new Set(d.components.map((c) => c.id));
  d.wires = d.wires.filter((w) => ids.has(w.a.c) && ids.has(w.b.c));
  for (;;) {
    const lonely = d.components.filter((c) => c.type === 'junction' && wiresAt(c.id).length === 0);
    if (!lonely.length) break;
    const gone = new Set(lonely.map((c) => c.id));
    d.components = d.components.filter((c) => !gone.has(c.id));
  }
  for (const s of d.steps) {
    for (const k of Object.keys(s.states)) if (!d.components.some((c) => c.id === k)) delete s.states[k];
  }
}

export function deleteSelection() {
  if (!state.sel.size) return;
  const d = doc();
  const ids = state.sel;
  d.wires = d.wires.filter((w) => !ids.has(w.id) && !ids.has(w.a.c) && !ids.has(w.b.c));
  d.components = d.components.filter((c) => !ids.has(c.id));
  d.frames = d.frames.filter((f) => !ids.has(f.id));
  d.texts = d.texts.filter((t) => !ids.has(t.id));
  pruneJunctions();
  select([]);
  commit();
}

export function rotateSelection(deg = 90) {
  let n = 0;
  for (const id of state.sel) {
    const c = compById(id);
    if (!c || c.type === 'junction') continue;
    c.rot = (((c.rot || 0) + deg) % 360 + 360) % 360;
    for (const w of wiresAt(c.id)) w.pts = null;
    n++;
  }
  if (n) commit();
}

export function flipSelection() {
  let n = 0;
  for (const id of state.sel) {
    const c = compById(id);
    if (!c || c.type === 'junction') continue;
    c.flip = !c.flip;
    for (const w of wiresAt(c.id)) w.pts = null;
    n++;
  }
  if (n) commit();
}

export function rerouteSelection() {
  let n = 0;
  for (const id of state.sel) {
    const w = wireById(id);
    if (w && w.pts) { w.pts = null; n++; }
  }
  if (!n) for (const w of doc().wires) { if (w.pts) { w.pts = null; n++; } }
  if (n) commit();
}

export function copySelection() {
  const comps = doc().components.filter((c) => state.sel.has(c.id));
  if (!comps.length) return;
  const ids = new Set(comps.map((c) => c.id));
  clipboard = JSON.stringify({
    components: comps,
    wires: doc().wires.filter((w) => ids.has(w.a.c) && ids.has(w.b.c)),
    frames: doc().frames.filter((f) => state.sel.has(f.id)),
    texts: doc().texts.filter((t) => state.sel.has(t.id)),
  });
}

export function pasteClipboard(dx = 10, dy = 10) {
  if (!clipboard) return;
  const data = JSON.parse(clipboard);
  const map = new Map();
  const added = [];
  for (const c of data.components) {
    const def = typeDef(c.type);
    const nc = { ...c, id: uid('c'), x: c.x + dx, y: c.y + dy };
    map.set(c.id, nc.id);
    doc().components.push(nc);
    nc.tag = def && def.tag ? nextTag(def.tag) : '';
    added.push(nc.id);
  }
  for (const w of data.wires) {
    doc().wires.push({ ...w, id: uid('w'), a: { c: map.get(w.a.c), p: w.a.p }, b: { c: map.get(w.b.c), p: w.b.p }, pts: null });
  }
  for (const f of data.frames) { const nf = { ...f, id: uid('f'), x: f.x + dx, y: f.y + dy }; doc().frames.push(nf); added.push(nf.id); }
  for (const t of data.texts) { const nt = { ...t, id: uid('t'), x: t.x + dx, y: t.y + dy }; doc().texts.push(nt); added.push(nt.id); }
  clipboard = JSON.stringify({
    components: data.components.map((c) => ({ ...c, x: c.x + dx, y: c.y + dy })),
    wires: data.wires,
    frames: data.frames.map((f) => ({ ...f, x: f.x + dx, y: f.y + dy })),
    texts: data.texts.map((t) => ({ ...t, x: t.x + dx, y: t.y + dy })),
  });
  select(added);
  commit();
}

export function duplicateSelection() { copySelection(); pasteClipboard(); }

/** 選択した機器をそろえる。mode: left | hcenter | right | top | vcenter | bottom */
export function alignSelection(mode) {
  const comps = doc().components.filter((c) => state.sel.has(c.id) && c.type !== 'junction');
  if (comps.length < 2) return;
  const bb = comps.map((c) => geoms.get(c.id).bbox);
  const target = {
    left: Math.min(...bb.map((b) => b.x0)), right: Math.max(...bb.map((b) => b.x1)),
    top: Math.min(...bb.map((b) => b.y0)), bottom: Math.max(...bb.map((b) => b.y1)),
    hcenter: comps.reduce((a, c) => a + c.x, 0) / comps.length,
    vcenter: comps.reduce((a, c) => a + c.y, 0) / comps.length,
  }[mode];
  comps.forEach((c, i) => {
    const b = bb[i];
    if (mode === 'left') c.x += snap(target - b.x0);
    else if (mode === 'right') c.x += snap(target - b.x1);
    else if (mode === 'top') c.y += snap(target - b.y0);
    else if (mode === 'bottom') c.y += snap(target - b.y1);
    else if (mode === 'hcenter') c.x = snap(target);
    else if (mode === 'vcenter') c.y = snap(target);
    for (const w of wiresAt(c.id)) w.pts = null;
  });
  commit();
}

function splitWire(w, x, y) {
  const pts = routes.get(w.id);
  if (!pts) return null;
  const n = nearestOnPath(pts, x, y);
  let jx = n.horizontal ? snap(n.x) : n.x;
  let jy = n.horizontal ? n.y : snap(n.y);
  const [p0, p1] = [pts[n.seg], pts[n.seg + 1]];
  jx = Math.max(Math.min(p0[0], p1[0]), Math.min(Math.max(p0[0], p1[0]), jx));
  jy = Math.max(Math.min(p0[1], p1[1]), Math.min(Math.max(p0[1], p1[1]), jy));
  const j = { id: uid('j'), type: 'junction', x: jx, y: jy, rot: 0, flip: false, tag: '', params: {} };
  doc().components.push(j);
  const first = simplify([...pts.slice(0, n.seg + 1), [jx, jy]]);
  const second = simplify([[jx, jy], ...pts.slice(n.seg + 1)]);
  const pipe2 = { ...(w.pipe || {}) };
  const len = Number(w.pipe && w.pipe.len) || 0;
  if (len > 0) {
    const plen = (q) => q.reduce((a, pt, i) => (i ? a + Math.abs(pt[0] - q[i - 1][0]) + Math.abs(pt[1] - q[i - 1][1]) : 0), 0);
    const l1 = plen(first), l2 = plen(second);
    const r = l1 + l2 > 0 ? l1 / (l1 + l2) : 0.5;
    w.pipe = { ...w.pipe, len: Math.round(len * r * 100) / 100, bends: 0 };
    pipe2.len = Math.round(len * (1 - r) * 100) / 100;
  }
  const w2 = { id: uid('w'), a: { c: j.id, p: 'J' }, b: { ...w.b }, kind: w.kind, pts: second.length >= 2 ? second : null, pipe: pipe2 };
  w.b = { c: j.id, p: 'J' };
  w.pts = first.length >= 2 ? first : null;
  doc().wires.push(w2);
  return j;
}

function addWire(a, b) {
  if (a.c === b.c && a.p === b.p) return null;
  const dup = doc().wires.some((w) =>
    (w.a.c === a.c && w.a.p === a.p && w.b.c === b.c && w.b.p === b.p)
    || (w.a.c === b.c && w.a.p === b.p && w.b.c === a.c && w.b.p === a.p));
  if (dup) return null;
  const kind = (a.p === 'X' || b.p === 'X') ? 'pilot' : 'main';
  const w = { id: uid('w'), a: { ...a }, b: { ...b }, kind, pts: null, pipe: {} };
  doc().wires.push(w);
  return w;
}

export function cycleState(c) {
  const def = typeDef(c.type);
  if (!def || !def.states) return;
  const opts = def.states.options.map((o) => o.value);
  const i = opts.indexOf(stateOf(c));
  setStateOf(c, opts[(i + 1) % opts.length]);
  commit();
}

// ---------------------------------------------------------------------------
// ポインタ操作
// ---------------------------------------------------------------------------
function hitOf(el) {
  const t = el && el.closest ? el.closest('[data-kind]') : null;
  if (!t || !svg.contains(t)) return null;
  return { kind: t.dataset.kind, id: t.dataset.id, c: t.dataset.c, p: t.dataset.p, corner: t.dataset.corner, el: t };
}

function startPan(e) {
  drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  svg.classList.add('panning');
}

function startMove(e, p) {
  const items = [];
  const moving = new Set();
  for (const id of state.sel) {
    const c = compById(id);
    if (c) { items.push({ o: c, x: c.x, y: c.y }); moving.add(id); continue; }
    const f = frameById(id);
    if (f) { items.push({ o: f, x: f.x, y: f.y }); continue; }
    const t = textById(id);
    if (t) items.push({ o: t, x: t.x, y: t.y });
  }
  const only = new Set();
  const carried = [];
  for (const w of doc().wires) {
    const ina = moving.has(w.a.c), inb = moving.has(w.b.c);
    if (ina && inb && w.pts) carried.push({ w, pts: w.pts.map((q) => [q[0], q[1]]) });
    else if (ina || inb) only.add(w.id);
    if (ina && inb && !w.pts) only.add(w.id);
  }
  drag = { mode: 'move', start: p, items, only, carried, moved: false };
}

function onDown(e) {
  if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) { startPan(e); e.preventDefault(); return; }
  if (e.button !== 0) return;
  svg.setPointerCapture(e.pointerId);
  const p = toWorld(e);
  const hit = hitOf(e.target);

  if (placing) {
    const c = addComponent(placing.type, p.x, p.y);
    if (!e.shiftKey) endPlace();
    else select(c.id);
    return;
  }
  if (tool === 'frame') { drag = { mode: 'frame-new', x0: snap(p.x), y0: snap(p.y) }; return; }
  if (tool === 'text') {
    const t = { id: uid('t'), x: snap(p.x), y: snap(p.y), text: '注記', size: 3 };
    doc().texts.push(t);
    select(t.id);
    commit();
    setTool('select');
    return;
  }
  if (!hit) {
    if (!e.shiftKey) select([]);
    drag = { mode: 'marquee', x0: p.x, y0: p.y, add: e.shiftKey };
    return;
  }
  if (hit.kind === 'port') { drag = { mode: 'wire', from: { c: hit.c, p: hit.p }, cur: p }; svg.classList.add('wiring'); return; }
  if (hit.kind === 'junction') {
    if (state.sel.has(hit.id) && !e.shiftKey) { startMove(e, p); return; }
    drag = { mode: 'junction', id: hit.id, start: p };
    return;
  }
  if (hit.kind === 'label') { const c = compById(hit.id); select(c.id, e.shiftKey); const off = c.label || { dx: 0, dy: 0 }; drag = { mode: 'label', c, dx: off.dx || 0, dy: off.dy || 0, start: p, moved: false }; return; }
  if (hit.kind === 'frame-h') { drag = { mode: 'frame-resize', f: frameById(hit.id), corner: hit.corner }; return; }
  if (hit.kind === 'wire') {
    select(hit.id, e.shiftKey);
    const pts = routes.get(hit.id);
    const n = pts ? nearestOnPath(pts, p.x, p.y) : null;
    drag = { mode: 'seg', id: hit.id, seg: n ? n.seg : -1, start: p, moved: false };
    return;
  }
  if (hit.kind === 'comp' || hit.kind === 'frame' || hit.kind === 'text') {
    if (e.shiftKey) select(hit.id, true);
    else if (!state.sel.has(hit.id)) select(hit.id);
    startMove(e, p);
  }
}

function onMove(e) {
  if (placing) { updateGhost(e); }
  if (!drag) return;
  const p = toWorld(e);
  if (drag.mode === 'pan') {
    const rect = svg.getBoundingClientRect();
    view.x = drag.vx - (e.clientX - drag.sx) * view.w / rect.width;
    view.y = drag.vy - (e.clientY - drag.sy) * view.h / rect.height;
    applyView();
  } else if (drag.mode === 'move') {
    const dx = snap(p.x - drag.start.x), dy = snap(p.y - drag.start.y);
    if (!drag.moved && dx === 0 && dy === 0) return;
    drag.moved = true;
    for (const it of drag.items) { it.o.x = it.x + dx; it.o.y = it.y + dy; }
    for (const cw of drag.carried) cw.w.pts = cw.pts.map((q) => [q[0] + dx, q[1] + dy]);
    queueRender({ reroute: true, only: drag.only });
  } else if (drag.mode === 'junction') {
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 1.2) {
      drag = { mode: 'wire', from: { c: drag.id, p: 'J' }, cur: p };
      svg.classList.add('wiring');
    }
  } else if (drag.mode === 'wire') {
    drag.cur = p;
    drawRubber(e);
  } else if (drag.mode === 'marquee') {
    drag.x1 = p.x; drag.y1 = p.y;
    const x = Math.min(drag.x0, p.x), y = Math.min(drag.y0, p.y);
    setTemp(`<rect class="marquee" x="${x}" y="${y}" width="${Math.abs(p.x - drag.x0)}" height="${Math.abs(p.y - drag.y0)}"/>`);
  } else if (drag.mode === 'seg') {
    moveSegment(p);
  } else if (drag.mode === 'label') {
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 0.8) return;
    drag.moved = true;
    drag.c.label = { dx: Math.round((drag.dx + dx) * 2) / 2, dy: Math.round((drag.dy + dy) * 2) / 2 };
    queueRender({ reroute: false });
  } else if (drag.mode === 'frame-new') {
    const x = Math.min(drag.x0, snap(p.x)), y = Math.min(drag.y0, snap(p.y));
    drag.rect = { x, y, w: Math.abs(snap(p.x) - drag.x0), h: Math.abs(snap(p.y) - drag.y0) };
    setTemp(`<rect class="frame-box ghost" x="${x}" y="${y}" width="${drag.rect.w}" height="${drag.rect.h}"/>`);
  } else if (drag.mode === 'frame-resize') {
    const f = drag.f;
    const x1 = f.x + f.w, y1 = f.y + f.h;
    const px = snap(p.x), py = snap(p.y);
    if (drag.corner.includes('w')) { f.x = Math.min(px, x1 - 5); f.w = x1 - f.x; } else f.w = Math.max(5, px - f.x);
    if (drag.corner.includes('n')) { f.y = Math.min(py, y1 - 5); f.h = y1 - f.y; } else f.h = Math.max(5, py - f.y);
    drag.moved = true;
    queueRender({ reroute: false });
  }
}

function moveSegment(p) {
  const w = wireById(drag.id);
  const base = drag.base || routes.get(drag.id);
  if (!w || !base || drag.seg <= 0 || drag.seg >= base.length - 2) return;   // 端の線分はポートに付いているので動かさない
  if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 1) return;
  if (!drag.base) drag.base = base.map((q) => [q[0], q[1]]);
  drag.moved = true;
  const pts = drag.base.map((q) => [q[0], q[1]]);
  const i = drag.seg;
  const horizontal = Math.abs(pts[i][1] - pts[i + 1][1]) < 1e-6;
  if (horizontal) { const y = snap(p.y); pts[i][1] = y; pts[i + 1][1] = y; }
  else { const x = snap(p.x); pts[i][0] = x; pts[i + 1][0] = x; }
  w.pts = pts;
  routes.set(w.id, pts);
  queueRender({ reroute: false });
}

function setTemp(html) {
  let g = L.ui.querySelector('#temp');
  if (!g) {
    g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.id = 'temp';
    L.ui.appendChild(g);
  }
  g.innerHTML = html;
}

function targetAt(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return hitOf(el);
}

function drawRubber(e) {
  const from = endpoint(drag.from);
  if (!from) return;
  const hit = targetAt(e);
  let to = { x: drag.cur.x, y: drag.cur.y, dx: 0, dy: 0 };
  let ok = false;
  if (hit && hit.kind === 'port' && !(hit.c === drag.from.c && hit.p === drag.from.p)) {
    to = endpoint({ c: hit.c, p: hit.p }) || to; ok = true;
  } else if (hit && hit.kind === 'junction' && hit.id !== drag.from.c) {
    to = endpoint({ c: hit.id, p: 'J' }) || to; ok = true;
  } else if (hit && hit.kind === 'wire') {
    const n = nearestOnPath(routes.get(hit.id), drag.cur.x, drag.cur.y);
    to = { x: n.x, y: n.y, dx: 0, dy: 0 }; ok = true;
  } else {
    to = { x: snap(to.x), y: snap(to.y), dx: 0, dy: 0 };
  }
  const pts = router.route(from, to);
  setTemp(`<path class="rubber${ok ? ' ok' : ''}" d="${pathD(pts)}"/>`
    + (ok ? `<circle class="snap-dot" cx="${to.x}" cy="${to.y}" r="1.6"/>` : ''));
}

function onUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  svg.classList.remove('panning', 'wiring');
  if (svg.hasPointerCapture && svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
  const p = toWorld(e);
  if (d.mode === 'move') {
    if (d.moved) commit();
  } else if (d.mode === 'junction') {
    select(d.id, e.shiftKey);
  } else if (d.mode === 'wire') {
    setTemp('');
    const hit = targetAt(e);
    let made = false;
    if (hit && hit.kind === 'port') made = !!addWire(d.from, { c: hit.c, p: hit.p });
    else if (hit && hit.kind === 'junction' && hit.id !== d.from.c) made = !!addWire(d.from, { c: hit.id, p: 'J' });
    else if (hit && hit.kind === 'wire') {
      const w = wireById(hit.id);
      const touching = w && ((w.a.c === d.from.c && w.a.p === d.from.p) || (w.b.c === d.from.c && w.b.p === d.from.p));
      if (w && !touching) {
        const j = splitWire(w, p.x, p.y);
        if (j) { computeGeoms(); made = !!addWire(d.from, { c: j.id, p: 'J' }); }
      }
    }
    if (made) commit(); else render({ reroute: false });
  } else if (d.mode === 'marquee') {
    setTemp('');
    if (d.x1 == null) return;
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
    const ids = [];
    for (const c of doc().components) {
      const g = geoms.get(c.id);
      if (g && g.bbox.x0 >= x0 && g.bbox.x1 <= x1 && g.bbox.y0 >= y0 && g.bbox.y1 <= y1) ids.push(c.id);
    }
    for (const f of doc().frames) if (f.x >= x0 && f.x + f.w <= x1 && f.y >= y0 && f.y + f.h <= y1) ids.push(f.id);
    for (const t of doc().texts) if (t.x >= x0 && t.x <= x1 && t.y >= y0 && t.y <= y1) ids.push(t.id);
    for (const w of doc().wires) {
      const pts = routes.get(w.id);
      if (pts && pts.every((q) => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1)) ids.push(w.id);
    }
    if (d.add) { for (const id of ids) state.sel.add(id); select([...state.sel]); }
    else select(ids);
  } else if (d.mode === 'seg') {
    if (d.moved) {
      const w = wireById(d.id);
      if (w && w.pts) w.pts = simplify(w.pts);
      commit();
    }
  } else if (d.mode === 'label') {
    if (d.moved) commit();
  } else if (d.mode === 'frame-new') {
    setTemp('');
    if (d.rect && d.rect.w >= 5 && d.rect.h >= 5) {
      const f = { id: uid('f'), ...d.rect, label: '' };
      doc().frames.push(f);
      select(f.id);
      commit();
    }
    setTool('select');
  } else if (d.mode === 'frame-resize') {
    if (d.moved) commit();
  }
}

function onWheel(e) {
  e.preventDefault();
  const p = toWorld(e);
  zoomBy(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
}

function onDblClick(e) {
  const hit = hitOf(e.target);
  if (!hit) return;
  if (hit.kind === 'comp') {
    const c = compById(hit.id);
    if (c) cycleState(c);
  } else if (hit.kind === 'wire') {
    const w = wireById(hit.id);
    const p = toWorld(e);
    if (w) { const j = splitWire(w, p.x, p.y); if (j) { select(j.id); commit(); } }
  }
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function nudge(dx, dy) {
  let n = 0;
  for (const id of state.sel) {
    const o = compById(id) || frameById(id) || textById(id);
    if (!o) continue;
    o.x += dx; o.y += dy; n++;
    if (compById(id)) for (const w of wiresAt(id)) w.pts = null;
  }
  if (n) commit();
}

function onKey(e) {
  if (isTyping(e)) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') { spaceDown = true; svg.classList.add('pan-ready'); e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if (placing) endPlace();
    if (drag && drag.mode === 'wire') { drag = null; setTemp(''); svg.classList.remove('wiring'); }
    setTool('select');
    select([]);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); e.preventDefault(); return; }
  if (!ctrl && (e.key === 'r' || e.key === 'R')) { rotateSelection(e.shiftKey ? -90 : 90); return; }
  if (!ctrl && (e.key === 'f' || e.key === 'F')) { flipSelection(); return; }
  if (ctrl && (e.key === 'c' || e.key === 'C')) { copySelection(); return; }
  if (ctrl && (e.key === 'v' || e.key === 'V')) { pasteClipboard(); e.preventDefault(); return; }
  if (ctrl && (e.key === 'd' || e.key === 'D')) { duplicateSelection(); e.preventDefault(); return; }
  if (ctrl && (e.key === 'a' || e.key === 'A')) {
    select([...doc().components.map((c) => c.id), ...doc().wires.map((w) => w.id), ...doc().frames.map((f) => f.id), ...doc().texts.map((t) => t.id)]);
    e.preventDefault();
    return;
  }
  const step = e.shiftKey ? G * 4 : G;
  if (e.key === 'ArrowLeft') { nudge(-step, 0); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { nudge(step, 0); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { nudge(0, -step); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { nudge(0, step); e.preventDefault(); }
  else if (e.key === '0' && !ctrl) fitView();
}

// ---------------------------------------------------------------------------
// パレットからの配置
// ---------------------------------------------------------------------------
export function beginPlace(type, fromDrag = false) {
  placing = { type, fromDrag };
  svg.classList.add('placing');
  setTool('select');
}

export function endPlace() {
  placing = null;
  svg.classList.remove('placing');
  setTemp('');
}

export function isPlacing() { return !!placing; }

function updateGhost(e) {
  if (!placing) return;
  const rect = svg.getBoundingClientRect();
  const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!inside) { setTemp(''); return; }
  const p = toWorld(e);
  const c = newComponent(placing.type, p.x, p.y);
  c.tag = '';
  const g = geomOf(c, { noState: true });
  if (g) setTemp(compSvg(c, g, 'ghost'));
}

/** パレットからドラッグしてきて、キャンバスの上で離したとき */
export function dropPlace(e) {
  if (!placing) return false;
  const rect = svg.getBoundingClientRect();
  const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!inside) return false;
  const p = toWorld(e);
  addComponent(placing.type, p.x, p.y);
  endPlace();
  return true;
}

export function ghostMove(e) { updateGhost(e); }

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
export function initEditor(el) {
  svg = el;
  svg.classList.add('dw');
  svg.innerHTML = `
    <defs>
      <pattern id="grid-dots" width="${G * 2}" height="${G * 2}" patternUnits="userSpaceOnUse">
        <circle cx="0" cy="0" r="0.18" class="grid-dot"/><circle cx="${G}" cy="0" r="0.1" class="grid-dot"/>
        <circle cx="0" cy="${G}" r="0.1" class="grid-dot"/><circle cx="${G}" cy="${G}" r="0.1" class="grid-dot"/>
        <circle cx="${G * 2}" cy="0" r="0.18" class="grid-dot"/><circle cx="0" cy="${G * 2}" r="0.18" class="grid-dot"/>
        <circle cx="${G * 2}" cy="${G * 2}" r="0.18" class="grid-dot"/>
      </pattern>
      <filter id="paper-shadow" x="-5%" y="-5%" width="110%" height="112%">
        <feDropShadow dx="0" dy="1.2" stdDeviation="2.2" flood-color="#000" flood-opacity="0.45"/>
      </filter>
    </defs>
    <style>${DRAWING_CSS}</style>
    <g id="L-sheet" filter="url(#paper-shadow)"></g>
    <rect id="L-grid" class="grid" fill="url(#grid-dots)"/>
    <g id="L-frames"></g><g id="L-under"></g><g id="L-wires"></g><g id="L-comps"></g>
    <g id="L-notes"></g><g id="L-over"></g><g id="L-ui"></g>`;
  for (const k of ['sheet', 'frames', 'under', 'wires', 'comps', 'notes', 'over', 'ui']) L[k] = svg.querySelector(`#L-${k}`);
  L.grid = svg.querySelector('#L-grid');

  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('dblclick', onDblClick);
  svg.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; svg.classList.remove('pan-ready'); } });
  new ResizeObserver(() => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const aspect = rect.width / rect.height;
    const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
    view.h = view.w / aspect;
    view.x = cx - view.w / 2; view.y = cy - view.h / 2;
    applyView();
  }).observe(svg);

  let lastSheet = '';
  on('doc', (d) => {
    const { w, h } = sheetSize();
    L.grid.setAttribute('x', 10); L.grid.setAttribute('y', 10);
    L.grid.setAttribute('width', w - 20); L.grid.setAttribute('height', h - 20);
    render();
    const key = `${w}x${h}`;
    if ((d && d.loaded) || key !== lastSheet) { lastSheet = key; fitView(); }
  });
  on('sel', () => render({ reroute: false }));
  on('results', () => render({ reroute: false }));
  on('view', () => render({ reroute: false }));
  on('step', () => render({ reroute: false }));
}
