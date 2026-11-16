// QR generator E2E: real rendering in Chrome, verification shown in the UI, and every exported file decoded
// again by an INDEPENDENT decoder — zxing-cpp (tests/tools/qrdecode.py) — not the jsQR the page itself uses.
// Setup once: python3 -m venv tests/.venv && tests/.venv/bin/pip install -r tests/requirements.txt
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, newPage, noHorizontalScroll, captureDownload } from './helpers.mjs';

const PY = fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
const DECODER = fileURLToPath(new URL('../tools/qrdecode.py', import.meta.url));
const HAS_ZXING = existsSync(PY);
const TMP = mkdtempSync(join(tmpdir(), 'qr-e2e-'));
let n = 0;

/** Decode PNG bytes with zxing-cpp. */
function zxing(buffer) {
  const f = join(TMP, `img${n++}.png`);
  writeFileSync(f, buffer);
  return JSON.parse(execFileSync(PY, [DECODER, f], { encoding: 'utf8' }).trim());
}

let srv, b;
before(async () => { srv = await startServer(8862); b = await launch(); });
after(async () => { await b?.browser.close(); srv?.stop(); });

const DONE = /verified|Not scannable|some checks|when small|Could not|Too much/;
async function waitVerified(page) {
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('#qrVerify').textContent), DONE.source, { timeout: 20000 });
  return page.textContent('#qrVerify');
}
async function settle(page) {
  await page.waitForTimeout(400); // debounce
  return waitVerified(page);
}
async function openQr(page) { await page.goto(srv.url + '/qr'); return waitVerified(page); }
async function setType(page, type, fields) {
  await page.click(`.qr-type[data-type=${type}]`);
  for (const [k, v] of Object.entries(fields)) {
    const el = page.locator(`#qrFields [data-key=${k}]`);
    if ((await el.evaluate((x) => x.tagName)) === 'SELECT') await el.selectOption(v); else await el.fill(v);
  }
  return settle(page);
}
async function exportAs(page, format, size) {
  await page.selectOption('#format', format);
  if (size) await page.selectOption('#size', String(size));
  return captureDownload(page, () => page.click('#qrDownload'));
}
/** Rasterise an SVG download in the browser so zxing-cpp can read it. */
async function svgToPng(page, svgText) {
  const b64 = await page.evaluate(async (svg) => {
    const img = new Image(); img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); await img.decode();
    const c = document.createElement('canvas'); c.width = 900; c.height = 900;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 900, 900); x.drawImage(img, 0, 0, 900, 900);
    return c.toDataURL('image/png').split(',')[1];
  }, svgText);
  return Buffer.from(b64, 'base64');
}

test('independent decoder (zxing-cpp) is installed for these tests', () => {
  assert.ok(HAS_ZXING, 'Run: python3 -m venv tests/.venv && tests/.venv/bin/pip install -r tests/requirements.txt');
});

test('default URL code renders, is verified in the UI and the PNG decodes with zxing-cpp', async () => {
  const page = await newPage(b.context);
  assert.match(await openQr(page), /Scan verified/);
  const dl = await exportAs(page, 'png', 1024);
  assert.equal(dl.name, 'qr-image4k.pages.dev-1024.png');
  assert.equal(dl.buffer.readUInt32BE(16), 1024); // PNG IHDR width
  assert.equal(dl.buffer.readUInt32BE(20), 1024);
  assert.equal(zxing(dl.buffer), 'https://image4k.pages.dev');
  assert.deepEqual(page.errors, []);
});

