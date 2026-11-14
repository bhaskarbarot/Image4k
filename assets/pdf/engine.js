/* Image4k PDF engine — a small, safe wrapper around PDFium (WebAssembly).
 * PDFium: BSD/Apache-2.0 (Google/Foxit). Browser build: @embedpdf/pdfium (MIT).
 * Everything runs locally in the browser; nothing is uploaded.
 */
import { init } from '/assets/vendor/pdfium-2.15.1/pdfium.esm.js';

const WASM_URL = '/assets/vendor/pdfium-2.15.1/pdfium.wasm';
const FONT_URL = '/assets/vendor/liberation-2.1.5/';

const OBJ = { TEXT: 1, PATH: 2, IMAGE: 3, SHADING: 4, FORM: 5 };
const RENDER_FLAGS = 0x01 /* annotations */ | 0x10 /* RGBA byte order */;
const ERR = { 1: 'unknown error', 2: 'file not found', 3: 'not a valid PDF (or damaged)', 4: 'password', 5: 'unsupported security', 6: 'page not found' };

let modulePromise = null;
function loadModule() {
  modulePromise = modulePromise || (async () => {
    const res = await fetch(WASM_URL);
    if (!res.ok) throw new Error('Could not load the PDF engine (HTTP ' + res.status + ')');
    const P = await init({ wasmBinary: await res.arrayBuffer() });
    P.PDFiumExt_Init();
    return P;
  })();
  modulePromise.catch(() => { modulePromise = null; });
  return modulePromise;
}

/** Font helpers ------------------------------------------------------------ */
export function describeFont(baseName) {
  const clean = (baseName || '').replace(/^[A-Z]{6}\+/, '');
  const n = clean.toLowerCase();
  const bold = /bold|black|heavy|semibold|demibold|demi|extrabold|w[6-9]\b/.test(n);
  const italic = /italic|oblique|-it\b|kursiv/.test(n);
  let family = 'Sans';
  if (/mono|courier|consol|menlo|code|typewriter|fixed/.test(n)) family = 'Mono';
  else if (!/sans/.test(n) && /serif|times|georgia|garamond|roman|book|minion|cambria|palatino|baskerville|caslon|didot|bodoni|cent|libertin|tinos|noto ?serif|merriweather|lora/.test(n)) family = 'Serif';
  return { clean, family, bold, italic, subset: /^[A-Z]{6}\+/.test(baseName || '') };
}
export function fallbackFontFile(desc) {
  const style = desc.bold && desc.italic ? 'BoldItalic' : desc.bold ? 'Bold' : desc.italic ? 'Italic' : 'Regular';
  return `Liberation${desc.family}-${style}.ttf`;
}

export class PdfDoc {
  constructor(P) {
    this.P = P;
    this.M = P.pdfium;
    this.doc = 0;
    this.src = 0;
    this.pages = new Map();       // index -> page handle
    this.fonts = new Map();       // file name -> font handle (loaded into this doc)
    this.fontBufs = [];           // keep font data alive while the doc is open
    this.glyphs = new Map();      // font base name -> Set of characters seen in the document
    this.scratch = this.malloc(64);
  }

  /** A new, empty document. */
  static async create() {
    const P = await loadModule();
    const d = new PdfDoc(P);
    d.doc = P.FPDF_CreateNewDocument();
    if (!d.doc) throw new Error('Could not create a PDF');
    d.pageCount = 0;
    return d;
  }

  static async open(bytes, password = '') {
    const P = await loadModule();
    const d = new PdfDoc(P);
    d.load(bytes, password);
    return d;
  }

  // ---- memory helpers ----------------------------------------------------
  heap() { return new Uint8Array(this.M.wasmExports.memory.buffer); }
  malloc(n) { return this.M.wasmExports.malloc(Math.max(1, n)); }
  free(p) { if (p) this.M.wasmExports.free(p); }
  f32(p) { return this.M.getValue(p, 'float'); }
  i32(p) { return this.M.getValue(p, 'i32'); }
  f64(p) { return this.M.getValue(p, 'double'); }
  wide(str) {
    const n = (str.length + 1) * 2;
    const p = this.malloc(n);
    this.M.stringToUTF16(str, p, n);
    return p;
  }

