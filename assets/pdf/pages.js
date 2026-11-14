/* Image4k PDF — page tools: Organize, Merge, Split.
 * Nothing is changed in the original files: every tool builds a fresh PDF from the chosen pages.
 */
import { PdfDoc } from './engine.js?v=pdf7';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const MAX_BYTES = 200 * 1024 * 1024;
let ui;          // { toast, busy, askPassword, showView, openInEditor }
let keySeq = 0;

// =====================================================================
// shared helpers
// =====================================================================
async function openPdf(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error(`${file.name} is not a PDF`);
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 200 MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let password = '';
  for (;;) {
    try {
      const doc = await PdfDoc.open(bytes, password);
      doc.fileName = file.name;
      return doc;
    } catch (e) {
      if (e.code !== 4) throw e;
      ui.busy(false);
      password = await ui.askPassword(!!password, file.name);
      if (password === null) return null;
      ui.busy(true, 'Opening PDF…');
    }
  }
}

function thumbCanvas(doc, i, width = 150) {
  const c = document.createElement('canvas');
  try {
    const { w } = doc.size(i);
    const img = doc.render(i, width / w);
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
  } catch (e) { c.width = width; c.height = Math.round(width * 1.3); }
  return c;
}

/** "1-3, 5, 8-" -> [[0,1,2],[4],[7..n-1]] (0-based). Throws a friendly error. */
export function parseRanges(text, total) {
  const out = [];
  for (const part of text.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*(?:-|–|to)\s*(\d*)$/i) || part.match(/^(\d+)$/);
    if (!m) throw new Error(`“${part}” is not a page range (use e.g. 1-3, 5, 8-)`);
    let a, b;
    if (m.length === 2) { a = b = +m[1]; } else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : total; }
    if (a < 1 || b < 1 || a > total || b > total) throw new Error(`Page ${Math.max(a, b)} does not exist — this PDF has ${total} pages`);
    const r = [];
    if (a <= b) for (let p = a; p <= b; p++) r.push(p - 1); else for (let p = a; p >= b; p--) r.push(p - 1);
    out.push(r);
  }
  if (!out.length) throw new Error('Enter at least one page or range');
  return out;
}

function downloadBytes(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function downloadMany(files, zipName) {
  if (files.length === 1) { downloadBytes(files[0].bytes, files[0].name); return; }
  if (typeof window.JSZip !== 'function') throw new Error('ZIP is unavailable');
  const zip = new window.JSZip();
  for (const f of files) zip.file(f.name, f.bytes);
  downloadBytes(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }), zipName, 'application/zip');
}

/**
 * Build a new PDF from page specs: { doc, index, rot (extra quarter turns), crop (view rect) } or { blank: {w,h} }.
 * Consecutive pages from the same source are copied in one go.
 */
async function buildPdf(specs) {
  const out = await PdfDoc.create();
  try {
    let k = 0;
    while (k < specs.length) {
      const s = specs[k];
      if (s.blank) { out.addBlankPage(out.pageCount, s.blank.w, s.blank.h); k++; continue; }
      let j = k;
      while (j + 1 < specs.length && !specs[j + 1].blank && specs[j + 1].doc === s.doc) j++;
      out.importPages(s.doc, specs.slice(k, j + 1).map((x) => x.index));
      k = j + 1;
    }
    specs.forEach((s, i) => {
      if (s.blank) return;
      if (s.crop) out.cropToView(i, s.doc, s.index, s.crop);
      if (s.rot) out.setRotation(i, s.doc.rotation(s.index) + s.rot);
    });
    return out.save();
  } finally {
    out.destroy();
  }
}

const baseName = (n) => (n || 'document').replace(/\.pdf$/i, '');

// =====================================================================
// ORGANIZE
// =====================================================================
const org = { docs: [], pages: [], history: [], future: [], sel: new Set(), last: null, name: '' };

