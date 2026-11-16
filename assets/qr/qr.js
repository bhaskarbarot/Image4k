/* QR Code Generator — real, scannable codes built in the browser with qr-code-styling (MIT),
 * verified after every change by decoding the rendered image with jsQR (Apache-2.0). */
import { h, clear, toast, download, copyText, seg, store, debounce, formatBytes } from '/assets/dev/ui.js';
import { build } from './payload.js';
import { PRESETS, contrastRatio, relLum, parseColor } from './style.js';

const QRCodeStyling = window.QRCodeStyling;
const jsQR = window.jsQR;
const $ = (s) => document.querySelector(s);

/* ---------- state ---------- */
const DEFAULT = {
  type: 'url',
  fields: { url: 'https://image4k.pages.dev' },
  preset: 'brand',
  fg: '#111111', fg2: '#8b3dff', gradient: false, gradType: 'linear', gradRot: 45,
  bg: '#ffffff', transparent: false,
  dots: 'rounded', corners: 'extra-rounded', cornerDots: 'dot', cornerColor: '',
  margin: 4, ec: 'auto',
  logo: null, logoSize: 0.3, logoMargin: 4, hideDots: true,
  size: 1024, format: 'png',
};
// Only STYLE choices are remembered — never the content (it can contain Wi-Fi passwords or contact
// details) and never the logo.
const STYLE_KEYS = ['preset', 'fg', 'fg2', 'gradient', 'gradType', 'gradRot', 'bg', 'transparent', 'dots', 'corners', 'cornerDots', 'cornerColor', 'margin', 'ec', 'logoSize', 'logoMargin', 'hideDots', 'size', 'format'];
const saved = store.get('qr:style', {});
const S = Object.assign({}, DEFAULT, Object.fromEntries(STYLE_KEYS.filter((k) => k in saved).map((k) => [k, saved[k]])));
S.fields = { ...DEFAULT.fields };
const saveState = debounce(() => store.set('qr:style', Object.fromEntries(STYLE_KEYS.map((k) => [k, S[k]]))), 400);

/* ---------- content forms ---------- */
const TYPES = [
  ['url', 'Website', [['url', 'Website address', 'url', 'https://example.com']]],
  ['text', 'Text', [['text', 'Text', 'textarea', 'Any text — shown on the phone when scanned']]],
  ['email', 'Email', [['to', 'Email address', 'email', 'name@example.com'], ['subject', 'Subject (optional)', 'text', ''], ['body', 'Message (optional)', 'textarea', '']]],
  ['phone', 'Phone', [['phone', 'Phone number', 'tel', '+91 98765 43210']]],
  ['sms', 'SMS', [['phone', 'Phone number', 'tel', '+91 98765 43210'], ['message', 'Message (optional)', 'textarea', '']]],
  ['whatsapp', 'WhatsApp', [['phone', 'WhatsApp number (with country code)', 'tel', '+91 98765 43210'], ['message', 'Pre-filled message (optional)', 'textarea', '']]],
  ['wifi', 'Wi-Fi', [['ssid', 'Network name (SSID)', 'text', 'MyHomeWiFi'], ['auth', 'Security', 'select', [['WPA', 'WPA / WPA2 / WPA3'], ['WEP', 'WEP (old)'], ['nopass', 'No password']]], ['password', 'Password', 'password', ''], ['hidden', 'Hidden network', 'checkbox']]],
  ['vcard', 'Contact', [['first', 'First name', 'text', ''], ['last', 'Last name', 'text', ''], ['mobile', 'Mobile', 'tel', ''], ['work', 'Work phone', 'tel', ''], ['email', 'Email', 'email', ''], ['org', 'Company', 'text', ''], ['title', 'Job title', 'text', ''], ['website', 'Website', 'url', ''], ['street', 'Street', 'text', ''], ['city', 'City', 'text', ''], ['zip', 'Postal code', 'text', ''], ['country', 'Country', 'text', ''], ['note', 'Note', 'textarea', '']]],
  ['custom', 'Custom', [['text', 'Exact content (encoded as-is)', 'textarea', 'e.g. a payment string, app deep link or any raw text']]],
];

