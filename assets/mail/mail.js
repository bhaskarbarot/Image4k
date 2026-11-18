/* Temp Mail — centered temp-mail.org-style inbox that receives real e-mail. Talks to /api/mail/*.
 * The server stores only plain text (HTML e-mails are converted to text server-side) and extracts the OTP,
 * so this page renders message content with textContent only — no HTML from e-mails is ever inserted. */
import { h, clear, toast, copyText, store, formatBytes, loadScript } from '/assets/dev/ui.js';

const $ = (s) => document.querySelector(s);
const API = '/api/mail';
const KEY = 'mail-inbox'; // { id, token, address, expiresAt }

let state = { id: null, token: null, address: null, expiresAt: 0, domains: [] };
let messages = [];       // summaries, newest first
let lastId = 0;          // highest message id seen
let openId = null;
const justArrived = new Set(); // ids that should play the entrance animation on next render
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
  const d = new Date(ms), diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/* ---------- demo mode (no backend) ---------- */
let demo = false;
const demoFull = new Map();
const DEMO_SAMPLES = [
  { delay: 1500, from: 'login@stytch.com', fromName: 'Groq', subject: 'Your Groq login code', otp: '628413',
    text: 'Your Groq login code is 628413.\n\nEnter this code to finish signing in. It expires in 10 minutes.\nIf you didn’t request this, you can ignore this email.' },
  { delay: 4000, from: 'noreply@tm.openai.com', fromName: 'OpenAI', subject: 'Your OpenAI verification code', otp: '915042',
    text: 'Your OpenAI verification code is: 915042\n\nThis code expires in 15 minutes. Don’t share it with anyone.' },
  { delay: 7000, from: 'noreply@github.com', fromName: 'GitHub', subject: '[GitHub] Please verify your device', otp: '839201',
    text: 'Hey! A sign-in attempt needs verification. Your authentication code is 839201.\nIf this wasn’t you, change your password right away.' },
];
function startDemo() {
  demo = true;
  state = { id: 'demo', token: 'demo', address: 'you' + rand() + '@demo-inbox.test', expiresAt: Date.now() + 15 * 60000, domains: ['demo-inbox.test'] };
  messages = []; lastId = 0; openId = null; demoFull.clear();
  $('#mailOff').hidden = true;
  $('#mailApp').hidden = false;
  $('#mailDemoBanner')?.removeAttribute('hidden');
  renderAddress(); renderList(); showView(null);
  bind(); startCountdown();
  for (const s of DEMO_SAMPLES) setTimeout(() => addDemoMessage(s), s.delay);
}
function addDemoMessage(s) {
  if (!demo) return;
  const id = ++lastId;
  demoFull.set(id, { id, receivedAt: Date.now(), from: s.from, fromName: s.fromName, subject: s.subject, otp: s.otp, text: s.text, attachments: [], seen: false });
  justArrived.add(id);
  messages.unshift({ id, receivedAt: Date.now(), from: s.from, fromName: s.fromName, subject: s.subject, otp: s.otp, seen: false, preview: s.text.slice(0, 140) });
  renderList();
  toast(`New email · code ${s.otp} from ${s.fromName}`, 'ok', 4000);
}
const rand = () => Math.floor(Math.random() * 9000 + 1000);

/* ---------- boot ---------- */
async function boot() {
  const { data } = await api('/config', { auth: false });
  if (!data.configured) {
    $('#mailApp').hidden = true; $('#mailOff').hidden = false;
    if (!data.hasStorage) $('#mailOffDetail').textContent = 'Receiving real email needs a Cloudflare D1 database (MAIL_DB) and a verified email domain (MAIL_DOMAIN). It can be enabled for FREE with a eu.org domain — owner: see docs/TEMPMAIL_FREE_DOMAIN.md. Meanwhile, try the demo below.';
    $('#demoBtn')?.addEventListener('click', startDemo);
    window.__mail = { get state() { return state; }, get messages() { return messages; }, startDemo };
    return;
  }
  state.domains = data.domains || [];
  $('#mailApp').hidden = false;
  const saved = store.get(KEY, null);
  if (saved && saved.id && saved.token) {
    state = { ...state, ...saved };
    if (!(await refresh(true))) await createInbox();
  } else await createInbox();
  bind(); startPolling(); startCountdown();
}

