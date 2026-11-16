/* HTTP client for the API tools: one request model, two transports.
 *  - direct: the browser's fetch() — private, but limited by the target's CORS policy;
 *  - proxy:  POST /api/proxy (Cloudflare Pages Function) — reaches any PUBLIC API, sees all headers.
 * Both resolve to the same normalised result so the UI does not care which one was used. */

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export class HttpToolError extends Error {
  constructor(message, code, detail) { super(message); this.name = 'HttpToolError'; this.code = code; this.detail = detail; }
}

/** Validate & build the final URL from a base URL and [{key,value}] params (params replace the URL's query). */
export function buildUrl(raw, params) {
  const s = String(raw || '').trim();
  if (!s) throw new HttpToolError('Enter a URL to send the request to.', 'invalid_url');
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); } catch (e) {
    throw new HttpToolError(`“${s}” is not a valid URL.`, 'invalid_url', 'Use a full address such as https://api.example.com/v1/users');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpToolError(`Only http:// and https:// URLs are supported (got ${u.protocol}).`, 'invalid_url');
  // Browsers are lenient (Chrome turns "exa mple" into "exa%20mple"); require a real host name or IP.
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9-]+(\.[a-z0-9-]+)*\.?)$/i.test(u.hostname)) {
    throw new HttpToolError(`“${s}” is not a valid URL — the host name “${decodeURIComponent(u.hostname)}” contains invalid characters.`, 'invalid_url', 'Use a full address such as https://api.example.com/v1/users');
  }
  if (params) {
    u.search = '';
    for (const p of params) u.searchParams.append(p.key, p.value);
  }
  return u;
}

/** Split a URL's query string into [{key,value}] rows. */
export function paramsFromUrl(raw) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    return [...u.searchParams].map(([key, value]) => ({ key, value }));
  } catch (e) { return null; }
}

const enc = new TextEncoder();
function b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function bytesFromB64(b64) {
  const s = atob(b64); const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Turn the UI body model into something sendable.
 * body: {type:'none'|'json'|'text'|'urlencoded'|'form', text, rows:[{key,value,file?}]}
 * Returns {payload, contentType} where payload is a string | URLSearchParams | FormData | null.
 */
export function buildBody(body, method) {
  if (!body || body.type === 'none' || method === 'GET' || method === 'HEAD') return { payload: null, contentType: null };
  if (body.type === 'json') return { payload: body.text, contentType: 'application/json' };
  if (body.type === 'text') return { payload: body.text, contentType: body.contentType || 'text/plain;charset=UTF-8' };
  if (body.type === 'urlencoded') {
    const p = new URLSearchParams();
    for (const r of body.rows || []) p.append(r.key, r.value);
    return { payload: p, contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  }
  if (body.type === 'form') {
    const fd = new FormData();
    for (const r of body.rows || []) { if (r.file) fd.append(r.key, r.file, r.file.name); else fd.append(r.key, r.value); }
    return { payload: fd, contentType: null }; // the browser sets multipart/form-data; boundary=…
  }
  return { payload: null, contentType: null };
}

/** Headers list [[k,v]] including auth. auth: {type:'none'|'bearer'|'basic'|'apikey', token, user, pass, key, value, in:'header'|'query'} */
export function applyAuth(headers, url, auth) {
  const out = headers.slice();
  if (!auth || auth.type === 'none') return out;
  if (auth.type === 'bearer' && auth.token) out.push(['Authorization', 'Bearer ' + auth.token.trim()]);
  if (auth.type === 'basic' && (auth.user || auth.pass)) {
    const raw = enc.encode(`${auth.user || ''}:${auth.pass || ''}`);
    out.push(['Authorization', 'Basic ' + b64FromBytes(raw)]);
  }
  if (auth.type === 'apikey' && auth.key) {
    if (auth.in === 'query') url.searchParams.set(auth.key, auth.value || '');
    else out.push([auth.key, auth.value || '']);
  }
  return out;
}

/**
 * Prepare a request from the UI model.
 * model: {method, url, params:[{key,value}], headers:[{key,value}], auth, body}
 * → {method, url (string), headers [[k,v]], payload, contentType}
 */
export function prepare(model) {
  const method = String(model.method || 'GET').toUpperCase();
  const url = buildUrl(model.url, model.params);
  let headers = (model.headers || []).map((h) => [h.key, h.value]);
  headers = applyAuth(headers, url, model.auth);
  const { payload, contentType } = buildBody(model.body, method);
  if (contentType && !headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', contentType]);
  for (const [k] of headers) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k)) throw new HttpToolError(`Invalid header name “${k}”.`, 'bad_header', 'Header names may only contain letters, digits and !#$%&\'*+-.^_`|~');
  }
  return { method, url: url.toString(), headers, payload, contentType };
}

