/* Minimal, dependency-free RFC 822 / MIME e-mail parser (pure — no DOM, no network).
 * Enough to turn a raw inbound e-mail into { from, subject, text, html, attachments[] } and to pull a
 * verification / OTP code out of it. Handles: folded headers, RFC 2047 encoded-words, quoted-printable &
 * base64 transfer encodings, charset decoding, and nested multipart/* bodies. It never executes anything in
 * the message and never fetches remote resources, so a hostile e-mail can only produce text. */

const te = new TextEncoder();
const toBytes = (raw) => (typeof raw === 'string' ? te.encode(raw) : raw instanceof Uint8Array ? raw : new Uint8Array(raw));

function indexOfDoubleNewline(bytes) {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return { at: i, len: 2 };
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return { at: i, len: 4 };
  }
  return null;
}

/** Decode bytes to a string using the given charset, falling back gracefully. */
function decodeCharset(bytes, charset) {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^latin1$/, 'iso-8859-1');
  try { return new TextDecoder(cs, { fatal: false }).decode(bytes); } catch (e) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e2) {
      let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s;
    }
  }
}

function base64ToBytes(s) {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  try {
    const bin = atob(clean.replace(/=+$/, '').padEnd(Math.ceil(clean.replace(/=+$/, '').length / 4) * 4, '='));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) { return new Uint8Array(0); }
}

function quotedPrintableToBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=') {
      const hex = s.substr(i + 1, 2);
      if (hex === '\r\n' || hex[0] === '\n') { i += hex[0] === '\n' ? 1 : 2; continue; } // soft line break
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 2; continue; }
      out.push(61); // literal '='
    } else if (c === '\r') { /* keep CRLF as-is via \n branch */ out.push(13); }
    else { out.push(c.charCodeAt(0) & 0xff); }
  }
  return new Uint8Array(out);
}

/** RFC 2047 encoded-word decoding for header values: =?charset?B|Q?text?= */
export function decodeEncodedWords(str) {
  if (!str || str.indexOf('=?') < 0) return str || '';
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+)(?==\?)/g, '=?$1?$2?$3?=') // drop whitespace between adjacent words
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
      try {
        let bytes;
        if (enc.toUpperCase() === 'B') bytes = base64ToBytes(text);
        else bytes = quotedPrintableToBytes(text.replace(/_/g, ' '));
        return decodeCharset(bytes, charset);
      } catch (e) { return _; }
    });
}

