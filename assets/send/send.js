/* Peer-to-peer file transfer (/send).
 *
 * The file streams BROWSER-TO-BROWSER over a WebRTC data channel — it never touches a server and is never
 * stored anywhere. A tiny signaling worker (a Cloudflare Durable Object) only relays the WebRTC handshake
 * (SDP offer/answer + ICE candidates) so the two browsers can find each other; the moment they connect, the
 * worker is out of the loop. There is no download link and no database: both people must be online at once.
 *
 * Max file size is capped so a huge transfer can't exhaust the receiver's memory (chunks are reassembled in
 * the browser). STUN is used for NAT traversal; a small share of very strict networks may fail to connect. */

const MAX_BYTES = 2 * 1024 * 1024 * 1024;        // 2 GB universal cap
const CHUNK = 64 * 1024;                           // 64 KB data-channel writes
const HIGH_WATER = 4 * 1024 * 1024;                // pause sending above 4 MB buffered (well under Chrome's 16 MB SCTP cap)
const LOW_WATER = 256 * 1024;                      // resume once drained to 256 KB
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — unambiguous to read aloud
const CODE_LEN = 6;
// Direct-connection fallback. The real config (incl. a TURN relay for strict networks) comes from /api/ice.
const ICE_FALLBACK = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }] };
let ICE_CACHE = null;

/** Fetch ICE servers (STUN + TURN relay if configured) so transfers also work across strict NATs. */
async function getIceConfig() {
  if (ICE_CACHE) return ICE_CACHE;
  try {
    const r = await fetch('/api/ice', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    if (r.ok) { const j = await r.json(); if (j && Array.isArray(j.iceServers) && j.iceServers.length) { ICE_CACHE = { iceServers: j.iceServers }; return ICE_CACHE; } }
  } catch (e) { /* endpoint not deployed (e.g. local static preview) → fall back to STUN */ }
  ICE_CACHE = ICE_FALLBACK;
  return ICE_CACHE;
}

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function randomCode() {
  const a = new Uint32Array(CODE_LEN); crypto.getRandomValues(a);
  let s = ''; for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
  return s;
}
/** Wait until the data channel's send buffer has drained — race-proof (the one-shot bufferedamountlow
 *  event can fire in the gap before we re-attach, so we also poll as a safety net). */
function waitDrain(dc) {
  if (dc.readyState !== 'open' || dc.bufferedAmount <= dc.bufferedAmountLowThreshold) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { dc.removeEventListener('bufferedamountlow', done); clearInterval(iv); resolve(); };
    const iv = setInterval(() => { if (dc.readyState !== 'open' || dc.bufferedAmount <= dc.bufferedAmountLowThreshold) done(); }, 50);
    dc.addEventListener('bufferedamountlow', done);
  });
}

/** Resolve the signaling WebSocket base URL (wss://…/ws). */
async function signalBase() {
  if (window.__SIGNAL_URL__) return window.__SIGNAL_URL__;            // test / manual override
  try {
    const r = await fetch('/api/signal-config', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    if (r.ok) { const j = await r.json(); if (j && j.url) return j.url; }
  } catch (e) { /* function not deployed locally */ }
  return null;
}

/** Smooth, throttled progress rendering (~100 ms) so the bar glides instead of strobing. */
function makeProgress(barEl, textEl) {
  let last = 0, raf = 0, pending = null;
  function paint() {
    raf = 0; if (!pending) return;
    const { done, total, label } = pending; pending = null;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    barEl.style.width = pct.toFixed(1) + '%';
    textEl.textContent = label || (fmtBytes(done) + ' / ' + fmtBytes(total) + '  ·  ' + pct.toFixed(0) + '%');
  }
  return {
    set(done, total, label) {
      pending = { done, total, label };
      const now = performance.now();
      if (now - last > 90 && !raf) { last = now; raf = requestAnimationFrame(paint); }
      else if (!raf) { raf = requestAnimationFrame(() => { last = performance.now(); paint(); }); }
    },
    finish(label) { if (raf) cancelAnimationFrame(raf); raf = 0; pending = null; barEl.style.width = '100%'; textEl.textContent = label; },
  };
}

/* ========================================================================== SENDER ====== */
async function startSend(file) {
  if (file.size > MAX_BYTES) { sendError(`That file is ${fmtBytes(file.size)}. The limit is ${fmtBytes(MAX_BYTES)}.`); return; }
  const base = await signalBase();
  if (!base) { sendError('File transfer is not configured on this server yet. See the deploy note.'); return; }

  const code = randomCode();
  showSendStage('wait', { file, code });

  const ws = new WebSocket(base + '?code=' + code + '&role=sender');
  const pc = new RTCPeerConnection(await getIceConfig());
  const dc = pc.createDataChannel('file', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW_WATER;
  const pending = []; let haveRemote = false; let offered = false; let cleaned = false;
  const prog = makeProgress($('sendBar'), $('sendProgTxt'));

  const cleanup = () => { if (cleaned) return; cleaned = true; try { dc.close(); } catch (e) {} try { pc.close(); } catch (e) {} try { ws.close(); } catch (e) {} };
  SEND_SESSION = cleanup;

  async function makeOffer() {
    if (offered) return; offered = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
  }
  pc.onicecandidate = (e) => { if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate })); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') showSendStage('live', { file, code });
    if (pc.connectionState === 'failed') sendError('Could not open a direct connection (the network may be too restrictive).');
  };

  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'ready' && m.peerPresent) makeOffer();
    else if (m.type === 'peer-joined') makeOffer();
    else if (m.type === 'peer-left') { if (pc.connectionState !== 'connected') showSendStage('wait', { file, code }); }
    else if (m.type === 'answer') { await pc.setRemoteDescription(m.sdp); haveRemote = true; for (const c of pending.splice(0)) try { await pc.addIceCandidate(c); } catch (e) {} }
    else if (m.type === 'ice' && m.candidate) { if (haveRemote) { try { await pc.addIceCandidate(m.candidate); } catch (e) {} } else pending.push(m.candidate); }
  };
  ws.onerror = () => sendError('Lost the connection to the pairing server.');

  dc.onopen = async () => {
    dc.send(JSON.stringify({ kind: 'meta', name: file.name, size: file.size, type: file.type || 'application/octet-stream' }));
    let offset = 0; const t0 = performance.now();
    while (offset < file.size) {
      if (dc.readyState !== 'open') return;                       // peer gone
      if (dc.bufferedAmount >= HIGH_WATER) await waitDrain(dc);
      if (dc.readyState !== 'open') return;
      const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
      dc.send(buf); offset += buf.byteLength;
      const secs = (performance.now() - t0) / 1000; const rate = secs > 0 ? offset / secs : 0;
      prog.set(offset, file.size, fmtBytes(offset) + ' / ' + fmtBytes(file.size) + '  ·  ' + ((offset / file.size) * 100).toFixed(0) + '%  ·  ' + fmtBytes(rate) + '/s');
    }
    dc.send(JSON.stringify({ kind: 'done' }));
    prog.finish('Sent ' + esc(file.name) + ' — ' + fmtBytes(file.size) + ' delivered.');
    showSendStage('done', { file, code });
  };
}

