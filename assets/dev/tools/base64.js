/* Base64 Encode / Decode — UTF-8 text and files, standard + URL-safe alphabets. */
import { h, editor, output, msgBox, seg, checkbox, primary, btn, toolbar, grid2, store, debounce, toast, download, pickFile, formatBytes, copyText, card, note } from '../ui.js';
import { bytesToBase64, base64ToBytes, utf8Encode, utf8Decode, isProbablyText, sniffType, bytesToHex } from '../lib/encode.js';

const MAX_FILE = 100 * 1024 * 1024;
const PREVIEW = 200000;

export function mount(root) {
  const st = store.get('base64', { dir: 'encode', alphabet: 'standard', wrap: false, strict: false });
  const save = () => store.set('base64', st);
  let decodedBytes = null; // last decode result (for "download as file")
  let fullOutput = '';     // full text (output panel may show a preview)

  const msg = msgBox();
  const input = editor({ label: 'Input', placeholder: 'Type or paste text to encode…', paste: true, clear: true, sample: () => (st.dir === 'encode' ? 'Hello, world! 👋 Zoë · 日本語' : 'SGVsbG8sIHdvcmxkISDwn5GLIFpvw6sgwrcg5pel5pys6Kqe') });
  const out = output({ label: 'Output', copy: false, empty: 'The result appears here as you type.' });
  const copyBtn = btn('Copy', (e) => { if (!fullOutput) return toast('Nothing to copy yet', 'err'); copyText(fullOutput, e.currentTarget); }, 'dt-mini');
  const dlBtn = btn('Download', () => {
    if (st.dir === 'decode' && decodedBytes) { const t = sniffType(decodedBytes); return download('decoded.' + t.ext, new Blob([decodedBytes], { type: t.mime })); }
    if (!fullOutput) return toast('Nothing to download yet', 'err');
    download(st.dir === 'encode' ? 'encoded.b64.txt' : 'decoded.txt', fullOutput);
  }, 'dt-mini');
  out.actions.append(copyBtn, dlBtn);

  const dir = seg([['encode', 'Encode'], ['decode', 'Decode']], st.dir, (v) => { st.dir = v; save(); refreshUi(); run(); }, 'Direction');
  const alpha = seg([['standard', 'Standard  + /'], ['url', 'URL-safe  - _']], st.alphabet, (v) => { st.alphabet = v; save(); run(); }, 'Alphabet');
  const wrap = checkbox('Wrap lines at 76', st.wrap, (v) => { st.wrap = v; save(); run(); });
  const strict = checkbox('Strict decoding', st.strict, (v) => { st.strict = v; save(); run(); });
  const binNote = h('div', { class: 'b64-bin', hidden: true });

  function setOut(text) {
    fullOutput = text;
    out.set(text.length > PREVIEW ? text.slice(0, PREVIEW) + `\n… (${formatBytes(text.length)} total — use Copy or Download for the full result)` : text);
  }

  function run() {
    msg.hide(); binNote.hidden = true; decodedBytes = null;
    const src = input.get();
    if (!src) { setOut(''); return; }
    if (st.dir === 'encode') {
      setOut(bytesToBase64(utf8Encode(src), { urlSafe: st.alphabet === 'url', wrap: wrap.input.checked ? 76 : 0 }));
      return;
    }
    try {
      const r = base64ToBytes(src, { strict: strict.input.checked });
      decodedBytes = r.bytes;
      if (r.notes.length) msg.info('Decoded (lenient mode)', r.notes.join(' '));
      if (isProbablyText(r.bytes)) setOut(utf8Decode(r.bytes));
      else {
        const t = sniffType(r.bytes);
        setOut('');
        binNote.hidden = false;
        binNote.replaceChildren(
          h('strong', null, `Binary data: ${t.mime} · ${formatBytes(r.bytes.length)}`),
          h('div', { class: 'dt-mono b64-hex' }, bytesToHex(r.bytes.subarray(0, 48), { sep: ' ' }) + (r.bytes.length > 48 ? ' …' : '')),
          primary(`Download .${t.ext} file`, () => download('decoded.' + t.ext, new Blob([r.bytes], { type: t.mime })), { 'data-act': 'download-file' }),
        );
      }
    } catch (e) {
      setOut('');
      msg.error('Invalid Base64 — ' + (e.reason || e.message), e.pos != null ? contextAt(src, e.pos) : '');
      if (e.pos != null) input.ta.setSelectionRange(e.pos, e.pos + 1);
    }
  }
  function contextAt(src, pos) {
    const a = Math.max(0, pos - 20), seg = src.slice(a, pos + 20).replace(/\n/g, '⏎');
    return `Position ${pos + 1}: …${seg}…\n${' '.repeat(pos - a + 15)}^`;
  }
  const live = debounce(run, 200);
  input.ta.addEventListener('input', live);

  function refreshUi() {
    input.ta.placeholder = st.dir === 'encode' ? 'Type or paste text to encode…' : 'Paste Base64 to decode (whitespace and missing = are fine)…';
    wrap.hidden = st.dir !== 'encode';
    strict.hidden = st.dir !== 'decode';
  }
  const swap = btn('⇄ Swap', () => {
    if (!fullOutput) return;
    const o = fullOutput;
    st.dir = st.dir === 'encode' ? 'decode' : 'encode'; save(); dir.set(st.dir); refreshUi();
    input.set(o); run();
  }, undefined, { 'data-act': 'swap', title: 'Use the output as the new input and switch direction' });

  /* ---- file → Base64 ---- */
  const fileInfo = h('div', { class: 'dt-note' }, 'No file selected.');
  const dataUri = checkbox('Output as data: URI', false);
  const fileOut = output({ label: 'File as Base64', copy: false, empty: 'Choose a file to encode it.' });
  let fileB64 = '', fileName = '';
  fileOut.actions.append(
    btn('Copy', (e) => { if (!fileB64) return toast('Choose a file first', 'err'); copyText(fileB64, e.currentTarget); }, 'dt-mini'),
    btn('Download', () => { if (!fileB64) return toast('Choose a file first', 'err'); download(fileName + '.b64.txt', fileB64); }, 'dt-mini'),
  );
  async function encodeFile(f) {
    if (!f) return;
    if (f.size > MAX_FILE) { toast(`File is too large (${formatBytes(f.size)}); the limit is ${formatBytes(MAX_FILE)}.`, 'err'); return; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const t = sniffType(bytes);
    const mime = f.type || t.mime;
    const b64 = bytesToBase64(bytes, { urlSafe: st.alphabet === 'url' && !dataUri.input.checked, wrap: 0 });
    fileB64 = dataUri.input.checked ? `data:${mime};base64,${b64}` : b64; fileName = f.name;
    fileInfo.textContent = `${f.name} · ${formatBytes(f.size)} · ${mime} → ${formatBytes(fileB64.length)} of Base64`;
    fileOut.set(fileB64.length > PREVIEW ? fileB64.slice(0, PREVIEW) + `\n… (${formatBytes(fileB64.length)} total — use Copy or Download)` : fileB64);
  }
  let lastFile = null;
  dataUri.input.addEventListener('change', () => lastFile && encodeFile(lastFile));
  const drop = h('div', { class: 'b64-drop', tabindex: '0', attrs: { role: 'button', 'aria-label': 'Choose a file to encode' } }, h('strong', null, 'Drop a file here or click to choose'), h('span', null, 'Any type, up to 100 MB · stays on your device'));
  const choose = async () => { const f = await pickFile(); if (f) { lastFile = f; encodeFile(f); } };
  drop.addEventListener('click', choose);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-drag'); const f = e.dataTransfer.files[0]; if (f) { lastFile = f; encodeFile(f); } });

  root.append(
    toolbar(dir, alpha, wrap, strict, primary('Convert', run, { 'data-act': 'run' }), swap),
    msg.el,
    grid2(input.el, h('div', { class: 'b64-outcol' }, out.el, binNote)),
    card('File → Base64', h('div', { class: 'b64-file' }, drop, h('div', { class: 'b64-file-opts' }, dataUri, fileInfo)), fileOut.el),
    note('Base64 represents bytes as text — it is an encoding, not encryption. Text is converted as UTF-8, so emoji and every language round-trip exactly. Decoded binary data (images, PDFs…) is detected and offered as a download. Nothing leaves your browser.'),
  );
  refreshUi();
  return () => live.cancel();
}
