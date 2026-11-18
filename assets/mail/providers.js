/* Temp-mail backend behind a small interface, so the page logic stays the same.
 * Currently one real backend: our own Cloudflare D1 + Email Worker (private), used once a mail domain is
 * configured. The in-browser demo lives in mail.js. (A free third-party API was evaluated but those services
 * block browser/proxy access, so there is no reliable instant option — see docs/TEMPMAIL_FREE_DOMAIN.md.)
 *
 * Common message shape:
 *   summary = { id, from, fromName, subject, otp, seen, receivedAt, preview }
 *   full    = { id, from, fromName, subject, otp, text, attachments:[{filename,contentType,size}], receivedAt }
 */

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
    get address() { return s.address; },
    async create(localPart) {
      const { res, data } = await api('/inboxes', { method: 'POST', body: localPart ? { localPart } : {} });
      if (!res.ok) throw Object.assign(new Error(data.error || 'create failed'), { code: data.code });
      s = { id: data.id, token: data.token, address: data.address, expiresAt: data.expiresAt, domains: data.domains || s.domains };
      return { address: s.address, expiresAt: s.expiresAt };
    },
    save() { return { prov: 'self', id: s.id, token: s.token, address: s.address, expiresAt: s.expiresAt }; },
    async restore(v) { if (!v || v.prov !== 'self' || !v.id || !v.token) return false; s = { ...s, id: v.id, token: v.token, address: v.address, expiresAt: v.expiresAt }; try { await this.list(); return true; } catch (e) { return false; } },
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
