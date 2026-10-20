// Compare view: 2–4 images, swipe or side-by-side with synced zoom/pan, plus prompt/param diff.
import { $, h, icon, clamp, pad } from '../util.js';
import { t, getLang } from '../i18n.js';
import { modelById } from '../data.js';
import { lookup, norm, pretty } from '../tagdb.js';
import { segment } from './inspector.js';
import { on } from '../store.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const MAX = 4;
const cmp = { ids: [], active: 1, mode: 'side', live: false, view: { s: 1, x: 0, y: 0 } };
let deps = null; // { get(id), urlFor(rec), onChange(ids), latestId() }
let root = null;

export const compareOpen = () => !!root;
export const compareIds = () => (root ? cmp.ids.slice() : []);

export function initCompare(d) {
  deps = d;
  on('settings.lang', () => { if (root) void render(); });
}

export async function openCompare(ids) {
  cmp.ids = [...new Set(ids)].slice(0, MAX);
  cmp.active = Math.min(cmp.ids.length, MAX - 1);
  cmp.view = { s: 1, x: 0, y: 0 };
  if (!root) {
    root = h('div', { class: 'cmp-view' });
    $('#stage').append(root);
    document.addEventListener('keydown', onKey, true);
  }
  await render();
}

export function closeCompare() {
  if (!root) return;
  root.remove();
  root = null;
  document.removeEventListener('keydown', onKey, true);
  deps.onChange([]);
}

export async function addToCompare(id) {
  if (!root) return openCompare([deps.currentId() || id, id].filter((x, i, a) => a.indexOf(x) === i));
  const at = cmp.ids.indexOf(id);
  if (at >= 0) {
    if (cmp.ids.length > 1) cmp.ids.splice(at, 1);
  } else if (cmp.ids.length < MAX) cmp.ids.push(id);
  else cmp.ids[cmp.active] = id;
  cmp.active = Math.min(cmp.active, cmp.ids.length - 1);
  await render();
}

// Plain archive click while comparing: put the image into the active slot.
export async function placeInActive(id) {
  if (!root) return;
  if (cmp.ids.length < 2) cmp.ids.push(id);
  else cmp.ids[cmp.active] = id;
  await render();
}

// A new image finished: the "live" slot follows it.
export async function onNewImage(id) {
  if (!root || !cmp.live) return;
  if (cmp.ids.length < 2) cmp.ids.push(id);
  else cmp.ids[cmp.ids.length - 1] = id;
  await render();
}

function onKey(e) {
  if (e.key === 'Escape' && !document.querySelector('.modal-bg, .lightbox')) {
    e.stopPropagation();
    closeCompare();
  }
}

// ---------------------------------------------------------------- render
async function render() {
  const zh = getLang() === 'zh';
  const recs = (await Promise.all(cmp.ids.map((id) => deps.get(id)))).filter(Boolean);
  cmp.ids = recs.map((r) => r.id);
  deps.onChange(cmp.ids);
  if (!root) return;

  const slots = recs.map((r, i) =>
    h(
      'button',
      {
        class: 'cmp-slot' + (i === cmp.active ? ' on' : ''),
        title: () => ((getLang() === 'zh') ? '点击设为当前槽位：之后点历史图像会放入此槽' : 'Make active: archive clicks fill this slot'),
        onclick: () => ((cmp.active = i), render()),
      },
      h('i', {}, LETTERS[i]),
      h('img', { src: deps.urlFor(r), alt: '' }),
      h('span', { class: 'mono' }, '№' + pad(r.no || 0, 4)),
      cmp.live && i === recs.length - 1 && i > 0 ? h('em', { class: 'mono' }, () => (t('copy.ui.compare.1'))) : null,
      recs.length > 1
        ? h('b', { class: 'x', title: () => ((getLang() === 'zh') ? '移出对比' : 'Remove'), onclick: (e) => (e.stopPropagation(), cmp.ids.splice(i, 1), (cmp.active = Math.min(cmp.active, cmp.ids.length - 1)), render()) }, '×')
        : null
    )
  );
  const modeSeg = h(
    'div',
    { class: 'seg' },
    ...[
      ['side', (getLang() === 'zh') ? '并排' : 'SIDE'],
      ['swipe', (getLang() === 'zh') ? '滑动' : 'SWIPE'],
    ].map(([m, l]) => h('button', { class: cmp.mode === m ? 'on' : '', disabled: m === 'swipe' && recs.length < 2, onclick: () => ((cmp.mode = m), render()) }, l))
  );
  const liveCk = h('input', { type: 'checkbox', checked: cmp.live });
  liveCk.onchange = async () => {
    cmp.live = liveCk.checked;
    const latest = deps.latestId();
    if (cmp.live && latest && !cmp.ids.includes(latest)) await onNewImage(latest);
    else render();
  };
  const head = h(
    'div',
    { class: 'cmp-head' },
    h('span', { class: 'cmp-t' }, () => (t('copy.ui.compare.0'))),
    h('div', { class: 'cmp-slots' }, ...slots, recs.length < MAX ? h('span', { class: 'cmp-hint mono' }, () => ((getLang() === 'zh') ? '点击历史图像放入当前槽位 · 右键「加入对比」新增' : 'Click archive to fill the slot · right-click → Add to compare')) : null),
    h('span', { class: 'sp' }),
    h('label', { class: 'tgl', title: () => ((getLang() === 'zh') ? '最后一个槽位自动显示最新生成的图像（配合自动生成，边改 tag 边对比）' : 'Last slot shows the newest image as it arrives') }, liveCk, h('span', { class: 'sw' }), h('span', { class: 'cn' }, () => ((getLang() === 'zh') ? '末位跟随最新' : 'Last = latest'))),
    modeSeg,
    recs.length === 2 ? h('button', { class: 'btn sm sq', title: () => ((getLang() === 'zh') ? '交换 A / B' : 'Swap A/B'), onclick: () => (cmp.ids.reverse(), render()) }, icon('swap')) : null,
    h('button', { class: 'btn sm sq', title: () => ((getLang() === 'zh') ? '重置缩放' : 'Reset zoom'), onclick: () => ((cmp.view = { s: 1, x: 0, y: 0 }), applyView()) }, icon('expand')),
    h('button', { class: 'btn sm sq', title: () => ((getLang() === 'zh') ? '关闭对比 (Esc)' : 'Close (Esc)'), onclick: closeCompare }, icon('close'))
  );

  const body = cmp.mode === 'swipe' && recs.length >= 2 ? swipeBody(recs) : sideBody(recs);
  root.replaceChildren(head, body, diffPanel(recs, zh));
  applyView();
}

