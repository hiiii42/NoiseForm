// Stage: empty poster, image view with fluted reveal, developing view, drop zone, toolbar.
import { $, h, icon, pad, fmtTime } from '../util.js';
import { state } from '../store.js';
import { bindCopy, t, getLang } from '../i18n.js';
import { modelById } from '../data.js';
import { fluteReveal } from '../fx.js';
import { createDeveloper } from '../develop.js';
import { lightbox } from './modal.js';

const urls = new Map();
let hooks = {};
let originalPreview = null;
const T = (zh, en) => getLang() === 'zh' ? zh : en;

export function urlFor(rec) {
  if (!rec?.blob) return '';
  let u = urls.get(rec.id);
  if (!u) {
    u = URL.createObjectURL(rec.blob);
    urls.set(rec.id, u);
  }
  return u;
}
export function dropUrl(id) {
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
}

// [id, icon, label key, class]. Everything after '…' lives in the "More" menu so the bar always fits.
const TOOLS = [
  ['star', 'star', 'tool.star'],
  ['save', 'download', 'tool.save'],
  ['compare', 'variations', 'tool.compare', 'hot'],
  '|',
  ['upscale', 'upscale', 'tool.upscale', 'hot'],
  ['variations', 'variations', 'tool.variations'],
  ['director', 'wand', 'tool.director', 'hot'],
  '|',
  ['seed', 'seed', 'tool.seed'],
  ['reuse', 'reuse', 'tool.reuse'],
  '…',
  ['copy', 'copy', 'tool.copy'],
  ['enhance', 'enhance', 'tool.enhance'],
  ['post', 'sliders', 'tool.post'],
  ['tiled', 'upscale', 'tool.tiled'],
  ['base', 'edit', 'tool.base'],
  ['inpaint', 'inpaint', 'tool.inpaint'],
  ['vibe', 'vibe', 'tool.vibe'],
  ['ref', 'target', 'tool.ref'],
  ['delete', 'trash', 'tool.delete', 'danger'],
];

export function initStage(h_) {
  hooks = h_;
  renderTools();
  initDrop();
}

export function renderTools() {
  const nav = $('#tools');
  const cut = TOOLS.indexOf('…');
  const btn = (x, cls) => h('button', { class: cls + (x[3] ? ' ' + x[3] : ''), 'data-tool': x[0], title: () => (t(x[2])), onclick: () => (closeMore(), hooks.tool?.(x[0])) }, icon(x[1]), h('span', {}, () => (t(x[2]))));
  const more = h('button', { class: 'tool more', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: () => (t('tool.more')), onclick: (e) => toggleMore(e.currentTarget, TOOLS.slice(cut + 1).map((x) => btn(x, 'tm-i'))) }, icon('more'), h('span', {}, () => (t('tool.more'))));
  nav.replaceChildren(...TOOLS.slice(0, cut).map((x) => (x === '|' ? h('span', { class: 'div' }) : btn(x, 'tool'))), h('span', { class: 'div' }), more);
  originalPreview?.mountTool();
}
let moreEl = null;
function toggleMore(anchor, items) {
  if (moreEl) return closeMore();
  moreEl = h('div', { class: 'tools-more', role: 'menu' }, ...items);
  document.body.append(moreEl);
  const r = anchor.getBoundingClientRect();
  moreEl.style.left = Math.max(8, Math.min(innerWidth - moreEl.offsetWidth - 8, r.right - moreEl.offsetWidth)) + 'px';
  moreEl.style.bottom = innerHeight - r.top + 6 + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  setTimeout(() => document.addEventListener('pointerdown', outsideMore, true));
  document.addEventListener('keydown', escMore, true);
}
function outsideMore(e) {
  if (moreEl && !moreEl.contains(e.target) && !e.target.closest('.tool.more')) closeMore();
}
function escMore(e) {
  if (e.key === 'Escape' && moreEl) (e.stopPropagation(), closeMore());
}
function closeMore() {
  moreEl?.remove();
  moreEl = null;
  $('#tools .tool.more')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', outsideMore, true);
  document.removeEventListener('keydown', escMore, true);
}

export function showEmpty() {
  zoomEvents?.abort();
  $('#stage')?.classList.remove('zooming');
  originalPreview?.dispose();
  originalPreview = null;
  $('#view').hidden = true;
  $('#tools').hidden = true;
  $('#poster').classList.remove('gone', 'paused');
}

