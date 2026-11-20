/* Metadata / EXIF Remover — reads the hidden data in your photos (GPS location, camera, date, software)
 * and strips it out. JPEG and PNG are cleaned losslessly (pixels untouched); other formats are re-encoded.
 * 100% in the browser — nothing is uploaded. Batch + "Download all as ZIP" (JSZip). */
(function () {
  'use strict';
  const MAX_FILES = 40;
  const MAX_BYTES = 80 * 1024 * 1024;
  const $ = (id) => document.getElementById(id);
  const fmtBytes = (n) => { if (n < 1024) return n + ' B'; const u = ['KB', 'MB', 'GB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1); return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i]; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ascii = (u8, off, count) => { let s = ''; for (let k = 0; k < count; k++) { const c = u8[off + k]; if (c === 0) break; s += String.fromCharCode(c); } return s.trim(); };

  /* ---------------- EXIF (TIFF) parser — just the useful tags ---------------- */
  function parseExifTiff(dv, t) {
    const le = dv.getUint16(t) === 0x4949;
    const g16 = (o) => dv.getUint16(o, le), g32 = (o) => dv.getUint32(o, le);
    if (dv.getUint16(t + 2, le) !== 0x002A) return null;
    const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const valOff = (e, type, count) => ((SIZES[type] || 1) * count <= 4 ? e + 8 : t + g32(e + 8));
    const readIFD = (off) => { const n = g16(off); const out = []; for (let i = 0; i < n; i++) { const e = off + 2 + i * 12; out.push({ tag: g16(e), type: g16(e + 2), count: g32(e + 4), e }); } return out; };
    const res = {}; let exifPtr = 0, gpsPtr = 0;
    for (const en of readIFD(t + g32(t + 4))) {
      const vo = valOff(en.e, en.type, en.count);
      if (en.tag === 0x010F) res.make = ascii(new Uint8Array(dv.buffer), vo, en.count);
      else if (en.tag === 0x0110) res.model = ascii(new Uint8Array(dv.buffer), vo, en.count);
      else if (en.tag === 0x0131) res.software = ascii(new Uint8Array(dv.buffer), vo, en.count);
      else if (en.tag === 0x0132) res.datetime = ascii(new Uint8Array(dv.buffer), vo, en.count);
      else if (en.tag === 0x0112) res.orientation = g16(vo);
      else if (en.tag === 0x8769) exifPtr = g32(en.e + 8);
      else if (en.tag === 0x8825) gpsPtr = g32(en.e + 8);
    }
    if (exifPtr) for (const en of readIFD(t + exifPtr)) { if (en.tag === 0x9003) res.dateTaken = ascii(new Uint8Array(dv.buffer), valOff(en.e, en.type, en.count), en.count); }
    if (gpsPtr) {
      let latRef, lonRef, lat, lon; const rat = (o) => g32(o) / (g32(o + 4) || 1);
      for (const en of readIFD(t + gpsPtr)) {
        const vo = valOff(en.e, en.type, en.count);
        if (en.tag === 1) latRef = ascii(new Uint8Array(dv.buffer), vo, en.count);
        else if (en.tag === 2) lat = [rat(vo), rat(vo + 8), rat(vo + 16)];
        else if (en.tag === 3) lonRef = ascii(new Uint8Array(dv.buffer), vo, en.count);
        else if (en.tag === 4) lon = [rat(vo), rat(vo + 8), rat(vo + 16)];
      }
      if (lat && lon) { let la = lat[0] + lat[1] / 60 + lat[2] / 3600, lo = lon[0] + lon[1] / 60 + lon[2] / 3600; if (latRef === 'S') la = -la; if (lonRef === 'W') lo = -lo; res.gps = { lat: la, lon: lo }; }
    }
    return res;
  }

  /* ---------------- JPEG ---------------- */
  function scanJpeg(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = { exif: null, hasXmp: false, hasIcc: false, appCount: 0 };
    let i = 2;
    while (i + 4 <= u8.length) {
      if (u8[i] !== 0xFF) break;
      const marker = u8[i + 1];
      if (marker === 0xDA || marker === 0xD9) break;
      const len = (u8[i + 2] << 8) | u8[i + 3]; const ds = i + 4;
      if (marker >= 0xE0 && marker <= 0xEF) {
        out.appCount++;
        if (marker === 0xE1 && u8[ds] === 0x45 && u8[ds + 1] === 0x78 && u8[ds + 2] === 0x69 && u8[ds + 3] === 0x66) { try { out.exif = parseExifTiff(dv, ds + 6); } catch (e) { out.exif = out.exif || {}; } }
        else if (marker === 0xE1 && ascii(u8, ds, Math.min(len, 32)).indexOf('ns.adobe.com/xap') >= 0) out.hasXmp = true;
        else if (marker === 0xE2 && ascii(u8, ds, Math.min(len, 16)).indexOf('ICC_PROFILE') >= 0) out.hasIcc = true;
      }
      i += 2 + len;
    }
    return out;
  }
  function stripJpeg(u8) {
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
    const keep = [[0, 2]]; let i = 2;
    while (i + 1 < u8.length) {
      if (u8[i] !== 0xFF) { keep.push([i, u8.length]); break; }
      const marker = u8[i + 1];
      if (marker === 0xDA) { keep.push([i, u8.length]); break; }       // start of scan → rest of file
      if (marker === 0xD9) { keep.push([i, i + 2]); break; }           // EOI
      if (marker >= 0xD0 && marker <= 0xD7) { keep.push([i, i + 2]); i += 2; continue; }
      const len = (u8[i + 2] << 8) | u8[i + 3]; const end = i + 2 + len;
      const drop = (marker >= 0xE0 && marker <= 0xEF) || marker === 0xFE; // APPn + comment
      if (!drop) keep.push([i, end]);
      i = end;
    }
    return join(u8, keep);
  }

  /* ---------------- PNG ---------------- */
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  function isPng(u8) { for (let k = 0; k < 8; k++) if (u8[k] !== PNG_SIG[k]) return false; return true; }
  function readPng(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const res = { text: [], hasExif: false, hasTime: false }; let i = 8;
    while (i + 8 <= u8.length) {
      const len = dv.getUint32(i); const type = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') { let kw = ''; for (let k = i + 8; k < i + 8 + len && u8[k] !== 0; k++) kw += String.fromCharCode(u8[k]); res.text.push(kw || type); }
      else if (type === 'eXIf') res.hasExif = true; else if (type === 'tIME') res.hasTime = true;
      i += 12 + len; if (type === 'IEND') break;
    }
    return res;
  }
  function stripPng(u8) {
    if (!isPng(u8)) return null;
    const drop = { tEXt: 1, zTXt: 1, iTXt: 1, eXIf: 1, tIME: 1, iDOT: 1 };
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const keep = [[0, 8]]; let i = 8;
    while (i + 8 <= u8.length) {
      const len = dv.getUint32(i); const type = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]); const end = i + 12 + len;
      if (!drop[type]) keep.push([i, end]);
      i = end; if (type === 'IEND') break;
    }
    return join(u8, keep);
  }

  function join(u8, keep) { let total = 0; for (const [a, b] of keep) total += b - a; const out = new Uint8Array(total); let o = 0; for (const [a, b] of keep) { out.set(u8.subarray(a, b), o); o += b - a; } return out; }

  async function reencode(file) {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const type = (file.type === 'image/webp') ? 'image/webp' : 'image/png';
    c.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
    const blob = await new Promise((res) => c.toBlob(res, type, 0.95));
    return { blob, mime: type, lossless: false };
  }

  /* ---------------- summarise found metadata ---------------- */
  function summarize(found, kind) {
    const items = []; let gps = null;
    if (kind === 'jpeg') {
      const x = found.exif;
      if (x) {
        if (x.gps) { gps = x.gps; items.push({ k: 'gps', label: 'Location (GPS)', val: x.gps.lat.toFixed(5) + ', ' + x.gps.lon.toFixed(5) }); }
        if (x.make || x.model) items.push({ k: 'cam', label: 'Camera', val: [x.make, x.model].filter(Boolean).join(' ') });
        if (x.dateTaken || x.datetime) items.push({ k: 'date', label: 'Date taken', val: x.dateTaken || x.datetime });
        if (x.software) items.push({ k: 'sw', label: 'Software', val: x.software });
        if (x.orientation) items.push({ k: 'ori', label: 'Orientation', val: String(x.orientation) });
      }
      if (found.hasXmp) items.push({ k: 'xmp', label: 'XMP data', val: 'present' });
      if (found.hasIcc) items.push({ k: 'icc', label: 'Colour profile (ICC)', val: 'present' });
      if (!items.length && found.appCount) items.push({ k: 'other', label: 'Embedded data', val: found.appCount + ' block' + (found.appCount > 1 ? 's' : '') });
    } else if (kind === 'png') {
      for (const t of found.text) items.push({ k: 'txt', label: 'Text', val: t });
      if (found.hasExif) items.push({ k: 'gps', label: 'EXIF data', val: 'present' });
      if (found.hasTime) items.push({ k: 'date', label: 'Timestamp', val: 'present' });
    }
    return { items, gps };
  }

  async function process(file) {
    const u8 = new Uint8Array(await file.arrayBuffer());
    if (u8[0] === 0xFF && u8[1] === 0xD8) { const f = scanJpeg(u8); const s = summarize(f, 'jpeg'); const clean = stripJpeg(u8); return { ...s, blob: new Blob([clean], { type: 'image/jpeg' }), ext: 'jpg', lossless: true }; }
    if (isPng(u8)) { const f = readPng(u8); const s = summarize(f, 'png'); const clean = stripPng(u8); return { ...s, blob: new Blob([clean], { type: 'image/png' }), ext: 'png', lossless: true }; }
    const r = await reencode(file); return { items: [{ k: 'other', label: 'Metadata', val: 'removed (re-encoded)' }], gps: null, blob: r.blob, ext: r.mime === 'image/webp' ? 'webp' : 'png', lossless: false, reencoded: true };
  }

  /* ---------------- UI ---------------- */
  let items = [], busy = false;
  const cleanName = (n, ext) => (n.replace(/\.[^.]+$/, '') || n) + '-clean.' + ext;

  function addFiles(list) {
    const files = Array.from(list).filter((f) => f && f.type.startsWith('image/'));
    if (!files.length) { flash('Please choose image files (JPG, PNG, WebP…).'); return; }
    for (const file of files) {
      if (items.length >= MAX_FILES) { flash('Up to ' + MAX_FILES + ' images at a time.'); break; }
      if (file.size > MAX_BYTES) { flash(esc(file.name) + ' is over the ' + fmtBytes(MAX_BYTES) + ' limit.'); continue; }
      const it = { file, blob: null, url: null };
      it.card = card(it); items.push(it); $('results').appendChild(it.card);
    }
    $('empty').hidden = items.length > 0; $('bar').hidden = items.length === 0;
    run();
  }
  function card(it) {
    const el = document.createElement('div'); el.className = 'md-item';
    el.innerHTML = '<div class="md-thumb" aria-hidden="true"><span class="md-spin"></span></div>' +
      '<div class="md-body"><strong class="md-name"></strong><div class="md-found">Scanning…</div></div>' +
      '<div class="md-act"></div>';
    el.querySelector('.md-name').textContent = it.file.name;
    try { const u = URL.createObjectURL(it.file); it._thumb = u; el.querySelector('.md-thumb').innerHTML = '<img src="' + u + '" alt="">'; } catch (e) {}
    return el;
  }
  async function run() {
    if (busy) return; busy = true;
    for (const it of items) { if (!it.blob) await one(it); }
    busy = false;
    $('downloadAll').hidden = items.filter((i) => i.blob).length < 2;
    $('clearBtn').hidden = items.length === 0;
  }
  async function one(it) {
    const found = it.card.querySelector('.md-found'); const act = it.card.querySelector('.md-act');
    try {
      const r = await process(it.file);
      it.blob = r.blob; it.url = URL.createObjectURL(r.blob); it.outName = cleanName(it.file.name, r.ext);
      if (r.items.length) {
        found.innerHTML = '<span class="md-found-label">Removed:</span> ' + r.items.map((x) =>
          '<span class="md-chip' + (x.k === 'gps' ? ' is-gps' : '') + '">' + (x.k === 'gps' ? '📍 ' : '') + esc(x.label) + (x.val && x.val !== 'present' ? ': ' + esc(x.val) : '') + '</span>').join('') +
          (r.reencoded ? '<span class="md-note">re-encoded to remove metadata</span>' : '');
      } else {
        found.innerHTML = '<span class="md-clean">✓ No metadata found — already clean</span>';
      }
      const a = document.createElement('a'); a.className = 'btn btn-primary btn-sm'; a.href = it.url; a.download = it.outName; a.textContent = 'Download clean';
      act.appendChild(a);
    } catch (e) { found.innerHTML = '<span class="md-err">Could not process this file.</span>'; }
  }
  async function downloadAllZip() {
    const done = items.filter((i) => i.blob); if (!done.length) return;
    if (typeof window.JSZip !== 'function') { done.forEach((i) => { const a = i.card.querySelector('a.btn'); if (a) a.click(); }); return; }
    const btn = $('downloadAll'); const lab = btn.textContent; btn.textContent = 'Zipping…'; btn.disabled = true;
    try {
      const zip = new window.JSZip(); const used = {};
      for (const i of done) { let n = i.outName; while (used[n]) n = n.replace(/(\.[^.]+)$/, '-' + (used[i.outName]++) + '$1'); used[i.outName] = (used[i.outName] || 1) + 1; used[n] = 1; zip.file(n, i.blob); }
      const blob = await zip.generateAsync({ type: 'blob' }); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'clean-images.zip'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } finally { btn.textContent = lab; btn.disabled = false; }
  }
  function clearAll() { items.forEach((i) => { if (i.url) URL.revokeObjectURL(i.url); if (i._thumb) URL.revokeObjectURL(i._thumb); }); items = []; $('results').innerHTML = ''; $('empty').hidden = false; $('bar').hidden = true; $('downloadAll').hidden = true; $('clearBtn').hidden = true; }
  let flashT; function flash(m) { const el = $('flash'); el.textContent = m; el.hidden = false; clearTimeout(flashT); flashT = setTimeout(() => { el.hidden = true; }, 4000); }

  function init() {
    const drop = $('drop'), input = $('file');
    $('browse').addEventListener('click', () => input.click());
    drop.addEventListener('click', (e) => { if (!e.target.closest('button')) input.click(); });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-drag'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); if (t === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('is-drag'); }));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
    $('downloadAll').addEventListener('click', downloadAllZip);
    $('clearBtn').addEventListener('click', clearAll);
  }
  document.addEventListener('DOMContentLoaded', init);
})();
