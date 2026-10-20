import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMetadata, modelFromSource, IMPORT_LIMITS } from '../../public/js/importschema.js';
import { MODELS, SAMPLERS, NOISE_SCHEDULES } from '../../public/js/data.js';

test('legal NovelAI metadata and character captions survive without mutating the input', () => {
  const input = {
    Software: 'NovelAI', Source: 'NovelAI Diffusion V4.5 4BDE2A90', Description: 'cat, girl',
    Comment: {
      prompt: 'cat, girl', uc: 'blurry', seed: 4294967295, width: 832, height: 1216,
      steps: 28, scale: 7, cfg_rescale: 0.2, n_samples: 1,
      sampler: 'k_euler_ancestral', noise_schedule: 'karras', sm: false, sm_dyn: false,
      dynamic_thresholding: false, skip_cfg_above_sigma: null,
      v4_prompt: { caption: { base_caption: 'cat, girl', char_captions: [{ char_caption: 'red hair', centers: [{ x: 0.2, y: 0.8 }] }] }, use_coords: true, use_order: true },
      v4_negative_prompt: { caption: { base_caption: 'blurry', char_captions: [{ char_caption: 'hat', centers: [{ x: 0.2, y: 0.8 }] }] }, legacy_uc: false },
    },
  };
  const before = structuredClone(input);
  const result = sanitizeMetadata(input);
  assert.equal(result.discarded, 0);
  assert.deepEqual(result.meta, input);
  assert.notEqual(result.meta.Comment.v4_prompt, input.Comment.v4_prompt);
  assert.deepEqual(input, before);
  assert.deepEqual(sanitizeMetadata({ ...input, Comment: JSON.stringify(input.Comment) }).meta, input);
});

test('seed, sampler, width and all enum fields reject markup and executable strings', () => {
  const payload = '<img src=x onerror="window.__pwn=1">';
  const { meta, discarded } = sanitizeMetadata({ Comment: {
    seed: payload, sampler: payload, width: payload, height: 1024, steps: 23,
    noise_schedule: payload, model: payload,
  } });
  assert.deepEqual(meta.Comment, { height: 1024, steps: 23 });
  assert.equal(discarded, 5);
  // Prompt prose may contain literal HTML characters; it is data, never markup.
  assert.equal(sanitizeMetadata({ Description: payload }).meta.Description, payload);
});

test('numbers use finite ranges and integral steps/dimensions/seeds/sample counts', () => {
  const invalid = { seed: -1, width: 832.5, height: 16385, steps: 1.5, scale: Infinity, cfg_rescale: -0.1, n_samples: 9, skip_cfg_above_sigma: NaN };
  const { meta, discarded } = sanitizeMetadata({ Comment: invalid });
  assert.deepEqual(meta.Comment, {});
  assert.equal(discarded, Object.keys(invalid).length);
  for (const seed of [0, 4294967295, '0', '4294967295']) assert.equal(sanitizeMetadata({ Comment: { seed } }).meta.Comment.seed, seed);
  for (const seed of ['', '1e3', '0x10', ' 42 ', '4294967296', true, {}, [], null]) {
    assert.equal(sanitizeMetadata({ Comment: { seed } }).discarded, 1);
  }
});

test('wrong types and unknown keys are discarded, without coercion or prototype writes', () => {
  const input = JSON.parse('{"Source":{},"Description":[],"Comment":{"__proto__":{"polluted":true},"width":"832","sm":"false","v4_prompt":[],"scale":true,"seed":{}},"constructor":{}}');
  const { meta, discarded } = sanitizeMetadata(input);
  assert.deepEqual(meta, { Comment: {} });
  assert.equal(discarded, 9);
  assert.equal({}.polluted, undefined);
  for (const input of [null, [], 'text', 23]) assert.deepEqual(sanitizeMetadata(input), { meta: {}, discarded: 1 });
});

