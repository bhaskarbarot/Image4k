/* SSRF guard for the API proxy (Cloudflare Pages Functions). Pure functions + an injectable DNS resolver,
 * so the same code runs in the Workers runtime and in node unit tests.
 *
 * Defence layers:
 *  1. scheme allow-list (http, https), no credentials in the URL, port allow-list;
 *  2. hostname deny-list (localhost, *.local, *.internal, metadata names, single-label names, our own host);
 *  3. IP literals in any private / reserved / special-purpose range are refused (IPv4 and IPv6, including
 *     IPv4-mapped, IPv4-compatible, NAT64 and 6to4 forms that embed an IPv4 address);
 *  4. hostnames are resolved with DNS-over-HTTPS and refused if ANY A/AAAA answer is private
 *     (DNS-rebinding mitigation). Remaining window: the runtime resolves again when it connects, so a
 *     hostile DNS server could still flip the answer between our check and the connection (TOCTOU).
 *     Cloudflare's Workers runtime itself does not route subrequests to private/internal networks, which
 *     covers that window on the production platform.
 *  5. every redirect hop goes through the same checks (the proxy follows redirects manually).
 */

export const ALLOWED_PORTS = new Set([80, 443, 8080, 8443, 8000, 8008, 8888, 3000, 4000, 5000, 9000]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.home.arpa', '.intranet', '.corp', '.private', '.localdomain', '.test', '.invalid', '.onion', '.arpa'];
const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal', 'kubernetes', 'kubernetes.default', 'wpad']);

export class SsrfError extends Error {
  constructor(message, code = 'blocked_destination') { super(message); this.name = 'SsrfError'; this.code = code; }
}

/** Strict dotted-quad parser (the WHATWG URL parser has already normalised hex/octal/decimal forms). */
export function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

/** Returns a reason string if the IPv4 address is not a public unicast address, else null. */
export function ipv4Reason(o) {
  const [a, b, c] = o;
  if (a === 0) return 'this-network (0.0.0.0/8)';
  if (a === 10) return 'private network (10.0.0.0/8)';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64.0.0/10)';
  if (a === 127) return 'loopback (127.0.0.0/8)';
  if (a === 169 && b === 254) return 'link-local / cloud metadata (169.254.0.0/16)';
  if (a === 172 && b >= 16 && b <= 31) return 'private network (172.16.0.0/12)';
  if (a === 192 && b === 0 && c === 0) return 'IETF protocol assignments (192.0.0.0/24)';
  if (a === 192 && b === 0 && c === 2) return 'documentation range (192.0.2.0/24)';
  if (a === 192 && b === 88 && c === 99) return '6to4 relay anycast (192.88.99.0/24)';
  if (a === 192 && b === 168) return 'private network (192.168.0.0/16)';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking range (198.18.0.0/15)';
  if (a === 198 && b === 51 && c === 100) return 'documentation range (198.51.100.0/24)';
  if (a === 203 && b === 0 && c === 113) return 'documentation range (203.0.113.0/24)';
  if (a >= 224 && a <= 239) return 'multicast (224.0.0.0/4)';
  if (a >= 240) return a === 255 && b === 255 && c === 255 && o[3] === 255 ? 'broadcast (255.255.255.255)' : 'reserved (240.0.0.0/4)';
  return null;
}

