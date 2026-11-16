import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startServer, launch, newPage, openTool, fillArea, noHorizontalScroll, captureDownload } from './helpers.mjs';
import { verifyJwt } from '../../assets/dev/lib/jwt.js';

let srv, b;
before(async () => { srv = await startServer(8831); b = await launch(); });
after(async () => { await b?.browser.close(); srv?.stop(); });

async function fresh(id, opts) {
  const page = await newPage(b.context, opts);
  await page.goto(srv.url + '/dev');
  await page.evaluate(() => localStorage.clear());
  await openTool(page, srv.url, '/dev', id);
  return page;
}
const T = (id) => `#tool-${id}`;

test('base64: encode UTF-8, decode, invalid position, binary → file download, copy', async () => {
  const page = await fresh('base64');
  const ta = page.locator(`${T('base64')} textarea`).first();
  await fillArea(ta, 'Zoë 🚀 日本');
  await page.click('[data-act=run]');
  const out = page.locator(`${T('base64')} pre`).first();
  assert.equal(await out.textContent(), Buffer.from('Zoë 🚀 日本').toString('base64'));
  await page.locator(`${T('base64')} .dt-panel`).nth(1).getByRole('button', { name: 'Copy' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), Buffer.from('Zoë 🚀 日本').toString('base64'));
  // swap → decode
  await page.click('[data-act=swap]');
  await page.click('[data-act=run]');
  assert.equal(await out.textContent(), 'Zoë 🚀 日本');
  // invalid
  await fillArea(ta, 'SGVs*bG8=');
  await page.click('[data-act=run]');
  assert.match(await page.locator(`${T('base64')} .dt-msg`).first().textContent(), /Invalid Base64 character '\*'.*position 5/i);
  // missing padding note
  await fillArea(ta, 'SGVsbG8');
  await page.click('[data-act=run]');
  assert.equal(await out.textContent(), 'Hello');
  assert.match(await page.locator(`${T('base64')} .dt-msg`).first().textContent(), /missing padding/i);
  // binary (PNG header) → download as .png
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 1, 2, 3]);
  await fillArea(ta, png.toString('base64'));
  await page.click('[data-act=run]');
  const dl = await captureDownload(page, () => page.click('[data-act=download-file]'));
  assert.equal(dl.name, 'decoded.png');
  assert.deepEqual(dl.buffer, png);
  // file → base64 (data URI)
  await page.locator(`${T('base64')} .b64-file-opts input[type=checkbox]`).check();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.b64-drop')]);
  await chooser.setFiles({ name: 'hi.txt', mimeType: 'text/plain', buffer: Buffer.from('hi there') });
  await page.waitForFunction(() => document.querySelectorAll('#tool-base64 pre')[1].textContent.startsWith('data:'));
  assert.equal(await page.locator(`${T('base64')} pre`).nth(1).textContent(), 'data:text/plain;base64,' + Buffer.from('hi there').toString('base64'));
  assert.deepEqual(page.errors, []);
});

test('url encoder: component/form encode, decode error position, URL breakdown', async () => {
  const page = await fresh('url-encoder');
  const ta = page.locator(`${T('url-encoder')} textarea`);
  await fillArea(ta, 'a b&c=é/?');
  await page.click('[data-act=run]');
  const out = page.locator(`${T('url-encoder')} pre`);
  assert.equal(await out.textContent(), 'a%20b%26c%3D%C3%A9%2F%3F');
  await page.locator(`${T('url-encoder')} select`).first().selectOption('form');
  assert.equal(await out.textContent(), 'a+b%26c%3D%C3%A9%2F%3F');
  await page.click(`${T('url-encoder')} .dt-seg [data-v=decode]`);
  await fillArea(ta, 'https://api.example.com:8443/v1/items?id=42&q=caf%C3%A9%20cr%C3%A8me#top');
  await page.click('[data-act=run]');
  assert.equal(await out.textContent(), 'https://api.example.com:8443/v1/items?id=42&q=café crème#top');
  const bd = await page.locator(`${T('url-encoder')} .url-bd`).textContent();
  assert.match(bd, /api\.example\.com/); assert.match(bd, /8443/); assert.match(bd, /café crème/);
  await fillArea(ta, 'discount 100%');
  await page.click('[data-act=run]');
  assert.match(await page.locator(`${T('url-encoder')} .dt-msg`).textContent(), /Malformed escape.*position 13/);
  assert.deepEqual(page.errors, []);
});

