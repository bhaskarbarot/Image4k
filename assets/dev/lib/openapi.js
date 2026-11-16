/* OpenAPI 3.0 / 3.1 and Swagger 2.0 — parse, normalize and validate. Pure functions (no DOM).
 * Only internal "#/…" $refs are resolved (with cycle protection). External refs are never fetched. */
import { reformat } from './json.js';
import { parseYaml } from './yaml.js';

export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const PATH_ITEM_KEYS = new Set([...METHODS, 'parameters', 'summary', 'description', 'servers', '$ref']);

/** Parse JSON or YAML text into an object (precise errors). */
export function parseSpecText(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Paste an OpenAPI / Swagger document first.');
  if (t[0] === '{' || t[0] === '[') {
    try { return JSON.parse(t); } catch (e) { reformat(t, { indent: 0 }); throw e; }
  }
  const { value, docs } = parseYaml(t);
  if (docs > 1) throw new Error('The YAML contains several documents (---); an OpenAPI spec must be a single document.');
  return value;
}

/* ---------- JSON pointer / $ref ---------- */
export function resolvePointer(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return { external: true };
  if (ref === '#') return { value: root };
  if (!ref.startsWith('#/')) return { missing: true };
  let cur = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur == null || typeof cur !== 'object' || !(key in cur)) return { missing: true };
    cur = cur[key];
  }
  return { value: cur };
}

/** Follow a chain of $ref objects. Returns { node, ref, circular, missing, external }. */
export function deref(root, node, seen = new Set()) {
  let ref = null;
  while (node && typeof node === 'object' && typeof node.$ref === 'string') {
    ref = node.$ref;
    if (seen.has(ref)) return { node: null, ref, circular: true };
    seen.add(ref);
    const r = resolvePointer(root, ref);
    if (r.external) return { node: null, ref, external: true };
    if (r.missing) return { node: null, ref, missing: true };
    node = r.value;
  }
  return { node, ref };
}

/* ---------- schema helpers ---------- */
export function typeLabel(s) {
  if (!s || typeof s !== 'object') return 'any';
  let t = s.type;
  if (Array.isArray(t)) t = t.join(' | ');
  if (!t) {
    if (s.properties || s.additionalProperties) t = 'object';
    else if (s.items) t = 'array';
    else if (s.allOf) t = 'allOf';
    else if (s.oneOf) t = 'oneOf';
    else if (s.anyOf) t = 'anyOf';
    else if (s.enum) t = 'enum';
    else if ('const' in s) t = 'const';
    else t = 'any';
  }
  if (t === 'array' && s.items && typeof s.items === 'object') t = 'array';
  if (s.format) t += ` <${s.format}>`;
  if (s.nullable) t += ' | null';
  return t;
}

/**
 * schemaTree(root, schema, opts) → node { name, type, required, description, enum, ref, circular, missing, children[] }
 * Expands lazily up to maxDepth; refs already on the current branch are marked circular.
 */
export function schemaTree(root, schema, { name = '', required = false, depth = 0, maxDepth = 8, stack = [] } = {}) {
  const d = deref(root, schema, new Set());
  const ref = d.ref;
  const node = { name, required, ref, type: 'any', children: [] };
  if (d.missing) { node.type = 'unresolved $ref'; node.missing = true; return node; }
  if (d.external) { node.type = 'external $ref'; node.external = true; return node; }
  if (d.circular || (ref && stack.includes(ref))) { node.type = (ref || '').split('/').pop() || 'recursive'; node.circular = true; return node; }
  const s = d.node;
  if (s === true || s === undefined || s === null) { node.type = 'any'; return node; }
  if (s === false) { node.type = 'never'; return node; }
  if (typeof s !== 'object') return node;
  node.type = typeLabel(s);
  if (ref) node.refName = ref.split('/').pop();
  for (const k of ['description', 'title', 'default', 'example', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'readOnly', 'writeOnly', 'deprecated']) if (s[k] !== undefined) node[k] = s[k];
  if (Array.isArray(s.enum)) node.enum = s.enum;
  if ('const' in s) node.const = s.const;
  if (depth >= maxDepth) { node.truncated = true; return node; }
  const nextStack = ref ? [...stack, ref] : stack;
  const sub = (sch, nm, req) => schemaTree(root, sch, { name: nm, required: req, depth: depth + 1, maxDepth, stack: nextStack });
  if (s.properties && typeof s.properties === 'object') {
    const req = new Set(Array.isArray(s.required) ? s.required : []);
    for (const [k, v] of Object.entries(s.properties)) node.children.push(sub(v, k, req.has(k)));
  }
  if (s.additionalProperties && typeof s.additionalProperties === 'object') node.children.push(sub(s.additionalProperties, '[key: string]', false));
  if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) node.children.push(sub(s.items, '[items]', false));
  if (Array.isArray(s.prefixItems)) s.prefixItems.forEach((it, i) => node.children.push(sub(it, `[${i}]`, false)));
  for (const comb of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(s[comb])) s[comb].forEach((it, i) => node.children.push(sub(it, `${comb}[${i}]`, false)));
  }
  return node;
}