const KIND = { gen: 'GEN', img2img: 'IMG2IMG', inpaint: 'INPAINT', upscale: 'UPSCALE ×4', director: 'DIRECTOR', enhance: 'ENHANCE', variation: 'VARIATION', import: 'IMPORT', post: 'POST', tile: 'TILE' };
const kindLabel = (rec) => (rec.kind === 'upscale' && rec.tiled ? t('kind.tiled', { scale: Number(rec.tiled.scale || 0).toFixed(1).replace(/\.0$/, '') }) : KIND[rec.kind] ? t('kind.' + rec.kind) : rec.kind.toUpperCase());

export function showRecord(rec, { reveal = false, batch = [] } = {}) {
  if (!rec) return showEmpty();
  originalPreview?.dispose();
  originalPreview = null;
  const view = $('#view');
  const poster = $('#poster');
  $('#stage')?.classList.remove('zooming');
  poster.classList.add('gone', 'paused');
  view.hidden = false;
  $('#tools').hidden = false;
  const src = urlFor(rec);
  const p = rec.params || {};
  const m = modelById(rec.model || p.model);
  const img = h('img', { src, alt: p.prompt || '', draggable: true });
  img.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/uri-list', src);
  });
  const frameIn = h('div', { class: 'frame-in', title: () => (T('滚轮 / Ctrl+滚轮缩放 · 拖动平移 · 双击复位', 'Wheel / Ctrl+wheel to zoom · drag to pan · double-click to reset')) }, img);
  const frame = h('figure', { class: 'frame' }, frameIn);
  const main = h('div', { class: 'view-main' }, frame);
  attachZoom(frameIn, img, main);
  if (batch.length > 1) {
    main.append(
      h(
        'div',
        { class: 'batch' },
        ...batch.map((b) =>
          h('button', { class: b.id === rec.id ? 'on' : '', onclick: () => hooks.select?.(b.id) }, h('img', { src: urlFor(b), alt: '' }))
        )
      )
    );
  }
  // compact slug: number, model, seed; the rest on hover
  const detail = () => [fmtTime(rec.createdAt), m.short, `${rec.width}×${rec.height}`, p.steps ? `${p.steps} ${t('f.steps')} · CFG ${p.scale} · ${(p.sampler || '').replace(/^k_/, '')}` : '', rec.seed != null ? t('f.seed') + ' ' + rec.seed : '', rec.job ? '#' + rec.job.no : ''].filter(Boolean).join(' · ');
  const left = h(
    'span',
    {},
    h('span', { class: 'no' }, '№' + pad(rec.no || 0, 4)),
    h('b', {}, () => rec.kind === 'gen' ? m.short : kindLabel(rec)),
    rec.demo ? h('b', { style: { color: 'var(--neg)', marginLeft: '8px' } }, 'DEMO') : null
  );
  const right = h('span', {}, rec.seed != null ? [() => t('f.seed') + ' ', h('b', {}, String(rec.seed))] : `${rec.width}×${rec.height}`);
  view.replaceChildren(h('div', { class: 'view-slug', title: detail }, left, right), main);
  const ho = takeHandoff();
  if (ho && reveal) landInto(ho, frameIn, img);
  else if (ho) ho.d.stop();
  else if (reveal && state.settings.fxReveal && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    img.decode().then(() => fluteReveal(frameIn, src)).catch(() => {});
  }
  updateSaveTool(rec);
  updateFlagTool(rec);
  // tool availability
  const isV4 = modelById(state.params.model).v4;
  for (const b of $('#tools').querySelectorAll('.tool')) {
    const k = b.dataset.tool;
    b.disabled = (k === 'seed' && rec.seed == null) || (k === 'reuse' && !rec.params) || (k === 'ref' && !isV4);
  }
  if (typeof hooks.original === 'function' && (['img2img', 'inpaint', 'enhance', 'post'].includes(rec.kind) || (rec.kind === 'upscale' && rec.tiled))) {
    originalPreview = holdOriginal(rec, frameIn, img, src);
    originalPreview.mountTool();
  }
}

