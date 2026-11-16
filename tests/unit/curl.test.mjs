import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenize, parseCurl, generate, LANGS, toCurl, buildUrl, detectDialect, CurlError } from '../../assets/dev/lib/curl.js';

const words = (cmd, d) => tokenize(cmd, d).filter((t) => t.v !== undefined).map((t) => t.v);

/* ---------------- tokenizer ---------------- */
test('tokenizer: single, double, ANSI-C quotes and escapes (bash)', () => {
  assert.deepEqual(words(`curl 'a b' "c \\"d\\" \\$e \\\\ f" $'g\\th\\n\\x41\\u00e9' i\\ j`), ['curl', 'a b', 'c "d" $e \\ f', 'g\th\nAé', 'i j']);
});
test('tokenizer: adjacent quoted pieces form one word', () => {
  assert.deepEqual(words(`curl 'it'\\''s' "a"'b'c`), ['curl', "it's", 'abc']);
});
test('tokenizer: backslash-newline continuations (LF and CRLF)', () => {
  assert.deepEqual(words('curl \\\n  -H x \\\r\n  url'), ['curl', '-H', 'x', 'url']);
});
test('tokenizer: PowerShell backtick continuation and quoting', () => {
  const cmd = "curl.exe 'https://x.io' `\n  -H 'It''s: ok' `\n  -d \"a`\"b\"";
  assert.equal(detectDialect(cmd), 'powershell');
  assert.deepEqual(words(cmd), ['curl.exe', 'https://x.io', '-H', "It's: ok", '-d', 'a"b']);
});
test('tokenizer: CMD caret continuation and MSVCRT backslash rules', () => {
  const cmd = 'curl "https://x.io" ^\n  -d "{\\"a\\":\\"b\\\\\\\\\\"}" ^\n  -H "X: 1"';
  assert.equal(detectDialect(cmd), 'cmd');
  assert.deepEqual(words(cmd), ['curl', 'https://x.io', '-d', '{"a":"b\\\\"}', '-H', 'X: 1']);
});
test('tokenizer: operators end the command; comments skipped', () => {
  const t = tokenize('curl x # comment\n | jq .');
  assert.deepEqual(t.filter((x) => x.v).map((x) => x.v), ['curl', 'x', 'jq', '.']);
  assert.ok(t.some((x) => x.op === '|'));
});
test('tokenizer: unterminated quotes throw', () => {
  assert.throws(() => tokenize("curl 'abc"), CurlError);
  assert.throws(() => tokenize('curl "abc'), CurlError);
  assert.throws(() => tokenize("curl $'abc"), CurlError);
});

