/* QR payload builders — pure functions (unit-tested). Each returns { data, error? }.
 * Formats follow what phone cameras (iOS / Android / Google Lens) understand:
 *   URL · plain text · mailto: · tel: · SMSTO: · WIFI: (ZXing format) · vCard 3.0 · https://wa.me/ */

const enc = encodeURIComponent;

export function url({ url = '' }) {
  let u = url.trim();
  if (!u) return { data: '', error: 'Enter a website address.' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try {
    const p = new URL(u);
    if (!/^(https?|ftp):$/.test(p.protocol)) return { data: u, warn: 'Only http(s) links open directly in phone browsers.' };
    if (!p.hostname.includes('.') && p.hostname !== 'localhost') return { data: u, warn: 'This address has no domain ending (like .com) — check it.' };
    return { data: u };
  } catch (e) { return { data: '', error: 'That is not a valid web address.' }; }
}

export function text({ text = '' }) {
  return text ? { data: text } : { data: '', error: 'Enter some text.' };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function email({ to = '', subject = '', body = '' }) {
  const addr = to.trim();
  if (!addr) return { data: '', error: 'Enter an email address.' };
  if (!EMAIL.test(addr)) return { data: '', error: 'That email address does not look valid.' };
  const q = [];
  if (subject) q.push('subject=' + enc(subject));
  if (body) q.push('body=' + enc(body));
  return { data: 'mailto:' + addr + (q.length ? '?' + q.join('&') : '') };
}

export function cleanPhone(n) {
  const s = String(n).trim();
  const plus = s.startsWith('+') || s.startsWith('00');
  const digits = s.replace(/\D/g, '').replace(/^00/, '');
  return (plus ? '+' : '') + digits;
}
export function phone({ phone: p = '' }) {
  const n = cleanPhone(p);
  if (n.replace('+', '').length < 3) return { data: '', error: 'Enter a phone number (with country code, e.g. +91 98765 43210).' };
  return { data: 'tel:' + n, warn: n.startsWith('+') ? undefined : 'Tip: add the country code (e.g. +91) so it works from any country.' };
}

export function sms({ phone: p = '', message = '' }) {
  const n = cleanPhone(p);
  if (n.replace('+', '').length < 3) return { data: '', error: 'Enter the phone number to text.' };
  return { data: 'SMSTO:' + n + ':' + message };
}

export function whatsapp({ phone: p = '', message = '' }) {
  const n = cleanPhone(p).replace('+', '');
  if (n.length < 8) return { data: '', error: 'Enter the WhatsApp number with country code (e.g. 919876543210).' };
  return { data: 'https://wa.me/' + n + (message ? '?text=' + enc(message) : '') };
}

/** Escape for the WIFI: format — backslash, semicolon, comma, colon and double quote. */
export const wifiEscape = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
export function wifi({ ssid = '', password = '', auth = 'WPA', hidden = false }) {
  if (!ssid) return { data: '', error: 'Enter the Wi-Fi network name (SSID).' };
  const T = auth === 'nopass' ? 'nopass' : auth === 'WEP' ? 'WEP' : 'WPA';
  if (T !== 'nopass' && !password) return { data: '', error: 'Enter the Wi-Fi password, or choose “No password”.' };
  let warn;
  if (T === 'WPA' && password.length < 8) warn = 'WPA passwords are normally at least 8 characters — check it.';
  if (T === 'WEP') warn = 'WEP is insecure; use WPA2/WPA3 on your router if you can.';
  // A password that looks like hex would be read as hex by some readers; quoting avoids that.
  const pw = /^[0-9A-Fa-f]+$/.test(password) && T !== 'nopass' ? '"' + wifiEscape(password) + '"' : wifiEscape(password);
  return {
    data: `WIFI:T:${T};S:${wifiEscape(ssid)};${T !== 'nopass' ? `P:${pw};` : ''}${hidden ? 'H:true;' : ''};`,
    warn,
  };
}

/** Escape a vCard 3.0 text value. */
export const vEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
export function vcard(f = {}) {
  const first = (f.first || '').trim(), last = (f.last || '').trim();
  if (!first && !last && !(f.org || '').trim()) return { data: '', error: 'Enter at least a name or an organisation.' };
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  lines.push(`N:${vEscape(last)};${vEscape(first)};;;`);
  lines.push(`FN:${vEscape([first, last].filter(Boolean).join(' ') || f.org)}`);
  if (f.org) lines.push(`ORG:${vEscape(f.org)}`);
  if (f.title) lines.push(`TITLE:${vEscape(f.title)}`);
  if (f.mobile) lines.push(`TEL;TYPE=CELL:${cleanPhone(f.mobile)}`);
  if (f.work) lines.push(`TEL;TYPE=WORK,VOICE:${cleanPhone(f.work)}`);
  if (f.email) {
    if (!EMAIL.test(f.email.trim())) return { data: '', error: 'The email address does not look valid.' };
    lines.push(`EMAIL;TYPE=INTERNET:${f.email.trim()}`);
  }
  if (f.website) lines.push(`URL:${url({ url: f.website }).data || vEscape(f.website)}`);
  if (f.street || f.city || f.zip || f.country) lines.push(`ADR;TYPE=WORK:;;${vEscape(f.street || '')};${vEscape(f.city || '')};${vEscape(f.region || '')};${vEscape(f.zip || '')};${vEscape(f.country || '')}`);
  if (f.note) lines.push(`NOTE:${vEscape(f.note)}`);
  lines.push('END:VCARD');
  return { data: lines.join('\r\n') };
}

export function custom({ text = '' }) {
  return text ? { data: text } : { data: '', error: 'Enter the exact content to encode.' };
}

export const BUILDERS = { url, text, email, phone, sms, whatsapp, wifi, vcard, custom };
export function build(type, fields) { return (BUILDERS[type] || text)(fields || {}); }
