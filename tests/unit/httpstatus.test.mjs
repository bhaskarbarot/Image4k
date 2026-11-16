import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_CODES, byCode, searchStatus, CLASSES } from '../../assets/dev/lib/httpstatus.js';

// IANA HTTP Status Code Registry (assigned codes, 2024+)
const IANA = [100, 101, 102, 103, 104, 200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300, 301, 302, 303, 304, 305, 306, 307, 308,
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
  500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511];

test('every IANA-registered code is present and not marked unofficial', () => {
  for (const c of IANA) {
    const s = byCode(c);
    assert.ok(s, 'missing ' + c);
    assert.notEqual(s.status, 'unofficial', c + ' wrongly unofficial');
  }
});
test('every entry is complete', () => {
  const seen = new Set();
  for (const s of STATUS_CODES) {
    assert.ok(!seen.has(s.code), 'duplicate ' + s.code); seen.add(s.code);
    assert.ok(s.name && s.ref && s.meaning.length > 20, 'incomplete ' + s.code);
    assert.ok(CLASSES[s.cls], 'class ' + s.code);
    assert.ok(['official', 'unofficial', 'deprecated', 'unused'].includes(s.status));
    if (s.status === 'official') assert.ok(s.uses.length && s.fix.length, 'uses/fix ' + s.code);
  }
});
test('names follow RFC 9110 wording', () => {
  assert.equal(byCode(413).name, 'Content Too Large');
  assert.equal(byCode(422).name, 'Unprocessable Content');
  assert.equal(byCode(416).name, 'Range Not Satisfiable');
  assert.match(byCode(418).name, /Unused/);
});
test('cacheable-by-default set matches RFC 9110 §15.1', () => {
  assert.deepEqual(STATUS_CODES.filter((s) => s.cacheable).map((s) => s.code), [200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]);
});
test('unofficial codes are marked', () => {
  for (const c of [419, 420, 444, 499, 520, 521, 522, 523, 524, 525, 526]) assert.equal(byCode(c).status, 'unofficial', String(c));
});
test('search by code prefix, class shorthand, words and class filter', () => {
  assert.deepEqual(searchStatus('404').map((s) => s.code), [404]);
  assert.ok(searchStatus('4').every((s) => String(s.code).startsWith('4')));
  assert.ok(searchStatus('5xx').every((s) => s.cls === 5));
  assert.ok(searchStatus('rate limit').some((s) => s.code === 429));
  assert.ok(searchStatus('timeout').some((s) => s.code === 504));
  assert.deepEqual(searchStatus('', 1).map((s) => s.cls).filter((c) => c !== 1), []);
  assert.equal(searchStatus('qwertyuiop').length, 0);
});
