/* Encoding utilities — pure functions (no DOM), usable in the page, in workers and in node tests.
 * Base64 (standard + URL-safe, RFC 4648), URL/percent encoding, hex, binary, HTML entities, UTF-8. */

export class EncodeError extends Error {
  constructor(message, pos) {
    super(pos != null ? `${message} (position ${pos + 1})` : message);
    this.name = 'EncodeError'; this.reason = message; this.pos = pos;
  }
}

/* ---------- UTF-8 ---------- */
export const utf8Encode = (s) => new TextEncoder().encode(String(s));
export function utf8Decode(bytes, { fatal = false } = {}) { return new TextDecoder('utf-8', { fatal }).decode(bytes); }
export function latin1Decode(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return s; }

/** Heuristic: are these bytes readable text (valid UTF-8 and few control characters)? */
export function isProbablyText(bytes) {
  if (!bytes.length) return true;
  let text;
  try { text = utf8Decode(bytes, { fatal: true }); } catch (e) { return false; }
  let ctrl = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) return false;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) ctrl++;
  }
  return ctrl / text.length < 0.02;
}

/* ---------- Base64 ---------- */
const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) { REV[STD.charCodeAt(i)] = i; REV[URLSAFE.charCodeAt(i)] = i; }

/** bytesToBase64(bytes, {urlSafe=false, pad=true, wrap=0}) */
export function bytesToBase64(bytes, opts = {}) {
  const A = opts.urlSafe ? URLSAFE : STD;
  const pad = opts.pad !== undefined ? opts.pad : !opts.urlSafe;
  const parts = [];
  let chunk = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += A[v >> 18] + A[(v >> 12) & 63] + A[(v >> 6) & 63] + A[v & 63];
    if (chunk.length > 65536) { parts.push(chunk); chunk = ''; }
  }
  if (i < n) {
    const b1 = bytes[i], b2 = i + 1 < n ? bytes[i + 1] : 0;
    const v = (b1 << 16) | (b2 << 8);
    chunk += A[v >> 18] + A[(v >> 12) & 63];
    if (i + 1 < n) chunk += A[(v >> 6) & 63] + (pad ? '=' : '');
    else chunk += pad ? '==' : '';
  }
  parts.push(chunk);
  let out = parts.join('');
  if (opts.wrap && opts.wrap > 0) out = out.replace(new RegExp(`(.{${opts.wrap}})(?=.)`, 'g'), '$1\n');
  return out;
}

/**
 * base64ToBytes(str, {strict=false}) → { bytes, notes: string[], urlSafe: boolean }
 * Accepts standard or URL-safe alphabet. Lenient by default: ignores whitespace and adds missing padding
 * (reported in notes). Throws EncodeError with the position of the first invalid character.
 */