async function organizeOpen(file) {
  ui.busy(true, 'Opening PDF…');
  try {
    const doc = await openPdf(file);
    if (!doc) return;
    org.docs.forEach((d) => d.destroy());
    Object.assign(org, { docs: [doc], pages: [], history: [], future: [], sel: new Set(), last: null, name: baseName(file.name) });
    for (let i = 0; i < doc.pageCount; i++) org.pages.push({ key: ++keySeq, doc, index: i, rot: 0, crop: null, thumb: null });
    $('#orgName').textContent = file.name;
    ui.showView('organize');
    orgRender();
  } catch (e) { ui.toast(e.message, true); } finally { ui.busy(false); }
}

function orgSnapshot() {
  org.history.push(org.pages.map((p) => ({ ...p })));
  if (org.history.length > 60) org.history.shift();
  org.future = [];
}
function orgUndo() {
  if (!org.history.length) return;
  org.future.push(org.pages.map((p) => ({ ...p })));
  org.pages = org.history.pop();
  org.sel.clear();
  orgRender();
}
function orgRedo() {
  if (!org.future.length) return;
  org.history.push(org.pages.map((p) => ({ ...p })));
  org.pages = org.future.pop();
  org.sel.clear();
  orgRender();
}

function orgRender() {
  const grid = $('#orgGrid');
  grid.innerHTML = '';
  org.pages.forEach((p, pos) => {
    const card = document.createElement('div');
    card.className = 'porg-card' + (org.sel.has(p.key) ? ' is-sel' : '');
    card.draggable = true;
    card.dataset.key = p.key;
    if (!p.thumb) p.thumb = p.blank ? null : thumbCanvas(p.doc, p.index, 150);
    const holder = document.createElement('div');
    holder.className = 'porg-thumb';
    if (p.blank) holder.innerHTML = '<div class="porg-blank">Blank page</div>';
    else {
      const c = p.thumb.cloneNode(false);
      c.getContext('2d').drawImage(p.thumb, 0, 0);
      c.style.transform = `rotate(${p.rot * 90}deg)`;
      holder.appendChild(c);
      if (p.crop) holder.insertAdjacentHTML('beforeend', '<span class="porg-flag">Cropped</span>');
    }
    card.appendChild(holder);
    card.insertAdjacentHTML('beforeend', `
      <div class="porg-bar">
        <span class="porg-num">${pos + 1}${org.docs.length > 1 ? `<small>${p.blank ? '' : 'File ' + (org.docs.indexOf(p.doc) + 1) + ' · p' + (p.index + 1)}</small>` : ''}</span>
        <span class="porg-acts">
          <button type="button" data-act="left" title="Move left" aria-label="Move page ${pos + 1} left">‹</button>
          <button type="button" data-act="rotl" title="Rotate left" aria-label="Rotate page ${pos + 1} left">↺</button>
          <button type="button" data-act="rotr" title="Rotate right" aria-label="Rotate page ${pos + 1} right">↻</button>
          <button type="button" data-act="del" title="Delete" aria-label="Delete page ${pos + 1}">✕</button>
          <button type="button" data-act="right" title="Move right" aria-label="Move page ${pos + 1} right">›</button>
        </span>
      </div>`);
    grid.appendChild(card);
  });
  $('#orgCount').textContent = `${org.pages.length} page${org.pages.length === 1 ? '' : 's'}` + (org.sel.size ? ` · ${org.sel.size} selected` : '');
  $('#orgUndo').disabled = !org.history.length;
  $('#orgRedo').disabled = !org.future.length;
  const none = !org.sel.size;
  ['#orgRotL', '#orgRotR', '#orgDel', '#orgExtract', '#orgCrop'].forEach((id) => { $(id).disabled = none; });
  $('#orgDownload').disabled = !org.pages.length;
}

function orgTargets() { return org.sel.size ? org.pages.filter((p) => org.sel.has(p.key)) : []; }

