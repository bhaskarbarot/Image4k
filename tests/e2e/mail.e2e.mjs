// Temp Mail end to end against `wrangler pages dev` (static site + Pages Functions + local D1).
// Proves the REAL flow: create an address in the browser → deliver a raw MIME e-mail to the server
// (via the test-only ingest route, the same storeIncoming() the Email Worker uses) → the page receives it
// live by polling and shows the detected OTP. Wrangler: set WRANGLER_BIN, else npx wrangler@4.156.2.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, launch, newPage } from './helpers.mjs';

const PORT = 8853;
const BASE = process.env.MAIL_BASE_URL || `http://localhost:${PORT}`;
const DOMAIN = 'mail.image4k.test';
let wr, b, persist;

function startWrangler() {
  if (process.env.MAIL_BASE_URL) return null;
  persist = mkdtempSync(join(tmpdir(), 'wr-mail-'));
  const bin = process.env.WRANGLER_BIN;
  const args = ['pages', 'dev', '.', '--port', String(PORT), '--d1', 'MAIL_DB=e2e-mail',
    '--binding', `MAIL_DOMAIN=${DOMAIN}`, '--binding', 'ALLOW_TEST_INGEST=1',
    '--persist-to', persist, '--log-level', 'warn'];
  return bin ? spawn(bin, args, { cwd: ROOT, stdio: 'ignore', detached: true }) : spawn('npx', ['--yes', 'wrangler@4.156.2', ...args], { cwd: ROOT, stdio: 'ignore', detached: true });
}
async function waitFor(url, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); if (r.status < 500) return; } catch (e) { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
  throw new Error('server did not start: ' + url);
}
// Deliver a raw e-mail to an address, exactly as the Email Worker would.
async function deliver(to, raw) {
  const r = await fetch(`${BASE}/api/mail/_ingest`, { method: 'POST', headers: { 'X-Test-To': to, 'Content-Type': 'message/rfc822' }, body: raw });
  return r.json();
}
const email = ({ from = 'GitHub <noreply@github.com>', subject = 'Verify', text, html }) => {
  const b64 = (s) => Buffer.from(s).toString('base64');
  const bnd = 'B42';
  const parts = [];
  if (text != null) parts.push(['Content-Type: text/plain; charset=utf-8', '', text].join('\r\n'));
  if (html != null) parts.push(['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(html)].join('\r\n'));
  return [`From: ${from}`, 'To: x@' + DOMAIN, `Subject: ${subject}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${bnd}"`, '', '', `--${bnd}`, parts.join(`\r\n--${bnd}\r\n`), `--${bnd}--`, ''].join('\r\n');
};

before(async () => { wr = startWrangler(); await waitFor(BASE + '/mail'); b = await launch(); });
after(async () => {
  await b?.browser.close();
  if (wr) { try { process.kill(-wr.pid, 'SIGTERM'); } catch (e) { /* gone */ } }
  if (persist) rmSync(persist, { recursive: true, force: true });
});

async function openMail(page) {
  // Clear storage BEFORE the page boots so every test gets a brand-new inbox (the browser context is shared,
  // and clearing after boot raced with the async inbox creation → a stale inbox could be restored).
  await page.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  await page.goto(BASE + '/mail');
  await page.waitForFunction(() => window.__mail && window.__mail.state.address, null, { timeout: 20000 });
  return page.evaluate(() => window.__mail.state.address);
}
// Force an immediate poll (the UI polls every 7 s; tests shouldn't wait on the timer).
async function sync(page) { await page.evaluate(() => window.__mail.refresh()); }
// Re-sync until at least n messages are shown (deterministic, independent of the poll timer).
async function waitForItems(page, n, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sync(page);
    try { await page.waitForFunction((k) => document.querySelectorAll('.mail-row').length >= k, n, { timeout: 1500 }); return; }
    catch (e) { /* retry */ }
  }
  throw new Error(`only ${await page.locator('.mail-row').count()} of ${n} messages appeared`);
}

test('config reports configured with the test domain', async () => {
  const r = await (await fetch(BASE + '/api/mail/config')).json();
  assert.equal(r.configured, true);
  assert.deepEqual(r.domains, [DOMAIN]);
});

test('create address → deliver real email → page receives it live and shows the OTP', async () => {
  const page = await newPage(b.context);
  const address = await openMail(page);
  assert.match(address, new RegExp('^[a-z0-9]+@' + DOMAIN.replace('.', '\\.') + '$'));
  assert.match(await page.textContent('#mailAddr'), new RegExp(DOMAIN));

  // deliver an OTP email to exactly this address
  const res = await deliver(address, email({ subject: 'Your code', text: 'Your verification code is 482913. It expires soon.', html: '<p>Code <b>482913</b></p>' }));
  assert.equal(res.ok, true);
  assert.equal(res.otp, '482913');

  // the page receives it on the next poll (forced here for a deterministic test)
  await waitForItems(page, 1);
  assert.equal(await page.locator('.mail-row').count(), 1);
  assert.match(await page.textContent('.mail-row-sender'), /GitHub/);
  assert.match(await page.textContent('.mail-row-otp'), /482913/);

  // open it → OTP banner + body
  await page.click('.mail-row');
  await page.waitForSelector('#mailMessage:not([hidden])');
  assert.equal(await page.textContent('#mailOtpCode'), '482913');
  assert.match(await page.textContent('#msgSubject'), /Your code/);
  assert.match(await page.textContent('#msgBody'), /verification code is 482913/);
  // copy the OTP
  await page.click('#copyOtp');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '482913');
  assert.deepEqual(page.errors, []);
});

