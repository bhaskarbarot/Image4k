import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../email-worker/src/worker.js';

// Minimal in-memory D1 shim: enough for storeIncoming()'s prepare().bind().run()/first().
function fakeD1(inboxRow) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = { sql, args: [] };
      stmt.bind = (...a) => { stmt.args = a; return stmt; };
      stmt.run = async () => { calls.push(sql.trim().split(/\s+/).slice(0, 2).join(' ')); return { meta: { last_row_id: 7 } }; };
      stmt.first = async () => (/FROM mail_inboxes WHERE address/.test(sql) ? inboxRow : null);
      stmt.all = async () => ({ results: [] });
      return stmt;
    },
  };
}
function mockMessage(to, raw) {
  const bytes = new TextEncoder().encode(raw);
  return {
    to,
    rejected: null,
    setReject(r) { this.rejected = r; },
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
  };
}

test('email worker stores a message for a known inbox', async () => {
  const now = Date.now();
  const d1 = fakeD1({ id: 'abc', created_at: now - 1000, last_activity: now - 1000 });
  const msg = mockMessage('cooltiger1234@mail.test', 'From: a@b.com\r\nSubject: Hi\r\n\r\nYour code is 445566\r\n');
  await worker.email(msg, { MAIL_DB: d1 }, {});
  assert.ok(d1.calls.some((c) => /INSERT INTO/i.test(c)), 'should insert a message');
  assert.equal(msg.rejected, null, 'known inbox is not rejected');
});

test('email worker rejects mail for an unknown inbox (no black hole)', async () => {
  const d1 = fakeD1(null); // no inbox matches
  const msg = mockMessage('nobody@mail.test', 'From: a@b.com\r\n\r\nhi\r\n');
  await worker.email(msg, { MAIL_DB: d1 }, {});
  assert.match(msg.rejected || '', /No such mailbox/);
});

test('email worker never throws, even with no storage bound', async () => {
  const msg = mockMessage('x@mail.test', 'hi');
  await assert.doesNotReject(worker.email(msg, {}, {}));
});
