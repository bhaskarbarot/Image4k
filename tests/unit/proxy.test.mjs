import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleProxy, LIMITS } from '../../server/proxy-core.js';
import { _resetLimits } from '../../server/limits.js';

const ORIGIN = 'https://tools.example';
const resolve = async (host) => ({ 'api.example.com': ['93.184.216.34'], 'other.example.com': ['93.184.216.35'], 'rebind.example.com': ['10.0.0.5'] }[host] || ['93.184.216.36']);
function req(spec, { origin = ORIGIN, ct = 'application/json', method = 'POST', ip = '203.0.113.50' } = {}) {
  const h = { 'Content-Type': ct, 'CF-Connecting-IP': ip };
  if (origin) h.Origin = origin;
  return new Request(ORIGIN + '/api/proxy', { method, headers: h, body: method === 'POST' ? (typeof spec === 'string' ? spec : JSON.stringify(spec)) : undefined });
}
async function call(spec, fetchImpl, opts) {
  const res = await handleProxy(req(spec, opts), {}, { fetchImpl, resolve });
  return { status: res.status, headers: res.headers, data: await res.json() };
}
beforeEach(() => _resetLimits());

test('forwards method, headers, body; strips hop-by-hop / identity headers; returns response', async () => {
  let seen;
  const f = async (url, init) => { seen = { url, init }; return new Response('{"ok":1}', { status: 201, statusText: 'Created', headers: { 'Content-Type': 'application/json', 'X-Rate': '5' } }); };
  const r = await call({ url: 'https://api.example.com/v1/items?q=1', method: 'post', headers: [['Authorization', 'Bearer t'], ['Host', 'evil'], ['X-Forwarded-For', '1.2.3.4'], ['CF-Connecting-IP', '1.1.1.1'], ['Cookie', 'a=1'], ['Content-Type', 'application/json']], body: '{"a":1}' }, f);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.status, 201);
  assert.equal(r.data.statusText, 'Created');
  assert.equal(r.data.body, '{"ok":1}');
  assert.equal(r.data.bodyEncoding, 'text');
  assert.ok(r.data.headers.some(([k, v]) => k === 'x-rate' && v === '5'));
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(seen.init.headers.get('authorization'), 'Bearer t');
  assert.equal(seen.init.headers.get('cookie'), 'a=1'); // user-supplied cookie header is the user's choice
  assert.equal(seen.init.headers.get('host'), null);
  assert.equal(seen.init.headers.get('x-forwarded-for'), null);
  assert.equal(seen.init.headers.get('cf-connecting-ip'), null);
  assert.match(seen.init.headers.get('user-agent'), /BhaskarSolution/);
  assert.equal(new TextDecoder().decode(seen.init.body), '{"a":1}');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('binary responses are base64 encoded', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  const r = await call({ url: 'https://api.example.com/x.png' }, async () => new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
  assert.equal(r.data.bodyEncoding, 'base64');
  assert.deepEqual([...Buffer.from(r.data.body, 'base64')], [...bytes]);
});

test('blocks private destinations, metadata, localhost and DNS rebinding', async () => {
  const never = async () => { throw new Error('must not fetch'); };
  for (const url of ['http://localhost:8080/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://[::1]/', 'https://rebind.example.com/']) {
    const r = await call({ url }, never);
    assert.equal(r.status, 403, url);
    assert.equal(r.data.ok, false);
    assert.match(r.data.error, /Blocked destination/);
  }
  const r2 = await call({ url: 'ftp://example.com/' }, never);
  assert.equal(r2.status, 400);
});

test('redirects are followed manually and every hop is re-validated', async () => {
  const hops = [];
  const f = async (url) => {
    hops.push(url);
    if (url.startsWith('https://api.example.com/start')) return new Response(null, { status: 302, headers: { Location: '/next' } });
    if (url === 'https://api.example.com/next') return new Response(null, { status: 301, headers: { Location: 'http://169.254.169.254/' } });
    return new Response('x');
  };
  const r = await call({ url: 'https://api.example.com/start' }, f);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /169\.254\.169\.254/);
  assert.deepEqual(hops, ['https://api.example.com/start', 'https://api.example.com/next']);
});

test('redirect: POST→GET on 302/303, credentials dropped cross-origin, chain reported', async () => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.get('authorization'), body: init.body });
    if (url === 'https://api.example.com/a') return new Response(null, { status: 303, headers: { Location: 'https://other.example.com/b' } });
    return new Response('done', { headers: { 'Content-Type': 'text/plain' } });
  };
  const r = await call({ url: 'https://api.example.com/a', method: 'POST', body: 'x', headers: [['Authorization', 'Bearer s']] }, f);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.finalUrl, 'https://other.example.com/b');
  assert.deepEqual(r.data.redirects, [{ status: 303, location: 'https://other.example.com/b' }]);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].body, null);
  assert.equal(calls[1].auth, null);
});

