// 図記号。JIS B 0125-1984 の記号要素と寸法比に合わせて、mm 単位の図形の並びとして作る。
//
// 基準寸法 ℓ = 10 mm（油研「図記号の寸法」）: 大円 φ10、中円 φ7.5、小円 φ3.3、接続点 φ1.5、
// 切換弁の正方形 10、ポート間隔 5、接続口 2.5、操作方法の長方形 10 × 5。
// ポートはすべて 2.5 mm の格子に乗る。
//
// 記号を足すとき: gen('名前', (p, ctx) => { const s = new Sym(); …; return s; }) を書き、
// library/*.json の "symbol" にその名前を書く。p は機器のパラメータ、ctx.state は工程の状態。

const R3 = (v) => Math.round(v * 1000) / 1000;

export class Sym {
  constructor() {
    this.prims = [];
    this.ports = {};
    this.labelSide = 'right';
  }

  line(x1, y1, x2, y2, k) { this.prims.push({ t: 'l', x1, y1, x2, y2, k }); return this; }

  poly(pts, o = {}) {
    this.prims.push({ t: 'p', pts: pts.map((q) => [q[0], q[1]]), closed: !!o.closed, fill: o.fill || 'none', k: o.k });
    return this;
  }

  rect(x, y, w, h, o = {}) {
    return this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], { closed: true, ...o });
  }

  circle(cx, cy, r, o = {}) { this.prims.push({ t: 'c', cx, cy, r, fill: o.fill || 'none', k: o.k }); return this; }

  // 角度は度。画面上で時計回り（y が下向き）に a0 から a1 へ描く
  arc(cx, cy, r, a0, a1, k) {
    const rad = Math.PI / 180;
    this.prims.push({
      t: 'a', cx, cy, r,
      x1: cx + r * Math.cos(a0 * rad), y1: cy + r * Math.sin(a0 * rad),
      x2: cx + r * Math.cos(a1 * rad), y2: cy + r * Math.sin(a1 * rad),
      large: (a1 - a0) > 180 ? 1 : 0, sweep: 1, k,
    });
    return this;
  }

  text(x, y, str, o = {}) {
    this.prims.push({ t: 't', x, y, s: String(str), size: o.size || 2.2, anchor: o.anchor || 'middle', k: o.k });
    return this;
  }

  port(name, x, y, dx, dy) { this.ports[name] = { x, y, dx, dy }; return this; }

  dot(x, y, r = 0.75) { return this.circle(x, y, r, { fill: 'ink' }); }

  // (x, y) を先端とする塗りつぶしの矢じり。向きは (dx, dy)
  head(x, y, dx, dy, size = 1.8, o = {}) {
    const n = Math.hypot(dx, dy) || 1;
    const ux = dx / n, uy = dy / n;
    const w = size * 0.36;
    const bx = x - ux * size, by = y - uy * size;
    return this.poly([[x, y], [bx - uy * w, by + ux * w], [bx + uy * w, by - ux * w]],
      { closed: true, fill: o.fill || 'ink', k: o.k });
  }

  arrow(x1, y1, x2, y2, size = 1.8, k) {
    this.line(x1, y1, x2, y2, k);
    return this.head(x2, y2, x2 - x1, y2 - y1, size);
  }

  // ばね（ジグザグ）
  spring(x1, y1, x2, y2, amp = 1.3, n = 3) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const pts = [[x1, y1]];
    const seg = 2 * n;
    for (let i = 0; i < seg; i++) {
      const t = (i + 0.5) / seg;
      const s = i % 2 === 0 ? amp : -amp;
      pts.push([x1 + dx * t + nx * s, y1 + dy * t + ny * s]);
    }
    pts.push([x2, y2]);
    return this.poly(pts);
  }

  // 局所表示のタンク。管端 (x, y) から下へ
  tank(x, y, k) {
    this.line(x, y, x, y + 2.5, k);
    return this.poly([[x - 2.5, y], [x - 2.5, y + 2.5], [x + 2.5, y + 2.5], [x + 2.5, y]]);
  }

  // 別の記号を変換して取り込む。tf = {x, y, rot(0/90/180/270 時計回り), flip(左右反転), scale}
  add(other, tf = {}) {
    const f = makeTf(tf);
    for (const q of other.prims) this.prims.push(tfPrim(q, f));
    const ports = {};
    for (const [name, pt] of Object.entries(other.ports)) {
      const [x, y] = f.pt(pt.x, pt.y);
      const [dx, dy] = f.dir(pt.dx, pt.dy);
      ports[name] = { x, y, dx, dy };
    }
    return ports;
  }
}

export function makeTf({ x = 0, y = 0, rot = 0, flip = false, scale = 1 } = {}) {
  const r = ((rot % 360) + 360) % 360;
  const dir = (px, py) => {
    if (flip) px = -px;
    if (r === 90) return [-py, px];
    if (r === 180) return [-px, -py];
    if (r === 270) return [py, -px];
    return [px, py];
  };
  const pt = (px, py) => {
    const [a, b] = dir(px * scale, py * scale);
    return [a + x, b + y];
  };
  return { pt, dir, flip, scale };
}

