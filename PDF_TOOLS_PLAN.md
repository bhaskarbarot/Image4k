# Image4k — PDF Tools: Full Plan, Guide & Handoff

> **RELEASED to `main` 2026-11-14** (commit after Phase 4a). Live: hub at `/`, image tools at `/image`, PDF tools at `/pdf`.
> Done: Phases 1,2,3,5 + Compress + Bhaskar Solution home page. Pending: Enhance-to-HD and the image "Make HD" quality
> fix — both wait on diagnosing the shared Real-ESRGAN AI (need a Chrome console trace). Password "breaker" intentionally not built.

> Written for: any developer or AI coding agent (e.g. Google Antigravity) continuing this project, and for the owner.
> Last updated: 2026-11-14 · Owner: Bhaskar Barot (GitHub `bhaskarbarot`)

---

## 1. What this project is

**Image4k** is a free, private, browser-only website. Nothing is uploaded — all processing happens on the visitor's device.

| Part | URL | Status |
|---|---|---|
| Image tools (Make HD, Resize, Compress, Remove BG) | https://image4k.pages.dev | ✅ LIVE (branch `main`) |
| PDF tools (`/pdf`) | https://pdf-tools.image4k.pages.dev/pdf | 🔄 PREVIEW (branch `pdf-tools`) |
| Repository | https://github.com/bhaskarbarot/Image4k | |

Hosting: **Cloudflare Pages** (free). Every push to `main` updates the live site in ~30 s. Every push to another
branch creates a **preview** at `https://<branch>.image4k.pages.dev`.

PDF tools design: **matte wine red (#7B1F2E) & white, Adobe-style** light workspace. One PDF at a time (Merge is the
only tool that takes several).

---

## 2. Golden rules (do not break these)

1. **Never touch the live site until the owner approves.** Work only on branch **`pdf-tools`**. Do not push to `main`,
   do not merge, do not change `index.html` / `assets/js/app.js` image logic unless the task says so.
2. **Git identity is per-repo and already configured.** Commits must be `bhaskarbarot <barotb076@gmail.com>`
   (check with `git config user.email`). Never use any other account/email. **Do not add a `Co-Authored-By` line.**
   Push with: `GIT_TERMINAL_PROMPT=0 git push origin pdf-tools`.
3. **Licenses: no AGPL / GPL code.** Do not copy code from BentoPDF, Stirling-PDF, MuPDF/PyMuPDF (AGPL). Allowed:
   MIT, Apache-2.0, BSD, SIL OFL (fonts). Current deps: PDFium wasm (@embedpdf/pdfium MIT, PDFium Apache/BSD),
   Liberation fonts (OFL), JSZip (MIT), pica (MIT), onnxruntime-web (MIT), Real-ESRGAN models (BSD-3).
4. **Everything runs in the browser.** No server, no uploads, no tracking. Self-host libraries under `assets/vendor/`.
5. **Cache busting:** after editing any `assets/pdf/*.js|css`, bump the `?v=` value where it is referenced
   (in `pdf.html`, and **every** `import ... from './engine.js?v=…'`). All imports of the same module MUST use the
   **same** `?v=` string, otherwise the browser loads two separate copies (see Task 0).
   Image site: bump `?v=` on `style.css` / `app.js` links in `index.html`, `privacy.html`, `terms.html`, `404.html`.
6. **Never put two Cache-Control rules on the same path** in `_headers` (Cloudflare merges them into a broken header).
   `/assets/vendor/*` = immutable (put new libraries in a **versioned folder**, e.g. `pdfium-2.15.1/`);
   `/assets/js/*`, `/assets/css/*`, `/assets/pdf/*` = always revalidate.
7. **Security headers (CSP) are strict.** No inline `<script>`; scripts only from `'self'` (+ jsDelivr already allowed).
   Fonts from `'self'` and Google Fonts. If you add a new external source, update `_headers` CSP.
8. **Repo-only files must stay private:** list them in `.assetsignore` (the Cloudflare build copies everything else).
9. **Test before every push** (Section 9) and verify output PDFs with a *second* engine (poppler: `pdftotext`,
   `pdffonts`, `pdfinfo`, `pdfimages`, `pdftoppm`).

---

## 3. How to run it locally

```bash
cd image4k
python3 serve.py 8093          # serves the site with the SAME headers as production (_headers)
# open http://localhost:8093        → image tools
# open http://localhost:8093/pdf    → PDF tools
```
Do **not** open the HTML files directly (`file://`) — modules, wasm and headers need a server.
After changing JS/CSS press **Ctrl+Shift+R** in the browser.

