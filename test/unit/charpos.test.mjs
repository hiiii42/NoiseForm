import test from 'node:test';
import assert from 'node:assert/strict';
import { POS_VALUES, posClamp, posSnap, posLabel, posTitle, modelById } from '../../public/js/data.js';
import { DEFAULT_PARAMS } from '../../public/js/store.js';
import { buildGenerateBody } from '../../public/js/nai.js';

test('V5 positions clamp to 10–90%, round to hundredths and default invalid input to center', () => {
  assert.equal(posClamp(-0.1), 0.1);
  assert.equal(posClamp(1), 0.9);
  assert.equal(posClamp(0.2849), 0.28);
  assert.equal(posClamp(0.4151), 0.42);
  for (const value of [undefined, null, NaN, Infinity, 'oops']) assert.equal(posClamp(value), 0.5);
});

test('V4 positions snap to the nearest grid; labels never fall back to C3 for off-grid input', () => {
  for (const n of POS_VALUES) assert.equal(posSnap(n), n);
  assert.equal(posSnap(0.28), 0.3);
  assert.equal(posSnap(0.41), 0.5);
  assert.equal(posSnap(0.199), 0.1);
  assert.equal(posSnap(0.2), 0.3);
  assert.equal(posSnap(-1), 0.1);
  assert.equal(posSnap(2), 0.9);
  assert.equal(posLabel(0.28, 0.41), 'B3');
  assert.equal(posLabel(0.81, 0.16), 'E1');
  assert.equal(posLabel(0.28, 0.41, true), '28·41');
  assert.equal(posTitle(0.28, 0.41), 'x 28% · y 41%');
});

test('all three character coordinate payloads match model precision without mutating editor data', () => {
  const characters = [{ id: 'a', prompt: '1girl', uc: 'hat', x: 0.284, y: 0.414, enabled: true },
    { id: 'b', prompt: '1boy', uc: '', x: -0.1, y: 1, enabled: true }];
  for (const id of ['nai-diffusion-5-curated', 'nai-diffusion-4-5-full']) {
    const model = modelById(id);
    const p = { ...DEFAULT_PARAMS, model: id, aiChoice: false, characters };
    const { parameters: out } = buildGenerateBody({ params: p, model, seed: 123 });
    const expected = model.v5 ? { x: 0.28, y: 0.41 } : { x: 0.3, y: 0.5 };
    assert.deepEqual(out.characterPrompts[0].center, expected);
    for (const field of ['v4_prompt', 'v4_negative_prompt']) {
      assert.deepEqual(out[field].caption.char_captions[0].centers, [expected]);
      assert.deepEqual(out[field].caption.char_captions[1].centers, [{ x: 0.1, y: 0.9 }]);
    }
    assert.equal(out.use_coords, true);
    assert.equal(out.v4_prompt.use_coords, true);
  }
  assert.equal(characters[0].x, 0.284);
  assert.equal(characters[1].y, 1);
});

test('request snapping matches the grid helper across fine boundary values', () => {
  const model = modelById('nai-diffusion-4-5-full');
  for (const value of [0, 0.199, 0.2, 0.399, 0.4, 0.599, 0.6, 0.799, 0.8, 1]) {
    const params = { ...DEFAULT_PARAMS, characters: [{ prompt: '1girl', uc: '', enabled: true, x: value, y: value }] };
    const out = buildGenerateBody({ params, model, seed: 1 });
    assert.equal(out.parameters.characterPrompts[0].center.x, posSnap(value));
  }
});