/** Send with the browser's fetch. opts: {signal, timeoutMs} */
export async function sendDirect(req, opts = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, opts.timeoutMs || 30000);
  const started = performance.now();
  try {
    const headers = new Headers();
    for (const [k, v] of req.headers) {
      // with FormData the browser must generate the multipart boundary itself
      if (req.payload instanceof FormData && k.toLowerCase() === 'content-type') continue;
      headers.append(k, v);
    }
    const res = await fetch(req.url, { method: req.method, headers, body: req.payload, signal: ctrl.signal, credentials: 'omit', redirect: 'follow', cache: 'no-store', referrerPolicy: 'no-referrer' });
    const bytes = req.method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await res.arrayBuffer());
    return {
      via: 'direct', status: res.status, statusText: res.statusText, headers: [...res.headers], bytes, size: bytes.byteLength,
      timeMs: Math.round(performance.now() - started), finalUrl: res.url || req.url, redirected: res.redirected, redirects: [], truncated: false,
      contentType: res.headers.get('content-type') || '',
    };
  } catch (e) {
    if (e.name === 'AbortError') {
      if (timedOut) throw new HttpToolError(`No response within ${Math.round((opts.timeoutMs || 30000) / 1000)} s — the request timed out.`, 'timeout');
      throw new HttpToolError('Request cancelled.', 'cancelled');
    }
    if (e instanceof TypeError) {
      const insecure = location.protocol === 'https:' && req.url.startsWith('http:') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(req.url);
      throw new HttpToolError(
        insecure ? 'Blocked: this page is HTTPS and the API is plain HTTP (mixed content).' : 'The browser could not read the response: the server did not allow this website (CORS), or it is unreachable.',
        'network',
        insecure ? 'Use https:// for the API, or switch “Send via” to Secure proxy.'
          : 'Browsers only let a page read another site\'s response if that API sends Access-Control-Allow-Origin. Switch “Send via” to Secure proxy to call public APIs without CORS, or check the URL, DNS and that the server is running.',
      );
    }
    throw new HttpToolError(e.message || 'Request failed', 'error');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Send through /api/proxy. FormData / URLSearchParams are serialised exactly as a browser would. */
export async function sendProxy(req, opts = {}) {
  let body = null, bodyEncoding = 'text';
  const headers = req.headers.slice();
  if (req.payload != null) {
    if (typeof req.payload === 'string') body = req.payload;
    else {
      // Let the platform encode multipart / urlencoded, then ship the raw bytes as base64.
      const r = new Response(req.payload);
      const ct = r.headers.get('content-type');
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.byteLength > 1024 * 1024) throw new HttpToolError('The request body is larger than the proxy limit (1 MB).', 'too_large');
      body = b64FromBytes(buf); bodyEncoding = 'base64';
      if (ct) { for (let i = headers.length - 1; i >= 0; i--) if (headers[i][0].toLowerCase() === 'content-type') headers.splice(i, 1); headers.push(['Content-Type', ct]); }
    }
  }
  const started = performance.now();
  let res;
  try {
    res = await fetch('/api/proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: opts.signal, cache: 'no-store',
      body: JSON.stringify({ url: req.url, method: req.method, headers, body, bodyEncoding, followRedirects: opts.followRedirects !== false }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new HttpToolError('Request cancelled.', 'cancelled');
    throw new HttpToolError('Could not reach the secure proxy of this website.', 'proxy_unreachable', 'Check your internet connection and try again.');
  }
  let data;
  try { data = await res.json(); } catch (e) {
    throw new HttpToolError(res.status === 404 ? 'The secure proxy is not available on this deployment.' : `The proxy answered with HTTP ${res.status}.`, 'proxy_unavailable', res.status === 404 ? 'It runs as a Cloudflare Pages Function at /api/proxy.' : undefined);
  }
  if (!data.ok) throw new HttpToolError(data.error || 'Proxy error', data.code || 'proxy_error', proxyHint(data.code));
  const bytes = data.bodyEncoding === 'base64' ? bytesFromB64(data.body || '') : enc.encode(data.body || '');
  const ct = (data.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
  return {
    via: 'proxy', status: data.status, statusText: data.statusText, headers: data.headers, bytes, size: data.size, truncated: data.truncated,
    timeMs: data.timeMs, roundTripMs: Math.round(performance.now() - started), finalUrl: data.finalUrl, redirected: data.redirects.length > 0, redirects: data.redirects, contentType: ct,
  };
}
function proxyHint(code) {
  return {
    blocked_destination: 'For your safety the proxy only reaches public internet addresses. To test a local server, use “Direct” instead.',
    blocked_dns: 'The host name points to a private / internal address, which the proxy never contacts.',
    port_not_allowed: 'Use a standard port, or call the API directly from your browser.',
    rate_limited: 'The proxy is shared by everyone — please wait a moment.',
    timeout: 'The API was too slow to answer (15 s limit).',
  }[code];
}

export function send(req, mode, opts) { return mode === 'proxy' ? sendProxy(req, opts) : sendDirect(req, opts); }

/* ---------- response helpers ---------- */
export function decodeText(bytes) { return new TextDecoder('utf-8').decode(bytes); }
export function isProbablyText(bytes, contentType) {
  if (/^(text\/|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|javascript|x-www-form-urlencoded|graphql|yaml|csv))|image\/svg/i.test(contentType || '')) return true;
  if (/^(image|audio|video|font)\/|application\/(octet-stream|pdf|zip|gzip|wasm)/i.test(contentType || '')) return false;
  const head = bytes.subarray(0, 4096);
  if (head.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); return true; } catch (e) { return false; } // stream: a cut multi-byte char at the end is not an error
}
export function kindOf(contentType, text) {
  const ct = (contentType || '').toLowerCase();
  if (/json/.test(ct)) return 'json';
  if (/xml|svg/.test(ct)) return 'xml';
  if (/html/.test(ct)) return 'html';
  if (text != null) {
    const t = text.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) { try { JSON.parse(text); return 'json'; } catch (e) { /* not json */ } }
    if (t.startsWith('<?xml')) return 'xml';
  }
  return 'text';
}
export function hexDump(bytes, max = 4096) {
  const lines = [];
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i += 16) {
    const row = bytes.subarray(i, Math.min(i + 16, n));
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const asc = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(i.toString(16).padStart(8, '0') + '  ' + hex.padEnd(48) + ' ' + asc);
  }
  if (bytes.length > max) lines.push(`… ${bytes.length - max} more bytes`);
  return lines.join('\n');
}
export function statusClass(s) { return s >= 500 ? 'is-err' : s >= 400 ? 'is-err' : s >= 300 ? 'is-warn' : s >= 200 ? 'is-ok' : 'is-info'; }

