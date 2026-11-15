/* Hole-filling inpainting (push-pull / normalized-convolution pyramid) — pure JS, no deps.
 * Fills the masked region with colour propagated from its surroundings. Good for removing
 * watermarks, logos and small objects. Exposes window.inpaintImage(imageData, mask).
 */
(function () {
  'use strict';
  // imageData: ImageData (RGBA). mask: Uint8Array length W*H, non-zero = hole to fill.
  function inpaintImage(imageData, mask) {
    const W = imageData.width, H = imageData.height, src = imageData.data;
    // level 0: colour + weight (0 in holes)
    let col = new Float32Array(W * H * 3), wt = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const known = mask[i] ? 0 : 1;
      wt[i] = known;
      col[i * 3] = src[i * 4] * known; col[i * 3 + 1] = src[i * 4 + 1] * known; col[i * 3 + 2] = src[i * 4 + 2] * known;
    }
    // Note: col stores weighted colour at L0 (0 where hole). After normalising below it becomes true colour.
    const levels = [{ w: W, h: H, col: normalise(col, wt, W * H), wt }];
    // PULL: build coarser levels
    let cw = W, ch = H;
    while (cw > 1 || ch > 1) {
      const nw = Math.max(1, Math.ceil(cw / 2)), nh = Math.max(1, Math.ceil(ch / 2));
      const L = levels[levels.length - 1];
      const ncol = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        let r = 0, g = 0, b = 0, sw = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const sx = x * 2 + dx, sy = y * 2 + dy; if (sx >= cw || sy >= ch) continue;
          const si = sy * cw + sx, ww = L.wt[si];
          r += L.col[si * 3] * ww; g += L.col[si * 3 + 1] * ww; b += L.col[si * 3 + 2] * ww; sw += ww;
        }
        const ni = y * nw + x;
        if (sw > 0) { ncol[ni * 3] = r / sw; ncol[ni * 3 + 1] = g / sw; ncol[ni * 3 + 2] = b / sw; }
        nwt[ni] = Math.min(1, sw / 4 * 4);   // keep in [0,1]; any coverage counts
        if (sw > 0) nwt[ni] = Math.min(1, sw);
      }
      levels.push({ w: nw, h: nh, col: ncol, wt: nwt });
      cw = nw; ch = nh;
      if (nw === 1 && nh === 1) break;
    }
    // PUSH: from coarsest down to level 0, fill low-weight pixels from the coarser level
    for (let l = levels.length - 2; l >= 0; l--) {
      const fine = levels[l], coarse = levels[l + 1];
      for (let y = 0; y < fine.h; y++) for (let x = 0; x < fine.w; x++) {
        const fi = y * fine.w + x, w = fine.wt[fi];
        if (w >= 0.999) continue;                 // already fully known
        // bilinear sample the coarse level
        const cx = x / 2, cy = y / 2;
        const c = bilinear(coarse, cx, cy);
        const a = w;                              // blend own colour by its weight
        fine.col[fi * 3] = a * fine.col[fi * 3] + (1 - a) * c[0];
        fine.col[fi * 3 + 1] = a * fine.col[fi * 3 + 1] + (1 - a) * c[1];
        fine.col[fi * 3 + 2] = a * fine.col[fi * 3 + 2] + (1 - a) * c[2];
        fine.wt[fi] = 1;
      }
    }
    // write filled colours back into the holes only
    const L0 = levels[0], out = new Uint8ClampedArray(src);
    for (let i = 0; i < W * H; i++) {
      if (!mask[i]) continue;
      out[i * 4] = L0.col[i * 3]; out[i * 4 + 1] = L0.col[i * 3 + 1]; out[i * 4 + 2] = L0.col[i * 3 + 2]; out[i * 4 + 3] = 255;
    }
    addDetail(out, mask, W, H);   // re-inject grain so textured fills don't look smeared
    return new ImageDataCtor(out, W, H);
  }

  // Add noise to each filled pixel matched to the local variance of the ORIGINAL surroundings,
  // so a fill over textured areas (rock, water, grain) blends instead of looking like a smooth blotch.
  function addDetail(out, mask, W, H) {
    let s = 0x9e3779b9 >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };
    const R = 3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const idx = y * W + x; if (!mask[idx]) continue;
      let n = 0, m0 = 0, m1 = 0, m2 = 0, q0 = 0, q1 = 0, q2 = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx; if (mask[j]) continue;      // only original (known) pixels
        const p = j * 4; const a = out[p], b = out[p + 1], c = out[p + 2];
        m0 += a; m1 += b; m2 += c; q0 += a * a; q1 += b * b; q2 += c * c; n++;
      }
      if (n < 6) continue;
      const sd0 = Math.sqrt(Math.max(0, q0 / n - (m0 / n) ** 2));
      const sd1 = Math.sqrt(Math.max(0, q1 / n - (m1 / n) ** 2));
      const sd2 = Math.sqrt(Math.max(0, q2 / n - (m2 / n) ** 2));
      const g = rnd(), p = idx * 4;
      out[p] += g * sd0 * 0.85; out[p + 1] += g * sd1 * 0.85; out[p + 2] += g * sd2 * 0.85;
    }
  }

  function normalise(weightedCol, wt, n) {
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const w = wt[i]; if (w > 0) { out[i * 3] = weightedCol[i * 3] / w; out[i * 3 + 1] = weightedCol[i * 3 + 1] / w; out[i * 3 + 2] = weightedCol[i * 3 + 2] / w; } }
    return out;
  }
  function bilinear(L, x, y) {
    const w = L.w, h = L.h;
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const p = (xx, yy) => { const i = (yy * w + xx) * 3; return [L.col[i], L.col[i + 1], L.col[i + 2]]; };
    const a = p(x0, y0), b = p(x1, y0), c = p(x0, y1), d = p(x1, y1);
    const out = [];
    for (let k = 0; k < 3; k++) out[k] = (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy;
    return out;
  }
  const ImageDataCtor = (typeof ImageData !== 'undefined') ? ImageData : function (d, w, h) { return { data: d, width: w, height: h }; };
  if (typeof window !== 'undefined') window.inpaintImage = inpaintImage;
  if (typeof module !== 'undefined') module.exports = { inpaintImage, ImageDataCtor };
})();
