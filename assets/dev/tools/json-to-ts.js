/* JSON → TypeScript interfaces / types. */
import { h, editor, output, msgBox, seg, checkbox, input as textInput, field, primary, toolbar, grid2, store, debounce } from '../ui.js';
import { parseJson } from '../lib/json.js';
import { jsonToTs } from '../lib/jsonts.js';

const SAMPLE = JSON.stringify({
  id: 42, username: 'asha', email: null, verified: true,
  profile: { displayName: 'Asha Patel', avatarUrl: 'https://example.com/a.png', 'social-links': { github: 'asha' } },
  roles: ['admin', 'editor'],
  orders: [
    { id: 'o1', total: 120.5, items: [{ sku: 'A1', qty: 2 }], coupon: 'NEW10' },
    { id: 'o2', total: 99, items: [], shippedAt: '2026-11-01T10:00:00Z' },
  ],
  scores: [1, 'n/a', 3],
}, null, 2);

export function mount(root) {
  const s = store.get('json-to-ts', { rootName: 'Root', kind: 'interface', exported: true, readonly: false });
  const save = () => store.set('json-to-ts', s);
  const msg = msgBox();
  const src = editor({ label: 'Input JSON', placeholder: 'Paste a JSON sample (an API response, a config…)', sample: SAMPLE, paste: true, clear: true, file: { accept: '.json,application/json,text/plain' } });
  const out = output({ label: 'TypeScript', download: { name: 'types.ts', mime: 'text/plain;charset=utf-8' }, empty: 'TypeScript declarations will appear here.' });
  const name = textInput({ value: s.rootName, placeholder: 'Root', attrs: { 'aria-label': 'Root type name', spellcheck: 'false' } });
  const kind = seg([['interface', 'interface'], ['type', 'type']], s.kind, (v) => { s.kind = v; save(); auto(); }, 'Declaration kind');
  const exp = checkbox('export', s.exported, (v) => { s.exported = v; save(); auto(); });
  const ro = checkbox('readonly', s.readonly, (v) => { s.readonly = v; save(); auto(); });
  name.addEventListener('input', () => { s.rootName = name.value; save(); auto(); });

  function run(quiet) {
    const text = src.get();
    msg.hide();
    if (!text.trim()) { out.set(''); if (!quiet) msg.error('Nothing to convert — paste some JSON first.'); return; }
    try {
      const value = parseJson(text);
      const ts = jsonToTs(value, { rootName: name.value.trim() || 'Root', useType: s.kind === 'type', exported: s.exported, readonly: s.readonly });
      out.set(ts);
      const count = (ts.match(/^(export )?(interface|type) /gm) || []).length;
      if (!quiet) msg.ok(`Generated ${count} declaration${count === 1 ? '' : 's'}`, 'Optional (?) = missing from some array items · | null = null seen in the sample. Types are inferred from this sample only — check fields the sample does not show.');
    } catch (e) {
      out.set('');
      msg.error('Invalid JSON — ' + (e.reason || e.message), e.line ? `Line ${e.line}, column ${e.col}` : '');
    }
  }
  const auto = debounce(() => { if (src.get().trim() && src.get().length < 2e6) run(true); }, 350);
  src.ta.addEventListener('input', auto);
  root.append(
    toolbar(primary('Generate', () => run(false), { 'data-act': 'generate' }), field('Root name', name), kind, exp, ro),
    msg.el,
    grid2(src.el, out.el),
    h('p', { class: 'dt-note' }, 'Nested objects get their own named declarations (array items are singularized: users → User); identical shapes are shared; keys that are not valid identifiers are quoted. Runs in your browser.'),
  );
  return () => auto.cancel();
}
