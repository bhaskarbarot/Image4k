/* API response helpers: format detection, HTML pretty-printer, form-urlencoded decoding. Pure (no DOM). */
import { validateJson } from './json.js';
import { looksLikeXml, validateXml } from './xml.js';

/** detectFormat(text) → 'json' | 'xml' | 'html' | 'form' | 'text' */
export function detectFormat(text) {
  const t = text.trim();
  if (!t) return 'text';
  if (/^[[{"]/.test(t) || /^(-?\d|true$|false$|null$)/.test(t)) { if (validateJson(t).ok) return 'json'; if (/^[[{]/.test(t)) return 'json'; }
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return 'html';
  if (/^</.test(t)) {
    if (validateXml(t).ok) return 'xml';
    if (!/^<\?xml/.test(t) && /<(head|body|div|p|span|script|style|meta|link|br|hr|img|table|ul|ol|li|h[1-6]|section|article|nav|header|footer|form|input|button)\b/i.test(t)) return 'html';
  }
  if (looksLikeXml(t)) return 'xml';
  if (/^[^\s=&]+=[^\s&]*(?:&[^\s=&]+(?:=[^\s&]*)?)*$/.test(t) && t.includes('=')) return 'form';
  return 'text';
}

/** Decode application/x-www-form-urlencoded into [[key, value]] (+ is a space). Throws on malformed % escapes. */
export function parseForm(text) {
  const out = [];
  for (const part of text.trim().split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i), v = i < 0 ? '' : part.slice(i + 1);
    const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { throw new Error(`Malformed percent-encoding in “${s.slice(0, 40)}”`); } };
    out.push([dec(k), dec(v)]);
  }
  return out;
}
export function formToObject(pairs) {
  const o = {};
  for (const [k, v] of pairs) {
    if (Object.prototype.hasOwnProperty.call(o, k)) o[k] = [].concat(o[k], v);
    else o[k] = v;
  }
  return o;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);
const RAW = new Set(['script', 'style', 'pre', 'textarea']);
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'label']);

/** Lenient HTML pretty-printer (HTML is forgiving, so this formats rather than validates). */
export function formatHtml(html, indent = 2) {
  const unit = indent === 'tab' || indent === '\t' ? '\t' : ' '.repeat(Number(indent) || 2);
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(script|style|pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[A-Za-z][^>]*>|[^<]+|</g;
  const out = [];
  let depth = 0, m;
  const pad = () => unit.repeat(Math.max(0, depth));
  while ((m = re.exec(html))) {
    const tok = m[0];
    if (tok.startsWith('<!--') || /^<!doctype/i.test(tok)) { out.push(pad() + tok.trim()); continue; }
    if (m[1]) { // raw block: keep content exactly
      const open = /^<[^>]*>/.exec(tok)[0];
      const close = /<\/[^>]*>$/.exec(tok)[0];
      const body = tok.slice(open.length, tok.length - close.length);
      if (!body.trim()) out.push(pad() + open + close);
      else if (m[1].toLowerCase() === 'pre' || m[1].toLowerCase() === 'textarea') out.push(pad() + tok);
      else {
        out.push(pad() + open);
        const lines = body.replace(/^\n+|\s+$/g, '').split('\n');
        const minIndent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
        for (const l of lines) out.push(l.trim() ? pad() + unit + l.slice(minIndent) : '');
        out.push(pad() + close);
      }
      continue;
    }
    if (tok.startsWith('</')) { depth--; out.push(pad() + tok.trim()); continue; }
    if (tok.startsWith('<') && tok.length > 1) {
      const name = (/^<([A-Za-z][\w:-]*)/.exec(tok) || [, ''])[1].toLowerCase();
      out.push(pad() + tok.replace(/\s+/g, ' ').trim());
      if (!VOID.has(name) && !tok.endsWith('/>')) depth++;
      continue;
    }
    const text = tok.replace(/\s+/g, ' ').trim();
    if (text) out.push(pad() + text);
  }
  // join <tag>short text</tag> onto one line for readability
  const joined = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[i], b = out[i + 1], c = out[i + 2];
    const om = /^(\s*)<([A-Za-z][\w:-]*)[^>]*>$/.exec(a || '');
    if (om && b !== undefined && c !== undefined && !b.trim().startsWith('<') && c.trim() === `</${om[2]}>` && b.trim().length < 80) {
      joined.push(a + b.trim() + c.trim()); i += 2;
    } else joined.push(a);
  }
  return joined.join('\n');
}

export function minifyHtml(html) {
  return html
    .replace(/<!--(?!\[if)[\s\S]*?-->/g, '')
    .replace(/(<(pre|textarea|script|style)\b[\s\S]*?<\/\2>)|\s+/gi, (m0, raw) => raw || ' ')
    .replace(/>\s+</g, '><')
    .trim();
}
export { INLINE };
