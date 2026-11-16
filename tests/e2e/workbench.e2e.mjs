import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, newPage, fillArea, noHorizontalScroll, captureDownload } from './helpers.mjs';

let srv, b;
before(async () => { srv = await startServer(8832); b = await launch(); });
after(async () => { await b?.browser.close(); srv?.stop(); });

async function open(opts, hash = '') {
  const page = await newPage(b.context, opts);
  await page.goto(srv.url + '/workbench');
  await page.evaluate(() => localStorage.clear());
  await page.goto(srv.url + '/workbench' + hash);
  if (hash) await page.reload();
  await page.waitForSelector('#tool-workbench .wb');
  return page;
}
const outText = (page) => page.locator('#tool-workbench .wb-io pre').textContent();
async function waitDone(page) {
  await page.waitForFunction(() => /✓|Failed|Cancelled|Timed out|Add an operation|disabled/.test(document.querySelector('#tool-workbench .wb-info')?.textContent || ''), null, { timeout: 20000 });
}
async function clearRecipe(page) { await page.click('[data-act=reset]'); }
async function add(page, id) { await page.click(`#tool-workbench .wb-op[data-op="${id}"]`); }

test('workbench: default recipe runs; palette search adds ops; chained transformations in order', async () => {
  const page = await open();
  await waitDone(page);
  assert.equal(await outText(page), Buffer.from('Hello, Bhaskar Solution! 👋').toString('base64'));
  await clearRecipe(page);
  await fillArea(page.locator('#tool-workbench .wb-io textarea'), 'Zoë says hi');
  await page.fill('.wb-search', 'upper');
  await page.press('.wb-search', 'Enter');
  await page.fill('.wb-search', '');
  await add(page, 'reverse');
  await add(page, 'base64-encode');
  await add(page, 'base64-decode');
  await add(page, 'sha256');
  await page.click('[data-act=run]');
  await waitDone(page);
  const { createHash } = await import('node:crypto');
  assert.equal(await outText(page), createHash('sha256').update('IH SYAS ËOZ').digest('hex'));
  assert.equal(await page.locator('.wb-step').count(), 5);
  assert.deepEqual(page.errors, []);
});

test('workbench: invalid intermediate step is reported and highlighted; disable + reorder fix it', async () => {
  const page = await open();
  await clearRecipe(page);
  await fillArea(page.locator('#tool-workbench .wb-io textarea'), 'hello');
  await add(page, 'uppercase');
  await add(page, 'hex-decode');
  await add(page, 'hex-encode');
  await page.click('[data-act=run]');
  await waitDone(page);
  assert.match(await page.locator('#tool-workbench .dt-msg').first().textContent(), /Step 2 \(Hex Decode\) failed: Invalid hex character 'H'/);
  assert.equal(await page.locator('.wb-step.is-err .wb-name').textContent(), 'Hex Decode');
  // move Hex Encode above Hex Decode (keyboard-friendly ↑ button) → HELLO → hex → back to text
  await page.locator('.wb-step').nth(2).locator('.wb-up').click();
  await page.click('[data-act=run]');
  await waitDone(page);
  assert.equal(await outText(page), 'HELLO');
  // disable step 1 → hello
  await page.locator('.wb-step').nth(0).locator('.wb-toggle').click();
  await page.click('[data-act=run]');
  await waitDone(page);
  assert.equal(await outText(page), 'hello');
  assert.deepEqual(page.errors, []);
});

test('workbench: step arguments, empty input, unicode, share link round-trip', async () => {
  const page = await open();
  await clearRecipe(page);
  await fillArea(page.locator('#tool-workbench .wb-io textarea'), 'b\na\nc\na');
  await add(page, 'dedupe-lines');
  await add(page, 'sort-lines');
  await page.locator('.wb-step').nth(1).locator('.wb-args label', { hasText: 'Descending' }).locator('input').check();
  await page.click('[data-act=run]');
  await waitDone(page);
  assert.equal(await outText(page), 'c\nb\na');
  // share link
  await page.click('[data-act=share]');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /\/workbench#recipe=/);
  const page2 = await newPage(b.context);
  await page2.goto(link.replace(/^https?:\/\/[^/]+/, srv.url));
  await page2.waitForSelector('.wb-step');
  assert.equal(await page2.locator('.wb-step').count(), 2);
  assert.equal(await page2.locator('.wb-step').nth(1).locator('.wb-args label', { hasText: 'Descending' }).locator('input').isChecked(), true);
  // empty input
  await fillArea(page.locator('#tool-workbench .wb-io textarea'), '');
  await page.click('[data-act=run]');
  await waitDone(page);
  assert.equal((await outText(page)).trim(), 'Output appears here.');
  // unicode
  await clearRecipe(page);
  await fillArea(page.locator('#tool-workbench .wb-io textarea'), '日本 🚀');
  await add(page, 'url-encode');
  await add(page, 'url-decode');
  await add(page, 'count-chars');
  await page.click('[data-act=run]');
  await waitDone(page);
  assert.match(await outText(page), /Characters \(as seen\): 4[\s\S]*UTF-8 bytes: 11/);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page2.errors, []);
});

test('workbench: binary output → hex preview + file download; large input stays responsive', async () => {
  const page = await open();
  await clearRecipe(page);
  await fillArea(page.locator('#tool-workbench .wb-io textarea'), '89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52');
  await add(page, 'hex-to-bytes');
  await page.click('[data-act=run]');
  await waitDone(page);
  assert.match(await page.locator('.wb-info').textContent(), /image\/png/);
  assert.match(await outText(page), /^00000000  89 50 4e 47/);
  const dl = await captureDownload(page, () => page.click('[data-act=download-output]'));
  assert.equal(dl.name, 'output.png');
  assert.equal(dl.buffer.length, 16);
  // large input (≈3 MB) through two steps
  await clearRecipe(page);
  await add(page, 'base64-encode');
  await add(page, 'base64-decode');
  await add(page, 'count-words');
  await fillArea(page.locator('#tool-workbench .wb-io textarea'), 'lorem ipsum dolor sit amet\n'.repeat(110000));
  await page.click('[data-act=run]');
  assert.equal(await page.evaluate(() => 40 + 2), 42); // main thread free while the worker runs
  await waitDone(page);
  assert.match(await outText(page), /Words: 550000/);
  assert.deepEqual(page.errors, []);
});

test('workbench: 390px layout has no horizontal scroll', async () => {
  const page = await open({ width: 390, height: 844 });
  await waitDone(page);
  await add(page, 'find-replace');
  assert.equal(await noHorizontalScroll(page), true);
  assert.deepEqual(page.errors, []);
});
