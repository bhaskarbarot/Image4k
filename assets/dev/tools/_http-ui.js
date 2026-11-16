/* Shared UI pieces for the network tools (REST tester, GraphQL, header checker). Not a tool itself. */
import { h, clear, output, msgBox, seg, tabs, formatBytes, download, store } from '../ui.js';
import { decodeText, isProbablyText, kindOf, hexDump, statusClass } from '../lib/http.js';
import { reformat } from '../lib/json.js';
import { formatXml } from '../lib/xml.js';

/** “Send via: Direct | Secure proxy” with a plain explanation of the difference. */
export function sendViaControl(storeKey) {
  const saved = store.get(storeKey, 'direct');
  const info = h('p', { class: 'dt-note api-via-note' });
  const explain = (v) => {
    info.textContent = v === 'proxy'
      ? 'Secure proxy: our server (a Cloudflare function) makes the request for you, so CORS does not apply and every response header is visible. Only public internet addresses are allowed; the request passes through our server but is never stored or logged. Limits: 15 s, 1 MB request, 5 MB response, 60 requests/min.'
      : 'Direct: your browser sends the request itself — nothing touches our servers. The API must allow this website via CORS, and browsers only expose CORS-safelisted response headers. Works with http://localhost APIs.';
  };
  const control = seg([['direct', 'Direct (browser)'], ['proxy', 'Secure proxy']], saved, (v) => { store.set(storeKey, v); explain(v); }, 'Send via');
  explain(saved);
  return { el: h('div', { class: 'api-via' }, h('span', { class: 'dt-label' }, 'Send via'), control, info), get value() { return control.value; }, set: (v) => { control.set(v); explain(v); } };
}