function tfPrim(q, f) {
  const o = { ...q };
  if (q.t === 'l') {
    [o.x1, o.y1] = f.pt(q.x1, q.y1);
    [o.x2, o.y2] = f.pt(q.x2, q.y2);
  } else if (q.t === 'p') {
    o.pts = q.pts.map(([a, b]) => f.pt(a, b));
  } else if (q.t === 'c') {
    [o.cx, o.cy] = f.pt(q.cx, q.cy);
    o.r = q.r * f.scale;
  } else if (q.t === 'a') {
    [o.cx, o.cy] = f.pt(q.cx, q.cy);
    [o.x1, o.y1] = f.pt(q.x1, q.y1);
    [o.x2, o.y2] = f.pt(q.x2, q.y2);
    o.r = q.r * f.scale;
    o.sweep = f.flip ? 1 - q.sweep : q.sweep;
  } else if (q.t === 't') {
    [o.x, o.y] = f.pt(q.x, q.y);
    o.size = q.size * (f.scale < 1 ? Math.max(f.scale, 0.85) : f.scale);
    if (f.flip && q.anchor !== 'middle') o.anchor = q.anchor === 'start' ? 'end' : 'start';
  }
  return o;
}

export function bboxOf(prims) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const ext = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const q of prims) {
    if (q.k === 'hl') continue;
    if (q.t === 'l') { ext(q.x1, q.y1); ext(q.x2, q.y2); }
    else if (q.t === 'p') q.pts.forEach(([a, b]) => ext(a, b));
    else if (q.t === 'c') { ext(q.cx - q.r, q.cy - q.r); ext(q.cx + q.r, q.cy + q.r); }
    else if (q.t === 'a') { ext(q.x1, q.y1); ext(q.x2, q.y2); }
  }
  if (!Number.isFinite(x0)) return { x0: -2.5, y0: -2.5, x1: 2.5, y1: 2.5 };
  return { x0, y0, x1, y1 };
}

const CLS = { thin: 's-thin', dash: 's-dash', chain: 's-chain', hl: 's-hl', elec: 's-thin' };

function cls(q) {
  const c = [];
  if (q.k && CLS[q.k]) c.push(CLS[q.k]);
  if (q.fill === 'ink') c.push('f-ink');
  else if (q.fill === 'paper') c.push('f-paper');
  return c.length ? ` class="${c.join(' ')}"` : '';
}

// 図形の並びを SVG にする。文字は回転させないので別に返す
export function primsToSvg(prims) {
  let shapes = '';
  const texts = [];
  for (const q of prims) {
    if (q.t === 'l') {
      shapes += `<line x1="${R3(q.x1)}" y1="${R3(q.y1)}" x2="${R3(q.x2)}" y2="${R3(q.y2)}"${cls(q)}/>`;
    } else if (q.t === 'p') {
      const pts = q.pts.map(([a, b]) => `${R3(a)},${R3(b)}`).join(' ');
      shapes += `<${q.closed ? 'polygon' : 'polyline'} points="${pts}"${cls(q)}/>`;
    } else if (q.t === 'c') {
      shapes += `<circle cx="${R3(q.cx)}" cy="${R3(q.cy)}" r="${R3(q.r)}"${cls(q)}/>`;
    } else if (q.t === 'a') {
      shapes += `<path d="M${R3(q.x1)} ${R3(q.y1)}A${R3(q.r)} ${R3(q.r)} 0 ${q.large} ${q.sweep} ${R3(q.x2)} ${R3(q.y2)}"${cls(q)}/>`;
    } else if (q.t === 't') {
      texts.push(q);
    }
  }
  return { shapes, texts };
}

export function textsToSvg(texts, extraClass = '') {
  return texts.map((q) =>
    `<text x="${R3(q.x)}" y="${R3(q.y)}" font-size="${R3(q.size)}" text-anchor="${q.anchor}" class="sym-text ${extraClass}">${esc(q.s)}</text>`).join('');
}

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// 共通の部品
// ---------------------------------------------------------------------------
const BALL = 1.65;                    // 小円 φ3.3
const APEX = BALL * Math.SQRT2;       // 弁座の頂点までの距離

// 逆止め弁の球と弁座。free は自由流れの向き 'up' | 'down'。戻り値は管路をつなぐ y 座標 [上, 下]
function checkCore(s, cx, cy, free) {
  const d = free === 'up' ? 1 : -1;     // 頂点は流れの上流側
  s.circle(cx, cy, BALL);
  const ay = cy + d * APEX;
  s.line(cx, ay, cx - 2.6, ay - d * 2.6);
  s.line(cx, ay, cx + 2.6, ay - d * 2.6);
  return free === 'up' ? [cy - BALL, ay] : [ay, cy + BALL];
}

// 絞りの円弧（縦の管路 x = cx をはさむ）
function throttleArcs(s, cx, cy, r = 3.2, gap = 1.0, span = 40) {
  s.arc(cx - gap - r, cy, r, -span, span);
  s.arc(cx + gap + r, cy, r, 180 - span, 180 + span);
}

// 可変を表す斜めの矢印
function varArrow(s, cx, cy, half = 3.5) {
  s.arrow(cx - half, cy + half, cx + half, cy - half, 1.7);
}

