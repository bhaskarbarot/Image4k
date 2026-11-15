/* Image4k PDF editor — UI. Uses engine.js (PDFium) for every real PDF change. */
import { PdfDoc } from './engine.js?v=pdf17';
import { initPageTools, pageTools } from './pages.js?v=pdf17';
import { initSecureTools, secureTools } from './secure.js?v=pdf17';
import { initConvertTools, convertTools } from './convert.js?v=pdf17';
import { initOptimizeTools, optimizeTools } from './optimize.js?v=pdf17';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const MAX_BYTES = 200 * 1024 * 1024;
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const FAMILY_CSS = { Sans: "'LibSans', Arial, sans-serif", Serif: "'LibSerif', 'Times New Roman', serif", Mono: "'LibMono', 'Courier New', monospace", Calibri: "'Carlito', Calibri, sans-serif" };

const state = {
  doc: null, name: '', password: '', zoom: 1, tool: 'edit',
  pages: [],            // { el, canvas, overlay, thumb, rendered, items }
  current: 0,
  sel: null,            // { page, item }
  editing: null,        // inline edit session
  undo: [], redo: [], dirty: false, busy: false,
  ink: '#111111', signMode: 'draw', pendingSign: false,
  eraseSize: 20, picking: null
};

// =====================================================================
// small UI helpers
// =====================================================================
let toastTimer = 0;
function toast(msg, err) {
  const t = $('#ptoast');
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 5000 : 2600);
}
function busy(on, text) {
  state.busy = on;
  $('#busy').hidden = !on;
  if (text) $('#busyText').textContent = text;
}
/** Show one screen: landing, editor or a tool view (any <section class="pview">). */
function showView(name) {
  const views = ['landing', 'editor', ...$$('.pview').map((v) => v.id)];
  for (const id of views) { const el = document.getElementById(id); if (el) el.hidden = id !== name; }
  const editing = name === 'editor';
  $('#docBar').hidden = !editing;
  $('#docActions').hidden = !editing;
  document.body.classList.toggle('is-editing', editing);
  state.view = name;
  window.scrollTo(0, 0);
}
function currentView() { return state.view || 'landing'; }

function setDirty(d) {
  state.dirty = d;
  $('#docState').textContent = d ? 'Edited — not downloaded yet' : 'No changes';
  $('[data-action="undo"]').disabled = !state.undo.length;
  $('[data-action="redo"]').disabled = !state.redo.length;
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const hex = (c) => '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

// =====================================================================
// open / close
// =====================================================================
async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Please choose a PDF file.', true); return; }
  if (file.size > MAX_BYTES) { toast('This PDF is larger than 200 MB.', true); return; }
  if (state.dirty && !confirm('Open a new PDF? Your changes to the current one have not been downloaded.')) return;
  busy(true, 'Opening PDF…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let doc = null, password = '';
    for (;;) {
      try { doc = await PdfDoc.open(bytes, password); break; }
      catch (e) {
        if (e.code !== 4) throw e;
        busy(false);
        password = await askPassword(!!password, file.name);
        if (password === null) return;
        busy(true, 'Opening PDF…');
      }
    }
    if (state.doc) state.doc.destroy();
    Object.assign(state, { doc, password, name: file.name.replace(/\.pdf$/i, ''), sel: null, editing: null, undo: [], redo: [], current: 0 });
    $('#docName').textContent = file.name;
    showView('editor');
    setDirty(false);
    buildPages();
    fitWidth();
    // guide users opening a scanned / photo PDF (no text layer to click-edit)
    try { if (!state.doc.pageText(0).trim()) toast('Scanned / photo PDF — the text is a picture, so use Add text, Erase or Match & type to change it.'); } catch (e) { /* ignore */ }
    if (state.pendingSign) { state.pendingSign = false; openSign(); }
  } catch (e) {
    console.error(e);
    toast(e.message || 'Could not open this PDF.', true);
  } finally {
    busy(false);
  }
}

function askPassword(retry, fileName) {
  const dlg = $('#pwDialog');
  $('#pwErr').hidden = !retry;
  $('#pwFile').textContent = fileName || '';
  $('#pwFile').hidden = !fileName;
  $('#pwInput').value = '';
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); cleanup(); resolve(v); };
    const ok = () => done($('#pwInput').value);
    const cancel = () => done(null);
    const key = (e) => { if (e.key === 'Enter') ok(); };
    function cleanup() { $('#pwOk').removeEventListener('click', ok); $('#pwCancel').removeEventListener('click', cancel); $('#pwInput').removeEventListener('keydown', key); dlg.removeEventListener('cancel', cancel); }
    $('#pwOk').addEventListener('click', ok);
    $('#pwCancel').addEventListener('click', cancel);
    $('#pwInput').addEventListener('keydown', key);
    dlg.addEventListener('cancel', cancel);
    dlg.showModal();
    $('#pwInput').focus();
  });
}

// =====================================================================
// pages, rendering, overlay
// =====================================================================
let pageObserver = null, thumbObserver = null;

function buildPages() {
  const viewer = $('#viewer'), thumbs = $('#thumbs');
  viewer.innerHTML = '';
  thumbs.innerHTML = '';
  if (pageObserver) pageObserver.disconnect();
  if (thumbObserver) thumbObserver.disconnect();
  state.pages = [];
  const ratios = new Map();
  pageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = +e.target.dataset.page;
      ratios.set(i, e.intersectionRatio);
      if (e.isIntersecting && !state.pages[i].rendered) renderPage(i);
    }
    let best = state.current, max = -1;
    ratios.forEach((r, i) => { if (r > max) { max = r; best = i; } });
    if (best !== state.current) { state.current = best; updatePageInd(); }
  }, { root: viewer, rootMargin: '300px 0px', threshold: [0, 0.25, 0.5, 0.75, 1] });
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderThumb(+e.target.dataset.page);
  }, { root: thumbs, rootMargin: '200px 0px' });

  for (let i = 0; i < state.doc.pageCount; i++) {
    const el = document.createElement('div');
    el.className = 'ppage';
    el.dataset.page = i;
    el.innerHTML = `<span class="ppage-label">Page ${i + 1}</span><canvas></canvas><div class="poverlay"></div>`;
    viewer.appendChild(el);
    const t = document.createElement('button');
    t.className = 'pthumb';
    t.type = 'button';
    t.dataset.page = i;
    t.innerHTML = `<canvas></canvas>${i + 1}`;
    t.addEventListener('click', () => scrollToPage(i));
    thumbs.appendChild(t);
    state.pages.push({ el, canvas: $('canvas', el), overlay: $('.poverlay', el), thumb: t, rendered: false, thumbDone: false, items: [] });
    pageObserver.observe(el);
    thumbObserver.observe(t);
  }
  sizePages();
  updatePageInd();
}