function orgRotate(pages, d) {
  if (!pages.length) return;
  orgSnapshot();
  pages.forEach((p) => { p.rot = (((p.rot + d) % 4) + 4) % 4; });
  orgRender();
}
function orgDelete(pages) {
  if (!pages.length) return;
  if (pages.length === org.pages.length) { ui.toast('A PDF needs at least one page.', true); return; }
  orgSnapshot();
  const del = new Set(pages.map((p) => p.key));
  org.pages = org.pages.filter((p) => !del.has(p.key));
  del.forEach((k) => org.sel.delete(k));
  orgRender();
}
function orgMove(key, to) {
  const from = org.pages.findIndex((p) => p.key === key);
  if (from < 0 || to < 0 || to >= org.pages.length || from === to) return;
  orgSnapshot();
  const [p] = org.pages.splice(from, 1);
  org.pages.splice(to, 0, p);
  orgRender();
}

async function orgAddFile(file) {
  ui.busy(true, 'Adding pages…');
  try {
    const doc = await openPdf(file);
    if (!doc) return;
    org.docs.push(doc);
    orgSnapshot();
    const at = org.sel.size ? Math.max(...org.pages.map((p, i) => (org.sel.has(p.key) ? i : -1))) + 1 : org.pages.length;
    const added = [];
    for (let i = 0; i < doc.pageCount; i++) added.push({ key: ++keySeq, doc, index: i, rot: 0, crop: null, thumb: null });
    org.pages.splice(at, 0, ...added);
    orgRender();
    ui.toast(`Added ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'} from ${file.name}.`);
  } catch (e) { ui.toast(e.message, true); } finally { ui.busy(false); }
}

function orgAddBlank() {
  orgSnapshot();
  const ref = org.pages.find((p) => !p.blank);
  const size = ref ? ref.doc.size(ref.index) : { w: 595, h: 842 };
  const at = org.sel.size ? Math.max(...org.pages.map((p, i) => (org.sel.has(p.key) ? i : -1))) + 1 : org.pages.length;
  org.pages.splice(at, 0, { key: ++keySeq, blank: { w: size.w, h: size.h }, rot: 0, crop: null });
  orgRender();
}

async function orgExport(onlySelected) {
  const pages = onlySelected ? orgTargets() : org.pages;
  if (!pages.length) return;
  ui.busy(true, 'Building PDF…');
  try {
    const bytes = await buildPdf(pages.map((p) => (p.blank ? { blank: p.blank } : { doc: p.doc, index: p.index, rot: p.rot, crop: p.crop })));
    downloadBytes(bytes, `${org.name}-${onlySelected ? 'extracted' : 'organized'}.pdf`);
    ui.toast(onlySelected ? `Downloaded ${pages.length} selected page${pages.length === 1 ? '' : 's'}.` : 'Your organized PDF is downloading.');
  } catch (e) { ui.toast('Could not build the PDF: ' + e.message, true); } finally { ui.busy(false); }
}

