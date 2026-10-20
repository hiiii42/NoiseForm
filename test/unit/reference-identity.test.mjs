import test from 'node:test';
import assert from 'node:assert/strict';
import { generationKey, recordKey } from '../../public/js/dupcheck.js';
import { DEFAULT_PARAMS } from '../../public/js/store.js';

const ref = { id: 'r', image: 'image-a', type: 'character', strength: 0.2, fidelity: 0.3 };
const vibe = { id: 'v', image: 'vibe-a', enabled: true, strength: 0.5, ie: 0.7 };
const spec = extra => ({ params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', prompt: 'test', seed: 42 }, model: 'nai-diffusion-4-5-full', seed: 42, demo: false, ...extra });

test('reference identity includes type, strength, fidelity, source content and order', () => {
  const key = generationKey(spec({ refs: [ref] }));
  for (const change of [{ type: 'style' }, { strength: 0.9 }, { fidelity: 0.8 }, { image: 'changed' }]) {
    assert.notEqual(generationKey(spec({ refs: [{ ...ref, ...change }] })), key, JSON.stringify(change));
  }
  const second = { ...ref, id: 'r2', image: 'image-b' };
  assert.notEqual(generationKey(spec({ refs: [ref, second] })), generationKey(spec({ refs: [second, ref] })));
});

test('vibe identity includes information extraction and effective normalized strengths', () => {
  const key = generationKey(spec({ vibes: [vibe] }));
  for (const change of [{ strength: 0.9 }, { ie: 0.2 }, { image: 'changed' }]) {
    assert.notEqual(generationKey(spec({ vibes: [{ ...vibe, ...change }] })), key);
  }
  assert.equal(generationKey(spec({ vibes: [{ ...vibe, enabled: false }] })), generationKey(spec({ vibes: [] })));
  const a = spec({ vibes: [vibe, { ...vibe, id: 'v2', image: 'vibe-b' }] });
  a.params.normalizeVibes = true;
  assert.equal(generationKey(a), generationKey({ ...a, vibes: a.vibes.map(v => ({ ...v, strength: 1 })) }));
});

test('signature excludes model-ineffective settings and unsupported references', () => {
  const a = spec({ model: 'nai-diffusion-5-curated' });
  a.params.model = a.model;
  assert.equal(generationKey(a), generationKey({ ...a, refs: [ref], vibes: [vibe] }));
  assert.equal(generationKey(a), generationKey({ ...a, params: { ...a.params, smea: true, dyn: true, variety: true, noiseSchedule: 'native' } }));
});

test('incomplete legacy reference records are incomparable; identical complete specs still match', () => {
  const g = spec({ refs: [ref] });
  assert.equal(recordKey({ ...g, generation: { refs: ['r'], vibes: [] } }), null);
  assert.equal(recordKey({ ...g, generation: { refs: [{ id: 'r' }], vibes: [] } }), null);
  assert.equal(recordKey({ ...g, generation: { refs: [], vibes: ['v'] } }), null);
  assert.equal(recordKey({ ...g }), null);
  assert.equal(recordKey({ ...g, params: {}, generation: { refs: [], vibes: [] } }), null);
  assert.equal(generationKey(spec({ refs: [{ id: 'r' }] })), null);
  assert.equal(generationKey(g), generationKey(structuredClone(g)));
});
