import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
const diag = await import('../../public/js/diag.js');
const nai = await import('../../public/js/nai.js');
const { state } = await import('../../public/js/store.js');
const body = { input: 'prompt SECRET', model: 'mock', parameters: {} };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const hang = (_, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));

test('diagnostics keep 200 entries, persist a versioned envelope and recover unfinished requests after reload', async () => {
  for (let i = 0; i < 205; i++) diag.begin({ kind: 'image', method: 'POST', path: '/generate?secret=pst-MOCK', body, authorization: 'pst-MOCK' }).end('ok');
  diag.begin({ kind: 'api', method: 'GET', path: '/pending' });
  diag.flush();
  assert.equal(diag.entries().length, 200);
  const saved = JSON.parse(storage.get('nf.diag'));
  assert.equal(saved.v, 1);
  assert.equal(saved.data.length, 200);
  assert.doesNotMatch(JSON.stringify(saved), /pst-MOCK|prompt SECRET|authorization|secret=/);
  const restored = await import('../../public/js/diag.js?reload');
  assert.equal(restored.entries().length, 200);
  assert.equal(restored.entries().at(-1).outcome, 'unknown');
  assert.equal(restored.entries().at(-1).path, '/pending');
});

test('redaction runs before truncation and strips credentials, URL userinfo/query and long base64', () => {
  const raw = `pst-SECRET sk-SECRET Bearer OTHERKEY https://alice:password@example.test/v1?key=HIDDEN ${'YWJj'.repeat(80)}`;
  const clean = diag.redact(raw);
  assert.doesNotMatch(clean, /SECRET|OTHERKEY|alice|password|HIDDEN|YWJj/);
  assert.match(clean, /example.test\/v1/);
  assert.equal(diag.redact('x '.repeat(500)).length, 300);
  assert.equal(diag.pathOnly('https://user:pass@example.test/path?token=SECRET'), '/path');
});

test('nai records each request once with success, HTTP, unknown, watchdog, cancellation and network outcomes', async (t) => {
  const original = fetch, limits = { ...nai.TIMEOUTS };
  t.after(() => { globalThis.fetch = original; Object.assign(nai.TIMEOUTS, limits); diag.flush(); });
  Object.assign(nai.TIMEOUTS, { probe: 25, headers: 25, idle: 25 });
  state.settings.token = 'pst-MOCK'; state.settings.conn = 'direct';
  const cases = [
    ['ok', async () => new Response(png), () => nai.generate(body)],
    ['http-error', async () => new Response('prompt SECRET pst-MOCK', { status: 400 }), () => nai.generate(body)],
    ['unknown', async () => { throw new Error('Bearer OTHERKEY pst-MOCK'); }, () => nai.generate(body)],
    ['unknown', async () => new Response('{"outcome":"unknown","message":"prompt SECRET"}', { status: 502 }), () => nai.generate(body)],
    ['http-error', async () => new Response('{}', { status: 502, headers: { 'x-nf-outcome': 'not-sent' } }), () => nai.generate(body)],
    ['timeout-headers', hang, () => nai.generate(body)],
    ['timeout-idle', async () => new Response(new ReadableStream({ start(c) { c.enqueue(png); } })), () => nai.generate(body)],
    ['timeout-idle', async () => new Response(new ReadableStream({ start() {} }), { status: 400 }), () => nai.generate(body)],
    ['unknown', async () => new Response(new ReadableStream({ start(c) { c.error(new Error('reset')); } })), () => nai.generate(body)],
    ['network', async () => { throw new Error('offline'); }, () => nai.subscription()],
    ['aborted', hang, () => { const c = new AbortController(); setTimeout(() => c.abort(), 5); return nai.generate(body, { signal: c.signal }); }],
    ['aborted', async () => new Response(new ReadableStream({ start() {} })), () => { const c = new AbortController(); setTimeout(() => c.abort(), 5); return nai.generate(body, { signal: c.signal }); }],
    ['aborted', hang, () => { const c = new AbortController(); c.abort(); return nai.generate(body, { signal: c.signal }); }],
  ];
  for (const [outcome, stub, operation] of cases) {
    const previous = diag.entries().at(-1)?.id;
    globalThis.fetch = stub;
    if (outcome === 'ok') await operation(); else await assert.rejects(operation());
    const next = diag.entries(), index = next.findIndex((r) => r.id === previous);
    const added = next.slice(index + 1);
    assert.equal(added.length, 1, outcome);
    assert.equal(added[0].outcome, outcome);
    assert.equal(added[0].path, outcome === 'network' ? '/user/subscription' : '/ai/generate-image');
    assert.ok(added[0].tEnd >= 0);
    assert.doesNotMatch(JSON.stringify(added), /pst-MOCK|OTHERKEY|prompt SECRET/);
  }
  // Route selection logs both the timed-out direct probe and the successful proxy probe.
  state.settings.conn = 'auto';
  globalThis.fetch = async () => new Response('{"ok":true}');
  await nai.probeProxy();
  const previous = diag.entries().at(-1).id;
  globalThis.fetch = (url, opts) => url.startsWith('https:') ? hang(url, opts) : Promise.resolve(new Response(opts.method === 'GET' ? '{}' : png));
  await nai.generate(body);
  const next = diag.entries(), added = next.slice(next.findIndex((r) => r.id === previous) + 1);
  assert.deepEqual(added.map((r) => [!!r.probe, r.route, r.outcome]), [[true, 'direct', 'timeout-headers'], [true, 'proxy', 'ok'], [false, 'proxy', 'ok']]);
});

