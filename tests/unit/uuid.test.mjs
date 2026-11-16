import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv4, uuidv7, generate, formatUuid, inspectUuid, NIL, MAX } from '../../assets/dev/lib/uuid.js';

const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
test('v4: format, version and variant bits, uniqueness', () => {
  const set = new Set();
  for (let i = 0; i < 5000; i++) {
    const u = uuidv4();
    assert.match(u, RE); assert.equal(u[14], '4'); assert.ok('89ab'.includes(u[19]));
    set.add(u);
  }
  assert.equal(set.size, 5000);
});
test('v7: version/variant, timestamp, strictly increasing within the same ms', () => {
  const now = Date.now();
  const list = Array.from({ length: 5000 }, () => uuidv7(now));
  for (const u of list) { assert.match(u, RE); assert.equal(u[14], '7'); assert.ok('89ab'.includes(u[19])); }
  for (let i = 1; i < list.length; i++) assert.ok(list[i] > list[i - 1], `not monotonic at ${i}`);
  assert.equal(parseInt(list[0].replace(/-/g, '').slice(0, 12), 16), now);
  const later = uuidv7(now + 5000);
  assert.ok(later > list.at(-1));
  assert.equal(inspectUuid(later).timestamp.getTime(), now + 5000);
});
test('v7: clock going backwards still yields increasing ids', () => {
  const a = uuidv7(Date.now() + 100000), b = uuidv7(Date.now());
  assert.ok(b > a);
});
test('generate clamps count to 1..10000', () => {
  assert.equal(generate(4, 0).length, 1);
  assert.equal(generate(7, 25).length, 25);
  assert.equal(generate(4, 99999).length, 10000);
});
test('formatting options', () => {
  const u = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  assert.equal(formatUuid(u, { upper: true }), u.toUpperCase());
  assert.equal(formatUuid(u, { hyphens: false }), u.replace(/-/g, ''));
  assert.equal(formatUuid(u, { braces: true }), '{' + u + '}');
});
test('inspect: versions, variants, special values, invalid input', () => {
  assert.equal(inspectUuid(uuidv4()).version, 4);
  assert.equal(inspectUuid('{' + uuidv4().toUpperCase() + '}').valid, true);
  assert.equal(inspectUuid('urn:uuid:' + uuidv4()).valid, true);
  assert.equal(inspectUuid(uuidv4().replace(/-/g, '')).valid, true);
  assert.equal(inspectUuid(NIL).special, 'nil');
  assert.equal(inspectUuid(MAX).special, 'max');
  assert.equal(inspectUuid('not-a-uuid').valid, false);
  assert.equal(inspectUuid('1234').valid, false);
  assert.equal(inspectUuid('0190a1b2-c3d47e5f-8a9b-0c1d2e3f4a5b').valid, false);
  // RFC 9562 v1 example: C232AB00-9414-11EC-B3C8-9F6BDECED846 → 2022-02-22T19:22:22Z
  const v1 = inspectUuid('C232AB00-9414-11EC-B3C8-9F6BDECED846');
  assert.equal(v1.version, 1);
  assert.equal(v1.timestamp.toISOString(), '2022-02-22T19:22:22.000Z');
  // RFC 9562 v7 example: 017F22E2-79B0-7CC3-98C4-DC0C0C07398F → 2022-02-22T19:22:22Z
  assert.equal(inspectUuid('017F22E2-79B0-7CC3-98C4-DC0C0C07398F').timestamp.toISOString(), '2022-02-22T19:22:22.000Z');
});
