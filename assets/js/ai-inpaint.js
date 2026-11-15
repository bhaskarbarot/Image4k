/* AI watermark inpainting — MI-GAN (Picsart, ICCV-2023) via onnxruntime-web + WebGPU.
 * Free model from Hugging Face, loaded on demand and cached. Falls back to the JS exemplar
 * fill (see inpaint.js) whenever WebGPU or the model is unavailable, so the tool never breaks.
 *
 * Model I/O (migan_pipeline_v2): input[0] = image uint8 [1,3,512,512] CHW, input[1] = mask
 * uint8 [1,1,512,512] where 255 = keep, 0 = fill. Output = uint8 [1,3,512,512] CHW, 0..255.
 */
(function () {
  'use strict';
  const ORT_VER = '1.31.1';
  const ORT_URL = {
    webgpu: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/ort.webgpu.min.mjs`,
    wasm: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/ort.wasm.min.mjs`
  };
  const MODEL_URL = 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx';
  const SIZE = 512;
  let ortMod = null, session = null, loading = null;

  function hasWebGPU() { return typeof navigator !== 'undefined' && !!navigator.gpu; }

  async function getSession(onProgress) {
    if (session) return session;
    if (loading) return loading;
    loading = (async () => {
      onProgress && onProgress(0.02, 'Loading AI runtime…');
      if (!ortMod) { try { ortMod = await import(ORT_URL.webgpu); } catch (e) { ortMod = await import(ORT_URL.wasm); } }
      const ort = ortMod;
      // download the model with progress, then cache in the browser's Cache Storage
      let buf = await cachedModel();
      if (!buf) {
        onProgress && onProgress(0.05, 'Downloading AI model (one time)…');
        const res = await fetch(MODEL_URL);
        if (!res.ok) throw new Error('model download failed');
        const total = +res.headers.get('content-length') || 80 * 1024 * 1024;
        const reader = res.body.getReader(); const chunks = []; let got = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress && onProgress(0.05 + 0.6 * Math.min(1, got / total), 'Downloading AI model… ' + Math.round(100 * got / total) + '%'); }
        buf = new Uint8Array(got); let off = 0; for (const c of chunks) { buf.set(c, off); off += c.length; }
        storeModel(buf).catch(() => {});
      }
      onProgress && onProgress(0.7, 'Starting AI model…');
      const providers = hasWebGPU() ? ['webgpu', 'wasm'] : ['wasm'];
      session = await ort.InferenceSession.create(buf.buffer || buf, { executionProviders: providers, graphOptimizationLevel: 'all' });
      return session;
    })();
    try { return await loading; } finally { loading = null; }
  }
  async function cachedModel() {
    try { const c = await caches.open('bs-ai-models'); const r = await c.match(MODEL_URL); if (r) return new Uint8Array(await r.arrayBuffer()); } catch (e) {}
    return null;
  }
  async function storeModel(buf) {
    try { const c = await caches.open('bs-ai-models'); await c.put(MODEL_URL, new Response(buf)); } catch (e) {}
  }

  // bounding box of the mask, padded, clamped
  function bbox(mask, W, H, pad) {
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (maxX < 0) return null;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** Run MI-GAN on the masked region of imageData. Returns a new ImageData, or throws. */
  async function run(imageData, mask, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    if (!hasWebGPU()) throw new Error('no-webgpu');
    const ort = ortMod || (await (async () => { await getSession(onProgress); return ortMod; })());
    const sess = await getSession(onProgress);
    const W = imageData.width, H = imageData.height;
    const box = bbox(mask, W, H, 48); if (!box) throw new Error('empty-mask');

    // crop image + mask to the box, stretched onto SIZE×SIZE
    const src = document.createElement('canvas'); src.width = W; src.height = H; src.getContext('2d').putImageData(imageData, 0, 0);
    const imgC = document.createElement('canvas'); imgC.width = SIZE; imgC.height = SIZE;
    imgC.getContext('2d').drawImage(src, box.x, box.y, box.w, box.h, 0, 0, SIZE, SIZE);
    const id = imgC.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;

    // mask crop -> SIZE×SIZE, value 255=keep, 0=fill
    const mC = document.createElement('canvas'); mC.width = box.w; mC.height = box.h;
    const mImg = mC.getContext('2d').createImageData(box.w, box.h);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) { const hole = mask[(box.y + y) * W + (box.x + x)]; const p = (y * box.w + x) * 4; const v = hole ? 0 : 255; mImg.data[p] = v; mImg.data[p + 1] = v; mImg.data[p + 2] = v; mImg.data[p + 3] = 255; }
    mC.getContext('2d').putImageData(mImg, 0, 0);
    const mBig = document.createElement('canvas'); mBig.width = SIZE; mBig.height = SIZE;
    const mctx = mBig.getContext('2d'); mctx.imageSmoothingEnabled = false; mctx.drawImage(mC, 0, 0, SIZE, SIZE);
    const md = mctx.getImageData(0, 0, SIZE, SIZE).data;

    // CHW uint8 tensors
    const N = SIZE * SIZE;
    const imgArr = new Uint8Array(3 * N), maskArr = new Uint8Array(N);
    for (let i = 0; i < N; i++) { imgArr[i] = id[i * 4]; imgArr[N + i] = id[i * 4 + 1]; imgArr[2 * N + i] = id[i * 4 + 2]; maskArr[i] = md[i * 4] > 127 ? 255 : 0; }
    const feeds = {};
    feeds[sess.inputNames[0]] = new ort.Tensor('uint8', imgArr, [1, 3, SIZE, SIZE]);
    feeds[sess.inputNames[1]] = new ort.Tensor('uint8', maskArr, [1, 1, SIZE, SIZE]);
    onProgress(0.85, 'Removing with AI…');
    const results = await sess.run(feeds);
    const out = (results[sess.outputNames[0]] || Object.values(results)[0]).data;   // uint8 CHW

    // CHW -> RGBA 512, resize back to the box, composite only the holes (feathered)
    const outC = document.createElement('canvas'); outC.width = SIZE; outC.height = SIZE;
    const outImg = outC.getContext('2d').createImageData(SIZE, SIZE);
    for (let i = 0; i < N; i++) { outImg.data[i * 4] = out[i]; outImg.data[i * 4 + 1] = out[N + i]; outImg.data[i * 4 + 2] = out[2 * N + i]; outImg.data[i * 4 + 3] = 255; }
    outC.getContext('2d').putImageData(outImg, 0, 0);
    const back = document.createElement('canvas'); back.width = box.w; back.height = box.h;
    back.getContext('2d').drawImage(outC, 0, 0, SIZE, SIZE, 0, 0, box.w, box.h);
    const bd = back.getContext('2d').getImageData(0, 0, box.w, box.h).data;

    const result = new Uint8ClampedArray(imageData.data);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
      if (!mask[(box.y + y) * W + (box.x + x)]) continue;
      const gi = ((box.y + y) * W + (box.x + x)) * 4, bi = (y * box.w + x) * 4;
      result[gi] = bd[bi]; result[gi + 1] = bd[bi + 1]; result[gi + 2] = bd[bi + 2]; result[gi + 3] = 255;
    }
    onProgress(1, 'Done');
    return new ImageData(result, W, H);
  }

  window.AIInpaint = { available: hasWebGPU, run: run, preload: (op) => getSession(op) };
})();