  load(bytes, password) {
    this.close();
    this.src = this.malloc(bytes.length);
    this.heap().set(bytes, this.src);
    this.doc = this.P.FPDF_LoadMemDocument(this.src, bytes.length, password || '');
    if (!this.doc) {
      const code = this.P.FPDF_GetLastError();
      this.free(this.src); this.src = 0;
      const e = new Error(code === 4 ? 'This PDF is password-protected.' : 'Could not open this PDF: ' + (ERR[code] || 'error ' + code));
      e.code = code;
      throw e;
    }
    this.pageCount = this.P.FPDF_GetPageCount(this.doc);
  }

  close() {
    for (const h of this.pages.values()) this.P.FPDF_ClosePage(h);
    this.pages.clear();
    this.fonts.clear();
    this.glyphs.clear();
    if (this.doc) this.P.FPDF_CloseDocument(this.doc);
    this.doc = 0;
    this.free(this.src); this.src = 0;
    for (const b of this.fontBufs) this.free(b);
    this.fontBufs = [];
  }

  destroy() { this.close(); this.free(this.scratch); this.scratch = 0; }

  page(i) {
    let h = this.pages.get(i);
    if (!h) {
      h = this.P.FPDF_LoadPage(this.doc, i);
      if (!h) throw new Error('Could not load page ' + (i + 1));
      this.pages.set(i, h);
    }
    return h;
  }

  /** Page size in points as displayed (rotation applied). */
  size(i) {
    const p = this.page(i);
    return { w: this.P.FPDF_GetPageWidthF(p), h: this.P.FPDF_GetPageHeightF(p) };
  }

  // ---- coordinates: page space (points, y up) <-> view space (points, y down, rotation applied)
  toView(i, x, y) {
    const { w, h } = this.size(i);
    const s = this.scratch;
    // use a large device size for precision, then scale back to points
    const K = 16;
    this.P.FPDF_PageToDevice(this.page(i), 0, 0, Math.round(w * K), Math.round(h * K), 0, x, y, s, s + 4);
    return { x: this.i32(s) / K, y: this.i32(s + 4) / K };
  }
  toPage(i, vx, vy) {
    const { w, h } = this.size(i);
    const s = this.scratch;
    const K = 16;
    this.P.FPDF_DeviceToPage(this.page(i), 0, 0, Math.round(w * K), Math.round(h * K), 0, Math.round(vx * K), Math.round(vy * K), s, s + 8);
    return { x: this.f64(s), y: this.f64(s + 8) };
  }