async function createInbox(localPart) {
  setStatus('Creating…');
  const { res, data } = await api('/inboxes', { method: 'POST', body: localPart ? { localPart } : {}, auth: false });
  if (!res.ok) {
    if (data.code === 'address_taken') { toast('That name is taken — try another.', 'err'); return false; }
    toast(data.error || 'Could not create an address.', 'err'); return false;
  }
  state = { id: data.id, token: data.token, address: data.address, expiresAt: data.expiresAt, domains: data.domains || state.domains };
  store.set(KEY, { id: state.id, token: state.token, address: state.address, expiresAt: state.expiresAt });
  messages = []; lastId = 0; openId = null;
  renderAddress(); renderList(); showView(null); setStatus('');
  bumpFast(); // poll quickly right after getting a new address (a sign-up OTP is likely coming)
  return true;
}

/* ---------- auto-refresh (no manual refresh needed) ----------
 * Self-scheduling poll: checks every ~2.5 s for the first 40 s after you get/open an address (so a sign-up
 * OTP shows almost instantly), then settles to ~5 s to save the database's free quota. Paused when the tab
 * is hidden. A new message extends the fast window (more are often on the way). */
let fastUntil = 0, pollStop = false;
function bumpFast() { fastUntil = Date.now() + 40000; }
function startPolling() {
  stopPolling(); pollStop = false; bumpFast();
  const loop = async () => {
    if (pollStop || demo) return;
    await refresh();
    if (pollStop || demo) return;
    pollTimer = setTimeout(loop, Date.now() < fastUntil ? 2500 : 5000);
  };
  loop();
}
function stopPolling() { pollStop = true; if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }
function setChecking(on) { document.querySelector('.mail-thead')?.classList.toggle('is-loading', !!on); setRefreshSpin(on); }
function setRefreshSpin(on) { $('#refreshBtn')?.classList.toggle('is-spin', !!on); }

async function refresh(initial) {
  if (!state.id || !state.token || demo) return false;
  polling = true; setChecking(true); if (!initial) setStatus('Checking…');
  try {
    const { res, data } = await api(`/inboxes/${state.id}/messages?after=0`);
    if (res.status === 404 || res.status === 410) {
      if (initial) return false;
      toast('Your address expired — made a new one.', 'warn');
      await createInbox(); return true;
    }
    if (!res.ok) { setStatus('offline'); return false; }
    state.expiresAt = data.inbox.expiresAt;
    const fresh = data.messages || [];
    const newOnes = fresh.filter((m) => m.id > lastId);
    const prevLast = lastId;
    lastId = fresh.reduce((mx, m) => Math.max(mx, m.id), lastId);
    for (const m of newOnes) justArrived.add(m.id);
    messages = fresh;
    renderList(); renderAddress(); setStatus('');
    if (prevLast > 0 && newOnes.length) { const n = newOnes[0]; toast(`New email${n.otp ? ' · code ' + n.otp : ''} from ${n.fromName || n.from}`, 'ok', 4000); }
    return true;
  } catch (e) { setStatus('offline'); return false; }
  finally { polling = false; setChecking(false); }
}
function setStatus(t) { const el = $('#mailStatus'); if (el) el.textContent = t || ''; }

/* ---------- render ---------- */
function renderAddress() { $('#mailAddr').textContent = state.address || '…'; }
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  const upd = () => {
    const el = $('#mailExpiry'); if (!el) return;
    if (!state.expiresAt) { el.textContent = ''; return; }
    const left = state.expiresAt - Date.now();
    if (left <= 0) { el.textContent = '· expired'; return; }
    const mins = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    el.textContent = mins >= 60 ? `· expires in ${Math.floor(mins / 60)}h ${mins % 60}m` : `· expires in ${mins}:${String(s).padStart(2, '0')}`;
  };
  upd(); countdownTimer = setInterval(upd, 1000);
}

function renderList() {
  const list = $('#mailList');
  $('#mailEmpty').hidden = messages.length > 0;
  clear(list);
  for (const m of messages) {
    const row = h('li', {
      class: 'mail-row' + (m.seen ? '' : ' is-unread') + (justArrived.has(m.id) ? ' mail-row-new' : ''),
      attrs: { role: 'button', tabindex: '0' },
      on: { click: () => openMessage(m.id), keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMessage(m.id); } } },
    },
      h('div', { class: 'mail-row-sender' }, m.fromName || m.from || 'Unknown', h('span', { class: 'mail-row-time' }, fmtTime(m.receivedAt))),
      h('div', { class: 'mail-row-subject' },
        h('span', { class: 's' }, m.subject || '(no subject)'),
        m.otp ? h('span', { class: 'mail-row-otp' }, 'Code ' + m.otp) : null),
      h('button', { class: 'mail-view-btn', type: 'button', attrs: { tabindex: '-1' } }, 'View'),
    );
    list.appendChild(row);
  }
  justArrived.clear();
}

