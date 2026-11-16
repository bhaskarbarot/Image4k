import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToBase64, base64ToBytes, base64EncodeText, base64DecodeText, utf8Encode, utf8Decode, isProbablyText, sniffType,
  urlEncode, urlDecode, bytesToHex, hexToBytes, bytesToBinary, binaryToBytes, htmlEncode, htmlDecode,
} from '../../assets/dev/lib/encode.js';

// RFC 4648 §10 test vectors
const RFC = [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']];
for (const [plain, b64] of RFC) {
  test(`base64 RFC 4648 vector "${plain}"`, () => {
    assert.equal(base64EncodeText(plain), b64);
    assert.equal(base64DecodeText(b64), plain);
  });
}
test('base64 matches Buffer for random bytes of many lengths', () => {
  for (let n = 0; n < 300; n++) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    assert.equal(bytesToBase64(b), Buffer.from(b).toString('base64'));
    assert.equal(bytesToBase64(b, { urlSafe: true }), Buffer.from(b).toString('base64url'));
    assert.deepEqual(Buffer.from(base64ToBytes(Buffer.from(b).toString('base64')).bytes), Buffer.from(b));
    assert.deepEqual(Buffer.from(base64ToBytes(Buffer.from(b).toString('base64url')).bytes), Buffer.from(b));
  }
});
test('base64 handles UTF-8 (emoji, CJK, accents)', () => {
  const s = 'Zoë 🚀 日本語 ✓';
  assert.equal(base64EncodeText(s), Buffer.from(s).toString('base64'));
  assert.equal(base64DecodeText(Buffer.from(s).toString('base64')), s);
});
test('base64 wrap at 76', () => {
  const out = bytesToBase64(new Uint8Array(200), { wrap: 76 });
  assert.ok(out.split('\n').every((l) => l.length <= 76));
  assert.equal(out.split('\n')[0].length, 76);
});
test('base64 lenient decode: whitespace + missing padding are reported', () => {
  const r = base64ToBytes('Zm9v\nYmE');
  assert.equal(utf8Decode(r.bytes), 'fooba');
  assert.ok(r.notes.some((n) => /whitespace/i.test(n)));
  assert.ok(r.notes.some((n) => /padding/i.test(n)));
});
test('base64 data: URI prefix is stripped', () => {
  assert.equal(utf8Decode(base64ToBytes('data:text/plain;base64,aGk=').bytes), 'hi');
});
test('base64 invalid char reports exact position', () => {
  assert.throws(() => base64ToBytes('Zm9v*mFy'), (e) => e.pos === 4 && /Invalid Base64 character '\*'/.test(e.message));
});
test('base64 strict mode rejects whitespace and missing padding', () => {
  assert.throws(() => base64ToBytes('Zm9v Yg==', { strict: true }), /Whitespace/);
  assert.throws(() => base64ToBytes('Zm9vYg', { strict: true }), /Missing padding/);
});
test('base64 invalid length / mixed alphabets / data after padding', () => {
  assert.throws(() => base64ToBytes('Zm9vY'), /single leftover/);
  assert.throws(() => base64ToBytes('a+b-'), /Mixes/);
  assert.throws(() => base64ToBytes('Zg==Zg=='), /after '='/);
});
test('base64 large input (5 MB) round-trips', () => {
  const b = crypto.getRandomValues(new Uint8Array(65536));
  const big = new Uint8Array(5 * 1024 * 1024); for (let i = 0; i < big.length; i += 65536) big.set(b.subarray(0, Math.min(65536, big.length - i)), i);
  const enc = bytesToBase64(big);
  assert.equal(enc, Buffer.from(big).toString('base64'));
  assert.equal(base64ToBytes(enc).bytes.length, big.length);
});

test('isProbablyText / sniffType', () => {
  assert.equal(isProbablyText(utf8Encode('hello\nworld')), true);
  assert.equal(isProbablyText(new Uint8Array([0, 1, 2, 255])), false);
  assert.deepEqual(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), { mime: 'image/png', ext: 'png' });
  assert.equal(sniffType(utf8Encode('%PDF-1.7')).ext, 'pdf');
  assert.equal(sniffType(utf8Encode('{"a":1}')).ext, 'json');
  assert.equal(sniffType(utf8Encode('<svg xmlns="x"/>')).ext, 'svg');
  assert.equal(sniffType(new Uint8Array([0x9a, 0x01, 0x02])).ext, 'bin');
});

test('url encode modes', () => {
  assert.equal(urlEncode('a b&c=d/é?'), 'a%20b%26c%3Dd%2F%C3%A9%3F');
  assert.equal(urlEncode('https://x.com/a b?q=1&r=é', 'uri'), 'https://x.com/a%20b?q=1&r=%C3%A9');
  assert.equal(urlEncode("a b!'()*", 'form'), 'a+b%21%27%28%29%2A');
  assert.equal(urlEncode('🚀'), '%F0%9F%9A%80');
});
test('url encode: lone surrogate gives a clear error', () => {
  assert.throws(() => urlEncode('a\uD800b'), (e) => e.pos === 1);
});
test('url decode + malformed escape position', () => {
  assert.equal(urlDecode('a%20b%26c%3Dd%2F%C3%A9'), 'a b&c=d/é');
  assert.equal(urlDecode('a+b%2B', 'form'), 'a b+');
  assert.equal(urlDecode('a+b'), 'a+b');
  assert.throws(() => urlDecode('100%'), (e) => e.pos === 3 && /two hex digits/.test(e.message));
  assert.throws(() => urlDecode('ok%zz'), (e) => e.pos === 2);
  assert.throws(() => urlDecode('%C3%28'), /not valid UTF-8/);
});

test('hex encode/decode with separators and prefixes', () => {
  assert.equal(bytesToHex(utf8Encode('Hi')), '4869');
  assert.equal(bytesToHex(utf8Encode('Hi'), { sep: ':', upper: true }), '48:69');
  for (const s of ['4869', '48 69', '0x48,0x69', '48:69', '\\x48\\x69', '48-69']) assert.equal(utf8Decode(hexToBytes(s)), 'Hi', s);
  assert.throws(() => hexToBytes('486'), /Odd number/);
  assert.throws(() => hexToBytes('48g9'), (e) => e.pos === 2);
});
test('binary encode/decode', () => {
  assert.equal(bytesToBinary(utf8Encode('A')), '01000001');
  assert.equal(utf8Decode(binaryToBytes('01001000 01101001')), 'Hi');
  assert.throws(() => binaryToBytes('0100100'), /multiple of 8/);
  assert.throws(() => binaryToBytes('0100 2001'), /Invalid binary/);
});
test('html entities', () => {
  assert.equal(htmlEncode('<a href="x">Tom & Jerry\'s</a>'), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  assert.equal(htmlEncode('é🚀', { mode: 'nonascii' }), '&#233;&#128640;');
  assert.equal(htmlDecode('&lt;b&gt; &amp;amp; &copy; &#169; &#xA9; &eacute; &#128640; &unknown;'), '<b> &amp; © © © é 🚀 &unknown;');
  assert.equal(htmlDecode(htmlEncode('x<y>"z" & é', { mode: 'all' })), 'x<y>"z" & é');
  assert.equal(htmlDecode('&#0; &#xD800;'), '� �');
});
