// V5 character centers: a lightweight layer over the current stage, no image copies.
import { $, h } from '../util.js';
import { state, set, on, emit } from '../store.js';
import { CHAR_COLORS, modelById, posClamp, posTitle } from '../data.js';
import { t } from '../i18n.js';

let active = null;

export function openCharPositions(character) {
  active?.close();
  const stage = $('#stage');
  const P = state.params;
  if (!stage || !modelById(P.model).v5) return;
  const previous = document.activeElement;
  set('params.aiChoice', false);
  let selected = character?.id;
  let drag = null;
  let closed = false;
  const events = new AbortController();
  const { signal } = events;
  const tabs = h('div', { class: 'charpos-tabs', role: 'tablist', 'aria-label': () => t('char.positions') });
  const board = h('div', { class: 'charpos-board', role: 'group', 'aria-label': () => t('char.positions') });
  const done = h('button', { class: 'btn solid charpos-done', type: 'button', onclick: () => close() }, () => t('char.positionDone'));
  const root = h('div', { class: 'charpos', role: 'dialog', tabindex: '-1', 'aria-label': () => t('char.positions') }, board, tabs, done);
  const entries = new Map();
  const enabled = () => P.characters.filter((c) => c.enabled);
  const choose = (id) => { selected = id; paint(); };
  function paint() {
    const chars = enabled();
    if (!chars.some((c) => c.id === selected)) selected = chars[0]?.id;
    for (const [id, entry] of entries) if (!chars.some((c) => c.id === id)) {
      entry.tab.remove(); entry.marker.remove(); entries.delete(id);
    }
    for (const c of chars) {
      const n = P.characters.indexOf(c) + 1;
      const color = CHAR_COLORS[(n - 1) % CHAR_COLORS.length];
      let entry = entries.get(c.id);
      if (!entry) {
        const tab = h('button', { type: 'button', role: 'tab', onclick: () => choose(c.id) });
        const marker = h('button', { type: 'button', class: 'charpos-marker', 'data-character-id': c.id, onfocus: () => choose(c.id), onclick: () => choose(c.id) });
        entries.set(c.id, entry = { tab, marker });
      }
      const { tab, marker } = entry;
      // Reappend only when order changed: focused/captured markers must stay mounted.
      if (tabs.children[chars.indexOf(c)] !== tab) tabs.append(tab);
      if (board.children[chars.indexOf(c)] !== marker) board.append(marker);
      tab.textContent = `C${n} ${(c.prompt || '').split(/[,\n]/)[0].trim().slice(0, 36)}`.trim();
      tab.title = c.prompt || `C${n}`;
      tab.style.setProperty('--cc', color);
      tab.setAttribute('aria-selected', String(c.id === selected));
      tab.tabIndex = c.id === selected ? 0 : -1;
      marker.textContent = n;
      marker.style.setProperty('--cc', color);
      marker.style.left = posClamp(c.x) * 100 + '%';
      marker.style.top = posClamp(c.y) * 100 + '%';
      marker.classList.toggle('on', c.id === selected);
      marker.setAttribute('aria-pressed', String(c.id === selected));
      marker.setAttribute('aria-label', t('char.positionMarker', { n, position: posTitle(c.x, c.y) }));
      marker.title = posTitle(c.x, c.y);
    }
  }
  function move(x, y) {
    const c = enabled().find((c) => c.id === selected);
    if (!c) return;
    const nextX = posClamp(x), nextY = posClamp(y);
    if (c.x === nextX && c.y === nextY) return;
    c.x = nextX; c.y = nextY;
    emit('params.characters');
  }
  function point(e) {
    const r = board.getBoundingClientRect();
    if (r.width && r.height) move((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }
  board.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault(); e.stopPropagation();
    const marker = e.target.closest('.charpos-marker');
    if (marker) choose(marker.dataset.characterId);
    if (!selected) return;
    drag = e.pointerId;
    board.setPointerCapture(e.pointerId);
    root.focus({ preventScroll: true });
    // Grabbing a marker selects it without jumping its center to the grab offset.
    if (!marker) point(e);
  }, { signal });
  board.addEventListener('pointermove', (e) => { if (drag === e.pointerId) point(e); }, { signal });
  const endDrag = (e) => {
    if (drag !== e.pointerId) return;
    drag = null;
    if (board.hasPointerCapture(e.pointerId)) board.releasePointerCapture(e.pointerId);
  };
  board.addEventListener('pointerup', endDrag, { signal });
  board.addEventListener('pointercancel', endDrag, { signal });
  board.addEventListener('lostpointercapture', () => { drag = null; }, { signal });
  root.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false, signal });
  root.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  window.addEventListener('keydown', (e) => {
    // A settings dialog opened above the stage keeps ownership of Escape and focus.
    if (e.target.closest?.('.modal-bg, .lightbox, .ctx-menu')) return;
    if (!root.contains(document.activeElement) && e.key !== 'Escape') return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (delta && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const c = enabled().find((c) => c.id === selected);
      const step = e.shiftKey ? 0.05 : 0.01;
      if (c) move(posClamp(c.x) + delta[0] * step, posClamp(c.y) + delta[1] * step);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const stops = [...root.querySelectorAll('button')].filter((el) => el.tabIndex >= 0);
      const i = stops.indexOf(document.activeElement);
      const next = i < 0 ? (e.shiftKey ? stops.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
      (stops[next] || root).focus({ preventScroll: true });
    }
    // The stage's S/F/X shortcuts must not run while adjusting a character.
    e.stopImmediatePropagation();
  }, { capture: true, signal });

  function layout() {
    if (closed) return;
    const r = root.getBoundingClientRect();
    const img = $('#view:not([hidden]) .frame-in img');
    const imageRect = img?.getBoundingClientRect();
    const hasImage = imageRect?.width > 0 && imageRect?.height > 0 && img.complete && img.naturalWidth;
    board.classList.toggle('empty', !hasImage);
    let left, top, width, height;
    if (hasImage) {
      ({ width, height } = imageRect);
      left = imageRect.left - r.left; top = imageRect.top - r.top;
    } else {
      const ratio = Math.max(1, Number(P.width) || 832) / Math.max(1, Number(P.height) || 1216);
      const availableW = Math.max(1, r.width - 48);
      const availableH = Math.max(1, r.height - tabs.offsetHeight - done.offsetHeight - 72);
      width = Math.min(availableW, availableH * ratio); height = width / ratio;
      left = (r.width - width) / 2;
      top = tabs.offsetHeight + 28 + (availableH - height) / 2;
    }
    Object.assign(board.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  }
  function close() {
    if (closed) return;
    closed = true;
    events.abort(); unsubscribe(); resize.disconnect(); observer.disconnect();
    root.remove(); active = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }
  stage.append(root);
  const resize = new ResizeObserver(layout);
  resize.observe(stage); resize.observe(tabs);
  const observer = new MutationObserver(layout);
  const view = $('#view');
  if (view) observer.observe(view, { subtree: true, childList: true, attributes: true });
  stage.addEventListener('load', layout, { capture: true, signal });
  window.addEventListener('resize', layout, { signal });
  const unsubscribe = on(['params', 'settings.lang'], () => {
    if (!modelById(P.model).v5 || P.aiChoice) return close();
    paint(); layout();
  });
  active = { close };
  paint(); layout();
  root.focus({ preventScroll: true });
  return active;
}