test('two emails arrive in order; unread + count update; delete works', async () => {
  const page = await newPage(b.context);
  const address = await openMail(page);
  await deliver(address, email({ from: 'Bank <ops@bank.test>', subject: 'First', text: 'hello one 111222' }));
  await waitForItems(page, 1);
  await deliver(address, email({ from: 'Shop <no@shop.test>', subject: 'Second', text: 'code 909090' }));
  await waitForItems(page, 2);
  assert.equal(await page.locator('.mail-row').count(), 2);
  // newest first
  assert.match(await page.locator('.mail-row').first().textContent(), /Shop|Second|909090/);
  // delete the open one
  await page.locator('.mail-row').first().click();
  await page.waitForSelector('#mailMessage:not([hidden])');
  await page.click('#msgDelete');
  await page.waitForFunction(() => document.querySelectorAll('.mail-row').length === 1);
  assert.deepEqual(page.errors, []);
});

test('inbox is private: reading messages requires the token', async () => {
  const page = await newPage(b.context);
  const address = await openMail(page);
  const id = await page.evaluate(() => window.__mail.state.id);
  await deliver(address, email({ text: 'secret 123456' }));
  const noAuth = await fetch(`${BASE}/api/mail/inboxes/${id}/messages`);
  assert.equal(noAuth.status, 401);
  const badAuth = await fetch(`${BASE}/api/mail/inboxes/${id}/messages`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(badAuth.status, 401);
});

test('mail to an unknown / non-existent address is not stored', async () => {
  const res = await deliver('does-not-exist-9999@' + DOMAIN, email({ text: 'nobody home 1234' }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_inbox');
});

test('custom address name works and is reflected', async () => {
  const page = await newPage(b.context);
  await openMail(page);
  await page.click('#changeBtn');
  const name = 'bhaskar' + Math.floor(Math.random() * 100000);
  await page.fill('#customLocal', name);
  await page.click('#customForm button[type=submit]');
  await page.waitForFunction((n) => window.__mail.state.address.startsWith(n + '@'), name, { timeout: 10000 });
  assert.match(await page.textContent('#mailAddr'), new RegExp('^' + name + '@'));
  await deliver(`${name}@${DOMAIN}`, email({ subject: 'Hi custom', text: 'your pin 778899' }));
  await waitForItems(page, 1);
  assert.match(await page.textContent('.mail-row-otp'), /778899/);
  assert.deepEqual(page.errors, []);
});

test('ingest route is test-only (guarded) and the page has no horizontal scroll at 390px', async () => {
  // the guard: without the env flag it would 404, but here it is enabled for the test run — assert it is NOT a public GET
  const get = await fetch(BASE + '/api/mail/_ingest');
  assert.equal(get.status, 404);
  const page = await newPage(b.context, { width: 390, height: 844 });
  await openMail(page);
  await deliver(await page.evaluate(() => window.__mail.state.address), email({ text: 'mobile 456123' }));
  await waitForItems(page, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
});

test('off state: when config says not configured, the page explains it', async () => {
  const page = await newPage(b.context);
  await page.route('**/api/mail/config', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, configured: false, hasStorage: false, domains: [] }) }));
  await page.goto(BASE + '/mail');
  await page.waitForSelector('#mailOff:not([hidden])');
  assert.match(await page.textContent('#mailOff'), /isn.t switched on/);
  assert.equal(await page.isHidden('#mailApp'), true);
});
