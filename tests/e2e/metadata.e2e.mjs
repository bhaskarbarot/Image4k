// Metadata/EXIF Remover (/metadata): detects GPS/camera/date, then strips all metadata (lossless JPG/PNG).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, launch, newPage, captureDownload } from './helpers.mjs';

const fx = (n) => fileURLToPath(new URL('./fixtures/' + n, import.meta.url));
const PORT = 8122;

function jpegHasMeta(buf) {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xFF) break;
    const m = buf[i + 1]; if (m === 0xDA || m === 0xD9) break;
    if ((m >= 0xE0 && m <= 0xEF) || m === 0xFE) return true; // any APPn/comment = metadata
    i += 2 + ((buf[i + 2] << 8) | buf[i + 3]);
  }
  return false;
}
function pngHasText(buf) {
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i); const type = buf.toString('ascii', i + 4, i + 8);
    if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) return true;
    i += 12 + len; if (type === 'IEND') break;
  }
  return false;
}

test('metadata: reads GPS/camera and strips all metadata (JPG + PNG, lossless)', async () => {
  // fixtures must actually carry metadata, else the test proves nothing
  assert.ok(jpegHasMeta(readFileSync(fx('exif.jpg'))), 'fixture JPG has EXIF');
  assert.ok(pngHasText(readFileSync(fx('exif.png'))), 'fixture PNG has text metadata');

  const server = await startServer(PORT);
  const { browser, context } = await launch();
  try {
    const p = await newPage(context);
    await p.goto(server.url + '/metadata');
    await p.waitForSelector('#drop');

    // JPEG with GPS
    await p.setInputFiles('#file', fx('exif.jpg'));
    await p.waitForSelector('.md-item .md-act a.btn', { timeout: 15000 });
    const found = await p.locator('.md-item .md-found').first().innerText();
    assert.match(found, /location|gps/i, 'GPS detected');
    assert.match(found, /37\.808/, 'GPS decimal shown');
    assert.match(found, /camera/i, 'camera detected');
    let dl = await captureDownload(p, () => p.locator('.md-item .md-act a.btn').first().click());
    assert.equal(dl.buffer.subarray(0, 2).toString('hex'), 'ffd8', 'still a JPEG');
    assert.ok(!jpegHasMeta(dl.buffer), 'all metadata stripped from JPEG');
    assert.ok(dl.buffer.length < readFileSync(fx('exif.jpg')).length, 'output smaller');

    // PNG with text
    await p.setInputFiles('#file', fx('exif.png'));
    await p.waitForSelector('.md-item:last-child .md-act a.btn', { timeout: 15000 });
    dl = await captureDownload(p, () => p.locator('.md-item').last().locator('.md-act a.btn').click());
    assert.equal(dl.buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'still a PNG');
    assert.ok(!pngHasText(dl.buffer), 'text metadata stripped from PNG');

    assert.deepEqual(p.errors, [], 'no console errors');
  } finally { await browser.close(); server.stop(); }
});
