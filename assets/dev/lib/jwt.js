/* JSON Web Tokens (RFC 7519 / JWS RFC 7515) — decode, sign and verify using ONLY the platform's Web Crypto.
 * No custom cryptography. Pure module (works in browsers, workers and node ≥ 20). */
import { utf8Encode, utf8Decode, bytesToBase64, base64ToBytes } from './encode.js';

export class JwtError extends Error {
  constructor(message, part) { super(message); this.name = 'JwtError'; this.part = part; }
}

/* ---------- base64url ---------- */
export const b64url = (bytes) => bytesToBase64(bytes, { urlSafe: true, pad: false });
export function b64urlToBytes(seg, partName) {
  const bad = /[^A-Za-z0-9\-_=]/.exec(seg);
  if (bad) throw new JwtError(`${partName} contains '${bad[0]}' at position ${bad.index + 1}, which is not valid base64url`, partName);
  try { return base64ToBytes(seg).bytes; } catch (e) { throw new JwtError(`${partName} is not valid base64url: ${e.reason || e.message}`, partName); }
}
export const b64urlJson = (obj) => b64url(utf8Encode(JSON.stringify(obj)));

/* ---------- algorithms ---------- */
const HASH = { 256: 'SHA-256', 384: 'SHA-384', 512: 'SHA-512' };
const CURVE = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' };
const EC_SIG_LEN = { ES256: 64, ES384: 96, ES512: 132 };
export const ALGS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];

export function algParams(alg) {
  const m = /^(HS|RS|PS|ES)(256|384|512)$/.exec(alg || '');
  if (!m) throw new JwtError(alg === 'none' ? 'alg "none" means the token is unsigned — there is nothing to verify' : `Unsupported algorithm "${alg}"`);
  const hash = HASH[m[2]];
  switch (m[1]) {
    case 'HS': return { kind: 'hmac', import: { name: 'HMAC', hash }, sign: { name: 'HMAC' } };
    case 'RS': return { kind: 'rsa', import: { name: 'RSASSA-PKCS1-v1_5', hash }, sign: { name: 'RSASSA-PKCS1-v1_5' } };
    case 'PS': return { kind: 'rsa', import: { name: 'RSA-PSS', hash }, sign: { name: 'RSA-PSS', saltLength: Number(m[2]) / 8 } };
    case 'ES': return { kind: 'ec', import: { name: 'ECDSA', namedCurve: CURVE[alg] }, sign: { name: 'ECDSA', hash } };
  }
}

/* ---------- decode ---------- */
/** decodeJwt(token) → { header, payload, signature, segments:[h,p,s], signingInput, alg } ; throws JwtError */
export function decodeJwt(token) {
  let t = String(token || '').trim().replace(/^Bearer\s+/i, '');
  if (!t) throw new JwtError('Paste a token first.');
  const segs = t.split('.');
  if (segs.length === 5) throw new JwtError('This looks like an encrypted JWE token (5 parts). Its payload cannot be read without the decryption key.');
  if (segs.length !== 3) throw new JwtError(`A JWT has 3 parts separated by dots (header.payload.signature) — this has ${segs.length}.`);
  const [hs, ps, ss] = segs;
  if (!hs) throw new JwtError('The header part is empty.', 'header');
  if (!ps) throw new JwtError('The payload part is empty.', 'payload');
  const parseJsonPart = (seg, name) => {
    const bytes = b64urlToBytes(seg, name);
    let text;
    try { text = utf8Decode(bytes, { fatal: true }); } catch (e) { throw new JwtError(`The ${name} is not UTF-8 text.`, name); }
    try { return JSON.parse(text); } catch (e) { throw new JwtError(`The ${name} is not valid JSON: ${e.message}`, name); }
  };
  const header = parseJsonPart(hs, 'header');
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new JwtError('The header must be a JSON object.', 'header');
  const payload = parseJsonPart(ps, 'payload');
  const signature = ss ? b64urlToBytes(ss, 'signature') : new Uint8Array(0);
  return { header, payload, signature, segments: segs, signingInput: hs + '.' + ps, alg: header.alg };
}