export function headersTable(rows, empty = 'No headers.') {
  if (!rows.length) return h('p', { class: 'dt-note' }, empty);
  return h('div', { class: 'dt-table-wrap' }, h('table', { class: 'dt-table' },
    h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Value'))),
    h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', { class: 'mono' }, k), h('td', { class: 'mono' }, v))))));
}

/** Response viewer: status line + Body / Headers tabs. */
export function responseView({ downloadName = 'response' } = {}) {
  const msg = msgBox();
  const statusLine = h('div', { class: 'api-status', attrs: { 'aria-live': 'polite' } });
  const out = output({ label: 'Body', empty: 'Send a request to see the response.', download: () => ({ name: fileName(), mime: last?.contentType || 'application/octet-stream' }) });
  const preview = h('div', { class: 'api-preview', hidden: true });
  const headWrap = h('div', { class: 'api-headers', hidden: true });
  const modeSeg = seg([['pretty', 'Pretty'], ['raw', 'Raw']], 'pretty', () => renderBody(), 'Body view');
  const t = tabs([['body', 'Body'], ['headers', 'Headers']], 'body', (id) => { bodyWrap.hidden = id !== 'body'; headWrap.hidden = id !== 'headers'; });
  const bodyWrap = h('div', { class: 'api-body' }, h('div', { class: 'dt-toolbar' }, modeSeg), preview, out.el);
  const el = h('section', { class: 'dt-card api-response' },
    h('div', { class: 'api-response-head' }, h('h3', { class: 'dt-card-title' }, 'Response'), statusLine),
    msg.el, t.el, bodyWrap, headWrap);
  let last = null, previewUrl = null;

  function fileName() {
    const ct = last?.contentType || '';
    const ext = /json/.test(ct) ? 'json' : /xml/.test(ct) ? 'xml' : /html/.test(ct) ? 'html' : /csv/.test(ct) ? 'csv' : /png/.test(ct) ? 'png' : /jpe?g/.test(ct) ? 'jpg' : /gif/.test(ct) ? 'gif' : /webp/.test(ct) ? 'webp' : /svg/.test(ct) ? 'svg' : /pdf/.test(ct) ? 'pdf' : /text/.test(ct) ? 'txt' : 'bin';
    return `${downloadName}.${ext}`;
  }
  function renderBody() {
    if (!last) return;
    const r = last;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    clear(preview); preview.hidden = true;
    if (/^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)/i.test(r.contentType) && r.bytes.length) {
      previewUrl = URL.createObjectURL(new Blob([r.bytes], { type: r.contentType }));
      preview.appendChild(h('img', { src: previewUrl, alt: 'Image returned by the API' }));
      preview.hidden = false;
    }
    if (!r.bytes.length) { out.set(''); out.pre.querySelector('code').textContent = r.method === 'HEAD' ? '(HEAD requests have no body)' : '(empty body)'; return; }
    if (!isProbablyText(r.bytes, r.contentType)) { out.set(hexDump(r.bytes)); return; }
    const text = decodeText(r.bytes);
    if (modeSeg.value === 'raw') { out.set(text); return; }
    const kind = kindOf(r.contentType, text);
    try {
      if (kind === 'json') { out.set(reformat(text, { indent: 2 }).text, 'json'); return; }
      if (kind === 'xml') { out.set(formatXml(text, { indent: 2 }), 'xml'); return; }
    } catch (e) { /* not well-formed → show as is */ }
    out.set(text);
  }
  // Downloading must give the exact bytes (binary included), not the pretty text.
  out.actions.lastChild.replaceWith(h('button', { type: 'button', class: 'dt-mini', on: { click: () => {
    if (!last) return;
    download(fileName(), new Blob([last.bytes], { type: last.contentType || 'application/octet-stream' }));
  } } }, 'Download'));

  return {
    el,
    show(r, req) {
      last = { ...r, method: req?.method };
      msg.hide();
      clear(statusLine);
      statusLine.append(
        h('span', { class: 'dt-badge ' + statusClass(r.status), dataset: { status: String(r.status) } }, `${r.status} ${r.statusText || ''}`.trim()),
        h('span', { class: 'dt-stat' }, 'Time ', h('b', null, r.timeMs + ' ms')),
        h('span', { class: 'dt-stat' }, 'Size ', h('b', null, formatBytes(r.size) + (r.truncated ? ' (truncated)' : ''))),
        h('span', { class: 'dt-badge ' + (r.via === 'proxy' ? 'is-info' : '') }, r.via === 'proxy' ? 'via secure proxy' : 'direct from your browser'),
      );
      if (r.status >= 400) msg.warn(`The server answered with HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}.`, r.status >= 500 ? 'A 5xx status means the server failed while handling the request.' : 'A 4xx status usually means the request itself was not accepted (URL, auth, body or method).');
      if (r.redirects?.length) statusLine.append(h('span', { class: 'dt-stat' }, 'Redirects ', h('b', null, String(r.redirects.length))));
      if (r.truncated) msg.warn('Response truncated at 5 MB by the proxy.');
      clear(headWrap);
      headWrap.append(headersTable(r.headers.map(([k, v]) => [k, v]), 'No headers were readable.'));
      if (r.redirects?.length) headWrap.append(h('h4', { class: 'api-sub' }, 'Redirect chain'), h('ol', { class: 'api-chain' }, r.redirects.map((x) => h('li', null, h('span', { class: 'dt-badge is-warn' }, String(x.status)), ' → ', h('span', { class: 'dt-mono' }, x.location)))));
      if (r.via === 'direct') headWrap.append(h('p', { class: 'dt-note' }, 'Direct mode: browsers only reveal CORS-safelisted headers (Cache-Control, Content-Language, Content-Length, Content-Type, Expires, Last-Modified, Pragma) plus any listed in the API\'s Access-Control-Expose-Headers. Use Secure proxy to see all headers.'));
      t.setLabel('headers', `Headers (${r.headers.length})`);
      renderBody();
    },
    error(err) {
      last = null;
      clear(statusLine);
      statusLine.append(h('span', { class: 'dt-badge is-err' }, err.code === 'timeout' ? 'Timed out' : err.code === 'cancelled' ? 'Cancelled' : 'No response'));
      out.set('');
      clear(headWrap);
      t.setLabel('headers', 'Headers');
      if (err.code === 'cancelled') msg.info(err.message);
      else msg.error(err.message, err.detail);
    },
    busy(text = 'Sending…') { clear(statusLine); statusLine.append(h('span', { class: 'api-spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'dt-meta' }, text)); msg.hide(); },
    get last() { return last; },
    cleanup() { if (previewUrl) URL.revokeObjectURL(previewUrl); },
  };
}
