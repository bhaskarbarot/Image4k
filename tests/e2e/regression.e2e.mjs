// Regression checks for the EXISTING site after adding the developer / API / QR tools:
// every page loads without console errors, navigation links resolve, the image tool still processes
// and downloads an image, the hub tabs + search work, and headers (CSP) are what we expect.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, newPage, noHorizontalScroll, captureDownload } from './helpers.mjs';

let srv, b;
before(async () => { srv = await startServer(8881); b = await launch(); });
after(async () => { await b?.browser.close(); srv?.stop(); });

const PAGES = ['/', '/image', '/qr', '/send', '/mail', '/pdf', '/ocr', '/watermark', '/dev', '/api-tools', '/workbench', '/privacy', '/terms'];

test('every page loads (200) without console errors and fits 390px', async () => {
  for (const p of PAGES) {
    for (const width of [1280, 390]) {
      const page = await newPage(b.context, { width, height: 900 });
      const res = await page.goto(srv.url + p);
      assert.equal(res.status(), 200, p);
      await page.waitForLoadState('networkidle');
      // serve.py (static test server) can't run Pages Functions, so pages that probe a backend on load
      // (temp-mail asks /api/mail/config) log one expected 404 here; production serves that function (200).
      const backendProbe = /Failed to load resource.*404/;
      const real = page.errors.filter((e) => !(p === '/mail' && backendProbe.test(e)));
      assert.deepEqual(real, [], `${p} @${width}`);
      if (width === 390) assert.equal(await noHorizontalScroll(page), true, `${p} horizontal scroll at 390px`);
      await page.close();
    }
  }
});

test('all internal links on the hub and tool pages resolve', async () => {
  const page = await newPage(b.context);
  const seen = new Set();
  for (const p of ['/', '/dev', '/api-tools', '/qr', '/image']) {
    await page.goto(srv.url + p);
    const hrefs = await page.$$eval('a[href^="/"]', (as) => as.map((a) => a.getAttribute('href')));
    for (const h of hrefs) seen.add(h.split('#')[0].split('?')[0] || '/');
  }
  for (const h of seen) {
    const r = await fetch(srv.url + h);
    assert.equal(r.status, 200, h);
  }
  assert.ok(seen.size >= 10);
});

test('hub: category tabs filter, search spans categories, deep link #api', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/');
  assert.equal(await page.locator('.hub-item').count(), 47);
  await page.click('[data-tab=dev]');
  assert.deepEqual(await page.locator('.hub-cat:not([hidden])').evaluateAll((e) => e.map((x) => x.dataset.cat)), ['dev']);
  assert.equal(await page.locator('.hub-cat[data-cat=dev] .hub-item:not([hidden])').count(), 17);
  await page.fill('#hubSearch', 'webhook');
  assert.deepEqual(await page.locator('.hub-item:not([hidden]) strong').allTextContents(), ['Webhook Tester']);
  await page.fill('#hubSearch', 'zzzz-nothing');
  assert.equal(await page.isVisible('#hubEmpty'), true);
  await page.goto(srv.url + '/#api');
  assert.deepEqual(await page.locator('.hub-cat:not([hidden])').evaluateAll((e) => e.map((x) => x.dataset.cat)), ['api']);
  // every tool in the registry is reachable from the hub
  const hubLinks = new Set(await page.$$eval('.hub-item', (as) => as.map((a) => a.getAttribute('href'))));
  const { TOOLS, toolUrl } = await import('../../assets/dev/registry.js');
  for (const t of TOOLS) { const want = t.cat === 'data' ? '/workbench' : toolUrl(t); assert.ok(hubLinks.has(want), 'hub missing ' + want); }
  assert.deepEqual(page.errors, []);
});

test('image tool still works: upload → Compress → download a real image', async () => {
  const page = await newPage(b.context);
  await page.goto(srv.url + '/image#compress');
  const png = await page.evaluate(async () => {
    const c = new OffscreenCanvas(640, 480); const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 640, 480); g.addColorStop(0, '#f43ff5'); g.addColorStop(1, '#2244ff');
    x.fillStyle = g; x.fillRect(0, 0, 640, 480);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(s);
  });
  await page.setInputFiles('#fileInput', { name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForSelector('#workspace:not([hidden])');
  await page.click('#runBtn');
  await page.waitForSelector('#fileList a[download]', { timeout: 60000 });
  const dl = await captureDownload(page, () => page.locator('#fileList a[download]').first().click());
  assert.equal(dl.name, 'test-compressed.png');
  assert.equal(dl.buffer.subarray(1, 4).toString(), 'PNG', 'downloaded file is a real PNG');
  assert.deepEqual(page.errors, []);
});

test('headers: site CSP is unchanged on normal pages; API page gets its own single CSP', async () => {
  const home = await fetch(srv.url + '/');
  assert.match(home.headers.get('content-security-policy'), /connect-src 'self' blob: data: https:\/\/cdn\.jsdelivr\.net/);
  const api = await fetch(srv.url + '/api-tools');
  const csp = api.headers.get('content-security-policy');
  assert.match(csp, /connect-src 'self' blob: data: https: wss: http:\/\/localhost:\*/);
  assert.doesNotMatch(csp, /cdn\.jsdelivr\.net https:\/\/huggingface/);
  const js = await fetch(srv.url + '/assets/dev/shell.js');
  assert.match(js.headers.get('cache-control'), /must-revalidate/);
});
