import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, newPage, openTool, fillArea, noHorizontalScroll, captureDownload } from './helpers.mjs';

let srv, b;
before(async () => { srv = await startServer(8841); b = await launch(); });
after(async () => { await b?.browser.close(); srv?.stop(); });

const CURL = `curl -X POST 'https://api.example.com/v1/items?x=1' \\
  -H 'Content-Type: application/json' \\
  -H "X-Note: it's" \\
  -d '{"name":"Zoë","qty":2}' -o out.json --frobnicate`;

test('cURL → Code: converts, shows warnings, switches languages, copy + download', async () => {
  const page = await newPage(b.context);
  await openTool(page, srv.url, '/dev', 'curl-to-code');
  const t = page.locator('#tool-curl-to-code');
  await fillArea(t.locator('textarea'), CURL);
  await t.locator('[data-act=convert]').click();
  const code = () => t.locator('pre').textContent();
  assert.match(await code(), /await fetch\('https:\/\/api\.example\.com\/v1\/items\?x=1'/);
  assert.match(await code(), /JSON\.stringify\(\{\n {4}name: 'Zoë',/);
  const warn = await t.locator('.cc-warnings').textContent();
  assert.match(warn, /-o out\.json/);
  assert.match(warn, /--frobnicate/);
  assert.match(await t.locator('.cc-summary').textContent(), /POST/);
  // python tab
  await t.getByRole('tab', { name: 'Python – Requests' }).click();
  assert.match(await code(), /requests\.post\(/);
  assert.match(await code(), /json=json_data/);
  // copy
  await t.locator('.dt-panel').last().getByRole('button', { name: 'Copy' }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /import requests/);
  // download keeps language extension
  const dl = await captureDownload(page, () => t.locator('.dt-panel').last().getByRole('button', { name: 'Download' }).click());
  assert.equal(dl.name, 'request.py');
  assert.match(dl.text, /requests\.post/);
  // Java filename
  await t.getByRole('tab', { name: 'Java – HttpClient' }).click();
  assert.match(await code(), /public class Main/);
  // error
  await fillArea(t.locator('textarea'), 'wget https://x');
  await t.locator('[data-act=convert]').click();
  assert.match(await t.locator('.dt-msg.is-err').textContent(), /start with "curl"/);
  await fillArea(t.locator('textarea'), "curl 'unterminated");
  await t.locator('[data-act=convert]').click();
  assert.match(await t.locator('.dt-msg.is-err').textContent(), /Unterminated/);
  assert.deepEqual(page.errors, []);
});

test('cURL generator: builds command, quoting per shell, copy', async () => {
  const page = await newPage(b.context);
  await openTool(page, srv.url, '/api-tools', 'curl-generator');
  const t = page.locator('#tool-curl-generator');
  await t.locator('select').first().selectOption('POST');
  await t.locator('.cg-url').fill("https://api.example.com/it's");
  await t.getByRole('tab', { name: 'Body' }).click();
  await t.getByRole('radio', { name: 'JSON' }).click();
  await t.locator('.cg-body').fill('{"a":"b"}');
  await t.getByRole('tab', { name: 'Auth' }).click();
  await t.getByRole('radio', { name: 'Bearer' }).click();
  await t.getByLabel('Bearer token').fill('tok123');
  const out = () => t.locator('pre').textContent();
  let cmd = await out();
  assert.match(cmd, /^curl 'https:\/\/api\.example\.com\/it'\\''s\?page=1' \\/);
  assert.match(cmd, /-H 'Authorization: Bearer tok123'/);
  assert.match(cmd, /-H 'Content-Type: application\/json'/);
  assert.match(cmd, /--data-raw '\{"a":"b"\}'/);
  await t.getByRole('radio', { name: 'Windows CMD' }).click();
  cmd = await out();
  assert.match(cmd, /--data-raw "\{\\"a\\":\\"b\\"\}"/);
  assert.match(cmd, / \^\n/);
  await t.getByRole('radio', { name: 'PowerShell' }).click();
  assert.match(await out(), /^curl\.exe /);
  await t.locator('[data-act=copy-command]').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^curl\.exe/);
  // invalid JSON body warns
  await t.getByRole('tab', { name: 'Body' }).click();
  await t.locator('.cg-body').fill('{bad');
  assert.match(await t.locator('.dt-msg').textContent(), /JSON body is not valid/);
  assert.deepEqual(page.errors, []);
});

test('OpenAPI viewer: sample loads, search, expand operation, validation errors, bad input', async () => {
  const page = await newPage(b.context);
  await openTool(page, srv.url, '/api-tools', 'openapi-viewer');
  const t = page.locator('#tool-openapi-viewer');
  await t.getByRole('button', { name: 'Load sample' }).click();
  assert.match(await t.locator('.oa-title').textContent(), /Bookshop API/);
  assert.match(await t.locator('.oa-info').textContent(), /Valid structure/);
  assert.equal(await t.locator('.oa-op').count(), 4);
  await t.locator('.oa-search').fill('cancel');
  await page.waitForFunction(() => document.querySelectorAll('#tool-openapi-viewer .oa-op').length === 1);
  await t.locator('.oa-search').fill('');
  await page.waitForFunction(() => document.querySelectorAll('#tool-openapi-viewer .oa-op').length === 4);
  await t.locator('.oa-op-sum', { hasText: '/orders' }).first().click();
  await t.locator('.oa-op[open] .oa-op-body').waitFor();
  const body = await t.locator('.oa-op[open]').textContent();
  assert.match(body, /Request body/);
  assert.match(body, /bookId/);
  assert.match(body, /201/);
  // invalid spec
  await fillArea(t.locator('textarea'), JSON.stringify({ openapi: '3.0.0', info: {}, paths: { '/a/{id}': { get: {} } } }));
  await t.locator('[data-act=load]').click();
  const issues = await t.locator('.oa-issues').textContent();
  assert.match(issues, /info\.title/);
  assert.match(issues, /\{id\} is used in the path but not declared/);
  // untrusted HTML is shown as text
  await fillArea(t.locator('textarea'), JSON.stringify({ openapi: '3.0.0', info: { title: '<img src=x onerror=alert(1)>', version: '1' }, paths: {} }));
  await t.locator('[data-act=load]').click();
  assert.equal(await t.locator('.oa-title').textContent(), '<img src=x onerror=alert(1)>');
  assert.equal(await t.locator('.oa-view img').count(), 0);
  // parse error
  await fillArea(t.locator('textarea'), '{"openapi": }');
  await t.locator('[data-act=load]').click();
  assert.match(await t.locator('.dt-msg.is-err').textContent(), /line 1/);
  assert.deepEqual(page.errors, []);
});

test('Mock API: deterministic generation, CSV, schema errors, download', async () => {
  const page = await newPage(b.context);
  await page.addInitScript(() => localStorage.clear());
  await openTool(page, srv.url, '/api-tools', 'mock-api');
  const t = page.locator('#tool-mock-api');
  assert.match(await t.locator('.mk-banner').textContent(), /MOCK DATA/);
  await t.locator('[data-act=generate]').click();
  const first = JSON.parse(await t.locator('pre').textContent());
  assert.equal(first.length, 5);
  assert.equal(first[0].id, 1);
  await t.locator('[data-act=generate]').click();
  assert.deepEqual(JSON.parse(await t.locator('pre').textContent()), first);
  // add a field
  await t.locator('.mk-add').last().click();
  await t.locator('[data-act=generate]').click();
  assert.ok('field_12' in JSON.parse(await t.locator('pre').textContent())[0]);
  // CSV
  await t.getByRole('radio', { name: 'CSV' }).click();
  const csv = await t.locator('pre').textContent();
  assert.match(csv.split('\n')[0], /^id,uuid,name,email,company,active,plan,created_at,address\.street/);
  const dl = await captureDownload(page, () => t.locator('.dt-panel').last().getByRole('button', { name: 'Download' }).click());
  assert.equal(dl.name, 'mock-data.csv');
  assert.equal(dl.text.split('\n').length, 6);
  // JSON mode with an error
  await t.getByRole('radio', { name: 'Schema JSON' }).click();
  await fillArea(t.locator('.mk-text'), JSON.stringify({ count: 3, fields: [{ name: 'n', type: 'integer', min: 9, max: 1 }] }));
  await t.locator('[data-act=generate]').click();
  assert.match(await t.locator('.dt-msg.is-err').textContent(), /min \(9\) is greater than max/);
  assert.deepEqual(page.errors, []);
});

test('HTTP status: search, class filter, ?code= deep link', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/api-tools?code=429#http-status');
  await page.waitForSelector('#tool-http-status .hs-item');
  const t = page.locator('#tool-http-status');
  assert.equal(await t.locator('.hs-item').count(), 1);
  assert.match(await t.locator('.hs-item[open]').textContent(), /Too Many Requests[\s\S]*Retry-After/);
  await t.locator('.hs-search').fill('');
  await page.waitForFunction(() => document.querySelectorAll('#tool-http-status .hs-item').length > 60);
  await t.getByRole('radio', { name: '5xx' }).click();
  const codes = await t.locator('.hs-code').allTextContents();
  assert.ok(codes.length > 10 && codes.every((c) => c.startsWith('5')));
  await t.getByRole('radio', { name: 'All' }).click();
  await t.locator('.hs-search').fill('teapot');
  await page.waitForFunction(() => document.querySelectorAll('#tool-http-status .hs-item').length === 1);
  assert.deepEqual(page.errors, []);
});

for (const [path, id] of [['/dev', 'curl-to-code'], ['/api-tools', 'curl-generator'], ['/api-tools', 'openapi-viewer'], ['/api-tools', 'mock-api'], ['/api-tools', 'http-status']]) {
  test(`${id} at 390px has no horizontal page scroll`, async () => {
    const page = await newPage(b.context, { width: 390, height: 844 });
    await openTool(page, srv.url, path, id);
    const t = page.locator('#tool-' + id);
    if (id === 'curl-to-code') { await fillArea(t.locator('textarea'), CURL); await t.locator('[data-act=convert]').click(); }
    if (id === 'openapi-viewer') { await t.getByRole('button', { name: 'Load sample' }).click(); await t.locator('.oa-op-sum').first().click(); }
    if (id === 'mock-api') await t.locator('[data-act=generate]').click();
    if (id === 'http-status') await t.locator('.hs-item summary').first().click();
    if (id === 'curl-generator') { await t.getByRole('tab', { name: 'Auth' }).click(); await t.getByRole('radio', { name: 'Basic' }).click(); }
    assert.equal(await noHorizontalScroll(page), true);
    assert.deepEqual(page.errors, []);
  });
}
