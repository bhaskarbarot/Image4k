import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatXml, minifyXml, validateXml, looksLikeXml, tokenize } from '../../assets/dev/lib/xml.js';

test('formats nested elements, inline text, self-closing, comments, CDATA, PI', () => {
  const src = '<?xml version="1.0"?><r a="1"><b>hi &amp; bye</b><c/><d><e>1</e><!-- c --></d><f><![CDATA[<x>]]></f><?pi data?></r>';
  assert.equal(formatXml(src), '<?xml version="1.0"?>\n<r a="1">\n  <b>hi &amp; bye</b>\n  <c/>\n  <d>\n    <e>1</e>\n    <!-- c -->\n  </d>\n  <f><![CDATA[<x>]]></f>\n  <?pi data?>\n</r>');
});
test('indent options and empty elements', () => {
  assert.equal(formatXml('<a><b></b><c>x</c></a>', { indent: 4 }), '<a>\n    <b></b>\n    <c>x</c>\n</a>');
  assert.equal(formatXml('<a><b/></a>', { indent: 'tab' }), '<a>\n\t<b/>\n</a>');
});
test('minify removes inter-tag whitespace, optionally comments', () => {
  const src = '<r>\n  <b> hi </b>\n  <!-- x -->\n  <c/>\n</r>';
  assert.equal(minifyXml(src), '<r><b>hi</b><!-- x --><c/></r>');
  assert.equal(minifyXml(src, { removeComments: true }), '<r><b>hi</b><c/></r>');
});
test('namespaces, unicode names and attribute quote styles are preserved', () => {
  assert.equal(minifyXml("<bk:book xmlns:bk='urn:x' név=\"é\"><title>गोदान</title></bk:book>"), "<bk:book xmlns:bk='urn:x' név=\"é\"><title>गोदान</title></bk:book>");
});
const bad = [
  ['<a><b></a>', 'Mismatched closing tag', 1, 7],
  ['<a>1</a><b/>', 'one root', 1, 9],
  ['<a x=1/>', 'must be quoted', 1, 6],
  ['<a>&nbsp</a>', "Unescaped '&'", 1, 4],
  ['<a x="1" x="2"/>', 'Duplicate attribute', 1, 10],
  ['', 'empty', 1, 1],
  ['text<a/>', 'Text before the root', 1, 1],
  ['<a>', 'Unclosed tag <a>', 1, 4],
  ['<a>\n  <b>\n</a>', 'expected </b>', 3, 1],
  ['<a x="<"/>', "'<' is not allowed", 1, 7],
  ['<a><!-- x -- y --></a>', "'--' is not allowed", 1, 11],
  ['<a>1 < 2</a>', 'Tag names cannot start with a space', 1, 7],
  ['<a>1 <2</a>', 'Invalid tag name', 1, 7],
  ['</a>', 'no matching opening', 1, 1],
  ['<a></a>trailing', 'Text after the root', 1, 8],
  [' <?xml version="1.0"?><a/>', 'declaration must be at the very start', 1, 2],
];
for (const [src, msg, line, col] of bad) {
  test(`invalid: ${JSON.stringify(src)} → ${msg}`, () => {
    const v = validateXml(src);
    assert.equal(v.ok, false);
    assert.match(v.error.message, new RegExp(msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    assert.equal(v.error.line, line, 'line');
    assert.equal(v.error.col, col, 'col');
  });
}
test('XXE / billion-laughs payloads are never expanded', () => {
  const xxe = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>';
  const out = formatXml(xxe);
  assert.match(out, /<foo>&xxe;<\/foo>/);
  assert.ok(!out.includes('root:'));
  const lol = '<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><l>&c;</l>';
  assert.equal(minifyXml(lol).length, lol.length);
});
test('validateXml counts elements; looksLikeXml', () => {
  assert.deepEqual(validateXml('<a><b/><c>1</c></a>'), { ok: true, elements: 3 });
  assert.equal(looksLikeXml('  <?xml version="1.0"?>'), true);
  assert.equal(looksLikeXml('{"a":1}'), false);
});
test('large XML (20k elements) formats quickly', () => {
  const src = '<root>' + Array.from({ length: 20000 }, (_, i) => `<item id="${i}"><name>n${i}</name></item>`).join('') + '</root>';
  const t0 = performance.now();
  const out = formatXml(src);
  assert.ok(performance.now() - t0 < 3000);
  assert.equal(out.split('\n').length, 20000 * 3 + 2);
  assert.equal(tokenize(minifyXml(out)).filter((t) => t.t === 'open').length, 40001);
});
