/* cURL ⇄ request model ⇄ code. Pure functions (no DOM) — used by the cURL → Code tool, the cURL generator
 * and unit tests.
 *
 *   tokenize(cmd, dialect)  shell words for bash/zsh, PowerShell or Windows CMD
 *   parseCurl(cmd, opts)    → request model { method, url, headers[[k,v]], body, auth, options, warnings[], info[] }
 *   generate(req, lang)     → { code, notes[] } for fetch | axios | python | php-curl | php-guzzle | go | java | ruby
 *   toCurl(req, {shell})    → curl command for bash | powershell | cmd
 *
 * Nothing is silently dropped: every option that cannot be represented ends up in `warnings`
 * (behaviour lost) or `info` (cosmetic flags with no effect in code). */
import { minifyJson, hasUnsafeNumbers } from './json.js';

export class CurlError extends Error { constructor(m) { super(m); this.name = 'CurlError'; } }

/* =====================================================================================
 * 1. Tokenizer
 * ===================================================================================== */

/** Guess the shell from continuation characters / quoting style. */
export function detectDialect(cmd) {
  if (/`\r?\n/.test(cmd) || /^\s*curl\.exe\b/i.test(cmd) && /'/.test(cmd) && !/\\\r?\n/.test(cmd)) return 'powershell';
  if (/\^\r?\n/.test(cmd)) return 'cmd';
  return 'bash';
}

/**
 * tokenize(cmd, dialect='auto') → [{v:string} | {op:string}]
 * Operators (|, ;, &&, ||, >, <) end the curl command; the parser warns about anything after them.
 */
export function tokenize(cmd, dialect = 'auto') {
  const d = dialect === 'auto' ? detectDialect(cmd) : dialect;
  const out = [];
  const vars = new Set();
  let i = 0, cur = '', has = false;
  const n = cmd.length;
  const push = () => { if (has) out.push({ v: cur }); cur = ''; has = false; };
  const isNl = (c) => c === '\n' || c === '\r';
  const skipNl = () => { if (cmd[i] === '\r' && cmd[i + 1] === '\n') i += 2; else i++; };
  const noteVar = (s) => { const m = /^\$(\{[A-Za-z_][\w]*\}|[A-Za-z_][\w]*)/.exec(s); if (m) vars.add(m[0]); };

  while (i < n) {
    const c = cmd[i];
    // ---------- continuations ----------
    if (d !== 'cmd' && d !== 'powershell' && c === '\\' && isNl(cmd[i + 1])) { i++; skipNl(); continue; }
    if (d === 'cmd' && c === '^' && (isNl(cmd[i + 1]) || /^\^[ \t]+\r?\n/.test(cmd.slice(i, i + 40)))) { i++; while (cmd[i] === ' ' || cmd[i] === '\t') i++; skipNl(); continue; }
    if (d === 'powershell' && c === '`' && (isNl(cmd[i + 1]) || /^`[ \t]+\r?\n/.test(cmd.slice(i, i + 40)))) { i++; while (cmd[i] === ' ' || cmd[i] === '\t') i++; skipNl(); continue; }
    // ---------- whitespace ----------
    if (c === ' ' || c === '\t' || isNl(c)) { push(); i++; continue; }
    // ---------- comments (bash / PowerShell) ----------
    if (c === '#' && !has && d !== 'cmd') { while (i < n && !isNl(cmd[i])) i++; continue; }
    // ---------- operators ----------
    {
      // | ; && || & chain commands and < > redirect (in all three shells) — the curl command ends here
      const op = /^(\|\||&&|\||;|>>|>|<|&)/.exec(cmd.slice(i, i + 2));
      if (op) { push(); out.push({ op: op[0] }); i += op[0].length; continue; }
    }
    // ---------- quoting ----------
    if (d === 'bash') {
      if (c === "'") {
        const end = cmd.indexOf("'", i + 1);
        if (end < 0) throw new CurlError("Unterminated single quote (') in the command");
        cur += cmd.slice(i + 1, end); has = true; i = end + 1; continue;
      }
      if (c === '$' && cmd[i + 1] === "'") { // ANSI-C quoting $'...'
        i += 2; has = true;
        for (;;) {
          if (i >= n) throw new CurlError("Unterminated $'…' string in the command");
          const ch = cmd[i];
          if (ch === "'") { i++; break; }
          if (ch === '\\') {
            const e = cmd[i + 1];
            const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
            if (e in simple) { cur += simple[e]; i += 2; continue; }
            let m;
            if ((m = /^x([0-9a-fA-F]{1,2})/.exec(cmd.slice(i + 1, i + 4)))) { cur += String.fromCharCode(parseInt(m[1], 16)); i += 1 + m[0].length; continue; }
            if ((m = /^u([0-9a-fA-F]{1,4})/.exec(cmd.slice(i + 1, i + 6)))) { cur += String.fromCodePoint(parseInt(m[1], 16)); i += 1 + m[0].length; continue; }
            if ((m = /^U([0-9a-fA-F]{1,8})/.exec(cmd.slice(i + 1, i + 10)))) { cur += String.fromCodePoint(parseInt(m[1], 16)); i += 1 + m[0].length; continue; }
            if ((m = /^[0-7]{1,3}/.exec(cmd.slice(i + 1, i + 4)))) { cur += String.fromCharCode(parseInt(m[0], 8)); i += 1 + m[0].length; continue; }
            cur += '\\' + (e ?? ''); i += 2; continue;
          }
          cur += ch; i++;
        }
        continue;
      }
      if (c === '"') {
        i++; has = true;
        for (;;) {
          if (i >= n) throw new CurlError('Unterminated double quote (") in the command');
          const ch = cmd[i];
          if (ch === '"') { i++; break; }
          if (ch === '\\') {
            const e = cmd[i + 1];
            if (e === '"' || e === '\\' || e === '$' || e === '`') { cur += e; i += 2; continue; }
            if (isNl(e)) { i++; skipNl(); continue; }
            cur += ch; i++; continue;
          }
          if (ch === '$') noteVar(cmd.slice(i, i + 40));
          cur += ch; i++;
        }
        continue;
      }
      if (c === '\\') { if (i + 1 < n) { cur += cmd[i + 1]; has = true; } i += 2; continue; }
      if (c === '$') noteVar(cmd.slice(i, i + 40));
      cur += c; has = true; i++; continue;
    }
    if (d === 'powershell') {
      if (c === "'") {
        i++; has = true;
        for (;;) {
          if (i >= n) throw new CurlError("Unterminated single quote (') in the command");
          if (cmd[i] === "'") { if (cmd[i + 1] === "'") { cur += "'"; i += 2; continue; } i++; break; }
          cur += cmd[i++];
        }
        continue;
      }
      if (c === '"') {
        i++; has = true;
        for (;;) {
          if (i >= n) throw new CurlError('Unterminated double quote (") in the command');
          const ch = cmd[i];
          if (ch === '"') { if (cmd[i + 1] === '"') { cur += '"'; i += 2; continue; } i++; break; }
          if (ch === '`') {
            const e = cmd[i + 1];
            const map = { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v', '`': '`', '"': '"', $: '$' };
            cur += e in map ? map[e] : e ?? ''; i += 2; continue;
          }
          if (ch === '$') noteVar(cmd.slice(i, i + 40));
          cur += ch; i++;
        }
        continue;
      }
      if (c === '`') { if (i + 1 < n) { cur += cmd[i + 1]; has = true; } i += 2; continue; }
      if (c === '$') noteVar(cmd.slice(i, i + 40));
      cur += c; has = true; i++; continue;
    }
    // cmd — Windows argv rules (MSVCRT): 2n backslashes + " → n backslashes + quote toggle; 2n+1 → n backslashes + literal "
    if (c === '\\') {
      let j = i; while (cmd[j] === '\\') j++;
      const nbs = j - i;
      if (cmd[j] === '"') { cur += '\\'.repeat(nbs >> 1); has = true; if (nbs % 2) { cur += '"'; i = j + 1; } else i = j; continue; }
      cur += '\\'.repeat(nbs); has = true; i = j; continue;
    }
    if (c === '"') {
      i++; has = true;
      for (;;) {
        if (i >= n) throw new CurlError('Unterminated double quote (") in the command');
        const ch = cmd[i];
        if (ch === '\\') {
          let j = i; while (cmd[j] === '\\') j++;
          const nbs = j - i;
          if (cmd[j] === '"') { cur += '\\'.repeat(nbs >> 1); if (nbs % 2) { cur += '"'; i = j + 1; continue; } i = j; continue; }
          cur += '\\'.repeat(nbs); i = j; continue;
        }
        if (ch === '"') { if (cmd[i + 1] === '"') { cur += '"'; i += 2; continue; } i++; break; }
        if (ch === '%') { const m = /^%[A-Za-z_]\w*%/.exec(cmd.slice(i, i + 40)); if (m) vars.add(m[0]); }
        cur += ch; i++;
      }
      continue;
    }
    if (c === '^') { if (i + 1 < n) { cur += cmd[i + 1]; has = true; } i += 2; continue; }
    if (c === '%') { const m = /^%[A-Za-z_]\w*%/.exec(cmd.slice(i, i + 40)); if (m) vars.add(m[0]); }
    cur += c; has = true; i++;
  }
  push();
  out.dialect = d;
  out.vars = [...vars];
  return out;
}

/* =====================================================================================
 * 2. Parser
 * ===================================================================================== */

const SHORT = {
  X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', A: 'user-agent', e: 'referer', b: 'cookie',
  G: 'get', I: 'head', L: 'location', k: 'insecure', m: 'max-time', x: 'proxy', o: 'output', O: 'remote-name',
  s: 'silent', S: 'show-error', v: 'verbose', i: 'include', f: 'fail', T: 'upload-file', E: 'cert', c: 'cookie-jar',
  D: 'dump-header', w: 'write-out', K: 'config', r: 'range', z: 'time-cond', 0: 'http1.0', 1: 'tlsv1', 2: 'sslv2', 3: 'sslv3',
  4: 'ipv4', 6: 'ipv6', N: 'no-buffer', n: 'netrc', q: 'disable', R: 'remote-time', C: 'continue-at', Y: 'speed-limit',
  y: 'speed-time', P: 'ftp-port', Q: 'quote', B: 'use-ascii', g: 'globoff', j: 'junk-session-cookies', J: 'remote-header-name',
  M: 'manual', h: 'help', V: 'version', '#': 'progress-bar', a: 'append', l: 'list-only', p: 'proxytunnel', U: 'proxy-user', t: 'telnet-option',
};
// long options that take a value
const WITH_VALUE = new Set([
  'request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'form', 'form-string', 'user',
  'oauth2-bearer', 'user-agent', 'referer', 'cookie', 'max-time', 'connect-timeout', 'proxy', 'output', 'url', 'url-query', 'upload-file',
  'cert', 'key', 'cacert', 'capath', 'cookie-jar', 'dump-header', 'write-out', 'config', 'range', 'resolve', 'connect-to', 'interface',
  'retry', 'retry-delay', 'retry-max-time', 'limit-rate', 'max-redirs', 'proxy-user', 'aws-sigv4', 'cert-type', 'key-type', 'pass',
  'ciphers', 'dns-servers', 'keepalive-time', 'local-port', 'max-filesize', 'netrc-file', 'noproxy', 'preproxy', 'proto', 'proto-redir',
  'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'tls-max', 'unix-socket', 'abstract-unix-socket', 'variable', 'time-cond', 'trace',
  'trace-ascii', 'stderr', 'speed-limit', 'speed-time', 'continue-at', 'ftp-port', 'quote', 'telnet-option', 'expect100-timeout',
  'happy-eyeballs-timeout-ms', 'output-dir', 'proxy-header', 'request-target', 'login-options', 'mail-from', 'mail-rcpt', 'pinnedpubkey',
  'proxy-cacert', 'proxy-cert', 'proxy-key', 'random-file', 'egd-file', 'hostpubmd5', 'hostpubsha256', 'pubkey', 'krb', 'delegation',
  'parallel-max', 'rate', 'etag-save', 'etag-compare', 'header-file', 'ech', 'ip-tos', 'vlan-priority', 'mptcp', 'json-file',
]);
const BOOLEAN = new Set([
  'get', 'head', 'location', 'location-trusted', 'insecure', 'compressed', 'silent', 'show-error', 'verbose', 'include', 'fail', 'fail-with-body',
  'fail-early', 'http1.0', 'http1.1', 'http2', 'http2-prior-knowledge', 'http3', 'http3-only', 'http0.9', 'globoff', 'no-buffer', 'progress-bar',
  'remote-name', 'remote-name-all', 'remote-header-name', 'ipv4', 'ipv6', 'tlsv1', 'tlsv1.0', 'tlsv1.1', 'tlsv1.2', 'tlsv1.3', 'sslv2', 'sslv3',
  'digest', 'ntlm', 'ntlm-wb', 'negotiate', 'basic', 'anyauth', 'no-keepalive', 'tcp-nodelay', 'tcp-fastopen', 'raw', 'path-as-is', 'create-dirs',
  'no-progress-meter', 'disable', 'styled-output', 'no-styled-output', 'netrc', 'netrc-optional', 'remote-time', 'use-ascii', 'junk-session-cookies',
  'manual', 'help', 'version', 'append', 'list-only', 'proxytunnel', 'ssl', 'ssl-reqd', 'ssl-no-revoke', 'compressed-ssh', 'post301', 'post302',
  'post303', 'retry-connrefused', 'retry-all-errors', 'no-alpn', 'no-npn', 'no-sessionid', 'parallel', 'parallel-immediate', 'xattr', 'suppress-connect-headers',
  'proxy-insecure', 'doh-insecure', 'false-start', 'cert-status', 'ignore-content-length', 'no-clobber', 'remove-on-error', 'skip-existing', 'show-headers',
]);
// flags that only change curl's own console output — no effect on the HTTP request
const COSMETIC = new Set(['silent', 'show-error', 'verbose', 'no-progress-meter', 'progress-bar', 'styled-output', 'no-styled-output', 'no-buffer', 'globoff', 'trace', 'trace-ascii', 'stderr', 'include', 'show-headers', 'disable', 'help', 'manual', 'version', 'write-out', 'create-dirs']);

const hget = (headers, name) => { const k = name.toLowerCase(); const h = headers.find(([n]) => n.toLowerCase() === k); return h ? h[1] : undefined; };
const hdel = (headers, name) => { const k = name.toLowerCase(); for (let i = headers.length - 1; i >= 0; i--) if (headers[i][0].toLowerCase() === k) headers.splice(i, 1); };
export const getHeader = hget;

/** Percent-encode like curl --data-urlencode (application/x-www-form-urlencoded, space → %20 is also fine but curl uses %20). */
const formEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * parseCurl(command, { dialect='auto' }) → request model.
 */
export function parseCurl(command, opts = {}) {
  const src = String(command || '').trim();
  if (!src) throw new CurlError('Paste a cURL command first.');
  const toks = tokenize(src, opts.dialect || 'auto');
  const warnings = [], info = [];
  const words = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].op) {
      const rest = toks.slice(k + 1).map((t) => t.v ?? t.op).join(' ');
      warnings.push(`Ignored everything after '${toks[k].op}'${rest ? ` (${rest.length > 60 ? rest.slice(0, 60) + '…' : rest})` : ''} — only the curl command itself is converted.`);
      break;
    }
    words.push(toks[k].v);
  }
  // strip a leading shell prompt "$ " / "PS> "
  while (words.length && /^(\$|>|PS>|%)$/.test(words[0])) words.shift();
  if (!words.length || !/(^|[\\/])curl(\.exe)?$/i.test(words[0])) throw new CurlError('The command must start with "curl".');
  if (toks.vars.length) warnings.push(`Shell variable${toks.vars.length > 1 ? 's' : ''} ${toks.vars.join(', ')} ${toks.vars.length > 1 ? 'were' : 'was'} kept literally — replace with real values in your code.`);

  const req = {
    method: null, url: null, headers: [], body: null, auth: null,
    options: { followRedirects: false, insecure: false, compressed: false, timeout: null, connectTimeout: null, proxy: null, maxRedirects: null, fail: false, httpVersion: null },
    warnings, info, dialect: toks.dialect,
  };
  const urls = [];
  const dataParts = []; // { text } already in final wire form
  const formParts = []; // { name, value } | { name, file, filename, contentType }
  let getMode = false, head = false, jsonFlag = false, explicitMethod = null, globoff = false;
  const urlQuery = [];
  const cookies = [];

  const words2 = words.slice(1);
  let k = 0;
  const take = (name) => {
    if (k >= words2.length) throw new CurlError(`Option ${name} needs a value.`);
    return words2[k++];
  };

  const apply = (name, value, flagText) => {
    switch (name) {
      case 'url': urls.push(value); break;
      case 'request': explicitMethod = value; break;
      case 'header': {
        if (value.startsWith('@')) { warnings.push(`${flagText} ${value}: headers read from a file are not included — add them manually.`); break; }
        const semi = /^([^:;\s]+)\s*;\s*$/.exec(value);
        if (semi) { req.headers.push([semi[1], '']); break; }
        const idx = value.indexOf(':');
        if (idx < 0) { warnings.push(`Header "${value}" has no ':' and was ignored.`); break; }
        const hn = value.slice(0, idx).trim(), hv = value.slice(idx + 1).trim();
        if (!hv) { info.push(`"${hn}:" with no value removes curl's default ${hn} header — nothing to send.`); hdel(req.headers, hn); break; }
        req.headers.push([hn, hv]);
        break;
      }
      case 'data': case 'data-ascii': case 'data-binary': case 'json': {
        if (name === 'json') jsonFlag = true;
        if (value.startsWith('@')) {
          const file = value.slice(1) || 'file';
          warnings.push(`${flagText} @${file}: the request body is read from a file — the generated code uses a placeholder; load "${file}" yourself.`);
          dataParts.push({ text: `<contents of ${file}>`, file });
        } else {
          dataParts.push({ text: value });
        }
        break;
      }
      case 'data-raw': dataParts.push({ text: value }); break;
      case 'data-urlencode': {
        let m;
        if (value.startsWith('@') || /^[^=]*@/.test(value) && !value.includes('=')) {
          const at = value.indexOf('@');
          const nm = value.slice(0, at), file = value.slice(at + 1);
          warnings.push(`--data-urlencode ${value}: content is read from file "${file}" — the generated code uses a placeholder.`);
          dataParts.push({ text: (nm ? nm + '=' : '') + formEncode(`<contents of ${file}>`) });
        } else if (value.startsWith('=')) dataParts.push({ text: formEncode(value.slice(1)) });
        else if ((m = /^([^=]+)=([\s\S]*)$/.exec(value))) dataParts.push({ text: m[1] + '=' + formEncode(m[2]) });
        else dataParts.push({ text: formEncode(value) });
        break;
      }
      case 'form': case 'form-string': {
        const eq = value.indexOf('=');
        if (eq < 0) { warnings.push(`${flagText} "${value}" is not name=value and was ignored.`); break; }
        const fname = value.slice(0, eq);
        let v = value.slice(eq + 1);
        if (name === 'form' && (v.startsWith('@') || v.startsWith('<'))) {
          const isUpload = v.startsWith('@');
          const parts = v.slice(1).split(';');
          const file = parts.shift();
          const part = { name: fname, file, filename: file.split(/[\\/]/).pop(), contentType: null };
          for (const p of parts) {
            const [pk, ...pv] = p.split('='); const val = pv.join('=').replace(/^"|"$/g, '');
            if (pk.trim() === 'type') part.contentType = val;
            else if (pk.trim() === 'filename') part.filename = val;
            else if (pk.trim()) warnings.push(`Form part attribute ";${p}" is not supported and was ignored.`);
          }
          if (isUpload) { formParts.push(part); warnings.push(`File upload "${fname}=@${file}" uses a placeholder path in the generated code — point it at the real file.`); }
          else { formParts.push({ name: fname, value: `<contents of ${file}>` }); warnings.push(`"${fname}=<${file}" reads the field text from a file — replaced by a placeholder.`); }
        } else {
          if (name === 'form') { const semi = v.indexOf(';type='); if (semi >= 0) { warnings.push(`Content type "${v.slice(semi + 6)}" on text field "${fname}" was ignored.`); v = v.slice(0, semi); } }
          formParts.push({ name: fname, value: v });
        }
        break;
      }
      case 'user': {
        const idx = value.indexOf(':');
        if (idx < 0) { req.auth = { type: 'basic', user: value, pass: '' }; warnings.push('-u without a password: curl would prompt for it — an empty password is used.'); }
        else req.auth = { type: 'basic', user: value.slice(0, idx), pass: value.slice(idx + 1) };
        break;
      }
      case 'oauth2-bearer': req.headers.push(['Authorization', 'Bearer ' + value]); break;
      case 'user-agent': req.headers.push(['User-Agent', value]); break;
      case 'referer': { const v2 = value.replace(/;auto$/, ''); if (v2 !== value) info.push('--referer ";auto" (set referer on redirects) is not reproduced.'); if (v2) req.headers.push(['Referer', v2]); break; }
      case 'cookie': {
        if (value.includes('=')) cookies.push(value.trim().replace(/;\s*$/, ''));
        else warnings.push(`--cookie "${value}" reads cookies from a file — not included; add a Cookie header manually.`);
        break;
      }
      case 'range': req.headers.push(['Range', 'bytes=' + value]); break;
      case 'get': getMode = true; break;
      case 'head': head = true; break;
      case 'location': case 'location-trusted': req.options.followRedirects = true; if (name === 'location-trusted') warnings.push('--location-trusted (send credentials to other hosts on redirect) is not reproduced.'); break;
      case 'max-redirs': req.options.maxRedirects = Number(value); break;
      case 'insecure': req.options.insecure = true; break;
      case 'compressed': req.options.compressed = true; break;
      case 'max-time': req.options.timeout = Number(value); if (!Number.isFinite(req.options.timeout)) { warnings.push(`Invalid --max-time "${value}" ignored.`); req.options.timeout = null; } break;
      case 'connect-timeout': req.options.connectTimeout = Number(value); if (!Number.isFinite(req.options.connectTimeout)) { warnings.push(`Invalid --connect-timeout "${value}" ignored.`); req.options.connectTimeout = null; } break;
      case 'proxy': req.options.proxy = value; break;
      case 'fail': case 'fail-with-body': req.options.fail = true; break;
      case 'url-query': urlQuery.push(value.startsWith('+') ? value.slice(1) : value.replace(/^([^=]*)=([\s\S]*)$/, (_, a, b) => a + '=' + formEncode(b))); break;
      case 'http1.0': case 'http1.1': case 'http2': case 'http2-prior-knowledge': case 'http3': case 'http3-only': req.options.httpVersion = name.replace('-prior-knowledge', '').replace('-only', ''); info.push(`--${name}: HTTP version preference is only reproduced where the language supports it.`); break;
      case 'globoff': globoff = true; break;
      case 'output': case 'remote-name': case 'remote-name-all': case 'remote-header-name': case 'output-dir':
        warnings.push(`${flagText}${value != null ? ' ' + value : ''}: saving the response to a file is not reproduced — the generated code returns the body.`); break;
      case 'upload-file': warnings.push(`${flagText} ${value}: file upload (PUT) is not reproduced — send the file contents as the body yourself.`); if (!explicitMethod) explicitMethod = explicitMethod || 'PUT'; break;
      case 'digest': case 'ntlm': case 'ntlm-wb': case 'negotiate': case 'anyauth':
        warnings.push(`--${name} authentication is not supported by the generated code — Basic auth is used instead.`); break;
      case 'basic': break;
      default:
        if (COSMETIC.has(name)) info.push(`${flagText}${value != null ? ' ' + value : ''} only changes curl's console output — no effect in code.`);
        else warnings.push(`${flagText}${value != null ? ' ' + value : ''} is not supported by the code generator and was ignored.`);
    }
  };

  while (k < words2.length) {
    const w = words2[k++];
    if (w === '--') { while (k < words2.length) urls.push(words2[k++]); break; }
    if (w.startsWith('--') && w.length > 2) {
      let name = w.slice(2), value = null;
      const eq = name.indexOf('=');
      if (eq > 0 && WITH_VALUE.has(name.slice(0, eq))) { value = name.slice(eq + 1); name = name.slice(0, eq); }
      let negated = false;
      if (name.startsWith('no-') && BOOLEAN.has(name.slice(3))) { negated = true; name = name.slice(3); }
      if (WITH_VALUE.has(name)) { if (value == null) value = take(w); apply(name, value, '--' + name); }
      else if (BOOLEAN.has(name)) {
        if (negated) { if (name === 'location') req.options.followRedirects = false; else if (name === 'insecure') req.options.insecure = false; else if (name === 'compressed') req.options.compressed = false; else info.push(`--no-${name} ignored.`); }
        else apply(name, null, '--' + name);
      } else warnings.push(`Unknown option ${w} was ignored.`);
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      // combined short flags: -sSL, -XPOST, -H'Accept: x'
      for (let j = 1; j < w.length; j++) {
        const ch = w[j];
        const name = SHORT[ch];
        if (!name) { warnings.push(`Unknown option -${ch} was ignored.`); continue; }
        if (WITH_VALUE.has(name)) {
          const rest = w.slice(j + 1);
          const value = rest.length ? rest : take('-' + ch);
          apply(name, value, '-' + ch);
          break;
        }
        apply(name, null, '-' + ch);
      }
      continue;
    }
    urls.push(w);
  }

  // ---------- URL ----------
  if (!urls.length) throw new CurlError('No URL found in the command.');
  if (urls.length > 1) warnings.push(`Several URLs were given; only the first (${urls[0]}) is converted.`);
  let url = urls[0];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { info.push(`No scheme in "${url}" — curl assumes http://.`); url = 'http://' + url; }
  if (!globoff && /[{}[\]]/.test(url.replace(/^[a-z]+:\/\/\[[^\]]+\]/i, ''))) warnings.push('The URL contains { } or [ ] — curl would expand them as a glob pattern; they are kept literally.');
  if (!/^https?:\/\//i.test(url)) warnings.push(`Only HTTP(S) URLs are converted correctly; "${url.split(':')[0]}" may not work in the generated code.`);

  if (cookies.length) req.headers.push(['Cookie', cookies.join('; ')]);

  // ---------- body ----------
  const dataText = dataParts.map((p) => p.text).join('&');
  if (getMode && dataParts.length) {
    url += (url.includes('?') ? '&' : '?') + dataText;
  }
  if (urlQuery.length) url += (url.includes('?') ? '&' : '?') + urlQuery.join('&');
  req.url = url;

  if (formParts.length && dataParts.length && !getMode) warnings.push('Both -d and -F were given (curl refuses this) — only the -F form is used.');
  if (formParts.length) {
    const ct = hget(req.headers, 'content-type');
    if (ct && /^multipart\/form-data\s*$/i.test(ct)) { hdel(req.headers, 'content-type'); info.push('Removed "Content-Type: multipart/form-data" — the HTTP library adds it with the correct boundary.'); }
    req.body = { type: 'multipart', parts: formParts };
  } else if (dataParts.length && !getMode) {
    if (jsonFlag) {
      if (!hget(req.headers, 'content-type')) req.headers.push(['Content-Type', 'application/json']);
      if (!hget(req.headers, 'accept')) req.headers.push(['Accept', 'application/json']);
    }
    const ct = hget(req.headers, 'content-type');
    if (!ct) req.headers.push(['Content-Type', 'application/x-www-form-urlencoded']); // curl's default for -d
    req.body = makeBody(dataText, hget(req.headers, 'content-type'));
    if (dataParts.some((p) => p.file)) req.body.placeholder = true;
  }

  // ---------- method ----------
  let method = head ? 'HEAD' : req.body ? 'POST' : 'GET';
  if (explicitMethod) {
    method = explicitMethod.toUpperCase();
    if (method !== explicitMethod) info.push(`Method "${explicitMethod}" written as ${method}.`);
  }
  if (getMode && !explicitMethod) method = head ? 'HEAD' : 'GET';
  req.method = method;
  if (head && req.body) warnings.push('-I (HEAD) together with a body: HEAD requests cannot carry a body; the body is dropped.');
  if (head && req.body) req.body = null;
  return req;
}

