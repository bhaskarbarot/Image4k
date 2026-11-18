/* Temp-mail backend: disposable inbox addresses that receive REAL e-mail, stored in Cloudflare D1.
 * Inbound mail arrives through a Cloudflare Email Worker (email-worker/) which calls storeIncoming();
 * the browser creates an inbox and polls it through the Pages Functions here.
 *
 * Inbox ids are 128-bit random; the read/delete token is 256-bit random and only its SHA-256 is stored,
 * so possession of the address alone never lets anyone read the inbox. Addresses expire automatically. */
import { json, fail, rateLimit, clientIp, sameOriginOnly, sha256Hex, randomToken, safeEqual } from './limits.js';
import { parseEmail, htmlToText, extractOtp } from './mime.js';

export const MAIL_LIMITS = {
  maxStoredPerInbox: 50,
  storedTextBytes: 128 * 1024,   // per text/html body kept
  maxRawBytes: 2 * 1024 * 1024,  // ignore e-mails larger than this
  createsPerHour: 40,
  inactivityMs: 60 * 60 * 1000,  // 1 h idle
  maxAgeMs: 24 * 60 * 60 * 1000, // 24 h absolute
  listLimit: 50,
  localPartMax: 30,
};

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mail_inboxes (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_mail_inboxes_addr ON mail_inboxes (address)',
  'CREATE INDEX IF NOT EXISTS idx_mail_inboxes_ip ON mail_inboxes (ip_hash, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_mail_inboxes_activity ON mail_inboxes (last_activity)',
  `CREATE TABLE IF NOT EXISTS mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    from_addr TEXT,
    from_name TEXT,
    subject TEXT,
    text_body TEXT,
    html_text TEXT,
    otp TEXT,
    attachments TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_mail_messages_inbox ON mail_messages (inbox_id, id)',
];

let schemaReady = null;
async function db(env) {
  const d = env && env.MAIL_DB;
  if (!d) return null;
  if (!schemaReady) schemaReady = (async () => { for (const s of SCHEMA) await d.prepare(s).run(); })().catch((e) => { schemaReady = null; throw e; });
  await schemaReady;
  return d;
}
export function _resetSchema() { schemaReady = null; }

/** The e-mail domain(s) the Email Worker accepts, from the MAIL_DOMAIN env var ("a.com" or "a.com,b.com"). */
export function mailDomains(env) {
  return String((env && env.MAIL_DOMAIN) || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
const notConfigured = () => fail(503, 'storage_not_configured', 'The temp-mail inbox is not switched on for this website yet. It needs a Cloudflare D1 database (MAIL_DB) and a verified e-mail domain (MAIL_DOMAIN). See docs/DEPLOYMENT.md.');

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const ADJ = ['cool', 'quick', 'calm', 'bold', 'brave', 'bright', 'swift', 'wise', 'lucky', 'happy', 'clever', 'quiet', 'sunny', 'jolly', 'mighty', 'noble', 'witty', 'zesty', 'fuzzy', 'snappy'];
const NOUN = ['tiger', 'otter', 'falcon', 'maple', 'comet', 'river', 'pixel', 'cedar', 'nova', 'raven', 'willow', 'ember', 'onyx', 'quartz', 'badger', 'lynx', 'heron', 'koala', 'panda', 'fox'];
const pick = (a) => a[crypto.getRandomValues(new Uint32Array(1))[0] % a.length];

/** Make a random, readable local-part, e.g. "cleverotter5821". */
export function randomLocalPart() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 9000 + 1000;
  return `${pick(ADJ)}${pick(NOUN)}${n}`;
}
/** Validate / normalise a user-chosen local-part. Returns a clean string or null. */
export function cleanLocalPart(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v.length < 2 || v.length > MAIL_LIMITS.localPartMax) return null;
  if (!/^[a-z0-9]([a-z0-9._-]{0,28}[a-z0-9])$/.test(v)) return null;
  if (/[._-]{2,}/.test(v)) return null;
  return v;
}
const expiresAt = (row) => Math.min(row.last_activity + MAIL_LIMITS.inactivityMs, row.created_at + MAIL_LIMITS.maxAgeMs);
const isExpired = (row, now) => expiresAt(row) <= now;

async function cleanup(d, now) {
  const cut = now - MAIL_LIMITS.inactivityMs, age = now - MAIL_LIMITS.maxAgeMs;
  await d.prepare('DELETE FROM mail_messages WHERE inbox_id IN (SELECT id FROM mail_inboxes WHERE last_activity < ?1 OR created_at < ?2)').bind(cut, age).run();
  await d.prepare('DELETE FROM mail_inboxes WHERE last_activity < ?1 OR created_at < ?2').bind(cut, age).run();
}

function publicLimits() {
  return { maxStored: MAIL_LIMITS.maxStoredPerInbox, inactivityMinutes: 60, maxAgeHours: 24 };
}

/** GET /api/mail/config — whether the feature is live, and on which domain(s). */
export async function getConfig(request, env) {
  const domains = mailDomains(env);
  const hasDb = !!(env && env.MAIL_DB);
  return json({ ok: true, configured: hasDb && domains.length > 0, hasStorage: hasDb, domains, limits: publicLimits() });
}

/** POST /api/mail/inboxes  { localPart?: string, domain?: string } */
export async function createInbox(request, env, now = Date.now()) {
  const bad = sameOriginOnly(request); if (bad) return bad;
  const domains = mailDomains(env);
  if (!env || !env.MAIL_DB || !domains.length) return notConfigured();
  const rl = rateLimit('mail-create:' + clientIp(request), { capacity: 12, windowMs: 60000 });
  if (!rl.ok) return fail(429, 'rate_limited', `Too many new addresses — wait ${rl.retryAfter} s.`, { 'Retry-After': String(rl.retryAfter) });
  const d = await db(env); if (!d) return notConfigured();
  await cleanup(d, now);
  const ipHash = await sha256Hex('mail-ip:' + clientIp(request));
  const recent = await d.prepare('SELECT COUNT(*) AS n FROM mail_inboxes WHERE ip_hash = ?1 AND created_at > ?2').bind(ipHash, now - 3600000).first();
  if (recent && recent.n >= MAIL_LIMITS.createsPerHour) return fail(429, 'rate_limited', `Limit reached: ${MAIL_LIMITS.createsPerHour} addresses per hour. Reuse one or try later.`);

  let body = {};
  try { if (request.headers.get('Content-Type')?.includes('json')) body = await request.json(); } catch (e) { /* optional */ }
  const domain = domains.includes(String(body.domain || '').toLowerCase()) ? String(body.domain).toLowerCase() : domains[0];
  let local = body.localPart ? cleanLocalPart(body.localPart) : null;
  if (body.localPart && !local) return fail(400, 'bad_local_part', 'Use 2–30 letters, digits, dot, dash or underscore (no leading/trailing or doubled punctuation).');

  const id = randomToken(16);
  const token = randomToken(32);
  for (let attempt = 0; attempt < 6; attempt++) {
    const localPart = local || randomLocalPart();
    const address = `${localPart}@${domain}`;
    try {
      await d.prepare('INSERT INTO mail_inboxes (id, address, token_hash, ip_hash, created_at, last_activity, message_count) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0)')
        .bind(id, address, await sha256Hex(token), ipHash, now).run();
      return json({ ok: true, id, token, address, createdAt: now, expiresAt: now + MAIL_LIMITS.inactivityMs, domains, limits: publicLimits() }, 201);
    } catch (e) {
      if (local) return fail(409, 'address_taken', 'That address is already in use — choose another.');
      // random collision: try again with a fresh local-part
    }
  }
  return fail(503, 'try_again', 'Could not allocate an address, please try again.');
}

async function authed(request, env, id, now) {
  const d = await db(env); if (!d) return { res: notConfigured() };
  if (!ID_RE.test(id || '')) return { res: fail(404, 'not_found', 'Unknown inbox.') };
  const row = await d.prepare('SELECT * FROM mail_inboxes WHERE id = ?1').bind(id).first();
  if (!row) return { res: fail(404, 'not_found', 'This inbox does not exist (it may have expired or been deleted).') };
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m || !safeEqual(await sha256Hex(m[1]), row.token_hash)) return { res: fail(401, 'unauthorized', 'A valid inbox token is required.') };
  if (isExpired(row, now)) return { res: fail(410, 'expired', 'This inbox has expired. Create a new address.') };
  return { d, row };
}

function msgSummary(r) {
  return { id: r.id, receivedAt: r.received_at, from: r.from_addr, fromName: r.from_name, subject: r.subject, otp: r.otp, hasHtml: !!(r.html_text && r.html_text.length), seen: !!r.seen, size: r.size, preview: (r.text_body || r.html_text || '').slice(0, 140) };
}

/** GET /api/mail/inboxes/:id/messages?after=N */
export async function listMessages(request, env, id, now = Date.now()) {
  const bad = sameOriginOnly(request); if (bad) return bad;
  const rl = rateLimit('mail-read:' + clientIp(request), { capacity: 150, windowMs: 60000, now });
  if (!rl.ok) return fail(429, 'rate_limited', `Polling too fast — wait ${rl.retryAfter} s.`, { 'Retry-After': String(rl.retryAfter) });
  const a = await authed(request, env, id, now); if (a.res) return a.res;
  const { d, row } = a;
  if (now - row.last_activity > 300000) { await d.prepare('UPDATE mail_inboxes SET last_activity = ?2 WHERE id = ?1').bind(id, now).run(); row.last_activity = now; }
  const after = Math.max(0, parseInt(new URL(request.url).searchParams.get('after') || '0', 10) || 0);
  const rs = await d.prepare('SELECT id, received_at, from_addr, from_name, subject, otp, html_text, text_body, size, seen FROM mail_messages WHERE inbox_id = ?1 AND id > ?2 ORDER BY id DESC LIMIT ?3')
    .bind(id, after, MAIL_LIMITS.listLimit).all();
  return json({ ok: true, inbox: { id, address: row.address, createdAt: row.created_at, expiresAt: expiresAt(row), messageCount: row.message_count }, messages: (rs.results || []).map(msgSummary), limits: publicLimits() });
}

/** GET /api/mail/inboxes/:id/messages/:mid — full message (marks it seen). */
export async function getMessage(request, env, id, mid, now = Date.now()) {
  const bad = sameOriginOnly(request); if (bad) return bad;
  const rl = rateLimit('mail-read:' + clientIp(request), { capacity: 150, windowMs: 60000, now });
  if (!rl.ok) return fail(429, 'rate_limited', `Too many requests — wait ${rl.retryAfter} s.`, { 'Retry-After': String(rl.retryAfter) });
  const a = await authed(request, env, id, now); if (a.res) return a.res;
  const { d } = a;
  const r = await d.prepare('SELECT * FROM mail_messages WHERE inbox_id = ?1 AND id = ?2').bind(id, parseInt(mid, 10) || -1).first();
  if (!r) return fail(404, 'not_found', 'Message not found.');
  await d.prepare('UPDATE mail_messages SET seen = 1 WHERE id = ?1').bind(r.id).run();
  return json({ ok: true, message: {
    id: r.id, receivedAt: r.received_at, from: r.from_addr, fromName: r.from_name, subject: r.subject,
    otp: r.otp, text: r.text_body || '', htmlText: r.html_text || '', attachments: safeParse(r.attachments), size: r.size, seen: true,
  } });
}
function safeParse(s) { try { return JSON.parse(s) || []; } catch (e) { return []; } }

/** DELETE /api/mail/inboxes/:id/messages/:mid */
export async function deleteMessage(request, env, id, mid, now = Date.now()) {
  const bad = sameOriginOnly(request); if (bad) return bad;
  const a = await authed(request, env, id, now); if (a.res) return a.res;
  await a.d.prepare('DELETE FROM mail_messages WHERE inbox_id = ?1 AND id = ?2').bind(id, parseInt(mid, 10) || -1).run();
  return json({ ok: true });
}

/** DELETE /api/mail/inboxes/:id — drop the whole inbox. */
export async function deleteInbox(request, env, id, now = Date.now()) {
  const bad = sameOriginOnly(request); if (bad) return bad;
  const a = await authed(request, env, id, now);
  if (a.res && a.res.status !== 410) return a.res;
  const d = a.d || (await db(env)); if (!d) return notConfigured();
  await d.prepare('DELETE FROM mail_messages WHERE inbox_id = ?1').bind(id).run();
  await d.prepare('DELETE FROM mail_inboxes WHERE id = ?1').bind(id).run();
  return json({ ok: true, deleted: id });
}

/**
 * Store one inbound e-mail. Called by the Email Worker (and by the test ingest route).
 * `rawBytes` is the full RFC822 message. Returns { stored: bool, reason? }.
 * Unknown / expired recipients are dropped silently (the sender should not learn whether an inbox exists).
 */
export async function storeIncoming(env, toAddress, rawBytes, now = Date.now()) {
  const d = await db(env);
  if (!d) return { stored: false, reason: 'no_storage' };
  const address = String(toAddress || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(address)) return { stored: false, reason: 'bad_address' };
  const row = await d.prepare('SELECT id, created_at, last_activity FROM mail_inboxes WHERE address = ?1').bind(address).first();
  if (!row) return { stored: false, reason: 'no_inbox' };
  if (isExpired(row, now)) return { stored: false, reason: 'expired' };
  if (rawBytes && rawBytes.length > MAIL_LIMITS.maxRawBytes) return { stored: false, reason: 'too_large' };

  const parsed = parseEmail(rawBytes);
  const textBody = (parsed.text || (parsed.html ? htmlToText(parsed.html) : '')).slice(0, MAIL_LIMITS.storedTextBytes);
  const htmlText = parsed.html ? htmlToText(parsed.html).slice(0, MAIL_LIMITS.storedTextBytes) : '';
  const otp = extractOtp(parsed.text, parsed.html);
  const atts = JSON.stringify((parsed.attachments || []).slice(0, 20).map((a) => ({ filename: String(a.filename).slice(0, 200), contentType: a.contentType, size: a.size })));
  const size = rawBytes ? rawBytes.length : textBody.length;

  const res = await d.prepare(`INSERT INTO mail_messages (inbox_id, received_at, from_addr, from_name, subject, text_body, html_text, otp, attachments, size, seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)`)
    .bind(row.id, now, (parsed.from || '').slice(0, 320), (parsed.fromName || '').slice(0, 200), (parsed.subject || '(no subject)').slice(0, 500),
      textBody, htmlText, otp, atts, size).run();
  await d.prepare('UPDATE mail_inboxes SET message_count = message_count + 1, last_activity = ?2 WHERE id = ?1').bind(row.id, now).run();
  await d.prepare('DELETE FROM mail_messages WHERE inbox_id = ?1 AND id NOT IN (SELECT id FROM mail_messages WHERE inbox_id = ?1 ORDER BY id DESC LIMIT ?2)').bind(row.id, MAIL_LIMITS.maxStoredPerInbox).run();
  return { stored: true, id: res.meta ? res.meta.last_row_id : null, otp };
}
