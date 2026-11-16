import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, newPage, openTool, fillArea, noHorizontalScroll, captureDownload } from './helpers.mjs';

let srv, b;
before(async () => { srv = await startServer(8811); b = await launch(); });
after(async () => { await b?.browser.close(); srv?.stop(); });

test('dev page overview lists all 17 developer tools and search filters', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/dev');
  await page.waitForSelector('.dt-nav-link');
  assert.equal(await page.locator('.dt-main .dt-ov-card').count(), 17);
  await page.fill('.dt-search', 'jwt');
  const names = await page.locator('.dt-nav a.dt-nav-link:not(.is-ext)').allTextContents();
  assert.deepEqual(names, ['JWT Decoder', 'JWT Generator']);
  assert.deepEqual(page.errors, []);
});

test('JSON formatter: format, minify, validate, error location, copy, download', async () => {
  const page = await newPage(b.context);
  await openTool(page, srv.url, '/dev', 'json-formatter');
  const ta = page.locator('#tool-json-formatter textarea');
  await fillArea(ta, '{"b":[1,2],"id":12345678901234567890,"name":"Zoë"}');
  await page.click('[data-act=format]');
  const out = page.locator('#tool-json-formatter pre');
  assert.equal(await out.textContent(), '{\n  "b": [\n    1,\n    2\n  ],\n  "id": 12345678901234567890,\n  "name": "Zoë"\n}');
  await page.click('[data-act=minify]');
  assert.equal(await out.textContent(), '{"b":[1,2],"id":12345678901234567890,"name":"Zoë"}');
  // copy
  await page.locator('#tool-json-formatter .dt-panel').nth(1).getByRole('button', { name: 'Copy' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '{"b":[1,2],"id":12345678901234567890,"name":"Zoë"}');
  // download
  const dl = await captureDownload(page, () => page.locator('#tool-json-formatter .dt-panel').nth(1).getByRole('button', { name: 'Download' }).click());
  assert.equal(dl.name, 'formatted.json');
  assert.equal(dl.text, '{"b":[1,2],"id":12345678901234567890,"name":"Zoë"}');
  // invalid
  await fillArea(ta, '{\n  "a": 1,\n  "b": 2,\n}');
  await page.click('[data-act=format]');
  const msg = await page.locator('#tool-json-formatter .dt-msg').textContent();
  assert.match(msg, /Trailing comma/);
  assert.match(msg, /Line 4, column 1/);
  assert.equal((await out.textContent()).trim(), 'Formatted JSON will appear here.');
  // empty
  await fillArea(ta, '');
  await page.click('[data-act=format]');
  assert.match(await page.locator('#tool-json-formatter .dt-msg').textContent(), /Nothing to format/);
  assert.deepEqual(page.errors, []);
});

test('JSON formatter is usable at 390px without horizontal scroll', async () => {
  const page = await newPage(b.context, { width: 390, height: 844 });
  await openTool(page, srv.url, '/dev', 'json-formatter');
  await fillArea(page.locator('#tool-json-formatter textarea'), JSON.stringify({ long: 'x'.repeat(500), arr: Array.from({ length: 50 }, (_, i) => i) }));
  await page.click('[data-act=format]');
  assert.equal(await noHorizontalScroll(page), true);
  assert.deepEqual(page.errors, []);
});
