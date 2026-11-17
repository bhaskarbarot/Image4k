/* Temp Mail — disposable inbox that receives real e-mail. Talks to /api/mail/* (server/mail-core.js).
 * The server stores only plain text (HTML e-mails are converted to text server-side) and extracts the OTP,
 * so this page renders message content with textContent only — no HTML from e-mails is ever inserted. */
import { h, clear, toast, copyText, store, formatBytes } from '/assets/dev/ui.js';

const $ = (s) => document.querySelector(s);
const API = '/api/mail';
const KEY = 'mail-inbox'; // { id, token, address, expiresAt }

let state = { id: null, token: null, address: null, expiresAt: 0, domains: [] };
let messages = [];       // summaries, newest first
let lastId = 0;          // highest message id seen
let openId = null;
let pollTimer = null, countdownTimer = null, polling = false;

/* ---------- api helpers ---------- */
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  return { res, data };
}
const fmtTime = (ms) => {
  const d = new Date(ms), now = Date.now(), diff = now - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/* ---------- boot ---------- */
async function boot() {
  const { data } = await api('/config', { auth: false });
  if (!data.configured) {
    $('#mailApp').hidden = true; $('#mailOff').hidden = false;
    if (!data.hasStorage) $('#mailOffDetail').textContent = 'Receiving real email needs a Cloudflare D1 database (MAIL_DB) and a verified email domain (MAIL_DOMAIN). The site owner can enable it from docs/DEPLOYMENT.md → “Temp-mail”. Every other tool works normally.';
    return;
  }
  state.domains = data.domains || [];
  $('#mailApp').hidden = false;
  const saved = store.get(KEY, null);
  if (saved && saved.id && saved.token) {
    state = { ...state, ...saved };
    const ok = await refresh(true);
    if (!ok) await createInbox();
  } else {
    await createInbox();
  }
  bind();
  startPolling();
  startCountdown();
}

async function createInbox(localPart) {
  setStatus('Creating address…');
  const { res, data } = await api('/inboxes', { method: 'POST', body: localPart ? { localPart } : {}, auth: false });
  if (!res.ok) {
    if (data.code === 'address_taken') { toast('That name is taken — try another.', 'err'); return false; }
    toast(data.error || 'Could not create an address.', 'err'); return false;
  }
  state = { id: data.id, token: data.token, address: data.address, expiresAt: data.expiresAt, domains: data.domains || state.domains };
  store.set(KEY, { id: state.id, token: state.token, address: state.address, expiresAt: state.expiresAt });
  messages = []; lastId = 0; openId = null;
  renderAddress(); renderList(); showView(null);
  setStatus('');
  return true;
}

/* ---------- polling ---------- */
function startPolling() {
  stopPolling();
  const tick = () => { if (!polling) refresh(); };
  pollTimer = setInterval(tick, 7000);
  refresh();
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

async function refresh(initial) {
  if (!state.id || !state.token) return false;
  polling = true; if (!initial) setStatus('Checking…');
  try {
    const { res, data } = await api(`/inboxes/${state.id}/messages?after=0`);
    if (res.status === 404 || res.status === 410) { // inbox gone/expired
      if (initial) return false;
      toast('Your address expired — made a new one.', 'warn');
      await createInbox(); return true;
    }
    if (!res.ok) { setStatus('Offline — will retry'); return false; }
    state.expiresAt = data.inbox.expiresAt;
    const fresh = data.messages || [];
    const newOnes = fresh.filter((m) => m.id > lastId);
    const prevLast = lastId;
    lastId = fresh.reduce((mx, m) => Math.max(mx, m.id), lastId);
    messages = fresh;
    renderList();
    renderAddress();
    setStatus(fresh.length ? '' : 'Waiting for mail…');
    if (prevLast > 0 && newOnes.length) {
      const n = newOnes[0];
      toast(`New email${n.otp ? ' · code ' + n.otp : ''} from ${n.fromName || n.from}`, 'ok', 4000);
    }
    return true;
  } catch (e) { setStatus('Offline — will retry'); return false; }
  finally { polling = false; }
}

function setStatus(t) { $('#mailStatus').textContent = t || ''; }

/* ---------- render ---------- */
function renderAddress() {
  $('#mailAddr').textContent = state.address || '…';
}
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  const upd = () => {
    if (!state.expiresAt) { $('#mailExpiry').textContent = ''; return; }
    const left = state.expiresAt - Date.now();
    const el = $('#mailExpiry');
    if (left <= 0) { el.textContent = 'expired'; return; }
    const mins = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    el.textContent = mins >= 60 ? `expires in ${Math.floor(mins / 60)}h ${mins % 60}m` : `expires in ${mins}:${String(s).padStart(2, '0')}`;
  };
  upd(); countdownTimer = setInterval(upd, 1000);
}

function renderList() {
  const list = $('#mailList');
  $('#mailCount').textContent = String(messages.length);
  $('#mailEmpty').hidden = messages.length > 0;
  clear(list);
  for (const m of messages) {
    const li = h('li', {
      class: 'mail-item' + (m.seen ? '' : ' is-unread') + (m.id === openId ? ' is-open' : ''),
      attrs: { role: 'button', tabindex: '0' },
      on: { click: () => openMessage(m.id), keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMessage(m.id); } } },
    },
      h('div', { class: 'mail-item-top' },
        h('span', { class: 'mail-item-from' }, m.fromName || m.from || 'Unknown'),
        h('span', { class: 'mail-item-time' }, fmtTime(m.receivedAt))),
      h('div', { class: 'mail-item-subject' }, m.subject || '(no subject)'),
      m.otp ? h('span', { class: 'mail-item-otp' }, 'Code ' + m.otp) : (m.preview ? h('div', { class: 'mail-item-preview' }, m.preview) : null),
    );
    list.appendChild(li);
  }
}