// Wheel zoom (1×–8×, around the cursor) with drag-pan while zoomed; double-click or Esc resets.
// The image stays inside its frame (overflow hidden) so the layout never moves.
// Wheel / Ctrl+wheel zoom (1–8×) around the cursor. The zoomed image is not confined to its frame: it may
// fill the whole stage area (box), and panning keeps it covering that area (or inside it while smaller).
// 1.6.3: zoom events cover the whole view and the image may fill the whole stage (box = #stage);
// the slug line and the toolbar stay on top. #view is reused across records: each attach aborts the last.
let zoomEvents = null;
function attachZoom(frameIn, img, host) {
  zoomEvents?.abort();
  zoomEvents = new AbortController();
  const signal = zoomEvents.signal;
  const box = $('#stage') || host;
  let z = 1, tx = 0, ty = 0;
  let drag = null;
  // zoom level + "back to fit" in one button (also: double-click, Esc)
  const pct = h('span', {});
  const badge = h('button', { type: 'button', class: 'zoom-badge mono', hidden: true, title: () => T('恢复原始大小（双击 / Esc）', 'Back to fit (double-click / Esc)'), 'aria-label': () => T('恢复原始大小', 'Back to fit') }, icon('undo'), pct);
  badge.addEventListener('click', (e) => (e.stopPropagation(), reset()), { signal });
  badge.addEventListener('pointerdown', (e) => e.stopPropagation(), { signal });
  host.append(badge);
  const apply = () => {
    img.style.transform = z === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${z})`;
    frameIn.classList.toggle('zoomed', z !== 1);
    box.classList.toggle('zooming', z !== 1);
    if (z === 1) box.classList.remove('zooming');
    badge.hidden = z === 1;
    pct.textContent = Math.round(z * 100) + '%';
  };
  // image centre (transform origin, untransformed) in client coordinates
  const origin = () => {
    const r = frameIn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const range = (lo, hi, half, c) => {
    const a = lo - c + half, b = hi - c - half;
    return [Math.min(a, b), Math.max(a, b)];
  };
  const clampPan = () => {
    const c = box.getBoundingClientRect();
    const o = origin();
    const [x0, x1] = range(c.left, c.right, (img.offsetWidth * z) / 2, o.x);
    const [y0, y1] = range(c.top, c.bottom, (img.offsetHeight * z) / 2, o.y);
    tx = Math.max(x0, Math.min(x1, tx));
    ty = Math.max(y0, Math.min(y1, ty));
  };
  const reset = () => ((z = 1), (tx = 0), (ty = 0), apply());
  const inStrip = (e) => e.target.closest?.('.batch, .zoom-badge, .view-slug');
  const view = $('#view');
  view.addEventListener('wheel', (e) => {
    if (inStrip(e)) return;
    e.preventDefault(); // also stops Ctrl+wheel from zooming the whole page
    const nz = Math.max(1, Math.min(8, z * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
    if (nz === z) return;
    // keep the image point under the cursor fixed
    const o = origin();
    const cx = e.clientX - o.x, cy = e.clientY - o.y;
    tx = cx - ((cx - tx) * nz) / z;
    ty = cy - ((cy - ty) * nz) / z;
    z = nz;
    if (z === 1) (tx = 0), (ty = 0);
    clampPan();
    apply();
  }, { passive: false, signal });
  view.addEventListener('pointerdown', (e) => {
    if (z === 1 || e.button !== 0 || inStrip(e)) return;
    drag = { x: e.clientX - tx, y: e.clientY - ty, id: e.pointerId, moved: false };
    view.setPointerCapture(e.pointerId);
  }, { signal });
  view.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    tx = e.clientX - drag.x;
    ty = e.clientY - drag.y;
    drag.moved = true;
    clampPan();
    apply();
  }, { signal });
  const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  view.addEventListener('pointerup', endDrag, { signal });
  view.addEventListener('pointercancel', endDrag, { signal });
  view.addEventListener('dblclick', (e) => !inStrip(e) && reset(), { signal });
  frameIn.addEventListener('keydown', (e) => e.key === 'Escape' && z !== 1 && (e.stopPropagation(), reset()));
  frameIn.tabIndex = -1;
  // native image drag (drop into the base slot) only while not zoomed
  frameIn.addEventListener('dragstart', (e) => z !== 1 && e.preventDefault(), true);
}

// Each displayed record owns its gesture state. A released/replaced view must never be
// changed by a late original() or decode() result. Hook URLs remain owned by the caller.
function holdOriginal(rec, frameIn, img, src) {
  const events = new AbortController();
  const listen = (el, name, fn, opts = {}) => el.addEventListener(name, fn, { ...opts, signal: events.signal });
  const label = h('span', { class: 'original-label', hidden: true }, () => (T('原图', 'Original')));
  frameIn.append(label);
  let button = null;
  let disposed = false;
  let missing = false;
  let original = null;
  let revision = 0;
  let gesture = null;
  let timer = null;
  let suppressClick = false;

  const stop = () => {
    clearTimeout(timer);
    timer = null;
    gesture = null;
    revision++;
    if (!label.hidden) img.src = src;
    label.hidden = true;
    frameIn.classList.remove('showing-original');
    frameIn.style.removeProperty('--original-width');
    frameIn.style.removeProperty('--original-height');
    button?.setAttribute('aria-pressed', 'false');
    button?.removeAttribute('aria-busy');
  };
  const show = async () => {
    const rev = ++revision;
    button?.setAttribute('aria-busy', 'true');
    // Cache only within this view, including a failed lookup. Do not revoke hook URLs.
    original ||= (async () => {
      try {
        const url = await hooks.original(rec);
        if (!url) return null;
        const probe = new Image();
        probe.src = url;
        await probe.decode();
        return url;
      } catch {
        return null;
      }
    })();
    const url = await original;
    if (disposed) return;
    if (!url) {
      missing = true;
      stop();
      button.disabled = true;
      bindCopy(button, 'title', () => (T('没有保存原图', 'No original saved')));
      return;
    }
    if (rev !== revision || !gesture || !frameIn.isConnected) return;
    const { width, height } = img.getBoundingClientRect();
    frameIn.style.setProperty('--original-width', width + 'px');
    frameIn.style.setProperty('--original-height', height + 'px');
    frameIn.classList.add('showing-original');
    img.src = url;
    label.hidden = false;
    bindCopy(label, 'textContent', () => (T('原图', 'Original')));
    button.setAttribute('aria-pressed', 'true');
    button.removeAttribute('aria-busy');
  };
  const pointerStart = (e, target, delay = 0) => {
    if (e.button !== 0 || e.isPrimary === false || missing || disposed) return;
    stop();
    gesture = { target, pointerId: e.pointerId, x: e.clientX, y: e.clientY, waiting: !!delay };
    if (delay) {
      suppressClick = false;
      timer = setTimeout(() => {
        timer = null;
        gesture.waiting = false;
        suppressClick = true;
        show();
      }, delay);
    } else {
      e.preventDefault();
      closeMore();
      show();
    }
  };
  listen(frameIn, 'pointerdown', (e) => pointerStart(e, frameIn, 600));
  listen(frameIn, 'pointerleave', () => { if (gesture?.target === frameIn) stop(); });
  listen(frameIn, 'dragstart', (e) => {
    if (suppressClick) e.preventDefault();
    stop();
  });
  listen(frameIn, 'contextmenu', (e) => { if (gesture?.target === frameIn || suppressClick) e.preventDefault(); });
  listen(frameIn, 'click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });
  listen(window, 'pointermove', (e) => {
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    const r = gesture.target.getBoundingClientRect();
    if ((gesture.waiting && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 10) ||
        e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) stop();
  });
  const pointerEnd = (e) => { if (gesture?.pointerId === e.pointerId) stop(); };
  listen(window, 'pointerup', pointerEnd);
  listen(window, 'pointercancel', pointerEnd);
  listen(window, 'blur', stop);
  listen(document, 'visibilitychange', () => { if (document.hidden) stop(); });

  return {
    mountTool() {
      stop();
      button?.remove();
      button = h('button', {
        type: 'button', class: 'tool original-tool', 'data-tool': 'original', disabled: missing,
        title: () => (missing ? T('没有保存原图', 'No original saved') : T('按住查看原图（空格）', 'Hold to view original (Space)')),
        'aria-pressed': 'false',
        onclick: (e) => e.preventDefault(),
        onpointerdown: (e) => pointerStart(e, button),
        onpointerleave: () => { if (gesture?.target === button) stop(); },
        onblur: () => { if (gesture?.target === button) stop(); },
        onkeydown: (e) => {
          if (e.code !== 'Space' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat || gesture || missing) return;
          closeMore();
          gesture = { target: button };
          show();
        },
        onkeyup: (e) => {
          if (e.code !== 'Space' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          stop();
        },
      }, icon($('#i-eye') ? 'eye' : 'variations'), h('span', {}, () => (T('原图', 'Original'))));
      $('#tools [data-tool="compare"]')?.after(button);
    },
    dispose() {
      stop();
      disposed = true;
      events.abort();
      button?.remove();
      label.remove();
    },
  };
}

export function updateFlagTool(rec) {
  const b = $('#tools [data-tool="star"]');
  if (!b) return;
  b.classList.toggle('starred', rec.flag === 1);
  b.classList.toggle('rejected', rec.flag === -1);
  bindCopy(b.querySelector('span'), 'textContent', () => (t(rec.flag === 1 ? 'tool.starred' : rec.flag === -1 ? 'tool.rejected' : 'tool.star')));
  bindCopy(b, 'title', () => (t('tool.starTip')));
}

export function updateSaveTool(rec) {
  const b = $('#tools [data-tool="save"]');
  if (!b) return;
  const s = rec.saved;
  b.classList.toggle('saved', !!s);
  bindCopy(b.querySelector('span'), 'textContent', () => (s ? t('tool.saved') : t('tool.save')));
  b.querySelector('use').setAttribute('href', s ? '#i-check' : '#i-download');
  bindCopy(b, 'title', () => (s ? `${t('tool.saved')} · ${new Date(s.at).toLocaleString()} · ${s.name}` : t('tool.save')));
}

let dev = null;
let handoff = null; // a landed developer waiting for showRecord to take over its frame
export function startDeveloping(opts, { visible = true } = {}) {
  stopDeveloping();
  $('#poster').classList.add('paused', 'gone');
  dev = createDeveloper($('#developing'), opts);
  if (!visible) hideDeveloping();
  return dev;
}
// generation keeps running; only the overlay is hidden so the stage stays browsable
export function hideDeveloping() {
  if (dev) $('#developing').hidden = true;
  if ($('#view').hidden) $('#poster').classList.remove('paused', 'gone');
}
export function revealDeveloping() {
  if (!dev) return false;
  $('#developing').hidden = false;
  $('#poster').classList.add('paused', 'gone');
  return true;
}
export const developingVisible = () => !!dev && !$('#developing').hidden;
export function stopDeveloping() {
  dev?.stop();
  dev = null;
  takeHandoff()?.d.stop();
  if ($('#view').hidden) $('#poster').classList.remove('paused', 'gone');
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Generation finished: zoom the developer to its final frame and develop the image there, then keep it on
// screen until showRecord() hands the frame over to the real <img> (or releaseHandoff() drops it).
export async function landDeveloping(blob) {
  const d = dev;
  if (!d) return;
  const animate = developingVisible() && state.settings.fxReveal !== false && !reducedMotion();
  if (animate) await d.land(blob);
  else await new Promise((r) => setTimeout(r, 160));
  if (dev !== d) return; // stopped or replaced meanwhile
  if (!animate || !developingVisible()) return stopDeveloping();
  dev = null;
  handoff = { d, rect: d.rect(), timer: setTimeout(releaseHandoff, 4000) };
}
function takeHandoff() {
  const ho = handoff;
  handoff = null;
  if (ho) clearTimeout(ho.timer);
  return ho;
}
export function releaseHandoff() {
  const ho = takeHandoff();
  if (!ho) return;
  ho.d.fadeOut(220);
  if ($('#view').hidden) $('#poster').classList.remove('paused', 'gone');
}
// FLIP: the new image starts exactly where the developer's frame is, the data ocean fades away,
// and the image settles into its place in the view.
function landInto(ho, frameIn, img) {
  const go = () => {
    const to = frameIn.getBoundingClientRect();
    const from = ho.rect;
    if (to.width > 1 && to.height > 1 && from.width > 1) {
      const sx = from.width / to.width;
      const sy = from.height / to.height;
      frameIn.animate(
        [{ transformOrigin: '0 0', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})` }, { transformOrigin: '0 0', transform: 'none' }],
        { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    }
    ho.d.fadeOut(240);
  };
  // wait for the decoded image so the hand-over is a single, flicker-free frame
  img.decode().then(go, go);
}

function initDrop() {
  const dz = $('#dropzone');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    dz.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dz.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    depth = 0;
    dz.hidden = true;
    if (!hasFiles(e)) return;
    e.preventDefault();
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (f) hooks.dropFile?.(f);
  });
  window.addEventListener('paste', (e) => {
    if (e.target.closest?.('textarea, input')) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) hooks.dropFile?.(item.getAsFile());
  });
}
