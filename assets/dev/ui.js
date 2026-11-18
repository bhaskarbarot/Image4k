/* Professional Developer — Developer tools: shared UI helpers (no framework, no innerHTML with user data).
 * Every tool module imports from here so clipboard, downloads, notifications, editors and errors
 * behave the same everywhere. */

/* ---------- DOM ---------- */
/** h('div', {class:'x', on:{click:fn}, dataset:{a:1}, attrs:{role:'tab'}}, 'text', childNode, [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av != null && av !== false) el.setAttribute(a, av === true ? '' : av); }
      else if (k in el && typeof v !== 'string') el[k] = v;
      else if (k in el && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'type' || k === 'placeholder' || k === 'title' || k === 'id' || k === 'name' || k === 'htmlFor')) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- small utils ---------- */
export function debounce(fn, ms = 250) {
  let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + ' ' + u[i];
}
export function byteLength(str) { return new TextEncoder().encode(str).length; }

/** localStorage wrapper that never throws (private mode, blocked storage…). */
export const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem('bs:' + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
  set(key, value) { try { localStorage.setItem('bs:' + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } },
};

/* ---------- notifications ---------- */
let toastHost = null;
export function toast(msg, type = 'ok', ms = 2600) {
  if (!toastHost) {
    toastHost = h('div', { class: 'dt-toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: 'dt-toast is-' + type }, msg);
  toastHost.appendChild(t);
  setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 300); }, ms);
}

/* ---------- clipboard & download ---------- */
export async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    // fallback for browsers / contexts without the async clipboard API
    const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
  }
  if (btn) flashButton(btn, ok ? 'Copied ✓' : 'Copy failed');
  if (!ok) toast('Could not copy — select the text and press Ctrl+C', 'err');
  return ok;
}
export function flashButton(btn, label, ms = 1400) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = label; btn.classList.add('is-flash');
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove('is-flash'); }, ms);
}
/** download('a.json', stringOrBlobOrBytes, 'application/json') */
export function download(filename, data, mime = 'text/plain;charset=utf-8') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Downloaded ' + filename + ' (' + formatBytes(blob.size) + ')');
}

/* ---------- files ---------- */
export function pickFile({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    inp.addEventListener('change', () => { resolve(multiple ? Array.from(inp.files) : inp.files[0] || null); inp.remove(); });
    document.body.appendChild(inp); inp.click();
  });
}
export const readText = (file) => file.text();
export async function readBytes(file) { return new Uint8Array(await file.arrayBuffer()); }
/** Rough check that a file really is text (not just named .json): no NUL bytes in the first 64 KB and valid UTF-8. */
export async function looksLikeText(file) {
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  if (head.includes(0)) return false;
  // stream:true tolerates a multi-byte character cut off at the end of the 64 KB sample
  try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); return true; } catch (e) { return false; }
}
export async function readTextFileChecked(file, maxBytes = 50 * 1024 * 1024) {
  if (file.size > maxBytes) throw new Error(`File is too large (${formatBytes(file.size)}). Limit is ${formatBytes(maxBytes)}.`);
  if (!(await looksLikeText(file))) throw new Error('This file does not look like a text file.');
  return file.text();
}

/* ---------- form controls ---------- */
export function btn(label, onClick, cls = 'btn btn-ghost btn-sm', attrs) {
  return h('button', { type: 'button', class: cls, on: onClick ? { click: onClick } : null, attrs }, label);
}
export function primary(label, onClick, attrs) { return btn(label, onClick, 'btn btn-primary btn-sm', attrs); }