/* ========================================================================== RECEIVER ==== */
async function startReceive(code) {
  code = (code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(code)) { recvError('Enter the code your friend gave you (letters and numbers).'); return; }
  const base = await signalBase();
  if (!base) { recvError('File transfer is not configured on this server yet.'); return; }

  showRecvStage('connect', { code });
  const ws = new WebSocket(base + '?code=' + code + '&role=receiver');
  const pc = new RTCPeerConnection(await getIceConfig());
  const pending = []; let haveRemote = false; let cleaned = false;
  let meta = null; const chunks = []; let received = 0;
  const prog = makeProgress($('recvBar'), $('recvProgTxt'));

  const cleanup = () => { if (cleaned) return; cleaned = true; try { pc.close(); } catch (e) {} try { ws.close(); } catch (e) {} };
  RECV_SESSION = cleanup;

  pc.onicecandidate = (e) => { if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate })); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') recvError('Could not open a direct connection (the network may be too restrictive).'); };
  pc.ondatachannel = (e) => {
    const dc = e.channel; dc.binaryType = 'arraybuffer'; const t0 = performance.now();
    dc.onmessage = (me) => {
      if (typeof me.data === 'string') {
        let m; try { m = JSON.parse(me.data); } catch (err) { return; }
        if (m.kind === 'meta') {
          if (m.size > MAX_BYTES) { recvError('The sender is offering a file larger than the ' + fmtBytes(MAX_BYTES) + ' limit.'); cleanup(); return; }
          meta = m; showRecvStage('live', { meta });
        } else if (m.kind === 'done') { finishDownload(); }
        return;
      }
      chunks.push(me.data); received += me.data.byteLength;
      if (meta) {
        const secs = (performance.now() - t0) / 1000; const rate = secs > 0 ? received / secs : 0;
        prog.set(received, meta.size, fmtBytes(received) + ' / ' + fmtBytes(meta.size) + '  ·  ' + ((received / meta.size) * 100).toFixed(0) + '%  ·  ' + fmtBytes(rate) + '/s');
        if (received >= meta.size) finishDownload();
      }
    };
  };

  function finishDownload() {
    if (!meta || received < meta.size || RECV_DONE) return; RECV_DONE = true;
    const blob = new Blob(chunks, { type: meta.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = meta.name || 'download'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    prog.finish('Received ' + esc(meta.name) + ' — ' + fmtBytes(meta.size) + '. Saved to your downloads.');
    showRecvStage('done', { meta, url, blob });
    chunks.length = 0;
  }

  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'offer') {
      await pc.setRemoteDescription(m.sdp); haveRemote = true;
      for (const c of pending.splice(0)) try { await pc.addIceCandidate(c); } catch (e) {}
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
    } else if (m.type === 'ice' && m.candidate) { if (haveRemote) { try { await pc.addIceCandidate(m.candidate); } catch (e) {} } else pending.push(m.candidate); }
    else if (m.type === 'peer-left' && !meta) recvError('The sender disconnected before the transfer started.');
  };
  ws.onerror = () => recvError('Lost the connection to the pairing server.');
}