/** Parse an IPv6 address (no brackets, optional zone id rejected) into 8 16-bit words. */
export function parseIPv6(s) {
  if (!s || s.includes('%')) return null;
  let tail = [];
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const o = parseIPv4(v4[1]);
    if (!o) return null;
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, -v4[1].length);
    if (s.endsWith('::')) { /* ok */ } else if (s.endsWith(':')) s = s.slice(0, -1); else return null;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const toWords = (p) => (p === '' ? [] : p.split(':').map((h) => (/^[0-9a-fA-F]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = toWords(parts[0]);
  const back = parts.length === 2 ? toWords(parts[1]) : [];
  if ([...head, ...back].some(Number.isNaN)) return null;
  const total = head.length + back.length + tail.length;
  let words;
  if (parts.length === 2) {
    if (total > 7) return null;
    words = [...head, ...new Array(8 - total).fill(0), ...back, ...tail];
  } else {
    if (total !== 8) return null;
    words = [...head, ...tail];
  }
  return words.length === 8 ? words : null;
}

const v4FromWords = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/** Returns a reason string if the IPv6 address is not a public unicast address, else null. */
export function ipv6Reason(w) {
  const zeroUpTo = (n) => w.slice(0, n).every((x) => x === 0);
  if (w.every((x) => x === 0)) return 'unspecified address (::)';
  if (zeroUpTo(7) && w[7] === 1) return 'loopback (::1)';
  if (zeroUpTo(5) && w[5] === 0xffff) { const r = ipv4Reason(v4FromWords(w[6], w[7])); return 'IPv4-mapped address' + (r ? ': ' + r : ' (not allowed)'); }
  if (zeroUpTo(6)) return 'IPv4-compatible address (deprecated ::/96)';
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
    // NAT64 is never needed to reach a public API from the proxy; refuse all of it, naming the embedded IPv4.
    const v4 = v4FromWords(w[6], w[7]);
    const r = ipv4Reason(v4);
    return 'NAT64 address (64:ff9b::/96) embedding ' + v4.join('.') + (r ? ' — ' + r : '');
  }
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return 'local-use NAT64 (64:ff9b:1::/48)';
  if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return 'discard prefix (100::/64)';
  if (w[0] === 0x2001 && w[1] === 0x0db8) return 'documentation range (2001:db8::/32)';
  if (w[0] === 0x2001 && w[1] === 0) return 'Teredo tunnel (2001::/32)';
  if (w[0] === 0x2001 && w[1] < 0x0200) return 'IETF special-purpose range (2001::/23)';
  if (w[0] === 0x2002) { const r = ipv4Reason(v4FromWords(w[1], w[2])); return r ? '6to4 address embedding ' + r : null; }
  if ((w[0] & 0xfe00) === 0xfc00) return 'unique-local address (fc00::/7)';
  if ((w[0] & 0xffc0) === 0xfe80) return 'link-local address (fe80::/10)';
  if ((w[0] & 0xffc0) === 0xfec0) return 'site-local address (fec0::/10)';
  if ((w[0] & 0xff00) === 0xff00) return 'multicast (ff00::/8)';
  if ((w[0] & 0xe000) !== 0x2000) return 'not a global unicast address (outside 2000::/3)';
  return null;
}

/** Reason string if the IP (v4 or v6, brackets allowed) is not public; null if public; undefined if not an IP. */
export function ipReason(ip) {
  const s = ip.replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(s);
  if (v4) return ipv4Reason(v4);
  if (s.includes(':')) { const v6 = parseIPv6(s); return v6 ? ipv6Reason(v6) : 'invalid IPv6 address'; }
  return undefined;
}

/**
 * Validate a URL string (no DNS). Returns the parsed URL or throws SsrfError.
 * opts.selfHosts: hostnames of this site (never proxy to ourselves).
 */
export function checkUrl(raw, opts = {}) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (e) { throw new SsrfError('Invalid URL — include the scheme, e.g. https://api.example.com/path', 'invalid_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError(`Only http:// and https:// URLs can be requested (got ${u.protocol})`, 'invalid_scheme');
  if (u.username || u.password) throw new SsrfError('Credentials inside the URL (user:pass@host) are not allowed — use the Auth tab / an Authorization header', 'credentials_in_url');
  let host = u.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) throw new SsrfError('URL has no host', 'invalid_url');
  // Destination checks first (clearest reason), then the port.
  const r = ipReason(host);
  if (r) throw new SsrfError(`Blocked destination: ${host} is a ${r}. The proxy only reaches public internet addresses.`);
  if (r === undefined) {
    if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new SsrfError(`Blocked destination: ${host} is a local / internal host name. The proxy only reaches public internet addresses.`);
    if (!host.includes('.')) throw new SsrfError(`Blocked destination: single-label host names like "${host}" are internal. Use a full domain name.`);
    if ((opts.selfHosts || []).some((s) => host === s || host.endsWith('.' + s))) throw new SsrfError('The proxy cannot call this website itself.', 'self_request');
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) throw new SsrfError(`Port ${port} is not allowed through the proxy. Allowed: ${[...ALLOWED_PORTS].join(', ')}`, 'port_not_allowed');
  return u;
}

/** Resolve A + AAAA via DNS-over-HTTPS. fetchImpl is injectable for tests. Returns array of IP strings. */
export async function resolveHost(host, { fetchImpl = fetch, signal } = {}) {
  const ask = async (type) => {
    const r = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal });
    if (!r.ok) throw new SsrfError('DNS lookup failed (HTTP ' + r.status + ')', 'dns_failed');
    const j = await r.json();
    return j;
  };
  const [a, aaaa] = await Promise.all([ask('A'), ask('AAAA')]);
  const ips = [];
  for (const j of [a, aaaa]) for (const ans of j.Answer || []) if (ans.type === 1 || ans.type === 28) ips.push(String(ans.data));
  if (!ips.length) {
    const nx = a.Status === 3 || aaaa.Status === 3;
    throw new SsrfError(nx ? `Host not found: ${host} does not exist (NXDOMAIN)` : `Could not resolve ${host} — no A/AAAA records`, 'dns_not_found');
  }
  return ips;
}

/** Full check: URL rules + DNS answers must all be public. Returns the URL. */
export async function assertPublicUrl(raw, opts = {}) {
  const u = checkUrl(raw, opts);
  const host = u.hostname.replace(/\.$/, '');
  if (ipReason(host) === undefined) {
    const ips = await (opts.resolve || resolveHost)(host, opts);
    for (const ip of ips) {
      const r = ipReason(ip);
      if (r === undefined || r) throw new SsrfError(`Blocked destination: ${host} resolves to ${ip} (${r || 'unrecognised address'}). The proxy only reaches public internet addresses.`, 'blocked_dns');
    }
  }
  return u;
}
