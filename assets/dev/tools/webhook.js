/* Webhook Tester — a real temporary URL (Cloudflare Pages Function + D1) that records incoming requests. */
import { h, clear, btn, primary, msgBox, toolbar, tabs, seg, output, copyText, store, toast, formatBytes } from '../ui.js';
import { reformat } from '../lib/json.js';
import { hexDump, kindOf } from '../lib/http.js';
import { headersTable } from './_http-ui.js';

const KEY = 'webhook-endpoint';
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

async function api(path, { method = 'GET', token } = {}) {
  let res;
  try {
    res = await fetch(path, { method, headers: token ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store' });
  } catch (e) { throw Object.assign(new Error('Network error — check your connection.'), { code: 'network' }); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  if (!res.ok || !data || data.ok === false) {
    const err = new Error(data?.error || (res.status === 404 && !data ? 'The webhook backend is not available on this deployment.' : `HTTP ${res.status}`));
    err.code = data?.code || (res.status === 404 && !data ? 'backend_missing' : 'http_' + res.status); err.status = res.status;
    throw err;
  }
  return data;
}

function bodyBytes(r) {
  if (r.bodyEncoding === 'base64') { const s = atob(r.body); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  return new TextEncoder().encode(r.body || '');
}

export function mount(root) {
  const msg = msgBox();
  const top = h('div', { class: 'wh-top' });
  const live = h('span', { class: 'wh-live', attrs: { 'aria-live': 'polite' } });
  const list = h('div', { class: 'wh-list', attrs: { role: 'listbox', 'aria-label': 'Received requests' } });
  const detail = h('div', { class: 'wh-detail' });
  const workspace = h('div', { class: 'wh-grid', hidden: true }, h('section', { class: 'dt-card wh-list-card' }, h('div', { class: 'wh-list-head' }, h('h3', { class: 'dt-card-title' }, 'Requests'), live), list), h('section', { class: 'dt-card' }, detail));
  let ep = store.get(KEY, null);
  let requests = [], selected = null, lastId = 0, timer = null, failures = 0, stopped = false, countdown = null;

  function save() { store.set(KEY, ep); }
  function renderTop() {
    clear(top);
    if (!ep) {
      top.append(h('div', { class: 'dt-card wh-empty' },
        h('p', null, 'Create a temporary URL, point your app or a service (Stripe, GitHub, Shopify, Slack…) at it, and watch every request arrive here in real time — method, headers, query and body.'),
        toolbar(primary('Create webhook URL', create, { 'data-act': 'create' })),
        h('p', { class: 'dt-note' }, 'The URL is random and unguessable. Requests are stored for up to 24 h of inactivity (max 7 days), newest 100 kept, bodies up to 1 MB accepted (first 256 KB stored). Only you can read them — the access token stays in this browser. Do not send real secrets or personal data to a test URL.')));
      workspace.hidden = true;
      return;
    }
    const urlBox = h('input', { class: 'dt-input wh-url', value: ep.url, readOnly: true, attrs: { 'aria-label': 'Your webhook URL', spellcheck: 'false' } });
    urlBox.addEventListener('focus', () => urlBox.select());
    const exp = h('span', { class: 'dt-meta wh-exp' });
    const tick = () => {
      const ms = ep.expiresAt - Date.now();
      exp.textContent = ms <= 0 ? 'expired' : `expires in ${Math.floor(ms / 3600000)} h ${Math.floor((ms % 3600000) / 60000)} min if unused`;
    };
    tick(); clearInterval(countdown); countdown = setInterval(tick, 30000);
    const exPost = `curl -X POST ${q(ep.url)} -H 'Content-Type: application/json' -d '{"event":"test","id":1}'`;
    const exGet = `curl ${q(ep.url + '?hello=world')}`;
    top.append(h('div', { class: 'dt-card wh-endpoint' },
      h('div', { class: 'dt-label' }, 'Your webhook URL — send any HTTP method to it (sub-paths work too)'),
      h('div', { class: 'wh-url-row' }, urlBox, btn('Copy URL', (e) => copyText(ep.url, e.currentTarget), 'btn btn-primary btn-sm', { 'data-act': 'copy-url' })),
      h('div', { class: 'toolbar dt-toolbar' }, exp,
        btn('Copy example POST (cURL)', (e) => copyText(exPost, e.currentTarget), 'dt-mini'),
        btn('Copy example GET (cURL)', (e) => copyText(exGet, e.currentTarget), 'dt-mini'),
        btn('Clear requests', clearAll, 'dt-mini', { 'data-act': 'clear' }),
        btn('Delete endpoint', del, 'dt-mini', { 'data-act': 'delete' }),
        btn('New URL', async () => { await del(true); create(); }, 'dt-mini')),
      h('pre', { class: 'dt-pre wh-example' }, exPost)));
    workspace.hidden = false;
  }

  async function create() {
    msg.hide();
    try {
      const d = await api('/api/hooks', { method: 'POST' });
      ep = { id: d.id, token: d.token, url: d.url, expiresAt: d.expiresAt };
      save(); requests = []; lastId = 0; selected = null;
      renderTop(); renderList(); renderDetail(); start();
      toast('Webhook URL created — send it a request!');
    } catch (e) { explain(e); }
  }
  async function del(silent) {
    if (!ep) return;
    try { await api(`/api/hooks/${ep.id}`, { method: 'DELETE', token: ep.token }); } catch (e) { if (e.status !== 404 && e.status !== 410) { explain(e); return; } }
    stop(); ep = null; save(); requests = []; selected = null;
    renderTop(); renderList(); renderDetail();
    if (silent !== true) toast('Endpoint deleted — its URL no longer accepts requests.');
  }
  async function clearAll() {
    try { await api(`/api/hooks/${ep.id}/requests`, { method: 'DELETE', token: ep.token }); requests = []; selected = null; renderList(); renderDetail(); toast('Requests cleared'); } catch (e) { explain(e); }
  }
  function explain(e) {
    if (e.code === 'storage_not_configured') msg.warn('The webhook tester is not switched on for this website yet.', 'It needs a small Cloudflare database that the site owner has not connected yet. All other tools work normally.');
    else if (e.code === 'backend_missing') msg.error('The webhook backend is not available here.', 'This feature needs the website\'s server functions (Cloudflare Pages Functions), which are not running on this host.');
    else if (e.code === 'rate_limited') msg.warn(e.message);
    else msg.error(e.message);
  }

  // ---------- polling ----------
  async function poll() {
    timer = null;
    if (!ep || stopped) return;
    if (document.hidden) { live.textContent = '⏸ paused while this tab is hidden'; return; }
    try {
      const d = await api(`/api/hooks/${ep.id}/requests?after=${lastId}`, { token: ep.token });
      failures = 0;
      if (d.endpoint) { ep.expiresAt = d.endpoint.expiresAt; save(); }
      if (d.requests.length) {
        const known = new Set(requests.map((r) => r.id));
        const fresh = d.requests.filter((r) => !known.has(r.id));
        requests = [...fresh, ...requests].sort((a, b) => b.id - a.id).slice(0, 100);
        lastId = Math.max(lastId, ...d.requests.map((r) => r.id));
        if (!selected && requests.length) selected = requests[0].id;
        renderList(); renderDetail();
      }
      live.textContent = '● listening — checks every 2 s';
      live.className = 'wh-live is-on';
      schedule(2000);
    } catch (e) {
      if (e.status === 404 || e.status === 410) {
        stop(); msg.warn(e.status === 410 ? 'This webhook URL has expired.' : 'This webhook URL no longer exists.', 'Create a new one to keep testing.');
        ep = null; save(); renderTop(); return;
      }
      if (e.code === 'storage_not_configured') { stop(); explain(e); return; }
      failures++;
      const wait = Math.min(30000, 2000 * 2 ** failures);
      live.textContent = `⚠ connection problem — retrying in ${Math.round(wait / 1000)} s`;
      live.className = 'wh-live is-warn';
      schedule(wait);
    }
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }
  function start() { stopped = false; schedule(0); }
  function stop() { stopped = true; clearTimeout(timer); timer = null; live.textContent = ''; clearInterval(countdown); }
  const onVis = () => { if (!document.hidden && ep && !stopped) schedule(0); };
  document.addEventListener('visibilitychange', onVis);

  // ---------- list & detail ----------
  function renderList() {
    clear(list);
    if (!requests.length) { list.appendChild(h('p', { class: 'dt-note wh-wait' }, 'Waiting for the first request… send one with the example cURL command above.')); return; }
    for (const r of requests) {
      const item = h('button', { type: 'button', class: 'wh-item' + (r.id === selected ? ' is-active' : ''), attrs: { role: 'option', 'aria-selected': r.id === selected }, dataset: { id: String(r.id) }, on: { click: () => { selected = r.id; renderList(); renderDetail(); } } },
        h('span', { class: 'dt-badge wh-m-' + r.method.toLowerCase() }, r.method),
        h('span', { class: 'wh-item-path dt-mono' }, (r.path === '/' ? '' : r.path) + (r.query || '') || '/'),
        h('span', { class: 'dt-meta' }, new Date(r.receivedAt).toLocaleTimeString() + ' · ' + formatBytes(r.size)));
      list.appendChild(item);
    }
  }
  const bodyOut = output({ label: 'Body', empty: '(empty body)' });
  const bodyMode = seg([['pretty', 'Pretty'], ['raw', 'Raw'], ['hex', 'Hex']], 'pretty', () => renderDetail(), 'Body view');
  let detailTab = 'body';
  function renderDetail() {
    clear(detail);
    const r = requests.find((x) => x.id === selected);
    if (!r) { detail.appendChild(h('p', { class: 'dt-note' }, requests.length ? 'Select a request to inspect it.' : 'Request details will appear here.')); return; }
    const bytes = bodyBytes(r);
    const text = r.bodyEncoding === 'text' ? r.body : null;
    let shown = '';
    if (bodyMode.value === 'hex' || text == null) shown = bytes.length ? hexDump(bytes, 64 * 1024) : '';
    else if (bodyMode.value === 'raw') shown = text;
    else {
      shown = text;
      if (kindOf(r.contentType, text) === 'json') { try { shown = reformat(text, { indent: 2 }).text; } catch (e) { /* show raw */ } }
    }
    bodyOut.set(shown, bodyMode.value === 'pretty' && shown !== text ? 'json' : undefined);
    const queryRows = [...new URLSearchParams(r.query || '')];
    const t = tabs([['body', 'Body'], ['headers', `Headers (${r.headers.length})`], ['query', `Query (${queryRows.length})`]], detailTab, (id) => { detailTab = id; renderDetail(); });
    const panes = {
      body: h('div', null, h('div', { class: 'dt-toolbar' }, bodyMode,
        r.truncated ? h('span', { class: 'dt-badge is-warn' }, `stored first ${formatBytes(bytes.length)} of ${formatBytes(r.size)}`) : null,
        r.bodyEncoding === 'base64' ? h('span', { class: 'dt-badge is-info' }, 'binary body') : null), bodyOut.el),
      headers: headersTable(r.headers),
      query: headersTable(queryRows, 'No query parameters.'),
    };
    const replay = () => {
      const parts = ['curl', '-X', r.method, q(ep ? ep.url + (r.path === '/' ? '' : r.path) + (r.query || '') : r.path)];
      for (const [k, v] of r.headers) if (!/^(host|content-length|connection|accept-encoding)$/i.test(k)) parts.push('-H', q(`${k}: ${v}`));
      if (text) parts.push('--data-raw', q(text));
      else if (bytes.length) parts.push('--data-binary', '@body.bin');
      return parts.join(' ');
    };
    detail.append(
      h('div', { class: 'wh-detail-head' },
        h('span', { class: 'dt-badge wh-m-' + r.method.toLowerCase() }, r.method),
        h('span', { class: 'dt-mono' }, r.path + (r.query || '')),
        h('span', { class: 'dt-meta' }, new Date(r.receivedAt).toLocaleString() + ' · ' + formatBytes(r.size) + (r.contentType ? ' · ' + r.contentType : '') + (r.ip ? ' · from ' + r.ip : ''))),
      toolbar(btn('Copy body', (e) => copyText(text ?? hexDump(bytes, 64 * 1024), e.currentTarget), 'dt-mini'), btn('Copy as cURL (replay)', (e) => copyText(replay(), e.currentTarget), 'dt-mini')),
      t.el, panes[detailTab]);
  }

  root.append(msg.el, top, workspace,
    h('p', { class: 'dt-privacy' }, 'Server-side tool: incoming requests are received and stored by this website (Cloudflare) so you can see them. Everything is deleted when you delete the endpoint or after it expires.'));
  renderTop(); renderList(); renderDetail();
  if (ep) start();
  return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
}
