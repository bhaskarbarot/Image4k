// Webhook backend against a real SQLite database (node:sqlite) wrapped in a D1-compatible shim.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHook, listRequests, receiveHook, deleteHook, clearRequests, HOOK_LIMITS, _resetSchema } from '../../server/hooks-core.js';
import { _resetLimits } from '../../server/limits.js';

function d1(dbx) {
  return {
    prepare(sql) {
      let args = [];
      const st = { bind(...a) { args = a; return st; },
        async run() { dbx.prepare(sql).run(...args); return { success: true }; },
        async all() { return { results: dbx.prepare(sql).all(...args) }; },
        async first() { return dbx.prepare(sql).get(...args) ?? null; } };
      return st;
    },
  };
}
const O = 'https://tools.example';
let env, raw;
beforeEach(() => { raw = new DatabaseSync(':memory:'); env = { HOOKS_DB: d1(raw) }; _resetSchema(); _resetLimits(); });

const mk = (path, init = {}) => new Request(O + path, { ...init, headers: { 'CF-Connecting-IP': '203.0.113.7', 'Sec-Fetch-Site': 'same-origin', ...(init.headers || {}) } });
async function create(now) {
  const r = await createHook(mk('/api/hooks', { method: 'POST', headers: { Origin: O } }), env, now);
  return { status: r.status, ...(await r.json()) };
}
const list = async (id, token, now, after) => {
  const r = await listRequests(mk(`/api/hooks/${id}/requests${after ? '?after=' + after : ''}`, { headers: token ? { Authorization: 'Bearer ' + token } : {} }), env, id, now);
  return { status: r.status, ...(await r.json()) };
};

test('create → receive POST + GET → list (newest first) with headers, query, body', async () => {
  const c = await create(1000);
  assert.equal(c.status, 201);
  assert.match(c.id, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(c.token.length >= 43);
  assert.equal(c.url, `${O}/api/hook/${c.id}`);
  // only the token hash is stored
  const row = raw.prepare('SELECT * FROM hook_endpoints').get();
  assert.notEqual(row.token_hash, c.token);
  assert.equal(row.token_hash.length, 64);

  let r = await receiveHook(mk(`/api/hook/${c.id}/events?x=1&y=two`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 'abc', 'CF-Ray': 'edge' }, body: '{"event":"paid","amount":5}' }), env, c.id, 'events', 2000);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  r = await receiveHook(mk(`/api/hook/${c.id}?q=hello`, { method: 'GET' }), env, c.id, '', 3000);
  assert.equal(r.status, 200);

  const l = await list(c.id, c.token, 4000);
  assert.equal(l.status, 200);
  assert.equal(l.requests.length, 2);
  assert.equal(l.requests[0].method, 'GET');
  assert.equal(l.requests[0].query, '?q=hello');
  const p = l.requests[1];
  assert.equal(p.method, 'POST');
  assert.equal(p.path, '/events');
  assert.equal(p.query, '?x=1&y=two');
  assert.equal(p.body, '{"event":"paid","amount":5}');
  assert.equal(p.contentType, 'application/json');
  assert.ok(p.headers.some(([k, v]) => k === 'x-signature' && v === 'abc'));
  assert.ok(!p.headers.some(([k]) => k === 'cf-ray' || k === 'cf-connecting-ip'), 'edge headers hidden');
  assert.equal(p.ip, '203.0.113.7');
  assert.equal(l.endpoint.requestCount, 2);
  // incremental polling
  const l2 = await list(c.id, c.token, 4000, l.requests[0].id);
  assert.equal(l2.requests.length, 0);
});