function sizePages() {
  state.pages.forEach((p, i) => {
    const { w, h } = state.doc.size(i);
    p.el.style.width = Math.round(w * state.zoom) + 'px';
    p.el.style.height = Math.round(h * state.zoom) + 'px';
  });
  $('#zoomVal').textContent = Math.round(state.zoom * 100) + '%';
}

function renderCanvas(i) {
  const p = state.pages[i];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const img = state.doc.render(i, state.zoom * dpr);
  p.canvas.width = img.width;
  p.canvas.height = img.height;
  p.canvas.getContext('2d').putImageData(img, 0, 0);
}

function renderPage(i) {
  const p = state.pages[i];
  if (!p || !state.doc) return;
  try {
    renderCanvas(i);
    p.items = state.doc.objects(i);
    buildOverlay(i);
    p.rendered = true;
  } catch (e) {
    console.error(e);
    toast('Could not show page ' + (i + 1) + ': ' + e.message, true);
  }
}

function renderThumb(i, force) {
  const p = state.pages[i];
  if (!p || (p.thumbDone && !force)) return;
  try {
    const { w } = state.doc.size(i);
    const img = state.doc.render(i, 220 / w);
    const c = $('canvas', p.thumb);
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    p.thumbDone = true;
  } catch (e) { console.warn(e); }
}

function buildOverlay(i) {
  const p = state.pages[i], z = state.zoom;
  p.overlay.innerHTML = '';
  p.overlay.className = 'poverlay' + ({ text: ' tool-text', erase: ' tool-erase', match: ' tool-match', highlight: ' tool-highlight' }[state.tool] || '');
  const pg = state.doc.size(i);
  p.items.forEach((item, k) => {
    // A full-page image is the scanned background: keep it non-interactive so clicks land on text & annotations on top of it.
    const isBg = item.kind === 'image' && item.box.w >= pg.w * 0.9 && item.box.h >= pg.h * 0.9;
    const d = document.createElement('div');
    d.className = 'pobj' + (item.kind === 'image' ? ' is-image' : '') + (item.broken ? ' is-broken' : '') + (isBg ? ' is-bg' : '');
    d.dataset.k = k;
    if (isBg) { d.style.pointerEvents = 'none'; p.overlay.appendChild(d); return; }
    const pad = item.kind === 'text' ? 1.5 : 0;
    Object.assign(d.style, { left: (item.box.x - pad) * z + 'px', top: (item.box.y - pad) * z + 'px', width: (item.box.w + 2 * pad) * z + 'px', height: (item.box.h + 2 * pad) * z + 'px' });
    d.title = item.kind === 'text' ? (item.broken ? 'This text uses a font that cannot be read, so it cannot be edited' : 'Click to edit · drag to move') : 'Drag to move · corner to resize';
    if (state.sel && state.sel.page === i && state.sel.k === k) {
      d.classList.add('is-sel');
      if (!item.broken) d.insertAdjacentHTML('beforeend', '<span class="phandle"></span>');   // text & images both resize
    }
    p.overlay.appendChild(d);
  });
}

function rerender(i) {
  renderPage(i);
  renderThumb(i, true);
}
function rerenderAll() {
  state.pages.forEach((p) => { p.rendered = false; p.thumbDone = false; });
  sizePages();
  // render what is on screen now, the observers handle the rest
  const v = $('#viewer').getBoundingClientRect();
  state.pages.forEach((p, i) => {
    const r = p.el.getBoundingClientRect();
    if (r.bottom > v.top - 300 && r.top < v.bottom + 300) renderPage(i);
  });
  state.pages.forEach((p, i) => { const r = p.thumb.getBoundingClientRect(); if (r.height && r.bottom > 0 && r.top < innerHeight) renderThumb(i, true); });
}

function updatePageInd() {
  $('#pageInd').textContent = `Page ${state.current + 1} / ${state.pages.length}`;
  state.pages.forEach((p, i) => p.thumb.classList.toggle('is-on', i === state.current));
}
function scrollToPage(i) {
  state.pages[i].el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  state.current = i;
  updatePageInd();
}

// =====================================================================
// zoom
// =====================================================================
function setZoom(z, keepCenter = true) {
  const viewer = $('#viewer');
  const ratio = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  state.zoom = Math.min(4, Math.max(0.25, z));
  finishEdit(false);
  rerenderAll();
  if (keepCenter) viewer.scrollTop = ratio * viewer.scrollHeight;
}
function fitWidth() {
  const viewer = $('#viewer');
  const avail = viewer.clientWidth - 48;
  let maxW = 0;
  for (let i = 0; i < state.doc.pageCount; i++) maxW = Math.max(maxW, state.doc.size(i).w);
  setZoom(Math.min(2, Math.max(0.4, avail / maxW)), false);
}
function stepZoom(dir) {
  const z = state.zoom;
  const next = dir > 0 ? ZOOMS.find((v) => v > z + 0.01) : [...ZOOMS].reverse().find((v) => v < z - 0.01);
  if (next) setZoom(next);
}

// =====================================================================
// changes + undo/redo
// =====================================================================
async function mutate(pageIndex, fn, label) {
  if (!state.doc) return;
  const snap = state.doc.save();
  try {
    const r = await fn();
    state.undo.push(snap);
    if (state.undo.length > 40) state.undo.shift();
    state.redo = [];
    setDirty(true);
    if (pageIndex !== null && pageIndex !== undefined) rerender(pageIndex);
    return r;
  } catch (e) {
    console.error(e);
    toast((label ? label + ': ' : '') + (e.message || 'something went wrong'), true);
    // restore the document exactly as it was
    state.doc.load(snap, state.password);
    rerenderAll();
    return null;
  }
}

function reloadFrom(bytes) {
  finishEdit(false);
  state.doc.load(bytes, state.password);
  select(null);
  rerenderAll();
}
function undo() {
  if (!state.undo.length || state.editing) return;
  state.redo.push(state.doc.save());
  reloadFrom(state.undo.pop());
  setDirty(true);
}
function redo() {
  if (!state.redo.length || state.editing) return;
  state.undo.push(state.doc.save());
  reloadFrom(state.redo.pop());
  setDirty(true);
}

