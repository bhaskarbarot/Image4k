// E2E: JSON → TS, JSON Diff, YAML⇄JSON, JSON⇄CSV, XML formatter, SQL formatter, Text diff, API response formatter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, newPage, openTool, fillArea, noHorizontalScroll, captureDownload } from './helpers.mjs';

let srv, b;
before(async () => { srv = await startServer(8821); b = await launch(); });
after(async () => { await b?.browser.close(); srv?.stop(); });

const T = (id) => `#tool-${id}`;
const clip = (page) => page.evaluate(() => navigator.clipboard.readText());
const outText = (page, id) => page.locator(`${T(id)} pre`).first().textContent();
const panel = (page, id, i) => page.locator(`${T(id)} .dt-panel`).nth(i);

test('JSON → TypeScript: generate, options, copy, download, invalid', async () => {
  const page = await newPage(b.context);
  await openTool(page, srv.url, '/dev', 'json-to-ts');
  await fillArea(page.locator(`${T('json-to-ts')} textarea`), JSON.stringify({ id: 1, 'my-key': 'x', users: [{ id: 1, email: null }, { id: 2, email: 'a@b.c', nick: 'z' }] }));
  await page.click('[data-act=generate]');
  const out = await outText(page, 'json-to-ts');
  assert.match(out, /export interface Root \{\n  id: number;\n  'my-key': string;\n  users: User\[\];\n\}/);
  assert.match(out, /export interface User \{\n  id: number;\n  email: string \| null;\n  nick\?: string;\n\}/);
  // type alias + root name + readonly
  await page.click(`${T('json-to-ts')} .dt-seg button[data-v=type]`);
  await page.fill(`${T('json-to-ts')} input[aria-label="Root type name"]`, 'api_response');
  await page.check(`${T('json-to-ts')} label:has-text("readonly") input`);
  await page.click('[data-act=generate]');
  assert.match(await outText(page, 'json-to-ts'), /^export type ApiResponse = \{\n  readonly id: number;/);
  await panel(page, 'json-to-ts', 1).getByRole('button', { name: 'Copy' }).click();
  assert.match(await clip(page), /export type ApiResponse/);
  const dl = await captureDownload(page, () => panel(page, 'json-to-ts', 1).getByRole('button', { name: 'Download' }).click());
  assert.equal(dl.name, 'types.ts');
  assert.match(dl.text, /readonly users: User\[\];/);
  await fillArea(page.locator(`${T('json-to-ts')} textarea`), '{"a": [1,}');
  await page.click('[data-act=generate]');
  assert.match(await page.locator(`${T('json-to-ts')} .dt-msg`).textContent(), /Invalid JSON.*Line 1, column 10/s);
  // reset persisted options for later runs
  await page.evaluate(() => localStorage.clear());
  assert.deepEqual(page.errors, []);
});

test('JSON Diff: compare, filters, key matching, copy report/patch, download, errors', async () => {
  const page = await newPage(b.context);
  await openTool(page, srv.url, '/dev', 'json-diff');
  const [ta, tb] = [page.locator(`${T('json-diff')} textarea`).nth(0), page.locator(`${T('json-diff')} textarea`).nth(1)];
  await fillArea(ta, '{"a":1,"b":{"c":"x"},"gone":true,"list":[{"id":1,"v":"a"},{"id":2,"v":"b"}]}');
  await fillArea(tb, '{"a":2,"b":{"c":"x","d":null},"list":[{"id":2,"v":"B"},{"id":1,"v":"a"}],"new":"é"}');
  await page.click('[data-act=compare]');
  const paths = await page.locator(`${T('json-diff')} .jd-path`).allTextContents();
  assert.ok(paths.includes('$.a') && paths.includes('$.b.d') && paths.includes('$.gone') && paths.includes('$.new'));
  assert.match(await page.locator(`${T('json-diff')} .dt-stats`).textContent(), /Added 2.*Removed 1/s);
  // filters
  await page.uncheck(`${T('json-diff')} .jd-filters label:has-text("Added") input`);
  assert.equal(await page.locator(`${T('json-diff')} .jd-item.jd-added`).count(), 0);
  await page.check(`${T('json-diff')} .jd-filters label:has-text("Added") input`);
  // key matching: re-ordered list → only the real change
  await page.click(`${T('json-diff')} .dt-seg button[data-v=key]`);
  const keyed = await page.locator(`${T('json-diff')} .jd-path`).allTextContents();
  assert.ok(keyed.includes('$.list[id=2].v'));
  assert.ok(!keyed.some((p) => p.startsWith('$.list[0]')));
  await page.click('[data-act=copy-text]');
  assert.match(await clip(page), /~ \$\.a: 1 → 2/);
  await page.click('[data-act=copy-patch]');
  const patch = JSON.parse(await clip(page));
  assert.ok(patch.some((p) => p.op === 'replace' && p.path === '/a' && p.value === 2));
  const dl = await captureDownload(page, () => page.click('[data-act=download]'));
  assert.equal(dl.name, 'json-diff.txt');
  assert.match(dl.text, /\+ \$\.new: "é"/);
  // identical
  await fillArea(tb, '{"list":[{"v":"a","id":1},{"id":2,"v":"b"}],"gone":true,"b":{"c":"x"},"a":1}');
  await page.click('[data-act=compare]');
  assert.match(await page.locator(`${T('json-diff')} .dt-msg`).textContent(), /equal/);
  // invalid right side
  await fillArea(tb, '{"a":1,\n"b":}');
  await page.click('[data-act=compare]');
  assert.match(await page.locator(`${T('json-diff')} .dt-msg`).textContent(), /Changed \(B\): invalid JSON.*Line 2, column 5/s);
  await page.evaluate(() => localStorage.clear());
  assert.deepEqual(page.errors, []);
});

test('YAML ⇄ JSON: convert both ways, swap, multi-doc, errors, download', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/dev'); await page.evaluate(() => localStorage.clear());
  await openTool(page, srv.url, '/dev', 'yaml-json');
  const ta = page.locator(`${T('yaml-json')} textarea`);
  await fillArea(ta, 'name: Zoë\nports: [80, 443]\nnested:\n  ok: true\n  none: ~\n');
  await page.click('[data-act=convert]');
  assert.equal(await outText(page, 'yaml-json'), '{\n  "name": "Zoë",\n  "ports": [\n    80,\n    443\n  ],\n  "nested": {\n    "ok": true,\n    "none": null\n  }\n}');
  const dl = await captureDownload(page, () => panel(page, 'yaml-json', 1).getByRole('button', { name: 'Download' }).click());
  assert.equal(dl.name, 'converted.json');
  await page.click('[data-act=swap]');
  assert.equal(await outText(page, 'yaml-json'), 'name: Zoë\nports:\n  - 80\n  - 443\nnested:\n  ok: true\n  none: null\n');
  const dl2 = await captureDownload(page, () => panel(page, 'yaml-json', 1).getByRole('button', { name: 'Download' }).click());
  assert.equal(dl2.name, 'converted.yaml');
  // back to YAML → JSON with multiple documents
  await page.click(`${T('yaml-json')} .dt-seg button[data-v=y2j]`);
  await fillArea(ta, 'a: 1\n---\nb: 2\n');
  await page.click('[data-act=convert]');
  assert.match(await page.locator(`${T('yaml-json')} .dt-msg`).textContent(), /2 YAML documents/);
  await fillArea(ta, 'a: 1\n b: 2');
  await page.click('[data-act=convert]');
  assert.match(await page.locator(`${T('yaml-json')} .dt-msg`).textContent(), /Invalid YAML.*Line 2, column 3/s);
  await page.evaluate(() => localStorage.clear());
  assert.deepEqual(page.errors, []);
});

