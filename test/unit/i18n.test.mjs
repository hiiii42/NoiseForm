import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DICT, setLang, t } from '../../public/js/i18n.js';
import { xyAxisCopy, xyValueCopy, xyQueueCopy } from '../../public/js/ui/xy-copy.js';

test('Chinese and English dictionaries have identical keys and nonempty strings', () => {
  assert.deepEqual(Object.keys(DICT.zh).sort(), Object.keys(DICT.en).sort());
  for (const [lang, entries] of Object.entries(DICT)) {
    for (const [key, value] of Object.entries(entries)) {
      assert.equal(typeof value, 'string', `${lang}.${key}`);
      assert.ok(value.trim(), `${lang}.${key} must not be empty`);
      if (lang === 'en') assert.doesNotMatch(value, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u, key);
    }
  }
});

test('static HTML localization attributes all resolve in both dictionaries', () => {
  const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  for (const [, key] of html.matchAll(/data-i18n(?:-title|-ph|-aria)?="([^"]+)"/g)) {
    assert.ok(Object.hasOwn(DICT.zh, key), key);
    assert.ok(Object.hasOwn(DICT.en, key), key);
  }
});

test('language selection and interpolation work without a DOM', () => {
  try {
    setLang('en');
    assert.equal(t('tile.progress', { done: 2, total: 3 }), 'Tiled upscale 2/3');
    setLang('zh');
    assert.equal(t('tile.progress', { done: 2, total: 3 }), '分块放大 2/3');
  } finally { setLang('zh'); }
});

test('stored X/Y captions translate only their generated UI fragments', () => {
  try {
    setLang('en');
    assert.equal(xyAxisCopy('步数'), 'steps');
    assert.equal(xyAxisCopy('中文 tag · 权重'), '中文 tag · weight');
    assert.equal(xyAxisCopy('插入（中文 tag 前）'), 'insert (before 中文 tag)');
    assert.equal(xyQueueCopy('X/Y · 步数 × 采样器'), 'X/Y · steps × sampler');
    assert.equal(xyValueCopy('steps', '23 步'), '23 steps');
    assert.equal(xyValueCopy('toggle', '无 中文 tag'), 'without 中文 tag');
    assert.equal(xyValueCopy('replace', '中文 tag'), '中文 tag');
    setLang('zh');
    assert.equal(xyAxisCopy('steps'), '步数');
    assert.equal(xyAxisCopy('tag · weight'), 'tag · 权重');
    assert.equal(xyValueCopy('steps', '23 steps'), '23 步');
  } finally { setLang('zh'); }
});
