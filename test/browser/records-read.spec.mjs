export default async ({ page, assert }) => {
  await page.waitFor("document.querySelector('.arch-empty')");
  const empty = await page.run(async () => {
    const records = await import('/js/app/records.js');
    const { setLang } = await import('/js/i18n.js');
    setLang('en');
    const events = [];
    const observe = (e) => events.push(e.detail);
    document.addEventListener('nf:persist-error', observe);
    try {
      await records.loadRecords();
      return { count: records.history.length, events, text: document.querySelector('.arch-empty')?.textContent };
    } finally { document.removeEventListener('nf:persist-error', observe); }
  });
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.events, []);
  assert.equal(empty.text, 'NOTHING YET');

  const failure = await page.run(async () => {
    const { images } = await import('/js/db.js');
    const records = await import('/js/app/records.js');
    const original = images.list, events = [];
    const observe = (e) => events.push(e.detail);
    document.addEventListener('nf:persist-error', observe);
    try {
      // Last successfully read archive must survive a later read failure.
      images.list = async () => [{ id: 'previous', no: 1 }];
      await records.loadRecords();
      images.list = async () => { throw new DOMException('injected archive read failure', 'UnknownError'); };
      await records.loadRecords();
      return { ids: records.history.map((r) => r.id), events };
    } finally {
      images.list = original;
      document.removeEventListener('nf:persist-error', observe);
      await records.loadRecords();
    }
  });
  assert.deepEqual(failure.ids, ['previous']);
  assert.deepEqual(failure.events, [{ key: 'images', operation: 'read', error: 'UnknownError', backupKey: null }]);
  await page.waitFor("[...document.querySelectorAll('.toast')].some((e) => e.textContent.includes('images') && e.textContent.includes('could not be read'))");
  assert.equal(await page.run(() => document.querySelector('.arch-empty')?.textContent), 'NOTHING YET');
};