test('generateStream records decoded first-frame time and downloaded bytes', async (t) => {
  const original = fetch; t.after(() => { globalThis.fetch = original; });
  state.settings.conn = 'direct';
  const str = (s) => [0xa0 + s.length, ...new TextEncoder().encode(s)];
  const payload = new Uint8Array([0x82, ...str('event_type'), ...str('final'), ...str('image'), 0xc4, png.length, ...png]);
  const frame = new Uint8Array(payload.length + 4);
  new DataView(frame.buffer).setUint32(0, payload.length); frame.set(payload, 4);
  globalThis.fetch = async () => new Response(frame);
  assert.equal((await nai.generateStream(body)).length, 1);
  const row = diag.entries().at(-1);
  assert.equal(row.outcome, 'ok'); assert.equal(row.stream, true);
  assert.ok(row.tFirstFrame >= row.tHeaders); assert.equal(row.bytes, frame.length);
});

test('LLM logs requests separately and never logs upstream error content or base credentials', async (t) => {
  const { chatEx } = await import('../../public/js/llm.js');
  const original = fetch; t.after(() => { globalThis.fetch = original; });
  state.settings.llm = { base: 'https://alice:password@mock.invalid/v1?key=SECRET', key: 'sk-MOCK', model: 'mock' };
  state.session.proxy = false;
  globalThis.fetch = async () => new Response('{"message":"prompt SECRET sk-MOCK"}', { status: 401 });
  await assert.rejects(chatEx([{ role: 'user', content: 'prompt SECRET' }]));
  const row = diag.entries().at(-1);
  assert.equal(row.kind, 'llm'); assert.equal(row.route, 'llm-direct'); assert.equal(row.outcome, 'http-error');
  assert.doesNotMatch(JSON.stringify(row), /SECRET|sk-MOCK|alice|password/);
});

test('export is an explicit metadata allowlist and works when the local server is unavailable', async (t) => {
  const original = fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => new Response(JSON.stringify(url === '/proxy/health'
    ? { version: '1.8.5', upstreamProxy: 'http://alice:password@127.0.0.1:7890', token: 'pst-MOCK' }
    : [{ target: 'llm', path: '/chat/completions?key=SECRET', host: 'alice:password@localhost:1234', outcome: 'unknown', body: 'prompt SECRET', authorization: 'pst-MOCK', error: 'sk-MOCK' }]));
  const report = await diag.exportReport({ pageVersion: '1.8.5', mode: 'direct', identity: 'browser-token', token: 'pst-MOCK' });
  assert.equal(report.server.upstreamProxy, '127.0.0.1:7890');
  assert.equal(report.serverLogs[0].host, 'localhost:1234');
  assert.doesNotMatch(JSON.stringify(report), /pst-MOCK|sk-MOCK|SECRET|alice|password|authorization/);
  globalThis.fetch = async () => { throw new Error('offline'); };
  const offline = await diag.exportReport();
  assert.equal(offline.server, null); assert.equal(offline.serverLogs, null);
  assert.ok(offline.frontend.length > 0);
});

test('callback/persistence events are sanitized; failed diagnostic writes cannot recurse', async () => {
  diag.flush();
  const events = new EventTarget(), document = new EventTarget();
  const originalDoc = globalThis.document, originalAdd = globalThis.addEventListener;
  globalThis.document = document;
  globalThis.addEventListener = events.addEventListener.bind(events);
  try {
    const isolated = await import('../../public/js/diag.js?events');
    events.dispatchEvent(new CustomEvent('nf:callback-error', { detail: { message: 'Bearer SECRET sk-MOCK' } }));
    document.dispatchEvent(new CustomEvent('nf:persist-error', { detail: { operation: 'write', key: 'nf.settings', error: 'QuotaExceededError' } }));
    assert.deepEqual(isolated.entries().slice(-2).map((r) => r.event), ['nf:callback-error', 'nf:persist-error']);
    assert.doesNotMatch(JSON.stringify(isolated.entries().slice(-2)), /SECRET|sk-MOCK/);
    const set = localStorage.setItem; let writes = 0;
    localStorage.setItem = () => { writes++; throw new DOMException('full', 'QuotaExceededError'); };
    try {
      isolated.flush(); await new Promise((r) => setTimeout(r, 150));
      assert.equal(writes, 1);
      assert.match(isolated.entries().at(-1).error, /nf.diag/);
    } finally { localStorage.setItem = set; }
  } finally { globalThis.document = originalDoc; globalThis.addEventListener = originalAdd; }
});