// 圧力制御弁の本体（正方形 10）。入口は上 (0,-5)、出口は下 (0,5)。
//   offset: 矢印を管路からずらす（常時閉）。pilot: 'in' | 'out' | null。side: ばねの側 (+1 右 / -1 左)
function pcvCore(s, { offset = true, pilot = 'in', side = 1, drain = false, pilotLen = 2.5 } = {}) {
  s.rect(-5, -5, 10, 10);
  const ax = offset ? -2.5 * side : 0;
  s.arrow(ax, -5, ax, 5, 1.8);
  s.spring(5 * side, 0, 10 * side, 0, 1.4, 3);
  s.arrow(6 * side, 2.6, 9.6 * side, -2.6, 1.5);
  if (pilot) {
    const py = pilot === 'in' ? -5 - pilotLen : 5 + pilotLen;
    const by = pilot === 'in' ? -2.5 : 2.5;
    s.poly([[0, py], [-7.5 * side, py], [-7.5 * side, by], [-5 * side, by]], { k: 'dash' });
  }
  if (drain) {
    s.poly([[5 * side, 3.5], [7.5 * side, 3.5], [7.5 * side, 6.25]], { k: 'dash' });
    s.tank(7.5 * side, 6.25, 'dash');
  }
}

// 切換弁の箱の中身
function boxPar(s, x) {
  s.arrow(x + 2.5, 5, x + 2.5, -5, 1.7);
  s.arrow(x + 7.5, -5, x + 7.5, 5, 1.7);
}
function boxCross(s, x) {
  s.arrow(x + 2.5, 5, x + 7.5, -5, 1.7);
  s.arrow(x + 2.5, -5, x + 7.5, 5, 1.7);
}
function blocked(s, px, py) {
  const d = py < 0 ? 1 : -1;
  s.line(px, py, px, py + 2 * d);
  s.line(px - 1.1, py + 2 * d, px + 1.1, py + 2 * d);
}
function boxCenter(s, x, kind) {
  const a = x + 2.5, b = x + 7.5;
  if (kind === 'tandem') {
    blocked(s, a, -5); blocked(s, b, -5);
    s.poly([[a, 5], [a, 2], [b, 2], [b, 5]]);
  } else if (kind === 'float') {
    blocked(s, a, 5);
    s.poly([[a, -5], [a, 0], [b, 0]]);
    s.line(b, -5, b, 5);
    s.dot(b, 0, 0.6);
  } else if (kind === 'open') {
    s.line(a, -5, a, 5); s.line(b, -5, b, 5); s.line(a, 0, b, 0);
    s.dot(a, 0, 0.6); s.dot(b, 0, 0.6);
  } else if (kind === 'pab') {
    blocked(s, b, 5);
    s.line(a, -5, a, 5);
    s.poly([[a, 0], [b, 0], [b, -5]]);
    s.dot(a, 0, 0.6);
  } else {
    blocked(s, a, -5); blocked(s, b, -5); blocked(s, a, 5); blocked(s, b, 5);
  }
}

// 操作部。xe は弁本体の端の x、side は外向き (-1 左 / +1 右)
function actSolenoid(s, xe, side, y0, label) {
  const x0 = side < 0 ? xe - 10 : xe;
  s.rect(x0, y0, 10, 5);
  if (side < 0) s.line(xe - 6.5, y0 + 5, xe - 3.5, y0);
  else s.line(xe + 3.5, y0, xe + 6.5, y0 + 5);
  if (label) s.text(xe + side * 11.2, y0 + 3.3, label, { size: 2.4, anchor: side < 0 ? 'end' : 'start' });
}
function actSpring(s, xe, side, y) {
  s.spring(xe, y, xe + side * 6, y, 1.25, 3);
}
function actLever(s, xe, side, y) {
  s.line(xe, y, xe + side * 4.5, y);
  s.line(xe + side * 4.5, y - 1.6, xe + side * 4.5, y + 1.6);
  s.line(xe + side * 4.5, y, xe + side * 8, y - 2.6);
  s.circle(xe + side * 8.5, y - 3, 0.7);
}
function actDetent(s, xe, side, y) {
  s.line(xe, y, xe + side * 6, y);
  for (const k of [1.5, 3, 4.5]) {
    s.poly([[xe + side * (k - 0.6), y], [xe + side * k, y - 1.1], [xe + side * (k + 0.6), y]]);
  }
  s.line(xe + side * 3, y - 3, xe + side * 3, y - 1.1);
}

// 4 ポート 3 位置弁の本体（接続口なし）。中央の箱が (-5..5)。
function dcv43Body(s, { center = 'closed', actuation = 'sol', state = null, labels = true } = {}) {
  if (state) {
    const hx = state === 'a' ? -15 : (state === 'b' ? 5 : -5);
    s.rect(hx, -5, 10, 10, { k: 'hl' });
  }
  s.rect(-15, -5, 30, 10);
  s.line(-5, -5, -5, 5);
  s.line(5, -5, 5, 5);
  boxPar(s, -15);
  boxCenter(s, -5, center);
  boxCross(s, 5);
  if (actuation === 'sol') {
    actSpring(s, -15, -1, -2.9); actSolenoid(s, -15, -1, 0, labels ? 'a' : '');
    actSpring(s, 15, 1, -2.9); actSolenoid(s, 15, 1, 0, labels ? 'b' : '');
  } else if (actuation === 'lever') {
    actSpring(s, -15, -1, -2.9); actLever(s, -15, -1, 2.5);
    actSpring(s, 15, 1, -2.9);
  } else {
    actLever(s, -15, -1, 0);
    actDetent(s, 15, 1, 0);
  }
}

function portLabels4(s) {
  s.text(-3.7, -5.9, 'A', { anchor: 'end' });
  s.text(3.7, -5.9, 'B', { anchor: 'start' });
  s.text(-3.7, 7.7, 'P', { anchor: 'end' });
  s.text(3.7, 7.7, 'T', { anchor: 'start' });
}

