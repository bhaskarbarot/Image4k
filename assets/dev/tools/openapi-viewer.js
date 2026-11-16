/* OpenAPI / Swagger viewer: paste, open or fetch a spec; validate it; browse endpoints by tag.
 * All text from the spec is untrusted and rendered as text nodes only. */
import { h, editor, msgBox, primary, btn, toolbar, input, tabs, clear, pickFile, readTextFileChecked, toast, debounce, copyText } from '../ui.js';
import { parseSpecText, analyze, groupByTag, searchOps, schemaTree, exampleFor, KIND_LABEL } from '../lib/openapi.js';

const SAMPLE = `openapi: 3.0.3
info:
  title: Bookshop API
  version: 1.4.0
  description: |
    Sample API for a small online bookshop.
    Lists books, manages orders and customer accounts.
servers:
  - url: https://api.bookshop.example/v1
    description: Production
tags:
  - name: books
    description: Browse the catalogue
  - name: orders
    description: Place and track orders
security:
  - bearerAuth: []
paths:
  /books:
    get:
      tags: [books]
      summary: List books
      operationId: listBooks
      security: []
      parameters:
        - name: q
          in: query
          description: Free-text search in title and author
          schema: { type: string }
        - $ref: '#/components/parameters/Limit'
      responses:
        '200':
          description: A page of books
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Book' }
  /books/{bookId}:
    get:
      tags: [books]
      summary: Get one book
      operationId: getBook
      security: []
      parameters:
        - name: bookId
          in: path
          required: true
          schema: { type: string, format: uuid }
      responses:
        '200':
          description: The book
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Book' }
        '404':
          $ref: '#/components/responses/NotFound'
  /orders:
    post:
      tags: [orders]
      summary: Place an order
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/NewOrder' }
            example: { items: [{ bookId: 3fa85f64-5717-4562-b3fc-2c963f66afa6, quantity: 2 }], giftWrap: false }
      responses:
        '201':
          description: Order created
          headers:
            Location: { schema: { type: string } }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '422':
          description: Validation failed
  /orders/{orderId}/cancel:
    post:
      tags: [orders]
      summary: Cancel an order (use DELETE /orders/{orderId} instead)
      operationId: cancelOrder
      deprecated: true
      parameters:
        - name: orderId
          in: path
          required: true
          schema: { type: integer }
      responses:
        '204': { description: Cancelled }
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    apiKey:
      type: apiKey
      in: header
      name: X-API-Key
  parameters:
    Limit:
      name: limit
      in: query
      description: Maximum number of results (1-100)
      schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
  responses:
    NotFound:
      description: Not found
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
  schemas:
    Book:
      type: object
      required: [id, title, price]
      properties:
        id: { type: string, format: uuid }
        title: { type: string, example: The Pragmatic Programmer }
        authors: { type: array, items: { type: string } }
        price: { type: number, format: float, example: 39.9 }
        related: { type: array, items: { $ref: '#/components/schemas/Book' } }
    NewOrder:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            type: object
            required: [bookId, quantity]
            properties:
              bookId: { type: string, format: uuid }
              quantity: { type: integer, minimum: 1 }
        giftWrap: { type: boolean, default: false }
    Order:
      allOf:
        - $ref: '#/components/schemas/NewOrder'
        - type: object
          properties:
            id: { type: integer, example: 1042 }
            status: { type: string, enum: [pending, paid, shipped, cancelled] }
            createdAt: { type: string, format: date-time }
    Error:
      type: object
      properties:
        code: { type: integer }
        message: { type: string }
`;

