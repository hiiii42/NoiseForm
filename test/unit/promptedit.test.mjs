import test from 'node:test';
import assert from 'node:assert/strict';
import { segments, editables, planEdits, applyEdits, editKey, findRewrite, promptPosition, applyCharacterEdits, promptArtists, replaceArtists } from '../../public/js/promptedit.js';

test('segments omit protected lines and expose normalized weighted cores', () => {
  const text = '# city, plaza\r\n1.2::City_Street::, {{Blue   Sky}}, [-1::crowd::]\r\n---\r\n@scene_city';
  assert.deepEqual(segments(text).map((s) => [s.core, s.key, s.line]), [
    ['City_Street', 'city street', 1], ['Blue   Sky', 'blue sky', 1], ['crowd', 'crowd', 1], ['@scene_city', '@scene city', 3],
  ]);
  assert.equal(editKey('{[1.2::CITY_STREET::]}'), 'city street');
});

test('replace in place keeps numeric, negative and nested bracket wrappers', () => {
  assert.equal(applyEdits('1girl, 1.2::city_street::, {-1::crowd::}, [[blue sky]]', {
    replace: [{ from: 'CITY STREET', to: 'countryside' }, { from: 'crowd', to: 'tree' }, { from: 'blue_sky', to: 'sunset' }],
  }), '1girl, 1.2::countryside::, {-1::tree::}, [[sunset]]');
});

test('obsolete scene sentences are replaced and additions deduplicate after edits', () => {
  assert.equal(applyEdits('city street, She stands in a city plaza., sky', {
    remove: ['sky'], replace: [{ from: 'she stands in a city plaza.', to: 'She stands by a village well.' }],
    add: ['CITY_STREET', 'tree', 'TREE', 'sky'],
  }), 'city street, She stands by a village well., tree, sky');
});

test('remove cleans commas at the beginning, middle, end and whole lines', () => {
  for (const [input, output] of [['a, b, c', 'b'], ['a, b, c, ', 'b'], ['a, c\nb, c', '\nb'], [' a , c ', '']]) {
    assert.equal(applyEdits(input, { remove: ['a', 'c'] }), output);
  }
});

test('comments, dividers, blank lines, CRLF and unmatched references stay intact', () => {
  const input = '# city, sky\r\n  ---  \r\ncity, @city, @my_chunk\r\n\r\nsky';
  assert.equal(applyEdits(input, { remove: ['city'], replace: [{ from: 'my chunk', to: 'bad' }], add: ['tree'] }),
    '# city, sky\r\n  ---  \r\n@city, @my_chunk\r\n\r\nsky, tree');
  assert.equal(applyEdits('@my_chunk, city', { remove: ['@my_chunk'] }), 'city');
  assert.equal(applyEdits('# keep, this\n---', { add: ['tree'] }), '# keep, this\n---\ntree');
});

test('no matching edit is byte-for-byte unchanged; swaps do not cascade; remove wins', () => {
  const src = '  1girl,   {sky}, \r\n# untouched';
  assert.equal(applyEdits(src, { remove: ['girl'], replace: [{ from: 'cloud', to: 'tree' }] }), src);
  assert.equal(applyEdits('a, b', { replace: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }), 'b, c');
  assert.equal(applyEdits('a, b', { remove: ['a'], replace: [{ from: 'a', to: 'c' }] }), 'b');
});

test('group weights survive partial deletion and replacement; empty groups disappear', () => {
  assert.equal(applyEdits('1.2::city, {crowd}, sky::, tree', { remove: ['crowd'], replace: [{ from: 'city', to: 'village' }] }), '1.2::village, sky::, tree');
  assert.equal(applyEdits('{city, crowd}, sky', { remove: ['city', 'crowd'] }), 'sky');
  assert.equal(applyEdits('{{city}, [crowd]}, sky', { replace: [{ from: 'city', to: 'village' }], remove: ['crowd'] }), '{{village}}, sky');
  assert.equal(applyEdits('tree', { add: ['1.2::tree, sky::', 'SKY', '{cloud, cloud}'] }), 'tree, 1.2::sky::, {cloud}');
});

test('findRewrite pairs a rewritten scene sentence with the one it replaces', () => {
  const text = 'dancing, times square, The three teenagers dance together in the middle of the crowded plaza, the boy in the center between the two girls.';
  const have = new Map(segments(text).map((s) => [s.key, s.text]));
  assert.equal(findRewrite('The three teenagers dance together on a dirt road between the fields', have), 'The three teenagers dance together in the middle of the crowded plaza');
  // short tags are never treated as sentences; unrelated sentences do not match
  assert.equal(findRewrite('A cat sleeps on a warm windowsill', have), null);
  // an already claimed sentence is skipped
  const claimed = new Set([editKey('The three teenagers dance together in the middle of the crowded plaza')]);
  assert.equal(findRewrite('The three teenagers dance together on a dirt road', have, claimed), null);
});