test('too many redirects', async () => {
  let n = 0;
  const r = await call({ url: 'https://api.example.com/loop' }, async () => new Response(null, { status: 302, headers: { Location: '/loop' + (++n) } }));
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'too_many_redirects');
});

test('followRedirects:false returns the 3xx itself', async () => {
  const r = await call({ url: 'https://api.example.com/a', followRedirects: false }, async () => new Response(null, { status: 302, headers: { Location: '/b' } }));
  assert.equal(r.data.status, 302);
});

test('a response larger than the cap is truncated', async () => {
  const big = new Uint8Array(LIMITS.responseBody + 1000).fill(97);
  const r = await call({ url: 'https://api.example.com/big' }, async () => new Response(big, { headers: { 'Content-Type': 'text/plain' } }));
  assert.equal(r.data.truncated, true);
  assert.equal(r.data.body.length, LIMITS.responseBody);
});

test('request body over 1 MB is refused', async () => {
  const r = await call({ url: 'https://api.example.com/', method: 'POST', body: 'a'.repeat(LIMITS.requestBody + 1) }, async () => new Response('x'));
  assert.equal(r.status, 413);
});

test('timeout returns 504', async () => {
  const f = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const orig = LIMITS.timeoutMs; LIMITS.timeoutMs = 50;
  try {
    const r = await call({ url: 'https://api.example.com/slow' }, f);
    assert.equal(r.status, 504);
    assert.equal(r.data.code, 'timeout');
  } finally { LIMITS.timeoutMs = orig; }
});

test('open-proxy guard: no Origin AND no Sec-Fetch-Site (curl/script) is refused', async () => {
  const r = await handleProxy(req({ url: 'https://api.example.com/' }, { origin: null }), {}, { fetchImpl: async () => new Response('x'), resolve });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'forbidden_origin');
});
test('open-proxy guard: no Origin but Sec-Fetch-Site: same-origin (browser) is allowed', async () => {
  const request = new Request(ORIGIN + '/api/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify({ url: 'https://api.example.com/' }) });
  const res = await handleProxy(request, {}, { fetchImpl: async () => new Response('{"ok":1}', { headers: { 'Content-Type': 'application/json' } }), resolve });
  assert.equal(res.status, 200);
});
test('foreign Origin, wrong content type, GET method and bad JSON are refused', async () => {
  const f = async () => new Response('x');
  assert.equal((await call({ url: 'https://api.example.com/' }, f, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call({ url: 'https://api.example.com/' }, f, { ct: 'text/plain' })).status, 415);
  assert.equal((await handleProxy(req(null, { method: 'GET' }), {}, { fetchImpl: f, resolve })).status, 405);
  assert.equal((await call('{not json', f)).status, 400);
});

test('rate limit: a request over the per-minute cap gets 429', async () => {
  const f = async () => new Response('x');
  for (let i = 0; i < LIMITS.perMinute; i++) assert.equal((await call({ url: 'https://api.example.com/' }, f)).status, 200);
  const r = await call({ url: 'https://api.example.com/' }, f);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  // a different client is unaffected
  assert.equal((await call({ url: 'https://api.example.com/' }, f, { ip: '198.51.100.1' })).status, 200);
});

test('self requests refused, including the production host from a Pages preview', async () => {
  const never = async () => { throw new Error('must not fetch'); };
  const mk = (host, url) => new Request(`https://${host}/api/proxy`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `https://${host}` }, body: JSON.stringify({ url }) });
  const r1 = await handleProxy(mk('image4k.pages.dev', 'https://image4k.pages.dev/api/proxy'), {}, { fetchImpl: never, resolve });
  assert.equal((await r1.json()).code, 'self_request');
  const r2 = await handleProxy(mk('pdf-tools.image4k.pages.dev', 'https://image4k.pages.dev/'), {}, { fetchImpl: never, resolve });
  assert.equal((await r2.json()).code, 'self_request');
  const r3 = await handleProxy(mk('tools.example', 'https://image4k.org/'), { SELF_HOSTS: 'image4k.org' }, { fetchImpl: never, resolve });
  assert.equal((await r3.json()).code, 'self_request');
});

test('upstream network error does not leak URLs', async () => {
  const r = await call({ url: 'https://api.example.com/secret?token=abc' }, async () => { throw new TypeError('connect failed https://api.example.com/secret?token=abc'); });
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.data.error, /token=abc/);
});
