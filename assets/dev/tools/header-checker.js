/* HTTP Header Checker — fetches a URL's headers through the secure proxy and grades them. */
import { h, clear, input, primary, msgBox, copyText, btn } from '../ui.js';
import { prepare, sendProxy, HttpToolError, statusClass } from '../lib/http.js';
import { gradeHeaders } from '../lib/headers-grade.js';
import { headersTable } from './_http-ui.js';

const ICON = { good: '✓', warn: '!', bad: '✕', info: 'i' };

export function mount(root) {
  const url = input({ placeholder: 'https://example.com', attrs: { 'aria-label': 'URL to check', spellcheck: 'false', inputmode: 'url' } });
  url.classList.add('api-url');
  const go = primary('Check headers', () => run(), { 'data-act': 'check' });
  const msg = msgBox();
  const out = h('div', { class: 'hc-out' });
  let busy = false;

  async function run() {
    if (busy) return;
    msg.hide(); clear(out);
    let req;
    try { req = prepare({ method: 'GET', url: url.value }); } catch (e) { msg.error(e.message, e.detail); return; }
    busy = true; go.textContent = 'Checking…'; go.disabled = true;
    try {
      const r = await sendProxy(req, { followRedirects: true });
      render(r, req.url);
    } catch (e) {
      const err = e instanceof HttpToolError ? e : new HttpToolError(e.message, 'error');
      msg.error(err.message, err.detail);
    } finally { busy = false; go.textContent = 'Check headers'; go.disabled = false; }
  }

  function findingRow(f) {
    return h('li', { class: 'hc-f is-' + f.status },
      h('span', { class: 'hc-ico', attrs: { 'aria-label': f.status } }, ICON[f.status]),
      h('div', null, h('strong', null, f.name), f.value ? h('code', { class: 'hc-val' }, f.value) : h('span', { class: 'dt-meta' }, ' — not set'), h('p', null, f.message)));
  }

  function render(r, requested) {
    const g = gradeHeaders(r.headers, { https: r.finalUrl.startsWith('https:') });
    const raw = r.headers.map(([k, v]) => `${k}: ${v}`).join('\n');
    out.append(
      h('section', { class: 'dt-card hc-summary' },
        h('div', { class: 'hc-grade hc-g-' + g.grade, attrs: { 'aria-label': 'Security grade ' + g.grade } }, g.grade),
        h('div', null,
          h('div', { class: 'dt-toolbar' }, h('span', { class: 'dt-badge ' + statusClass(r.status), dataset: { status: String(r.status) } }, `${r.status} ${r.statusText || ''}`.trim()), h('span', { class: 'dt-stat' }, 'Security score ', h('b', null, g.score + '/100')), h('span', { class: 'dt-stat' }, 'Time ', h('b', null, r.timeMs + ' ms')), h('span', { class: 'dt-stat' }, h('b', null, String(r.headers.length)), ' headers')),
          h('p', { class: 'dt-mono hc-final' }, r.finalUrl),
          r.redirects.length ? h('ol', { class: 'api-chain' }, h('li', null, h('span', { class: 'dt-mono' }, requested)), r.redirects.map((x) => h('li', null, h('span', { class: 'dt-badge is-warn' }, String(x.status)), ' → ', h('span', { class: 'dt-mono' }, x.location)))) : null)),
      h('section', { class: 'dt-card' }, h('h3', { class: 'dt-card-title' }, 'Security headers'), h('ul', { class: 'hc-list' }, g.security.map(findingRow))),
      h('section', { class: 'dt-card' }, h('h3', { class: 'dt-card-title' }, 'Caching'), h('ul', { class: 'hc-list' }, g.cache.map((c) => findingRow({ ...c, status: c.value ? 'info' : 'warn' })))),
      h('section', { class: 'dt-card' }, h('h3', { class: 'dt-card-title' }, 'CORS (cross-origin access)'), h('ul', { class: 'hc-list' }, g.cors.map(findingRow))),
      h('section', { class: 'dt-card' }, h('div', { class: 'wh-list-head' }, h('h3', { class: 'dt-card-title' }, 'All response headers'), btn('Copy all', (e) => copyText(raw, e.currentTarget), 'dt-mini')), headersTable(r.headers)),
    );
  }
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  root.append(
    h('div', { class: 'api-reqline' }, url, go),
    h('p', { class: 'dt-privacy' }, 'Browsers do not let a web page read most response headers of other websites (CORS), so this check runs on our server: a Cloudflare function makes one GET request to the public URL you enter (redirects followed, max 5), returns the headers and stores nothing. Private / internal addresses are refused.'),
    msg.el, out);
  url.focus();
  return () => {};
}
