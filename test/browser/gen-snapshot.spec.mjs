import { mockLiveSource } from '../fixtures/mocklive.mjs';

export const options = { init: [mockLiveSource({ delay: 800 }), `
localStorage.setItem('nf.chunks', JSON.stringify([{ id:'scene', name:'scene', text:'original scene\\n# private note\\n---' }]));
const originalFetch = window.fetch;
window.fetch = async (url, opts = {}) => {
  const response = await originalFetch(url, opts);
  if (!String(url).endsWith('generate-image')) return response;
  const body = JSON.parse(opts.body);
  const { unzip, zip } = await import('/js/zip.js');
  const { writeTextChunks } = await import('/js/png.js');
  const files = await unzip(new Uint8Array(await response.arrayBuffer()));
  files[0].data = writeTextChunks(files[0].data, { Description: body.input, Comment: JSON.stringify(body.parameters) });
  return new Response(zip(files));
};`] };

export default async ({ page, assert }) => {
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    Object.assign(state.params, { prompt: '@scene', uc: '', ucPreset: 3, qualityToggle: false, model: 'nai-diffusion-4-5-full', width: 832, height: 1216, steps: 23, seed: '12345', characters: [{ id: 'c', prompt: '@scene', uc: '', enabled: true, x: 0.5, y: 0.5 }] });
    document.querySelector('#btnGenerate').click();
  });
  await page.waitFor('window.__gen === 1');
  await page.run(async () => {
    const { state, set } = await import('/js/store.js');
    localStorage.setItem('nf.chunks', JSON.stringify([{ id: 'scene', name: 'scene', text: 'changed scene' }]));
    window.dispatchEvent(new StorageEvent('storage', { key: 'nf.chunks' }));
    Object.assign(state.params, { prompt: '@scene, new', width: 512, height: 512, steps: 20, seed: '67890' });
    state.params.characters[0].prompt = 'changed character';
    state.session.tier = 0;
    set('settings.token', ''); // even a LIVE -> DEMO change cannot relabel this result
  });
  await page.waitFor("import('/js/store.js').then(m=>!m.state.session.generating)");
  const first = await page.run(async () => {
    const { images } = await import('/js/db.js');
    const { readTextChunks } = await import('/js/png.js');
    const rec = await images.get((await images.list())[0].id);
    const meta = readTextChunks(new Uint8Array(await rec.blob.arrayBuffer()));
    return { params: rec.params, demo: rec.demo, meta: JSON.parse(meta.Comment), prompt: meta.Description, stats: (await import('/js/stats.js')).today() };
  });
  assert.equal(first.params.prompt, 'original scene');
  assert.equal(first.prompt, first.params.prompt);
  assert.equal(first.params.characters[0].prompt, 'original scene');
  for (const key of ['width', 'height', 'steps', 'seed', 'sampler']) assert.equal(first.params[key], first.meta[key], key);
  assert.equal(first.demo, false);
  assert.equal(first.stats.n, 1);
  assert.equal(first.stats.free, 1, 'cost uses the starting account');
  await page.run(async () => {
    (await import('/js/store.js')).set('settings.token', 'pst-MOCK');
    document.querySelector('#btnGenerate').click();
  });
  await page.waitFor("window.__gen === 2 && import('/js/store.js').then(m=>!m.state.session.generating)");
  const next = await page.run(async () => (await (await import('/js/db.js')).images.list())[0].params);
  assert.equal(next.prompt, 'changed scene, new');
  assert.equal(next.width, 512);
  assert.equal(next.steps, 20);
  assert.equal(next.seed, 67890);
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const image = canvas.toDataURL();
    Object.assign(state.params, { model: 'nai-diffusion-5-curated', prompt: 'reference snapshot', seed: '42' });
    state.base = { image, sourceId: 'original-base', strength: 0.6, noise: 0.1 };
    state.refs = [{ id: 'original-ref', image, type: 'character', strength: 0.7, fidelity: 0.8 }];
    document.querySelector('#btnGenerate').click();
    // Mutate the same objects while prepBase is awaiting image decode, before the POST.
    state.base.sourceId = 'changed-base';
    state.base.strength = 0.9;
    state.refs[0].id = 'changed-ref';
    state.refs[0].strength = 0.2;
    state.refs = [];
    state.params.model = 'nai-diffusion-5-full';
  });
  await page.waitFor("window.__gen === 3 && import('/js/store.js').then(m=>!m.state.session.generating)");
  const third = await page.run(async () => ({ body: window.__genBodies[2], rec: (await (await import('/js/db.js')).images.list())[0] }));
  assert.equal(third.body.model, 'nai-diffusion-4-5-curated');
  assert.equal(third.body.parameters.strength, 0.6);
  assert.deepEqual(third.body.parameters.director_reference_strength_values, [0.7]);
  assert.equal(third.rec.sourceId, 'original-base');
  assert.deepEqual(third.rec.generation.refs, ['original-ref']);
  assert.equal(third.rec.params.model, third.body.model);
};
