// Temp Mail via the mail.tm provider — mail.tm is MOCKED with page.route so the test is deterministic and
// never touches the real service. Covers: instant address, custom name, live receive + OTP, every button.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, newPage, noHorizontalScroll, captureDownload } from './helpers.mjs';

let srv, b;
before(async () => { srv = await startServer(8815); b = await launch(); });
after(async () => { await b?.browser.close(); srv?.stop(); });

// Install a mock mail.tm backend on a page. Returns helpers to deliver mail.
async function mockMailTm(page) {
  const state = { inbox: [], full: {}, lastAddress: null };
  await page.route('https://api.mail.tm/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname, method = req.method();
    const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (p === '/domains') return json({ 'hydra:member': [{ id: 'd1', domain: 'mocktm.test', isActive: true, isPrivate: false }] });
    if (p === '/accounts' && method === 'POST') { const body = JSON.parse(req.postData() || '{}'); state.lastAddress = body.address; return json({ id: 'acc1', address: body.address }, 201); }
    if (p === '/token' && method === 'POST') return json({ id: 'acc1', token: 'tok-abc' });
    if (p === '/messages' && method === 'GET') return json({ 'hydra:member': state.inbox, 'hydra:totalItems': state.inbox.length });
    const mm = p.match(/^\/messages\/(.+)$/);
    if (mm) { const id = decodeURIComponent(mm[1]); if (method === 'DELETE') { state.inbox = state.inbox.filter((x) => x.id !== id); return route.fulfill({ status: 204, body: '' }); } return json(state.full[id] || {}, state.full[id] ? 200 : 404); }
    if (p.startsWith('/accounts/') && method === 'DELETE') { state.inbox = []; state.full = {}; return route.fulfill({ status: 204, body: '' }); }
    return json({}, 404);
  });
  return {
    deliver({ id, from, name, subject, intro, text, html }) {
      const createdAt = new Date().toISOString();
      state.inbox.unshift({ id, from: { address: from, name }, subject, intro, seen: false, hasAttachments: false, createdAt });
      state.full[id] = { id, from: { address: from, name }, subject, intro, text: text || '', html: html ? [html] : [], attachments: [], seen: false, createdAt };
    },
    get address() { return state.lastAddress; },
  };
}
async function openMail(page) {
  await page.goto(srv.url + '/mail');
  await page.waitForFunction(() => window.__mail && window.__mail.provider === 'mailtm' && window.__mail.state.address, null, { timeout: 15000 });
  return page.evaluate(() => window.__mail.state.address);
}
async function sync(page) { await page.evaluate(() => window.__mail.refresh()); }

test('instant mail.tm inbox: address created, FREE banner, address domain is the service domain', async () => {
  const page = await newPage(b.context);
  const mock = await mockMailTm(page);
  const addr = await openMail(page);
  assert.match(addr, /@mocktm\.test$/);
  assert.match(await page.textContent('#mailAddr'), /@mocktm\.test$/);
  assert.match(await page.textContent('#mailDemoBanner'), /mail\.tm/);
  assert.equal(await page.isVisible('#mailEmpty'), true);
  assert.deepEqual(page.errors.filter((e) => !/404/.test(e)), []);
});

test('receives a real-shaped OTP email live, shows & copies the code, deletes it', async () => {
  const page = await newPage(b.context);
  const mock = await mockMailTm(page);
  const addr = await openMail(page);
  mock.deliver({ id: 'm1', from: 'login@stytch.com', name: 'Groq', subject: 'Your Groq login code', intro: 'Your login code is 628413. It expires in 10 minutes.', text: 'Your login code is 628413. It expires in 10 minutes.' });
  await sync(page);
  await page.waitForSelector('.mail-row', { timeout: 10000 });
  assert.match(await page.textContent('.mail-row-sender'), /Groq/);
  assert.match(await page.textContent('.mail-row-otp'), /628413/);
  await page.click('.mail-row');
  await page.waitForSelector('#mailMessage:not([hidden])');
  assert.equal(await page.textContent('#mailOtpCode'), '628413');
  assert.match(await page.textContent('#msgBody'), /login code is 628413/);
  await page.click('#copyOtp');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '628413');
  // delete this message
  await page.click('#msgDelete');
  await page.waitForFunction(() => document.querySelectorAll('.mail-row').length === 0);
  assert.deepEqual(page.errors.filter((e) => !/404/.test(e)), []);
});

test('custom name: user picks their own mailbox name', async () => {
  const page = await newPage(b.context);
  const mock = await mockMailTm(page);
  await openMail(page);
  await page.click('#changeBtn');
  await page.fill('#customLocal', 'bhaskar');
  await page.click('#customForm button[type=submit]');
  await page.waitForFunction(() => window.__mail.state.address.startsWith('bhaskar@'), null, { timeout: 8000 });
  assert.equal(await page.textContent('#mailAddr'), 'bhaskar@mocktm.test');
});

test('all buttons work: Copy, Refresh, QR, Change, Delete (new address), View', async () => {
  const page = await newPage(b.context);
  const mock = await mockMailTm(page);
  const first = await openMail(page);
  // Copy (address)
  await page.click('#copyBtn');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), first);
  // Refresh (no error, spins)
  await page.click('#refreshBtn');
  // QR modal
  await page.click('#qrBtn');
  await page.waitForSelector('#qrModal:not([hidden])');
  assert.match(await page.textContent('#qrAddr'), /@mocktm\.test$/);
  await page.waitForSelector('#qrCanvas canvas, #qrCanvas svg', { timeout: 8000 });
  await page.click('#qrClose');
  assert.equal(await page.isHidden('#qrModal'), true);
  // deliver, View button opens it
  mock.deliver({ id: 'v1', from: 'no@shop.test', name: 'Shop', subject: 'Order', intro: 'code 112233', text: 'your code 112233' });
  await sync(page);
  await page.waitForSelector('.mail-row');
  await page.locator('.mail-view-btn').first().click();
  await page.waitForSelector('#mailMessage:not([hidden])');
  await page.click('#msgBack');
  // Delete inbox → brand new address
  page.on('dialog', (d) => d.accept());
  await page.click('#deleteBtn');
  await page.waitForFunction((a) => window.__mail.state.address && window.__mail.state.address !== a, first, { timeout: 8000 });
  assert.notEqual(await page.textContent('#mailAddr'), first);
  assert.deepEqual(page.errors.filter((e) => !/404/.test(e)), []);
});

test('mail.tm inbox works at 390px without horizontal scroll', async () => {
  const page = await newPage(b.context, { width: 390, height: 844 });
  const mock = await mockMailTm(page);
  await openMail(page);
  mock.deliver({ id: 'z1', from: 'a@b.test', name: 'Svc', subject: 'Hi', intro: 'code 456789', text: 'code 456789' });
  await sync(page);
  await page.waitForSelector('.mail-row');
  assert.equal(await noHorizontalScroll(page), true);
});