function ports4(s) {
  s.line(-2.5, -5, -2.5, -7.5); s.line(2.5, -5, 2.5, -7.5);
  s.line(-2.5, 5, -2.5, 7.5); s.line(2.5, 5, 2.5, 7.5);
  s.port('A', -2.5, -7.5, 0, -1).port('B', 2.5, -7.5, 0, -1);
  s.port('P', -2.5, 7.5, 0, 1).port('T', 2.5, 7.5, 0, 1);
  portLabels4(s);
}

// ---------------------------------------------------------------------------
// 記号の登録
// ---------------------------------------------------------------------------
const GEN = {};
export function gen(name, fn) { GEN[name] = fn; }

gen('junction', () => {
  const s = new Sym();
  s.dot(0, 0, 0.75);
  s.port('J', 0, 0, 0, 0);
  return s;
});

gen('tank', () => {
  const s = new Sym();
  s.tank(0, 2.5);
  s.line(0, 0, 0, 2.5);
  s.port('T', 0, 0, 0, -1);
  s.labelSide = 'none';
  return s;
});

gen('pump', (p, ctx) => {
  const s = new Sym();
  s.circle(0, 0, 5);
  s.line(0, -7.5, 0, -5); s.line(0, 5, 0, 7.5);
  s.poly([[0, -5], [-1.45, -2.5], [1.45, -2.5]], { closed: true, fill: 'ink' });
  s.port('P', 0, -7.5, 0, -1).port('S', 0, 7.5, 0, 1);
  // 軸（機械的結合は複線）と電動機
  if (p.drive === 'shaft') {
    s.line(4.97, -0.55, 9, -0.55); s.line(4.97, 0.55, 9, 0.55);
  } else {
    s.line(4.97, -0.55, 10.03, -0.55); s.line(4.97, 0.55, 10.03, 0.55);
    s.circle(15, 0, 5);
    s.text(15, 1.6, 'M', { size: 4.4 });
  }
  if (ctx.args.variable) {
    s.arrow(-6.5, 6.5, 6.5, -6.5, 1.9);
    // 圧力補償: 吐出側からのパイロットと、ばねで戻す制御部
    s.poly([[0, -6.25], [-10, -6.25], [-10, -3.75]], { k: 'dash' });
    s.rect(-11.25, -3.75, 2.5, 3.75);
    s.poly([[-11.0, -3.75], [-9.0, -3.75], [-10, -1.6]], { closed: true, fill: 'ink' });
    s.spring(-10, 0, -10, 4.5, 1.2, 3);
    s.dot(0, -6.25, 0.6);
  }
  s.labelSide = 'left';
  return s;
});

gen('accumulator', () => {
  const s = new Sym();
  s.line(0, 0, 0, -2.5);
  s.arc(0, -12, 3, 180, 360);
  s.arc(0, -5.5, 3, 0, 180);
  s.line(-3, -12, -3, -5.5); s.line(3, -12, 3, -5.5);
  s.line(-3, -9, 3, -9);
  s.poly([[-1.2, -13.6], [1.2, -13.6], [0, -11.6]], { closed: true });
  s.port('P', 0, 0, 0, 1);
  return s;
});

gen('relief', () => {
  const s = new Sym();
  pcvCore(s, { offset: true, pilot: 'in', side: 1 });
  s.line(0, -10, 0, -5); s.line(0, 5, 0, 10);
  s.port('P', 0, -10, 0, -1).port('T', 0, 10, 0, 1);
  return s;
});

gen('reducing', () => {
  const s = new Sym();
  pcvCore(s, { offset: false, pilot: 'out', side: 1, drain: true });
  s.line(0, -10, 0, -5); s.line(0, 5, 0, 10);
  s.port('P', 0, -10, 0, -1).port('A', 0, 10, 0, 1);
  return s;
});

gen('sequence', () => {
  const s = new Sym();
  pcvCore(s, { offset: true, pilot: 'in', side: 1, drain: true });
  s.line(0, -10, 0, -5); s.line(0, 5, 0, 10);
  s.port('P', 0, -10, 0, -1).port('A', 0, 10, 0, 1);
  return s;
});

gen('counterbalance', () => {
  const s = new Sym();
  const core = new Sym();
  pcvCore(core, { offset: true, pilot: 'in', side: 1, pilotLen: 1.25 });
  s.add(core, { x: -5, y: 0, flip: true });        // ばねは左、パイロットは右… を反転して配置
  // 主弁の管路
  s.poly([[0, -7.5], [-5, -7.5], [-5, -5]]);
  s.poly([[-5, 5], [-5, 7.5], [0, 7.5]]);
  // 逆止め弁（弁側 → 負荷側が自由流れ）
  const [ty, by] = checkCore(s, 7.5, 0, 'up');
  s.poly([[0, -7.5], [7.5, -7.5], [7.5, ty]]);
  s.poly([[7.5, by], [7.5, 7.5], [0, 7.5]]);
  s.dot(0, -7.5); s.dot(0, 7.5);
  s.line(0, -12.5, 0, -7.5); s.line(0, 7.5, 0, 12.5);
  s.rect(-16.25, -10, 27.5, 20, { k: 'chain' });
  s.port('C', 0, -12.5, 0, -1).port('V', 0, 12.5, 0, 1);
  return s;
});

