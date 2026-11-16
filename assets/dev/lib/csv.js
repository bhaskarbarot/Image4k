/* CSV ⇄ JSON — RFC 4180 parser/serializer. Pure functions, no DOM.
 * Handles quoted fields, escaped quotes (""), delimiters and line breaks inside quotes, CRLF/LF/CR,
 * empty cells, ragged rows and a UTF-8 BOM. */

export class CsvError extends Error {
  constructor(message, line) { super(`${message} (line ${line})`); this.name = 'CsvError'; this.reason = message; this.line = line; }
}

const CANDIDATES = [',', ';', '\t', '|'];

/** Guess the delimiter from the first few lines (characters outside quotes). */
export function detectDelimiter(text) {
  const sample = text.slice(0, 20000);
  const counts = Object.fromEntries(CANDIDATES.map((d) => [d, 0]));
  let inQ = false, lines = 0;
  for (let i = 0; i < sample.length && lines < 10; i++) {
    const c = sample[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && c === '\n') lines++;
    else if (!inQ && c in counts) counts[c]++;
  }
  let best = ',', n = 0;
  for (const d of CANDIDATES) if (counts[d] > n) { best = d; n = counts[d]; }
  return best;
}

/** parseCsv(text, {delimiter: ','|'auto'|…, quote: '"'}) → string[][] */
export function parseCsv(text, opts = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = !opts.delimiter || opts.delimiter === 'auto' ? detectDelimiter(text) : opts.delimiter === 'tab' ? '\t' : opts.delimiter;
  const q = opts.quote || '"';
  const rows = [];
  let row = [], field = '', i = 0, line = 1, inQuotes = false, quoteStart = 0, fieldStarted = false;
  const n = text.length;
  const endField = () => { row.push(field); field = ''; fieldStarted = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === q) {
        if (text[i + 1] === q) { field += q; i += 2; continue; }
        inQuotes = false; i++;
        // after a closing quote only a delimiter, newline or EOF may follow
        const nx = text[i];
        if (nx !== undefined && nx !== d && nx !== '\n' && nx !== '\r') {
          if (opts.strict) throw new CsvError(`Unexpected character '${nx}' after closing quote`, line);
          // lenient: keep the stray characters as part of the field
          while (i < n && text[i] !== d && text[i] !== '\n' && text[i] !== '\r') field += text[i++];
        }
        continue;
      }
      if (c === '\n') line++;
      field += c; i++;
      continue;
    }
    if (c === q && !fieldStarted) { inQuotes = true; quoteStart = line; fieldStarted = true; i++; continue; }
    if (c === d) { endField(); i++; continue; }
    if (c === '\r' || c === '\n') {
      endRow(); line++;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; fieldStarted = true; i++;
  }
  if (inQuotes) throw new CsvError('Unterminated quoted field — a closing " is missing', quoteStart);
  if (field !== '' || row.length) endRow();
  // drop completely empty lines (a lone empty field), common at the end of files
  const out = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  out.delimiter = d;
  return out;
}

function typed(v) {
  if (v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(v)) {
    const num = Number(v);
    if (Number.isFinite(num) && (!/^-?\d+$/.test(v) || Number.isSafeInteger(num))) return num;
  }
  return v;
}

/** csvToJson(text, {header=true, delimiter='auto', types=false}) → array of objects (or arrays if header=false) */
export function csvToJson(text, opts = {}) {
  const rows = parseCsv(text, opts);
  const conv = opts.types ? typed : (v) => v;
  if (opts.header === false) return rows.map((r) => r.map(conv));
  if (!rows.length) return [];
  const seen = new Map();
  const keys = rows[0].map((k, idx) => {
    let key = k.trim() || `column_${idx + 1}`;
    if (seen.has(key)) { let n = seen.get(key) + 1; while (seen.has(`${key}_${n}`)) n++; seen.set(key, n); key = `${key}_${n}`; }
    seen.set(key, 1);
    return key;
  });
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const o = {};
    const cells = rows[r];
    const width = Math.max(keys.length, cells.length);
    for (let c = 0; c < width; c++) {
      const key = keys[c] || `column_${c + 1}`;
      o[key] = c < cells.length ? conv(cells[c]) : (opts.types ? null : '');
    }
    out.push(o);
  }
  return out;
}

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function cell(v, d, opts) {
  let s;
  if (v === null || v === undefined) s = '';
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  // Optional protection against spreadsheet formula injection (=, +, -, @ at the start).
  if (opts.excelSafe && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(d) || s.includes('"') || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * jsonToCsv(value, {delimiter=',', header=true, flatten=true, eol='\n', excelSafe=false}) → string
 * value: array of objects (keys unioned in first-seen order), array of arrays, array of scalars, or one object.
 */
export function jsonToCsv(value, opts = {}) {
  const d = opts.delimiter === 'tab' ? '\t' : opts.delimiter || ',';
  const eol = opts.eol || '\n';
  const doFlat = opts.flatten !== false;
  let data = value;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    // { "items": [...] } → use the first array property if it is the only meaningful content
    const arrays = Object.values(data).filter(Array.isArray);
    data = arrays.length === 1 && Object.keys(data).length === 1 ? arrays[0] : [data];
  }
  if (!Array.isArray(data)) throw new Error('JSON must be an array (of objects or arrays) or an object to convert to CSV');
  if (!data.length) return '';
  const lines = [];
  if (data.every(Array.isArray)) {
    for (const r of data) lines.push(r.map((v) => cell(v, d, opts)).join(d));
    return lines.join(eol);
  }
  if (data.every((x) => x === null || typeof x !== 'object')) {
    if (opts.header !== false) lines.push('value');
    for (const v of data) lines.push(cell(v, d, opts));
    return lines.join(eol);
  }
  const rows = data.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? (doFlat ? flatten(x, '', {}) : x) : { value: x }));
  const keys = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  if (opts.header !== false) lines.push(keys.map((k) => cell(k, d, opts)).join(d));
  for (const r of rows) lines.push(keys.map((k) => cell(r[k], d, opts)).join(d));
  return lines.join(eol);
}
