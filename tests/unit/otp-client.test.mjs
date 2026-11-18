import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOtp, htmlToText } from '../../assets/mail/otp.js';

// The client extractor must match the server one (server/mime.js) on the real-provider shapes.
const CASES = [
  ['Your verification code is 482913. It expires soon.', '', '482913'],
  ['Enter this code to sign in: 739 204', '', '739204'],
  ['G-558812 is your Google verification code.', '', '558812'],
  ['Use PIN 4455 to confirm', '', '4455'],
  ['Your activation code is A1B2C9.', '', 'A1B2C9'],
  ['', '<p>Your login code</p><h2>662200</h2>', '662200'],
  ['Hi,\n\n884417\n\nThanks', '', '884417'],
  ['© 2026 Acme. Order 12 shipped.', '', null],
];
for (const [text, html, expect] of CASES) {
  test(`otp: ${JSON.stringify((text || html).slice(0, 40))} → ${expect}`, () => {
    assert.equal(extractOtp(text, html), expect);
  });
}
test('htmlToText strips tags and decodes entities', () => {
  assert.match(htmlToText('<b>Hi&amp;Bye</b><br>line2'), /Hi&Bye/);
  assert.doesNotMatch(htmlToText('<script>x()</script>hi'), /x\(\)/);
});
