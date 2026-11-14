/* Image4k PDF — convert & extract: PDF→image, Image→PDF, Extract (text / images / tables).
 * All local in the browser. Nothing is uploaded.
 */
import { PdfDoc } from './engine.js?v=pdf6';
import { parseRanges } from './pages.js?v=pdf6';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const MAX_BYTES = 200 * 1024 * 1024;
let ui, keySeq = 0;

async function openPdf(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error(`${file.name} is not a PDF`);
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 200 MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let password = '';
  for (;;) {
    try { const doc = await PdfDoc.open(bytes, password); doc.fileName = file.name; return doc; }
    catch (e) {
      if (e.code !== 4) throw e;
      ui.busy(false);
      password = await ui.askPassword(!!password, file.name);
      if (password === null) return null;
      ui.busy(true, 'Opening PDF…');
    }
  }
}
const baseName = (n) => (n || 'document').replace(/\.pdf$/i, '');
function downloadBytes(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function zipAndDownload(files, zipName) {
  if (files.length === 1) { downloadBytes(files[0].bytes, files[0].name, files[0].type); return; }
  if (typeof window.JSZip !== 'function') throw new Error('ZIP is unavailable');
  const zip = new window.JSZip();
  for (const f of files) zip.file(f.name, f.bytes);
  downloadBytes(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), zipName, 'application/zip');
}
function imageDataToCanvas(img) { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0); return c; }
const canvasBlob = (c, type, q) => new Promise((res) => c.toBlob((b) => res(b), type, q));
async function blobBytes(b) { return new Uint8Array(await b.arrayBuffer()); }

// =====================================================================
// PDF -> IMAGE
// =====================================================================
const ti = { doc: null, name: '' };
async function toImagesOpen(file) {
  ui.busy(true, 'Opening PDF…');
  try {
    const doc = await openPdf(file); if (!doc) return;
    if (ti.doc) ti.doc.destroy();
    ti.doc = doc; ti.name = baseName(file.name);
    $('#tiName').textContent = `${file.name} · ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}`;
    $('#tiRange').value = '';
    const grid = $('#tiGrid'); grid.innerHTML = '';
    const max = Math.min(doc.pageCount, 30);
    for (let i = 0; i < max; i++) {
      const { w } = doc.size(i); const im = doc.render(i, 150 / w);
      const c = imageDataToCanvas(im); c.className = 'pspl-thumb';
      const cell = document.createElement('div'); cell.className = 'pconv-thumb'; cell.appendChild(c);
      cell.insertAdjacentHTML('beforeend', `<span>${i + 1}</span>`); grid.appendChild(cell);
    }
    if (doc.pageCount > max) grid.insertAdjacentHTML('beforeend', `<div class="pconv-more">+${doc.pageCount - max} more</div>`);
    ui.showView('toimg');
  } catch (e) { ui.toast(e.message, true); } finally { ui.busy(false); }
}
async function toImagesGo() {
  const doc = ti.doc; if (!doc) return;
  const fmt = $('#tiFormat').value, dpi = +$('#tiDpi').value;
  const type = fmt === 'png' ? 'image/png' : 'image/jpeg', ext = fmt === 'png' ? 'png' : 'jpg';
  let indices;
  try { indices = $('#tiRange').value.trim() ? parseRanges($('#tiRange').value, doc.pageCount).flat() : [...Array(doc.pageCount).keys()]; }
  catch (e) { ui.toast(e.message, true); return; }
  ui.busy(true, 'Rendering pages…');
  try {
    const files = [];
    for (let n = 0; n < indices.length; n++) {
      const i = indices[n];
      ui.busy(true, `Rendering page ${n + 1} of ${indices.length}…`);
      const { w } = doc.size(i);
      const img = doc.render(i, dpi / 72);
      let c = imageDataToCanvas(img);
      if (fmt === 'jpg') { const bg = document.createElement('canvas'); bg.width = c.width; bg.height = c.height; const x = bg.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, bg.width, bg.height); x.drawImage(c, 0, 0); c = bg; }
      const blob = await canvasBlob(c, type, 0.92);
      files.push({ name: `${ti.name}-p${i + 1}.${ext}`, bytes: await blobBytes(blob), type });
      await new Promise((r) => setTimeout(r, 0));
    }
    await zipAndDownload(files, `${ti.name}-images.zip`);
    ui.toast(files.length === 1 ? 'Your image is downloading.' : `${files.length} images downloaded as a ZIP.`);
  } catch (e) { ui.toast('Could not export images: ' + e.message, true); } finally { ui.busy(false); }
}