export function field(label, control, hint) {
  const id = control.id || (control.id = uid('f'));
  return h('label', { class: 'dt-field', htmlFor: id }, h('span', { class: 'dt-label' }, label), control, hint ? h('small', { class: 'dt-hint' }, hint) : null);
}
export function select(options, value, onChange) {
  const s = h('select', { class: 'dt-input' });
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : typeof o === 'object' ? [o.value, o.label] : [o, o];
    s.appendChild(h('option', { value: v }, l));
  }
  if (value != null) s.value = value;
  if (onChange) s.addEventListener('change', () => onChange(s.value));
  return s;
}
export function input(props = {}) { return h('input', { class: 'dt-input', type: 'text', ...props }); }
export function checkbox(label, checked, onChange) {
  const c = h('input', { type: 'checkbox', checked: !!checked });
  if (onChange) c.addEventListener('change', () => onChange(c.checked));
  const l = h('label', { class: 'dt-check' }, c, h('span', null, label));
  l.input = c;
  return l;
}
/** Segmented control: seg([['a','A'],['b','B']], 'a', v => …) */
export function seg(options, value, onChange, label) {
  const wrap = h('div', { class: 'dt-seg', attrs: { role: 'radiogroup', 'aria-label': label || null } });
  const set = (v) => {
    wrap.value = v;
    for (const b of wrap.children) { const on = b.dataset.v === v; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', on); }
  };
  for (const [v, l] of options) {
    wrap.appendChild(h('button', { type: 'button', dataset: { v }, attrs: { role: 'radio' }, on: { click: () => { set(v); onChange && onChange(v); } } }, l));
  }
  set(value);
  wrap.set = set;
  return wrap;
}
/** tabs([['body','Body'],['headers','Headers']], 'body', id => …) → {el, set} ; ARIA tablist */
export function tabs(items, active, onChange) {
  const el = h('div', { class: 'dt-tabs', attrs: { role: 'tablist' } });
  const set = (id) => {
    for (const b of el.children) { const on = b.dataset.id === id; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; }
    el.value = id;
  };
  for (const [id, label] of items) {
    el.appendChild(h('button', { type: 'button', class: 'dt-tab', dataset: { id }, attrs: { role: 'tab' }, on: { click: () => { set(id); onChange && onChange(id); } } }, label));
  }
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const bs = Array.from(el.children); const i = bs.findIndex((b) => b.dataset.id === el.value);
    const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
    n.click(); n.focus();
  });
  set(active);
  return { el, set, setLabel(id, text) { const b = el.querySelector(`[data-id="${id}"]`); if (b) b.textContent = text; } };
}

let uidN = 0;
export function uid(p = 'u') { return p + '-' + (++uidN) + '-' + Math.random().toString(36).slice(2, 6); }

/* ---------- editor panel ---------- */
/**
 * editor({ label, placeholder, value, readonly, rows, file:{accept}, download:{name,mime}, copy, clear, paste, sample, onInput })
 * Returns { el, ta, get, set, setMeta, actions }.
 */
export function editor(opts = {}) {
  const ta = h('textarea', {
    class: 'dt-code', placeholder: opts.placeholder || '',
    attrs: { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', 'aria-label': opts.label || 'Editor', rows: opts.rows || 12, wrap: opts.wrap === false ? 'off' : null },
  });
  if (opts.readonly) ta.readOnly = true;
  if (opts.value) ta.value = opts.value;
  const meta = h('span', { class: 'dt-meta' });
  const actions = h('div', { class: 'dt-actions' });
  const api = {
    el: null, ta, actions,
    get: () => ta.value,
    set: (v) => { ta.value = v == null ? '' : String(v); updateMeta(); },
    setMeta: (t) => { meta.textContent = t; },
  };
  function updateMeta() {
    if (opts.meta === false) return;
    const v = ta.value;
    const lines = v ? v.split('\n').length : 0;
    meta.textContent = v.length > 2e6 ? formatBytes(byteLength(v)) : `${lines.toLocaleString()} lines · ${v.length.toLocaleString()} chars`;
  }
  if (opts.sample) actions.appendChild(btn('Sample', () => { api.set(typeof opts.sample === 'function' ? opts.sample() : opts.sample); ta.dispatchEvent(new Event('input')); }, 'dt-mini'));
  if (opts.paste) actions.appendChild(btn('Paste', async () => {
    try { api.set(await navigator.clipboard.readText()); ta.dispatchEvent(new Event('input')); } catch (e) { toast('Clipboard access was blocked — press Ctrl+V in the box instead.', 'err'); ta.focus(); }
  }, 'dt-mini'));
  if (opts.file) actions.appendChild(btn('Open file', async () => {
    const f = await pickFile({ accept: opts.file.accept || '' });
    if (!f) return;
    try { api.set(await readTextFileChecked(f, opts.file.max)); ta.dispatchEvent(new Event('input')); toast('Loaded ' + f.name); } catch (e) { toast(e.message, 'err'); }
  }, 'dt-mini'));
  if (opts.copy) actions.appendChild(btn('Copy', (e) => { if (!ta.value) return toast('Nothing to copy yet', 'err'); copyText(ta.value, e.currentTarget); }, 'dt-mini'));
  if (opts.download) actions.appendChild(btn('Download', () => {
    if (!ta.value) return toast('Nothing to download yet', 'err');
    const d = typeof opts.download === 'function' ? opts.download() : opts.download;
    download(d.name, ta.value, d.mime);
  }, 'dt-mini'));
  if (opts.clear) actions.appendChild(btn('Clear', () => { api.set(''); ta.dispatchEvent(new Event('input')); ta.focus(); }, 'dt-mini'));
  ta.addEventListener('input', () => { updateMeta(); opts.onInput && opts.onInput(ta.value); });
  // Tab inserts two spaces instead of leaving the editor (Esc then Tab still moves focus).
  let escaped = false;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { escaped = true; return; }
    if (e.key === 'Tab' && !escaped && !ta.readOnly && !e.shiftKey) {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      ta.setRangeText('  ', s, en, 'end'); ta.dispatchEvent(new Event('input'));
    }
    escaped = false;
  });
  api.el = h('div', { class: 'dt-panel' + (opts.class ? ' ' + opts.class : '') },
    h('div', { class: 'dt-panel-head' }, h('span', { class: 'dt-panel-title' }, opts.label || ''), meta, actions),
    ta);
  updateMeta();
  return api;
}