test('additions go above a trailing artist-only line', () => {
  assert.equal(applyEdits('1girl, city\n1.2::artist:foo::, artist:bar', { add: ['rice paddy'] }), '1girl, city, rice paddy\n1.2::artist:foo::, artist:bar');
  assert.equal(applyEdits('1girl, artist:foo', { add: ['smile'] }), '1girl, artist:foo, smile');
  assert.equal(applyEdits('# artists\nartist:foo', { add: ['smile'] }), '# artists\nartist:foo, smile');
});

test('character edits use stable original indices, retain disabled flags, and target only one prompt', () => {
  const source = [
    { id: 'a', prompt: '1girl, {long hair}, tree', enabled: true, x: .3, y: .5 },
    { id: 'b', prompt: '1boy, tree', enabled: false, x: .5, y: .5 },
    { id: 'c', prompt: '1girl, long hair, tree', enabled: true, x: .7, y: .5 },
  ];
  const out = applyCharacterEdits(source, [{ index: 2, delete: true }, { index: 3, replace: [{ from: 'long hair', to: 'short hair' }], add: ['smile'], position: { x: .326, y: 2 } }], { remove: ['tree'] });
  assert.equal(out.characters.length, 2);
  assert.equal(out.characters[0].prompt, '1girl, {long hair}');
  assert.equal(out.characters[1].prompt, '1girl, short hair, smile');
  assert.deepEqual([out.characters[1].x, out.characters[1].y], [.33, .9]);
  assert.equal(out.positionChanged, true);
  assert.equal(source[2].prompt, '1girl, long hair, tree', 'inputs are not mutated');
  const moved = applyCharacterEdits([source[2], source[0]], [{ index: 1, id: 'a', delete: true }]);
  assert.equal(moved.characters[0].id, 'c', 'snapshot IDs win if the live list was reordered');
});

test('new characters respect remaining model capacity after deletion', () => {
  const out = applyCharacterEdits([{ id: 'old', prompt: '1boy' }], [
    { index: 1, delete: true }, { new: true, label: 'girl', tags: ['1girl'], position: { x: -.2, y: .537 } }, { new: true, tags: ['1boy'] },
  ], { maxChars: 1, idFactory: () => 'new-id' });
  assert.equal(out.dropped, 1);
  assert.equal(out.characters[0].id, 'new-id');
  assert.equal(out.characters[0].label, 'girl');
  assert.deepEqual([out.characters[0].x, out.characters[0].y], [.1, .54]);
  assert.equal(applyCharacterEdits([], [{ new: true, tags: ['1girl'] }], { maxChars: 0 }).characters.length, 0);
  assert.equal(applyCharacterEdits([{ prompt: '1girl', x: .5, y: .5 }], [{ index: 1, position: { x: .3, y: .4 } }], { supportsPosition: false }).positionChanged, false);
});

test('positions accept old labels and finite coordinates only', () => {
  assert.deepEqual(promptPosition('left'), { x: .3, y: .5 });
  assert.deepEqual(promptPosition({ x: .127, y: .903 }), { x: .13, y: .9 });
  for (const p of [null, {}, 'unknown', { x: NaN, y: .5 }, { x: '0.3', y: .5 }]) assert.equal(promptPosition(p), null);
});

test('artist replacement preserves weighted retained artists and original insertion position', () => {
  const text = '# artist:comment\r\n1girl, 1.2::artist:foo::, tree, {-1::artist:bar::}\r\nsky';
  assert.deepEqual(promptArtists(text), [{ tag: 'artist:foo', text: '1.2::artist:foo::' }, { tag: 'artist:bar', text: '{-1::artist:bar::}' }]);
  assert.equal(replaceArtists(text, ['artist:foo', 'artist:baz']), '# artist:comment\r\n1girl, 1.2::artist:foo::, artist:baz, tree\r\nsky');
  assert.equal(replaceArtists(text, ['artist:foo', 'artist:bar']), text);
  assert.equal(replaceArtists(text, []), '# artist:comment\r\n1girl, tree\r\nsky');
  assert.equal(replaceArtists('1girl, sky', ['artist:new', 'artist:new']), '1girl, sky\nartist:new');
  assert.equal(replaceArtists('1girl, sky,\n', ['artist:new']), '1girl, sky\nartist:new');
  assert.equal(replaceArtists('', ['artist:new']), 'artist:new');
});

test('mixed weighted groups retain non-artists without giving new artists inherited weight', () => {
  const text = '1girl, {sky, 1.2::artist:foo, tree::, artist:bar}, city';
  const result = replaceArtists(text, ['artist:foo', 'artist:new']);
  assert.equal(result, '1girl, {sky}, {1.2::artist:foo::}, artist:new, {1.2::tree::}, city');
  assert.deepEqual(segments(result).map((s) => s.core), ['1girl', 'sky', 'artist:foo', 'artist:new', 'tree', 'city']);
});

