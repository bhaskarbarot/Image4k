// Temp Mail DEMO mode — runs against the static server (serve.py), no backend needed.
// Proves anyone can try the full experience in-browser when the real inbox isn't switched on yet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, newPage, noHorizontalScroll } from './helpers.mjs';

let srv, b;
before(async () => { srv = await startServer(8814); b = await launch(); });
after(async () => { await b?.browser.close(); srv?.stop(); });

test('off-state shows a demo button; demo delivers live OTP emails you can open and copy', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/mail');
  await page.waitForSelector('#mailOff:not([hidden])');
  assert.equal(await page.isVisible('#demoBtn'), true);
  await page.click('#demoBtn');
  assert.equal(await page.isVisible('#mailDemoBanner'), true);
  assert.match(await page.textContent('#mailAddr'), /@demo-inbox\.test$/);
  // three sample emails arrive over a few seconds (no reload)
  await page.waitForFunction(() => document.querySelectorAll('.mail-row').length >= 3, null, { timeout: 12000 });
  assert.match(await page.textContent('#mailList'), /Groq/);
  // newest first (GitHub), open it → OTP + copy
  await page.locator('.mail-row').first().click();
  await page.waitForSelector('#mailMessage:not([hidden])');
  const code = await page.textContent('#mailOtpCode');
  assert.match(code, /^\d{6}$/);
  await page.click('#copyOtp');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code);
  // the only console noise is the expected backend-config 404 on the static server
  assert.deepEqual(page.errors.filter((e) => !/404/.test(e)), []);
});

test('demo: delete a message and get a new address', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/mail');
  await page.waitForSelector('#demoBtn');
  await page.evaluate(() => window.__mail.startDemo());
  await page.waitForFunction(() => document.querySelectorAll('.mail-row').length >= 1, null, { timeout: 8000 });
  const first = await page.evaluate(() => window.__mail.state.address);
  await page.locator('.mail-row').first().click();
  await page.waitForSelector('#mailMessage:not([hidden])');
  const before = await page.locator('.mail-row').count();
  await page.click('#msgDelete');
  await page.waitForFunction((n) => document.querySelectorAll('.mail-row').length === n - 1, before, { timeout: 5000 });
  assert.ok(typeof first === 'string' && first.length > 5);
});

test('demo works at 390px without horizontal scroll', async () => {
  const page = await newPage(b.context, { width: 390, height: 844 });
  await page.goto(srv.url + '/mail');
  await page.waitForSelector('#demoBtn');
  await page.click('#demoBtn');
  await page.waitForSelector('.mail-row', { timeout: 8000 });
  assert.equal(await noHorizontalScroll(page), true);
});
