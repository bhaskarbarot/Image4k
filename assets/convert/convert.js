/* Image Converter — HEIC/HEIF, PNG, JPG, WebP, AVIF, GIF, BMP → JPG / PNG / WebP.
 * 100% in the browser: HEIC is decoded with heic2any (libheif/wasm), everything else via the canvas.
 * Nothing is uploaded. Multiple files + "Download all as ZIP" (JSZip). */
(function () {
  'use strict';
  const MAX_FILES = 40;
  const MAX_BYTES = 80 * 1024 * 1024;         // 80 MB per image
  const FORMATS = {
    jpg: { mime: 'image/jpeg', ext: 'jpg', lossy: true, label: 'JPG' },
    png: { mime: 'image/png', ext: 'png', lossy: false, label: 'PNG' },
    webp: { mime: 'image/webp', ext: 'webp', lossy: true, label: 'WebP' },
  };

  const $ = (id) => document.getElementById(id);
  const fmtBytes = (n) => { if (n < 1024) return n + ' B'; const u = ['KB', 'MB', 'GB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1); return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i]; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const baseName = (n) => n.replace(/\.[^.]+$/, '') || n;

  let items = [];            // { file, card, blob, url, status }
  let busy = false;

  function isHeic(file) {
    const n = (file.name || '').toLowerCase();
    return file.type === 'image/heic' || file.type === 'image/heif' || n.endsWith('.heic') || n.endsWith('.heif');
  }

  async function decodeToBitmap(file) {
    if (isHeic(file)) {
      if (typeof window.heic2any !== 'function') throw new Error('HEIC decoder failed to load — reload the page.');
      let out = await window.heic2any({ blob: file, toType: 'image/png' });
      if (Array.isArray(out)) out = out[0];
      return await createImageBitmap(out);
    }
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  }

  async function encode(bitmap, fmt, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (fmt.mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); } // JPG has no alpha
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => b ? res(b) : rej(new Error('Your browser could not export ' + fmt.label + '.')), fmt.mime, fmt.lossy ? quality : undefined));
    return blob;
  }

  function currentFmt() { return FORMATS[$('fmt').value] || FORMATS.jpg; }
  function currentQuality() { return Math.min(1, Math.max(0.3, (parseInt($('quality').value, 10) || 92) / 100)); }

  function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f && (f.type.startsWith('image/') || isHeic(f)));
    if (!files.length) { flash('Those don’t look like images. Try JPG, PNG, WebP, HEIC…'); return; }
    for (const file of files) {
      if (items.length >= MAX_FILES) { flash('Up to ' + MAX_FILES + ' images at a time.'); break; }
      if (file.size > MAX_BYTES) { flash(esc(file.name) + ' is over the ' + fmtBytes(MAX_BYTES) + ' limit.'); continue; }
      const item = { file, blob: null, url: null, status: 'queued' };
      item.card = buildCard(item);
      items.push(item);
      $('results').appendChild(item.card);
    }
    $('empty').hidden = items.length > 0;
    $('bar').hidden = items.length === 0;
    convertAll();
  }

  function buildCard(item) {
    const card = document.createElement('div');
    card.className = 'cv-item';
    card.innerHTML =
      '<div class="cv-thumb" aria-hidden="true"><span class="cv-spin"></span></div>' +
      '<div class="cv-meta"><strong class="cv-name"></strong><span class="cv-sub">' + esc(item.file.name.split('.').pop().toUpperCase()) + ' · ' + fmtBytes(item.file.size) + '</span></div>' +
      '<div class="cv-act"></div>';
    card.querySelector('.cv-name').textContent = item.file.name;
    return card;
  }

  async function convertAll() {
    if (busy) return; busy = true;
    const fmt = currentFmt(), q = currentQuality();
    for (const item of items) {
      if (item.status === 'done' && item.outFmt === fmt.ext && item.outQ === (fmt.lossy ? q : 1)) continue;
      await convertItem(item, fmt, q);
    }
    busy = false;
    const done = items.filter((i) => i.status === 'done');
    $('downloadAll').hidden = done.length < 2;
    $('clearBtn').hidden = items.length === 0;
  }

  async function convertItem(item, fmt, q) {
    item.status = 'working';
    const thumb = item.card.querySelector('.cv-thumb');
    const act = item.card.querySelector('.cv-act');
    thumb.innerHTML = '<span class="cv-spin"></span>'; act.innerHTML = '';
    try {
      const bmp = await decodeToBitmap(item.file);
      const blob = await encode(bmp, fmt, q);
      if (bmp.close) bmp.close();
      if (item.url) URL.revokeObjectURL(item.url);
      item.blob = blob; item.url = URL.createObjectURL(blob);
      item.outName = baseName(item.file.name) + '.' + fmt.ext;
      item.outFmt = fmt.ext; item.outQ = fmt.lossy ? q : 1; item.status = 'done';
      const pct = item.file.size ? Math.round((1 - blob.size / item.file.size) * 100) : 0;
      thumb.innerHTML = '<img src="' + item.url + '" alt="">';
      item.card.querySelector('.cv-sub').innerHTML =
        esc(item.file.name.split('.').pop().toUpperCase()) + ' → <b>' + fmt.label + '</b> · ' +
        fmtBytes(item.file.size) + ' → ' + fmtBytes(blob.size) +
        (pct > 0 ? ' <span class="cv-save">−' + pct + '%</span>' : '');
      const a = document.createElement('a');
      a.className = 'btn btn-primary btn-sm'; a.href = item.url; a.download = item.outName; a.textContent = 'Download';
      act.appendChild(a);
    } catch (e) {
      item.status = 'error';
      thumb.innerHTML = '<span class="cv-err">!</span>';
      act.innerHTML = '<span class="cv-errmsg"></span>';
      act.querySelector('.cv-errmsg').textContent = e.message || 'Could not convert this file.';
    }
  }

  async function downloadAllZip() {
    const done = items.filter((i) => i.status === 'done' && i.blob);
    if (!done.length) return;
    if (typeof window.JSZip !== 'function') { done.forEach((i) => i.card.querySelector('a.btn') && i.card.querySelector('a.btn').click()); return; }
    const btn = $('downloadAll'); const label = btn.textContent; btn.textContent = 'Zipping…'; btn.disabled = true;
    try {
      const zip = new window.JSZip(); const used = {};
      for (const i of done) { let name = i.outName; while (used[name]) { const m = name.match(/^(.*?)(\.[^.]+)$/); name = (m ? m[1] + '-' + (used[i.outName]) + m[2] : name + '-dup'); } used[i.outName] = (used[i.outName] || 1) + 1; used[name] = 1; zip.file(name, i.blob); }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'converted-images.zip'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } finally { btn.textContent = label; btn.disabled = false; }
  }

  function clearAll() {
    items.forEach((i) => { if (i.url) URL.revokeObjectURL(i.url); });
    items = []; $('results').innerHTML = '';
    $('empty').hidden = false; $('bar').hidden = true; $('downloadAll').hidden = true; $('clearBtn').hidden = true;
  }

  let flashT;
  function flash(msg) { const el = $('flash'); el.textContent = msg; el.hidden = false; clearTimeout(flashT); flashT = setTimeout(() => { el.hidden = true; }, 4000); }

  function syncQualityUi() {
    const lossy = currentFmt().lossy;
    $('qualityWrap').hidden = !lossy;
    $('qualityOut').textContent = $('quality').value + '%';
  }

  function init() {
    const drop = $('drop'), input = $('file');
    $('browse').addEventListener('click', () => input.click());
    drop.addEventListener('click', (e) => { if (!e.target.closest('button')) input.click(); });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-drag'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); if (t === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('is-drag'); }));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
    $('fmt').addEventListener('change', () => { syncQualityUi(); convertAll(); });
    $('quality').addEventListener('input', syncQualityUi);
    $('quality').addEventListener('change', () => { if (currentFmt().lossy) convertAll(); });
    $('downloadAll').addEventListener('click', downloadAllZip);
    $('clearBtn').addEventListener('click', clearAll);
    syncQualityUi();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
