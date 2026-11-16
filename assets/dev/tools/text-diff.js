/* Text Diff — side-by-side & unified views with word-level highlights. Large inputs are diffed in a worker. */
import { h, editor, msgBox, seg, checkbox, primary, btn, toolbar, grid2, store, clear, copyText, download, toast } from '../ui.js';
import { computeDiff, toUnified, unifiedPatch } from '../lib/textdiff.js';

const WORKER = new URL('../workers/diff.worker.js', import.meta.url);

/** Run one job in a fresh module worker; terminated on completion, timeout or cancel. → { promise, cancel } */
function runWorker(url, message, { timeout = 30000 } = {}) {
  const w = new Worker(url, { type: 'module' });
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); w.terminate(); fn(v); };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('Timed out'), { timeout: true })), timeout);
    cancel = () => finish(reject, Object.assign(new Error('Cancelled'), { cancelled: true }));
    w.onmessage = (e) => (e.data && e.data.error ? finish(reject, new Error(e.data.error)) : finish(resolve, e.data));
    w.onerror = (e) => { if (e.preventDefault) e.preventDefault(); finish(reject, new Error(e.message || 'Worker failed')); };
    w.postMessage(message);
  });
  return { promise, cancel: () => cancel() };
}
const BIG = 150000;          // characters (A+B) above which the diff runs in a worker
const RENDER_ROWS = 4000;    // rows rendered at once (the rest on demand)
const CONTEXT = 3;           // unchanged lines kept around changes when collapsing
const A_SAMPLE = `Bhaskar Solution — release notes
Version 1.4
- Faster image upscaling
- Fixed PDF merge order
Contact: support@example.com
Thanks for using our tools!`;
const B_SAMPLE = `Bhaskar Solution — release notes
Version 1.5
- Faster image upscaling with WebGPU
- Fixed PDF merge order
- New developer tools
Contact: support@example.com
Thanks for using our tools!`;

