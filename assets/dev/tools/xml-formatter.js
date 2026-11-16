/* XML Formatter — format / minify / validate. Pure tokenizer: entities are never expanded (XXE-safe). */
import { h, editor, output, msgBox, seg, checkbox, primary, btn, toolbar, grid2, store, debounce, toast } from '../ui.js';
import { formatXml, minifyXml, validateXml } from '../lib/xml.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?><catalog xmlns:bk="urn:books"><!-- sample --><bk:book id="b1" lang="en"><title>Clean Code</title><author>Robert C. Martin</author><price currency="USD">32.99</price><tags><tag>craft</tag><tag>java</tag></tags></bk:book><bk:book id="b2" lang="hi"><title>गोदान</title><author>Premchand</author><notes><![CDATA[Contains <markup> & symbols]]></notes><available/></bk:book></catalog>`;

export function mount(root) {
  const saved = store.get('xml-formatter', { indent: '2', strip: false });
  const input = editor({ label: 'Input XML', placeholder: 'Paste XML here — or open an .xml file', sample: SAMPLE, paste: true, file: { accept: '.xml,.svg,.xsd,.xsl,.rss,.atom,.plist,text/xml,application/xml,text/plain' }, clear: true });
  const out = output({ label: 'Result', download: { name: 'formatted.xml', mime: 'application/xml' }, empty: 'Formatted XML will appear here.' });
  const msg = msgBox();
  const status = h('div', { class: 'dt-stats', attrs: { 'aria-live': 'polite' } });
  const indent = seg([['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'Tab']], saved.indent, (v) => { saved.indent = v; store.set('xml-formatter', saved); if (out.get()) run('format'); }, 'Indentation');
  const strip = checkbox('Remove comments when minifying', saved.strip, (v) => { saved.strip = v; store.set('xml-formatter', saved); });

  const goTo = (pos, line, col, src) => h('button', { type: 'button', class: 'dt-mini', on: { click: () => { input.ta.focus(); input.ta.setSelectionRange(pos, Math.min(pos + 1, src.length)); } } }, `Go to line ${line}:${col}`);

  function showError(e, src) {
    out.set('');
    const l = src.split('\n')[e.line - 1] ?? '';
    const ctx = l.length <= 160 ? '\n' + l + '\n' + ' '.repeat(Math.max(0, e.col - 1)) + '^' : '';
    msg.error('Invalid XML — ' + e.reason, `Line ${e.line}, column ${e.col}` + ctx);
    status.replaceChildren(h('span', { class: 'dt-badge is-err' }, '✕ Invalid'), goTo(e.pos, e.line, e.col, src));
  }
  function run(mode) {
    const src = input.get();
    msg.hide();
    if (!src.trim()) { out.set(''); status.replaceChildren(); msg.error('Nothing to format — paste some XML first.'); return; }
    try {
      const v = validateXml(src);
      if (!v.ok) { const e = v.error; showError({ reason: e.message, line: e.line, col: e.col, pos: e.pos }, src); return; }
      status.replaceChildren(h('span', { class: 'dt-badge is-ok' }, '✓ Well-formed XML'), h('span', { class: 'dt-stat' }, 'Elements ', h('b', null, v.elements.toLocaleString())));
      if (mode === 'validate') { msg.ok('Well-formed XML', `${v.elements.toLocaleString()} elements. (Checked for well-formedness; DTD/XSD schema validation is not performed.)`); return; }
      const ind = indent.value === 'tab' ? '\t' : Number(indent.value);
      const text = mode === 'minify' ? minifyXml(src, { removeComments: strip.input.checked }) : formatXml(src, { indent: ind });
      out.set(text, 'xml');
      if (mode === 'minify') toast(`Minified: ${src.length.toLocaleString()} → ${text.length.toLocaleString()} characters`);
    } catch (e) {
      if (e.name === 'XmlError') showError(e, src); else msg.error('Could not process the XML', e.message);
    }
  }
  const live = debounce(() => {
    const src = input.get();
    if (!src.trim() || src.length > 5e6) { if (!src.trim()) { status.replaceChildren(); msg.hide(); } return; }
    const v = validateXml(src);
    if (v.ok) { msg.hide(); status.replaceChildren(h('span', { class: 'dt-badge is-ok' }, '✓ Well-formed XML'), h('span', { class: 'dt-stat' }, 'Elements ', h('b', null, v.elements.toLocaleString()))); }
    else status.replaceChildren(h('span', { class: 'dt-badge is-err' }, '✕ ' + v.error.message), goTo(v.error.pos, v.error.line, v.error.col, src));
  }, 300);
  input.ta.addEventListener('input', live);
  input.ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run('format'); } });

  root.append(
    toolbar(primary('Format', () => run('format'), { 'data-act': 'format' }), btn('Minify', () => run('minify'), undefined, { 'data-act': 'minify' }), btn('Validate', () => run('validate'), undefined, { 'data-act': 'validate' }), indent, strip),
    status, msg.el,
    grid2(input.el, out.el),
    h('p', { class: 'dt-note' }, 'Security: DOCTYPEs are kept as text and entities are never expanded or fetched, so XXE and “billion laughs” payloads are harmless here. Checks well-formedness (not DTD/XSD validity). Runs entirely in your browser.'),
  );
  return () => live.cancel();
}