test('long strings, huge JSON, oversized character arrays and centers are discarded', () => {
  const long = 'x'.repeat(IMPORT_LIMITS.text + 1);
  const { meta, discarded } = sanitizeMetadata({ Description: long, Source: 'x'.repeat(1025), Comment: {
    prompt: long, uc: long,
    v4_prompt: { caption: { char_captions: Array(IMPORT_LIMITS.characters + 1).fill({ char_caption: 'cat' }) } },
  } });
  assert.equal(discarded, 5);
  assert.deepEqual(meta, { Comment: { v4_prompt: { caption: {} } } });
  assert.equal(sanitizeMetadata({ Comment: 'x'.repeat(IMPORT_LIMITS.json + 1) }).discarded, 1);
  assert.equal(sanitizeMetadata({ Comment: '{broken' }).discarded, 1);
  assert.equal(sanitizeMetadata({ Comment: { v4_prompt: { caption: { char_captions: [{ char_caption: 'cat', centers: Array(33).fill({ x: 0.5, y: 0.5 }) }] } } } }).discarded, 1);
});

test('character arrays enforce model limits and reject malformed entries without shifting pairings', () => {
  const caption = (char_captions) => ({ v4_prompt: { caption: { char_captions } } });
  for (const chars of [[null], [23], [{}], [{ char_caption: [] }], [{ char_caption: 'cat' }, null]]) {
    const r = sanitizeMetadata({ Comment: caption(chars) });
    assert.equal(r.meta.Comment.v4_prompt.caption.char_captions, undefined);
    assert.ok(r.discarded > 0);
  }
  const chars = Array(7).fill({ char_caption: 'cat' });
  assert.equal(sanitizeMetadata({ Source: 'NovelAI V4.5', Comment: caption(chars) }).discarded, 1);
  assert.equal(sanitizeMetadata({ Source: 'NovelAI V5', Comment: caption(chars) }).discarded, 0);
  const coords = sanitizeMetadata({ Comment: caption([{ char_caption: 'cat', centers: [{ x: '<script>', y: 2 }] }]) });
  assert.equal(coords.meta.Comment.v4_prompt.caption.char_captions[0].centers, undefined);
  assert.ok(coords.discarded > 0);
});

test('every current data.js enum is accepted and unsupported values are rejected', () => {
  for (const { id } of MODELS) assert.equal(sanitizeMetadata({ Comment: { model: id } }).meta.Comment.model, id);
  for (const { id } of SAMPLERS) assert.equal(sanitizeMetadata({ Comment: { sampler: id } }).meta.Comment.sampler, id);
  for (const { id } of NOISE_SCHEDULES) assert.equal(sanitizeMetadata({ Comment: { noise_schedule: id } }).meta.Comment.noise_schedule, id);
  assert.equal(sanitizeMetadata({ model: 'unknown', Comment: { sampler: 'unknown', noise_schedule: 'unknown' } }).discarded, 3);
});

test('legacy Description and all existing Source hash/version formats remain supported', () => {
  const sources = [
    ['4BDE2A90', 'nai-diffusion-4-5-full'], ['C02D4F98', 'nai-diffusion-4-5-curated'],
    ['37442FCA', 'nai-diffusion-4-full'], ['7ABFFA2A', 'nai-diffusion-4-curated-preview'],
    ['B0BDF6C1', 'nai-diffusion-3'], ['4BE8C60C', 'nai-diffusion-furry-3'],
    ['657484A5', 'nai-diffusion-5-full'], ['DB276663', 'nai-diffusion-5-curated'],
    ['93F4BD30', 'nai-diffusion-5-full-medium'],
    ['NovelAI V5', 'nai-diffusion-5-curated'], ['NovelAI V4.5', 'nai-diffusion-4-5-full'],
    ['NovelAI V4', 'nai-diffusion-4-full'], ['NovelAI Diffusion 3', 'nai-diffusion-3'],
  ];
  for (const [Source, id] of sources) {
    const r = sanitizeMetadata({ Source, Description: 'fur dataset, fox' });
    assert.equal(r.discarded, 0);
    assert.equal(modelFromSource(r.meta.Source), id);
  }
  assert.equal(modelFromSource({}), null);
});
