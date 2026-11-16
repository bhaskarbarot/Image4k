import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, yamlToJson, jsonToYaml, dumpYaml } from '../../assets/dev/lib/yaml.js';

test('YAML → JSON: maps, sequences, scalars, null, flow style', () => {
  assert.equal(yamlToJson('a: 1\nb: [x, y]\nc:\n  d: true\n  e: ~\nf: "012"\ng: 1.5\n', 0), '{"a":1,"b":["x","y"],"c":{"d":true,"e":null},"f":"012","g":1.5}');
});
test('anchors and merge keys resolve', () => {
  assert.equal(yamlToJson('base: &b {x: 1}\nderived:\n  <<: *b\n  y: 2\n', 0), '{"base":{"x":1},"derived":{"x":1,"y":2}}');
});
test('multi-document input returns an array', () => {
  const r = parseYaml('---\na: 1\n---\nb: 2\n');
  assert.equal(r.docs, 2);
  assert.deepEqual(r.value, [{ a: 1 }, { b: 2 }]);
});
test('block scalars and unicode', () => {
  assert.deepEqual(parseYaml('text: |\n  line 1\n  line 2\nname: Zoë 🚀\n').value, { text: 'line 1\nline 2\n', name: 'Zoë 🚀' });
});
test('timestamps become ISO strings in JSON', () => {
  assert.equal(yamlToJson('at: 2026-11-16T10:00:00Z', 0), '{"at":"2026-11-16T10:00:00.000Z"}');
});
test('errors carry line and column', () => {
  assert.throws(() => yamlToJson('a: 1\n b: 2'), (e) => e.name === 'YamlError' && e.line === 2 && e.col === 3);
  assert.throws(() => yamlToJson('a: [1, 2'), (e) => e.name === 'YamlError' && e.line >= 1);
});
test('unsafe JavaScript tags are rejected (safe load)', () => {
  assert.throws(() => yamlToJson('a: !!js/function "function(){}"'), /unknown tag/i);
  assert.throws(() => yamlToJson('a: !!js/regexp /x/'), /unknown tag/i);
});
test('empty YAML → null', () => { assert.equal(yamlToJson('', 0), 'null'); });
test('JSON → YAML quotes ambiguous strings and keeps types', () => {
  const y = jsonToYaml('{"a":[1,{"b":"x: y"}],"c":"multi\\nline","d":"yes","e":"012","f":null,"g":true,"h":"true"}');
  assert.equal(y, 'a:\n  - 1\n  - b: "x: y"\nc: |-\n  multi\n  line\nd: "yes"\ne: "012"\nf: null\ng: true\nh: "true"\n');
  // and it round-trips
  assert.deepEqual(parseYaml(y).value, { a: [1, { b: 'x: y' }], c: 'multi\nline', d: 'yes', e: '012', f: null, g: true, h: 'true' });
});
test('JSON → YAML: invalid JSON gives a precise error; indent option', () => {
  assert.throws(() => jsonToYaml('{"a":}'), (e) => e.name === 'JsonError' && e.col === 6);
  assert.equal(dumpYaml({ a: { b: 1 } }, { indent: 4 }), 'a:\n    b: 1\n');
});
test('large documents convert quickly', () => {
  const obj = { items: Array.from({ length: 10000 }, (_, i) => ({ id: i, name: 'n' + i, tags: ['a', 'b'] })) };
  const t0 = performance.now();
  const y = dumpYaml(obj);
  assert.deepEqual(parseYaml(y).value, obj);
  assert.ok(performance.now() - t0 < 4000);
});