function renderForm() {
  const box = $('#qrFields');
  clear(box);
  const def = TYPES.find((t) => t[0] === S.type);
  const vals = S.fields || {};
  for (const [key, label, kind, extra] of def[2]) {
    let ctl;
    if (kind === 'textarea') ctl = h('textarea', { class: 'dt-input qr-ta', rows: 3, placeholder: extra || '', value: vals[key] || '' });
    else if (kind === 'select') ctl = h('select', { class: 'dt-input' }, extra.map(([v, l]) => h('option', { value: v }, l)));
    else if (kind === 'checkbox') {
      const c = h('input', { type: 'checkbox', checked: !!vals[key] });
      c.addEventListener('change', () => { S.fields[key] = c.checked; changed(); });
      box.appendChild(h('label', { class: 'dt-check' }, c, h('span', null, label)));
      continue;
    } else ctl = h('input', { class: 'dt-input', type: kind === 'url' ? 'url' : kind === 'email' ? 'email' : kind === 'tel' ? 'tel' : kind === 'password' ? 'text' : 'text', placeholder: extra || '', value: vals[key] || '', attrs: { autocomplete: 'off', spellcheck: 'false', inputmode: kind === 'tel' ? 'tel' : kind === 'email' ? 'email' : kind === 'url' ? 'url' : null } });
    if (kind === 'select') ctl.value = vals[key] || extra[0][0];
    ctl.dataset.key = key;
    ctl.addEventListener('input', () => { S.fields[key] = ctl.value; changed(); });
    box.appendChild(h('label', { class: 'dt-field' }, h('span', { class: 'dt-label' }, label), ctl));
  }
}
function setType(t) {
  S.type = t;
  // keep fields that make sense across types
  const keep = {}; for (const k of ['phone', 'message']) if (S.fields[k]) keep[k] = S.fields[k];
  S.fields = keep;
  if (t === 'url') S.fields.url = '';
  renderForm(); changed(true);
}