export function base64ToBytes(str, opts = {}) {
  const notes = [];
  let s = String(str);
  // strip a data: URI prefix
  const dm = /^data:[^,]*;base64,/i.exec(s.trim());
  if (dm) { s = s.trim().slice(dm[0].length); notes.push('Removed the data: URI prefix.'); }
  let clean = '';
  let hadWs = false, sawStd = false, sawUrl = false, padStart = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f') {
      if (opts.strict) throw new EncodeError('Whitespace is not allowed in strict mode', i);
      hadWs = true; continue;
    }
    if (c === '=') { if (padStart < 0) padStart = clean.length; clean += c; continue; }
    if (padStart >= 0) throw new EncodeError(`Unexpected '${c}' after '=' padding`, i);
    if (code > 127 || REV[code] < 0) throw new EncodeError(`Invalid Base64 character '${c}'`, i);
    if (c === '+' || c === '/') sawStd = true;
    if (c === '-' || c === '_') sawUrl = true;
    clean += c;
  }
  if (sawStd && sawUrl) throw new EncodeError('Mixes the standard (+ /) and URL-safe (- _) alphabets');
  if (hadWs) notes.push('Ignored whitespace / line breaks.');
  let data = padStart >= 0 ? clean.slice(0, padStart) : clean;
  const padLen = padStart >= 0 ? clean.length - padStart : 0;
  if (padLen > 2) throw new EncodeError('Too much padding — at most two "=" are allowed');
  if (data.length % 4 === 1) throw new EncodeError('Invalid length — Base64 cannot end with a single leftover character');
  const needPad = (4 - (data.length % 4)) % 4;
  if (padStart >= 0 && padLen !== needPad) {
    if (opts.strict) throw new EncodeError(`Wrong padding: expected ${needPad} "=" but found ${padLen}`);
    notes.push('Corrected wrong padding.');
  } else if (padStart < 0 && needPad) {
    if (opts.strict) throw new EncodeError(`Missing padding: ${needPad} "=" expected at the end`);
    notes.push(`Added missing padding (${'='.repeat(needPad)}).`);
  }
  const n = data.length;
  const outLen = Math.floor((n * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0, i = 0;
  for (; i + 3 < n; i += 4) {
    const v = (REV[data.charCodeAt(i)] << 18) | (REV[data.charCodeAt(i + 1)] << 12) | (REV[data.charCodeAt(i + 2)] << 6) | REV[data.charCodeAt(i + 3)];
    out[o++] = v >> 16; out[o++] = (v >> 8) & 255; out[o++] = v & 255;
  }
  const rem = n - i;
  if (rem === 2) {
    const v = (REV[data.charCodeAt(i)] << 18) | (REV[data.charCodeAt(i + 1)] << 12);
    out[o++] = v >> 16;
  } else if (rem === 3) {
    const v = (REV[data.charCodeAt(i)] << 18) | (REV[data.charCodeAt(i + 1)] << 12) | (REV[data.charCodeAt(i + 2)] << 6);
    out[o++] = v >> 16; out[o++] = (v >> 8) & 255;
  }
  return { bytes: out.subarray(0, o), notes, urlSafe: sawUrl };
}
export const base64EncodeText = (text, opts) => bytesToBase64(utf8Encode(text), opts);
export function base64DecodeText(b64, opts) { const r = base64ToBytes(b64, opts); return utf8Decode(r.bytes); }

/* ---------- File type sniffing (magic bytes) ---------- */
const MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png', 'png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg', 'jpg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif', 'gif'],
  [[0x25, 0x50, 0x44, 0x46], 'application/pdf', 'pdf'],
  [[0x50, 0x4b, 0x03, 0x04], 'application/zip', 'zip'],
  [[0x1f, 0x8b], 'application/gzip', 'gz'],
  [[0x42, 0x4d], 'image/bmp', 'bmp'],
  [[0x00, 0x00, 0x01, 0x00], 'image/x-icon', 'ico'],
  [[0x49, 0x44, 0x33], 'audio/mpeg', 'mp3'],
  [[0x4f, 0x67, 0x67, 0x53], 'audio/ogg', 'ogg'],
  [[0x1a, 0x45, 0xdf, 0xa3], 'video/webm', 'webm'],
  [[0x7f, 0x45, 0x4c, 0x46], 'application/x-elf', 'elf'],
  [[0x4d, 0x5a], 'application/x-msdownload', 'exe'],
  [[0x00, 0x61, 0x73, 0x6d], 'application/wasm', 'wasm'],
  [[0x37, 0x7a, 0xbc, 0xaf], 'application/x-7z-compressed', '7z'],
  [[0x52, 0x61, 0x72, 0x21], 'application/vnd.rar', 'rar'],
  [[0x77, 0x4f, 0x46, 0x32], 'font/woff2', 'woff2'],
  [[0x77, 0x4f, 0x46, 0x46], 'font/woff', 'woff'],
];
export function sniffType(bytes) {
  for (const [sig, mime, ext] of MAGIC) if (sig.every((b, i) => bytes[i] === b)) return { mime, ext };
  const ascii = latin1Decode(bytes.subarray(0, 16));
  if (ascii.startsWith('RIFF') && latin1Decode(bytes.subarray(8, 12)) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (ascii.startsWith('RIFF') && latin1Decode(bytes.subarray(8, 12)) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (latin1Decode(bytes.subarray(4, 8)) === 'ftyp') {
    const brand = latin1Decode(bytes.subarray(8, 12));
    if (/avif|avis/.test(brand)) return { mime: 'image/avif', ext: 'avif' };
    if (/heic|heix|mif1/.test(brand)) return { mime: 'image/heic', ext: 'heic' };
    return { mime: 'video/mp4', ext: 'mp4' };
  }
  if (isProbablyText(bytes.subarray(0, 4096))) {
    const t = utf8Decode(bytes.subarray(0, 512)).trimStart();
    if (t.startsWith('<svg') || (t.startsWith('<?xml') && t.includes('<svg'))) return { mime: 'image/svg+xml', ext: 'svg' };
    if (t.startsWith('{') || t.startsWith('[')) return { mime: 'application/json', ext: 'json' };
    if (/^<!doctype html|^<html/i.test(t)) return { mime: 'text/html', ext: 'html' };
    if (t.startsWith('<?xml') || t.startsWith('<')) return { mime: 'application/xml', ext: 'xml' };
    return { mime: 'text/plain', ext: 'txt' };
  }
  return { mime: 'application/octet-stream', ext: 'bin' };
}

/* ---------- URL / percent encoding ---------- */
/** mode: 'component' (encodeURIComponent), 'uri' (encodeURI — keeps :/?#&=), 'form' (application/x-www-form-urlencoded) */
export function urlEncode(str, mode = 'component') {
  const s = String(str);
  // lone surrogates would make encodeURIComponent throw — report a clear error instead
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.exec(s);
  if (lone) throw new EncodeError('Text contains an unpaired surrogate character that cannot be encoded as UTF-8', lone.index);
  if (mode === 'uri') return encodeURI(s);
  const enc = encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return mode === 'form' ? enc.replace(/%20/g, '+') : enc;
}

/** Decode percent-encoding; throws EncodeError pointing at the malformed sequence. mode 'form' turns + into space. */
export function urlDecode(str, mode = 'component') {
  let s = String(str);
  if (mode === 'form') s = s.replace(/\+/g, ' ');
  // validate % sequences and UTF-8 explicitly so we can give a position
  const bytes = [];
  let out = '';
  const flush = (at) => {
    if (!bytes.length) return;
    try { out += utf8Decode(new Uint8Array(bytes), { fatal: true }); } catch (e) { throw new EncodeError('Percent-encoded bytes are not valid UTF-8', at); }
    bytes.length = 0;
  };
  let seqStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '%') {
      const hx = s.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hx)) throw new EncodeError(`Malformed escape '${s.slice(i, i + 3)}' — '%' must be followed by two hex digits (write a literal % as %25)`, i);
      if (!bytes.length) seqStart = i;
      bytes.push(parseInt(hx, 16));
      i += 2;
    } else {
      flush(seqStart);
      out += c;
    }
  }
  flush(seqStart);
  return out;
}

