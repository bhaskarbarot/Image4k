/* Hash Generator — MD5 / SHA-1 / SHA-256 / SHA-512 for text and files of any size. */
import { h, editor, msgBox, seg, checkbox, primary, btn, toolbar, store, debounce, toast, download, pickFile, formatBytes, copyText, card, note, tabs, clear } from '../ui.js';
import { ALGORITHMS, INSECURE, hashText, hashBlob, digestToString, normalizeChecksum, algForLength, WEBCRYPTO_MAX } from '../lib/hash.js';

export function mount(root) {
  const st = store.get('hash-generator', { tab: 'text', format: 'hex', algs: ALGORITHMS.slice() });
  const save = () => store.set('hash-generator', st);
  const msg = msgBox();
  let lastResults = null; // { source: 'text'|'file', name, digests: {alg: Uint8Array} }
  let abort = null;

  const algBoxes = ALGORITHMS.map((a) => {
    const c = checkbox(a, st.algs.includes(a), () => { st.algs = ALGORITHMS.filter((x, i) => algBoxes[i].input.checked); save(); rerun(); });
    return c;
  });
  const fmt = seg([['hex', 'hex'], ['HEX', 'HEX'], ['base64', 'Base64']], st.format, (v) => { st.format = v; save(); render(); }, 'Output format');
  const expect = h('input', { class: 'dt-input hash-expect', placeholder: 'Paste an expected checksum to compare (hex or Base64)…', attrs: { 'aria-label': 'Expected checksum', spellcheck: 'false' } });
  expect.addEventListener('input', () => render());

  const results = h('div', { class: 'hash-results', attrs: { 'aria-live': 'polite' } });
  function render() {
    clear(results);
    if (!lastResults) { results.appendChild(note(st.tab === 'text' ? 'Type text above — hashes update as you type.' : 'Choose or drop a file to hash it.')); return; }
    const want = expect.value.trim() ? normalizeChecksum(expect.value) : null;
    let matched = null;
    const tbody = h('tbody');
    for (const alg of ALGORITHMS) {
      const d = lastResults.digests[alg];
      if (!d) continue;
      const val = digestToString(d, st.format);
      const hexv = digestToString(d, 'hex');
      const isMatch = want && want === hexv;
      if (isMatch) matched = alg;
      tbody.appendChild(h('tr', { class: isMatch ? 'hash-match' : '' },
        h('th', { attrs: { scope: 'row' } }, alg, INSECURE.has(alg) ? h('span', { class: 'dt-badge is-warn hash-weak', title: 'Broken for security purposes' }, 'not secure') : null),
        h('td', { class: 'mono hash-val', dataset: { alg } }, val),
        h('td', null, btn('Copy', (e) => copyText(val, e.currentTarget), 'dt-mini', { 'aria-label': 'Copy ' + alg }))));
    }
    results.appendChild(h('div', { class: 'dt-table-wrap' }, h('table', { class: 'dt-table hash-table' }, tbody)));
    if (want === null && expect.value.trim()) results.appendChild(h('div', { class: 'dt-msg is-warn' }, 'The expected value is not a hex or Base64 checksum.'));
    else if (want) {
      if (matched) results.appendChild(h('div', { class: 'dt-msg is-ok' }, h('strong', null, `✓ Match — the ${matched} checksum is identical.`)));
      else {
        const guess = algForLength(want.length);
        results.appendChild(h('div', { class: 'dt-msg is-err' }, h('strong', null, '✕ No match.'),
          h('div', { class: 'dt-msg-detail' }, guess ? (lastResults.digests[guess] ? `It looks like a ${guess} checksum, but it differs — the data is not identical.` : `It looks like a ${guess} checksum — enable ${guess} above to compare.`) : 'Its length does not match MD5, SHA-1, SHA-256 or SHA-512.')));
      }
    }
  }

  /* ---- text ---- */
  const input = editor({ label: 'Text (hashed as UTF-8)', placeholder: 'Type or paste text…', paste: true, clear: true, sample: 'The quick brown fox jumps over the lazy dog', rows: 6 });
  let textToken = 0;
  async function hashTextNow() {
    const token = ++textToken;
    const src = input.get();
    const algs = st.algs.length ? st.algs : [];
    if (!algs.length) { lastResults = null; render(); msg.warn('Choose at least one algorithm.'); return; }
    msg.hide();
    const digests = {};
    for (const a of algs) digests[a] = await hashText(a, src);
    if (token !== textToken) return;
    lastResults = { source: 'text', name: '-', digests };
    render();
  }
  const live = debounce(hashTextNow, 150);
  input.ta.addEventListener('input', live);

  /* ---- file ---- */
  const prog = h('div', { class: 'hash-prog', hidden: true }, h('div', { class: 'hash-bar' }, h('i')), h('span'));
  const cancelBtn = btn('Cancel', () => abort && abort.abort(), 'dt-mini', { 'data-act': 'cancel' });
  prog.appendChild(cancelBtn);
  const fileInfo = h('div', { class: 'dt-note' });
  let lastFile = null;
  async function hashFileNow(f) {
    if (!f) return;
    lastFile = f;
    const algs = st.algs.length ? st.algs : [];
    if (!algs.length) { msg.warn('Choose at least one algorithm.'); return; }
    if (abort) abort.abort();
    const ctrl = (abort = new AbortController());
    msg.hide(); lastResults = null; render();
    fileInfo.textContent = `${f.name} · ${formatBytes(f.size)}` + (f.size > WEBCRYPTO_MAX ? ' · large file: streamed in 4 MB chunks' : '');
    prog.hidden = false;
    const bar = prog.querySelector('i'), label = prog.querySelector('span');
    const t0 = performance.now();
    try {
      const digests = await hashBlob(f, algs, {
        signal: ctrl.signal,
        onProgress: (p) => { bar.style.width = (p * 100).toFixed(1) + '%'; label.textContent = `Hashing… ${(p * 100).toFixed(0)}%`; },
      });
      if (ctrl !== abort) return;
      lastResults = { source: 'file', name: f.name, digests };
      label.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(2)} s`;
      render();
    } catch (e) {
      if (e.cancelled) { label.textContent = 'Cancelled'; toast('Hashing cancelled', 'warn'); }
      else msg.error('Could not hash the file', e.message);
    } finally {
      if (ctrl === abort) abort = null;
    }
  }
  const drop = h('div', { class: 'b64-drop hash-drop', tabindex: '0', attrs: { role: 'button', 'aria-label': 'Choose a file to hash' } },
    h('strong', null, 'Drop a file here or click to choose'), h('span', null, 'Any size — read in chunks, never uploaded'));
  const choose = async () => hashFileNow(await pickFile());
  drop.addEventListener('click', choose);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-drag'); hashFileNow(e.dataTransfer.files[0]); });
  const filePane = h('div', { class: 'hash-pane' }, drop, fileInfo, prog);
  const textPane = h('div', { class: 'hash-pane' }, input.el);

  function rerun() { if (st.tab === 'text') hashTextNow(); else if (lastFile) hashFileNow(lastFile); }

  const t = tabs([['text', 'Text'], ['file', 'File']], st.tab, (id) => {
    st.tab = id; save(); textPane.hidden = id !== 'text'; filePane.hidden = id !== 'file';
    lastResults = null; render(); if (id === 'text') hashTextNow();
  });
  textPane.hidden = st.tab !== 'text'; filePane.hidden = st.tab !== 'file';

  const dlBtn = btn('Download results', () => {
    if (!lastResults) return toast('Nothing to download yet', 'err');
    const name = lastResults.source === 'file' ? lastResults.name : '-';
    const lines = [];
    for (const alg of ALGORITHMS) if (lastResults.digests[alg]) lines.push(`# ${alg}`, `${digestToString(lastResults.digests[alg], 'hex')}  ${name}`, '');
    download((lastResults.source === 'file' ? lastResults.name : 'text') + '.checksums.txt', lines.join('\n'));
  }, undefined, { 'data-act': 'download' });

  root.append(
    t.el,
    toolbar(...algBoxes, fmt, primary('Hash', rerun, { 'data-act': 'run' }), dlBtn),
    textPane, filePane,
    msg.el,
    card('Results', results, expect),
    h('div', { class: 'dt-msg is-warn hash-warn' }, h('strong', null, 'MD5 and SHA-1 are cryptographically broken.'),
      h('div', { class: 'dt-msg-detail' }, 'Use them only to detect accidental corruption or to match legacy checksums — never for passwords, signatures or tamper-proof integrity. For passwords use a slow hash (Argon2, bcrypt, scrypt); for integrity use SHA-256 or SHA-512.')),
    note('SHA hashes use your browser’s Web Crypto engine; MD5 and files over 256 MB are streamed with hash-wasm. Nothing is uploaded.'),
  );
  render();
  if (st.tab === 'text') hashTextNow();
  return () => { live.cancel(); if (abort) abort.abort(); };
}
