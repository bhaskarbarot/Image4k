import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmail, extractOtp, htmlToText, decodeEncodedWords } from '../../server/mime.js';

const b64 = (s) => Buffer.from(s).toString('base64');
const CRLF = '\r\n';

function multipart({ subject = 'Hi', from = 'A <a@b.com>', text, html, textEnc = '7bit', htmlEnc = 'base64' } = {}) {
  const bnd = 'BOUND42';
  const parts = [];
  if (text != null) parts.push([`Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: ${textEnc}`, '', textEnc === 'base64' ? b64(text) : text].join(CRLF));
  if (html != null) parts.push([`Content-Type: text/html; charset=utf-8`, `Content-Transfer-Encoding: ${htmlEnc}`, '', htmlEnc === 'base64' ? b64(html) : html].join(CRLF));
  return [
    `From: ${from}`, `To: user@mail.image4k.org`, `Subject: ${subject}`,
    `Date: Mon, 17 Nov 2026 10:00:00 +0000`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${bnd}"`, '', '',
    `--${bnd}`, parts.join(`${CRLF}--${bnd}${CRLF}`), `--${bnd}--`, '',
  ].join(CRLF);
}

test('parses from/name, to, subject and both bodies', () => {
  const raw = multipart({ from: 'GitHub <noreply@github.com>', subject: 'Verify', text: 'Your code is 123456', html: '<p>Your code is <b>123456</b></p>' });
  const p = parseEmail(raw);
  assert.equal(p.from, 'noreply@github.com');
  assert.equal(p.fromName, 'GitHub');
  assert.equal(p.to, 'user@mail.image4k.org');
  assert.equal(p.subject, 'Verify');
  assert.match(p.text, /123456/);
  assert.match(p.html, /<b>123456<\/b>/);
  assert.equal(typeof p.date, 'number');
});

test('RFC 2047 encoded-word subjects (B and Q), with emoji and adjacency', () => {
  assert.equal(decodeEncodedWords('=?UTF-8?B?' + b64('Résumé 🔐') + '?='), 'Résumé 🔐');
  assert.equal(decodeEncodedWords('=?utf-8?Q?Hello_World_=E2=9C=93?='), 'Hello World ✓');
  assert.equal(decodeEncodedWords('=?UTF-8?B?' + b64('part one ') + '?= =?UTF-8?B?' + b64('part two') + '?='), 'part one part two');
  const p = parseEmail(multipart({ subject: '=?UTF-8?B?' + b64('Код: 5566') + '?=', text: 'x' }));
  assert.equal(p.subject, 'Код: 5566');
});

test('quoted-printable decoding incl. soft line breaks and UTF-8', () => {
  const p = parseEmail(multipart({ text: 'Caf=C3=A9 code 24=\r\n68 ok', textEnc: 'quoted-printable', html: null }));
  assert.match(p.text, /Café code 2468 ok/);
});

test('single-part text/plain (no multipart)', () => {
  const raw = ['From: s@x.io', 'Subject: Plain', '', 'Just text 998877', ''].join(CRLF);
  const p = parseEmail(raw);
  assert.equal(p.subject, 'Plain');
  assert.equal(p.text, 'Just text 998877');
  assert.equal(p.html, '');
});

test('nested multipart/mixed with an attachment records metadata only', () => {
  const inner = 'INNER'; const outer = 'OUTER';
  const raw = [
    'From: s@x.io', 'To: u@mail.image4k.org', 'Subject: Doc',
    `Content-Type: multipart/mixed; boundary="${outer}"`, '', '',
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`, '', '',
    `--${inner}`, 'Content-Type: text/plain', '', 'See attached. PIN 4455', `--${inner}--`, '',
    `--${outer}`,
    'Content-Type: application/pdf; name="invoice.pdf"', 'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64', '', b64('%PDF-1.4 fake'), `--${outer}--`, '',
  ].join(CRLF);
  const p = parseEmail(raw);
  assert.match(p.text, /PIN 4455/);
  assert.equal(p.attachments.length, 1);
  assert.equal(p.attachments[0].filename, 'invoice.pdf');
  assert.equal(p.attachments[0].contentType, 'application/pdf');
});

test('htmlToText strips tags, decodes entities, keeps line breaks', () => {
  const t = htmlToText('<style>x{}</style><h1>Hi&amp;Bye</h1><p>Line&nbsp;1</p><p>Line 2 &#128273;</p><script>bad()</script>');
  assert.doesNotMatch(t, /</);
  assert.doesNotMatch(t, /bad\(\)/);
  assert.match(t, /Hi&Bye/);
  assert.match(t, /Line 1/);
  assert.match(t, /Line 2 🔑/);
});

// ---- OTP extraction across many real-world shapes ----
const OTP = [
  ['Your verification code is 482913. It expires in 10 minutes.', '482913'],
  ['Enter this code to sign in: 739 204', '739204'],
  ['G-558812 is your Google verification code.', '558812'],
  ['Your one-time password (OTP) is 9087', '9087'],
  ['Use PIN 4455 to confirm your identity', '4455'],
  ['Your activation code is A1B2C9.', 'A1B2C9'],
  ['Twój kod weryfikacyjny to 112233', '112233'],
  ['<p>Your login code</p><h2>662200</h2>', '662200', true],
];
for (const [body, expected, isHtml] of OTP) {
  test(`OTP: ${JSON.stringify(body).slice(0, 48)} → ${expected}`, () => {
    assert.equal(extractOtp(isHtml ? '' : body, isHtml ? body : ''), expected);
  });
}
test('OTP: ignores years and unrelated numbers', () => {
  assert.equal(extractOtp('© 2026 Acme. Order 12 shipped. Visit example.com', ''), null);
  assert.equal(extractOtp('Welcome! Your account was created in 2026.', ''), null);
});
test('OTP: 6-digit number without keyword is still accepted (common case)', () => {
  assert.equal(extractOtp('Hi there,\n\n884417\n\nThanks', ''), '884417');
});
test('huge input is handled without throwing', () => {
  const big = 'x '.repeat(500000) + ' code 123456';
  assert.equal(extractOtp(big, ''), '123456');
});
test('malformed / empty input never throws', () => {
  for (const v of ['', '\r\n\r\n', 'From:', '====', '\x00\x01binary']) {
    const p = parseEmail(v); assert.equal(typeof p.subject, 'string');
  }
});