test('a sentence that contains commas can be replaced or removed as one unit (bug: rural prompt)', () => {
  const text = 'rural, farm, golden hour, The three teenagers dance together on a dirt path between rice paddies, the boy in the center between the two girls., depth of field, Low sun casts long shadows behind the two girls.';
  const whole = 'The three teenagers dance together on a dirt path between rice paddies, the boy in the center between the two girls.';
  assert.deepEqual(editables(text).filter((s) => s.core.includes(',')).map((s) => s.core), [whole]);
  assert.equal(applyEdits(text, { replace: [{ from: whole, to: 'The two girls dance on a dirt path between rice paddies.' }] }),
    'rural, farm, golden hour, The two girls dance on a dirt path between rice paddies., depth of field, Low sun casts long shadows behind the two girls.');
  assert.equal(applyEdits(text, { remove: [whole] }), 'rural, farm, golden hour, depth of field, Low sun casts long shadows behind the two girls.');
  // inside a weight group the wrapper is kept
  assert.equal(applyEdits('1.2::She runs, then she jumps.::, tree', { replace: [{ from: 'She runs, then she jumps.', to: 'She walks.' }] }), '1.2::She walks.::, tree');
  // tag runs are never offered as one unit; halves remain individually editable
  assert.equal(editables('rural, farm, rice paddy, The end.').some((s) => s.core.includes(',')), false);
  assert.ok(segments(text).some((s) => s.core === 'the boy in the center between the two girls.'));
});

test('sentence keys ignore the final period; short tags keep their punctuation', () => {
  assert.equal(editKey('She waits at the bus stop.'), editKey('She waits at the bus stop'));
  assert.equal(applyEdits('night, She waits at the bus stop.', { replace: [{ from: 'She waits at the bus stop', to: 'She waits on the sand.' }] }), 'night, She waits on the sand.');
  assert.notEqual(editKey('!?'), editKey('!'));
  assert.equal(editKey('...'), '...');
});

test('comma sentence edits have deterministic overlap precedence', () => {
  const old = 'The girls walk through the park, the boy waves beside them.';
  const next = 'The girls walk through the park, the girls wave beside them.';
  for (const from of [old, old.slice(0, -1)]) {
    assert.equal(applyEdits('tree, ' + old, { replace: [{ from, to: next }] }), 'tree, ' + next);
    assert.equal(applyEdits('tree, 1.2::' + old + '::', { replace: [{ from, to: next }] }), 'tree, 1.2::' + next + '::');
  }
  assert.equal(applyEdits('tree, ' + old, {
    remove: [old], replace: [{ from: 'the boy waves beside them', to: 'the girls wave beside them.' }],
  }), 'tree, ' + next, 'a partial replacement cancels an enclosing deletion');
  assert.equal(applyEdits('tree, ' + old, {
    remove: [old, 'the boy waves beside them'],
    replace: [{ from: 'the boy waves beside them', to: 'discarded' }, { from: old, to: next }],
  }), 'tree, ' + next, 'whole replacement wins over all overlapping edits');
  const multi = 'The girls walk through the park, the boy waves, a dog follows them.';
  assert.equal(applyEdits('tree, {{' + multi + '}}', {
    remove: ['the boy waves'], replace: [{ from: multi.slice(0, -1), to: next }],
  }), 'tree, {{' + next + '}}');
  assert.equal(applyEdits(old + '\n' + old, { remove: [old], replace: [{ from: 'the boy waves beside them.', to: 'the girls wave beside them.' }] }), next + '\n' + next);
});

test('edit plans resolve conflicts per original occurrence and contain no overlapping ranges', () => {
  const old = 'The girls walk through the park, the boy waves beside them.';
  const next = 'The girls walk through the park, the girls wave beside them.';
  const text = '# ' + old + '\r\ntree, {1.2::' + old + '::}\r\nthe boy waves beside them.';
  const edits = {
    remove: ['the boy waves beside them.'],
    replace: [{ from: old, to: next }, { from: 'the boy waves beside them.', to: 'discarded' }],
  };
  const plan = planEdits(text, edits);
  assert.deepEqual(plan.replace, [edits.replace[0]]);
  assert.deepEqual(plan.remove, edits.remove, 'a separate occurrence is still removed');
  for (const a of plan.spans) for (const b of plan.spans) if (a !== b) {
    assert.ok(a.end <= b.start || b.end <= a.start, 'execution ranges do not overlap');
  }
  assert.equal(applyEdits(text, edits), '# ' + old + '\r\ntree, {1.2::' + next + '::}\r\n');
});
