# Open-source attribution & licence review

> Written for: the owner and anyone redistributing this site. Last reviewed 2026-11-16.

All tools in this repository are independent implementations. No source code was copied from the reference
projects listed in section 2; they were reviewed for features, UX patterns and architecture only.
Libraries in section 1 are redistributed unmodified (except removal of `sourceMappingURL` comments) in versioned
folders under `assets/vendor/`, each with its original licence file next to it.

## 1. Libraries shipped to the browser (added for the developer / API / QR tools)

| Library | Version | Licence | Commercial use | Where | Used for | Modifications | Attribution requirement |
|---|---|---|---|---|---|---|---|
| [js-yaml](https://github.com/nodeca/js-yaml) | 4.1.1 | MIT | Yes | `assets/vendor/js-yaml-4.1.1/` | YAML ⇄ JSON, OpenAPI YAML, workbench | none | keep `LICENSE` (included) |
| [sql-formatter](https://github.com/sql-formatter-org/sql-formatter) | 15.8.2 | MIT | Yes | `assets/vendor/sql-formatter-15.8.2/` | SQL formatter | source-map comment removed | keep `LICENSE` (included) |
| [jsdiff (`diff`)](https://github.com/kpdecker/jsdiff) | 8.0.4 | BSD-3-Clause | Yes | `assets/vendor/diff-8.0.4/` (ESM build) | Text diff | `.d.ts`/`.map` files not shipped | keep copyright + licence text (included); don't use authors' names to endorse |
| [hash-wasm](https://github.com/Daninet/hash-wasm) | 4.12.0 | MIT | Yes | `assets/vendor/hash-wasm-4.12.0/` | MD5 + streaming hashes of large files | none | keep `LICENSE` (included) |
| [qr-code-styling](https://github.com/kozakdenys/qr-code-styling) | 1.9.1 | MIT | Yes | `assets/vendor/qr-code-styling-1.9.1/` | QR rendering & styling (bundles qrcode-generator, MIT, © Kazuhiko Arase) | source-map comment removed | keep `LICENSE` (included) |
| [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | Apache-2.0 | Yes | `assets/vendor/jsqr-1.4.0/` | in-page scan verification of generated QR codes | none | keep `LICENSE` (included); state changes (none) |

Pre-existing libraries (unchanged by this work): pica, JSZip, heic2any (MIT), PDFium via @embedpdf/pdfium
(MIT / Apache-2.0 / BSD), Liberation & Carlito fonts (SIL OFL 1.1), Tesseract.js (Apache-2.0),
onnxruntime-web (MIT), Real-ESRGAN models (BSD-3), Transformers.js (Apache-2.0).

Browser platform APIs used instead of libraries: Web Crypto (SHA hashes, HMAC/RSA/RSA-PSS/ECDSA JWT signing and
verification, random IDs), `crypto.randomUUID`, `TextEncoder/TextDecoder`, `URL`, `Web Workers`.

## 2. Reference projects reviewed (no code reused)

| Project | Repository | Licence (GitHub API, 2026-11-16) | What we looked at | Code reused |
|---|---|---|---|---|
| IT-Tools | github.com/CorentinTh/it-tools | **GPL-3.0** | tool catalogue, one-tool-per-route layout, search | **None** — GPL code must not be copied into this non-GPL site |
| CyberChef | github.com/gchq/CyberChef | Apache-2.0 | operation registry + recipe/pipeline concept, input/output panes | None (our workbench is an independent design; name/branding not used) |
| Hoppscotch | github.com/hoppscotch/hoppscotch | MIT | request builder tabs (params/headers/auth/body), response viewer | None |
| JSON Crack | github.com/AykutSarac/jsoncrack.com | Apache-2.0 | JSON tooling UX | None |
| Tesseract.js | github.com/naptha/tesseract.js | Apache-2.0 | already used by the existing OCR tool | Library (pre-existing) |
| Stirling-PDF | github.com/Stirling-Tools/Stirling-PDF | NOASSERTION (mixed; core historically GPL/AGPL-style) | not used | **None** (already on the project's do-not-copy list) |
| FFmpeg.wasm | github.com/ffmpegwasm/ffmpeg.wasm | MIT (wrapper; FFmpeg core is LGPL/GPL depending on build) | not needed for this scope | None |

## 3. Test-only tools (never deployed)

| Tool | Licence | Purpose |
|---|---|---|
| playwright-core 1.56.1 | Apache-2.0 | browser E2E tests (drives the system Chrome) |
| zxing-cpp 3.1.1 (Python) | Apache-2.0 | independent QR decoder that re-checks every exported QR file in `tests/e2e/qr.e2e.mjs` |
| Pillow 13.0.0 (Python) | MIT-CMU (HPND) | image loading for zxing-cpp in tests |
| wrangler 4.156.2 | MIT OR Apache-2.0 | runs Pages Functions + local D1 for API/webhook E2E tests |

## 4. Obligations checklist
- [x] Every shipped library keeps its licence file in its vendor folder.
- [x] No GPL/AGPL code copied (IT-Tools, Stirling-PDF explicitly excluded).
- [x] No third-party branding or trademarks used (CyberChef is mentioned only descriptively as "inspired by").
- [x] Apache-2.0 jsQR redistributed unmodified with its licence.