// =====================================================================
// selection + side panel
// =====================================================================
function select(sel) {
  const prev = state.sel;
  state.sel = sel;
  if (prev && state.pages[prev.page]) buildOverlay(prev.page);
  if (sel && (!prev || prev.page !== sel.page)) buildOverlay(sel.page);
  const item = sel ? state.pages[sel.page].items[sel.k] : null;
  $('#sideEmpty').hidden = !!item;
  $('#sideText').hidden = !item || item.kind !== 'text';
  $('#sideImage').hidden = !item || item.kind !== 'image';
  $('#deleteSel').hidden = !item;
  $('[data-action="delete"]').disabled = !item;
  $('#side').classList.toggle('is-open', !!item);
  if (item && item.kind === 'text') {
    $('#propText').value = item.text;
    $('#propFontName').textContent = item.font.clean || 'Unknown font';
    $('#propFamily').value = '';
    $('#propSize').value = Math.round(item.size * 10) / 10;
    $('#propBold').checked = item.font.bold;
    $('#propItalic').checked = item.font.italic;
    $('#propColor').value = hex(item.color);
    $('#fontNote').textContent = item.font.subset
      ? 'This PDF only stores the letters it uses. If you type a new letter, that line switches to the closest matching font.'
      : '';
  }
}
const selItem = () => (state.sel ? state.pages[state.sel.page].items[state.sel.k] : null);

async function deleteSelected() {
  const item = selItem();
  if (!item) return;
  const i = state.sel.page;
  select(null);
  await mutate(i, () => state.doc.remove(i, item.objs), 'Delete');
}

async function applyPanel() {
  const item = selItem();
  if (!item || item.kind !== 'text') return;
  const i = state.sel.page;
  const text = $('#propText').value.replace(/\r?\n/g, ' ');
  const opts = {};
  if ($('#propFamily').value) opts.family = $('#propFamily').value;
  const size = parseFloat($('#propSize').value);
  if (size > 0 && Math.abs(size - item.size) > 0.05) opts.size = size;
  if ($('#propBold').checked !== item.font.bold) opts.bold = $('#propBold').checked;
  if ($('#propItalic').checked !== item.font.italic) opts.italic = $('#propItalic').checked;
  if ($('#propColor').value.toLowerCase() !== hex(item.color)) opts.color = fromHex($('#propColor').value);
  if (!text.trim()) { await deleteSelected(); return; }
  if (text === item.text && !Object.keys(opts).length) { toast('Nothing changed.'); return; }
  select(null);
  const r = await mutate(i, () => state.doc.editText(i, item, text, opts), 'Edit text');
  if (r && r.usedFallback && !Object.keys(opts).length) toast('Some new letters were not in this PDF’s font — that line now uses the closest matching font.');
}

// ---- live (real-time) editing ---------------------------------------
// Panel changes apply to the PDF immediately — bold/italic/colour/size/content
// show on the page as you change them, no "Apply" needed.
let _liveT = null, _liveBusy = false, _liveAgain = false;
function queueLive(d = 280) { clearTimeout(_liveT); _liveT = setTimeout(applyLive, d); }

/** Re-select the same text after a live edit WITHOUT touching panel inputs or focus. */
function requiet(i, k, prevBox) {
  const items = state.pages[i].items;
  let nk = (items[k] && items[k].kind === 'text') ? k : -1;
  if (nk < 0) {
    let best = Infinity;
    for (let j = 0; j < items.length; j++) {
      const it = items[j]; if (it.kind !== 'text') continue;
      const d = (it.box.x - prevBox.x) ** 2 + (it.box.y - prevBox.y) ** 2;
      if (d < best) { best = d; nk = j; }
    }
  }
  if (nk >= 0) { state.sel = { page: i, k: nk }; buildOverlay(i); }
}

async function applyLive() {
  const sel = state.sel, item = selItem();
  if (!sel || !item || item.kind !== 'text') return;
  if (_liveBusy) { _liveAgain = true; return; }
  const i = sel.page, prevBox = { ...item.box };
  const text = $('#propText').value.replace(/\r?\n/g, ' ');
  const opts = {};
  if ($('#propFamily').value) opts.family = $('#propFamily').value;
  const size = parseFloat($('#propSize').value);
  if (size > 0 && Math.abs(size - item.size) > 0.05) opts.size = size;
  if ($('#propBold').checked !== item.font.bold) opts.bold = $('#propBold').checked;
  if ($('#propItalic').checked !== item.font.italic) opts.italic = $('#propItalic').checked;
  if ($('#propColor').value.toLowerCase() !== hex(item.color)) opts.color = fromHex($('#propColor').value);
  if (!text.trim()) return;                                   // never delete while the box is being typed in
  if (text === item.text && !Object.keys(opts).length) return;
  _liveBusy = true;
  await mutate(i, () => state.doc.editText(i, item, text, opts), 'Edit text');
  requiet(i, sel.k, prevBox);
  _liveBusy = false;
  if (_liveAgain) { _liveAgain = false; applyLive(); }
}

/** Open the style panel for a brand-new (not yet committed) text box. */
function openNewTextPanel(size, color) {
  $('#sideEmpty').hidden = true; $('#sideImage').hidden = true; $('#sideText').hidden = false;
  $('#deleteSel').hidden = false; $('#side').classList.add('is-open');
  $('#propText').value = '';
  $('#propFontName').textContent = 'New text';
  $('#propFamily').value = ''; $('#propSize').value = Math.round(size * 10) / 10;
  $('#propBold').checked = false; $('#propItalic').checked = false;
  $('#propColor').value = hex(color);
  $('#fontNote').textContent = '';
}

/** Live-style the inline (uncommitted) new-text element from the panel. */
function styleNewTextLive() {
  const ed = state.editing; if (!ed || !ed.isNew) return;
  const z = state.zoom;
  ed.size = parseFloat($('#propSize').value) || ed.size;
  ed.bold = $('#propBold').checked; ed.italic = $('#propItalic').checked;
  ed.family = $('#propFamily').value || ed.family;
  ed.color = fromHex($('#propColor').value);
  Object.assign(ed.el.style, {
    fontSize: ed.size * z + 'px', lineHeight: ed.size * 1.2 * z + 'px', minHeight: ed.size * 1.2 * z + 'px',
    fontWeight: ed.bold ? '700' : '400', fontStyle: ed.italic ? 'italic' : 'normal',
    color: rgb(ed.color), fontFamily: FAMILY_CSS[ed.family] || FAMILY_CSS.Sans,
  });
  const t = $('#propText').value; if (t && document.activeElement === $('#propText')) ed.el.textContent = t;
}

/** Route a panel change: new uncommitted text → style the inline box; existing text → live edit. */
function onStyleInput(immediate) {
  if (state.editing && state.editing.isNew) { styleNewTextLive(); return; }
  if (immediate) applyLive(); else queueLive();
}

/** "Done" button: bake in the new text, or flush a live edit, then close the panel. */
async function commitText() {
  if (state.editing && state.editing.isNew) { await finishEdit(true); return; }
  clearTimeout(_liveT); await applyLive(); select(null);
}

