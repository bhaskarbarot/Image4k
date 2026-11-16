/* Regex engine wrapper — pure. Runs inside a worker (workers/regex.worker.js) so that catastrophic
 * backtracking can be stopped by terminating the worker; the page never freezes. */

export const ALL_FLAGS = ['g', 'i', 'm', 's', 'u', 'v', 'y', 'd'];
export function supportedFlags() {
  return ALL_FLAGS.filter((f) => { try { new RegExp('', f); return true; } catch (e) { return false; } });
}
export const FLAG_INFO = {
  g: 'global — find all matches', i: 'ignore case', m: 'multiline — ^ and $ match at line breaks', s: 'dotAll — . matches line breaks',
  u: 'unicode — code points, \\u{…} and \\p{…}', v: 'unicodeSets — set operations in [ ] (supersedes u)', y: 'sticky — match only at lastIndex', d: 'indices — report start/end of every group',
};

/** Validate a pattern/flags; returns null or an error message. */
export function checkPattern(pattern, flags) {
  if ([...flags].some((f, i) => flags.indexOf(f) !== i)) return 'Each flag can only be used once.';
  if (flags.includes('u') && flags.includes('v')) return 'Flags "u" and "v" cannot be combined — "v" already includes Unicode mode.';
  try { new RegExp(pattern, flags); return null; } catch (e) { return e.message.replace(/^Invalid regular expression: /, ''); }
}

/**
 * runRegex({pattern, flags, text, replace, limit}) → {
 *   matches: [{ index, end, text, groups: [string|undefined], named: {name: string|undefined} | null, indices }],
 *   truncated, total, replaced (if replace given), error }
 */
export function runRegex({ pattern, flags = '', text = '', replace = null, limit = 10000 }) {
  const err = checkPattern(pattern, flags);
  if (err) return { error: err, matches: [] };
  const re = new RegExp(pattern, flags);
  const matches = [];
  let truncated = false;
  const unicode = flags.includes('u') || flags.includes('v');
  const pushMatch = (m) => {
    matches.push({
      index: m.index, end: m.index + m[0].length, text: m[0],
      groups: m.slice(1),
      named: m.groups ? { ...m.groups } : null,
      indices: m.indices ? Array.from(m.indices, (p) => (p ? [p[0], p[1]] : null)) : null,
      namedIndices: m.indices && m.indices.groups ? Object.fromEntries(Object.entries(m.indices.groups).map(([k, v]) => [k, v ? [v[0], v[1]] : null])) : null,
    });
  };
  if (flags.includes('g') || flags.includes('y')) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (matches.length >= limit) { truncated = true; break; }
      pushMatch(m);
      if (m[0].length === 0) {
        // avoid an infinite loop on empty matches (advance one code point in unicode mode)
        const cp = unicode ? text.codePointAt(re.lastIndex) : 0;
        re.lastIndex += unicode && cp > 0xffff ? 2 : 1;
      }
      if (!flags.includes('g')) break; // sticky without g: one match
    }
  } else {
    const m = re.exec(text);
    if (m) pushMatch(m);
  }
  const out = { matches, truncated, total: matches.length };
  if (replace != null) {
    out.replaced = text.replace(new RegExp(pattern, flags), replace);
  }
  return out;
}

export const PRESETS = [
  { name: 'Email address', pattern: String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`, flags: 'g' },
  { name: 'URL (http/https)', pattern: String.raw`https?:\/\/[^\s/$.?#][^\s]*`, flags: 'gi' },
  { name: 'IPv4 address', pattern: String.raw`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b`, flags: 'g' },
  { name: 'Date YYYY-MM-DD', pattern: String.raw`(?<year>\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\d|3[01])`, flags: 'g' },
  { name: 'Time HH:MM(:SS)', pattern: String.raw`\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b`, flags: 'g' },
  { name: 'Hex colour', pattern: String.raw`#(?:[0-9a-fA-F]{3}){1,2}\b`, flags: 'g' },
  { name: 'UUID', pattern: String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b`, flags: 'gi' },
  { name: 'Phone (international)', pattern: String.raw`\+?\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}`, flags: 'g' },
  { name: 'Slug', pattern: String.raw`^[a-z0-9]+(?:-[a-z0-9]+)*$`, flags: 'gm' },
  { name: 'Strong password (8+, upper, lower, digit, symbol)', pattern: String.raw`^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{8,}$`, flags: 'gm' },
  { name: 'HTML tag', pattern: String.raw`<\/?([a-z][a-z0-9-]*)\b[^>]*>`, flags: 'gi' },
  { name: 'Duplicate words', pattern: String.raw`\b(\w+)\s+\1\b`, flags: 'gi' },
];

export const CHEATSHEET = [
  ['.', 'any character except line breaks (with s: any)'], ['\\d \\w \\s', 'digit · word char · whitespace (upper-case = NOT)'],
  ['[abc] [^abc] [a-z]', 'character set · negated set · range'], ['^ $', 'start · end (of line with m)'], ['\\b', 'word boundary'],
  ['a* a+ a?', '0 or more · 1 or more · 0 or 1'], ['a{3} a{2,} a{2,5}', 'exactly · at least · between'], ['a*? a+?', 'lazy (as few as possible)'],
  ['(abc)', 'capture group → $1'], ['(?<name>abc)', 'named group → $<name>'], ['(?:abc)', 'non-capturing group'], ['a|b', 'alternation'],
  ['(?=a) (?!a)', 'lookahead · negative lookahead'], ['(?<=a) (?<!a)', 'lookbehind · negative lookbehind'], ['\\1 \\k<name>', 'back-reference'],
  ['\\p{L} \\p{Emoji}', 'Unicode property (needs u or v)'],
];
