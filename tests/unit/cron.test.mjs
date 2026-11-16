import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRuns, describe, isImpossible, CronError, PRESETS } from '../../assets/dev/lib/cron.js';

const FROM = new Date(Date.UTC(2026, 10, 16, 7, 30, 15)); // Monday 16 Nov 2026 07:30:15 UTC
const runs = (expr, n = 3, from = FROM) => nextRuns(parseCron(expr), { from, count: n, utc: true }).runs.map((d) => d.toISOString());

test('every 5 minutes', () => { assert.deepEqual(runs('*/5 * * * *'), ['2026-11-16T07:35:00.000Z', '2026-11-16T07:40:00.000Z', '2026-11-16T07:45:00.000Z']); });
test('every minute starts at the next whole minute', () => { assert.deepEqual(runs('* * * * *', 2), ['2026-11-16T07:31:00.000Z', '2026-11-16T07:32:00.000Z']); });
test('run time equal to "from" is excluded (strictly after)', () => {
  assert.deepEqual(runs('30 7 * * *', 1, new Date(Date.UTC(2026, 10, 16, 7, 30, 0))), ['2026-11-17T07:30:00.000Z']);
});
test('weekdays at 09:00 skips the weekend', () => {
  assert.deepEqual(runs('0 9 * * 1-5', 6), ['2026-11-16T09:00:00.000Z', '2026-11-17T09:00:00.000Z', '2026-11-18T09:00:00.000Z', '2026-11-19T09:00:00.000Z', '2026-11-20T09:00:00.000Z', '2026-11-23T09:00:00.000Z']);
});
test('leap day 29 Feb', () => { assert.deepEqual(runs('0 0 29 2 *'), ['2028-02-29T00:00:00.000Z', '2032-02-29T00:00:00.000Z', '2036-02-29T00:00:00.000Z']); });
test('impossible date 31 Feb never runs', () => {
  const c = parseCron('0 0 31 2 *');
  assert.equal(isImpossible(c), true);
  assert.equal(nextRuns(c, { from: FROM, utc: true }).never, true);
  assert.equal(nextRuns(parseCron('0 0 30,31 2 *'), { from: FROM, utc: true }).never, true);
});
test('Vixie OR semantics when both day fields are restricted', () => {
  // 13th of the month OR any Friday
  assert.deepEqual(runs('0 0 13 * 5', 4, new Date(Date.UTC(2026, 10, 1))), ['2026-11-06T00:00:00.000Z', '2026-11-13T00:00:00.000Z', '2026-11-20T00:00:00.000Z', '2026-11-27T00:00:00.000Z']);
});
test('AND semantics when day-of-week starts with *', () => {
  // 1st of month that is also an even weekday (Sun, Tue, Thu, Sat)
  const r = nextRuns(parseCron('0 0 1 * */2'), { from: FROM, count: 3, utc: true }).runs;
  for (const d of r) { assert.equal(d.getUTCDate(), 1); assert.ok([0, 2, 4, 6].includes(d.getUTCDay())); }
});
test('names, 7 = Sunday, @macros', () => {
  assert.deepEqual(runs('0 3 * * SUN', 1), runs('0 3 * * 7', 1));
  assert.deepEqual(runs('0 3 * * sun', 1), ['2026-11-22T03:00:00.000Z']);
  assert.deepEqual(runs('@weekly', 1), ['2026-11-22T00:00:00.000Z']);
  assert.deepEqual(runs('@yearly', 1), ['2027-01-01T00:00:00.000Z']);
  assert.deepEqual(runs('@hourly', 1), ['2026-11-16T08:00:00.000Z']);
  assert.deepEqual(runs('0 0 1 JAN-MAR *', 3), ['2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z', '2027-03-01T00:00:00.000Z']);
});
test('6-field with seconds', () => { assert.deepEqual(runs('*/20 * * * * *'), ['2026-11-16T07:30:20.000Z', '2026-11-16T07:30:40.000Z', '2026-11-16T07:31:00.000Z']); });
test('steps on ranges and n/step', () => {
  assert.deepEqual(parseCron('1-10/3 * * * *').fields.minute.values, [1, 4, 7, 10]);
  assert.deepEqual(parseCron('50/5 * * * *').fields.minute.values, [50, 55]);
  assert.deepEqual(parseCron('0 0 * * MON,WED-FRI').fields.dow.values, [1, 3, 4, 5]);
});
test('yearly schedule search is fast', () => {
  const t0 = performance.now();
  nextRuns(parseCron('59 23 31 12 *'), { from: FROM, count: 20, utc: true });
  nextRuns(parseCron('0 0 29 2 1'), { from: FROM, count: 5, utc: true });
  assert.ok(performance.now() - t0 < 1500);
});
test('local-time mode returns increasing dates', () => {
  const r = nextRuns(parseCron('30 2 * * *'), { from: FROM, count: 40 }).runs;
  for (let i = 1; i < r.length; i++) assert.ok(r[i] > r[i - 1]);
});
const invalid = [
  ['', /Enter a cron/], ['* * *', /found 3/], ['0 24 * * *', /Hour: 24 is out of range/], ['60 * * * *', /Minute: 60/],
  ['0 0 0 * *', /Day of month: 0 is out of range/], ['0 0 * 13 *', /Month: 13/], ['0 0 * * 8', /Day of week: 8/],
  ['0 0 * FOO *', /not a valid month name/], ['5-1 * * * *', /backwards/], ['*/0 * * * *', /at least 1/], ['0 0 L * *', /Quartz/],
  ['0 0 * * 5#2', /Quartz/], ['@reboot', /no schedule/], ['@sometimes', /Unknown macro/], ['0 0 1 1 * 2026 x y', /Expected 5/], ['0 0 0 1 1 * 2026', /Quartz/],
  ['a * * * *', /not a number/], ['1,,2 * * * *', /not valid syntax/],
];
for (const [expr, re] of invalid) {
  test(`invalid: "${expr}"`, () => { assert.throws(() => parseCron(expr), (e) => e instanceof CronError && re.test(e.message)); });
}
test('every field error is reported', () => {
  try { parseCron('99 99 * * *'); assert.fail(); } catch (e) { assert.equal(e.errors.length, 2); }
});
test('descriptions', () => {
  assert.equal(describe(parseCron('*/5 * * * *')), 'Every 5 minutes.');
  assert.equal(describe(parseCron('0 9 * * 1-5')), 'At 09:00, on Monday through Friday.');
  assert.equal(describe(parseCron('30 9 * * *')), 'At 09:30.');
  assert.equal(describe(parseCron('0 0 1,15 * *')), 'At 00:00, on the 1st and 15th of the month.');
  assert.equal(describe(parseCron('0 0 13 * 5')), 'At 00:00, on the 13th of the month or on Friday.');
  assert.match(describe(parseCron('0 8-17 * * *')), /between 08:00 and 17:59/);
  assert.match(describe(parseCron('0 0 1 */3 *')), /every 3 months/);
  assert.equal(describe(parseCron('*/30 * * * * *')), 'Every 30 seconds.');
});
test('all presets parse and run', () => {
  for (const [, expr] of PRESETS) assert.ok(nextRuns(parseCron(expr), { from: FROM, count: 2, utc: true }).runs.length === 2, expr);
});
