// 図面用紙: 図枠・表題欄・機器表・注記。図面と同じ SVG の中に mm 単位で描く。
import { state, SHEETS, typeDef, paramsOf, specText } from './store.js';
import { esc } from './symbols.js';

export const MARGIN = 10;     // 用紙の端から図枠まで

export function sheetSize(doc = state.doc) {
  return SHEETS[doc.meta.sheet] || SHEETS.A3;
}

/** 文字のおおよその幅（mm）。全角は 1、半角は 0.55 文字ぶん */
export function textWidth(str, size) {
  let n = 0;
  for (const ch of String(str)) n += ch.charCodeAt(0) > 0x2e80 ? 1.0 : 0.56;
  return n * size;
}

/** 幅に収まるように末尾を省く */
export function fitText(str, width, size) {
  const s = String(str ?? '');
  if (textWidth(s, size) <= width) return s;
  let out = '';
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > width) break;
    out += ch;
  }
  return out + '…';
}

function naturalKey(tag) {
  const m = /^(.*?)(\d+)$/.exec(tag || '');
  return m ? [m[1], parseInt(m[2], 10)] : [tag || '~', 0];
}

export function layerTitle(def, layer) {
  const kinds = (def && def.layerKinds) || [];
  const k = kinds.find((q) => q.kind === layer.kind);
  const name = k ? k.name : layer.kind;
  const line = layer.line === 'AB' ? 'A・B' : layer.line;
  if (layer.kind === 'tcheck') {
    return `${name}（${line} ライン・${(layer.mode || 'out') === 'out' ? 'メータアウト' : 'メータイン'}）`;
  }
  if (layer.kind === 'reducing') return `${name}（P ライン・${line} パイロット）`;
  return `${name}（${line} ライン）`;
}

function layerSpec(def, layer) {
  const k = ((def && def.layerKinds) || []).find((q) => q.kind === layer.kind);
  if (!k) return '';
  return k.fields.map((f) => `${f.label} ${layer[f.key] ?? f.default}${f.unit ? ' ' + f.unit : ''}`).join(' / ');
}

/** 機器表の行。積層弁スタックは、電磁弁と各段を別の行にする */
export function bomRows(doc = state.doc) {
  const rows = [];
  for (const c of doc.components) {
    const def = typeDef(c.type);
    if (!def || def.bom === false) continue;
    const p = paramsOf(c);
    const base = { id: c.id, tag: c.tag || '', maker: p.maker || '', note: p.note || '' };
    if (c.type === 'stack') {
      const centerOpt = def.params.find((q) => q.key === 'center').options.find((o) => o.value === p.center);
      rows.push({ ...base, tag: `${c.tag}-1`, name: '電磁切換弁（4 ポート 3 位置）', model: p.model_code || '',
        spec: `呼び ${p.size} / ${centerOpt ? centerOpt.label : ''}` });
      (p.layers || []).forEach((layer, i) => {
        rows.push({ ...base, tag: `${c.tag}-${i + 2}`, name: layerTitle(def, layer), model: layer.model_code || '',
          spec: layerSpec(def, layer), note: '' });
      });
    } else {
      rows.push({ ...base, name: def.name, model: p.model_code || '', spec: specText(c) });
    }
  }
  rows.sort((a, b) => {
    const ka = naturalKey(a.tag.split('-')[0]), kb = naturalKey(b.tag.split('-')[0]);
    if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return a.tag < b.tag ? -1 : (a.tag > b.tag ? 1 : 0);
  });
  return rows;
}

