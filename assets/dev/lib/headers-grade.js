/* Grades HTTP response headers for security, caching and CORS. Pure function: headers in, findings out.
 * Each finding: {name, status:'good'|'warn'|'bad'|'info', value, message}. */

function index(headers) {
  const m = new Map();
  for (const [k, v] of headers) {
    const key = k.toLowerCase();
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(v);
  }
  return { get: (k) => (m.has(k) ? m.get(k).join(', ') : null), all: (k) => m.get(k) || [], has: (k) => m.has(k) };
}

function directives(v) {
  const o = {};
  for (const part of String(v).split(/[;,]/)) {
    const [k, ...rest] = part.trim().split('=');
    if (k) o[k.trim().toLowerCase()] = rest.join('=').trim().replace(/^"|"$/g, '') || true;
  }
  return o;
}

/** @param headers [[name, value]]  @param opts {https:boolean} */
export function gradeHeaders(headers, opts = {}) {
  const h = index(headers);
  const https = opts.https !== false;
  const security = [];
  const add = (name, status, value, message, weight = 1) => security.push({ name, status, value, message, weight });

  // HSTS
  const hsts = h.get('strict-transport-security');
  if (!https) add('Strict-Transport-Security', 'info', hsts, 'Only meaningful on HTTPS responses — this URL is plain HTTP, so the connection itself is not encrypted.', 0);
  else if (!hsts) add('Strict-Transport-Security', 'bad', null, 'Missing. Browsers may connect over plain HTTP first (SSL-stripping risk). Add e.g. "max-age=31536000; includeSubDomains".', 2);
  else {
    const d = directives(hsts); const age = Number(d['max-age'] || 0);
    if (age < 15552000) add('Strict-Transport-Security', 'warn', hsts, `max-age is ${age} s — use at least 6 months (15552000), ideally 1 year.`, 2);
    else add('Strict-Transport-Security', 'good', hsts, 'HTTPS is enforced' + (d.includesubdomains ? ' including subdomains' : '') + (d.preload ? ' (preload-ready).' : '.'), 2);
  }

  // CSP
  const csp = h.get('content-security-policy');
  const cspRO = h.get('content-security-policy-report-only');
  if (!csp) add('Content-Security-Policy', cspRO ? 'warn' : 'bad', cspRO, cspRO ? 'Only a Report-Only policy is set — it reports but does not block attacks.' : 'Missing. A CSP is the strongest defence against cross-site scripting (XSS) and data injection.', 2);
  else {
    const weak = [];
    if (/script-src[^;]*'unsafe-inline'/.test(csp) && !/script-src[^;]*('nonce-|'sha(256|384|512)-|'strict-dynamic')/.test(csp)) weak.push("'unsafe-inline' scripts");
    if (/(script-src|default-src)[^;]*(\s|^)\*(\s|;|$)/.test(csp)) weak.push('wildcard script sources');
    if (!/default-src|script-src/.test(csp)) weak.push('no default-src / script-src');
    if (!/object-src\s+'none'/.test(csp) && !/default-src\s+'none'/.test(csp)) weak.push("object-src not 'none'");
    add('Content-Security-Policy', weak.length ? 'warn' : 'good', csp, weak.length ? 'Present but weakened by: ' + weak.join(', ') + '.' : 'Present and restricts script sources.', 2);
  }

  // Clickjacking
  const xfo = h.get('x-frame-options');
  const fa = csp && /frame-ancestors/.test(csp);
  if (fa) add('Clickjacking protection', 'good', 'CSP frame-ancestors', 'CSP frame-ancestors controls who may embed this page (supersedes X-Frame-Options).');
  else if (xfo && /^(deny|sameorigin)$/i.test(xfo.trim())) add('X-Frame-Options', 'good', xfo, 'Page cannot be embedded by other sites (clickjacking protection).');
  else add('X-Frame-Options', 'bad', xfo, xfo ? `Unrecognised value "${xfo}" — use DENY or SAMEORIGIN, or CSP frame-ancestors.` : 'Missing (and no CSP frame-ancestors). Other sites could embed this page in a frame (clickjacking).');

  const xcto = h.get('x-content-type-options');
  add('X-Content-Type-Options', xcto && /nosniff/i.test(xcto) ? 'good' : 'bad', xcto, xcto && /nosniff/i.test(xcto) ? 'MIME sniffing disabled.' : 'Missing "nosniff". Browsers may guess content types and execute uploaded files as scripts.');

  const rp = h.get('referrer-policy');
  if (!rp) add('Referrer-Policy', 'warn', null, 'Missing. Browsers default to strict-origin-when-cross-origin; set it explicitly (e.g. strict-origin-when-cross-origin or no-referrer).');
  else if (/unsafe-url|no-referrer-when-downgrade/i.test(rp)) add('Referrer-Policy', 'warn', rp, 'Leaks full URLs (including paths and query strings) to other sites.');
  else add('Referrer-Policy', 'good', rp, 'Limits what URL information is sent to other sites.');

  const pp = h.get('permissions-policy');
  add('Permissions-Policy', pp ? 'good' : 'warn', pp, pp ? 'Restricts powerful browser features (camera, microphone, geolocation…).' : 'Missing. Consider disabling features the site does not use, e.g. camera=(), microphone=(), geolocation=().');

  const coop = h.get('cross-origin-opener-policy');
  add('Cross-Origin-Opener-Policy', coop ? 'good' : 'info', coop, coop ? 'Isolates the browsing context from cross-origin windows.' : 'Not set (optional). "same-origin" protects against cross-window attacks (e.g. XS-Leaks).', 0);
  const coep = h.get('cross-origin-embedder-policy');
  add('Cross-Origin-Embedder-Policy', coep ? 'good' : 'info', coep, coep ? 'Controls loading of cross-origin resources (needed for cross-origin isolation).' : 'Not set (optional; required only for SharedArrayBuffer / cross-origin isolation).', 0);
  const corp = h.get('cross-origin-resource-policy');
  add('Cross-Origin-Resource-Policy', corp ? 'good' : 'info', corp, corp ? 'Limits which sites may load this resource.' : 'Not set (optional). Protects resources from being loaded by other sites (Spectre-style leaks).', 0);

  // Cookies
  const cookies = h.all('set-cookie').map((c) => {
    const name = c.split('=')[0].trim();
    const lower = c.toLowerCase();
    const flags = { secure: /;\s*secure/.test(lower), httpOnly: /;\s*httponly/.test(lower), sameSite: (/;\s*samesite=(\w+)/.exec(lower) || [])[1] || null };
    const issues = [];
    if (https && !flags.secure) issues.push('missing Secure');
    if (!flags.httpOnly) issues.push('missing HttpOnly (readable by JavaScript)');
    if (!flags.sameSite) issues.push('no SameSite (defaults to Lax)');
    else if (flags.sameSite === 'none' && !flags.secure) issues.push('SameSite=None requires Secure');
    return { name, value: c, flags, status: issues.length ? (issues.some((i) => /Secure|SameSite=None/.test(i)) ? 'bad' : 'warn') : 'good', message: issues.length ? issues.join('; ') + '.' : 'Secure, HttpOnly and SameSite set.' };
  });
  for (const c of cookies) add(`Set-Cookie: ${c.name}`, c.status, c.value, c.message);

  // Information disclosure
  for (const name of ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-generator']) {
    const v = h.get(name);
    if (!v) continue;
    const versioned = /\d/.test(v);
    add(name.replace(/(^|-)(\w)/g, (m, a, b) => a + b.toUpperCase()), name === 'server' && !versioned ? 'info' : 'warn', v,
      versioned ? 'Reveals software and version — helps attackers find known vulnerabilities. Remove or genericise it.' : 'Reveals the technology in use. Harmless on its own, but often removed.', name === 'server' && !versioned ? 0 : 1);
  }

  // Score
  let max = 0, got = 0;
  for (const f of security) {
    if (!f.weight) continue;
    max += f.weight;
    got += f.weight * (f.status === 'good' ? 1 : f.status === 'warn' ? 0.5 : 0);
  }
  const score = max ? Math.round((got / max) * 100) : 0;
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  // Caching
  const cache = [];
  const cc = h.get('cache-control');
  if (cc) {
    const d = directives(cc);
    let msg = [];
    if (d['no-store']) msg.push('never stored by browsers or CDNs');
    else if (d['no-cache']) msg.push('stored but revalidated with the server before every use');
    if (d['max-age'] !== undefined) msg.push(`fresh for ${fmtSecs(Number(d['max-age']))} in browsers`);
    if (d['s-maxage'] !== undefined) msg.push(`fresh for ${fmtSecs(Number(d['s-maxage']))} in shared caches/CDNs`);
    if (d.private) msg.push('only the browser may cache it (private)');
    if (d.public) msg.push('CDNs may cache it (public)');
    if (d.immutable) msg.push('never revalidated while fresh (immutable)');
    if (d['must-revalidate']) msg.push('must revalidate once stale');
    cache.push({ name: 'Cache-Control', value: cc, message: msg.length ? msg.join('; ') + '.' : 'Custom directives.' });
  } else cache.push({ name: 'Cache-Control', value: null, message: 'Missing — caches use heuristics (often 10% of the age since Last-Modified).' });
  for (const [name, msg] of [['etag', 'Validator for conditional requests (If-None-Match → 304).'], ['last-modified', 'Validator for conditional requests (If-Modified-Since → 304).'], ['expires', 'Legacy absolute expiry (ignored when Cache-Control max-age is present).'], ['age', 'Seconds the response has been in a shared cache — indicates a CDN hit.'], ['vary', 'Request headers that create separate cache entries.'], ['pragma', 'Legacy HTTP/1.0 cache directive.'], ['cf-cache-status', 'Cloudflare cache result.'], ['x-cache', 'CDN cache result.']]) {
    const v = h.get(name); if (v) cache.push({ name: name.replace(/(^|-)(\w)/g, (m, a, b) => a + b.toUpperCase()), value: v, message: msg });
  }

  // CORS
  const cors = [];
  const acao = h.get('access-control-allow-origin');
  if (!acao) cors.push({ name: 'Access-Control-Allow-Origin', value: null, status: 'info', message: 'Not set — browsers will not let other websites read this response (same-origin only). Normal for regular web pages.' });
  else {
    const creds = /true/i.test(h.get('access-control-allow-credentials') || '');
    const st = acao.trim() === '*' ? (creds ? 'bad' : 'warn') : 'good';
    cors.push({ name: 'Access-Control-Allow-Origin', value: acao, status: st, message: acao.trim() === '*' ? 'Any website may read this response' + (creds ? ' — and credentials are allowed, which browsers reject and indicates a misconfiguration.' : '. Fine for public APIs; never for user-specific data.') : `Only ${acao} may read this response.` });
  }
  for (const [name, msg] of [['access-control-allow-credentials', 'Cookies/credentials allowed on cross-origin requests.'], ['access-control-allow-methods', 'Methods allowed in cross-origin requests.'], ['access-control-allow-headers', 'Request headers allowed in cross-origin requests.'], ['access-control-expose-headers', 'Response headers readable by other origins.'], ['access-control-max-age', 'How long browsers may cache the preflight result (seconds).'], ['timing-allow-origin', 'Origins allowed to read detailed resource timing.']]) {
    const v = h.get(name); if (v) cors.push({ name: name.replace(/(^|-)(\w)/g, (m, a, b) => a + b.toUpperCase()), value: v, status: 'info', message: msg });
  }

  return { score, grade, security, cache, cors, cookies };
}

function fmtSecs(s) {
  if (!Number.isFinite(s)) return '?';
  if (s < 120) return s + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  if (s < 172800) return +(s / 3600).toFixed(1) + ' h';
  return Math.round(s / 86400) + ' days';
}