/** Classify a body string by its content type. */
export function makeBody(text, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (/\bjson\b/.test(ct)) {
    let value, structured = false;
    try {
      value = JSON.parse(text);
      // safe to emit as a language literal only if that is lossless (no big ints, no duplicate keys, same key order)
      structured = !hasUnsafeNumbers(text) && JSON.stringify(value) === minifyJson(text);
    } catch (e) { value = undefined; }
    return { type: 'json', text, value, structured };
  }
  if (ct.startsWith('application/x-www-form-urlencoded')) {
    const fields = parseForm(text);
    return { type: 'form', text, fields };
  }
  return { type: 'raw', text };
}

/** Parse a=1&b=2 into [[k,v]] only when re-encoding gives back exactly the same string (lossless), else null. */
function parseForm(text) {
  if (!text) return null;
  try {
    const fields = text.split('&').map((p) => {
      const eq = p.indexOf('=');
      if (eq < 0) throw new Error('no =');
      return [decodeURIComponent(p.slice(0, eq).replace(/\+/g, ' ')), decodeURIComponent(p.slice(eq + 1).replace(/\+/g, ' '))];
    });
    // lossless if re-encoding (URLSearchParams style "+" or curl style "%20") gives back the exact text
    const re1 = fields.map(([a, b]) => new URLSearchParams([[a, b]]).toString()).join('&');
    const re2 = fields.map(([a, b]) => formEncode(a) + '=' + formEncode(b)).join('&');
    return re1 === text || re2 === text ? fields : null;
  } catch (e) { return null; }
}

