/* Image4k.org — application logic.
 * Everything runs locally in the browser: decoding, resizing (pica, Lanczos3 + unsharp mask),
 * encoding, compression and AI background removal (Transformers.js, loaded on demand).
 */
(() => {
  'use strict';

  // ======================================================================
  // Constants & environment
  // ======================================================================
  const MAX_FILES = 10;
  const MAX_FILE_BYTES = 80 * 1024 * 1024;
  const PRESETS = window.IMAGE4K_PRESETS || [];
  const BRANDS = window.IMAGE4K_BRANDS || {};
  const Enc = window.Image4kEncoders;
  const TJS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
  const HEIC_LIB = '/assets/vendor/heic2any.min.js';

  const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
  const lowMem = isIOS || (navigator.deviceMemory && navigator.deviceMemory <= 4);
  const MAX_AREA = lowMem ? 16_000_000 : 40_000_000; // output pixel budget
  const MAX_SIDE = isIOS ? 8192 : 16384;

  const FORMATS = {
    jpeg: { label: 'JPG',  mime: 'image/jpeg',   ext: 'jpg',  lossy: true,  alpha: false },
    png:  { label: 'PNG',  mime: 'image/png',    ext: 'png',  lossy: false, alpha: true },
    webp: { label: 'WebP', mime: 'image/webp',   ext: 'webp', lossy: true,  alpha: true },
    avif: { label: 'AVIF', mime: 'image/avif',   ext: 'avif', lossy: true,  alpha: true },
    bmp:  { label: 'BMP',  mime: 'image/bmp',    ext: 'bmp',  lossy: false, alpha: false },
    tiff: { label: 'TIFF', mime: 'image/tiff',   ext: 'tiff', lossy: false, alpha: true },
    ico:  { label: 'ICO',  mime: 'image/x-icon', ext: 'ico',  lossy: false, alpha: true }
  };

  const support = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    const can = (m) => { try { return c.toDataURL(m).startsWith('data:' + m); } catch (e) { return false; } };
    return { jpeg: true, png: true, bmp: true, tiff: true, ico: true, webp: can('image/webp'), avif: can('image/avif') };
  })();

  const picaInst = typeof window.pica === 'function' ? window.pica() : null;

  const TOOL_TEXT = {
    hd:       { h1: 'Convert images to HD &amp; 4K for free', lead: 'Upscale photos to HD, 4K or 8K with crisp, sharp detail — up to 10 images at once, right in your browser.', dz: 'Convert Photo to HD', run: 'Make HD', size: 'Output shape', suffix: 'hd' },
    resize:   { h1: 'Resize images for any platform', lead: 'Pick from 80+ sizes for Instagram, YouTube, Facebook, X, ads and print — or enter your own, with optional 4K quality.', dz: 'Resize Images', run: 'Resize', size: 'Choose size', suffix: 'resized' },
    compress: { h1: 'Compress images without losing quality', lead: 'Shrink JPG, PNG and WebP files by up to 90% — by quality or to an exact size in KB. Up to 10 images at once.', dz: 'Compress Images', run: 'Compress', size: 'Compression', suffix: 'compressed' },
    bg:       { h1: 'Remove image backgrounds for free', lead: 'AI cut-outs in seconds. Keep the background transparent, pick any color from the palette, or blur it.', dz: 'Remove Background', run: 'Remove background', size: 'Canvas size', suffix: 'no-bg' }
  };

  const PALETTE = ['#ffffff', '#000000', '#f3f4f6', '#9ca3af', '#374151', '#ef4444', '#f97316', '#f59e0b', '#facc15',
    '#84cc16', '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
    '#d946ef', '#ec4899', '#f43f5e', '#fde2e4', '#fef3c7', '#dcfce7', '#e0f2fe'];

  const CATS = [
    ['all', 'All'], ['hd', 'HD & 4K'], ['social', 'Social media'], ['ads', 'Ads'], ['print', 'Print'], ['ratio', 'Ratios']
  ];

  // ======================================================================
  // Settings
  // ======================================================================
  const DEFAULTS = {
    hd:       { mode: 'original', presetId: null, w: 1920, h: 1080, scale: '4k', engine: 'best', engineChosen: false, fit: 'cover', position: 'center', pad: 'blur', padColor: '#ffffff', sharpen: 'balanced', colors: false, format: 'auto', quality: 95 },
    resize:   { mode: 'preset', presetId: null, w: 1920, h: 1080, percent: 50, boost4k: false, engine: 'best', engineChosen: false, fit: 'cover', position: 'center', pad: 'blur', padColor: '#ffffff', sharpen: 'auto', format: 'auto', quality: 92 },
    compress: { cmode: 'quality', quality: 75, targetKB: 200, maxDim: '0', format: 'auto' },
    bg:       { mode: 'original', presetId: null, w: 1080, h: 1080, model: 'object', bgType: 'transparent', bgColor: '#ffffff', edge: 'natural', fillHoles: true, cropSubject: false, fit: 'contain', position: 'center', format: 'auto', quality: 92 }
  };
  const STORE_KEY = 'image4k:settings:v2';
  const settings = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const tool of Object.keys(DEFAULTS)) {
        if (!saved[tool]) continue;
        for (const k of Object.keys(DEFAULTS[tool])) {
          if (k in saved[tool] && typeof saved[tool][k] === typeof DEFAULTS[tool][k] || (k === 'presetId' && typeof saved[tool][k] === 'string')) {
            settings[tool][k] = saved[tool][k];
          }
        }
      }
    }
  } catch (e) { /* storage unavailable */ }
  if (!['object', 'people'].includes(settings.bg.model)) settings.bg.model = 'object';
  if (!['quality', 'target'].includes(settings.compress.cmode)) settings.compress.cmode = 'quality';
  for (const t of ['hd', 'resize']) {
    const e = settings[t].engine;
    settings[t].engine = e === 'art' ? 'fast' : ['best', 'fast', 'classic'].includes(e) ? e : 'best';
  }
  for (const t of Object.keys(settings)) if (settings[t].format !== 'auto' && !FORMATS[settings[t].format]) settings[t].format = 'auto';
  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } }, 300);
  }

  const state = {
    tool: 'hd',
    items: [],
    busy: false,
    cancel: false,
    runSig: '',
    presetCat: 'all',
    presetQuery: '',
    lock: true
  };
  const S = () => settings[state.tool];

  // ======================================================================
  // DOM helpers
  // ======================================================================
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtBytes = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB' : (b / 1048576).toFixed(b < 10485760 ? 2 : 1) + ' MB');
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const presetById = (id) => PRESETS.find((p) => p.id === id) || null;

  let toastTimer = 0;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 5200 : 3400);
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('memory: could not allocate a ' + c.width + '×' + c.height + ' canvas');
    return c;
  }
  function freeCanvas(c) { if (c && c.tagName === 'CANVAS') { c.width = 1; c.height = 1; } }

  function toCanvas(src, w, h) {
    if (src && src.tagName === 'CANVAS' && src.width === w && src.height === h) return src;
    const c = makeCanvas(w, h);
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return c;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('memory: encoding failed — image may be too large'))), mime, quality);
      } catch (e) { reject(e); }
    });
  }

  function getImageData(canvas) {
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  }

  // ======================================================================
  // Decoding
  // ======================================================================
  const EXT_RE = /\.(jpe?g|jfif|png|webp|gif|bmp|avif|svg|heic|heif|tiff?|ico)$/i;

  function guessMime(file) {
    if (file.type && file.type.startsWith('image/')) return file.type === 'image/jpg' ? 'image/jpeg' : file.type;
    const m = (file.name.match(EXT_RE) || [])[1];
    if (!m) return '';
    const e = m.toLowerCase();
    return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
      avif: 'image/avif', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon' })[e] || '';
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This file could not be read as an image'));
      img.src = url;
    });
  }

  let heicLoading = null;
  function loadHeicLib() {
    if (window.heic2any) return Promise.resolve();
    heicLoading = heicLoading || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HEIC_LIB;
      s.onload = () => resolve();
      s.onerror = () => { heicLoading = null; reject(new Error('Could not load the HEIC decoder')); };
      document.head.appendChild(s);
    });
    return heicLoading;
  }

  async function bitmapFrom(blob) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* try plain */ }
    return createImageBitmap(blob);
  }

  /** Returns { src, w, h, close() } for drawing. */
  async function decodeItem(item) {
    let blob = item.decodedBlob || item.file;
    if (item.svg) {
      const url = URL.createObjectURL(blob);
      try {
        const img = await loadImage(url);
        let w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { w = 1024; h = 1024; }
        return { src: img, w, h, close: () => URL.revokeObjectURL(url), svg: true };
      } catch (e) { URL.revokeObjectURL(url); throw e; }
    }
    if (item.heic && !item.decodedBlob) {
      try {
        const bmp = await bitmapFrom(blob); // Safari decodes HEIC natively
        return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close && bmp.close() };
      } catch (e) {
        await loadHeicLib();
        let out = await Promise.race([
          window.heic2any({ blob, toType: 'image/png' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('This HEIC file could not be decoded — try exporting it as JPG')), 90000))
        ]);
        if (Array.isArray(out)) out = out[0];
        item.decodedBlob = out;
        blob = out;
      }
    }
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await bitmapFrom(blob);
        return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close && bmp.close() };
      } catch (e) { /* fall through */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      if (img.decode) { try { await img.decode(); } catch (e) { /* ignore */ } }
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      if (item.mime === 'image/tiff') throw new Error('This browser cannot open TIFF files — try Safari or convert to PNG first');
      throw e;
    }
  }

  // ======================================================================
  // Size computation
  // ======================================================================
  function baseSize(sw, sh, s) {
    switch (s.mode) {
      case 'preset': {
        const p = presetById(s.presetId);
        return p ? { w: p.w, h: p.h, reshape: true, dpi: p.cat === 'print' ? 300 : 0, preset: p } : null;
      }
      case 'custom': {
        const w = Math.round(+s.w), h = Math.round(+s.h);
        return w > 0 && h > 0 ? { w, h, reshape: true } : null;
      }
      case 'percent': return { w: sw * s.percent / 100, h: sh * s.percent / 100 };
      default: return { w: sw, h: sh };
    }
  }

  function computeTarget(sw, sh, tool, s) {
    let w, h, reshape = false, dpi = 0;
    if (tool === 'compress') {
      w = sw; h = sh;
      const md = parseInt(s.maxDim, 10) || 0;
      if (md && Math.max(w, h) > md) { const k = md / Math.max(w, h); w *= k; h *= k; }
    } else {
      const b = baseSize(sw, sh, s);
      if (!b) return null;
      w = b.w; h = b.h; reshape = !!b.reshape; dpi = b.dpi || 0;
      if (tool === 'hd') {
        let k;
        if (s.scale === '2') k = 2;
        else if (s.scale === '4') k = 4;
        else k = Math.max(1, (s.scale === '8k' ? 7680 : 3840) / Math.max(w, h));
        w *= k; h *= k;
      } else if (tool === 'resize' && s.boost4k) {
        const k = 3840 / Math.max(w, h);
        w *= k; h *= k;
      }
    }
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    let limited = false;
    const k2 = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));
    if (k2 < 1) { w = Math.max(1, Math.floor(w * k2)); h = Math.max(1, Math.floor(h * k2)); limited = true; }
    return { w, h, reshape, dpi, limited };
  }

  function resolveFormat(item, tool, s) {
    let f = s.format;
    const lossyOnly = tool === 'compress' && s.cmode === 'target';
    if (f !== 'auto' && !support[f]) f = 'auto';
    if (lossyOnly && f !== 'auto' && !FORMATS[f].lossy) f = 'auto';
    if (f !== 'auto') return f;

    if (lossyOnly) {
      if (item.mime === 'image/webp' && support.webp) return 'webp';
      if (item.mime === 'image/avif' && support.avif) return 'avif';
      return item.alpha && support.webp ? 'webp' : 'jpeg';
    }
    if (tool === 'bg') return s.bgType === 'transparent' ? 'png' : 'jpeg';
    const t = item.mime;
    if (t === 'image/jpeg' || item.heic) return 'jpeg';
    if (t === 'image/webp') return support.webp ? 'webp' : item.alpha ? 'png' : 'jpeg';
    if (t === 'image/avif') return support.avif ? 'avif' : support.webp ? 'webp' : item.alpha ? 'png' : 'jpeg';
    if (tool === 'compress' && (t === 'image/bmp' || t === 'image/tiff' || t === 'image/gif') && !item.alpha) return 'jpeg';
    if (tool === 'hd' && s.mode !== 'original' && s.fit === 'contain' && s.pad === 'transparent') return 'png';
    return 'png';
  }

  // ======================================================================
  // Resampling
  // ======================================================================
  function sharpParams(level, linearScale) {
    const r = linearScale > 2.5 ? 1.35 : 1;
    switch (level) {
      case 'soft': return { amount: 60, radius: Math.min(2, 0.6 * r), threshold: 2 };
      case 'balanced': return { amount: 100, radius: Math.min(2, 0.8 * r), threshold: 2 };
      case 'strong': return { amount: 160, radius: Math.min(2, 1.0 * r), threshold: 1 };
      default: return { amount: 0, radius: 0.5, threshold: 0 };
    }
  }
  const NO_SHARP = sharpParams('off', 1);

  function resolveSharpen(s, tool, areaScale) {
    const lvl = s.sharpen;
    if (lvl === 'auto' || !lvl) return areaScale > 1.05 ? 'soft' : 'off';
    return lvl;
  }

  async function hqResize(from, fw, fh, dw, dh, sharp, alpha, filter) {
    dw = Math.max(1, Math.round(dw));
    dh = Math.max(1, Math.round(dh));
    if (fw === dw && fh === dh && !(sharp && sharp.amount)) return toCanvas(from, dw, dh);
    const to = makeCanvas(dw, dh);
    const up = dw * dh > fw * fh;
    if (picaInst) {
      try {
        await picaInst.resize(from, to, {
          filter: filter || (up ? 'lanczos3' : 'mks2013'),
          alpha: !!alpha,
          unsharpAmount: sharp ? sharp.amount : 0,
          unsharpRadius: sharp ? sharp.radius : 0.5,
          unsharpThreshold: sharp ? sharp.threshold : 0
        });
        return to;
      } catch (e) {
        console.warn('[image4k] pica failed, using canvas fallback', e);
      }
    }
    // Fallback: progressive halving for downscale, smooth draw for upscale.
    let cur = from, cw = fw, ch = fh, tmp = null;
    while (cw / 2 >= dw && ch / 2 >= dh) {
      const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
      const c = makeCanvas(nw, nh);
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      if (tmp) freeCanvas(tmp);
      tmp = c; cur = c; cw = nw; ch = nh;
    }
    const ctx = to.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, dw, dh);
    if (tmp) freeCanvas(tmp);
    return to;
  }

  function posOffset(extra, pos, axis) {
    if (axis === 'x') return pos === 'left' ? 0 : pos === 'right' ? extra : Math.round(extra / 2);
    return pos === 'top' ? 0 : pos === 'bottom' ? extra : Math.round(extra / 2);
  }

  /** Cheap, cross-browser blurred "cover" fill (downscale → upscale). */
  function drawBlurCover(ctx, src, sw, sh, W, H) {
    const tr = W / H, sr = sw / sh;
    let cw = sw, ch = sh, cx = 0, cy = 0;
    if (sr > tr) { cw = sh * tr; cx = (sw - cw) / 2; } else { ch = sw / tr; cy = (sh - ch) / 2; }
    const tinyW = Math.max(4, Math.round(Math.min(48, W / 24) * (tr >= 1 ? 1 : tr)));
    const tinyH = Math.max(4, Math.round(tinyW / tr));
    const tiny = makeCanvas(tinyW, tinyH);
    const tc = tiny.getContext('2d');
    tc.imageSmoothingQuality = 'high';
    tc.drawImage(src, cx, cy, cw, ch, 0, 0, tinyW, tinyH);
    const midW = Math.max(8, Math.round(tinyW * 4)), midH = Math.max(8, Math.round(tinyH * 4));
    const mid = makeCanvas(midW, midH);
    const mc = mid.getContext('2d');
    mc.imageSmoothingQuality = 'high';
    mc.drawImage(tiny, 0, 0, midW, midH);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(mid, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    freeCanvas(tiny); freeCanvas(mid);
  }

  /** Place src (sw×sh) into a W×H frame using fit = cover | contain | stretch. */
  async function renderGeom(src, sw, sh, t, fit, position, pad, sharp, alpha, filter, resizer) {
    const W = t.w, H = t.h;
    const rs = resizer || hqResize;
    if (fit === 'cover') {
      const tr = W / H, sr = sw / sh;
      let cw = sw, ch = sh, cx = 0, cy = 0;
      if (sr > tr + 1e-6) { cw = Math.max(1, Math.round(sh * tr)); cx = posOffset(sw - cw, position, 'x'); }
      else if (sr < tr - 1e-6) { ch = Math.max(1, Math.round(sw / tr)); cy = posOffset(sh - ch, position, 'y'); }
      let from = src;
      if (cw !== sw || ch !== sh) {
        from = makeCanvas(cw, ch);
        from.getContext('2d').drawImage(src, cx, cy, cw, ch, 0, 0, cw, ch);
      }
      const out = await rs(from, cw, ch, W, H, sharp, alpha, filter);
      if (from !== src && from !== out) freeCanvas(from);
      return out;
    }
    if (fit === 'contain') {
      const k = Math.min(W / sw, H / sh);
      const iw = Math.max(1, Math.round(sw * k)), ih = Math.max(1, Math.round(sh * k));
      const inner = await rs(src, sw, sh, iw, ih, sharp, alpha, filter);
      if (iw === W && ih === H) return inner;
      const out = makeCanvas(W, H);
      const c = out.getContext('2d');
      if (pad.type === 'color') { c.fillStyle = pad.color; c.fillRect(0, 0, W, H); }
      else if (pad.type === 'black') { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
      else if (pad.type === 'blur') drawBlurCover(c, src, sw, sh, W, H);
      c.drawImage(inner, Math.round((W - iw) / 2), Math.round((H - ih) / 2));
      if (inner !== src) freeCanvas(inner);
      return out;
    }
    return rs(src, sw, sh, W, H, sharp, alpha, filter);
  }

  function enhanceColors(canvas) {
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = ((i / 255 - 0.5) * 1.07 + 0.5) * 255 + 1.5;
    const sat = 1.12;
    for (let i = 0; i < d.length; i += 4) {
      const r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      d[i] = l + (r - l) * sat;
      d[i + 1] = l + (g - l) * sat;
      d[i + 2] = l + (b - l) * sat;
    }
    ctx.putImageData(id, 0, 0);
  }

  function flatten(canvas, color) {
    const c = makeCanvas(canvas.width, canvas.height);
    const x = c.getContext('2d');
    x.fillStyle = color || '#ffffff';
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(canvas, 0, 0);
    return c;
  }

  async function fitWithin(canvas, max, alpha) {
    const L = Math.max(canvas.width, canvas.height);
    if (L <= max) return canvas;
    const k = max / L;
    return hqResize(canvas, canvas.width, canvas.height, canvas.width * k, canvas.height * k, NO_SHARP, alpha);
  }

  // ======================================================================
  // Encoding
  // ======================================================================
  async function encode(canvas, fmt, quality, dpi, hasAlpha) {
    const F = FORMATS[fmt];
    let c = canvas;
    if (!F.alpha && hasAlpha) c = flatten(canvas, '#ffffff');
    let blob;
    try {
      if (fmt === 'bmp') blob = Enc.encodeBMP(getImageData(c));
      else if (fmt === 'tiff') blob = Enc.encodeTIFF(getImageData(c), dpi || 72);
      else if (fmt === 'ico') blob = await Enc.encodeICO(await canvasToBlob(c, 'image/png'), c.width, c.height);
      else {
        blob = await canvasToBlob(c, F.mime, F.lossy ? Math.min(1, Math.max(0.01, quality / 100)) : undefined);
        if (blob.type && blob.type !== F.mime) throw new Error(F.label + ' export is not supported by this browser — choose another format');
      }
      if (dpi && (fmt === 'jpeg' || fmt === 'png')) blob = await Enc.setDPI(blob, dpi);
    } finally {
      if (c !== canvas) freeCanvas(c);
    }
    return blob;
  }

  async function encodeToTarget(canvas, fmt, targetBytes, hasAlpha, onStep) {
    const F = FORMATS[fmt];
    let cur = canvas;
    let smallest = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const src = !F.alpha && hasAlpha ? flatten(cur, '#ffffff') : cur;
      const enc = (q) => canvasToBlob(src, F.mime, q);
      let b = await enc(0.92);
      if (b.size <= targetBytes) { if (src !== cur) freeCanvas(src); return { blob: b, canvas: cur }; }
      let lo = 0.04, hi = 0.92, best = null;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        b = await enc(mid);
        if (onStep) onStep();
        if (b.size <= targetBytes) { best = b; lo = mid; } else { hi = mid; }
        if (!smallest || b.size < smallest.size) smallest = b;
      }
      if (best) { if (src !== cur) freeCanvas(src); return { blob: best, canvas: cur }; }
      const low = await enc(0.04);
      if (src !== cur) freeCanvas(src);
      if (!smallest || low.size < smallest.size) smallest = low;
      const k = Math.max(0.35, Math.min(0.9, Math.sqrt(targetBytes / low.size) * 0.92));
      const next = await hqResize(cur, cur.width, cur.height, cur.width * k, cur.height * k, NO_SHARP, hasAlpha);
      if (cur !== canvas) freeCanvas(cur);
      cur = next;
      if (cur.width < 16 || cur.height < 16) break;
    }
    return { blob: smallest, canvas: cur, missed: true };
  }

  const colorsFromQuality = (q) => (q >= 95 ? 256 : Math.max(8, Math.round(Math.pow(2, 3 + (q / 100) * 5))));

  // ======================================================================
  // AI super-resolution (Real-ESRGAN family via onnxruntime-web, loaded on demand)
  //   best: RealESRNet x4plus — fidelity-trained (no GAN), keeps text and shapes correct
  //   fast: realesr-animevideov3 — compact and quick, good for photos and illustrations
  // ======================================================================
  const ORT_VER = '1.31.1';
  const ORT_URL = {
    webgpu: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/ort.webgpu.min.mjs`,
    wasm: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/ort.wasm.min.mjs`
  };
  const SR_MODELS = {
    best: {
      parts: ['/assets/models/realesrnet-x4plus.onnx.part1', '/assets/models/realesrnet-x4plus.onnx.part2'],
      label: 'AI Best', size: 33834807,
      tile: { gpu: 192, cpu: 384 }, pad: { gpu: 32, cpu: 32 },
      maxIn: { gpu: 2_500_000, cpu: 1_000_000 },
      secPerMP: { gpu: 30, cpu: 4200 }   // cpu figure is for one core; divided by threads (measured: ~15x AI Fast)
    },
    fast: {
      parts: ['/assets/models/realesr-animevideov3.onnx'],
      label: 'AI Fast', size: 2492874,
      tile: { gpu: 256, cpu: 256 }, pad: { gpu: 24, cpu: 24 },
      maxIn: { gpu: 4_000_000, cpu: 1_600_000 },
      secPerMP: { gpu: 3, cpu: 280 }
    }
  };
  const MODEL_CACHE = 'image4k-models-v1';
  const SR_SCALE = 4;
  let srRuntime = null;          // { ort, ep }
  const srSessions = new Map();  // key -> Promise<InferenceSession>
  let gpuProbe = null;

  function probeGPU() {
    gpuProbe = gpuProbe || (async () => {
      if (!navigator.gpu) return false;
      try {
        const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!a) return false;
        const info = a.info || {};
        if (info.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(`${info.description || ''} ${info.architecture || ''} ${info.vendor || ''}`)) return false;
        return true;
      } catch (e) { return false; }
    })();
    return gpuProbe;
  }

  const cpuThreads = () => (self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) : 1);

  async function loadSRRuntime(onProgress) {
    if (srRuntime) return srRuntime;
    onProgress && onProgress('Loading AI engine…');
    let ort = null, ep = 'wasm';
    if (await probeGPU()) {
      try { ort = await import(ORT_URL.webgpu); ep = 'webgpu'; } catch (e) { console.warn('[image4k] WebGPU runtime failed to load', e); }
    }
    if (!ort) { ort = await import(ORT_URL.wasm); ep = 'wasm'; }
    ort.env.wasm.numThreads = cpuThreads();
    // run CPU inference in a background worker so the page never freezes
    if (ep === 'wasm') ort.env.wasm.proxy = true;
    srRuntime = { ort, ep };
    return srRuntime;
  }

  /** Download (or read from Cache Storage) a model that may be split into parts. */
  async function fetchModel(m, onProgress) {
    let cache = null;
    try { cache = await caches.open(MODEL_CACHE); } catch (e) { /* Cache API unavailable */ }
    const buffers = [];
    let got = 0;
    for (const url of m.parts) {
      let res = cache ? await cache.match(url) : null;
      const fromCache = !!res;
      if (!res) {
        res = await fetch(url);
        if (!res.ok) throw new Error(`Could not download the ${m.label} model (HTTP ${res.status})`);
        if (cache) { try { await cache.put(url, res.clone()); } catch (e) { /* quota — fine */ } }
      }
      if (fromCache || !res.body) {
        const b = new Uint8Array(await res.arrayBuffer());
        buffers.push(b); got += b.length;
      } else {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffers.push(value); got += value.length;
          onProgress && onProgress(`Downloading ${m.label} model (one time) — ${Math.min(100, Math.round((got / m.size) * 100))}%`);
        }
      }
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const b of buffers) { out.set(b, o); o += b.length; }
    return out;
  }

  async function getSRSession(kind, onProgress) {
    const rt = await loadSRRuntime(onProgress);
    const key = kind + '|' + rt.ep;
    if (!srSessions.has(key)) {
      const p = (async () => {
        const m = SR_MODELS[kind];
        const bytes = await fetchModel(m, onProgress);
        onProgress && onProgress(`Starting ${m.label}…`);
        try {
          return await rt.ort.InferenceSession.create(bytes, { executionProviders: [rt.ep], graphOptimizationLevel: 'all' });
        } catch (e) {
          if (rt.ep !== 'webgpu') throw e;
          console.warn('[image4k] WebGPU session failed, using CPU', e);
          rt.ep = 'wasm';
          return rt.ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        }
      })();
      srSessions.set(key, p);
      p.catch(() => srSessions.delete(key));
    }
    return { session: await srSessions.get(key), rt };
  }

  /** Rough processing-time estimate (seconds) for an AI upscale of `mp` input megapixels. */
  // Real speed of THIS device (seconds per input megapixel), learned from finished runs.
  const SPEED_KEY = 'image4k:speed:v1';
  function readSpeeds() { try { return JSON.parse(localStorage.getItem(SPEED_KEY) || '{}'); } catch (e) { return {}; } }
  function saveSpeed(kind, ep, secPerMP) {
    if (!(secPerMP > 0) || !isFinite(secPerMP)) return;
    const all = readSpeeds();
    const k = kind + '|' + ep;
    all[k] = all[k] ? all[k] * 0.5 + secPerMP * 0.5 : secPerMP;   // smooth over runs
    try { localStorage.setItem(SPEED_KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
  }

  async function estimateAISeconds(kind, mp) {
    const m = SR_MODELS[kind];
    const gpu = await probeGPU();
    const ep = gpu ? 'webgpu' : 'wasm';
    const inMP = Math.min(mp, (gpu ? m.maxIn.gpu : m.maxIn.cpu) / 1e6);
    const speeds = readSpeeds();
    if (speeds[kind + '|' + ep]) return inMP * speeds[kind + '|' + ep];
    // no run of this model yet: scale the other model's measured speed by their known cost ratio
    const other = kind === 'best' ? 'fast' : 'best';
    const o = SR_MODELS[other];
    if (speeds[other + '|' + ep]) {
      const ratio = gpu ? m.secPerMP.gpu / o.secPerMP.gpu : m.secPerMP.cpu / o.secPerMP.cpu;
      return inMP * speeds[other + '|' + ep] * ratio;
    }
    return gpu ? inMP * m.secPerMP.gpu : (inMP * m.secPerMP.cpu) / cpuThreads();
  }

  /**
   * AI 4× super-resolution of `from` (fw×fh), delivered at dw×dh.
   * Tiled with overlap so any size works. Flat tiles (empty backgrounds) skip the network —
   * the result there would be identical — which makes screenshots and documents much faster.
   */
  async function aiResize(from, fw, fh, dw, dh, kind, alpha, onProgress) {
    dw = Math.max(1, Math.round(dw)); dh = Math.max(1, Math.round(dh));
    const M = SR_MODELS[kind];
    let { session, rt } = await getSRSession(kind, onProgress);
    let gpu = rt.ep === 'webgpu';

    // Keep the AI input within a sensible compute budget.
    const maxIn = gpu ? M.maxIn.gpu : M.maxIn.cpu;
    let src = from, sw = fw, sh = fh;
    const k = Math.min(1, Math.sqrt(maxIn / (fw * fh)));
    if (k < 1) {
      src = await hqResize(from, fw, fh, fw * k, fh * k, NO_SHARP, false);
      sw = src.width; sh = src.height;
    } else if (from.tagName !== 'CANVAS') {
      src = toCanvas(from, fw, fh);
    }
    const data = src.getContext('2d').getImageData(0, 0, sw, sh).data;

    const TILE = gpu ? M.tile.gpu : M.tile.cpu, PAD = gpu ? M.pad.gpu : M.pad.cpu;
    const OW = sw * SR_SCALE, OH = sh * SR_SCALE;
    const assemble = OW * OH <= MAX_AREA;
    const big = assemble ? makeCanvas(OW, OH) : null;
    const out = assemble ? null : makeCanvas(dw, dh);
    const octx = (big || out).getContext('2d');
    octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'high';
    const tileCanvas = makeCanvas(Math.min(TILE, sw) * SR_SCALE, Math.min(TILE, sh) * SR_SCALE);
    const fx = dw / sw, fy = dh / sh;

    // even split so no tile is a thin sliver
    const tilesX = Math.ceil(sw / TILE), tilesY = Math.ceil(sh / TILE);
    const tw = Math.ceil(sw / tilesX), th = Math.ceil(sh / tilesY);
    const total = tilesX * tilesY;
    const estTotal = (sw * sh / 1e6) * (gpu ? M.secPerMP.gpu : M.secPerMP.cpu / cpuThreads());
    onProgress && onProgress(`${M.label} enhancing 0%${gpu ? ' · GPU' : ''}`, { frac: 0, eta: estTotal });
    let done = 0, worked = 0;
    const t0 = performance.now();
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        if (state.cancel) throw new Error('cancelled');
        const x0 = tx * tw, y0 = ty * th;
        const w = Math.min(tw, sw - x0), h = Math.min(th, sh - y0);
        let px0, py0, pw, ph;
        if (gpu) {
          // fixed-size padded window (constant tensor shape = no shader recompiles), clamped to the image
          pw = Math.min(sw, tw + 2 * PAD); ph = Math.min(sh, th + 2 * PAD);
          px0 = Math.max(0, Math.min(x0 - PAD, sw - pw));
          py0 = Math.max(0, Math.min(y0 - PAD, sh - ph));
        } else {
          // CPU: context only where a neighbouring tile exists — no wasted work at image edges
          px0 = Math.max(0, x0 - PAD); py0 = Math.max(0, y0 - PAD);
          pw = Math.min(sw, x0 + w + PAD) - px0; ph = Math.min(sh, y0 + h + PAD) - py0;
        }

        // flat tile? (all channels within a few levels across the padded window)
        let mn0 = 255, mx0 = 0, mn1 = 255, mx1 = 0, mn2 = 255, mx2 = 0, s0 = 0, s1 = 0, s2 = 0;
        for (let y = 0; y < ph; y++) {
          let si = ((py0 + y) * sw + px0) * 4;
          for (let x = 0; x < pw; x++, si += 4) {
            const r = data[si], g = data[si + 1], b = data[si + 2];
            if (r < mn0) mn0 = r; if (r > mx0) mx0 = r;
            if (g < mn1) mn1 = g; if (g > mx1) mx1 = g;
            if (b < mn2) mn2 = b; if (b > mx2) mx2 = b;
            s0 += r; s1 += g; s2 += b;
          }
        }
        const dx0 = Math.round(x0 * fx), dy0 = Math.round(y0 * fy);
        const dx1 = Math.round((x0 + w) * fx), dy1 = Math.round((y0 + h) * fy);
        if (mx0 - mn0 <= 4 && mx1 - mn1 <= 4 && mx2 - mn2 <= 4) {
          const n = pw * ph;
          octx.fillStyle = `rgb(${Math.round(s0 / n)},${Math.round(s1 / n)},${Math.round(s2 / n)})`;
          if (big) octx.fillRect(x0 * SR_SCALE, y0 * SR_SCALE, w * SR_SCALE, h * SR_SCALE);
          else octx.fillRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
          done++;
          if (onProgress) onProgress(`${M.label} enhancing ${Math.round((done / total) * 100)}%${gpu ? ' · GPU' : ''}`, { frac: done / total });
          continue;
        }

        const n = pw * ph;
        const input = new Float32Array(3 * n);
        for (let y = 0; y < ph; y++) {
          let si = ((py0 + y) * sw + px0) * 4, o = y * pw;
          for (let x = 0; x < pw; x++, si += 4, o++) {
            input[o] = data[si] / 255;
            input[n + o] = data[si + 1] / 255;
            input[2 * n + o] = data[si + 2] / 255;
          }
        }
        const tensor = new rt.ort.Tensor('float32', input, [1, 3, ph, pw]);
        let result;
        try {
          result = await session.run({ input: tensor });
        } catch (e) {
          if (rt.ep !== 'webgpu' || worked > 0) throw e;
          // GPU failed at run time: rebuild on CPU and retry this tile
          console.warn('[image4k] WebGPU run failed, switching to CPU', e);
          srSessions.delete(kind + '|webgpu');
          rt.ep = 'wasm'; gpu = false;
          ({ session, rt } = await getSRSession(kind, onProgress));
          result = await session.run({ input: tensor });
        }
        const od = result.output.data;
        const OWt = pw * SR_SCALE, OHt = ph * SR_SCALE, N = OWt * OHt;
        const ox = (x0 - px0) * SR_SCALE, oy = (y0 - py0) * SR_SCALE;
        const ow = w * SR_SCALE, oh = h * SR_SCALE;
        const img = new ImageData(ow, oh);
        const id = img.data;
        for (let y = 0; y < oh; y++) {
          let q = (oy + y) * OWt + ox, i = y * ow * 4;
          for (let x = 0; x < ow; x++, q++, i += 4) {
            id[i] = od[q] * 255 + 0.5;
            id[i + 1] = od[N + q] * 255 + 0.5;
            id[i + 2] = od[2 * N + q] * 255 + 0.5;
            id[i + 3] = 255;
          }
        }
        if (result.output.dispose) result.output.dispose();
        if (big) {
          octx.putImageData(img, x0 * SR_SCALE, y0 * SR_SCALE);
        } else {
          tileCanvas.getContext('2d').putImageData(img, 0, 0);
          octx.drawImage(tileCanvas, 0, 0, ow, oh, dx0, dy0, dx1 - dx0, dy1 - dy0);
        }
        done++; worked++;
        if (onProgress) {
          const el = (performance.now() - t0) / 1000;
          // blend the measured pace with the up-front estimate so the countdown is sane from tile 1
          const measured = (el / done) * (total - done);
          const eta = done >= 2 ? measured : (measured + estTotal * (1 - done / total)) / 2;
          onProgress(`${M.label} enhancing ${Math.round((done / total) * 100)}%${gpu ? ' · GPU' : ''}`, { frac: done / total, eta });
        }
        await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
      }
    }
    if (worked > 0) {
      // learn this device's real speed (only from tiles that ran the network)
      const workedMP = (sw * sh / 1e6) * (worked / total);
      saveSpeed(kind, rt.ep, ((performance.now() - t0) / 1000) / workedMP);
    }
    if (src !== from) freeCanvas(src);
    freeCanvas(tileCanvas);
    let result = out;
    if (big) {
      onProgress && onProgress('Finishing…');
      result = OW === dw && OH === dh ? big : await hqResize(big, OW, OH, dw, dh, NO_SHARP, false);
      if (result !== big) freeCanvas(big);
    }
    if (alpha) {
      // the model works on RGB — carry the original transparency over with classic resampling
      const a = await hqResize(from, fw, fh, dw, dh, NO_SHARP, true);
      const ad = getImageData(a).data;
      const rctx = result.getContext('2d');
      const rid = rctx.getImageData(0, 0, dw, dh);
      for (let i = 3; i < rid.data.length; i += 4) rid.data[i] = ad[i];
      rctx.putImageData(rid, 0, 0);
      freeCanvas(a);
    }
    return result;
  }

  /** Resampler that uses AI for real upscales and classic resampling otherwise. */
  function makeResizer(engine, onProgress, notes) {
    if (!SR_MODELS[engine]) return hqResize;
    return async (from, fw, fh, dw, dh, sharp, alpha, filter) => {
      if (dw * dh < fw * fh * 1.44) return hqResize(from, fw, fh, dw, dh, sharp, alpha, filter);
      const r = await aiResize(from, fw, fh, dw, dh, engine, alpha, onProgress);
      if (notes && !notes.includes(SR_MODELS[engine].label)) notes.push(SR_MODELS[engine].label);
      return r;
    };
  }

  // ======================================================================
  // Background removal (Transformers.js, loaded on demand)
  // ======================================================================
  const MODELS = {
    object: { id: 'onnx-community/ormbg-ONNX', device: 'wasm', dtype: 'uint8', label: 'Any-object model', size: '44 MB' },
    people: { id: 'Xenova/modnet', device: 'wasm', dtype: 'fp32', label: 'People model', size: '26 MB' }
  };
  let tjs = null;
  const segCache = new Map();

  function pickModel(pref) {
    return pref === 'people' ? MODELS.people : MODELS.object;
  }

  async function getSegmenter(cfg, onProgress) {
    if (!tjs) {
      onProgress && onProgress('Loading AI engine…');
      tjs = await import(TJS_URL);
      tjs.env.allowLocalModels = false;
    }
    const key = cfg.id + '|' + cfg.device + '|' + cfg.dtype;
    if (!segCache.has(key)) {
      const files = new Map();
      const p = tjs.pipeline('background-removal', cfg.id, {
        device: cfg.device,
        dtype: cfg.dtype,
        progress_callback: (ev) => {
          if (!onProgress || !ev) return;
          if (ev.status === 'progress' && ev.total) {
            files.set(ev.file, { loaded: ev.loaded || 0, total: ev.total });
            let l = 0, t = 0;
            files.forEach((v) => { l += v.loaded; t += v.total; });
            onProgress(`Downloading ${cfg.label} (one time) — ${fmtBytes(l)} of ${fmtBytes(t)}`);
          } else if (ev.status === 'ready') {
            onProgress(`${cfg.label} ready`);
          }
        }
      });
      segCache.set(key, p);
      p.catch(() => segCache.delete(key));
    }
    return segCache.get(key);
  }

  /** Returns an opaque greyscale mask canvas (sw×sh): white = subject. */
  /**
   * Clean up the raw matte (in place, greyscale in a Uint8 array of w*h):
   *  - stretch so the confident subject becomes fully opaque and the background fully clear
   *  - optionally fill "holes": regions enclosed by the subject that the model left see-through
   *    (white logos, reflections, labels…). Background that touches the image border is never filled.
   */
  function cleanMatte(v, w, h, fillHoles) {
    let max = 0;
    for (let i = 0; i < v.length; i++) if (v[i] > max) max = v[i];
    const lo = 10, hi = Math.max(lo + 40, Math.min(215, max * 0.85));
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, Math.round(((i - lo) / (hi - lo)) * 255)));
    for (let i = 0; i < v.length; i++) v[i] = lut[v[i]];
    if (!fillHoles) return;
    // flood-fill the background from the borders through non-solid pixels
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;
    const OPEN = 250;
    const push = (i) => { if (!seen[i] && v[i] < OPEN) { seen[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const i = stack[--sp];
      const x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < w * (h - 1)) push(i + w);
    }
    // anything see-through that the outside background can't reach is a hole inside the subject
    for (let i = 0; i < v.length; i++) if (!seen[i] && v[i] < 255) v[i] = 255;
  }

  async function segmentMask(srcCanvas, sw, sh, pref, onProgress, fillHoles) {
    const cfg = pickModel(pref);
    const L = 1536;
    const k = Math.min(1, L / Math.max(sw, sh));
    const iw = Math.max(1, Math.round(sw * k)), ih = Math.max(1, Math.round(sh * k));
    const small = await hqResize(srcCanvas, sw, sh, iw, ih, NO_SHARP, false);

    const seg = await getSegmenter(cfg, onProgress);
    onProgress && onProgress('Finding the subject…');
    const RI = tjs.RawImage;
    const raw = typeof RI.fromCanvas === 'function' ? RI.fromCanvas(small) : await RI.fromBlob(await canvasToBlob(small, 'image/png'));
    const out = await seg(raw);
    const r = Array.isArray(out) ? out[0] : out;

    const mw = r.width, mh = r.height, ch = r.channels;
    const m = makeCanvas(mw, mh);
    const mctx = m.getContext('2d');
    const id = mctx.createImageData(mw, mh);
    const src = r.data, dst = id.data;
    const off = ch === 4 ? 3 : ch === 2 ? 1 : 0;
    const vals = new Uint8Array(mw * mh);
    for (let i = 0; i < mw * mh; i++) vals[i] = src[i * ch + off];
    cleanMatte(vals, mw, mh, fillHoles);
    for (let i = 0, j = 0; i < mw * mh; i++, j += 4) {
      dst[j] = dst[j + 1] = dst[j + 2] = vals[i];
      dst[j + 3] = 255;
    }
    mctx.putImageData(id, 0, 0);
    if (small !== srcCanvas) freeCanvas(small);
    if (mw === sw && mh === sh) return { mask: m, model: cfg };
    const full = await hqResize(m, mw, mh, sw, sh, NO_SHARP, false, 'hamming');
    freeCanvas(m);
    return { mask: full, model: cfg };
  }

  function refineMask(mask, edge) {
    if (edge === 'natural') return;
    const ctx = mask.getContext('2d');
    const w = mask.width, h = mask.height;
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    if (edge === 'sharp') {
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) {
        const t = Math.min(1, Math.max(0, (i - 70) / 115));
        lut[i] = Math.round(t * t * (3 - 2 * t) * 255);
      }
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = lut[d[i]];
    } else if (edge === 'soft') {
      // separable box blur, two passes
      const r = Math.max(1, Math.round(Math.max(w, h) / 900));
      const a = new Float32Array(w * h), b = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) a[i] = d[i * 4];
      const pass = (src, dst, horiz) => {
        const n = horiz ? w : h, m = horiz ? h : w;
        for (let line = 0; line < m; line++) {
          let acc = 0;
          const idx = (k) => (horiz ? line * w + k : k * w + line);
          for (let k = -r; k <= r; k++) acc += src[idx(Math.min(n - 1, Math.max(0, k)))];
          for (let k = 0; k < n; k++) {
            dst[idx(k)] = acc / (2 * r + 1);
            acc += src[idx(Math.min(n - 1, k + r + 1))] - src[idx(Math.max(0, k - r))];
          }
        }
      };
      pass(a, b, true); pass(b, a, false); pass(a, b, true); pass(b, a, false);
      for (let i = 0; i < w * h; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = a[i];
    }
    ctx.putImageData(id, 0, 0);
  }

  function maskBBox(mask) {
    const w = mask.width, h = mask.height;
    const d = getImageData(mask).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4] > 24) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03);
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function cropCanvas(c, r) {
    const out = makeCanvas(r.w, r.h);
    out.getContext('2d').drawImage(c, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return out;
  }

  // ======================================================================
  // Per-image processing
  // ======================================================================
  async function processItem(item, tool, s, onProgress) {
    const dec = await decodeItem(item);
    const notes = [];
    let canvas = null;
    try {
      const fmt = resolveFormat(item, tool, s);
      let src = dec.src, sw = dec.w, sh = dec.h;
      let dpi = 0;
      let hasAlpha = !!item.alpha;
      let blob;

      if (tool === 'compress') {
        const t = computeTarget(sw, sh, tool, s);
        if (t.limited) notes.push('Size limited by browser memory');
        canvas = t.w === sw && t.h === sh ? toCanvas(src, sw, sh) : await renderGeom(src, sw, sh, t, 'stretch', 'center', {}, NO_SHARP, hasAlpha);
        if (s.cmode === 'target') {
          onProgress && onProgress('Finding the best quality for ' + s.targetKB + ' KB…');
          const r = await encodeToTarget(canvas, fmt, Math.max(1, s.targetKB) * 1024, hasAlpha);
          blob = r.blob;
          if (r.canvas !== canvas) { freeCanvas(canvas); canvas = r.canvas; }
          if (r.missed) notes.push('Could not reach ' + s.targetKB + ' KB — this is the smallest possible');
          else if (canvas.width !== t.w) notes.push('Dimensions reduced to reach the target size');
        } else if (fmt === 'png' && Enc.canPalettePNG && s.quality < 100) {
          blob = await Enc.encodePalettePNG(getImageData(canvas), colorsFromQuality(s.quality));
        } else {
          blob = await encode(canvas, fmt, s.quality, 0, hasAlpha);
        }
        if (blob.size >= item.size && FORMATS[fmt].mime === item.mime && canvas.width === item.w && canvas.height === item.h) {
          blob = item.file;
          notes.push('Already optimized — original kept');
        }
        return { blob, canvas, fmt, notes, hasAlpha };
      }

      if (tool === 'bg') {
        let base = toCanvas(src, sw, sh);
        if (base === src) base = toCanvas(src, sw, sh); // never mutate the source
        const { mask, model } = await segmentMask(base, sw, sh, s.model, onProgress, !!s.fillHoles);
        notes.push(model.label);
        let m = mask;
        if (item.alpha) {
          // the upload already had transparency: never make transparent pixels visible again
          const bd = getImageData(base).data;
          const mctx = m.getContext('2d');
          const mid = mctx.getImageData(0, 0, sw, sh);
          const md = mid.data;
          for (let i = 0; i < md.length; i += 4) {
            const v = Math.round((md[i] * bd[i + 3]) / 255);
            md[i] = md[i + 1] = md[i + 2] = v;
          }
          mctx.putImageData(mid, 0, 0);
        }
        refineMask(m, s.edge);
        if (s.cropSubject) {
          const bb = maskBBox(m);
          if (bb) {
            const b2 = cropCanvas(base, bb), m2 = cropCanvas(m, bb);
            freeCanvas(base); freeCanvas(m);
            base = b2; m = m2; sw = bb.w; sh = bb.h;
          } else notes.push('No clear subject found');
        }
        onProgress && onProgress('Building the cut-out…');
        const t = computeTarget(sw, sh, tool, s);
        if (!t) throw new Error('Pick a size first');
        if (t.limited) notes.push('Size limited by browser memory');
        dpi = t.dpi;
        const fit = t.reshape ? s.fit : 'stretch';
        const up = (t.w * t.h) / (sw * sh);
        const img = await renderGeom(base, sw, sh, t, fit, s.position, { type: 'none' }, sharpParams(up > 1.05 ? 'soft' : 'off', Math.sqrt(up)), false);
        const msk = await renderGeom(m, sw, sh, t, fit, s.position, { type: 'black' }, NO_SHARP, false, up > 1 ? 'hamming' : undefined);
        // combine colour + mask -> RGBA cut-out (always on a fresh canvas so `base` stays intact)
        let cut = img;
        if (img === base) { cut = makeCanvas(t.w, t.h); cut.getContext('2d').drawImage(img, 0, 0); }
        const cctx = cut.getContext('2d');
        const cid = cctx.getImageData(0, 0, t.w, t.h);
        const md = getImageData(msk).data;
        const cd = cid.data;
        for (let i = 3; i < cd.length; i += 4) cd[i] = md[i - 3];
        cctx.putImageData(cid, 0, 0);
        if (msk !== m) freeCanvas(msk);
        if (s.bgType === 'transparent') {
          canvas = cut;
          hasAlpha = true;
        } else {
          canvas = makeCanvas(t.w, t.h);
          const x = canvas.getContext('2d');
          if (s.bgType === 'color') { x.fillStyle = s.bgColor; x.fillRect(0, 0, t.w, t.h); }
          else drawBlurCover(x, base, sw, sh, t.w, t.h);
          x.drawImage(cut, 0, 0);
          freeCanvas(cut);
          hasAlpha = false;
        }
        if (base !== canvas) freeCanvas(base);
        if (m !== canvas) freeCanvas(m);
      } else {
        // HD / Resize
        const t = computeTarget(sw, sh, tool, s);
        if (!t) throw new Error('Pick a size first');
        if (t.limited) notes.push('Size limited by browser memory');
        dpi = t.dpi;
        if (dec.svg) {
          // rasterise vectors directly at the needed scale — no resampling blur
          const f = Math.min(Math.max(t.w / sw, t.h / sh), Math.sqrt(MAX_AREA / (sw * sh)));
          const c = makeCanvas(sw * f, sh * f);
          c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
          src = c; sw = c.width; sh = c.height;
          hasAlpha = true;
        }
        if (tool === 'hd' && s.colors) {
          const c = src.tagName === 'CANVAS' ? src : toCanvas(src, sw, sh);
          enhanceColors(c);
          src = c;
        }
        const fit = t.reshape ? s.fit : 'stretch';
        const up = (t.w * t.h) / (sw * sh);
        const useAI = !!SR_MODELS[s.engine] && !dec.svg;
        const sharp = useAI ? NO_SHARP : sharpParams(resolveSharpen(s, tool, up), Math.sqrt(up));
        const resizer = useAI ? makeResizer(s.engine, onProgress, notes) : hqResize;
        if (fit === 'contain' && s.pad === 'transparent') hasAlpha = true;
        canvas = await renderGeom(src, sw, sh, t, fit, s.position, { type: s.pad, color: s.padColor }, sharp, hasAlpha, undefined, resizer);
        if (useAI && !notes.some((n) => n.startsWith('AI')) && tool === 'hd') notes.push('Already high-resolution — sharpened without AI');
        if (src !== dec.src && src !== canvas) freeCanvas(src);
      }

      if (fmt === 'ico') {
        const c2 = await fitWithin(canvas, 256, hasAlpha);
        if (c2 !== canvas) { freeCanvas(canvas); canvas = c2; notes.push('ICO is limited to 256 px'); }
      }
      onProgress && onProgress('Saving ' + FORMATS[fmt].label + '…');
      blob = await encode(canvas, fmt, s.quality, dpi, hasAlpha);
      if (!FORMATS[fmt].alpha && hasAlpha && tool === 'bg') notes.push(FORMATS[fmt].label + ' has no transparency — white background used');
      return { blob, canvas, fmt, notes, hasAlpha };
    } catch (e) {
      freeCanvas(canvas);
      throw e;
    } finally {
      dec.close && dec.close();
    }
  }

  async function makeThumb(canvasOrSrc, w, h, alpha, max = 480) {
    const k = Math.min(1, max / Math.max(w, h));
    const c = makeCanvas(w * k, h * k);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(canvasOrSrc, 0, 0, c.width, c.height);
    const b = await canvasToBlob(c, alpha ? 'image/png' : 'image/jpeg', 0.85);
    freeCanvas(c);
    return URL.createObjectURL(b);
  }

  // ======================================================================
  // File intake
  // ======================================================================
  let idSeq = 0;

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let room = MAX_FILES - state.items.length;
    let skippedMax = 0, skippedType = 0, skippedSize = 0;
    const added = [];
    for (const file of files) {
      const mime = guessMime(file);
      if (!mime) { skippedType++; continue; }
      if (file.size > MAX_FILE_BYTES) { skippedSize++; continue; }
      if (room <= 0) { skippedMax++; continue; }
      room--;
      const name = file.name || 'image';
      const dot = name.lastIndexOf('.');
      const item = {
        id: ++idSeq,
        file,
        name,
        base: (dot > 0 ? name.slice(0, dot) : name).replace(/[^\w\-. ()]+/g, '_').slice(0, 80) || 'image',
        mime,
        size: file.size,
        heic: /hei[cf]/.test(mime),
        svg: mime === 'image/svg+xml',
        w: 0, h: 0, alpha: false,
        thumbUrl: '', previewUrl: '',
        status: 'loading',
        result: null,
        error: null
      };
      state.items.push(item);
      added.push(item);
    }
    const msgs = [];
    if (skippedMax) msgs.push(`Max ${MAX_FILES} images per batch — ${skippedMax} skipped`);
    if (skippedType) msgs.push(`${skippedType} file(s) are not images`);
    if (skippedSize) msgs.push(`${skippedSize} file(s) are over 80 MB`);
    if (msgs.length) toast(msgs.join(' · '), true);
    if (!added.length) return;

    $('#workspace').hidden = false;
    render();
    if (state.items.length === added.length) {
      setTimeout(() => $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' }), 60);
    }
    added.reduce((p, item) => p.then(() => inspect(item)), Promise.resolve());
  }

  async function inspect(item) {
    try {
      const dec = await decodeItem(item);
      try {
        item.w = dec.w; item.h = dec.h;
        if (/png|webp|gif|avif|svg|x-icon|tiff|heif/.test(item.mime)) {
          const k = Math.min(1, 256 / Math.max(dec.w, dec.h));
          const c = makeCanvas(dec.w * k, dec.h * k);
          c.getContext('2d').drawImage(dec.src, 0, 0, c.width, c.height);
          const d = getImageData(c).data;
          for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { item.alpha = true; break; }
          freeCanvas(c);
        }
        item.thumbUrl = await makeThumb(dec.src, dec.w, dec.h, item.alpha);
        const displayable = /jpeg|png|webp|gif|avif|bmp|svg|x-icon/.test(item.mime) && !item.heic;
        item.previewUrl = displayable ? URL.createObjectURL(item.file) : URL.createObjectURL(item.decodedBlob || await canvasBlobFrom(dec.src, dec.w, dec.h));
      } finally { dec.close && dec.close(); }
      item.status = 'ready';
      if (state.items[0] === item && state.lock) syncLockedSize();
    } catch (e) {
      console.error(e);
      item.status = 'error';
      item.error = friendlyError(e);
    }
    if (state.items.includes(item)) render();
  }

  async function canvasBlobFrom(src, w, h) {
    const c = toCanvas(src, w, h);
    const b = await canvasToBlob(c, 'image/jpeg', 0.92);
    if (c !== src) freeCanvas(c);
    return b;
  }

  function revokeItem(item) {
    revokeLater(item.thumbUrl);
    revokeLater(item.previewUrl);
    revokeResult(item);
  }
  // Revoke after the DOM has re-rendered, so no <img>/<a> still points at a dead URL.
  const revokeLater = (u) => { if (u) setTimeout(() => URL.revokeObjectURL(u), 1500); };
  function revokeResult(item) {
    const r = item.result;
    if (!r) return;
    revokeLater(r.url);
    if (r.displayUrl !== r.url) revokeLater(r.displayUrl);
    revokeLater(r.thumbUrl);
    item.result = null;
  }

  function removeItem(id) {
    const i = state.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    revokeItem(state.items[i]);
    state.items.splice(i, 1);
    if (!state.items.length) $('#workspace').hidden = true;
    render();
  }

  function clearAll() {
    state.items.forEach(revokeItem);
    state.items = [];
    $('#workspace').hidden = true;
    render();
    $('#app').scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
  }

  function friendlyError(e) {
    const msg = (e && (e.message || String(e))) || 'Something went wrong';
    if (/cancelled/.test(msg)) return 'Stopped';
    if (/memory|alloc|bad_alloc|out of|too large/i.test(msg)) return 'Not enough memory for this size — try a smaller output or fewer images.';
    if (/fetch|network|Failed to load|import/i.test(msg)) return 'Network error while loading the AI model — check your connection and try again.';
    return msg.replace(/^Error:\s*/, '');
  }

  // ======================================================================
  // Run
  // ======================================================================
  async function run() {
    if (state.busy) return;
    const tool = state.tool;
    const s = JSON.parse(JSON.stringify(S()));
    const queue = state.items.filter((it) => it.status !== 'loading' && !(it.status === 'error' && !it.w));
    if (!queue.length) { toast('Add at least one image first.', true); return; }
    if (tool !== 'compress' && !baseSize(1000, 1000, s)) {
      const target = s.mode === 'custom' ? $('input[data-key="w"]') : $('#presetGrid');
      toast(s.mode === 'custom' ? 'Enter a width and height first.' : 'Pick a size from the presets first.', true);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        target.classList.remove('flash');
        requestAnimationFrame(() => target.classList.add('flash'));
        if (s.mode === 'custom') setTimeout(() => target.focus({ preventScroll: true }), 400);
      }
      return;
    }

    if ((tool === 'hd' || tool === 'resize') && s.engine === 'best' && !(await probeGPU())) {
      let mp = 0;
      for (const it of queue) {
        if (!it.w) continue;
        const t = computeTarget(it.w, it.h, tool, s);
        if (t && t.w * t.h >= it.w * it.h * 1.44) mp += (it.w * it.h) / 1e6;
      }
      const est = mp ? await estimateAISeconds('best', mp) : 0;
      if (est > 75) {
        const fastEst = await estimateAISeconds('fast', mp);
        const choice = await askSpeed(est, fastEst);
        if (choice === 'cancel') return;
        if (choice === 'fast') { s.engine = 'fast'; S().engine = 'fast'; persist(); syncUI(); }
      }
    }

    state.busy = true;
    state.cancel = false;
    state.runSig = state.tool + JSON.stringify(s);
    $('#afterRun').hidden = true;
    const prog = $('#progress'), bar = $('#progressBar'), ptxt = $('#progressText');
    prog.hidden = false;
    render();

    let ok = 0, failed = 0;
    // live status: refreshed every second so long AI runs never look frozen
    const live = { label: '', msg: '', frac: 0, deadline: 0, start: 0, index: 0 };
    const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    const paint = () => {
      if (!live.label) return;
      const el = (Date.now() - live.start) / 1000;
      let txt = `${live.label}: ${live.msg}`;
      if (el >= 3) txt += ` · ${mmss(el)} elapsed`;
      if (live.deadline) {
        const left = (live.deadline - Date.now()) / 1000;
        txt += left > 90 ? ` · about ${Math.round(left / 60)} min left` : left > 5 ? ` · about ${Math.round(left)}s left` : ' · almost done';
      }
      ptxt.textContent = txt;
      $('#mbarText').textContent = txt;
      // between tile updates, advance smoothly with time (never past 97% of the estimate)
      let frac = live.frac;
      if (live.deadline) {
        const left = Math.max(0, (live.deadline - Date.now()) / 1000);
        frac = Math.max(frac, Math.min(0.97, el / (el + left)));
      }
      bar.style.width = (((live.index + Math.min(1, frac)) / queue.length) * 100).toFixed(1) + '%';
    };
    const ticker = setInterval(paint, 1000);
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (!state.items.includes(item)) continue;
      item.status = 'busy'; item.error = null;
      revokeResult(item);
      renderFiles();
      Object.assign(live, { label: `Image ${i + 1} of ${queue.length}`, msg: item.name, frac: 0, deadline: 0, start: Date.now(), index: i });
      paint();
      await nextFrame();
      try {
        const r = await processItem(item, tool, s, (m, o) => {
          live.msg = m;
          if (o && typeof o.frac === 'number') live.frac = o.frac;
          if (o && typeof o.eta === 'number' && isFinite(o.eta)) live.deadline = Date.now() + o.eta * 1000;
          if (/^(Finishing|Saving)/.test(m)) live.deadline = 0;
          paint();
        });
        const fmt = FORMATS[r.fmt];
        const outW = r.canvas.width, outH = r.canvas.height;
        const suffix = tool === 'hd' ? (s.scale === '8k' ? '8k' : s.scale === '4k' ? '4k' : 'hd-' + s.scale + 'x')
          : tool === 'resize' ? outW + 'x' + outH : TOOL_TEXT[tool].suffix;
        const url = URL.createObjectURL(r.blob);
        let displayUrl = url;
        if (r.fmt === 'tiff') displayUrl = URL.createObjectURL(await canvasToBlob(r.canvas, r.hasAlpha ? 'image/png' : 'image/jpeg', 0.9));
        const thumbUrl = await makeThumb(r.canvas, outW, outH, r.hasAlpha);
        item.result = {
          blob: r.blob, url, displayUrl, thumbUrl,
          w: outW, h: outH, size: r.blob.size, fmt: r.fmt, notes: r.notes,
          name: `${item.base}-${suffix}.${fmt.ext}`,
          fit: tool !== 'compress' && s.mode !== 'original' && s.mode !== 'percent' ? s.fit : 'stretch',
          position: s.position || 'center',
          hasAlpha: !!r.hasAlpha,
          tool
        };
        freeCanvas(r.canvas);
        item.status = 'done';
        ok++;
      } catch (e) {
        if (state.cancel) { item.status = 'ready'; renderFiles(); break; }
        console.error('[image4k]', e);
        item.status = 'error';
        item.error = friendlyError(e);
        failed++;
      }
      renderFiles();
      await nextFrame();
      if (state.cancel) break;
    }
    clearInterval(ticker);
    live.label = '';
    for (const it of queue) if (it.status === 'busy') it.status = 'ready';
    const cancelled = state.cancel;
    state.cancel = false;
    bar.style.width = '100%';
    ptxt.textContent = cancelled ? `Stopped — ${ok} image${ok === 1 ? '' : 's'} finished` : failed ? `Done — ${ok} converted, ${failed} failed` : `Done — ${ok} image${ok === 1 ? '' : 's'} ready to download`;
    state.busy = false;
    $('#afterRun').hidden = ok < 2;
    render();
    if (ok && !cancelled) toast(ok === 1 ? 'Your image is ready — tap Download.' : `${ok} images ready — download them one by one or as a ZIP.`);
    if (ok) {
      const firstDone = $('.file.done');
      if (firstDone && window.innerWidth < 1060) firstDone.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
  }

  const fmtDuration = (sec) => (sec < 90 ? `${Math.max(5, Math.round(sec / 5) * 5)} seconds` : `${Math.round(sec / 60)} minutes`);

  /** Ask whether to wait for AI Best on a CPU-only device. Resolves 'best' | 'fast' | 'cancel'. */
  function askSpeed(bestSec, fastSec) {
    const dlg = $('#speedDialog');
    $('#speedFast').textContent = `Use AI Fast (recommended) · about ${fmtDuration(fastSec)}`;
    $('#speedBest').textContent = `Wait for AI Best · about ${fmtDuration(bestSec)}`;
    return new Promise((resolve) => {
      const done = (v) => { cleanup(); if (dlg.open) dlg.close(); resolve(v); };
      const onBest = () => done('best'), onFast = () => done('fast'), onCancel = () => done('cancel');
      const onClose = () => done('cancel');
      function cleanup() {
        $('#speedBest').removeEventListener('click', onBest);
        $('#speedFast').removeEventListener('click', onFast);
        $('#speedCancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('cancel', onClose);
      }
      $('#speedBest').addEventListener('click', onBest);
      $('#speedFast').addEventListener('click', onFast);
      $('#speedCancel').addEventListener('click', onCancel);
      dlg.addEventListener('cancel', onClose);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    });
  }

  function download(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
  }

  async function downloadZip() {
    const done = state.items.filter((i) => i.result);
    if (!done.length) return;
    if (typeof window.JSZip !== 'function') { toast('ZIP is unavailable — download images one by one.', true); return; }
    const btn = $('#zipBtn');
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.textContent = 'Preparing ZIP…';
    try {
      const zip = new window.JSZip();
      const used = new Set();
      for (const it of done) {
        let n = it.result.name, k = 1;
        while (used.has(n.toLowerCase())) { const d = it.result.name.lastIndexOf('.'); n = `${it.result.name.slice(0, d)}-${++k}${it.result.name.slice(d)}`; }
        used.add(n.toLowerCase());
        zip.file(n, it.result.blob);
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      download(url, `image4k-${TOOL_TEXT[state.tool].suffix}-${stamp}.zip`);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      console.error(e);
      toast('Could not create the ZIP: ' + friendlyError(e), true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  // ======================================================================
  // Rendering — files
  // ======================================================================
  const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  function fileCard(it) {
    const r = it.result;
    const badge = it.status === 'done' ? '<span class="file-badge ok">Done</span>'
      : it.status === 'busy' ? '<span class="file-badge busy">Working…</span>'
      : it.status === 'error' ? '<span class="file-badge err">Error</span>'
      : it.status === 'loading' ? '<span class="file-badge">Reading…</span>' : '';
    const type = (it.mime.split('/')[1] || '').replace('svg+xml', 'svg').replace('x-icon', 'ico').replace('jpeg', 'jpg').toUpperCase();
    const meta = it.w ? `${it.w} × ${it.h} · ${fmtBytes(it.size)} · ${esc(type)}` : `${fmtBytes(it.size)} · ${esc(type)}`;
    let out = '';
    if (r) {
      const diff = Math.round(((r.size - it.size) / it.size) * 100);
      const cls = diff <= 0 ? 'gain' : 'loss';
      const sign = diff > 0 ? '+' : '';
      out = `<div class="file-out">→ <b>${r.w} × ${r.h}</b> · ${fmtBytes(r.size)} · ${FORMATS[r.fmt].label} <span class="${cls}">${sign}${diff}%</span></div>`;
      if (r.notes && r.notes.length) out += `<div class="file-meta">${r.notes.map(esc).join(' · ')}</div>`;
      out += `<div class="file-actions">
        <a class="btn btn-primary" href="${r.url}" download="${esc(r.name)}">Download</a>
        <button class="btn btn-ghost" type="button" data-act="compare">Compare</button>
      </div>`;
    } else if (it.status === 'error') {
      out = `<div class="file-err">${esc(it.error || 'Failed')}</div>`;
    }
    const thumb = (r && r.thumbUrl) || it.thumbUrl;
    return `<div class="file ${it.status}" data-id="${it.id}">
      <div class="file-thumb">
        ${thumb ? `<img src="${thumb}" alt="${esc(it.name)}">` : ''}
        ${badge}
        ${r && r.hasAlpha && FORMATS[r.fmt].alpha ? '<span class="file-tag">Transparent ✓</span>' : ''}
        <button class="icon-btn" type="button" data-act="remove" aria-label="Remove ${esc(it.name)}" ${state.busy ? 'disabled' : ''}>${ICON_X}</button>
        <div class="progress-line"></div>
      </div>
      <div class="file-body">
        <div class="file-name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="file-meta">${meta}</div>
        ${out}
      </div>
    </div>`;
  }

  function renderFiles() {
    const list = $('#fileList');
    let html = state.items.map(fileCard).join('');
    if (state.items.length < MAX_FILES) {
      html += `<button class="add-tile" type="button" data-act="add">${ICON_PLUS}Add image<small style="font-weight:600;color:var(--muted)">${MAX_FILES - state.items.length} left</small></button>`;
    }
    list.innerHTML = html;
    $('#fileCount').textContent = `${state.items.length} / ${MAX_FILES}`;
  }

  // ======================================================================
  // Rendering — presets
  // ======================================================================
  function presetShape(p) {
    const r = p.w / p.h;
    const max = 40;
    let bw, bh;
    if (r >= 1) { bw = max; bh = Math.max(6, Math.round(max / r)); } else { bh = max; bw = Math.max(6, Math.round(max * r)); }
    const b = BRANDS[p.brand] || BRANDS.generic;
    const glyph = bw >= 16 && bh >= 12 ? esc(b.glyph || '') : '';
    return `<span class="preset-shape" style="width:${bw}px;height:${bh}px">${glyph}</span>`;
  }

  function renderPresetCats() {
    $('#presetCats').innerHTML = CATS.map(([id, label]) =>
      `<button class="chip" type="button" role="radio" data-cat="${id}" aria-checked="${state.presetCat === id}">${label}</button>`).join('');
  }

  function renderPresets() {
    const q = state.presetQuery.trim().toLowerCase();
    const sel = S().presetId;
    const list = PRESETS.filter((p) => (state.presetCat === 'all' || p.cat === state.presetCat) &&
      (!q || `${p.name} ${p.w}x${p.h} ${p.w} × ${p.h} ${p.brand} ${p.cat}`.toLowerCase().includes(q)));
    $('#presetGrid').innerHTML = list.length ? list.map((p) => {
      const b = BRANDS[p.brand] || BRANDS.generic;
      return `<button class="preset" type="button" role="radio" data-id="${p.id}" aria-checked="${p.id === sel}" style="--c:${b.color}" title="${esc(p.name)} — ${p.w} × ${p.h}">
        <span class="preset-icon">${presetShape(p)}</span>
        <span class="preset-name">${esc(p.name)}</span>
        <span class="preset-dim">${p.w} × ${p.h}</span>
      </button>`;
    }).join('') : '<div class="presets-empty">No sizes match your search.</div>';
  }

  function renderPalettes() {
    $$('[data-palette]').forEach((wrap) => {
      const key = wrap.dataset.palette;
      wrap.innerHTML = `<div class="palette" role="radiogroup" aria-label="Background color">
        ${PALETTE.map((c) => `<button type="button" class="swatch" role="radio" data-color="${c}" style="--sw:${c}" aria-label="${c}" title="${c}"></button>`).join('')}
        <label class="swatch swatch-custom" title="Custom color"><input type="color" data-color-input aria-label="Custom color"></label>
      </div>
      <div class="color-row"><span class="color-preview" data-color-preview></span><input class="input" data-hex type="text" maxlength="7" spellcheck="false" aria-label="Hex color" placeholder="#ffffff"></div>`;
      wrap.dataset.key = key;
    });
  }

  function syncPalettes() {
    const s = S();
    $$('[data-palette]').forEach((wrap) => {
      const key = wrap.dataset.palette;
      if (!(key in s)) return;
      const val = String(s[key]).toLowerCase();
      $$('.swatch[data-color]', wrap).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === val)));
      const ci = $('[data-color-input]', wrap);
      if (ci) ci.value = val;
      const hx = $('[data-hex]', wrap);
      if (hx && document.activeElement !== hx) hx.value = val;
      const pv = $('[data-color-preview]', wrap);
      if (pv) pv.style.background = val;
    });
  }

  // ======================================================================
  // Rendering — settings / UI sync
  // ======================================================================
  function whenOK(el) {
    const w = el.dataset.when;
    if (!w) return true;
    const s = S();
    return w.split(';').every((cond) => {
      const [k, vals] = cond.split('=');
      if (!(k in s)) return false;
      return vals.split(',').includes(String(s[k]));
    });
  }

  function syncUI() {
    const tool = state.tool, s = S();
    $$('[data-tools], [data-when]').forEach((el) => {
      const tools = el.dataset.tools ? el.dataset.tools.split(/\s+/) : null;
      el.hidden = (tools && !tools.includes(tool)) || !whenOK(el);
    });
    $$('[role=radiogroup][data-key]').forEach((g) => {
      const v = String(s[g.dataset.key]);
      $$('[role=radio]', g).forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === v)));
    });
    $$('input[data-key], select[data-key]').forEach((el) => {
      const k = el.dataset.key;
      if (!(k in s)) return;
      if (el.type === 'checkbox') el.checked = !!s[k];
      else if (document.activeElement !== el) el.value = s[k];
    });
    $$('[data-out]').forEach((el) => { const k = el.dataset.out; if (k in s) el.textContent = s[k]; });
    $$('#formatChips .chip').forEach((c) => {
      const f = c.dataset.value;
      const ok = f === 'auto' || support[f];
      c.hidden = !ok;
    });
    $('#lockBtn').setAttribute('aria-pressed', String(state.lock));

    // quality slider only for lossy output
    const lossyPossible = s.format === 'auto' || (FORMATS[s.format] && FORMATS[s.format].lossy);
    $('#qualityField').hidden = tool === 'compress' || !lossyPossible;

    // warnings
    const warn = [];
    if (tool === 'bg' && s.bgType === 'transparent' && (s.format === 'jpeg' || s.format === 'bmp')) warn.push(`${FORMATS[s.format].label} can't store transparency — the background will be white. Choose PNG or WebP to keep it transparent.`);
    if (tool === 'compress' && s.cmode === 'target' && s.format !== 'auto' && !FORMATS[s.format].lossy) warn.push('Target size needs JPG, WebP or AVIF — the best of those will be used.');
    if (s.format === 'ico') warn.push('ICO files are limited to 256 × 256 px.');
    if (s.format === 'tiff' || s.format === 'bmp') warn.push(`${FORMATS[s.format].label} files are uncompressed and can be large.`);
    if (tool === 'compress' && s.format === 'png' && s.cmode === 'quality') warn.push('PNG is compressed by reducing colors — lower quality = fewer colors.');
    const fw = $('#formatWarn');
    fw.hidden = !warn.length;
    fw.textContent = warn.join(' ');

    // model hint
    if (tool === 'bg') {
      $('#modelHint').textContent = s.model === 'people'
        ? 'Fast model tuned for people & portraits (≈26 MB, downloaded once and cached).'
        : 'Works on products, pets, people and objects (≈44 MB, downloaded once and cached).';
    }

    if (tool === 'hd' || tool === 'resize') {
      const eh = $('#engineHint');
      const msg = {
        best: 'Most accurate AI — keeps text, faces and shapes true to the original. 34 MB model, downloaded once.',
        fast: 'Lighter AI — about 10× quicker. Great for photos and drawings; small text may change slightly.',
        classic: 'Instant resampling — no AI. Edges stay soft when enlarging small images.'
      }[s.engine] || '';
      eh.textContent = msg;
      if (s.engine !== 'classic') probeGPU().then((g) => {
        if (S().engine !== s.engine) return;
        eh.textContent = msg + (g ? ' Your graphics card will be used — fast.'
          : s.engine === 'best' ? ' No graphics acceleration here, so it runs on your CPU and can take several minutes per image.'
            : ' Runs on your CPU — usually under a minute per image.');
      });
    }

    syncPalettes();
    $$('#presetGrid .preset').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === s.presetId)));
    $$('#presetCats .chip').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.cat === state.presetCat)));
    updateSummary();
  }

  function updateSummary() {
    const tool = state.tool, s = S();
    const sum = $('#summary');
    const first = state.items.find((i) => i.w);
    const n = state.items.filter((i) => i.status !== 'loading').length;
    const runBtn = $('#runBtn');
    let label = TOOL_TEXT[tool].run + (n > 1 ? ` (${n})` : '');
    let disabled = state.busy || !n;
    let html;
    state.invalid = '';
    if (!state.items.length) html = 'Add images to begin.';
    else if (tool !== 'compress' && s.mode === 'preset' && !presetById(s.presetId)) {
      html = '<b>Pick a size</b> from the presets to continue.';
      state.invalid = 'preset';
    } else if (tool !== 'compress' && s.mode === 'custom' && !(s.w > 0 && s.h > 0)) {
      html = '<b>Enter a width and height</b> to continue.';
      state.invalid = 'custom';
    } else if (!first) html = 'Reading your images…';
    else {
      const fmt = resolveFormat(first, tool, s);
      const flabel = FORMATS[fmt].label;
      if (tool === 'compress') {
        const t = computeTarget(first.w, first.h, tool, s);
        const how = s.cmode === 'target' ? `≤ ${s.targetKB} KB` : `${s.quality}% quality`;
        html = `Output${n > 1 ? ' (first image)' : ''}<span class="big">${t.w} × ${t.h} · ${flabel} · ${how}</span>`;
      } else if (tool === 'bg' && s.cropSubject && s.mode !== 'preset' && s.mode !== 'custom') {
        html = `Output<span class="big">Cropped to subject · ${flabel}</span>`;
      } else {
        const t = computeTarget(first.w, first.h, tool, s);
        if (t) {
          const p = s.mode === 'preset' ? presetById(s.presetId) : null;
          const tag = t.w >= 7680 || t.h >= 7680 ? ' · 8K' : Math.max(t.w, t.h) >= 3840 ? ' · 4K' : Math.max(t.w, t.h) >= 1920 ? ' · HD' : '';
          html = `${p ? esc(p.name) + ' · ' : ''}Output${n > 1 ? ' (first image)' : ''}<span class="big">${t.w} × ${t.h} px · ${flabel}${tag}</span>`;
          if (t.limited) html += '<span class="hint warn">Capped to the largest size this device can safely handle.</span>';
          if (tool === 'bg') html += `<span class="hint">Background: ${s.bgType === 'color' ? s.bgColor : s.bgType}</span>`;
        } else html = 'Choose a size to continue.';
      }
    }
    const hasResults = state.items.some((i) => i.result);
    if (!state.busy && hasResults && state.runSig && state.runSig !== tool + JSON.stringify(s)) {
      html += '<span class="hint stale">Settings changed — press the button again to update your images.</span>';
    }
    sum.innerHTML = html;
    if (state.busy) label = 'Working…';
    runBtn.textContent = label;
    runBtn.disabled = disabled;
    // mobile action bar mirrors the main button
    const showBar = !$('#workspace').hidden;
    $('#mbar').hidden = !showBar;
    document.body.classList.toggle('has-mbar', showBar);
    $('#mbarBtn').textContent = label;
    $('#mbarBtn').disabled = disabled;
    if (!state.busy) {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('.hint').forEach((h) => h.remove());
      $('#mbarText').innerHTML = tmp.innerHTML;
    }
    $('#cancelBtn').hidden = !state.busy;
    $('#clearBtn').disabled = state.busy;
    $('#addMoreBtn').disabled = state.items.length >= MAX_FILES;
  }

  function render() {
    renderFiles();
    syncUI();
  }

  function syncLockedSize() {
    const s = S();
    const first = state.items.find((i) => i.w);
    if (!first || !('w' in s) || !state.lock) return;
    s.h = Math.max(1, Math.round(s.w * first.h / first.w));
  }

  function setTool(tool, focus) {
    if (!TOOL_TEXT[tool]) return;
    state.tool = tool;
    $$('.tool-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tool === tool)));
    const tt = TOOL_TEXT[tool];
    $('[data-title]').innerHTML = `<span class="grad">Image4k</span>: ${tt.h1}`;
    $('[data-lead]').textContent = tt.lead;
    $('[data-dz-title]').textContent = tt.dz;
    $('[data-size-title]').textContent = tt.size;
    $('#workspace').setAttribute('aria-labelledby', 'tab-' + tool);
    $('#afterRun').hidden = state.items.filter((i) => i.result && i.result.tool === tool).length < 2;
    renderPresets();
    render();
    try { history.replaceState(null, '', '#' + tool); } catch (e) { /* ignore */ }
    if (focus) $('#app').scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
  }

  // ======================================================================
  // Compare dialog
  // ======================================================================
  /** Before/after slider: drag anywhere with mouse, finger or pen; arrow keys via the hidden range input. */
  function initBA(root) {
    const range = $('.ba-range', root);
    const set = (v) => {
      v = Math.max(0, Math.min(100, v));
      range.value = v;
      root.style.setProperty('--pos', v + '%');
    };
    root.baSet = set;
    range.addEventListener('input', () => { root.dataset.touched = '1'; set(+range.value); });
    const posFrom = (e) => {
      const r = root.getBoundingClientRect();
      return ((e.clientX - r.left) / r.width) * 100;
    };
    let dragging = false, startX = 0, startY = 0, decided = false;
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true; decided = e.pointerType === 'mouse';
      startX = e.clientX; startY = e.clientY;
      root.dataset.touched = '1';
      if (decided) {
        e.preventDefault();
        root.setPointerCapture(e.pointerId);
        root.classList.add('dragging');
        set(posFrom(e));
      }
    });
    root.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (!decided) {
        // touch: only take over horizontal swipes, let vertical swipes scroll the page
        const dx = Math.abs(e.clientX - startX), dy = Math.abs(e.clientY - startY);
        if (dx < 6 && dy < 6) return;
        if (dy > dx) { dragging = false; return; }
        decided = true;
        root.setPointerCapture(e.pointerId);
        root.classList.add('dragging');
      }
      set(posFrom(e));
    });
    const end = (e) => {
      if (dragging && !decided && e.type === 'pointerup') set(posFrom(e)); // a tap jumps to that spot
      dragging = false;
      root.classList.remove('dragging');
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('click', () => range.focus({ preventScroll: true }));
    set(+range.value || 50);
  }

  function openCompare(item) {
    const r = item.result;
    if (!r) return;
    const dlg = $('#compareDialog');
    const ba = $('#cmpBA');
    const before = $('#cmpBefore'), after = $('#cmpAfter');
    $('#cmpTitle').textContent = item.name;
    after.src = r.displayUrl;
    before.src = item.previewUrl || item.thumbUrl;
    before.style.objectFit = r.fit === 'cover' ? 'cover' : r.fit === 'contain' ? 'contain' : 'fill';
    const pos = { top: 'center top', bottom: 'center bottom', left: 'left center', right: 'right center' }[r.position] || 'center';
    before.style.objectPosition = pos;
    ba.dataset.w = r.w; ba.dataset.h = r.h;
    $('#cmpStage').classList.remove('zoom');
    $('#cmpZoom').setAttribute('aria-pressed', 'false');
    $('#cmpZoom').textContent = 'Zoom 100%';
    sizeCompare(false);
    $('#cmpDownload').href = r.url;
    $('#cmpDownload').setAttribute('download', r.name);
    $('#cmpInfoA').textContent = `Before: ${item.w} × ${item.h} · ${fmtBytes(item.size)}`;
    $('#cmpInfoB').textContent = `After: ${r.w} × ${r.h} · ${fmtBytes(r.size)} · ${FORMATS[r.fmt].label}`;
    $('.ba-range', ba).value = 50;
    ba.style.setProperty('--pos', '50%');
    const transparent = r.hasAlpha && FORMATS[r.fmt].alpha;
    $('#cmpNote').hidden = !transparent;
    setCmpBg('checker');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function setCmpBg(bg) {
    const st = $('#cmpStage');
    st.classList.toggle('bg-white', bg === 'white');
    st.classList.toggle('bg-black', bg === 'black');
    $$('.cmp-bg [data-bg]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.bg === bg)));
  }

  function sizeCompare(zoom) {
    const ba = $('#cmpBA');
    const w = +ba.dataset.w, h = +ba.dataset.h;
    if (!w || !h) return;
    if (zoom) {
      ba.style.width = w + 'px';
      ba.style.height = h + 'px';
    } else {
      const maxW = Math.min(1100, window.innerWidth - 26);
      const maxH = Math.max(200, window.innerHeight - 170);
      const k = Math.min(maxW / w, maxH / h);
      ba.style.width = Math.round(w * k) + 'px';
      ba.style.height = Math.round(h * k) + 'px';
    }
  }

  // ======================================================================
  // Hero demo
  // ======================================================================
  function initDemo() {
    const root = $('#demoBA');
    initBA(root);
    // one gentle sweep so visitors see it is interactive; stops as soon as they touch it
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const start = () => {
      if (root.dataset.touched) return;
      const t0 = performance.now(), D = 2800;
      const step = (now) => {
        if (root.dataset.touched) return;
        const t = Math.min(1, (now - t0) / D);
        root.baSet(50 + Math.sin(t * Math.PI * 2) * 30);
        if (t < 1) requestAnimationFrame(step); else root.baSet(50);
      };
      requestAnimationFrame(step);
    };
    const imgs = $$('img', root);
    Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = r; i.onerror = r; }))))
      .then(() => setTimeout(start, 700));
  }

  // ======================================================================
  // Events
  // ======================================================================
  function bind() {
    const input = $('#fileInput');
    const pick = () => { if (!state.busy || state.items.length < MAX_FILES) input.click(); };
    $('#pickBtn').addEventListener('click', pick);
    $('#addMoreBtn').addEventListener('click', pick);
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

    $('#pasteBtn').addEventListener('click', async () => {
      if (!navigator.clipboard || !navigator.clipboard.read) { toast('Press Ctrl+V (⌘V on Mac) to paste an image.'); return; }
      try {
        const items = await navigator.clipboard.read();
        const files = [];
        for (const ci of items) {
          const type = ci.types.find((t) => t.startsWith('image/'));
          if (type) {
            const b = await ci.getType(type);
            files.push(new File([b], `pasted-${Date.now()}.${type.split('/')[1]}`, { type }));
          }
        }
        if (files.length) addFiles(files); else toast('No image found on the clipboard.', true);
      } catch (e) {
        toast('Press Ctrl+V (⌘V on Mac) to paste an image.');
      }
    });
    document.addEventListener('paste', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (files.length) { e.preventDefault(); addFiles(files); }
    });

    // drag & drop (dropzone + whole page)
    const dz = $('#dropzone'), overlay = $('#dropOverlay');
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.classList.add('show'); });
    window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove('show'); });
    window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; overlay.classList.remove('show'); dz.classList.remove('drag');
      addFiles(e.dataTransfer.files);
    });
    dz.addEventListener('dragenter', () => dz.classList.add('drag'));
    dz.addEventListener('dragleave', (e) => { if (!dz.contains(e.relatedTarget)) dz.classList.remove('drag'); });
    dz.addEventListener('click', (e) => { if (e.target === dz || e.target.closest('.dz-icon, h2')) pick(); });

    // tools
    $$('.tool-btn').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $$('[data-goto]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); setTool(a.dataset.goto, true); }));

    // chips (generic)
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('[role=radiogroup][data-key] [role=radio]');
      if (chip && !chip.disabled) {
        const g = chip.closest('[role=radiogroup]');
        const key = g.dataset.key;
        S()[key] = chip.dataset.value;
        if (key === 'mode' && chip.dataset.value === 'custom' && state.lock) syncLockedSize();
        if (key === 'model' && state.tool === 'bg') S().fillHoles = chip.dataset.value !== 'people';
        if (key === 'engine') S().engineChosen = true;
        persist(); syncUI();
      }
    });
    // keyboard arrows within radiogroups
    document.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const cur = e.target.closest && e.target.closest('[role=radio]');
      if (!cur) return;
      const g = cur.closest('[role=radiogroup]');
      const opts = $$('[role=radio]', g).filter((o) => !o.hidden && !o.disabled && o.offsetParent !== null);
      const i = opts.indexOf(cur);
      if (i < 0) return;
      e.preventDefault();
      const n = opts[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + opts.length) % opts.length];
      n.focus(); n.click();
    });

    // inputs (generic)
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (!el.dataset || !el.dataset.key) return;
      const s = S(), k = el.dataset.key;
      if (!(k in s)) return;
      if (el.type === 'checkbox') s[k] = el.checked;
      else if (el.type === 'range' || el.type === 'number') {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        s[k] = v;
        if (state.lock && (k === 'w' || k === 'h')) {
          const first = state.items.find((i) => i.w);
          const ratio = first ? first.w / first.h : (s.w && s.h ? s.w / s.h : 1);
          if (k === 'w') s.h = Math.max(1, Math.round(v / ratio)); else s.w = Math.max(1, Math.round(v * ratio));
        }
      } else s[k] = el.value;
      persist(); syncUI();
    });
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (!el.dataset || !el.dataset.key) return;
      const s = S(), k = el.dataset.key;
      if (el.type === 'number') {
        const max = +el.max || 16384, min = +el.min || 1;
        s[k] = Math.min(max, Math.max(min, Math.round(+el.value || min)));
        el.value = s[k];
        persist(); syncUI();
      } else if (el.tagName === 'SELECT') { s[k] = el.value; persist(); syncUI(); }
    });
    $('#lockBtn').addEventListener('click', () => { state.lock = !state.lock; if (state.lock) syncLockedSize(); syncUI(); });

    // presets
    $('#presetGrid').addEventListener('click', (e) => {
      const b = e.target.closest('.preset');
      if (!b) return;
      S().presetId = b.dataset.id;
      persist(); syncUI();
    });
    $('#presetCats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      state.presetCat = b.dataset.cat;
      renderPresets(); syncUI();
    });
    $('#presetSearch').addEventListener('input', (e) => {
      state.presetQuery = e.target.value;
      if (state.presetQuery && state.presetCat !== 'all') state.presetCat = 'all';
      renderPresets(); syncUI();
    });

    // palettes
    document.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch[data-color]');
      if (!sw) return;
      const key = sw.closest('[data-palette]').dataset.palette;
      S()[key] = sw.dataset.color;
      persist(); syncUI();
    });
    document.addEventListener('input', (e) => {
      const el = e.target;
      const wrap = el.closest && el.closest('[data-palette]');
      if (!wrap) return;
      const key = wrap.dataset.palette;
      if (el.matches('[data-color-input]')) {
        S()[key] = el.value.toLowerCase();
        const hx = $('[data-hex]', wrap);
        if (hx) hx.value = S()[key];
        persist(); syncUI();
      }
      if (el.matches('[data-hex]')) {
        let v = el.value.trim();
        if (!v.startsWith('#')) v = '#' + v;
        if (/^#[0-9a-f]{6}$/i.test(v)) { S()[key] = v.toLowerCase(); persist(); syncUI(); }
        else if (/^#[0-9a-f]{3}$/i.test(v)) { S()[key] = ('#' + v.slice(1).split('').map((c) => c + c).join('')).toLowerCase(); persist(); syncUI(); }
      }
    });

    // file list actions
    $('#fileList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'add') { pick(); return; }
      const card = btn.closest('.file');
      const item = card && state.items.find((i) => i.id === +card.dataset.id);
      if (!item) return;
      if (act === 'remove' && !state.busy) removeItem(item.id);
      if (act === 'compare') openCompare(item);
    });
    $('#clearBtn').addEventListener('click', () => { if (!state.busy) clearAll(); });
    $('#runBtn').addEventListener('click', run);
    $('#mbarBtn').addEventListener('click', run);
    $('#cancelBtn').addEventListener('click', () => {
      if (!state.busy) return;
      state.cancel = true;
      $('#progressText').textContent = 'Stopping after the current step…';
    });
    $('#zipBtn').addEventListener('click', downloadZip);

    // compare dialog
    initBA($('#cmpBA'));
    const dlg = $('#compareDialog');
    $('#cmpClose').addEventListener('click', () => dlg.close());
    $$('.cmp-bg [data-bg]').forEach((b) => b.addEventListener('click', () => setCmpBg(b.dataset.bg)));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    $('#cmpZoom').addEventListener('click', (e) => {
      const z = !$('#cmpStage').classList.contains('zoom');
      $('#cmpStage').classList.toggle('zoom', z);
      e.currentTarget.setAttribute('aria-pressed', String(z));
      e.currentTarget.textContent = z ? 'Fit to screen' : 'Zoom 100%';
      sizeCompare(z);
    });
    window.addEventListener('resize', () => { if (dlg.open) sizeCompare($('#cmpStage').classList.contains('zoom')); });

    window.addEventListener('hashchange', () => {
      const h = location.hash.slice(1);
      if (TOOL_TEXT[h] && h !== state.tool) setTool(h);
    });
  }

  // ======================================================================
  // Init
  // ======================================================================
  function init() {
    const y = $('#year');
    if (y) y.textContent = new Date().getFullYear();
    renderPalettes();
    renderPresetCats();
    bind();
    initDemo();
    const fromHash = location.hash.slice(1);
    const fromQuery = new URLSearchParams(location.search).get('tool');
    const start = TOOL_TEXT[fromHash] ? fromHash : TOOL_TEXT[fromQuery] ? fromQuery : 'hd';
    state.tool = start;
    setTool(start);
    probeGPU().then((gpu) => {
      if (gpu) return;
      let changed = false;
      for (const t of ['hd', 'resize']) {
        if (!settings[t].engineChosen && settings[t].engine === 'best') { settings[t].engine = 'fast'; changed = true; }
      }
      if (changed) syncUI();
    });
    if (!picaInst) console.warn('[image4k] pica not loaded — using canvas resampling');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
