export const options = { init: [`
  if (!sessionStorage.getItem('persist-seeded')) {
    localStorage.setItem('nf.settings', JSON.stringify({lang:'en', theme:'dusk', autoCount:7}));
    localStorage.setItem('nf.params', JSON.stringify({prompt:'legacy 雨夜', seed:'42', scale:5}));
    sessionStorage.setItem('persist-seeded', '1');
  }
`] };

export default async ({ page, assert }) => {
  const initial = await page.run(async () => {
    const { state } = await import('/js/store.js');
    return { settings: JSON.parse(localStorage.getItem('nf.settings')), params: JSON.parse(localStorage.getItem('nf.params')),
      values: [state.settings.lang, state.settings.theme, state.settings.autoCount, state.params.prompt, state.params.seed, state.params.scale] };
  });
  assert.deepEqual(initial.values, ['en', 'dusk', 7, 'legacy 雨夜', '42', 5]);
  assert.equal(initial.settings.v, 2); // settings are at schema v2 (1.6.2 text-size default)
  assert.equal(initial.params.v, 1);
  assert.deepEqual(initial.settings.data, { lang: 'en', theme: 'dusk', autoCount: 7, fontScale: 's85' });
  assert.deepEqual(initial.params.data, { prompt: 'legacy 雨夜', seed: '42', scale: 5 });

  const migration = await page.run(async () => {
    const { kv } = await import('/js/db.js');
    const q = await import('/js/queue.js');
    const { state } = await import('/js/store.js');
    const job = { id: 'legacy', no: 1, kind: 'batch', count: 3, done: 1, status: 'running', createdAt: 1,
      seeds: [42], recs: ['rec'], snap: { params: structuredClone(state.params) }, seedMode: 'fixed', seedFrom: null, freeOnly: true };
    const legacy = { seq: 1, jobs: [job], history: [] };
    await kv.setRaw('queue', legacy);
    await q.loadQueue();
    const raw = await kv.getRaw('queue');
    await kv.setRaw('refs', { vibes: [], refs: [] });
    await kv.setRaw('xyGrids', [{ id: 'grid', cells: {} }]);
    await kv.setRaw('promptLog', [{ id: 'prompt', prompt: 'cat', uc: '', chars: [], recs: [] }]);
    for (const key of ['refs', 'xyGrids', 'promptLog']) await kv.get(key);
    return { legacy, raw, status: q.headJob().status,
      versions: await Promise.all(['refs', 'xyGrids', 'promptLog'].map(async (key) => (await kv.getRaw(key)).v)) };
  });
  assert.deepEqual(migration.raw, { v: 1, data: migration.legacy });
  assert.equal(migration.status, 'paused', 'recovery pauses the in-memory running job');
  assert.deepEqual(migration.versions, [1, 1, 1]);

  const corruption = await page.run(async () => {
    const { kv } = await import('/js/db.js');
    const { hydrate, state } = await import('/js/store.js');
    const q = await import('/js/queue.js');
    const events = [];
    document.addEventListener('nf:persist-error', (e) => events.push(e.detail));
    localStorage.setItem('nf.settings', '{broken');
    localStorage.setItem('nf.params', JSON.stringify({ scale: 'broken' }));
    await kv.setRaw('queue', { v: 1, data: { jobs: 'broken' } });
    await hydrate();
    await q.loadQueue();
    const backups = {};
    for (const event of events.filter((e) => e.backupKey)) backups[event.key] = event.key.startsWith('nf.')
      ? localStorage.getItem(event.backupKey) : await kv.getRaw(event.backupKey);
    return { events, backups, queue: q.queueJobs(), theme: state.settings.theme };
  });
  assert.equal(corruption.backups['nf.settings'], '{broken');
  assert.deepEqual(JSON.parse(corruption.backups['nf.params']), { scale: 'broken' });
  assert.deepEqual(corruption.backups.queue, { v: 1, data: { jobs: 'broken' } });
  assert.equal(corruption.events.filter((e) => e.operation === 'validate').length, 3);
  assert.deepEqual(corruption.queue, []);
  assert.equal(corruption.theme, 'ink');

  const failure = await page.run(async () => {
    const { kv } = await import('/js/db.js');
    const q = await import('/js/queue.js');
    const { state } = await import('/js/store.js');
    const original = kv.updateRaw;
    let reported = false;
    const observe = (e) => { if (e.detail.key === 'queue' && e.detail.operation === 'write') reported = true; };
    document.addEventListener('nf:persist-error', observe);
    kv.updateRaw = async () => { throw new DOMException('test quota', 'QuotaExceededError'); };
    try {
      q.enqueue({ params: structuredClone(state.params) }, { count: 1 });
      for (let i = 0; i < 50 && !reported; i++) await new Promise((r) => setTimeout(r, 20));
      return reported;
    } finally { kv.updateRaw = original; document.removeEventListener('nf:persist-error', observe); }
  });
  assert.equal(failure, true, 'queue write errors reach the UI event boundary');
};
