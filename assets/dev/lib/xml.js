/* XML formatter / minifier / validator — a pure tokenizer (no DOM, no network).
 * Security: DOCTYPE declarations are kept as text and entities are NEVER expanded or fetched,
 * so external-entity (XXE) and entity-expansion ("billion laughs") attacks are impossible by design. */

export class XmlError extends Error {
  constructor(message, pos, text) {
    let line = 1, last = -1;
    for (let i = 0; i < Math.min(pos, text.length); i++) if (text.charCodeAt(i) === 10) { line++; last = i; }
    const col = Math.min(pos, text.length) - last;
    super(`${message} (line ${line}, column ${col})`);
    this.name = 'XmlError'; this.reason = message; this.pos = pos; this.line = line; this.col = col;
  }
}

const NAME_START = /[A-Za-z_:À-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�]/;
const NAME_RE = /[A-Za-z_:À-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�][\w.\-:·À-ÖØ-öø-ͽͿ-῿‌-‍‿-⁀⁰-↏Ⰰ-⿯、-퟿豈-﷏ﷰ-�]*/y;
const ENTITY_RE = /&(?:[A-Za-z_:][\w.\-:]*|#\d+|#x[0-9a-fA-F]+);/y;

/** Tokenize into a flat list: {t:'decl'|'pi'|'comment'|'cdata'|'doctype'|'open'|'close'|'self'|'text', ...} */
export function tokenize(text) {
  const toks = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (msg, at = i) => { throw new XmlError(msg, at, text); };
  const stack = [];
  let rootSeen = false, rootClosed = false;

  function checkText(s, at) {
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '&') {
        ENTITY_RE.lastIndex = k;
        if (!ENTITY_RE.exec(s)) fail("Unescaped '&' — use &amp; (or a valid entity like &lt; or &#169;)", at + k);
      }
    }
  }
  function readName(what) {
    NAME_RE.lastIndex = i;
    const m = NAME_RE.exec(text);
    if (!m) fail(`Invalid ${what} name` + (text[i] ? ` starting with '${text[i]}'` : ''));
    i += m[0].length;
    return m[0];
  }
  const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };

  while (i < n) {
    if (text[i] !== '<') {
      const start = i;
      const end = text.indexOf('<', i);
      const s = text.slice(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      if (s.trim()) {
        if (!stack.length) fail(rootClosed ? 'Text after the root element is not allowed' : 'Text before the root element is not allowed', start + s.search(/\S/));
        checkText(s, start);
        if (s.includes(']]>')) fail("']]>' is not allowed in text", start + s.indexOf(']]>'));
      }
      toks.push({ t: 'text', v: s, pos: start });
      continue;
    }
    const start = i;
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) fail('Unterminated processing instruction — missing ?>');
      const body = text.slice(i, end + 2);
      const isDecl = /^<\?xml[\s?]/.test(body);
      if (isDecl && start !== (text.charCodeAt(0) === 0xfeff ? 1 : 0)) fail('The XML declaration must be at the very start of the document');
      toks.push({ t: isDecl ? 'decl' : 'pi', v: body, pos: start });
      i = end + 2; continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) fail('Unterminated comment — missing -->');
      const body = text.slice(i + 4, end);
      if (body.includes('--')) fail("'--' is not allowed inside a comment", i + 4 + body.indexOf('--'));
      toks.push({ t: 'comment', v: text.slice(i, end + 3), pos: start });
      i = end + 3; continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      if (!stack.length) fail('CDATA is only allowed inside an element');
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) fail('Unterminated CDATA section — missing ]]>');
      toks.push({ t: 'cdata', v: text.slice(i, end + 3), pos: start });
      i = end + 3; continue;
    }
    if (text.startsWith('<!DOCTYPE', i)) {
      if (rootSeen) fail('DOCTYPE must come before the root element');
      // find the closing '>' while skipping an internal subset [ ... ] and quoted strings
      let j = i + 9, depth = 0, quote = null;
      for (; j < n; j++) {
        const c = text[j];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= n) fail('Unterminated DOCTYPE');
      toks.push({ t: 'doctype', v: text.slice(i, j + 1), pos: start });
      i = j + 1; continue;
    }
    if (text.startsWith('</', i)) {
      i += 2;
      const name = readName('closing tag');
      skipWs();
      if (text[i] !== '>') fail(`Expected '>' to close </${name}`);
      i++;
      const open = stack.pop();
      if (!open) fail(`Closing tag </${name}> has no matching opening tag`, start);
      if (open.name !== name) fail(`Mismatched closing tag: expected </${open.name}> (opened on line ${lineOf(text, open.pos)}) but found </${name}>`, start);
      if (!stack.length) rootClosed = true;
      toks.push({ t: 'close', name, pos: start });
      continue;
    }
    if (text[i + 1] === '!') fail("Unknown markup declaration '<!'");
    // start tag
    i++;
    if (!NAME_START.test(text[i] || '')) fail(text[i] === ' ' ? "Tag names cannot start with a space after '<'" : `Invalid tag name starting with '${text[i] ?? 'end of input'}' — escape a literal '<' as &lt;`);
    const name = readName('tag');
    if (!stack.length) {
      if (rootClosed) fail(`Only one root element is allowed — found a second root <${name}>`, start);
      rootSeen = true;
    }
    const attrs = [];
    const names = new Set();
    for (;;) {
      const hadWs = /\s/.test(text[i] || '');
      skipWs();
      if (i >= n) fail(`Unterminated tag <${name}>`, start);
      if (text[i] === '>') { i++; toks.push({ t: 'open', name, attrs, pos: start }); stack.push({ name, pos: start }); break; }
      if (text.startsWith('/>', i)) { i += 2; toks.push({ t: 'self', name, attrs, pos: start }); if (!stack.length) rootClosed = true; break; }
      if (!hadWs) fail(`Missing space between attributes in <${name}>`);
      const aPos = i;
      const an = readName('attribute');
      if (names.has(an)) fail(`Duplicate attribute '${an}' in <${name}>`, aPos);
      names.add(an);
      skipWs();
      if (text[i] !== '=') fail(`Attribute '${an}' must have a value (e.g. ${an}="…")`);
      i++; skipWs();
      const qc = text[i];
      if (qc !== '"' && qc !== "'") fail(`Attribute value for '${an}' must be quoted`);
      const end = text.indexOf(qc, i + 1);
      if (end < 0) fail(`Unterminated attribute value for '${an}'`);
      const val = text.slice(i + 1, end);
      if (val.includes('<')) fail(`'<' is not allowed in attribute values — use &lt;`, i + 1 + val.indexOf('<'));
      checkText(val, i + 1);
      attrs.push([an, val, qc]);
      i = end + 1;
    }
  }
  if (stack.length) { const open = stack[stack.length - 1]; fail(`Unclosed tag <${open.name}> (opened on line ${lineOf(text, open.pos)})`, n); }
  if (!rootSeen) fail(text.trim() ? 'No root element found' : 'Input is empty', n);
  return toks;
}
function lineOf(text, pos) { let l = 1; for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) l++; return l; }

