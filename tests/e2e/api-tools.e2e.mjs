// API & backend tools, end to end, against `wrangler pages dev` (static site + Pages Functions + local D1).
// Wrangler: set WRANGLER_BIN to a wrangler 4.x binary, otherwise `npx --yes wrangler@4.156.2` is used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, launch, newPage, fillArea, noHorizontalScroll } from './helpers.mjs';

// Like helpers.openTool, but waits for the tool to be *attached* (some tools start with a hidden message box).
async function openTool(page, base, path, id) {
  await page.goto(`${base}${path}#${id}`);
  await page.waitForSelector(`#tool-${id} > :not(.dt-loading)`, { state: 'attached', timeout: 15000 });
}

const PORT = 8852;
const BASE = process.env.API_BASE_URL || `http://localhost:${PORT}`;
let wr, b, persist, echo, nocors, gql;
let online = false;

function startWrangler() {
  if (process.env.API_BASE_URL) return null;
  persist = mkdtempSync(join(tmpdir(), 'wr-hooks-'));
  const bin = process.env.WRANGLER_BIN;
  const args = ['pages', 'dev', '.', '--port', String(PORT), '--d1', 'HOOKS_DB=e2e-hooks', '--persist-to', persist, '--log-level', 'warn'];
  return bin ? spawn(bin, args, { cwd: ROOT, stdio: 'ignore', detached: true }) : spawn('npx', ['--yes', 'wrangler@4.156.2', ...args], { cwd: ROOT, stdio: 'ignore', detached: true });
}
async function waitFor(url, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); if (r.status < 500) return; } catch (e) { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
  throw new Error('server did not start: ' + url);
}
function listen(handler, port) { return new Promise((res) => { const s = http.createServer(handler); s.listen(port, '127.0.0.1', () => res(s)); }); }
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString())); });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': 'X-Echo' };

before(async () => {
  wr = startWrangler();
  echo = await listen(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const body = await readBody(req);
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/fail') { res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' }); return res.end('{"error":"boom"}'); }
    if (u.pathname === '/text') { res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' }); return res.end('plain hello'); }
    if (u.pathname === '/slow') { setTimeout(() => { try { res.writeHead(200, CORS); res.end('late'); } catch (e) { /* closed */ } }, 5000); return; }
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'X-Echo': 'yes' });
    res.end(JSON.stringify({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body }));
  }, 8861);
  nocors = await listen((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"secret":true}'); }, 8862);
  gql = await listen(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const raw = await readBody(req);
    let j; try { j = JSON.parse(raw); } catch (e) { res.writeHead(400, CORS); return res.end('bad'); }
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    if (/__schema/.test(j.query)) return res.end(JSON.stringify({ errors: [{ message: 'GraphQL introspection is not allowed' }] }));
    if (/broken/.test(j.query)) return res.end(JSON.stringify({ data: null, errors: [{ message: 'Cannot query field "broken" on type "Query".', locations: [{ line: 1, column: 3 }], path: ['broken'], extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }));
    res.end(JSON.stringify({ data: { echo: { query: j.query, variables: j.variables ?? null, operationName: j.operationName ?? null, contentType: req.headers['content-type'], auth: req.headers.authorization || null } } }));
  }, 8863);
  try { const r = await fetch('https://example.com/', { signal: AbortSignal.timeout(8000) }); online = r.ok; } catch (e) { online = false; }
  await waitFor(BASE + '/api-tools');
  b = await launch();
});
after(async () => {
  await b?.browser.close();
  for (const s of [echo, nocors, gql]) s?.close();
  if (wr) { try { process.kill(-wr.pid, 'SIGTERM'); } catch (e) { /* gone */ } }
  if (persist) rmSync(persist, { recursive: true, force: true });
});

// Chrome logs failed cross-origin fetches as console errors; those are the *expected* outcome of the CORS tests.
const expectedNoise = (e) => /has been blocked by CORS policy|Failed to load resource|net::ERR_FAILED|ERR_CONNECTION_REFUSED/.test(e);
const realErrors = (page) => page.errors.filter((e) => !expectedNoise(e));

