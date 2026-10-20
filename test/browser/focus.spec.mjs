// Real Chrome keyboard input exercises focus containment and restoration across overlays.
export default async ({ page, assert, log }) => {
  const active = () => page.eval('document.activeElement.id');
  const inside = (selector) => page.run((s) => document.querySelector(s)?.contains(document.activeElement), selector);
  const cycle = async (selector, count = 12) => {
    for (const modifiers of [0, 8]) {
      for (let i = 0; i < count; i++) {
        await page.key('Tab', modifiers);
        assert.equal(await inside(selector), true, `Tab (${modifiers}) stays inside ${selector}`);
      }
    }
  };
  await page.waitFor("document.querySelector('#promptEditor textarea')");
  await page.eval("document.querySelector('#btnSettings').focus()");
  await page.click('#btnSettings');
  assert.equal(await inside('.modal'), true);
  assert.equal(await page.eval(`(() => {
    const m = document.querySelector('.modal');
    return m.role === 'dialog' && m.getAttribute('aria-modal') === 'true' &&
      m.querySelector('.modal-t').id === m.getAttribute('aria-labelledby');
  })()`), true);
  await cycle('.modal', 30);

  // Confirm on top of settings: Escape dismisses only the child, restoring its opener.
  await page.eval(`(async () => {
    const { confirmDialog } = await import('/js/ui/modal.js');
    const opener = document.querySelector('.modal .modal-x');
    opener.id = 'focus-parent-opener'; opener.focus();
    window.focusResult = 'pending';
    confirmDialog('Nested confirmation').then(value => { window.focusResult = value; });
  })()`);
  assert.equal(await page.eval("document.querySelectorAll('.modal').length"), 2);
  assert.equal(await inside('.modal-bg:last-child .modal'), true);
  await cycle('.modal-bg:last-child .modal');
  await page.key('Escape');
  assert.equal(await page.eval('window.focusResult'), false);
  assert.equal(await page.eval("document.querySelectorAll('.modal').length"), 1);
  assert.equal(await active(), 'focus-parent-opener');
  await page.key('Escape');
  assert.equal(await active(), 'btnSettings');
  log('Settings / nested confirm: forward and reverse Tab, ARIA title, Escape and opener restoration');

  await page.eval(`(async () => {
    const { openModal, toast } = await import('/js/ui/modal.js');
    const body = document.createElement('div');
    body.innerHTML = '<button id="focus-first">first</button><button hidden>hidden</button><button disabled>disabled</button><button id="focus-last">last</button>';
    window.focusModal = openModal({ title: 'Focus test', body });
    document.querySelector('#focus-last').focus();
    toast('Does not move focus');
  })()`);
  assert.equal(await active(), 'focus-last', 'toast does not steal focus');
  await page.key('Tab');
  assert.equal(await page.eval("document.activeElement.matches('.modal-x')"), true, 'last wraps to first');
  await page.key('Tab', 8);
  assert.equal(await active(), 'focus-last', 'first wraps to last');
  await page.key('Tab', 8);
  assert.equal(await active(), 'focus-first', 'hidden / disabled controls are skipped');

  await page.eval(`(async () => {
    const { lightbox } = await import('/js/ui/modal.js');
    lightbox('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
  })()`);
  assert.equal(await inside('.lightbox'), true);
  assert.equal(await page.eval(`(() => {
    const lb = document.querySelector('.lightbox');
    return lb.role === 'dialog' && lb.getAttribute('aria-modal') === 'true' &&
      !!document.getElementById(lb.getAttribute('aria-labelledby'))?.textContent;
  })()`), true);
  await cycle('.lightbox', 3);
  await page.key('Escape');
  assert.equal(await active(), 'focus-first');
  assert.equal(await inside('.modal'), true, 'lightbox Escape leaves parent open');
  await page.click('.modal-x');
  assert.equal(await active(), 'btnSettings');

  // No controls: dialog itself is focusable. A removed opener must not throw on close.
  await page.eval(`(async () => {
    const { openModal } = await import('/js/ui/modal.js');
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    const m = openModal({ title: 'Empty', body: 'No controls' });
    m.el.querySelector('.modal-x').remove(); opener.remove(); window.focusModal = m;
  })()`);
  await cycle('.modal', 2);
  assert.equal(await page.eval("document.activeElement.matches('.modal[tabindex=\"-1\"]')"), true);
  await page.key('Escape');
  log('Toast, lightbox nesting, hidden / disabled controls, empty dialog and detached opener');

  // A parent closed out of order must neither steal focus nor break the child's return path.
  await page.eval(`(async () => {
    const { openModal, confirmDialog } = await import('/js/ui/modal.js');
    document.querySelector('#btnSettings').focus();
    const parent = openModal({ title: 'Parent', body: 'Parent' });
    confirmDialog('Child').then(value => { window.focusResult = value; });
    parent.close();
  })()`);
  assert.equal(await inside('.modal'), true);
  await page.click('.modal-f .solid');
  assert.equal(await page.eval('window.focusResult'), true);
  assert.equal(await active(), 'btnSettings');

  // Capture the real contextmenu target, even when another control has keyboard focus.
  await page.eval(`(async () => {
    const { openMenu } = await import('/js/ui/ctxmenu.js');
    const button = document.createElement('button'); button.id = 'focus-menu-trigger'; button.textContent = 'Menu';
    const plain = document.createElement('div'); plain.id = 'focus-menu-plain'; plain.textContent = 'Plain';
    document.body.append(button, plain);
    window.focusMenuItems = [
      { label: 'disabled first', disabled: true },
      { label: 'first', run: () => { window.focusMenuRan = true; } }, '-',
      { label: 'last', run: () => {} }, { label: 'disabled last', disabled: true }
    ];
    for (const el of [button, plain]) el.oncontextmenu = e => {
      e.preventDefault(); openMenu(e.clientX, e.clientY, window.focusMenuItems);
    };
    window.focusOpenMenu = (id = 'focus-menu-trigger') => document.getElementById(id)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    window.focusOpenMenu();
  })()`);
  const label = () => page.eval('document.activeElement.textContent.trim()');
  assert.equal(await label(), 'first');
  assert.equal(await page.eval("[...document.querySelectorAll('.ctx-item')].every(e => e.role === 'menuitem') && document.querySelector('.ctx-sep').role === 'separator'"), true);
  await page.key('End'); assert.equal(await label(), 'last');
  await page.key('Home'); assert.equal(await label(), 'first');
  await page.key('ArrowUp'); assert.equal(await label(), 'last');
  await page.key('ArrowDown'); assert.equal(await label(), 'first');
  await page.key('Tab');
  assert.equal(await page.eval("!!document.querySelector('.ctx-menu')"), false);
  assert.equal(await active(), 'focus-menu-trigger');
  await page.eval('window.focusOpenMenu()');
  await page.key('Tab', 8);
  assert.equal(await active(), 'focus-menu-trigger');
  await page.eval('window.focusOpenMenu()');
  await page.key('Escape');
  assert.equal(await active(), 'focus-menu-trigger');
  await page.eval('window.focusOpenMenu()');
  await page.click('.ctx-item:not(:disabled)');
  assert.equal(await page.eval('window.focusMenuRan'), true);
  assert.equal(await active(), 'focus-menu-trigger');
  await page.eval("window.focusOpenMenu('focus-menu-plain')");
  await page.key('Tab');
  assert.equal(await page.eval('document.activeElement === document.body'), true);
  await page.eval('window.focusOpenMenu(); document.getElementById("focus-menu-trigger").remove()');
  await page.key('Escape');
  assert.equal(await page.eval('document.activeElement === document.body'), true);

  // A menu over a dialog owns Tab / Escape without also closing the parent dialog.
  await page.eval(`(async () => {
    const { openModal } = await import('/js/ui/modal.js');
    const { openMenu } = await import('/js/ui/ctxmenu.js');
    const m = openModal({ title: 'Menu parent', body: 'Menu parent' });
    m.el.querySelector('.modal-x').id = 'focus-menu-parent';
    openMenu(40, 40, window.focusMenuItems);
  })()`);
  await page.key('Tab');
  assert.equal(await active(), 'focus-menu-parent');
  await page.eval("import('/js/ui/ctxmenu.js').then(({openMenu}) => { openMenu(40, 40, window.focusMenuItems); })");
  await page.key('Escape');
  assert.equal(await active(), 'focus-menu-parent');
  assert.equal(await inside('.modal'), true);
  await page.eval("import('/js/ui/ctxmenu.js').then(({openMenu}) => { openMenu(40, 40, [{label: 'disabled', disabled: true}]); })");
  await page.key('End');
  await page.key('Escape');
  assert.equal(await active(), 'focus-menu-parent');
  assert.equal(await inside('.modal'), true, 'disabled-only menu still owns Escape');
  await page.key('Escape');
  log('Menu roles, Home / End / arrows, Tab / Shift+Tab / Escape / click, actual trigger and body fallback');
};
