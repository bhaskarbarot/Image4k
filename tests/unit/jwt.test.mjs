import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwt, signJwt, verifyJwt, generateKey, claimStatus, relativeTime, parsePem, importKey, ALGS, b64urlJson } from '../../assets/dev/lib/jwt.js';

// RFC 7515 Appendix A.1 (HS256)
const A1 = 'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const A1_KEY = { kty: 'oct', k: 'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow' };
// RFC 7515 Appendix A.3 (ES256)
const A3 = 'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q';
const A3_KEY = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };

test('decode RFC 7515 A.1 token', () => {
  const d = decodeJwt(A1);
  assert.deepEqual(d.header, { typ: 'JWT', alg: 'HS256' });
  assert.equal(d.payload.iss, 'joe');
  assert.equal(d.payload.exp, 1300819380);
  assert.equal(d.payload['http://example.com/is_root'], true);
  assert.equal(d.signature.length, 32);
});
test('verify RFC 7515 A.1 (HS256) with JWK and with base64url secret', async () => {
  assert.equal((await verifyJwt(A1, A1_KEY)).valid, true);
  assert.equal((await verifyJwt(A1, A1_KEY.k, { encoding: 'base64' })).valid, true);
  assert.equal((await verifyJwt(A1, 'wrong secret')).valid, false);
});
test('verify RFC 7515 A.3 (ES256) with public JWK', async () => {
  assert.equal((await verifyJwt(A3, A3_KEY)).valid, true);
  const tampered = A3.replace('.eyJ', '.eyK');
  assert.equal((await verifyJwt(tampered, A3_KEY).catch(() => ({ valid: false }))).valid, false);
});
test('Bearer prefix and whitespace are tolerated', () => { assert.equal(decodeJwt('  Bearer ' + A1 + '\n').payload.iss, 'joe'); });
test('malformed tokens give specific errors', () => {
  assert.throws(() => decodeJwt(''), /Paste a token/);
  assert.throws(() => decodeJwt('abc.def'), /3 parts/);
  assert.throws(() => decodeJwt('a.b.c.d.e'), /JWE/);
  assert.throws(() => decodeJwt('ab$c.eyJ9.x'), /header contains '\$' at position 3/);
  assert.throws(() => decodeJwt(b64urlJson({ alg: 'HS256' }) + '.bm90IGpzb24.sig'), /payload is not valid JSON/);
  assert.throws(() => decodeJwt('.eyJhIjoxfQ.'), /header part is empty/);
  assert.throws(() => decodeJwt('WzFd.eyJhIjoxfQ.'), /header must be a JSON object/);
});
test('unicode claims decode correctly', () => {
  const tok = b64urlJson({ alg: 'none' }) + '.' + b64urlJson({ name: 'Zoë 🚀 日本' }) + '.';
  assert.equal(decodeJwt(tok).payload.name, 'Zoë 🚀 日本');
});
test('claimStatus: expired, not yet valid, missing exp, ms timestamps', () => {
  const now = Date.UTC(2026, 0, 1);
  const s = claimStatus({ exp: now / 1000 - 3600, iat: now / 1000 - 7200 }, now);
  assert.equal(s.expired, true);
  assert.match(s.times.exp.relative, /1 h ago/);
  const s2 = claimStatus({ nbf: now / 1000 + 600, exp: now / 1000 + 86400 }, now);
  assert.equal(s2.notYetValid, true); assert.equal(s2.expired, false);
  assert.match(s2.times.exp.relative, /^in 1 day/);
  assert.ok(claimStatus({ sub: 'x' }, now).warnings.some((w) => /never expires/.test(w)));
  assert.ok(claimStatus({ exp: now + 1000 }, now).warnings.some((w) => /milliseconds/.test(w)));
  assert.ok(claimStatus({ exp: 'tomorrow' }, now).warnings.some((w) => /NumericDate/.test(w)));
});
test('relativeTime formatting', () => {
  assert.equal(relativeTime(3 * 3600e3 + 5 * 60e3), 'in 3 h 5 min');
  assert.equal(relativeTime(-2 * 864e5), '2 days ago');
  assert.equal(relativeTime(0), 'in 0 s');
});

for (const alg of ALGS) {
  test(`sign → verify round trip ${alg} (generated key)`, async () => {
    const k = await generateKey(alg);
    const header = { alg, typ: 'JWT' };
    const payload = { sub: '42', name: 'Zoë', iat: 1700000000 };
    if (alg.startsWith('HS')) {
      const tok = await signJwt(header, payload, k.secret, { encoding: 'base64' });
      assert.equal(decodeJwt(tok).payload.name, 'Zoë');
      assert.equal((await verifyJwt(tok, k.secret, { encoding: 'base64' })).valid, true);
      assert.equal((await verifyJwt(tok, k.secret + 'x', { encoding: 'utf8' })).valid, false);
    } else {
      const tok = await signJwt(header, payload, k.privatePem);
      assert.equal((await verifyJwt(tok, k.publicPem)).valid, true);
      assert.equal((await verifyJwt(tok, JSON.stringify(k.publicJwk))).valid, true);
      const tok2 = await signJwt(header, payload, JSON.stringify(k.privateJwk));
      assert.equal((await verifyJwt(tok2, k.publicPem)).valid, true);
      const other = await generateKey(alg);
      assert.equal((await verifyJwt(tok, other.publicPem)).valid, false);
      if (alg.startsWith('ES')) assert.equal(decodeJwt(tok).signature.length, { ES256: 64, ES384: 96, ES512: 132 }[alg]);
    }
  });
}
test('HMAC: empty secret rejected; alg none not verifiable; private key refused for verify', async () => {
  await assert.rejects(signJwt({ alg: 'HS256' }, {}, ''), /empty/);
  const none = b64urlJson({ alg: 'none' }) + '.' + b64urlJson({ a: 1 }) + '.';
  assert.equal((await verifyJwt(none, 'x')).valid, false);
  const k = await generateKey('RS256');
  const tok = await signJwt({ alg: 'RS256' }, { a: 1 }, k.privatePem);
  await assert.rejects(verifyJwt(tok, k.privatePem), /PUBLIC key/);
});
test('PEM parsing: PKCS#1 RSA keys are wrapped; certificates explained', async () => {
  assert.throws(() => parsePem('nope'), /Not a PEM/);
  assert.throws(() => parsePem('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'), /certificate/);
  // derive a PKCS#1 key from a generated SPKI by stripping the 24-byte RSA SPKI header
  const k = await generateKey('RS256');
  const spki = parsePem(k.publicPem).der;
  const pkcs1 = spki.subarray(24);
  const pem = '-----BEGIN RSA PUBLIC KEY-----\n' + Buffer.from(pkcs1).toString('base64') + '\n-----END RSA PUBLIC KEY-----';
  const key = await importKey('RS256', pem, 'verify');
  assert.equal(key.type, 'public');
});
test('JWKS: picks key by kid', async () => {
  const k = await generateKey('ES256');
  const tok = await signJwt({ alg: 'ES256', kid: 'b' }, { a: 1 }, k.privatePem);
  const jwks = JSON.stringify({ keys: [{ ...(await generateKey('ES256')).publicJwk, kid: 'a' }, { ...k.publicJwk, kid: 'b' }] });
  assert.equal((await verifyJwt(tok, jwks)).valid, true);
});
