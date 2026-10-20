import test from 'node:test';
import assert from 'node:assert/strict';
import * as nai from '../../public/js/nai.js';
import { state } from '../../public/js/store.js';

const body = { input: 'mock', model: 'mock', parameters: { seed: 1 } };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const health = () => new Response(JSON.stringify({ ok: true, serverToken: false }));
const unknown = (err) => err.unknown === true && err.status === 0 && /Anlas/.test(err.message);

test('all paid endpoints send one POST after acceptance, never replay on network failure', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const operation of [
    () => nai.generate(body), () => nai.generateStream(body),
    () => nai.encodeVibe('image', 1, 'model'),
    () => nai.upscale('image', 64, 64), () => nai.augment('colorize', 'image', 64, 64),
  ]) {
    state.settings.token = 'pst-MOCK';
    state.settings.conn = 'auto';
    const posts = [], gets = [];
    globalThis.fetch = async (url, opts = {}) => {
      if (url === '/proxy/health') return health();
      if (opts.method === 'GET') { gets.push(url); return new Response('{}'); }
      posts.push(url);
      throw new TypeError('accepted, then disconnected');
    };
    await nai.probeProxy();
    await assert.rejects(operation(), unknown);
    assert.equal(posts.length, 1);
    assert.equal(gets.length, 1);
    assert.match(posts[0], /^https:\/\/image\.novelai\.net/);
  }
});

test('only the read-only probe may fail over before a POST; GET retains failover', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  state.settings.conn = 'auto';
  state.settings.token = 'pst-MOCK';
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (url === '/proxy/health') return health();
    calls.push([url, opts.method]);
    if (url.startsWith('https:')) throw new TypeError('direct route unreachable');
    return opts.method === 'GET' ? new Response('{}') : new Response(png);
  };
  await nai.probeProxy();
  assert.equal((await nai.generate(body)).length, 1);
  assert.equal(calls.filter((c) => c[1] === 'POST').length, 1);
  assert.equal(calls[2][0], '/proxy/image/ai/generate-image');
  await nai.probeProxy();
  calls.length = 0;
  await nai.subscription();
  assert.deepEqual(calls.map((c) => c[1]), ['GET', 'GET']);
});

test('unreachable probes send zero POSTs and pre-aborted operations remain safe to retry', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  state.settings.conn = 'auto';
  let posts = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (url === '/proxy/health') return health();
    if (opts.method === 'POST') posts++;
    throw new TypeError('offline');
  };
  await nai.probeProxy();
  await assert.rejects(nai.generate(body), (err) => !err.unknown && err.status === 0);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(nai.generate(body, { signal: abort.signal }), (err) => !err.unknown && err.name === 'AbortError');
  assert.equal(posts, 0);
});

test('response-body truncation and empty completed streams are unknown, with no endpoint fallback', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  state.settings.conn = 'direct';
  for (const operation of [() => nai.generate(body), () => nai.generateStream(body), () => nai.upscale('image', 64, 64)]) {
    let posts = 0;
    globalThis.fetch = async () => {
      posts++;
      return new Response(new ReadableStream({ start(c) { c.error(new TypeError('body connection reset')); } }));
    };
    await assert.rejects(operation(), unknown);
    assert.equal(posts, 1);
  }
  globalThis.fetch = async () => new Response(new Uint8Array());
  await assert.rejects(nai.generateStream(body), unknown);
});

test('an execution connection keeps its original credentials and server-token cannot use direct', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  state.settings.token = '';
  state.settings.conn = 'direct';
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, serverToken: true }));
  await nai.probeProxy();
  const connection = nai.connectionContext();
  assert.equal(connection.identity, 'server-token');
  state.settings.token = 'pst-CHANGED';
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, '/proxy/image/ai/generate-image');
    assert.equal(opts.headers.authorization, undefined);
    return new Response(png);
  };
  assert.equal((await nai.generate(body, { connection })).length, 1);
});
