/* Browser copy of the OTP / verification-code extractor (same logic as server/mime.js).
 * Used for the mail.tm provider, where the service does not detect codes for us.
 * Pure functions — no DOM, no network. Kept in sync with server/mime.js (tested in tests/unit/mime.test.mjs
 * and tests/unit/otp-client.test.mjs). */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ' };

/** Strip HTML to readable text (for a preview and for OTP scanning when only an HTML body exists). */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
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

/** Pull the most likely verification code out of an e-mail's text (+ optional HTML). Returns a string or null. */
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
    else { code = m[4].toUpperCase(); kind = 'alnum'; if (!/[0-9]/.test(code) || !/[A-Z]/.test(code)) continue; }
    const start = m.index, end = re.lastIndex;
    const before = body[start - 1], after = body[end];
    if (isWord(before) || isWord(after)) continue;
    if (before === '.' && isDigit(body[start - 2])) continue;
    if (after === '.' && isDigit(body[end + 1])) continue;
    const ctx = body.slice(Math.max(0, start - 60), Math.min(body.length, end + 20));
    const near = KEYWORDS.test(ctx);
    let score = 0;
    if (near) score += 100;
    if (code.length === 6) score += 20; else if (code.length === 4 || code.length === 8) score += 8; else if (code.length === 5 || code.length === 7) score += 5;
    if (kind === 'split') score += 10;
    if (kind === 'digits' && code.length === 4 && +code >= 1900 && +code <= 2100 && !near) score -= 50;
    score -= start / 5000;
    candidates.push({ code, score, near });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best.near && !(best.code.length === 6 && /^[0-9]+$/.test(best.code))) return null;
  return best.code;
}