Useful checks (poppler is installed on the owner's Linux machine):
```bash
pdftotext -layout out.pdf -     # text really in the file
pdffonts out.pdf                # fonts used (original subset font kept? fallback added?)
pdfinfo out.pdf                 # page count, page size, "Encrypted: yes/no"
pdfimages -list out.pdf         # images inside the PDF
pdftoppm -r 80 -png out.pdf p   # render pages to PNG to look at them
```

---

## 4. Deploy & release

- **Preview:** `git push origin pdf-tools` → https://pdf-tools.image4k.pages.dev/pdf (≈30 s).
- **Release (only when the owner says "release"):** merge `pdf-tools` into `main`, push `main`, then verify
  https://image4k.pages.dev/pdf and re-run the image-site checks.
- Cloudflare Pages build settings (already set — do not change):
  Build command `mkdir -p dist && tar -c --exclude-from=.assetsignore --exclude=./dist . | tar -x -C dist`,
  output directory `dist`, framework preset None.

---

## 5. Project structure

```
image4k/
├── index.html, privacy.html, terms.html, 404.html   # image site (LIVE) — header has "PDF Tools · NEW" button (on pdf-tools branch)
├── pdf.html                    # PDF tools page: landing, editor, organize, merge, split views + dialogs
├── assets/
│   ├── css/style.css           # image site styles (dark theme)
│   ├── js/app.js               # image site logic (AI upscaling, resize, compress, remove BG) — do not break
│   ├── pdf/
│   │   ├── engine.js           # ★ PdfDoc class: wrapper around PDFium wasm (all real PDF changes)
│   │   ├── editor.js           # ★ PDF editor UI + page routing (entry module of pdf.html)
│   │   ├── pages.js            # ★ Organize / Merge / Split (Phase 2, written, NOT wired yet)
│   │   └── pdf.css             # wine-red & white theme for /pdf
│   ├── vendor/
│   │   ├── pdfium-2.15.1/      # pdfium.esm.js + pdfium.wasm (4.6 MB) + LICENSE
│   │   ├── liberation-2.1.5/   # 12 fallback fonts (Sans/Serif/Mono × Regular/Bold/Italic/BoldItalic) + OFL license
│   │   └── jszip.min.js, pica.min.js, heic2any.min.js
│   └── models/                 # Real-ESRGAN ONNX models for image AI (used by app.js)
├── _headers                    # security + caching headers (Cloudflare)
├── .assetsignore               # files NOT published (README, serve.py, configs, this plan…)
├── serve.py                    # local server mirroring _headers
├── wrangler.jsonc              # only used if deployed as a Cloudflare Worker
├── README.md
└── PDF_TOOLS_PLAN.md           # this file
```

---

## 6. Architecture

### 6.1 Engine — `assets/pdf/engine.js` (`PdfDoc`)
PDFium compiled to WebAssembly, loaded once (`loadModule()`), wasm from `/assets/vendor/pdfium-2.15.1/`.
Coordinates: **page space** = PDF points, y up · **view space** = points, y down, page rotation applied
(what the user sees at 100 %). Convert with `toView(i,x,y)` / `toPage(i,vx,vy)`.

| Method | What it does |
|---|---|
| `await PdfDoc.open(bytes, password)` | open; throws `e.code === 4` when a password is needed/wrong |
| `await PdfDoc.create()` | new empty PDF |
| `load(bytes, pw)` / `close()` / `destroy()` | reload (used for undo) / free memory |
| `pageCount`, `size(i)` → `{w,h}` | page count and view size in points |
| `render(i, scale)` → `ImageData` | draw page (scale 1 = 72 dpi) |
| `objects(i)` | editable items: text **lines** (runs grouped by baseline + same font) and images. Each: `{kind, objs[], text, box{x,y,w,h} (view pts), base (font name), size, color[r,g,b,a], font{family,bold,italic,subset}, embedded, broken, runs[]}` |
| `await editText(i, line, text, opts)` | change text; keeps original font if every letter exists in it, else rebuilds the line with a matching Liberation font (same size/colour/matrix). `opts {family,bold,italic,size,color}` forces a style |
| `move(i, objs, dx, dy)` | move (view points) |
| `resizeTo(i, imgObj, box)` | resize image to view box |
| `remove(i, objs)` | delete objects |
| `await addText(i, vx, vy, text, {family,bold,italic,size,color})` | new text (vy = baseline) |
| `addImage(i, ImageData, box)` / `replaceImage(i, obj, ImageData)` | images (alpha supported → signatures) |
| `setHidden(objs, hidden, colors)` | temporary hide while the inline editor is open |
| `importPages(srcDoc, indices[], at)` | copy pages between documents (Phase 2) |
| `addBlankPage(at,w,h)`, `deletePage(i)`, `rotation(i)`, `setRotation(i,q)`, `cropToView(i, fromDoc, fromIndex, rect)` | page operations (Phase 2) |
| `commit(i)` | `FPDFPage_GenerateContent` — required after object changes, before save |
| `save()` → `Uint8Array` | full save |

Raw PDFium functions are on `this.P` (e.g. `this.P.FPDF_GetPageCount`). Memory helpers: `malloc/free/heap/wide`.
Full function list: `@embedpdf/pdfium@2.15.1/dist/vendor/functions.d.ts` (on jsDelivr).

### 6.2 Editor — `assets/pdf/editor.js`
State object `state` (doc, zoom, tool, pages[], sel, editing, undo/redo snapshots).
Undo = full PDF byte snapshots (`doc.save()` before each change, `doc.load()` to restore) — simple and safe.
Rendering: one `.ppage` per page (canvas + `.poverlay` with `.pobj` boxes), lazy via IntersectionObserver.
Text editing: click a line → object hidden (alpha 0) → `contenteditable` box styled like the text → Enter commits.
Test hook: `window.__pdfEditor = { state, openFile }`.

### 6.3 Page tools — `assets/pdf/pages.js`
Organize keeps a **model** (`org.pages = [{key, doc, index, rot, crop, blank}]`) and only builds a real PDF on
download (`buildPdf(specs)` → new doc + `importPages` + rotation/crop). Merge/Split also use `buildPdf`.
Entry points: `initPageTools(helpers)` and `pageTools.organize(file) / merge(files) / split(file) / organizeAdd(file)`.
`helpers` must provide: `toast(msg, isError)`, `busy(on, text)`, `askPassword(retry, fileName)`,
`showView(name)`, `openInEditor(file)`. Test hook: `window.__pdfPages`.

### 6.4 `pdf.html` element IDs (for wiring)
- Views: `#landing`, `#editor`, `#organize`, `#merge`, `#split` (each `hidden` except the active one).
- Landing tool cards: `button[data-open="edit|sign|merge|split|organize"]` (others still `<div class="ptool">… Soon`).
- Back links inside tool views: `button[data-back]` → landing.
- File inputs: `#pdfInput` (editor), `#toolInput` (single PDF for split/organize), `#mrgInput` (multiple),
  `#orgAddInput`, `#imgInput`, `#signInput`.
- Header (editor only): `#docBar`, `#docActions`, `#downloadBtn`, `#openOther`.
- Dialogs: `#signDialog`, `#pwDialog`, `#cropDialog`.

---

## 7. How to use (end-user guide — also good for the site's help text)

**Edit PDF** — Select a PDF → click any text and type (Enter = done, Esc = cancel) → drag text or images to move →
select + Delete to remove → *Add text*: click the tool, then click on the page → *Image*: pick a picture
(drag to move, corner handle to resize) → *Sign*: draw / type / upload → Undo/Redo (Ctrl+Z / Ctrl+Y) → Download.
The right panel can change a line's style (Sans/Serif/Mono), size, bold, italic, colour.

**Merge PDF** — add 2+ PDFs → drag (or ↑ ↓) to order → optional "Pages" per file (e.g. `1-3, 7`) → Merge & download.

**Split PDF** — choose: every page · every N pages · custom ranges (`1-3, 4-7, 9`) · pick pages → Split & download
(several files come as one ZIP).

**Organize pages** — click pages to select (Shift = range, Ctrl+A = all) → drag to reorder or use ‹ › →
rotate ↺ ↻ · delete ✕ · Crop (drag the frame) · Extract selected · Add PDF · Blank page · Undo/Redo → Download.
"Edit content" opens the result in the editor.

**(Coming)** PDF → JPG/PNG · Images → PDF · Extract · Compress · Enhance to HD · Protect · Unlock.

---

## 8. Status & tasks

### ✅ Phase 1 — PDF Editor (DONE · committed `9f9d234` on `pdf-tools` · live on preview)
Edit text in original font with automatic font fallback · move · delete · add text · images (add/replace/resize) ·
signatures (draw/type/upload) · undo/redo · password-protected PDFs open · download · mobile layout ·
"PDF Tools · NEW" button in the image site header/footer. Tests passed: 13/13 editor flow, real Word & macOS PDFs,
image-site audit 111/111.

### ✅ Phase 2 — Organize / Merge / Split (DONE · wired + tested on `pdf-tools`)
Done (uncommitted on `pdf-tools`): engine page operations, `pages.js`, views in `pdf.html`, styles in `pdf.css`.

**Task 0 — fix module version mismatch (do first).**
`editor.js` line 2 imports `./engine.js?v=pdf2`, `pages.js` imports `./engine.js?v=pdf3`. Make both the same
(e.g. `?v=pdf4`) and bump `pdf.html` → `editor.js?v=pdf4`, `pdf.css?v=pdf4`.

**Task 1 — wire Phase 2 in `editor.js`:**
1. `import { initPageTools, pageTools } from './pages.js?v=pdf4';`
2. Add `showView(name)`: hide all of `#landing #editor #organize #merge #split`, show `#<name>`;
   `#docBar`/`#docActions` visible only for `editor`; `document.body.classList.toggle('is-editing', name==='editor')`;
   scroll to top. Replace the manual hiding in `openFile()` with `showView('editor')`.
3. Change `askPassword(retry)` → `askPassword(retry, fileName)` (show the file name in `#pwTitle` or a note).
4. Call `initPageTools({ toast, busy, askPassword, showView, openInEditor: (file) => openFile(file) })` in `bind()`.
5. Tool cards: replace the current `[data-open]` handler:
   `edit`/`sign` → `#pdfInput` (as now); `organize`/`split` → `#toolInput` then `pageTools.organize(f)` / `pageTools.split(f)`;
   `merge` → `#mrgInput` (multiple) then `pageTools.merge(files)` (pages.js already listens to `#mrgInput`
   **inside the Merge view**; for the landing card, open the same input and make sure the merge view is shown).
   Remember which tool opened `#toolInput` (e.g. `state.pendingTool`).
6. `[data-back]` buttons → `showView('landing')`.
7. Drag & drop (`window` `drop` handler): editor/landing → open in editor (current behaviour);
   merge view → `pageTools.merge(files)`; organize view → `pageTools.organizeAdd(file)`; split view → `pageTools.split(file)`.
8. The editor's keyboard handler must ignore keys when `#editor` is hidden (it already checks this).

**Task 2 — test Phase 2** (Section 9) → commit → push `pdf-tools`.

### ✅ Phase 3 — Convert & Extract (DONE · PDF→image, Image→PDF, Extract on `pdf-tools`)
| # | Tool | How (PDFium) | Done when |
|---|---|---|---|
| 3 | **PDF → JPG/PNG** | `doc.render(i, dpi/72)` → canvas → `toBlob`; pages via range input; 1 file or ZIP | 72/150/300 dpi work; page count & size correct; ZIP for many pages |
| 4 | **Images → PDF** | `PdfDoc.create()` → `addBlankPage(at, w, h)` (A4 595×842, Letter 612×792, or image size) → `addImage(i, ImageData, box)` with margins; order by drag | output opens in poppler with N pages, images centered, orientation auto. Note: `addImage` stores pixels losslessly (big files) → for JPEG inputs implement `FPDFImageObj_LoadJpegFileInline` with an `FPDF_FILEACCESS` struct (`M.addFunction` for `m_GetBlock`) to keep files small |
| 9 | **Extract** | Text: `FPDFText_LoadPage` + `FPDFText_CountChars` + `FPDFText_GetText` per page → .txt. Images: image objects → `FPDFImageObj_GetRenderedBitmap`/`GetBitmap` → PNG (or `FPDFImageObj_GetImageDataRaw` for original JPEG) → ZIP. Tables: char boxes `FPDFText_GetCharBox` → cluster rows by y, columns by x gaps → CSV | text matches `pdftotext`; images count matches `pdfimages -list` |

### 🔄 Phase 4 — Optimize (Compress DONE on `pdf-tools`; Enhance-to-HD pending the shared AI fix)
| # | Tool | How | Done when |
|---|---|---|---|
| 7 | **Compress PDF** | For each image object: get bitmap → downscale to target dpi (Low 72 / Medium 150 / High 220) → JPEG re-encode (canvas) → put back with `FPDFImageObj_LoadJpegFileInline` (needs FILEACCESS callback). Keep text/vectors. Show size before/after; if bigger, keep original | output smaller on image-heavy PDFs, text still selectable (`pdftotext`) |
| 8 | **Enhance to HD** | Same loop, but upscale embedded images with the Real-ESRGAN code from `assets/js/app.js` (`aiResize`) — extract it into a shared module (e.g. `assets/js/sr.js`) without breaking the image site | images sharper, text untouched, image site still passes its audit |

### ✅ Phase 5 — Security (DONE · Protect + Unlock on `pdf-tools`)
| # | Tool | How | Done when |
|---|---|---|---|
| 11 | **Protect PDF (add password)** | `this.P.EPDF_SetEncryption(doc, userPassword, ownerPassword, permissions)` then `save()`. Permission bits (PDF spec): print 4, modify 8, copy 16, annotate 32, fill forms 256, accessibility 512, assemble 1024, high-quality print 2048 (`permissions = 0xFFFFF0C0 \| chosen bits` style — verify with `qpdf --show-encryption` or `pdfinfo`). UI: password + confirm, show/hide, strength meter, checkboxes for allow print/copy/edit, optional separate owner password | `pdfinfo out.pdf` shows `Encrypted: yes`; opening asks for the password; wrong password fails; permissions respected |
| 12 | **Unlock PDF (remove password)** | open with password (`PdfDoc.open(bytes, pw)`), `this.P.EPDF_RemoveEncryption(doc)`, `save()`. For owner-only locks use `EPDF_UnlockOwnerPermissions(doc, ownerPw)` | `pdfinfo` shows `Encrypted: no`; content identical. **Never** brute-force or crack passwords — the user must know it |

### ✅ Image-PDF editing tools (NEW, 2026-11-14) — on `pdf-tools`
Eraser (drag to cover anything; auto-samples the surrounding colour so it blends on scans/photos) ·
Match & type (click text on an image → copies its colour + size → type real, selectable text over it) ·
Eyedropper in the text panel (pick any colour from the page) · friendlier font names (Arial/Times/Courier).
Engine: addRect (filled rectangle via FPDFPageObj_CreateNewRect). These make photo/scanned PDFs editable
(cover the old, type the new) — the normal text editor can't change pixels baked into an image.

### ⏳ Phase 6 — Later
**Note — password "breaker":** requested but intentionally NOT built. A tool that opens a PDF without its
password is password cracking (defeating access control); it is out of scope. Unlock only removes protection
once the PDF is open with the password the user knows (or lifts owner-only restrictions on a PDF that already opens).

OCR for scanned PDFs (Tesseract.js, Apache-2.0) · broader fallback fonts (Noto, OFL: symbols, Hindi/Gujarati) · fill PDF forms.

### 🚀 Release checklist
All phases tested on preview → owner approves → merge `pdf-tools` → `main` → push → verify live `/pdf` and image tools →
update README + sitemap (`/pdf`).

---

## 9. Testing (required before each push)

**Manual (browser at http://localhost:8093/pdf):** open a real PDF (Word export, Chrome "Print to PDF", a scanned PDF,
a password-protected PDF, a 50+ page PDF), use every button of the tool, download, open the result in another viewer.

**Automated (recommended):** Playwright (`playwright-core` + installed Chromium) driving the page like a user; read
`window.__pdfEditor` / `window.__pdfPages` for state. Previous runs used: open → edit 2 lines → drag → add text →
signature → undo/redo → download (13 checks), plus the image-site audit (111 checks).

**Per feature acceptance:**
- Organize: page order, rotation (`pdfinfo -f 1 -l N` page rot), crop (page size changes), delete, blank page, extract, undo.
- Merge: page count = sum of ranges; order correct (`pdftotext` first lines); ranges like `3-1` reverse.
- Split: each mode → correct file count / pages; ZIP opens; names `name-pages-1-3.pdf`.
- Always: no console errors; mobile width 390 px has no horizontal scroll; image site still passes.

---

## 10. Lessons learned / pitfalls

- **Subset fonts:** PDFs embed only the letters they use. Typing a new letter in the original font makes it vanish.
  `fontCovers()` checks letters seen on the page; otherwise the line is rebuilt with a Liberation font.
  `FPDFFont_GetBaseFontName` does **not** always keep the `ABCDEF+` subset prefix → rely on `FPDFFont_GetIsEmbedded`.
- **Group text by baseline**, not by box top (letters with descenders split words otherwise).
- `FPDF_LoadMemDocument` does **not** copy the bytes — keep the buffer alive until `close()` (engine does this).
- Call `commit(i)` (GenerateContent) after object edits, before `save()`.
- Hugging Face model downloads (Remove BG) fail if the page sends a `*.workers.dev` Referer → site uses
  `Referrer-Policy: no-referrer`.
- Cloudflare merges overlapping `_headers` rules → one Cache-Control per path.
- Module URLs with different `?v=` are different modules (two wasm instances) → keep them identical.
- AI on CPU is slow; long operations must show live progress (elapsed + countdown) and never freeze the UI.
