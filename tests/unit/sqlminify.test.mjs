import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { minifySql, tokenizeSql } from '../../assets/dev/lib/sqlmin.js';
import { detectFormat, parseForm, formToObject, formatHtml, minifyHtml } from '../../assets/dev/lib/respfmt.js';

const require = createRequire(import.meta.url);
const sqlFormatter = require('../../assets/vendor/sql-formatter-15.8.2/sql-formatter.min.js');

test('collapses whitespace, removes comments, keeps strings exactly', () => {
  const q = "SELECT a ,  b -- note 'x'\nFROM  t   /* block */\nWHERE x = 'it''s -- not   a comment'\n  AND f( 1 , 2 ) > 0 ;";
  assert.equal(minifySql(q), "SELECT a,b FROM t WHERE x = 'it''s -- not   a comment' AND f(1,2) > 0;");
});
test('keepComments converts line comments to block comments safely', () => {
  assert.equal(minifySql('SELECT 1 -- a */ b\nFROM t', { keepComments: true }), 'SELECT 1 /* a * / b */ FROM t');
});
test('never creates "--" from "a - -1"', () => {
  assert.equal(minifySql('SELECT a - -1, b - - 2'), 'SELECT a - -1,b - - 2');
  assert.ok(!/--/.test(minifySql('SELECT a\n-\n-1')));
});
test('quoted identifiers, dollar quotes, hints are preserved', () => {
  assert.equal(minifySql('SELECT "my  col", `x  y`, [a  b] FROM t'), 'SELECT "my  col",`x  y`,[a  b] FROM t');
  assert.equal(minifySql('CREATE FUNCTION f() RETURNS int AS $body$\n  -- inside\n  SELECT 1;\n$body$ LANGUAGE sql;'), 'CREATE FUNCTION f() RETURNS int AS $body$\n  -- inside\n  SELECT 1;\n$body$ LANGUAGE sql;');
  assert.equal(minifySql('SELECT /*+ INDEX(t i) */ *  FROM t /*! STRAIGHT_JOIN */'), 'SELECT /*+ INDEX(t i) */ * FROM t /*! STRAIGHT_JOIN */');
});
test('MySQL: # comments and backslash escapes', () => {
  assert.equal(minifySql("SELECT 'a\\' b' # c\nFROM t", { dialect: 'mysql' }), "SELECT 'a\\' b' FROM t");
  // in standard SQL a backslash is literal and # is not a comment
  assert.equal(minifySql("SELECT 'a\\' AS x, 1 #2", { dialect: 'postgresql' }), "SELECT 'a\\' AS x,1 #2");
});
test('unicode content is untouched', () => {
  assert.equal(minifySql("SELECT 'Zoë 🚀'  AS name,  ünïcode FROM t"), "SELECT 'Zoë 🚀' AS name,ünïcode FROM t");
});
test('errors: unterminated string / comment / identifier report the line', () => {
  assert.throws(() => minifySql("SELECT 1;\nSELECT 'abc"), (e) => e.name === 'SqlError' && e.line === 2);
  assert.throws(() => minifySql('SELECT /* x'), /Unterminated \/\* comment/);
  assert.throws(() => minifySql('SELECT "x'), /Unterminated quoted identifier/);
});
test('minified SQL formats to the same output as the original (meaning preserved)', () => {
  const q = "select u.id, count(o.id) as n -- c\nfrom users u left join orders o on o.user_id = u.id where u.email like '%a  b%' group by u.id having count(o.id) > 2 order by n desc;";
  const f = (s) => sqlFormatter.format(s, { language: 'postgresql' });
  assert.equal(f(minifySql(q)), f(q.replace(' -- c', '')));
});
test('tokenizer exposes token kinds', () => {
  assert.deepEqual(tokenizeSql("a 'b' -- c").map((t) => t.t), ['word', 'ws', 'str', 'ws', 'line']);
});
test('large SQL (5k statements) minifies quickly', () => {
  const q = Array.from({ length: 5000 }, (_, i) => `INSERT INTO t (id, name) VALUES (${i}, 'name ${i}'); -- row ${i}`).join('\n');
  const t0 = performance.now();
  const m = minifySql(q);
  assert.ok(performance.now() - t0 < 2000);
  assert.ok(!m.includes('-- row'));
});
test('sql-formatter reports parse errors with position', () => {
  assert.throws(() => sqlFormatter.format('SELECT (a FROM', { language: 'postgresql' }), /Parse error.*line 1 column/);
});

// ---- response formatter helpers ----
test('detectFormat', () => {
  assert.equal(detectFormat('{"a":1}'), 'json');
  assert.equal(detectFormat('[1,2'), 'json');
  assert.equal(detectFormat('<?xml version="1.0"?><a/>'), 'xml');
  assert.equal(detectFormat('<a><b/></a>'), 'xml');
  assert.equal(detectFormat('<!doctype html><p>x'), 'html');
  assert.equal(detectFormat('<div><br></div>'), 'html');
  assert.equal(detectFormat('a=1&b=x%20y'), 'form');
  assert.equal(detectFormat('hello world'), 'text');
  assert.equal(detectFormat(''), 'text');
});
test('parseForm decodes + and %, repeated keys become arrays', () => {
  const p = parseForm('scope=read%3Ausers+write&tag=a&tag=b&empty=&flag');
  assert.deepEqual(p, [['scope', 'read:users write'], ['tag', 'a'], ['tag', 'b'], ['empty', ''], ['flag', '']]);
  assert.deepEqual(formToObject(p), { scope: 'read:users write', tag: ['a', 'b'], empty: '', flag: '' });
  assert.throws(() => parseForm('a=%E0%A4'), /Malformed/);
});
test('formatHtml indents and keeps script/pre bodies; minifyHtml', () => {
  const f = formatHtml('<html><body><ul><li>A</li></ul><br><pre>x\n  y</pre></body></html>');
  assert.equal(f, '<html>\n  <body>\n    <ul>\n      <li>A</li>\n    </ul>\n    <br>\n    <pre>x\n  y</pre>\n  </body>\n</html>');
  assert.equal(minifyHtml('<div>\n  <p> hi  there </p>\n  <!-- c -->\n  <pre>a\n  b</pre>\n</div>'), '<div><p> hi there </p><pre>a\n  b</pre></div>');
});