gen('pressure_switch', () => {
  const s = new Sym();
  s.line(0, 0, 0, -2.5);
  s.rect(-3.75, -10, 7.5, 7.5);
  s.spring(0, -10, 0, -14.5, 1.3, 3);
  s.arrow(-2.6, -10.6, 2.6, -14.2, 1.5);
  // 接点
  s.line(-2.6, -4.6, -1.4, -4.6); s.line(-1.4, -4.6, 1.6, -7.2); s.line(1.2, -7.6, 2.6, -7.6);
  // 電気信号線
  s.line(3.75, -6.25, 7, -6.25, 'thin');
  s.poly([[5.0, -5.2], [5.9, -7.2], [5.5, -6.1], [6.4, -7.6]], { k: 'thin' });
  s.port('P', 0, 0, 0, 1);
  return s;
});

gen('check', (p) => {
  const s = new Sym();
  const [ty, by] = checkCore(s, 0, 0, 'up');
  s.line(0, 5, 0, by);
  if (p.spring) { s.spring(0, ty, 0, -4.6, 1.1, 2); s.line(0, -4.6, 0, -5); }
  else s.line(0, ty, 0, -5);
  s.port('IN', 0, 5, 0, 1).port('OUT', 0, -5, 0, -1);
  return s;
});

gen('pilot_check', () => {
  const s = new Sym();
  s.rect(-5, -5, 10, 10);
  const [ty, by] = checkCore(s, 0, 0, 'up');
  s.line(0, 7.5, 0, by); s.line(0, ty, 0, -7.5);
  s.poly([[-7.5, 2.5], [-2.6, 2.5]], { k: 'dash' });
  s.port('IN', 0, 7.5, 0, 1).port('OUT', 0, -7.5, 0, -1).port('X', -7.5, 2.5, -1, 0);
  s.text(-6.4, 1.5, 'X', { size: 2.0 });
  return s;
});

gen('stop_valve', () => {
  const s = new Sym();
  s.poly([[-2, -3.5], [2, -3.5], [0, 0]], { closed: true });
  s.poly([[-2, 3.5], [2, 3.5], [0, 0]], { closed: true });
  s.line(0, -5, 0, -3.5); s.line(0, 3.5, 0, 5);
  s.port('IN', 0, 5, 0, 1).port('OUT', 0, -5, 0, -1);
  return s;
});

gen('throttle', () => {
  const s = new Sym();
  s.line(0, -5, 0, 5);
  throttleArcs(s, 0, 0);
  varArrow(s, 0, 0, 3.6);
  s.port('IN', 0, 5, 0, 1).port('OUT', 0, -5, 0, -1);
  return s;
});

gen('throttle_check', () => {
  const s = new Sym();
  s.line(0, -7.5, 0, 7.5);
  throttleArcs(s, 0, 0, 2.8, 0.9, 38);
  varArrow(s, 0, 0, 3.0);
  const [ty, by] = checkCore(s, 6.25, 0, 'down');
  s.poly([[0, -5], [6.25, -5], [6.25, ty]]);
  s.poly([[6.25, by], [6.25, 5], [0, 5]]);
  s.dot(0, -5); s.dot(0, 5);
  s.rect(-4.5, -6.25, 14.5, 12.5, { k: 'thin' });
  s.port('IN', 0, 7.5, 0, 1).port('OUT', 0, -7.5, 0, -1);
  return s;
});

gen('flow_control', (p) => {
  const s = new Sym();
  const withCheck = p.with_check !== false && p.with_check !== 'false';
  s.line(0, -10, 0, 10);
  s.rect(-2.5, -5, 5, 10);
  throttleArcs(s, 0, 1.2, 2.6, 0.8, 36);
  s.arrow(-2.3, 3.5, 2.3, -1.1, 1.4);
  s.head(0, -4.6, 0, -1, 1.7);                    // 流路の矢印: 圧力補償
  if (withCheck) {
    const [ty, by] = checkCore(s, 6.25, 0, 'down');
    s.poly([[0, -7.5], [6.25, -7.5], [6.25, ty]]);
    s.poly([[6.25, by], [6.25, 7.5], [0, 7.5]]);
    s.dot(0, -7.5); s.dot(0, 7.5);
    s.rect(-5, -8.75, 15, 17.5, { k: 'chain' });
  }
  s.port('IN', 0, 10, 0, 1).port('OUT', 0, -10, 0, -1);
  return s;
});

gen('dcv43', (p, ctx) => {
  const s = new Sym();
  dcv43Body(s, { center: p.center, actuation: p.actuation, state: ctx.state });
  ports4(s);
  s.labelSide = 'top';
  return s;
});

gen('dcv42', (p, ctx) => {
  const s = new Sym();
  const normalCross = (p.normal || 'PB') === 'PB';
  if (ctx.state) s.rect(ctx.state === 'on' ? -15 : -5, -5, 10, 10, { k: 'hl' });
  s.rect(-15, -5, 20, 10);
  s.line(-5, -5, -5, 5);
  (normalCross ? boxPar : boxCross)(s, -15);
  (normalCross ? boxCross : boxPar)(s, -5);
  if (p.actuation === 'lever') actLever(s, -15, -1, 0);
  else actSolenoid(s, -15, -1, -2.5, 'a');
  actSpring(s, 5, 1, 0);
  ports4(s);
  s.labelSide = 'top';
  return s;
});

