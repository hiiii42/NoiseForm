import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveModel, estimateCost, freeBlockers } from '../../public/js/domain/cost.js';

const opus = { tier: 3, active: true, live: true, freeBlocked: false, usageNegative: false, anlas: 0 };
const spec = (params = {}, extra = {}) => ({ params: { model: 'nai-diffusion-4-5-full', width: 1024, height: 1024, steps: 28, nSamples: 1, ...params }, ...extra });

for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-5-full']) {
  test(`${model}: free boundaries and first-sample discount`, () => {
    const s = spec({ model });
    assert.equal(estimateCost(s, opus).total, 0);
    assert.deepEqual(freeBlockers(s, opus), []);
    for (const delta of [{ width: 1025 }, { steps: 29 }, { nSamples: 2 }]) {
      const changed = spec({ model, ...delta });
      assert.ok(estimateCost(changed, opus).total > 0);
      assert.ok(freeBlockers(changed, opus).length);
    }
    for (const delta of [{ tier: 2 }, { active: false }, { freeBlocked: true }]) {
      assert.equal(estimateCost(s, { ...opus, ...delta }).opusFree, false);
      assert.ok(freeBlockers(s, { ...opus, ...delta }).length);
    }
    const batch = estimateCost(spec({ model, nSamples: 3 }), opus);
    assert.equal(batch.total, batch.per * 2);
    assert.equal(estimateCost(spec({ model, nSamples: 3 }, { nSamples: 1 }), opus).total, 0);
    assert.deepEqual(freeBlockers(spec({ model, steps: 40 }), { ...opus, live: false }), []);
  });
}

test('V5 allowance only affects V5, and balance does not alter pricing', () => {
  const account = { ...opus, usageNegative: true };
  assert.equal(estimateCost(spec(), account).total, 0);
  assert.equal(estimateCost(spec({ model: 'nai-diffusion-5-full' }), account).total, 30);
  assert.deepEqual(estimateCost(spec(), opus), estimateCost(spec(), { ...opus, anlas: 1000 }));
});

test('effective model preserves all V5 fallbacks and disabled-vibe behavior', () => {
  for (const [model, fallback] of [['nai-diffusion-5-full', 'nai-diffusion-4-5-full'], ['nai-diffusion-5-curated', 'nai-diffusion-4-5-curated'], ['nai-diffusion-5-full-medium', 'nai-diffusion-4-5-full']]) {
    assert.equal(effectiveModel(spec({ model })).id, model);
    assert.equal(effectiveModel(spec({ model }, { vibes: [{ enabled: false }] })).id, model);
    for (const extra of [{ vibes: [{ enabled: true }] }, { refs: [{}] }]) assert.equal(effectiveModel(spec({ model }, extra)).id, fallback);
  }
});

test('encoding cache, extra vibes, precise references and inpaint exclusions', () => {
  const vibe = { enabled: true, ie: 0.7 };
  const cached = { ...vibe, enc: { 'nai-diffusion-4-5-full@0.70': 'cached' } };
  assert.equal(estimateCost(spec({}, { vibes: [vibe] }), opus).total, 2);
  assert.equal(estimateCost(spec({}, { vibes: [cached] }), opus).total, 0);
  assert.equal(estimateCost(spec({}, { vibes: Array(5).fill(cached) }), opus).total, 2);
  assert.equal(estimateCost(spec({}, { vibes: Array(5).fill(vibe) }), opus).total, 12);
  assert.equal(estimateCost(spec({}, { refs: [{}], vibes: [vibe] }), opus).total, 25);
  assert.equal(estimateCost(spec({}, { base: { mask: 'mask', strength: 0.1 }, vibes: [vibe] }), opus).total, 0);
});

test('rounding, minimum, img2img, inpaint, fixed steps and large-price warning', () => {
  const paid = { ...opus, tier: 0 };
  assert.equal(estimateCost(spec({ width: 64, height: 64, steps: 1 }), paid).per, 2);
  assert.equal(estimateCost(spec({}, { base: { strength: 0.25 } }), paid).total, 5);
  assert.equal(estimateCost(spec({}, { base: { strength: 0.25, mask: 'mask' } }), paid).total, 20);
  assert.equal(estimateCost(spec({ model: 'nai-diffusion-5-full-medium', steps: 50 }), opus).total, 0);
  assert.equal(estimateCost(spec({ width: 4096, height: 4096 }), paid).tooLarge, true);
  assert.equal(estimateCost(spec({ model: 'nai-diffusion-3', smea: true, dyn: true }), paid).per, 28);
});

test('blocker order and language remain stable; inputs are not mutated', () => {
  const s = spec({ width: 1025, steps: 29, nSamples: 2 }, { lang: 'en' });
  const before = structuredClone(s);
  assert.deepEqual(freeBlockers(s, { ...opus, tier: 2, freeBlocked: true }), [
    'NovelAI has disabled free generations for this account', 'Free generations need Opus',
    '1025×1024 exceeds 1MP', 'Steps 29 > 28', '2 images: only 1 is free',
  ]);
  assert.deepEqual(freeBlockers(spec({ steps: 29 }, { lang: 'zh' }), opus), ['步数 29 > 28']);
  assert.deepEqual(s, before);
});
