/* Mock API generator: schema editor (visual or JSON) → deterministic fake JSON / CSV data. */
import { h, output, msgBox, seg, select, field, input, primary, btn, toolbar, store, debounce, clear, toast } from '../ui.js';
import { generateMock, validateSchema, FIELD_TYPES, DEFAULTS, SAMPLE_SCHEMA, randomSeed } from '../lib/mock.js';
import { jsonToCsv } from '../lib/csv.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const today = () => new Date().toISOString().slice(0, 10);

// option inputs shown per type: [key, label, inputType]
const OPTS = {
  id: [['start', 'Start', 'number']],
  boolean: [['truePct', '% true', 'number']],
  integer: [['min', 'Min', 'number'], ['max', 'Max', 'number']],
  float: [['min', 'Min', 'number'], ['max', 'Max', 'number'], ['decimals', 'Decimals', 'number']],
  price: [['min', 'Min', 'number'], ['max', 'Max', 'number']],
  date: [['from', 'From', 'date'], ['to', 'To', 'date']],
  datetime: [['from', 'From', 'date'], ['to', 'To', 'date']],
  past: [['days', 'Within days', 'number']],
  future: [['days', 'Within days', 'number']],
  enum: [['values', 'Values (comma-separated)', 'text']],
};

export function mount(root) {
  const saved = store.get('mock-api', null);
  let schema = saved && saved.schema ? saved.schema : clone(SAMPLE_SCHEMA);
  if (!schema.now) schema.now = today();
  const msg = msgBox();
  const out = output({ label: 'Mock data', empty: 'Click Generate to create mock data.', download: () => (fmt.value === 'csv' ? { name: 'mock-data.csv', mime: 'text/csv;charset=utf-8' } : { name: 'mock-data.json', mime: 'application/json' }) });

  // ---------- settings ----------
  const count = input({ type: 'number', min: '1', max: '10000', step: '1', value: String(schema.count ?? 10), attrs: { 'aria-label': 'Number of records' } });
  const seedIn = input({ value: String(schema.seed ?? 'demo'), attrs: { 'aria-label': 'Seed', spellcheck: 'false' } });
  const nowIn = input({ type: 'date', value: schema.now, attrs: { 'aria-label': 'Relative dates from' } });
  const fmt = seg([['array', 'JSON array'], ['wrapped', 'JSON {data, meta}'], ['csv', 'CSV']], (saved && saved.fmt) || 'array', () => run(), 'Output format');
  // settings apply to the visual schema and, in JSON mode, are patched into the JSON text too
  function applySetting(key, val) {
    schema[key] = val;
    if (mode === 'json') { try { const s = JSON.parse(text.value); s[key] = val; text.value = JSON.stringify(s, null, 2); } catch (e) { /* invalid JSON: leave the text alone */ } }
    changed();
  }
  count.addEventListener('input', () => applySetting('count', Math.floor(Number(count.value))));
  seedIn.addEventListener('input', () => applySetting('seed', seedIn.value));
  nowIn.addEventListener('input', () => applySetting('now', nowIn.value));

  // ---------- visual editor ----------
  const visual = h('div', { class: 'mk-visual' });
  const text = h('textarea', { class: 'dt-code mk-text', attrs: { rows: 18, spellcheck: 'false', 'aria-label': 'Schema JSON' } });
  const textWrap = h('div', { class: 'dt-panel' }, text);
  let mode = 'visual';
  const modeSeg = seg([['visual', 'Visual editor'], ['json', 'Schema JSON']], 'visual', (v) => switchMode(v), 'Editor mode');

  function switchMode(v) {
    if (v === mode) return;
    if (v === 'json') { text.value = JSON.stringify(schema, null, 2); mode = 'json'; visual.hidden = true; textWrap.hidden = false; return; }
    // json → visual: must parse
    try {
      const parsed = JSON.parse(text.value);
      const errs = validateSchema(parsed);
      if (errs.length) throw new Error(errs.join('\n'));
      schema = parsed; syncSettings(); mode = 'visual'; visual.hidden = false; textWrap.hidden = true; drawVisual(); msg.hide();
    } catch (e) {
      modeSeg.set('json');
      msg.error('Fix the schema JSON before switching to the visual editor', e.message);
    }
  }
  function syncSettings() { count.value = String(schema.count ?? 10); seedIn.value = String(schema.seed ?? ''); nowIn.value = schema.now || today(); }

  function typeSelect(value, onChange, allowArray = true) {
    const s = select(FIELD_TYPES.filter(([t]) => allowArray || t !== 'array'), value, onChange);
    s.setAttribute('aria-label', 'Field type');
    s.classList.add('mk-type');
    return s;
  }
  function optInputs(f) {
    const box = h('div', { class: 'mk-opts' });
    for (const [key, label, type] of OPTS[f.type] || []) {
      const def = (DEFAULTS[f.type] || {})[key];
      const val = f[key] ?? def;
      const inp = input({ type, value: Array.isArray(val) ? val.join(', ') : String(val ?? ''), attrs: { 'aria-label': label } });
      inp.classList.add('mk-opt');
      inp.addEventListener('input', () => { f[key] = type === 'number' ? (inp.value === '' ? undefined : Number(inp.value)) : inp.value; changed(); });
      box.append(field(label, inp));
    }
    return box;
  }
  function fieldsEditor(list, depth) {
    const wrap = h('div', { class: 'mk-fields' + (depth ? ' is-nested' : '') });
    list.forEach((f, i) => {
      const name = input({ value: f.name || '', placeholder: 'field name', attrs: { 'aria-label': 'Field name', spellcheck: 'false' } });
      name.classList.add('mk-name');
      name.addEventListener('input', () => { f.name = name.value; changed(); });
      const type = typeSelect(f.type, (v) => {
        for (const k of Object.keys(f)) if (!['name', 'nullable'].includes(k)) delete f[k];
        f.type = v;
        Object.assign(f, clone(DEFAULTS[v] || {}));
        if (v === 'object') f.fields = [{ name: 'value', type: 'word' }];
        if (v === 'array') f.of = { type: 'word' };
        drawVisual(); changed();
      });
      const nullable = input({ type: 'number', min: '0', max: '100', value: f.nullable ? String(f.nullable) : '', placeholder: '0', attrs: { 'aria-label': '% null', title: 'Percentage of records where this field is null' } });
      nullable.classList.add('mk-null');
      nullable.addEventListener('input', () => { if (nullable.value === '' || Number(nullable.value) === 0) delete f.nullable; else f.nullable = Number(nullable.value); changed(); });
      const move = (d) => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; drawVisual(); changed(); };
      const row = h('div', { class: 'mk-row' },
        h('div', { class: 'mk-main' }, name, type, h('label', { class: 'mk-nl' }, '% null', nullable),
          h('div', { class: 'mk-btns' },
            h('button', { type: 'button', class: 'dt-mini', attrs: { 'aria-label': 'Move up', title: 'Move up' }, disabled: i === 0, on: { click: () => move(-1) } }, '↑'),
            h('button', { type: 'button', class: 'dt-mini', attrs: { 'aria-label': 'Move down', title: 'Move down' }, disabled: i === list.length - 1, on: { click: () => move(1) } }, '↓'),
            h('button', { type: 'button', class: 'dt-mini mk-del', attrs: { 'aria-label': 'Remove field', title: 'Remove' }, on: { click: () => { list.splice(i, 1); if (!list.length) list.push({ name: 'field', type: 'word' }); drawVisual(); changed(); } } }, '×'))),
        optInputs(f));
      if (f.type === 'object') row.append(fieldsEditor(f.fields || (f.fields = []), depth + 1));
      if (f.type === 'array') {
        if (!f.of) f.of = { type: 'word' };
        const ofSel = typeSelect(f.of.type, (v) => { f.of = { type: v, ...clone(DEFAULTS[v] || {}) }; if (v === 'object') f.of.fields = [{ name: 'value', type: 'word' }]; drawVisual(); changed(); }, false);
        const minI = input({ type: 'number', min: '0', max: '100', value: String(f.min ?? 1), attrs: { 'aria-label': 'Minimum items' } });
        const maxI = input({ type: 'number', min: '0', max: '100', value: String(f.max ?? 3), attrs: { 'aria-label': 'Maximum items' } });
        minI.addEventListener('input', () => { f.min = Number(minI.value); changed(); });
        maxI.addEventListener('input', () => { f.max = Number(maxI.value); changed(); });
        row.append(h('div', { class: 'mk-arr' }, field('Items of type', ofSel), field('Min items', minI), field('Max items', maxI)), optInputs(f.of));
        if (f.of.type === 'object') row.append(fieldsEditor(f.of.fields || (f.of.fields = []), depth + 1));
      }
      wrap.append(row);
    });
    if (depth < 5) wrap.append(btn('+ Add field', () => { list.push({ name: uniqueName(list), type: 'word' }); drawVisual(); changed(); }, 'dt-mini mk-add'));
    return wrap;
  }
  const uniqueName = (list) => { let n = list.length + 1; while (list.some((f) => f.name === 'field_' + n)) n++; return 'field_' + n; };
  function drawVisual() { clear(visual); visual.append(fieldsEditor(schema.fields, 0)); }

  // ---------- generate ----------
  function currentSchema() {
    if (mode === 'json') { const s = JSON.parse(text.value); return s; }
    return schema;
  }
  function run(explicit) {
    msg.hide();
    let s;
    try { s = currentSchema(); } catch (e) { out.set(''); msg.error('The schema JSON is invalid', e.message); return; }
    const errs = validateSchema(s);
    if (errs.length) { out.set(''); msg.error(`The schema has ${errs.length} problem${errs.length > 1 ? 's' : ''}`, errs.join('\n')); return; }
    const t0 = performance.now();
    const data = generateMock(s);
    let textOut;
    if (fmt.value === 'csv') textOut = jsonToCsv(data, { flatten: true });
    else if (fmt.value === 'wrapped') textOut = JSON.stringify({ data, meta: { count: data.length, seed: String(s.seed ?? 'demo'), mock: true, note: 'Generated mock data — not real' } }, null, 2);
    else textOut = JSON.stringify(data, null, 2);
    out.set(textOut, fmt.value === 'csv' ? null : textOut.length < 1.5e6 ? 'json' : null);
    if (explicit) toast(`Generated ${data.length.toLocaleString()} records in ${Math.round(performance.now() - t0)} ms`);
    store.set('mock-api', { schema: mode === 'json' ? s : schema, fmt: fmt.value });
  }
  const auto = debounce(() => { const c = Number(count.value); if (c > 0 && c <= 500) run(false); else store.set('mock-api', { schema, fmt: fmt.value }); }, 400);
  function changed() { auto(); }
  text.addEventListener('input', () => auto());

  textWrap.hidden = true;
  drawVisual();
  root.append(
    h('div', { class: 'dt-msg is-warn mk-banner' }, h('strong', null, 'MOCK DATA'), ' — every value is randomly generated and fake. Names, emails, phone numbers (555-01xx) and IPs (2001:db8::/32) are not real.'),
    h('div', { class: 'dt-row mk-settings' },
      field('Records (1–10 000)', count),
      field('Seed', seedIn),
      h('div', { class: 'mk-seedbtn' }, btn('Random seed', () => { seedIn.value = randomSeed(); applySetting('seed', seedIn.value); run(true); }, undefined, { 'data-act': 'random-seed' })),
      field('Relative dates from', nowIn)),
    h('div', { class: 'dt-toolbar' }, modeSeg, fmt),
    visual, textWrap,
    toolbar(primary('Generate', () => run(true), { 'data-act': 'generate' }), btn('Reset to sample', () => { schema = clone(SAMPLE_SCHEMA); schema.now = today(); syncSettings(); if (mode === 'json') text.value = JSON.stringify(schema, null, 2); drawVisual(); run(true); })),
    msg.el,
    out.el,
    h('p', { class: 'dt-note' }, 'Same seed + same schema = identical data every time (great for tests and demos). Generated entirely in your browser.'),
  );
  run(false);
  return () => auto.cancel();
}
