import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDiff, toUnified, unifiedPatch, splitLines, wordParts } from '../../assets/dev/lib/textdiff.js';
import { applyPatch } from '../../assets/vendor/diff-8.0.4/index.js';

test('identical texts', () => {
  const r = computeDiff('a\nb\n', 'a\nb\n');
  assert.equal(r.stats.identical, true);
  assert.equal(r.rows.length, 2);
});
test('added, removed and modified lines with word-level parts', () => {
  const r = computeDiff('a\nb\nc d e\nf\nold\n', 'a\nB\nc X e\nf\n+new\n');
  assert.deepEqual(r.rows.map((x) => x.t), ['same', 'mod', 'mod', 'same', 'mod']);
  assert.deepEqual(r.rows[2].l.parts, [{ v: 'c ' }, { v: 'd', del: true }, { v: ' e' }]);
  assert.deepEqual(r.rows[2].r.parts, [{ v: 'c ' }, { v: 'X', add: true }, { v: ' e' }]);
  const r2 = computeDiff('1\n2\n3', '1\n3\n4');
  assert.deepEqual(r2.rows.map((x) => x.t), ['same', 'del', 'same', 'add']);
  assert.equal(r2.stats.added, 1); assert.equal(r2.stats.removed, 1);
});
test('line numbers on both sides', () => {
  const r = computeDiff('x\na\nb', 'a\nb\ny');
  assert.deepEqual(r.rows.map((x) => [x.l?.n ?? null, x.r?.n ?? null]), [[1, null], [2, 1], [3, 2], [null, 3]]);
});
test('ignore whitespace / case keep each side\'s original text', () => {
  const r = computeDiff('Hello   World\nX', 'hello world\nX', { ignoreWhitespace: true, ignoreCase: true });
  assert.equal(r.stats.identical, true);
  assert.equal(r.rows[0].l.text, 'Hello   World');
  assert.equal(r.rows[0].r.text, 'hello world');
  assert.equal(computeDiff('a b', 'a  b').stats.identical, false);
});
test('empty inputs and CRLF', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.equal(computeDiff('', 'x\ny').stats.added, 2);
  assert.equal(computeDiff('a\r\nb', 'a\nb').stats.identical, true);
});
test('unicode and special characters', () => {
  const r = computeDiff('Zoë 🚀 <b>&amp;</b>', 'Zoë 🛸 <b>&amp;</b>');
  assert.equal(r.stats.modified, 1);
  assert.ok(r.rows[0].l.parts.some((p) => p.del && p.v.includes('🚀')));
  const wp = wordParts('日本 語', '日本 文');
  assert.equal(wp.left.map((p) => p.v).join(''), '日本 語');
  assert.equal(wp.right.map((p) => p.v).join(''), '日本 文');
});
test('unified view interleaves removed before added', () => {
  const u = toUnified(computeDiff('a\nb\nc', 'a\nB\nc').rows);
  assert.deepEqual(u.map((x) => x.t + x.text), [' a', '-b', '+B', ' c']);
});
test('unified patch applies back to produce the new text', () => {
  const a = 'line1\nline2\nline3\nline4\n', b = 'line1\nline 2!\nline3\nline4\nline5\n';
  const p = unifiedPatch(a, b);
  assert.match(p, /^-{3} original\.txt/m);
  assert.match(p, /^\+line 2!$/m);
  assert.equal(applyPatch(a, p), b);
});
test('large input (20k lines) is fast', () => {
  const A = Array.from({ length: 20000 }, (_, i) => 'line ' + i).join('\n');
  const B = A.replace('line 500\n', 'line 500 changed\n').replace('line 19000\n', '');
  const t0 = performance.now();
  const r = computeDiff(A, B);
  assert.equal(r.stats.modified, 1);
  assert.equal(r.stats.removed, 1);
  assert.ok(performance.now() - t0 < 3000);
});
