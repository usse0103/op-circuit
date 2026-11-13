// 配線の自動ルーティング。2.5 mm の格子の上で、直交する経路を A* で探す。
//  - 曲がりは少なく、機器の記号は避け、ほかの配線とは重ならないようにする
//  - ポートからは、まずポートの向きにまっすぐ出る

export const G = 2.5;

const TURN = 5;         // 曲がり 1 回の重さ（格子の歩数に換算）
const INSIDE = 60;      // 機器の記号の中を通る
const RING = 3;         // 機器のすぐ外側を通る
const OVERLAP = 14;     // ほかの配線に重なって走る
const CROSS = 2.5;      // ほかの配線を横切る
const CORNER_ON = 9;    // ほかの配線の上で曲がる（分岐と見まちがえる）

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

function dirIndex(dx, dy) {
  if (dx > 0) return 0;
  if (dy > 0) return 1;
  if (dx < 0) return 2;
  if (dy < 0) return 3;
  return -1;
}

class Heap {
  constructor() { this.f = []; this.v = []; }
  get size() { return this.f.length; }
  push(f, v) {
    const F = this.f, V = this.v;
    let i = F.length;
    F.push(f); V.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= f) break;
      F[i] = F[p]; V[i] = V[p];
      i = p;
    }
    F[i] = f; V[i] = v;
  }
  pop() {
    const F = this.f, V = this.v;
    const top = V[0];
    const f = F.pop(), v = V.pop();
    const n = F.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && F[c + 1] < F[c]) c++;
        if (F[c] >= f) break;
        F[i] = F[c]; V[i] = V[c];
        i = c;
      }
      F[i] = f; V[i] = v;
    }
    return top;
  }
}

export class Router {
  /** bounds: 配線してよい範囲 {x0, y0, x1, y1}（mm） */
  constructor(bounds) {
    this.ox = Math.floor(bounds.x0 / G) * G;
    this.oy = Math.floor(bounds.y0 / G) * G;
    this.W = Math.ceil((bounds.x1 - this.ox) / G) + 1;
    this.H = Math.ceil((bounds.y1 - this.oy) / G) + 1;
    const n = this.W * this.H;
    this.obs = new Float32Array(n);
    this.occH = new Uint8Array(n);
    this.occV = new Uint8Array(n);
    this.g = new Float32Array(n * 4);
    this.stamp = new Uint32Array(n * 4);
    this.parent = new Int32Array(n * 4);
    this.gen = 0;
  }

  gx(x) { return Math.max(0, Math.min(this.W - 1, Math.round((x - this.ox) / G))); }
  gy(y) { return Math.max(0, Math.min(this.H - 1, Math.round((y - this.oy) / G))); }

  /** 機器の外形を障害物として登録する */
  setObstacles(rects) {
    this.obs.fill(0);
    const { W, H, obs } = this;
    for (const r of rects) {
      const ax0 = Math.max(0, Math.ceil((r.x0 - G - this.ox) / G - 1e-6));
      const ax1 = Math.min(W - 1, Math.floor((r.x1 + G - this.ox) / G + 1e-6));
      const ay0 = Math.max(0, Math.ceil((r.y0 - G - this.oy) / G - 1e-6));
      const ay1 = Math.min(H - 1, Math.floor((r.y1 + G - this.oy) / G + 1e-6));
      for (let y = ay0; y <= ay1; y++) {
        const py = this.oy + y * G;
        for (let x = ax0; x <= ax1; x++) {
          const px = this.ox + x * G;
          const inside = px > r.x0 + 0.1 && px < r.x1 - 0.1 && py > r.y0 + 0.1 && py < r.y1 - 0.1;
          const i = y * W + x;
          const pen = inside ? INSIDE : RING;
          if (pen > obs[i]) obs[i] = pen;
        }
      }
    }
  }

  clearWires() { this.occH.fill(0); this.occV.fill(0); }

  snapshot() { return { h: this.occH.slice(), v: this.occV.slice() }; }
  restore(s) { this.occH.set(s.h); this.occV.set(s.v); }

  /** 経路を占有として登録する。端点のセルは共有できるよう登録しない */
  addWire(pts) {
    const { W } = this;
    for (let i = 0; i + 1 < pts.length; i++) {
      const x0 = this.gx(pts[i][0]), y0 = this.gy(pts[i][1]);
      const x1 = this.gx(pts[i + 1][0]), y1 = this.gy(pts[i + 1][1]);
      const first = i === 0, last = i + 2 === pts.length;
      if (y0 === y1) {
        const a = Math.min(x0, x1), b = Math.max(x0, x1);
        for (let x = a; x <= b; x++) {
          if ((first && x === x0) || (last && x === x1)) continue;
          this.occH[y0 * W + x] = 1;
        }
      } else if (x0 === x1) {
        const a = Math.min(y0, y1), b = Math.max(y0, y1);
        for (let y = a; y <= b; y++) {
          if ((first && y === y0) || (last && y === y1)) continue;
          this.occV[y * W + x0] = 1;
        }
      }
    }
  }

