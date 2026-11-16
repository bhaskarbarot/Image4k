/* JSON ⇄ CSV converter with a table preview. RFC 4180 quoting; handles commas/quotes/newlines in fields. */
import { h, editor, output, msgBox, seg, select, field, checkbox, primary, btn, toolbar, grid2, store, clear } from '../ui.js';
import { parseCsv, csvToJson, jsonToCsv } from '../lib/csv.js';
import { parseJson } from '../lib/json.js';

const CSV_SAMPLE = `id,name,email,city,notes
1,Asha Patel,asha@example.com,Ahmedabad,"Likes ""quotes"", commas"
2,Zoë Müller,zoe@example.de,Berlin,
3,José García,jose@example.es,"Madrid, ES","Line one
line two"`;
const JSON_SAMPLE = JSON.stringify([
  { id: 1, name: 'Asha Patel', email: 'asha@example.com', address: { city: 'Ahmedabad', zip: '380001' }, tags: ['admin', 'ops'] },
  { id: 2, name: 'Zoë Müller', email: 'zoe@example.de', address: { city: 'Berlin' }, active: true },
  { id: 3, name: 'José "Pepe" García', notes: 'Line one\nline two, with comma' },
], null, 2);
const PREVIEW_ROWS = 200;

export function mount(root) {
  const s = store.get('json-csv', { dir: 'j2c', delim: 'auto', header: true, types: true, flatten: true, excel: false });
  const save = () => store.set('json-csv', s);
  const msg = msgBox();
  const input = editor({ label: 'Input', paste: true, clear: true, sample: () => (s.dir === 'c2j' ? CSV_SAMPLE : JSON_SAMPLE), file: { accept: '.csv,.tsv,.txt,.json,text/csv,application/json,text/plain' } });
  const out = output({ label: 'Output', download: () => (s.dir === 'c2j' ? { name: 'converted.json', mime: 'application/json' } : { name: 'converted.csv', mime: 'text/csv;charset=utf-8' }) });
  const preview = h('div', { class: 'dt-table-wrap jc-preview', hidden: true });
  const previewNote = h('p', { class: 'dt-note' });

  const dir = seg([['j2c', 'JSON → CSV'], ['c2j', 'CSV → JSON']], s.dir, (v) => { s.dir = v; save(); labels(); if (input.get().trim()) run(); }, 'Direction');
  const delim = select([['auto', 'Auto-detect'], [',', 'Comma ,'], [';', 'Semicolon ;'], ['tab', 'Tab'], ['|', 'Pipe |']], s.delim, (v) => { s.delim = v; save(); rerun(); });
  const header = checkbox('First row is a header', s.header, (v) => { s.header = v; save(); rerun(); });
  const types = checkbox('Convert numbers, true/false & empty → null', s.types, (v) => { s.types = v; save(); rerun(); });
  const flatten = checkbox('Flatten nested objects (a.b)', s.flatten, (v) => { s.flatten = v; save(); rerun(); });
  const excel = checkbox('Excel-safe (escape = + - @)', s.excel, (v) => { s.excel = v; save(); rerun(); });
  const rerun = () => { if (out.get() || !msg.el.hidden) run(); };

  function labels() {
    const c2j = s.dir === 'c2j';
    input.el.querySelector('.dt-panel-title').textContent = c2j ? 'Input CSV' : 'Input JSON';
    out.el.querySelector('.dt-panel-title').textContent = c2j ? 'JSON output' : 'CSV output';
    input.ta.placeholder = c2j ? 'Paste CSV here — or open a .csv file' : 'Paste a JSON array of objects (or an object) here';
    types.hidden = !c2j; flatten.hidden = c2j; excel.hidden = c2j;
    delim.options[0].textContent = c2j ? 'Auto-detect' : 'Comma , (default)';
  }

  function renderPreview(rows, hasHeader) {
    clear(preview);
    if (!rows.length) { preview.hidden = true; previewNote.textContent = ''; return; }
    const width = Math.max(...rows.slice(0, PREVIEW_ROWS + 1).map((r) => r.length));
    const table = h('table', { class: 'dt-table' });
    const head = hasHeader ? rows[0] : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
    table.appendChild(h('thead', null, h('tr', null, h('th', null, '#'), head.map((c) => h('th', null, c)))));
    const body = h('tbody');
    const dataRows = hasHeader ? rows.slice(1) : rows;
    dataRows.slice(0, PREVIEW_ROWS).forEach((r, i) => {
      body.appendChild(h('tr', null, h('td', { class: 'jc-n' }, String(i + 1)), Array.from({ length: width }, (_, c) => h('td', { class: r[c] === undefined ? 'jc-missing' : '' }, r[c] ?? ''))));
    });
    table.appendChild(body);
    preview.appendChild(table);
    preview.hidden = false;
    previewNote.textContent = `Preview: ${Math.min(PREVIEW_ROWS, dataRows.length).toLocaleString()} of ${dataRows.length.toLocaleString()} rows · ${width} columns.`;
  }

  function run() {
    const src = input.get();
    msg.hide();
    if (!src.trim()) { out.set(''); renderPreview([]); msg.error('Nothing to convert — paste some ' + (s.dir === 'c2j' ? 'CSV' : 'JSON') + ' first.'); return; }
    try {
      if (s.dir === 'c2j') {
        const rows = parseCsv(src, { delimiter: s.delim });
        const data = csvToJson(src, { delimiter: s.delim, header: s.header, types: s.types });
        out.set(JSON.stringify(data, null, 2), 'json');
        renderPreview(rows, s.header);
        const used = rows.delimiter === '\t' ? 'Tab' : rows.delimiter;
        const ragged = new Set(rows.map((r) => r.length)).size > 1;
        msg.ok(`Converted ${data.length.toLocaleString()} ${s.header ? 'records' : 'rows'}`, `Delimiter: ${used}` + (ragged ? ' · some rows have a different number of columns (missing cells are empty; extra cells get column_N keys).' : ''));
      } else {
        const value = parseJson(src);
        const csv = jsonToCsv(value, { delimiter: s.delim === 'auto' ? ',' : s.delim, header: s.header, flatten: s.flatten, excelSafe: s.excel });
        out.set(csv);
        const rows = parseCsv(csv, { delimiter: s.delim === 'auto' ? ',' : s.delim });
        renderPreview(rows, s.header);
        msg.ok(`Converted to ${Math.max(0, rows.length - (s.header ? 1 : 0)).toLocaleString()} CSV rows`, 'Arrays inside records are written as JSON text.' + (s.flatten ? ' Nested objects become dot-separated columns (address.city).' : ''));
      }
    } catch (e) {
      out.set(''); renderPreview([]);
      const kind = s.dir === 'c2j' ? 'CSV' : 'JSON';
      msg.error(`Could not convert — ${e.reason || e.message}`, e.line ? `${kind} line ${e.line}` + (e.col ? `, column ${e.col}` : '') : '');
    }
  }
  input.ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
  labels();
  root.append(
    toolbar(primary('Convert', run, { 'data-act': 'convert' }), dir),
    h('div', { class: 'dt-row jc-opts' }, field('Delimiter', delim), header, types, flatten, excel),
    msg.el,
    grid2(input.el, out.el),
    previewNote, preview,
    h('p', { class: 'dt-note' }, 'Quoted fields, doubled quotes (""), delimiters and line breaks inside quotes are handled per RFC 4180. Excel-safe mode prefixes cells that start with = + - @ with an apostrophe to block formula injection. Runs in your browser.'),
  );
}
