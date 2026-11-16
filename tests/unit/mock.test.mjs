import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMock, validateSchema, createRng, SAMPLE_SCHEMA, FIELD_TYPES } from '../../assets/dev/lib/mock.js';

const ALL = {
  seed: 'all-types', count: 200, now: '2026-06-01',
  fields: FIELD_TYPES.filter(([t]) => t !== 'object' && t !== 'array').map(([t]) => ({ name: t, type: t }))
    .concat([{ name: 'obj', type: 'object', fields: [{ name: 'x', type: 'integer', min: 5, max: 6 }] }, { name: 'arr', type: 'array', min: 2, max: 4, of: { type: 'uuid' } }]),
};

test('same seed + schema → identical output; different seed → different', () => {
  const a = JSON.stringify(generateMock(ALL));
  assert.equal(JSON.stringify(generateMock(ALL)), a);
  assert.notEqual(JSON.stringify(generateMock({ ...ALL, seed: 'other' })), a);
});

test('PRNG is uniform-ish and within [0,1)', () => {
  const r = createRng('x');
  let sum = 0;
  for (let i = 0; i < 10000; i++) { const v = r.next(); assert.ok(v >= 0 && v < 1); sum += v; }
  assert.ok(Math.abs(sum / 10000 - 0.5) < 0.02);
  for (let i = 0; i < 1000; i++) { const v = r.int(3, 5); assert.ok(v >= 3 && v <= 5 && Number.isInteger(v)); }
});

test('every type produces valid values', () => {
  const rows = generateMock(ALL);
  assert.equal(rows.length, 200);
  rows.forEach((r, i) => {
    assert.equal(r.id, 1 + i);
    assert.match(r.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(r.email, /^[a-z0-9]+\.[a-z0-9]+@[a-z0-9.-]+\.[a-z]+$/);
    assert.ok(r.email.startsWith(r.firstName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()));
    assert.equal(r.fullName, r.firstName + ' ' + r.lastName);
    assert.match(r.phone, /^\+1-\d{3}-555-01\d\d$/);
    assert.match(r.ipv4, /^(\d{1,3}\.){3}\d{1,3}$/);
    assert.ok(r.ipv4.split('.').every((o) => +o >= 0 && +o <= 255));
    assert.match(r.ipv6, /^2001:db8:/);
    assert.match(r.color, /^#[0-9a-f]{6}$/);
    assert.match(r.url, /^https:\/\/[a-z0-9]+\.[a-z]+\//);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!isNaN(Date.parse(r.datetime)));
    assert.ok(Date.parse(r.past) <= Date.parse('2026-06-01') && Date.parse(r.past) >= Date.parse('2026-06-01') - 365 * 864e5);
    assert.ok(Date.parse(r.future) >= Date.parse('2026-06-01'));
    assert.ok(r.integer >= 0 && r.integer <= 1000 && Number.isInteger(r.integer));
    assert.ok(r.float >= 0 && r.float <= 100);
    assert.equal(typeof r.boolean, 'boolean');
    assert.ok(['active', 'pending', 'disabled'].includes(r.enum));
    assert.ok(r.latitude >= -90 && r.latitude <= 90 && r.longitude >= -180 && r.longitude <= 180);
    assert.match(r.zip, /^\d{5}$/);
    assert.match(r.sentence, /^[A-Z][a-z ]+\.$/);
    assert.ok(r.obj.x === 5 || r.obj.x === 6);
    assert.ok(r.arr.length >= 2 && r.arr.length <= 4);
  });
});

test('ranges, enum lists, nullable and boolean percentage are respected', () => {
  const rows = generateMock({ seed: 1, count: 2000, fields: [
    { name: 'n', type: 'integer', min: -3, max: 3 }, { name: 'p', type: 'price', min: 10, max: 11 },
    { name: 'e', type: 'enum', values: ['x', 'y'] }, { name: 'maybe', type: 'word', nullable: 25 }, { name: 'b', type: 'boolean', truePct: 90 },
    { name: 'd', type: 'date', from: '2024-02-01', to: '2024-02-03' }, { name: 'f', type: 'float', min: 1, max: 2, decimals: 3 },
  ] });
  const nulls = rows.filter((r) => r.maybe === null).length;
  assert.ok(nulls > 400 && nulls < 600, 'nullable ≈ 25%: ' + nulls);
  const trues = rows.filter((r) => r.b).length;
  assert.ok(trues > 1700 && trues < 1900, 'truePct ≈ 90%: ' + trues);
  for (const r of rows) {
    assert.ok(r.n >= -3 && r.n <= 3);
    assert.ok(r.p >= 10 && r.p <= 11);
    assert.ok(['x', 'y'].includes(r.e));
    assert.ok(['2024-02-01', '2024-02-02', '2024-02-03'].includes(r.d), r.d);
    assert.ok(r.f >= 1 && r.f <= 2 && (String(r.f).split('.')[1] || '').length <= 3);
  }
  assert.ok(new Set(rows.map((r) => r.n)).size === 7, 'all integers in range appear');
});

test('validation reports every problem', () => {
  const errs = validateSchema({ count: 20000, fields: [
    { name: 'a', type: 'integer', min: 9, max: 1 }, { name: 'a', type: 'word' }, { type: 'word' }, { name: 'z', type: 'bogus' },
    { name: 'arr', type: 'array', min: 5, max: 2 }, { name: 'o', type: 'object', fields: [] }, { name: 'en', type: 'enum', values: '' },
    { name: 'dt', type: 'date', from: '2025-01-02', to: '2025-01-01' }, { name: 'nn', type: 'word', nullable: 150 },
  ] });
  const all = errs.join('\n');
  for (const re of [/count/, /min \(9\) is greater than max/, /duplicate field name/, /needs a "name"/, /unknown type "bogus"/, /array min\/max/, /needs "of"/, /non-empty array/, /enum needs at least one value/, /"from" is after "to"/, /nullable/]) assert.match(all, re);
  assert.throws(() => generateMock({ fields: [] }), /non-empty/);
  assert.deepEqual(validateSchema(SAMPLE_SCHEMA), []);
});

test('10 000 records generate in reasonable time', () => {
  const t0 = performance.now();
  const rows = generateMock({ ...SAMPLE_SCHEMA, count: 10000 });
  assert.equal(rows.length, 10000);
  assert.ok(performance.now() - t0 < 4000);
});
