/* Cloudflare Email Worker — the REAL inbound-mail receiver for temp-mail.
 * Cloudflare Email Routing delivers mail for the temp-mail domain here (catch-all). We read the raw
 * RFC822 message and store it in the SAME D1 database the website's Pages Functions read from, so the
 * browser can poll it. Unknown / expired recipients are dropped silently.
 *
 * Deploy: see docs/DEPLOYMENT.md. Bind the same D1 database as MAIL_DB (wrangler.toml). */
import { storeIncoming, MAIL_LIMITS } from '../../server/mail-core.js';

async function streamToBytes(stream, max) {
  const reader = stream.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size <= max) chunks.push(value);
    else { try { await reader.cancel(); } catch (e) { /* ignore */ } break; }
  }
  const out = new Uint8Array(Math.min(size, max)); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

export default {
  async email(message, env, ctx) {
    try {
      const to = (message.to || '').toLowerCase();
      const raw = await streamToBytes(message.raw, MAIL_LIMITS.maxRawBytes + 1024);
      const res = await storeIncoming(env, to, raw);
      // If there is no such inbox, reject so the sender's server doesn't keep retrying a black hole.
      if (!res.stored && (res.reason === 'no_inbox' || res.reason === 'expired' || res.reason === 'bad_address')) {
        try { message.setReject('550 5.1.1 No such mailbox'); } catch (e) { /* some runtimes lack setReject */ }
      }
    } catch (e) {
      // Never throw out of the email handler; a failure here must not bounce unrelated mail.
    }
  },
};