/* ---------- claims ---------- */
export const CLAIM_INFO = {
  iss: 'Issuer — who created and signed the token', sub: 'Subject — whom the token refers to (usually a user id)',
  aud: 'Audience — who the token is intended for', exp: 'Expiration time', nbf: 'Not before — token is invalid before this time',
  iat: 'Issued at', jti: 'JWT ID — unique identifier (prevents replay)', name: 'Full name', email: 'Email address',
  email_verified: 'Email has been verified', scope: 'Granted OAuth scopes', scp: 'Granted scopes', azp: 'Authorized party (client id)',
  nonce: 'Nonce (binds an ID token to a client session)', auth_time: 'Time the user authenticated', sid: 'Session id',
  roles: 'Roles', groups: 'Groups', client_id: 'OAuth client id', amr: 'Authentication methods used', acr: 'Authentication context class',
  preferred_username: 'Preferred username', given_name: 'Given name', family_name: 'Family name', picture: 'Profile picture URL', locale: 'Locale',
  alg: 'Signing algorithm', typ: 'Token type', kid: 'Key id — which key signed the token', cty: 'Content type', jku: 'JWK Set URL', x5t: 'X.509 thumbprint', x5u: 'X.509 URL', jwk: 'Embedded public key',
};
const TIME_CLAIMS = ['exp', 'nbf', 'iat', 'auth_time', 'updated_at'];

export function relativeTime(diffMs) {
  const abs = Math.abs(diffMs);
  const units = [['year', 365 * 864e5], ['day', 864e5], ['h', 36e5], ['min', 6e4], ['s', 1e3]];
  const parts = [];
  let rest = abs;
  for (const [u, ms] of units) {
    const n = Math.floor(rest / ms);
    if (n || (u === 's' && !parts.length)) { parts.push(n + ' ' + u + ((u === 'year' || u === 'day') && n !== 1 ? 's' : '')); rest -= n * ms; }
    if (parts.length === 2) break;
  }
  const s = parts.join(' ');
  return diffMs >= 0 ? 'in ' + s : s + ' ago';
}

/** Validity summary: { expired, notYetValid, issuedInFuture, times:{claim:{date, relative}} , warnings:[] } */
export function claimStatus(payload, now = Date.now()) {
  const out = { expired: false, notYetValid: false, issuedInFuture: false, times: {}, warnings: [] };
  if (!payload || typeof payload !== 'object') return out;
  for (const c of TIME_CLAIMS) {
    if (!(c in payload)) continue;
    const v = payload[c];
    if (typeof v !== 'number' || !Number.isFinite(v)) { out.warnings.push(`"${c}" should be a NumericDate (seconds since 1970), got ${JSON.stringify(v)}`); continue; }
    const ms = v > 1e12 ? v : v * 1000; // tolerate millisecond timestamps
    if (v > 1e12) out.warnings.push(`"${c}" looks like milliseconds; JWT NumericDate must be in seconds`);
    out.times[c] = { date: new Date(ms), relative: relativeTime(ms - now) };
    if (c === 'exp' && now >= ms) out.expired = true;
    if (c === 'nbf' && now < ms) out.notYetValid = true;
    if (c === 'iat' && ms > now + 60000) out.issuedInFuture = true;
  }
  if (!('exp' in payload) && typeof payload === 'object') out.warnings.push('No "exp" claim — this token never expires.');
  return out;
}