function cell(x, y, w, h, label, value, opt = {}) {
  const size = opt.size || 3;
  const v = fitText(value || '', w - 3, size);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="tb-line"/>`
    + `<text x="${x + 1.2}" y="${y + 2.6}" font-size="1.8" class="tb-label">${esc(label)}</text>`
    + `<text x="${x + (opt.center ? w / 2 : 2)}" y="${y + h - (h - size) / 2 + 0.3 + (opt.dy || 0)}" font-size="${size}"`
    + ` text-anchor="${opt.center ? 'middle' : 'start'}" class="tb-value${opt.bold ? ' tb-bold' : ''}">${esc(v)}</text>`;
}

/** 図枠・表題欄・機器表の SVG。戻り値 { svg, drawArea } */
export function renderSheet(doc = state.doc, opts = {}) {
  const { w, h } = sheetSize(doc);
  const m = doc.meta;
  const fx0 = MARGIN, fy0 = MARGIN, fx1 = w - MARGIN, fy1 = h - MARGIN;
  let s = '';
  s += `<rect x="0" y="0" width="${w}" height="${h}" class="paper"/>`;
  s += `<rect x="${fx0}" y="${fy0}" width="${fx1 - fx0}" height="${fy1 - fy0}" class="frame"/>`;
  // 中心マーク
  const cm = 5;
  s += `<path class="center-mark" d="M${w / 2} 0V${fy0 + cm}M${w / 2} ${h}V${fy1 - cm}M0 ${h / 2}H${fx0 + cm}M${w} ${h / 2}H${fx1 - cm}"/>`;

  // 表題欄
  const tw = Math.min(180, (fx1 - fx0) * 0.62);
  const k = tw / 180;
  const th = 28;
  const tx = fx1 - tw, ty = fy1 - th;
  s += `<g class="titleblock">`;
  s += `<rect x="${tx}" y="${ty}" width="${tw}" height="${th}" class="tb-bg"/>`;
  s += cell(tx, ty, 110 * k, 12, '名称', m.title, { size: 5, bold: true, dy: -0.4 });
  s += cell(tx + 110 * k, ty, 70 * k, 12, '図番', m.drawingNo, { size: 4.2, bold: true, dy: -0.4 });
  s += cell(tx, ty + 12, 60 * k, 8, '案件', m.project);
  s += cell(tx + 60 * k, ty + 12, 50 * k, 8, '客先', m.customer);
  s += cell(tx + 110 * k, ty + 12, 25 * k, 8, '尺度', m.scale || 'NTS', { center: true });
  s += cell(tx + 135 * k, ty + 12, 25 * k, 8, '用紙', doc.meta.sheet, { center: true });
  s += cell(tx + 160 * k, ty + 12, 20 * k, 8, '改訂', m.rev, { center: true });
  s += cell(tx, ty + 20, 37 * k, 8, '設計', m.author);
  s += cell(tx + 37 * k, ty + 20, 37 * k, 8, '検図', m.checker);
  s += cell(tx + 74 * k, ty + 20, 36 * k, 8, '承認', m.approver);
  s += cell(tx + 110 * k, ty + 20, 35 * k, 8, '日付', m.date, { center: true });
  s += cell(tx + 145 * k, ty + 20, 35 * k, 8, '図記号', 'JIS B 0125', { size: 2.6, center: true });
  s += `<rect x="${tx}" y="${ty}" width="${tw}" height="${th}" class="tb-outer"/>`;
  s += `</g>`;

  // 機器表
  let bomTop = ty;
  if (m.showBom !== false) {
    const rows = bomRows(doc);
    if (rows.length) {
      const rh = 4.6, hh = 5.2;
      const cols = [
        { key: 'tag', label: '番号', w: 17 }, { key: 'name', label: '名称', w: 45 },
        { key: 'model', label: '形式', w: 38 }, { key: 'spec', label: '仕様', w: 50 },
        { key: 'maker', label: 'メーカー', w: 16 }, { key: 'note', label: '備考', w: 14 },
      ];
      const maxRows = Math.max(0, Math.floor((ty - fy0 - 30 - hh) / rh));
      const shown = rows.slice(0, maxRows);
      const bh = hh + shown.length * rh + (rows.length > shown.length ? rh : 0);
      const by = ty - bh;
      bomTop = by;
      s += `<g class="bom">`;
      s += `<rect x="${tx}" y="${by}" width="${tw}" height="${bh}" class="tb-bg"/>`;
      let x = tx;
      for (const c of cols) {
        const cw = c.w * k;
        s += `<rect x="${x}" y="${by}" width="${cw}" height="${bh}" class="tb-line"/>`;
        s += `<text x="${x + cw / 2}" y="${by + 3.7}" font-size="2.3" text-anchor="middle" class="tb-label2">${c.label}</text>`;
        shown.forEach((r, i) => {
          const yy = by + hh + i * rh;
          s += `<text x="${x + 1.2}" y="${yy + 3.3}" font-size="2.3" class="tb-value" data-bom="${esc(r.id)}">${esc(fitText(r[c.key] || '', cw - 2, 2.3))}</text>`;
        });
        x += cw;
      }
      s += `<path class="tb-line" d="M${tx} ${by + hh}H${tx + tw}"/>`;
      for (let i = 1; i < shown.length; i++) {
        s += `<path class="tb-hair" d="M${tx} ${by + hh + i * rh}H${tx + tw}"/>`;
      }
      if (rows.length > shown.length) {
        s += `<text x="${tx + 2}" y="${by + bh - 1.3}" font-size="2.2" class="tb-label2">ほか ${rows.length - shown.length} 点は計算書の機器表を参照</text>`;
      }
      s += `<rect x="${tx}" y="${by}" width="${tw}" height="${bh}" class="tb-outer"/>`;
      s += `</g>`;
    }
  }

  // 凡例と注記（左下）
  const lx = fx0 + 3;
  let ly = fy1 - 3;
  const notes = String(m.notes || '').split(/\r?\n/).filter((t) => t.trim());
  const fluid = (state.lib && state.lib.standards.fluids.find((f) => f.id === doc.settings.fluid)) || { name: doc.settings.fluid };
  const lines = [];
  lines.push({ legend: true });
  lines.push({ text: `作動油: ${fluid.name}　タンク油量: ${doc.settings.tankVolume} L` });
  notes.forEach((t, i) => lines.push({ text: `${i + 1}. ${t}` }));
  const maxW = tx - fx0 - 8;
  s += `<g class="notes">`;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (ln.legend) {
      s += `<g transform="translate(${lx},${ly - 1})">`
        + `<line x1="0" y1="0" x2="9" y2="0" class="wire"/><text x="10.5" y="0.9" font-size="2.3">主管路</text>`
        + `<line x1="24" y1="0" x2="33" y2="0" class="wire pilot"/><text x="34.5" y="0.9" font-size="2.3">パイロット管路</text>`
        + `<line x1="56" y1="0" x2="65" y2="0" class="wire drain"/><text x="66.5" y="0.9" font-size="2.3">ドレン管路</text>`
        + `<line x1="82" y1="0" x2="91" y2="0" class="s-chain"/><text x="92.5" y="0.9" font-size="2.3">包囲線</text>`
        + `</g>`;
    } else {
      s += `<text x="${lx}" y="${ly}" font-size="2.5">${esc(fitText(ln.text, maxW, 2.5))}</text>`;
    }
    ly -= 4;
  }
  if (notes.length) s += `<text x="${lx}" y="${ly}" font-size="2.5" class="tb-bold">注記</text>`;
  s += `</g>`;

  return {
    svg: s,
    drawArea: { x0: fx0, y0: fy0, x1: fx1, y1: fy1 },
    titleBlock: { x0: tx, y0: bomTop, x1: fx1, y1: fy1 },
    opts,
  };
}