// =====================================================================
// inline text editing
// =====================================================================
function startEdit(i, k) {
  const item = state.pages[i].items[k];
  if (!item || item.kind !== 'text') return;
  if (item.broken) { toast('This text uses a font that cannot be read, so it cannot be edited. You can delete it and add new text.', true); return; }
  finishEdit(true);
  select({ page: i, k });
  const z = state.zoom, p = state.pages[i];
  const colors = item.runs.map((r) => r.color);
  state.doc.setHidden(item.objs, true, colors);
  renderCanvas(i);
  const ed = document.createElement('div');
  ed.className = 'pinline';
  ed.contentEditable = 'plaintext-only';
  if (ed.contentEditable !== 'plaintext-only') ed.contentEditable = 'true';
  ed.spellcheck = false;
  ed.textContent = item.text;
  Object.assign(ed.style, {
    left: item.box.x * z + 'px',
    top: item.box.y * z + 'px',
    minHeight: item.box.h * z + 'px',
    lineHeight: item.box.h * z + 'px',
    fontSize: item.size * z + 'px',
    fontFamily: FAMILY_CSS[item.font.family],
    fontWeight: item.font.bold ? 700 : 400,
    fontStyle: item.font.italic ? 'italic' : 'normal',
    color: rgb(item.color)
  });
  p.overlay.appendChild(ed);
  state.editing = { i, k, item, colors, el: ed, isNew: false };
  ed.focus();
  const range = document.createRange();
  range.selectNodeContents(ed);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  ed.addEventListener('keydown', onEditKey);
  ed.addEventListener('blur', () => setTimeout(() => {
    if (!state.editing || state.editing.el !== ed) return;
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#side')) return; // editing style in the panel — keep the box open
    finishEdit(true);
  }, 0));
}

function startNewText(i, vx, vy, opts = {}) {
  finishEdit(true);
  const z = state.zoom, p = state.pages[i];
  const size = opts.size || 14;
  const color = opts.color || [0, 0, 0, 255];
  const family = opts.family || 'Sans';
  const ed = document.createElement('div');
  ed.className = 'pinline';
  ed.contentEditable = 'plaintext-only';
  if (ed.contentEditable !== 'plaintext-only') ed.contentEditable = 'true';
  Object.assign(ed.style, { left: vx * z + 'px', top: vy * z + 'px', minHeight: size * 1.2 * z + 'px', lineHeight: size * 1.2 * z + 'px', fontSize: size * z + 'px', fontFamily: FAMILY_CSS[family] || FAMILY_CSS.Sans, color: rgb(color), minWidth: '120px' });
  ed.dataset.placeholder = 'Type here';
  p.overlay.appendChild(ed);
  state.editing = { i, el: ed, isNew: true, vx, vy, size, color, family, bold: !!opts.bold, italic: !!opts.italic };
  openNewTextPanel(size, color);
  ed.focus();
  ed.addEventListener('keydown', onEditKey);
  ed.addEventListener('blur', () => setTimeout(() => {
    if (!state.editing || state.editing.el !== ed) return;
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#side')) return; // editing style in the panel — keep the box open
    finishEdit(true);
  }, 0));
}

function onEditKey(e) {
  if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
  else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
  e.stopPropagation();
}

async function finishEdit(commit) {
  const ed = state.editing;
  if (!ed || ed.closing) return;
  ed.closing = true;
  let text = ed.el.textContent.replace(/\r?\n/g, ' ');
  if (ed.isNew && !text.trim()) text = ($('#propText').value || '').replace(/\r?\n/g, ' ');   // allow content typed in the panel
  ed.el.remove();
  state.editing = null;
  if (ed.isNew) {
    if (commit && text.trim()) {
      const baseline = ed.vy + ed.size * 0.95;
      await mutate(ed.i, () => state.doc.addText(ed.i, ed.vx, baseline, text, { size: ed.size, color: ed.color, family: ed.family, bold: ed.bold, italic: ed.italic }), 'Add text');
      selectLastText(ed.i);     // keep the new text selected so it stays movable/resizable & stylable
    } else { rerender(ed.i); select(null); }
    return;
  }
  state.doc.setHidden(ed.item.objs, false, ed.colors);
  if (commit && text !== ed.item.text) {
    if (!text.trim()) {
      await mutate(ed.i, () => state.doc.remove(ed.i, ed.item.objs), 'Delete text');
      select(null);
    } else {
      const r = await mutate(ed.i, () => state.doc.editText(ed.i, ed.item, text), 'Edit text');
      if (r && r.usedFallback) toast('Some new letters were not in this PDF’s font — that line now uses the closest matching font.');
      select(null);
    }
  } else {
    renderCanvas(ed.i);
  }
}

