/* Text diff built on jsdiff 8.0.4 (BSD-3-Clause, self-hosted). Pure functions — usable in a worker and in node.
 * computeDiff(a, b, {ignoreWhitespace, ignoreCase}) → { rows, stats }
 *   rows: side-by-side rows { t:'same'|'add'|'del'|'mod', l?:{n,text,parts?}, r?:{n,text,parts?} }
 *   parts (for 'mod' rows): [{v, add?, del?}] word-level changes per side. */
import { diffArrays, diffWordsWithSpace, createTwoFilesPatch } from '../../vendor/diff-8.0.4/index.js';

export function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '' ) lines.pop(); // trailing newline is not an extra line
  return lines;
}

function normalizer({ ignoreWhitespace, ignoreCase }) {
  return (s) => {
    let v = s;
    if (ignoreWhitespace) v = v.replace(/\s+/g, ' ').trim();
    if (ignoreCase) v = v.toLowerCase();
    return v;
  };
}

export function wordParts(oldLine, newLine, opts = {}) {
  const changes = diffWordsWithSpace(oldLine, newLine, { ignoreCase: !!opts.ignoreCase });
  const left = [], right = [];
  // jsdiff returns the *new* text for unchanged runs; rebuild each side from its own source text
  let li = 0, ri = 0;
  for (const c of changes) {
    if (c.added) { right.push({ v: newLine.slice(ri, ri + c.value.length), add: true }); ri += c.value.length; }
    else if (c.removed) { left.push({ v: oldLine.slice(li, li + c.value.length), del: true }); li += c.value.length; }
    else { left.push({ v: oldLine.slice(li, li + c.value.length) }); right.push({ v: newLine.slice(ri, ri + c.value.length) }); li += c.value.length; ri += c.value.length; }
  }
  return { left, right };
}

export function computeDiff(a, b, opts = {}) {
  const A = splitLines(a), B = splitLines(b);
  const norm = normalizer(opts);
  const NA = A.map(norm), NB = B.map(norm);
  const chunks = diffArrays(NA, NB);
  const rows = [];
  const stats = { added: 0, removed: 0, modified: 0, same: 0, linesA: A.length, linesB: B.length };
  let i = 0, j = 0;
  for (let c = 0; c < chunks.length; c++) {
    const ch = chunks[c];
    const count = ch.count ?? ch.value.length;
    if (!ch.added && !ch.removed) {
      for (let k = 0; k < count; k++) { rows.push({ t: 'same', l: { n: i + 1, text: A[i] }, r: { n: j + 1, text: B[j] } }); i++; j++; }
      stats.same += count;
      continue;
    }
    if (ch.removed) {
      const next = chunks[c + 1];
      const addCount = next && next.added ? (next.count ?? next.value.length) : 0;
      const pairs = Math.min(count, addCount);
      for (let k = 0; k < pairs; k++) {
        const wp = wordParts(A[i], B[j], opts);
        rows.push({ t: 'mod', l: { n: i + 1, text: A[i], parts: wp.left }, r: { n: j + 1, text: B[j], parts: wp.right } });
        i++; j++;
      }
      stats.modified += pairs;
      for (let k = pairs; k < count; k++) { rows.push({ t: 'del', l: { n: i + 1, text: A[i] } }); i++; stats.removed++; }
      for (let k = pairs; k < addCount; k++) { rows.push({ t: 'add', r: { n: j + 1, text: B[j] } }); j++; stats.added++; }
      if (addCount) c++;
      continue;
    }
    for (let k = 0; k < count; k++) { rows.push({ t: 'add', r: { n: j + 1, text: B[j] } }); j++; stats.added++; }
  }
  stats.identical = stats.added === 0 && stats.removed === 0 && stats.modified === 0;
  return { rows, stats };
}

/** Unified-view lines derived from side-by-side rows. */
export function toUnified(rows) {
  const out = [];
  const pendingAdd = [];
  for (const r of rows) {
    if (r.t === 'same') { out.push(...pendingAdd.splice(0)); out.push({ t: ' ', o: r.l.n, n: r.r.n, text: r.l.text }); }
    else if (r.t === 'del') out.push({ t: '-', o: r.l.n, text: r.l.text });
    else if (r.t === 'add') out.push({ t: '+', n: r.r.n, text: r.r.text });
    else { out.push({ t: '-', o: r.l.n, text: r.l.text, parts: r.l.parts }); pendingAdd.push({ t: '+', n: r.r.n, text: r.r.text, parts: r.r.parts }); }
  }
  out.push(...pendingAdd);
  return out;
}

/** Standard unified patch (git/diff -u compatible). */
export function unifiedPatch(a, b, nameA = 'original.txt', nameB = 'changed.txt', context = 3) {
  return createTwoFilesPatch(nameA, nameB, a, b, '', '', { context });
}