test('Wi-Fi, vCard, WhatsApp, email, SMS, phone and Unicode text all scan to the exact payload', async () => {
  const page = await newPage(b.context);
  await openQr(page);
  const cases = [
    ['wifi', { ssid: 'Home;Net', password: 'p@ss:word123' }, 'WIFI:T:WPA;S:Home\\;Net;P:p@ss\\:word123;;'],
    ['vcard', { first: 'Zoë', last: 'Shah', mobile: '+91 98765 43210', email: 'zoe@example.com', org: 'Bhaskar Solution' },
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Shah;Zoë;;;\r\nFN:Zoë Shah\r\nORG:Bhaskar Solution\r\nTEL;TYPE=CELL:+919876543210\r\nEMAIL;TYPE=INTERNET:zoe@example.com\r\nEND:VCARD'],
    ['whatsapp', { phone: '+91 98765 43210', message: 'Hello 👋' }, 'https://wa.me/919876543210?text=Hello%20%F0%9F%91%8B'],
    ['email', { to: 'hi@example.com', subject: 'Quote #12', body: 'Hello there' }, 'mailto:hi@example.com?subject=Quote%20%2312&body=Hello%20there'],
    ['sms', { phone: '+1 555 010 0000', message: 'On my way' }, 'SMSTO:+15550100000:On my way'],
    ['phone', { phone: '+91 98765 43210' }, 'tel:+919876543210'],
    ['text', { text: 'नमस्ते દુનિયા 🚀 — “quotes” & <tags>' }, 'नमस्ते દુનિયા 🚀 — “quotes” & <tags>'],
  ];
  for (const [type, fields, expected] of cases) {
    assert.match(await setType(page, type, fields), /Scan verified/, type);
    assert.equal(await page.evaluate(() => window.__qr.data), expected, type + ' payload');
    const dl = await exportAs(page, 'png', 1024);
    assert.equal(zxing(dl.buffer), expected, type + ' zxing-cpp');
  }
  assert.deepEqual(page.errors, []);
});

test('every suggested style preset is verified in the UI and decodes with zxing-cpp at 1024 and 256 px', async () => {
  const page = await newPage(b.context);
  await openQr(page);
  const ids = await page.locator('.qr-preset').evaluateAll((els) => els.map((e) => e.dataset.preset));
  assert.ok(ids.length >= 8);
  for (const id of ids) {
    await page.click(`.qr-preset[data-preset=${id}]`);
    assert.match(await settle(page), /Scan verified/, id);
    for (const size of [1024, 256]) {
      const dl = await exportAs(page, 'png', size);
      assert.equal(zxing(dl.buffer), 'https://image4k.pages.dev', `${id} @${size}`);
    }
  }
});

test('transparent PNG has transparent pixels; SVG, JPG and WebP exports decode', async () => {
  const page = await newPage(b.context);
  await openQr(page);
  const t = await exportAs(page, 'png-t', 512);
  const alpha = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    return x.getImageData(2, 2, 1, 1).data[3];
  }, t.buffer.toString('base64'));
  assert.equal(alpha, 0, 'corner pixel must be fully transparent');
  assert.equal(zxing(t.buffer), 'https://image4k.pages.dev');
  const s = await exportAs(page, 'svg');
  assert.match(s.name, /\.svg$/);
  assert.match(s.text, /^<\?xml[\s\S]*<svg[\s\S]*<\/svg>\s*$/);
  assert.equal(zxing(await svgToPng(page, s.text)), 'https://image4k.pages.dev');
  for (const fmt of ['jpeg', 'webp']) {
    const d = await exportAs(page, fmt, 512);
    assert.match(d.name, new RegExp(`\\.${fmt}$`));
    const png = Buffer.from(await page.evaluate(async ({ b64, fmt }) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/' + fmt }));
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    }, { b64: d.buffer.toString('base64'), fmt }), 'base64');
    assert.equal(zxing(png), 'https://image4k.pages.dev', fmt);
  }
});

test('logo upload raises error correction to H, stays verified and decodable; fake image rejected', async () => {
  const page = await newPage(b.context);
  await openQr(page);
  const png = await page.evaluate(async () => {
    const c = new OffscreenCanvas(200, 200); const x = c.getContext('2d');
    x.fillStyle = '#f43ff5'; x.beginPath(); x.arc(100, 100, 95, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#fff'; x.font = 'bold 120px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('B', 100, 108);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  });
  await page.setInputFiles('#logoFile', { name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForSelector('#logoOpts:not([hidden])');
  assert.match(await settle(page), /Scan verified/);
  assert.match(await page.textContent('#qrVersion'), /error correction H/);
  const dl = await exportAs(page, 'png', 1024);
  assert.equal(zxing(dl.buffer), 'https://image4k.pages.dev');
  // biggest logo size still verified by the UI → must really decode
  await page.locator('#logoSize').evaluate((el) => { el.value = '0.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const v = await settle(page);
  if (/Scan verified/.test(v)) assert.equal(zxing((await exportAs(page, 'png', 1024)).buffer), 'https://image4k.pages.dev', 'UI said verified at 50% logo');
  // forcing low error correction with a logo is warned about
  await page.selectOption('#ec', 'L');
  await page.waitForFunction(() => document.querySelector('#qrWarnings').textContent.includes('error correction L'));
  // a non-image file disguised as .png is rejected (content is checked, not the extension)
  await page.setInputFiles('#logoFile', { name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('<script>alert(1)</script>') });
  await page.waitForSelector('.dt-toast.is-err');
  assert.deepEqual(page.errors, []);
});

test('warnings: low contrast and inverted colours; errors: empty and oversized content', async () => {
  const page = await newPage(b.context);
  await openQr(page);
  await page.locator('#fg').evaluate((el) => { el.value = '#dddddd'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => /Low contrast/.test(document.querySelector('#qrWarnings').textContent));
  await page.locator('#bg').evaluate((el) => { el.value = '#000000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => /inverted/.test(document.querySelector('#qrWarnings').textContent));
  await page.click('#qrReset');
  await page.click('.qr-type[data-type=text]');
  assert.match(await page.textContent('#qrDataErr'), /Enter some text/);
  await page.fill('#qrFields [data-key=text]', 'x'.repeat(5000));
  await page.waitForFunction(() => /Too much content/.test(document.querySelector('#qrVerify').textContent));
  assert.deepEqual(page.errors, []);
});

test('content is never persisted; style is', async () => {
  const page = await newPage(b.context);
  await openQr(page);
  await setType(page, 'wifi', { ssid: 'Secret', password: 'supersecret123' });
  await page.click('.qr-preset[data-preset=forest]');
  await page.waitForTimeout(600);
  const stored = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
  assert.doesNotMatch(stored, /supersecret123|Secret/);
  assert.match(stored, /forest/);
  await page.click('#qrReset');
});

test('QR page works at 390px without horizontal scroll and the image page links to it', async () => {
  const page = await newPage(b.context, { width: 390, height: 844 });
  await openQr(page);
  assert.equal(await noHorizontalScroll(page), true);
  await page.goto(srv.url + '/image');
  assert.equal(await page.locator('.tools a[href="/qr"]').count(), 1);
});
