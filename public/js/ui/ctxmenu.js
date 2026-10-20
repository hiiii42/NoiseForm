// Small right-click menu. openMenu(x, y, items): items = [{ label, icon?, hint?, run, danger?, disabled? } | '-'].
// Closes on outside pointerdown, Esc, Tab, scroll, resize or after an item runs.
import { h, icon } from '../util.js';

let cur = null;
export function closeMenu() {
  if (!cur) return;
  cur.off();
  cur.el.remove();
  const trigger = cur.trigger;
  cur = null;
  const target = trigger?.isConnected && !trigger.matches(':disabled') && !trigger.closest('[inert]') &&
    (trigger.tabIndex >= 0 || trigger.hasAttribute('tabindex') || trigger.isContentEditable) &&
    trigger.getClientRects().length && getComputedStyle(trigger).visibility === 'visible'
    ? trigger : document.body;
  const oldTabindex = target.getAttribute('tabindex');
  if (target === document.body) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  if (target === document.body) {
    if (oldTabindex === null) target.removeAttribute('tabindex');
    else target.setAttribute('tabindex', oldTabindex);
  }
}
export function openMenu(x, y, items) {
  // Right-clicking does not focus the target in every browser (notably non-controls).
  const eventTarget = window.event?.type === 'contextmenu' ? window.event.target : null;
  const trigger = eventTarget
    ? eventTarget.closest('button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]')
    : (cur?.trigger || document.activeElement);
  closeMenu();
  const buttons = [];
  const el = h(
    'div',
    { class: 'ctx-menu', role: 'menu' },
    ...items.map((it) => {
      if (it === '-') return h('div', { class: 'ctx-sep', role: 'separator' });
      const b = h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          class: 'ctx-item' + (it.danger ? ' danger' : '') + (it.on ? ' on' : ''),
          disabled: !!it.disabled,
          onclick: () => {
            closeMenu();
            it.run();
          },
        },
        it.icon ? icon(it.icon) : h('i', { class: 'ctx-ic' }),
        h('span', {}, it.label),
        it.hint ? h('kbd', {}, it.hint) : null
      );
      buttons.push(b);
      return b;
    })
  );
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  el.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  const outside = (e) => !el.contains(e.target) && closeMenu();
  const key = (e) => {
    if (e.key === 'Escape' || e.key === 'Tab') return e.preventDefault(), e.stopImmediatePropagation(), closeMenu();
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const live = buttons.filter((b) => !b.disabled);
      const i = live.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? live.length - 1
        : (i + (e.key === 'ArrowDown' ? 1 : -1) + live.length) % live.length;
      live[next]?.focus({ preventScroll: true });
    }
  };
  const gone = (e) => !(e?.target instanceof Node && el.contains(e.target)) && closeMenu();
  const outsideTimer = setTimeout(() => document.addEventListener('pointerdown', outside, true));
  document.addEventListener('keydown', key, true);
  // a scroll event already queued when the menu opens (e.g. from the click that led here) must not close it
  const scrollTimer = setTimeout(() => {
    addEventListener('resize', gone);
    document.addEventListener('scroll', gone, true);
  }, 120);
  cur = {
    el,
    trigger,
    off: () => {
      clearTimeout(outsideTimer);
      clearTimeout(scrollTimer);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      removeEventListener('resize', gone);
      document.removeEventListener('scroll', gone, true);
    },
  };
  buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
  return el;
}