// =====================================================================
// colour sampling (eyedropper) + eraser + match-and-type
// =====================================================================
/** RGBA of the rendered page at view point (vx, vy) in points. */
function samplePageColor(i, vx, vy) {
  const p = state.pages[i]; if (!p || !p.canvas.width) return null;
  const { w, h } = state.doc.size(i);
  const sx = p.canvas.width / w, sy = p.canvas.height / h;
  const px = Math.max(0, Math.min(p.canvas.width - 1, Math.round(vx * sx)));
  const py = Math.max(0, Math.min(p.canvas.height - 1, Math.round(vy * sy)));
  try { const d = p.canvas.getContext('2d').getImageData(px, py, 1, 1).data; return [d[0], d[1], d[2], 255]; }
  catch (e) { return null; }
}
/** Median colour of a grid around (vx,vy) — the background, even when the centre is on text. */
function sampleAreaColor(i, vx, vy, rad) {
  const cols = [], N = 7;
  for (let a = 0; a < N; a++) for (let c = 0; c < N; c++) {
    const col = samplePageColor(i, vx + (a / (N - 1) - 0.5) * 2 * rad, vy + (c / (N - 1) - 0.5) * 2 * rad);
    if (col) cols.push(col);
  }
  if (!cols.length) return [255, 255, 255, 255];
  const med = (f) => cols.map(f).sort((p, q) => p - q)[cols.length >> 1];
  return [med((c) => c[0]), med((c) => c[1]), med((c) => c[2]), 255];
}
/** Guess the colour and size of text under a click on an image (for Match & type). */
function sampleTextStyle(i, vx, vy) {
  const p = state.pages[i], { w, h } = state.doc.size(i);
  const sx = p.canvas.width / w, sy = p.canvas.height / h;
  const cx = Math.round(vx * sx), cy = Math.round(vy * sy), R = Math.max(8, Math.round(22 * sy));
  const x0 = Math.max(0, cx - R), y0 = Math.max(0, cy - R);
  const ww = Math.min(p.canvas.width, cx + R) - x0, hh = Math.min(p.canvas.height, cy + R) - y0;
  let color = [0, 0, 0, 255], size = 14;
  try {
    const data = p.canvas.getContext('2d').getImageData(x0, y0, ww, hh).data;
    let darkLum = 999, light = 0;
    for (let k = 0; k < data.length; k += 4) {
      const lum = 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
      if (lum < darkLum) { darkLum = lum; color = [data[k], data[k + 1], data[k + 2], 255]; }
      if (lum > light) light = lum;
    }
    // text height = vertical run of "dark" pixels through the clicked column
    const mid = (darkLum + light) / 2, col = Math.min(ww - 1, cx - x0);
    let top = -1, bot = -1;
    for (let yy = 0; yy < hh; yy++) {
      const k = (yy * ww + col) * 4, lum = 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
      if (lum < mid) { if (top < 0) top = yy; bot = yy; }
    }
    if (top >= 0 && bot > top) size = Math.max(7, Math.min(72, ((bot - top) / sy) * 1.3));
  } catch (e) { /* cross-origin or empty — use defaults */ }
  return { color, size };
}
/** Round eraser brush: paint over anything with the background colour; size is adjustable. */
function startEraseBrush(i, sx, sy, pageEl) {
  const p = state.pages[i], z = state.zoom, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { w, h } = state.doc.size(i);
  const scale = z * dpr;                                    // view points -> paint pixels
  const pc = document.createElement('canvas');
  pc.width = Math.max(1, Math.round(w * scale)); pc.height = Math.max(1, Math.round(h * scale));
  Object.assign(pc.style, { position: 'absolute', left: '0', top: '0', width: (w * z) + 'px', height: (h * z) + 'px', pointerEvents: 'none', zIndex: '6' });
  p.overlay.appendChild(pc);
  const ctx = pc.getContext('2d');
  const bg = sampleAreaColor(i, sx, sy, (state.eraseSize || 20));
  ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
  const r = (state.eraseSize || 20) / 2;                    // radius in view points
  const rectEl = pageEl.getBoundingClientRect();
  let minX = w, minY = h, maxX = 0, maxY = 0, last = null;
  const stamp = (vx, vy) => {
    ctx.beginPath(); ctx.arc(vx * scale, vy * scale, r * scale, 0, Math.PI * 2); ctx.fill();
    minX = Math.min(minX, vx - r); minY = Math.min(minY, vy - r); maxX = Math.max(maxX, vx + r); maxY = Math.max(maxY, vy + r);
  };
  const paint = (vx, vy) => {
    if (last) { const d = Math.hypot(vx - last.x, vy - last.y), n = Math.max(1, Math.ceil(d / (r * 0.4))); for (let k = 1; k <= n; k++) stamp(last.x + (vx - last.x) * k / n, last.y + (vy - last.y) * k / n); }
    else stamp(vx, vy);
    last = { x: vx, y: vy };
  };
  paint(sx, sy);
  const onMove = (ev) => paint((ev.clientX - rectEl.left) / z, (ev.clientY - rectEl.top) / z);
  const onUp = async () => {
    document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp);
    minX = Math.max(0, minX); minY = Math.max(0, minY); maxX = Math.min(w, maxX); maxY = Math.min(h, maxY);
    const bw = maxX - minX, bh = maxY - minY;
    pc.remove();
    if (bw < 1 || bh < 1) return;
    const sxp = Math.round(minX * scale), syp = Math.round(minY * scale), swp = Math.max(1, Math.round(bw * scale)), shp = Math.max(1, Math.round(bh * scale));
    const crop = ctx.getImageData(sxp, syp, swp, shp);
    await mutate(i, () => state.doc.addImage(i, crop, { x: minX, y: minY, w: bw, h: bh }), 'Erase');
  };
  document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp);
}

/** Drag a rectangle to drop a translucent highlight (like a highlighter pen). */
function startHighlight(i, sx, sy, pageEl) {
  const p = state.pages[i], z = state.zoom;
  const box = document.createElement('div'); box.className = 'phl-preview'; p.overlay.appendChild(box);
  const r = pageEl.getBoundingClientRect();
  let cur = { x: sx, y: sy, w: 0, h: 0 };
  const draw = (vx, vy) => { const x = Math.min(sx, vx), y = Math.min(sy, vy), w = Math.abs(vx - sx), h = Math.abs(vy - sy); Object.assign(box.style, { left: x * z + 'px', top: y * z + 'px', width: w * z + 'px', height: h * z + 'px' }); cur = { x, y, w, h }; };
  const onMove = (ev) => draw((ev.clientX - r.left) / z, (ev.clientY - r.top) / z);
  const onUp = async () => {
    document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp);
    box.remove();
    if (cur.w < 3 || cur.h < 3) return;
    await mutate(i, () => state.doc.addHighlight(i, cur, state.hlColor || [255, 232, 59]), 'Highlight');
  };
  document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp);
}

// ---- colour-picker magnifier (loupe) ----------------------------------
let _loupe = null;
function ensureLoupe() {
  if (_loupe) return _loupe;
  const box = document.createElement('div'); box.id = 'pickLoupe'; box.hidden = true;
  const cv = document.createElement('canvas'); cv.width = 132; cv.height = 132;
  box.appendChild(cv); document.body.appendChild(box);
  _loupe = { box, cv, ctx: cv.getContext('2d') };
  return _loupe;
}
function drawLoupe(i, vx, vy, clientX, clientY) {
  const p = state.pages[i]; if (!p || !p.canvas.width) return;
  const lp = ensureLoupe(); lp.box.hidden = false;
  const { w } = state.doc.size(i);
  const s = p.canvas.width / w;
  const cx = vx * s, cy = vy * s;
  const SRC = 22, g = lp.ctx, W = lp.cv.width, Z = W / SRC;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, W, W);
  g.drawImage(p.canvas, cx - SRC / 2, cy - SRC / 2, SRC, SRC, 0, 0, W, W);
  const m = W / 2;
  g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 1; g.strokeRect(m - Z / 2 - 1, m - Z / 2 - 1, Z + 2, Z + 2);
  g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeRect(m - Z / 2, m - Z / 2, Z, Z);
  const c = samplePageColor(i, vx, vy); if (c) lp.box.style.borderColor = hex(c);
  const off = 20, LW = 150;
  let left = clientX + off, top = clientY + off;
  if (left + LW > innerWidth) left = clientX - LW - off;
  if (top + LW > innerHeight) top = clientY - LW - off;
  lp.box.style.left = Math.max(4, left) + 'px'; lp.box.style.top = Math.max(4, top) + 'px';
}
function hideLoupe() { if (_loupe) _loupe.box.hidden = true; }

