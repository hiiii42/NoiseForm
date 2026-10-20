import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SYSTEM, buildMessages, compilePlan, countPlan, parsePlanJSON, planToPatch, planOutcome } from '../../public/js/aiplan.js';

const model = { id: 'nai-diffusion-5-full', name: 'NAI Diffusion V5 Full', v4: true, v5: true, maxChars: 32 };
const verify = (tag) => typeof tag === 'string' && tag.trim() ? { tag: tag.trim().toLowerCase().replaceAll('_', ' '), st: 'ok' } : null;
const compile = (json, snapshot = {}, options = {}) => compilePlan(json, { snapshot, model, verify, ...options });
const old = 'The three teenagers dance together on a dirt path between rice paddies, the boy in the center between the two girls.';
const next = 'The two girls dance together on a dirt path between rice paddies.';
// Recorded DeepSeek-flash response excerpts already preserved in ideate-chars.spec.mjs.
// The complete 1.8.1 provider envelope is not present in this checkout. Keep these
// excerpts as raw JSON text; the no-op replacement below is a separate regression case.
const recorded = [
  `{"replace":[{"from":"${old}","to":"${next}","kind":"nl"}]}`,
  `{"replace":[{"from":"${old.slice(0, -1)}","to":"${next}","kind":"nl"}]}`,
  `{"remove":["${old}"],"nl":["${next}"]}`,
];
const freeze = (obj) => { if (obj && typeof obj === 'object') { Object.values(obj).forEach(freeze); Object.freeze(obj); } return obj; };

test('request SYSTEM is unchanged and model context retains disabled character numbering', () => {
  // Hash the template source spelling to guard the prompt copied from ideate.js.
  const template = 'export const SYSTEM = `' + SYSTEM + '`;';
  assert.equal(createHash('sha256').update(template).digest('hex'), 'cec1237ad1077a3f7f43e2e2589a2a075dcba6b01bc5b310fab395472a718d9b');
  const params = freeze({ prompt: '2girls', aiChoice: false, characters: [
    { id: 'a', prompt: '1girl', label: 'left', x: .3, y: .5 },
    { id: 'b', prompt: '1boy', enabled: false, x: .7, y: .5 },
  ] });
  const messages = buildMessages({ params, model, desc: '删掉男人', lang: 'zh', dict: '\nDictionary tags found in the text (tag | 中文 | posts):\n1boy | 男 | 1000' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, SYSTEM);
  const text = messages[1].content;
  assert.ok(text.includes('Modify current prompts. Request: 删掉男人'));
  assert.ok(text.includes('character limit: 32; positions supported: true'));
  assert.ok(text.includes('Character 2 [enabled: false; position: x 0.70 y 0.50]:\n1boy'));
  assert.ok(text.includes('User language: Chinese\nDictionary tags found'));
});

test('new/check/artist requests preserve text, history, feedback and multimodal shape', () => {
  const history = freeze([[{ role: 'user', content: 'paint' }, { role: 'assistant', content: '{}' }]]);
  const params = { prompt: 'tree', characters: [] };
  const fresh = buildMessages({ mode: 'gen', merge: 'new', splitChars: false, params, model, lang: 'en', desc: 'scene' });
  assert.ok(fresh[1].content.includes('Write a complete new prompt. Request: scene'));
  assert.ok(fresh[1].content.includes('Do not use characters.\nUser language: English'));
  assert.ok(!fresh[1].content.includes('Base prompt:'));
  assert.ok(buildMessages({ mode: 'check', params, model })[1].content.includes('Check these prompts.'));
  const artists = buildMessages({ mode: 'artists', params, model, artistHistory: history, artistSelection: [{ tag: 'artist:a', kept: true }, { tag: 'artist:b', kept: false }], attachedImage: 'data:image/jpeg;base64,AA==' });
  assert.equal(artists.length, 4);
  assert.deepEqual(artists.slice(1, 3), history[0]);
  assert.ok(artists[3].content[0].text.includes('Kept artists: ["artist:a"]\nRejected artists: ["artist:b"]'));
  assert.deepEqual(artists[3].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } });
});

test('delete a person removes original character, count tag and interaction, and rewrites sentence', () => {
  const sentence = 'The three friends dance in the middle of the street.';
  const snapshot = freeze({ prompt: `2girls, 1boy, hetero, ${sentence}`, aiChoice: false, characters: [
    { id: 'a', prompt: '1girl, long hair' }, { id: 'man', prompt: '1boy, short hair' }, { id: 'b', prompt: '1girl, kimono', enabled: false },
  ] });
  const plan = compile({ remove: ['1boy', 'hetero'], replace: [{ from: sentence, to: 'The two girls dance in the middle of the street.', kind: 'nl' }], char_edits: [{ index: 2, delete: true }] }, snapshot);
  assert.deepEqual(countPlan(plan), { remove: 3, replace: 1, add: 0 });
  assert.equal(plan.charEdits[0].characterId, 'man');
  assert.equal(plan.charEdits[0].deletion.characterId, 'man');
  assert.deepEqual(planToPatch(plan).characters.map((c) => c.id), ['a', 'b']);
  assert.equal(planToPatch(plan).prompt, '2girls, The two girls dance in the middle of the street.');
  assert.equal(planToPatch(plan).characters[1].enabled, false);
  assert.equal(snapshot.characters.length, 3);
});