/* ---------- QR options ---------- */
function utf8Binary(str) {
  // qr-code-styling's byte mode takes one char per byte, so give it the UTF-8 bytes (emoji, Hindi, … work).
  const bytes = new TextEncoder().encode(str);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
function ecLevel() {
  if (S.ec !== 'auto') return S.ec;
  return S.logo ? 'H' : 'Q';
}
function fill(color, color2) {
  if (!S.gradient) return { color };
  return { gradient: { type: S.gradType, rotation: (S.gradRot * Math.PI) / 180, colorStops: [{ offset: 0, color }, { offset: 1, color: color2 }] } };
}
let moduleCount = 25;
function options(size, forExport) {
  const margin = Math.round((S.margin * size) / (moduleCount + 2 * S.margin));
  const cornerColor = S.cornerColor || S.fg;
  return {
    width: size, height: size, type: forExport === 'svg' ? 'svg' : 'canvas', margin,
    data: utf8Binary(current.data || ' '),
    image: S.logo || undefined,
    qrOptions: { errorCorrectionLevel: ecLevel(), mode: 'Byte' },
    imageOptions: { hideBackgroundDots: S.hideDots, imageSize: S.logoSize, margin: S.logoMargin, crossOrigin: 'anonymous', saveAsBlob: true },
    dotsOptions: { type: S.dots, ...fill(S.fg, S.fg2) },
    cornersSquareOptions: { type: S.corners, ...(S.cornerColor ? { color: cornerColor } : fill(S.fg, S.fg2)) },
    cornersDotOptions: { type: S.cornerDots, ...(S.cornerColor ? { color: cornerColor } : fill(S.fg, S.fg2)) },
    backgroundOptions: { color: S.transparent ? 'rgba(0,0,0,0)' : S.bg },
  };
}

/* ---------- render + verify ---------- */
let current = { data: '' };
let preview = null;
let verifyToken = 0;

function computeData() {
  const r = build(S.type, S.fields);
  current = r;
  const err = $('#qrDataErr');
  err.hidden = !r.error; err.textContent = r.error || '';
  return r;
}

async function render() {
  const r = computeData();
  const holder = $('#qrPreview');
  if (!r.data) {
    holder.classList.add('is-empty');
    setBadge('wait', 'Enter content to create your QR code');
    $('#qrWarnings').replaceChildren();
    $('#qrPayload').textContent = '';
    return;
  }
  holder.classList.remove('is-empty');
  $('#qrPayload').textContent = r.data;
  $('#qrBytes').textContent = formatBytes(new TextEncoder().encode(r.data).length);
  try {
    const opts = options(720);
    if (!preview) {
      preview = new QRCodeStyling({ ...opts, type: 'canvas' });
      clear(holder); preview.append(holder);
    } else preview.update({ ...opts, type: 'canvas' });
    moduleCount = preview._qr ? preview._qr.getModuleCount() : moduleCount;
    // margin depends on module count — re-apply once the real count is known
    const fixed = options(720);
    if (fixed.margin !== opts.margin) preview.update({ ...fixed, type: 'canvas' });
    $('#qrVersion').textContent = `Version ${(moduleCount - 17) / 4} · ${moduleCount}×${moduleCount} modules · error correction ${ecLevel()}`;
  } catch (e) {
    const msg = String(e && e.message || e);
    setBadge('err', /overflow/i.test(msg) ? 'Too much content for one QR code — shorten it or lower error correction.' : 'Could not build the QR code: ' + msg);
    return;
  }
  warnings(r);
  verify();
}

function setBadge(kind, text) {
  const b = $('#qrVerify');
  b.className = 'qr-verify is-' + kind;
  b.textContent = text;
  $('#qrDownload').disabled = kind === 'wait' || kind === 'err-build';
}

// Verification: render at three sizes (large, medium, small) and decode each one with jsQR.
// "Scan verified" is shown only when every size decodes to exactly the intended content.
// (Exported files are additionally checked with zxing-cpp, an independent decoder, in tests/e2e/qr.e2e.mjs.)
const verify = debounce(async () => {
  const token = ++verifyToken;
  setBadge('wait', 'Checking that it scans…');
  try {
    const want = current.data;
    const results = [];
    for (const size of [900, 520, 300]) {
      const q = new QRCodeStyling({ ...options(size), type: 'canvas' });
      const img = await toImageData(await q.getRawData('png'));
      if (token !== verifyToken) return;
      results.push({ size, text: decodeJsQR(img) });
    }
    if (token !== verifyToken) return;
    const pass = results.map((r) => r.text === want);
    if (pass.every(Boolean)) setBadge('ok', '✓ Scan verified — decodes to exactly your content at large, medium and small size');
    else if (pass[0] && !pass[2]) setBadge('warn', '⚠ Scans when large but not when small — print it bigger, shorten the content or simplify the style');
    else if (pass.some(Boolean)) setBadge('warn', '⚠ Scans in some checks but not all — pick a preset, raise contrast or reduce the logo for reliable scanning');
    else setBadge('err', '✕ Not scannable — increase contrast, make the logo smaller or raise error correction');
    window.__qrVerified = { ok: pass.every(Boolean), results, want };
  } catch (e) {
    if (token === verifyToken) setBadge('warn', 'Could not run the scan check: ' + (e.message || e));
  }
}, 250);

async function toImageData(blob) {
  const bmp = await createImageBitmap(blob);
  // composite on white like paper/screen; transparent codes are checked on a white background
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}
const utf8 = (bytes) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch (e) { return null; } };
function decodeJsQR(img) {
  const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return res ? (utf8(res.binaryData) ?? res.data) : null;
}
async function decodeBlob(blob) { return decodeJsQR(await toImageData(blob)); }

