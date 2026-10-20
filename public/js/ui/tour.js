// Contextual tours. Copy may be a string or a () => string for live language selection.
import { h, icon, clamp } from '../util.js';
import { getLang } from '../i18n.js';
import { modalOpen } from './modal.js';
import { on } from '../store.js';

const KEY = 'nf.tours';
const tours = new Map();
const pending = new Map();
let active = null;
let sessionSeen = Object.create(null);
let storageFailed = false;
const T = (zh, en) => getLang() === 'zh' ? zh : en;
const copy = (value) => typeof value === 'function' ? value() : value;

function readSeen() {
  if (storageFailed) return sessionSeen;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
  } catch { /* Storage can be disabled; retain state for this page session. */ }
  return sessionSeen;
}

export function tourSeen(id) {
  const seen = readSeen();
  return Object.hasOwn(seen, id) && seen[id] === true;
}

export function markSeen(id) {
  sessionSeen = Object.assign(Object.create(null), readSeen(), { [id]: true });
  try { localStorage.setItem(KEY, JSON.stringify(sessionSeen)); } catch { storageFailed = true; }
}

export function resetTours() {
  for (const job of [...pending.values()]) job.cancel();
  active?.finish(false, false);
  sessionSeen = Object.create(null);
  try { localStorage.removeItem(KEY); storageFailed = false; } catch { storageFailed = true; }
}

export function defineTour(id, { steps, title }) {
  if (typeof id !== 'string' || !id || !Array.isArray(steps) || !steps.length) {
    throw new TypeError('defineTour requires an id and at least one step');
  }
  tours.set(id, { title, steps });
}

// step is zero-based; -1 means the tour was not opened. Skipping also counts as seen.
export function startTour(id, { force = false } = {}) {
  if (active?.id === id) return active.promise;
  if (!tours.has(id)) return Promise.reject(new Error(`Unknown tour: ${id}`));
  if (!force && tourSeen(id)) return Promise.resolve({ completed: false, step: -1 });
  pending.get(id)?.cancel();
  active?.finish(false, false);

  const tour = tours.get(id);
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const previousFocus = document.activeElement;
  const card = h('section', {
    class: 'tour-card', role: 'dialog', tabindex: -1,
    'aria-labelledby': 'nf-tour-title', 'aria-describedby': 'nf-tour-rows',
  });
  let index = 0;
  let target = null;
  let frame = 0;
  let closed = false;
  const resize = new ResizeObserver(() => schedule());
  // Font scale, theme, collapsed panels and newly mounted contextual targets can all change.
  const changes = new MutationObserver(() => schedule());
  const viewport = window.visualViewport;
  const unsubscribeLang = on('settings.lang', () => show(index));

  function finish(completed, seen = true) {
    if (closed) return;
    closed = true;
    unsubscribeLang();
    if (seen) markSeen(id);
    target?.classList.remove('tour-target');
    cancelAnimationFrame(frame);
    resize.disconnect();
    changes.disconnect();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('scroll', schedule, true);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    const restoreFocus = card.contains(document.activeElement);
    card.remove();
    active = null;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    resolve({ completed, step: index });
  }

  function advance() {
    if (index === tour.steps.length - 1) finish(true);
    else show(index + 1);
  }

  function onKey(event) {
    if (event.isComposing) return;
    if (['ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(event.key)) {
      // Capture before app hotkeys, including Ctrl+Enter, so a tour never generates a picture.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.key === 'Escape') finish(false);
      else if (event.key === 'ArrowLeft') show(Math.max(0, index - 1));
      else if (event.key === 'Enter' && event.target.closest?.('.tour-card button, .tour-card a')) event.target.click();
      else advance();
    } else if (event.key === 'Tab') {
      const controls = [...card.querySelectorAll('a[href], button:not(:disabled)')];
      const at = controls.indexOf(document.activeElement);
      event.preventDefault();
      event.stopImmediatePropagation();
      controls[(at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }
  }

  function findTarget() {
    const selector = tour.steps[index].target;
    if (!selector) return null;
    try {
      return [...document.querySelectorAll(selector)].find((el) => {
        const style = getComputedStyle(el);
        return el.getClientRects().length && style.visibility === 'visible' &&
          el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      }) || null;
    } catch { return null; }
  }

  function setTarget(next) {
    if (next === target) return;
    if (target) {
      resize.unobserve(target);
      target.classList.remove('tour-target');
    }
    target = next;
    if (target) {
      target.classList.add('tour-target');
      resize.observe(target);
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }

  function position() {
    frame = 0;
    if (closed) return;
    setTarget(findTarget());
    const margin = 12;
    const gap = 16;
    const left = (viewport?.offsetLeft || 0) + margin;
    const top = (viewport?.offsetTop || 0) + margin;
    const width = (viewport?.width || innerWidth) - margin * 2;
    const height = (viewport?.height || innerHeight) - margin * 2;
    card.style.maxWidth = Math.max(1, width) + 'px';
    card.style.maxHeight = Math.max(1, height) + 'px';
    const w = card.offsetWidth;
    const ht = card.offsetHeight;
    const right = left + width;
    const bottom = top + height;
    let x = left + (width - w) / 2;
    let y = top + (height - ht) / 2;
    let side = 'center';
    const r = target?.getBoundingClientRect();
    if (r && r.right > left && r.left < right && r.bottom > top && r.top < bottom) {
      // Choose a side with enough room, then minimize overlap and clamping on small screens.
      const cx = (r.left + r.right - w) / 2;
      const cy = (r.top + r.bottom - ht) / 2;
      const options = [
        ['right', r.right + gap, cy], ['left', r.left - gap - w, cy],
        ['bottom', cx, r.bottom + gap], ['top', cx, r.top - gap - ht],
      ].map(([name, px, py]) => {
        const nx = clamp(px, left, Math.max(left, right - w));
        const ny = clamp(py, top, Math.max(top, bottom - ht));
        const overlap = Math.max(0, Math.min(nx + w, r.right) - Math.max(nx, r.left)) *
          Math.max(0, Math.min(ny + ht, r.bottom) - Math.max(ny, r.top));
        return { name, x: nx, y: ny, score: overlap * 100 + Math.abs(nx - px) + Math.abs(ny - py) };
      });
      options.sort((a, b) => a.score - b.score);
      ({ x, y, name: side } = options[0]);
    }
    // Avoid mutation-observer loops from writing unchanged geometry.
    const px = Math.round(x) + 'px';
    const py = Math.round(y) + 'px';
    if (card.style.left !== px) card.style.left = px;
    if (card.style.top !== py) card.style.top = py;
    if (card.dataset.placement !== side) card.dataset.placement = side;
  }

  function schedule() {
    if (!frame && !closed) frame = requestAnimationFrame(position);
  }

  function show(step) {
    index = step;
    const current = tour.steps[index];
    card.dataset.tour = id;
    card.dataset.step = index;
    const previous = h('button', {
      class: 'tour-prev', type: 'button', disabled: index === 0,
      onclick: () => show(index - 1),
    }, () => (T('上一步', 'Back')));
    const next = h('button', { class: 'tour-next', type: 'button', onclick: advance },
      () => (index === tour.steps.length - 1 ? T('完成', 'Done') : T('下一步', 'Next')));
    const doc = current.doc;
    const children = [
      h('header', { class: 'tour-head' },
        h('span', { class: 'tour-kicker' }, copy(current.kicker) || copy(tour.title)),
        h('span', { class: 'tour-count', 'aria-label': () => (T('引导进度', 'Tour progress')) }, `${index + 1} / ${tour.steps.length}`)),
      h('h2', { class: 'tour-title', id: 'nf-tour-title' }, copy(current.title)),
      h('dl', { class: 'tour-rows', id: 'nf-tour-rows' },
        ...(current.rows || []).map(([action, text]) => h('div', { class: 'tour-row' },
          h('dt', {}, h('kbd', {}, copy(action))), h('dd', {}, copy(text))))),
      current.note ? h('p', { class: 'tour-note' }, copy(current.note)) : null,
      // Only local documentation paths are supported; links preserve the current tour.
      /^docs\/[\w/.-]+\.md(?:#.*)?$/.test(doc || '') ? h('a', {
        class: 'tour-doc', href: new URL('../../' + doc, import.meta.url).href,
        target: '_blank', rel: 'noopener noreferrer',
      }, () => (T('详细教程', 'Full guide')), icon('expand')) : null,
      h('footer', { class: 'tour-foot' },
        h('button', { class: 'tour-skip', type: 'button', onclick: () => finish(false) }, () => (T('跳过引导', 'Skip tour'))),
        previous, next)
    ];
    card.replaceChildren(...children.filter((node) => node != null));
    position();
    card.focus({ preventScroll: true });
  }

  active = { id, promise, finish };
  document.body.append(card);
  resize.observe(card);
  changes.observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['hidden', 'class', 'open'] });
  changes.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'lang'] });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', schedule, true);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  show(0);
  return promise;
}