for (const [i, response] of recorded.entries()) test(`recorded comma sentence path ${i + 1}: complete replace, missing period, remove + nl`, () => {
  const snapshot = { prompt: `2girls, streetwear\nartist:ningen mame, rural, golden hour, ${old}, depth of field`, characters: [] };
  const plan = compile(response, snapshot);
  assert.deepEqual(countPlan(plan), { remove: 0, replace: 1, add: 0 });
  assert.equal(plan.replace[0].from, old);
  assert.equal(plan.nl.length, 0);
  assert.equal(plan.remove.length, 0);
  const range = plan.replace[0].sources[0];
  assert.equal(snapshot.prompt.slice(range.start, range.end), old);
  assert.equal(planToPatch(plan).prompt, snapshot.prompt.replace(old, next));
});

test('identity 2girls replacement and repeated replace target are not counted twice', () => {
  const plan = compile({ replace: [{ from: '2girls', to: '2girls' }, { from: old, to: next, kind: 'nl' }], nl: [next], tags: ['tree', 'TREE'] }, { prompt: `2girls, ${old}` });
  assert.equal(plan.replace.length, 1);
  assert.deepEqual(countPlan(plan), { remove: 0, replace: 1, add: 1 });
  assert.equal(planToPatch(plan).prompt, `2girls, ${next}, tree`);
});

test('whole replacement wins subsegment overlap; partial rewrite cancels enclosing deletion', () => {
  const source = 'The girls walk through the park, the boy waves beside them.';
  const target = 'The girls walk through the park, the girls wave beside them.';
  const plans = [
    { remove: [source], nl: [target] },
    { remove: [source], replace: [{ from: 'the boy waves beside them.', to: 'the girls wave beside them.', kind: 'nl' }] },
    { remove: ['the boy waves beside them.'], replace: [{ from: source, to: target, kind: 'nl' }, { from: 'the boy waves beside them.', to: 'discarded words here.', kind: 'nl' }] },
  ];
  for (const json of plans) {
    const plan = compile(json, { prompt: `tree, ${source}` });
    assert.deepEqual(countPlan(plan), { remove: 0, replace: 1, add: 0 });
    assert.equal(planToPatch(plan).prompt, `tree, ${target}`);
    plan.replace[0].on = false;
    assert.deepEqual(countPlan(plan), { remove: 0, replace: 0, add: 0 });
    assert.equal(planToPatch(plan).prompt, `tree, ${source}`);
  }
});

test('rewrite explicitly clears empty/single/unsplit characters and ignores old remove/replace', () => {
  const snapshot = { prompt: '1boy', characters: [{ id: 'old', prompt: '1boy' }] };
  for (const [characters, splitChars] of [[[], true], [[{ tags: ['1girl'] }], true], [[{ tags: ['1girl'] }, { tags: ['1boy'] }], false]]) {
    const plan = compile({ tags: ['no humans', 'tree'], characters, remove: ['1boy'], replace: [{ from: '1boy', to: '1girl' }] }, snapshot, { merge: 'new', splitChars });
    assert.deepEqual(planToPatch(plan).characters, []);
    assert.equal(planToPatch(plan).prompt, 'no humans, tree');
  }
  const plan = compile({ characters: [{ tags: ['1girl'], position: 'left' }, { tags: ['1boy'], position: { x: .71, y: .52 } }] }, snapshot, { merge: 'new' });
  const patch = planToPatch(plan);
  assert.deepEqual(patch.characters.map((c) => [c.prompt, c.x]), [['1girl', .3], ['1boy', .71]]);
  assert.equal(patch.aiChoice, false);
  assert.deepEqual(planToPatch(plan), patch, 'pure patch assembly has stable character IDs');
});

test('char_edits use original IDs, enforce cap, and retain deterministic IDs after empty additions', () => {
  const snapshot = { prompt: 'tree', aiChoice: true, characters: [{ id: 'ai-character-1', prompt: '1girl' }, { id: 'gone', prompt: '1boy' }] };
  const plan = compile({ char_edits: [
    { index: 2, delete: true }, { index: 1, add: ['smile'], position: { x: .326, y: .674 } },
    { new: true, tags: [] }, { new: true, label: 'new', tags: ['1girl'], position: 'right' }, { new: true, tags: ['1boy'] },
  ] }, snapshot, { model: { ...model, maxChars: 2 } });
  const { patch, dropped } = planOutcome(plan);
  assert.equal(dropped, 1);
  assert.equal(patch.characters.length, 2);
  assert.equal(patch.characters[0].prompt, '1girl, smile');
  assert.deepEqual([patch.characters[0].x, patch.characters[0].y, patch.aiChoice], [.33, .67, false]);
  assert.equal(patch.characters[1].label, 'new');
  assert.equal(patch.characters[1].id, plan.charEdits.find((g) => g.label === 'new').characterId);
  assert.equal(new Set(patch.characters.map((c) => c.id)).size, 2);
  freeze(plan);
  assert.deepEqual(planToPatch(plan), patch);
});