  /** a, b: {x, y, dx, dy}。dx = dy = 0 は向きなし（分岐点）。戻り値は [[x, y], …] */
  route(a, b) {
    const { W, H } = this;
    const ax = this.gx(a.x), ay = this.gy(a.y), bx = this.gx(b.x), by = this.gy(b.y);
    const da = dirIndex(a.dx, a.dy), db = dirIndex(b.dx, b.dy);
    if (ax === bx && ay === by) return [[a.x, a.y], [b.x, b.y]];

    // 始点・終点は、ポートの向きに 1 歩出た所
    let sx = ax, sy = ay, tx = bx, ty = by;
    if (da >= 0) { sx = ax + DX[da]; sy = ay + DY[da]; }
    if (db >= 0) { tx = bx + DX[db]; ty = by + DY[db]; }
    const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
    if (!inb(sx, sy)) { sx = ax; sy = ay; }
    if (!inb(tx, ty)) { tx = bx; ty = by; }
    const wantEnd = db >= 0 ? (db + 2) % 4 : -1;     // 終点に入る向き

    const pad = 28;
    const wx0 = Math.max(0, Math.min(sx, tx) - pad), wx1 = Math.min(W - 1, Math.max(sx, tx) + pad);
    const wy0 = Math.max(0, Math.min(sy, ty) - pad), wy1 = Math.min(H - 1, Math.max(sy, ty) + pad);

    this.gen++;
    const gen = this.gen;
    const { g, stamp, parent, obs, occH, occV } = this;
    const heap = new Heap();
    const hfn = (x, y) => Math.abs(x - tx) + Math.abs(y - ty);
    const visit = (x, y, d, cost, from) => {
      const idx = (y * W + x) * 4 + d;
      if (stamp[idx] === gen && g[idx] <= cost) return;
      stamp[idx] = gen; g[idx] = cost; parent[idx] = from;
      heap.push(cost + hfn(x, y), idx);
    };
    if (da >= 0) visit(sx, sy, da, 0, -1);
    else for (let d = 0; d < 4; d++) visit(sx, sy, d, 0, -1);

    let goal = -1, goalCost = Infinity;
    while (heap.size) {
      const idx = heap.pop();
      const cost = g[idx];
      if (cost >= goalCost) break;
      const d = idx & 3;
      const cell = idx >> 2;
      const x = cell % W, y = (cell - x) / W;
      if (x === tx && y === ty) {
        const total = cost + (wantEnd >= 0 && d !== wantEnd ? TURN : 0);
        if (total < goalCost) { goalCost = total; goal = idx; }
        continue;
      }
      const occHere = occH[cell] | occV[cell];
      for (let nd = 0; nd < 4; nd++) {
        if (nd === ((d + 2) & 3)) continue;
        const nx = x + DX[nd], ny = y + DY[nd];
        if (nx < wx0 || nx > wx1 || ny < wy0 || ny > wy1) continue;
        const nc = ny * W + nx;
        let step = 1 + obs[nc];
        if (nd !== d) step += TURN + (occHere ? CORNER_ON : 0);
        const horizontal = (nd & 1) === 0;
        if (horizontal) {
          if (occH[nc]) step += OVERLAP;
          else if (occV[nc]) step += CROSS;
        } else {
          if (occV[nc]) step += OVERLAP;
          else if (occH[nc]) step += CROSS;
        }
        visit(nx, ny, nd, cost + step, idx);
      }
    }

    const cells = [];
    if (goal < 0) {
      cells.push([sx, sy], [tx, sy], [tx, ty]);       // 見つからないときは L 字
    } else {
      for (let i = goal; i >= 0; i = parent[i]) {
        const cell = i >> 2;
        const x = cell % W;
        cells.push([x, (cell - x) / W]);
      }
      cells.reverse();
    }
    const pts = [[a.x, a.y]];
    for (const [x, y] of cells) pts.push([this.ox + x * G, this.oy + y * G]);
    pts.push([b.x, b.y]);
    return simplify(pts);
  }
}

/** 同じ点と、一直線上の中間点を取り除く */
export function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const n = out.length;
    if (n && Math.abs(out[n - 1][0] - p[0]) < 1e-6 && Math.abs(out[n - 1][1] - p[1]) < 1e-6) continue;
    if (n >= 2) {
      const a = out[n - 2], b = out[n - 1];
      const col = (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(b[0] - p[0]) < 1e-6)
        || (Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(b[1] - p[1]) < 1e-6);
      if (col) { out[n - 1] = [p[0], p[1]]; continue; }
    }
    out.push([p[0], p[1]]);
  }
  return out;
}