async function openMessage(id) {
  openId = id; renderList();
  let m;
  if (demo) { m = demoFull.get(id); if (!m) return; }
  else {
    const { res, data } = await api(`/inboxes/${state.id}/messages/${id}`);
    if (!res.ok) { toast(data.error || 'Could not open the message.', 'err'); return; }
    m = data.message;
  }
  const sum = messages.find((x) => x.id === id); if (sum) sum.seen = true;
  if (demo && demoFull.get(id)) demoFull.get(id).seen = true;
  renderList();
  $('#inboxView').hidden = true;
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
  $('.mail-inbox-card').scrollIntoView({ block: 'nearest' });
}

function showView(id) {
  openId = id;
  if (id == null) { $('#mailMessage').hidden = true; $('#inboxView').hidden = false; }
}

/* ---------- QR of the address ---------- */
async function openQr() {
  if (!state.address) return;
  $('#qrAddr').textContent = state.address;
  $('#qrModal').hidden = false;
  const holder = $('#qrCanvas'); clear(holder);
  try {
    const QR = await loadScript('/assets/vendor/qr-code-styling-1.9.1/qr-code-styling.js', 'QRCodeStyling');
    new QR({ width: 200, height: 200, type: 'canvas', data: state.address, margin: 0,
      qrOptions: { errorCorrectionLevel: 'M' },
      dotsOptions: { type: 'rounded', color: '#15121f' },
      cornersSquareOptions: { type: 'extra-rounded', color: '#b0129f' },
      cornersDotOptions: { type: 'dot', color: '#b0129f' },
      backgroundOptions: { color: '#ffffff' } }).append(holder);
  } catch (e) { holder.textContent = 'QR code unavailable'; }
}
function closeQr() { $('#qrModal').hidden = true; }

/* ---------- actions ---------- */
function bind() {
  if (bind._bound) return;
  bind._bound = true;
  const copy = (e) => state.address && copyText(state.address, e.currentTarget);
  $('#copyAddr').addEventListener('click', copy);
  $('#copyBtn').addEventListener('click', copy);
  $('#qrBtn').addEventListener('click', openQr);
  $('#qrClose').addEventListener('click', closeQr);
  $('#qrModal').addEventListener('click', (e) => { if (e.target === $('#qrModal')) closeQr(); });
  $('#refreshBtn').addEventListener('click', () => { if (demo) { setRefreshSpin(true); setTimeout(() => setRefreshSpin(false), 600); } else { bumpFast(); refresh(); } });
  $('#changeBtn').addEventListener('click', () => {
    const form = $('#customForm');
    const show = form.hidden; form.hidden = !show;
    if (show) { $('#customDomain').textContent = '@' + (state.domains[0] || 'demo-inbox.test'); $('#customLocal').focus(); }
  });
  $('#deleteBtn').addEventListener('click', async () => {
    if (!confirm('Delete this address and get a new one? The current inbox and its messages are removed.')) return;
    if (demo) {
      messages = []; lastId = 0; demoFull.clear(); openId = null;
      state.address = 'you' + rand() + '@demo-inbox.test';
      renderAddress(); renderList(); showView(null);
      for (const s of DEMO_SAMPLES) setTimeout(() => addDemoMessage(s), s.delay);
      return;
    }
    try { await api(`/inboxes/${state.id}`, { method: 'DELETE' }); } catch (e) { /* best effort */ }
    await createInbox();
  });
  $('#copyOtp').addEventListener('click', (e) => copyText($('#mailOtpCode').textContent, e.currentTarget));
  $('#msgBack').addEventListener('click', () => showView(null));
  $('#msgDelete').addEventListener('click', async () => {
    if (openId == null) return;
    if (demo) { demoFull.delete(openId); } else { try { await api(`/inboxes/${state.id}/messages/${openId}`, { method: 'DELETE' }); } catch (e) {} }
    messages = messages.filter((m) => m.id !== openId); showView(null); renderList(); toast('Message deleted');
  });
  const form = $('#customForm');
  $('#customCancel').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#customLocal').value.trim().toLowerCase();
    if (!v) return;
    if (demo) { state.address = v + '@demo-inbox.test'; renderAddress(); form.hidden = true; return; }
    if (await createInbox(v)) form.hidden = true;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeQr(); if (!$('#mailMessage').hidden) showView(null); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPolling(); else if (state.id && !demo) startPolling(); });
  window.addEventListener('beforeunload', stopPolling);
  window.__mail = { get state() { return state; }, get messages() { return messages; }, refresh, createInbox, openMessage, startDemo, openQr };
}

boot();