test('artist pairing replaces existing artists and preserves weights, rejected choices and scene', () => {
  const snapshot = freeze({ prompt: '1.2::artist:old, tree::, sky', characters: [{ id: 'c', prompt: '1girl' }] });
  const choices = freeze([{ tag: 'artist:old', on: false }, { tag: 'artist:rejected', on: false, known: true }]);
  const plan = compile({ artists: [{ tag: 'artist:new', why: 'paint' }] }, snapshot, { mode: 'artists', artistSelection: choices, verifyArtist: (tag) => typeof tag === 'string' ? { tag, known: true } : null });
  assert.deepEqual(plan.artists.map((a) => [a.tag, a.on]), [['artist:old', false], ['artist:new', true], ['artist:rejected', false]]);
  assert.deepEqual(planToPatch(plan), { prompt: 'artist:new, 1.2::tree::, sky' });
  assert.deepEqual(compile({ artists: [] }, snapshot, { mode: 'artists', artistSelection: plan.artists }).artists.map((a) => [a.tag, a.on]), plan.artists.map((a) => [a.tag, a.on]));
  assert.equal(snapshot.characters[0].id, 'c');
});

test('empty, malformed, wrong-shaped and truncated responses stay safe and salvage complete fields', () => {
  assert.deepEqual(countPlan(compile({}, { prompt: 'tree' })), { remove: 0, replace: 0, add: 0 });
  for (const value of [null, [], 7, false]) assert.throws(() => compile(value), /建议对象/);
  assert.throws(() => parsePlanJSON('no JSON'), /不是 JSON/);
  assert.throws(() => parsePlanJSON('{broken'), /不完整/);
  assert.throws(() => parsePlanJSON('{broken', { truncated: true }), /截断/);
  const json = parsePlanJSON('<think>reason</think>```json\n{"tags":["tree"],"note":"unfinished', { truncated: true });
  assert.deepEqual(json.tags, ['tree']);
  assert.equal(planToPatch(compile(json, {}, { merge: 'new' })).prompt, 'tree');
  const bad = compile({ tags: [null, 5, {}, 'tree'], nl: [null, {}], char_edits: [null, {}, { index: 99, delete: true }], characters: [null], conflicts: [null] });
  assert.deepEqual(countPlan(bad), { remove: 0, replace: 0, add: 1 });
});

test('injected verification selects known tags only and explicit user choices drive both count and patch', () => {
  const plan = compile({ tags: ['tree', 'unknown'], replace: [{ from: 'night', to: 'day', kind: 'tag' }] }, { prompt: 'night' }, { verify: (tag) => ({ tag, st: tag === 'tree' ? 'ok' : 'checking' }) });
  assert.deepEqual(countPlan(plan), { remove: 0, replace: 0, add: 1 });
  assert.equal(planToPatch(plan).prompt, 'night, tree');
  plan.tags[1].on = true;
  plan.replace[0].on = true;
  assert.deepEqual(countPlan(plan), { remove: 0, replace: 1, add: 2 });
  assert.equal(planToPatch(plan).prompt, 'day, tree, unknown');
});

test('compiling never mutates inputs; IDs and original ranges survive repeated compilation', () => {
  const response = freeze({ remove: ['1boy'], char_edits: [{ index: 1, add: ['smile'] }], tags: ['tree'] });
  const snapshot = freeze({ prompt: '1boy', characters: [{ id: 'a', prompt: '1girl' }] });
  const a = compile(response, snapshot), b = compile(response, snapshot);
  assert.deepEqual(a, b);
  assert.deepEqual(a.remove[0].sources, [{ characterId: null, start: 0, end: 4 }]);
  const items = [...a.tags, ...a.remove, ...a.charEdits, ...a.charEdits.flatMap((g) => g.add)];
  assert.ok(items.every((item) => typeof item.id === 'string' && typeof item.on === 'boolean'));
  assert.ok(items.every((item) => item.target && Number.isInteger(item.target.offset)));
  assert.deepEqual(a.tags[0].target, { characterId: null, offset: 4 });
  assert.equal(a.charEdits[0].add[0].target.characterId, 'a');
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  snapshot.characters.forEach((c) => assert.ok(c.id));
  freeze(a);
  assert.deepEqual(planToPatch(a), planToPatch(a));
});
