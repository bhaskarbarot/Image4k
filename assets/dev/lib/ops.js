/* Data Workbench — extensible operation registry + recipe runner. Pure module (runs in a worker).
 *
 * An operation: { id, name, category, desc, args:[{id,label,type:'text'|'number'|'select'|'bool',default,options}],
 *                 input:'string'|'bytes', output:'string'|'bytes', run(value, args) → value | Promise<value> }
 * Values flow between steps as text or bytes; conversion between them is automatic (UTF-8).
 * To add an operation: push one object into OPS — the UI, search and recipe runner pick it up automatically. */
import {
  utf8Encode, utf8Decode, bytesToBase64, base64ToBytes, urlEncode, urlDecode, htmlEncode, htmlDecode,
  bytesToHex, hexToBytes, bytesToBinary, binaryToBytes,
} from './encode.js';
import { hashBytes, digestToString } from './hash.js';
import { reformat } from './json.js';
import { csvToJson, jsonToCsv } from './csv.js';
import { formatXml } from './xml.js';
import { yamlToJson, jsonToYaml } from './yaml.js';
import { uuidv4, uuidv7 } from './uuid.js';

export class RecipeError extends Error {
  constructor(step, opName, message) {
    super(`Step ${step + 1} (${opName}) failed: ${message}`);
    this.name = 'RecipeError'; this.step = step; this.opName = opName; this.reason = message;
  }
}

const sel = (id, label, options, def) => ({ id, label, type: 'select', options, default: def ?? options[0][0] });
const bool = (id, label, def = false) => ({ id, label, type: 'bool', default: def });
const txt = (id, label, def = '') => ({ id, label, type: 'text', default: def });
const num = (id, label, def = 0) => ({ id, label, type: 'number', default: def });

const lines = (s) => s.split(/\r\n|\n|\r/);
const unique = (arr) => Array.from(new Set(arr));
const indentOf = (v) => (v === 'tab' ? '\t' : Number(v));
const parseJsonText = (s) => JSON.parse(reformat(s, { indent: 0 }).text); // precise error messages

// --- extraction patterns ---
const URL_RE = /\b(?:https?|ftp|wss?):\/\/[^\s<>"'`{}|\\^]+[^\s<>"'`{}|\\^.,;:!?)\]]/gi;
const EMAIL_RE = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}\b/g;
const IPV4_RE = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.]*\d)/g;
const IPV6_RE = /(?<![0-9A-Fa-f:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:))(?![0-9A-Fa-f:])/g;
const DOMAIN_RE = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}\b/g;

function extract(re, s, args) {
  const found = s.match(re) || [];
  const list = args.unique ? unique(found) : found;
  return (args.sort ? [...list].sort() : list).join('\n');
}

function hexdump(bytes) {
  const out = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const row = bytes.subarray(off, off + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0'));
    const left = hex.slice(0, 8).join(' '), right = hex.slice(8).join(' ');
    const ascii = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    out.push(`${off.toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${ascii}|`);
  }
  return out.join('\n');
}

const naturalCmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