/** Read-only highlighted output panel: output({label, download:{name,mime}}) → {el, set(text, lang), get} */
export function output(opts = {}) {
  const code = h('code');
  const pre = h('pre', { class: 'dt-pre', attrs: { tabindex: '0', 'aria-label': opts.label || 'Output' } }, code);
  const meta = h('span', { class: 'dt-meta' });
  const actions = h('div', { class: 'dt-actions' });
  let text = '';
  const api = {
    el: null, actions, pre,
    get: () => text,
    set(t, lang) {
      text = t == null ? '' : String(t);
      clear(code);
      if (!text) { code.appendChild(h('span', { class: 'dt-empty' }, opts.empty || 'Output will appear here.')); meta.textContent = ''; return; }
      if (lang === 'json' && text.length < 1.5e6) code.appendChild(highlightJSON(text));
      else if (lang === 'xml' && text.length < 1.5e6) code.appendChild(highlightXML(text));
      else code.textContent = text;
      meta.textContent = `${text.split('\n').length.toLocaleString()} lines · ${formatBytes(byteLength(text))}`;
    },
  };
  if (opts.copy !== false) actions.appendChild(btn('Copy', (e) => { if (!text) return toast('Nothing to copy yet', 'err'); copyText(text, e.currentTarget); }, 'dt-mini'));
  if (opts.download) actions.appendChild(btn('Download', () => {
    if (!text) return toast('Nothing to download yet', 'err');
    const d = typeof opts.download === 'function' ? opts.download() : opts.download;
    download(d.name, text, d.mime);
  }, 'dt-mini'));
  api.el = h('div', { class: 'dt-panel' + (opts.class ? ' ' + opts.class : '') },
    h('div', { class: 'dt-panel-head' }, h('span', { class: 'dt-panel-title' }, opts.label || 'Output'), meta, actions), pre);
  api.set('');
  return api;
}

/* ---------- message boxes ---------- */
/** msgBox() → {el, error(msg, detail), ok(msg), warn(msg), info(msg), hide()} */
export function msgBox() {
  const el = h('div', { class: 'dt-msg', hidden: true, attrs: { role: 'alert' } });
  const show = (type, msg, detail) => {
    clear(el); el.hidden = false; el.className = 'dt-msg is-' + type;
    el.appendChild(h('strong', null, msg));
    if (detail) el.appendChild(h('div', { class: 'dt-msg-detail' }, detail));
  };
  return {
    el,
    error: (m, d) => show('err', m, d), ok: (m, d) => show('ok', m, d), warn: (m, d) => show('warn', m, d), info: (m, d) => show('info', m, d),
    hide: () => { el.hidden = true; clear(el); },
  };
}

