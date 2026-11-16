/* URL Encode / Decode + URL breakdown. */
import { h, editor, output, msgBox, seg, select, primary, btn, toolbar, grid2, store, debounce, card, note, copyText, clear } from '../ui.js';
import { urlEncode, urlDecode } from '../lib/encode.js';

export function mount(root) {
  const st = store.get('url-encoder', { dir: 'encode', mode: 'component' });
  const save = () => store.set('url-encoder', st);
  const msg = msgBox();
  const input = editor({ label: 'Input', placeholder: 'Text or URL to encode…', paste: true, clear: true, sample: () => (st.dir === 'encode' ? 'name=Zoë & friends/✓?' : 'https://example.com/search?q=caf%C3%A9%20%26%20cr%C3%A8me&lang=fr') });
  const out = output({ label: 'Output', download: { name: 'url.txt' }, empty: 'The result appears here as you type.' });
  const dir = seg([['encode', 'Encode'], ['decode', 'Decode']], st.dir, (v) => { st.dir = v; save(); refresh(); run(); }, 'Direction');
  const modeSel = select([], st.mode, (v) => { st.mode = v; save(); run(); });
  const modeHint = h('small', { class: 'dt-hint url-hint' });

  function refresh() {
    clear(modeSel);
    const opts = st.dir === 'encode'
      ? [['component', 'Component — encodeURIComponent'], ['uri', 'Full URL — encodeURI'], ['form', 'Form data — spaces as +']]
      : [['component', 'Standard — %XX'], ['form', 'Form data — + means space']];
    for (const [v, l] of opts) modeSel.appendChild(h('option', { value: v }, l));
    if (!opts.some(([v]) => v === st.mode)) st.mode = 'component';
    modeSel.value = st.mode;
    const hints = {
      component: 'Encodes everything except A–Z a–z 0–9 - _ . ~ — use for a single query value or path segment.',
      uri: 'Keeps URL structure (: / ? # & =) and encodes spaces and non-ASCII — use for a whole URL.',
      form: 'application/x-www-form-urlencoded, as HTML forms send it.',
    };
    modeHint.textContent = st.dir === 'encode' ? hints[st.mode] : st.mode === 'form' ? 'Treats + as a space (form data). Standard mode keeps + as a plus sign.' : 'Decodes %XX sequences as UTF-8.';
  }
  modeSel.addEventListener('change', refresh);

  function run() {
    msg.hide();
    const src = input.get();
    if (!src) { out.set(''); breakdown(''); return; }
    try {
      const r = st.dir === 'encode' ? urlEncode(src, st.mode) : urlDecode(src, st.mode);
      out.set(r);
      breakdown(st.dir === 'decode' ? src : looksUrl(src) ? src : r);
    } catch (e) {
      out.set('');
      msg.error(e.reason || e.message, e.pos != null ? `At position ${e.pos + 1}: “${src.slice(Math.max(0, e.pos - 12), e.pos)}⟦${src.slice(e.pos, e.pos + 3)}⟧${src.slice(e.pos + 3, e.pos + 15)}”` : '');
      if (e.pos != null) input.ta.setSelectionRange(e.pos, e.pos + 3);
      breakdown('');
    }
  }
  const looksUrl = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s.trim());
  const live = debounce(run, 200);
  input.ta.addEventListener('input', live);

  /* ---- URL breakdown ---- */
  const urlIn = h('input', { class: 'dt-input url-in', type: 'url', placeholder: 'https://user@api.example.com:8443/v1/items?id=42&tag=a%20b#top', attrs: { 'aria-label': 'URL to analyse', spellcheck: 'false' } });
  const bdOut = h('div', { class: 'url-bd' });
  function breakdown(candidate) {
    if (candidate && looksUrl(candidate) && !urlIn.matches(':focus')) urlIn.value = candidate.trim();
    renderBreakdown();
  }
  function renderBreakdown() {
    clear(bdOut);
    const v = urlIn.value.trim();
    if (!v) { bdOut.appendChild(note('Enter a full URL (with https://) to see its parts and decoded query parameters.')); return; }
    let u;
    try { u = new URL(v); } catch (e) { bdOut.appendChild(h('div', { class: 'dt-msg is-err' }, 'Not a valid absolute URL — include the scheme, e.g. https://')); return; }
    const row = (k, val, mono = true) => h('tr', null, h('th', { attrs: { scope: 'row' } }, k), h('td', { class: mono ? 'mono' : '' }, val || h('span', { class: 'dt-hint' }, '—')),
      h('td', null, val ? btn('Copy', (e) => copyText(val, e.currentTarget), 'dt-mini') : null));
    const tbl = h('table', { class: 'dt-table' }, h('tbody', null,
      row('Protocol', u.protocol.replace(/:$/, '')), row('Username', u.username), row('Password', u.password ? '••••••' : ''), row('Host', u.hostname),
      row('Port', u.port || (u.protocol === 'https:' ? '443 (default)' : u.protocol === 'http:' ? '80 (default)' : '')), row('Path', safeDecode(u.pathname)),
      row('Query string', u.search), row('Fragment', u.hash ? safeDecode(u.hash.slice(1)) : ''), row('Origin', u.origin)));
    bdOut.appendChild(h('div', { class: 'dt-table-wrap' }, tbl));
    const params = Array.from(u.searchParams);
    if (params.length) {
      bdOut.appendChild(h('h4', { class: 'url-sub' }, `Query parameters (${params.length})`));
      bdOut.appendChild(h('div', { class: 'dt-table-wrap' }, h('table', { class: 'dt-table' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Key'), h('th', null, 'Value (decoded)'))),
        h('tbody', null, params.map(([k, val], i) => h('tr', null, h('td', null, String(i + 1)), h('td', { class: 'mono' }, k), h('td', { class: 'mono' }, val)))))));
    }
  }
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  urlIn.addEventListener('input', debounce(renderBreakdown, 150));

  root.append(
    toolbar(dir, modeSel, primary('Convert', run, { 'data-act': 'run' }), btn('⇄ Swap', () => {
      const o = out.get(); if (!o) return;
      st.dir = st.dir === 'encode' ? 'decode' : 'encode'; save(); dir.set(st.dir); refresh(); input.set(o); run();
    }, undefined, { 'data-act': 'swap' })),
    modeHint,
    msg.el,
    grid2(input.el, out.el),
    card('URL breakdown', urlIn, bdOut),
  );
  refresh();
  renderBreakdown();
  return () => live.cancel();
}