/** Build a sample value from a schema (example/default/enum first). */
export function exampleFor(root, schema, depth = 0, stack = []) {
  const d = deref(root, schema, new Set());
  if (!d.node || typeof d.node !== 'object') return d.circular ? '<recursive>' : null;
  if (d.ref && stack.includes(d.ref)) return '<recursive>';
  const st = d.ref ? [...stack, d.ref] : stack;
  const s = d.node;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (depth > 6) return null;
  if (Array.isArray(s.allOf)) {
    const out = {};
    for (const part of s.allOf) { const v = exampleFor(root, part, depth + 1, st); if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, v); }
    return out;
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length) return exampleFor(root, s.oneOf[0], depth + 1, st);
  if (Array.isArray(s.anyOf) && s.anyOf.length) return exampleFor(root, s.anyOf[0], depth + 1, st);
  let t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (!t) t = s.properties ? 'object' : s.items ? 'array' : 'string';
  switch (t) {
    case 'object': {
      const o = {};
      for (const [k, v] of Object.entries(s.properties || {})) o[k] = exampleFor(root, v, depth + 1, st);
      return o;
    }
    case 'array': return s.items ? [exampleFor(root, s.items, depth + 1, st)] : [];
    case 'integer': return s.minimum ?? 0;
    case 'number': return s.minimum ?? 0;
    case 'boolean': return true;
    case 'null': return null;
    default: {
      const f = s.format;
      if (f === 'date-time') return '2026-01-01T12:00:00Z';
      if (f === 'date') return '2026-01-01';
      if (f === 'email') return 'user@example.com';
      if (f === 'uuid') return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
      if (f === 'uri' || f === 'url') return 'https://example.com';
      if (f === 'binary' || f === 'byte') return '<binary>';
      return 'string';
    }
  }
}

/* ---------- normalize + validate ---------- */

/**
 * analyze(spec) → normalized model + issues. Never throws for structurally odd documents;
 * problems are reported in `issues` ({level:'error'|'warning', message, at}).
 */