/* ---------- keys ---------- */
function derLen(n) {
  if (n < 128) return [n];
  const b = []; while (n) { b.unshift(n & 255); n >>= 8; }
  return [0x80 | b.length, ...b];
}
const der = (tag, bytes) => new Uint8Array([tag, ...derLen(bytes.length), ...bytes]);
const RSA_ALG_ID = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
const EC_OID = new Uint8Array([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const CURVE_OID = {
  'P-256': [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07],
  'P-384': [0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22],
  'P-521': [0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23],
};

/** Parse PEM → { type: 'spki'|'pkcs8', der } (PKCS#1 RSA and SEC1 EC keys are wrapped automatically). */
export function parsePem(pem, curve) {
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (!m) throw new JwtError('Not a PEM key — expected "-----BEGIN … KEY-----" … "-----END … KEY-----".');
  const label = m[1];
  const body = base64ToBytes(m[2].replace(/[^A-Za-z0-9+/=]/g, '')).bytes;
  switch (label) {
    case 'PUBLIC KEY': return { type: 'spki', der: body };
    case 'PRIVATE KEY': return { type: 'pkcs8', der: body };
    case 'RSA PUBLIC KEY': return { type: 'spki', der: der(0x30, [...RSA_ALG_ID, ...der(0x03, [0, ...body])]) };
    case 'RSA PRIVATE KEY': return { type: 'pkcs8', der: der(0x30, [0x02, 0x01, 0x00, ...RSA_ALG_ID, ...der(0x04, body)]) };
    case 'EC PRIVATE KEY': {
      if (!curve) throw new JwtError('EC PRIVATE KEY needs an ES algorithm to know the curve.');
      return { type: 'pkcs8', der: der(0x30, [0x02, 0x01, 0x00, ...der(0x30, [...EC_OID, ...CURVE_OID[curve]]), ...der(0x04, body)]) };
    }
    case 'CERTIFICATE': throw new JwtError('This is an X.509 certificate. Paste its public key ("-----BEGIN PUBLIC KEY-----"), e.g. from: openssl x509 -pubkey -noout -in cert.pem');
    case 'ENCRYPTED PRIVATE KEY': throw new JwtError('Encrypted private keys are not supported — decrypt it first (openssl pkcs8 -topk8 -nocrypt).');
    default: throw new JwtError(`Unsupported PEM type "${label}".`);
  }
}

export function toPem(derBytes, label) {
  const b64 = bytesToBase64(derBytes).replace(/(.{64})(?=.)/g, '$1\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** secretBytes(secret, encoding 'utf8'|'base64'|'hex') */
export function secretBytes(secret, encoding = 'utf8') {
  if (encoding === 'base64') return base64ToBytes(secret).bytes;
  if (encoding === 'hex') {
    const s = String(secret).replace(/\s/g, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new JwtError('Secret is not valid hex.');
    return new Uint8Array(s.match(/../g)?.map((x) => parseInt(x, 16)) || []);
  }
  return utf8Encode(secret);
}

/**
 * importKey(alg, material, usage 'sign'|'verify', {encoding, kid})
 * material: HMAC secret string | PEM string | JWK object/JSON string (or JWKS {keys:[…]}) | CryptoKey
 */
export async function importKey(alg, material, usage, opts = {}) {
  const p = algParams(alg);
  if (material && typeof material === 'object' && material.type && material.algorithm) return material; // CryptoKey
  if (p.kind === 'hmac' && typeof material === 'string' && !material.trim().startsWith('{')) {
    const bytes = secretBytes(material, opts.encoding);
    if (!bytes.length) throw new JwtError('The secret is empty.');
    return crypto.subtle.importKey('raw', bytes, p.import, false, [usage]);
  }
  let jwk = material;
  if (typeof material === 'string') {
    const s = material.trim();
    if (s.startsWith('-----')) {
      if (p.kind === 'hmac') throw new JwtError('HS algorithms use a shared secret, not a PEM key.');
      const { type, der: d } = parsePem(s, CURVE[alg]);
      if (usage === 'sign' && type !== 'pkcs8') throw new JwtError('Signing needs a PRIVATE key.');
      if (usage === 'verify' && type === 'pkcs8') throw new JwtError('Paste the PUBLIC key to verify (a private key cannot be used for verification here).');
      try { return await crypto.subtle.importKey(type, d, p.import, false, [usage]); } catch (e) {
        throw new JwtError(`The key does not match ${alg}: ${e.message}`);
      }
    }
    try { jwk = JSON.parse(s); } catch (e) { throw new JwtError(p.kind === 'hmac' ? 'Invalid key' : 'Key must be a PEM block or a JWK (JSON).'); }
  }
  if (jwk && Array.isArray(jwk.keys)) {
    const found = (opts.kid && jwk.keys.find((k) => k.kid === opts.kid)) || jwk.keys.find((k) => !k.alg || k.alg === alg);
    if (!found) throw new JwtError('No matching key in the JWK Set' + (opts.kid ? ` for kid "${opts.kid}"` : ''));
    jwk = found;
  }
  if (!jwk || typeof jwk !== 'object' || !jwk.kty) throw new JwtError('JWK must be an object with a "kty" field.');
  const k = { ...jwk };
  delete k.key_ops; delete k.use;
  if (k.alg && k.alg !== alg) throw new JwtError(`The JWK is for ${k.alg}, but the token uses ${alg}.`);
  if (usage === 'verify') for (const f of ['d', 'p', 'q', 'dp', 'dq', 'qi']) delete k[f];
  else if (p.kind !== 'hmac' && !k.d) throw new JwtError('Signing needs a private JWK (with "d").');
  try { return await crypto.subtle.importKey('jwk', k, p.import, false, [usage]); } catch (e) {
    throw new JwtError(`The JWK does not match ${alg}: ${e.message}`);
  }
}

/* ---------- sign / verify ---------- */
export async function signJwt(header, payload, key, opts = {}) {
  const alg = header.alg;
  const p = algParams(alg);
  const h = { ...header };
  const signingInput = b64urlJson(h) + '.' + (typeof payload === 'string' ? b64url(utf8Encode(payload)) : b64urlJson(payload));
  const k = await importKey(alg, key, 'sign', opts);
  const sig = new Uint8Array(await crypto.subtle.sign(p.sign, k, utf8Encode(signingInput)));
  return signingInput + '.' + b64url(sig);
}

/** verifyJwt(token, key, {encoding, alg}) → { valid, alg, reason? } — never throws for a bad signature. */
export async function verifyJwt(token, key, opts = {}) {
  const d = decodeJwt(token);
  const alg = opts.alg || d.alg;
  if (alg === 'none') return { valid: false, alg, reason: 'alg "none" — the token is unsigned.' };
  const p = algParams(alg);
  if (p.kind === 'ec' && d.signature.length !== EC_SIG_LEN[alg]) {
    return { valid: false, alg, reason: d.signature[0] === 0x30 ? 'Signature is DER-encoded; JWS requires raw r||s.' : `Wrong signature length for ${alg} (${d.signature.length} bytes, expected ${EC_SIG_LEN[alg]}).` };
  }
  const k = await importKey(alg, key, 'verify', { ...opts, kid: d.header.kid });
  const valid = await crypto.subtle.verify(p.sign, k, d.signature, utf8Encode(d.signingInput));
  return { valid, alg, reason: valid ? null : 'The signature does not match this key / secret.' };
}

/** Generate a fresh key for alg. HS → random secret (base64url); RS/PS/ES → PEM + JWK pair. */
export async function generateKey(alg) {
  const p = algParams(alg);
  if (p.kind === 'hmac') {
    const len = { HS256: 32, HS384: 48, HS512: 64 }[alg];
    return { secret: b64url(crypto.getRandomValues(new Uint8Array(len))), encoding: 'base64' };
  }
  const params = p.kind === 'rsa' ? { ...p.import, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) } : p.import;
  const pair = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);
  const [pk8, spki, privateJwk, publicJwk] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', pair.privateKey), crypto.subtle.exportKey('spki', pair.publicKey),
    crypto.subtle.exportKey('jwk', pair.privateKey), crypto.subtle.exportKey('jwk', pair.publicKey),
  ]);
  for (const j of [privateJwk, publicJwk]) { j.alg = alg; delete j.key_ops; delete j.ext; }
  return { privatePem: toPem(new Uint8Array(pk8), 'PRIVATE KEY'), publicPem: toPem(new Uint8Array(spki), 'PUBLIC KEY'), privateJwk, publicJwk };
}
