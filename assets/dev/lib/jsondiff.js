/* Structural JSON diff. Pure functions (no DOM).
 * Objects are compared by key (key order is ignored); arrays by index, or — with opts.arrayKey —
 * by matching items that share the same value of that key (e.g. "id").
 * Each change: { op:'added'|'removed'|'changed', path:'$.a.b[2]', pointer:'/a/b/2', old?, new?, typeChanged? } */

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function childPath(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  return IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}
const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

export function diffJson(a, b, opts = {}) {
  const out = [];
  const arrayKey = opts.arrayKey ? String(opts.arrayKey) : null;
  const walk = (x, y, path, ptr, depth) => {
    if (depth > 5000) throw new Error('JSON is nested too deeply to compare.');
    const tx = typeName(x), ty = typeName(y);
    if (tx !== ty) { out.push({ op: 'changed', path, pointer: ptr, old: x, new: y, typeChanged: true, oldType: tx, newType: ty }); return; }
    if (tx === 'object') {
      for (const k of Object.keys(x)) {
        const p = childPath(path, k), pp = ptr + '/' + esc(k);
        if (Object.prototype.hasOwnProperty.call(y, k)) walk(x[k], y[k], p, pp, depth + 1);
        else out.push({ op: 'removed', path: p, pointer: pp, old: x[k] });
      }
      for (const k of Object.keys(y)) {
        if (!Object.prototype.hasOwnProperty.call(x, k)) out.push({ op: 'added', path: childPath(path, k), pointer: ptr + '/' + esc(k), new: y[k] });
      }
      return;
    }
    if (tx === 'array') {
      if (arrayKey && keyedArray(x, arrayKey) && keyedArray(y, arrayKey)) return walkKeyed(x, y, path, ptr, depth);
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) walk(x[i], y[i], childPath(path, i), ptr + '/' + i, depth + 1);
      for (let i = x.length - 1; i >= n; i--) out.push({ op: 'removed', path: childPath(path, i), pointer: ptr + '/' + i, old: x[i] });
      for (let i = n; i < y.length; i++) out.push({ op: 'added', path: childPath(path, i), pointer: ptr + '/' + i, new: y[i] });
      return;
    }
    if (!Object.is(x, y) && !(x === 0 && y === 0)) out.push({ op: 'changed', path, pointer: ptr, old: x, new: y });
  };
  const keyLabel = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
  function walkKeyed(x, y, path, ptr, depth) {
    const idxX = new Map(x.map((it, i) => [keyOf(it[arrayKey]), i]));
    const idxY = new Map(y.map((it, i) => [keyOf(it[arrayKey]), i]));
    x.forEach((it, i) => {
      const k = keyOf(it[arrayKey]);
      const p = `${path}[${arrayKey}=${keyLabel(it[arrayKey])}]`;
      if (idxY.has(k)) { const j = idxY.get(k); walk(it, y[j], p, ptr + '/' + j, depth + 1); }
      else out.push({ op: 'removed', path: p, pointer: ptr + '/' + i, old: it });
    });
    y.forEach((it, j) => {
      const k = keyOf(it[arrayKey]);
      if (!idxX.has(k)) out.push({ op: 'added', path: `${path}[${arrayKey}=${keyLabel(it[arrayKey])}]`, pointer: ptr + '/' + j, new: it });
    });
  }
  walk(a, b, '$', '', 0);
  return out;
}
const keyOf = (v) => typeName(v) + ':' + JSON.stringify(v);
/** Array qualifies for key matching when every item is an object with a unique scalar value at `key`. */
function keyedArray(arr, key) {
  const seen = new Set();
  for (const it of arr) {
    if (!isObj(it) || !(key in it) || (it[key] !== null && typeof it[key] === 'object')) return false;
    const k = keyOf(it[key]);
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

export function summarize(changes) {
  const s = { added: 0, removed: 0, changed: 0, typeChanged: 0, total: changes.length };
  for (const c of changes) { s[c.op]++; if (c.typeChanged) s.typeChanged++; }
  return s;
}

export function preview(v, max = 140) {
  let s;
  try { s = JSON.stringify(v); } catch (e) { s = String(v); }
  if (s === undefined) s = 'undefined';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Human-readable text report. */
export function toText(changes) {
  if (!changes.length) return 'No differences — the documents are equal.';
  return changes.map((c) => {
    if (c.op === 'added') return `+ ${c.path}: ${preview(c.new, 400)}`;
    if (c.op === 'removed') return `- ${c.path}: ${preview(c.old, 400)}`;
    return `~ ${c.path}: ${preview(c.old, 400)} → ${preview(c.new, 400)}${c.typeChanged ? `  (type ${c.oldType} → ${c.newType})` : ''}`;
  }).join('\n');
}

/** RFC 6902-style operations (add/remove/replace). Exactly applicable in index mode. */
export function toPatch(changes) {
  return changes.map((c) => {
    if (c.op === 'added') return { op: 'add', path: c.pointer, value: c.new };
    if (c.op === 'removed') return { op: 'remove', path: c.pointer };
    return { op: 'replace', path: c.pointer, value: c.new };
  });
}
