/* JSON → TypeScript declarations. Pure functions (no DOM).
 * Infers a union-of-shapes for every value, merges objects found in arrays (keys missing from some
 * items become optional), and names nested objects after their keys (array items singularized).
 * Identical object shapes share one declaration. */

const IDENT = /^[A-Za-z_$][\w$]*$/;
const BUILTINS = new Set(['Object', 'String', 'Number', 'Boolean', 'Array', 'Date', 'Function', 'Symbol', 'Promise', 'Map', 'Set', 'Error', 'RegExp', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract', 'JSON', 'Math', 'Element', 'Node', 'Event', 'Response', 'Request', 'Headers', 'URL', 'Window', 'Document', 'BigInt', 'Infinity', 'NaN', 'Any', 'Unknown', 'Never', 'Void', 'Null', 'Undefined', 'Intl', 'Proxy', 'Reflect', 'WeakMap', 'WeakSet', 'Iterator']);
const MAX_DEPTH = 2000;

/* ---------- inference ---------- */
// desc: {k:'string'|'number'|'boolean'|'null'} | {k:'obj', fields: Map<key,{u:Union,opt:boolean}>} | {k:'arr', items: Union}
// Union: array of descs, at most one of each kind.

function infer(v, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`JSON is nested more than ${MAX_DEPTH} levels deep — too deep to convert.`);
  if (v === null) return { k: 'null' };
  if (Array.isArray(v)) {
    let items = [];
    for (const x of v) items = addToUnion(items, infer(x, depth + 1));
    return { k: 'arr', items };
  }
  if (typeof v === 'object') {
    const fields = new Map();
    for (const [key, val] of Object.entries(v)) fields.set(key, { u: [infer(val, depth + 1)], opt: false });
    return { k: 'obj', fields };
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return { k: typeof v };
  return { k: 'unknown' };
}

function addToUnion(union, d) {
  const i = union.findIndex((x) => x.k === d.k);
  if (i < 0) return [...union, d];
  const out = union.slice();
  if (d.k === 'obj') out[i] = mergeObj(union[i], d);
  else if (d.k === 'arr') out[i] = { k: 'arr', items: mergeUnion(union[i].items, d.items) };
  return out;
}
function mergeUnion(a, b) { let u = a; for (const d of b) u = addToUnion(u, d); return u; }
function mergeObj(a, b) {
  const fields = new Map();
  for (const [key, fa] of a.fields) {
    const fb = b.fields.get(key);
    if (fb) fields.set(key, { u: mergeUnion(fa.u, fb.u), opt: fa.opt || fb.opt });
    else fields.set(key, { u: fa.u, opt: true });
  }
  for (const [key, fb] of b.fields) if (!a.fields.has(key)) fields.set(key, { u: fb.u, opt: true });
  return { k: 'obj', fields };
}

/* ---------- naming ---------- */
export function pascalCase(s) {
  const words = String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  let name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  if (!name) name = 'Item';
  if (/^\d/.test(name)) name = 'T' + name;
  return name;
}
export function singularize(name) {
  if (/ies$/.test(name) && name.length > 4) return name.slice(0, -3) + 'y';
  if (/(ss|us|is|ics)$/i.test(name)) return name;
  if (/(x|z|ch|sh|ss|us)es$/.test(name)) return name.slice(0, -2);
  if (/s$/.test(name) && name.length > 2) return name.slice(0, -1);
  return name;
}

function propKey(k) {
  return IDENT.test(k) ? k : "'" + k.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
}

/* ---------- emit ---------- */
/**
 * jsonToTs(value, { rootName='Root', useType=false, exported=true, readonly=false, indent=2 }) → string
 * value: an already-parsed JSON value.
 */
export function jsonToTs(value, opts = {}) {
  const rootName = pascalCase(opts.rootName || 'Root');
  const unit = opts.indent === 'tab' || opts.indent === '\t' ? '\t' : ' '.repeat(Number(opts.indent) || 2);
  const exp = opts.exported === false ? '' : 'export ';
  const ro = opts.readonly ? 'readonly ' : '';
  const decls = []; // {name, body}
  const bySig = new Map(); // signature → name
  const used = new Set();

  function uniqueName(base) {
    let name = BUILTINS.has(base) ? base + 'Type' : base;
    if (!used.has(name)) { used.add(name); return name; }
    let n = 2;
    while (used.has(name + n)) n++;
    used.add(name + n);
    return name + n;
  }

  const sigCache = new WeakMap();
  function sig(d) {
    if (d.k !== 'obj' && d.k !== 'arr') return d.k;
    if (sigCache.has(d)) return sigCache.get(d);
    let s;
    if (d.k === 'arr') s = '[' + unionSig(d.items) + ']';
    else s = '{' + [...d.fields.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, f]) => JSON.stringify(k) + (f.opt ? '?' : '') + ':' + unionSig(f.u)).join(',') + '}';
    sigCache.set(d, s);
    return s;
  }
  const unionSig = (u) => u.map(sig).sort().join('|');

  // name objects depth-first in document order so the root comes first
  function nameObj(d, hint) {
    if (!d.fields.size) return 'Record<string, unknown>';
    const s = sig(d);
    if (bySig.has(s)) return bySig.get(s);
    const name = uniqueName(hint);
    bySig.set(s, name);
    const slot = { name, body: null };
    decls.push(slot);
    const lines = [];
    for (const [key, f] of d.fields) {
      const t = typeOf(f.u, pascalCase(key));
      lines.push(`${unit}${ro}${propKey(key)}${f.opt ? '?' : ''}: ${t};`);
    }
    slot.body = lines;
    return name;
  }

  function typeOf(u, hint) {
    if (!u.length) return 'unknown';
    const order = { obj: 0, arr: 1, string: 2, number: 3, boolean: 4, unknown: 5, null: 6 };
    const parts = [...u].sort((a, b) => order[a.k] - order[b.k]).map((d) => {
      if (d.k === 'obj') return nameObj(d, hint);
      if (d.k === 'arr') {
        if (!d.items.length) return 'unknown[]';
        const inner = typeOf(d.items, singularOrItem(hint));
        return (inner.includes('|') ? `(${inner})` : inner) + '[]';
      }
      return d.k;
    });
    return [...new Set(parts)].join(' | ');
  }
  function singularOrItem(hint) { const s = singularize(hint); return s === hint ? hint + 'Item' : s; }

  const root = infer(value);
  used.add(rootName);
  if (root.k === 'obj' && root.fields.size) {
    used.delete(rootName);
    nameObj(root, rootName);
  } else {
    const t = root.k === 'arr' ? typeOf([root], rootName) : typeOf([root], rootName);
    decls.unshift({ name: rootName, alias: t });
  }

  return decls.map((dcl) => {
    if (dcl.alias) return `${exp}type ${dcl.name} = ${dcl.alias};`;
    const body = dcl.body.join('\n');
    return opts.useType
      ? `${exp}type ${dcl.name} = {\n${body}\n};`
      : `${exp}interface ${dcl.name} {\n${body}\n}`;
  }).join('\n\n') + '\n';
}
