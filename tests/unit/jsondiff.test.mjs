import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffJson, summarize, toText, toPatch } from '../../assets/dev/lib/jsondiff.js';

// minimal RFC 6902 applier for verification
function apply(doc, ops) {
  let root = structuredClone(doc);
  for (const op of ops) {
    if (op.path === '') { root = structuredClone(op.value); continue; }
    const parts = op.path.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = parts.pop();
    let parent = root;
    for (const p of parts) parent = parent[Array.isArray(parent) ? Number(p) : p];
    if (Array.isArray(parent)) {
      const i = last === '-' ? parent.length : Number(last);
      if (op.op === 'add') parent.splice(i, 0, structuredClone(op.value));
      else if (op.op === 'remove') parent.splice(i, 1);
      else parent[i] = structuredClone(op.value);
    } else if (op.op === 'remove') delete parent[last];
    else parent[last] = structuredClone(op.value);
  }
  return root;
}

test('identical documents (key order ignored)', () => {
  assert.deepEqual(diffJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), []);
  assert.equal(toText([]), 'No differences — the documents are equal.');
});
test('added / removed / changed with paths', () => {
  const d = diffJson({ a: 1, b: { c: 'x' }, gone: true }, { a: 2, b: { c: 'x', d: null }, 'new key': [1] });
  assert.deepEqual(d.map((c) => [c.op, c.path]), [['changed', '$.a'], ['added', '$.b.d'], ['removed', '$.gone'], ['added', '$["new key"]']]);
  assert.deepEqual(summarize(d), { added: 2, removed: 1, changed: 1, typeChanged: 0, total: 4 });
});
test('type changes are flagged', () => {
  const d = diffJson({ zip: '380001', x: [1], y: null }, { zip: 380001, x: { 0: 1 }, y: 0 });
  assert.equal(d.length, 3);
  assert.ok(d.every((c) => c.typeChanged));
  assert.equal(d[0].oldType, 'string'); assert.equal(d[0].newType, 'number');
  assert.match(toText(d), /type string → number/);
});
test('arrays by index: growth and shrink', () => {
  assert.deepEqual(diffJson([1, 2], [1, 3, 4]).map((c) => [c.op, c.path]), [['changed', '$[1]'], ['added', '$[2]']]);
  assert.deepEqual(diffJson([1, 2, 3, 4], [1]).map((c) => [c.op, c.path]), [['removed', '$[3]'], ['removed', '$[2]'], ['removed', '$[1]']]);
});
test('arrays matched by key ignore re-ordering', () => {
  const a = { users: [{ id: 1, role: 'admin' }, { id: 2, role: 'viewer' }, { id: 3 }] };
  const b = { users: [{ id: 2, role: 'editor' }, { id: 1, role: 'admin' }, { id: 4 }] };
  const d = diffJson(a, b, { arrayKey: 'id' });
  assert.deepEqual(d.map((c) => [c.op, c.path]), [['changed', '$.users[id=2].role'], ['removed', '$.users[id=3]'], ['added', '$.users[id=4]']]);
  // without the key: index-based
  assert.ok(diffJson(a, b).length > 3);
});
test('key matching falls back to index when keys are missing or duplicated', () => {
  const d = diffJson([{ id: 1 }, { id: 1 }], [{ id: 1 }, { id: 2 }], { arrayKey: 'id' });
  assert.deepEqual(d.map((c) => c.path), ['$[1].id']);
});
test('unicode keys and values; special characters in pointers', () => {
  const d = diffJson({ 'a/b': 1, 'm~n': 'é' }, { 'a/b': 2, 'm~n': '日本' });
  assert.deepEqual(d.map((c) => c.pointer), ['/a~1b', '/m~0n']);
});
test('JSON Patch output reproduces the target document (index mode)', () => {
  const A = { a: 1, list: [1, 2, 3, 4], obj: { x: [{ y: 1 }], drop: 'me' }, t: 'x' };
  const B = { a: 2, list: [1, 5], obj: { x: [{ y: 2 }, { z: 3 }], add: { deep: true } }, t: 1, extra: 'é' };
  assert.deepEqual(apply(A, toPatch(diffJson(A, B))), B);
  assert.deepEqual(apply([1, 2], toPatch(diffJson([1, 2], { a: 1 }))), { a: 1 });
});
test('large documents diff quickly', () => {
  const A = Array.from({ length: 20000 }, (_, i) => ({ id: i, v: i }));
  const B = A.map((o) => (o.id % 1000 === 0 ? { ...o, v: -1 } : o));
  const t0 = performance.now();
  const d = diffJson(A, B);
  assert.equal(d.length, 20);
  assert.ok(performance.now() - t0 < 2000);
});
