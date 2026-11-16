/* GraphQL Playground — queries & mutations with variables/headers, introspection-based schema explorer. */
import { h, clear, input, editor, kvEditor, btn, primary, msgBox, toolbar, tabs, field, store, debounce, copyText } from '../ui.js';
import { prepare, send, HttpToolError, decodeText } from '../lib/http.js';
import { INTROSPECTION_QUERY, buildGraphQLBody, typeRefToString, namedType } from '../lib/graphql.js';
import { validateJson } from '../lib/json.js';
import { sendViaControl, responseView } from './_http-ui.js';

const SAMPLE = `query GetCountry($code: ID!) {
  country(code: $code) {
    name
    capital
    currency
  }
}`;

export function mount(root) {
  const saved = store.get('graphql', { endpoint: 'https://countries.trevorblades.com/graphql' });
  const endpoint = input({ value: saved.endpoint, placeholder: 'https://api.example.com/graphql', attrs: { 'aria-label': 'GraphQL endpoint', spellcheck: 'false', inputmode: 'url' } });
  endpoint.classList.add('api-url');
  endpoint.addEventListener('change', () => store.set('graphql', { endpoint: endpoint.value.trim() }));
  const runBtn = primary('Run', () => (inflight ? inflight.abort() : run()), { 'data-act': 'run' });
  const via = sendViaControl('graphql-via');
  const msg = msgBox();
  const query = editor({ label: 'Query / mutation', value: SAMPLE, rows: 14, clear: true });
  const vars = editor({ label: 'Variables (JSON)', value: '{\n  "code": "IN"\n}', rows: 6, clear: true });
  const varsStatus = h('span', { class: 'dt-meta' });
  const checkVars = debounce(() => {
    const v = vars.get();
    if (!v.trim()) { varsStatus.textContent = ''; return; }
    const r = validateJson(v);
    varsStatus.textContent = r.ok ? '✓ valid JSON' : `✕ ${r.error.message} (line ${r.error.line}:${r.error.col})`;
    varsStatus.className = 'dt-meta ' + (r.ok ? 'api-ok' : 'api-bad');
  }, 250);
  vars.ta.addEventListener('input', checkVars); checkVars();
  const opName = input({ placeholder: 'Only needed when the document has several operations', attrs: { spellcheck: 'false' } });
  const headers = kvEditor({ keyPlaceholder: 'Header', valuePlaceholder: 'Value', rows: [{ key: 'Authorization', value: '', on: false }] });
  const errorsBox = h('div', { class: 'gql-errors', hidden: true });
  const resp = responseView({ downloadName: 'graphql-response' });
  let inflight = null;

  async function post(body) {
    const req = prepare({ method: 'POST', url: endpoint.value, headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Accept', value: 'application/graphql-response+json, application/json' }, ...headers.get()], body: { type: 'text', text: JSON.stringify(body), contentType: 'application/json' } });
    // the raw-text body adds a second Content-Type; keep only the first
    const seen = new Set();
    req.headers = req.headers.filter(([k]) => { const l = k.toLowerCase(); if (l !== 'content-type') return true; if (seen.has(l)) return false; seen.add(l); return true; });
    inflight = new AbortController();
    try { return { req, res: await send(req, via.value, { signal: inflight.signal, timeoutMs: 30000 }) }; } finally { inflight = null; }
  }

  async function run() {
    msg.hide(); errorsBox.hidden = true;
    let body;
    try { body = buildGraphQLBody({ query: query.get(), variables: vars.get(), operationName: opName.value.trim() }); } catch (e) { msg.error(e.message); return; }
    runBtn.textContent = 'Cancel';
    resp.busy();
    try {
      const { req, res } = await post(body);
      resp.show(res, req);
      showGraphQLErrors(res);
    } catch (e) { resp.error(e instanceof HttpToolError ? e : new HttpToolError(e.message, 'error')); } finally { runBtn.textContent = 'Run'; }
  }

  function parseJsonBody(res) { try { return JSON.parse(decodeText(res.bytes)); } catch (e) { return null; } }
  function showGraphQLErrors(res) {
    clear(errorsBox);
    const j = parseJsonBody(res);
    if (!j) { if (res.status < 400) { errorsBox.hidden = false; errorsBox.append(h('div', { class: 'dt-msg is-warn' }, 'The response is not JSON — is this really a GraphQL endpoint?')); } return; }
    if (!Array.isArray(j.errors) || !j.errors.length) return;
    errorsBox.hidden = false;
    errorsBox.append(h('div', { class: 'dt-msg is-err', attrs: { role: 'alert' } },
      h('strong', null, `GraphQL returned ${j.errors.length} error${j.errors.length > 1 ? 's' : ''}` + (j.data ? ' (partial data was also returned)' : '')),
      h('ul', { class: 'gql-err-list' }, j.errors.map((e) => h('li', null,
        h('span', { class: 'gql-err-msg' }, String(e.message ?? JSON.stringify(e))),
        e.path ? h('span', { class: 'dt-badge' }, 'path: ' + e.path.join('.')) : null,
        Array.isArray(e.locations) ? h('span', { class: 'dt-badge' }, 'at ' + e.locations.map((l) => `${l.line}:${l.column}`).join(', ')) : null,
        e.extensions?.code ? h('span', { class: 'dt-badge is-warn' }, String(e.extensions.code)) : null)))));
  }

  // ---------- schema explorer ----------
  const schemaMsg = msgBox();
  const typeSearch = input({ type: 'search', placeholder: 'Search types and fields…', attrs: { 'aria-label': 'Search schema' } });
  const typeList = h('div', { class: 'gql-types' });
  const typeDetail = h('div', { class: 'gql-detail' });
  const showBuiltins = h('input', { type: 'checkbox', attrs: { 'aria-label': 'Show built-in types' } });
  let schema = null;
  async function introspect(e) {
    schemaMsg.info('Loading schema…');
    try {
      const { res } = await post({ query: INTROSPECTION_QUERY, operationName: 'IntrospectionQuery' });
      const j = parseJsonBody(res);
      if (!j) throw new Error(`HTTP ${res.status}: the endpoint did not return JSON.`);
      if (!j.data || !j.data.__schema) {
        const why = Array.isArray(j.errors) ? j.errors.map((x) => x.message).join(' · ') : `HTTP ${res.status}`;
        schemaMsg.error('This server did not return its schema — introspection may be disabled (common in production).', 'Server said: ' + why);
        return;
      }
      schema = j.data.__schema;
      schemaMsg.ok(`Schema loaded: ${schema.types.filter((t) => !t.name.startsWith('__')).length} types.`, [schema.queryType && 'Query: ' + schema.queryType.name, schema.mutationType && 'Mutation: ' + schema.mutationType.name, schema.subscriptionType && 'Subscription: ' + schema.subscriptionType.name + ' (not runnable here)'].filter(Boolean).join(' · '));
      renderTypes();
      showType(schema.queryType?.name);
    } catch (err) { schemaMsg.error(err.message, err.detail); }
  }
  function matches(t, q) {
    if (!q) return true;
    if (t.name.toLowerCase().includes(q)) return true;
    return (t.fields || t.inputFields || []).some((f) => f.name.toLowerCase().includes(q));
  }
  function renderTypes() {
    clear(typeList);
    if (!schema) return;
    const q = typeSearch.value.trim().toLowerCase();
    const list = schema.types.filter((t) => (showBuiltins.checked || (!t.name.startsWith('__') && !['String', 'Int', 'Float', 'Boolean', 'ID'].includes(t.name))) && matches(t, q))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const t of list) typeList.appendChild(h('button', { type: 'button', class: 'gql-type', on: { click: () => showType(t.name) } }, h('span', { class: 'dt-badge' }, t.kind.replace('_', ' ').toLowerCase()), ' ', t.name));
    if (!list.length) typeList.appendChild(h('p', { class: 'dt-note' }, 'No matching types.'));
  }
  typeSearch.addEventListener('input', renderTypes);
  showBuiltins.addEventListener('change', renderTypes);
  function typeLink(ref) {
    const n = namedType(ref);
    return h('button', { type: 'button', class: 'gql-link', on: { click: () => showType(n) } }, typeRefToString(ref));
  }
  function showType(name) {
    clear(typeDetail);
    const t = schema && schema.types.find((x) => x.name === name);
    if (!t) return;
    typeDetail.append(h('h4', { class: 'api-sub' }, t.name, ' ', h('span', { class: 'dt-badge' }, t.kind)));
    if (t.description) typeDetail.append(h('p', { class: 'dt-note' }, t.description));
    const fields = t.fields || t.inputFields;
    if (fields) {
      typeDetail.append(h('ul', { class: 'gql-fields' }, fields.map((f) => h('li', null,
        h('span', { class: 'gql-fname' }, f.name),
        f.args && f.args.length ? h('span', { class: 'gql-args' }, '(', f.args.map((a, i) => [i ? ', ' : '', a.name + ': ', typeLink(a.type), a.defaultValue != null ? ' = ' + a.defaultValue : '']), ')') : null,
        ': ', typeLink(f.type),
        f.isDeprecated ? h('span', { class: 'dt-badge is-warn' }, 'deprecated' + (f.deprecationReason ? ': ' + f.deprecationReason : '')) : null,
        f.description ? h('div', { class: 'dt-note' }, f.description) : null))));
    }
    if (t.enumValues) typeDetail.append(h('ul', { class: 'gql-fields' }, t.enumValues.map((v) => h('li', null, h('span', { class: 'gql-fname' }, v.name), v.description ? h('div', { class: 'dt-note' }, v.description) : null))));
    if (t.possibleTypes && t.possibleTypes.length) typeDetail.append(h('p', { class: 'dt-note' }, 'Possible types: '), h('div', { class: 'dt-toolbar' }, t.possibleTypes.map(typeLink)));
    if (t.interfaces && t.interfaces.length) typeDetail.append(h('p', { class: 'dt-note' }, 'Implements: '), h('div', { class: 'dt-toolbar' }, t.interfaces.map(typeLink)));
  }

  const sideTabs = tabs([['vars', 'Variables'], ['headers', 'Headers'], ['schema', 'Schema']], 'vars', (id) => { for (const [k, el] of Object.entries(sidePanes)) el.hidden = k !== id; });
  const sidePanes = {
    vars: h('div', null, vars.el, varsStatus, field('Operation name', opName)),
    headers: h('div', null, headers.el, h('p', { class: 'dt-note' }, 'Content-Type: application/json is sent automatically. Tick a row to enable it.')),
    schema: h('div', { hidden: true }, toolbar(btn('Load schema (introspection)', introspect, 'btn btn-ghost btn-sm', { 'data-act': 'introspect' }), h('label', { class: 'dt-check' }, showBuiltins, h('span', null, 'Show built-in types'))), schemaMsg.el, typeSearch, h('div', { class: 'gql-explorer' }, typeList, typeDetail)),
  };
  sidePanes.headers.hidden = true;

  query.ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!inflight) run(); } });
  root.append(
    h('div', { class: 'api-reqline' }, h('span', { class: 'dt-badge is-info api-gql-badge' }, 'POST'), endpoint, runBtn),
    toolbar(btn('Copy request as cURL', (e) => {
      try {
        const body = buildGraphQLBody({ query: query.get(), variables: vars.get(), operationName: opName.value.trim() });
        const hs = headers.get().map((x) => ` -H '${(x.key + ': ' + x.value).replace(/'/g, "'\\''")}'`).join('');
        copyText(`curl -X POST '${endpoint.value.trim().replace(/'/g, "'\\''")}' -H 'Content-Type: application/json'${hs} --data-raw '${JSON.stringify(body).replace(/'/g, "'\\''")}'`, e.currentTarget);
      } catch (err) { msg.error(err.message); }
    }), h('span', { class: 'dt-meta' }, 'Ctrl+Enter runs · mutations supported · subscriptions are not (they need WebSockets)')),
    via.el, msg.el,
    h('div', { class: 'dt-grid2' }, query.el, h('section', { class: 'dt-card' }, sideTabs.el, sidePanes.vars, sidePanes.headers, sidePanes.schema)),
    errorsBox, resp.el,
  );
  return () => { if (inflight) inflight.abort(); resp.cleanup(); checkVars.cancel(); };
}
