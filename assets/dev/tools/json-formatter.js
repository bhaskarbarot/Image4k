/* JSON Formatter — format / minify / validate with exact error positions. */
import { h, editor, output, msgBox, seg, checkbox, primary, btn, toolbar, grid2, store, debounce, toast } from '../ui.js';
import { reformat, validateJson, hasUnsafeNumbers, sortKeysDeep } from '../lib/json.js';

const SAMPLE = `{"id":12345678901234567890,"name":"Professional Developer","tags":["free","private","dev-tools"],"active":true,"owner":{"name":"Zoë","languages":["en","hi","gu"],"emoji":"🚀"},"ratio":0.75,"deleted_at":null}`;

export function mount(root) {
  const saved = store.get('json-formatter', { indent: '2', sort: false });
  const input = editor({ label: 'Input JSON', placeholder: 'Paste or type JSON here — or open a .json file', sample: SAMPLE, paste: true, file: { accept: '.json,application/json,text/plain' }, clear: true });
  const out = output({ label: 'Result', download: { name: 'formatted.json', mime: 'application/json' }, empty: 'Formatted JSON will appear here.' });
  const msg = msgBox();
  const status = h('div', { class: 'dt-stats', attrs: { 'aria-live': 'polite' } });
  const indent = seg([['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'Tab']], saved.indent, (v) => { saved.indent = v; store.set('json-formatter', saved); if (out.get()) run('format'); }, 'Indentation');
  const sort = checkbox('Sort keys A→Z', saved.sort, (v) => { saved.sort = v; store.set('json-formatter', saved); if (out.get()) run('format'); });

  function showError(e, src) {
    out.set('');
    msg.error(`Invalid JSON — ${e.message}`, `Line ${e.line}, column ${e.col}` + contextLine(src, e.line, e.col));
    status.replaceChildren(h('span', { class: 'dt-badge is-err' }, '✕ Invalid'), h('button', {
      type: 'button', class: 'dt-mini', on: { click: () => { input.ta.focus(); input.ta.setSelectionRange(e.pos, Math.min(e.pos + 1, src.length)); } },
    }, `Go to line ${e.line}:${e.col}`));
  }
  function contextLine(src, line, col) {
    const l = src.split('\n')[line - 1] ?? '';
    if (l.length > 160) return '';
    return '\n' + l + '\n' + ' '.repeat(Math.max(0, col - 1)) + '^';
  }
  function showStats(stats, src) {
    status.replaceChildren(
      h('span', { class: 'dt-badge is-ok' }, '✓ Valid JSON'),
      h('span', { class: 'dt-stat' }, 'Root ', h('b', null, stats.type)),
      h('span', { class: 'dt-stat' }, 'Keys ', h('b', null, stats.keys.toLocaleString())),
      h('span', { class: 'dt-stat' }, 'Values ', h('b', null, stats.values.toLocaleString())),
      h('span', { class: 'dt-stat' }, 'Depth ', h('b', null, String(stats.depth))),
    );
    if (hasUnsafeNumbers(src)) msg.info('Large integers detected', 'Numbers bigger than 2^53 are kept exactly as written by Format and Minify.' + (sort.input.checked ? ' “Sort keys” uses JavaScript numbers, so they may be rounded — turn it off to keep them exact.' : ''));
  }

  function run(mode) {
    const src = input.get();
    msg.hide();
    if (!src.trim()) { out.set(''); status.replaceChildren(); msg.error('Nothing to format — paste some JSON first.'); return; }
    try {
      const ind = mode === 'minify' ? 0 : indent.value === 'tab' ? '\t' : Number(indent.value);
      let r = reformat(src, { indent: ind });
      if (mode === 'validate') { showStats(r.stats, src); msg.ok('Valid JSON', `${r.stats.type} with ${r.stats.keys.toLocaleString()} keys, nesting depth ${r.stats.depth}.`); return; }
      if (sort.input.checked) {
        const sorted = JSON.stringify(sortKeysDeep(JSON.parse(src)), null, ind);
        r = { text: sorted, stats: r.stats };
      }
      out.set(r.text, 'json');
      showStats(r.stats, src);
      if (mode === 'minify') toast(`Minified: ${src.length.toLocaleString()} → ${r.text.length.toLocaleString()} characters`);
    } catch (e) {
      if (e.name === 'JsonError') showError(e, src);
      else { msg.error('Could not process the JSON', e.message); }
    }
  }

  // live validation while typing (cheap: tokenizer only, debounced)
  const live = debounce(() => {
    const src = input.get();
    if (!src.trim()) { status.replaceChildren(); msg.hide(); return; }
    if (src.length > 5e6) return; // big docs: validate on demand only
    const v = validateJson(src);
    if (v.ok) { msg.hide(); showStats(v.stats, src); } else status.replaceChildren(h('span', { class: 'dt-badge is-err' }, '✕ ' + v.error.message), h('button', {
      type: 'button', class: 'dt-mini', on: { click: () => { input.ta.focus(); input.ta.setSelectionRange(v.error.pos, Math.min(v.error.pos + 1, src.length)); } },
    }, `Line ${v.error.line}:${v.error.col}`));
  }, 300);
  input.ta.addEventListener('input', live);
  input.ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run('format'); } });

  root.append(
    toolbar(
      primary('Format', () => run('format'), { 'data-act': 'format' }),
      btn('Minify', () => run('minify'), undefined, { 'data-act': 'minify' }),
      btn('Validate', () => run('validate'), undefined, { 'data-act': 'validate' }),
      indent, sort,
    ),
    status,
    msg.el,
    grid2(input.el, out.el),
    h('p', { class: 'dt-note' }, 'Tip: Ctrl+Enter formats. Numbers, key order and escapes are preserved exactly; everything runs in your browser — nothing is uploaded.'),
  );
  return () => live.cancel();
}
