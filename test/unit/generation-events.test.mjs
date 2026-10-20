// Execute the production generate module in Node with explicit dependency stubs.
// Only import URLs are rewritten; lifecycle/recovery functions are the real source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { on } from '../../public/js/app/events.js';

let fixtureId = 0;
async function fixture({ failRequest = false, failSave = false } = {}) {
  const sourceURL = new URL('../../public/js/app/generate.js', import.meta.url);
  const id = `__nfGenerationTest${++fixtureId}`;
  const saved = [], commits = [], history = [];
  const state = {
    params: { model: 'mock', prompt: 'test', uc: '', characters: [], width: 64, height: 64, steps: 4, nSamples: 1, seed: '7', sampler: 'k_euler', noiseSchedule: 'karras' },
    base: null, refs: [], vibes: [], settings: { stream: false }, session: { follow: true, demoNoted: true },
  };
  let serial = 0, requests = 0, duplicate = false;
  const dependencies = {
    '../util.js': { uid: () => `id-${++serial}`, randomSeed: () => 7, downloadBlob: () => {} },
    '../store.js': { state, emit: () => {}, commit: (root, patch) => { commits.push([root, patch]); Object.assign(state[root], patch); } },
    '../i18n.js': { t: (key) => key, getLang: () => 'en' },
    '../nai.js': { connectionContext: () => ({ identity: 'demo' }), generationCost: () => ({ total: 0 }) },
    '../demo.js': { demoGenerate: async (_params, progress) => {
      requests++;
      if (failRequest) throw Error('stub request failed');
      progress(0.25); progress(0.1); progress(0.75);
      return [{ blob: new Blob(['local test']), seed: 7 }];
    } },
    '../png.js': { readTextChunks: () => ({}) },
    '../zip.js': { zip: () => new Uint8Array() },
    '../auto.js': { autoRunning: () => false },
    '../queue.js': { queueRunning: () => false, cutIn: () => {} },
    '../stats.js': { recordGen: () => {} },
    '../dupcheck.js': { checkDuplicate: () => ({ duplicate, armed: true }), rememberJob: () => {}, generationKey: () => 'key' },
    './records.js': { history, selectRecord: async () => {}, addRecords: async (items, options) => {
      if (failSave) throw Error('stub quota full');
      saved.push(...items); history.push(...items); options.onPersisted(items); return items;
    } },
    './editor.js': { editorSnapshot: () => ({}) },
    './account.js': { refreshAccount: () => {} },
  };
  globalThis[id] = dependencies;
  let source = await readFile(sourceURL, 'utf8');
  source = source.replace(/from '([^']+)'/g, (_, specifier) => {
    const stub = dependencies[specifier];
    if (!stub) return `from '${new URL(specifier, sourceURL).href}'`;
    const body = `const stub = globalThis[${JSON.stringify(id)}][${JSON.stringify(specifier)}];\n` +
      Object.keys(stub).map((name) => `export const ${name} = stub.${name};`).join('\n');
    return `from 'data:text/javascript;base64,${Buffer.from(body).toString('base64')}'`;
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  delete globalThis[id];
  const model = { id: 'mock', short: 'MOCK' };
  return { mod, saved, commits, requests: () => requests, state,
    run: () => mod.generate({ model }),
    allowSave: () => { failSave = false; },
    duplicate: () => { duplicate = true; },
  };
}

async function capture(run, broken = false) {
  const seen = [], logged = [], original = console.error;
  console.error = (...args) => logged.push(args);
  const remove = [];
  if (broken) {
    remove.push(on('generation:start', () => { throw Error('broken stage'); }));
    remove.push(on('generation:land', async () => { throw Error('broken animation'); }));
  }
  for (const name of ['generation:start', 'generation:progress', 'generation:done', 'generation:failed', 'pending-saves']) {
    remove.push(on(name, (value) => seen.push([name, value])));
  }
  try { return { result: await run(), seen, logged }; }
  finally { remove.forEach((fn) => fn()); console.error = original; }
}

test('actual generate emits start, monotonic progress, done and preserves success despite broken views', async () => {
  const f = await fixture();
  const { result, seen, logged } = await capture(f.run, true);
  assert.equal(result.ok, true);
  assert.equal(f.saved.length, 1);
  assert.equal(f.requests(), 1);
  assert.equal(f.mod.pendingSaveCount(), 0);
  assert.equal(f.state.session.generating, false);
  assert.deepEqual(seen.filter(([name]) => name !== 'pending-saves').map(([name]) => name),
    ['generation:start', 'generation:progress', 'generation:progress', 'generation:progress', 'generation:done']);
  assert.deepEqual(seen.filter(([name]) => name === 'generation:progress').map(([, p]) => p), [0.25, 0.75, 1]);
  assert.equal(logged.length, 2);
});

test('actual generate emits start then failed on request error and clears busy', async () => {
  const f = await fixture({ failRequest: true });
  const { result, seen } = await capture(f.run);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'request');
  assert.deepEqual(seen.map(([name]) => name), ['generation:start', 'generation:failed']);
  assert.equal(f.saved.length, 0);
  assert.equal(f.state.session.generating, false);
});

test('actual generate emits pending-saves and retry reuses Blob without another request', async () => {
  const f = await fixture({ failSave: true });
  const { result, seen } = await capture(f.run);
  assert.equal(result.stage, 'persist');
  assert.equal(result.ok, false);
  const entries = seen.find(([name]) => name === 'pending-saves')[1];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].items[0].blob.size, 10);
  assert.ok(!seen.some(([name]) => ['generation:done', 'generation:failed'].includes(name)));
  await capture(() => f.mod.retrySave(result.pendingId));
  assert.equal(f.requests(), 1);
  assert.equal(f.mod.pendingSaveCount(), 1);
  f.allowSave();
  const retried = await capture(() => f.mod.retrySave(result.pendingId));
  assert.equal(retried.result.ok, true);
  assert.equal(retried.result.recs[0].id, entries[0].items[0].id);
  assert.equal(retried.result.recs[0].blob, entries[0].items[0].blob);
  assert.equal(f.requests(), 1);
  assert.equal(f.mod.pendingSaveCount(), 0);
  assert.equal(f.state.session.generating, false);
});

test('generation captures injected chunks before the first async boundary', async () => {
  const f = await fixture();
  const rows = [{ name: 'scene', text: 'rain, # not a comment here' }];
  f.state.params.prompt = '@scene';
  f.mod.initGeneration({ chunks: () => rows });
  const context = f.mod.generationContext({ model: { id: 'mock', short: 'MOCK' } });
  rows[0].text = 'sun';
  f.state.params.prompt = 'draft';
  assert.equal(context.params.prompt, 'rain, # not a comment here');
  assert.equal(Object.isFrozen(context.params), true);
});
