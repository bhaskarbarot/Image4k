/* YAML ⇄ JSON converter (js-yaml 4.1.1, safe load — no custom JS types). */
import { h, editor, output, msgBox, seg, primary, btn, toolbar, grid2, store } from '../ui.js';
import { parseYaml, dumpYaml } from '../lib/yaml.js';
import { parseJson, hasUnsafeNumbers } from '../lib/json.js';

const YAML_SAMPLE = `# Service config
service: billing-api
version: 2.3.1
replicas: 3
enabled: true
owner: { name: Zoë, team: payments }
ports:
  - 8080
  - 8443
env:
  DATABASE_URL: "postgres://db:5432/billing"
  FEATURE_FLAGS: [audit, "retry: on"]
defaults: &defaults
  timeout: 30
  retries: 2
worker:
  <<: *defaults
  timeout: 60
description: |
  Multi-line text
  is kept as written.
`;
const JSON_SAMPLE = '{"service":"billing-api","version":"2.3.1","replicas":3,"enabled":true,"owner":{"name":"Zoë","team":"payments"},"ports":[8080,8443],"note":"yes","empty":null,"tags":[]}';

export function mount(root) {
  const saved = store.get('yaml-json', { dir: 'y2j', indent: '2' });
  const msg = msgBox();
  const status = h('div', { class: 'dt-stats', attrs: { 'aria-live': 'polite' } });
  const input = editor({ label: 'Input', paste: true, clear: true, sample: () => (saved.dir === 'y2j' ? YAML_SAMPLE : JSON_SAMPLE), file: { accept: '.yaml,.yml,.json,text/plain,application/json' } });
  const out = output({ label: 'Output', download: () => (saved.dir === 'y2j' ? { name: 'converted.json', mime: 'application/json' } : { name: 'converted.yaml', mime: 'application/yaml' }) });
  const dir = seg([['y2j', 'YAML → JSON'], ['j2y', 'JSON → YAML']], saved.dir, (v) => { saved.dir = v; store.set('yaml-json', saved); labels(); if (input.get().trim()) run(); }, 'Direction');
  const indent = seg([['2', '2 spaces'], ['4', '4 spaces']], saved.indent, (v) => { saved.indent = v; store.set('yaml-json', saved); if (out.get()) run(); }, 'Indentation');

  function labels() {
    const y2j = saved.dir === 'y2j';
    input.el.querySelector('.dt-panel-title').textContent = y2j ? 'Input YAML' : 'Input JSON';
    out.el.querySelector('.dt-panel-title').textContent = y2j ? 'JSON output' : 'YAML output';
    input.ta.placeholder = y2j ? 'Paste YAML here (several documents separated by --- are supported)' : 'Paste JSON here';
  }
  function run() {
    const src = input.get();
    msg.hide(); status.replaceChildren();
    if (!src.trim()) { out.set(''); msg.error('Nothing to convert — paste some ' + (saved.dir === 'y2j' ? 'YAML' : 'JSON') + ' first.'); return; }
    const ind = Number(indent.value);
    try {
      if (saved.dir === 'y2j') {
        const { value, docs } = parseYaml(src);
        out.set(JSON.stringify(value, null, ind), 'json');
        status.append(h('span', { class: 'dt-badge is-ok' }, '✓ Valid YAML'), h('span', { class: 'dt-stat' }, 'Documents ', h('b', null, String(docs))));
        if (docs > 1) msg.info(`${docs} YAML documents found`, 'They are returned as a JSON array, one item per document.');
      } else {
        const value = parseJson(src);
        out.set(dumpYaml(value, { indent: ind }));
        status.append(h('span', { class: 'dt-badge is-ok' }, '✓ Valid JSON'));
        if (hasUnsafeNumbers(src)) msg.warn('Large integers', 'Integers above 2^53 cannot be represented exactly by JavaScript and may be rounded in the YAML output.');
      }
    } catch (e) {
      out.set('');
      const kind = saved.dir === 'y2j' ? 'YAML' : 'JSON';
      msg.error(`Invalid ${kind} — ${e.reason || e.message}`, e.line ? `Line ${e.line}, column ${e.col}` + (e.snippet ? '\n' + e.snippet : '') : '');
      status.append(h('span', { class: 'dt-badge is-err' }, '✕ Invalid ' + kind));
      if (e.line && e.pos == null) {
        // place the caret at the error
        const lines = src.split('\n'); let pos = 0;
        for (let i = 0; i < e.line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
        pos += Math.max(0, e.col - 1);
        status.append(h('button', { type: 'button', class: 'dt-mini', on: { click: () => { input.ta.focus(); input.ta.setSelectionRange(pos, pos + 1); } } }, `Go to line ${e.line}:${e.col}`));
      } else if (e.pos != null) {
        status.append(h('button', { type: 'button', class: 'dt-mini', on: { click: () => { input.ta.focus(); input.ta.setSelectionRange(e.pos, e.pos + 1); } } }, `Go to line ${e.line}:${e.col}`));
      }
    }
  }
  function swap() {
    const res = out.get();
    if (!res) return msg.error('Convert something first, then swap to continue from the result.');
    saved.dir = saved.dir === 'y2j' ? 'j2y' : 'y2j'; store.set('yaml-json', saved);
    dir.set(saved.dir); labels();
    input.set(res); out.set(''); run();
  }
  input.ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
  labels();
  root.append(
    toolbar(primary('Convert', run, { 'data-act': 'convert' }), btn('⇄ Swap', swap, undefined, { 'data-act': 'swap' }), dir, indent),
    status, msg.el,
    grid2(input.el, out.el),
    h('p', { class: 'dt-note' }, 'YAML is parsed safely (YAML 1.2 core types, anchors, merge keys; no custom JavaScript types). Comments are not part of the data model and are not carried into JSON. Ctrl+Enter converts. Nothing leaves your browser.'),
  );
}