test('JSON ⇄ CSV: both directions, preview table, delimiter, download', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/dev'); await page.evaluate(() => localStorage.clear());
  await openTool(page, srv.url, '/dev', 'json-csv');
  const ta = page.locator(`${T('json-csv')} textarea`);
  await fillArea(ta, JSON.stringify([{ id: 1, name: 'A, "q"', addr: { city: 'X' } }, { id: 2, note: 'l1\nl2' }]));
  await page.click('[data-act=convert]');
  assert.equal(await outText(page, 'json-csv'), 'id,name,addr.city,note\n1,"A, ""q""",X,\n2,,,"l1\nl2"');
  assert.equal(await page.locator(`${T('json-csv')} .jc-preview tbody tr`).count(), 2);
  const dl = await captureDownload(page, () => panel(page, 'json-csv', 1).getByRole('button', { name: 'Download' }).click());
  assert.equal(dl.name, 'converted.csv');
  // CSV → JSON with ; delimiter and types
  await page.click(`${T('json-csv')} .dt-seg button[data-v=c2j]`);
  await fillArea(ta, 'id;name;city\n1;"Zoë; Jr";"Multi\nline"\n2;Bo;');
  await page.selectOption(`${T('json-csv')} select`, ';');
  await page.click('[data-act=convert]');
  assert.deepEqual(JSON.parse(await outText(page, 'json-csv')), [{ id: 1, name: 'Zoë; Jr', city: 'Multi\nline' }, { id: 2, name: 'Bo', city: null }]);
  assert.equal(await page.locator(`${T('json-csv')} .jc-preview tbody tr`).count(), 2);
  const dl2 = await captureDownload(page, () => panel(page, 'json-csv', 1).getByRole('button', { name: 'Download' }).click());
  assert.equal(dl2.name, 'converted.json');
  await page.selectOption(`${T('json-csv')} select`, 'auto');
  await fillArea(ta, 'a,b\n1,"unterminated');
  await page.click('[data-act=convert]');
  assert.match(await page.locator(`${T('json-csv')} .dt-msg`).textContent(), /Unterminated quoted field.*line 2/s);
  await page.evaluate(() => localStorage.clear());
  assert.deepEqual(page.errors, []);
});