test('hash generator: text vectors, checksum compare, file hashing, download', async () => {
  const page = await fresh('hash-generator');
  await fillArea(page.locator(`${T('hash-generator')} textarea`), 'abc');
  const cell = (alg) => page.locator(`${T('hash-generator')} td[data-alg="${alg}"]`);
  await page.waitForFunction(() => document.querySelector('#tool-hash-generator td[data-alg="SHA-256"]')?.textContent === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await cell('MD5').textContent(), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(await cell('SHA-1').textContent(), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.match(await page.locator(`${T('hash-generator')} .hash-table`).textContent(), /not secure/);
  await page.fill('.hash-expect', 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD');
  assert.match(await page.locator(`${T('hash-generator')} .hash-results .dt-msg`).textContent(), /Match — the SHA-256/);
  await page.fill('.hash-expect', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ae');
  assert.match(await page.locator(`${T('hash-generator')} .hash-results .dt-msg`).textContent(), /No match/);
  await page.fill('.hash-expect', '');
  // file tab
  await page.click(`${T('hash-generator')} .dt-tab[data-id=file]`);
  const data = Buffer.alloc(3 * 1024 * 1024, 'x');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.hash-drop')]);
  await chooser.setFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: data });
  await page.waitForFunction(() => /Done/.test(document.querySelector('#tool-hash-generator .hash-prog span').textContent));
  assert.equal(await cell('SHA-512').textContent(), createHash('sha512').update(data).digest('hex'));
  assert.equal(await cell('MD5').textContent(), createHash('md5').update(data).digest('hex'));
  const dl = await captureDownload(page, () => page.click('[data-act=download]'));
  assert.equal(dl.name, 'big.bin.checksums.txt');
  assert.match(dl.text, new RegExp(createHash('sha256').update(data).digest('hex') + '  big.bin'));
  assert.deepEqual(page.errors, []);
});

test('uuid generator: v7 bulk, copy all, download, inspector', async () => {
  const page = await fresh('uuid-generator');
  await page.click(`${T('uuid-generator')} .dt-seg [data-v="7"]`);
  await page.fill('.uuid-count', '25');
  await page.click('[data-act=generate]');
  const text = await page.locator(`${T('uuid-generator')} pre`).textContent();
  const ids = text.split('\n');
  assert.equal(ids.length, 25);
  for (const u of ids) assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual([...ids].sort(), ids, 'v7 ids are time-ordered');
  await page.click('[data-act=copy-all]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
  const dl = await captureDownload(page, () => page.locator(`${T('uuid-generator')} .dt-panel`).getByRole('button', { name: 'Download' }).click());
  assert.equal(dl.text, text);
  await page.fill('.uuid-ins', '{017F22E2-79B0-7CC3-98C4-DC0C0C07398F}');
  await page.waitForSelector('.uuid-valid');
  assert.match(await page.locator(`${T('uuid-generator')} .dt-card`).last().textContent(), /2022-02-22T19:22:22\.000Z/);
  await page.fill('.uuid-ins', 'nope');
  await page.waitForFunction(() => /Not a UUID/.test(document.querySelector('.uuid-ins').parentElement.textContent));
  assert.deepEqual(page.errors, []);
});

test('jwt decoder: sample, expiry, malformed, real verification', async () => {
  const page = await fresh('jwt-decoder');
  assert.match(await page.locator(`${T('jwt-decoder')} .jwt-json`).nth(1).textContent(), /Zoë Example/);
  assert.match(await page.locator('.jwt-status').textContent(), /Signature NOT verified/);
  assert.match(await page.locator('.jwt-status').textContent(), /Not expired/);
  await page.fill('.jwt-key', 'bhaskar-solution-demo-secret');
  await page.click('[data-act=verify]');
  assert.match(await page.locator(`${T('jwt-decoder')} .dt-card`).nth(2).locator('.dt-msg').textContent(), /Signature verified \(HS256\)/);
  await page.fill('.jwt-key', 'wrong');
  await page.click('[data-act=verify]');
  assert.match(await page.locator(`${T('jwt-decoder')} .dt-card`).nth(2).locator('.dt-msg').textContent(), /Signature invalid/);
  // expired token
  await fillArea(page.locator(`${T('jwt-decoder')} textarea`).first(), 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MiIsImlhdCI6MTYwMDAwMDAwMCwiZXhwIjoxNjAwMDAzNjAwfQ.wZRlGJnRlHHs23-UyfbXbUKWd3WI8Xj78OF2V_XGXaI');
  await page.click('[data-act=decode]');
  assert.match(await page.locator('.jwt-status').textContent(), /Expired .* ago/);
  // malformed
  await fillArea(page.locator(`${T('jwt-decoder')} textarea`).first(), 'abc.def');
  await page.click('[data-act=decode]');
  assert.match(await page.locator(`${T('jwt-decoder')} .dt-msg`).first().textContent(), /3 parts/);
  assert.deepEqual(page.errors, []);
});

test('jwt generator: HS256 and ES256 tokens verify independently', async () => {
  const page = await fresh('jwt-generator');
  await page.fill('.jwt-secret', 'a-very-long-and-random-test-secret-123456');
  await page.click('[data-act=sign]');
  const tok = await page.locator('.jwt-out').getAttribute('data-token');
  assert.equal((await verifyJwt(tok, 'a-very-long-and-random-test-secret-123456')).valid, true);
  await page.click('[data-act=copy]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), tok);
  // ES256 with a generated key pair
  await page.locator(`${T('jwt-generator')} select`).first().selectOption('ES256');
  await page.click('[data-act=gen-keys]');
  await page.waitForSelector('.jwt-pem');
  await page.click('[data-act=sign]');
  const tok2 = await page.locator('.jwt-out').getAttribute('data-token');
  const pub = await page.locator('.jwt-pem').textContent();
  assert.equal(JSON.parse(Buffer.from(tok2.split('.')[0], 'base64url')).alg, 'ES256');
  assert.equal((await verifyJwt(tok2, pub)).valid, true);
  // invalid payload JSON
  await fillArea(page.locator(`${T('jwt-generator')} textarea`).nth(1), '{"a": 1,}');
  await page.click('[data-act=sign]');
  assert.match(await page.locator(`${T('jwt-generator')} .dt-msg`).first().textContent(), /Payload: Trailing comma/);
  assert.deepEqual(page.errors, []);
});

test('regex tester: matches, groups, replace, invalid, catastrophic pattern stopped while page stays responsive', async () => {
  const page = await fresh('regex-tester');
  await page.fill('.rx-pattern', '(\\d+)-(?<w>[a-z]+)');
  await fillArea(page.locator(`${T('regex-tester')} textarea`), 'x 12-ab y 7-cd');
  await page.click('[data-act=run]');
  await page.waitForFunction(() => /2 matches/.test(document.querySelector('#tool-regex-tester .dt-stats').textContent));
  assert.equal(await page.locator('.rx-mirror mark').count(), 2);
  assert.match(await page.locator('.rx-matches').textContent(), /12-ab[\s\S]*w[\s\S]*ab/);
  await page.fill('.rx-repl', '$<w>=$1');
  await page.waitForFunction(() => document.querySelector('.rx-replout').textContent === 'x ab=12 y cd=7');
  // invalid
  await page.fill('.rx-pattern', '(abc');
  await page.click('[data-act=run]');
  assert.match(await page.locator(`${T('regex-tester')} .dt-msg`).textContent(), /Invalid regular expression/);
  // catastrophic backtracking
  await page.fill('.rx-pattern', '(a+)+$');
  await fillArea(page.locator(`${T('regex-tester')} textarea`), 'a'.repeat(34) + '!');
  const t0 = Date.now();
  await page.click('[data-act=run]');
  const pong = await page.evaluate(() => 1 + 1); // main thread must answer immediately
  assert.equal(pong, 2);
  assert.ok(Date.now() - t0 < 900, 'page responded while the regex was running');
  await page.waitForFunction(() => /Stopped after 1 s/.test(document.querySelector('#tool-regex-tester .dt-msg')?.textContent || ''), null, { timeout: 5000 });
  assert.match(await page.locator('#tool-regex-tester .dt-stats').textContent(), /Stopped/);
  assert.deepEqual(page.errors, []);
});

test('cron: describe, next runs, invalid field, never-runs, builder', async () => {
  const page = await fresh('cron');
  await page.fill('.cron-expr', '0 9 * * 1-5');
  await page.waitForFunction(() => document.querySelector('.cron-desc').textContent === 'At 09:00, on Monday through Friday.');
  assert.equal(await page.locator('.cron-runs li').count(), 10);
  const times = await page.locator('.cron-runs time').evaluateAll((els) => els.map((e) => new Date(e.dateTime)));
  for (const d of times) { assert.ok(d.getDay() >= 1 && d.getDay() <= 5); assert.equal(d.getHours(), 9); assert.equal(d.getMinutes(), 0); }
  await page.fill('.cron-expr', '0 24 * * *');
  await page.waitForFunction(() => /Hour: 24 is out of range/.test(document.querySelector('#tool-cron .dt-msg').textContent));
  assert.equal(await page.locator('.cron-bad').count(), 1);
  await page.fill('.cron-expr', '0 0 31 2 *');
  await page.waitForFunction(() => /never runs/.test(document.querySelector('.cron-runs').textContent));
  // builder: hour row → specific → pick 06 and 18
  await page.fill('.cron-expr', '30 * * * *');
  await page.waitForTimeout(300);
  const hourRow = page.locator('.cron-row[data-key=hour]');
  await hourRow.locator('select').first().selectOption('specific');
  await hourRow.locator('.cron-chip[data-v="6"]').click();
  await hourRow.locator('.cron-chip[data-v="18"]').click();
  assert.equal(await page.inputValue('.cron-expr'), '30 6,18 * * *');
  assert.equal(await page.locator('.cron-desc').textContent(), 'At 06:30 and 18:30.');
  // UTC toggle
  await page.click(`${T('cron')} .dt-seg [data-v=utc]`);
  const iso = await page.locator('.cron-runs time').first().getAttribute('datetime');
  assert.match(iso, /T(06|18):30:00/);
  await page.click('[data-act=copy]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '30 6,18 * * *');
  assert.deepEqual(page.errors, []);
});

test('every Fork-B developer tool fits 390px without horizontal scroll', async () => {
  for (const id of ['base64', 'url-encoder', 'hash-generator', 'uuid-generator', 'jwt-decoder', 'jwt-generator', 'regex-tester', 'cron']) {
    const page = await fresh(id, { width: 390, height: 844 });
    await page.waitForTimeout(250);
    assert.equal(await noHorizontalScroll(page), true, id);
    assert.deepEqual(page.errors, [], id);
    await page.close();
  }
});
