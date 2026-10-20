import { h } from '../util.js';
import { bindCopy, getLang } from '../i18n.js';

const KEY = 'nf.layout';
const MIN = 340;

// Deliberately independent of store.js: widths are layout preferences, in CSS pixels.
export function initResizer() {
  const panel = document.querySelector('#panel');
  if (!panel || panel.querySelector('.panel-resize')) return;
  const root = document.documentElement;
  let saved = null;
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}')?.panelWidth;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) saved = value;
  } catch {}
  const measure = h('div', { class: 'panel-resize-measure', 'aria-hidden': 'true' });
  const baseMeasure = h('div', { class: 'panel-resize-measure', style: { width: 'var(--panel-w)' }, 'aria-hidden': 'true' });
  document.body.append(measure, baseMeasure);
  const handle = h('div', {
    class: 'panel-resize', role: 'separator', tabIndex: 0,
    'aria-orientation': 'vertical', 'aria-controls': 'panel',
  });
  panel.append(handle);
  let drag = null;
  const bounds = () => {
    const max = Math.floor(measure.getBoundingClientRect().width);
    return { min: Math.min(MIN, max), max };
  };
  const clamp = (value) => {
    const { min, max } = bounds();
    return Math.round(Math.max(min, Math.min(value, max)));
  };
  const sync = () => {
    if (saved === null) root.style.removeProperty('--panel-user-w');
    else root.style.setProperty('--panel-user-w', `${saved}px`);
    const { min, max } = bounds();
    const zh = getLang() === 'zh';
    bindCopy(handle, 'title', () => ((getLang() === 'zh') ? '拖动调整宽度 · 双击复位' : 'Drag to resize · Double-click to reset'));
    handle.setAttribute('aria-label', (getLang() === 'zh') ? '左侧栏宽度' : 'Left panel width');
    handle.setAttribute('aria-valuemin', min);
    handle.setAttribute('aria-valuemax', max);
    const width = Math.round(baseMeasure.getBoundingClientRect().width);
    handle.setAttribute('aria-valuenow', width);
    handle.setAttribute('aria-valuetext', `${width}px`);
  };
  const persist = () => {
    try {
      let layout;
      try { layout = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
      if (!layout || typeof layout !== 'object' || Array.isArray(layout)) layout = {};
      if (saved === null) delete layout.panelWidth;
      else layout.panelWidth = saved;
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {} // A blocked or full localStorage must not break dragging.
  };
  const reset = () => { saved = null; sync(); persist(); };
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || innerWidth <= 900) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width, saved };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('panel-resizing');
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.moved && event.clientX === drag.x) return;
    drag.moved = true;
    // The visible column includes review; only persist the base panel width.
    const extra = panel.getBoundingClientRect().width - baseMeasure.getBoundingClientRect().width;
    saved = clamp(drag.width + event.clientX - drag.x - extra);
    sync();
  });
  const finish = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const active = drag;
    drag = null;
    if (event.type === 'pointercancel') saved = active.saved;
    document.body.classList.remove('panel-resizing');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    sync();
    persist();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish);
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home' || event.key === 'Enter') return reset();
    const width = baseMeasure.getBoundingClientRect().width;
    saved = clamp(event.key === 'End' ? bounds().max : width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10));
    sync();
    persist();
  });
  new ResizeObserver(sync).observe(panel);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['lang'] });
  window.addEventListener('resize', sync);
  sync();
}