/* ---------------- parser ---------------- */
test('parse: simple GET with headers', () => {
  const r = parseCurl(`curl https://api.x.com/u?a=1 -H 'Accept: application/json' -H "X-Y: z"`);
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://api.x.com/u?a=1');
  assert.deepEqual(r.headers, [['Accept', 'application/json'], ['X-Y', 'z']]);
  assert.equal(r.body, null);
  assert.deepEqual(r.warnings, []);
});
test('parse: combined short flags -sSL, attached -XPOST and -H\'…\'', () => {
  const r = parseCurl(`curl -sSL -XPOST -H'X-A: 1' https://x.io -d a=1`);
  assert.equal(r.method, 'POST');
  assert.equal(r.options.followRedirects, true);
  assert.deepEqual(r.headers.slice(0, 1), [['X-A', '1']]);
  assert.equal(r.info.length, 2); // -s, -S
});
test('parse: -d defaults to POST + form content type; multiple -d joined with &', () => {
  const r = parseCurl(`curl https://x.io -d a=1 -d 'b=two words'`);
  assert.equal(r.method, 'POST');
  assert.equal(r.body.text, 'a=1&b=two words');
  assert.deepEqual(r.headers, [['Content-Type', 'application/x-www-form-urlencoded']]);
});
test('parse: --json sets content-type and accept, keeps body', () => {
  const r = parseCurl(`curl --json '{"a":1}' https://x.io`);
  assert.equal(r.method, 'POST');
  assert.equal(r.body.type, 'json');
  assert.equal(r.body.structured, true);
  assert.deepEqual(r.headers, [['Content-Type', 'application/json'], ['Accept', 'application/json']]);
});
test('parse: JSON body with big integer is not converted to a literal', () => {
  const r = parseCurl(`curl -H 'Content-Type: application/json' -d '{"id":12345678901234567890}' https://x.io`);
  assert.equal(r.body.structured, false);
  assert.match(generate(r, 'python').code, /data = '\{"id":12345678901234567890\}'/);
});
test('parse: -G moves data to the query string', () => {
  const r = parseCurl(`curl -G https://x.io/s?x=1 --data-urlencode 'q=hello world' -d n=2`);
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://x.io/s?x=1&q=hello%20world&n=2');
  assert.equal(r.body, null);
});
test('parse: --data-urlencode forms', () => {
  const r = parseCurl(`curl https://x.io --data-urlencode 'a=b&c' --data-urlencode '=x y' --data-urlencode plain`);
  assert.equal(r.body.text, 'a=b%26c&x%20y&plain');
  const r2 = parseCurl(`curl https://x.io --data-urlencode 'f@data.txt'`);
  assert.ok(r2.warnings.some((w) => /data\.txt/.test(w)));
});
test('parse: -F form fields and file uploads with type', () => {
  const r = parseCurl(`curl https://x.io/up -F 'file=@/tmp/a b.png;type=image/png' -F name=Al --form-string 'raw=@notafile'`);
  assert.equal(r.method, 'POST');
  assert.deepEqual(r.body.parts, [
    { name: 'file', file: '/tmp/a b.png', filename: 'a b.png', contentType: 'image/png' },
    { name: 'name', value: 'Al' },
    { name: 'raw', value: '@notafile' },
  ]);
  assert.ok(r.warnings.some((w) => /placeholder/.test(w)));
});
test('parse: -u basic auth, --oauth2-bearer, -A, -e, -b', () => {
  const r = parseCurl(`curl -u 'al:p:w' --oauth2-bearer T0K -A 'UA/1' -e https://ref -b 'a=1; b=2' https://x.io`);
  assert.deepEqual(r.auth, { type: 'basic', user: 'al', pass: 'p:w' });
  assert.deepEqual(r.headers, [['Authorization', 'Bearer T0K'], ['User-Agent', 'UA/1'], ['Referer', 'https://ref'], ['Cookie', 'a=1; b=2']]);
});
test('parse: -I head, -k, --compressed, -m, --connect-timeout, -x, --max-redirs', () => {
  const r = parseCurl(`curl -I -k --compressed -m 2.5 --connect-timeout 3 -x http://proxy:8080 -L --max-redirs 4 https://x.io`);
  assert.equal(r.method, 'HEAD');
  assert.deepEqual([r.options.insecure, r.options.compressed, r.options.timeout, r.options.connectTimeout, r.options.proxy, r.options.maxRedirects], [true, true, 2.5, 3, 'http://proxy:8080', 4]);
});
test('parse: header forms "X;" (empty) and "X:" (remove)', () => {
  const r = parseCurl(`curl -H 'X-Empty;' -H 'Accept:' https://x.io`);
  assert.deepEqual(r.headers, [['X-Empty', '']]);
  assert.ok(r.info.some((w) => /Accept/.test(w)));
});
test('parse: unsupported and unknown flags are warned, never silently dropped', () => {
  const r = parseCurl(`curl -o out.json --cert c.pem --digest -u a:b --frobnicate https://x.io --resolve x.io:443:1.2.3.4`);
  const w = r.warnings.join('\n');
  for (const s of ['-o out.json', '--cert c.pem', 'digest', '--frobnicate', '--resolve']) assert.ok(w.includes(s), 'missing warning for ' + s);
});
test('parse: shell variables, pipes and missing scheme are reported', () => {
  const r = parseCurl(`curl -H "Authorization: Bearer $TOKEN" example.com/x | jq .`);
  assert.equal(r.url, 'http://example.com/x');
  assert.ok(r.warnings.some((w) => w.includes('$TOKEN')));
  assert.ok(r.warnings.some((w) => w.includes("'|'")));
  assert.ok(r.info.some((w) => /http:\/\//.test(w)));
});
test('parse: errors for empty, non-curl, missing URL, missing option value', () => {
  assert.throws(() => parseCurl(''), /Paste/);
  assert.throws(() => parseCurl('wget https://x'), /start with "curl"/);
  assert.throws(() => parseCurl('curl -H "A: b"'), /No URL/);
  assert.throws(() => parseCurl('curl https://x -H'), /needs a value/);
});
test('parse: --url, --url-query, -X lowercase, leading $ prompt, curl.exe path', () => {
  const r = parseCurl(`$ C:\\tools\\curl.exe --url https://x.io/a --url-query "q=a b" -X put`, { dialect: 'cmd' });
  assert.equal(r.url, 'https://x.io/a?q=a%20b');
  assert.equal(r.method, 'PUT');
});

/* ---------------- generators ---------------- */
const CASES = {
  get: `curl 'https://api.x.com/users?page=2' -H 'Accept: application/json' -H "X-Note: it's \\"quoted\\" \\$x"`,
  json: `curl -X POST https://api.x.com/items -H 'Content-Type: application/json' -d '{"name":"Zoë \\"x\\"","tags":["a"],"ok":true,"n":null,"e":{}}' --max-time 10`,
  form: `curl https://x.io/login -d 'user=al&pass=p%26w'`,
  multipart: `curl https://x.io/up -F 'file=@photo.jpg;type=image/jpeg' -F 'title=Hello world'`,
  auth: `curl -u 'user:pa$$' -k -L --compressed -x http://proxy:3128 https://x.io/secure`,
  raw: `curl -X PATCH https://x.io/t -H 'Content-Type: text/plain' --data-binary $'line1\\nline2 $HOME \\'q\\''`,
};
for (const [name, cmd] of Object.entries(CASES)) {
  for (const l of LANGS) {
    test(`generate ${l.id}: ${name}`, () => {
      const r = parseCurl(cmd);
      const { code } = generate(r, l.id);
      assert.ok(code.length > 20);
      assert.ok(code.includes('x.io') || code.includes('x.com'), 'URL present');
      if (name === 'get') assert.match(code, /it's|it\\'s/);
      if (name === 'json' && ['fetch', 'axios', 'python', 'php-guzzle', 'ruby'].includes(l.id)) assert.match(code, /Zo[ëe]/);
      if (name === 'auth') assert.match(code, /pa\$\$|pa\\\$\\\$|dXNlcjpwYSQk/); // literal or base64 of user:pa$$
      if (name === 'multipart') assert.match(code, /photo\.jpg/);
    });
  }
}
test('generated python uses json= for JSON and auth tuple', () => {
  assert.match(generate(parseCurl(CASES.json), 'python').code, /json=json_data/);
  assert.match(generate(parseCurl(CASES.auth), 'python').code, /auth=\('user', 'pa\$\$'\)[\s\S]*allow_redirects|verify=False/);
});
test('redirect matching: no -L → libraries told not to follow', () => {
  const r = parseCurl('curl https://x.io');
  assert.match(generate(r, 'fetch').code, /redirect: 'manual'/);
  assert.match(generate(r, 'python').code, /allow_redirects=False/);
  assert.match(generate(r, 'go').code, /ErrUseLastResponse/);
  assert.doesNotMatch(generate(r, 'fetch', { matchRedirects: false }).code, /redirect:/);
  assert.doesNotMatch(generate(parseCurl('curl -L https://x.io'), 'fetch').code, /redirect:/);
});
test('PHP strings with $ use single quotes (no interpolation)', () => {
  const code = generate(parseCurl(`curl -H 'X: $var' https://x.io`), 'php-curl').code;
  assert.match(code, /'X: \$var'/);
});

/* ---------------- compile/syntax checks with real toolchains (skip if missing) ---------------- */
const has = (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0 || spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'curlgen-'));

test('python3 compiles every generated Python snippet', { skip: !has('python3') && 'python3 not installed' }, () => {
  for (const [name, cmd] of Object.entries(CASES)) {
    const f = join(dir, `t_${name}.py`);
    writeFileSync(f, generate(parseCurl(cmd), 'python').code);
    execFileSync('python3', ['-m', 'py_compile', f]);
  }
});
test('node parses every generated fetch / axios snippet', { skip: !has('node') && 'node not installed' }, () => {
  for (const [name, cmd] of Object.entries(CASES)) for (const lang of ['fetch', 'axios']) {
    const f = join(dir, `t_${name}_${lang}.mjs`);
    writeFileSync(f, generate(parseCurl(cmd), lang).code);
    execFileSync(process.execPath, ['--check', f]);
  }
});
test('javac compiles every generated Java snippet', { skip: !has('javac') && 'javac not installed' }, () => {
  for (const [name, cmd] of Object.entries(CASES)) {
    const d = join(dir, 'java_' + name); mkdirSync(d);
    writeFileSync(join(d, 'Main.java'), generate(parseCurl(cmd), 'java').code);
    execFileSync('javac', ['-d', d, join(d, 'Main.java')], { stdio: 'pipe' });
  }
});
for (const [bin, lang, ext, args] of [['php', 'php-curl', 'php', ['-l']], ['php', 'php-guzzle', 'php', ['-l']], ['ruby', 'ruby', 'rb', ['-c']], ['gofmt', 'go', 'go', ['-e']]]) {
  test(`${bin} syntax-checks generated ${lang}`, { skip: !has(bin) && `${bin} not installed` }, () => {
    for (const [name, cmd] of Object.entries(CASES)) {
      const f = join(dir, `t_${name}_${lang}.${ext}`);
      writeFileSync(f, generate(parseCurl(cmd), lang).code);
      execFileSync(bin, [...args, f], { stdio: 'pipe' });
    }
  });
}

/* ---------------- curl generator round-trip ---------------- */
const SPECS = [
  { method: 'GET', url: 'https://api.x.com/a?q=1', headers: [['Accept', 'application/json']], auth: null, body: null, options: {} },
  { method: 'PATCH', url: "https://api.x.com/a?q=it's 100%", headers: [['X-Quote', `He said "hi" & it's $HOME`]], auth: { type: 'basic', user: 'al', pass: `p'w"d` }, body: { type: 'json', text: '{"a":"it\'s \\"q\\" \\\\ $x","n":[1,2]}' }, options: { followRedirects: true, insecure: true, compressed: true, timeout: 30 } },
  { method: 'POST', url: 'https://x.io/form', headers: [], auth: null, body: { type: 'form', fields: [['name', 'Zoë & co'], ['n', '1+1=2']] }, options: {} },
  { method: 'PUT', url: 'https://x.io/up', headers: [['X-Empty', '']], auth: null, body: { type: 'multipart', parts: [{ name: 'f', file: 'my file.png', contentType: 'image/png' }, { name: 'note', value: '@literal' }] }, options: {} },
  { method: 'DELETE', url: 'https://x.io/r/1', headers: [], auth: null, body: null, options: { followRedirects: false } },
  { method: 'HEAD', url: 'https://x.io/', headers: [], auth: null, body: null, options: {} },
];
for (const shell of ['bash', 'powershell', 'cmd']) {
  for (const ml of [true, false]) {
    SPECS.forEach((spec, i) => {
      test(`toCurl → parseCurl round-trip: ${shell} ${ml ? 'multi-line' : 'single-line'} #${i}`, () => {
        const { command } = toCurl(spec, { shell, multiline: ml });
        const r = parseCurl(command, { dialect: shell });
        assert.equal(r.method, spec.method);
        assert.equal(r.url, spec.url);
        for (const [k, v] of spec.headers) assert.ok(r.headers.some(([a, b]) => a === k && b === v), `header ${k}`);
        assert.deepEqual(r.auth, spec.auth);
        if (spec.body?.type === 'json') { assert.equal(r.body.text, spec.body.text); assert.ok(r.headers.some(([k, v]) => k === 'Content-Type' && v === 'application/json')); }
        if (spec.body?.type === 'form') assert.deepEqual(r.body.fields, spec.body.fields);
        if (spec.body?.type === 'multipart') assert.deepEqual(r.body.parts.map((p) => p.file ?? p.value), ['my file.png', '@literal']);
        assert.equal(!!r.options.followRedirects, !!spec.options.followRedirects);
        assert.equal(!!r.options.insecure, !!spec.options.insecure);
        assert.equal(r.options.timeout ?? null, spec.options.timeout ?? null);
        // the only acceptable warning: file uploads use a placeholder path in generated code
        assert.deepEqual(r.warnings.filter((w) => !/placeholder path/.test(w)), []);
      });
    });
  }
}
test('buildUrl appends encoded params and keeps fragments', () => {
  assert.equal(buildUrl('https://x.io/a?x=1#f', [['q', 'a b&c'], ['', 'skip']]), 'https://x.io/a?x=1&q=a%20b%26c#f');
  assert.equal(buildUrl('https://x.io/a', []), 'https://x.io/a');
});