// ---- crop dialog --------------------------------------------------------
const crop = { pages: [], rect: null, view: null };
function orgCropOpen() {
  const pages = orgTargets().filter((p) => !p.blank);
  if (!pages.length) { ui.toast('Select the pages to crop first.', true); return; }
  const p0 = pages[0];
  const { w, h } = p0.doc.size(p0.index);
  const maxW = Math.min(520, window.innerWidth - 80), k = Math.min(maxW / w, 560 / h);
  const img = p0.doc.render(p0.index, k * Math.min(2, window.devicePixelRatio || 1));
  const c = $('#cropCanvas');
  c.width = img.width; c.height = img.height;
  c.style.width = Math.round(w * k) + 'px'; c.style.height = Math.round(h * k) + 'px';
  c.getContext('2d').putImageData(img, 0, 0);
  const start = p0.crop || { x: w * 0.05, y: h * 0.05, w: w * 0.9, h: h * 0.9 };
  Object.assign(crop, { pages, view: { w, h, k }, rect: { ...start } });
  $('#cropInfo').textContent = pages.length > 1 ? `The same crop is applied to ${pages.length} selected pages.` : 'Drag the frame or its corners.';
  cropDraw();
  $('#cropDialog').showModal();
}
function cropDraw() {
  const { k } = crop.view, r = crop.rect, box = $('#cropBox');
  Object.assign(box.style, { left: r.x * k + 'px', top: r.y * k + 'px', width: r.w * k + 'px', height: r.h * k + 'px' });
}
function bindCrop() {
  const box = $('#cropBox');
  box.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    const handle = e.target.dataset.h || 'move';
    const s = { x: e.clientX, y: e.clientY, r: { ...crop.rect } };
    const { w, h, k } = crop.view;
    const move = (ev) => {
      const dx = (ev.clientX - s.x) / k, dy = (ev.clientY - s.y) / k;
      let { x, y, w: rw, h: rh } = s.r;
      if (handle === 'move') { x = Math.min(Math.max(0, x + dx), w - rw); y = Math.min(Math.max(0, y + dy), h - rh); }
      else {
        if (handle.includes('w')) { const nx = Math.min(Math.max(0, x + dx), x + rw - 20); rw += x - nx; x = nx; }
        if (handle.includes('e')) rw = Math.min(Math.max(20, rw + dx), w - x);
        if (handle.includes('n')) { const ny = Math.min(Math.max(0, y + dy), y + rh - 20); rh += y - ny; y = ny; }
        if (handle.includes('s')) rh = Math.min(Math.max(20, rh + dy), h - y);
      }
      crop.rect = { x, y, w: rw, h: rh };
      cropDraw();
    };
    const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
  });
  $('#cropApply').addEventListener('click', () => {
    orgSnapshot();
    crop.pages.forEach((p) => {
      // scale the frame to each page's own size
      const { w, h } = p.doc.size(p.index);
      const fx = w / crop.view.w, fy = h / crop.view.h, r = crop.rect;
      p.crop = { x: r.x * fx, y: r.y * fy, w: r.w * fx, h: r.h * fy };
      p.thumb = null;
    });
    $('#cropDialog').close();
    orgRender();
    ui.toast('Crop set — it is applied when you download.');
  });
  $('#cropReset').addEventListener('click', () => {
    orgSnapshot();
    crop.pages.forEach((p) => { p.crop = null; });
    $('#cropDialog').close();
    orgRender();
  });
  $('#cropCancel').addEventListener('click', () => $('#cropDialog').close());
}