// =====================================================================
// IMAGE -> PDF
// =====================================================================
const ip = { items: [] };   // { key, file, url, w, h, name }
const PAGE_SIZES = { a4: { w: 595, h: 842 }, letter: { w: 612, h: 792 } };
async function imagesAdd(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
  if (!files.length) { ui.toast('Choose image files (JPG, PNG…).', true); return; }
  ui.busy(true, 'Reading images…');
  try {
    for (const f of files) {
      try {
        const bmp = await createImageBitmap(f);
        ip.items.push({ key: ++keySeq, file: f, url: URL.createObjectURL(f), w: bmp.width, h: bmp.height, name: f.name });
        bmp.close && bmp.close();
      } catch (e) { ui.toast(`Could not read ${f.name}.`, true); }
    }
    ui.showView('imgpdf');
    imagesRender();
  } finally { ui.busy(false); }
}
function imagesRender() {
  const list = $('#ipList'); list.innerHTML = '';
  ip.items.forEach((it, pos) => {
    const row = document.createElement('div'); row.className = 'pmrg-row'; row.dataset.key = it.key; row.draggable = true;
    row.innerHTML = `<div class="pmrg-thumb"><img src="${it.url}" alt="" style="max-width:60px;max-height:80px;border-radius:4px"></div>
      <div class="pmrg-info"><b>${pos + 1}. <span></span></b><small>${it.w}×${it.h}px</small></div>
      <div class="pmrg-acts">
        <button type="button" data-act="up" aria-label="Move up" ${pos === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-act="down" aria-label="Move down" ${pos === ip.items.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" data-act="del" aria-label="Remove">✕</button>
      </div>`;
    $('b span', row).textContent = it.name;
    list.appendChild(row);
  });
  $('#ipSummary').textContent = ip.items.length ? `${ip.items.length} image${ip.items.length === 1 ? '' : 's'}` : 'Add one or more images.';
  $('#ipGo').disabled = !ip.items.length;
}
async function imagesToPdfGo() {
  if (!ip.items.length) return;
  const sizeMode = $('#ipSize').value, marginMode = $('#ipMargin').value;
  const margin = { none: 0, small: 24, medium: 48 }[marginMode] ?? 24;
  ui.busy(true, 'Building PDF…');
  try {
    const out = await PdfDoc.create();
    try {
      for (let n = 0; n < ip.items.length; n++) {
        const it = ip.items[n];
        ui.busy(true, `Adding image ${n + 1} of ${ip.items.length}…`);
        // decode to a canvas, re-encode as JPEG (small) unless it has transparency
        const bmp = await createImageBitmap(it.file);
        const hasAlpha = /png|webp|gif|svg/i.test(it.file.type);
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        const cx = c.getContext('2d'); if (!hasAlpha) { cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); }
        cx.drawImage(bmp, 0, 0); bmp.close && bmp.close();
        // page size
        let pw, ph;
        if (sizeMode === 'auto') { pw = c.width * 0.75; ph = c.height * 0.75; }   // 96px -> 72pt
        else { const s = PAGE_SIZES[sizeMode]; const land = c.width > c.height; pw = land ? s.h : s.w; ph = land ? s.w : s.h; }
        out.addBlankPage(out.pageCount, pw, ph);
        const i = out.pageCount - 1;
        // fit image inside margins, centered
        const availW = pw - 2 * margin, availH = ph - 2 * margin;
        const k = Math.min(availW / c.width, availH / c.height);
        const bw = c.width * k, bh = c.height * k;
        const box = { x: (pw - bw) / 2, y: (ph - bh) / 2, w: bw, h: bh };
        if (hasAlpha) { out.addImage(i, cx.getImageData(0, 0, c.width, c.height), box); }
        else { const blob = await canvasBlob(c, 'image/jpeg', 0.9); out.addJpeg(i, await blobBytes(blob), box); }
        await new Promise((r) => setTimeout(r, 0));
      }
      downloadBytes(out.save(), 'images.pdf');
      ui.toast(`Built a PDF with ${ip.items.length} page${ip.items.length === 1 ? '' : 's'}.`);
    } finally { out.destroy(); }
  } catch (e) { ui.toast('Could not build the PDF: ' + e.message, true); } finally { ui.busy(false); }
}