/* ========================================================================== UI WIRING === */
let SEND_SESSION = null, RECV_SESSION = null, RECV_DONE = false;

function setMode(mode) {
  for (const m of ['send', 'receive']) {
    $('tab-' + m).classList.toggle('is-active', m === mode);
    $('tab-' + m).setAttribute('aria-selected', m === mode ? 'true' : 'false');
    $('panel-' + m).hidden = m !== mode;
  }
  try { history.replaceState(null, '', '#' + mode); } catch (e) {}
}

function showSendStage(stage, { file, code } = {}) {
  $('sendPick').hidden = stage !== 'pick';
  $('sendActive').hidden = stage === 'pick';
  $('sendErr').hidden = true;
  if (stage === 'pick') { if (SEND_SESSION) { SEND_SESSION(); SEND_SESSION = null; } return; }
  $('sendFileName').textContent = file.name;
  $('sendFileSize').textContent = fmtBytes(file.size);
  $('sendCode').textContent = code;
  const statuses = {
    wait: 'Waiting for your friend to enter the code…',
    live: 'Connected — sending directly, device to device.',
    done: 'Done. The file was delivered peer-to-peer.',
  };
  $('sendStatus').textContent = statuses[stage] || '';
  $('sendStatus').className = 'send-status is-' + stage;
  $('sendProgWrap').hidden = stage === 'wait';
  $('sendDoneRow').hidden = stage !== 'done';
}
function sendError(msg) { $('sendErr').hidden = false; $('sendErr').textContent = msg; $('sendActive').hidden = true; $('sendPick').hidden = false; if (SEND_SESSION) { SEND_SESSION(); SEND_SESSION = null; } }

function showRecvStage(stage, { code, meta } = {}) {
  $('recvEnter').hidden = stage === 'live' || stage === 'done';
  $('recvActive').hidden = stage === 'connect-hidden';
  $('recvErr').hidden = true;
  if (stage === 'connect') { $('recvActive').hidden = false; $('recvStatus').textContent = 'Connecting with code ' + code + '…'; $('recvFileRow').hidden = true; $('recvProgWrap').hidden = true; $('recvDoneRow').hidden = true; return; }
  if (stage === 'live') {
    $('recvActive').hidden = false; $('recvFileRow').hidden = false;
    $('recvFileName').textContent = meta.name; $('recvFileSize').textContent = fmtBytes(meta.size);
    $('recvStatus').textContent = 'Connected — receiving directly, device to device.';
    $('recvProgWrap').hidden = false; $('recvDoneRow').hidden = true;
  }
  if (stage === 'done') {
    $('recvActive').hidden = false; $('recvStatus').textContent = 'Done.';
    $('recvDoneRow').hidden = false; $('recvProgWrap').hidden = false;
  }
}
function recvError(msg) { $('recvErr').hidden = false; $('recvErr').textContent = msg; $('recvActive').hidden = true; $('recvEnter').hidden = false; if (RECV_SESSION) { RECV_SESSION(); RECV_SESSION = null; } }

function initSendPicker() {
  const drop = $('sendDrop'), input = $('sendFile');
  const pick = (f) => { if (f) { RECV_DONE = false; startSend(f); } };
  $('sendBrowse').addEventListener('click', () => input.click());
  input.addEventListener('change', () => pick(input.files[0]));
  drop.addEventListener('click', (e) => { if (e.target.closest('button')) return; input.click(); });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-drag'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); if (t === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('is-drag'); }));
  drop.addEventListener('drop', (e) => pick(e.dataTransfer.files[0]));
}

function main() {
  $('tab-send').addEventListener('click', () => setMode('send'));
  $('tab-receive').addEventListener('click', () => setMode('receive'));
  initSendPicker();
  $('sendReset').addEventListener('click', () => showSendStage('pick'));
  $('copyCode').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('sendCode').textContent); $('copyCode').textContent = 'Copied'; setTimeout(() => $('copyCode').textContent = 'Copy code', 1500); } catch (e) {}
  });
  const recvForm = $('recvForm');
  recvForm.addEventListener('submit', (e) => { e.preventDefault(); RECV_DONE = false; startReceive($('recvCode').value); });
  $('recvCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); });
  $('recvReset').addEventListener('click', () => { if (RECV_SESSION) { RECV_SESSION(); RECV_SESSION = null; } RECV_DONE = false; $('recvCode').value = ''; showRecvStage('connect-hidden'); $('recvActive').hidden = true; $('recvEnter').hidden = false; });

  showSendStage('pick');
  $('recvActive').hidden = true;
  const start = (location.hash || '').replace('#', '');
  setMode(start === 'receive' ? 'receive' : 'send');

  if (!('RTCPeerConnection' in window)) { sendError('Your browser does not support WebRTC, which this tool needs.'); }
}
document.addEventListener('DOMContentLoaded', main);
