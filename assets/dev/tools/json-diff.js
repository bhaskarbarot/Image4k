/* JSON Diff — structural comparison with JSON paths. */
import { h, editor, msgBox, seg, checkbox, input as textInput, field, primary, btn, toolbar, grid2, store, clear, copyText, download, toast } from '../ui.js';
import { parseJson } from '../lib/json.js';
import { diffJson, summarize, preview, toText, toPatch } from '../lib/jsondiff.js';

const LEFT = JSON.stringify({ id: 7, name: 'Asha', plan: 'free', tags: ['a', 'b'], address: { city: 'Ahmedabad', zip: '380001' }, users: [{ id: 1, role: 'admin' }, { id: 2, role: 'viewer' }], legacy: true }, null, 2);
const RIGHT = JSON.stringify({ id: 7, name: 'Asha Patel', plan: 'pro', tags: ['a', 'b', 'c'], address: { city: 'Ahmedabad', zip: 380001 }, users: [{ id: 2, role: 'editor' }, { id: 1, role: 'admin' }], createdAt: '2026-11-16' }, null, 2);
const RENDER_LIMIT = 2000;

export function mount(root) {
  const s = store.get('json-diff', { mode: 'index', key: 'id', show: { added: true, removed: true, changed: true } });
  const save = () => store.set('json-diff', s);
  const msg = msgBox();
  const a = editor({ label: 'Original JSON (A)', placeholder: 'Paste the original JSON', sample: LEFT, paste: true, clear: true, file: { accept: '.json,application/json,text/plain' } });
  const b = editor({ label: 'Changed JSON (B)', placeholder: 'Paste the changed JSON', sample: RIGHT, paste: true, clear: true, file: { accept: '.json,application/json,text/plain' } });
  const keyInput = textInput({ value: s.key, placeholder: 'id', attrs: { 'aria-label': 'Match array items by key', spellcheck: 'false' } });
  const keyField = field('Match key', keyInput);
  const mode = seg([['index', 'Arrays by index'], ['key', 'Match array items by key']], s.mode, (v) => { s.mode = v; save(); keyField.hidden = v !== 'key'; if (last) run(); }, 'Array comparison');
  keyField.hidden = s.mode !== 'key';
  keyInput.addEventListener('change', () => { s.key = keyInput.value.trim(); save(); if (last) run(); });
  const summary = h('div', { class: 'dt-stats', attrs: { 'aria-live': 'polite' } });
  const filters = h('div', { class: 'dt-row jd-filters', hidden: true },
    ...['added', 'removed', 'changed'].map((op) => checkbox(op[0].toUpperCase() + op.slice(1), s.show[op], (v) => { s.show[op] = v; save(); render(); })));
  const list = h('div', { class: 'jd-list', attrs: { 'aria-label': 'Differences' } });
  const actions = h('div', { class: 'dt-toolbar', hidden: true },
    btn('Copy report', (e) => last && copyText(toText(visible()), e.currentTarget), 'dt-mini', { 'data-act': 'copy-text' }),
    btn('Copy as JSON Patch', (e) => last && copyText(JSON.stringify(toPatch(visible()), null, 2), e.currentTarget), 'dt-mini', { 'data-act': 'copy-patch' }),
    btn('Download report', () => last && download('json-diff.txt', toText(visible())), 'dt-mini', { 'data-act': 'download' }));
  let last = null;
  const visible = () => (last || []).filter((c) => s.show[c.op]);

  function parseSide(ed, label) {
    const t = ed.get();
    if (!t.trim()) throw Object.assign(new Error(`${label} is empty — paste JSON on both sides.`), { side: label });
    try { return parseJson(t); } catch (e) { throw Object.assign(e, { side: label }); }
  }
  function run() {
    msg.hide(); last = null; clear(list); summary.replaceChildren(); filters.hidden = true; actions.hidden = true;
    let A, B;
    try { A = parseSide(a, 'Original (A)'); B = parseSide(b, 'Changed (B)'); } catch (e) {
      msg.error(e.line ? `${e.side}: invalid JSON — ${e.reason}` : e.message, e.line ? `Line ${e.line}, column ${e.col}` : '');
      return;
    }
    if (s.mode === 'key' && !keyInput.value.trim()) { msg.error('Enter the key used to match array items (for example id).'); return; }
    last = diffJson(A, B, { arrayKey: s.mode === 'key' ? keyInput.value.trim() : null });
    const st = summarize(last);
    summary.append(
      h('span', { class: 'dt-badge ' + (st.total ? 'is-warn' : 'is-ok') }, st.total ? `${st.total} difference${st.total === 1 ? '' : 's'}` : '✓ Identical'),
      h('span', { class: 'dt-stat jd-s-add' }, 'Added ', h('b', null, String(st.added))),
      h('span', { class: 'dt-stat jd-s-del' }, 'Removed ', h('b', null, String(st.removed))),
      h('span', { class: 'dt-stat jd-s-chg' }, 'Changed ', h('b', null, String(st.changed))),
      st.typeChanged ? h('span', { class: 'dt-stat' }, 'Type changes ', h('b', null, String(st.typeChanged))) : null);
    if (!st.total) { msg.ok('The documents are equal', 'Key order and whitespace are ignored.'); return; }
    filters.hidden = false; actions.hidden = false;
    render();
  }
  function render() {
    clear(list);
    if (!last) return;
    const items = visible();
    if (!items.length) { list.appendChild(h('p', { class: 'dt-note' }, 'No differences match the selected filters.')); return; }
    for (const c of items.slice(0, RENDER_LIMIT)) {
      const sign = c.op === 'added' ? '+' : c.op === 'removed' ? '−' : '~';
      const vals = c.op === 'added' ? [h('ins', { class: 'dt-add jd-val' }, preview(c.new))]
        : c.op === 'removed' ? [h('del', { class: 'dt-del jd-val' }, preview(c.old))]
        : [h('del', { class: 'dt-del jd-val' }, preview(c.old)), h('span', { class: 'jd-arrow', attrs: { 'aria-label': 'changed to' } }, '→'), h('ins', { class: 'dt-add jd-val' }, preview(c.new))];
      list.appendChild(h('div', { class: 'jd-item jd-' + c.op },
        h('span', { class: 'jd-sign', attrs: { 'aria-label': c.op } }, sign),
        h('code', { class: 'jd-path' }, c.path),
        c.typeChanged ? h('span', { class: 'dt-badge is-warn' }, `${c.oldType} → ${c.newType}`) : null,
        h('div', { class: 'jd-vals' }, vals)));
    }
    if (items.length > RENDER_LIMIT) list.appendChild(h('p', { class: 'dt-note' }, `Showing the first ${RENDER_LIMIT.toLocaleString()} of ${items.length.toLocaleString()} differences — copy or download the report for all of them.`));
  }
  function swap() { const t = a.get(); a.set(b.get()); b.set(t); if (last) run(); toast('Swapped A and B'); }

  root.append(
    toolbar(primary('Compare', run, { 'data-act': 'compare' }), btn('⇄ Swap', swap, undefined, { 'data-act': 'swap' }), mode, keyField),
    msg.el,
    grid2(a.el, b.el),
    summary, filters, actions, list,
    h('p', { class: 'dt-note' }, 'Paths use JSONPath-style notation ($.users[0].role). With “match by key”, array items are paired by that key ($.users[id=2]) so re-ordering is not reported as a change. JSON Patch output is exact for index-based comparison. Runs in your browser.'),
  );
}
