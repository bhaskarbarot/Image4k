import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashText, hashBytes, hashBlob, digestToString, normalizeChecksum, algForLength, ALGORITHMS } from '../../assets/dev/lib/hash.js';

const hex = (d) => digestToString(d);
// Known vectors (RFC 1321, FIPS 180-4 examples)
const V = {
  '': { MD5: 'd41d8cd98f00b204e9800998ecf8427e', 'SHA-1': 'da39a3ee5e6b4b0d3255bfef95601890afd80709', 'SHA-256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'SHA-512': 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e' },
  abc: { MD5: '900150983cd24fb0d6963f7d28e17f72', 'SHA-1': 'a9993e364706816aba3e25717850c26c9cd0d89d', 'SHA-256': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'SHA-512': 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f' },
  'The quick brown fox jumps over the lazy dog': { MD5: '9e107d9d372bb6826bd81d3542a419d6' },
};
for (const [input, algs] of Object.entries(V)) {
  for (const [alg, want] of Object.entries(algs)) {
    test(`${alg}("${input.slice(0, 12)}") known vector`, async () => { assert.equal(hex(await hashText(alg, input)), want); });
  }
}
test('unicode text hashes as UTF-8 (matches node:crypto)', async () => {
  const s = 'Zoë 🚀 日本語';
  for (const [alg, n] of [['MD5', 'md5'], ['SHA-1', 'sha1'], ['SHA-256', 'sha256'], ['SHA-512', 'sha512']]) {
    assert.equal(hex(await hashText(alg, s)), createHash(n).update(s, 'utf8').digest('hex'));
  }
});
test('hashBlob: one pass, all algorithms, progress reported', async () => {
  const data = crypto.getRandomValues(new Uint8Array(65536));
  const big = new Uint8Array(9 * 1024 * 1024); for (let i = 0; i < big.length; i += data.length) big.set(data, i);
  const progress = [];
  const r = await hashBlob(new Blob([big]), ALGORITHMS, { onProgress: (p) => progress.push(p) });
  assert.equal(hex(r.MD5), createHash('md5').update(big).digest('hex'));
  assert.equal(hex(r['SHA-256']), createHash('sha256').update(big).digest('hex'));
  assert.equal(hex(r['SHA-512']), createHash('sha512').update(big).digest('hex'));
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.length >= 3);
});
test('hashBlob of empty blob', async () => {
  const r = await hashBlob(new Blob([]), ['SHA-256', 'MD5']);
  assert.equal(hex(r['SHA-256']), V['']['SHA-256']);
  assert.equal(hex(r.MD5), V[''].MD5);
});
test('hashBlob can be cancelled', async () => {
  const ac = new AbortController(); ac.abort();
  await assert.rejects(hashBlob(new Blob([new Uint8Array(10)]), ['MD5'], { signal: ac.signal }), /Cancelled/);
});
test('output formats and checksum normalisation', async () => {
  const d = await hashBytes('SHA-256', new TextEncoder().encode('abc'));
  assert.equal(digestToString(d, 'HEX'), V.abc['SHA-256'].toUpperCase());
  assert.equal(digestToString(d, 'base64'), Buffer.from(V.abc['SHA-256'], 'hex').toString('base64'));
  assert.equal(normalizeChecksum(V.abc['SHA-256'].toUpperCase() + '  file.txt'), V.abc['SHA-256']);
  assert.equal(normalizeChecksum(Buffer.from(V.abc['SHA-256'], 'hex').toString('base64')), V.abc['SHA-256']);
  assert.equal(algForLength(64), 'SHA-256');
  assert.equal(algForLength(10), null);
});
test('unsupported algorithm rejects', async () => { await assert.rejects(hashText('SHA-3', 'x'), /Unsupported/); });
