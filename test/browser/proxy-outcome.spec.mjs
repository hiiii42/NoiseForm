import http from 'node:http';
import { startServer } from './harness.mjs';

export const options = { allowProxy: true };

export default async ({ page, assert, log }) => {
  let mode = 'reset';
  let posts = 0;
  let server;
  const upstream = http.createServer((req, res) => {
    if (req.url.includes('/user/subscription')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tier: 3, active: true, trainingStepsLeft: { fixedTrainingStepsLeft: 100 } }));
      return;
    }
    if (req.method !== 'POST' || !req.url.includes('/ai/generate-image')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"tags":[]}');
      return;
    }
    req.resume();
    req.on('end', () => {
      posts++;
      if (mode === 'reset') return req.socket.destroy();
      if (mode === 'partial') {
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': '100' });
        res.write(Buffer.from('504b030400000000', 'hex'));
        setTimeout(() => res.destroy(), 30);
        return;
      }
      res.writeHead(Number(mode), { 'content-type': 'application/json' });
      res.end('{"message":"ordinary rejection"}');
    });
  });
  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    server = await startServer({ NODE_ENV: 'test', NF_TEST_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`, NF_UPSTREAM_PROXY: 'none' });
    await page.goto(server.url);
    await page.run(async () => {
      const { state } = await import('/js/store.js');
      const nai = await import('/js/nai.js');
      Object.assign(state.settings, { token: 'pst-LOCAL-TEST', conn: 'proxy', autoFreeOnly: false, stream: false });
      await nai.probeProxy();
      state.session.live = true;
      Object.assign(state.params, { prompt: 'local proxy outcome regression', seed: '' });
      window.proxyJob = (await import('/js/queue.js')).enqueue({ params: structuredClone(state.params), base: null, refs: [], vibes: [] }, { count: 1, start: true });
    });
    await page.waitFor("['paused','failed'].includes(window.proxyJob.status) && import('/js/queue.js').then(q=>!q.queueRunning())");
    assert.equal(posts, 1, 'accepted POST must never be replayed');
    assert.deepEqual(await page.run(() => ({ status: window.proxyJob.status, stage: window.proxyJob.stage, done: window.proxyJob.done })), { status: 'paused', stage: 'unknown', done: 0 });
    await page.wait(1700); // longer than the normal retry delay
    assert.equal(posts, 1);
    log('real local upstream: count=1 paused as unknown after exactly one accepted POST');

    const beforeAuto = posts;
    await page.run(async () => {
      const { state } = await import('/js/store.js');
      state.settings.autoMode = 'change';
      state.settings.autoCount = 1;
      await (await import('/js/auto.js')).startAuto();
    });
    assert.equal(posts, beforeAuto + 1, 'auto stops immediately on unknown');
    assert.equal(await page.eval("import('/js/auto.js').then(a=>a.autoRunning())"), false);

    mode = 'partial';
    for (const stream of [false, true]) {
      const result = await page.run(async (stream) => {
        const nai = await import('/js/nai.js');
        const started = performance.now();
        try {
          await (stream ? nai.generateStream : nai.generate)({ parameters: {} });
          return { returned: true };
        } catch (err) {
          return { unknown: err instanceof nai.UnknownResultError && err.unknown, elapsed: performance.now() - started };
        }
      }, stream);
      assert.equal(result.unknown, true, JSON.stringify(result));
      assert.ok(result.elapsed < 1000, `truncated response settled in ${result.elapsed}ms`);
    }
    log('truncated generate and generateStream reads both become UnknownResultError within one second');

    for (const status of [400, 401, 402, 403, 429]) {
      mode = String(status);
      const result = await page.run(async () => {
        const nai = await import('/js/nai.js');
        try { await nai.generate({}); } catch (err) { return { status: err.status, ordinary: err instanceof nai.ApiError && !err.unknown }; }
      });
      assert.deepEqual(result, { status, ordinary: true });
    }
    // Either machine-readable signal suffices, even if an intermediary loses the other.
    const signals = await page.run(async () => {
      const nai = await import('/js/nai.js');
      const original = window.fetch;
      const results = [];
      try {
        for (const marker of ['header', 'json', 'header-broken-body']) {
          window.fetch = async () => new Response(marker === 'header-broken-body'
            ? new ReadableStream({ start(c) { c.error(new TypeError('truncated error body')); } })
            : JSON.stringify(marker === 'json' ? { outcome: 'unknown' } : { message: 'transport failure' }), {
              status: 502, headers: marker.startsWith('header') ? { 'x-nf-outcome': 'unknown' } : {},
            });
          try { await nai.generate({}); } catch (err) { results.push(err instanceof nai.UnknownResultError && err.unknown); }
        }
      } finally { window.fetch = original; }
      return results;
    });
    assert.deepEqual(signals, [true, true, true]);

    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    const refused = await page.run(async () => {
      const nai = await import('/js/nai.js');
      try { await nai.generate({}); } catch (err) { return { status: err.status, ordinary: err instanceof nai.ApiError && !err.unknown }; }
    });
    assert.deepEqual(refused, { status: 502, ordinary: true });
    assert.equal(page.blocked.length, 0, 'no remote network attempted');
    assert.equal(page.errors.filter((s) => !s.includes('结果未知') && !s.includes('result is unknown')).length, 0, page.errors.join('\n'));
    page.errors.length = 0; // expected generation errors were checked above
  } finally {
    await server?.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
};
