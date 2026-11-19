// Real peer-to-peer file transfer: two browser pages, a live WebRTC data channel, received bytes == sent.
// Needs the signaling worker running locally:  cd signaling-worker && npx wrangler dev --local --port 8787
// (override with SIGNAL_WS). The file streams page-to-page; this asserts the bytes arrive intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, launch, newPage, captureDownload } from './helpers.mjs';

const SIGNAL = process.env.SIGNAL_WS || 'ws://localhost:8787/ws';
const PORT = 8097;

test('P2P transfer: sender generates a code, receiver gets the exact file', async (t) => {
  // skip gracefully if the signaling worker isn't up
  try { const ws = await import('ws').catch(() => null); if (ws) { await new Promise((res, rej) => { const s = new ws.WebSocket(SIGNAL + '?code=PING&role=sender'); s.onopen = () => { s.close(); res(); }; s.onerror = () => rej(new Error('no signaling server')); setTimeout(() => rej(new Error('timeout')), 2000); }); } }
  catch (e) { t.skip('signaling worker not reachable at ' + SIGNAL + ' (start it with wrangler dev --port 8787)'); return; }

  const server = await startServer(PORT);
  const { browser, context } = await launch();
  try {
    const inject = `window.__SIGNAL_URL__ = ${JSON.stringify(SIGNAL)};`;

    const sender = await newPage(context);
    await sender.addInitScript(inject);
    await sender.goto(server.url + '/send');

    const receiver = await newPage(context);
    await receiver.addInitScript(inject);
    await receiver.goto(server.url + '/send#receive');

    // a multi-chunk file with known content
    const payload = crypto.randomBytes(300 * 1024);
    const digest = crypto.createHash('sha256').update(payload).digest('hex');

    await sender.setInputFiles('#sendFile', { name: 'proof.bin', mimeType: 'application/octet-stream', buffer: payload });

    // the one-time code appears on the sender
    await sender.waitForSelector('#sendActive:not([hidden]) #sendCode');
    const code = (await sender.locator('#sendCode').textContent()).trim();
    assert.match(code, /^[A-Z0-9]{6}$/, 'code is 6 unambiguous chars');

    // receiver enters it and the download fires when the transfer completes
    await receiver.locator('#tab-receive').click();
    await receiver.locator('#recvCode').fill(code);
    const dl = await captureDownload(receiver, () => receiver.locator('#recvForm button[type=submit]').click());

    assert.equal(dl.name, 'proof.bin', 'received filename matches');
    assert.equal(dl.buffer.length, payload.length, 'received byte count matches');
    assert.equal(crypto.createHash('sha256').update(dl.buffer).digest('hex'), digest, 'received bytes are identical (sha256)');

    // both sides reach the done state
    await sender.waitForSelector('#sendStatus.is-done', { timeout: 10000 });
    await receiver.waitForSelector('#recvDoneRow:not([hidden])', { timeout: 10000 });

    assert.deepEqual(sender.errors, [], 'no sender console errors');
    assert.deepEqual(receiver.errors, [], 'no receiver console errors');
  } finally {
    await browser.close();
    server.stop();
  }
});

test('receiver rejects an invalid code', async (t) => {
  const server = await startServer(PORT + 1);
  const { browser, context } = await launch();
  try {
    const page = await newPage(context);
    await page.addInitScript(`window.__SIGNAL_URL__ = ${JSON.stringify(SIGNAL)};`);
    await page.goto(server.url + '/send#receive');
    await page.locator('#tab-receive').click();
    await page.locator('#recvCode').fill('AB');          // too short
    await page.locator('#recvForm button[type=submit]').click();
    await page.waitForSelector('#recvErr:not([hidden])');
    assert.match(await page.locator('#recvErr').textContent(), /code/i);
  } finally {
    await browser.close();
    server.stop();
  }
});