/* ---------- syntax highlighting (DOM-built, so user data is never parsed as HTML) ---------- */
const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;
export function highlightJSON(text) {
  const frag = document.createDocumentFragment();
  let last = 0, m;
  JSON_TOKEN.lastIndex = 0;
  while ((m = JSON_TOKEN.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    let cls = 'num';
    if (m[1]) cls = m[2] ? 'key' : 'str';
    else if (m[3]) cls = 'bool';
    else if (m[4]) cls = 'null';
    else if (m[6]) cls = 'punc';
    if (m[1] && m[2]) {
      frag.appendChild(h('span', { class: 'tk-key' }, m[1]));
      frag.appendChild(document.createTextNode(m[2]));
    } else frag.appendChild(h('span', { class: 'tk-' + cls }, m[0]));
    last = JSON_TOKEN.lastIndex;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}
const XML_TOKEN = /(<!--[\s\S]*?-->)|(<!\[CDATA\[[\s\S]*?\]\]>)|(<\?[\s\S]*?\?>)|(<\/?)([\w:.-]+)|([\w:.-]+)(=)("[^"]*"|'[^']*')|(\/?>)/g;
export function highlightXML(text) {
  const frag = document.createDocumentFragment();
  let last = 0, m; XML_TOKEN.lastIndex = 0;
  const add = (cls, s) => frag.appendChild(h('span', { class: 'tk-' + cls }, s));
  while ((m = XML_TOKEN.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) add('com', m[1]);
    else if (m[2]) add('str', m[2]);
    else if (m[3]) add('null', m[3]);
    else if (m[4]) { add('punc', m[4]); add('key', m[5]); }
    else if (m[6]) { add('bool', m[6]); frag.appendChild(document.createTextNode(m[7])); add('str', m[8]); }
    else if (m[9]) add('punc', m[9]);
    last = XML_TOKEN.lastIndex;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

/* ---------- key/value table (headers, query params, form fields) ---------- */
/** kvEditor({ rows:[{key,value,on}], keyPlaceholder, valuePlaceholder, onChange }) → {el, get():[{key,value}], set(rows)} */
export function kvEditor(opts = {}) {
  const list = h('div', { class: 'dt-kv-list' });
  const el = h('div', { class: 'dt-kv' }, list, btn('+ Add row', () => { addRow(); changed(); }, 'dt-mini dt-kv-add'));
  const changed = () => opts.onChange && opts.onChange();
  function addRow(r = {}) {
    const on = h('input', { type: 'checkbox', checked: r.on !== false, attrs: { 'aria-label': 'Enabled' } });
    const k = h('input', { class: 'dt-input', value: r.key || '', placeholder: opts.keyPlaceholder || 'Key', attrs: { 'aria-label': opts.keyPlaceholder || 'Key', spellcheck: 'false' } });
    const v = h('input', { class: 'dt-input', value: r.value || '', placeholder: opts.valuePlaceholder || 'Value', attrs: { 'aria-label': opts.valuePlaceholder || 'Value', spellcheck: 'false' } });
    const row = h('div', { class: 'dt-kv-row' }, on, k, v, h('button', { type: 'button', class: 'dt-kv-del', attrs: { 'aria-label': 'Remove row', title: 'Remove' }, on: { click: () => { row.remove(); changed(); } } }, '×'));
    for (const x of [on, k, v]) x.addEventListener('input', changed);
    on.addEventListener('change', changed);
    list.appendChild(row);
    return row;
  }
  const api = {
    el,
    get() {
      return Array.from(list.children).map((row) => {
        const [on, k, v] = row.querySelectorAll('input');
        return { on: on.checked, key: k.value.trim(), value: v.value };
      }).filter((r) => r.on && r.key);
    },
    set(rows) { clear(list); (rows || []).forEach(addRow); if (!rows || !rows.length) addRow(); },
    add: addRow,
  };
  api.set(opts.rows || []);
  return api;
}

/* ---------- workers with timeout (protects the page from runaway work) ---------- */
/**
 * runWorker(url, message, { timeout, type:'module' }) → { promise, cancel }
 * The worker is terminated on timeout or cancel, so a stuck computation can never freeze the tab.
 */
export function runWorker(url, message, { timeout = 5000, type = 'module', onProgress } = {}) {
  const w = new Worker(url, { type });
  let done = false, timer;
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); w.terminate(); fn(v); };
    cancel = () => finish(reject, Object.assign(new Error('Cancelled'), { cancelled: true }));
    w.onmessage = (e) => {
      if (e.data && e.data.progress != null) { if (onProgress) onProgress(e.data.progress); return; }
      if (e.data && e.data.error) finish(reject, Object.assign(new Error(e.data.error), e.data.details || {}));
      else finish(resolve, e.data);
    };
    w.onerror = (e) => { e.preventDefault && e.preventDefault(); finish(reject, new Error(e.message || 'Worker failed')); };
    if (timeout) timer = setTimeout(() => finish(reject, Object.assign(new Error(`Stopped after ${(timeout / 1000).toFixed(1)} s — the operation took too long.`), { timeout: true })), timeout);
    w.postMessage(message);
  });
  return { promise, cancel: () => cancel() };
}

/* ---------- layout helpers ---------- */
export const row = (...c) => h('div', { class: 'dt-row' }, ...c);
export const toolbar = (...c) => h('div', { class: 'dt-toolbar' }, ...c);
export const grid2 = (...c) => h('div', { class: 'dt-grid2' }, ...c);
export const card = (title, ...c) => h('section', { class: 'dt-card' }, title ? h('h3', { class: 'dt-card-title' }, title) : null, ...c);
export const note = (text, cls = '') => h('p', { class: 'dt-note ' + cls }, text);

/** Load a classic (UMD) script once, e.g. loadScript('/assets/vendor/x/x.min.js', 'GlobalName'). */
const scriptCache = new Map();
export function loadScript(src, globalName) {
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  if (!scriptCache.has(src)) {
    scriptCache.set(src, new Promise((resolve, reject) => {
      const s = h('script', { src, async: true });
      s.onload = () => resolve(globalName ? window[globalName] : true);
      s.onerror = () => { scriptCache.delete(src); reject(new Error('Could not load ' + src.split('/').pop() + ' — check your connection and retry.')); };
      document.head.appendChild(s);
    }));
  }
  return scriptCache.get(src);
}
