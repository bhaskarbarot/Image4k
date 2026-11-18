/* API Response Formatter — detects JSON / XML / HTML / form-urlencoded / text and pretty-prints it. */
import { h, editor, output, msgBox, seg, select, field, primary, btn, toolbar, grid2, store, byteLength, formatBytes, clear } from '../ui.js';
import { reformat, hasUnsafeNumbers } from '../lib/json.js';
import { formatXml, minifyXml, validateXml } from '../lib/xml.js';
import { detectFormat, parseForm, formToObject, formatHtml, minifyHtml } from '../lib/respfmt.js';

const SAMPLES = {
  json: '{"data":{"user":{"id":"u_1","name":"Asha","roles":["admin"]}},"meta":{"requestId":"req-91f2","took_ms":12}}',
  xml: '<?xml version="1.0"?><response status="ok"><user id="u_1"><name>Asha</name><role>admin</role></user></response>',
  html: '<!doctype html><html><head><title>Status</title><style>body{font:14px sans-serif}</style></head><body><h1>Service is up</h1><p>All <b>systems</b> operational.</p><br><ul><li>API</li><li>Webhooks</li></ul></body></html>',
  form: 'grant_type=client_credentials&scope=read%3Ausers+write%3Ausers&client_id=abc%20123&tag=a&tag=b',
};
const EXT = { json: ['response.json', 'application/json'], xml: ['response.xml', 'application/xml'], html: ['response.html', 'text/html'], form: ['response.json', 'application/json'], text: ['response.txt', 'text/plain'] };
const LABEL = { json: 'JSON', xml: 'XML', html: 'HTML', form: 'Form (x-www-form-urlencoded)', text: 'Plain text' };

export function mount(root) {
  const s = store.get('response-formatter', { as: 'auto', indent: '2' });
  const save = () => store.set('response-formatter', s);
  let detected = 'text', outKind = 'text';
  const msg = msgBox();
  const status = h('div', { class: 'dt-stats', attrs: { 'aria-live': 'polite' } });
  const input = editor({ label: 'Response body', placeholder: 'Paste an API response body — JSON, XML, HTML, form data or text', paste: true, clear: true, file: {}, sample: () => SAMPLES[['json', 'xml', 'html', 'form'][Math.floor(Math.random() * 4)]] });
  const out = output({ label: 'Formatted', download: () => ({ name: EXT[outKind][0], mime: EXT[outKind][1] }), empty: 'The formatted response will appear here.' });
  const as = select([['auto', 'Auto-detect'], ['json', 'JSON'], ['xml', 'XML'], ['html', 'HTML'], ['form', 'Form data'], ['text', 'Plain text']], s.as, (v) => { s.as = v; save(); if (input.get().trim()) run('pretty'); });
  const indent = seg([['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'Tab']], s.indent, (v) => { s.indent = v; save(); if (out.get()) run('pretty'); }, 'Indentation');
  const formTable = h('div', { class: 'dt-table-wrap', hidden: true });

  function stat(label, value) { return h('span', { class: 'dt-stat' }, label + ' ', h('b', null, value)); }
  function run(mode) {
    const src = input.get();
    msg.hide(); status.replaceChildren(); clear(formTable); formTable.hidden = true;
    if (!src.trim()) { out.set(''); msg.error('Nothing to format — paste a response body first.'); return; }
    detected = detectFormat(src);
    const kind = s.as === 'auto' ? detected : s.as;
    const ind = s.indent === 'tab' ? '\t' : Number(s.indent);
    status.append(h('span', { class: 'dt-badge is-info' }, (s.as === 'auto' ? 'Detected: ' : 'As: ') + LABEL[kind]), stat('Size', formatBytes(byteLength(src))), stat('Lines', src.split('\n').length.toLocaleString()));
    try {
      if (kind === 'json') {
        const r = reformat(src.trim(), { indent: mode === 'minify' ? 0 : ind });
        out.set(r.text, 'json'); outKind = 'json';
        status.append(h('span', { class: 'dt-badge is-ok' }, '✓ Valid JSON'), stat('Keys', r.stats.keys.toLocaleString()), stat('Depth', String(r.stats.depth)));
        if (hasUnsafeNumbers(src)) msg.info('Large integers are kept exactly as received.');
      } else if (kind === 'xml') {
        const v = validateXml(src.trim());
        if (!v.ok) throw Object.assign(new Error(v.error.message), { reason: v.error.message, line: v.error.line, col: v.error.col });
        out.set(mode === 'minify' ? minifyXml(src.trim()) : formatXml(src.trim(), { indent: ind }), 'xml'); outKind = 'xml';
        status.append(h('span', { class: 'dt-badge is-ok' }, '✓ Well-formed XML'), stat('Elements', v.elements.toLocaleString()));
      } else if (kind === 'html') {
        out.set(mode === 'minify' ? minifyHtml(src) : formatHtml(src, ind), 'xml'); outKind = 'html';
        msg.info('HTML is formatted leniently', 'Browsers accept imperfect HTML, so it is re-indented rather than validated. The markup is shown as text — it is never rendered or executed.');
      } else if (kind === 'form') {
        const pairs = parseForm(src);
        const obj = formToObject(pairs);
        out.set(JSON.stringify(obj, null, mode === 'minify' ? 0 : ind), 'json'); outKind = 'form';
        status.append(h('span', { class: 'dt-badge is-ok' }, `✓ ${pairs.length} field${pairs.length === 1 ? '' : 's'}`));
        formTable.appendChild(h('table', { class: 'dt-table' },
          h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, 'Decoded value'))),
          h('tbody', null, pairs.map(([k, v]) => h('tr', null, h('td', { class: 'mono' }, k), h('td', { class: 'mono' }, v))))));
        formTable.hidden = false;
      } else {
        out.set(mode === 'minify' ? src.replace(/\s+/g, ' ').trim() : src); outKind = 'text';
        status.append(stat('Words', ((src.match(/\S+/g) || []).length).toLocaleString()));
        if (s.as === 'auto') msg.info('No structured format detected', 'Shown as plain text. Choose a format manually if detection is wrong.');
      }
    } catch (e) {
      out.set('');
      status.append(h('span', { class: 'dt-badge is-err' }, '✕ Invalid ' + LABEL[kind]));
      msg.error(`Invalid ${LABEL[kind]} — ${e.reason || e.message}`, e.line ? `Line ${e.line}, column ${e.col}` : (s.as === 'auto' ? '' : 'Try “Auto-detect” if the body is a different format.'));
    }
  }
  input.ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run('pretty'); } });
  root.append(
    toolbar(primary('Format', () => run('pretty'), { 'data-act': 'format' }), btn('Minify', () => run('minify'), undefined, { 'data-act': 'minify' }), field('Detect as', as), indent),
    status, msg.el,
    grid2(input.el, out.el),
    formTable,
    h('p', { class: 'dt-note' }, 'Paste the body of any HTTP response. JSON numbers are kept exactly; XML entities are never expanded; HTML is displayed as text, never rendered. Everything stays in your browser.'),
  );
}