async function openMessage(id) {
  openId = id;
  renderList();
  const { res, data } = await api(`/inboxes/${state.id}/messages/${id}`);
  if (!res.ok) { toast(data.error || 'Could not open the message.', 'err'); return; }
  const m = data.message;
  // mark seen locally
  const sum = messages.find((x) => x.id === id); if (sum) sum.seen = true;
  renderList();
  $('#mailViewEmpty').hidden = true;
  $('#mailMessage').hidden = false;
  const otpWrap = $('#mailOtp');
  if (m.otp) { otpWrap.hidden = false; $('#mailOtpCode').textContent = m.otp; } else otpWrap.hidden = true;
  $('#msgSubject').textContent = m.subject || '(no subject)';
  $('#msgFrom').textContent = (m.fromName ? m.fromName + ' · ' : '') + (m.from || '');
  $('#msgTime').textContent = new Date(m.receivedAt).toLocaleString();
  $('#msgBody').textContent = m.text || '(This email has no text content.)';
  const at = $('#msgAttachments');
  if (m.attachments && m.attachments.length) {
    at.hidden = false; clear(at);
    at.appendChild(h('span', { class: 'mail-att-label' }, '📎 Attachments (not downloadable):'));
    for (const a of m.attachments) at.appendChild(h('span', { class: 'mail-att' }, `${a.filename} · ${formatBytes(a.size)}`));
  } else at.hidden = true;
  $('#mailView').classList.add('is-showing');
}

function showView(id) {
  openId = id;
  if (id == null) { $('#mailMessage').hidden = true; $('#mailViewEmpty').hidden = false; $('#mailView').classList.remove('is-showing'); }
}

/* ---------- actions ---------- */
function bind() {
  $('#copyAddr').addEventListener('click', (e) => state.address && copyText(state.address, e.currentTarget));
  $('#newAddr').addEventListener('click', async () => { if (confirm('Get a new address? The current inbox and its messages will be dropped.')) await createInbox(); });
  $('#refreshBtn').addEventListener('click', () => refresh());
  $('#copyOtp').addEventListener('click', (e) => copyText($('#mailOtpCode').textContent, e.currentTarget));
  $('#msgBack').addEventListener('click', () => showView(null));
  $('#msgDelete').addEventListener('click', async () => {
    if (openId == null) return;
    const { res } = await api(`/inboxes/${state.id}/messages/${openId}`, { method: 'DELETE' });
    if (res.ok) { messages = messages.filter((m) => m.id !== openId); showView(null); renderList(); toast('Message deleted'); }
  });
  // custom address
  const form = $('#customForm');
  $('#editAddr').addEventListener('click', () => { form.hidden = false; $('#customDomain').textContent = '@' + (state.domains[0] || ''); $('#customLocal').focus(); });
  $('#customCancel').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#customLocal').value.trim();
    if (!v) return;
    if (await createInbox(v)) form.hidden = true;
  });
  // pause fast polling when the tab is hidden (save battery + D1 budget)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else if (state.id) startPolling();
  });
  window.addEventListener('beforeunload', () => { stopPolling(); });
  // test hook
  window.__mail = { get state() { return state; }, get messages() { return messages; }, refresh, createInbox, openMessage };
}

boot();
