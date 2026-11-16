import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OPS, runRecipe, RecipeError, opById, encodeRecipe, decodeRecipe, sanitizeRecipe, defaultArgs } from '../../assets/dev/lib/ops.js';

const run = async (input, ...steps) => (await runRecipe(input, steps.map((s) => (typeof s === 'string' ? { op: s } : s)))).value;
const dec = (v) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : v);

test('every op from the spec exists and has a valid definition', () => {
  const required = ['base64-encode', 'base64-decode', 'url-encode', 'url-decode', 'html-encode', 'html-decode', 'hex-encode', 'hex-decode', 'binary-encode', 'binary-decode',
    'utf8-encode', 'decode-text', 'md5', 'sha1', 'sha256', 'sha512', 'uppercase', 'lowercase', 'reverse', 'remove-whitespace', 'dedupe-lines', 'sort-lines', 'trim-lines',
    'find-replace', 'substring', 'count-chars', 'count-words', 'json-beautify', 'json-minify', 'json-to-csv', 'csv-to-json', 'xml-format', 'yaml-to-json', 'json-to-yaml',
    'hex-to-bytes', 'bytes-to-hex', 'binary-to-hex', 'hex-to-binary', 'generate-uuid', 'parse-url', 'extract-urls', 'extract-emails', 'extract-ips', 'extract-domains'];
  for (const id of required) assert.ok(opById(id), id);
  assert.equal(new Set(OPS.map((o) => o.id)).size, OPS.length, 'unique ids');
  for (const o of OPS) { assert.ok(o.name && o.category && typeof o.run === 'function' && ['string', 'bytes'].includes(o.input) && ['string', 'bytes'].includes(o.output), o.id); }
});