gen('dcv22', (p, ctx) => {
  const s = new Sym();
  const normOpen = p.normal === 'open';
  if (ctx.state) s.rect(ctx.state === 'on' ? -15 : -5, -5, 10, 10, { k: 'hl' });
  s.rect(-15, -5, 20, 10);
  s.line(-5, -5, -5, 5);
  const open = (x) => s.arrow(x + 5, 5, x + 5, -5, 1.7);
  const closed = (x) => { blocked(s, x + 5, -5); blocked(s, x + 5, 5); };
  (normOpen ? closed : open)(-15);
  (normOpen ? open : closed)(-5);
  actSolenoid(s, -15, -1, -2.5, '');
  actSpring(s, 5, 1, 0);
  s.line(0, -5, 0, -7.5); s.line(0, 5, 0, 7.5);
  s.port('A', 0, -7.5, 0, -1).port('P', 0, 7.5, 0, 1);
  s.text(-1.2, -5.9, 'A', { anchor: 'end' });
  s.text(-1.2, 7.7, 'P', { anchor: 'end' });
  s.labelSide = 'top';
  return s;
});

gen('cylinder', (p) => {
  const body = new Sym();
  body.poly([[15, -1.25], [15, -5], [-15, -5], [-15, 5], [15, 5], [15, 1.25]]);
  body.rect(-8.75, -5, 2.5, 10);
  body.poly([[-6.25, -1.25], [22.5, -1.25], [22.5, 1.25], [-6.25, 1.25]]);
  body.line(-12.5, 5, -12.5, 7.5); body.line(12.5, 5, 12.5, 7.5);
  body.port('H', -12.5, 7.5, 0, 1).port('R', 12.5, 7.5, 0, 1);
  const s = new Sym();
  s.ports = s.add(body, { flip: p.rod_side === 'left' });
  s.labelSide = 'top';
  return s;
});

gen('motor_hyd', () => {
  const s = new Sym();
  s.circle(0, 0, 5);
  s.poly([[-1.45, -4.78], [1.45, -4.78], [0, -2.3]], { closed: true, fill: 'ink' });
  s.poly([[-1.45, 4.78], [1.45, 4.78], [0, 2.3]], { closed: true, fill: 'ink' });
  s.line(0, -7.5, 0, -5); s.line(0, 5, 0, 7.5);
  s.line(4.97, -0.55, 10, -0.55); s.line(4.97, 0.55, 10, 0.55);
  s.port('A', 0, -7.5, 0, -1).port('B', 0, 7.5, 0, 1);
  s.text(-1.4, -6.0, 'A', { anchor: 'end' });
  s.text(-1.4, 7.8, 'B', { anchor: 'end' });
  s.labelSide = 'left';
  return s;
});

gen('filter', () => {
  const s = new Sym();
  s.poly([[0, -5], [5, 0], [0, 5], [-5, 0]], { closed: true });
  s.line(-5, 0, 5, 0, 'dash');
  s.line(0, -7.5, 0, -5); s.line(0, 5, 0, 7.5);
  s.port('IN', 0, -7.5, 0, -1).port('OUT', 0, 7.5, 0, 1);
  return s;
});

gen('cooler', (p) => {
  const s = new Sym();
  s.poly([[0, -5], [5, 0], [0, 5], [-5, 0]], { closed: true });
  s.line(-5, 0, 5, 0);
  s.line(0, -7.5, 0, -5); s.line(0, 5, 0, 7.5);
  if (p.coolant !== false && p.coolant !== 'false') {
    // 冷却水の管路を表示するとき: 入口と出口を矢印で示す
    s.arrow(-9.5, 0, -5, 0, 1.6, 'thin');
    s.arrow(5, 0, 9.5, 0, 1.6, 'thin');
  } else {
    s.head(-5, 0, -1, 0, 1.6); s.head(5, 0, 1, 0, 1.6);
  }
  s.port('IN', 0, -7.5, 0, -1).port('OUT', 0, 7.5, 0, 1);
  return s;
});

gen('gauge', () => {
  const s = new Sym();
  s.circle(0, -6.25, 3.75);
  s.arrow(-1.9, -4.5, 2.0, -8.3, 1.5);
  s.line(0, -2.5, 0, 0);
  s.port('P', 0, 0, 0, 1);
  return s;
});

// ---------------------------------------------------------------------------
// 積層弁スタック
//   各社カタログの表記に合わせ、P・T・B・A の 4 本線に機能を配置する。
//   いちばん上に電磁弁（90° 回して描く）、いちばん下がベース（マニホールド）。
//   弁の記号は線の間隔に合わせて 0.75 倍で描く（JIS B 0125 表 1 備考:
//   やむを得ない場合は基準寸法を対象によって変えてよい）。
// ---------------------------------------------------------------------------
const SX = { P: -22.5, T: -7.5, B: 7.5, A: 22.5 };
const STACK_HALF = 32.5;
const MS = 0.75;
const DCV_ZONE = 45;

function layerHeight(layer) {
  if (layer.kind === 'relief' && layer.line === 'AB') return 30;
  if (layer.kind === 'check' || layer.kind === 'throttle') return 15;
  return 20;
}

export function stackGeometry(layers) {
  const hs = layers.map(layerHeight);
  const total = hs.reduce((a, b) => a + b, 0);
  const tops = [];
  let y = -5 - total;
  for (const h of hs) { tops.push(y); y += h; }
  return { heights: hs, tops, total, dcvTop: -5 - total - DCV_ZONE };
}

