import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { jsonToTs, pascalCase, singularize } from '../../assets/dev/lib/jsonts.js';

const require = createRequire(import.meta.url);
// Optional real type-check: set TYPESCRIPT_PATH=/path/to/node_modules/typescript (not a dependency of this repo).
let ts = null;
try { ts = require(process.env.TYPESCRIPT_PATH || 'typescript'); } catch (e) { ts = null; }

function typeCheck(code, usage = '') {
  if (!ts) return null;
  const file = 'gen.ts';
  const source = code + '\n' + usage;
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile;
  host.getSourceFile = (name, lang) => (name === file ? ts.createSourceFile(name, source, lang) : orig(name, lang));
  const program = ts.createProgram([file], { noEmit: true, strict: true, lib: ['lib.es2020.d.ts'], types: [] }, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

const SAMPLE = {
  id: 1, name: 'x', 'my-key': true, "it's": 1, owner: { name: 'a', tags: ['t'] },
  users: [{ id: 1, email: 'a', addr: { city: 'x' } }, { id: 2, email: null, nick: 'n' }],
  mixed: [1, 'a'], empty: [], meta: {}, billing: { city: 'a', zip: '1' }, shipping: { city: 'b', zip: '2' },
  categories: [{ n: 1 }], date: { d: 1 }, matrix: [[1, 2], [3]], 'ünïcødé': 'ok', '2fa': false,
};

test('root interface, nested names, optional & nullable fields', () => {
  const out = jsonToTs(SAMPLE);
  assert.match(out, /^export interface Root \{/);
  assert.match(out, /owner: Owner;/);
  assert.match(out, /users: User\[\];/);
  assert.match(out, /export interface User \{\n  id: number;\n  email: string \| null;\n  addr\?: Addr;\n  nick\?: string;\n\}/);
  assert.match(out, /mixed: \(string \| number\)\[\];/);
  assert.match(out, /empty: unknown\[\];/);
  assert.match(out, /meta: Record<string, unknown>;/);
  assert.match(out, /categories: Category\[\];/);
  assert.match(out, /matrix: number\[\]\[\];/);
});
test('invalid identifiers are quoted (and escaped)', () => {
  const out = jsonToTs(SAMPLE);
  assert.match(out, /'my-key': boolean;/);
  assert.match(out, /'it\\'s': number;/);
  assert.match(out, /'2fa': boolean;/);
  assert.match(out, /'ünïcødé': string;/);
});
test('identical shapes are deduplicated; builtin names avoided', () => {
  const out = jsonToTs(SAMPLE);
  assert.match(out, /billing: Billing;/);
  assert.match(out, /shipping: Billing;/);
  assert.equal((out.match(/interface Billing /g) || []).length, 1);
  assert.match(out, /date: DateType;/);
});
test('name collisions get numeric suffixes', () => {
  const out = jsonToTs({ data: { x: 1 }, Data: { y: 2 } });
  assert.match(out, /data: Data;/);
  assert.match(out, /Data: Data2;/);
});
test('type aliases, no export, readonly', () => {
  const out = jsonToTs({ a: { b: 1 } }, { useType: true, exported: false, readonly: true, rootName: 'api response' });
  assert.equal(out, 'type ApiResponse = {\n  readonly a: A;\n};\n\ntype A = {\n  readonly b: number;\n};\n');
});
test('array and scalar roots', () => {
  assert.equal(jsonToTs([{ a: 1 }, { b: 'x' }], { rootName: 'items' }), 'export type Items = Item[];\n\nexport interface Item {\n  a?: number;\n  b?: string;\n}\n');
  assert.equal(jsonToTs('s'), 'export type Root = string;\n');
  assert.equal(jsonToTs(null), 'export type Root = null;\n');
  assert.equal(jsonToTs([]), 'export type Root = unknown[];\n');
});
test('array of objects merged with nested arrays of objects', () => {
  const out = jsonToTs({ orders: [{ items: [{ sku: 'a' }] }, { items: [{ sku: 'b', qty: 1 }] }] });
  assert.match(out, /export interface Item \{\n  sku: string;\n  qty\?: number;\n\}/);
});
test('helpers', () => {
  assert.equal(pascalCase('user_name'), 'UserName');
  assert.equal(pascalCase('createdAt'), 'CreatedAt');
  assert.equal(pascalCase('123'), 'T123');
  assert.equal(pascalCase('---'), 'Item');
  assert.equal(singularize('Categories'), 'Category');
  assert.equal(singularize('Addresses'), 'Address');
  assert.equal(singularize('Boxes'), 'Box');
  assert.equal(singularize('Status'), 'Status');
  assert.equal(singularize('Statuses'), 'Status');
  assert.equal(singularize('Users'), 'User');
});
test('large input (5k array items) is fast', () => {
  const arr = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: 'n' + i, tags: ['a'], extra: i % 2 ? { x: i } : undefined }));
  const t0 = performance.now();
  const out = jsonToTs(JSON.parse(JSON.stringify(arr)));
  assert.ok(performance.now() - t0 < 2000);
  assert.match(out, /extra\?: Extra;/);
});
test('generated code type-checks with the real TypeScript compiler (when available)', { skip: !ts && 'set TYPESCRIPT_PATH to enable' }, () => {
  const out = jsonToTs(SAMPLE);
  const usage = `const v: Root = ${JSON.stringify(SAMPLE)};\nconst u: User = { id: 3, email: null };\nexport { v, u };`;
  assert.deepEqual(typeCheck(out, usage), []);
  const out2 = jsonToTs({ a: { b: [1, null] } }, { useType: true, readonly: true });
  assert.deepEqual(typeCheck(out2, 'const r: Root = { a: { b: [1, null] } }; export { r };'), []);
  // and the checker really catches a mismatch
  assert.ok(typeCheck(out, 'const bad: User = { id: "x", email: null }; export { bad };').length > 0);
});