function warnings(r) {
  const list = [];
  if (r.warn) list.push(['info', r.warn]);
  const bg = S.transparent ? '#ffffff' : S.bg;
  const fgs = S.gradient ? [S.fg, S.fg2] : [S.fg];
  if (S.cornerColor) fgs.push(S.cornerColor);
  const worst = Math.min(...fgs.map((f) => contrastRatio(f, bg)));
  if (worst < 3) list.push(['err', `Low contrast (${worst.toFixed(1)}:1) between the code and its background — many phone cameras will fail. Aim for 4:1 or more.`]);
  else if (worst < 4.5) list.push(['warn', `Contrast is ${worst.toFixed(1)}:1 — fine for most phones, but 4.5:1 or more is safest when printed.`]);
  if (fgs.some((f) => relLum(parseColor(f)) > relLum(parseColor(bg)))) list.push(['warn', 'The code is lighter than its background (inverted). Some older scanners cannot read inverted codes — dark on light is safest.']);
  if (S.transparent) list.push(['info', 'Transparent background: place the code on a light, plain surface so it stays readable.']);
  if (S.logo && (S.ec === 'L' || S.ec === 'M')) list.push(['err', `A logo covers part of the code; error correction ${S.ec} may not recover it. Use “Auto” (H) or Q/H.`]);
  if (S.logo && S.logoSize > 0.4) list.push(['warn', 'Large logo — keep it under about 40% of the width for reliable scanning.']);
  if (S.margin < 2) list.push(['warn', 'Very small quiet zone. Scanners need empty space around the code — 4 modules is the standard.']);
  const bytes = new TextEncoder().encode(r.data).length;
  if (bytes > 300) list.push(['info', `Long content (${bytes} bytes) makes a dense code — print it larger (at least 3 cm / 1.2 in wide).`]);
  const box = $('#qrWarnings');
  box.replaceChildren(...list.map(([k, t]) => h('li', { class: 'is-' + k }, t)));
}

/* ---------- presets (suggested styles) ---------- */
let thumbs = [];
const renderThumbs = debounce(() => {
  const data = current.data || 'https://image4k.pages.dev';
  for (const { q, p } of thumbs) {
    q.update({ data: utf8Binary(data), qrOptions: { errorCorrectionLevel: 'Q' }, ...presetOptions(p, 128) });
  }
}, 500);
function presetOptions(p, size) {
  const f = (c1, c2) => (p.gradient ? { gradient: { type: p.gradient, rotation: (p.rot || 0) * Math.PI / 180, colorStops: [{ offset: 0, color: c1 }, { offset: 1, color: c2 }] } } : { color: c1 });
  return {
    width: size, height: size, margin: Math.round(size * 0.06),
    dotsOptions: { type: p.dots, ...f(p.fg, p.fg2) },
    cornersSquareOptions: { type: p.corners, ...(p.corner ? { color: p.corner } : f(p.fg, p.fg2)) },
    cornersDotOptions: { type: p.cornerDots, ...(p.corner ? { color: p.corner } : f(p.fg, p.fg2)) },
    backgroundOptions: { color: p.bg },
  };
}
function buildPresets() {
  const box = $('#qrPresets');
  for (const p of PRESETS) {
    const holder = h('span', { class: 'qr-thumb' });
    const b = h('button', { type: 'button', class: 'qr-preset', dataset: { preset: p.id }, attrs: { 'aria-pressed': S.preset === p.id, title: p.name } }, holder, h('span', null, p.name));
    b.addEventListener('click', () => applyPreset(p));
    box.appendChild(b);
    const q = new QRCodeStyling({ type: 'canvas', data: 'https://image4k.pages.dev', qrOptions: { errorCorrectionLevel: 'Q' }, ...presetOptions(p, 128) });
    q.append(holder);
    thumbs.push({ q, p });
  }
}
function applyPreset(p) {
  Object.assign(S, {
    preset: p.id, fg: p.fg, fg2: p.fg2 || p.fg, gradient: !!p.gradient, gradType: p.gradient || 'linear', gradRot: p.rot || 0,
    bg: p.bg, transparent: false, dots: p.dots, corners: p.corners, cornerDots: p.cornerDots, cornerColor: p.corner || '',
  });
  syncControls(); changed();
}