// 横線。crossXs の位置で縦線を飛び越える
function hline(s, x1, x2, y, crossXs, style, k) {
  const dir = x2 > x1 ? 1 : -1;
  const xs = (crossXs || []).filter((x) => (x - x1) * dir > 0.01 && (x2 - x) * dir > 0.01).sort((a, b) => (a - b) * dir);
  if (style !== 'jump' || !xs.length) { s.line(x1, y, x2, y, k); return; }
  let cur = x1;
  const r = 1.2;
  for (const x of xs) {
    s.line(cur, y, x - dir * r, y, k);
    if (dir > 0) s.arc(x, y, r, 180, 360, k);
    else { s.arc(x, y, r, 180, 360, k); }
    cur = x + dir * r;
  }
  s.line(cur, y, x2, y, k);
}

function drawLayer(s, layer, top, h, style) {
  const bottom = top + h;
  const mid = top + h / 2;
  const inline = {};                      // ライン → [上端, 下端]（そこは管路を切る）
  const kind = layer.kind;
  const lines = layer.line === 'AB' ? ['A', 'B'] : [layer.line];

  if (kind === 'relief') {
    lines.forEach((ln, i) => {
      const y = lines.length === 2 ? top + 9 + i * 13.5 : mid + 1.5;
      const core = new Sym();
      pcvCore(core, { offset: true, pilot: 'in', side: 1, pilotLen: 2.2 });
      // 入口を ln 側、出口を T 側に向けて横置きにする
      const toLeft = SX[ln] > SX.T;       // T は左にある
      const cx = ln === 'P' ? (SX.P + SX.T) / 2 : (ln === 'B' ? 0 : 15);
      s.add(core, { x: cx, y, rot: toLeft ? 90 : 270, flip: toLeft, scale: MS });
      const half = 5 * MS;
      const xin = cx + (toLeft ? half : -half);
      const xout = cx + (toLeft ? -half : half);
      hline(s, SX[ln], xin, y, [], style);
      hline(s, xout, SX.T, y, ln === 'A' ? [SX.B] : [], style);
      s.dot(SX[ln], y, 0.6); s.dot(SX.T, y, 0.6);
    });
  } else if (kind === 'reducing') {
    const core = new Sym();
    pcvCore(core, { offset: false, pilot: null, side: 1 });
    // 一次側はベース（下）、二次側は電磁弁（上）
    s.add(core, { x: SX.P, y: mid, rot: 180, flip: true, scale: MS });
    const half = 5 * MS;
    inline.P = [mid - half, mid + half];
    // ドレンは T ラインへ
    const sx = SX.P + 10 * MS;
    s.poly([[sx - 3.2, mid + 2.6], [sx - 1.2, mid + 2.6], [sx - 1.2, mid + 6.2], [SX.T, mid + 6.2]], { k: 'dash' });
    s.dot(SX.T, mid + 6.2, 0.6);
    // パイロット: 二次側の P、または A・B ライン
    const yp = top + 3;
    const src = layer.line === 'A' || layer.line === 'B' ? layer.line : 'P';
    if (src === 'P') {
      s.poly([[SX.P, yp], [SX.P - 6.5, yp], [SX.P - 6.5, mid - 1.9], [SX.P - half, mid - 1.9]], { k: 'dash' });
      s.dot(SX.P, yp, 0.6);
    } else {
      s.poly([[SX[src], yp], [SX.P - 6.5, yp], [SX.P - 6.5, mid - 1.9], [SX.P - half, mid - 1.9]], { k: 'dash' });
      s.dot(SX[src], yp, 0.6);
    }
  } else if (kind === 'check') {
    const ln = layer.line === 'T' ? 'T' : 'P';
    const core = new Sym();
    const [ty, by] = checkCore(core, 0, 0, ln === 'T' ? 'down' : 'up');
    s.add(core, { x: SX[ln], y: mid, scale: MS });
    inline[ln] = [mid + ty * MS, mid + by * MS];
  } else if (kind === 'throttle') {
    const ln = layer.line === 'T' ? 'T' : 'P';
    const core = new Sym();
    throttleArcs(core, 0, 0);
    varArrow(core, 0, 0, 3.6);
    s.add(core, { x: SX[ln], y: mid, scale: MS });
  } else if (kind === 'tcheck') {
    const out = (layer.mode || 'out') === 'out';
    for (const ln of lines) {
      const side = ln === 'A' ? 1 : -1;       // バイパスを外側（A は右、B は左）に出す
      const core = new Sym();
      throttleArcs(core, 0, 0, 2.8, 0.9, 38);
      varArrow(core, 0, 0, 3.0);
      const [ty, by] = checkCore(core, 6.25, 0, out ? 'down' : 'up');
      core.poly([[0, -5], [6.25, -5], [6.25, ty]]);
      core.poly([[6.25, by], [6.25, 5], [0, 5]]);
      core.dot(0, -5, 0.7); core.dot(0, 5, 0.7);
      core.rect(-4.5, -6.25, 14.5, 12.5, { k: 'thin' });
      s.add(core, { x: SX[ln], y: mid, flip: side < 0, scale: MS });
    }
  } else if (kind === 'pcheck') {
    const half = 3.75;
    for (const ln of lines) {
      const core = new Sym();
      core.rect(-5, -5, 10, 10);
      const [ty, by] = checkCore(core, 0, 0, 'down');
      core.line(0, -5, 0, ty); core.line(0, by, 0, 5);
      s.add(core, { x: SX[ln], y: mid + 2, scale: MS });
      inline[ln] = [mid + 2 - half, mid + 2 + half];
    }
    // パイロットは相手のライン（電磁弁側）から
    const yc = mid + 2;
    if (lines.includes('A')) {
      s.poly([[SX.B, top + 4.5], [16.25, top + 4.5], [16.25, yc + 1.2], [SX.A - half, yc + 1.2]], { k: 'dash' });
      s.dot(SX.B, top + 4.5, 0.6);
    }
    if (lines.includes('B')) {
      s.poly([[SX.A, top + 2.5], [13.75, top + 2.5], [13.75, yc - 1.2], [SX.B + half, yc - 1.2]], { k: 'dash' });
      s.dot(SX.A, top + 2.5, 0.6);
    }
  } else if (kind === 'cbal') {
    for (const ln of lines) {
      const side = ln === 'A' ? 1 : -1;
      const core = new Sym();
      // 一次側（負荷）は下、弁側は上。内部パイロットは負荷側から
      pcvCore(core, { offset: true, pilot: 'in', side: -1, pilotLen: 1.6 });
      const sub = new Sym();
      sub.add(core, { rot: 180, flip: true });
      const [ty, by] = checkCore(sub, 9.5, 0, 'down');
      sub.poly([[0, -7.4], [9.5, -7.4], [9.5, ty]]);
      sub.poly([[9.5, by], [9.5, 7.4], [0, 7.4]]);
      sub.dot(0, -7.4, 0.7); sub.dot(0, 7.4, 0.7);
      sub.line(0, -9.5, 0, -5); sub.line(0, 5, 0, 9.5);
      s.add(sub, { x: SX[ln], y: mid, flip: side < 0, scale: MS });
      inline[ln] = [mid - 9.5 * MS, mid + 9.5 * MS];
    }
  }

  for (const ln of ['P', 'T', 'B', 'A']) {
    const cut = inline[ln];
    if (cut) { s.line(SX[ln], top, SX[ln], cut[0]); s.line(SX[ln], cut[1], SX[ln], bottom); }
    else s.line(SX[ln], top, SX[ln], bottom);
  }
  s.rect(-STACK_HALF, top, STACK_HALF * 2, h, { k: 'thin' });
}

