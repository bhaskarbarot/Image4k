/* Image4k PDF editor — UI. Uses engine.js (PDFium) for every real PDF change. */
import { PdfDoc } from './engine.js?v=pdf6';
import { initPageTools, pageTools } from './pages.js?v=pdf6';
import { initSecureTools, secureTools } from './secure.js?v=pdf6';
import { initConvertTools, convertTools } from './convert.js?v=pdf6';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const MAX_BYTES = 200 * 1024 * 1024;
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const FAMILY_CSS = { Sans: "'LibSans', Arial, sans-serif", Serif: "'LibSerif', 'Times New Roman', serif", Mono: "'LibMono', 'Courier New', monospace" };

const state = {
  doc: null, name: '', password: '', zoom: 1, tool: 'edit',
  pages: [],            // { el, canvas, overlay, thumb, rendered, items }
  current: 0,
  sel: null,            // { page, item }
  editing: null,        // inline edit session
  undo: [], redo: [], dirty: false, busy: false,
  ink: '#111111', signMode: 'draw', pendingSign: false
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
  p.overlay.className = 'poverlay' + (state.tool === 'text' ? ' tool-text' : '');
  p.items.forEach((item, k) => {
    const d = document.createElement('div');
    d.className = 'pobj' + (item.kind === 'image' ? ' is-image' : '') + (item.broken ? ' is-broken' : '');
    d.dataset.k = k;
    const pad = item.kind === 'text' ? 1.5 : 0;
    Object.assign(d.style, { left: (item.box.x - pad) * z + 'px', top: (item.box.y - pad) * z + 'px', width: (item.box.w + 2 * pad) * z + 'px', height: (item.box.h + 2 * pad) * z + 'px' });
    d.title = item.kind === 'text' ? (item.broken ? 'This text uses a font that cannot be read, so it cannot be edited' : 'Click to edit · drag to move') : 'Drag to move · corner to resize';
    if (state.sel && state.sel.page === i && state.sel.k === k) {
      d.classList.add('is-sel');
      if (item.kind === 'image') d.insertAdjacentHTML('beforeend', '<span class="phandle"></span>');
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
  ed.addEventListener('blur', () => setTimeout(() => { if (state.editing && state.editing.el === ed) finishEdit(true); }, 0));
}

function startNewText(i, vx, vy) {
  finishEdit(true);
  const z = state.zoom, p = state.pages[i];
  const size = 14;
  const ed = document.createElement('div');
  ed.className = 'pinline';
  ed.contentEditable = 'plaintext-only';
  if (ed.contentEditable !== 'plaintext-only') ed.contentEditable = 'true';
  Object.assign(ed.style, { left: vx * z + 'px', top: vy * z + 'px', minHeight: size * 1.2 * z + 'px', lineHeight: size * 1.2 * z + 'px', fontSize: size * z + 'px', fontFamily: FAMILY_CSS.Sans, color: '#000', minWidth: '120px' });
  ed.dataset.placeholder = 'Type here';
  p.overlay.appendChild(ed);
  state.editing = { i, el: ed, isNew: true, vx, vy, size };
  ed.focus();
  ed.addEventListener('keydown', onEditKey);
  ed.addEventListener('blur', () => setTimeout(() => { if (state.editing && state.editing.el === ed) finishEdit(true); }, 0));
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
  const text = ed.el.textContent.replace(/\r?\n/g, ' ');
  ed.el.remove();
  state.editing = null;
  if (ed.isNew) {
    if (commit && text.trim()) {
      const baseline = ed.vy + ed.size * 0.95;
      await mutate(ed.i, () => state.doc.addText(ed.i, ed.vx, baseline, text, { size: ed.size }), 'Add text');
    } else rerender(ed.i);
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
// pointer: select, drag-move, resize, add text
// =====================================================================
function bindOverlayEvents() {
  const viewer = $('#viewer');
  viewer.addEventListener('pointerdown', (e) => {
    const pageEl = e.target.closest('.ppage');
    if (!pageEl || e.target.closest('.pinline')) return;
    const i = +pageEl.dataset.page;
    const objEl = e.target.closest('.pobj');
    const rect = pageEl.getBoundingClientRect();
    const vx = (e.clientX - rect.left) / state.zoom, vy = (e.clientY - rect.top) / state.zoom;

    if (state.tool === 'text' && !objEl) {
      e.preventDefault();
      startNewText(i, vx, vy - 8);
      setTool('edit');
      return;
    }
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
        if (item.kind === 'text' && state.tool === 'edit') await editItem(i, item);
        else select({ page: i, k });
        return;
      }
      finishEdit(true);
      const z = state.zoom;
      if (resizing) {
        const w = parseFloat(objEl.style.width) / z, h = parseFloat(objEl.style.height) / z;
        await mutate(i, () => state.doc.resizeTo(i, item.objs[0], { x: item.box.x, y: item.box.y, w, h }), 'Resize');
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
  state.pages.forEach((p) => p.overlay.classList.toggle('tool-text', t === 'text'));
  if (t === 'text') toast('Click on the page where the new text should go.');
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
  protect: { open: (f) => secureTools.protect(f) },
  unlock: { open: (f) => secureTools.unlock(f) },
  toimg: { open: (f) => convertTools.toImages(f) },
  extract: { open: (f) => convertTools.extract(f) },
  imgpdf: { input: '#imgpdfInput', drop: (fs) => convertTools.imagesToPdf(fs) }
};

function bind() {
  const helpers = { toast, busy, askPassword, showView, openInEditor: (file) => openFile(file) };
  initPageTools(helpers);
  initSecureTools(helpers);
  initConvertTools(helpers);
  const input = $('#pdfInput');
  const pick = () => input.click();
  $('#pickPdf').addEventListener('click', (e) => { e.stopPropagation(); pick(); });
  $('#pdfDrop').addEventListener('click', pick);
  $('#pdfDrop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  input.addEventListener('change', () => { openFile(input.files[0]); input.value = ''; });
  $('#openOther').addEventListener('click', pick);
  // tool cards on the landing page
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

  // drag & drop anywhere — what happens depends on the screen that is open
  const drop = $('#pdfDrop');
  const isPdf = (x) => /\.pdf$/i.test(x.name) || x.type === 'application/pdf';
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.classList.add('drag'); } });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('drag'); });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); drop.classList.remove('drag');
    const files = [...e.dataTransfer.files];
    const view = currentView();
    const tool = TOOLS[view];
    if (tool && tool.drop) { tool.drop(files); return; }
    const f = files.find(isPdf);
    if (tool && tool.open) { if (f) tool.open(f); else toast('Please drop a PDF file.', true); return; }
    if (f) openFile(f); else if (state.doc && view === 'editor' && files[0].type.startsWith('image/')) addImageFile(files[0]);
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
  $('#applyText').addEventListener('click', applyPanel);
  $('#deleteSel').addEventListener('click', deleteSelected);
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