/** 経路を直交にそろえる（手で動かした経路の端点が動いたとき用）。直せなければ null */
export function stretch(pts, a, b) {
  if (!pts || pts.length < 4) return null;
  const out = pts.map((p) => [p[0], p[1]]);
  const fix = (i0, i1, end) => {
    const vertical = Math.abs(out[i0][0] - out[i1][0]) < 1e-6;
    out[i0] = [end.x, end.y];
    if (vertical) out[i1][0] = end.x; else out[i1][1] = end.y;
  };
  fix(0, 1, a);
  fix(out.length - 1, out.length - 2, b);
  for (let i = 0; i + 1 < out.length; i++) {
    const dx = Math.abs(out[i][0] - out[i + 1][0]), dy = Math.abs(out[i][1] - out[i + 1][1]);
    if (dx > 1e-6 && dy > 1e-6) return null;
  }
  return simplify(out);
}

/** 全配線の交差を調べ、横線が縦線を飛び越える位置を返す: Map(配線 id → [{seg, x}]) */
export function findCrossings(routes) {
  const vert = [];
  for (const [id, pts] of routes) {
    for (let i = 0; i + 1 < pts.length; i++) {
      if (Math.abs(pts[i][0] - pts[i + 1][0]) < 1e-6 && Math.abs(pts[i][1] - pts[i + 1][1]) > 1e-6) {
        vert.push({ id, x: pts[i][0], y0: Math.min(pts[i][1], pts[i + 1][1]), y1: Math.max(pts[i][1], pts[i + 1][1]) });
      }
    }
  }
  const out = new Map();
  for (const [id, pts] of routes) {
    const list = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      if (Math.abs(pts[i][1] - pts[i + 1][1]) > 1e-6) continue;
      const y = pts[i][1];
      const x0 = Math.min(pts[i][0], pts[i + 1][0]), x1 = Math.max(pts[i][0], pts[i + 1][0]);
      for (const v of vert) {
        if (v.x > x0 + 0.01 && v.x < x1 - 0.01 && y > v.y0 + 0.01 && y < v.y1 - 0.01) list.push({ seg: i, x: v.x });
      }
    }
    if (list.length) out.set(id, list);
  }
  return out;
}

/** 経路を SVG の path にする。crossings があれば、その位置を半円で飛び越える */
export function pathD(pts, crossings, radius = 1.25) {
  if (!pts.length) return '';
  const f = (v) => Math.round(v * 1000) / 1000;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const xs = crossings ? crossings.filter((c) => c.seg === i).map((c) => c.x) : [];
    if (xs.length && Math.abs(y0 - y1) < 1e-6) {
      const dir = x1 > x0 ? 1 : -1;
      xs.sort((p, q) => (p - q) * dir);
      let last = -Infinity;
      for (const x of xs) {
        if (Math.abs(x - last) < radius * 2.1) continue;     // 近すぎる交差はまとめる
        if (Math.abs(x - x0) < radius + 0.2 || Math.abs(x - x1) < radius + 0.2) continue;
        d += `L${f(x - dir * radius)} ${f(y0)}A${radius} ${radius} 0 0 ${dir > 0 ? 1 : 0} ${f(x + dir * radius)} ${f(y0)}`;
        last = x;
      }
    }
    d += `L${f(x1)} ${f(y1)}`;
  }
  return d;
}

/** 経路の長さと、いちばん長い線分（ラベルを置く場所） */
export function longestSegment(pts) {
  let best = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.abs(pts[i][0] - pts[i + 1][0]) + Math.abs(pts[i][1] - pts[i + 1][1]);
    if (!best || len > best.len) {
      best = {
        len, i,
        x: (pts[i][0] + pts[i + 1][0]) / 2, y: (pts[i][1] + pts[i + 1][1]) / 2,
        horizontal: Math.abs(pts[i][1] - pts[i + 1][1]) < 1e-6,
        dx: Math.sign(pts[i + 1][0] - pts[i][0]), dy: Math.sign(pts[i + 1][1] - pts[i][1]),
      };
    }
  }
  return best;
}

/** 点 (x, y) にいちばん近い経路上の点 */
export function nearestOnPath(pts, x, y) {
  let best = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const px = Math.max(Math.min(x0, x1), Math.min(Math.max(x0, x1), x));
    const py = Math.max(Math.min(y0, y1), Math.min(Math.max(y0, y1), y));
    const d = Math.hypot(px - x, py - y);
    if (!best || d < best.d) best = { d, x: px, y: py, seg: i, horizontal: Math.abs(y0 - y1) < 1e-6 };
  }
  return best;
}