function bindOrganize() {
  const grid = $('#orgGrid');
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.porg-card');
    if (!card) return;
    const key = +card.dataset.key;
    const pos = org.pages.findIndex((p) => p.key === key);
    const act = e.target.closest('[data-act]');
    if (act) {
      const p = org.pages[pos];
      ({ rotl: () => orgRotate([p], -1), rotr: () => orgRotate([p], 1), del: () => orgDelete([p]), left: () => orgMove(key, pos - 1), right: () => orgMove(key, pos + 1) })[act.dataset.act]();
      return;
    }
    if (e.shiftKey && org.last !== null) {
      const a = org.pages.findIndex((p) => p.key === org.last);
      const [lo, hi] = [Math.min(a, pos), Math.max(a, pos)];
      for (let i = lo; i <= hi; i++) org.sel.add(org.pages[i].key);
    } else if (org.sel.has(key)) org.sel.delete(key); else org.sel.add(key);
    org.last = key;
    orgRender();
  });
  // drag & drop reorder
  let dragKey = null;
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.porg-card');
    if (!card) return;
    dragKey = +card.dataset.key;
    card.classList.add('is-drag');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragKey));
  });
  grid.addEventListener('dragend', () => { dragKey = null; $$('.porg-card', grid).forEach((c) => c.classList.remove('is-drag', 'drop-before', 'drop-after')); });
  grid.addEventListener('dragover', (e) => {
    if (dragKey === null) return;
    e.preventDefault();
    const card = e.target.closest('.porg-card');
    $$('.porg-card', grid).forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
  });
  grid.addEventListener('drop', (e) => {
    if (dragKey === null) return;
    e.preventDefault();
    e.stopPropagation();
    const card = e.target.closest('.porg-card');
    if (!card) return;
    const targetKey = +card.dataset.key;
    const after = card.classList.contains('drop-after');
    const from = org.pages.findIndex((p) => p.key === dragKey);
    let to = org.pages.findIndex((p) => p.key === targetKey) + (after ? 1 : 0);
    if (from < to) to--;
    orgMove(dragKey, to);
  });

  $('#orgRotL').addEventListener('click', () => orgRotate(orgTargets(), -1));
  $('#orgRotR').addEventListener('click', () => orgRotate(orgTargets(), 1));
  $('#orgDel').addEventListener('click', () => orgDelete(orgTargets()));
  $('#orgExtract').addEventListener('click', () => orgExport(true));
  $('#orgCrop').addEventListener('click', orgCropOpen);
  $('#orgUndo').addEventListener('click', orgUndo);
  $('#orgRedo').addEventListener('click', orgRedo);
  $('#orgAll').addEventListener('click', () => {
    if (org.sel.size === org.pages.length) org.sel.clear(); else org.pages.forEach((p) => org.sel.add(p.key));
    orgRender();
  });
  $('#orgBlank').addEventListener('click', orgAddBlank);
  $('#orgAddPdf').addEventListener('click', () => $('#orgAddInput').click());
  $('#orgAddInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) orgAddFile(f); });
  $('#orgDownload').addEventListener('click', () => orgExport(false));
  $('#orgEdit').addEventListener('click', async () => {
    ui.busy(true, 'Preparing editor…');
    try {
      const bytes = await buildPdf(org.pages.map((p) => (p.blank ? { blank: p.blank } : { doc: p.doc, index: p.index, rot: p.rot, crop: p.crop })));
      ui.busy(false);
      ui.openInEditor(new File([bytes], org.name + '.pdf', { type: 'application/pdf' }));
    } catch (e) { ui.busy(false); ui.toast(e.message, true); }
  });
  document.addEventListener('keydown', (e) => {
    if ($('#organize').hidden || e.target.closest('input, textarea, dialog')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? orgRedo() : orgUndo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); orgRedo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); org.pages.forEach((p) => org.sel.add(p.key)); orgRender(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (org.sel.size) { e.preventDefault(); orgDelete(orgTargets()); } }
    else if (e.key === 'Escape') { org.sel.clear(); orgRender(); }
  });
  bindCrop();
}

// =====================================================================
// MERGE
// =====================================================================
const mrg = { files: [] };   // { key, doc, name, range }

async function mergeAdd(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  ui.busy(true, 'Opening PDFs…');
  try {
    for (const f of files) {
      try {
        const doc = await openPdf(f);
        if (doc) mrg.files.push({ key: ++keySeq, doc, name: f.name, range: '', thumb: thumbCanvas(doc, 0, 90) });
      } catch (e) { ui.toast(e.message, true); }
    }
    ui.showView('merge');
    mergeRender();
  } finally { ui.busy(false); }
}

function mergeRender() {
  const list = $('#mrgList');
  list.innerHTML = '';
  mrg.files.forEach((f, pos) => {
    const row = document.createElement('div');
    row.className = 'pmrg-row';
    row.dataset.key = f.key;
    row.draggable = true;
    const thumb = document.createElement('div');
    thumb.className = 'pmrg-thumb';
    const c = f.thumb.cloneNode(false); c.getContext('2d').drawImage(f.thumb, 0, 0);
    thumb.appendChild(c);
    row.appendChild(thumb);
    row.insertAdjacentHTML('beforeend', `
      <div class="pmrg-info">
        <b>${pos + 1}. <span></span></b>
        <small>${f.doc.pageCount} page${f.doc.pageCount === 1 ? '' : 's'}</small>
        <label>Pages <input type="text" class="pinput" data-range placeholder="All (e.g. 1-3, 5)" value=""></label>
      </div>
      <div class="pmrg-acts">
        <button type="button" data-act="up" title="Move up" aria-label="Move up" ${pos === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-act="down" title="Move down" aria-label="Move down" ${pos === mrg.files.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" data-act="del" title="Remove" aria-label="Remove">✕</button>
      </div>`);
    $('b span', row).textContent = f.name;
    $('[data-range]', row).value = f.range;
    list.appendChild(row);
  });
  const total = mrg.files.reduce((n, f) => n + f.doc.pageCount, 0);
  $('#mrgSummary').textContent = mrg.files.length ? `${mrg.files.length} PDF${mrg.files.length === 1 ? '' : 's'} · ${total} pages in total` : 'Add at least two PDFs.';
  $('#mrgGo').disabled = mrg.files.length < 2;
}