export function mount(root) {
  const src = editor({ label: 'Spec (JSON or YAML)', placeholder: 'Paste an OpenAPI 3.x or Swagger 2.0 document…', sample: SAMPLE, paste: true, clear: true, rows: 12 });
  const urlIn = input({ type: 'url', placeholder: 'https://petstore3.swagger.io/api/v3/openapi.json', attrs: { 'aria-label': 'Spec URL', spellcheck: 'false' } });
  urlIn.classList.add('oa-urlin');
  const msg = msgBox();
  const view = h('div', { class: 'oa-view' });
  let model = null;

  const srcTabs = tabs([['paste', 'Paste'], ['file', 'Open file'], ['url', 'From URL']], 'paste', (id) => showSrc(id));
  const srcHost = h('div', { class: 'oa-src' });
  const filePane = h('div', { class: 'oa-filepane' },
    btn('Choose .json / .yaml file', async () => {
      const f = await pickFile({ accept: '.json,.yaml,.yml,application/json,text/yaml,text/plain' });
      if (!f) return;
      try { src.set(await readTextFileChecked(f, 20 * 1024 * 1024)); toast('Loaded ' + f.name); load(); } catch (e) { msg.error('Could not open the file', e.message); }
    }, 'btn btn-ghost btn-sm', { 'data-act': 'open-file' }),
    h('p', { class: 'dt-note' }, 'The file is read in your browser — it is not uploaded.'));
  const urlPane = h('div', { class: 'oa-urlpane' },
    h('div', { class: 'dt-row' }, urlIn, primary('Fetch', () => fetchSpec(), { 'data-act': 'fetch' })),
    h('p', { class: 'dt-note' }, 'Fetched directly by your browser. The server must allow cross-origin requests (CORS); if it does not, download the spec and open it as a file instead.'));
  function showSrc(id) { clear(srcHost); srcHost.append(id === 'paste' ? src.el : id === 'file' ? filePane : urlPane); }

  async function fetchSpec() {
    const u = urlIn.value.trim();
    msg.hide();
    if (!/^https?:\/\//i.test(u)) { msg.error('Enter a full http(s):// URL.'); return; }
    let res;
    try {
      res = await fetch(u, { headers: { Accept: 'application/json, application/yaml, text/yaml, */*' }, credentials: 'omit' });
    } catch (e) {
      msg.error('The spec could not be fetched', 'The request was blocked before a response arrived. This is usually CORS: the server does not allow other websites to read it (or the URL is unreachable / not HTTPS). Download the file and use “Open file” instead.');
      return;
    }
    if (!res.ok) { msg.error(`The server answered HTTP ${res.status} ${res.statusText}`, 'Check the URL.'); return; }
    const text = await res.text();
    if (text.length > 20 * 1024 * 1024) { msg.error('The spec is larger than 20 MB.'); return; }
    src.set(text);
    load();
  }

  function load() {
    msg.hide();
    clear(view);
    let spec;
    try { spec = parseSpecText(src.get()); } catch (e) { model = null; msg.error('Could not parse the document', e.message); return; }
    model = analyze(spec);
    render();
  }

  function render() {
    clear(view);
    const m = model;
    const errs = m.issues.filter((i) => i.level === 'error'), warns = m.issues.filter((i) => i.level === 'warning');
    // header
    view.append(h('section', { class: 'dt-card oa-info' },
      h('div', { class: 'oa-titlerow' },
        h('h2', { class: 'oa-title' }, m.info.title || '(untitled API)'),
        m.info.version ? h('span', { class: 'dt-badge' }, 'v' + m.info.version) : null,
        h('span', { class: 'dt-badge is-info' }, KIND_LABEL[m.kind] + (m.version ? ` (${m.version})` : '')),
        h('span', { class: 'dt-badge ' + (errs.length ? 'is-err' : 'is-ok') }, errs.length ? `${errs.length} error${errs.length > 1 ? 's' : ''}` : '✓ Valid structure'),
        warns.length ? h('span', { class: 'dt-badge is-warn' }, `${warns.length} warning${warns.length > 1 ? 's' : ''}`) : null,
      ),
      m.info.description ? h('p', { class: 'oa-desc' }, m.info.description) : null,
      m.servers.length ? h('div', { class: 'oa-servers' }, h('strong', null, 'Servers'), h('ul', null, m.servers.map((s) => h('li', null, h('code', null, s.url), s.description ? ' — ' + s.description : '')))) : null,
      h('div', { class: 'dt-stats' },
        h('span', { class: 'dt-stat' }, 'Endpoints ', h('b', null, String(m.operations.length))),
        h('span', { class: 'dt-stat' }, 'Tags ', h('b', null, String(groupByTag(m).length))),
        h('span', { class: 'dt-stat' }, 'Auth schemes ', h('b', null, String(m.securitySchemes.length)))),
    ));
    if (m.issues.length) {
      view.append(h('details', { class: 'dt-card oa-issues', open: errs.length > 0 },
        h('summary', null, `Validation: ${errs.length} error(s), ${warns.length} warning(s)`),
        h('ul', { class: 'oa-issue-list' }, m.issues.map((i) => h('li', { class: 'oa-issue is-' + i.level }, h('span', { class: 'dt-badge ' + (i.level === 'error' ? 'is-err' : 'is-warn') }, i.level), ' ', i.message, i.at ? h('code', { class: 'oa-at' }, i.at) : null)))));
    }
    if (m.securitySchemes.length) {
      view.append(h('section', { class: 'dt-card' }, h('h3', { class: 'dt-card-title' }, 'Authentication'),
        h('div', { class: 'dt-table-wrap' }, h('table', { class: 'dt-table' },
          h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Type'), h('th', null, 'Details'))),
          h('tbody', null, m.securitySchemes.map((s) => h('tr', null, h('td', { class: 'mono' }, s.name), h('td', null, s.type || '?'), h('td', null, schemeDetails(s)))))))));
    }
    // endpoints
    const search = input({ type: 'search', placeholder: 'Search path, summary, operationId or tag…', attrs: { 'aria-label': 'Search endpoints' } });
    search.classList.add('oa-search');
    const list = h('div', { class: 'oa-groups' });
    const drawList = () => {
      clear(list);
      const matches = new Set(searchOps(m, search.value));
      const groups = groupByTag(m).map((g) => ({ ...g, ops: g.ops.filter((o) => matches.has(o)) })).filter((g) => g.ops.length);
      if (!groups.length) { list.append(h('p', { class: 'dt-note' }, m.operations.length ? 'No endpoint matches your search.' : 'This document has no operations.')); return; }
      for (const g of groups) {
        list.append(h('section', { class: 'oa-group' },
          h('h3', { class: 'oa-tag' }, g.tag, h('span', { class: 'oa-count' }, String(g.ops.length))),
          g.description ? h('p', { class: 'dt-note' }, g.description) : null,
          g.ops.map((o) => opRow(o))));
      }
    };
    search.addEventListener('input', debounce(drawList, 150));
    view.append(h('section', { class: 'oa-endpoints' }, h('div', { class: 'oa-endhead' }, h('h3', { class: 'dt-card-title' }, 'Endpoints'), search), list));
    drawList();
  }

  function schemeDetails(s) {
    if (s.type === 'apiKey') return `${s.paramName} in ${s.in}`;
    if (s.type === 'http') return `${s.scheme}${s.bearerFormat ? ' (' + s.bearerFormat + ')' : ''}`;
    if (s.type === 'oauth2') return Object.entries(s.flows || {}).map(([f, v]) => `${f}: ${[v.authorizationUrl, v.tokenUrl].filter(Boolean).join(' · ')}${v.scopes && Object.keys(v.scopes).length ? ' — scopes: ' + Object.keys(v.scopes).join(', ') : ''}`).join(' | ') || 'oauth2';
    if (s.type === 'openIdConnect') return s.openIdConnectUrl || '';
    return s.description || '';
  }

  function opRow(o) {
    const det = h('details', { class: 'oa-op' + (o.deprecated ? ' is-deprecated' : '') });
    const sum = h('summary', { class: 'oa-op-sum' },
      h('span', { class: 'cc-method cc-m-' + o.method }, o.method.toUpperCase()),
      h('code', { class: 'oa-path' }, o.path),
      h('span', { class: 'oa-sumtext' }, o.summary),
      o.deprecated ? h('span', { class: 'dt-badge is-warn' }, 'deprecated') : null);
    det.append(sum);
    let built = false;
    det.addEventListener('toggle', () => { if (det.open && !built) { built = true; det.append(opDetail(o)); } });
    return det;
  }

  function opDetail(o) {
    const root2 = model.root;
    const box = h('div', { class: 'oa-op-body' });
    const meta = [];
    if (o.operationId) meta.push(h('span', { class: 'dt-stat' }, 'operationId ', h('b', { class: 'dt-mono' }, o.operationId)));
    meta.push(h('button', { type: 'button', class: 'dt-mini', on: { click: (e) => copyText(o.path, e.currentTarget) } }, 'Copy path'));
    box.append(h('div', { class: 'dt-stats' }, meta));
    if (o.description) box.append(h('p', { class: 'oa-desc' }, o.description));
    // security
    const sec = o.security || [];
    box.append(h('p', { class: 'oa-sec' }, h('strong', null, 'Security: '), sec.length ? sec.map((r) => Object.entries(r).map(([k, v]) => k + (v && v.length ? ` (${v.join(', ')})` : '')).join(' + ') || 'none (anonymous allowed)').join('  or  ') : 'none'));
    // parameters
    if (o.parameters.length) {
      box.append(h('h4', null, 'Parameters'), h('div', { class: 'dt-table-wrap' }, h('table', { class: 'dt-table' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'In'), h('th', null, 'Type'), h('th', null, 'Required'), h('th', null, 'Description'))),
        h('tbody', null, o.parameters.map((p) => h('tr', null,
          h('td', { class: 'mono' }, p.name, p.deprecated ? ' (deprecated)' : ''), h('td', null, p.in), h('td', { class: 'mono' }, p.type),
          h('td', null, p.required ? h('span', { class: 'dt-badge is-err' }, 'required') : 'optional'), h('td', null, p.description)))))));
    }
    // request body
    if (o.requestBody) {
      box.append(h('h4', null, 'Request body', o.requestBody.required ? h('span', { class: 'dt-badge is-err oa-req' }, 'required') : null));
      if (o.requestBody.description) box.append(h('p', { class: 'oa-desc' }, o.requestBody.description));
      for (const c of o.requestBody.content) box.append(mediaBlock(root2, c));
    }
    // responses
    if (o.responses.length) {
      box.append(h('h4', null, 'Responses'));
      for (const r of o.responses) {
        const cls = /^2/.test(r.status) ? 'is-ok' : /^[45]/.test(r.status) ? 'is-err' : /^3/.test(r.status) ? 'is-info' : '';
        const rd = h('div', { class: 'oa-resp' }, h('div', { class: 'oa-resp-head' }, h('span', { class: 'dt-badge ' + cls }, r.status), ' ', r.description, r.headers && r.headers.length ? h('span', { class: 'dt-note' }, ' · headers: ' + r.headers.join(', ')) : null));
        for (const c of r.content) rd.append(mediaBlock(root2, c));
        box.append(rd);
      }
    }
    return box;
  }

  function mediaBlock(rootSpec, c) {
    const wrap = h('div', { class: 'oa-media' }, h('div', { class: 'oa-mt' }, h('code', null, c.mediaType)));
    if (c.schema) {
      const tree = schemaTree(rootSpec, c.schema);
      const ex = c.example !== undefined ? c.example : exampleFor(rootSpec, c.schema);
      const exText = typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2);
      wrap.append(h('div', { class: 'oa-media-grid' },
        h('div', { class: 'oa-schema' }, h('div', { class: 'oa-label' }, 'Schema'), treeNode(tree, true)),
        h('div', { class: 'oa-example' }, h('div', { class: 'oa-label' }, c.example !== undefined ? 'Example' : 'Example (generated)', h('button', { type: 'button', class: 'dt-mini', on: { click: (e) => copyText(exText, e.currentTarget) } }, 'Copy')), h('pre', { class: 'dt-pre oa-pre' }, exText))));
    } else if (c.example !== undefined) {
      wrap.append(h('pre', { class: 'dt-pre oa-pre' }, typeof c.example === 'string' ? c.example : JSON.stringify(c.example, null, 2)));
    }
    return wrap;
  }

  function treeNode(n, isRoot) {
    const label = h('span', { class: 'oa-node' },
      n.name ? h('span', { class: 'oa-pname' }, n.name) : null,
      n.required ? h('span', { class: 'oa-star', title: 'required' }, '*') : null,
      h('span', { class: 'oa-ptype' + (n.missing ? ' is-bad' : '') }, (n.name ? ' ' : '') + (n.refName ? n.refName + ' · ' : '') + n.type),
      n.circular ? h('span', { class: 'dt-badge' }, '↻ recursive') : null,
      n.enum ? h('span', { class: 'oa-enum' }, ' ∈ ' + n.enum.map((x) => JSON.stringify(x)).join(' | ')) : null,
      n.description ? h('span', { class: 'oa-pdesc' }, ' — ' + n.description) : null);
    if (!n.children.length) return h('div', { class: 'oa-leaf' + (isRoot ? ' is-root' : '') }, label);
    return h('details', { class: 'oa-branch', open: isRoot }, h('summary', null, label), h('div', { class: 'oa-kids' }, n.children.map((c) => treeNode(c, false))));
  }

  srcTabs.el.classList.add('oa-srctabs');
  showSrc('paste');
  root.append(
    srcTabs.el, srcHost,
    toolbar(primary('Load spec', () => load(), { 'data-act': 'load' }), btn('Load sample', () => { src.set(SAMPLE); srcTabs.set('paste'); showSrc('paste'); load(); })),
    msg.el, view,
    h('p', { class: 'dt-note' }, 'Supports OpenAPI 3.0, 3.1 and Swagger 2.0 in JSON or YAML. Only references inside the document (#/…) are resolved — external files are never fetched. Descriptions are shown as plain text.'),
  );
}
