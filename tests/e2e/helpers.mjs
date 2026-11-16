// Shared E2E helpers: start the local preview server (same headers as production) and drive real Chrome.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);

/** Start `python3 serve.py <port>` (static site + _headers). Set BASE_URL to test another server instead. */
export async function startServer(port) {
  if (process.env.BASE_URL) return { url: process.env.BASE_URL.replace(/\/$/, ''), stop() {} };
  const proc = spawn('python3', ['serve.py', String(port)], { cwd: ROOT, stdio: 'ignore' });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(url + '/'); if (r.ok) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, stop: () => proc.kill() };
}

export async function launch() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  return { browser, context };
}

/** New page that records console errors and failed requests (asserted at the end of each test). */
export async function newPage(context, { width = 1280, height = 900 } = {}) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  page.errors = [];
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  return page;
}

/** Open a tool from the shell: /dev#json-formatter etc. Waits until the tool has mounted. */
export async function openTool(page, base, path, id) {
  await page.goto(`${base}${path}#${id}`);
  await page.waitForSelector(`#tool-${id} > :not(.dt-loading)`, { timeout: 15000, state: 'attached' });
}

/** Fill a textarea (fast for big inputs) and fire input events. */
export async function fillArea(locator, text) {
  await locator.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
}

export async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

/** Read the text of the last toast notification. */
export async function lastToast(page) {
  return page.locator('.dt-toast').last().textContent();
}

/** Trigger a download via `action()` and return { name, text }. */
export async function captureDownload(page, action) {
  const [dl] = await Promise.all([page.waitForEvent('download'), action()]);
  const path = await dl.path();
  const { readFileSync } = await import('node:fs');
  return { name: dl.suggestedFilename(), buffer: readFileSync(path), text: readFileSync(path, 'utf8') };
}
