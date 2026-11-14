# Prompt for Google Antigravity (copy everything inside the box)

```
You are continuing an existing, working project: Image4k — a free, private, browser-only website with image tools
(LIVE) and new PDF tools (in progress). The project folder is the open workspace (image4k/).

FIRST, read these files completely before changing anything:
1. PDF_TOOLS_PLAN.md  — the full plan, rules, architecture, element IDs, task list and acceptance criteria
2. assets/pdf/engine.js, assets/pdf/editor.js, assets/pdf/pages.js, pdf.html, assets/pdf/pdf.css
3. _headers, .assetsignore, serve.py, README.md

HARD RULES (never break):
- Work ONLY on git branch `pdf-tools`. Never push to `main`, never merge, never change the live image tools
  (index.html image logic, assets/js/app.js) unless a task explicitly requires it — and then the image site must still work.
- Commit as the existing repo-local identity (bhaskarbarot <barotb076@gmail.com) — check `git config user.email`.
  Do NOT add any Co-Authored-By or other attribution lines. Push with: GIT_TERMINAL_PROMPT=0 git push origin pdf-tools
- Everything must run in the browser: no server, no uploads, no tracking, no new CDNs unless also added to the CSP in _headers.
  Self-host libraries in a versioned folder under assets/vendor/ (e.g. assets/vendor/name-1.2.3/).
- Licenses: only MIT / Apache-2.0 / BSD / SIL OFL. Do NOT copy code from AGPL/GPL projects (BentoPDF, Stirling-PDF, MuPDF, PyMuPDF).
- Use the existing PDFium engine (assets/pdf/engine.js, class PdfDoc) for all PDF work. Add new methods there when needed.
- Keep the matte wine-red (#7B1F2E) & white Adobe-style design of /pdf (reuse classes from pdf.css).
- Cache busting: after editing any assets/pdf/*.js or *.css, bump the ?v= value in pdf.html AND in every
  `import ... from './engine.js?v=...'` — all imports of the same file must use the SAME ?v= string.
- Never add a second Cache-Control rule for an already-covered path in _headers.
- Repo-only files (plans, notes, scripts) must be listed in .assetsignore so they are never published.
- Password tools must NEVER crack or brute-force passwords; Unlock only works with the password the user knows.

YOUR JOB — do the tasks in PDF_TOOLS_PLAN.md section 8, in this order, testing after each:
1. Task 0: fix the engine.js ?v= mismatch between editor.js (pdf2) and pages.js (pdf3).
2. Task 1: wire Phase 2 (Organize / Merge / Split) into editor.js exactly as described (showView, tool cards,
   back buttons, file inputs, drag & drop per view, askPassword with file name, initPageTools helpers).
3. Task 2: test Phase 2, then commit and push to pdf-tools.
4. Phase 5 (Security): Protect PDF (add password + permissions via EPDF_SetEncryption) and Unlock PDF
   (EPDF_RemoveEncryption). Add landing tool cards "Protect PDF" and "Unlock PDF" and a view for each.
5. Phase 3: PDF → JPG/PNG, Images → PDF, Extract (text / images / tables).
6. Phase 4: Compress PDF, Enhance to HD (share the Real-ESRGAN code with the image site without breaking it).
After each phase: update the tool cards on the landing page (remove "Soon"), update PDF_TOOLS_PLAN.md status,
commit with a clear message, push to pdf-tools, and give me the preview link https://pdf-tools.image4k.pages.dev/pdf

TESTING (required before every push):
- Run locally: `python3 serve.py 8093` → http://localhost:8093/pdf (never open files via file://).
- Test every button of the new tool in a real browser with real PDFs (Word export, Chrome print-to-PDF,
  a password-protected PDF, a 50+ page PDF). Check: no console errors, works at 390 px width without horizontal scroll.
- Verify downloaded PDFs with poppler: pdftotext -layout, pdffonts, pdfinfo (page count, "Encrypted"), pdfimages -list,
  pdftoppm -png (look at the pages).
- Make sure the image tools at http://localhost:8093/ still work (upload an image, Make HD, Resize, Compress, Remove BG, download).
- Report honestly what passed and what failed; do not claim something works without testing it.

When everything is done and tested on the preview, STOP and ask me before releasing to main.
```

---

## Tips for using this prompt
- Paste the box contents as the first message in Antigravity with the `image4k` folder open.
- If Antigravity's context gets long, start a new chat and say:
  *"Continue the Image4k PDF tools from PDF_TOOLS_PLAN.md — read it first, then do the next unchecked task."*
- Ask it to update `PDF_TOOLS_PLAN.md` (status section) after every finished task, so any agent can always pick up where the last one stopped.
