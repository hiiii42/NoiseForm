// Archive rail: thumbnails grouped by day, newest first, plus a live "pending" card while generating.
// Filters (flag / saved / date), search, multi-select (Ctrl / Shift) with a right-click menu for actions.
// Expands into a resizable grid. Thumbnail nodes are kept per record and reconciled in place,
// so a re-render (new image, compare letter, flag) touches only what changed.
import { $, h, icon, pad, clamp, debounce } from '../util.js';
import { bindCopy, t, getLang } from '../i18n.js';
import { state, set } from '../store.js';
import { compileQuery, SEARCH_HELP } from '../search.js';
import { loadTagDB } from '../tagdb.js';
import { openMenu } from './ctxmenu.js';

const thumbUrls = new Map();
let hooks = {};
let pending = null; // { w, h, n, progress, label }
let cmpIds = [];
const LETTERS = ['A', 'B', 'C', 'D'];

const view = { filter: 'all', date: '', query: '', pred: null };
let all = []; // last full list passed in
let visible = []; // after filters, in display order
let currentId = null;
const selected = new Set();
let anchor = null;

const zh = () => getLang() === 'zh';
const T = (z, en) => zh() ? z : en;
const DAY = 86400000;
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1, 2)}.${pad(d.getDate(), 2)}`;
};
const startOfDay = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const FILTERS = {
  all: [() => true, '全部', 'All'],
  star: [(r) => r.flag === 1, '★ 收藏', '★ Starred'],
  unstar: [(r) => r.flag !== 1, '☆ 未收藏', '☆ Not starred'],
  saved: [(r) => !!r.saved, '✓ 已保存', '✓ Saved'],
  unsaved: [(r) => !r.saved, '未保存', 'Unsaved'],
  reject: [(r) => r.flag === -1, '✕ 已淘汰', '✕ Rejected'],
};
function datePred(v) {
  if (!v) return () => true;
  const s = startOfDay();
  if (v === 'today') return (r) => r.createdAt >= s;
  if (v === 'yesterday') return (r) => r.createdAt >= s - DAY && r.createdAt < s;
  if (v === '7d') return (r) => r.createdAt >= s - 6 * DAY;
  if (v === '30d') return (r) => r.createdAt >= s - 29 * DAY;
  const k = v.slice(2);
  return (r) => dayKey(r.createdAt) === k;
}

export function initArchive(h_) {
  hooks = h_;
  $('#btnZip').onclick = () => hooks.zip?.();
  $('#btnClearHistory').onclick = () => hooks.clear?.();
  $('#btnStorage').onclick = () => hooks.storage?.();
  $('#archFilter').onchange = (e) => ((view.filter = e.target.value), refresh());
  $('#archDate').onchange = (e) => ((view.date = e.target.value), refresh());
  initSearch();
  // thumbnails are buttons with images: no native image drag ghost
  $('#archList').addEventListener('dragstart', (e) => e.target.closest?.('.thumb') && e.preventDefault());
  initWide();
}

const refresh = () => hooks.refresh?.();

// ---------------------------------------------------------------- search
function initSearch() {
  const inp = $('#archSearch');
  const run = debounce(() => {
    view.query = inp.value.trim();
    view.pred = compileQuery(view.query);
    inp.closest('.arch-search').classList.toggle('on', !!view.pred);
    refresh();
    // Chinese terms are matched through the tag dictionary — rerun once it is loaded
    if (/[　-鿿]/.test(view.query)) loadTagDB().then(() => ((view.pred = compileQuery(view.query)), refresh()), () => {});
  }, 160);
  inp.addEventListener('input', run);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      inp.value = '';
      run();
      inp.blur();
    }
  });
  let pop = null;
  $('#archHelp').onclick = (e) => {
    e.preventDefault();
    if (pop) return (pop.remove(), (pop = null));
    pop = h(
      'div',
      { class: 'arch-help' },
      h('b', { class: 'mono' }, () => (zh() ? '搜索语法 · 空格分隔、同时满足' : 'SEARCH · space-separated, all must match')),
      ...SEARCH_HELP.map(([ex, z, en]) =>
        h(
          'button',
          {
            onclick: () => {
              inp.value = (inp.value.trim() + ' ' + ex.split('  ')[0]).trim();
              inp.dispatchEvent(new Event('input'));
              inp.focus();
            },
          },
          h('code', {}, ex),
          h('span', {}, () => (zh() ? z : en))
        )
      )
    );
    $('.arch-tools').append(pop);
    setTimeout(() => document.addEventListener('pointerdown', function off(ev) {
      if (pop && !pop.contains(ev.target) && ev.target.id !== 'archHelp') (pop.remove(), (pop = null));
      if (!pop) document.removeEventListener('pointerdown', off);
    }));
  };
}

export function setQuery(q) {
  const inp = $('#archSearch');
  inp.value = q;
  inp.dispatchEvent(new Event('input'));
}

// ---------------------------------------------------------------- expanded grid
// CSS additionally caps the width so the stage keeps ~360px
const clampW = (w) => clamp(Number(w) || 560, 260, Math.max(300, innerWidth - $('.panel').offsetWidth - 360));

function applyWide() {
  const S = state.settings;
  const wide = !!S.archWide;
  document.body.classList.toggle('arch-wide', wide);
  document.body.style.setProperty('--arch-wide-w', clampW(S.archW) + 'px');
  $('#archList').style.setProperty('--thumb', (S.archSize || 120) + 'px');
  const b = $('#btnArchWide');
  b.classList.toggle('on', wide);
  b.dataset.i18nTitle = wide ? 'arch.collapse' : 'arch.expand'; // survives a language switch
  bindCopy(b, 'title', () => (t(b.dataset.i18nTitle)));
}

function initWide() {
  const S = state.settings;
  $('#btnArchWide').onclick = () => {
    set('settings.archWide', !S.archWide);
    applyWide();
    requestAnimationFrame(() => $('#archList .thumb.on')?.scrollIntoView({ block: 'nearest' }));
  };
  const size = $('#archSize');
  size.value = S.archSize || 120;
  size.oninput = () => $('#archList').style.setProperty('--thumb', size.value + 'px');
  size.onchange = () => set('settings.archSize', Number(size.value));
  // drag the left edge to resize; double-click resets
  const grip = $('#archResize');
  grip.addEventListener('pointerdown', (e) => {
    if (!S.archWide) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = $('#archive').getBoundingClientRect().width;
    document.body.classList.add('resizing');
    const move = (ev) => document.body.style.setProperty('--arch-wide-w', clampW(w0 + x0 - ev.clientX) + 'px');
    grip.addEventListener('pointermove', move);
    grip.addEventListener(
      'pointerup',
      (ev) => {
        grip.removeEventListener('pointermove', move);
        document.body.classList.remove('resizing');
        set('settings.archW', clampW(w0 + x0 - ev.clientX));
      },
      { once: true }
    );
  });
  grip.addEventListener('dblclick', () => (set('settings.archW', 560), applyWide()));
  addEventListener('resize', () => S.archWide && applyWide());
  applyWide();
}

// ---------------------------------------------------------------- selection
export const selectedIds = () => visible.filter((r) => selected.has(r.id)).map((r) => r.id);
export const visibleRecords = () => visible;

export function clearSelection() {
  if (!selected.size) return false;
  selected.clear();
  paintSelection();
  return true;
}
export function selectAllVisible() {
  for (const r of visible) selected.add(r.id);
  paintSelection();
}

function onThumbClick(id, e) {
  if (e.ctrlKey || e.metaKey) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    anchor = id;
    return paintSelection();
  }
  if (e.shiftKey) {
    const from = anchor || currentId || id;
    const a = visible.findIndex((r) => r.id === from);
    const b = visible.findIndex((r) => r.id === id);
    selected.clear();
    if (a < 0 || b < 0) selected.add(id);
    else for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(visible[i].id);
    anchor = from;
    return paintSelection();
  }
  if (e.altKey) return hooks.useSeed?.(id);
  selected.clear();
  anchor = id;
  paintSelection();
  hooks.select?.(id, e);
}

function paintSelection() {
  for (const [id, n] of nodes) n.el.classList.toggle('picked', selected.has(id));
  const bar = $('#archSel');
  const ids = selectedIds();
  bar.hidden = !ids.length;
  $('#archive').classList.toggle('selecting', ids.length > 0);
  if (!ids.length) return;
  const Z = zh();
  // actions live in the right-click menu; the strip only says what is picked
  bar.replaceChildren(
    h('span', { class: 'sel-n mono' }, h('b', {}, ids.length), () => ((getLang() === 'zh') ? ' 已选' : ' SEL')),
    h('span', { class: 'sel-hint' }, () => ((getLang() === 'zh') ? '右键操作' : 'right-click for actions')),
    h('span', { class: 'sp' }),
    h('button', { class: 'btn sm sq ghost', title: () => ((getLang() === 'zh') ? '取消选择 (Esc)' : 'Clear (Esc)'), onclick: clearSelection }, icon('close'))
  );
}

// Right-click: a menu for the picked set (when the thumb is part of it) or for that one image.
// Alt+left = use only its seed, Alt+right = use its parameters but keep the current seed.
function onThumbMenu(id, e) {
  e.preventDefault();
  if (e.altKey) return hooks.useParams?.(id);
  const Z = zh();
  const multi = selected.size > 1 && selected.has(id);
  if (multi) {
    const ids = selectedIds();
    const recs = ids.map((x) => all.find((r) => r.id === x)).filter(Boolean);
    const allStar = recs.every((r) => r.flag === 1);
    const allSaved = recs.every((r) => r.saved);
    const run = (act) => () => hooks.batch?.(act, selectedIds());
    return openMenu(e.clientX, e.clientY, [
      { label: () => ((getLang() === 'zh') ? `已选 ${ids.length} 张` : `${ids.length} selected`), icon: 'check', disabled: true, run: () => {} },
      '-',
      { label: () => (allStar ? ((getLang() === 'zh') ? '取消收藏' : 'Unstar') : (getLang() === 'zh') ? '收藏' : 'Star'), icon: 'star', hint: allStar ? 'U' : 'F', run: run(allStar ? 'unflag' : 'star') },
      { label: () => ((getLang() === 'zh') ? '淘汰' : 'Reject'), icon: 'reject', hint: 'X', run: run('reject') },
      { label: () => ((getLang() === 'zh') ? '加入对比（最多 4 张）' : 'Compare (up to 4)'), icon: 'variations', run: run('compare') },
      { label: () => ((getLang() === 'zh') ? '导出 ZIP' : 'Export ZIP'), icon: 'zip', hint: 'Ctrl+S', run: run('zip') },
      { label: () => (allSaved ? ((getLang() === 'zh') ? '清除「已保存」标记' : 'Clear saved mark') : (getLang() === 'zh') ? '标记为已保存' : 'Mark as saved'), icon: 'check', run: run(allSaved ? 'unsaved' : 'saved') },
      '-',
      { label: () => ((getLang() === 'zh') ? '取消选择' : 'Clear selection'), icon: 'close', hint: 'Esc', run: clearSelection },
      { label: () => ((getLang() === 'zh') ? `删除 ${ids.length} 张` : `Delete ${ids.length}`), icon: 'trash', hint: 'Del', danger: true, run: run('delete') },
    ]);
  }
  const rec = all.find((r) => r.id === id);
  if (!rec) return;
  if (selected.size && !selected.has(id)) clearSelection();
  const one = (act) => () => hooks.batch?.(act, [id]);
  openMenu(e.clientX, e.clientY, [
    { label: () => ((getLang() === 'zh') ? '查看' : 'Open'), icon: 'eye', run: () => hooks.select?.(id, e) },
    { label: () => (String(state.params.seed) === String(rec.seed) ? (getLang() === 'zh' ? '解锁种子' : 'Unlock seed') : getLang() === 'zh' ? '只用种子（锁定）' : 'Use seed only (lock)'), icon: String(state.params.seed) === String(rec.seed) ? 'unlock' : 'seed', hint: () => getLang() === 'zh' ? 'Alt+左键' : 'Alt+left', disabled: rec.seed == null, run: () => hooks.useSeed?.(id) },
    { label: () => ((getLang() === 'zh') ? '套用参数（不含种子）' : 'Use parameters (keep seed)'), icon: 'reuse', hint: () => ((getLang() === 'zh') ? 'Alt+右键' : 'Alt+right'), disabled: !rec.params, run: () => hooks.useParams?.(id) },
    { label: () => ((getLang() === 'zh') ? '加入对比' : 'Add to compare'), icon: 'variations', run: () => hooks.compare?.(id) },
    '-',
    { label: () => (rec.flag === 1 ? ((getLang() === 'zh') ? '取消收藏' : 'Unstar') : (getLang() === 'zh') ? '收藏' : 'Star'), icon: 'star', hint: rec.flag === 1 ? 'U' : 'F', run: one(rec.flag === 1 ? 'unflag' : 'star') },
    { label: () => ((getLang() === 'zh') ? '淘汰' : 'Reject'), icon: 'reject', hint: 'X', run: one('reject') },
    { label: () => ((getLang() === 'zh') ? '下载' : 'Download'), icon: 'download', run: () => hooks.download?.(id) },
    '-',
    { label: () => ((getLang() === 'zh') ? '删除' : 'Delete'), icon: 'trash', hint: 'Del', danger: true, run: one('delete') },
  ]);
}

// Columns in the current layout (for ↑/↓ in the grid).
export function gridColumns() {
  const th = [...$('#archList').querySelectorAll('.thumb[data-id]')].slice(0, 40);
  if (th.length < 2) return 1;
  const top = th[0].offsetTop;
  const n = th.findIndex((el) => el.offsetTop !== top);
  return n < 0 ? th.length : n;
}

// ---------------------------------------------------------------- thumbnails
function thumbUrl(rec) {
  let u = thumbUrls.get(rec.id);
  if (!u && rec.thumb) {
    u = URL.createObjectURL(rec.thumb);
    thumbUrls.set(rec.id, u);
  }
  return u || '';
}
export const thumbUrlFor = thumbUrl;

export function forgetThumb(id) {
  const u = thumbUrls.get(id);
  if (u) URL.revokeObjectURL(u);
  thumbUrls.delete(id);
  nodes.delete(id);
  selected.delete(id);
}

const nodes = new Map(); // record id → { el, sig }
const days = new Map(); // day label → header element

function thumbNode(rec, ci) {
  const sig = [rec.no, rec.width, rec.height, rec.kind, rec.demo, rec.saved?.name || '', rec.flag || 0, ci, getLang()].join('|');
  const n = nodes.get(rec.id);
  if (n && n.sig === sig) return n.el;
  const kind = rec.demo ? h('span', { class: 'kind demo' }, 'DEMO') : rec.kind !== 'gen' ? h('span', { class: 'kind' }, () => t('kind.' + rec.kind)) : null;
  const el = h(
    'div',
    {
      class: 'thumb' + (ci >= 0 ? ' in-cmp' : '') + (n ? ' seen' : '') + (rec.flag === 1 ? ' star' : rec.flag === -1 ? ' rej' : ''),
      'data-id': rec.id,
      style: { '--ar': `${rec.width}/${rec.height}` },
      title: () => ((rec.params?.prompt || '').slice(0, 200) + '\n— ' + t('arch.clickTip')),
      onclick: (e) => onThumbClick(rec.id, e),
      oncontextmenu: (e) => onThumbMenu(rec.id, e),
    },
    // reuse the already-decoded <img> when only a badge changed
    h('button', { type: 'button', class: 'thumb-open', 'aria-label': (rec.params?.prompt || '') || `№${pad(rec.no || 0, 4)}` },
      n?.el.querySelector('img') || h('img', { src: thumbUrl(rec), alt: '', loading: 'lazy', decoding: 'async', draggable: false })
    ),
    h('span', { class: 'no' }, pad(rec.no || 0, 4)),
    kind,
    ci >= 0 ? h('span', { class: 'cmp-badge' }, LETTERS[ci]) : null,
    rec.flag === 1 ? h('span', { class: 'fl' }, '★') : rec.flag === -1 ? h('span', { class: 'fl rej' }, '✕') : null,
    rec.saved ? h('span', { class: 'sv', title: () => (t('tool.saved') + ' · ' + rec.saved.name) }, '✓') : null,
    h('span', { class: 'ck' }, '✓')
  );
  if (n) n.el.replaceWith(el);
  nodes.set(rec.id, { el, sig });
  return el;
}

function dayNode(label) {
  let el = days.get(label);
  if (!el) days.set(label, (el = h('div', { class: 'arch-day' }, label)));
  return el;
}

// Make host's children equal `want`, leaving nodes that are already in place untouched
// (re-inserting them would restart their entrance animation).
function reconcile(host, want) {
  let cur = host.firstChild;
  for (const el of want) {
    if (cur === el) {
      cur = cur.nextSibling;
      continue;
    }
    host.insertBefore(el, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    cur.remove();
    cur = next;
  }
}

function pendingCard() {
  const pct = Math.round((pending.progress || 0) * 100);
  return h(
    'button',
    {
      class: 'thumb pending' + (pending.focused ? ' on' : ''),
      style: { '--ar': `${pending.w}/${pending.h}`, '--p': pct + '%' },
      title: () => (zh() ? '生成中 — 点击查看进度' : 'Generating — click to watch'),
      onclick: () => hooks.focusPending?.(),
    },
    h('span', { class: 'pd-fill' }),
    h('span', { class: 'pd-pct mono' }, String(pct).padStart(2, '0') + '%'),
    h('span', { class: 'no' }, () => (pending.label || (zh() ? '生成中' : 'NEW'))),
    pending.n > 1 ? h('span', { class: 'kind' }, '×' + pending.n) : null
  );
}

export function setPending(p) {
  pending = p ? { ...pending, ...p } : null;
  const host = $('#archList');
  const old = host.querySelector('.thumb.pending');
  if (!pending) return old?.remove();
  const card = pendingCard();
  if (old) old.replaceWith(card);
  else {
    host.querySelector('.arch-empty')?.remove();
    host.prepend(card);
  }
}

export function updatePendingProgress(progress) {
  if (!pending) return;
  pending.progress = progress;
  const el = $('#archList .thumb.pending');
  if (!el) return;
  const pct = Math.round(progress * 100);
  el.style.setProperty('--p', pct + '%');
  el.querySelector('.pd-pct').textContent = String(pct).padStart(2, '0') + '%';
}

// ---------------------------------------------------------------- filter controls
let filterSig = '';
function paintFilters() {
  const Z = zh();
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, [f]]) => [k, all.filter(f).length]));
  const s0 = startOfDay();
  const dayCounts = new Map();
  for (const r of all) dayCounts.set(dayKey(r.createdAt), (dayCounts.get(dayKey(r.createdAt)) || 0) + 1);
  const rel = {
    today: all.filter((r) => r.createdAt >= s0).length,
    yesterday: all.filter((r) => r.createdAt >= s0 - DAY && r.createdAt < s0).length,
    '7d': all.filter((r) => r.createdAt >= s0 - 6 * DAY).length,
    '30d': all.filter((r) => r.createdAt >= s0 - 29 * DAY).length,
  };
  const sig = JSON.stringify([counts, [...dayCounts], rel, Z, view.filter, view.date]);
  if (sig === filterSig) return;
  filterSig = sig;
  const opt = (v, label, cur) => h('option', { value: v, selected: v === cur }, label);
  $('#archFilter').replaceChildren(...Object.entries(FILTERS).map(([k, [, z, en]]) => opt(k, `${(getLang() === 'zh') ? z : en}  ${counts[k]}`, view.filter)));
  $('#archFilter').classList.toggle('on', view.filter !== 'all');
  const relL = (getLang() === 'zh') ? { today: '今天', yesterday: '昨天', '7d': '近 7 天', '30d': '近 30 天' } : { today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', '30d': 'Last 30 days' };
  if (view.date.startsWith('d:') && !dayCounts.has(view.date.slice(2))) view.date = '';
  $('#archDate').replaceChildren(
    opt('', (getLang() === 'zh') ? '全部日期' : 'Any date', view.date),
    ...Object.entries(relL).map(([k, l]) => opt(k, `${l}  ${rel[k]}`, view.date)),
    h('optgroup', { label: () => ((getLang() === 'zh') ? '按日' : 'By day') }, ...[...dayCounts].map(([d, n]) => opt('d:' + d, `${d}  ${n}`, view.date)))
  );
  $('#archDate').classList.toggle('on', !!view.date);
}

// ---------------------------------------------------------------- render
export function renderArchive(list, cur) {
  all = list;
  currentId = cur;
  const host = $('#archList');
  const fp = FILTERS[view.filter][0];
  const dp = datePred(view.date);
  const showTiles = /\bis:tile\b/.test(view.query || '');
  visible = all.filter((r) => (showTiles || r.kind !== 'tile') && fp(r) && dp(r) && (!view.pred || view.pred(r)));
  for (const id of selected) if (!visible.some((r) => r.id === id)) selected.delete(id);
  $('#archCount').textContent = visible.length === all.length ? pad(all.length, 3) : `${visible.length}/${all.length}`;
  $('#archCount').classList.toggle('filtered', visible.length !== all.length);
  paintFilters();
  const out = [];
  if (pending) out.push(host.querySelector('.thumb.pending') || pendingCard());
  if (!visible.length && !pending) {
    host.replaceChildren(h('div', { class: 'arch-empty' }, () => (all.length ? (zh() ? '没有符合条件的图像' : 'NO MATCHES') : t('arch.empty'))));
    paintSelection();
    return;
  }
  let day = '';
  for (const rec of visible) {
    const label = dayKey(rec.createdAt);
    if (label !== day) {
      day = label;
      out.push(dayNode(label));
    }
    const el = thumbNode(rec, cmpIds.indexOf(rec.id));
    el.classList.toggle('on', rec.id === cur);
    out.push(el);
  }
  reconcile(host, out);
  paintSelection();
}

export function markCompare(ids, list, cur) {
  cmpIds = ids;
  renderArchive(list, cur);
}

export function markCurrent(id) {
  currentId = id;
  for (const b of $('#archList').querySelectorAll('.thumb:not(.pending)')) b.classList.toggle('on', b.dataset.id === id);
  $('#archList .thumb.pending')?.classList.toggle('on', !id);
  const el = $(`#archList .thumb[data-id="${id}"]`);
  const list = $('#archList');
  if (!el) return;
  // scroll only the rail, never the page
  const r = el.getBoundingClientRect();
  const lr = list.getBoundingClientRect();
  if (r.top < lr.top || r.bottom > lr.bottom) list.scrollBy({ top: r.top - lr.top - 12, behavior: 'smooth' });
  if (r.left < lr.left || r.right > lr.right) list.scrollBy({ left: r.left - lr.left - 12, behavior: 'smooth' });
}

export function flashThumb(id) {
  const el = $(`#archList .thumb[data-id="${id}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

export function setStorageLabel(text, warn) {
  const b = $('#btnStorage');
  b.querySelector('b').textContent = text;
  b.classList.toggle('warn', !!warn);
}
