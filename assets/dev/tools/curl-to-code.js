/* cURL → Code: parse a curl command and generate equivalent code in 8 languages. */
import { h, editor, output, msgBox, select, checkbox, primary, toolbar, field, tabs, store, debounce, clear } from '../ui.js';
import { parseCurl, generate, LANGS } from '../lib/curl.js';

const SAMPLE = `curl -X POST 'https://api.example.com/v1/orders?notify=true' \\
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.demo' \\
  -H 'Content-Type: application/json' \\
  -H "X-Request-Id: it's-42" \\
  --data-raw '{"item":"Café ☕","qty":2,"gift":true,"note":null}' \\
  --max-time 15 -L`;

export function mount(root) {
  const saved = store.get('curl-to-code', { lang: 'fetch', dialect: 'auto', redirects: true });
  const input = editor({ label: 'cURL command', placeholder: "curl https://api.example.com -H 'Accept: application/json'", sample: SAMPLE, paste: true, clear: true, rows: 9 });
  const msg = msgBox();
  const summary = h('div', { class: 'cc-summary', hidden: true });
  const warnBox = h('div', { class: 'cc-warnings', hidden: true });
  const dialect = select([['auto', 'Shell: auto-detect'], ['bash', 'Bash / zsh'], ['powershell', 'PowerShell'], ['cmd', 'Windows CMD']], saved.dialect, (v) => { saved.dialect = v; store.set('curl-to-code', saved); run(); });
  dialect.setAttribute('aria-label', 'Shell syntax of the command');
  const redirects = checkbox("Match curl's redirect behaviour", saved.redirects, (v) => { saved.redirects = v; store.set('curl-to-code', saved); run(); });
  redirects.title = 'curl only follows redirects with -L; most libraries follow them by default. When on, the generated code disables redirects unless -L was given.';

  const out = output({
    label: 'Code', empty: 'Generated code will appear here.',
    download: () => { const l = LANGS.find((x) => x.id === saved.lang); return { name: (l.id === 'java' ? 'Main' : 'request') + '.' + l.ext, mime: 'text/plain;charset=utf-8' }; },
  });
  const langNotes = h('ul', { class: 'cc-notes' });
  const langTabs = tabs(LANGS.map((l) => [l.id, l.name]), saved.lang, (id) => { saved.lang = id; store.set('curl-to-code', saved); render(); });
  let req = null;

  function render() {
    if (!req) { out.set(''); clear(langNotes); return; }
    const g = generate(req, saved.lang, { matchRedirects: redirects.input.checked });
    out.set(g.code);
    clear(langNotes);
    for (const n of g.notes) langNotes.appendChild(h('li', null, n));
  }

  function run(showEmptyError) {
    msg.hide();
    const src = input.get();
    if (!src.trim()) {
      req = null; summary.hidden = true; warnBox.hidden = true; render();
      if (showEmptyError) msg.error('Paste a cURL command first.');
      return;
    }
    try {
      req = parseCurl(src, { dialect: dialect.value });
    } catch (e) {
      req = null; summary.hidden = true; warnBox.hidden = true; render();
      msg.error('Could not parse the command', e.message);
      return;
    }
    // summary
    clear(summary); summary.hidden = false;
    summary.append(
      h('div', { class: 'cc-line' }, h('span', { class: 'cc-method cc-m-' + req.method.toLowerCase() }, req.method), h('code', { class: 'cc-url' }, req.url)),
      h('div', { class: 'dt-stats' },
        h('span', { class: 'dt-stat' }, 'Headers ', h('b', null, String(req.headers.length))),
        h('span', { class: 'dt-stat' }, 'Body ', h('b', null, req.body ? (req.body.type === 'multipart' ? `multipart (${req.body.parts.length} parts)` : req.body.type) : 'none')),
        req.auth ? h('span', { class: 'dt-stat' }, 'Auth ', h('b', null, 'Basic')) : null,
        req.options.followRedirects ? h('span', { class: 'dt-stat' }, h('b', null, 'Follows redirects')) : null,
        req.options.timeout ? h('span', { class: 'dt-stat' }, 'Timeout ', h('b', null, req.options.timeout + ' s')) : null,
        req.options.insecure ? h('span', { class: 'dt-badge is-warn' }, 'TLS checks off (-k)') : null,
        h('span', { class: 'dt-stat' }, 'Syntax ', h('b', null, { bash: 'Bash', powershell: 'PowerShell', cmd: 'CMD' }[req.dialect])),
      ),
    );
    // warnings / info — never hidden from the user
    clear(warnBox);
    warnBox.hidden = !(req.warnings.length || req.info.length);
    if (req.warnings.length) warnBox.appendChild(h('div', { class: 'dt-msg is-warn' }, h('strong', null, `${req.warnings.length} warning${req.warnings.length > 1 ? 's' : ''} — not everything could be converted`), h('ul', { class: 'cc-list' }, req.warnings.map((w) => h('li', null, w)))));
    if (req.info.length) warnBox.appendChild(h('div', { class: 'dt-msg is-info' }, h('strong', null, 'Notes'), h('ul', { class: 'cc-list' }, req.info.map((w) => h('li', null, w)))));
    render();
  }

  const live = debounce(() => run(false), 350);
  input.ta.addEventListener('input', live);
  input.ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(true); } });

  root.append(
    input.el,
    toolbar(primary('Convert', () => run(true), { 'data-act': 'convert' }), dialect, redirects),
    msg.el, summary, warnBox,
    h('div', { class: 'cc-langs' }, langTabs.el),
    out.el,
    langNotes,
    h('p', { class: 'dt-note' }, 'Supports quotes, $\'…\' strings, line continuations (\\ ` ^), combined flags like -sSL, -d/--data-*, --json, -F, -u, -G, -L, -k, --compressed, timeouts and proxies. The command is parsed in your browser and never executed or uploaded.'),
  );
  if (input.get()) run();
  return () => live.cancel();
}