/* ---------- Hex ---------- */
export function bytesToHex(bytes, { sep = '', upper = false, prefix = '' } = {}) {
  const parts = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) parts[i] = prefix + (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  const s = parts.join(sep);
  return upper ? s.toUpperCase() : s;
}
/** Accepts "48656c6c6f", "48 65 6c", "0x48,0x65", "48:65", "\x48\x65". Throws on odd length / non-hex. */
export function hexToBytes(str) {
  const s = String(str);
  let digits = '';
  const positions = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X')) && (i === 0 || /[\s,:;]/.test(s[i - 1]))) { i++; continue; }
    if (c === '\\' && (s[i + 1] === 'x' || s[i + 1] === 'X')) { i++; continue; }
    if (/[\s,:;\-]/.test(c)) continue;
    if (!/[0-9a-fA-F]/.test(c)) throw new EncodeError(`Invalid hex character '${c}'`, i);
    digits += c; positions.push(i);
  }
  if (digits.length % 2) throw new EncodeError('Odd number of hex digits — each byte needs two digits', positions[positions.length - 1]);
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.substr(i * 2, 2), 16);
  return out;
}

/* ---------- Binary ---------- */
export function bytesToBinary(bytes, sep = ' ') {
  const parts = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) parts[i] = bytes[i].toString(2).padStart(8, '0');
  return parts.join(sep);
}
export function binaryToBytes(str) {
  const s = String(str);
  let bits = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '0' || c === '1') bits += c;
    else if (!/[\s,]/.test(c)) throw new EncodeError(`Invalid binary character '${c}' — only 0 and 1 are allowed`, i);
  }
  if (bits.length % 8) throw new EncodeError(`Bit count (${bits.length}) is not a multiple of 8`);
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.substr(i * 8, 8), 2);
  return out;
}

/* ---------- HTML entities ---------- */
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·',
  deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', micro: 'µ', iexcl: '¡', iquest: '¿', shy: '­',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', hArr: '⇔', le: '≤', ge: '≥', ne: '≠',
  asymp: '≈', infin: '∞', sum: '∑', prod: '∏', radic: '√', minus: '−', permil: '‰', prime: '′', Prime: '″', dagger: '†',
  Dagger: '‡', loz: '◊', spades: '♠', clubs: '♣', hearts: '♥', diams: '♦', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω', Alpha: 'Α', Beta: 'Β',
  Gamma: 'Γ', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Pi: 'Π', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä',
  aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í',
  icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß', Agrave: 'À', Aacute: 'Á',
  Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê',
  Euml: 'Ë', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Ouml: 'Ö', Oslash: 'Ø', Uacute: 'Ú', Uuml: 'Ü',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', tab: '\t', newline: '\n',
};
const REVERSE_NAMED = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** htmlEncode(str, {mode:'minimal'|'nonascii'|'all'}) — minimal: & < > " '; nonascii: also everything > 127 as &#…; */
export function htmlEncode(str, opts = {}) {
  const mode = opts.mode || 'minimal';
  let out = '';
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (REVERSE_NAMED[ch]) out += REVERSE_NAMED[ch];
    else if (mode === 'all' && !/[A-Za-z0-9\s]/.test(ch)) out += '&#' + cp + ';';
    else if ((mode === 'nonascii' || mode === 'all') && cp > 127) out += '&#' + cp + ';';
    else out += ch;
  }
  return out;
}
export function htmlDecode(str) {
  return String(str).replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, ent) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      if (cp === 0) return '�';
      return String.fromCodePoint(cp);
    }
    if (Object.prototype.hasOwnProperty.call(NAMED, ent) && m.endsWith(';')) return NAMED[ent];
    // legacy entities without ';' (only the very common ones)
    if (!m.endsWith(';') && ['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg'].includes(ent)) return NAMED[ent];
    return m;
  });
}
