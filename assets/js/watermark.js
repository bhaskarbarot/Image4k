/* Watermark / object remover — OpenCV.js inpainting, fully in-browser. Nothing is uploaded.
 * OpenCV.js (Apache-2.0), self-hosted under /assets/vendor/opencv-4.5.2/. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const MAX = 2600;                 // cap processing size for speed/memory
  let img = null, mask = null, disp = null;  // offscreen image canvas, mask canvas, display canvas
  let mode = 'brush', painting = false, last = null, undoStack = [], busy = false;

  function note(m, isErr) { const n = $('#hint'); n.textContent = m; n.classList.toggle('is-err', !!isErr); }

  // grow a binary mask by r pixels (separable box dilation) so edges are fully covered
  function dilate(src, w, h, r) {
    if (r <= 0) return src;
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let on = 0; for (let dx = -r; dx <= r && !on; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && src[y * w + xx]) on = 1; }
      tmp[y * w + x] = on;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let on = 0; for (let dy = -r; dy <= r && !on; dy++) { const yy = y + dy; if (yy >= 0 && yy < h && tmp[yy * w + x]) on = 1; }
      out[y * w + x] = on;
    }
    return out;
  }
  function setProgress(on, text) { $('#progress').hidden = !on; if (text) $('#progressText').textContent = text; if (on) $('#barFill').style.width = '100%'; }

  async function load(file) {
    if (window.ConsentGate && !(await window.ConsentGate.require('the Watermark Remover'))) {
      note('You need to accept the responsible-use terms (and password) to use this tool.', true);
      $('#file').value = '';
      return;
    }
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    img = document.createElement('canvas'); img.width = w; img.height = h;
    img.getContext('2d').drawImage(bmp, 0, 0, w, h); bmp.close && bmp.close();
    mask = document.createElement('canvas'); mask.width = w; mask.height = h;
    disp = $('#canvas'); disp.width = w; disp.height = h;
    undoStack = []; $('#undo').disabled = true;
    $('#startPane').hidden = true; $('#workPane').hidden = false;
    redraw();
  }

  function redraw() {
    const c = disp.getContext('2d');
    c.clearRect(0, 0, disp.width, disp.height);
    c.drawImage(img, 0, 0);
    c.drawImage(mask, 0, 0);
  }

  // display/CSS coords -> canvas pixel coords
  function toCanvas(e) {
    const r = disp.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (disp.width / r.width), y: (e.clientY - r.top) * (disp.height / r.height) };
  }
  function brushRadius() { return (+$('#brush').value) * (disp.width / disp.getBoundingClientRect().width) / 2; }

  function paintDab(x, y, r) {
    const m = mask.getContext('2d');
    m.fillStyle = 'rgba(244,63,245,0.55)';
    m.beginPath(); m.arc(x, y, r, 0, Math.PI * 2); m.fill();
  }
  function brushStroke(x, y) {
    const r = brushRadius();
    if (last) { const d = Math.hypot(x - last.x, y - last.y), n = Math.max(1, Math.ceil(d / (r * 0.4))); for (let k = 1; k <= n; k++) paintDab(last.x + (x - last.x) * k / n, last.y + (y - last.y) * k / n, r); }
    else paintDab(x, y, r);
    last = { x, y }; redraw();
  }

  // magic wand: select every pixel within tolerance of the clicked colour
  function wandSelect(x, y) {
    const w = img.width, h = img.height;
    const data = img.getContext('2d').getImageData(0, 0, w, h).data;
    const px = Math.max(0, Math.min(w - 1, Math.round(x))), py = Math.max(0, Math.min(h - 1, Math.round(y)));
    const i0 = (py * w + px) * 4, r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2];
    const tol = (+$('#tol').value) * 3.0;      // 5..90 -> distance threshold
    const tol2 = tol * tol;
    const m = mask.getContext('2d');
    const out = m.getImageData(0, 0, w, h), od = out.data;
    let hit = 0;
    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - r0, dg = data[i + 1] - g0, db = data[i + 2] - b0;
      if (dr * dr + dg * dg + db * db <= tol2) { od[i] = 244; od[i + 1] = 63; od[i + 2] = 245; od[i + 3] = 140; hit++; }
    }
    m.putImageData(out, 0, 0); redraw();
    const pct = Math.round((hit / (w * h)) * 100);
    note(hit ? `Selected ~${pct}% of the image. Lower “Match” if it grabbed too much, then press Remove.` : 'Nothing matched that colour — try raising “Match”.', !hit);
  }

  function hasMask() {
    const d = mask.getContext('2d').getImageData(0, 0, mask.width, mask.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }
  function clearMask() { mask.getContext('2d').clearRect(0, 0, mask.width, mask.height); redraw(); }

  async function remove() {
    if (busy) return;
    if (!hasMask()) { note('Mark the watermark first — brush over it or click to select it.', true); return; }
    busy = true; $('#remove').disabled = true;
    setProgress(true, 'Removing…');
    try {
      await new Promise((r) => setTimeout(r, 30));
      // snapshot for undo
      if (undoStack.length >= 6) undoStack.shift();
      const snap = document.createElement('canvas'); snap.width = img.width; snap.height = img.height;
      snap.getContext('2d').drawImage(img, 0, 0); undoStack.push(snap); $('#undo').disabled = false;

      const w = img.width, h = img.height;
      const imgData = img.getContext('2d').getImageData(0, 0, w, h);
      // binary mask from the painted alpha, dilated a few px so edges are fully covered
      const md = mask.getContext('2d').getImageData(0, 0, w, h).data;
      let m = new Uint8Array(w * h);
      for (let p = 0, q = 3; q < md.length; p++, q += 4) m[p] = md[q] > 0 ? 1 : 0;
      m = dilate(m, w, h, 3);
      const hd = $('#hdRefine') ? $('#hdRefine').checked : true;
      let out;
      if (hd && window.inpaintExemplarAsync) {
        setProgress(true, 'Refining (texture-aware)…');
        out = await window.inpaintExemplarAsync(imgData, m, {
          onProgress: (p) => { $('#barFill').style.width = Math.round(6 + p * 90) + '%'; $('#progressText').textContent = 'Refining… ' + Math.round(p * 100) + '%'; }
        });
      } else {
        out = window.inpaintImage(imgData, m);
      }
      img.getContext('2d').putImageData(out, 0, 0);
      clearMask();
      setProgress(false);
      note('Done. Brush any leftover bits and press Remove again, or download.');
    } catch (e) {
      console.error(e); setProgress(false);
      note('Could not process this image: ' + (e.message || e), true);
    } finally { busy = false; $('#remove').disabled = false; }
  }

  function undo() {
    if (!undoStack.length) return;
    const snap = undoStack.pop();
    img.getContext('2d').clearRect(0, 0, img.width, img.height);
    img.getContext('2d').drawImage(snap, 0, 0);
    clearMask(); $('#undo').disabled = !undoStack.length;
  }
  function download() {
    disp.getContext('2d'); // ensure
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'no-watermark.png'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); }, 'image/png');
  }
  function setMode(m) {
    mode = m;
    $('#modeBrush').classList.toggle('is-on', m === 'brush'); $('#modeBrush').setAttribute('aria-pressed', String(m === 'brush'));
    $('#modeWand').classList.toggle('is-on', m === 'wand'); $('#modeWand').setAttribute('aria-pressed', String(m === 'wand'));
    $('#brushField').hidden = m !== 'brush'; $('#tolField').hidden = m !== 'wand';
    note(m === 'brush' ? 'Brush over the watermark (it turns red), then press Remove.' : 'Click on the watermark — every pixel of that colour is selected. Adjust “Match”, then Remove.');
  }

  function bind() {
    const input = $('#file'), pick = () => input.click();
    $('#pick').addEventListener('click', (e) => { e.stopPropagation(); pick(); });
    $('#drop').addEventListener('click', pick);
    $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    input.addEventListener('change', () => { if (input.files[0]) load(input.files[0]); });
    window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('#drop') && $('#drop').classList.add('drag'); } });
    window.addEventListener('drop', (e) => { if (!e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) load(f); });

    $('#modeBrush').addEventListener('click', () => setMode('brush'));
    $('#modeWand').addEventListener('click', () => setMode('wand'));
    $('#clearMask').addEventListener('click', clearMask);
    $('#remove').addEventListener('click', remove);
    $('#undo').addEventListener('click', undo);
    $('#dl').addEventListener('click', download);
    $('#reset').addEventListener('click', () => { $('#startPane').hidden = false; $('#workPane').hidden = true; input.value = ''; });

    const cv = $('#canvas');
    // delegated pointer handlers (canvas exists after load)
    document.addEventListener('pointerdown', (e) => {
      if (e.target !== $('#canvas') || !img) return;
      const p = toCanvas(e);
      if (mode === 'wand') { wandSelect(p.x, p.y); return; }
      painting = true; last = null; $('#canvas').setPointerCapture(e.pointerId); brushStroke(p.x, p.y); e.preventDefault();
    });
    document.addEventListener('pointermove', (e) => { if (!painting) return; const p = toCanvas(e); brushStroke(p.x, p.y); });
    document.addEventListener('pointerup', () => { painting = false; last = null; });
    document.addEventListener('pointercancel', () => { painting = false; last = null; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
  window.__wm = { remove, wandSelect, hasMask, load, getMaskCanvas: () => mask, getImgCanvas: () => img, redraw };
})();