async function mergeGo() {
  const specs = [];
  try {
    for (const f of mrg.files) {
      const idx = f.range.trim() ? parseRanges(f.range, f.doc.pageCount).flat() : [...Array(f.doc.pageCount).keys()];
      idx.forEach((i) => specs.push({ doc: f.doc, index: i }));
    }
  } catch (e) { ui.toast(e.message, true); return; }
  ui.busy(true, 'Merging…');
  try {
    const bytes = await buildPdf(specs);
    downloadBytes(bytes, 'merged.pdf');
    ui.toast(`Merged ${specs.length} pages into one PDF.`);
  } catch (e) { ui.toast('Could not merge: ' + e.message, true); } finally { ui.busy(false); }
}

function bindMerge() {
  const list = $('#mrgList');
  list.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const key = +act.closest('.pmrg-row').dataset.key;
    const i = mrg.files.findIndex((f) => f.key === key);
    if (act.dataset.act === 'del') { mrg.files[i].doc.destroy(); mrg.files.splice(i, 1); }
    else {
      const j = act.dataset.act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= mrg.files.length) return;
      [mrg.files[i], mrg.files[j]] = [mrg.files[j], mrg.files[i]];
    }
    mergeRender();
  });
  list.addEventListener('input', (e) => {
    if (!e.target.matches('[data-range]')) return;
    const key = +e.target.closest('.pmrg-row').dataset.key;
    mrg.files.find((f) => f.key === key).range = e.target.value;
  });
  let dragKey = null;
  list.addEventListener('dragstart', (e) => { const r = e.target.closest('.pmrg-row'); if (r) { dragKey = +r.dataset.key; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragKey)); } });
  list.addEventListener('dragover', (e) => { if (dragKey !== null) e.preventDefault(); });
  list.addEventListener('drop', (e) => {
    if (dragKey === null) return;
    e.preventDefault(); e.stopPropagation();
    const r = e.target.closest('.pmrg-row');
    if (r) {
      const from = mrg.files.findIndex((f) => f.key === dragKey);
      const to = mrg.files.findIndex((f) => f.key === +r.dataset.key);
      const [m] = mrg.files.splice(from, 1);
      mrg.files.splice(to, 0, m);
      mergeRender();
    }
    dragKey = null;
  });
  $('#mrgAdd').addEventListener('click', () => $('#mrgInput').click());
  $('#mrgInput').addEventListener('change', (e) => { const fl = e.target.files; mergeAdd(fl).then(() => { e.target.value = ''; }); });
  $('#mrgGo').addEventListener('click', mergeGo);
  $('#mrgClear').addEventListener('click', () => { mrg.files.forEach((f) => f.doc.destroy()); mrg.files = []; mergeRender(); });
}

// =====================================================================
// SPLIT
// =====================================================================
const spl = { doc: null, name: '', mode: 'each', picked: new Set() };

async function splitOpen(file) {
  ui.busy(true, 'Opening PDF…');
  try {
    const doc = await openPdf(file);
    if (!doc) return;
    if (spl.doc) spl.doc.destroy();
    Object.assign(spl, { doc, name: baseName(file.name), picked: new Set() });
    $('#splName').textContent = `${file.name} · ${doc.pageCount} pages`;
    const grid = $('#splGrid');
    grid.innerHTML = '';
    for (let i = 0; i < doc.pageCount; i++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pspl-page'; b.dataset.i = i;
      b.appendChild(thumbCanvas(doc, i, 110));
      b.insertAdjacentHTML('beforeend', `<span>${i + 1}</span>`);
      grid.appendChild(b);
    }
    ui.showView('split');
    splitSync();
  } catch (e) { ui.toast(e.message, true); } finally { ui.busy(false); }
}