test('binary body is stored as base64; invalid JSON is stored verbatim', async () => {
  const c = await create(1000);
  await receiveHook(mk(`/api/hook/${c.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([0, 1, 2, 250]) }), env, c.id, '', 2000);
  await receiveHook(mk(`/api/hook/${c.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' }), env, c.id, '', 2001);
  const l = await list(c.id, c.token, 3000);
  assert.equal(l.requests[0].body, '{broken');
  assert.equal(l.requests[1].bodyEncoding, 'base64');
  assert.deepEqual([...Buffer.from(l.requests[1].body, 'base64')], [0, 1, 2, 250]);
});

test('oversized payload → 413 and nothing stored; >256 KB stored truncated', async () => {
  const c = await create(1000);
  const big = 'a'.repeat(HOOK_LIMITS.maxBodyBytes + 10);
  let r = await receiveHook(mk(`/api/hook/${c.id}`, { method: 'POST', body: big }), env, c.id, '', 2000);
  assert.equal(r.status, 413);
  // without Content-Length (streamed)
  const stream = new ReadableStream({ start(ctl) { for (let i = 0; i < 11; i++) ctl.enqueue(new Uint8Array(100 * 1024)); ctl.close(); } });
  r = await receiveHook(new Request(O + '/api/hook/' + c.id, { method: 'POST', body: stream, duplex: 'half' }), env, c.id, '', 2001);
  assert.equal(r.status, 413);
  assert.equal((await list(c.id, c.token, 3000)).requests.length, 0);
  const mid = 'b'.repeat(300 * 1024);
  r = await receiveHook(mk(`/api/hook/${c.id}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: mid }), env, c.id, '', 4000);
  assert.equal(r.status, 200);
  const l = await list(c.id, c.token, 5000);
  assert.equal(l.requests[0].truncated, true);
  assert.equal(l.requests[0].size, 300 * 1024);
  assert.equal(l.requests[0].body.length, HOOK_LIMITS.storedBodyBytes);
});

test('token required: none / wrong → 401; foreign Origin → 403', async () => {
  const c = await create(1000);
  assert.equal((await list(c.id, null, 2000)).status, 401);
  assert.equal((await list(c.id, 'x'.repeat(43), 2000)).status, 401);
  const r = await listRequests(mk(`/api/hooks/${c.id}/requests`, { headers: { Authorization: 'Bearer ' + c.token, Origin: 'https://evil.example' } }), env, c.id, 2000);
  assert.equal(r.status, 403);
});

test('delete endpoint → later requests 404; clear requests works', async () => {
  const c = await create(1000);
  await receiveHook(mk(`/api/hook/${c.id}`, { method: 'POST', body: 'x' }), env, c.id, '', 1500);
  let r = await clearRequests(mk(`/api/hooks/${c.id}/requests`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + c.token } }), env, c.id, 2000);
  assert.equal(r.status, 200);
  assert.equal((await list(c.id, c.token, 2100)).requests.length, 0);
  r = await deleteHook(mk(`/api/hooks/${c.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + wrongToken(c.token) } }), env, c.id, 2200);
  assert.equal(r.status, 401);
  r = await deleteHook(mk(`/api/hooks/${c.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + c.token } }), env, c.id, 2300);
  assert.equal(r.status, 200);
  r = await receiveHook(mk(`/api/hook/${c.id}`, { method: 'POST', body: 'x' }), env, c.id, '', 2400);
  assert.equal(r.status, 404);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM hook_requests').get().n, 0);
});
const wrongToken = (t) => (t[0] === 'A' ? 'B' : 'A') + t.slice(1);

test('expiry: inactive for 24 h → 410; polling keeps alive; hard max 7 days; cleanup on create', async () => {
  const H = 3600000;
  const c = await create(0);
  assert.equal((await receiveHook(mk(`/api/hook/${c.id}`, { method: 'POST', body: 'x' }), env, c.id, '', 25 * H)).status, 410);
  const c2 = await create(0);
  // polls every 20 h keep it alive (activity written when older than 10 min)
  for (let t = 20; t < 7 * 24; t += 20) assert.equal((await list(c2.id, c2.token, t * H)).status, 200, 'alive at ' + t);
  assert.equal((await list(c2.id, c2.token, 7 * 24 * H + 1)).status, 410);
  // creating a new endpoint purges expired rows
  await create(8 * 24 * H);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM hook_endpoints').get().n, 1);
});

test('only the newest 100 requests are kept', async () => {
  const c = await create(0);
  for (let i = 0; i < 105; i++) {
    _resetLimits();
    const r = await receiveHook(mk(`/api/hook/${c.id}`, { method: 'POST', body: 'n' + i }), env, c.id, '', 1000 + i * 20000);
    assert.equal(r.status, 200);
  }
  const l = await list(c.id, c.token, 3e6);
  assert.equal(l.requests.length, 100);
  assert.equal(l.requests[0].body, 'n104');
  assert.equal(l.requests[99].body, 'n5');
});

test('burst limit per endpoint → 429', async () => {
  const c = await create(0);
  let last;
  for (let i = 0; i <= HOOK_LIMITS.burstCount; i++) last = await receiveHook(mk(`/api/hook/${c.id}`, { method: 'POST', body: 'x' }), env, c.id, '', 1000 + i);
  assert.equal(last.status, 429);
});

test('endpoint creation limit per IP per hour', async () => {
  for (let i = 0; i < HOOK_LIMITS.createsPerHour; i++) { _resetLimits(); assert.equal((await create(1000 + i)).status, 201); }
  _resetLimits();
  const r = await create(2000);
  assert.equal(r.status, 429);
  assert.match(r.error, /per hour/);
});

test('unknown / malformed id → 404; missing storage → 503 storage_not_configured', async () => {
  assert.equal((await receiveHook(mk('/api/hook/nope', { method: 'POST' }), env, 'nope', '', 1)).status, 404);
  assert.equal((await receiveHook(mk('/api/hook/AAAAAAAAAAAAAAAAAAAAAA', { method: 'POST' }), env, 'AAAAAAAAAAAAAAAAAAAAAA', '', 1)).status, 404);
  const r = await createHook(mk('/api/hooks', { method: 'POST' }), {}, 1);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'storage_not_configured');
});

test('preflight OPTIONS is recorded and answered with CORS', async () => {
  const c = await create(0);
  const r = await receiveHook(mk(`/api/hook/${c.id}`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } }), env, c.id, '', 10);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});