export const OPS = [
  // ---------- Encoding ----------
  { id: 'base64-encode', name: 'Base64 Encode', category: 'Encoding', desc: 'Bytes → Base64 text (RFC 4648).', input: 'bytes', output: 'string',
    args: [sel('alphabet', 'Alphabet', [['standard', 'Standard (+/)'], ['url', 'URL-safe (-_)']]), bool('wrap', 'Wrap at 76 chars')],
    run: (b, a) => bytesToBase64(b, { urlSafe: a.alphabet === 'url', wrap: a.wrap ? 76 : 0 }) },
  { id: 'base64-decode', name: 'Base64 Decode', category: 'Encoding', desc: 'Base64 (standard or URL-safe) → bytes. Whitespace and missing padding are tolerated unless strict.', input: 'string', output: 'bytes',
    args: [bool('strict', 'Strict (no whitespace / padding required)')],
    run: (s, a) => base64ToBytes(s, { strict: a.strict }).bytes },
  { id: 'url-encode', name: 'URL Encode', category: 'Encoding', desc: 'Percent-encode text.', input: 'string', output: 'string',
    args: [sel('mode', 'Mode', [['component', 'Component (encodeURIComponent)'], ['uri', 'Full URL (encodeURI)'], ['form', 'Form (+ for spaces)']])],
    run: (s, a) => urlEncode(s, a.mode) },
  { id: 'url-decode', name: 'URL Decode', category: 'Encoding', desc: 'Decode %XX sequences.', input: 'string', output: 'string',
    args: [sel('mode', 'Mode', [['component', 'Standard'], ['form', 'Form (+ means space)']])],
    run: (s, a) => urlDecode(s, a.mode) },
  { id: 'html-encode', name: 'HTML Entity Encode', category: 'Encoding', desc: 'Escape & < > " \' (optionally all non-ASCII).', input: 'string', output: 'string',
    args: [sel('mode', 'Encode', [['minimal', 'Only special characters'], ['nonascii', 'Special + non-ASCII'], ['all', 'Everything except letters/digits']])],
    run: (s, a) => htmlEncode(s, { mode: a.mode }) },
  { id: 'html-decode', name: 'HTML Entity Decode', category: 'Encoding', desc: 'Named (&amp;amp;), decimal (&amp;#169;) and hex (&amp;#xA9;) entities → characters.', input: 'string', output: 'string', args: [], run: (s) => htmlDecode(s) },
  { id: 'hex-encode', name: 'Hex Encode', category: 'Encoding', desc: 'Text (UTF-8) → hexadecimal.', input: 'bytes', output: 'string',
    args: [sel('sep', 'Separator', [['', 'None'], [' ', 'Space'], [':', 'Colon'], ['0x', '0x prefix']]), bool('upper', 'Upper case')],
    run: (b, a) => (a.sep === '0x' ? bytesToHex(b, { sep: ' ', prefix: '0x', upper: a.upper }).replace(/0X/g, '0x') : bytesToHex(b, { sep: a.sep, upper: a.upper })) },
  { id: 'hex-decode', name: 'Hex Decode', category: 'Encoding', desc: 'Hexadecimal → text (UTF-8). Spaces, colons and 0x prefixes are ignored.', input: 'string', output: 'string',
    args: [], run: (s) => utf8Decode(hexToBytes(s)) },
  { id: 'binary-encode', name: 'Binary Encode', category: 'Encoding', desc: 'Text (UTF-8) → 8-bit binary groups.', input: 'bytes', output: 'string',
    args: [sel('sep', 'Separator', [[' ', 'Space'], ['', 'None'], ['\n', 'New line']])], run: (b, a) => bytesToBinary(b, a.sep) },
  { id: 'binary-decode', name: 'Binary Decode', category: 'Encoding', desc: '0/1 groups → text (UTF-8).', input: 'string', output: 'string', args: [], run: (s) => utf8Decode(binaryToBytes(s)) },
  { id: 'utf8-encode', name: 'Text → UTF-8 bytes', category: 'Encoding', desc: 'Encode text as UTF-8 bytes (shows a byte view; chain with Bytes → Hex dump).', input: 'string', output: 'bytes', args: [], run: (s) => utf8Encode(s) },
  { id: 'decode-text', name: 'Bytes → Text (charset)', category: 'Encoding', desc: 'Decode bytes using a character set (UTF-8, UTF-16, Latin-1, Windows-1252…).', input: 'bytes', output: 'string',
    args: [sel('charset', 'Character set', [['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'], ['iso-8859-1', 'Latin-1 (ISO-8859-1)'], ['windows-1252', 'Windows-1252'], ['windows-1251', 'Windows-1251 (Cyrillic)'], ['shift_jis', 'Shift_JIS'], ['gbk', 'GBK']]), bool('fatal', 'Fail on invalid bytes')],
    run: (b, a) => {
      try { return new TextDecoder(a.charset, { fatal: a.fatal }).decode(b); } catch (e) {
        if (e instanceof RangeError) throw new Error(`Character set "${a.charset}" is not supported by this browser`);
        throw new Error(`Bytes are not valid ${a.charset}`);
      }
    } },

  // ---------- Hashing ----------
  ...[['md5', 'MD5'], ['sha1', 'SHA-1'], ['sha256', 'SHA-256'], ['sha512', 'SHA-512']].map(([id, alg]) => ({
    id, name: alg, category: 'Hashing', desc: `${alg} digest of the input bytes.${alg === 'MD5' || alg === 'SHA-1' ? ' Not secure for passwords or signatures.' : ''}`,
    input: 'bytes', output: 'string', args: [sel('format', 'Output', [['hex', 'hex'], ['HEX', 'HEX'], ['base64', 'Base64']])],
    run: async (b, a) => digestToString(await hashBytes(alg, b), a.format),
  })),

  // ---------- Text ----------
  { id: 'uppercase', name: 'Uppercase', category: 'Text', desc: 'Convert to UPPER CASE (Unicode-aware).', input: 'string', output: 'string', args: [], run: (s) => s.toUpperCase() },
  { id: 'lowercase', name: 'Lowercase', category: 'Text', desc: 'Convert to lower case (Unicode-aware).', input: 'string', output: 'string', args: [], run: (s) => s.toLowerCase() },
  { id: 'reverse', name: 'Reverse', category: 'Text', desc: 'Reverse characters (emoji-safe), words or lines.', input: 'string', output: 'string',
    args: [sel('by', 'Reverse by', [['char', 'Characters'], ['word', 'Words'], ['line', 'Lines']])],
    run: (s, a) => {
      if (a.by === 'line') return lines(s).reverse().join('\n');
      if (a.by === 'word') return s.split(/(\s+)/).reverse().join('');
      if (typeof Intl !== 'undefined' && Intl.Segmenter) return Array.from(new Intl.Segmenter().segment(s), (x) => x.segment).reverse().join('');
      return Array.from(s).reverse().join('');
    } },
  { id: 'remove-whitespace', name: 'Remove Whitespace', category: 'Text', desc: 'Remove spaces, tabs and/or line breaks.', input: 'string', output: 'string',
    args: [sel('mode', 'Remove', [['all', 'All whitespace'], ['collapse', 'Collapse runs to one space'], ['linebreaks', 'Line breaks only'], ['spaces', 'Spaces & tabs only']])],
    run: (s, a) => (a.mode === 'all' ? s.replace(/\s+/g, '') : a.mode === 'collapse' ? s.replace(/\s+/g, ' ').trim() : a.mode === 'linebreaks' ? s.replace(/[\r\n]+/g, '') : s.replace(/[ \t ]+/g, '')) },
  { id: 'dedupe-lines', name: 'Remove Duplicate Lines', category: 'Text', desc: 'Keep the first occurrence of each line.', input: 'string', output: 'string',
    args: [bool('ignoreCase', 'Ignore case'), bool('trim', 'Ignore leading/trailing spaces'), bool('dropEmpty', 'Drop empty lines')],
    run: (s, a) => {
      const seen = new Set(); const out = [];
      for (const l of lines(s)) {
        if (a.dropEmpty && !l.trim()) continue;
        let k = a.trim ? l.trim() : l; if (a.ignoreCase) k = k.toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push(l); }
      }
      return out.join('\n');
    } },
  { id: 'sort-lines', name: 'Sort Lines', category: 'Text', desc: 'Sort lines alphabetically, naturally (file2 < file10) or numerically.', input: 'string', output: 'string',
    args: [sel('mode', 'Order', [['alpha', 'Alphabetical'], ['natural', 'Natural'], ['numeric', 'Numeric'], ['length', 'By length']]), bool('desc', 'Descending'), bool('ignoreCase', 'Ignore case', true)],
    run: (s, a) => {
      const arr = lines(s);
      let cmp;
      if (a.mode === 'numeric') cmp = (x, y) => { const nx = parseFloat(x), ny = parseFloat(y); return (isNaN(nx) ? Infinity : nx) - (isNaN(ny) ? Infinity : ny) || naturalCmp(x, y); };
      else if (a.mode === 'natural') cmp = naturalCmp;
      else if (a.mode === 'length') cmp = (x, y) => x.length - y.length;
      else cmp = a.ignoreCase ? (x, y) => { const p = x.toLowerCase(), q = y.toLowerCase(); return p < q ? -1 : p > q ? 1 : 0; } : (x, y) => (x < y ? -1 : x > y ? 1 : 0);
      arr.sort(cmp);
      if (a.desc) arr.reverse();
      return arr.join('\n');
    } },
  { id: 'trim-lines', name: 'Trim Lines', category: 'Text', desc: 'Remove leading/trailing whitespace from every line.', input: 'string', output: 'string',
    args: [sel('side', 'Trim', [['both', 'Both sides'], ['start', 'Start'], ['end', 'End']]), bool('dropEmpty', 'Drop empty lines')],
    run: (s, a) => lines(s).map((l) => (a.side === 'start' ? l.trimStart() : a.side === 'end' ? l.trimEnd() : l.trim())).filter((l) => !a.dropEmpty || l).join('\n') },
  { id: 'find-replace', name: 'Find & Replace', category: 'Text', desc: 'Replace literal text or a regular expression ($1, $<name> work in regex mode).', input: 'string', output: 'string',
    args: [txt('find', 'Find'), txt('replace', 'Replace with'), sel('mode', 'Mode', [['literal', 'Literal text'], ['regex', 'Regular expression']]), bool('global', 'Replace all', true), bool('ignoreCase', 'Ignore case'), bool('multiline', 'Multiline (^ $ per line)')],
    run: (s, a) => {
      if (!a.find) throw new Error('Enter the text to find');
      const flags = (a.global ? 'g' : '') + (a.ignoreCase ? 'i' : '') + (a.multiline ? 'm' : '') + 'u';
      const pattern = a.mode === 'regex' ? a.find : a.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let re;
      try { re = new RegExp(pattern, flags); } catch (e) { throw new Error('Invalid regular expression: ' + e.message.replace(/^Invalid regular expression: /, '')); }
      return a.mode === 'regex' ? s.replace(re, a.replace) : s.replace(re, () => a.replace);
    } },
  { id: 'substring', name: 'Extract Substring', category: 'Text', desc: 'Characters from a start position (0-based; negative counts from the end) with an optional length.', input: 'string', output: 'string',
    args: [num('start', 'Start', 0), num('length', 'Length (0 = to end)', 0)],
    run: (s, a) => {
      const chars = Array.from(s);
      let st = Math.trunc(Number(a.start) || 0); if (st < 0) st = Math.max(0, chars.length + st);
      const len = Math.trunc(Number(a.length) || 0);
      if (len < 0) throw new Error('Length cannot be negative');
      return chars.slice(st, len ? st + len : undefined).join('');
    } },
  { id: 'count-chars', name: 'Count Characters', category: 'Text', desc: 'Characters, bytes, lines and more.', input: 'string', output: 'string', args: [],
    run: (s) => {
      const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? Array.from(new Intl.Segmenter().segment(s)).length : Array.from(s).length;
      return [
        `Characters (as seen): ${graphemes}`, `Code points: ${Array.from(s).length}`, `UTF-16 units (JS length): ${s.length}`,
        `UTF-8 bytes: ${utf8Encode(s).length}`, `Without whitespace: ${Array.from(s.replace(/\s/g, '')).length}`,
        `Lines: ${s ? lines(s).length : 0}`,
      ].join('\n');
    } },
  { id: 'count-words', name: 'Count Words', category: 'Text', desc: 'Words, unique words, sentences, lines.', input: 'string', output: 'string', args: [bool('top', 'List the 10 most frequent words')],
    run: (s, a) => {
      const words = s.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || [];
      const freq = new Map();
      for (const w of words) { const k = w.toLowerCase(); freq.set(k, (freq.get(k) || 0) + 1); }
      const out = [`Words: ${words.length}`, `Unique words: ${freq.size}`, `Sentences: ${(s.match(/[^.!?…]+[.!?…]+/g) || []).length}`, `Lines: ${s ? lines(s).length : 0}`, `Paragraphs: ${s.trim() ? s.trim().split(/\n\s*\n/).length : 0}`];
      if (a.top) out.push('', 'Top words:', ...[...freq].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([w, n]) => `  ${w} — ${n}`));
      return out.join('\n');
    } },

  // ---------- Data formats ----------
  { id: 'json-beautify', name: 'JSON Beautify', category: 'Data formats', desc: 'Pretty-print JSON (numbers kept exactly).', input: 'string', output: 'string',
    args: [sel('indent', 'Indent', [['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'Tab']])], run: (s, a) => reformat(s, { indent: indentOf(a.indent) }).text },
  { id: 'json-minify', name: 'JSON Minify', category: 'Data formats', desc: 'Remove insignificant whitespace from JSON.', input: 'string', output: 'string', args: [], run: (s) => reformat(s, { indent: 0 }).text },
  { id: 'json-to-csv', name: 'JSON to CSV', category: 'Data formats', desc: 'Array of objects → CSV (nested keys flattened with dots).', input: 'string', output: 'string',
    args: [sel('delimiter', 'Delimiter', [[',', 'Comma'], [';', 'Semicolon'], ['tab', 'Tab'], ['|', 'Pipe']])], run: (s, a) => jsonToCsv(parseJsonText(s), { delimiter: a.delimiter }) },
  { id: 'csv-to-json', name: 'CSV to JSON', category: 'Data formats', desc: 'CSV → JSON array (quoted fields, commas and newlines inside quotes handled).', input: 'string', output: 'string',
    args: [sel('delimiter', 'Delimiter', [['auto', 'Auto-detect'], [',', 'Comma'], [';', 'Semicolon'], ['tab', 'Tab'], ['|', 'Pipe']]), bool('header', 'First row is header', true), bool('types', 'Convert numbers / booleans')],
    run: (s, a) => JSON.stringify(csvToJson(s, { delimiter: a.delimiter, header: a.header, types: a.types }), null, 2) },
  { id: 'xml-format', name: 'XML Format', category: 'Data formats', desc: 'Pretty-print XML (entities never expanded).', input: 'string', output: 'string',
    args: [sel('indent', 'Indent', [['2', '2 spaces'], ['4', '4 spaces'], ['tab', 'Tab']])], run: (s, a) => formatXml(s, { indent: indentOf(a.indent) }) },
  { id: 'yaml-to-json', name: 'YAML to JSON', category: 'Data formats', desc: 'YAML → JSON (multiple documents become an array).', input: 'string', output: 'string',
    args: [sel('indent', 'Indent', [['2', '2 spaces'], ['4', '4 spaces'], ['0', 'Minified']])], run: (s, a) => yamlToJson(s, Number(a.indent)) },
  { id: 'json-to-yaml', name: 'JSON to YAML', category: 'Data formats', desc: 'JSON → YAML.', input: 'string', output: 'string', args: [], run: (s) => jsonToYaml(s) },

  // ---------- Binary & hex ----------
  { id: 'hex-to-bytes', name: 'Hex → Bytes', category: 'Binary & hex', desc: 'Hexadecimal → raw bytes (download them, or chain further).', input: 'string', output: 'bytes', args: [], run: (s) => hexToBytes(s) },
  { id: 'bytes-to-hex', name: 'Bytes → Hex dump', category: 'Binary & hex', desc: 'Canonical hex dump: offset, 16 bytes per row, ASCII column.', input: 'bytes', output: 'string', args: [], run: (b) => hexdump(b) },
  { id: 'binary-to-hex', name: 'Binary → Hex', category: 'Binary & hex', desc: 'Bit groups → hexadecimal.', input: 'string', output: 'string',
    args: [sel('sep', 'Separator', [[' ', 'Space'], ['', 'None']])], run: (s, a) => bytesToHex(binaryToBytes(s), { sep: a.sep }) },
  { id: 'hex-to-binary', name: 'Hex → Binary', category: 'Binary & hex', desc: 'Hexadecimal → 8-bit groups.', input: 'string', output: 'string',
    args: [sel('sep', 'Separator', [[' ', 'Space'], ['', 'None']])], run: (s, a) => bytesToBinary(hexToBytes(s), a.sep) },

  // ---------- Utilities ----------
  { id: 'generate-uuid', name: 'Generate UUID', category: 'Utilities', desc: 'Generate UUIDs (ignores the input).', input: 'string', output: 'string',
    args: [sel('version', 'Version', [['4', 'v4 (random)'], ['7', 'v7 (time-ordered)']]), num('count', 'How many', 1)],
    run: (s, a) => {
      const n = Math.trunc(Number(a.count) || 1);
      if (n < 1 || n > 10000) throw new Error('Count must be between 1 and 10000');
      return Array.from({ length: n }, () => (a.version === '7' ? uuidv7() : uuidv4())).join('\n');
    } },
  { id: 'parse-url', name: 'Parse URL', category: 'Utilities', desc: 'Break a URL into protocol, host, port, path, query parameters and fragment (JSON).', input: 'string', output: 'string', args: [],
    run: (s) => {
      let u;
      try { u = new URL(s.trim()); } catch (e) { throw new Error('Not a valid absolute URL (include the scheme, e.g. https://)'); }
      const params = {};
      for (const [k, v] of u.searchParams) { if (k in params) params[k] = [].concat(params[k], v); else params[k] = v; }
      return JSON.stringify({ href: u.href, protocol: u.protocol.replace(/:$/, ''), username: u.username || undefined, password: u.password ? '••••' : undefined, hostname: u.hostname, port: u.port || null, origin: u.origin, pathname: u.pathname, search: u.search, query: params, hash: u.hash }, null, 2);
    } },
  { id: 'extract-urls', name: 'Extract URLs', category: 'Utilities', desc: 'Find http(s), ftp and ws(s) URLs.', input: 'string', output: 'string', args: [bool('unique', 'Unique only', true), bool('sort', 'Sort')], run: (s, a) => extract(URL_RE, s, a) },
  { id: 'extract-emails', name: 'Extract Emails', category: 'Utilities', desc: 'Find email addresses.', input: 'string', output: 'string', args: [bool('unique', 'Unique only', true), bool('sort', 'Sort')], run: (s, a) => extract(EMAIL_RE, s, a) },
  { id: 'extract-ips', name: 'Extract IP Addresses', category: 'Utilities', desc: 'Find IPv4 and IPv6 addresses.', input: 'string', output: 'string',
    args: [sel('version', 'Version', [['both', 'IPv4 + IPv6'], ['4', 'IPv4 only'], ['6', 'IPv6 only']]), bool('unique', 'Unique only', true), bool('sort', 'Sort')],
    run: (s, a) => {
      const found = [];
      if (a.version !== '6') found.push(...(s.match(IPV4_RE) || []));
      if (a.version !== '4') found.push(...(s.match(IPV6_RE) || []).filter((x) => x.includes(':') && x !== '::' && x.replace(/:/g, '').length > 0));
      const list = a.unique ? unique(found) : found;
      return (a.sort ? [...list].sort() : list).join('\n');
    } },
  { id: 'extract-domains', name: 'Extract Domains', category: 'Utilities', desc: 'Find domain names (from URLs, emails and plain text).', input: 'string', output: 'string', args: [bool('unique', 'Unique only', true), bool('sort', 'Sort')],
    run: (s, a) => {
      const found = (s.match(DOMAIN_RE) || []).map((d) => d.toLowerCase()).filter((d) => !/^\d+(\.\d+)+$/.test(d));
      const list = a.unique ? unique(found) : found;
      return (a.sort ? [...list].sort() : list).join('\n');
    } },
];

export const CATEGORIES = Array.from(new Set(OPS.map((o) => o.category)));
export const opById = (id) => OPS.find((o) => o.id === id);
export const defaultArgs = (op) => Object.fromEntries(op.args.map((a) => [a.id, a.default]));

/** Normalise a recipe from storage/URL: drop unknown ops, fill missing args. */
export function sanitizeRecipe(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.filter((s) => s && opById(s.op)).map((s) => {
    const op = opById(s.op);
    const args = defaultArgs(op);
    for (const a of op.args) if (s.args && s.args[a.id] !== undefined) args[a.id] = a.type === 'bool' ? !!s.args[a.id] : a.type === 'number' ? Number(s.args[a.id]) : String(s.args[a.id]);
    return { op: s.op, args, disabled: !!s.disabled };
  });
}

/**
 * runRecipe(input: string|Uint8Array, steps:[{op, args, disabled}]) → { type:'string'|'bytes', value, steps: n }
 * Throws RecipeError naming the failing step.
 */
export async function runRecipe(input, steps, opts = {}) {
  let cur = typeof input === 'string' ? { t: 'string', v: input } : { t: 'bytes', v: input };
  let ran = 0;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.disabled) continue;
    const op = opById(st.op);
    if (!op) throw new RecipeError(i, st.op, 'unknown operation');
    const args = { ...defaultArgs(op), ...(st.args || {}) };
    let v = cur.v;
    if (op.input === 'bytes' && cur.t === 'string') v = utf8Encode(v);
    else if (op.input === 'string' && cur.t === 'bytes') v = utf8Decode(v);
    try {
      const r = await op.run(v, args);
      cur = op.output === 'bytes' ? { t: 'bytes', v: r instanceof Uint8Array ? r : utf8Encode(String(r)) } : { t: 'string', v: String(r) };
    } catch (e) {
      throw new RecipeError(i, op.name, (e && (e.reason ? e.message : e.message)) || String(e));
    }
    ran++;
    if (opts.onStep) opts.onStep(i);
  }
  return { type: cur.t, value: cur.v, steps: ran };
}

/** Share recipes in the URL: base64url(JSON). */
export function encodeRecipe(steps) {
  const compact = steps.map((s) => {
    const op = opById(s.op); const d = defaultArgs(op);
    const args = {}; for (const k in s.args) if (s.args[k] !== d[k]) args[k] = s.args[k];
    return Object.assign({ op: s.op }, Object.keys(args).length ? { args } : {}, s.disabled ? { disabled: true } : {});
  });
  return bytesToBase64(utf8Encode(JSON.stringify(compact)), { urlSafe: true, pad: false });
}
export function decodeRecipe(str) {
  try { return sanitizeRecipe(JSON.parse(utf8Decode(base64ToBytes(str).bytes))); } catch (e) { return []; }
}
