/* Temp Mail — centered temp-mail.org-style inbox. Works with whichever backend is live:
 *   self-hosted (our Cloudflare D1 + Email Worker) when a mail domain is configured, otherwise the free
 *   mail.tm API (instant, no domain), and a built-in demo if neither is reachable. See providers.js.
 * Message content is rendered with textContent only — no HTML from e-mails is ever inserted into the page. */
import { h, clear, toast, copyText, store, formatBytes, loadScript } from '/assets/dev/ui.js';
import { makeSelfHosted, makeMailTm } from './providers.js';

const $ = (s) => document.querySelector(s);
const KEY = 'mail-inbox';

let live = null;          // active provider (self | mailtm)
let demo = false;
let address = null, expiresAt = 0, domains = [], thirdParty = false, supportsCustom = true;
let messages = [];        // summaries, newest first
let openId = null;
const seenIds = new Set();      // message ids already shown (new-mail detection)
const justArrived = new Set();  // ids to play the entrance animation on next render
let pollTimer = null, countdownTimer = null, polling = false;

const fmtTime = (ms) => {
  const d = new Date(ms), diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const rand = () => Math.floor(Math.random() * 9000 + 1000);

/* ---------------- boot: choose the backend ---------------- */
async function boot() {
  let cfg = { configured: false, hasStorage: false, domains: [] };
  try { cfg = await (await fetch('/api/mail/config')).json(); } catch (e) { /* static host → stays unconfigured */ }

  if (cfg.configured) {
    live = makeSelfHosted(); live.setDomains(cfg.domains || []); domains = cfg.domains || []; thirdParty = false; supportsCustom = true;
    return startLive();
  }
  // no private backend yet → try the free instant mail.tm service
  try {
    const m = makeMailTm();
    await m.init();
    live = m; domains = m.domains(); thirdParty = true; supportsCustom = true;
    await startLive();
    showProviderNote();
    return;
  } catch (e) {
    // nothing reachable → offer the demo
    $('#mailApp').hidden = true; $('#mailOff').hidden = false;
    $('#mailOffDetail').textContent = 'The free instant inbox (mail.tm) could not be reached right now, and this site’s own mail backend isn’t switched on yet. Try the demo below, or reload in a moment.';
    $('#demoBtn')?.addEventListener('click', startDemo);
    window.__mail = { get state() { return { address }; }, get messages() { return messages; }, startDemo, provider: 'none' };
  }
}

function showProviderNote() {
  const el = $('#mailDemoBanner'); if (!el) return;
  clear(el);
  el.appendChild(h('span', { class: 'mail-demo-badge' }, 'FREE'));
  el.appendChild(h('span', null,
    'Instant inbox powered by ', h('b', null, 'mail.tm'), ' — real email & OTP codes arrive here, free. Note: mail passes through their servers, so it isn’t private. Your own private address (',
    h('b', null, 'prodevtools.net.eu.org'), ') switches on automatically once it’s approved.'));
  el.hidden = false;
}

async function startLive() {
  $('#mailApp').hidden = false;
  const saved = store.get(KEY, null);
  let ok = false;
  if (saved && saved.prov === live.id) {
    try { ok = await live.restore(saved); } catch (e) { ok = false; }
  }
  if (ok) {
    address = live.address; store.set(KEY, live.save());
    renderAddress(); showView(null);
    await refresh(true);
  } else {
    await createInbox();
  }
  bind(); startPolling(); startCountdown();
}

async function createInbox(localPart) {
  setStatus('Creating…');
  try {
    const r = await live.create(localPart);
    address = r.address; expiresAt = r.expiresAt || 0;
    store.set(KEY, live.save());
    messages = []; seenIds.clear(); justArrived.clear(); openId = null;
    renderAddress(); renderList(); showView(null); setStatus(''); bumpFast();
    return true;
  } catch (e) {
    if (e.code === 'address_taken') toast('That name is taken — try another.', 'err');
    else toast(e.message || 'Could not create an address.', 'err');
    setStatus('');
    return false;
  }
}

/* ---------------- auto-refresh ---------------- */
let fastUntil = 0, pollStop = false;
function bumpFast() { fastUntil = Date.now() + 40000; }
function startPolling() {
  stopPolling(); pollStop = false; bumpFast();
  const loop = async () => {
    if (pollStop || demo || !live) return;
    await refresh();
    if (pollStop || demo || !live) return;
    pollTimer = setTimeout(loop, Date.now() < fastUntil ? 2500 : 5000);
  };
  loop();
}
function stopPolling() { pollStop = true; if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }
function setChecking(on) { document.querySelector('.mail-thead')?.classList.toggle('is-loading', !!on); $('#refreshBtn')?.classList.toggle('is-spin', !!on); }

async function refresh(initial) {
  if (!live || demo) return false;
  polling = true; setChecking(true); if (!initial) setStatus('Checking…');
  try {
    const r = await live.list();
    address = r.address || address; expiresAt = r.expiresAt || expiresAt;
    const firstLoad = seenIds.size === 0;
    const newOnes = r.messages.filter((m) => !seenIds.has(m.id));
    for (const m of r.messages) seenIds.add(m.id);
    if (!firstLoad) for (const m of newOnes) justArrived.add(m.id);
    messages = r.messages;
    renderList(); renderAddress(); setStatus('');
    if (!firstLoad && newOnes.length) { const n = newOnes[0]; toast(`New email${n.otp ? ' · code ' + n.otp : ''} from ${n.fromName || n.from}`, 'ok', 4000); }
    return true;
  } catch (e) {
    if (e && e.expired) { if (initial) return false; toast('Your address expired — made a new one.', 'warn'); await createInbox(); return true; }
    setStatus('offline'); return false;
  } finally { polling = false; setChecking(false); }
}
function setStatus(t) { const el = $('#mailStatus'); if (el) el.textContent = t || ''; }

/* ---------------- render ---------------- */
function renderAddress() { $('#mailAddr').textContent = address || '…'; }
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  const upd = () => {
    const el = $('#mailExpiry'); if (!el) return;
    if (!expiresAt) { el.textContent = ''; return; }
    const left = expiresAt - Date.now();
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
      h('div', { class: 'mail-row-subject' }, h('span', { class: 's' }, m.subject || '(no subject)'), m.otp ? h('span', { class: 'mail-row-otp' }, 'Code ' + m.otp) : null),
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
  else { try { m = await live.open(id); } catch (e) { toast(e.message || 'Could not open the message.', 'err'); return; } }
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

function showView(id) { openId = id; if (id == null) { $('#mailMessage').hidden = true; $('#inboxView').hidden = false; } }

/* ---------------- QR of the address ---------------- */
async function openQr() {
  if (!address) return;
  $('#qrAddr').textContent = address; $('#qrModal').hidden = false;
  const holder = $('#qrCanvas'); clear(holder);
  try {
    const QR = await loadScript('/assets/vendor/qr-code-styling-1.9.1/qr-code-styling.js', 'QRCodeStyling');
    new QR({ width: 200, height: 200, type: 'canvas', data: address, margin: 0, qrOptions: { errorCorrectionLevel: 'M' },
      dotsOptions: { type: 'rounded', color: '#15121f' }, cornersSquareOptions: { type: 'extra-rounded', color: '#b0129f' },
      cornersDotOptions: { type: 'dot', color: '#b0129f' }, backgroundOptions: { color: '#ffffff' } }).append(holder);
  } catch (e) { holder.textContent = 'QR code unavailable'; }
}
function closeQr() { $('#qrModal').hidden = true; }

/* ---------------- demo (no backend) ---------------- */
const demoFull = new Map();
const DEMO_SAMPLES = [
  { delay: 1500, from: 'login@stytch.com', fromName: 'Groq', subject: 'Your Groq login code', otp: '628413', text: 'Your Groq login code is 628413.\n\nEnter this code to finish signing in. It expires in 10 minutes.' },
  { delay: 4000, from: 'noreply@tm.openai.com', fromName: 'OpenAI', subject: 'Your OpenAI verification code', otp: '915042', text: 'Your OpenAI verification code is: 915042\n\nThis code expires in 15 minutes.' },
  { delay: 7000, from: 'noreply@github.com', fromName: 'GitHub', subject: '[GitHub] Please verify your device', otp: '839201', text: 'Your authentication code is 839201.\nIf this wasn’t you, change your password.' },
];
function startDemo() {
  demo = true; live = null; thirdParty = false;
  address = 'you' + rand() + '@demo-inbox.test'; expiresAt = Date.now() + 15 * 60000;
  messages = []; seenIds.clear(); justArrived.clear(); openId = null; demoFull.clear();
  $('#mailOff').hidden = true; $('#mailApp').hidden = false;
  const b = $('#mailDemoBanner'); if (b) { clear(b); b.appendChild(h('span', { class: 'mail-demo-badge' }, 'DEMO')); b.appendChild(h('span', null, 'Sample emails generated in your browser — real email needs the inbox switched on.')); b.hidden = false; }
  renderAddress(); renderList(); showView(null); bind(); startCountdown();
  for (const s of DEMO_SAMPLES) setTimeout(() => addDemoMessage(s), s.delay);
}
function addDemoMessage(s) {
  if (!demo) return;
  const id = 'd' + (demoFull.size + 1);
  demoFull.set(id, { id, receivedAt: Date.now(), from: s.from, fromName: s.fromName, subject: s.subject, otp: s.otp, text: s.text, attachments: [], seen: false });
  justArrived.add(id);
  messages.unshift({ id, receivedAt: Date.now(), from: s.from, fromName: s.fromName, subject: s.subject, otp: s.otp, seen: false, preview: s.text.slice(0, 140) });
  renderList();
  toast(`New email · code ${s.otp} from ${s.fromName}`, 'ok', 4000);
}

/* ---------------- actions ---------------- */
function bind() {
  if (bind._bound) return; bind._bound = true;
  const copy = (e) => address && copyText(address, e.currentTarget);
  $('#copyAddr').addEventListener('click', copy);
  $('#copyBtn').addEventListener('click', copy);
  $('#qrBtn').addEventListener('click', openQr);
  $('#qrClose').addEventListener('click', closeQr);
  $('#qrModal').addEventListener('click', (e) => { if (e.target === $('#qrModal')) closeQr(); });
  $('#refreshBtn').addEventListener('click', () => { if (demo) { setChecking(true); setTimeout(() => setChecking(false), 600); } else { bumpFast(); refresh(); } });
  $('#changeBtn').addEventListener('click', () => {
    const form = $('#customForm'); const show = form.hidden; form.hidden = !show;
    if (show) { $('#customDomain').textContent = '@' + (domains[0] || (demo ? 'demo-inbox.test' : '')); $('#customLocal').focus(); }
  });
  $('#deleteBtn').addEventListener('click', async () => {
    if (!confirm('Delete this address and get a new one? The current inbox and its messages are removed.')) return;
    if (demo) { messages = []; justArrived.clear(); demoFull.clear(); openId = null; address = 'you' + rand() + '@demo-inbox.test'; renderAddress(); renderList(); showView(null); for (const s of DEMO_SAMPLES) setTimeout(() => addDemoMessage(s), s.delay); return; }
    try { await live.destroy(); } catch (e) {}
    await createInbox();
  });
  $('#copyOtp').addEventListener('click', (e) => copyText($('#mailOtpCode').textContent, e.currentTarget));
  $('#msgBack').addEventListener('click', () => showView(null));
  $('#msgDelete').addEventListener('click', async () => {
    if (openId == null) return;
    if (demo) demoFull.delete(openId); else { try { await live.removeMessage(openId); } catch (e) {} }
    messages = messages.filter((m) => m.id !== openId); seenIds.delete(openId); showView(null); renderList(); toast('Message deleted');
  });
  const form = $('#customForm');
  $('#customCancel').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#customLocal').value.trim().toLowerCase();
    if (!v) return;
    if (demo) { address = v + '@demo-inbox.test'; renderAddress(); form.hidden = true; return; }
    if (await createInbox(v)) form.hidden = true;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeQr(); if (!$('#mailMessage').hidden) showView(null); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPolling(); else if (live && !demo) startPolling(); });
  window.addEventListener('beforeunload', stopPolling);
  window.__mail = { get state() { return { address, expiresAt, id: live && live.inboxId }; }, get messages() { return messages; }, get provider() { return demo ? 'demo' : (live && live.id); }, refresh, createInbox, openMessage, startDemo, openQr };
}

boot();