export function validateXml(text) {
  try { const toks = tokenize(text); return { ok: true, elements: toks.filter((t) => t.t === 'open' || t.t === 'self').length }; } catch (e) {
    if (e instanceof XmlError) return { ok: false, error: { message: e.reason, line: e.line, col: e.col, pos: e.pos, full: e.message } };
    throw e;
  }
}

const tagStr = (t, close) => '<' + t.name + t.attrs.map(([k, v, q]) => ` ${k}=${q}${v}${q}`).join('') + (close ? '/>' : '>');

/** formatXml(text, {indent: 2|4|'\t'}) — pretty print. Whitespace-only text is dropped; text is trimmed. */
export function formatXml(text, opts = {}) {
  const toks = tokenize(text);
  const unit = opts.indent === '\t' || opts.indent === 'tab' ? '\t' : ' '.repeat(opts.indent == null ? 2 : Number(opts.indent));
  const out = [];
  let depth = 0;
  const pad = () => unit.repeat(depth);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    switch (t.t) {
      case 'text': {
        const s = t.v.trim();
        if (s) out.push(pad() + s.replace(/\s*\n\s*/g, '\n' + pad()));
        break;
      }
      case 'open': {
        // <a>text</a> stays on one line
        const nx = toks[k + 1], nx2 = toks[k + 2];
        if (nx && nx2 && (nx.t === 'text' || nx.t === 'cdata') && nx2.t === 'close' && !nx.v.includes('\n')) {
          out.push(pad() + tagStr(t) + (nx.t === 'text' ? nx.v.trim() : nx.v) + `</${t.name}>`);
          k += 2; break;
        }
        if (nx && nx.t === 'close') { out.push(pad() + tagStr(t) + `</${t.name}>`); k += 1; break; }
        if (nx && nx.t === 'text' && !nx.v.trim() && nx2 && nx2.t === 'close') { out.push(pad() + tagStr(t) + `</${t.name}>`); k += 2; break; }
        out.push(pad() + tagStr(t));
        depth++;
        break;
      }
      case 'close': depth--; out.push(pad() + `</${t.name}>`); break;
      case 'self': out.push(pad() + tagStr(t, true)); break;
      default: out.push(pad() + t.v.trim());
    }
  }
  return out.join('\n');
}

/** minifyXml(text, {removeComments=false}) — removes whitespace between tags. */
export function minifyXml(text, opts = {}) {
  const toks = tokenize(text);
  let out = '';
  for (const t of toks) {
    if (t.t === 'text') { if (t.v.trim()) out += t.v.trim().replace(/\s+/g, ' '); }
    else if (t.t === 'comment') { if (!opts.removeComments) out += t.v; }
    else if (t.t === 'open') out += tagStr(t);
    else if (t.t === 'self') out += tagStr(t, true);
    else if (t.t === 'close') out += `</${t.name}>`;
    else out += t.v;
  }
  return out;
}

/** Heuristic: does this text look like XML (used by the response formatter / workbench)? */
export const looksLikeXml = (s) => /^\s*(<\?xml|<!DOCTYPE|<!--|<[A-Za-z_])/.test(s);