test('XML formatter: format, minify, validate, XXE kept inert, error location, download', async () => {
  const page = await newPage(b.context);
  await openTool(page, srv.url, '/dev', 'xml-formatter');
  const ta = page.locator(`${T('xml-formatter')} textarea`);
  await fillArea(ta, '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r><a id="1">&x;</a><b/></r>');
  await page.click('[data-act=format]');
  assert.equal(await outText(page, 'xml-formatter'), '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<r>\n  <a id="1">&x;</a>\n  <b/>\n</r>');
  await page.click('[data-act=minify]');
  assert.match(await outText(page, 'xml-formatter'), /<r><a id="1">&x;<\/a><b\/><\/r>$/);
  await page.click('[data-act=validate]');
  assert.match(await page.locator(`${T('xml-formatter')} .dt-msg`).textContent(), /Well-formed/);
  await page.click('[data-act=format]');
  const dl = await captureDownload(page, () => panel(page, 'xml-formatter', 1).getByRole('button', { name: 'Download' }).click());
  assert.equal(dl.name, 'formatted.xml');
  await fillArea(ta, '<a>\n  <b>\n</a>');
  await page.click('[data-act=format]');
  assert.match(await page.locator(`${T('xml-formatter')} .dt-msg`).textContent(), /Mismatched closing tag.*Line 3, column 1/s);
  assert.deepEqual(page.errors, []);
});

test('SQL formatter: dialect format, minify, parse error, never executed note', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/dev'); await page.evaluate(() => localStorage.clear());
  await openTool(page, srv.url, '/dev', 'sql-formatter');
  const ta = page.locator(`${T('sql-formatter')} textarea`);
  await fillArea(ta, "select id, name from users where email like '%a  b%' -- note\nand age > 3;");
  await page.click('[data-act=format]');
  await page.waitForFunction(() => /^SELECT/.test(document.querySelector('#tool-sql-formatter pre').textContent));
  assert.equal(await outText(page, 'sql-formatter'), "SELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  email LIKE '%a  b%' -- note\n  AND age > 3;");
  await page.click('[data-act=minify]');
  assert.equal(await outText(page, 'sql-formatter'), "select id,name from users where email like '%a  b%' and age > 3;");
  assert.match(await page.locator(T('sql-formatter')).textContent(), /never executed/);
  await fillArea(ta, 'SELECT (a FROM');
  await page.click('[data-act=format]');
  await page.waitForSelector(`${T('sql-formatter')} .dt-msg.is-err`);
  assert.match(await page.locator(`${T('sql-formatter')} .dt-msg.is-err`).textContent(), /could not be parsed.*line 1 column/s);
  const dlBtn = panel(page, 'sql-formatter', 1).getByRole('button', { name: 'Download' });
  await fillArea(ta, 'select 1');
  await page.click('[data-act=format]');
  await page.waitForFunction(() => /SELECT/.test(document.querySelector('#tool-sql-formatter pre').textContent));
  const dl = await captureDownload(page, () => dlBtn.click());
  assert.equal(dl.name, 'formatted.sql');
  assert.deepEqual(page.errors, []);
});

