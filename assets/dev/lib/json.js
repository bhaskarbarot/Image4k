/* JSON utilities — pure functions (no DOM), shared by the JSON tools, API tools and the workbench.
 * The formatter is a streaming tokenizer, not JSON.parse → JSON.stringify, so it:
 *  - keeps numbers exactly as written (no precision loss on 64-bit IDs like 12345678901234567890),
 *  - keeps duplicate keys and key order,
 *  - reports the exact line/column of the first error with a human message,
 *  - never recurses (very deep documents cannot overflow the stack). */

export class JsonError extends Error {
  constructor(message, pos, text) {
    const { line, col } = posToLineCol(text, pos);
    super(`${message} (line ${line}, column ${col})`);
    this.name = 'JsonError';
    this.reason = message; this.pos = pos; this.line = line; this.col = col;
  }
}

export function posToLineCol(text, pos) {
  let line = 1, last = -1;
  const end = Math.min(pos, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) { line++; last = i; }
  return { line, col: end - last };
}

const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WS = (c) => c === 32 || c === 10 || c === 13 || c === 9;

function describe(text, i) {
  if (i >= text.length) return 'end of input';
  const ch = text[i];
  if (ch === '\n') return 'a line break';
  return `'${ch}'`;
}

/**
 * Re-print JSON. opts.indent: number of spaces, or '\t'. opts.indent = 0/'' → minified.
 * Throws JsonError on invalid input. Returns { text, stats: { depth, values, keys, type } }.
 */