gen('stack', (p, ctx) => {
  const s = new Sym();
  const layers = Array.isArray(p.layers) ? p.layers : [];
  const g = stackGeometry(layers);
  const style = ctx.cross || 'jump';

  layers.forEach((layer, i) => {
    drawLayer(s, layer, g.tops[i], g.heights[i], style);
    s.text(STACK_HALF - 1.2, g.tops[i] + 3.2, `-${i + 2}`, { size: 2.0, anchor: 'end' });
  });

  // 電磁弁
  const yd = g.dcvTop + DCV_ZONE / 2;
  const body = new Sym();
  dcv43Body(body, { center: p.center, actuation: 'sol', state: ctx.state, labels: false });
  s.add(body, { x: 0, y: yd, rot: 90, scale: MS });
  const off = 2.5 * MS, edge = 5 * MS, zoneBottom = g.dcvTop + DCV_ZONE;
  s.poly([[SX.P, zoneBottom], [SX.P, yd - off], [-edge, yd - off]]);
  s.poly([[SX.A, zoneBottom], [SX.A, yd - off], [edge, yd - off]]);
  s.poly([[SX.T, zoneBottom], [SX.T, yd + off], [-edge, yd + off]]);
  s.poly([[SX.B, zoneBottom], [SX.B, yd + off], [edge, yd + off]]);
  s.text(6.5, yd - 16.5, 'a', { size: 2.4, anchor: 'start' });
  s.text(6.5, yd + 18.2, 'b', { size: 2.4, anchor: 'start' });
  s.text(STACK_HALF - 1.2, g.dcvTop + 4, '-1', { size: 2.0, anchor: 'end' });

  // ベース
  for (const ln of ['P', 'T', 'B', 'A']) {
    s.line(SX[ln], -5, SX[ln], 0);
    s.port(ln, SX[ln], 0, 0, 1);
    s.text(SX[ln] + 1.3, -1.2, ln, { anchor: 'start' });
  }
  s.line(-STACK_HALF, -5, STACK_HALF, -5, 'thin');
  s.labelSide = 'top';
  return s;
});

// ---------------------------------------------------------------------------
// 外から使う関数
// ---------------------------------------------------------------------------
const cache = new Map();

/** 機器の図記号を作る。戻り値 { prims, ports, bbox, labelSide } は機器の原点まわりの座標 */
export function buildSymbol(typeDef, params, opts = {}) {
  const name = typeDef.symbol || typeDef.type;
  const fn = GEN[name];
  const p = { ...(typeDef.defaults || {}), ...(params || {}) };
  const key = `${typeDef.type}|${opts.state || ''}|${opts.cross || ''}|${JSON.stringify(symbolParams(typeDef, p))}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let s;
  if (fn) {
    s = fn(p, { state: opts.state || null, cross: opts.cross || 'jump', args: typeDef.symbolArgs || {}, typeDef });
  } else {
    s = new Sym();
    s.rect(-5, -5, 10, 10);
    s.text(0, 1, '?', { size: 4 });
    (typeDef.ports || []).forEach((name2, i) => s.port(name2, -5 + 5 * i, 7.5, 0, 1));
  }
  const out = { prims: s.prims, ports: s.ports, bbox: bboxOf(s.prims), labelSide: s.labelSide };
  if (cache.size > 600) cache.clear();
  cache.set(key, out);
  return out;
}

function symbolParams(typeDef, p) {
  const o = {};
  for (const d of typeDef.params || []) if (d.symbol) o[d.key] = p[d.key];
  return o;
}

export function hasSymbol(name) { return !!GEN[name]; }