/** Parse a header block (already split off) into ordered pairs + a lowercase lookup of the first value. */
function parseHeaders(block) {
  const text = decodeCharset(block, 'utf-8');
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (const line of lines) {
    if (!line) continue;
    if ((line[0] === ' ' || line[0] === '\t') && pairs.length) { pairs[pairs.length - 1][1] += ' ' + line.trim(); continue; }
    const i = line.indexOf(':');
    if (i < 0) continue;
    pairs.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  const map = new Map();
  for (const [k, v] of pairs) if (!map.has(k.toLowerCase())) map.set(k.toLowerCase(), v);
  return { pairs, get: (n) => map.get(n.toLowerCase()) || '' };
}

/** Parse a Content-Type / Content-Disposition style value into { value, params{} }. */
function parseParams(headerValue) {
  const parts = splitSemicolons(headerValue || '');
  const value = (parts.shift() || '').trim().toLowerCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    let k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim().replace(/^"(.*)"$/s, '$1');
    // RFC 2231 continuations/charset (name*0, name*=utf-8''…) — keep it simple: strip the trailing *
    const star = k.endsWith('*');
    if (star) { k = k.slice(0, -1); const m = /^([^']*)'[^']*'(.*)$/.exec(v); if (m) v = decodeURIComponent(m[2]); }
    params[k] = params[k] ? params[k] + v : v;
  }
  return { value, params };
}
function splitSemicolons(s) {
  const out = []; let cur = '', q = false;
  for (const c of s) { if (c === '"') q = !q; if (c === ';' && !q) { out.push(cur); cur = ''; } else cur += c; }
  out.push(cur); return out;
}

function decodeBody(bytes, cte) {
  const enc = (cte || '').trim().toLowerCase();
  if (enc === 'base64') return base64ToBytes(decodeCharset(bytes, 'ascii'));
  if (enc === 'quoted-printable') return quotedPrintableToBytes(decodeCharset(bytes, 'ascii'));
  return bytes; // 7bit / 8bit / binary
}

function splitMultipart(bytes, boundary) {
  const delim = te.encode('--' + boundary);
  const parts = [];
  let start = -1;
  for (let i = 0; i <= bytes.length - delim.length; i++) {
    let match = true;
    for (let j = 0; j < delim.length; j++) if (bytes[i + j] !== delim[j]) { match = false; break; }
    if (!match) continue;
    // boundary must be at line start
    if (i !== 0 && bytes[i - 1] !== 10) continue;
    const after = bytes[i + delim.length];
    const isClose = after === 45 && bytes[i + delim.length + 1] === 45; // "--boundary--"
    if (start >= 0) {
      let end = i; // trim the CRLF before the delimiter
      if (bytes[end - 1] === 10) end--; if (bytes[end - 1] === 13) end--;
      parts.push(bytes.subarray(start, end));
    }
    // advance to the start of the next part (after the boundary line)
    let p = i + delim.length;
    while (p < bytes.length && bytes[p] !== 10) p++;
    start = p + 1;
    if (isClose) break;
  }
  return parts;
}

/** Parse one MIME entity (headers already separated) and fold its text/html/attachments into `acc`. */
function parseEntity(bytes, acc, depth) {
  if (depth > 20) return;
  const split = indexOfDoubleNewline(bytes);
  const headerBytes = split ? bytes.subarray(0, split.at) : bytes;
  const bodyBytes = split ? bytes.subarray(split.at + split.len) : new Uint8Array(0);
  const h = parseHeaders(headerBytes);
  const ct = parseParams(h.get('content-type') || 'text/plain');
  const disp = parseParams(h.get('content-disposition'));
  const cte = h.get('content-transfer-encoding');

  if (ct.value.startsWith('multipart/') && ct.params.boundary) {
    for (const part of splitMultipart(bodyBytes, ct.params.boundary)) parseEntity(part, acc, depth + 1);
    return;
  }
  const filename = disp.params.filename || ct.params.name;
  const isAttachment = disp.value === 'attachment' || (filename && ct.value !== 'text/plain' && ct.value !== 'text/html');
  const decoded = decodeBody(bodyBytes, cte);
  if (isAttachment) {
    acc.attachments.push({ filename: decodeEncodedWords(filename || 'attachment'), contentType: ct.value || 'application/octet-stream', size: decoded.length });
    return;
  }
  const str = decodeCharset(decoded, ct.params.charset);
  if (ct.value === 'text/html') acc.html = acc.html ? acc.html + '\n' + str : str;
  else acc.text = acc.text ? acc.text + '\n' + str : str; // text/plain and unknown inline text
}

function addr(value) {
  const v = decodeEncodedWords(value || '');
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(v) || /^\s*([^<>\s]+@[^<>\s]+)\s*$/.exec(v);
  if (!m) return { name: '', address: v.trim() };
  if (m.length === 3) return { name: (m[1] || '').trim(), address: (m[2] || '').trim() };
  return { name: '', address: (m[1] || '').trim() };
}

/** Parse a full raw e-mail. Returns a plain object safe to store / serialise. */
export function parseEmail(raw) {
  const bytes = toBytes(raw);
  const split = indexOfDoubleNewline(bytes);
  const h = parseHeaders(split ? bytes.subarray(0, split.at) : bytes);
  const acc = { text: '', html: '', attachments: [] };
  parseEntity(bytes, acc, 0);
  const from = addr(h.get('from'));
  const dateStr = h.get('date');
  const date = dateStr ? Date.parse(dateStr) : NaN;
  return {
    from: from.address,
    fromName: from.name,
    to: addr(h.get('to')).address,
    subject: decodeEncodedWords(h.get('subject')),
    date: Number.isFinite(date) ? date : null,
    messageId: h.get('message-id'),
    text: acc.text.trim(),
    html: acc.html.trim(),
    attachments: acc.attachments,
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ' };
/** Strip HTML to readable text (for a preview and for OTP scanning when only an HTML body exists). */
export function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch (e) { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ' '; } })
    .replace(/&([a-z0-9#]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] != null ? ENTITIES[n.toLowerCase()] : m))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

const KEYWORDS = /\b(otp|o\.t\.p|code|c[óo]digo|codice|passcode|pass\s?code|pin|one[\s-]?time|verification|verify|verific|confirm|security|auth|token|2fa|mfa|einmal|code de|kode)\b/i;
/**
 * Pull the most likely verification code out of an e-mail. Heuristics:
 *  - candidates are 4–8 char runs of digits (optionally split by one space/hyphen), or 6–8 alphanumerics;
 *  - a candidate near a keyword ("code", "OTP", "verification"…) wins;
 *  - bare 4-digit years and obvious phone/order numbers are de-prioritised.
 * Returns the code as a string (digits/letters only) or null.
 */
export function extractOtp(text, html) {
  const body = [text || '', html ? htmlToText(html) : ''].join('\n');
  if (!body.trim()) return null;
  const candidates = [];
  const isWord = (c) => c != null && /[A-Za-z0-9]/.test(c);
  const isDigit = (c) => c != null && c >= '0' && c <= '9';
  const re = /([0-9]{3,4})[ -]([0-9]{3,4})|([0-9]{4,8})|([A-Za-z][A-Za-z0-9]{5,7}|[0-9][A-Za-z0-9]{5,7})/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    let code, kind;
    if (m[1]) { code = m[1] + m[2]; kind = 'split'; }
    else if (m[3]) { code = m[3]; kind = 'digits'; }
    else { code = m[4].toUpperCase(); kind = 'alnum'; if (!/[0-9]/.test(code) || !/[A-Z]/.test(code)) continue; } // alnum must mix letters+digits
    const start = m.index, end = re.lastIndex;
    const before = body[start - 1], after = body[end];
    // not part of a longer alphanumeric token
    if (isWord(before) || isWord(after)) continue;
    // not a decimal like 3.14159 (a dot glued to a digit on either side)
    if (before === '.' && isDigit(body[start - 2])) continue;
    if (after === '.' && isDigit(body[end + 1])) continue;
    const ctx = body.slice(Math.max(0, start - 60), Math.min(body.length, end + 20));
    const near = KEYWORDS.test(ctx);
    let score = 0;
    if (near) score += 100;
    if (code.length === 6) score += 20; else if (code.length === 4 || code.length === 8) score += 8; else if (code.length === 5 || code.length === 7) score += 5;
    if (kind === 'split') score += 10;
    if (kind === 'digits' && code.length === 4 && +code >= 1900 && +code <= 2100 && !near) score -= 50; // looks like a year
    score -= start / 5000; // earlier in the message is slightly better
    candidates.push({ code, score, near });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  // require either proximity to a keyword or a strong 6-digit shape, to avoid returning random numbers
  const best = candidates[0];
  if (!best.near && !(best.code.length === 6 && /^[0-9]+$/.test(best.code))) return null;
  return best.code;
}
