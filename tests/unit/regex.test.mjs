import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRegex, checkPattern, supportedFlags, PRESETS } from '../../assets/dev/lib/regex.js';

test('global matches with positions and groups', () => {
  const r = runRegex({ pattern: '(\\w)(\\d)', flags: 'g', text: 'a1 b2 c3' });
  assert.equal(r.total, 3);
  assert.deepEqual(r.matches.map((m) => [m.index, m.end, m.text]), [[0, 2, 'a1'], [3, 5, 'b2'], [6, 8, 'c3']]);
  assert.deepEqual(r.matches[1].groups, ['b', '2']);
});
test('named groups and d-flag indices', () => {
  const r = runRegex({ pattern: '(?<y>\\d{4})-(?<m>\\d\\d)', flags: 'gd', text: 'on 2026-11 and 2027-01' });
  assert.deepEqual(r.matches[0].named, { y: '2026', m: '11' });
  assert.deepEqual(r.matches[0].namedIndices.y, [3, 7]);
  assert.deepEqual(r.matches[1].indices[2], [20, 22]);
});
test('non-global returns only the first match', () => {
  assert.equal(runRegex({ pattern: 'a', flags: '', text: 'aaa' }).total, 1);
});
test('empty matches do not loop forever (and are unicode-aware)', () => {
  assert.equal(runRegex({ pattern: '', flags: 'g', text: 'abc' }).total, 4);
  assert.equal(runRegex({ pattern: '', flags: 'gu', text: '🚀🚀' }).total, 3);
  assert.equal(runRegex({ pattern: 'x*', flags: 'g', text: 'axxb' }).total, 4);
});
test('flags i m s u', () => {
  assert.equal(runRegex({ pattern: 'HELLO', flags: 'gi', text: 'hello Hello' }).total, 2);
  assert.equal(runRegex({ pattern: '^\\w+$', flags: 'gm', text: 'one\ntwo' }).total, 2);
  assert.equal(runRegex({ pattern: 'a.b', flags: 's', text: 'a\nb' }).total, 1);
  assert.equal(runRegex({ pattern: '\\p{Emoji_Presentation}', flags: 'gu', text: 'hi 🚀 ✓ 🎉' }).total, 2);
});
test('sticky flag', () => {
  assert.equal(runRegex({ pattern: 'a', flags: 'y', text: 'aab' }).total, 1);
  assert.equal(runRegex({ pattern: 'a', flags: 'gy', text: 'aab' }).total, 2);
});
test('match cap', () => {
  const r = runRegex({ pattern: '.', flags: 'g', text: 'x'.repeat(20000), limit: 10000 });
  assert.equal(r.total, 10000); assert.equal(r.truncated, true);
});
test('replace preview with $1 and $<name>', () => {
  assert.equal(runRegex({ pattern: '(\\w+)@(?<d>\\w+)', flags: 'g', text: 'a@b c@d', replace: '$<d>:$1' }).replaced, 'b:a d:c');
});
test('invalid pattern and bad flags give messages', () => {
  assert.match(runRegex({ pattern: '(abc', flags: 'g', text: '' }).error, /Unterminated group/i);
  assert.match(checkPattern('a', 'gg'), /once/);
  if (supportedFlags().includes('v')) assert.match(checkPattern('a', 'uv'), /cannot be combined/);
  assert.equal(checkPattern('a+', 'gim'), null);
});
test('presets are valid patterns and match their examples', () => {
  for (const p of PRESETS) assert.equal(checkPattern(p.pattern, p.flags), null, p.name);
  const email = PRESETS.find((p) => p.name === 'Email address');
  assert.equal(runRegex({ pattern: email.pattern, flags: email.flags, text: 'mail a.b+c@ex-ample.co.uk now' }).matches[0].text, 'a.b+c@ex-ample.co.uk');
});
test('unicode text positions are UTF-16 indices', () => {
  const r = runRegex({ pattern: 'b', flags: 'g', text: '🚀b' });
  assert.equal(r.matches[0].index, 2);
});