test('single op', async () => { assert.equal(await run('hello', 'uppercase'), 'HELLO'); });
test('chain: text → base64 → url-encode → url-decode → base64 decode', async () => {
  assert.equal(dec(await run('Zoë 🚀?', 'base64-encode', 'url-encode', 'url-decode', 'base64-decode')), 'Zoë 🚀?');
});
test('chain: hex → bytes → sha256 equals sha256 of decoded text', async () => {
  const want = createHash('sha256').update('abc').digest('hex');
  assert.equal(await run('61 62 63', 'hex-to-bytes', 'sha256'), want);
  assert.equal(await run('abc', 'md5'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(await run('', 'sha1'), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
});
test('invalid intermediate step names the step and stops', async () => {
  await assert.rejects(runRecipe('hello', [{ op: 'uppercase' }, { op: 'reverse' }, { op: 'hex-decode' }, { op: 'lowercase' }]),
    (e) => e instanceof RecipeError && e.step === 2 && /^Step 3 \(Hex Decode\) failed: /.test(e.message));
});
test('disabled steps are skipped', async () => {
  assert.equal(await run('abc', { op: 'uppercase', disabled: true }, 'reverse'), 'cba');
});
test('empty input and empty recipe', async () => {
  assert.equal(await run(''), '');
  assert.equal(await run('', 'base64-encode'), '');
  assert.equal(await run('', 'count-words'), 'Words: 0\nUnique words: 0\nSentences: 0\nLines: 0\nParagraphs: 0');
});
test('unicode: reverse keeps emoji/combining marks intact; upper/lower', async () => {
  assert.equal(await run('añb👍🏽c', 'reverse'), 'c👍🏽bña');
  assert.equal(await run('straße', 'uppercase'), 'STRASSE');
});
test('large input (2 MB) through several steps', async () => {
  const big = 'line ' + 'x'.repeat(50) + '\n';
  const input = big.repeat(40000);
  const out = await run(input, 'base64-encode', 'base64-decode', 'dedupe-lines', 'count-chars');
  assert.match(dec(out), /Lines: 2/); // one unique line + the trailing empty line
});
test('text ops', async () => {
  assert.equal(await run('b\na\nB\na', { op: 'dedupe-lines', args: { ignoreCase: true } }), 'b\na');
  assert.equal(await run('file10\nfile2\nfile1', { op: 'sort-lines', args: { mode: 'natural' } }), 'file1\nfile2\nfile10');
  assert.equal(await run('10\n9\n-1\nx', { op: 'sort-lines', args: { mode: 'numeric', desc: true } }), 'x\n10\n9\n-1');
  assert.equal(await run('  a  \n b', 'trim-lines'), 'a\nb');
  assert.equal(await run(' a  b \n c', { op: 'remove-whitespace', args: { mode: 'collapse' } }), 'a b c');
  assert.equal(await run('a.b.c', { op: 'find-replace', args: { find: '.', replace: '-' } }), 'a-b-c');
  assert.equal(await run('2026-11-16', { op: 'find-replace', args: { find: '(\\d+)-(\\d+)-(\\d+)', replace: '$3/$2/$1', mode: 'regex' } }), '16/11/2026');
  await assert.rejects(runRecipe('x', [{ op: 'find-replace', args: { find: '(', mode: 'regex' } }]), /Invalid regular expression/);
  assert.equal(await run('Hello 🚀 World', { op: 'substring', args: { start: 6, length: 1 } }), '🚀');
  assert.equal(await run('Hello', { op: 'substring', args: { start: -3 } }), 'llo');
  assert.match(await run('héllo 🚀', 'count-chars'), /UTF-8 bytes: 11/);
  assert.match(await run('the cat and the dog', { op: 'count-words', args: { top: true } }), /Words: 5[\s\S]*the — 2/);
});
test('encoding ops', async () => {
  assert.equal(await run('<a>&"', 'html-encode', 'html-decode'), '<a>&"');
  assert.equal(await run('Hi', 'hex-encode'), '4869');
  assert.equal(await run('Hi', { op: 'hex-encode', args: { sep: '0x' } }), '0x48 0x69');
  assert.equal(await run('48 69', 'hex-decode'), 'Hi');
  assert.equal(await run('Hi', 'binary-encode', 'binary-decode'), 'Hi');
  assert.equal(await run('01001000 01101001', 'binary-to-hex'), '48 69');
  assert.equal(await run('4869', 'hex-to-binary'), '01001000 01101001');
  assert.match(await run('Hi!', 'utf8-encode', 'bytes-to-hex'), /^00000000  48 69 21 .*\|Hi!\|$/);
  assert.equal(await run('café', 'utf8-encode', { op: 'decode-text', args: { charset: 'iso-8859-1' } }), 'cafÃ©');
  await assert.rejects(runRecipe('%%', [{ op: 'url-decode' }]), /Step 1 \(URL Decode\) failed: Malformed/);
  await assert.rejects(runRecipe('a$b', [{ op: 'base64-decode' }]), /Invalid Base64 character/);
});
test('data format ops', async () => {
  assert.equal(await run('{"a":[1,2]}', 'json-beautify', 'json-minify'), '{"a":[1,2]}');
  assert.equal(await run('[{"a":1,"b":"x,y"}]', 'json-to-csv'), 'a,b\n1,"x,y"');
  assert.deepEqual(JSON.parse(await run('a;b\n1;2', { op: 'csv-to-json', args: { types: true } })), [{ a: 1, b: 2 }]);
  assert.equal(await run('<a><b>1</b></a>', 'xml-format'), '<a>\n  <b>1</b>\n</a>');
  assert.equal(await run('a: 1\nb: [x]', { op: 'yaml-to-json', args: { indent: '0' } }), '{"a":1,"b":["x"]}');
  assert.equal(await run('{"a":1}', 'json-to-yaml'), 'a: 1\n');
  await assert.rejects(runRecipe('{bad', [{ op: 'json-beautify' }]), /Step 1 \(JSON Beautify\) failed: .*line 1/);
});
test('utilities', async () => {
  const text = 'Visit https://example.com/a?b=1, mail me@site.org or ME@site.org. Server 192.168.1.10 and 10.0.0.256 and 2001:db8::1 at sub.example.co.uk';
  assert.equal(await run(text, 'extract-urls'), 'https://example.com/a?b=1');
  assert.equal(await run(text, 'extract-emails'), 'me@site.org\nME@site.org');
  assert.equal(await run(text, 'extract-ips'), '192.168.1.10\n2001:db8::1');
  assert.equal(await run(text, { op: 'extract-ips', args: { version: '4' } }), '192.168.1.10');
  assert.equal(await run(text, { op: 'extract-domains', args: { sort: true } }), 'example.com\nsite.org\nsub.example.co.uk');
  const u = JSON.parse(await run('https://user:pw@api.example.com:8443/v1/items?id=1&id=2&q=a%20b#top', 'parse-url'));
  assert.equal(u.hostname, 'api.example.com'); assert.equal(u.port, '8443'); assert.deepEqual(u.query, { id: ['1', '2'], q: 'a b' }); assert.equal(u.password, '••••');
  await assert.rejects(runRecipe('not a url', [{ op: 'parse-url' }]), /valid absolute URL/);
  const ids = (await run('', { op: 'generate-uuid', args: { version: '7', count: 5 } })).split('\n');
  assert.equal(ids.length, 5); assert.ok(ids.every((x) => x[14] === '7'));
});
test('recipe share encoding round-trips and sanitises', () => {
  const steps = sanitizeRecipe([{ op: 'base64-encode', args: { alphabet: 'url' } }, { op: 'nope' }, { op: 'reverse', disabled: true }]);
  assert.equal(steps.length, 2);
  const back = decodeRecipe(encodeRecipe(steps));
  assert.deepEqual(back, steps);
  assert.deepEqual(decodeRecipe('garbage!!'), []);
  assert.deepEqual(defaultArgs(opById('sort-lines')), { mode: 'alpha', desc: false, ignoreCase: true });
});
