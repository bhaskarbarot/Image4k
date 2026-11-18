/* Temp-mail backends behind one small interface, so the page works the same whichever is live:
 *   - 'self'   : our own Cloudflare D1 + Email Worker (private, used once a mail domain is configured)
 *   - 'mailtm' : the free public mail.tm API from the browser (instant, no domain; not self-hosted/private)
 *   - 'demo'   : in-browser sample emails (no backend)
 *
 * Common message shape:
 *   summary  = { id, from, fromName, subject, otp, seen, receivedAt, preview }
 *   full     = { id, from, fromName, subject, otp, text, attachments:[{filename,contentType,size}], receivedAt }
 * create() -> { address, expiresAt }.  list() -> { address, expiresAt, messages:[summary] } (may throw {expired:true}).
 */
import { extractOtp } from './otp.js';

const rand = () => Math.floor(Math.random() * 9000 + 1000);
const ADJ = ['cool', 'quick', 'calm', 'bold', 'brave', 'bright', 'swift', 'wise', 'lucky', 'happy', 'clever', 'quiet', 'sunny', 'jolly', 'mighty', 'noble', 'witty', 'zesty', 'fuzzy', 'snappy'];
const NOUN = ['tiger', 'otter', 'falcon', 'maple', 'comet', 'river', 'pixel', 'cedar', 'nova', 'raven', 'willow', 'ember', 'onyx', 'quartz', 'badger', 'lynx', 'heron', 'koala', 'panda', 'fox'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
export const randomLocal = () => pick(ADJ) + pick(NOUN) + rand();

/* ---------------- self-hosted (our Cloudflare backend) ---------------- */
export function makeSelfHosted() {
  const API = '/api/mail';
  let s = { id: null, token: null, address: null, expiresAt: 0, domains: [] };
  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (s.token) headers.Authorization = 'Bearer ' + s.token;
    const res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await res.json(); } catch (e) { /* ignore */ }
    return { res, data };
  }
  const mapSummary = (m) => ({ id: m.id, from: m.from, fromName: m.fromName, subject: m.subject, otp: m.otp, seen: !!m.seen, receivedAt: m.receivedAt, preview: m.preview });
  return {
    id: 'self', thirdParty: false, supportsCustom: true,
    setDomains(d) { s.domains = d || []; },
    domains() { return s.domains; },
    get inboxId() { return s.id; },
    async create(localPart) {
      const { res, data } = await api('/inboxes', { method: 'POST', body: localPart ? { localPart } : {} });
      if (!res.ok) throw Object.assign(new Error(data.error || 'create failed'), { code: data.code });
      s = { id: data.id, token: data.token, address: data.address, expiresAt: data.expiresAt, domains: data.domains || s.domains };
      return { address: s.address, expiresAt: s.expiresAt };
    },
    save() { return { prov: 'self', id: s.id, token: s.token, address: s.address, expiresAt: s.expiresAt }; },
    async restore(v) { if (!v || v.prov !== 'self' || !v.id || !v.token) return false; s = { ...s, id: v.id, token: v.token, address: v.address, expiresAt: v.expiresAt }; try { await this.list(); return true; } catch (e) { return false; } },
    get address() { return s.address; },
    async list() {
      const { res, data } = await api(`/inboxes/${s.id}/messages?after=0`);
      if (res.status === 404 || res.status === 410) throw { expired: true };
      if (!res.ok) throw new Error('offline');
      s.expiresAt = data.inbox.expiresAt;
      return { address: data.inbox.address, expiresAt: data.inbox.expiresAt, messages: (data.messages || []).map(mapSummary) };
    },
    async open(id) {
      const { res, data } = await api(`/inboxes/${s.id}/messages/${id}`);
      if (!res.ok) throw new Error(data.error || 'open failed');
      const m = data.message;
      return { id: m.id, from: m.from, fromName: m.fromName, subject: m.subject, otp: m.otp, text: m.text || '', attachments: m.attachments || [], receivedAt: m.receivedAt };
    },
    async removeMessage(id) { await api(`/inboxes/${s.id}/messages/${id}`, { method: 'DELETE' }); },
    async destroy() { try { await api(`/inboxes/${s.id}`, { method: 'DELETE' }); } catch (e) {} },
  };
}

