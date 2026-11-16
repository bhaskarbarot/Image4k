/* Webhook tester backend: temporary endpoints that record real incoming HTTP requests in Cloudflare D1.
 * Endpoint ids are 128-bit random; the read/delete token is 256-bit random and only its SHA-256 is stored. */
import { json, fail, rateLimit, clientIp, sameOriginOnly, sha256Hex, randomToken, safeEqual, readCapped, encodeBody } from './limits.js';

export const HOOK_LIMITS = {
  maxStoredPerEndpoint: 100,
  storedBodyBytes: 256 * 1024,
  maxBodyBytes: 1024 * 1024,
  burstCount: 30, burstWindowMs: 10000,
  createsPerHour: 20,
  inactivityMs: 24 * 3600 * 1000,
  maxAgeMs: 7 * 24 * 3600 * 1000,
  listLimit: 100,
};

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hook_endpoints (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_hook_endpoints_ip ON hook_endpoints (ip_hash, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_hook_endpoints_activity ON hook_endpoints (last_activity)',
  `CREATE TABLE IF NOT EXISTS hook_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    query TEXT NOT NULL,
    headers TEXT NOT NULL,
    content_type TEXT,
    body TEXT NOT NULL,
    body_encoding TEXT NOT NULL,
    size INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    ip TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_hook_requests_endpoint ON hook_requests (endpoint_id, id)',
];

let schemaReady = null; // per isolate
async function db(env) {
  const d = env && env.HOOKS_DB;
  if (!d) return null;
  if (!schemaReady) {
    schemaReady = (async () => { for (const s of SCHEMA) await d.prepare(s).run(); })().catch((e) => { schemaReady = null; throw e; });
  }
  await schemaReady;
  return d;
}
export function _resetSchema() { schemaReady = null; }

const notConfigured = () => fail(503, 'storage_not_configured', 'The webhook tester needs its storage (a Cloudflare D1 database bound as HOOKS_DB). The site owner has not enabled it yet.');
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const expiresAt = (row) => Math.min(row.last_activity + HOOK_LIMITS.inactivityMs, row.created_at + HOOK_LIMITS.maxAgeMs);
const isExpired = (row, now) => expiresAt(row) <= now;

async function cleanup(d, now) {
  const cut = now - HOOK_LIMITS.inactivityMs, age = now - HOOK_LIMITS.maxAgeMs;
  await d.prepare('DELETE FROM hook_requests WHERE endpoint_id IN (SELECT id FROM hook_endpoints WHERE last_activity < ?1 OR created_at < ?2)').bind(cut, age).run();
  await d.prepare('DELETE FROM hook_endpoints WHERE last_activity < ?1 OR created_at < ?2').bind(cut, age).run();
}

/** POST /api/hooks */
export async function createHook(request, env, now = Date.now()) {
  const bad = sameOriginOnly(request); if (bad) return bad;
  const rl = rateLimit('hook-create:' + clientIp(request), { capacity: 10, windowMs: 60000 });
  if (!rl.ok) return fail(429, 'rate_limited', `Too many endpoints created — wait ${rl.retryAfter} s.`, { 'Retry-After': String(rl.retryAfter) });
  const d = await db(env); if (!d) return notConfigured();
  await cleanup(d, now);
  const ipHash = await sha256Hex('hooks-ip:' + clientIp(request));
  const recent = await d.prepare('SELECT COUNT(*) AS n FROM hook_endpoints WHERE ip_hash = ?1 AND created_at > ?2').bind(ipHash, now - 3600000).first();
  if (recent && recent.n >= HOOK_LIMITS.createsPerHour) return fail(429, 'rate_limited', `Limit reached: ${HOOK_LIMITS.createsPerHour} webhook endpoints per hour. Reuse an existing one or try later.`);
  const id = randomToken(16);
  const token = randomToken(32);
  await d.prepare('INSERT INTO hook_endpoints (id, token_hash, ip_hash, created_at, last_activity, request_count) VALUES (?1, ?2, ?3, ?4, ?4, 0)')
    .bind(id, await sha256Hex(token), ipHash, now).run();
  const origin = new URL(request.url).origin;
  return json({ ok: true, id, token, url: `${origin}/api/hook/${id}`, createdAt: now, expiresAt: now + HOOK_LIMITS.inactivityMs, limits: publicLimits() }, 201);
}

function publicLimits() {
  return { maxStored: HOOK_LIMITS.maxStoredPerEndpoint, maxBodyBytes: HOOK_LIMITS.maxBodyBytes, storedBodyBytes: HOOK_LIMITS.storedBodyBytes, inactivityHours: 24, maxAgeDays: 7 };
}

async function authed(request, env, id, now) {
  const d = await db(env); if (!d) return { res: notConfigured() };
  if (!ID_RE.test(id || '')) return { res: fail(404, 'not_found', 'Unknown webhook endpoint.') };
  const row = await d.prepare('SELECT * FROM hook_endpoints WHERE id = ?1').bind(id).first();
  if (!row) return { res: fail(404, 'not_found', 'This webhook endpoint does not exist (it may have expired or been deleted).') };
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m || !safeEqual(await sha256Hex(m[1]), row.token_hash)) return { res: fail(401, 'unauthorized', 'A valid endpoint token is required.') };
  if (isExpired(row, now)) return { res: fail(410, 'expired', 'This webhook endpoint has expired. Create a new one.') };
  return { d, row };
}

/** GET /api/hooks/:id/requests?after=N */
export async function listRequests(request, env, id, now = Date.now()) {
  const bad = sameOriginOnly(request); if (bad) return bad;
  const a = await authed(request, env, id, now); if (a.res) return a.res;
  const { d, row } = a;
  // Polling keeps the endpoint alive, but write at most every 10 minutes (D1 write budget).
  if (now - row.last_activity > 600000) { await d.prepare('UPDATE hook_endpoints SET last_activity = ?2 WHERE id = ?1').bind(id, now).run(); row.last_activity = now; }
  const after = Math.max(0, parseInt(new URL(request.url).searchParams.get('after') || '0', 10) || 0);
  const rs = await d.prepare('SELECT * FROM hook_requests WHERE endpoint_id = ?1 AND id > ?2 ORDER BY id DESC LIMIT ?3').bind(id, after, HOOK_LIMITS.listLimit).all();
  const requests = (rs.results || []).map((r) => ({
    id: r.id, receivedAt: r.received_at, method: r.method, path: r.path, query: r.query, headers: safeParse(r.headers),
    contentType: r.content_type, body: r.body, bodyEncoding: r.body_encoding, size: r.size, truncated: !!r.truncated, ip: r.ip,
  }));
  const origin = new URL(request.url).origin;
  return json({ ok: true, endpoint: { id, url: `${origin}/api/hook/${id}`, createdAt: row.created_at, expiresAt: expiresAt(row), requestCount: row.request_count }, requests, limits: publicLimits() });
}
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return []; } }

/** DELETE /api/hooks/:id */
export async function deleteHook(request, env, id, now = Date.now()) {
  const bad = sameOriginOnly(request); if (bad) return bad;
  const a = await authed(request, env, id, now);
  if (a.res && a.res.status !== 410) return a.res;
  const d = a.d || (await db(env));
  await d.prepare('DELETE FROM hook_requests WHERE endpoint_id = ?1').bind(id).run();
  await d.prepare('DELETE FROM hook_endpoints WHERE id = ?1').bind(id).run();
  return json({ ok: true, deleted: id });
}

/** DELETE /api/hooks/:id/requests */
export async function clearRequests(request, env, id, now = Date.now()) {
  const bad = sameOriginOnly(request); if (bad) return bad;
  const a = await authed(request, env, id, now); if (a.res) return a.res;
  await a.d.prepare('DELETE FROM hook_requests WHERE endpoint_id = ?1').bind(id).run();
  return json({ ok: true });
}

// Headers added by Cloudflare's edge, not by the webhook sender — hidden so the list shows what was sent.
const EDGE_HEADERS = /^(cf-.*|cdn-loop|x-forwarded-for|x-forwarded-proto|x-real-ip|true-client-ip)$/i;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '600' };

/** ANY /api/hook/:id[/...] — record the request. */
export async function receiveHook(request, env, id, subPath = '', now = Date.now()) {
  const d = await db(env); if (!d) return notConfigured();
  if (!ID_RE.test(id || '')) return fail(404, 'not_found', 'Unknown webhook endpoint.', CORS);
  const row = await d.prepare('SELECT id, created_at, last_activity, request_count FROM hook_endpoints WHERE id = ?1').bind(id).first();
  if (!row) return fail(404, 'not_found', 'Unknown webhook endpoint.', CORS);
  if (isExpired(row, now)) return fail(410, 'expired', 'This webhook endpoint has expired.', CORS);
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > HOOK_LIMITS.maxBodyBytes) return fail(413, 'payload_too_large', 'Payload larger than 1 MB — not stored.', CORS);
  const rl = rateLimit('hook-in:' + id, { capacity: HOOK_LIMITS.burstCount, windowMs: HOOK_LIMITS.burstWindowMs, now });
  if (!rl.ok) return fail(429, 'rate_limited', 'Too many requests to this endpoint — slow down.', { ...CORS, 'Retry-After': String(rl.retryAfter) });
  const burst = await d.prepare('SELECT COUNT(*) AS n FROM hook_requests WHERE endpoint_id = ?1 AND received_at > ?2').bind(id, now - HOOK_LIMITS.burstWindowMs).first();
  if (burst && burst.n >= HOOK_LIMITS.burstCount) return fail(429, 'rate_limited', 'Too many requests to this endpoint — slow down.', { ...CORS, 'Retry-After': '10' });

  const read = await readCapped(request.body, HOOK_LIMITS.maxBodyBytes, { abortOnExceed: true });
  if (read.truncated) return fail(413, 'payload_too_large', 'Payload larger than 1 MB — not stored.', CORS);
  const ct = request.headers.get('Content-Type') || '';
  const stored = read.bytes.subarray(0, HOOK_LIMITS.storedBodyBytes);
  const enc = encodeBody(stored, ct);
  const headers = [];
  for (const [k, v] of request.headers) if (!EDGE_HEADERS.test(k)) headers.push([k, v.length > 8192 ? v.slice(0, 8192) + '…' : v]);
  const u = new URL(request.url);
  await d.prepare(`INSERT INTO hook_requests (endpoint_id, received_at, method, path, query, headers, content_type, body, body_encoding, size, truncated, ip)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`)
    .bind(id, now, request.method.slice(0, 16), ('/' + (subPath || '')).slice(0, 2048), u.search.slice(0, 8192), JSON.stringify(headers.slice(0, 200)), ct.slice(0, 256) || null,
      enc.body, enc.bodyEncoding, read.size, read.bytes.byteLength > HOOK_LIMITS.storedBodyBytes ? 1 : 0, clientIp(request)).run();
  await d.prepare('UPDATE hook_endpoints SET last_activity = ?2, request_count = request_count + 1 WHERE id = ?1').bind(id, now).run();
  await d.prepare('DELETE FROM hook_requests WHERE endpoint_id = ?1 AND id NOT IN (SELECT id FROM hook_requests WHERE endpoint_id = ?1 ORDER BY id DESC LIMIT ?2)').bind(id, HOOK_LIMITS.maxStoredPerEndpoint).run();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Cache-Control': 'no-store' } });
  return json({ ok: true }, 200, CORS);
}