// =====================================================================
// pointer: select, drag-move, resize, add text
// =====================================================================
function bindOverlayEvents() {
  const viewer = $('#viewer');
  viewer.addEventListener('pointermove', (e) => {
    if (!state.picking) { return; }
    const pageEl = (e.target.closest && e.target.closest('.ppage')) || document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.ppage');
    if (!pageEl) { hideLoupe(); return; }
    const i = +pageEl.dataset.page, r = pageEl.getBoundingClientRect();
    drawLoupe(i, (e.clientX - r.left) / state.zoom, (e.clientY - r.top) / state.zoom, e.clientX, e.clientY);
  });
  viewer.addEventListener('pointerdown', (e) => {
    const pageEl = e.target.closest('.ppage');
    if (!pageEl || e.target.closest('.pinline')) return;
    const i = +pageEl.dataset.page;
    const objEl = e.target.closest('.pobj');
    const rect = pageEl.getBoundingClientRect();
    const vx = (e.clientX - rect.left) / state.zoom, vy = (e.clientY - rect.top) / state.zoom;

    if (state.picking) { e.preventDefault(); const c = samplePageColor(i, vx, vy); viewer.classList.remove('is-picking'); hideLoupe(); const cb = state.picking; state.picking = null; if (c) cb(c); return; }
    if (state.tool === 'erase') { e.preventDefault(); startEraseBrush(i, vx, vy, pageEl); return; }
    if (state.tool === 'match') { e.preventDefault(); const st = sampleTextStyle(i, vx, vy); startNewText(i, vx, vy - st.size * 0.8, { size: st.size, color: st.color }); setTool('edit'); return; }

    if (state.tool === 'text') {           // Text tool: always add text, even over a full-page image/scan
      e.preventDefault();
      startNewText(i, vx, vy - 8);
      setTool('edit');
      return;
    }
    if (state.tool === 'highlight') { e.preventDefault(); startHighlight(i, vx, vy, pageEl); return; }
    if (!objEl) { finishEdit(true); select(null); return; }

    const k = +objEl.dataset.k;
    const item = state.pages[i].items[k];
    const resizing = !!e.target.closest('.phandle');
    e.preventDefault();
    objEl.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    const orig = { left: parseFloat(objEl.style.left), top: parseFloat(objEl.style.top), w: parseFloat(objEl.style.width), h: parseFloat(objEl.style.height) };
    let moved = false;
    const onMove = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      if (resizing) {
        const k2 = Math.max(0.05, (orig.w + dx) / orig.w);
        objEl.style.width = orig.w * k2 + 'px';
        objEl.style.height = orig.h * k2 + 'px';
      } else {
        objEl.classList.add('is-drag');
        objEl.style.left = orig.left + dx + 'px';
        objEl.style.top = orig.top + dy + 'px';
      }
    };
    const onUp = async (ev) => {
      objEl.removeEventListener('pointermove', onMove);
      objEl.removeEventListener('pointerup', onUp);
      objEl.removeEventListener('pointercancel', onUp);
      if (!moved) {
        // click once to select (then move/resize); click the selected text again to edit its words inline
        const already = state.sel && state.sel.page === i && state.sel.k === k;
        if (!resizing && item.kind === 'text' && !item.broken && already) await editItem(i, item);
        else select({ page: i, k });
        return;
      }
      finishEdit(true);
      const z = state.zoom;
      if (resizing) {
        const newW = parseFloat(objEl.style.width) / z;
        if (item.kind === 'text') {
          const scale = Math.max(0.1, newW / (item.box.w || newW));   // text: scale the FONT size, not a raw matrix
          const ns = Math.max(4, Math.round(item.size * scale * 10) / 10);
          const pb = { ...item.box };
          await mutate(i, () => state.doc.editText(i, item, item.text, { size: ns }), 'Resize text');
          requiet(i, state.sel ? state.sel.k : k, pb);   // editText replaces the object — reselect quietly
          return;
        } else {
          const h = parseFloat(objEl.style.height) / z;
          await mutate(i, () => state.doc.resizeTo(i, item.objs[0], { x: item.box.x, y: item.box.y, w: newW, h }), 'Resize');
        }
      } else {
        const dx = (ev.clientX - start.x) / z, dy = (ev.clientY - start.y) / z;
        await mutate(i, () => state.doc.move(i, item.objs, dx, dy), 'Move');
      }
      reselectAt(i, item);
    };
    objEl.addEventListener('pointermove', onMove);
    objEl.addEventListener('pointerup', onUp);
    objEl.addEventListener('pointercancel', onUp);
  });
}

/** Open the inline editor for `item`, finishing any edit that is still open first. */
async function editItem(i, item) {
  if (state.editing) await finishEdit(true);
  const k = state.pages[i].items.findIndex((it) => it.kind === 'text' && it.objs.some((o) => item.objs.includes(o)));
  if (k >= 0) startEdit(i, k);
}

/** After a change, keep the same object selected (it may have a new index). */
function reselectAt(i, before) {
  const items = state.pages[i].items;
  const k = items.findIndex((it) => it.objs.some((o) => before.objs.includes(o)));
  select(k >= 0 ? { page: i, k } : null);
}

