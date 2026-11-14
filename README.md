# Image4k.org

Free image tools that run entirely in the browser: **Make HD / 4K**, **Resize**, **Compress**, **Remove Background**.
Static site — no backend, no database, no build step. Images never leave the visitor's device.

## Features
- Drag & drop, file picker or paste · up to **10 images** per batch · 80 MB each
- Input: JPG, PNG, WebP, AVIF, GIF (first frame), BMP, SVG, HEIC/HEIF (iPhone)
- Output: JPG, PNG, WebP, BMP, TIFF, ICO (+ AVIF where the browser can encode it)
- **Make HD**: 2×, 4×, 4K (3840 px), 8K (7680 px) — **AI super-resolution (Real-ESRGAN)** in the browser:
  "AI Photo" (realesr-general-x4v3) and "AI Text & Art" (realesr-animevideov3), WebGPU when available, otherwise multi-threaded WASM;
  "Classic" (Lanczos3 + unsharp mask) as instant fallback. The Resize tool uses the same AI when it enlarges.
- **Resize**: 90+ presets (Instagram, YouTube, Facebook, X, LinkedIn, Pinterest, Twitch, ads, print, ratios, HD/4K/8K),
  custom size with aspect lock, percent, crop / fit (blur, color, transparent border) / stretch, "4K Ultra HD" toggle,
  print presets tagged 300 DPI
- **Compress**: quality slider or exact target size (KB); PNG compressed by color quantization; keeps the original if it is already smaller
- **Remove BG**: AI cut-out (ormbg for any object, MODNet for people), transparent / any color (palette + picker + hex) / blur,
  soft-natural-sharp edges, crop to subject
- Before/after compare with 100% zoom, per-image download, "Download all" ZIP
- Settings remembered per tool, mobile friendly, accessible (keyboard, ARIA), SEO + Open Graph + JSON-LD

## Files
```
index.html              main app + landing content
privacy.html terms.html 404.html
assets/css/style.css
assets/js/presets.js    all size presets (edit here to add more)
assets/js/encoders.js   BMP/TIFF/ICO/palette-PNG encoders, DPI tagging
assets/js/app.js        application logic
assets/vendor/          pica 9.0.1, JSZip 3.10.1, heic2any 0.0.4 (self-hosted)
assets/models/          Real-ESRGAN ONNX models (exported from the official weights) + BSD-3 license
assets/img/             favicon, icons, og-image, hero demo
_headers                security + caching headers (Netlify / Cloudflare Pages)
serve.py                local preview server with the same headers
```

## Run locally
```
python3 serve.py        # http://localhost:8080
```
(Opening index.html directly from disk will not work — it needs to be served over HTTP.)

## Deploy
Upload the folder as-is to any static host and point `image4k.org` at it.

- **Cloudflare Pages / Netlify**: deploy the folder; `_headers` is applied automatically.
- **Vercel / nginx / Apache**: copy the headers from `_headers`. nginx example:
```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net; worker-src 'self' blob: data: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self' blob: data: https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co https://*.hf.co; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "credentialless" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
error_page 404 /404.html;
```
COOP/COEP enable multi-threaded WebAssembly, which makes background removal ~3–4× faster in Chrome/Edge/Firefox.

## Notes
- AI upscaling: onnxruntime-web 1.31.1 loads from cdn.jsdelivr.net; the models are served from `/assets/models/`.
  Speed: seconds with a GPU (WebGPU, Chrome/Edge), ~30–60 s per 1 MP image on CPU. Tiled with overlap, so any image size works;
  inputs above ~1.6 MP (CPU) / 4 MP (GPU) are reduced first to keep processing time reasonable.
  The models were exported to ONNX from the official Real-ESRGAN v0.2.5.0 weights and verified against PyTorch (max diff 5e-6).
- The background-removal engine (Transformers.js 4.3.2) loads from cdn.jsdelivr.net and the models from huggingface.co
  the first time the tool is used, then the browser caches them. To self-host, change `TJS_URL` and `MODELS` in `app.js`
  and set `env.remoteHost` to your own model mirror.
- `'unsafe-eval'` in the CSP is required by the HEIC decoder (heic2any).
- Max output is capped to ~40 MP on desktop and ~16 MP on phones / low-memory devices to avoid browser crashes; the UI says when this happens.
- Licenses: pica, JSZip, heic2any — MIT; Transformers.js, ormbg, MODNet — Apache-2.0. All allow commercial use.