/* ---------------- mail.tm (free public API, client-side) ---------------- */
export function makeMailTm() {
  const API = 'https://api.mail.tm';
  let s = { accountId: null, token: null, address: null, password: null, domains: [] };
  async function req(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && s.token) headers.Authorization = 'Bearer ' + s.token;
    const res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (e) { /* 204 etc */ }
    return { res, data };
  }
  async function activeDomains() {
    const { res, data } = await req('/domains?page=1', { auth: false });
    if (!res.ok || !data) throw new Error('mail.tm unavailable');
    const list = (data['hydra:member'] || []).filter((d) => d.isActive && !d.isPrivate).map((d) => d.domain);
    if (!list.length) throw new Error('mail.tm has no open domains right now');
    s.domains = list; return list;
  }
  function makePassword() { return 'Pw-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase() + '9!'; }
  const mapFrom = (f) => (f && typeof f === 'object' ? { from: f.address || '', fromName: f.name || '' } : { from: String(f || ''), fromName: '' });
  return {
    id: 'mailtm', thirdParty: true, supportsCustom: true,
    async init() { await activeDomains(); },
    domains() { return s.domains; },
    async create(localPart) {
      if (!s.domains.length) await activeDomains();
      const domain = s.domains[0];
      const local = (localPart || randomLocal()).toLowerCase().replace(/[^a-z0-9._-]/g, '');
      const address = `${local}@${domain}`;
      const password = makePassword();
      const acc = await req('/accounts', { method: 'POST', body: { address, password }, auth: false });
      if (acc.res.status === 422) throw Object.assign(new Error('That name is taken'), { code: 'address_taken' });
      if (!acc.res.ok) throw new Error((acc.data && acc.data.detail) || 'Could not create a mailbox');
      const tok = await req('/token', { method: 'POST', body: { address, password }, auth: false });
      if (!tok.res.ok || !tok.data || !tok.data.token) throw new Error('Could not sign in to the mailbox');
      s = { accountId: tok.data.id, token: tok.data.token, address, password, domains: s.domains };
      // mail.tm accounts don't expire on a fixed clock; show a soft 24h window for the UI.
      return { address, expiresAt: Date.now() + 24 * 3600 * 1000 };
    },
    save() { return { prov: 'mailtm', accountId: s.accountId, token: s.token, address: s.address, password: s.password }; },
    async restore(v) {
      if (!v || v.prov !== 'mailtm' || !v.token || !v.accountId) return false;
      s = { ...s, accountId: v.accountId, token: v.token, address: v.address, password: v.password };
      try { const { res } = await req('/messages?page=1'); return res.ok; } catch (e) { return false; }
    },
    get address() { return s.address; },
    async list() {
      const { res, data } = await req('/messages?page=1');
      if (res.status === 401) throw { expired: true };
      if (!res.ok || !data) throw new Error('offline');
      const msgs = (data['hydra:member'] || []).map((m) => {
        const f = mapFrom(m.from);
        return { id: m.id, ...f, subject: m.subject || '(no subject)', otp: extractOtp(m.intro || '', ''), seen: !!m.seen, receivedAt: Date.parse(m.createdAt) || Date.now(), preview: (m.intro || '').slice(0, 140) };
      });
      return { address: s.address, expiresAt: Date.now() + 24 * 3600 * 1000, messages: msgs };
    },
    async open(id) {
      const { res, data } = await req('/messages/' + encodeURIComponent(id));
      if (!res.ok || !data) throw new Error('Could not open the message');
      const f = mapFrom(data.from);
      const html = Array.isArray(data.html) ? data.html.join('\n') : (data.html || '');
      const text = data.text || '';
      return { id: data.id, ...f, subject: data.subject || '(no subject)', otp: extractOtp(text, html), text: text || stripToText(html), attachments: (data.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })), receivedAt: Date.parse(data.createdAt) || Date.now() };
    },
    async removeMessage(id) { try { await req('/messages/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) {} },
    async destroy() { try { if (s.accountId) await req('/accounts/' + encodeURIComponent(s.accountId), { method: 'DELETE' }); } catch (e) {} },
  };
}
// small local html->text for mail.tm open() when there is no plain text part
function stripToText(html) { return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