// =====================================================================
// tools
// =====================================================================
function setTool(t) {
  state.tool = t;
  $$('.ptb[data-tool]').forEach((b) => { const on = b.dataset.tool === t; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
  const cls = { text: 'tool-text', erase: 'tool-erase', match: 'tool-match', highlight: 'tool-highlight' }[t] || '';
  state.pages.forEach((p) => { p.overlay.classList.remove('tool-text', 'tool-erase', 'tool-match', 'tool-highlight'); if (cls) p.overlay.classList.add(cls); });
  const ew = $('#eraseSizeWrap'); if (ew) ew.hidden = t !== 'erase';
  if (t === 'text') toast('Click where the new text should go.');
  else if (t === 'erase') toast('Drag over anything to cover it — works on photos and scans too.');
  else if (t === 'match') toast('Click on text in the image to copy its colour & size, then type over it.');
  else if (t === 'highlight') toast('Drag across text or an area to highlight it.');
}

async function fileToImageData(file, maxSide = 2400) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return c.getContext('2d').getImageData(0, 0, c.width, c.height);
}

async function addImageFile(file) {
  if (!file) return;
  const i = state.current;
  try {
    busy(true, 'Adding image…');
    const img = await fileToImageData(file);
    const { w, h } = state.doc.size(i);
    const bw = Math.min(w * 0.45, img.width * 0.75);
    const bh = bw * (img.height / img.width);
    const box = { x: (w - bw) / 2, y: Math.max(20, (h - bh) / 3), w: bw, h: bh };
    await mutate(i, () => state.doc.addImage(i, img, box), 'Add image');
    selectLastImage(i);
  } catch (e) {
    toast('Could not read that image.', true);
  } finally { busy(false); }
}
function selectLastImage(i) {
  const items = state.pages[i].items;
  for (let k = items.length - 1; k >= 0; k--) if (items[k].kind === 'image') { select({ page: i, k }); return; }
}
function selectLastText(i) {
  const items = state.pages[i].items;
  for (let k = items.length - 1; k >= 0; k--) if (items[k].kind === 'text') { select({ page: i, k }); return; }
}

async function replaceSelectedImage(file) {
  const item = selItem();
  if (!file || !item || item.kind !== 'image') return;
  const i = state.sel.page;
  try {
    busy(true, 'Replacing image…');
    const img = await fileToImageData(file);
    await mutate(i, () => state.doc.replaceImage(i, item.objs[0], img), 'Replace image');
    reselectAt(i, item);
  } catch (e) { toast('Could not read that image.', true); } finally { busy(false); }
}

// =====================================================================
// signature
// =====================================================================
const pad = { drawing: false, last: null, dirty: false };
function openSign() {
  setSignMode('draw');
  clearPad();
  $('#signName').value = '';
  $('#signDialog').showModal();
}
function setSignMode(m) {
  state.signMode = m;
  $$('.psign-tabs [data-sign]').forEach((b) => { const on = b.dataset.sign === m; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
  $$('#signDialog [data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== m; });
  if (m === 'type') setTimeout(() => $('#signName').focus(), 0);
}
function clearPad() {
  const c = $('#signPad');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  pad.dirty = false;
}
function bindPad() {
  const c = $('#signPad');
  const pos = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) }; };
  c.addEventListener('pointerdown', (e) => { e.preventDefault(); c.setPointerCapture(e.pointerId); pad.drawing = true; pad.last = pos(e); });
  c.addEventListener('pointermove', (e) => {
    if (!pad.drawing) return;
    const p = pos(e), x = c.getContext('2d');
    x.strokeStyle = state.ink; x.lineWidth = 5; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(pad.last.x, pad.last.y); x.lineTo(p.x, p.y); x.stroke();
    pad.last = p; pad.dirty = true;
  });
  const stop = () => { pad.drawing = false; };
  c.addEventListener('pointerup', stop);
  c.addEventListener('pointercancel', stop);
}

/** Crop transparent borders. */
function trim(img) {
  const { width: W, height: H, data } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
  const c = document.createElement('canvas'); c.width = x1 - x0 + 1; c.height = y1 - y0 + 1;
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; tmp.getContext('2d').putImageData(img, 0, 0);
  c.getContext('2d').drawImage(tmp, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c.getContext('2d').getImageData(0, 0, c.width, c.height);
}

async function signatureImage() {
  if (state.signMode === 'draw') {
    if (!pad.dirty) return null;
    const c = $('#signPad');
    return trim(c.getContext('2d').getImageData(0, 0, c.width, c.height));
  }
  if (state.signMode === 'type') {
    const name = $('#signName').value.trim();
    if (!name) return null;
    await document.fonts.load("120px 'Dancing Script'").catch(() => {});
    const c = document.createElement('canvas'); c.width = 1400; c.height = 300;
    const x = c.getContext('2d');
    x.fillStyle = state.ink; x.font = "120px 'Dancing Script', cursive"; x.textBaseline = 'middle';
    x.fillText(name, 20, 150, 1360);
    return trim(x.getImageData(0, 0, c.width, c.height));
  }
  return null;
}

async function placeSignature(img) {
  if (!img) { toast('Draw, type or upload a signature first.', true); return; }
  $('#signDialog').close();
  const i = state.current;
  const { w, h } = state.doc.size(i);
  const bw = Math.min(180, w * 0.4), bh = bw * (img.height / img.width);
  const box = { x: w - bw - 50, y: h - bh - 90, w: bw, h: bh };
  await mutate(i, () => state.doc.addImage(i, img, box), 'Add signature');
  selectLastImage(i);
  toast('Signature added — drag it into place.');
}

async function uploadSignature(file) {
  if (!file) return;
  try {
    const img = await fileToImageData(file, 1600);
    // make the paper transparent: light pixels -> clear, dark pixels -> ink-coloured
    const d = img.data, ink = fromHex(state.ink);
    for (let p = 0; p < d.length; p += 4) {
      const lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      const a = Math.max(0, Math.min(255, (205 - lum) * 2.2));
      d[p] = ink[0]; d[p + 1] = ink[1]; d[p + 2] = ink[2]; d[p + 3] = Math.min(d[p + 3], a);
    }
    await placeSignature(trim(img));
  } catch (e) { toast('Could not read that image.', true); }
}

// =====================================================================
// download
// =====================================================================
function download() {
  if (!state.doc) return;
  finishEdit(true);
  try {
    const bytes = state.doc.save();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${state.name || 'document'}-edited.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    state.dirty = false;
    $('#docState').textContent = 'Downloaded';
  } catch (e) { toast('Could not save: ' + e.message, true); }
}

// =====================================================================
// wiring
// =====================================================================
/**
 * Tools opened from the landing page. `open(file)` = single PDF tools (picked with #toolInput),
 * `input` = a tool with its own file input, `drop(files)` = what dropping files on that tool's view does.
 */
const TOOLS = {
  organize: { open: (f) => pageTools.organize(f), drop: (fs) => { const f = fs.find((x) => /\.pdf$/i.test(x.name) || x.type === 'application/pdf'); if (f) pageTools.organizeAdd(f); else toast('Please drop a PDF file.', true); } },
  split: { open: (f) => pageTools.split(f) },
  merge: { input: '#mrgInput', drop: (fs) => pageTools.merge(fs) },
  protect: { open: async (f) => { if (window.ConsentGate && !(await window.ConsentGate.require('Protect PDF'))) return; return secureTools.protect(f); } },
  unlock: { open: async (f) => { if (window.ConsentGate && !(await window.ConsentGate.require('Unlock PDF'))) return; return secureTools.unlock(f); } },
  toimg: { open: (f) => convertTools.toImages(f) },
  extract: { open: (f) => convertTools.extract(f) },
  imgpdf: { input: '#imgpdfInput', drop: (fs) => convertTools.imagesToPdf(fs) },
  compress: { open: (f) => optimizeTools.compress(f) }
};

function bind() {
  const helpers = { toast, busy, askPassword, showView, openInEditor: (file) => openFile(file) };
  initPageTools(helpers);
  initSecureTools(helpers);
  initConvertTools(helpers);
  initOptimizeTools(helpers);
  const input = $('#pdfInput');
  const pick = () => input.click();
  input.addEventListener('change', () => { openFile(input.files[0]); input.value = ''; });
  $('#openOther').addEventListener('click', pick);
  // service cards on the landing page — pick the service first, then the file
  const toolInput = $('#toolInput');
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.open;
    if (t === 'edit' || t === 'sign') { state.pendingSign = t === 'sign'; pick(); return; }
    const tool = TOOLS[t];
    if (!tool) return;
    if (tool.input) { $(tool.input).click(); return; }      // tool with its own (multi-file) input
    state.pendingTool = t;
    toolInput.accept = tool.accept || 'application/pdf,.pdf';
    toolInput.click();
  }));
  toolInput.addEventListener('change', () => {
    const f = toolInput.files[0], t = state.pendingTool;
    toolInput.value = '';
    if (f && TOOLS[t]) TOOLS[t].open(f);
  });
  $$('[data-back]').forEach((b) => b.addEventListener('click', () => showView('landing')));

  // "choose a tool" dialog — shown when a PDF is dropped on the landing
  const runService = (name, f) => {
    if (name === 'edit') return openFile(f);
    if (name === 'merge') return pageTools.merge([f]);
    const tool = TOOLS[name];
    if (tool && tool.open) return tool.open(f);
  };
  $$('#chooseDialog [data-choose]').forEach((b) => b.addEventListener('click', () => {
    const f = state.droppedFile; $('#chooseDialog').close();
    if (f) runService(b.dataset.choose, f);
  }));
  $('#chooseCancel').addEventListener('click', () => $('#chooseDialog').close());
  function openChooser(file) { state.droppedFile = file; $('#chooseFile').textContent = file.name; $('#chooseFile').hidden = false; $('#chooseDialog').showModal(); }

  // drag & drop anywhere — what happens depends on the screen that is open
  const isPdf = (x) => /\.pdf$/i.test(x.name) || x.type === 'application/pdf';
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('pdragging'); } });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('pdragging'); });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); document.body.classList.remove('pdragging');
    const files = [...e.dataTransfer.files];
    const view = currentView();
    const tool = TOOLS[view];
    if (tool && tool.drop) { tool.drop(files); return; }          // merge / image-to-pdf views
    const f = files.find(isPdf);
    if (tool && tool.open) { if (f) tool.open(f); else toast('Please drop a PDF file.', true); return; }  // single-PDF tool views
    if (view === 'editor') {                                       // already editing: open / add image
      if (f) openFile(f); else if (state.doc && files[0].type.startsWith('image/')) addImageFile(files[0]);
      else toast('Please drop a PDF file.', true);
      return;
    }
    // landing: let the user choose what to do
    if (f) openChooser(f);
    else if (files.some((x) => x.type.startsWith('image/'))) convertTools.imagesToPdf(files.filter((x) => x.type.startsWith('image/')));
    else toast('Please drop a PDF file.', true);
  });

  // toolbar
  $$('.ptb[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $$('.ptb[data-action]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.action;
    if (a === 'image') $('#imgInput').click();
    else if (a === 'sign') openSign();
    else if (a === 'undo') undo();
    else if (a === 'redo') redo();
    else if (a === 'delete') deleteSelected();
    else if (a === 'zoom-in') stepZoom(1);
    else if (a === 'zoom-out') stepZoom(-1);
    else if (a === 'zoom-fit') fitWidth();
  }));
  $('#imgInput').addEventListener('change', (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (state.replacing) { state.replacing = false; replaceSelectedImage(f); } else addImageFile(f);
  });
  $('#replaceImage').addEventListener('click', () => { state.replacing = true; $('#imgInput').click(); });
  $('#applyText').addEventListener('click', commitText);
  // live editing: panel changes show on the page immediately
  $('#propBold').addEventListener('change', () => onStyleInput(true));
  $('#propItalic').addEventListener('change', () => onStyleInput(true));
  $('#propFamily').addEventListener('change', () => onStyleInput(true));
  $('#propSize').addEventListener('input', () => onStyleInput(false));
  $('#propColor').addEventListener('input', () => onStyleInput(false));
  $('#propText').addEventListener('input', () => { if (state.editing && state.editing.isNew) styleNewTextLive(); else queueLive(320); });
  $('#propEyedrop').addEventListener('click', () => {
    state.picking = (c) => { $('#propColor').value = hex(c); applyPanel(); };
    $('#viewer').classList.add('is-picking');
    toast('Click anywhere on the page to pick that colour.');
  });
  $('#deleteSel').addEventListener('click', deleteSelected);
  const es = $('#eraseSize'); if (es) es.addEventListener('input', (e) => { state.eraseSize = +e.target.value; });
  $('#downloadBtn').addEventListener('click', download);

  // signature dialog
  bindPad();
  $$('.psign-tabs [data-sign]').forEach((b) => b.addEventListener('click', () => setSignMode(b.dataset.sign)));
  $('#signClear').addEventListener('click', clearPad);
  $('#signCancel').addEventListener('click', () => $('#signDialog').close());
  $('#signPlace').addEventListener('click', async () => {
    if (state.signMode === 'upload') { $('#signInput').click(); return; }
    await placeSignature(await signatureImage());
  });
  $('#signUploadBtn').addEventListener('click', () => $('#signInput').click());
  $('#signInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; uploadSignature(f); });
  $$('.psign-colors [data-ink]').forEach((b) => b.addEventListener('click', () => {
    state.ink = b.dataset.ink;
    $$('.psign-colors [data-ink]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  }));

  bindOverlayEvents();

  // keyboard
  document.addEventListener('keydown', async (e) => {
    if (!state.doc || $('#editor').hidden) return;
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); download(); return; }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'Escape') { select(null); setTool('edit'); }
    else if (e.key.toLowerCase() === 't') setTool('text');
    else if (e.key.toLowerCase() === 'e') setTool('erase');
    else if (e.key.toLowerCase() === 'm') setTool('match');
    else if (e.key.toLowerCase() === 'v') setTool('edit');
    else if (state.sel && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1, item = selItem(), i = state.sel.page;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      await mutate(i, () => state.doc.move(i, item.objs, d[0], d[1]), 'Move');
      reselectAt(i, item);
    }
  });

  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  let rz = 0;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (state.doc) rerenderAll(); }, 250); });
  const y = $('#pyear'); if (y) y.textContent = new Date().getFullYear();
}

bind();
// test hook (used by automated checks only)
window.__pdfEditor = { state, openFile };
