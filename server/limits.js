/* Best-effort, in-isolate rate limiting + small HTTP helpers shared by the Pages Functions.
 * A Cloudflare isolate is reused for many requests but not shared between data centres, so this
 * limiter slows bursts from one client; hard global limits need a Cloudflare dashboard rate-limiting rule
 * (documented in docs/DEPLOYMENT.md). */

const buckets = new Map();

/** Token bucket: capacity tokens, refilled continuously over windowMs. Returns { ok, retryAfter } (seconds). */
export function rateLimit(key, { capacity = 60, windowMs = 60000, now = Date.now() } = {}) {
  if (buckets.size > 10000) { // keep memory bounded
    for (const [k, b] of buckets) if (now - b.t > windowMs) buckets.delete(k);
    if (buckets.size > 10000) buckets.clear();
  }
  let b = buckets.get(key);
  const rate = capacity / windowMs;
  if (!b) { b = { tokens: capacity, t: now }; buckets.set(key, b); }
  b.tokens = Math.min(capacity, b.tokens + (now - b.t) * rate);
  b.t = now;
  if (b.tokens >= 1) { b.tokens -= 1; return { ok: true, retryAfter: 0 }; }
  return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / rate / 1000) };
}
export function _resetLimits() { buckets.clear(); }

export const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...BASE_HEADERS, ...extra } });
}
export function fail(status, code, error, extra) { return json({ ok: false, code, error }, status, extra); }

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || 'local';
}

/**
 * Management endpoints may only be called by our own pages: a browser always sends Origin on
 * cross-site POST/DELETE, so a foreign Origin is refused. (Non-browser clients can still call them;
 * they are protected by tokens and rate limits instead.)
 */
export function sameOriginOnly(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const self = new URL(request.url).origin;
  if (origin === self) return null;
  return fail(403, 'forbidden_origin', 'This endpoint can only be used from this website.');
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken(bytes = 16) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Constant-time comparison of two equal-length strings. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Read a request/response body stream up to `max` bytes. Returns { bytes, size, truncated }. */
export async function readCapped(stream, max, { abortOnExceed = false } = {}) {
  if (!stream) return { bytes: new Uint8Array(0), size: 0, truncated: false };
  const reader = stream.getReader();
  const chunks = []; let size = 0, kept = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (kept < max) {
      const take = value.subarray(0, Math.min(value.byteLength, max - kept));
      chunks.push(take); kept += take.byteLength;
    }
    if (size > max) {
      truncated = true;
      if (abortOnExceed) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; }
      try { await reader.cancel(); } catch (e) { /* ignore */ }
      break;
    }
  }
  const out = new Uint8Array(kept);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return { bytes: out, size, truncated };
}

const TEXTUAL = /^(text\/|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|x-yaml|csv|sql|ld\+json)|image\/svg\+xml)/i;
/** Encode bytes for JSON transport: UTF-8 text when it is text, otherwise base64. */
export function encodeBody(bytes, contentType) {
  if (!bytes.byteLength) return { body: '', bodyEncoding: 'text' };
  const looksText = TEXTUAL.test(contentType || '') || (!contentType && !bytes.subarray(0, 4096).includes(0));
  if (looksText) {
    try { return { body: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bodyEncoding: 'text' }; } catch (e) { /* fall through */ }
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { body: btoa(s), bodyEncoding: 'base64' };
}
export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