function paneImg(rec) {
  return h('img', { class: 'zimg', src: deps.urlFor(rec), alt: '', draggable: false });
}

function sideBody(recs) {
  const grid = h('div', { class: 'cmp-side', style: { '--n': recs.length } });
  recs.forEach((r, i) => {
    const pane = h(
      'div',
      { class: 'cmp-pane' + (i === cmp.active ? ' on' : '') },
      h('div', { class: 'zwrap' }, paneImg(r)),
      h('span', { class: 'cmp-lab mono' }, h('i', {}, LETTERS[i]), `№${pad(r.no || 0, 4)} · ${r.seed ?? '—'} · ${r.width}×${r.height}`)
    );
    bindZoom(pane);
    grid.append(pane);
  });
  return grid;
}

function swipeBody(recs) {
  const [a, b] = recs;
  const box = h('div', { class: 'cmp-swipe', style: { '--x': '50%' } });
  const stack = h(
    'div',
    { class: 'zwrap' },
    paneImg(a),
    h('img', { class: 'zimg after', src: deps.urlFor(b), alt: '', draggable: false })
  );
  const bar = h('div', { class: 'bar' }, h('span', { class: 'mono' }, 'A ⇆ B'));
  box.append(stack, bar, h('span', { class: 'cmp-lab mono l' }, h('i', {}, 'A'), '№' + pad(a.no || 0, 4)), h('span', { class: 'cmp-lab mono r' }, h('i', {}, 'B'), '№' + pad(b.no || 0, 4)));
  let dragging = false;
  const move = (e) => {
    const r = box.getBoundingClientRect();
    box.style.setProperty('--x', clamp(((e.clientX - r.left) / r.width) * 100, 0, 100) + '%');
  };
  bar.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    dragging = true;
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', (e) => dragging && move(e));
  bar.addEventListener('pointerup', () => (dragging = false));
  box.addEventListener('mousemove', (e) => e.altKey && move(e));
  bindZoom(box);
  return box;
}

// Synced wheel-zoom / drag-pan for every pane (shared normalized view).
function bindZoom(el) {
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left - r.width / 2) / r.width;
      const py = (e.clientY - r.top - r.height / 2) / r.height;
      const v = cmp.view;
      const ns = clamp(v.s * (e.deltaY < 0 ? 1.18 : 1 / 1.18), 1, 12);
      const k = ns / v.s;
      v.x = px - (px - v.x) * k;
      v.y = py - (py - v.y) * k;
      v.s = ns;
      if (ns === 1) v.x = v.y = 0;
      applyView();
    },
    { passive: false }
  );
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.bar, button')) return;
    const r = el.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, vx: cmp.view.x, vy: cmp.view.y, w: r.width, h: r.height };
    el.setPointerCapture(e.pointerId);
    el.classList.add('grabbing');
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    cmp.view.x = start.vx + (e.clientX - start.x) / start.w;
    cmp.view.y = start.vy + (e.clientY - start.y) / start.h;
    applyView();
  });
  const end = () => {
    start = null;
    el.classList.remove('grabbing');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => ((cmp.view = { s: 1, x: 0, y: 0 }), applyView()));
}

function applyView() {
  if (!root) return;
  const { s, x, y } = cmp.view;
  for (const w of root.querySelectorAll('.zwrap')) w.style.transform = `translate(${x * 100}%, ${y * 100}%) scale(${s})`;
  const z = root.querySelector('.cmp-zoom');
  if (z) z.textContent = Math.round(s * 100) + '%';
}

