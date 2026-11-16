/* SQL minifier — a tokenizer that never changes the meaning of the query:
 *  - string literals ('…' with '' escapes, E'…', N'…'), quoted identifiers ("…", `…`, […]) and
 *    PostgreSQL dollar-quoted bodies ($tag$…$tag$) are copied byte-for-byte;
 *  - comments are removed, except optimizer hints (/*+ … *\/) and MySQL executable comments (/*! … *\/);
 *    with keepComments, `-- line` comments are converted to /* block *\/ comments so they survive on one line;
 *  - whitespace runs collapse to one space, and spaces next to ( ) , ; are dropped;
 *  - never joins two tokens in a way that creates a comment (e.g. "a - -1" stays "a - -1").
 * Dialect affects only '#' comments (mysql/mariadb) and backslash escapes in strings (mysql/mariadb). */

export class SqlError extends Error {
  constructor(message, line) { super(`${message} (line ${line})`); this.name = 'SqlError'; this.reason = message; this.line = line; }
}

export function tokenizeSql(sql, dialect = 'sql') {
  const mysql = dialect === 'mysql' || dialect === 'mariadb' || dialect === 'tidb' || dialect === 'singlestoredb';
  const toks = [];
  let i = 0;
  const n = sql.length;
  const lineAt = (p) => sql.slice(0, p).split('\n').length;
  const push = (t, v) => toks.push({ t, v });
  while (i < n) {
    const c = sql[i], c2 = sql[i + 1];
    if (/\s/.test(c)) { let j = i + 1; while (j < n && /\s/.test(sql[j])) j++; push('ws', sql.slice(i, j)); i = j; continue; }
    if ((c === '-' && c2 === '-') || (c === '#' && mysql)) {
      let j = sql.indexOf('\n', i); if (j < 0) j = n;
      push('line', sql.slice(i + (c === '#' ? 1 : 2), j)); i = j; continue;
    }
    if (c === '/' && c2 === '*') {
      const j = sql.indexOf('*/', i + 2);
      if (j < 0) throw new SqlError('Unterminated /* comment', lineAt(i));
      const body = sql.slice(i, j + 2);
      push(/^\/\*[+!]/.test(body) ? 'hint' : 'block', body); i = j + 2; continue;
    }
    if (c === "'" || ((c === 'E' || c === 'e' || c === 'N' || c === 'n' || c === 'B' || c === 'b' || c === 'X' || c === 'x') && c2 === "'")) {
      const start = i;
      const backslash = mysql || ((c === 'E' || c === 'e') && c2 === "'");
      i += c === "'" ? 1 : 2;
      for (;;) {
        if (i >= n) throw new SqlError('Unterminated string literal', lineAt(start));
        if (backslash && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      push('str', sql.slice(start, i)); continue;
    }
    if (c === '"' || c === '`') {
      const start = i; i++;
      for (;;) {
        if (i >= n) throw new SqlError(`Unterminated quoted identifier ${c}`, lineAt(start));
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } i++; break; }
        i++;
      }
      push('str', sql.slice(start, i)); continue;
    }
    if (c === '[' && (dialect === 'transactsql' || dialect === 'tsql' || dialect === 'sql')) {
      const j = sql.indexOf(']', i);
      if (j < 0) throw new SqlError('Unterminated [identifier]', lineAt(i));
      push('str', sql.slice(i, j + 1)); i = j + 1; continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const j = sql.indexOf(tag, i + tag.length);
        if (j < 0) throw new SqlError(`Unterminated dollar-quoted string ${tag}`, lineAt(i));
        push('str', sql.slice(i, j + tag.length)); i = j + tag.length; continue;
      }
    }
    if (/[A-Za-z0-9_@$#\u0080-￿]/.test(c)) { let j = i + 1; while (j < n && /[A-Za-z0-9_@$#.\u0080-￿]/.test(sql[j])) j++; push('word', sql.slice(i, j)); i = j; continue; }
    push('op', c); i++;
  }
  return toks;
}

const TIGHT = new Set(['(', ')', ',', ';']);

export function minifySql(sql, { dialect = 'sql', keepComments = false } = {}) {
  const toks = tokenizeSql(sql, dialect);
  const parts = [];
  let pendingSpace = false;
  const lastChar = () => { const p = parts[parts.length - 1]; return p ? p[p.length - 1] : ''; };
  for (const t of toks) {
    if (t.t === 'ws') { pendingSpace = true; continue; }
    let v;
    if (t.t === 'line') { if (!keepComments) { pendingSpace = true; continue; } v = '/*' + t.v.replace(/\*\//g, '* /') + ' */'; }
    else if (t.t === 'block') { if (!keepComments) { pendingSpace = true; continue; } v = t.v; }
    else v = t.v;
    if (parts.length && pendingSpace) {
      const prev = lastChar(), next = v[0];
      const tight = (TIGHT.has(prev) && prev !== ')') || TIGHT.has(next) && next !== '(';
      // keep a separating space unless both sides are punctuation that cannot merge into a new token
      const danger = (prev === '-' && next === '-') || (prev === '/' && next === '*') || (prev === '*' && next === '/');
      if (danger || !tight) parts.push(' ');
    } else if (parts.length) {
      const prev = lastChar(), next = v[0];
      if ((prev === '-' && next === '-') || (prev === '/' && next === '*')) parts.push(' ');
    }
    parts.push(v);
    pendingSpace = false;
  }
  return parts.join('').trim();
}
