// F12: real IndexedDB transactions must settle at commit/abort, not request success.
export default async ({ page, url, assert, log }) => {
  // Keep the application from writing to the database while fault injection is active.
  await page.goto(url + 'css/base.css', 100);
  for (const scenario of ['success', 'request-error', 'success-then-abort', 'closed', 'versionchange', 'close-event', 'open-failure', 'list-abort', 'sync-error']) {
    const result = await page.run(async (scenario) => {
      const factory = indexedDB;
      const originalOpen = factory.open;
      const originalPut = IDBObjectStore.prototype.put;
      const originalCursor = IDBIndex.prototype.openCursor;
      const name = 'nf-db-spec-' + crypto.randomUUID();
      const connections = [];
      let opens = 0;
      let injectOpenFailure = scenario === 'open-failure';
      factory.open = function (_name, version) {
        opens++;
        const requestedVersion = injectOpenFailure ? 0.5 : version;
        injectOpenFailure = false;
        const req = originalOpen.call(factory, name, requestedVersion);
        req.addEventListener('success', () => connections.push(req.result));
        return req;
      };
      const bounded = async (promise) => {
        let timer;
        try {
          return await Promise.race([
            promise.then((value) => ({ state: 'resolved', value }), (error) => ({ state: 'rejected', name: error?.name })),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ state: 'timeout' }), 1500); }),
          ]);
        } finally { clearTimeout(timer); }
      };
      const requestDone = (req) => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('cleanup blocked'));
      });
      try {
        if (scenario === 'open-failure') {
          const existing = await requestDone(originalOpen.call(factory, name, 2));
          existing.close();
          // Keep a valid version on retry by deleting the pre-existing v2 database.
        }
        const { images, kv } = await import('/js/db.js?f12=' + name);
        const rec = { id: 'one', createdAt: 1, blob: new Blob(['image']), thumb: new Blob(['thumb']) };
        if (scenario === 'open-failure') {
          // version=0.5 is coerced to 0 and throws TypeError synchronously; also test
          // the asynchronous VersionError through the ordinary version=1 open below.
          const syncFailure = await bounded(kv.get('x'));
          const asyncFailure = await bounded(kv.get('x'));
          await requestDone(factory.deleteDatabase(name));
          const retry = await bounded(kv.set('x', 42));
          return { syncFailure, asyncFailure, retry, opens };
        }
        await images.put(rec);
        if (scenario === 'success') {
          const write = await bounded(kv.set('x', 42));
          const value = await bounded(kv.get('x'));
          const list = await bounded(images.list());
          return { write, value, list, opens };
        }
        if (scenario === 'request-error') {
          IDBObjectStore.prototype.put = function (...args) {
            // add() against an existing primary key causes an asynchronous ConstraintError.
            return this.name === 'images' ? this.add(...args) : originalPut.apply(this, args);
          };
          const failure = await bounded(images.put(rec));
          IDBObjectStore.prototype.put = originalPut;
          return { failure, recovery: await bounded(images.get('one')) };
        }
        if (scenario === 'success-then-abort') {
          IDBObjectStore.prototype.put = function (...args) {
            const req = originalPut.apply(this, args);
            req.addEventListener('success', () => this.transaction.abort());
            return req;
          };
          const failure = await bounded(images.put({ ...rec, id: 'aborted' }));
          IDBObjectStore.prototype.put = originalPut;
          return { failure, rolledBack: (await images.get('aborted')) === undefined };
        }
        if (scenario === 'sync-error') {
          const failure = await bounded(kv.set('bad', () => {}));
          return { failure, recovery: await bounded(kv.set('good', 42)) };
        }
        if (scenario === 'list-abort') {
          IDBIndex.prototype.openCursor = function (...args) {
            const req = originalCursor.apply(this, args);
            req.addEventListener('success', () => { if (!req.result) this.objectStore.transaction.abort(); });
            return req;
          };
          return { failure: await bounded(images.list()) };
        }
        if (scenario === 'closed') connections.at(-1).close();
        if (scenario === 'close-event') {
          connections.at(-1).close();
          // Explicit close emits no event. Dispatch the forced-close notification separately.
          connections.at(-1).dispatchEvent(new Event('close'));
        }
        if (scenario === 'versionchange') await requestDone(factory.deleteDatabase(name));
        return { recovery: await bounded(kv.set('reopened', true)), value: await kv.get('reopened'), opens };
      } finally {
        factory.open = originalOpen;
        IDBObjectStore.prototype.put = originalPut;
        IDBIndex.prototype.openCursor = originalCursor;
        for (const db of connections) db.close();
        await requestDone(factory.deleteDatabase(name));
      }
    }, scenario);
    if (scenario === 'success') {
      assert.equal(result.write.state, 'resolved');
      assert.deepEqual(result.value, { state: 'resolved', value: 42 });
      assert.equal(result.list.state, 'resolved');
      assert.equal(result.list.value.length, 1);
      assert.equal(result.list.value[0].bytes, 10);
      assert.equal('blob' in result.list.value[0], false);
    } else if (scenario === 'request-error') {
      assert.deepEqual(result.failure, { state: 'rejected', name: 'ConstraintError' });
      assert.equal(result.recovery.state, 'resolved');
    } else if (scenario === 'success-then-abort' || scenario === 'list-abort') {
      assert.deepEqual(result.failure, { state: 'rejected', name: 'AbortError' });
      if (scenario === 'success-then-abort') assert.equal(result.rolledBack, true);
    } else if (scenario === 'open-failure') {
      assert.deepEqual(result.syncFailure, { state: 'rejected', name: 'TypeError' });
      assert.deepEqual(result.asyncFailure, { state: 'rejected', name: 'VersionError' });
      assert.equal(result.retry.state, 'resolved');
      assert.equal(result.opens, 3);
    } else if (scenario === 'sync-error') {
      assert.deepEqual(result.failure, { state: 'rejected', name: 'DataCloneError' });
      assert.equal(result.recovery.state, 'resolved');
    } else {
      assert.equal(result.recovery.state, 'resolved');
      assert.equal(result.value, true);
      assert.equal(result.opens, 2, 'stale connection was replaced');
    }
    log('F12 ' + scenario + ': settled within 1500ms');
  }
};