// ---------------------------------------------------------------- diff
function tagSet(text) {
  const m = new Map();
  for (const seg of segment(text || '')) {
    let key = norm(seg.text);
    if (seg.weight != null) key += '@' + seg.weight;
    else if (seg.ups || seg.dns) key += '@' + (seg.ups ? '{' + seg.ups + '}' : '[' + seg.dns + ']');
    m.set(key, seg);
  }
  return m;
}

function tagChip(key, seg, kind) {
  const base = key.split('@')[0];
  const w = key.includes('@') ? key.split('@')[1] : '';
  const e = lookup(base);
  return h('span', { class: 'dtag ' + kind }, kind === 'add' ? '+' : '−', h('b', {}, pretty(base)), w ? h('em', {}, w.startsWith('{') || w.startsWith('[') ? w : '×' + w) : null, e?.zh ? h('i', {}, e.zh) : null);
}

export function diffRow(label, a, b) {
  const A = tagSet(a);
  const B = tagSet(b);
  const add = [...B].filter(([k]) => !A.has(k));
  const rem = [...A].filter(([k]) => !B.has(k));
  if (!add.length && !rem.length) return null;
  return h('div', { class: 'drow' }, h('span', { class: 'dl mono' }, label), h('div', { class: 'dtags' }, ...add.map(([k, s]) => tagChip(k, s, 'add')), ...rem.map(([k, s]) => tagChip(k, s, 'rem'))));
}

function paramDiff(a, b, zh) {
  const pa = a.params || {};
  const pb = b.params || {};
  const fields = [
    [(getLang() === 'zh') ? '模型' : 'Model', (r) => modelById(r.model || r.params?.model).short],
    [(getLang() === 'zh') ? '尺寸' : 'Size', (r) => `${r.width}×${r.height}`],
    [(getLang() === 'zh') ? '种子' : 'Seed', (r) => r.seed ?? '—'],
    [(getLang() === 'zh') ? '步数' : 'Steps', (r, p) => p.steps],
    ['CFG', (r, p) => p.scale],
    [(getLang() === 'zh') ? '重缩放' : 'Rescale', (r, p) => p.cfgRescale],
    [(getLang() === 'zh') ? '采样器' : 'Sampler', (r, p) => (p.sampler || '').replace(/^k_/, '')],
    [(getLang() === 'zh') ? '负面预设' : 'UC preset', (r, p) => p.ucPreset],
    [(getLang() === 'zh') ? '质量标签' : 'Quality', (r, p) => (p.qualityToggle ? 'ON' : 'OFF')],
    ['Variety+', (r, p) => (p.variety ? 'ON' : 'OFF')],
    [(getLang() === 'zh') ? '类型' : 'Kind', (r) => r.kind],
  ];
  const out = [];
  for (const [label, f] of fields) {
    const va = f(a, pa);
    const vb = f(b, pb);
    if (String(va) !== String(vb)) out.push(h('span', { class: 'pd' }, h('i', {}, label), h('s', {}, String(va ?? '—')), ' → ', h('b', {}, String(vb ?? '—'))));
  }
  return out;
}

function diffPanel(recs, zh) {
  const box = h('div', { class: 'cmp-diff' });
  if (recs.length < 2) {
    box.append(h('p', { class: 'hint' }, () => ((getLang() === 'zh') ? '再选择至少一张图像进行对比：点击右侧历史图像（放入当前槽位），或右键「加入对比」新增槽位。' : 'Pick at least one more image: click the archive, or right-click → Add to compare.')));
    return box;
  }
  const a = recs[0];
  for (let i = 1; i < recs.length; i++) {
    const b = recs[i];
    const rows = [];
    const pa = a.params || {};
    const pb = b.params || {};
    rows.push(diffRow((getLang() === 'zh') ? '提示词' : 'Prompt', pa.prompt, pb.prompt));
    rows.push(diffRow((getLang() === 'zh') ? '负面' : 'UC', pa.uc, pb.uc));
    const ca = pa.characters || [];
    const cb = pb.characters || [];
    for (let k = 0; k < Math.max(ca.length, cb.length); k++) {
      rows.push(diffRow(((getLang() === 'zh') ? '角色' : 'Char') + (k + 1), ca[k]?.enabled === false ? '' : ca[k]?.prompt, cb[k]?.enabled === false ? '' : cb[k]?.prompt));
    }
    const pd = paramDiff(a, b, zh);
    const any = rows.some(Boolean) || pd.length;
    box.append(
      h(
        'div',
        { class: 'dblock' },
        h('span', { class: 'dhead mono' }, h('i', {}, 'A'), ' → ', h('i', {}, LETTERS[i])),
        any
          ? h('div', { class: 'dbody' }, pd.length ? h('div', { class: 'drow' }, h('span', { class: 'dl mono' }, () => ((getLang() === 'zh') ? '参数' : 'Params')), h('div', { class: 'dtags' }, ...pd)) : null, ...rows.filter(Boolean))
          : h('span', { class: 'hint' }, () => (!a.params || !b.params ? ((getLang() === 'zh') ? '（缺少参数记录）' : '(no parameters recorded)') : (getLang() === 'zh') ? '提示词与参数完全相同' : 'Identical prompt & parameters'))
      )
    );
  }
  return box;
}
