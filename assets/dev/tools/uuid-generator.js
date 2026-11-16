/* UUID Generator — RFC 9562 v4 / v7, bulk, formatting, inspector. */
import { h, output, seg, checkbox, primary, btn, toolbar, store, toast, copyText, card, note, clear, field, debounce } from '../ui.js';
import { generate, formatUuid, inspectUuid } from '../lib/uuid.js';

const LIST_MAX = 50;

export function mount(root) {
  const st = store.get('uuid-generator', { version: '4', count: 5, upper: false, hyphens: true, braces: false });
  const save = () => store.set('uuid-generator', st);
  let ids = [];

  const ver = seg([['4', 'v4 · random'], ['7', 'v7 · time-ordered']], st.version, (v) => { st.version = v; save(); gen(); }, 'UUID version');
  const count = h('input', { type: 'number', class: 'dt-input uuid-count', min: '1', max: '10000', value: String(st.count), attrs: { 'aria-label': 'How many' } });
  const upper = checkbox('UPPERCASE', st.upper, (v) => { st.upper = v; save(); render(); });
  const hyph = checkbox('Hyphens', st.hyphens, (v) => { st.hyphens = v; save(); render(); });
  const braces = checkbox('{Braces}', st.braces, (v) => { st.braces = v; save(); render(); });
  const list = h('ol', { class: 'uuid-list' });
  const out = output({ label: 'All UUIDs', download: () => ({ name: `uuid-v${st.version}-${ids.length}.txt` }), empty: 'Click Generate.' });
  const verDesc = h('p', { class: 'dt-note' });

  function gen() {
    let n = Math.floor(Number(count.value));
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > 10000) { n = 10000; toast('Maximum is 10 000 per batch', 'warn'); }
    count.value = String(n); st.count = n; save();
    ids = generate(Number(st.version), n);
    render();
  }
  const fmt = (u) => formatUuid(u, { upper: upper.input.checked, hyphens: hyph.input.checked, braces: braces.input.checked });
  function render() {
    verDesc.textContent = st.version === '7'
      ? 'v7 embeds a millisecond Unix timestamp, so IDs sort by creation time — ideal for database primary keys (better index locality than v4).'
      : 'v4 is 122 bits of cryptographically secure randomness — the general-purpose choice.';
    clear(list);
    const shown = ids.slice(0, LIST_MAX).map(fmt);
    shown.forEach((u) => list.appendChild(h('li', null, h('code', { class: 'dt-mono' }, u), btn('Copy', (e) => copyText(u, e.currentTarget), 'dt-mini'))));
    if (ids.length > LIST_MAX) list.appendChild(h('li', { class: 'uuid-more' }, `…and ${(ids.length - LIST_MAX).toLocaleString()} more — use Copy all or Download.`));
    out.set(ids.map(fmt).join('\n'));
  }
  count.addEventListener('keydown', (e) => { if (e.key === 'Enter') gen(); });

  /* ---- inspector ---- */
  const insIn = h('input', { class: 'dt-input uuid-ins', placeholder: 'Paste a UUID to inspect (any case, with or without hyphens/braces)', attrs: { 'aria-label': 'UUID to inspect', spellcheck: 'false' } });
  const insOut = h('div');
  function inspect() {
    clear(insOut);
    const v = insIn.value.trim();
    if (!v) return;
    const r = inspectUuid(v);
    if (!r.valid) { insOut.appendChild(h('div', { class: 'dt-msg is-err' }, r.error)); return; }
    const rows = [['Canonical', r.canonical], ['Version', r.special ? r.variant : `${r.version} — ${r.versionName}`], ['Variant', r.variant]];
    if (r.timestamp) rows.push(['Timestamp', `${r.timestamp.toISOString()} (${r.timestamp.toLocaleString()})`]);
    insOut.appendChild(h('div', { class: 'dt-table-wrap' }, h('table', { class: 'dt-table' }, h('tbody', null, rows.map(([k, v2]) => h('tr', null, h('th', { attrs: { scope: 'row' } }, k), h('td', { class: 'mono' }, v2)))))));
    insOut.prepend(h('div', { class: 'dt-msg is-ok uuid-valid' }, '✓ Valid UUID'));
  }
  insIn.addEventListener('input', debounce(inspect, 150));

  root.append(
    toolbar(ver, field('How many (1–10 000)', count), upper, hyph, braces, primary('Generate', gen, { 'data-act': 'generate' }),
      btn('Copy all', (e) => { if (!ids.length) return toast('Generate first', 'err'); copyText(ids.map(fmt).join('\n'), e.currentTarget); }, undefined, { 'data-act': 'copy-all' })),
    verDesc,
    h('div', { class: 'dt-grid2' }, card('UUIDs', list), out.el),
    card('Inspect a UUID', insIn, insOut),
    note('Generated with crypto.getRandomValues in your browser. v7 IDs generated in the same millisecond use a counter, so they are strictly increasing.'),
  );
  gen();
}