/* ---------------- webhook ---------------- */
test('webhook: create endpoint, receive POST + GET, inspect, delete', async () => {
  const page = await newPage(b.context);
  await page.goto(BASE + '/api-tools');
  await page.evaluate(() => localStorage.clear());
  await openTool(page, BASE, '/api-tools', 'webhook');
  await page.click('[data-act=create]');
  const url = await page.locator('.wh-url').inputValue();
  assert.match(url, new RegExp(`^${BASE}/api/hook/[A-Za-z0-9_-]{22}$`));
  let r = await fetch(url + '/orders?source=e2e', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 'sig-123' }, body: JSON.stringify({ event: 'order.paid', amount: 42, name: 'Zoë' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  r = await fetch(url + '?hello=world&n=2');
  assert.equal(r.status, 200);
  await page.waitForFunction(() => document.querySelectorAll('.wh-item').length === 2, null, { timeout: 15000 });
  // newest first: GET
  assert.match(await page.locator('.wh-item').first().textContent(), /GET/);
  await page.locator('.wh-item', { hasText: 'POST' }).click();
  const head = await page.locator('.wh-detail-head').textContent();
  assert.match(head, /POST/);
  assert.match(head, /\/orders\?source=e2e/);
  const body = await page.locator('.wh-detail pre').textContent();
  assert.equal(body, JSON.stringify({ event: 'order.paid', amount: 42, name: 'Zoë' }, null, 2));
  await page.getByRole('tab', { name: /Headers/ }).click();
  const hdrs = await page.locator('.wh-detail table').textContent();
  assert.match(hdrs, /x-signature\s*sig-123/);
  assert.match(hdrs, /content-type\s*application\/json/);
  await page.getByRole('tab', { name: /Query/ }).click();
  assert.match(await page.locator('.wh-detail table').textContent(), /source\s*e2e/);
  // reload keeps the endpoint (id + token in localStorage)
  await page.reload();
  await page.waitForSelector('.wh-url');
  assert.equal(await page.locator('.wh-url').inputValue(), url);
  await page.waitForFunction(() => document.querySelectorAll('.wh-item').length === 2, null, { timeout: 15000 });
  // delete → URL stops working
  await page.click('[data-act=delete]');
  await page.waitForSelector('[data-act=create]');
  r = await fetch(url, { method: 'POST', body: 'x' });
  assert.equal(r.status, 404);
  assert.deepEqual(realErrors(page), []);
});

test('webhook API: token required, oversized payload 413 and not stored, foreign origin refused', async () => {
  const c = await (await fetch(BASE + '/api/hooks', { method: 'POST' })).json();
  assert.equal(c.ok, true);
  assert.equal((await fetch(`${BASE}/api/hooks/${c.id}/requests`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/hooks/${c.id}/requests`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${BASE}/api/hooks/${c.id}/requests`, { headers: { Authorization: 'Bearer ' + c.token, Origin: 'https://evil.example' } })).status, 403);
  const big = await fetch(c.url, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(big.status, 413);
  const bad = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not valid json' });
  assert.equal(bad.status, 200);
  const l = await (await fetch(`${BASE}/api/hooks/${c.id}/requests`, { headers: { Authorization: 'Bearer ' + c.token } })).json();
  assert.equal(l.requests.length, 1, 'oversized payload not stored');
  assert.equal(l.requests[0].body, '{not valid json');
  assert.equal((await fetch(`${BASE}/api/hook/doesnotexistdoesnotexi`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${BASE}/api/hooks/${c.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + c.token } })).status, 200);
  assert.equal((await fetch(c.url)).status, 404);
});

/* ---------------- REST tester ---------------- */
async function rest(page, { method = 'GET', url, via = 'direct' }) {
  await page.selectOption('#tool-rest-tester select.api-method', method);
  await page.fill('#tool-rest-tester .api-url', url);
  await page.locator('#tool-rest-tester .api-via button', { hasText: via === 'proxy' ? 'Secure proxy' : 'Direct' }).click();
}
const sendAndWait = async (page) => {
  await page.click('[data-act=send]');
  await page.waitForFunction(() => { const s = document.querySelector('.api-status'); return s && !s.querySelector('.api-spinner') && s.textContent.trim(); }, null, { timeout: 30000 });
};

test('REST tester (direct): GET JSON with params + headers, POST JSON body, text, 500, timeout, CORS, invalid URL', async () => {
  const page = await newPage(b.context);
  await page.goto(BASE + '/api-tools');
  await page.evaluate(() => localStorage.clear());
  await openTool(page, BASE, '/api-tools', 'rest-tester');
  await rest(page, { url: 'http://127.0.0.1:8861/items?page=2&q=caf%C3%A9' });
  await page.waitForTimeout(400); // URL → params sync (debounced)
  const reqTabs = page.locator('#tool-rest-tester .dt-card').first();
  await reqTabs.getByRole('tab', { name: /Params/ }).click();
  assert.equal(await page.locator('.dt-kv-row input.dt-input').nth(1).inputValue(), '2');
  await reqTabs.getByRole('tab', { name: /Headers/ }).click();
  await page.locator('.dt-kv-add').click();
  const rows = page.locator('.dt-kv-row');
  await rows.last().locator('input.dt-input').first().fill('X-Test');
  await rows.last().locator('input.dt-input').nth(1).fill('héllo-123'.normalize('NFC').replace('é', 'e'));
  await reqTabs.getByRole('tab', { name: /Auth/ }).click();
  await page.locator('.dt-seg button', { hasText: 'Bearer token' }).click();
  await page.fill('.api-auth-fields input', 'tok-abc');
  await sendAndWait(page);
  assert.equal(await page.locator('.api-status .dt-badge').first().getAttribute('data-status'), '200');
  const out = JSON.parse(await page.locator('.api-response pre').textContent());
  assert.equal(out.method, 'GET');
  assert.deepEqual(out.query, { page: '2', q: 'café' });
  assert.equal(out.headers['x-test'], 'hello-123');
  assert.equal(out.headers.authorization, 'Bearer tok-abc');
  // headers tab: only exposed headers are visible directly
  await page.locator('.api-response').getByRole('tab', { name: /Headers/ }).click();
  const ht = await page.locator('.api-headers').textContent();
  assert.match(ht, /x-echo\s*yes/);
  assert.match(ht, /CORS-safelisted/);
  await page.locator('.api-response').getByRole('tab', { name: 'Body' }).click();

  // POST JSON
  await rest(page, { method: 'POST', url: 'http://127.0.0.1:8861/create' });
  await reqTabs.getByRole('tab', { name: /Body/ }).click();
  await page.locator('.dt-seg button', { hasText: /^JSON$/ }).click();
  await fillArea(page.locator('.api-body-area textarea'), '{"name":"Ada","tags":["x"]}');
  await sendAndWait(page);
  const out2 = JSON.parse(await page.locator('.api-response pre').textContent());
  assert.equal(out2.method, 'POST');
  assert.equal(out2.body, '{"name":"Ada","tags":["x"]}');
  assert.equal(out2.headers['content-type'], 'application/json');
  // invalid JSON body is caught before sending
  await fillArea(page.locator('.api-body-area textarea'), '{"name": }');
  await page.click('[data-act=send]');
  assert.match(await page.locator('#tool-rest-tester > .dt-msg').textContent(), /JSON body is invalid/);
  await page.locator('.dt-seg button', { hasText: /^None$/ }).click();

  // non-JSON
  await rest(page, { url: 'http://127.0.0.1:8861/text' });
  await sendAndWait(page);
  assert.equal(await page.locator('.api-response pre').textContent(), 'plain hello');
  // HTTP 500
  await rest(page, { url: 'http://127.0.0.1:8861/fail' });
  await sendAndWait(page);
  assert.equal(await page.locator('.api-status .dt-badge').first().getAttribute('data-status'), '500');
  assert.match(await page.locator('.api-response .dt-msg').textContent(), /HTTP 500/);
  // timeout
  await page.fill('[data-field=timeout]', '1');
  await rest(page, { url: 'http://127.0.0.1:8861/slow' });
  await sendAndWait(page);
  assert.match(await page.locator('.api-response .dt-msg').textContent(), /timed out/);
  await page.fill('[data-field=timeout]', '30');
  // CORS failure
  await rest(page, { url: 'http://127.0.0.1:8862/' });
  await sendAndWait(page);
  const cors = await page.locator('.api-response .dt-msg').textContent();
  assert.match(cors, /CORS/);
  assert.match(cors, /Secure proxy/);
  // invalid URL
  await rest(page, { url: 'http://exa mple' });
  await page.click('[data-act=send]');
  assert.match(await page.locator('#tool-rest-tester > .dt-msg').textContent(), /not a valid URL/);
  // history stored without the bearer token
  const hist = await page.evaluate(() => localStorage.getItem('bs:rest-history'));
  assert.ok(hist.includes('127.0.0.1:8861'));
  assert.ok(!hist.includes('tok-abc'), 'token must not be stored');
  // copy as cURL
  await rest(page, { url: 'http://127.0.0.1:8861/x' });
  await page.getByRole('button', { name: 'Copy as cURL' }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^curl 'http:\/\/127\.0\.0\.1:8861\/x'/);
  assert.deepEqual(realErrors(page), []);
});

test('REST tester (secure proxy): refuses localhost / metadata / private IPs with a clear message', async () => {
  const page = await newPage(b.context);
  await openTool(page, BASE, '/api-tools', 'rest-tester');
  for (const u of ['http://localhost:8861/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/']) {
    await rest(page, { url: u, via: 'proxy' });
    await sendAndWait(page);
    const m = await page.locator('.api-response .dt-msg').textContent();
    assert.match(m, /Blocked destination/, u);
    assert.match(m, /public internet/, u);
  }
  assert.deepEqual(realErrors(page), []);
});

test('REST tester (secure proxy): real public request (skipped when offline)', async (t) => {
  if (!online) return t.skip('offline');
  const page = await newPage(b.context);
  await openTool(page, BASE, '/api-tools', 'rest-tester');
  await rest(page, { url: 'https://example.com/', via: 'proxy' });
  await sendAndWait(page);
  assert.equal(await page.locator('.api-status .dt-badge').first().getAttribute('data-status'), '200');
  assert.match(await page.locator('.api-response pre').textContent(), /Example Domain/);
  await page.locator('.api-response').getByRole('tab', { name: /Headers/ }).click();
  assert.match(await page.locator('.api-headers').textContent(), /content-type/i);
  assert.deepEqual(realErrors(page), []);
});

test('header checker grades a public site (skipped when offline) and reports blocked targets', async (t) => {
  const page = await newPage(b.context);
  await openTool(page, BASE, '/api-tools', 'header-checker');
  await page.fill('#tool-header-checker .api-url', 'http://127.0.0.1/');
  await page.click('[data-act=check]');
  await page.waitForSelector('#tool-header-checker .dt-msg:not([hidden])');
  assert.match(await page.locator('#tool-header-checker .dt-msg').textContent(), /Blocked destination/);
  if (!online) return t.skip('offline');
  await page.fill('#tool-header-checker .api-url', 'https://example.com');
  await page.click('[data-act=check]');
  await page.waitForSelector('.hc-grade', { timeout: 20000 });
  assert.match(await page.locator('.hc-grade').textContent(), /^[A-F]$/);
  assert.ok(await page.locator('.hc-f').count() > 8);
  assert.match(await page.locator('.hc-out').textContent(), /Strict-Transport-Security/);
  assert.deepEqual(realErrors(page), []);
});

test('GraphQL playground: variables, headers, errors display, introspection disabled message, subscription refused', async () => {
  const page = await newPage(b.context);
  await openTool(page, BASE, '/api-tools', 'graphql');
  await page.fill('#tool-graphql .api-url', 'http://127.0.0.1:8863/graphql');
  await fillArea(page.locator('#tool-graphql textarea').first(), 'query One($id: ID!) { user(id: $id) { name } }');
  await fillArea(page.locator('#tool-graphql textarea').nth(1), '{"id": "42"}');
  await page.click('[data-act=run]');
  await page.waitForSelector('.api-status .dt-badge[data-status]');
  const out = JSON.parse(await page.locator('.api-response pre').textContent());
  assert.equal(out.data.echo.query, 'query One($id: ID!) { user(id: $id) { name } }');
  assert.deepEqual(out.data.echo.variables, { id: '42' });
  assert.equal(out.data.echo.contentType, 'application/json');
  // invalid variables
  await fillArea(page.locator('#tool-graphql textarea').nth(1), '{"id": }');
  await page.click('[data-act=run]');
  assert.match(await page.locator('#tool-graphql > .dt-msg').textContent(), /Variables must be valid JSON/);
  await fillArea(page.locator('#tool-graphql textarea').nth(1), '');
  // GraphQL errors
  await fillArea(page.locator('#tool-graphql textarea').first(), '{ broken }');
  await page.click('[data-act=run]');
  await page.waitForSelector('.gql-errors:not([hidden])');
  const errs = await page.locator('.gql-errors').textContent();
  assert.match(errs, /Cannot query field "broken"/);
  assert.match(errs, /path: broken/);
  assert.match(errs, /at 1:3/);
  assert.match(errs, /GRAPHQL_VALIDATION_FAILED/);
  // subscription refused honestly
  await fillArea(page.locator('#tool-graphql textarea').first(), 'subscription { ticks }');
  await page.click('[data-act=run]');
  assert.match(await page.locator('#tool-graphql > .dt-msg').textContent(), /WebSocket/);
  // introspection disabled → honest message
  await page.getByRole('tab', { name: 'Schema' }).click();
  await page.click('[data-act=introspect]');
  const schemaMsg = page.locator('#tool-graphql .dt-card .dt-msg.is-err');
  await schemaMsg.waitFor({ timeout: 10000 });
  assert.match(await schemaMsg.textContent(), /introspection may be disabled[\s\S]*not allowed/);
  assert.deepEqual(realErrors(page), []);
});

test('API tools are usable at 390 px without horizontal scroll (empty and populated)', async () => {
  const page = await newPage(b.context, { width: 390, height: 844 });
  for (const id of ['rest-tester', 'graphql', 'webhook', 'header-checker']) {
    await openTool(page, BASE, '/api-tools', id);
    assert.equal(await noHorizontalScroll(page), true, id);
  }
  // populated REST response
  await openTool(page, BASE, '/api-tools', 'rest-tester');
  await page.fill('#tool-rest-tester .api-url', 'http://127.0.0.1:8861/' + 'very-long-path-segment/'.repeat(8) + '?q=' + 'x'.repeat(200));
  await sendAndWait(page);
  assert.equal(await noHorizontalScroll(page), true, 'rest response');
  // populated webhook
  await page.evaluate(() => localStorage.removeItem('bs:webhook-endpoint'));
  await openTool(page, BASE, '/api-tools', 'webhook');
  await page.click('[data-act=create]');
  const url = await page.locator('.wh-url').inputValue();
  await fetch(url + '/' + 'deep/'.repeat(20) + '?k=' + 'v'.repeat(300), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Long': 'z'.repeat(400) }, body: JSON.stringify({ text: 'w'.repeat(2000) }) });
  await page.waitForSelector('.wh-item', { timeout: 15000 });
  await page.locator('.wh-item').first().click();
  assert.equal(await noHorizontalScroll(page), true, 'webhook detail');
  await page.click('[data-act=delete]');
  assert.deepEqual(realErrors(page), []);
});

test('webhook UI explains a missing database binding (503) plainly', async () => {
  const page = await newPage(b.context);
  await page.route('**/api/hooks', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'storage_not_configured', error: 'x' }) }));
  await page.goto(BASE + '/api-tools');
  await page.evaluate(() => localStorage.removeItem('bs:webhook-endpoint'));
  await openTool(page, BASE, '/api-tools', 'webhook');
  await page.click('[data-act=create]');
  await page.waitForFunction(() => /not switched on/.test(document.querySelector('#tool-webhook > .dt-msg')?.textContent || ''), null, { timeout: 10000 });
  const m = await page.locator('#tool-webhook > .dt-msg').textContent();
  assert.match(m, /not switched on for this website yet/);
  assert.match(m, /All other tools work normally/);
  assert.deepEqual(realErrors(page).filter((e) => !/503/.test(e)), []);
});
