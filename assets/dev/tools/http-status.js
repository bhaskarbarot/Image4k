/* HTTP status code reference — searchable, filterable by class, ?code=404 deep links. */
import { h, input, seg, clear, debounce, copyText } from '../ui.js';
import { STATUS_CODES, CLASSES, searchStatus, byCode } from '../lib/httpstatus.js';

export function mount(root) {
  const params = new URLSearchParams(location.search);
  const initial = params.get('code') || '';
  const search = input({ type: 'search', placeholder: 'Search by code, name or problem — e.g. 404, timeout, CORS, rate limit', value: initial, attrs: { 'aria-label': 'Search status codes' } });
  search.classList.add('hs-search');
  const cls = seg([['all', 'All'], ['1', '1xx'], ['2', '2xx'], ['3', '3xx'], ['4', '4xx'], ['5', '5xx']], 'all', () => draw(), 'Status class');
  const count = h('span', { class: 'dt-meta', attrs: { 'aria-live': 'polite' } });
  const list = h('div', { class: 'hs-list' });

  function card(s, open) {
    const status = s.status !== 'official' ? h('span', { class: 'dt-badge ' + (s.status === 'unofficial' ? 'is-warn' : '') }, s.status) : null;
    const det = h('details', { class: 'hs-item hs-c' + s.cls, id: 'code-' + s.code, open: !!open },
      h('summary', null,
        h('span', { class: 'hs-code' }, String(s.code)),
        h('span', { class: 'hs-name' }, s.name),
        status,
        s.cacheable ? h('span', { class: 'dt-badge is-info', title: 'Cacheable by default (heuristic freshness, RFC 9110 §15.1)' }, 'cacheable') : null),
      h('div', { class: 'hs-body' },
        h('p', { class: 'hs-meaning' }, s.meaning),
        s.uses.length ? h('div', null, h('h4', null, 'Common use cases'), h('ul', null, s.uses.map((u) => h('li', null, u)))) : null,
        s.fix.length ? h('div', null, h('h4', null, 'Troubleshooting'), h('ul', null, s.fix.map((u) => h('li', null, u)))) : null,
        h('div', { class: 'hs-foot' },
          h('span', { class: 'dt-note' }, 'Defined in: ', s.ref, ' · Class: ', s.cls + 'xx ' + CLASSES[s.cls].name),
          h('button', { type: 'button', class: 'dt-mini', on: { click: (e) => copyText(`${s.code} ${s.name}`, e.currentTarget) } }, 'Copy'),
          h('button', { type: 'button', class: 'dt-mini', on: { click: (e) => copyText(location.origin + location.pathname + '?code=' + s.code + '#http-status', e.currentTarget) } }, 'Copy link'))));
    return det;
  }

  function draw() {
    clear(list);
    const c = cls.value === 'all' ? null : Number(cls.value);
    const res = searchStatus(search.value, c);
    count.textContent = `${res.length} of ${STATUS_CODES.length} codes`;
    if (!res.length) { list.append(h('p', { class: 'dt-note' }, 'No status code matches your search.')); return; }
    let lastCls = null;
    const exact = /^\d{3}$/.test(search.value.trim()) ? Number(search.value.trim()) : null;
    for (const s of res) {
      if (s.cls !== lastCls) { lastCls = s.cls; list.append(h('h3', { class: 'hs-cls' }, `${s.cls}xx · ${CLASSES[s.cls].name}`, h('span', { class: 'dt-note' }, ' — ' + CLASSES[s.cls].desc))); }
      list.append(card(s, res.length === 1 || s.code === exact));
    }
  }
  search.addEventListener('input', debounce(() => {
    draw();
    // keep the URL shareable when the search is an exact code
    const v = search.value.trim();
    const url = new URL(location.href);
    if (/^\d{3}$/.test(v) && byCode(v)) url.searchParams.set('code', v); else url.searchParams.delete('code');
    history.replaceState(null, '', url);
  }, 150));

  root.append(h('div', { class: 'hs-bar' }, search, cls, count), list,
    h('p', { class: 'dt-note' }, 'Official codes follow the IANA HTTP Status Code Registry (RFC 9110 and related RFCs). Codes marked “unofficial” are used by specific software (nginx, Cloudflare, Laravel…) and are not part of the standard.'));
  draw();
  if (initial && byCode(initial)) setTimeout(() => document.getElementById('code-' + initial)?.scrollIntoView({ block: 'center' }), 50);
}