  /** Render a page to ImageData at `scale` (1 = 72 dpi). */
  render(i, scale) {
    const { w, h } = this.size(i);
    const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
    const bmp = this.P.FPDFBitmap_Create(W, H, 1);
    if (!bmp) throw new Error('memory: page too large to render');
    try {
      this.P.FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xFFFFFFFF);
      this.P.FPDF_RenderPageBitmap(bmp, this.page(i), 0, 0, W, H, 0, RENDER_FLAGS);
      const buf = this.P.FPDFBitmap_GetBuffer(bmp);
      const stride = this.P.FPDFBitmap_GetStride(bmp);
      const out = new Uint8ClampedArray(W * H * 4);
      const heap = this.heap();
      if (stride === W * 4) out.set(heap.subarray(buf, buf + W * H * 4));
      else for (let y = 0; y < H; y++) out.set(heap.subarray(buf + y * stride, buf + y * stride + W * 4), y * W * 4);
      return new ImageData(out, W, H);
    } finally {
      this.P.FPDFBitmap_Destroy(bmp);
    }
  }

  // ---- object inspection --------------------------------------------------
  objBoundsView(i, obj) {
    const s = this.scratch;
    if (!this.P.FPDFPageObj_GetBounds(obj, s, s + 4, s + 8, s + 12)) return null;
    const l = this.f32(s), b = this.f32(s + 4), r = this.f32(s + 8), t = this.f32(s + 12);
    const a = this.toView(i, l, b), c = this.toView(i, r, t);
    return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) };
  }
  matrix(obj) {
    const s = this.scratch;
    this.P.FPDFPageObj_GetMatrix(obj, s);
    return [0, 4, 8, 12, 16, 20].map((o) => this.f32(s + o));
  }
  setMatrix(obj, m) {
    const s = this.scratch;
    m.forEach((v, k) => this.M.setValue(s + k * 4, v, 'float'));
    return this.P.FPDFPageObj_SetMatrix(obj, s);
  }
  fillColor(obj) {
    const s = this.scratch;
    this.P.FPDFPageObj_GetFillColor(obj, s, s + 4, s + 8, s + 12);
    return [this.i32(s), this.i32(s + 4), this.i32(s + 8), this.i32(s + 12)];
  }
  fontBaseName(obj) {
    const font = this.P.FPDFTextObj_GetFont(obj);
    if (!font) return '';
    const len = this.P.FPDFFont_GetBaseFontName(font, 0, 0);
    if (!len) return '';
    const p = this.malloc(len);
    this.P.FPDFFont_GetBaseFontName(font, p, len);
    const s = this.M.UTF8ToString(p);
    this.free(p);
    return s;
  }
  objText(obj, tp) {
    const len = this.P.FPDFTextObj_GetText(obj, tp, 0, 0);
    if (len <= 2) return '';
    const p = this.malloc(len);
    this.P.FPDFTextObj_GetText(obj, tp, p, len);
    const s = this.M.UTF16ToString(p);
    this.free(p);
    return s;
  }

  /** List editable objects on a page (text runs grouped into lines, plus images). */
  objects(i) {
    const page = this.page(i);
    const tp = this.P.FPDFText_LoadPage(page);
    const n = this.P.FPDFPage_CountObjects(page);
    const runs = [], images = [];
    try {
      for (let k = 0; k < n; k++) {
        const obj = this.P.FPDFPage_GetObject(page, k);
        const type = this.P.FPDFPageObj_GetType(obj);
        if (type === OBJ.IMAGE) {
          const box = this.objBoundsView(i, obj);
          if (box && box.w > 2 && box.h > 2) images.push({ kind: 'image', objs: [obj], index: k, box });
          continue;
        }
        if (type !== OBJ.TEXT) continue;
        const mode = this.P.FPDFTextObj_GetTextRenderMode(obj);
        if (mode === 3 || mode === 7) continue;                 // invisible (e.g. OCR layer)
        const text = this.objText(obj, tp);
        if (!text || !text.trim()) continue;
        const s = this.scratch;
        this.P.FPDFTextObj_GetFontSize(obj, s);
        const rawSize = this.f32(s);
        const m = this.matrix(obj);
        const scaleY = Math.hypot(m[2], m[3]) || 1;
        const base = this.fontBaseName(obj);
        const box = this.objBoundsView(i, obj);
        if (!box) continue;
        const fontH = this.P.FPDFTextObj_GetFont(obj);
        const embedded = fontH ? this.P.FPDFFont_GetIsEmbedded(fontH) === 1 : false;
        const baseY = this.toView(i, m[4], m[5]).y;
        const set = this.glyphs.get(base) || new Set();
        for (const ch of text) set.add(ch);
        this.glyphs.set(base, set);
        runs.push({
          obj, index: k, text, base, rawSize, size: rawSize * scaleY, m,
          rotated: Math.abs(m[1]) > 1e-3 || Math.abs(m[2]) > 1e-3,
          color: this.fillColor(obj), box, baseY, embedded,
          broken: /�/.test(text)
        });
      }
    } finally {
      this.P.FPDFText_ClosePage(tp);
    }
    // group runs that sit on the same baseline with the same font into one editable line
    const lines = [];
    // cluster runs by baseline (tolerant to tiny offsets), then order each cluster left -> right
    const byBase = runs.slice().sort((a, b) => a.baseY - b.baseY);
    let cluster = 0;
    byBase.forEach((r, k) => { if (k && r.baseY - byBase[k - 1].baseY > 0.8) cluster++; r.cluster = cluster; });
    const sorted = byBase.sort((a, b) => a.cluster - b.cluster || a.box.x - b.box.x);
    for (const r of sorted) {
      const last = lines[lines.length - 1];
      const prev = last && last.runs[last.runs.length - 1];
      const sameLine = prev && !r.rotated && !prev.rotated && prev.base === r.base && prev.cluster === r.cluster &&
        Math.abs(prev.size - r.size) < 0.05 * r.size &&
        r.box.x - (prev.box.x + prev.box.w) < 0.6 * r.size && r.box.x >= prev.box.x - 0.5;
      if (sameLine) {
        const gap = r.box.x - (prev.box.x + prev.box.w);
        const needSpace = gap > 0.2 * r.size && !/\s$/.test(last.text) && !/^\s/.test(r.text);
        last.text += (needSpace ? ' ' : '') + r.text;
        last.runs.push(r);
        last.box = union(last.box, r.box);
      } else {
        lines.push({ kind: 'text', runs: [r], text: r.text, box: { ...r.box } });
      }
    }
    for (const l of lines) {
      const r0 = l.runs[0];
      Object.assign(l, { objs: l.runs.map((r) => r.obj), base: r0.base, size: r0.size, color: r0.color, font: describeFont(r0.base), embedded: r0.embedded, broken: l.runs.some((r) => r.broken), index: r0.index });
    }
    return lines.concat(images);
  }

  // ---- editing -------------------------------------------------------------
  /** Show/hide objects without removing them (used while the inline editor is open). */
  setHidden(objs, hidden, colors) {
    objs.forEach((o, k) => {
      const c = colors[k];
      this.P.FPDFPageObj_SetFillColor(o, c[0], c[1], c[2], hidden ? 0 : c[3]);
      const s = this.scratch;
      if (this.P.FPDFPageObj_GetStrokeColor(o, s, s + 4, s + 8, s + 12)) {
        this.P.FPDFPageObj_SetStrokeColor(o, this.i32(s), this.i32(s + 4), this.i32(s + 8), hidden ? 0 : c[3]);
      }
    });
  }

  async loadFont(file) {
    if (this.fonts.has(file)) return this.fonts.get(file);
    const res = await fetch(FONT_URL + file);
    if (!res.ok) throw new Error('Could not load font ' + file);
    const data = new Uint8Array(await res.arrayBuffer());
    const p = this.malloc(data.length);
    this.heap().set(data, p);
    this.fontBufs.push(p);
    const font = this.P.FPDFText_LoadFont(this.doc, p, data.length, 2 /* TrueType */, true /* CID = full Unicode */);
    if (!font) throw new Error('Could not use font ' + file);
    this.fonts.set(file, font);
    return font;
  }

  /** Does the line's own (possibly subset) font contain every character of `text`? */
  fontCovers(line, text) {
    // Embedded fonts are almost always subsets: only letters already used in the PDF are safe.
    if (line.embedded || line.font.subset) {
      const seen = this.glyphs.get(line.base);
      if (!seen) return false;
      for (const ch of text) if (ch !== ' ' && !seen.has(ch)) return false;
      return true;
    }
    // Non-embedded (standard) fonts: safe for the Latin-1 range plus common punctuation.
    for (const ch of text) if (ch.charCodeAt(0) > 0xFF && !'–—‘’‚“”„•…€™'.includes(ch)) return false;
    return true;
  }

  /**
   * Replace a text line with new text. Keeps the original font when it has every glyph,
   * otherwise rebuilds the line with a matching complete font (same size, colour, position).
   * Options: { family, bold, italic, size, color } force a style (always uses a bundled font).
   */
  async editText(i, line, text, opts = {}) {
    const page = this.page(i);
    const [first, ...rest] = line.objs;
    const restyle = opts.family || opts.bold !== undefined || opts.italic !== undefined || opts.size || opts.color;
    let usedFallback = false;
    if (!restyle && this.fontCovers(line, text)) {
      const w = this.wide(text);
      const ok = this.P.FPDFText_SetText(first, w);
      this.free(w);
      if (!ok) throw new Error('Could not change this text');
    } else {
      const d = line.font;
      const desc = { family: opts.family || d.family, bold: opts.bold ?? d.bold, italic: opts.italic ?? d.italic };
      const font = await this.loadFont(fallbackFontFile(desc));
      const r0 = line.runs[0];
      const scaleY = Math.hypot(r0.m[2], r0.m[3]) || 1;
      const rawSize = opts.size ? opts.size / scaleY : r0.rawSize;
      const nobj = this.P.FPDFPageObj_CreateTextObj(this.doc, font, rawSize);
      const w = this.wide(text);
      this.P.FPDFText_SetText(nobj, w);
      this.free(w);
      this.setMatrix(nobj, r0.m);
      const c = opts.color || line.color;
      this.P.FPDFPageObj_SetFillColor(nobj, c[0], c[1], c[2], c[3] ?? 255);
      const index = this.indexOf(page, first);
      this.P.FPDFPage_RemoveObject(page, first);
      this.P.FPDFPageObj_Destroy(first);
      if (index >= 0) this.P.FPDFPage_InsertObjectAtIndex(page, nobj, index); else this.P.FPDFPage_InsertObject(page, nobj);
      usedFallback = true;
      const set = this.glyphs.get(fallbackFontFile(desc)) || new Set();
      this.glyphs.set(fallbackFontFile(desc), set);
    }
    for (const o of rest) { this.P.FPDFPage_RemoveObject(page, o); this.P.FPDFPageObj_Destroy(o); }
    this.commit(i);
    return { usedFallback };
  }

  indexOf(page, obj) {
    const n = this.P.FPDFPage_CountObjects(page);
    for (let k = 0; k < n; k++) if (this.P.FPDFPage_GetObject(page, k) === obj) return k;
    return -1;
  }

  /** Move objects by (dx, dy) in view points. */
  move(i, objs, dx, dy) {
    const a = this.toPage(i, 0, 0), b = this.toPage(i, dx, dy);
    for (const o of objs) this.P.FPDFPageObj_Transform(o, 1, 0, 0, 1, b.x - a.x, b.y - a.y);
    this.commit(i);
  }

  /** Scale an image object so its view box becomes `box` (view points). */
  resizeTo(i, obj, box) {
    const bl = this.toPage(i, box.x, box.y + box.h), tr = this.toPage(i, box.x + box.w, box.y);
    const w = Math.abs(tr.x - bl.x), h = Math.abs(tr.y - bl.y);
    this.setMatrix(obj, [w, 0, 0, h, Math.min(bl.x, tr.x), Math.min(bl.y, tr.y)]);
    this.commit(i);
  }

  remove(i, objs) {
    const page = this.page(i);
    for (const o of objs) { this.P.FPDFPage_RemoveObject(page, o); this.P.FPDFPageObj_Destroy(o); }
    this.commit(i);
  }

  /** Draw a filled rectangle over view box {x,y,w,h} (used by the eraser / whiteout). */
  addRect(i, box, color) {
    const a = this.toPage(i, box.x, box.y + box.h), b = this.toPage(i, box.x + box.w, box.y);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    const obj = this.P.FPDFPageObj_CreateNewRect(x, y, w, h);
    if (!obj) throw new Error('Could not add the shape');
    this.P.FPDFPageObj_SetFillColor(obj, color[0], color[1], color[2], color[3] ?? 255);
    this.P.FPDFPath_SetDrawMode(obj, 2 /* winding fill */, false);
    this.P.FPDFPage_InsertObject(this.page(i), obj);
    this.commit(i);
    return obj;
  }

  /** Add a text line at view point (vx, vy = baseline). */
  async addText(i, vx, vy, text, { family = 'Sans', bold = false, italic = false, size = 14, color = [0, 0, 0, 255] } = {}) {
    const font = await this.loadFont(fallbackFontFile({ family, bold, italic }));
    const obj = this.P.FPDFPageObj_CreateTextObj(this.doc, font, size);
    const w = this.wide(text);
    this.P.FPDFText_SetText(obj, w);
    this.free(w);
    const p = this.toPage(i, vx, vy);
    this.setMatrix(obj, [1, 0, 0, 1, p.x, p.y]);
    this.P.FPDFPageObj_SetFillColor(obj, color[0], color[1], color[2], color[3] ?? 255);
    this.P.FPDFPage_InsertObject(this.page(i), obj);
    this.commit(i);
    return obj;
  }

  /** Create a PDFium bitmap from RGBA ImageData. Caller destroys it. */
  bitmapFrom(img) {
    const { width: W, height: H, data } = img;
    const stride = W * 4;
    const p = this.malloc(stride * H);
    const heap = this.heap();
    for (let i = 0, j = p; i < data.length; i += 4, j += 4) {   // RGBA -> BGRA
      heap[j] = data[i + 2]; heap[j + 1] = data[i + 1]; heap[j + 2] = data[i]; heap[j + 3] = data[i + 3];
    }
    const bmp = this.P.FPDFBitmap_CreateEx(W, H, 4 /* BGRA */, p, stride);
    return { bmp, buf: p };
  }

  /** Insert an image (ImageData) into view box {x,y,w,h}. */
  addImage(i, img, box) {
    const obj = this.P.FPDFPageObj_NewImageObj(this.doc);
    const { bmp, buf } = this.bitmapFrom(img);
    try {
      if (!this.P.FPDFImageObj_SetBitmap(0, 0, obj, bmp)) throw new Error('Could not add this image');
    } finally {
      this.P.FPDFBitmap_Destroy(bmp);
      this.free(buf);
    }
    this.P.FPDFPage_InsertObject(this.page(i), obj);
    this.resizeTo(i, obj, box);
    return obj;
  }

  replaceImage(i, obj, img) {
    const { bmp, buf } = this.bitmapFrom(img);
    try {
      if (!this.P.FPDFImageObj_SetBitmap(0, 0, obj, bmp)) throw new Error('Could not replace this image');
    } finally {
      this.P.FPDFBitmap_Destroy(bmp);
      this.free(buf);
    }
    this.commit(i);
  }

  // ---- page-level operations (organize / merge / split) ------------------
  /** Forget cached page handles (indices change after structural edits). */
  resetPages() {
    for (const h of this.pages.values()) this.P.FPDF_ClosePage(h);
    this.pages.clear();
    this.pageCount = this.P.FPDF_GetPageCount(this.doc);
  }

  /** Copy pages (0-based `indices`, in that order) from `src` into this document at `at`. */
  importPages(src, indices, at = this.pageCount) {
    if (!indices.length) return;
    const p = this.malloc(indices.length * 4);
    indices.forEach((v, k) => this.M.setValue(p + k * 4, v, 'i32'));
    const ok = this.P.FPDF_ImportPagesByIndex(this.doc, src.doc, p, indices.length, at);
    this.free(p);
    if (!ok) throw new Error('Could not copy pages');
    this.resetPages();
  }

  addBlankPage(at, w, h) {
    const page = this.P.FPDFPage_New(this.doc, at, w, h);
    if (!page) throw new Error('Could not add a page');
    this.P.FPDF_ClosePage(page);
    this.resetPages();
  }

  deletePage(i) { this.P.FPDFPage_Delete(this.doc, i); this.resetPages(); }

  rotation(i) { return this.P.FPDFPage_GetRotation(this.page(i)); }
  setRotation(i, quarterTurns) { this.P.FPDFPage_SetRotation(this.page(i), ((quarterTurns % 4) + 4) % 4); }

  /** Crop page `i` to a rectangle given in view points of the SOURCE geometry `fromDoc`/`fromIndex`. */
  cropToView(i, fromDoc, fromIndex, r) {
    const a = fromDoc.toPage(fromIndex, r.x, r.y), b = fromDoc.toPage(fromIndex, r.x + r.w, r.y + r.h);
    const l = Math.min(a.x, b.x), rr = Math.max(a.x, b.x), bt = Math.min(a.y, b.y), t = Math.max(a.y, b.y);
    this.P.FPDFPage_SetCropBox(this.page(i), l, bt, rr, t);
  }

  /** Write the page's object list back into its content stream. */
  commit(i) {
    if (!this.P.FPDFPage_GenerateContent(this.page(i))) throw new Error('Could not update page ' + (i + 1));
  }

  // ---- convert / extract / optimize (Phase 3 & 4) ------------------------
  /** All text of page `i` in reading order (empty string if the page has none). */
  pageText(i) {
    const tp = this.P.FPDFText_LoadPage(this.page(i));
    try {
      const n = this.P.FPDFText_CountChars(tp);
      if (n <= 0) return '';
      const p = this.malloc((n + 1) * 2);
      this.P.FPDFText_GetText(tp, 0, n, p);
      const s = this.M.UTF16ToString(p);
      this.free(p);
      return s;
    } finally { this.P.FPDFText_ClosePage(tp); }
  }

  /** Per-character boxes + unicode for page `i` (view space). Used to rebuild tables as CSV. */
  pageChars(i) {
    const tp = this.P.FPDFText_LoadPage(this.page(i));
    const out = [];
    try {
      const n = this.P.FPDFText_CountChars(tp);
      const s = this.scratch;
      for (let k = 0; k < n; k++) {
        const u = this.P.FPDFText_GetUnicode(tp, k);
        if (!u || u === 10 || u === 13) continue;
        if (!this.P.FPDFText_GetCharBox(tp, k, s, s + 8, s + 16, s + 24)) continue;
        const l = this.f64(s), r = this.f64(s + 8), b = this.f64(s + 16), t = this.f64(s + 24);
        const a = this.toView(i, l, t), c = this.toView(i, r, b);
        out.push({ ch: String.fromCharCode(u), x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) });
      }
    } finally { this.P.FPDFText_ClosePage(tp); }
    return out;
  }

  /** The image objects on page `i`, each with its rendered pixels and display box. */
  imageList(i) {
    const page = this.page(i);
    const n = this.P.FPDFPage_CountObjects(page);
    const out = [];
    for (let k = 0; k < n; k++) {
      const obj = this.P.FPDFPage_GetObject(page, k);
      if (this.P.FPDFPageObj_GetType(obj) !== OBJ.IMAGE) continue;
      out.push({ obj, index: k, box: this.objBoundsView(i, obj), pixels: this.imagePixels(obj) });
    }
    return out;
  }
  imagePixels(obj) {
    const s = this.scratch;
    if (!this.P.FPDFImageObj_GetImagePixelSize(obj, s, s + 4)) return null;
    return { w: this.i32(s), h: this.i32(s + 4) };
  }
  /** Rendered RGBA ImageData of one image object (with any soft mask applied). */
  objectImageData(i, obj) {
    const bmp = this.P.FPDFImageObj_GetRenderedBitmap(this.doc, this.page(i), obj);
    if (!bmp) return null;
    try {
      const W = this.P.FPDFBitmap_GetWidth(bmp), H = this.P.FPDFBitmap_GetHeight(bmp);
      const buf = this.P.FPDFBitmap_GetBuffer(bmp), stride = this.P.FPDFBitmap_GetStride(bmp);
      const fmt = this.P.FPDFBitmap_GetFormat(bmp);          // 1=Gray 2=BGR 3=BGRx 4=BGRA
      const bpp = fmt === 2 ? 3 : fmt === 1 ? 1 : 4;
      const out = new Uint8ClampedArray(W * H * 4), heap = this.heap();
      for (let y = 0; y < H; y++) {
        let si = buf + y * stride, di = y * W * 4;
        for (let x = 0; x < W; x++, si += bpp, di += 4) {
          if (fmt === 1) { out[di] = out[di + 1] = out[di + 2] = heap[si]; out[di + 3] = 255; }
          else { out[di] = heap[si + 2]; out[di + 1] = heap[si + 1]; out[di + 2] = heap[si]; out[di + 3] = bpp === 4 ? heap[si + 3] : 255; }
        }
      }
      return new ImageData(out, W, H);
    } finally { this.P.FPDFBitmap_Destroy(bmp); }
  }
  hasAlpha(obj) {
    const s = this.scratch;
    // FPDFImageObj_GetImageMetadata(obj, page, &meta) — bits_per_pixel 32 hints alpha; be safe and check render format
    const bmp = this.P.FPDFImageObj_GetBitmap(obj);
    if (!bmp) return false;
    try { return this.P.FPDFBitmap_GetFormat(bmp) === 4; } finally { this.P.FPDFBitmap_Destroy(bmp); }
  }

  /** Embed a JPEG (Uint8Array) as a NEW image on page `i` at view box {x,y,w,h}. Stays compressed. */
  addJpeg(i, jpegBytes, box) {
    const page = this.page(i);
    const obj = this.P.FPDFPageObj_NewImageObj(this.doc);
    const p = this.malloc(jpegBytes.length);
    this.heap().set(jpegBytes, p);
    const ok = this.P.EPDFImageObj_SetJpeg(page, 0, obj, p, jpegBytes.length);
    this.free(p);
    if (!ok) { this.P.FPDFPageObj_Destroy(obj); throw new Error('Could not embed the image'); }
    this.P.FPDFPage_InsertObject(page, obj);
    this.resizeTo(i, obj, box);
    return obj;
  }

  /** Replace an EXISTING image object's pixels with a JPEG (used by Compress). Keeps its matrix. */
  replaceJpeg(i, obj, jpegBytes) {
    const page = this.page(i);
    const pa = this.malloc(4); this.M.setValue(pa, page, 'i32');
    const p = this.malloc(jpegBytes.length);
    this.heap().set(jpegBytes, p);
    const ok = this.P.EPDFImageObj_SetJpeg(pa, 1, obj, p, jpegBytes.length);
    this.free(p); this.free(pa);
    if (!ok) throw new Error('Could not recompress an image');
  }

  // ---- security (Protect / Unlock) ---------------------------------------
  /** True if this PDF carries any encryption (open password or owner restrictions). */
  isEncrypted() { return !!this.P.EPDF_IsEncrypted(this.doc); }
  /** The permission bits currently in force (unsigned 32-bit). 0xFFFFFFFF = all allowed. */
  permissions() { return this.P.FPDF_GetDocPermissions(this.doc) >>> 0; }
  /** True when the document was opened with the OWNER password (full rights). */
  ownerUnlocked() { return !!this.P.EPDF_IsOwnerUnlocked(this.doc); }

  /**
   * Add (or replace) encryption. `userPw` is needed to OPEN the file; `ownerPw` grants full
   * rights and is required to change these settings later. `perms` is the PDF permission
   * integer (see PERM in secure.js). Throws on failure.
   */
  encrypt(userPw, ownerPw, perms) {
    const owner = ownerPw || userPw || '';
    if (!this.P.EPDF_SetEncryption(this.doc, userPw || '', owner, perms >>> 0))
      throw new Error('Could not protect this PDF');
  }
  /** Remove all encryption. The document must already be open (unlocked). */
  decrypt() {
    if (!this.P.EPDF_RemoveEncryption(this.doc)) throw new Error('Could not remove the protection');
  }
  /** Lift owner-only restrictions (printing/copying) using the owner password. */
  unlockOwner(ownerPw) { return !!this.P.EPDF_UnlockOwnerPermissions(this.doc, ownerPw || ''); }

  /** Save the whole document to bytes. */
  save() {
    const w = this.P.PDFiumExt_OpenFileWriter();
    try {
      if (!this.P.PDFiumExt_SaveAsCopy(this.doc, w)) throw new Error('Could not save the PDF');
      const size = this.P.PDFiumExt_GetFileWriterSize(w);
      const p = this.malloc(size);
      this.P.PDFiumExt_GetFileWriterData(w, p, size);
      const out = this.heap().slice(p, p + size);
      this.free(p);
      return out;
    } finally {
      this.P.PDFiumExt_CloseFileWriter(w);
    }
  }
}

function union(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export { OBJ };
