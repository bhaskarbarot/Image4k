import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeHeaders } from '../../assets/dev/lib/headers-grade.js';
import { buildUrl, paramsFromUrl, prepare, toCurl, redactModel, kindOf, isProbablyText, hexDump, HttpToolError } from '../../assets/dev/lib/http.js';

const strong = [
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload'],
  ['Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'"],
  ['X-Content-Type-Options', 'nosniff'], ['Referrer-Policy', 'no-referrer'], ['Permissions-Policy', 'camera=()'],
  ['Set-Cookie', 'sid=1; Secure; HttpOnly; SameSite=Lax'], ['Cache-Control', 'public, max-age=600, s-maxage=3600'], ['ETag', '"x"'],
];
test('well-configured site grades A', () => {
  const g = gradeHeaders(strong);
  assert.equal(g.grade, 'A');
  assert.equal(g.score, 100);
  assert.ok(g.security.find((f) => f.name === 'Clickjacking protection').status === 'good');
  assert.match(g.cache[0].message, /10 min in browsers/);
  assert.match(g.cache[0].message, /1 h in shared caches/);
});
test('bare site grades F with explanations', () => {
  const g = gradeHeaders([['Content-Type', 'text/html'], ['Server', 'Apache/2.4.1'], ['X-Powered-By', 'PHP/8.1']]);
  assert.equal(g.grade, 'F');
  const by = (n) => g.security.find((f) => f.name === n);
  assert.equal(by('Strict-Transport-Security').status, 'bad');
  assert.equal(by('Content-Security-Policy').status, 'bad');
  assert.equal(by('X-Frame-Options').status, 'bad');
  assert.equal(by('X-Powered-By').status, 'warn');
  assert.match(by('Server').message, /version/);
  assert.match(g.cache[0].message, /Missing/);
  assert.match(g.cors[0].message, /Not set/);
});
test('weak HSTS, unsafe-inline CSP, bad cookies, wildcard CORS with credentials', () => {
  const g = gradeHeaders([
    ['strict-transport-security', 'max-age=300'], ['content-security-policy', "script-src 'self' 'unsafe-inline'"],
    ['set-cookie', 'a=1'], ['set-cookie', 'b=2; SameSite=None'], ['access-control-allow-origin', '*'], ['access-control-allow-credentials', 'true'],
  ]);
  const by = (n) => g.security.find((f) => f.name === n);
  assert.equal(by('Strict-Transport-Security').status, 'warn');
  assert.match(by('Content-Security-Policy').message, /unsafe-inline/);
  assert.equal(g.cookies.length, 2);
  assert.equal(g.cookies[0].status, 'bad');
  assert.match(g.cookies[1].message, /SameSite=None requires Secure/);
  assert.equal(g.cors[0].status, 'bad');
});
test('HTTP (not HTTPS) URL: HSTS reported as info', () => {
  const g = gradeHeaders([], { https: false });
  assert.equal(g.security.find((f) => f.name === 'Strict-Transport-Security').status, 'info');
});

test('buildUrl: adds https://, rejects junk and other schemes, params replace query', () => {
  assert.equal(buildUrl('api.example.com/x').toString(), 'https://api.example.com/x');
  assert.throws(() => buildUrl(''), HttpToolError);
  assert.throws(() => buildUrl('http://exa mple.com'), /not a valid URL/);
  assert.throws(() => buildUrl('ftp://x.com'), /Only http/);
  assert.throws(() => buildUrl('http://exa%20mple/'), /not a valid URL/);
  assert.equal(buildUrl('http://[::1]:8080/x').hostname, '[::1]');
  assert.equal(buildUrl('https://bücher.example/').hostname, 'xn--bcher-kva.example');
  assert.equal(buildUrl('http://127.0.0.1:3000').port, '3000');
  assert.equal(buildUrl('https://a.com/p?old=1', [{ key: 'q', value: 'a b&c' }, { key: 'n', value: 'é' }]).toString(), 'https://a.com/p?q=a+b%26c&n=%C3%A9');
  assert.deepEqual(paramsFromUrl('https://a.com/?x=1&y=two&x=3'), [{ key: 'x', value: '1' }, { key: 'y', value: 'two' }, { key: 'x', value: '3' }]);
});
test('prepare: auth types, content types, invalid header names', () => {
  let r = prepare({ method: 'post', url: 'https://a.com', headers: [{ key: 'X-A', value: '1' }], auth: { type: 'bearer', token: ' tok ' }, body: { type: 'json', text: '{"a":1}' } });
  assert.deepEqual(r.headers, [['X-A', '1'], ['Authorization', 'Bearer tok'], ['Content-Type', 'application/json']]);
  assert.equal(r.payload, '{"a":1}');
  r = prepare({ method: 'GET', url: 'https://a.com', auth: { type: 'basic', user: 'Zoë', pass: 'p:w' }, body: { type: 'json', text: 'x' } });
  assert.equal(r.headers[0][1], 'Basic ' + Buffer.from('Zoë:p:w').toString('base64'));
  assert.equal(r.payload, null, 'GET has no body');
  r = prepare({ method: 'GET', url: 'https://a.com/x', auth: { type: 'apikey', key: 'api_key', value: 's3', in: 'query' } });
  assert.equal(r.url, 'https://a.com/x?api_key=s3');
  r = prepare({ method: 'PUT', url: 'https://a.com', body: { type: 'urlencoded', rows: [{ key: 'a', value: '1 2' }] } });
  assert.equal(r.payload.toString(), 'a=1+2');
  assert.match(r.headers[0][1], /x-www-form-urlencoded/);
  assert.throws(() => prepare({ method: 'GET', url: 'https://a.com', headers: [{ key: 'Bad Header', value: '1' }] }), /Invalid header name/);
});
test('toCurl quotes safely', () => {
  const r = prepare({ method: 'POST', url: "https://a.com/it's", headers: [{ key: 'X-Q', value: "it's" }], body: { type: 'text', text: "a'b" } });
  assert.equal(toCurl(r), "curl -X POST 'https://a.com/it'\\''s' -H 'X-Q: it'\\''s' -H 'Content-Type: text/plain;charset=UTF-8' --data-raw 'a'\\''b'");
  assert.equal(toCurl(prepare({ method: 'HEAD', url: 'https://a.com' })), "curl --head 'https://a.com/'");
});
test('history redaction removes secrets', () => {
  const m = redactModel({ method: 'GET', url: 'https://u:p@a.com/x?token=abc&page=2', params: [{ key: 'token', value: 'abc' }, { key: 'page', value: '2' }],
    headers: [{ key: 'Authorization', value: 'Bearer x' }, { key: 'X-Api-Key', value: 'k' }, { key: 'Accept', value: 'a' }], auth: { type: 'bearer', token: 'secret' }, body: { type: 'none' } });
  assert.equal(m.url, 'https://a.com/x?token=&page=2');
  assert.deepEqual(m.params, [{ key: 'token', value: '' }, { key: 'page', value: '2' }]);
  assert.deepEqual(m.headers.map((h) => h.value), ['', '', 'a']);
  assert.equal(m.auth.token, undefined);
  assert.doesNotMatch(JSON.stringify(m), /secret|Bearer x|abc/);
});
test('response helpers', () => {
  assert.equal(kindOf('application/vnd.api+json'), 'json');
  assert.equal(kindOf('text/plain', '{"a":1}'), 'json');
  assert.equal(kindOf('text/plain', '{nope'), 'text');
  assert.equal(kindOf('application/xml'), 'xml');
  assert.equal(isProbablyText(new Uint8Array([0x89, 0x50, 0, 1]), ''), false);
  assert.equal(isProbablyText(new TextEncoder().encode('héllo'), ''), true);
  assert.match(hexDump(new Uint8Array([72, 105, 0])), /^00000000  48 69 00\s+Hi\.$/);
});

import { findOperations, buildGraphQLBody, typeRefToString, namedType } from '../../assets/dev/lib/graphql.js';
test('graphql: operation detection ignores strings, comments and nested words', () => {
  assert.deepEqual(findOperations('{ user { query } }'), [{ type: 'query', name: null }]);
  assert.deepEqual(findOperations('query A { a } mutation B($x: Int) { b(x: $x) } fragment F on T { c }'), [{ type: 'query', name: 'A' }, { type: 'mutation', name: 'B' }]);
  assert.deepEqual(findOperations('# subscription S { x }\nquery Q { a(s: "mutation M { }") }'), [{ type: 'query', name: 'Q' }]);
  assert.deepEqual(findOperations('subscription { ticks }'), [{ type: 'subscription', name: null }]);
});
test('graphql: request body building and validation', () => {
  assert.deepEqual(buildGraphQLBody({ query: '{ a }', variables: '' }), { query: '{ a }' });
  assert.deepEqual(buildGraphQLBody({ query: 'query Q($id: ID) { a }', variables: '{"id":"1"}' }), { query: 'query Q($id: ID) { a }', variables: { id: '1' } });
  assert.throws(() => buildGraphQLBody({ query: '' }), /Write a query/);
  assert.throws(() => buildGraphQLBody({ query: '{ a }', variables: '{bad' }), /Variables must be valid JSON/);
  assert.throws(() => buildGraphQLBody({ query: '{ a }', variables: '[1]' }), /JSON object/);
  assert.throws(() => buildGraphQLBody({ query: 'query A { a } query B { b }' }), /2 operations/);
  assert.deepEqual(buildGraphQLBody({ query: 'query A { a } query B { b }', operationName: 'B' }).operationName, 'B');
  assert.throws(() => buildGraphQLBody({ query: 'query A { a }', operationName: 'Z' }), /No operation named/);
  assert.throws(() => buildGraphQLBody({ query: 'subscription { t }' }), /WebSocket/);
});
test('graphql: type references', () => {
  const t = { kind: 'NON_NULL', ofType: { kind: 'LIST', ofType: { kind: 'NON_NULL', ofType: { kind: 'OBJECT', name: 'User' } } } };
  assert.equal(typeRefToString(t), '[User!]!');
  assert.equal(namedType(t), 'User');
});