export function analyze(spec) {
  const issues = [];
  const err = (message, at) => issues.push({ level: 'error', message, at });
  const warn = (message, at) => issues.push({ level: 'warning', message, at });
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    err('The document is not an object.', '');
    return { kind: 'unknown', version: null, info: {}, servers: [], securitySchemes: [], tags: [], operations: [], issues, root: spec };
  }
  let kind = 'unknown', version = null;
  if (typeof spec.openapi === 'string') {
    version = spec.openapi;
    if (/^3\.1\.\d+/.test(version)) kind = 'openapi31';
    else if (/^3\.0\.\d+/.test(version)) kind = 'openapi30';
    else { kind = 'openapi30'; warn(`Unrecognised OpenAPI version "${version}" — treated as 3.0.`, 'openapi'); }
  } else if (spec.swagger !== undefined) {
    version = String(spec.swagger);
    kind = 'swagger2';
    if (version !== '2.0') err(`Swagger version must be "2.0" (found "${version}").`, 'swagger');
  } else {
    err('Missing "openapi" (3.x) or "swagger" (2.0) version field — this does not look like an OpenAPI document.', '');
  }
  const isV2 = kind === 'swagger2';

  // info
  const info = spec.info && typeof spec.info === 'object' ? spec.info : {};
  if (!spec.info) err('Missing required "info" object.', 'info');
  else {
    if (!info.title) err('Missing required "info.title".', 'info.title');
    if (info.version === undefined || info.version === '') err('Missing required "info.version".', 'info.version');
  }

  // servers
  let servers = [];
  if (isV2) {
    const schemes = Array.isArray(spec.schemes) && spec.schemes.length ? spec.schemes : ['https'];
    if (spec.host) servers = schemes.map((s) => ({ url: `${s}://${spec.host}${spec.basePath || ''}` }));
    else if (spec.basePath) servers = [{ url: spec.basePath, description: 'basePath (host not specified)' }];
  } else if (Array.isArray(spec.servers)) {
    servers = spec.servers.filter((s) => s && typeof s === 'object').map((s) => ({ url: String(s.url ?? ''), description: s.description, variables: s.variables }));
    servers.forEach((s, i) => { if (!s.url) err('Server is missing "url".', `servers[${i}]`); });
  }

  // security schemes
  const rawSchemes = isV2 ? spec.securityDefinitions || {} : (spec.components && spec.components.securitySchemes) || {};
  const securitySchemes = [];
  for (const [name, raw] of Object.entries(rawSchemes)) {
    const d = deref(spec, raw);
    const s = d.node || {};
    if (d.missing) err(`Security scheme "${name}" has an unresolved $ref ${d.ref}.`, `securitySchemes.${name}`);
    const item = { name, type: s.type, description: s.description };
    if (s.type === 'apiKey') { item.in = s.in; item.paramName = s.name; if (!s.in || !s.name) err(`apiKey scheme "${name}" needs "in" and "name".`, `securitySchemes.${name}`); }
    else if (s.type === 'http') { item.scheme = s.scheme; item.bearerFormat = s.bearerFormat; if (!s.scheme) err(`http scheme "${name}" needs "scheme" (e.g. bearer, basic).`, `securitySchemes.${name}`); }
    else if (s.type === 'basic') { item.type = 'http'; item.scheme = 'basic'; }
    else if (s.type === 'oauth2') {
      if (isV2) item.flows = { [s.flow || 'unknown']: { authorizationUrl: s.authorizationUrl, tokenUrl: s.tokenUrl, scopes: s.scopes || {} } };
      else item.flows = s.flows || {};
      if (!isV2 && !s.flows) err(`oauth2 scheme "${name}" needs "flows".`, `securitySchemes.${name}`);
    } else if (s.type === 'openIdConnect') { item.openIdConnectUrl = s.openIdConnectUrl; if (!s.openIdConnectUrl) err(`openIdConnect scheme "${name}" needs "openIdConnectUrl".`, `securitySchemes.${name}`); }
    else if (s.type === 'mutualTLS') { /* 3.1 */ }
    else err(`Security scheme "${name}" has an unknown type "${s.type}".`, `securitySchemes.${name}`);
    securitySchemes.push(item);
  }
  const schemeNames = new Set(securitySchemes.map((s) => s.name));
  const checkSecurity = (sec, at) => {
    if (!Array.isArray(sec)) return [];
    for (const reqObj of sec) for (const nm of Object.keys(reqObj || {})) if (!schemeNames.has(nm)) err(`Security requirement uses undefined scheme "${nm}".`, at);
    return sec;
  };
  const globalSecurity = checkSecurity(spec.security, 'security');

  // tags
  const tags = Array.isArray(spec.tags) ? spec.tags.filter((t) => t && t.name).map((t) => ({ name: String(t.name), description: t.description })) : [];

  // paths
  const operations = [];
  const opIds = new Map();
  const paths = spec.paths;
  if (paths === undefined) {
    if (kind === 'openapi31' && (spec.webhooks || spec.components)) warn('No "paths" — allowed in OpenAPI 3.1 when webhooks/components are present.', 'paths');
    else err('Missing required "paths" object.', 'paths');
  } else if (typeof paths !== 'object' || Array.isArray(paths)) err('"paths" must be an object.', 'paths');
  else {
    for (const [path, rawItem] of Object.entries(paths)) {
      if (path.startsWith('x-')) continue;
      const at = `paths.${path}`;
      if (!path.startsWith('/')) err(`Path "${path}" must start with "/".`, at);
      const di = deref(spec, rawItem);
      if (di.missing || di.circular) { err(`Path item ${path} has an unresolved $ref.`, at); continue; }
      if (di.external) { warn(`Path item ${path} references an external file (${di.ref}) — not loaded.`, at); continue; }
      const item = di.node || {};
      for (const key of Object.keys(item)) if (!PATH_ITEM_KEYS.has(key) && !key.startsWith('x-')) warn(`"${key}" is not a valid HTTP method or path-item field (in ${path}).`, at);
      const templ = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const pathParams = Array.isArray(item.parameters) ? item.parameters : [];
      for (const method of METHODS) {
        const rawOp = item[method];
        if (!rawOp) continue;
        if (isV2 && method === 'trace') warn('Swagger 2.0 does not support "trace".', `${at}.${method}`);
        const op = typeof rawOp === 'object' ? rawOp : {};
        const oat = `${method.toUpperCase()} ${path}`;
        // parameters: path-level, overridden by op-level (same name+in)
        const merged = new Map();
        const addParams = (list, level) => {
          if (list === undefined) return;
          if (!Array.isArray(list)) { err(`"parameters" must be an array (${level}).`, oat); return; }
          const seen = new Set();
          for (const rp of list) {
            const d = deref(spec, rp);
            if (d.missing) { err(`Parameter $ref ${d.ref} cannot be resolved.`, oat); continue; }
            if (d.external) { warn(`Parameter $ref ${d.ref} is external — not loaded.`, oat); continue; }
            if (d.circular) { err(`Parameter $ref ${d.ref} is circular.`, oat); continue; }
            const p = d.node || {};
            if (!p.name || !p.in) { err('Parameter is missing "name" or "in".', oat); continue; }
            const allowed = isV2 ? ['query', 'header', 'path', 'formData', 'body'] : ['query', 'header', 'path', 'cookie'];
            if (!allowed.includes(p.in)) err(`Parameter "${p.name}" has invalid location in: "${p.in}".`, oat);
            const key = p.in + ':' + p.name;
            if (seen.has(key)) err(`Duplicate parameter "${p.name}" (in: ${p.in}).`, oat);
            seen.add(key);
            if (p.in === 'path' && p.required !== true) err(`Path parameter "${p.name}" must have required: true.`, oat);
            merged.set(key, p);
          }
        };
        addParams(pathParams.length ? pathParams : undefined, 'path item');
        addParams(op.parameters, 'operation');
        const params = [...merged.values()];
        const declaredPath = params.filter((p) => p.in === 'path').map((p) => p.name);
        for (const t of templ) if (!declaredPath.includes(t)) err(`Path parameter {${t}} is used in the path but not declared.`, oat);
        for (const p of declaredPath) if (!templ.includes(p)) err(`Path parameter "${p}" is declared but not used in the path.`, oat);
        if (op.operationId) {
          if (opIds.has(op.operationId)) err(`Duplicate operationId "${op.operationId}" (also used by ${opIds.get(op.operationId)}).`, oat);
          else opIds.set(op.operationId, oat);
        }
        // request body
        let requestBody = null;
        if (isV2) {
          const consumes = op.consumes || spec.consumes || ['application/json'];
          const bodyP = params.find((p) => p.in === 'body');
          const formP = params.filter((p) => p.in === 'formData');
          if (bodyP) requestBody = { required: !!bodyP.required, description: bodyP.description, content: consumes.map((mt) => ({ mediaType: mt, schema: bodyP.schema })) };
          else if (formP.length) {
            const hasFile = formP.some((p) => p.type === 'file');
            const schema = { type: 'object', properties: Object.fromEntries(formP.map((p) => [p.name, { type: p.type === 'file' ? 'string' : p.type, format: p.type === 'file' ? 'binary' : p.format, description: p.description }])), required: formP.filter((p) => p.required).map((p) => p.name) };
            requestBody = { required: formP.some((p) => p.required), content: [{ mediaType: hasFile ? 'multipart/form-data' : 'application/x-www-form-urlencoded', schema }] };
          }
        } else if (op.requestBody) {
          const d = deref(spec, op.requestBody);
          if (d.missing) err(`requestBody $ref ${d.ref} cannot be resolved.`, oat);
          else if (d.node) {
            const rb = d.node;
            requestBody = { required: !!rb.required, description: rb.description, content: Object.entries(rb.content || {}).map(([mt, m]) => ({ mediaType: mt, schema: m && m.schema, example: mediaExample(spec, m) })) };
            if (!rb.content) err('requestBody must have "content".', oat);
          }
        }
        // responses
        const responses = [];
        if (op.responses === undefined) { if (kind !== 'openapi31') err('Operation has no "responses".', oat); }
        else if (typeof op.responses !== 'object') err('"responses" must be an object.', oat);
        else {
          if (!Object.keys(op.responses).filter((k) => !k.startsWith('x-')).length) err('"responses" must contain at least one response.', oat);
          for (const [status, rr] of Object.entries(op.responses)) {
            if (status.startsWith('x-')) continue;
            if (!/^([1-5]\d\d|[1-5]XX|default)$/.test(status)) warn(`Response key "${status}" is not a valid status code (use e.g. 200, 4XX or default).`, oat);
            const d = deref(spec, rr);
            if (d.missing) { err(`Response ${status} $ref ${d.ref} cannot be resolved.`, oat); responses.push({ status, description: '(unresolved $ref)', content: [] }); continue; }
            if (d.external) { warn(`Response ${status} $ref ${d.ref} is external — not loaded.`, oat); responses.push({ status, description: '(external $ref)', content: [] }); continue; }
            const r = d.node || {};
            if (r.description === undefined) warn(`Response ${status} has no "description" (required by the spec).`, oat);
            let content;
            if (isV2) {
              const produces = op.produces || spec.produces || ['application/json'];
              content = r.schema ? produces.map((mt) => ({ mediaType: mt, schema: r.schema, example: r.examples && r.examples[mt] })) : [];
            } else content = Object.entries(r.content || {}).map(([mt, m]) => ({ mediaType: mt, schema: m && m.schema, example: mediaExample(spec, m) }));
            responses.push({ status, description: r.description || '', content, headers: r.headers ? Object.keys(r.headers) : [] });
          }
        }
        const opTags = Array.isArray(op.tags) && op.tags.length ? op.tags.map(String) : ['default'];
        for (const t of opTags) if (t !== 'default' && !tags.find((x) => x.name === t)) tags.push({ name: t });
        operations.push({
          id: `${method}-${path}`, method, path, summary: op.summary || '', description: op.description || '', operationId: op.operationId || '',
          tags: opTags, deprecated: !!op.deprecated,
          parameters: params.filter((p) => !isV2 || (p.in !== 'body' && p.in !== 'formData')).map((p) => ({
            in: p.in, name: p.name, required: !!p.required, deprecated: !!p.deprecated, description: p.description || '',
            type: isV2 && !p.schema ? typeLabel({ type: p.type, format: p.format, items: p.items }) + (p.type === 'array' && p.items ? `<${p.items.type}>` : '') : typeLabel(deref(spec, p.schema).node || p.schema),
            schema: p.schema,
          })),
          requestBody, responses,
          security: op.security !== undefined ? checkSecurity(op.security, oat) : globalSecurity,
          securityOverridden: op.security !== undefined,
        });
      }
    }
  }

  // every $ref in the document must resolve
  const refIssues = new Set();
  walkRefs(spec, (ref, at) => {
    if (ref.startsWith('#')) { if (resolvePointer(spec, ref).missing && !refIssues.has(ref)) { refIssues.add(ref); err(`Unresolved $ref "${ref}".`, at); } }
    else if (!refIssues.has(ref)) { refIssues.add(ref); warn(`External $ref "${ref}" is not loaded (only references inside this document are resolved).`, at); }
  });
  // de-duplicate identical messages
  const seenMsg = new Set();
  const uniq = issues.filter((i) => { const k = i.level + i.message; if (seenMsg.has(k)) return false; seenMsg.add(k); return true; });
  return { kind, version, info: { title: info.title || '', version: info.version != null ? String(info.version) : '', description: info.description || '', contact: info.contact, license: info.license, termsOfService: info.termsOfService }, servers, securitySchemes, globalSecurity, tags, operations, issues: uniq, root: spec };
}

