// Image Converter (/convert): real HEIC→JPG (heic2any), PNG↔JPG/PNG, and a ZIP of the batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startServer, launch, newPage, captureDownload } from './helpers.mjs';

const fx = (n) => fileURLToPath(new URL('./fixtures/' + n, import.meta.url));
const PORT = 8120;

test('convert: HEIC→JPG, PNG→JPG/PNG, download-all ZIP', async () => {
  const server = await startServer(PORT);
  const { browser, context } = await launch();
  try {
    const p = await newPage(context);
    await p.goto(server.url + '/convert');
    await p.waitForSelector('#drop');
    const libs = await p.evaluate(() => ({ h: typeof window.heic2any, z: typeof window.JSZip }));
    assert.equal(libs.h, 'function', 'heic2any loaded');
    assert.equal(libs.z, 'function', 'JSZip loaded');

    // PNG → JPG
    await p.setInputFiles('#file', fx('plain.png'));
    await p.waitForSelector('.cv-item .cv-act a.btn', { timeout: 15000 });
    let dl = await captureDownload(p, () => p.locator('.cv-item .cv-act a.btn').first().click());
    assert.ok(dl.name.endsWith('.jpg'), 'output named .jpg');
    assert.equal(dl.buffer.subarray(0, 3).toString('hex'), 'ffd8ff', 'real JPEG');

    // → PNG
    await p.selectOption('#fmt', 'png');
    await p.waitForTimeout(500);
    dl = await captureDownload(p, () => p.locator('.cv-item .cv-act a.btn').first().click());
    assert.equal(dl.buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'real PNG');

    // HEIC → JPG (the headline: browsers can't decode HEIC without the wasm lib)
    await p.selectOption('#fmt', 'jpg');
    await p.setInputFiles('#file', fx('sample.heic'));
    await p.waitForSelector('.cv-item:last-child .cv-act a.btn', { timeout: 30000 });
    dl = await captureDownload(p, () => p.locator('.cv-item').last().locator('.cv-act a.btn').click());
    assert.equal(dl.buffer.subarray(0, 3).toString('hex'), 'ffd8ff', 'HEIC decoded to a real JPEG');
    assert.ok(dl.buffer.length > 2000, 'HEIC output has real content');

    // ZIP of the two
    await p.waitForSelector('#downloadAll:not([hidden])');
    const zip = await captureDownload(p, () => p.locator('#downloadAll').click());
    assert.ok(zip.name.endsWith('.zip') && zip.buffer.subarray(0, 2).toString('hex') === '504b', 'real ZIP');

    assert.deepEqual(p.errors, [], 'no console errors');
  } finally { await browser.close(); server.stop(); }
});
