/* Responsible-use gate for sensitive tools (watermark remover, PDF protect/unlock).
 * Shows a consent note + access password before the tool can be used.
 * NOTE: this is a client-side deterrent/agreement, not hard security — real enforcement
 * needs a backend. The password and consent are remembered for the browser session only. */
(function () {
  'use strict';
  const PASSWORD = 'BhaskarBarot';
  const KEY = 'bs_consent_v1';
  function granted() { try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function grant() { try { sessionStorage.setItem(KEY, '1'); } catch (e) {} }

  function el(tag, style, text) { const n = document.createElement(tag); if (style) Object.assign(n.style, style); if (text != null) n.textContent = text; return n; }

  function modal(toolName) {
    return new Promise((resolve) => {
      const ov = el('div', {
        position: 'fixed', inset: '0', zIndex: '9999', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(8,8,12,0.78)', backdropFilter: 'blur(3px)', padding: '20px'
      });
      const box = el('div', {
        maxWidth: '460px', width: '100%', background: '#17171c', color: '#eee', border: '1px solid #2c2c36',
        borderRadius: '18px', padding: '26px 24px', boxShadow: '0 24px 60px rgba(0,0,0,.5)', fontFamily: 'Urbanist, system-ui, sans-serif'
      });
      const lock = el('div', { fontSize: '30px', marginBottom: '6px' }, '🔐');
      const h = el('h2', { margin: '0 0 10px', fontSize: '21px', fontWeight: '800' }, 'Responsible-use agreement');
      const sub = el('p', { margin: '0 0 12px', fontSize: '14px', color: '#b7b7c2', lineHeight: '1.55' },
        'You’re about to use ' + (toolName || 'this tool') + '. It can change, remove or unlock content in your files.');
      const terms = el('p', { margin: '0 0 14px', fontSize: '13.5px', color: '#b7b7c2', lineHeight: '1.6' },
        'Use it only on content you own or are allowed to edit. Do not use it to remove watermarks, copyright marks or protection from content that isn’t yours, or in any way that breaks privacy, copyright or the law. You take full responsibility for how you use it.');
      const chkWrap = el('label', { display: 'flex', gap: '9px', alignItems: 'flex-start', fontSize: '13.5px', color: '#ddd', margin: '0 0 14px', cursor: 'pointer', lineHeight: '1.45' });
      const chk = el('input'); chk.type = 'checkbox'; chk.className = 'cg-chk'; Object.assign(chk.style, { width: '18px', height: '18px', marginTop: '1px', accentColor: '#7c5cff', flex: 'none' });
      chkWrap.appendChild(chk); chkWrap.appendChild(el('span', null, 'I own this content or have permission, and I agree to use it responsibly and lawfully.'));
      const pwLabel = el('div', { fontSize: '12.5px', fontWeight: '700', color: '#b7b7c2', margin: '0 0 6px' }, 'Access password');
      const pw = el('input'); pw.type = 'password'; pw.autocomplete = 'off'; pw.className = 'cg-pw'; pw.placeholder = 'Enter the access password';
      Object.assign(pw.style, { width: '100%', boxSizing: 'border-box', background: '#0f0f14', color: '#fff', border: '1px solid #33333f', borderRadius: '10px', padding: '11px 12px', fontSize: '15px' });
      const err = el('p', { color: '#ff6b6b', fontSize: '13px', fontWeight: '600', margin: '10px 0 0', minHeight: '16px' }, '');
      const row = el('div', { display: 'flex', gap: '10px', marginTop: '16px' });
      const cancel = el('button', { flex: '1', padding: '11px', borderRadius: '10px', border: '1px solid #33333f', background: 'transparent', color: '#ccc', fontWeight: '700', cursor: 'pointer' }, 'Cancel');
      const go = el('button', { flex: '2', padding: '11px', borderRadius: '10px', border: '0', background: '#7c5cff', color: '#fff', fontWeight: '800', cursor: 'pointer' }, 'Agree & continue');
      cancel.type = 'button'; go.type = 'button'; go.className = 'cg-go'; cancel.className = 'cg-cancel';
      row.appendChild(cancel); row.appendChild(go);
      box.append(lock, h, sub, terms, chkWrap, pwLabel, pw, err, row);
      ov.className = 'cg-overlay'; ov.appendChild(box); document.body.appendChild(ov);
      setTimeout(() => pw.focus(), 50);

      function close(result) { ov.remove(); resolve(result); }
      function submit() {
        if (!chk.checked) { err.textContent = 'Please tick the agreement box first.'; return; }
        if (pw.value !== PASSWORD) { err.textContent = 'Incorrect password.'; pw.select(); return; }
        grant(); close(true);
      }
      cancel.addEventListener('click', () => close(false));
      go.addEventListener('click', submit);
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      ov.addEventListener('click', (e) => { if (e.target === ov) close(false); });
    });
  }

  window.ConsentGate = {
    granted,
    require: function (toolName) { return granted() ? Promise.resolve(true) : modal(toolName); }
  };
})();
