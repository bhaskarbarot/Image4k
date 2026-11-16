/* JWT Generator — sign tokens with Web Crypto (HS/RS/PS/ES 256/384/512). Keys never leave the browser. */
import { h, editor, msgBox, select, primary, btn, toolbar, store, card, note, copyText, download, grid2, field, toast, clear } from '../ui.js';
import { ALGS, signJwt, generateKey, decodeJwt } from '../lib/jwt.js';
import { reformat } from '../lib/json.js';
import { uuidv4 } from '../lib/uuid.js';

export function mount(root) {
  const st = store.get('jwt-generator', { alg: 'HS256', enc: 'utf8' });
  const save = () => store.set('jwt-generator', st);
  const msg = msgBox();
  const now = () => Math.floor(Date.now() / 1000);

  const algSel = select(ALGS.map((a) => [a, a + ' — ' + ({ HS: 'HMAC + SHA', RS: 'RSA PKCS#1 v1.5', PS: 'RSA-PSS', ES: 'ECDSA' }[a.slice(0, 2)]) + '-' + a.slice(2)]), st.alg, (v) => { st.alg = v; save(); syncHeader(); refreshKeyUi(); });
  const header = editor({ label: 'Header', rows: 5, meta: false, value: JSON.stringify({ alg: st.alg, typ: 'JWT' }, null, 2) });
  const payload = editor({ label: 'Payload (claims)', rows: 10, meta: false, value: JSON.stringify({ sub: '1234567890', name: 'Jane Developer', iat: now(), exp: now() + 3600 }, null, 2) });

  function readJson(ed, name) {
    try { return JSON.parse(reformat(ed.get(), { indent: 0 }).text); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  function syncHeader() {
    try { const hd = readJson(header, 'Header'); hd.alg = st.alg; header.set(JSON.stringify(hd, null, 2)); } catch (e) { /* user is mid-edit; Sign reports errors */ }
  }
  function setClaim(k, v) {
    try { const p = readJson(payload, 'Payload'); if (v === undefined) delete p[k]; else p[k] = v; payload.set(JSON.stringify(p, null, 2)); msg.hide(); } catch (e) { msg.error(e.message); }
  }
  const helpers = toolbar(
    btn('iat = now', () => setClaim('iat', now()), 'dt-mini'),
    btn('exp = +1 hour', () => setClaim('exp', now() + 3600), 'dt-mini'),
    btn('exp = +1 day', () => setClaim('exp', now() + 86400), 'dt-mini'),
    btn('exp = +30 days', () => setClaim('exp', now() + 30 * 86400), 'dt-mini'),
    btn('nbf = now', () => setClaim('nbf', now()), 'dt-mini'),
    btn('jti = new UUID', () => setClaim('jti', uuidv4()), 'dt-mini'),
  );

  /* ---- key material ---- */
  const secret = h('input', { class: 'dt-input jwt-secret', type: 'text', placeholder: 'Your HMAC secret', attrs: { 'aria-label': 'Secret', spellcheck: 'false', autocomplete: 'off' } });
  const encSel = select([['utf8', 'Text (UTF-8)'], ['base64', 'Base64 / Base64url'], ['hex', 'Hex']], st.enc, (v) => { st.enc = v; save(); });
  const secretWarn = h('p', { class: 'dt-note is-warn', hidden: true });
  secret.addEventListener('input', checkSecret);
  function checkSecret() {
    const need = { HS256: 32, HS384: 48, HS512: 64 }[st.alg];
    const len = st.enc === 'utf8' ? new TextEncoder().encode(secret.value).length : st.enc === 'hex' ? Math.floor(secret.value.replace(/\s/g, '').length / 2) : Math.floor(secret.value.replace(/[^A-Za-z0-9+/_-]/g, '').length * 3 / 4);
    secretWarn.hidden = !secret.value || len >= need;
    secretWarn.textContent = `RFC 7518 recommends a secret of at least ${need} bytes for ${st.alg} (this one is ${len}). Use “Generate secret” for a strong one.`;
  }
  const privKey = h('textarea', { class: 'dt-code jwt-key', placeholder: '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n\n(or a private JWK — or click “Generate key pair”)', attrs: { rows: '7', spellcheck: 'false', 'aria-label': 'Private key' } });
  const pubOut = h('div', { class: 'jwt-pub' });
  const hsBox = h('div', { class: 'jwt-keybox' }, toolbar(field('Secret', secret), field('Secret format', encSel),
    btn('Generate secret', async () => { const k = await generateKey(st.alg); secret.value = k.secret; st.enc = 'base64'; encSel.value = 'base64'; save(); checkSecret(); toast('Random secret generated'); }, undefined, { 'data-act': 'gen-secret' })), secretWarn);
  const asymBox = h('div', { class: 'jwt-keybox' }, privKey,
    toolbar(btn('Generate key pair', genPair, undefined, { 'data-act': 'gen-keys' }), h('span', { class: 'dt-note' }, 'RSA 2048-bit or the algorithm’s EC curve, created in your browser.')), pubOut);
  async function genPair() {
    try {
      const k = await generateKey(st.alg);
      privKey.value = k.privatePem;
      clear(pubOut);
      const pubJwk = JSON.stringify(k.publicJwk, null, 2);
      pubOut.append(
        h('div', { class: 'dt-panel-head' }, h('span', { class: 'dt-panel-title' }, 'Public key — share this to let others verify'), h('div', { class: 'dt-actions' },
          btn('Copy PEM', (e) => copyText(k.publicPem, e.currentTarget), 'dt-mini'), btn('Copy JWK', (e) => copyText(pubJwk, e.currentTarget), 'dt-mini'),
          btn('Download public.pem', () => download('public.pem', k.publicPem, 'application/x-pem-file'), 'dt-mini'),
          btn('Download private.pem', () => download('private.pem', k.privatePem, 'application/x-pem-file'), 'dt-mini'))),
        h('pre', { class: 'dt-pre jwt-pem' }, k.publicPem));
      toast(st.alg + ' key pair generated');
    } catch (e) { msg.error('Key generation failed', e.message); }
  }
  function refreshKeyUi() {
    const hs = st.alg.startsWith('HS');
    hsBox.hidden = !hs; asymBox.hidden = hs; checkSecret();
  }

  /* ---- output ---- */
  const tokenOut = h('div', { class: 'jwt-parts jwt-out', attrs: { 'aria-live': 'polite', tabindex: '0' } }, h('span', { class: 'dt-empty' }, 'Your signed token appears here.'));
  let token = '';
  const copyTok = btn('Copy token', (e) => { if (!token) return toast('Sign a token first', 'err'); copyText(token, e.currentTarget); }, undefined, { 'data-act': 'copy' });

  async function sign() {
    msg.hide();
    try {
      const hd = readJson(header, 'Header');
      if (!hd || typeof hd !== 'object' || Array.isArray(hd)) throw new Error('Header must be a JSON object');
      if (hd.alg && hd.alg !== st.alg) msg.info(`Header alg "${hd.alg}" was replaced with ${st.alg}.`);
      hd.alg = st.alg;
      const pl = readJson(payload, 'Payload');
      const key = st.alg.startsWith('HS') ? secret.value : privKey.value.trim();
      if (!key) throw new Error(st.alg.startsWith('HS') ? 'Enter a secret (or click “Generate secret”).' : 'Paste a private key (or click “Generate key pair”).');
      token = await signJwt(hd, pl, key, { encoding: st.enc });
      const [a, b, c] = token.split('.');
      tokenOut.replaceChildren(h('span', { class: 'jwt-h' }, a), '.', h('span', { class: 'jwt-p' }, b), '.', h('span', { class: 'jwt-s' }, c));
      tokenOut.dataset.token = token;
      const d = decodeJwt(token);
      msg.ok(`Signed with ${st.alg}`, `${token.length} characters · payload has ${Object.keys(d.payload || {}).length} claims.`);
    } catch (e) { token = ''; msg.error('Could not sign', e.message); }
  }

  root.append(
    toolbar(field('Algorithm', algSel), primary('Sign token', sign, { 'data-act': 'sign' }), copyTok),
    msg.el,
    grid2(header.el, h('div', null, payload.el, helpers)),
    card('Signing key', hsBox, asymBox),
    card('Token', tokenOut),
    h('div', { class: 'dt-msg is-info' }, h('strong', null, 'Handle tokens and keys like passwords.'),
      h('div', { class: 'dt-msg-detail' }, 'Signing uses your browser’s Web Crypto API — no custom cryptography, nothing is sent anywhere. A JWT is signed, not encrypted: never put secrets in its payload. Keep private keys and HMAC secrets out of source control and rotate them if exposed.')),
    note('ES256/384/512 signatures are produced in the raw r‖s form required by JWS (RFC 7518).'),
  );
  refreshKeyUi();
  syncHeader();
}