/* ---------- cURL ---------- */
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
/** Build a bash cURL command for a prepared request (string / URLSearchParams / FormData payloads). */
export function toCurl(req) {
  const parts = ['curl'];
  if (req.method === 'HEAD') parts.push('--head');
  else if (req.method !== 'GET' || (req.payload != null && req.method !== 'GET')) parts.push('-X', req.method);
  parts.push(shq(req.url));
  for (const [k, v] of req.headers) {
    if (req.payload instanceof FormData && k.toLowerCase() === 'content-type') continue;
    parts.push('-H', shq(`${k}: ${v}`));
  }
  if (typeof req.payload === 'string') parts.push('--data-raw', shq(req.payload));
  else if (req.payload instanceof URLSearchParams) parts.push('--data-raw', shq(req.payload.toString()));
  else if (req.payload instanceof FormData) for (const [k, v] of req.payload) parts.push('-F', shq(typeof v === 'string' ? `${k}=${v}` : `${k}=@${v.name}`));
  return parts.join(' ');
}

/* ---------- history (secrets redacted) ---------- */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;
const SECRET_PARAM = /^(token|access_token|id_token|refresh_token|api_key|apikey|key|secret|client_secret|password|sig|signature|auth)$/i;
export function redactModel(model) {
  const m = JSON.parse(JSON.stringify({ ...model, body: model.body && { ...model.body, rows: (model.body.rows || []).map((r) => ({ key: r.key, value: r.file ? '' : r.value })) } }));
  m.headers = (m.headers || []).map((h) => (SECRET_HEADER.test(h.key) ? { ...h, value: '' } : h));
  m.params = (m.params || []).map((p) => (SECRET_PARAM.test(p.key) ? { ...p, value: '' } : p));
  try {
    const u = new URL(m.url);
    for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.set(k, '');
    u.username = ''; u.password = '';
    m.url = u.toString();
  } catch (e) { /* keep as typed */ }
  if (m.auth) m.auth = { type: m.auth.type, in: m.auth.in, key: m.auth.key, user: m.auth.user }; // secrets dropped
  if (m.body && typeof m.body.text === 'string' && m.body.text.length > 20000) m.body.text = m.body.text.slice(0, 20000);
  return m;
}