/* ---------- controls ---------- */
function syncControls() {
  for (const b of document.querySelectorAll('.qr-preset')) b.setAttribute('aria-pressed', b.dataset.preset === S.preset);
  $('#fg').value = S.fg; $('#fg2').value = S.fg2; $('#bg').value = S.bg;
  $('#gradient').checked = S.gradient; $('#gradType').value = S.gradType; $('#gradRot').value = S.gradRot;
  $('#fg2Wrap').hidden = !S.gradient; $('#gradOpts').hidden = !S.gradient;
  $('#transparent').checked = S.transparent; $('#bg').disabled = S.transparent;
  $('#cornerColorOn').checked = !!S.cornerColor; $('#cornerColor').value = S.cornerColor || S.fg; $('#cornerColor').disabled = !S.cornerColor;
  $('#dots').set(S.dots); $('#corners').set(S.corners); $('#cornerDots').set(S.cornerDots);
  $('#margin').value = S.margin; $('#marginOut').textContent = S.margin;
  $('#ec').value = S.ec;
  $('#logoSize').value = S.logoSize; $('#logoSizeOut').textContent = Math.round(S.logoSize * 100) + '%';
  $('#logoMargin').value = S.logoMargin; $('#hideDots').checked = S.hideDots;
  $('#logoOpts').hidden = !S.logo; $('#logoRemove').hidden = !S.logo;
  $('#size').value = String(S.size); $('#format').value = S.format;
}

function changed(full) {
  saveState();
  render();
  renderThumbs();
}

function segInto(id, options, value, key) {
  const s = seg(options, value, (v) => { S[key] = v; S.preset = 'custom'; syncControls(); changed(); }, key);
  s.id = id;
  $('#' + id + 'Slot').replaceWith(s);
}

async function loadLogo(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast('Logo is too large (max 8 MB).', 'err');
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) {
    // SVG files can't always be decoded by createImageBitmap — fall back to an <img>
    try { bmp = await imgFromFile(file); } catch (e2) { return toast('That file is not an image we can read.', 'err'); }
  }
  // Re-encode to a PNG data URL: validates the content (not the extension) and strips anything executable.
  const max = 512, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  S.logo = c.toDataURL('image/png');
  if (S.ec === 'L' || S.ec === 'M') toast('Error correction raised to H so the code still scans with a logo.', 'warn', 4000), S.ec = 'auto';
  syncControls(); changed();
}
function imgFromFile(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const im = new Image();
    im.onload = () => { res(im); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
    im.src = url;
  });
}