function splitPlan() {
  const n = spl.doc.pageCount;
  const all = [...Array(n).keys()];
  if (spl.mode === 'each') return all.map((i) => [i]);
  if (spl.mode === 'every') {
    const k = Math.max(1, parseInt($('#splEvery').value, 10) || 1);
    const out = [];
    for (let i = 0; i < n; i += k) out.push(all.slice(i, i + k));
    return out;
  }
  if (spl.mode === 'ranges') return parseRanges($('#splRanges').value, n);
  const picked = [...spl.picked].sort((a, b) => a - b);
  if (!picked.length) throw new Error('Click the pages you want to extract');
  return [picked];
}

function splitSync() {
  $$('#split [data-mode]').forEach((b) => { const on = b.dataset.mode === spl.mode; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
  $('#splEveryRow').hidden = spl.mode !== 'every';
  $('#splRangesRow').hidden = spl.mode !== 'ranges';
  $('#splGrid').classList.toggle('is-picking', spl.mode === 'pick');
  $$('.pspl-page', $('#splGrid')).forEach((b) => b.classList.toggle('is-on', spl.mode === 'pick' && spl.picked.has(+b.dataset.i)));
  let msg = '';
  try {
    const plan = splitPlan();
    msg = plan.length === 1 ? `Result: 1 PDF with ${plan[0].length} page${plan[0].length === 1 ? '' : 's'}` : `Result: ${plan.length} PDFs (downloaded together as a ZIP)`;
    $('#splGo').disabled = false;
  } catch (e) { msg = e.message; $('#splGo').disabled = true; }
  $('#splSummary').textContent = msg;
}

async function splitGo() {
  let plan;
  try { plan = splitPlan(); } catch (e) { ui.toast(e.message, true); return; }
  ui.busy(true, `Splitting into ${plan.length} file${plan.length === 1 ? '' : 's'}…`);
  try {
    const files = [];
    for (const group of plan) {
      const bytes = await buildPdf(group.map((i) => ({ doc: spl.doc, index: i })));
      const label = group.length === 1 ? `page-${group[0] + 1}` : `pages-${group[0] + 1}-${group[group.length - 1] + 1}`;
      files.push({ name: `${spl.name}-${label}.pdf`, bytes });
    }
    await downloadMany(files, `${spl.name}-split.zip`);
    ui.toast(files.length === 1 ? 'Your PDF is downloading.' : `${files.length} PDFs downloaded as a ZIP.`);
  } catch (e) { ui.toast('Could not split: ' + e.message, true); } finally { ui.busy(false); }
}

function bindSplit() {
  $$('#split [data-mode]').forEach((b) => b.addEventListener('click', () => { spl.mode = b.dataset.mode; splitSync(); }));
  $('#splEvery').addEventListener('input', splitSync);
  $('#splRanges').addEventListener('input', splitSync);
  $('#splGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.pspl-page');
    if (!b) return;
    if (spl.mode !== 'pick') { spl.mode = 'pick'; }
    const i = +b.dataset.i;
    if (spl.picked.has(i)) spl.picked.delete(i); else spl.picked.add(i);
    splitSync();
  });
  $('#splGo').addEventListener('click', splitGo);
}

// =====================================================================
// entry points
// =====================================================================
export function initPageTools(helpers) {
  ui = helpers;
  bindOrganize();
  bindMerge();
  bindSplit();
}
export const pageTools = {
  organize: (file) => organizeOpen(file),
  merge: (files) => mergeAdd(files),
  split: (file) => splitOpen(file),
  organizeAdd: (file) => orgAddFile(file)
};
// test hook
window.__pdfPages = { org, mrg, spl, parseRanges };