/* =====================================================================================
 * 3. Code generators
 * ===================================================================================== */

export const LANGS = [
  { id: 'fetch', name: 'JavaScript – Fetch', ext: 'js' },
  { id: 'axios', name: 'JavaScript – Axios', ext: 'js' },
  { id: 'python', name: 'Python – Requests', ext: 'py' },
  { id: 'php-curl', name: 'PHP – cURL', ext: 'php' },
  { id: 'php-guzzle', name: 'PHP – Guzzle', ext: 'php' },
  { id: 'go', name: 'Go – net/http', ext: 'go' },
  { id: 'java', name: 'Java – HttpClient', ext: 'java' },
  { id: 'ruby', name: 'Ruby – Net::HTTP', ext: 'rb' },
];

const hex4 = (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
// ---- string literal encoders ----
export const q = {
  js: (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\u0000-\u001f\u2028\u2029]/g, hex4) + "'",
  py: (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\u0000-\u001f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + "'",
  php: (s) => {
    s = String(s);
    if (!/[\u0000-\u001f]/.test(s)) return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\u0000-\u001f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + '"';
  },
  go: (s) => JSON.stringify(String(s)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'),
  java: (s) => JSON.stringify(String(s)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'),
  rb: (s) => {
    s = String(s);
    if (!/[\u0000-\u001f]/.test(s)) return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/#/g, '\\#').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\u0000-\u001f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + '"';
  },
};

// ---- JSON value → language literal ----
function literal(v, lang, ind = 0) {
  const pad = (n) => (lang === 'js' || lang === 'rb' ? '  ' : '    ').repeat(n);
  const isArr = Array.isArray(v);
  if (v === null) return { js: 'null', py: 'None', php: 'null', rb: 'nil' }[lang];
  if (typeof v === 'boolean') return lang === 'py' ? (v ? 'True' : 'False') : String(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return q[lang](v);
  const entries = isArr ? v.map((x) => [null, x]) : Object.entries(v);
  if (!entries.length) {
    if (isArr) return '[]';
    return { js: '{}', py: '{}', php: '(object) []', rb: '{}' }[lang];
  }
  const items = entries.map(([key, val]) => {
    const lv = literal(val, lang, ind + 1);
    if (key === null) return pad(ind + 1) + lv;
    if (lang === 'js') return pad(ind + 1) + (/^[A-Za-z_$][\w$]*$/.test(key) ? key : q.js(key)) + ': ' + lv;
    if (lang === 'py') return pad(ind + 1) + q.py(key) + ': ' + lv;
    if (lang === 'php') return pad(ind + 1) + q.php(key) + ' => ' + lv;
    return pad(ind + 1) + q.rb(key) + ' => ' + lv;
  });
  const open = isArr ? '[' : lang === 'php' ? '[' : '{';
  const close = isArr ? ']' : lang === 'php' ? ']' : '}';
  return open + '\n' + items.join(',\n') + '\n' + pad(ind) + close;
}

const b64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = ''; for (const x of bytes) bin += String.fromCharCode(x);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
};
const isStructuredJson = (req) => req.body && req.body.type === 'json' && req.body.structured && req.body.value !== undefined && typeof req.body.value === 'object' && req.body.value !== null;
const sec = (t) => (Number.isInteger(t) ? String(t) : String(t));

/**
 * generate(req, lang, { matchRedirects = true }) → { code, notes[] }
 * matchRedirects: reproduce curl's behaviour of NOT following redirects unless -L was given.
 */
export function generate(req, lang, opts = {}) {
  const g = GEN[lang];
  if (!g) throw new Error('Unknown language ' + lang);
  const notes = [];
  const o = { matchRedirects: opts.matchRedirects !== false };
  const code = g(req, notes, o);
  return { code, notes };
}

const GEN = {
  /* ---------------- JavaScript fetch ---------------- */
  fetch(req, notes, o) {
    const L = [];
    const headers = req.headers.slice();
    if (req.auth) headers.push(['Authorization', 'Basic ' + b64(`${req.auth.user}:${req.auth.pass}`)]);
    const pre = [];
    let bodyExpr = null;
    const b = req.body;
    if (b) {
      if (b.type === 'multipart') {
        pre.push('const form = new FormData();');
        for (const p of b.parts) {
          if (p.file != null) {
            pre.push(`// Replace with the real file, e.g. fileInput.files[0] in a browser or await fs.openAsBlob(${q.js(p.file)}) in Node 20+`);
            pre.push(`form.append(${q.js(p.name)}, new Blob(['<contents of ${p.file.replace(/'/g, '')}>']${p.contentType ? `, { type: ${q.js(p.contentType)} }` : ''}), ${q.js(p.filename)});`);
          } else pre.push(`form.append(${q.js(p.name)}, ${q.js(p.value)});`);
        }
        bodyExpr = 'form';
      } else if (isStructuredJson(req)) bodyExpr = 'JSON.stringify(' + literal(b.value, 'js', 1) + ')';
      else if (b.type === 'form' && b.fields) bodyExpr = 'new URLSearchParams(' + literal(Object.fromEntries(b.fields), 'js', 1) + ')';
      else bodyExpr = q.js(b.text);
      if (b.type === 'form' && b.fields && new Set(b.fields.map((f) => f[0])).size !== b.fields.length) bodyExpr = q.js(b.text);
    }
    const fo = [];
    if (req.method !== 'GET') fo.push(`  method: ${q.js(req.method)},`);
    if (headers.length) fo.push('  headers: {\n' + headers.map(([k, v]) => `    ${q.js(k)}: ${q.js(v)},`).join('\n') + '\n  },');
    if (bodyExpr) fo.push(`  body: ${bodyExpr},`);
    if (!req.options.followRedirects && o.matchRedirects) fo.push(`  redirect: 'manual', // curl does not follow redirects without -L`);
    if (req.options.timeout) fo.push(`  signal: AbortSignal.timeout(${Math.round(req.options.timeout * 1000)}),`);
    if (req.options.connectTimeout) notes.push('fetch has no separate connect timeout; only --max-time is applied.');
    if (req.options.insecure) notes.push('fetch cannot skip TLS verification. In Node you can (temporarily, insecurely) set NODE_TLS_REJECT_UNAUTHORIZED=0.');
    if (req.options.proxy) notes.push('fetch has no proxy option. In Node use undici\'s ProxyAgent (dispatcher option).');
    if (req.options.compressed) notes.push('fetch decompresses gzip/deflate/br responses automatically.');
    if (req.auth) notes.push('Basic auth is sent as a pre-computed Authorization header.');
    L.push(...pre);
    if (pre.length) L.push('');
    L.push(`const response = await fetch(${q.js(req.url)}${fo.length ? ', {\n' + fo.join('\n') + '\n}' : ''});`);
    if (req.options.fail) L.push('if (!response.ok) throw new Error(`HTTP ${response.status}`);');
    L.push(req.method === 'HEAD' ? 'console.log(response.status, Object.fromEntries(response.headers));' : 'const data = await response.text();\nconsole.log(response.status, data);');
    return L.join('\n');
  },

  /* ---------------- Axios ---------------- */
  axios(req, notes, o) {
    const L = ["import axios from 'axios';"];
    const b = req.body;
    const pre = [];
    let data = null;
    if (b) {
      if (b.type === 'multipart') {
        pre.push('const form = new FormData();');
        for (const p of b.parts) {
          if (p.file != null) {
            pre.push(`// Replace with the real file (browser: fileInput.files[0]; Node 20+: await fs.openAsBlob(${q.js(p.file)}))`);
            pre.push(`form.append(${q.js(p.name)}, new Blob(['<contents of ${p.file.replace(/'/g, '')}>']${p.contentType ? `, { type: ${q.js(p.contentType)} }` : ''}), ${q.js(p.filename)});`);
          } else pre.push(`form.append(${q.js(p.name)}, ${q.js(p.value)});`);
        }
        data = 'form';
      } else if (isStructuredJson(req)) data = literal(b.value, 'js', 1);
      else if (b.type === 'form' && b.fields && new Set(b.fields.map((f) => f[0])).size === b.fields.length) data = 'new URLSearchParams(' + literal(Object.fromEntries(b.fields), 'js', 1) + ')';
      else data = q.js(b.text);
    }
    const c = [`  method: ${q.js(req.method.toLowerCase())},`, `  url: ${q.js(req.url)},`];
    if (req.headers.length) c.push('  headers: {\n' + req.headers.map(([k, v]) => `    ${q.js(k)}: ${q.js(v)},`).join('\n') + '\n  },');
    if (req.auth) c.push(`  auth: { username: ${q.js(req.auth.user)}, password: ${q.js(req.auth.pass)} },`);
    if (data) c.push(`  data: ${data},`);
    if (req.options.timeout) c.push(`  timeout: ${Math.round(req.options.timeout * 1000)},`);
    if (req.options.connectTimeout) notes.push('Axios has no separate connect timeout; only --max-time is applied.');
    if (!req.options.followRedirects && o.matchRedirects) c.push('  maxRedirects: 0, // curl does not follow redirects without -L (Node only)');
    else if (req.options.maxRedirects != null) c.push(`  maxRedirects: ${req.options.maxRedirects},`);
    if (req.options.proxy) {
      try {
        const p = new URL(/^[a-z]+:\/\//i.test(req.options.proxy) ? req.options.proxy : 'http://' + req.options.proxy);
        c.push(`  proxy: { protocol: ${q.js(p.protocol.replace(':', ''))}, host: ${q.js(p.hostname)}, port: ${p.port || (p.protocol === 'https:' ? 443 : 1080)}${p.username ? `, auth: { username: ${q.js(decodeURIComponent(p.username))}, password: ${q.js(decodeURIComponent(p.password))} }` : ''} }, // Node only`);
      } catch (e) { notes.push(`Proxy "${req.options.proxy}" could not be parsed.`); }
    }
    if (req.options.insecure) {
      L.push("import https from 'node:https';");
      c.push('  // Skips TLS certificate checks (like curl -k). Never use in production. Node only.\n  httpsAgent: new https.Agent({ rejectUnauthorized: false }),');
    }
    c.push('  validateStatus: () => true, // like curl: do not throw on 4xx/5xx');
    if (req.options.fail) c.pop();
    L.push('');
    L.push(...pre);
    if (pre.length) L.push('');
    L.push('const response = await axios({\n' + c.join('\n') + '\n});');
    L.push('console.log(response.status, response.data);');
    return L.join('\n');
  },

  /* ---------------- Python requests ---------------- */
  python(req, notes, o) {
    const L = ['import requests', ''];
    const args = [q.py(req.url)];
    const b = req.body;
    let headers = req.headers.slice();
    if (req.headers.length) {
      // requests sets these itself for json= / data=dict / files=
      if (isStructuredJson(req)) headers = headers.filter(([k, v]) => !(k.toLowerCase() === 'content-type' && /^application\/json\s*$/i.test(v)));
      if (b && b.type === 'form' && b.fields) headers = headers.filter(([k, v]) => !(k.toLowerCase() === 'content-type' && /^application\/x-www-form-urlencoded\s*$/i.test(v)));
      if (headers.length) { L.push('headers = {\n' + headers.map(([k, v]) => `    ${q.py(k)}: ${q.py(v)},`).join('\n') + '\n}', ''); args.push('headers=headers'); }
    }
    if (b) {
      if (b.type === 'multipart') {
        const files = b.parts.filter((p) => p.file != null), fields = b.parts.filter((p) => p.file == null);
        if (fields.length) { L.push('data = {\n' + fields.map((p) => `    ${q.py(p.name)}: ${q.py(p.value)},`).join('\n') + '\n}', ''); args.push('data=data'); }
        if (files.length) {
          L.push('# Replace the paths with your real files', 'files = {\n' + files.map((p) => `    ${q.py(p.name)}: (${q.py(p.filename)}, open(${q.py(p.file)}, 'rb')${p.contentType ? ', ' + q.py(p.contentType) : ''}),`).join('\n') + '\n}', '');
          args.push('files=files');
        } else { args.push('files={}  # forces multipart/form-data'); }
      } else if (isStructuredJson(req)) { L.push('json_data = ' + literal(b.value, 'py', 0), ''); args.push('json=json_data'); }
      else if (b.type === 'form' && b.fields) { L.push('data = [\n' + b.fields.map(([k, v]) => `    (${q.py(k)}, ${q.py(v)}),`).join('\n') + '\n]', ''); args.push('data=data'); }
      else { L.push('data = ' + q.py(b.text) + (/[^\x00-\x7f]/.test(b.text) ? ".encode('utf-8')" : ''), ''); args.push('data=data'); }
    }
    if (req.auth) args.push(`auth=(${q.py(req.auth.user)}, ${q.py(req.auth.pass)})`);
    if (req.options.timeout || req.options.connectTimeout) {
      if (req.options.connectTimeout && req.options.timeout) args.push(`timeout=(${sec(req.options.connectTimeout)}, ${sec(req.options.timeout)})`);
      else if (req.options.connectTimeout) args.push(`timeout=(${sec(req.options.connectTimeout)}, None)`);
      else args.push(`timeout=${sec(req.options.timeout)}`);
      if (req.options.timeout) notes.push('requests timeouts are per socket operation, not a total time limit like curl --max-time.');
    }
    if (req.method === 'HEAD' ? req.options.followRedirects : (!req.options.followRedirects && o.matchRedirects)) args.push(req.method === 'HEAD' ? 'allow_redirects=True' : 'allow_redirects=False');
    if (req.options.insecure) args.push('verify=False  # like curl -k: skips TLS checks, never use in production');
    if (req.options.proxy) { const p = /^[a-z0-9]+:\/\//i.test(req.options.proxy) ? req.options.proxy : 'http://' + req.options.proxy; args.push(`proxies={'http': ${q.py(p)}, 'https': ${q.py(p)}}`); }
    const fn = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete', HEAD: 'head', OPTIONS: 'options' }[req.method];
    const call = fn ? `requests.${fn}(` : `requests.request(${q.py(req.method)}, `;
    const multi = args.length > 2 || args.some((a) => a.includes('  # '));
    const withComma = (a) => { const c = a.indexOf('  # '); return c >= 0 ? a.slice(0, c) + ',' + a.slice(c) : a + ','; };
    L.push('response = ' + call + (multi ? '\n    ' + args.map(withComma).join('\n    ') + '\n)' : args.join(', ') + ')'));
    if (req.options.fail) L.push('response.raise_for_status()');
    L.push(req.method === 'HEAD' ? 'print(response.status_code, response.headers)' : 'print(response.status_code, response.text)');
    return L.join('\n');
  },

  /* ---------------- PHP cURL ---------------- */
  'php-curl'(req, notes) {
    const L = ['<?php', '', '$ch = curl_init();', `curl_setopt($ch, CURLOPT_URL, ${q.php(req.url)});`, 'curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);'];
    if (req.method === 'HEAD') L.push('curl_setopt($ch, CURLOPT_NOBODY, true);');
    else if (req.method !== 'GET' && !(req.method === 'POST' && req.body)) L.push(`curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${q.php(req.method)});`);
    if (req.headers.length) L.push('curl_setopt($ch, CURLOPT_HTTPHEADER, [\n' + req.headers.map(([k, v]) => `    ${q.php(v === '' ? k + ';' : k + ': ' + v)},`).join('\n') + '\n]);');
    const b = req.body;
    if (b) {
      if (b.type === 'multipart') {
        L.push('curl_setopt($ch, CURLOPT_POSTFIELDS, [\n' + b.parts.map((p) => p.file != null
          ? `    ${q.php(p.name)} => new CURLFile(${q.php(p.file)}, ${p.contentType ? q.php(p.contentType) : "''"}, ${q.php(p.filename)}), // replace with the real path`
          : `    ${q.php(p.name)} => ${q.php(p.value)},`).join('\n') + '\n]);');
      } else L.push(`curl_setopt($ch, CURLOPT_POSTFIELDS, ${q.php(b.text)});`);
      if (req.method === 'POST') L.splice(L.findIndex((x) => x.startsWith('curl_setopt($ch, CURLOPT_RETURNTRANSFER')) + 1, 0, 'curl_setopt($ch, CURLOPT_POST, true);');
    }
    if (req.auth) L.push(`curl_setopt($ch, CURLOPT_USERPWD, ${q.php(req.auth.user + ':' + req.auth.pass)});`);
    if (req.options.followRedirects) { L.push('curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);'); if (req.options.maxRedirects != null) L.push(`curl_setopt($ch, CURLOPT_MAXREDIRS, ${req.options.maxRedirects});`); }
    if (req.options.compressed) L.push("curl_setopt($ch, CURLOPT_ENCODING, ''); // accept & decode gzip/deflate/br");
    if (req.options.timeout) L.push(Number.isInteger(req.options.timeout) ? `curl_setopt($ch, CURLOPT_TIMEOUT, ${req.options.timeout});` : `curl_setopt($ch, CURLOPT_TIMEOUT_MS, ${Math.round(req.options.timeout * 1000)});`);
    if (req.options.connectTimeout) L.push(Number.isInteger(req.options.connectTimeout) ? `curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, ${req.options.connectTimeout});` : `curl_setopt($ch, CURLOPT_CONNECTTIMEOUT_MS, ${Math.round(req.options.connectTimeout * 1000)});`);
    if (req.options.insecure) L.push('// Skips TLS certificate checks (like curl -k). Never use in production.', 'curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);', 'curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);');
    if (req.options.proxy) L.push(`curl_setopt($ch, CURLOPT_PROXY, ${q.php(req.options.proxy)});`);
    if (req.options.fail) L.push('curl_setopt($ch, CURLOPT_FAILONERROR, true);');
    L.push('', '$response = curl_exec($ch);', 'if ($response === false) {', "    throw new RuntimeException('Request failed: ' . curl_error($ch));", '}', '$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);', 'curl_close($ch);', '', 'echo $status, PHP_EOL, $response;');
    return L.join('\n');
  },

  /* ---------------- PHP Guzzle ---------------- */
  'php-guzzle'(req, notes, o) {
    const L = ['<?php', '', "require 'vendor/autoload.php';", '', 'use GuzzleHttp\\Client;', '', '$client = new Client();', ''];
    const opt = [];
    let headers = req.headers.slice();
    const b = req.body;
    if (isStructuredJson(req)) headers = headers.filter(([k, v]) => !(k.toLowerCase() === 'content-type' && /^application\/json\s*$/i.test(v)));
    if (b && b.type === 'form' && b.fields) headers = headers.filter(([k, v]) => !(k.toLowerCase() === 'content-type' && /^application\/x-www-form-urlencoded\s*$/i.test(v)));
    if (headers.length) opt.push("    'headers' => [\n" + headers.map(([k, v]) => `        ${q.php(k)} => ${q.php(v)},`).join('\n') + '\n    ],');
    if (b) {
      if (b.type === 'multipart') {
        opt.push("    'multipart' => [\n" + b.parts.map((p) => p.file != null
          ? `        [\n            'name' => ${q.php(p.name)},\n            'contents' => fopen(${q.php(p.file)}, 'r'), // replace with the real path\n            'filename' => ${q.php(p.filename)},${p.contentType ? `\n            'headers' => ['Content-Type' => ${q.php(p.contentType)}],` : ''}\n        ],`
          : `        ['name' => ${q.php(p.name)}, 'contents' => ${q.php(p.value)}],`).join('\n') + '\n    ],');
      } else if (isStructuredJson(req)) opt.push("    'json' => " + literal(b.value, 'php', 1) + ',');
      else if (b.type === 'form' && b.fields && new Set(b.fields.map((f) => f[0])).size === b.fields.length) opt.push("    'form_params' => " + literal(Object.fromEntries(b.fields), 'php', 1) + ',');
      else opt.push(`    'body' => ${q.php(b.text)},`);
    }
    if (req.auth) opt.push(`    'auth' => [${q.php(req.auth.user)}, ${q.php(req.auth.pass)}],`);
    if (req.options.timeout) opt.push(`    'timeout' => ${req.options.timeout},`);
    if (req.options.connectTimeout) opt.push(`    'connect_timeout' => ${req.options.connectTimeout},`);
    if (req.options.followRedirects) { if (req.options.maxRedirects != null) opt.push(`    'allow_redirects' => ['max' => ${req.options.maxRedirects}],`); }
    else if (o.matchRedirects) opt.push("    'allow_redirects' => false, // curl does not follow redirects without -L");
    if (req.options.insecure) opt.push("    'verify' => false, // like curl -k: skips TLS checks, never use in production");
    if (req.options.proxy) opt.push(`    'proxy' => ${q.php(req.options.proxy)},`);
    if (req.options.compressed) opt.push("    'decode_content' => true,");
    if (!req.options.fail) opt.push("    'http_errors' => false, // like curl: do not throw on 4xx/5xx");
    L.push(`$response = $client->request(${q.php(req.method)}, ${q.php(req.url)}${opt.length ? ', [\n' + opt.join('\n') + '\n]' : ''});`);
    L.push('', "echo $response->getStatusCode(), PHP_EOL, $response->getBody();");
    return L.join('\n');
  },

  /* ---------------- Go net/http ---------------- */
  go(req, notes, o) {
    const imports = new Set(['fmt', 'io', 'net/http']);
    const body = [];
    let bodyVar = 'nil';
    const b = req.body;
    if (b) {
      if (b.type === 'multipart') {
        imports.add('bytes'); imports.add('mime/multipart');
        body.push('body := &bytes.Buffer{}', 'writer := multipart.NewWriter(body)');
        for (const p of b.parts) {
          if (p.file != null) {
            imports.add('os');
            body.push(`// Replace with the real file path`, `file, err := os.Open(${q.go(p.file)})`, 'if err != nil {', '\tpanic(err)', '}', 'defer file.Close()');
            if (p.contentType) {
              imports.add('net/textproto');
              body.push('partHeader := make(textproto.MIMEHeader)', `partHeader.Set("Content-Disposition", ${q.go(`form-data; name="${p.name}"; filename="${p.filename}"`)})`, `partHeader.Set("Content-Type", ${q.go(p.contentType)})`, 'part, err := writer.CreatePart(partHeader)');
            } else body.push(`part, err := writer.CreateFormFile(${q.go(p.name)}, ${q.go(p.filename)})`);
            body.push('if err != nil {', '\tpanic(err)', '}', 'if _, err := io.Copy(part, file); err != nil {', '\tpanic(err)', '}');
          } else body.push(`if err := writer.WriteField(${q.go(p.name)}, ${q.go(p.value)}); err != nil {`, '\tpanic(err)', '}');
        }
        body.push('if err := writer.Close(); err != nil {', '\tpanic(err)', '}', '');
        bodyVar = 'body';
      } else {
        imports.add('strings');
        const lit = !b.text.includes('`') && /["\\\n]/.test(b.text) && !/[\u0000-\u0008\u000b-\u001f]/.test(b.text) ? '`' + b.text + '`' : q.go(b.text);
        body.push(`body := strings.NewReader(${lit})`, '');
        bodyVar = 'body';
      }
    }
    const L = [];
    const clientOpts = [];
    if (req.options.timeout) { imports.add('time'); clientOpts.push(`\tTimeout: ${goDuration(req.options.timeout)},`); }
    const transport = [];
    if (req.options.insecure) { imports.add('crypto/tls'); transport.push('\tTLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // like curl -k: never use in production'); }
    if (req.options.proxy) { imports.add('net/url'); transport.push('\tProxy: http.ProxyURL(proxyURL),'); }
    if (req.options.connectTimeout) { imports.add('net'); imports.add('time'); transport.push(`\tDialContext: (&net.Dialer{Timeout: ${goDuration(req.options.connectTimeout)}}).DialContext,`); }
    if (transport.length) clientOpts.push('\tTransport: &http.Transport{\n' + transport.map((t) => '\t' + t).join('\n') + '\n\t},');
    if (!req.options.followRedirects && o.matchRedirects) clientOpts.push('\t// curl does not follow redirects without -L\n\tCheckRedirect: func(req *http.Request, via []*http.Request) error {\n\t\treturn http.ErrUseLastResponse\n\t},');
    if (req.options.proxy) L.push(`proxyURL, err := url.Parse(${q.go(/^[a-z0-9]+:\/\//i.test(req.options.proxy) ? req.options.proxy : 'http://' + req.options.proxy)})`, 'if err != nil {', '\tpanic(err)', '}', '');
    L.push(clientOpts.length ? 'client := &http.Client{\n' + clientOpts.join('\n') + '\n}' : 'client := &http.Client{}', '');
    L.push(...body);
    L.push(`req, err := http.NewRequest(${q.go(req.method)}, ${q.go(req.url)}, ${bodyVar})`, 'if err != nil {', '\tpanic(err)', '}');
    for (const [k, v] of req.headers) L.push(`req.Header.Set(${q.go(k)}, ${q.go(v)})`);
    if (b && b.type === 'multipart') L.push('req.Header.Set("Content-Type", writer.FormDataContentType())');
    if (req.auth) L.push(`req.SetBasicAuth(${q.go(req.auth.user)}, ${q.go(req.auth.pass)})`);
    if (req.options.compressed) notes.push('Go\'s http.Transport requests and decodes gzip automatically when you do not set Accept-Encoding yourself.');
    L.push('', 'resp, err := client.Do(req)', 'if err != nil {', '\tpanic(err)', '}', 'defer resp.Body.Close()', '');
    if (req.options.fail) L.push('if resp.StatusCode >= 400 {', '\tpanic(fmt.Sprintf("HTTP %d", resp.StatusCode))', '}', '');
    L.push('data, err := io.ReadAll(resp.Body)', 'if err != nil {', '\tpanic(err)', '}', 'fmt.Println(resp.StatusCode, string(data))');
    const sorted = [...imports].sort();
    return 'package main\n\nimport (\n' + sorted.map((i) => `\t"${i}"`).join('\n') + '\n)\n\nfunc main() {\n' + L.map((l) => (l ? l.split('\n').map((x) => '\t' + x).join('\n') : '')).join('\n') + '\n}\n';
  },

  /* ---------------- Java HttpClient ---------------- */
  java(req, notes) {
    const imports = new Set(['java.net.URI', 'java.net.http.HttpClient', 'java.net.http.HttpRequest', 'java.net.http.HttpResponse']);
    const L = [];
    const cb = [];
    if (req.options.followRedirects) cb.push('.followRedirects(HttpClient.Redirect.NORMAL)');
    if (req.options.connectTimeout) { imports.add('java.time.Duration'); cb.push(`.connectTimeout(Duration.ofMillis(${Math.round(req.options.connectTimeout * 1000)}))`); }
    if (req.options.proxy) {
      imports.add('java.net.InetSocketAddress'); imports.add('java.net.ProxySelector');
      try { const p = new URL(/^[a-z0-9]+:\/\//i.test(req.options.proxy) ? req.options.proxy : 'http://' + req.options.proxy); cb.push(`.proxy(ProxySelector.of(new InetSocketAddress(${q.java(p.hostname)}, ${p.port || 1080})))`); } catch (e) { notes.push('Proxy could not be parsed.'); }
    }
    if (req.options.httpVersion === 'http1.1' || req.options.httpVersion === 'http1.0') cb.push('.version(HttpClient.Version.HTTP_1_1)');
    if (req.options.insecure) notes.push('Java HttpClient has no one-line "insecure" switch; skipping TLS checks needs a custom SSLContext (not generated, on purpose).');
    if (req.options.compressed) notes.push('Java HttpClient does not decompress gzip automatically — wrap the body in GZIPInputStream if the server compresses.');
    const b = req.body;
    let publisher = 'HttpRequest.BodyPublishers.noBody()';
    const pre = [];
    if (b) {
      if (b.type === 'multipart') {
        imports.add('java.io.ByteArrayOutputStream'); imports.add('java.nio.charset.StandardCharsets'); imports.add('java.nio.file.Files'); imports.add('java.nio.file.Path');
        pre.push('String boundary = "----JavaBoundary" + System.currentTimeMillis();', 'ByteArrayOutputStream body = new ByteArrayOutputStream();');
        for (const p of b.parts) {
          if (p.file != null) {
            pre.push(`body.write(("--" + boundary + "\\r\\nContent-Disposition: form-data; name=" + ${q.java('"' + p.name + '"')} + "; filename=" + ${q.java('"' + p.filename + '"')} + "\\r\\nContent-Type: " + ${q.java(p.contentType || 'application/octet-stream')} + "\\r\\n\\r\\n").getBytes(StandardCharsets.UTF_8));`);
            pre.push(`body.write(Files.readAllBytes(Path.of(${q.java(p.file)}))); // replace with the real path`);
            pre.push('body.write("\\r\\n".getBytes(StandardCharsets.UTF_8));');
          } else {
            pre.push(`body.write(("--" + boundary + "\\r\\nContent-Disposition: form-data; name=" + ${q.java('"' + p.name + '"')} + "\\r\\n\\r\\n" + ${q.java(p.value)} + "\\r\\n").getBytes(StandardCharsets.UTF_8));`);
          }
        }
        pre.push('body.write(("--" + boundary + "--\\r\\n").getBytes(StandardCharsets.UTF_8));');
        publisher = 'HttpRequest.BodyPublishers.ofByteArray(body.toByteArray())';
      } else publisher = `HttpRequest.BodyPublishers.ofString(${q.java(b.text)})`;
    }
    const rb = [`.uri(URI.create(${q.java(req.url)}))`];
    if (req.options.timeout) { imports.add('java.time.Duration'); rb.push(`.timeout(Duration.ofMillis(${Math.round(req.options.timeout * 1000)}))`); }
    const restricted = new Set(['connection', 'content-length', 'expect', 'host', 'upgrade']);
    for (const [k, v] of req.headers) {
      if (restricted.has(k.toLowerCase())) { notes.push(`Java HttpClient does not allow setting the "${k}" header; it was left out.`); continue; }
      rb.push(`.header(${q.java(k)}, ${q.java(v)})`);
    }
    if (b && b.type === 'multipart') rb.push('.header("Content-Type", "multipart/form-data; boundary=" + boundary)');
    if (req.auth) { imports.add('java.util.Base64'); imports.add('java.nio.charset.StandardCharsets'); rb.push(`.header("Authorization", "Basic " + Base64.getEncoder().encodeToString(${q.java(req.auth.user + ':' + req.auth.pass)}.getBytes(StandardCharsets.UTF_8)))`); }
    const m = req.method;
    if (m === 'GET' && !b) rb.push('.GET()');
    else if (m === 'DELETE' && !b) rb.push('.DELETE()');
    else if (m === 'POST') rb.push(`.POST(${publisher})`);
    else if (m === 'PUT') rb.push(`.PUT(${publisher})`);
    else rb.push(`.method(${q.java(m)}, ${publisher})`);
    rb.push('.build()');
    L.push(cb.length ? 'HttpClient client = HttpClient.newBuilder()\n        ' + cb.join('\n        ') + '\n        .build();' : 'HttpClient client = HttpClient.newHttpClient();');
    if (pre.length) L.push('', ...pre);
    L.push('', 'HttpRequest request = HttpRequest.newBuilder()\n        ' + rb.join('\n        ') + ';');
    L.push('', 'HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());');
    if (req.options.fail) L.push('if (response.statusCode() >= 400) {\n    throw new RuntimeException("HTTP " + response.statusCode());\n}');
    L.push('System.out.println(response.statusCode());', 'System.out.println(response.body());');
    return [...imports].sort().map((i) => `import ${i};`).join('\n') + '\n\npublic class Main {\n    public static void main(String[] args) throws Exception {\n' + L.join('\n').split('\n').map((l) => (l ? '        ' + l : '')).join('\n') + '\n    }\n}\n';
  },

  /* ---------------- Ruby Net::HTTP ---------------- */
  ruby(req, notes) {
    const L = ["require 'net/http'", "require 'uri'"];
    const b = req.body;
    if (isStructuredJson(req)) L.push("require 'json'");
    if (req.options.insecure) L.push("require 'openssl'");
    L.push('', `uri = URI(${q.rb(req.url)})`);
    const cls = { GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete', HEAD: 'Head', OPTIONS: 'Options', TRACE: 'Trace' }[req.method];
    if (cls) L.push(`request = Net::HTTP::${cls}.new(uri)`);
    else { L.push(`# Custom method ${req.method}`, `request = Net::HTTPGenericRequest.new(${q.rb(req.method)}, ${b ? 'true' : 'false'}, true, uri)`); }
    for (const [k, v] of req.headers) L.push(`request[${q.rb(k)}] = ${q.rb(v)}`);
    if (req.auth) L.push(`request.basic_auth(${q.rb(req.auth.user)}, ${q.rb(req.auth.pass)})`);
    if (b) {
      if (b.type === 'multipart') {
        L.push('# Replace the paths with your real files');
        L.push('request.set_form([\n' + b.parts.map((p) => p.file != null
          ? `  [${q.rb(p.name)}, File.open(${q.rb(p.file)}), { filename: ${q.rb(p.filename)}${p.contentType ? `, content_type: ${q.rb(p.contentType)}` : ''} }],`
          : `  [${q.rb(p.name)}, ${q.rb(p.value)}],`).join('\n') + "\n], 'multipart/form-data')");
      } else if (isStructuredJson(req)) L.push('request.body = JSON.dump(' + literal(b.value, 'rb', 0) + ')');
      else L.push(`request.body = ${q.rb(b.text)}`);
    }
    const opts = [`use_ssl: uri.scheme == 'https'`];
    if (req.options.insecure) { opts.push('verify_mode: OpenSSL::SSL::VERIFY_NONE'); L.push('', '# verify_mode VERIFY_NONE skips TLS checks (like curl -k) — never use in production'); }
    if (req.options.timeout) opts.push(`read_timeout: ${req.options.timeout}`);
    if (req.options.connectTimeout) opts.push(`open_timeout: ${req.options.connectTimeout}`);
    let proxyArgs = '';
    if (req.options.proxy) {
      try { const p = new URL(/^[a-z0-9]+:\/\//i.test(req.options.proxy) ? req.options.proxy : 'http://' + req.options.proxy); proxyArgs = `, ${q.rb(p.hostname)}, ${p.port || 1080}`; } catch (e) { notes.push('Proxy could not be parsed.'); }
    }
    if (req.options.followRedirects) notes.push('Net::HTTP does not follow redirects automatically — check response["location"] and repeat the request if needed.');
    if (req.options.compressed) notes.push('Net::HTTP decompresses gzip/deflate automatically when you do not set Accept-Encoding yourself.');
    L.push(...(req.options.insecure ? [] : ['']), `response = Net::HTTP.start(uri.hostname, uri.port${proxyArgs}, ${opts.join(', ')}) do |http|`, '  http.request(request)', 'end', '');
    if (req.options.fail) L.push("raise \"HTTP #{response.code}\" if response.code.to_i >= 400");
    L.push('puts response.code', 'puts response.body');
    return L.join('\n');
  },
};

function goDuration(s) {
  const ms = Math.round(s * 1000);
  return ms % 1000 === 0 ? `${ms / 1000} * time.Second` : `${ms} * time.Millisecond`;
}

/* =====================================================================================
 * 4. Request model → curl command (for the cURL generator)
 * ===================================================================================== */

export const SHELLS = [
  { id: 'bash', name: 'Bash / zsh (Linux, macOS)' },
  { id: 'powershell', name: 'PowerShell' },
  { id: 'cmd', name: 'Windows CMD' },
];

const shq = {
  bash: (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'"),
  powershell: (s) => (/^[A-Za-z0-9_%+=:,./-]+$/.test(s) && !/^-/.test(s) ? s : "'" + String(s).replace(/'/g, "''") + "'"),
  cmd: (s) => (/^[A-Za-z0-9_@+=:,./-]+$/.test(s) ? s : '"' + String(s).replace(/(\\*)"/g, (m, bs) => bs + bs + '\\"').replace(/(\\+)$/, '$1$1') + '"'),
};

/**
 * toCurl(spec, { shell='bash', multiline=true }) → { command, notes[] }
 * spec: { method, url, headers:[[k,v]], auth:{type:'basic',user,pass}|null,
 *         body: null | {type:'raw'|'json'|'form'|'multipart', text, fields:[[k,v]], parts:[{name,value}|{name,file,contentType}]},
 *         options: {followRedirects, insecure, compressed, verbose, include, timeout} }
 */
export function toCurl(spec, opts = {}) {
  const shell = opts.shell || 'bash';
  const Q = shq[shell];
  const notes = [];
  const args = [];
  const m = (spec.method || 'GET').toUpperCase();
  const b = spec.body && spec.body.type && spec.body.type !== 'none' ? spec.body : null;
  const opt = spec.options || {};
  if (m === 'HEAD') args.push(['-I']);
  else if (!(m === 'GET' && !b) && !(m === 'POST' && b)) args.push(['-X', m]);
  if (opt.followRedirects) args.push(['-L']);
  if (opt.compressed) args.push(['--compressed']);
  if (opt.insecure) args.push(['-k']);
  if (opt.verbose) args.push(['-v']);
  if (opt.include) args.push(['-i']);
  if (opt.timeout) args.push(['--max-time', String(opt.timeout)]);
  const headers = (spec.headers || []).slice();
  const hasCT = headers.some(([k]) => k.toLowerCase() === 'content-type');
  // curl -d defaults to application/x-www-form-urlencoded — state the real type explicitly
  if (b && !hasCT && b.type === 'json') headers.push(['Content-Type', 'application/json']);
  if (b && !hasCT && b.type === 'raw') headers.push(['Content-Type', 'text/plain']);
  for (const [k, v] of headers) args.push(['-H', v === '' ? `${k};` : `${k}: ${v}`]);
  if (spec.auth && spec.auth.type === 'basic') args.push(['-u', `${spec.auth.user}:${spec.auth.pass}`]);
  if (b) {
    if (b.type === 'multipart') {
      for (const p of b.parts || []) {
        if (p.file != null) args.push(['-F', `${p.name}=@${p.file}${p.contentType ? ';type=' + p.contentType : ''}`]);
        else {
          if (/^[@<]/.test(p.value)) notes.push(`Field "${p.name}" starts with @ or < — sent with --form-string so curl does not read a file.`);
          args.push([/^[@<]/.test(p.value) || /;type=/.test(p.value) ? '--form-string' : '-F', `${p.name}=${p.value}`]);
        }
      }
    } else if (b.type === 'form' && b.fields) {
      for (const [k, v] of b.fields) args.push(['--data-urlencode', `${k}=${v}`]);
    } else {
      args.push(['--data-raw', b.text ?? '']);
    }
  }
  if (shell === 'cmd' && /%/.test(spec.url + JSON.stringify(spec.headers) + JSON.stringify(b))) notes.push('CMD expands %VARIABLES% even inside quotes — check any % characters (in a .bat file write %%).');
  if (shell === 'powershell') notes.push('Uses curl.exe (not the PowerShell "curl" alias). Arguments with double quotes need PowerShell 7.3+; in Windows PowerShell 5.1 write \\" inside them.');
  if (shell === 'cmd' && /[\r\n]/.test(JSON.stringify(args))) notes.push('CMD cannot pass line breaks inside an argument — put multi-line bodies in a file and use --data-binary @file.');
  const exe = shell === 'powershell' ? 'curl.exe' : 'curl';
  const parts = args.map((a) => a.map((x, i) => (i === 0 ? x : Q(x))).join(' '));
  const urlPart = Q(spec.url || '');
  const cont = { bash: ' \\', powershell: ' `', cmd: ' ^' }[shell];
  const command = opts.multiline !== false && parts.length
    ? [exe + ' ' + urlPart, ...parts].map((p, i, arr) => (i < arr.length - 1 ? p + cont : p)).join('\n  ')
    : [exe, urlPart, ...parts].join(' ');
  return { command, notes };
}

/** Build the final URL from a base URL and [[k,v]] query params (keeps any query already in the URL). */
export function buildUrl(base, params) {
  const list = (params || []).filter(([k]) => k);
  if (!list.length) return base;
  const qs = list.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const hashIdx = base.indexOf('#');
  const main = hashIdx >= 0 ? base.slice(0, hashIdx) : base;
  const frag = hashIdx >= 0 ? base.slice(hashIdx) : '';
  return main + (main.includes('?') ? (main.endsWith('?') || main.endsWith('&') ? '' : '&') : '?') + qs + frag;
}