async function exportBlob() {
  const fmt = S.format;
  const size = Number(S.size);
  const q = new QRCodeStyling({ ...options(size, fmt), type: fmt === 'svg' ? 'svg' : 'canvas',
    backgroundOptions: { color: S.transparent || fmt === 'png-t' ? 'rgba(0,0,0,0)' : S.bg } });
  const ext = fmt === 'png-t' ? 'png' : fmt;
  const blob = await q.getRawData(ext);
  return { blob, ext };
}
function fileBase() {
  const t = S.type, f = S.fields || {};
  const raw = t === 'url' ? (current.data.replace(/^https?:\/\//, '').split(/[/?#]/)[0]) : t === 'wifi' ? 'wifi-' + (f.ssid || '') : t === 'vcard' ? 'contact-' + ([f.first, f.last].filter(Boolean).join('-')) : t;
  return ('qr-' + raw).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/-+/g, '-').replace(/-$/, '').slice(0, 60) || 'qr-code';
}

function bind() {
  // content type tabs
  const tabs = $('#qrTypes');
  for (const [id, label] of TYPES) {
    const b = h('button', { type: 'button', class: 'qr-type', dataset: { type: id }, attrs: { role: 'tab', 'aria-selected': S.type === id } }, label);
    b.addEventListener('click', () => { for (const x of tabs.children) x.setAttribute('aria-selected', x === b); setType(id); });
    tabs.appendChild(b);
  }
  renderForm();
  buildPresets();

  segInto('dots', [['square', 'Square'], ['rounded', 'Rounded'], ['extra-rounded', 'Extra round'], ['dots', 'Dots'], ['classy', 'Classy'], ['classy-rounded', 'Classy round']], S.dots, 'dots');
  segInto('corners', [['square', 'Square'], ['extra-rounded', 'Rounded'], ['dot', 'Circle']], S.corners, 'corners');
  segInto('cornerDots', [['square', 'Square'], ['dot', 'Dot']], S.cornerDots, 'cornerDots');

  const on = (id, ev, fn) => $('#' + id).addEventListener(ev, fn);
  const custom = () => { S.preset = 'custom'; };
  on('fg', 'input', (e) => { S.fg = e.target.value; custom(); syncControls(); changed(); });
  on('fg2', 'input', (e) => { S.fg2 = e.target.value; custom(); changed(); });
  on('bg', 'input', (e) => { S.bg = e.target.value; custom(); changed(); });
  on('gradient', 'change', (e) => { S.gradient = e.target.checked; custom(); syncControls(); changed(); });
  on('gradType', 'change', (e) => { S.gradType = e.target.value; changed(); });
  on('gradRot', 'input', (e) => { S.gradRot = Number(e.target.value); changed(); });
  on('transparent', 'change', (e) => { S.transparent = e.target.checked; syncControls(); changed(); });
  on('cornerColorOn', 'change', (e) => { S.cornerColor = e.target.checked ? $('#cornerColor').value : ''; custom(); syncControls(); changed(); });
  on('cornerColor', 'input', (e) => { S.cornerColor = e.target.value; custom(); changed(); });
  on('margin', 'input', (e) => { S.margin = Number(e.target.value); $('#marginOut').textContent = S.margin; changed(); });
  on('ec', 'change', (e) => { S.ec = e.target.value; changed(); });
  on('logoBtn', 'click', () => $('#logoFile').click());
  on('logoFile', 'change', (e) => { loadLogo(e.target.files[0]); e.target.value = ''; });
  on('logoRemove', 'click', () => { S.logo = null; syncControls(); changed(); });
  on('logoSize', 'input', (e) => { S.logoSize = Number(e.target.value); $('#logoSizeOut').textContent = Math.round(S.logoSize * 100) + '%'; changed(); });
  on('logoMargin', 'input', (e) => { S.logoMargin = Number(e.target.value); changed(); });
  on('hideDots', 'change', (e) => { S.hideDots = e.target.checked; changed(); });
  on('size', 'change', (e) => { S.size = Number(e.target.value); saveState(); });
  on('format', 'change', (e) => { S.format = e.target.value; $('#size').disabled = S.format === 'svg'; saveState(); });
  on('qrDownload', 'click', async () => {
    if (!current.data) return toast('Enter content first.', 'err');
    try { const { blob, ext } = await exportBlob(); download(fileBase() + (S.format === 'svg' ? '' : '-' + S.size) + '.' + ext, blob); } catch (e) { toast('Export failed: ' + (e.message || e), 'err'); }
  });
  on('qrCopyImg', 'click', async (e) => {
    if (!current.data) return toast('Enter content first.', 'err');
    try {
      const q = new QRCodeStyling({ ...options(1024), type: 'canvas' });
      const blob = await q.getRawData('png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('QR image copied — paste it into a document or chat');
    } catch (err) { toast('Your browser blocked copying images — use Download instead.', 'err'); }
  });
  on('qrCopyText', 'click', (e) => { if (current.data) copyText(current.data, e.currentTarget); });
  on('qrReset', 'click', () => { Object.assign(S, DEFAULT, { fields: { url: 'https://image4k.pages.dev' }, logo: null }); for (const x of tabs.children) x.setAttribute('aria-selected', x.dataset.type === 'url'); renderForm(); syncControls(); changed(); });
  // drop a logo anywhere on the logo card
  const drop = $('#logoCard');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); loadLogo(e.dataTransfer.files[0]); });

  syncControls();
  $('#size').disabled = S.format === 'svg';
  render();
}

if (!QRCodeStyling || !jsQR) {
  $('#qrVerify').textContent = 'The QR engine could not load — please reload the page.';
} else bind();

// test hook
window.__qr = { S, get data() { return current.data; }, render, decodeBlob, exportBlob };
