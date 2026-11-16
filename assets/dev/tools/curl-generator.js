/* cURL Generator: build a request visually → curl command for bash, PowerShell or CMD. */
import { h, output, msgBox, select, checkbox, seg, field, input, tabs, kvEditor, toolbar, primary, store, debounce, clear, copyText, toast } from '../ui.js';
import { toCurl, buildUrl, SHELLS } from '../lib/curl.js';
import { validateJson } from '../lib/json.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function mount(root) {
  const saved = store.get('curl-generator', { shell: 'bash', multiline: true });
  const msg = msgBox();
  const method = select(METHODS, 'GET', () => update());
  method.setAttribute('aria-label', 'HTTP method');
  const url = input({ type: 'url', placeholder: 'https://api.example.com/v1/users', value: 'https://api.example.com/v1/users', attrs: { 'aria-label': 'URL', spellcheck: 'false' } });
  url.classList.add('cg-url');
  url.addEventListener('input', () => update());

  const params = kvEditor({ keyPlaceholder: 'Parameter', valuePlaceholder: 'Value', onChange: () => update(), rows: [{ key: 'page', value: '1' }] });
  const headers = kvEditor({ keyPlaceholder: 'Header', valuePlaceholder: 'Value', onChange: () => update(), rows: [{ key: 'Accept', value: 'application/json' }] });

  // auth
  const authUser = input({ placeholder: 'Username', attrs: { 'aria-label': 'Username', autocomplete: 'off' } });
  const authPass = input({ type: 'password', placeholder: 'Password', attrs: { 'aria-label': 'Password', autocomplete: 'new-password' } });
  const bearer = input({ placeholder: 'Token', attrs: { 'aria-label': 'Bearer token', autocomplete: 'off', spellcheck: 'false' } });
  const apiKeyName = input({ value: 'X-API-Key', attrs: { 'aria-label': 'API key header name' } });
  const apiKeyVal = input({ placeholder: 'Key', attrs: { 'aria-label': 'API key value', autocomplete: 'off', spellcheck: 'false' } });
  for (const x of [authUser, authPass, bearer, apiKeyName, apiKeyVal]) x.addEventListener('input', () => update());
  const authBox = h('div', { class: 'cg-auth' });
  const authSeg = seg([['none', 'None'], ['bearer', 'Bearer'], ['basic', 'Basic'], ['apikey', 'API key']], 'none', () => { renderAuth(); update(); }, 'Authentication');
  function renderAuth() {
    clear(authBox);
    const v = authSeg.value;
    if (v === 'bearer') authBox.append(field('Bearer token', bearer));
    if (v === 'basic') authBox.append(h('div', { class: 'dt-row' }, field('Username', authUser), field('Password', authPass)));
    if (v === 'apikey') authBox.append(h('div', { class: 'dt-row' }, field('Header name', apiKeyName), field('Key', apiKeyVal)));
    if (v === 'none') authBox.append(h('p', { class: 'dt-note' }, 'No authentication header.'));
  }

  // body
  const bodyText = h('textarea', { class: 'dt-code cg-body', attrs: { rows: 8, spellcheck: 'false', 'aria-label': 'Request body' }, placeholder: '{\n  "name": "Ada"\n}' });
  bodyText.addEventListener('input', () => update());
  const formKv = kvEditor({ keyPlaceholder: 'Field', valuePlaceholder: 'Value', onChange: () => update() });
  const multiKv = kvEditor({ keyPlaceholder: 'Field', valuePlaceholder: 'Value or @path/to/file', onChange: () => update() });
  const bodyBox = h('div', { class: 'cg-bodybox' });
  const bodySeg = seg([['none', 'None'], ['json', 'JSON'], ['raw', 'Text'], ['form', 'Form URL-encoded'], ['multipart', 'Multipart']], 'none', () => { renderBody(); update(); }, 'Body type');
  function renderBody() {
    clear(bodyBox);
    const v = bodySeg.value;
    if (v === 'json' || v === 'raw') bodyBox.append(h('div', { class: 'dt-panel' }, bodyText));
    if (v === 'form') bodyBox.append(formKv.el);
    if (v === 'multipart') bodyBox.append(multiKv.el, h('p', { class: 'dt-note' }, 'Start a value with @ to upload a file, e.g. @photo.jpg or @photo.jpg;type=image/jpeg.'));
    if (v === 'none') bodyBox.append(h('p', { class: 'dt-note' }, 'No request body.'));
  }

  // options
  const optL = checkbox('Follow redirects (-L)', true, () => update());
  const optK = checkbox('Skip TLS verification (-k)', false, () => update());
  const optC = checkbox('Compressed (--compressed)', false, () => update());
  const optV = checkbox('Verbose (-v)', false, () => update());
  const optI = checkbox('Include response headers (-i)', false, () => update());
  const timeout = input({ type: 'number', min: '0', step: '1', placeholder: 'seconds', attrs: { 'aria-label': 'Timeout in seconds' } });
  timeout.addEventListener('input', () => update());

  const panes = {
    params: h('div', { class: 'cg-pane' }, params.el),
    headers: h('div', { class: 'cg-pane' }, headers.el),
    auth: h('div', { class: 'cg-pane' }, authSeg, authBox),
    body: h('div', { class: 'cg-pane' }, bodySeg, bodyBox),
    options: h('div', { class: 'cg-pane cg-opts' }, optL, optK, optC, optV, optI, field('Max time (--max-time)', timeout)),
  };
  const tabBar = tabs([['params', 'Query params'], ['headers', 'Headers'], ['auth', 'Auth'], ['body', 'Body'], ['options', 'Options']], 'params', (id) => showPane(id));
  const paneHost = h('div', { class: 'cg-panes' });
  function showPane(id) { clear(paneHost); paneHost.append(panes[id]); }

  // output
  const shellSeg = seg(SHELLS.map((s) => [s.id, s.name]), saved.shell, (v) => { saved.shell = v; store.set('curl-generator', saved); update(); }, 'Shell');
  const multiline = checkbox('Multi-line', saved.multiline, (v) => { saved.multiline = v; store.set('curl-generator', saved); update(); });
  const out = output({ label: 'curl command', empty: 'Your command will appear here.' });
  const notes = h('ul', { class: 'cc-notes' });

  function spec() {
    const hs = headers.get().map((r) => [r.key, r.value]);
    const a = authSeg.value;
    let auth = null;
    if (a === 'bearer' && bearer.value) hs.push(['Authorization', 'Bearer ' + bearer.value]);
    if (a === 'apikey' && apiKeyName.value.trim()) hs.push([apiKeyName.value.trim(), apiKeyVal.value]);
    if (a === 'basic') auth = { type: 'basic', user: authUser.value, pass: authPass.value };
    let body = null;
    const bt = bodySeg.value;
    if (bt === 'json' || bt === 'raw') body = { type: bt, text: bodyText.value };
    if (bt === 'form') body = { type: 'form', fields: formKv.get().map((r) => [r.key, r.value]) };
    if (bt === 'multipart') body = { type: 'multipart', parts: multiKv.get().map((r) => (r.value.startsWith('@') ? (() => { const [file, ...rest] = r.value.slice(1).split(';type='); return { name: r.key, file, contentType: rest.join(';type=') || null }; })() : { name: r.key, value: r.value })) };
    return {
      method: method.value,
      url: buildUrl(url.value.trim(), params.get().map((r) => [r.key, r.value])),
      headers: hs, auth, body,
      options: { followRedirects: optL.input.checked, insecure: optK.input.checked, compressed: optC.input.checked, verbose: optV.input.checked, include: optI.input.checked, timeout: Number(timeout.value) > 0 ? Number(timeout.value) : null },
    };
  }

  function update() {
    msg.hide();
    const s = spec();
    if (!s.url) { out.set(''); clear(notes); msg.info('Enter a URL to build the command.'); return; }
    if (!/^https?:\/\/[^\s/]+/i.test(s.url)) msg.warn('The URL should start with http:// or https:// and include a host.');
    if (s.body && s.body.type === 'json' && s.body.text.trim()) {
      const v = validateJson(s.body.text);
      if (!v.ok) msg.warn('The JSON body is not valid', v.error.full);
    }
    if (s.method === 'GET' && s.body) msg.warn('GET requests with a body are unusual and many servers ignore the body.');
    if (s.method === 'HEAD' && s.body) msg.warn('HEAD requests cannot have a body — curl -I will not send it.');
    const r = toCurl(s, { shell: shellSeg.value, multiline: multiline.input.checked });
    out.set(r.command);
    clear(notes);
    for (const n of r.notes) notes.appendChild(h('li', null, n));
  }
  const updateSoon = debounce(update, 120);

  renderAuth(); renderBody(); showPane('params');
  root.append(
    h('div', { class: 'cg-request' }, method, url),
    tabBar.el, paneHost,
    h('div', { class: 'cg-outhead' }, shellSeg, multiline),
    msg.el,
    out.el,
    notes,
    toolbar(primary('Copy command', (e) => { if (!out.get()) return toast('Nothing to copy yet', 'err'); copyText(out.get(), e.currentTarget); }, { 'data-act': 'copy-command' })),
    h('p', { class: 'dt-note' }, 'Arguments are quoted for the chosen shell (single quotes for Bash/PowerShell, escaped double quotes for CMD). Secrets you type stay in this page — nothing is sent anywhere.'),
  );
  update();
  return () => updateSoon.cancel();
}