// One pending trigger per id. Wait for a quiet, visible page without competing dialogs.
// Resolves like startTour; resetTours cancels pending triggers with step: -1.
export function maybeStart(id, delayMs = 0) {
  if (tourSeen(id)) return Promise.resolve({ completed: false, step: -1 });
  if (active?.id === id) return active.promise;
  if (pending.has(id)) return pending.get(id).promise;
  if (!tours.has(id)) return Promise.reject(new Error(`Unknown tour: ${id}`));
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  let timer;
  let idle;
  let lastInput = performance.now();
  let held = false;
  const events = ['pointerdown', 'pointerup', 'pointercancel', 'keydown', 'input', 'wheel'];
  const readyAt = performance.now() + Math.max(0, Number(delayMs) || 0);

  function activity(event) {
    lastInput = performance.now();
    if (event.type === 'pointerdown') held = true;
    if (event.type === 'pointerup' || event.type === 'pointercancel') held = false;
  }
  function cleanup() {
    clearTimeout(timer);
    if (idle != null) window.cancelIdleCallback?.(idle);
    for (const event of events) window.removeEventListener(event, activity, true);
    window.removeEventListener('blur', release);
    pending.delete(id);
  }
  function release() { held = false; lastInput = performance.now(); }
  function check() {
    if (tourSeen(id)) return cancel();
    const busy = document.visibilityState !== 'visible' || active || modalOpen() || held ||
      document.querySelector('.lightbox, [role="dialog"]');
    if (busy || performance.now() < readyAt || performance.now() - lastInput < 800) {
      timer = setTimeout(queue, 250);
      return;
    }
    cleanup();
    startTour(id).then(resolve);
  }
  function queue() {
    if (window.requestIdleCallback) idle = window.requestIdleCallback(check, { timeout: 1000 });
    else check();
  }
  function cancel() { cleanup(); resolve({ completed: false, step: -1 }); }
  pending.set(id, { promise, cancel });
  for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
  window.addEventListener('blur', release);
  timer = setTimeout(queue, Math.max(0, readyAt - performance.now()));
  return promise;
}
