/* UUID v4 and v7 (RFC 9562) — pure module, uses crypto.getRandomValues. */

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fmt = (b) => { const s = hex(b); return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`; };

export function uuidv4() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  return fmt(b);
}

/* v7: 48-bit Unix ms timestamp + 12-bit counter (rand_a, RFC 9562 §6.2 method 1) + 62 random bits.
 * Within the same millisecond the counter increments, so generated IDs are strictly increasing;
 * if the counter overflows, the timestamp is advanced by 1 ms (allowed by the RFC). */
let lastMs = -1, counter = 0;
export function uuidv7(now = Date.now()) {
  let ms = now;
  if (ms <= lastMs) {
    ms = lastMs;
    counter++;
    if (counter > 0xfff) { ms = lastMs + 1; counter = crypto.getRandomValues(new Uint16Array(1))[0] & 0x7ff; }
  } else {
    counter = crypto.getRandomValues(new Uint16Array(1))[0] & 0x7ff; // top bit 0 leaves room to count
  }
  lastMs = ms;
  const b = crypto.getRandomValues(new Uint8Array(16));
  // 48-bit big-endian timestamp
  let t = ms;
  for (let i = 5; i >= 0; i--) { b[i] = t % 256; t = Math.floor(t / 256); }
  b[6] = 0x70 | ((counter >> 8) & 0x0f);
  b[7] = counter & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80;
  return fmt(b);
}

export const NIL = '00000000-0000-0000-0000-000000000000';
export const MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** format(uuid, {upper, hyphens=true, braces=false}) */
export function formatUuid(u, opts = {}) {
  let s = opts.hyphens === false ? u.replace(/-/g, '') : u;
  if (opts.upper) s = s.toUpperCase();
  if (opts.braces) s = '{' + s + '}';
  return s;
}

/** Inspect any UUID string: accepts hyphens or not, braces, urn:uuid: prefix, any case. */
export function inspectUuid(input) {
  const raw = String(input).trim();
  const s = raw.replace(/^urn:uuid:/i, '').replace(/^\{(.*)\}$/, '$1');
  const compact = s.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(compact) || (s.includes('-') && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s))) {
    return { valid: false, error: 'Not a UUID — expected 32 hex digits, optionally as 8-4-4-4-12 with hyphens.' };
  }
  const c = compact.toLowerCase();
  const canonical = `${c.slice(0, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}-${c.slice(16, 20)}-${c.slice(20)}`;
  if (c === NIL.replace(/-/g, '')) return { valid: true, canonical, version: 0, variant: 'Nil UUID', special: 'nil' };
  if (c === MAX.replace(/-/g, '')) return { valid: true, canonical, version: 15, variant: 'Max UUID', special: 'max' };
  const version = parseInt(c[12], 16);
  const v = parseInt(c[16], 16);
  const variant = (v & 0x8) === 0 ? 'NCS (reserved, legacy)' : (v & 0xc) === 0x8 ? 'RFC 9562 / RFC 4122' : (v & 0xe) === 0xc ? 'Microsoft (reserved)' : 'Reserved (future)';
  const out = { valid: true, canonical, version, variant };
  if (version === 7 || version === 6 || version === 1) {
    if (version === 7) out.timestamp = new Date(parseInt(c.slice(0, 12), 16));
    if (version === 1 || version === 6) {
      const th = version === 1 ? c.slice(13, 16) + c.slice(8, 12) + c.slice(0, 8) : c.slice(0, 12) + c.slice(13, 16);
      const ticks = BigInt('0x' + th); // 100-ns since 1582-10-15
      out.timestamp = new Date(Number((ticks - 122192928000000000n) / 10000n));
    }
  }
  out.versionName = { 1: 'time-based (MAC)', 2: 'DCE security', 3: 'name-based (MD5)', 4: 'random', 5: 'name-based (SHA-1)', 6: 'reordered time', 7: 'Unix time-ordered', 8: 'custom' }[version] || 'unknown';
  return out;
}

/** Generate n UUIDs (1..10000) of the given version. */
export function generate(version, n) {
  const count = Math.max(1, Math.min(10000, Math.floor(Number(n) || 1)));
  const gen = version === 7 || version === '7' ? () => uuidv7() : uuidv4;
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = gen();
  return out;
}
