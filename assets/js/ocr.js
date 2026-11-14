/* Image to Text (OCR) — Tesseract.js, fully in-browser. Nothing is uploaded.
 * Tesseract.js (Apache-2.0), self-hosted under /assets/vendor/tesseract-5.1.1/. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const V = '/assets/vendor/tesseract-5.1.1/';
  let file = null, worker = null, busy = false;

  // --- wasm SIMD support decides which core to load ---
  function simdSupported() {
    try {
      // minimal module that uses an i8x16 SIMD opcode
      return WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
    } catch (e) { return false; }
  }
  const CORE = simdSupported() ? V + 'tesseract-core-simd-lstm.wasm.js' : V + 'tesseract-core-lstm.wasm.js';

  function setProgress(frac, text) {
    $('#progress').hidden = false;
    $('#barFill').style.width = Math.round((frac || 0) * 100) + '%';
    if (text) $('#progressText').textContent = text;
  }
  function note(msg, isErr) { const n = $('#note'); n.textContent = msg || ''; n.classList.toggle('is-err', !!isErr); }

  function showImage(f) {
    file = f;
    const url = URL.createObjectURL(f);
    $('#preview').src = url;
    $('#previewBox').hidden = false;
    $('#drop').hidden = true;
    note('');
  }
  function reset() {
    file = null;
    $('#previewBox').hidden = true;
    $('#drop').hidden = false;
    $('#progress').hidden = true;
    $('#file').value = '';
  }

  // Downscale very large images a little for speed (OCR is fine up to ~2500px).
  async function prepare(f) {
    const bmp = await createImageBitmap(f);
    const max = 2600, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k >= 1) { bmp.close && bmp.close(); return f; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    return await new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
  }

  async function getWorker(lang) {
    if (worker && worker._lang === lang) return worker;
    if (worker) { try { await worker.terminate(); } catch (e) {} worker = null; }
    setProgress(0, 'Loading the recogniser…');
    const w = await Tesseract.createWorker(lang, 1, {
      workerPath: V + 'worker.min.js',
      corePath: CORE,
      langPath: V,
      logger: (m) => {
        if (m.status === 'recognizing text') setProgress(m.progress, 'Reading the image… ' + Math.round(m.progress * 100) + '%');
        else if (m.status && /load|init|download/i.test(m.status)) setProgress(m.progress || 0, 'Loading the recogniser…');
      }
    });
    w._lang = lang;
    worker = w;
    return w;
  }

  async function run() {
    if (!file || busy) return;
    busy = true;
    $('#run').disabled = true; $('#reset').disabled = true;
    note('');
    try {
      const lang = $('#lang').value || 'eng';
      const img = await prepare(file);
      const w = await getWorker(lang);
      setProgress(0, 'Reading the image…');
      const { data } = await w.recognize(img);
      const text = (data.text || '').replace(/\n{3,}/g, '\n\n').trim();
      $('#out').value = text;
      $('#copy').disabled = !text; $('#dl').disabled = !text;
      $('#progress').hidden = true;
      if (!text) note('No readable text was found in this image. A sharper, higher-contrast image usually helps.', true);
      else {
        const conf = Math.round(data.confidence || 0);
        note(`Done — ${text.split(/\s+/).filter(Boolean).length} words recognised${conf ? ' · ~' + conf + '% confidence' : ''}. Check and fix anything before copying.`);
      }
    } catch (e) {
      console.error(e);
      $('#progress').hidden = true;
      note('Could not read this image: ' + (e.message || e), true);
    } finally {
      busy = false;
      $('#run').disabled = false; $('#reset').disabled = false;
    }
  }

  function bind() {
    const input = $('#file'), pick = () => input.click();
    $('#pick').addEventListener('click', (e) => { e.stopPropagation(); pick(); });
    $('#drop').addEventListener('click', pick);
    $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    input.addEventListener('change', () => { if (input.files[0]) showImage(input.files[0]); });
    $('#run').addEventListener('click', run);
    $('#reset').addEventListener('click', reset);
    $('#copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#out').value); note('Copied to clipboard.'); }
      catch (e) { $('#out').select(); document.execCommand && document.execCommand('copy'); note('Copied.'); }
    });
    $('#dl').addEventListener('click', () => {
      const blob = new Blob([$('#out').value], { type: 'text/plain' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'extracted-text.txt';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    });
    // drag & drop
    window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('#drop').classList.add('drag'); } });
    window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#drop').classList.remove('drag'); });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault(); $('#drop').classList.remove('drag');
      const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
      if (f) showImage(f); else note('Please drop an image file.', true);
    });
    window.addEventListener('beforeunload', () => { if (worker) { try { worker.terminate(); } catch (e) {} } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
