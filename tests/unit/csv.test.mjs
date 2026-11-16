import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, csvToJson, jsonToCsv, detectDelimiter } from '../../assets/dev/lib/csv.js';

test('quoted fields: commas, doubled quotes, newlines, CRLF', () => {
  const rows = [...parseCsv('a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"multi\nline",\n')];
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'he said "hi"'], ['2', 'multi\nline', '']]);
});
test('empty cells and ragged rows', () => {
  assert.deepEqual(csvToJson('a,b,c\n1,,3\n4\n5,6,7,8'), [
    { a: '1', b: '', c: '3' }, { a: '4', b: '', c: '' }, { a: '5', b: '6', c: '7', column_4: '8' }]);
});
test('header de-duplication and blank headers', () => {
  assert.deepEqual(csvToJson('name,name,,x\n1,2,3,4'), [{ name: '1', name_2: '2', column_3: '3', x: '4' }]);
});
test('type conversion is conservative', () => {
  assert.deepEqual(csvToJson('n,f,b,z,e,lead,big\n42,-1.5e3,true,,null,007,12345678901234567890', { types: true }),
    [{ n: 42, f: -1500, b: true, z: null, e: null, lead: '007', big: '12345678901234567890' }]);
});
test('delimiter detection and explicit delimiters', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(detectDelimiter('a|b\n"x|y"|2'), '|');
  assert.deepEqual(csvToJson('a;b\n1;"2;3"'), [{ a: '1', b: '2;3' }]);
  assert.deepEqual(csvToJson('a\tb\n1\t2', { delimiter: 'tab' }), [{ a: '1', b: '2' }]);
});
test('no header → arrays; BOM; empty input', () => {
  assert.deepEqual(csvToJson('﻿1,2\n3,4', { header: false }), [['1', '2'], ['3', '4']]);
  assert.deepEqual(csvToJson(''), []);
  assert.deepEqual([...parseCsv('\n\n')], []);
  assert.equal(parseCsv('a;b').delimiter, ';');
});
test('unterminated quote reports the line', () => {
  assert.throws(() => parseCsv('a,b\n1,"oops\n2,3'), (e) => e.name === 'CsvError' && e.line === 2);
});
test('unicode passes through', () => {
  assert.deepEqual(csvToJson('名前,city\nZoë,München 🚀'), [{ 名前: 'Zoë', city: 'München 🚀' }]);
});
test('jsonToCsv: union of keys, flattening, quoting, arrays as JSON', () => {
  const csv = jsonToCsv([{ a: 1, b: { c: 'x,y' } }, { a: 'he "q"', d: [1, 2], e: null, f: 'line1\nline2', g: ' pad' }]);
  assert.equal(csv, 'a,b.c,d,e,f,g\n1,"x,y",,,,\n"he ""q""",,"[1,2]",,"line1\nline2"," pad"');
});
test('jsonToCsv: no flatten, custom delimiter, no header, CRLF', () => {
  assert.equal(jsonToCsv([{ a: { b: 1 } }], { flatten: false }), 'a\n"{""b"":1}"');
  assert.equal(jsonToCsv([{ a: 1, b: 2 }], { delimiter: ';', header: false, eol: '\r\n' }), '1;2');
  assert.equal(jsonToCsv([{ a: 1 }, { a: 2 }], { eol: '\r\n' }), 'a\r\n1\r\n2');
});
test('jsonToCsv: arrays of arrays / scalars / single object / wrapper object', () => {
  assert.equal(jsonToCsv([[1, 'a,b'], [2]]), '1,"a,b"\n2');
  assert.equal(jsonToCsv([1, 'x']), 'value\n1\nx');
  assert.equal(jsonToCsv({ a: 1 }), 'a\n1');
  assert.equal(jsonToCsv({ items: [{ a: 1 }] }), 'a\n1');
  assert.equal(jsonToCsv([]), '');
  assert.throws(() => jsonToCsv(5), /array/);
});
test('Excel-safe mode neutralizes formulas', () => {
  assert.equal(jsonToCsv([{ a: '=1+1', b: '@SUM(A1)', c: '-5', d: 'ok' }], { excelSafe: true }), "a,b,c,d\n'=1+1,'@SUM(A1),'-5,ok");
});
test('round trip JSON → CSV → JSON', () => {
  const data = [{ id: '1', name: 'A, "quoted"', note: 'multi\nline' }, { id: '2', name: 'Zoë', note: '' }];
  assert.deepEqual(csvToJson(jsonToCsv(data)), data);
});
test('large CSV (50k rows) parses quickly', () => {
  const text = 'id,name,score\n' + Array.from({ length: 50000 }, (_, i) => `${i},"Name, ${i}",${i * 1.5}`).join('\n');
  const t0 = performance.now();
  const out = csvToJson(text, { types: true });
  assert.equal(out.length, 50000);
  assert.equal(out[49999].name, 'Name, 49999');
  assert.ok(performance.now() - t0 < 3000);
});
