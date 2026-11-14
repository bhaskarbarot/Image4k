/* Image4k.org — encoders the browser canvas does not provide natively.
 * BMP (24-bit), TIFF (RGBA, uncompressed), ICO (PNG-in-ICO),
 * palette PNG (lossy PNG compression via median-cut + dithering),
 * and DPI tagging for JPEG / PNG.
 */
(function () {
  'use strict';

  // ---------- CRC32 (PNG chunks) -------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
  }

  // ---------- BMP ----------------------------------------------------------
  function encodeBMP(imageData) {
    const { width: w, height: h, data } = imageData;
    const rowSize = Math.ceil((w * 3) / 4) * 4;
    const size = 54 + rowSize * h;
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x42; u8[1] = 0x4d;
    dv.setUint32(2, size, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, w, true);
    dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true);
    dv.setUint32(34, rowSize * h, true);
    dv.setInt32(38, 2835, true);
    dv.setInt32(42, 2835, true);
    for (let y = 0; y < h; y++) {
      let o = 54 + (h - 1 - y) * rowSize;
      let i = y * w * 4;
      for (let x = 0; x < w; x++, i += 4) {
        u8[o++] = data[i + 2];
        u8[o++] = data[i + 1];
        u8[o++] = data[i];
      }
    }
    return new Blob([buf], { type: 'image/bmp' });
  }

  // ---------- TIFF (baseline, RGBA, little-endian, single strip) -----------
  function encodeTIFF(imageData, dpi) {
    const { width: w, height: h, data } = imageData;
    dpi = dpi || 72;
    const tags = [
      [256, 4, 1, w],          // ImageWidth
      [257, 4, 1, h],          // ImageLength
      [258, 3, 4, 'bps'],      // BitsPerSample -> offset
      [259, 3, 1, 1],          // Compression: none
      [262, 3, 1, 2],          // Photometric: RGB
      [273, 4, 1, 'strip'],    // StripOffsets
      [277, 3, 1, 4],          // SamplesPerPixel
      [278, 4, 1, h],          // RowsPerStrip
      [279, 4, 1, w * h * 4],  // StripByteCounts
      [282, 5, 1, 'xres'],     // XResolution
      [283, 5, 1, 'yres'],     // YResolution
      [284, 3, 1, 1],          // PlanarConfiguration: chunky
      [296, 3, 1, 2],          // ResolutionUnit: inch
      [338, 3, 1, 2]           // ExtraSamples: unassociated alpha
    ];
    const ifdOffset = 8;
    const ifdSize = 2 + tags.length * 12 + 4;
    const bpsOffset = ifdOffset + ifdSize;      // 4 x uint16 = 8 bytes
    const xresOffset = bpsOffset + 8;           // rational = 8 bytes
    const yresOffset = xresOffset + 8;
    const stripOffset = yresOffset + 8;
    const total = stripOffset + w * h * 4;
    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x49; u8[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOffset, true);
    dv.setUint16(ifdOffset, tags.length, true);
    let p = ifdOffset + 2;
    const resolve = (v) => (v === 'bps' ? bpsOffset : v === 'strip' ? stripOffset : v === 'xres' ? xresOffset : v === 'yres' ? yresOffset : v);
    for (const [tag, type, count, value] of tags) {
      dv.setUint16(p, tag, true);
      dv.setUint16(p + 2, type, true);
      dv.setUint32(p + 4, count, true);
      if (type === 3 && count === 1) dv.setUint16(p + 8, value, true);
      else dv.setUint32(p + 8, resolve(value), true);
      p += 12;
    }
    dv.setUint32(p, 0, true);
    for (let i = 0; i < 4; i++) dv.setUint16(bpsOffset + i * 2, 8, true);
    dv.setUint32(xresOffset, dpi, true); dv.setUint32(xresOffset + 4, 1, true);
    dv.setUint32(yresOffset, dpi, true); dv.setUint32(yresOffset + 4, 1, true);
    u8.set(data, stripOffset);
    return new Blob([buf], { type: 'image/tiff' });
  }

  // ---------- ICO (single PNG image, <= 256px) -----------------------------
  async function encodeICO(pngBlob, w, h) {
    const png = new Uint8Array(await pngBlob.arrayBuffer());
    const out = new Uint8Array(22 + png.length);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, 0, true);
    dv.setUint16(2, 1, true);
    dv.setUint16(4, 1, true);
    out[6] = w >= 256 ? 0 : w;
    out[7] = h >= 256 ? 0 : h;
    out[8] = 0; out[9] = 0;
    dv.setUint16(10, 1, true);
    dv.setUint16(12, 32, true);
    dv.setUint32(14, png.length, true);
    dv.setUint32(18, 22, true);
    out.set(png, 22);
    return new Blob([out], { type: 'image/x-icon' });
  }

  // ---------- Palette PNG (lossy PNG compression) --------------------------
  const canPalettePNG = typeof CompressionStream === 'function';

  function medianCut(samples, n, maxColors) {
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const boxes = [{ s: 0, e: n }];

    function measure(box) {
      const min = [255, 255, 255, 255], max = [0, 0, 0, 0];
      for (let k = box.s; k < box.e; k++) {
        const o = order[k] * 4;
        for (let c = 0; c < 4; c++) {
          const v = samples[o + c];
          if (v < min[c]) min[c] = v;
          if (v > max[c]) max[c] = v;
        }
      }
      let ch = 0, range = -1;
      for (let c = 0; c < 4; c++) {
        const r = max[c] - min[c];
        if (r > range) { range = r; ch = c; }
      }
      box.ch = ch; box.range = range;
      box.score = range * Math.sqrt(box.e - box.s);
    }
    measure(boxes[0]);

    while (boxes.length < maxColors) {
      let bi = -1, best = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.e - b.s > 1 && b.range > 0 && b.score > best) { best = b.score; bi = i; }
      }
      if (bi < 0) break;
      const b = boxes[bi];
      const ch = b.ch;
      const sub = order.subarray(b.s, b.e);
      sub.sort((x, y) => samples[x * 4 + ch] - samples[y * 4 + ch]);
      const mid = b.s + ((b.e - b.s) >> 1);
      const a = { s: b.s, e: mid }, c = { s: mid, e: b.e };
      measure(a); measure(c);
      boxes.splice(bi, 1, a, c);
    }

    return boxes.map((b) => {
      let r = 0, g = 0, bl = 0, al = 0;
      const cnt = b.e - b.s;
      for (let k = b.s; k < b.e; k++) {
        const o = order[k] * 4;
        r += samples[o]; g += samples[o + 1]; bl += samples[o + 2]; al += samples[o + 3];
      }
      return [Math.round(r / cnt), Math.round(g / cnt), Math.round(bl / cnt), Math.round(al / cnt)];
    });
  }

  async function encodePalettePNG(imageData, maxColors, dpi) {
    const { width: w, height: h, data } = imageData;
    maxColors = Math.max(2, Math.min(256, maxColors | 0));
    const total = w * h;

    // 1. sample pixels
    const step = Math.max(1, Math.floor(total / 250000));
    const n = Math.ceil(total / step);
    const samples = new Uint8Array(n * 4);
    let si = 0;
    for (let p = 0; p < total; p += step) {
      const o = p * 4;
      if (data[o + 3] < 8) { si += 4; continue; } // transparent -> 0,0,0,0
      samples[si] = data[o]; samples[si + 1] = data[o + 1]; samples[si + 2] = data[o + 2]; samples[si + 3] = data[o + 3];
      si += 4;
    }
    const palette = medianCut(samples, n, maxColors);
    const pc = palette.length;
    const pr = new Int32Array(pc), pg = new Int32Array(pc), pb = new Int32Array(pc), pa = new Int32Array(pc);
    palette.forEach((c, i) => { pr[i] = c[0]; pg[i] = c[1]; pb[i] = c[2]; pa[i] = c[3]; });

    // 2. map with Floyd–Steinberg dithering (RGB) + nearest-colour cache
    const cache = new Int16Array(1 << 19).fill(-1);
    const nearest = (r, g, b, a) => {
      const key = ((r >> 3) << 14) | ((g >> 3) << 9) | ((b >> 3) << 4) | (a >> 4);
      let idx = cache[key];
      if (idx >= 0) return idx;
      let bd = Infinity;
      for (let i = 0; i < pc; i++) {
        const dr = r - pr[i], dg = g - pg[i], db = b - pb[i], da = a - pa[i];
        const d = dr * dr * 3 + dg * dg * 4 + db * db * 2 + da * da * 4;
        if (d < bd) { bd = d; idx = i; }
      }
      cache[key] = idx;
      return idx;
    };

    const raw = new Uint8Array(h * (w + 1));
    const DITHER = maxColors < 256 ? 0.85 : 0.6;
    let errCur = new Float32Array((w + 2) * 3);
    let errNext = new Float32Array((w + 2) * 3);
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let y = 0; y < h; y++) {
      raw[y * (w + 1)] = 0; // filter: none
      errNext.fill(0);
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const a = data[o + 3];
        let idx;
        const e = (x + 1) * 3;
        if (a < 8) {
          idx = nearest(0, 0, 0, 0);
        } else {
          const r = clamp(data[o] + errCur[e]);
          const g = clamp(data[o + 1] + errCur[e + 1]);
          const b = clamp(data[o + 2] + errCur[e + 2]);
          idx = nearest(r | 0, g | 0, b | 0, a);
          const er = (r - pr[idx]) * DITHER, eg = (g - pg[idx]) * DITHER, eb = (b - pb[idx]) * DITHER;
          // right
          errCur[e + 3] += er * 0.4375; errCur[e + 4] += eg * 0.4375; errCur[e + 5] += eb * 0.4375;
          // bottom-left, bottom, bottom-right
          errNext[e - 3] += er * 0.1875; errNext[e - 2] += eg * 0.1875; errNext[e - 1] += eb * 0.1875;
          errNext[e] += er * 0.3125; errNext[e + 1] += eg * 0.3125; errNext[e + 2] += eb * 0.3125;
          errNext[e + 3] += er * 0.0625; errNext[e + 4] += eg * 0.0625; errNext[e + 5] += eb * 0.0625;
        }
        raw[y * (w + 1) + 1 + x] = idx;
      }
      const t = errCur; errCur = errNext; errNext = t;
    }

    // 3. zlib-deflate the scanlines
    const zstream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
    const idat = new Uint8Array(await new Response(zstream).arrayBuffer());

    // 4. assemble PNG
    const ihdr = new Uint8Array(13);
    const idv = new DataView(ihdr.buffer);
    idv.setUint32(0, w); idv.setUint32(4, h);
    ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const plte = new Uint8Array(pc * 3);
    let hasAlpha = false;
    for (let i = 0; i < pc; i++) {
      plte[i * 3] = pr[i]; plte[i * 3 + 1] = pg[i]; plte[i * 3 + 2] = pb[i];
      if (pa[i] < 255) hasAlpha = true;
    }
    const parts = [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', ihdr)
    ];
    if (dpi) parts.push(physChunk(dpi));
    parts.push(pngChunk('PLTE', plte));
    if (hasAlpha) {
      const trns = new Uint8Array(pc);
      for (let i = 0; i < pc; i++) trns[i] = pa[i];
      parts.push(pngChunk('tRNS', trns));
    }
    parts.push(pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0)));
    return new Blob(parts, { type: 'image/png' });
  }

  // ---------- DPI tagging ---------------------------------------------------
  function physChunk(dpi) {
    const ppm = Math.round(dpi / 0.0254);
    const d = new Uint8Array(9);
    const dv = new DataView(d.buffer);
    dv.setUint32(0, ppm); dv.setUint32(4, ppm); d[8] = 1;
    return pngChunk('pHYs', d);
  }

  async function setDPI(blob, dpi) {
    if (!dpi) return blob;
    const u8 = new Uint8Array(await blob.arrayBuffer());
    if (blob.type === 'image/jpeg') {
      // JFIF APP0 directly after SOI
      if (u8[2] === 0xff && u8[3] === 0xe0 && u8[6] === 0x4a && u8[7] === 0x46 && u8[8] === 0x49 && u8[9] === 0x46) {
        u8[13] = 1;
        u8[14] = dpi >> 8; u8[15] = dpi & 0xff;
        u8[16] = dpi >> 8; u8[17] = dpi & 0xff;
        return new Blob([u8], { type: blob.type });
      }
      return blob;
    }
    if (blob.type === 'image/png') {
      // skip if already present
      for (let p = 8; p < u8.length - 8;) {
        const len = (u8[p] << 24 | u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3]) >>> 0;
        const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
        if (type === 'pHYs') return blob;
        if (type === 'IDAT') break;
        p += 12 + len;
      }
      const ihdrEnd = 8 + 25;
      return new Blob([u8.subarray(0, ihdrEnd), physChunk(dpi), u8.subarray(ihdrEnd)], { type: 'image/png' });
    }
    return blob;
  }

  window.Image4kEncoders = { encodeBMP, encodeTIFF, encodeICO, encodePalettePNG, canPalettePNG, setDPI };
})();
