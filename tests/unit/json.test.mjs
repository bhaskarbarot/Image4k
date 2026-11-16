import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reformat, formatJson, minifyJson, validateJson, hasUnsafeNumbers, sortKeysDeep, parseJson } from '../../assets/dev/lib/json.js';

test('formats nested objects/arrays with 2 spaces, empty containers stay compact', () => {
  assert.equal(formatJson('{"a":[1,{"b":null}],"c":{},"d":[]}', 2), '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": {},\n  "d": []\n}');
});
test('tab and 4-space indentation', () => {
  assert.equal(formatJson('{"a":1}', '\t'), '{\n\t"a": 1\n}');
  assert.equal(formatJson('[1]', 4), '[\n    1\n]');
});
test('minify removes all insignificant whitespace', () => {
  assert.equal(minifyJson(' {\n "a" : [ 1 , 2 ] ,\t"b":"x y" } '), '{"a":[1,2],"b":"x y"}');
});
test('round-trips: minify(format(x)) parses to the same value', () => {
  const src = '{"x":[1,2.5e10,-0.1,true,false,null,"\\"q\\" \\u00e9 \\n"],"y":{"z":[[],[{}]]}}';
  assert.deepEqual(JSON.parse(minifyJson(formatJson(src, 2))), JSON.parse(src));
});
test('big integers are preserved exactly (no precision loss)', () => {
  assert.equal(minifyJson('{"id": 12345678901234567890}'), '{"id":12345678901234567890}');
  assert.equal(hasUnsafeNumbers('{"id": 12345678901234567890}'), true);
  assert.equal(hasUnsafeNumbers('{"id": "12345678901234567890", "n": 42}'), false);
});
test('unicode and emoji pass through unchanged', () => {
  assert.equal(minifyJson('{ "név": "Zoë 🚀 日本" }'), '{"név":"Zoë 🚀 日本"}');
});
test('duplicate keys and key order are kept', () => {
  assert.equal(minifyJson('{"b":1,"a":2,"b":3}'), '{"b":1,"a":2,"b":3}');
});
test('scalar roots are valid', () => {
  for (const s of ['1', '"x"', 'true', 'null', '-0.5e-3']) assert.equal(validateJson(s).ok, true, s);
});
test('BOM is tolerated', () => { assert.equal(validateJson('﻿{"a":1}').ok, true); });

const bad = [
  ['{"a":1,}', 'Trailing comma', 1, 8],
  ['[1,2,]', 'Trailing comma', 1, 6],
  ['{a:1}', 'double quotes', 1, 2],
  ["{'a':1}", 'double quotes', 1, 2],
  ['{"a":1 "b":2}', "Expected ','", 1, 8],
  ['[1,2', 'unclosed array', 1, 5],
  ['', 'empty', 1, 1],
  ['   ', 'empty', 1, 4],
  ['01', 'leading zeros', 1, 1],
  ['{"a":1}x', 'after the end', 1, 8],
  ['"abc', 'Unterminated string', 1, 1],
  ['{"a"}', "Expected ':'", 1, 5],
  ['[NaN]', 'NaN', 1, 2],
  ['{"a":1,\n  "b": tru}', 'did you mean true', 2, 8],
  ['[1]]', 'after the end', 1, 4],
  ['{"a":"x\ny"}', 'Line break inside a string', 1, 8],
  ['{"a":"\\x"}', 'Invalid escape', 1, 7],
  ['[1, // c\n2]', 'Comments', 1, 5],
  ['{"a":[1,2}', 'Mismatched bracket', 1, 10],
];
for (const [src, msg, line, col] of bad) {
  test(`error: ${JSON.stringify(src)} → ${msg} @${line}:${col}`, () => {
    const v = validateJson(src);
    assert.equal(v.ok, false);
    assert.match(v.error.message, new RegExp(msg, 'i'));
    assert.equal(v.error.line, line, 'line');
    assert.equal(v.error.col, col, 'column');
  });
}

test('very deep nesting does not overflow the stack', () => {
  const deep = '['.repeat(200000) + ']'.repeat(200000);
  assert.equal(validateJson(deep).stats.depth, 200000);
});
test('large input (≈5 MB) formats quickly', () => {
  const arr = Array.from({ length: 40000 }, (_, i) => ({ id: i, name: 'user ' + i, tags: ['a', 'b'], ok: i % 2 === 0 }));
  const src = JSON.stringify(arr);
  const t0 = performance.now();
  const r = reformat(src, { indent: 2 });
  assert.ok(performance.now() - t0 < 3000);
  assert.equal(r.stats.type, 'array');
  assert.deepEqual(JSON.parse(r.text).length, 40000);
});
test('sortKeysDeep sorts nested keys, keeps array order', () => {
  assert.equal(JSON.stringify(sortKeysDeep({ b: 1, a: { d: [3, 1], c: 2 } })), '{"a":{"c":2,"d":[3,1]},"b":1}');
});
test('parseJson throws a precise JsonError', () => {
  assert.throws(() => parseJson('{"a":}'), (e) => e.name === 'JsonError' && e.line === 1 && e.col === 6);
});
