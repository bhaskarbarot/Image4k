/* JWT Decoder — decode header/payload, explain claims and times; optional real signature verification. */
import { h, editor, msgBox, seg, select, primary, btn, toolbar, store, debounce, card, note, copyText, clear, highlightJSON, grid2 } from '../ui.js';
import { decodeJwt, claimStatus, verifyJwt, CLAIM_INFO } from '../lib/jwt.js';

export const SAMPLE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ilpvw6sgRXhhbXBsZSIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc2MzI4MDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.3_ZC0ToKfwZUkthe7LysrZ8g6d_HY7Ek2eTxLfuvT2s';
const SAMPLE_SECRET = 'bhaskar-solution-demo-secret';

export function mount(root) {
  const msg = msgBox();
  const input = editor({ label: 'Encoded token', placeholder: 'Paste a JWT (eyJ…) — “Bearer ” prefix is fine', paste: true, clear: true, sample: SAMPLE, rows: 5 });
  const parts = h('div', { class: 'jwt-parts', attrs: { 'aria-label': 'Token structure' } });
  const status = h('div', { class: 'dt-stats jwt-status', attrs: { 'aria-live': 'polite' } });
  const headerPre = h('pre', { class: 'dt-pre jwt-json', attrs: { tabindex: '0', 'aria-label': 'Header' } });
  const payloadPre = h('pre', { class: 'dt-pre jwt-json', attrs: { tabindex: '0', 'aria-label': 'Payload' } });
  const claims = h('div');
  const panel = (title, pre, getText) => h('div', { class: 'dt-panel' }, h('div', { class: 'dt-panel-head' }, h('span', { class: 'dt-panel-title' }, title),
    h('div', { class: 'dt-actions' }, btn('Copy', (e) => { const t = getText(); if (t) copyText(t, e.currentTarget); }, 'dt-mini'))), pre);
  let decoded = null;

  function render() {
    msg.hide(); clear(parts); clear(status); clear(claims); clear(headerPre); clear(payloadPre); decoded = null; verifyOut.hide();
    const src = input.get().trim();
    if (!src) { status.appendChild(h('span', { class: 'dt-note' }, 'Paste a token to decode it.')); return; }
    try { decoded = decodeJwt(src); } catch (e) {
      msg.error('Cannot decode this token', e.message);
      status.appendChild(h('span', { class: 'dt-badge is-err' }, '✕ Malformed'));
      return;
    }
    const [hs, ps, ss] = decoded.segments;
    parts.append(h('span', { class: 'jwt-h' }, hs), '.', h('span', { class: 'jwt-p' }, ps), '.', h('span', { class: 'jwt-s' }, ss || ''));
    const hj = JSON.stringify(decoded.header, null, 2), pj = JSON.stringify(decoded.payload, null, 2);
    headerPre.appendChild(highlightJSON(hj)); payloadPre.appendChild(highlightJSON(pj));
    headerPre.dataset.text = hj; payloadPre.dataset.text = pj;

    const cs = claimStatus(decoded.payload);
    const alg = String(decoded.header.alg);
    status.append(
      h('span', { class: 'dt-badge is-info' }, 'alg ' + alg),
      alg === 'none' ? h('span', { class: 'dt-badge is-err', title: 'Unsigned token — anyone can forge it' }, '⚠ Unsigned (alg: none)') : h('span', { class: 'dt-badge is-warn jwt-unverified' }, 'Signature NOT verified'),
      cs.expired ? h('span', { class: 'dt-badge is-err jwt-expired' }, '✕ Expired ' + cs.times.exp.relative) : cs.times.exp ? h('span', { class: 'dt-badge is-ok' }, '✓ Not expired — expires ' + cs.times.exp.relative) : h('span', { class: 'dt-badge is-warn' }, 'No expiry'),
      cs.notYetValid ? h('span', { class: 'dt-badge is-warn' }, 'Not valid yet — nbf ' + cs.times.nbf.relative) : null,
      cs.issuedInFuture ? h('span', { class: 'dt-badge is-warn' }, 'Issued in the future (clock skew?)') : null,
    );
    if (cs.warnings.length) msg.warn('Claim warnings', cs.warnings.join('\n'));

    if (decoded.payload && typeof decoded.payload === 'object' && !Array.isArray(decoded.payload)) {
      const rows = Object.entries(decoded.payload).map(([k, v]) => {
        const t = cs.times[k];
        return h('tr', null, h('td', { class: 'mono' }, k),
          h('td', { class: 'mono' }, typeof v === 'string' ? v : JSON.stringify(v), t ? h('div', { class: 'jwt-time' }, `${t.date.toISOString()} · ${t.date.toLocaleString()} · ${t.relative}`) : null),
          h('td', null, CLAIM_INFO[k] || ''));
      });
      claims.appendChild(h('div', { class: 'dt-table-wrap' }, h('table', { class: 'dt-table' },
        h('thead', null, h('tr', null, h('th', null, 'Claim'), h('th', null, 'Value'), h('th', null, 'Meaning'))), h('tbody', null, rows))));
    }
    verifyHint();
  }
  const live = debounce(render, 150);
  input.ta.addEventListener('input', live);

  /* ---- optional verification ---- */
  const keyKind = seg([['secret', 'Shared secret (HS*)'], ['key', 'Public key — PEM / JWK (RS/PS/ES)']], 'secret', () => { keyArea.placeholder = keyKind.value === 'secret' ? 'HMAC secret' : '-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n\nor a JWK / JWK Set JSON'; encSel.hidden = keyKind.value !== 'secret'; }, 'Key type');
  const encSel = select([['utf8', 'Secret is text (UTF-8)'], ['base64', 'Secret is Base64 / Base64url'], ['hex', 'Secret is hex']], 'utf8');
  const keyArea = h('textarea', { class: 'dt-code jwt-key', placeholder: 'HMAC secret', attrs: { rows: '4', spellcheck: 'false', 'aria-label': 'Secret or public key' } });
  const verifyOut = msgBox();
  const hint = h('p', { class: 'dt-note' });
  function verifyHint() {
    if (!decoded) return;
    const a = String(decoded.header.alg || '');
    const want = a.startsWith('HS') ? 'secret' : 'key';
    if (keyKind.value !== want && !keyArea.value) { keyKind.querySelector(`[data-v="${want}"]`).click(); }
    hint.textContent = a.startsWith('HS') ? `${a}: paste the shared secret the issuer used.` : a === 'none' ? 'This token is unsigned and cannot be verified.' : `${a}: paste the issuer’s PUBLIC key (PEM, JWK or JWKS). Private keys are not needed.`;
  }
  async function verify() {
    if (!decoded) { verifyOut.error('Decode a valid token first.'); return; }
    if (!keyArea.value.trim()) { verifyOut.error('Paste the secret or public key first.'); return; }
    try {
      const r = await verifyJwt(input.get(), keyArea.value.trim(), { encoding: encSel.value });
      if (r.valid) verifyOut.ok(`✓ Signature verified (${r.alg})`, 'The token was signed with this key and has not been modified. Still check exp/nbf, issuer and audience before trusting it.');
      else verifyOut.error(`✕ Signature invalid (${r.alg})`, r.reason);
    } catch (e) { verifyOut.error('Could not verify', e.message); }
  }

  root.append(
    input.el,
    toolbar(primary('Decode', render, { 'data-act': 'decode' }), btn('Load sample', () => { input.set(SAMPLE); render(); keyArea.value = ''; }, undefined, { 'data-act': 'sample' })),
    status,
    msg.el,
    card('Structure', parts, h('p', { class: 'dt-note jwt-legend' }, h('span', { class: 'jwt-h' }, 'header'), ' . ', h('span', { class: 'jwt-p' }, 'payload'), ' . ', h('span', { class: 'jwt-s' }, 'signature'),
      ' — header and payload are only Base64url-encoded JSON (anyone can read them); the signature proves who issued the token.')),
    grid2(panel('Header', headerPre, () => headerPre.dataset.text), panel('Payload', payloadPre, () => payloadPre.dataset.text)),
    card('Claims', claims),
    card('Verify signature (optional)', hint, keyKind, keyArea, toolbar(encSel, primary('Verify', verify, { 'data-act': 'verify' })), verifyOut.el,
      h('p', { class: 'dt-note' }, `Verification uses your browser’s Web Crypto; the key never leaves this page. Demo token secret: “${SAMPLE_SECRET}”.`)),
    note('Decoding does NOT prove a token is genuine — only a successful signature check with the issuer’s key does. Never paste production secrets into tools you don’t trust; this one runs entirely offline in your browser.'),
  );
  input.set(SAMPLE);
  render();
  return () => live.cancel();
}