test('Text diff: side-by-side, unified, word highlights, patch copy/download, worker for big input', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/dev'); await page.evaluate(() => localStorage.clear());
  await openTool(page, srv.url, '/dev', 'text-diff');
  const [ta, tb] = [page.locator(`${T('text-diff')} textarea`).nth(0), page.locator(`${T('text-diff')} textarea`).nth(1)];
  await fillArea(ta, 'alpha\nbeta gamma\ndelta\n');
  await fillArea(tb, 'alpha\nbeta GAMMA\ndelta\nepsilon\n');
  await page.click('[data-act=compare]');
  const stats = await page.locator(`${T('text-diff')} .dt-stats`).textContent();
  assert.match(stats, /Added 1.*Removed 0.*Modified 1/s);
  assert.equal(await page.locator(`${T('text-diff')} .td-text ins.dt-add`).first().textContent(), 'GAMMA');
  assert.equal(await page.locator(`${T('text-diff')} .td-text del.dt-del`).first().textContent(), 'gamma');
  await page.click(`${T('text-diff')} .dt-seg button[data-v=unified]`);
  const signs = await page.locator(`${T('text-diff')} .td-sign`).allTextContents();
  assert.deepEqual(signs, [' ', '-', '+', ' ', '+']);
  await page.click('[data-act=copy-patch]');
  assert.match(await clip(page), /^-beta gamma$/m);
  const dl = await captureDownload(page, () => page.click('[data-act=download]'));
  assert.equal(dl.name, 'changes.patch');
  assert.match(dl.text, /^\+epsilon$/m);
  // ignore case → identical
  await page.check(`${T('text-diff')} label:has-text("Ignore case") input`);
  await page.click('[data-act=compare]');
  assert.match(await page.locator(`${T('text-diff')} .dt-stats`).textContent(), /Added 1.*Modified 0/s);
  await page.uncheck(`${T('text-diff')} label:has-text("Ignore case") input`);
  // big input goes through the worker
  const big = Array.from({ length: 30000 }, (_, i) => 'row ' + i).join('\n');
  await fillArea(ta, big);
  await fillArea(tb, big.replace('row 777\n', 'row 777 edited\n'));
  await page.click('[data-act=compare]');
  await page.waitForFunction(() => /Modified 1/.test(document.querySelector('#tool-text-diff .dt-stats').textContent), null, { timeout: 20000 });
  assert.ok(await page.locator(`${T('text-diff')} .td-fold`).count() >= 1);
  await page.evaluate(() => localStorage.clear());
  assert.deepEqual(page.errors, []);
});

test('API response formatter: JSON, XML, form, forced type error, download extension', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/api-tools'); await page.evaluate(() => localStorage.clear());
  await openTool(page, srv.url, '/api-tools', 'response-formatter');
  const ta = page.locator(`${T('response-formatter')} textarea`);
  await fillArea(ta, '{"ok":true,"id":12345678901234567890}');
  await page.click('[data-act=format]');
  assert.equal(await outText(page, 'response-formatter'), '{\n  "ok": true,\n  "id": 12345678901234567890\n}');
  assert.match(await page.locator(`${T('response-formatter')} .dt-stats`).textContent(), /Detected: JSON/);
  const dl = await captureDownload(page, () => panel(page, 'response-formatter', 1).getByRole('button', { name: 'Download' }).click());
  assert.equal(dl.name, 'response.json');
  await fillArea(ta, '<?xml version="1.0"?><r><a>1</a></r>');
  await page.click('[data-act=format]');
  assert.equal(await outText(page, 'response-formatter'), '<?xml version="1.0"?>\n<r>\n  <a>1</a>\n</r>');
  const dl2 = await captureDownload(page, () => panel(page, 'response-formatter', 1).getByRole('button', { name: 'Download' }).click());
  assert.equal(dl2.name, 'response.xml');
  await fillArea(ta, 'a=1&b=hello+w%C3%B6rld&b=2');
  await page.click('[data-act=format]');
  assert.deepEqual(JSON.parse(await outText(page, 'response-formatter')), { a: '1', b: ['hello wörld', '2'] });
  assert.equal(await page.locator(`${T('response-formatter')} .dt-table tbody tr`).count(), 3);
  await page.click('[data-act=minify]');
  assert.equal(await outText(page, 'response-formatter'), '{"a":"1","b":["hello wörld","2"]}');
  await page.selectOption(`${T('response-formatter')} select`, 'json');
  await fillArea(ta, '<html>nope</html>');
  await page.click('[data-act=format]');
  assert.match(await page.locator(`${T('response-formatter')} .dt-msg`).textContent(), /Invalid JSON/);
  await page.evaluate(() => localStorage.clear());
  assert.deepEqual(page.errors, []);
});

test('all eight tools work at 390px without horizontal page scroll', async () => {
  const page = await newPage(b.context, { width: 390, height: 844 });
  const tools = [['/dev', 'json-to-ts'], ['/dev', 'json-diff'], ['/dev', 'yaml-json'], ['/dev', 'json-csv'], ['/dev', 'xml-formatter'], ['/dev', 'sql-formatter'], ['/dev', 'text-diff'], ['/api-tools', 'response-formatter']];
  for (const [path, id] of tools) {
    await openTool(page, srv.url, path, id);
    // load the sample in every editor and run the primary action
    for (const s of await page.locator(`${T(id)} button:has-text("Sample")`).all()) await s.click();
    const primaryBtn = page.locator(`${T(id)} .btn-primary`).first();
    await primaryBtn.click();
    await page.waitForTimeout(400);
    assert.equal(await noHorizontalScroll(page), true, `${id} scrolls horizontally at 390px`);
    assert.equal(await page.locator(`${T(id)} .dt-msg.is-err`).count(), 0, `${id} sample produced an error`);
  }
  assert.deepEqual(page.errors, []);
});