export function reformat(text, opts = {}) {
  const unit = opts.indent === '\t' || opts.indent === 'tab' ? '\t' : ' '.repeat(Math.max(0, Number(opts.indent) || 0));
  const pretty = unit.length > 0;
  const nl = (d) => (pretty ? '\n' + unit.repeat(d) : '');
  const out = [];
  const stack = []; // 'o' | 'a'
  const counts = [];
  let i = 0;
  const n = text.length;
  let expect = 'value'; // value | valueOrEnd | key | keyOrEnd | colon | commaOrEnd | end
  let maxDepth = 0, values = 0, keys = 0, rootType = null;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM

  const fail = (msg, at = i) => { throw new JsonError(msg, at, text); };

  function readString() {
    const start = i;
    i++; // opening quote
    for (;;) {
      if (i >= n) fail('Unterminated string — a closing " is missing', start);
      const c = text.charCodeAt(i);
      if (c === 34) { i++; return text.slice(start, i); }
      if (c === 92) {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('Invalid \\u escape — expected 4 hex digits', i);
          i += 6; continue;
        }
        if (e === undefined || '"\\/bfnrt'.indexOf(e) < 0) fail(`Invalid escape sequence '\\${e ?? ''}' in string`, i);
        i += 2; continue;
      }
      if (c < 0x20) fail(c === 10 ? 'Line break inside a string — use \\n instead' : 'Control character inside a string must be escaped', i);
      i++;
    }
  }
  function readScalar() {
    const c = text[i];
    if (c === '"') return readString();
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUM.lastIndex = i;
      const m = NUM.exec(text);
      if (!m) fail('Invalid number');
      const after = text[i + m[0].length];
      if (after && /[0-9.eE+\-xX]/.test(after)) fail(m[0] === '0' || m[0] === '-0' ? 'Numbers cannot have leading zeros or hex/octal notation' : 'Invalid number', i);
      i += m[0].length; return m[0];
    }
    for (const lit of ['true', 'false', 'null']) {
      if (text.startsWith(lit, i)) {
        const after = text[i + lit.length];
        if (after && /[A-Za-z0-9_$]/.test(after)) break;
        i += lit.length; return lit;
      }
    }
    if (c === "'") fail('Strings must use double quotes ("), not single quotes');
    if (c === '/') fail('Comments are not allowed in JSON');
    if (text.startsWith('NaN', i) || text.startsWith('Infinity', i) || text.startsWith('undefined', i)) fail(`${text.startsWith('NaN', i) ? 'NaN' : text.startsWith('Infinity', i) ? 'Infinity' : 'undefined'} is not a valid JSON value`);
    if (c === '+') fail("Numbers cannot start with '+'");
    if (c === '.') fail('Numbers must have a digit before the decimal point');
    const word = (/^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 40)) || [''])[0];
    if (word && ['true', 'false', 'null'].some((l) => l.startsWith(word) || word.startsWith(l))) fail(`Invalid value '${word}' — did you mean ${['true', 'false', 'null'].find((l) => l[0] === word[0])}?`);
    if (/[A-Za-z_$]/.test(c)) fail(`Unexpected word starting with '${c}' — strings must be in double quotes`);
    return fail(`Unexpected ${describe(text, i)} — expected a value`);
  }
  function afterValue() {
    values++;
    expect = stack.length ? 'commaOrEnd' : 'end';
  }
  function open(kind) {
    out.push(kind === 'o' ? '{' : '[');
    stack.push(kind); counts.push(0);
    if (stack.length > maxDepth) maxDepth = stack.length;
    expect = kind === 'o' ? 'keyOrEnd' : 'valueOrEnd';
    if (!rootType) rootType = kind === 'o' ? 'object' : 'array';
    i++;
  }
  function close(kind) {
    const k = stack.pop(); const cnt = counts.pop();
    if (k !== kind) fail(`Mismatched bracket: expected '${k === 'o' ? '}' : ']'}' but found '${kind === 'o' ? '}' : ']'}'`);
    if (cnt > 0) out.push(nl(stack.length));
    out.push(kind === 'o' ? '}' : ']');
    i++;
    afterValue();
  }
  function startItem() {
    counts[counts.length - 1]++;
    out.push(nl(stack.length));
  }

  while (true) {
    while (i < n && WS(text.charCodeAt(i))) i++;
    if (i >= n) break;
    const c = text[i];
    switch (expect) {
      case 'value':
      case 'valueOrEnd': {
        if (c === ']' && expect === 'valueOrEnd') { close('a'); break; }
        if (c === ']' || c === '}') fail(stack.length ? (text.lastIndexOf(',', i) > -1 && /,\s*$/.test(text.slice(0, i)) ? 'Trailing comma is not allowed in JSON' : `Unexpected '${c}' — expected a value`) : `Unexpected '${c}'`);
        if (stack.length && stack[stack.length - 1] === 'a') startItem();
        if (c === '{') { open('o'); break; }
        if (c === '[') { open('a'); break; }
        const tok = readScalar();
        if (!rootType) rootType = tok[0] === '"' ? 'string' : tok === 'null' ? 'null' : tok === 'true' || tok === 'false' ? 'boolean' : 'number';
        out.push(tok);
        afterValue();
        break;
      }
      case 'keyOrEnd':
      case 'key': {
        if (c === '}' && expect === 'keyOrEnd') { close('o'); break; }
        if (c === '}') fail('Trailing comma is not allowed in JSON');
        if (c !== '"') {
          if (c === "'") fail('Property names must use double quotes ("), not single quotes');
          if (/[A-Za-z_$]/.test(c)) fail('Property names must be wrapped in double quotes');
          if (c === '/') fail('Comments are not allowed in JSON');
          fail(`Unexpected ${describe(text, i)} — expected a property name in double quotes`);
        }
        startItem();
        out.push(readString());
        keys++;
        expect = 'colon';
        break;
      }
      case 'colon':
        if (c !== ':') fail(`Expected ':' after property name, found ${describe(text, i)}`);
        out.push(pretty ? ': ' : ':');
        i++;
        expect = 'value';
        break;
      case 'commaOrEnd': {
        const top = stack[stack.length - 1];
        if (c === ',') { out.push(','); i++; expect = top === 'o' ? 'key' : 'value'; break; }
        if (c === '}' || c === ']') { close(c === '}' ? 'o' : 'a'); break; }
        if (c === '/') fail('Comments are not allowed in JSON');
        fail(`Expected ',' or '${top === 'o' ? '}' : ']'}' after ${top === 'o' ? 'property value' : 'array element'}, found ${describe(text, i)}`);
        break;
      }
      case 'end':
        fail(c === ',' ? 'Unexpected comma after the top-level value' : `Unexpected ${describe(text, i)} after the end of the JSON value`);
    }
  }
  if (!rootType && expect === 'value') fail(text.trim() ? 'Expected a JSON value' : 'Input is empty', i);
  if (stack.length) fail(`Unexpected end of input — ${stack.length} unclosed ${stack[stack.length - 1] === 'o' ? "object '{'" : "array '['"}`, n);
  if (expect === 'colon') fail("Unexpected end of input — expected ':'", n);
  return { text: out.join(''), stats: { depth: maxDepth, values, keys, type: rootType } };
}

/** Validate + locate the first error. Never throws. */
export function validateJson(text) {
  try { const r = reformat(text, { indent: 0 }); return { ok: true, stats: r.stats }; } catch (e) {
    if (e instanceof JsonError) return { ok: false, error: { message: e.reason, line: e.line, col: e.col, pos: e.pos, full: e.message } };
    throw e;
  }
}

export function formatJson(text, indent = 2) { return reformat(text, { indent }).text; }
export function minifyJson(text) { return reformat(text, { indent: 0 }).text; }

/** JSON.parse with the same precise error messages as the formatter. */
export function parseJson(text) {
  try { return JSON.parse(text); } catch (e) {
    reformat(text, { indent: 0 }); // throws a precise JsonError
    throw e; // (should not happen) parser disagreement
  }
}

/** True if the document contains integers that JavaScript numbers cannot represent exactly. */
export function hasUnsafeNumbers(text) {
  const re = /"(?:\\.|[^"\\])*"|(-?\d{16,})(?![.\deE])/g; let m;
  while ((m = re.exec(text))) if (m[1] && !Number.isSafeInteger(Number(m[1]))) return true;
  return false;
}

/** Deep sort object keys (arrays keep their order). */
export function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) o[k] = sortKeysDeep(v[k]);
    return o;
  }
  return v;
}

export function indentArg(v) { return v === 'tab' ? '\t' : Number(v) || 2; }
