/* REST API Tester — real HTTP requests, direct from the browser or through the secure proxy. */
import { h, clear, select, input, editor, seg, tabs, kvEditor, btn, primary, msgBox, toolbar, copyText, store, toast, debounce, field } from '../ui.js';
import { METHODS, prepare, send, paramsFromUrl, toCurl, redactModel, HttpToolError } from '../lib/http.js';
import { reformat, validateJson } from '../lib/json.js';
import { sendViaControl, responseView } from './_http-ui.js';

const HISTORY_KEY = 'rest-history';

export function mount(root) {
  const method = select(METHODS, 'GET');
  method.classList.add('api-method');
  method.setAttribute('aria-label', 'HTTP method');
  const url = input({ placeholder: 'https://api.example.com/v1/users?page=1', attrs: { 'aria-label': 'Request URL', spellcheck: 'false', autocomplete: 'off', inputmode: 'url' } });
  url.classList.add('api-url');
  const sendBtn = primary('Send', () => (inflight ? inflight.abort() : run()), { 'data-act': 'send' });
  const via = sendViaControl('rest-via');
  const timeoutIn = input({ type: 'number', value: '30', attrs: { min: '1', max: '120', step: '1', 'aria-label': 'Timeout in seconds', 'data-field': 'timeout' } });
  timeoutIn.classList.add('api-timeout');
  const timeoutMs = () => Math.min(120, Math.max(1, Number(timeoutIn.value) || 30)) * 1000;
  const formMsg = msgBox();

  // --- Params (two-way sync with the URL's query string) ---
  let syncing = false;
  const params = kvEditor({ keyPlaceholder: 'Parameter', valuePlaceholder: 'Value', onChange: () => { if (syncing) return; syncUrlFromParams(); updateCounts(); } });
  function syncUrlFromParams() {
    const raw = url.value.trim(); if (!raw) return;
    const base = raw.split('#')[0].split('?')[0];
    const qs = new URLSearchParams(params.get().map((p) => [p.key, p.value])).toString();
    syncing = true; url.value = base + (qs ? '?' + qs : ''); syncing = false;
  }
  const syncParamsFromUrl = debounce(() => {
    if (syncing) return;
    const rows = paramsFromUrl(url.value.trim());
    if (rows) { syncing = true; params.set(rows); syncing = false; updateCounts(); }
  }, 250);
  url.addEventListener('input', syncParamsFromUrl);

  // --- Headers ---
  const headers = kvEditor({ keyPlaceholder: 'Header', valuePlaceholder: 'Value', rows: [{ key: 'Accept', value: 'application/json' }], onChange: () => updateCounts() });

  // --- Auth ---
  const authFields = h('div', { class: 'api-auth-fields' });
  const a = {
    token: input({ type: 'password', placeholder: 'Token', attrs: { autocomplete: 'off', spellcheck: 'false' } }),
    user: input({ placeholder: 'Username', attrs: { autocomplete: 'off' } }),
    pass: input({ type: 'password', placeholder: 'Password', attrs: { autocomplete: 'off' } }),
    key: input({ placeholder: 'X-API-Key', value: 'X-API-Key', attrs: { spellcheck: 'false' } }),
    value: input({ type: 'password', placeholder: 'API key value', attrs: { autocomplete: 'off', spellcheck: 'false' } }),
    in: select([['header', 'Header'], ['query', 'Query parameter']], 'header'),
  };
  const authType = seg([['none', 'No auth'], ['bearer', 'Bearer token'], ['basic', 'Basic auth'], ['apikey', 'API key']], 'none', () => renderAuth(), 'Authentication');
  function renderAuth() {
    clear(authFields);
    const t = authType.value;
    if (t === 'bearer') authFields.append(field('Token', a.token, 'Sent as “Authorization: Bearer <token>”.'));
    if (t === 'basic') authFields.append(field('Username', a.user), field('Password', a.pass, 'Sent as “Authorization: Basic base64(user:password)”.'));
    if (t === 'apikey') authFields.append(field('Name', a.key), field('Value', a.value), field('Add to', a.in));
    if (t === 'none') authFields.append(h('p', { class: 'dt-note' }, 'No authentication is added. You can also set an Authorization header yourself in the Headers tab.'));
    updateCounts();
  }
  const authModel = () => ({ type: authType.value, token: a.token.value, user: a.user.value, pass: a.pass.value, key: a.key.value.trim(), value: a.value.value, in: a.in.value });

  // --- Body ---
  const bodyType = seg([['none', 'None'], ['json', 'JSON'], ['text', 'Raw text'], ['urlencoded', 'x-www-form-urlencoded'], ['form', 'form-data']], 'none', () => renderBody(), 'Body type');
  const jsonEd = editor({ label: 'JSON body', placeholder: '{\n  "name": "Ada"\n}', rows: 10, clear: true });
  const jsonStatus = h('span', { class: 'dt-meta' });
  jsonEd.actions.prepend(btn('Format', () => {
    try { jsonEd.set(reformat(jsonEd.get(), { indent: 2 }).text); checkJson(); } catch (e) { checkJson(); }
  }, 'dt-mini'));
  const checkJson = debounce(() => {
    const v = jsonEd.get();
    if (!v.trim()) { jsonStatus.textContent = ''; return; }
    const r = validateJson(v);
    jsonStatus.textContent = r.ok ? '✓ valid JSON' : `✕ ${r.error.message} (line ${r.error.line}:${r.error.col})`;
    jsonStatus.className = 'dt-meta ' + (r.ok ? 'api-ok' : 'api-bad');
  }, 250);
  jsonEd.ta.addEventListener('input', checkJson);
  const textEd = editor({ label: 'Raw body', rows: 10, clear: true });
  const textType = input({ value: 'text/plain;charset=UTF-8', attrs: { 'aria-label': 'Content-Type of raw body', spellcheck: 'false' } });
  const urlenc = kvEditor({ keyPlaceholder: 'Field', valuePlaceholder: 'Value' });
  const formRows = h('div', { class: 'dt-kv-list' });
  const formWrap = h('div', { class: 'dt-kv' }, formRows, btn('+ Add field', () => addFormRow(), 'dt-mini dt-kv-add'));
  function addFormRow(r = {}) {
    const k = input({ placeholder: 'Field', value: r.key || '', attrs: { 'aria-label': 'Field name', spellcheck: 'false' } });
    const kind = select([['text', 'Text'], ['file', 'File']], r.file ? 'file' : 'text');
    const v = input({ placeholder: 'Value', value: r.value || '', attrs: { 'aria-label': 'Field value' } });
    const f = h('input', { type: 'file', class: 'api-file', hidden: true, attrs: { 'aria-label': 'File' } });
    kind.addEventListener('change', () => { v.hidden = kind.value === 'file'; f.hidden = kind.value !== 'file'; });
    const row = h('div', { class: 'api-form-row' }, k, kind, v, f, h('button', { type: 'button', class: 'dt-kv-del', attrs: { 'aria-label': 'Remove field' }, on: { click: () => row.remove() } }, '×'));
    row.get = () => ({ key: k.value.trim(), value: v.value, file: kind.value === 'file' ? f.files[0] || null : null, isFile: kind.value === 'file' });
    formRows.appendChild(row);
  }
  addFormRow();
  const bodyArea = h('div', { class: 'api-body-area' });
  function renderBody() {
    clear(bodyArea);
    const t = bodyType.value;
    if (t === 'none') bodyArea.append(h('p', { class: 'dt-note' }, 'This request has no body.'));
    if (t === 'json') bodyArea.append(jsonEd.el, jsonStatus);
    if (t === 'text') bodyArea.append(field('Content-Type', textType), textEd.el);
    if (t === 'urlencoded') bodyArea.append(urlenc.el);
    if (t === 'form') bodyArea.append(formWrap, h('p', { class: 'dt-note' }, 'Sent as multipart/form-data; the browser generates the boundary. Files up to 1 MB also work through the secure proxy.'));
    if (t !== 'none' && (method.value === 'GET' || method.value === 'HEAD')) bodyArea.append(h('p', { class: 'dt-note is-warn' }, `${method.value} requests cannot carry a body — choose POST, PUT or PATCH to send it.`));
    updateCounts();
  }
  method.addEventListener('change', () => renderBody());
  const bodyModel = () => {
    const t = bodyType.value;
    if (t === 'json') return { type: 'json', text: jsonEd.get() };
    if (t === 'text') return { type: 'text', text: textEd.get(), contentType: textType.value.trim() || 'text/plain' };
    if (t === 'urlencoded') return { type: 'urlencoded', rows: urlenc.get() };
    if (t === 'form') return { type: 'form', rows: Array.from(formRows.children).map((r) => r.get()).filter((r) => r.key && (!r.isFile || r.file)) };
    return { type: 'none' };
  };

  // --- tabs ---
  const panes = { params: h('div', null, params.el, h('p', { class: 'dt-note' }, 'Query parameters stay in sync with the URL.')), headers: headers.el, auth: h('div', null, authType, authFields), body: h('div', null, bodyType, bodyArea) };
  const paneHost = h('div', { class: 'api-pane' });
  const reqTabs = tabs([['params', 'Params'], ['headers', 'Headers'], ['auth', 'Auth'], ['body', 'Body']], 'params', (id) => showPane(id));
  function showPane(id) { clear(paneHost); paneHost.appendChild(panes[id]); }
  function updateCounts() {
    const n = (x) => (x ? ` (${x})` : '');
    reqTabs.setLabel('params', 'Params' + n(params.get().length));
    reqTabs.setLabel('headers', 'Headers' + n(headers.get().length));
    reqTabs.setLabel('auth', 'Auth' + (authType.value !== 'none' ? ' ●' : ''));
    reqTabs.setLabel('body', 'Body' + (bodyType.value !== 'none' ? ' ●' : ''));
  }
  showPane('params'); renderAuth(); renderBody();

  // --- send ---
  const resp = responseView({ downloadName: 'response' });
  let inflight = null;
  const model = () => ({ method: method.value, url: url.value, params: params.get(), headers: headers.get(), auth: authModel(), body: bodyModel() });
  async function run() {
    formMsg.hide();
    let req;
    try {
      const m = model();
      if (m.body.type === 'json' && m.method !== 'GET' && m.method !== 'HEAD' && m.body.text.trim()) {
        const v = validateJson(m.body.text);
        if (!v.ok) throw new HttpToolError(`The JSON body is invalid: ${v.error.message}`, 'bad_body', `Line ${v.error.line}, column ${v.error.col}. Fix it or switch the body type to Raw text.`);
      }
      req = prepare(m);
    } catch (e) { formMsg.error(e.message, e.detail); return; }
    inflight = new AbortController();
    sendBtn.textContent = 'Cancel';
    sendBtn.classList.add('is-cancel');
    resp.busy(via.value === 'proxy' ? 'Sending through the secure proxy…' : 'Sending from your browser…');
    try {
      const r = await send(req, via.value, { signal: inflight.signal, timeoutMs: timeoutMs() });
      resp.show(r, req);
      addHistory();
    } catch (e) {
      resp.error(e instanceof HttpToolError ? e : new HttpToolError(e.message || String(e), 'error'));
    } finally {
      inflight = null;
      sendBtn.textContent = 'Send';
      sendBtn.classList.remove('is-cancel');
    }
  }

  // --- history (secrets are never stored) ---
  const histList = h('ul', { class: 'api-history' });
  const hist = h('details', { class: 'dt-card api-hist' }, h('summary', null, 'History (last 20, stored only in this browser — secrets removed)'), histList,
    btn('Clear history', () => { store.set(HISTORY_KEY, []); renderHistory(); }, 'dt-mini'));
  function addHistory() {
    const list = store.get(HISTORY_KEY, []);
    list.unshift({ at: Date.now(), model: redactModel(model()) });
    store.set(HISTORY_KEY, list.slice(0, 20));
    renderHistory();
  }
  function renderHistory() {
    clear(histList);
    const list = store.get(HISTORY_KEY, []);
    if (!list.length) histList.appendChild(h('li', { class: 'dt-note' }, 'No requests yet.'));
    for (const it of list) {
      histList.appendChild(h('li', null, h('button', { type: 'button', class: 'api-hist-item', on: { click: () => load(it.model) } },
        h('span', { class: 'dt-badge' }, it.model.method), ' ', h('span', { class: 'dt-mono' }, it.model.url), ' ', h('span', { class: 'dt-meta' }, new Date(it.at).toLocaleString()))));
    }
  }
  function load(m) {
    method.value = m.method; url.value = m.url;
    syncing = true; params.set(m.params || []); headers.set(m.headers || []); syncing = false;
    authType.set(m.auth?.type || 'none'); a.key.value = m.auth?.key || 'X-API-Key'; a.user.value = m.auth?.user || ''; a.in.value = m.auth?.in || 'header';
    a.token.value = ''; a.pass.value = ''; a.value.value = '';
    renderAuth();
    const b = m.body || { type: 'none' };
    bodyType.set(b.type);
    if (b.type === 'json') jsonEd.set(b.text || '');
    if (b.type === 'text') { textEd.set(b.text || ''); textType.value = b.contentType || 'text/plain'; }
    if (b.type === 'urlencoded') urlenc.set(b.rows || []);
    if (b.type === 'form') { clear(formRows); (b.rows || []).forEach((r) => addFormRow({ key: r.key, value: r.value })); if (!formRows.children.length) addFormRow(); }
    renderBody();
    if (m.auth && m.auth.type !== 'none') toast('Loaded — re-enter the secret for ' + m.auth.type + ' auth (secrets are never saved).', 'warn', 4000);
  }
  renderHistory();

  const curlBtn = btn('Copy as cURL', (e) => {
    try { copyText(toCurl(prepare(model())), e.currentTarget); } catch (err) { formMsg.error(err.message, err.detail); }
  });
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!inflight) run(); } });
  root.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!inflight) run(); } });

  root.append(
    h('div', { class: 'api-reqline' }, method, url, sendBtn),
    h('div', { class: 'api-subbar' }, curlBtn, h('label', { class: 'api-timeout-field' }, h('span', null, 'Timeout'), timeoutIn, h('small', null, 'sec')), h('span', { class: 'dt-meta api-subhint' }, 'Enter or Ctrl+Enter to send')),
    via.el,
    formMsg.el,
    h('section', { class: 'dt-card' }, reqTabs.el, paneHost),
    resp.el,
    hist,
  );
  url.focus();
  return () => { if (inflight) inflight.abort(); resp.cleanup(); syncParamsFromUrl.cancel(); checkJson.cancel(); };
}