// =====================================================================
// EXTRACT
// =====================================================================
const ex = { doc: null, name: '', mode: 'text' };
async function extractOpen(file) {
  ui.busy(true, 'Opening PDF…');
  try {
    const doc = await openPdf(file); if (!doc) return;
    if (ex.doc) ex.doc.destroy();
    ex.doc = doc; ex.name = baseName(file.name);
    $('#exName').textContent = `${file.name} · ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}`;
    ui.showView('extract'); extractSync();
  } catch (e) { ui.toast(e.message, true); } finally { ui.busy(false); }
}
function extractSync() {
  $$('#extract [data-ex]').forEach((b) => { const on = b.dataset.ex === ex.mode; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
  const hint = { text: 'Download all selectable text as a .txt file (one blank line between pages).', images: 'Download every embedded image as PNG files (a ZIP when there is more than one).', tables: 'Detect rows and columns from text positions and download a .csv per page (ZIP for several).' };
  $('#exHint').textContent = hint[ex.mode];
}
async function extractGo() {
  const doc = ex.doc; if (!doc) return;
  ui.busy(true, 'Extracting…');
  try {
    if (ex.mode === 'text') {
      let txt = '';
      for (let i = 0; i < doc.pageCount; i++) txt += (i ? '\n\n' : '') + doc.pageText(i).replace(/\r\n?/g, '\n').trimEnd();
      if (!txt.trim()) { ui.toast('No selectable text found — this PDF may be scanned images.', true); return; }
      downloadBytes(new Blob([txt], { type: 'text/plain' }), `${ex.name}.txt`, 'text/plain');
      ui.toast('Text extracted.');
    } else if (ex.mode === 'images') {
      const files = []; let seen = 0;
      for (let i = 0; i < doc.pageCount; i++) {
        ui.busy(true, `Scanning page ${i + 1}…`);
        for (const im of doc.imageList(i)) {
          const data = doc.objectImageData(i, im.obj); if (!data || data.width < 4 || data.height < 4) continue;
          const blob = await canvasBlob(imageDataToCanvas(data), 'image/png');
          files.push({ name: `${ex.name}-p${i + 1}-img${++seen}.png`, bytes: await blobBytes(blob), type: 'image/png' });
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      if (!files.length) { ui.toast('No embedded images found in this PDF.', true); return; }
      await zipAndDownload(files, `${ex.name}-images.zip`);
      ui.toast(`Extracted ${files.length} image${files.length === 1 ? '' : 's'}.`);
    } else {
      const files = [];
      for (let i = 0; i < doc.pageCount; i++) {
        const csv = charsToCsv(doc.pageChars(i));
        if (csv) files.push({ name: `${ex.name}-p${i + 1}.csv`, bytes: new TextEncoder().encode(csv), type: 'text/csv' });
      }
      if (!files.length) { ui.toast('No table-like text found to turn into CSV.', true); return; }
      await zipAndDownload(files, `${ex.name}-tables.zip`);
      ui.toast(`Built ${files.length} CSV file${files.length === 1 ? '' : 's'} from the text layout.`);
    }
  } catch (e) { ui.toast('Could not extract: ' + e.message, true); } finally { ui.busy(false); }
}

/** Cluster characters into rows (by baseline) and columns (by x gaps) and emit CSV. */
function charsToCsv(chars) {
  if (chars.length < 4) return '';
  // group into rows by y
  const sorted = chars.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = []; let cur = null;
  for (const c of sorted) {
    if (!cur || c.y - cur.y > c.h * 0.6) { cur = { y: c.y, cells: [c] }; rows.push(cur); }
    else cur.cells.push(c);
  }
  if (rows.length < 2) return '';
  // build word boxes per row (gap > 0.35*height starts a new cell)
  const table = rows.map((r) => {
    const cs = r.cells.slice().sort((a, b) => a.x - b.x);
    const cells = []; let word = '', x0 = cs[0].x, prev = null;
    for (const c of cs) {
      if (prev && c.x - (prev.x + prev.w) > c.h * 0.9) { cells.push({ x: x0, text: word }); word = ''; x0 = c.x; }
      word += c.ch; prev = c;
    }
    if (word) cells.push({ x: x0, text: word });
    return cells;
  });
  // align columns by shared x positions
  const cols = [];
  table.forEach((r) => r.forEach((cell) => { if (!cols.some((x) => Math.abs(x - cell.x) < 12)) cols.push(cell.x); }));
  cols.sort((a, b) => a - b);
  if (cols.length < 2) return '';
  const esc = (s) => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  // assign each row's cells to the nearest column
  const grid = table.map((r) => {
    const out = new Array(cols.length).fill('');
    r.forEach((cell) => {
      let ci = 0, best = Infinity;
      cols.forEach((x, k) => { const d = Math.abs(x - cell.x); if (d < best) { best = d; ci = k; } });
      out[ci] = (out[ci] ? out[ci] + ' ' : '') + cell.text.trim();
    });
    return out;
  });
  // drop columns that are empty in every row, and rows that are completely empty
  const keepCol = cols.map((_, c) => grid.some((row) => row[c].trim() !== ''));
  const rows2 = grid.map((row) => row.filter((_, c) => keepCol[c]))
    .filter((row) => row.some((v) => v.trim() !== ''));
  if (rows2.length < 2 || rows2[0].length < 2) return '';
  return rows2.map((row) => row.map(esc).join(',')).join('\r\n');
}

// =====================================================================
// wiring
// =====================================================================
function bind() {
  $('#tiGo').addEventListener('click', toImagesGo);
  $('#ipAdd').addEventListener('click', () => $('#imgpdfInput').click());
  $('#imgpdfInput').addEventListener('change', (e) => { const fl = e.target.files; imagesAdd(fl).then(() => { e.target.value = ''; }); });
  $('#ipList').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]'); if (!act) return;
    const key = +act.closest('.pmrg-row').dataset.key, i = ip.items.findIndex((x) => x.key === key);
    if (act.dataset.act === 'del') { URL.revokeObjectURL(ip.items[i].url); ip.items.splice(i, 1); }
    else { const j = act.dataset.act === 'up' ? i - 1 : i + 1; if (j < 0 || j >= ip.items.length) return; [ip.items[i], ip.items[j]] = [ip.items[j], ip.items[i]]; }
    imagesRender();
  });
  $('#ipGo').addEventListener('click', imagesToPdfGo);
  $$('#extract [data-ex]').forEach((b) => b.addEventListener('click', () => { ex.mode = b.dataset.ex; extractSync(); }));
  $('#exGo').addEventListener('click', extractGo);
}

export function initConvertTools(helpers) { ui = helpers; bind(); }
export const convertTools = {
  toImages: (file) => toImagesOpen(file),
  imagesToPdf: (files) => imagesAdd(files),
  extract: (file) => extractOpen(file)
};
window.__pdfConvert = { ti, ip, ex, charsToCsv };
