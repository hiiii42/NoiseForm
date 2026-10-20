// Modal shell, confirm dialog, toasts, lightbox.
import { $, h, icon } from '../util.js';
import { t } from '../i18n.js';
import { on } from '../store.js';

let openCount = 0;
let dialogId = 0;
const focusStack = [];
const focusable = 'button, input, select, textarea, a[href], area[href], summary, iframe, [tabindex], [contenteditable="true"], audio[controls], video[controls]';

function tabStops(el) {
  return [...el.querySelectorAll(focusable)].filter((node) =>
    node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]') &&
    node.getClientRects().length && getComputedStyle(node).visibility === 'visible'
  ).sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

// One stack covers modal-root dialogs and body-mounted lightboxes alike.
function dialogFocus(el, close) {
  const entry = { el, previous: document.activeElement };
  const top = () => focusStack.at(-1) === entry;
  const focusFirst = () => (tabStops(el)[0] || el).focus({ preventScroll: true });
  const onKey = (e) => {
    // Menus own their keys even when all items are disabled and focus stays in the dialog.
    if (!top() || document.querySelector('.ctx-menu')) return;
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      close();
    } else if (e.key === 'Tab') {
      const stops = tabStops(el);
      const i = stops.indexOf(document.activeElement);
      const next = i < 0 ? (e.shiftKey ? stops.length - 1 : 0)
        : (i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
      e.preventDefault();
      e.stopImmediatePropagation();
      (stops[next] || el).focus({ preventScroll: true });
    }
  };
  focusStack.push(entry);
  document.addEventListener('keydown', onKey, true);
  focusFirst();
  return () => {
    const wasTop = top();
    const i = focusStack.indexOf(entry);
    // If a parent is closed first, its child must still return to the original opener.
    for (const child of focusStack.slice(i + 1)) {
      if (el.contains(child.previous)) child.previous = entry.previous;
    }
    focusStack.splice(i, 1);
    document.removeEventListener('keydown', onKey, true);
    if (!wasTop) return;
    const parent = focusStack.at(-1);
    if (entry.previous?.isConnected && (!parent || parent.el.contains(entry.previous))) {
      entry.previous.focus({ preventScroll: true });
    }
    if (parent && !parent.el.contains(document.activeElement)) {
      (tabStops(parent.el)[0] || parent.el).focus({ preventScroll: true });
    }
  };
}

export function openModal({ n = '00', title, sub, accent, size, body, foot, onClose, onLang }) {
  const root = $('#modalRoot');
  const closeBtn = h('button', { class: 'btn ghost sq modal-x', title: () => (t('act.close')) }, icon('close'));
  const titleId = `modal-title-${++dialogId}`;
  const modal = h(
    'div',
    { class: 'modal' + (size ? ' ' + size : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1', style: accent ? { '--sec': accent } : null },
    h('header', { class: 'modal-h' }, h('span', { class: 'sec-n' }, n), h('h2', { class: 'modal-t', id: titleId }, title), sub ? h('span', { class: 'modal-s' }, sub) : null, closeBtn),
    h('div', { class: 'modal-b' }, body),
    foot ? h('footer', { class: 'modal-f' }, foot) : null
  );
  const bg = h('div', { class: 'modal-bg' }, modal);
  let closed = false;
  const unsubscribeLang = onLang ? on('settings.lang', onLang) : () => {};
  const close = (v) => {
    if (closed) return;
    closed = true;
    unsubscribeLang();
    openCount--;
    bg.remove();
    releaseFocus();
    onClose?.(v);
  };
  closeBtn.onclick = () => close();
  bg.addEventListener('mousedown', (e) => {
    if (e.target === bg) close();
  });
  root.append(bg);
  openCount++;
  const releaseFocus = dialogFocus(modal, close);
  return { el: modal, body: modal.querySelector('.modal-b'), close };
}

export const modalOpen = () => openCount > 0;

export function confirmDialog(message, { danger = false, okText } = {}) {
  return new Promise((res) => {
    let result = false;
    const ok = h('button', { class: 'btn solid' + (danger ? ' danger' : '') }, okText || (() => t('act.confirm')));
    const cancel = h('button', { class: 'btn' }, () => (t('act.cancel')));
    const m = openModal({
      n: '!!',
      title: () => t(danger ? 'modal.caution' : 'modal.confirm'),
      accent: danger ? 'var(--neg)' : undefined,
      body: h('p', { class: 'cn', style: { margin: 0, fontSize: 'calc(15px * var(--fz))', lineHeight: 1.65 } }, message),
      foot: [cancel, ok],
      onClose: () => res(result),
    });
    m.el.style.width = 'min(440px, 100%)';
    ok.onclick = () => {
      result = true;
      m.close();
    };
    cancel.onclick = () => m.close();
    ok.focus({ preventScroll: true });
  });
}

export function toast(msg, type = 'ok', ms = 3200, onClick) {
  const el = h('div', { class: 'toast ' + type + (onClick ? ' act' : ''), role: 'status' }, h('i'), h('p', {}, msg));
  $('#toasts').append(el);
  const kill = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  };
  setTimeout(kill, type === 'err' ? Math.max(ms, 6500) : ms);
  el.onclick = () => {
    onClick?.();
    kill();
  };
}

export function lightbox(src) {
  const img = h('img', { src, alt: '' });
  const titleId = `modal-title-${++dialogId}`;
  const title = h('h2', { id: titleId, hidden: true }, () => `${t('tool.view')} · ${t('gen.image')}`);
  const lb = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, title, img);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    lb.remove();
    releaseFocus();
  };
  lb.addEventListener('click', (e) => {
    if (e.target === img && !lb.classList.contains('actual')) {
      lb.classList.add('actual');
      return;
    }
    close();
  });
  document.body.append(lb);
  const releaseFocus = dialogFocus(lb, close);
}