function mediaExample(root, m) {
  if (!m || typeof m !== 'object') return undefined;
  if (m.example !== undefined) return m.example;
  if (m.examples && typeof m.examples === 'object') {
    const first = Object.values(m.examples)[0];
    const d = deref(root, first);
    if (d.node && d.node.value !== undefined) return d.node.value;
  }
  return undefined;
}

function walkRefs(node, fn, at = '', seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (typeof node.$ref === 'string') fn(node.$ref, at);
  for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walkRefs(v, fn, at ? at + '.' + k : k, seen);
}

export const KIND_LABEL = { openapi30: 'OpenAPI 3.0', openapi31: 'OpenAPI 3.1', swagger2: 'Swagger 2.0', unknown: 'Unknown' };

/** Group operations by tag (keeps tag order from the document, "default" last). */
export function groupByTag(model) {
  const order = model.tags.map((t) => t.name);
  const groups = new Map();
  for (const op of model.operations) for (const t of op.tags) { if (!groups.has(t)) groups.set(t, []); groups.get(t).push(op); }
  return [...groups.entries()].sort((a, b) => {
    const ia = a[0] === 'default' ? 1e9 : order.indexOf(a[0]) === -1 ? 1e8 : order.indexOf(a[0]);
    const ib = b[0] === 'default' ? 1e9 : order.indexOf(b[0]) === -1 ? 1e8 : order.indexOf(b[0]);
    return ia - ib;
  }).map(([tag, ops]) => ({ tag, description: (model.tags.find((t) => t.name === tag) || {}).description || '', ops }));
}

export function searchOps(model, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return model.operations;
  return model.operations.filter((o) => [o.path, o.summary, o.operationId, o.method, o.description, ...o.tags].join(' ').toLowerCase().includes(q));
}
