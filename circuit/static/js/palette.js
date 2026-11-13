// 左ペイン。機器ライブラリの一覧。ドラッグしてキャンバスに置く（クリックしてから置くこともできる）。
import { state } from './store.js';
import { buildSymbol, primsToSvg, textsToSvg } from './symbols.js';
import { beginPlace, endPlace, dropPlace, ghostMove, isPlacing } from './editor.js';
import { h } from './inspector.js';

function thumb(def) {
  const sym = buildSymbol(def, def.defaults, { state: null });
  const b = sym.bbox;
  const pad = 2.5;
  const w = b.x1 - b.x0 + pad * 2, hh = b.y1 - b.y0 + pad * 2;
  const { shapes, texts } = primsToSvg(sym.prims);
  return `<svg class="dw thumb" viewBox="${b.x0 - pad} ${b.y0 - pad} ${w} ${hh}" preserveAspectRatio="xMidYMid meet">${shapes}${textsToSvg(texts)}</svg>`;
}

export function initPalette(el) {
  const lib = state.lib;
  const search = h('input', { type: 'search', class: 'pal-search', placeholder: '機器を探す', spellcheck: 'false' });
  const list = h('div', { class: 'pal-list' });
  el.replaceChildren(h('div', { class: 'pal-head' }, h('div', { class: 'pane-title' }, '機器ライブラリ'), search), list);

  const items = [];
  for (const cat of lib.categories) {
    const defs = Object.values(lib.types).filter((t) => t.category === cat.id && !t.hidden);
    if (!defs.length) continue;
    const grid = h('div', { class: 'pal-grid' });
    const group = h('div', { class: 'pal-group' }, h('div', { class: 'pal-cat' }, cat.name), grid);
    for (const def of defs) {
      const item = h('button', { class: `pal-item${def.type === 'stack' ? ' wide' : ''}`, title: `${def.name}\n${def.en || ''}\n${def.jis || ''}`, 'data-type': def.type },
        h('span', { class: 'pal-sym', html: thumb(def) }), h('span', { class: 'pal-name' }, def.name));
      grid.append(item);
      items.push({ item, def, group });
    }
    list.append(group);
  }

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    const shown = new Set();
    for (const { item, def, group } of items) {
      const hit = !q || def.name.toLowerCase().includes(q) || (def.en || '').toLowerCase().includes(q) || def.type.includes(q);
      item.hidden = !hit;
      if (hit) shown.add(group);
    }
    for (const { group } of items) group.hidden = !shown.has(group);
  });
  search.addEventListener('keydown', (e) => e.stopPropagation());

  // ドラッグで置く。動かさずに離したときは「置くモード」のままにして、キャンバスのクリックで置く
  let dragFrom = null;
  list.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.pal-item');
    if (!item || e.button !== 0) return;
    e.preventDefault();
    if (isPlacing()) endPlace();
    dragFrom = { x: e.clientX, y: e.clientY, type: item.dataset.type, moved: false };
    beginPlace(item.dataset.type, true);
    list.querySelectorAll('.pal-item.active').forEach((q) => q.classList.remove('active'));
    item.classList.add('active');
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragFrom) return;
    if (Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) > 4) dragFrom.moved = true;
    ghostMove(e);
  });
  window.addEventListener('pointerup', (e) => {
    if (!dragFrom) return;
    const d = dragFrom;
    dragFrom = null;
    if (d.moved) {
      if (!dropPlace(e)) endPlace();
      list.querySelectorAll('.pal-item.active').forEach((q) => q.classList.remove('active'));
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') list.querySelectorAll('.pal-item.active').forEach((q) => q.classList.remove('active'));
  });
  document.getElementById('canvas').addEventListener('pointerdown', () => {
    setTimeout(() => { if (!isPlacing()) list.querySelectorAll('.pal-item.active').forEach((q) => q.classList.remove('active')); }, 0);
  });
}
