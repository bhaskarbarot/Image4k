/* Image4k PDF — optimize: Compress PDF (recompress images, keep text & vectors sharp).
 * Enhance to HD (AI image upscaling inside a PDF) is added once the shared Real-ESRGAN
 * module is in place — see initEnhance below.
 * All local in the browser. Nothing is uploaded.
 */
import { PdfDoc } from './engine.js?v=pdf7';

const $ = (s, r = document) => r.querySelector(s);
const MAX_BYTES = 200 * 1024 * 1024;
let ui;

async function openPdf(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error(`${file.name} is not a PDF`);
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 200 MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let password = '';
  for (;;) {
    try { return { doc: await PdfDoc.open(bytes, password), bytes, password }; }
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
function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const canvasBlob = (c, type, q) => new Promise((res) => c.toBlob((b) => res(b), type, q));
async function blobBytes(b) { return new Uint8Array(await b.arrayBuffer()); }
function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }

const PRESETS = {
  strong: { dpi: 72, q: 0.6, label: 'Strong' },
  balanced: { dpi: 150, q: 0.75, label: 'Balanced' },
  light: { dpi: 220, q: 0.82, label: 'Light' }
};

const cmp = { doc: null, name: '', origBytes: null };

async function compressOpen(file) {
  ui.busy(true, 'Opening PDF…');
  try {
    const r = await openPdf(file); if (!r) return;
    if (cmp.doc) cmp.doc.destroy();
    cmp.doc = r.doc; cmp.origBytes = r.bytes; cmp.pw = r.password; cmp.name = baseName(file.name);
    $('#cmName').textContent = `${file.name} · ${fmtSize(r.bytes.length)}`;
    $('#cmResult').hidden = true;
    ui.showView('compress');
  } catch (e) { ui.toast(e.message, true); } finally { ui.busy(false); }
}

/** Downscale ImageData to at most maxW×maxH, return a canvas. */
function downscale(img, maxW, maxH) {
  const k = Math.min(1, maxW / img.width, maxH / img.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
  const src = document.createElement('canvas'); src.width = img.width; src.height = img.height;
  src.getContext('2d').putImageData(img, 0, 0);
  const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function compressGo() {
  const doc = cmp.doc; if (!doc) return;
  const preset = PRESETS[$('#cmLevel').value];
  ui.busy(true, 'Compressing…');
  try {
    let changed = 0;
    for (let i = 0; i < doc.pageCount; i++) {
      ui.busy(true, `Compressing page ${i + 1} of ${doc.pageCount}…`);
      let touched = false;
      for (const im of doc.imageList(i)) {
        if (!im.box || !im.pixels) continue;
        if (doc.hasAlpha(im.obj)) continue;                    // keep transparency intact
        const dispWpt = im.box.w, dispHpt = im.box.h;
        const effDpi = (im.pixels.w / (dispWpt / 72));          // current pixels per inch on the page
        if (effDpi <= preset.dpi * 1.1) continue;              // already small enough
        const maxW = Math.max(1, Math.round((dispWpt / 72) * preset.dpi));
        const maxH = Math.max(1, Math.round((dispHpt / 72) * preset.dpi));
        if (maxW >= im.pixels.w) continue;
        const data = doc.objectImageData(i, im.obj); if (!data) continue;
        const c = downscale(data, maxW, maxH);
        const blob = await canvasBlob(c, 'image/jpeg', preset.q); if (!blob) continue;
        doc.replaceJpeg(i, im.obj, await blobBytes(blob));
        touched = true; changed++;
        await new Promise((r) => setTimeout(r, 0));
      }
      if (touched) doc.commit(i);
    }
    const out = doc.save();
    const before = cmp.origBytes.length, after = out.length;
    const smaller = after < before * 0.98;
    $('#cmResult').hidden = false;
    if (changed === 0) {
      $('#cmResult').innerHTML = `<b>Already optimized.</b> No images needed recompressing at this level — the file is unchanged.`;
      ui.toast('Nothing to compress at this level.');
    } else if (!smaller) {
      $('#cmResult').innerHTML = `<b>Kept the original.</b> Recompressing did not make it smaller (${fmtSize(before)} → ${fmtSize(after)}), so the original is downloaded unchanged.`;
      downloadBytes(cmp.origBytes, `${cmp.name}.pdf`);
    } else {
      const pct = Math.min(99, Math.round((1 - after / before) * 100));
      $('#cmResult').innerHTML = `<b>Done — ${pct}% smaller.</b> ${fmtSize(before)} → <b>${fmtSize(after)}</b> · ${changed} image${changed === 1 ? '' : 's'} recompressed. Text stays selectable.`;
      downloadBytes(out, `${cmp.name}-compressed.pdf`);
      ui.toast(`Compressed ${pct}% smaller.`);
    }
    // reload a clean copy so the user can try another level
    doc.load(cmp.origBytes, cmp.pw);
  } catch (e) { ui.toast('Could not compress: ' + e.message, true); try { doc.load(cmp.origBytes, cmp.pw); } catch (_) {} } finally { ui.busy(false); }
}

function bind() {
  $('#cmGo').addEventListener('click', compressGo);
}

export function initOptimizeTools(helpers) { ui = helpers; bind(); }
export const optimizeTools = { compress: (file) => compressOpen(file) };
window.__pdfOptimize = { cmp };
