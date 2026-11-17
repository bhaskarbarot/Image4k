import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomLocalPart, cleanLocalPart, mailDomains, MAIL_LIMITS } from '../../server/mail-core.js';

test('randomLocalPart is a safe, readable local-part', () => {
  for (let i = 0; i < 200; i++) {
    const lp = randomLocalPart();
    assert.match(lp, /^[a-z]+[0-9]{4}$/);
    assert.ok(lp.length <= MAIL_LIMITS.localPartMax);
    assert.equal(cleanLocalPart(lp), lp, 'random parts must pass validation');
  }
});

test('cleanLocalPart accepts valid names and rejects bad ones', () => {
  for (const ok of ['bob', 'a1', 'my.name', 'test_user', 'foo-bar', 'x9y8z7']) assert.equal(cleanLocalPart(ok), ok, ok);
  assert.equal(cleanLocalPart('UPPER'), 'upper'); // normalised
  for (const bad of ['', 'a', '.bob', 'bob.', '-x', 'x-', 'a..b', 'a@b', 'a b', 'has!bang', 'x'.repeat(31), 'a_'.repeat(20)]) {
    assert.equal(cleanLocalPart(bad), null, JSON.stringify(bad));
  }
});

test('mailDomains parses the MAIL_DOMAIN env var', () => {
  assert.deepEqual(mailDomains({ MAIL_DOMAIN: 'mail.image4k.org' }), ['mail.image4k.org']);
  assert.deepEqual(mailDomains({ MAIL_DOMAIN: 'A.com, b.io ,' }), ['a.com', 'b.io']);
  assert.deepEqual(mailDomains({}), []);
  assert.deepEqual(mailDomains(undefined), []);
});

// storeIncoming + the read path are exercised end-to-end against a real D1 in tests/e2e/mail.e2e.mjs.
