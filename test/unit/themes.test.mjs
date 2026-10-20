import test from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_SIZES, scaleOf } from '../../public/js/themes.js';

test('legacy font IDs retain their exact scale; invalid preferences use the 85% default', () => {
  for (const [id, expected] of [['sm', .92], ['md', 1], ['lg', 1.1], ['xl', 1.2]]) assert.equal(scaleOf(id), expected);
  for (const id of [undefined, null, '', 'unknown', '__proto__']) assert.equal(scaleOf(id), 0.85);
});

test('font steps cover 70–150%, remain ordered and use unique persisted IDs', () => {
  assert.equal(TEXT_SIZES[0][1], .7);
  assert.equal(TEXT_SIZES.at(-1)[1], 1.5);
  assert.equal(new Set(TEXT_SIZES.map(([id]) => id)).size, TEXT_SIZES.length);
  for (let i = 1; i < TEXT_SIZES.length; i++) {
    assert.ok(TEXT_SIZES[i][1] > TEXT_SIZES[i - 1][1]);
    assert.ok(TEXT_SIZES[i][1] - TEXT_SIZES[i - 1][1] <= .15 + Number.EPSILON);
  }
});
