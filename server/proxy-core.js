/* Secure HTTP proxy used by the REST tester, GraphQL playground and header checker when the target API
 * does not allow browser (CORS) access. Not an open proxy: public destinations only (see ssrf.js),
 * size / time / rate limits, no cookies or client IP forwarded, nothing logged. */
import { assertPublicUrl, SsrfError } from './ssrf.js';
import { json, fail, rateLimit, clientIp, sameOriginOnly, readCapped, encodeBody, base64ToBytes } from './limits.js';

export const LIMITS = {
  requestBody: 1024 * 1024,      // 1 MB
  responseBody: 5 * 1024 * 1024, // 5 MB
  timeoutMs: 15000,
  maxRedirects: 5,
  perMinute: 60,
};
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// Never forwarded from the user's header list (hop-by-hop, routing, identity of the caller).
const STRIP = /^(host|content-length|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|expect|cf-.*|cdn-loop|x-forwarded-.*|forwarded|x-real-ip|true-client-ip|via|origin|referer|sec-.*)$/i;
const UA = 'BhaskarSolution-APITester/1.0 (+https://image4k.org/api-tools)';

export async function handleProxy(request, env = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const resolve = deps.resolve;
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST', { Allow: 'POST' });
  const bad = sameOriginOnly(request);
  if (bad) return bad;
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return fail(415, 'unsupported_media_type', 'Send the proxy request as application/json');
  const rl = rateLimit('proxy:' + clientIp(request), { capacity: LIMITS.perMinute, windowMs: 60000 });
  if (!rl.ok) return fail(429, 'rate_limited', `Too many proxied requests — try again in ${rl.retryAfter} s (limit ${LIMITS.perMinute} per minute).`, { 'Retry-After': String(rl.retryAfter) });

  // Parse the envelope (bounded: 1 MB body + JSON/base64 overhead)
  const env1 = await readCapped(request.body, Math.ceil(LIMITS.requestBody * 1.4) + 64 * 1024);
  if (env1.truncated) return fail(413, 'request_too_large', 'Request body is larger than 1 MB.');
  let spec;
  try { spec = JSON.parse(new TextDecoder().decode(env1.bytes)); } catch (e) { return fail(400, 'bad_request', 'Proxy request must be valid JSON.'); }
  if (!spec || typeof spec !== 'object') return fail(400, 'bad_request', 'Proxy request must be a JSON object.');

  const method = String(spec.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) return fail(400, 'bad_method', `Unsupported method ${method}`);
  const headers = new Headers();
  if (spec.headers != null && !Array.isArray(spec.headers)) return fail(400, 'bad_request', 'headers must be an array of [name, value] pairs');
  try {
    for (const pair of spec.headers || []) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const [k, v] = [String(pair[0]).trim(), String(pair[1])];
      if (!k || STRIP.test(k)) continue;
      headers.append(k, v);
    }
  } catch (e) { return fail(400, 'bad_header', 'Invalid header name or value: ' + e.message); }
  if (!headers.has('User-Agent')) headers.set('User-Agent', UA);
  if (!headers.has('Accept')) headers.set('Accept', '*/*');

  let body = null;
  if (spec.body != null && spec.body !== '' && method !== 'GET' && method !== 'HEAD') {
    try { body = spec.bodyEncoding === 'base64' ? base64ToBytes(String(spec.body)) : new TextEncoder().encode(String(spec.body)); } catch (e) { return fail(400, 'bad_body', 'Body is not valid base64.'); }
    if (body.byteLength > LIMITS.requestBody) return fail(413, 'request_too_large', 'Request body is larger than 1 MB.');
  }

  const host = new URL(request.url).hostname.toLowerCase();
  // On preview deployments (branch.project.pages.dev) also refuse the production project host and its siblings.
  const pagesRoot = host.endsWith('.pages.dev') ? host.split('.').slice(-3).join('.') : null;
  const selfHosts = [host, pagesRoot, ...(env.SELF_HOSTS ? String(env.SELF_HOSTS).split(',') : [])].filter(Boolean).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
  const started = Date.now();
  const redirects = [];
  let url = String(spec.url || '');
  let curMethod = method, curBody = body;
  try {
    for (let hop = 0; ; hop++) {
      const u = await assertPublicUrl(url, { selfHosts, resolve, fetchImpl, signal: controller.signal });
      const res = await fetchImpl(u.toString(), { method: curMethod, headers, body: curBody, redirect: 'manual', signal: controller.signal });
      const loc = res.headers.get('Location');
      if (res.status >= 300 && res.status < 400 && loc && spec.followRedirects !== false) {
        if (hop >= LIMITS.maxRedirects) { try { await res.body?.cancel(); } catch (e) { /* ignore */ } throw new SsrfError(`Too many redirects (more than ${LIMITS.maxRedirects})`, 'too_many_redirects'); }
        const nextUrl = new URL(loc, u);
        const next = nextUrl.toString();
        redirects.push({ status: res.status, location: next });
        // Like browsers: credentials are not carried across to a different origin.
        if (nextUrl.origin !== u.origin) for (const h of ['Authorization', 'Cookie', 'Proxy-Authorization']) headers.delete(h);
        try { await res.body?.cancel(); } catch (e) { /* ignore */ }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod === 'POST')) { curMethod = curMethod === 'HEAD' ? 'HEAD' : 'GET'; curBody = null; headers.delete('Content-Type'); }
        url = next;
        continue;
      }
      const ct = res.headers.get('Content-Type') || '';
      const read = curMethod === 'HEAD' ? { bytes: new Uint8Array(0), size: 0, truncated: false } : await readCapped(res.body, LIMITS.responseBody);
      const outHeaders = [];
      for (const [k, v] of res.headers) if (k.toLowerCase() !== 'set-cookie') outHeaders.push([k, v]);
      const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('Set-Cookie') ? [res.headers.get('Set-Cookie')] : []);
      for (const c of cookies) outHeaders.push(['set-cookie', c]);
      const enc = encodeBody(read.bytes, ct);
      return json({
        ok: true, status: res.status, statusText: res.statusText || '', headers: outHeaders, ...enc,
        size: read.size, truncated: read.truncated, timeMs: Date.now() - started, redirects, finalUrl: u.toString(),
      });
    }
  } catch (e) {
    if (e instanceof SsrfError) return fail(e.code === 'invalid_url' || e.code === 'invalid_scheme' ? 400 : 403, e.code, e.message);
    if (e && e.name === 'AbortError') return fail(504, 'timeout', `The API did not answer within ${LIMITS.timeoutMs / 1000} s.`);
    return fail(502, 'upstream_error', 'Could not reach the API: ' + (e && e.message ? e.message.replace(/https?:\/\/\S+/g, '[url]') : 'network error'));
  } finally {
    clearTimeout(timer);
  }
}