export function mount(root) {
  const s = store.get('text-diff', { view: 'split', ws: false, ic: false, collapse: true });
  const save = () => store.set('text-diff', s);
  const msg = msgBox();
  const a = editor({ label: 'Original text', placeholder: 'Paste the original text', sample: A_SAMPLE, paste: true, clear: true, file: {} });
  const b = editor({ label: 'Changed text', placeholder: 'Paste the changed text', sample: B_SAMPLE, paste: true, clear: true, file: {} });
  const view = seg([['split', 'Side by side'], ['unified', 'Unified']], s.view, (v) => { s.view = v; save(); render(); }, 'View');
  const ws = checkbox('Ignore whitespace', s.ws, (v) => { s.ws = v; save(); if (last) run(); });
  const ic = checkbox('Ignore case', s.ic, (v) => { s.ic = v; save(); if (last) run(); });
  const collapse = checkbox('Hide unchanged lines', s.collapse, (v) => { s.collapse = v; save(); render(); });
  const stats = h('div', { class: 'dt-stats', attrs: { 'aria-live': 'polite' } });
  const result = h('div', { class: 'td-result', attrs: { 'aria-label': 'Differences' } });
  const busy = h('div', { class: 'td-busy', hidden: true }, h('span', { class: 'td-spin', attrs: { 'aria-hidden': 'true' } }), 'Comparing…', btn('Cancel', () => job && job.cancel(), 'dt-mini'));
  const actions = h('div', { class: 'dt-toolbar', hidden: true },
    btn('Copy unified patch', async (e) => { const p = await patch(); if (p != null) copyText(p, e.currentTarget); }, 'dt-mini', { 'data-act': 'copy-patch' }),
    btn('Download .patch', async () => { const p = await patch(); if (p != null) download('changes.patch', p, 'text/x-diff;charset=utf-8'); }, 'dt-mini', { 'data-act': 'download' }));
  let last = null, job = null, limit = RENDER_ROWS, inputs = null;

  async function patch() {
    if (!inputs) return null;
    if (inputs.a.length + inputs.b.length < BIG) return unifiedPatch(inputs.a, inputs.b);
    try { job = runWorker(WORKER, { op: 'patch', a: inputs.a, b: inputs.b }, { timeout: 30000 }); return (await job.promise).patch; } catch (e) { toast(e.message, 'err'); return null; }
  }

  async function run() {
    const A = a.get(), B = b.get();
    msg.hide(); clear(result); stats.replaceChildren(); actions.hidden = true; last = null; limit = RENDER_ROWS;
    if (!A && !B) { msg.error('Paste text on both sides to compare.'); return; }
    const opts = { ignoreWhitespace: s.ws, ignoreCase: s.ic };
    inputs = { a: A, b: B };
    try {
      if (A.length + B.length >= BIG) {
        busy.hidden = false;
        job = runWorker(WORKER, { op: 'diff', a: A, b: B, opts }, { timeout: 30000 });
        last = await job.promise;
      } else last = computeDiff(A, B, opts);
    } catch (e) {
      busy.hidden = true;
      if (e.cancelled) { msg.info('Comparison cancelled.'); return; }
      msg.error('Could not compare the texts', e.timeout ? 'The texts are too different or too large to compare within 30 seconds.' : e.message);
      return;
    } finally { job = null; }
    busy.hidden = true;
    const st = last.stats;
    stats.append(
      h('span', { class: 'dt-badge ' + (st.identical ? 'is-ok' : 'is-warn') }, st.identical ? '✓ No differences' : 'Differences found'),
      h('span', { class: 'dt-stat td-s-add' }, '+ Added ', h('b', null, st.added.toLocaleString())),
      h('span', { class: 'dt-stat td-s-del' }, '− Removed ', h('b', null, st.removed.toLocaleString())),
      h('span', { class: 'dt-stat td-s-mod' }, '~ Modified ', h('b', null, st.modified.toLocaleString())),
      h('span', { class: 'dt-stat' }, 'Lines ', h('b', null, `${st.linesA.toLocaleString()} → ${st.linesB.toLocaleString()}`)));
    actions.hidden = st.identical;
    if (st.identical && (s.ws || s.ic) && A !== B) msg.info('Equal when ignoring ' + [s.ws && 'whitespace', s.ic && 'case'].filter(Boolean).join(' and '), 'The raw texts still differ — untick the options to see those differences.');
    render();
  }

  const lineText = (side, cls) => {
    const cell = h('span', { class: 'td-text' });
    if (side.parts) for (const p of side.parts) cell.appendChild(p.add ? h('ins', { class: 'dt-add' }, p.v) : p.del ? h('del', { class: 'dt-del' }, p.v) : document.createTextNode(p.v));
    else cell.textContent = side.text;
    if (!side.text) cell.appendChild(h('span', { class: 'td-eol', attrs: { 'aria-hidden': 'true' } }, ' '));
    return cell;
  };
  // Collapse runs of unchanged rows (keeping CONTEXT lines around changes)
  function withFolds(rows, isSame) {
    if (!s.collapse) return rows;
    const out = [];
    let k = 0;
    while (k < rows.length) {
      if (!isSame(rows[k])) { out.push(rows[k++]); continue; }
      let e = k; while (e < rows.length && isSame(rows[e])) e++;
      const runLen = e - k;
      const keepStart = k === 0 ? 0 : CONTEXT, keepEnd = e === rows.length ? 0 : CONTEXT;
      if (runLen > keepStart + keepEnd + 1) {
        out.push(...rows.slice(k, k + keepStart));
        out.push({ fold: runLen - keepStart - keepEnd, from: k + keepStart, to: e - keepEnd });
        out.push(...rows.slice(e - keepEnd, e));
      } else out.push(...rows.slice(k, e));
      k = e;
    }
    return out;
  }
  function render() {
    clear(result);
    if (!last) return;
    if (last.stats.identical && !last.rows.length) return;
    const unified = s.view === 'unified';
    const base = unified ? toUnified(last.rows) : last.rows;
    const rows = withFolds(base, unified ? (r) => r.t === ' ' : (r) => r.t === 'same');
    const table = h('div', { class: 'td-table ' + (unified ? 'is-unified' : 'is-split'), attrs: { role: 'table' } });
    for (const r of rows.slice(0, limit)) {
      if (r.fold) {
        table.appendChild(h('button', { type: 'button', class: 'td-fold', on: { click: () => { s.collapse = false; collapse.input.checked = false; save(); render(); } } }, `⋯ ${r.fold.toLocaleString()} unchanged line${r.fold === 1 ? '' : 's'} — show all`));
        continue;
      }
      if (unified) {
        const cls = r.t === '+' ? 'is-add' : r.t === '-' ? 'is-del' : '';
        table.appendChild(h('div', { class: 'td-row ' + cls, attrs: { role: 'row' } },
          h('span', { class: 'td-n' }, r.o ?? ''), h('span', { class: 'td-n' }, r.n ?? ''), h('span', { class: 'td-sign' }, r.t), lineText(r)));
      } else {
        const lc = r.t === 'del' || r.t === 'mod' ? 'is-del' : '', rc = r.t === 'add' || r.t === 'mod' ? 'is-add' : '';
        table.appendChild(h('div', { class: 'td-row', attrs: { role: 'row' } },
          h('span', { class: 'td-n ' + lc }, r.l ? r.l.n : ''), r.l ? h('span', { class: 'td-cell ' + lc }, lineText(r.l)) : h('span', { class: 'td-cell is-empty' }),
          h('span', { class: 'td-n ' + rc }, r.r ? r.r.n : ''), r.r ? h('span', { class: 'td-cell ' + rc }, lineText(r.r)) : h('span', { class: 'td-cell is-empty' })));
      }
    }
    result.appendChild(table);
    if (rows.length > limit) result.appendChild(btn(`Show ${Math.min(RENDER_ROWS, rows.length - limit).toLocaleString()} more rows (of ${(rows.length - limit).toLocaleString()} remaining)`, () => { limit += RENDER_ROWS; render(); }, 'btn btn-ghost btn-sm td-more'));
  }
  function swap() { const t = a.get(); a.set(b.get()); b.set(t); if (last) run(); }

  root.append(
    toolbar(primary('Compare', run, { 'data-act': 'compare' }), btn('⇄ Swap', swap, undefined, { 'data-act': 'swap' }), view, ws, ic, collapse),
    msg.el,
    grid2(a.el, b.el),
    busy, stats, actions, result,
    h('p', { class: 'dt-note' }, 'Lines are matched with the Myers diff algorithm (jsdiff); changed words inside modified lines are highlighted. The patch is a standard unified diff (git apply / patch compatible). Large texts are compared in a background worker. Nothing is uploaded.'),
  );
  return () => { if (job) job.cancel(); };
}
