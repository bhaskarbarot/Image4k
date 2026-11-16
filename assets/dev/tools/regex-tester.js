/* Regex Tester — JavaScript regular expressions evaluated in a worker with a hard timeout. */
import { h, editor, msgBox, select, btn, store, debounce, card, note, copyText, clear, runWorker } from '../ui.js';
import { supportedFlags, FLAG_INFO, PRESETS, CHEATSHEET, checkPattern } from '../lib/regex.js';

const TIMEOUT = 1000;
const WORKER_URL = new URL('../workers/regex.worker.js', import.meta.url);
const HIGHLIGHT_MAX = 2000;

export function mount(root) {
  const st = store.get('regex-tester', { pattern: String.raw`(?<user>[\w.+-]+)@(?<domain>[\w-]+(?:\.[\w-]+)+)`, flags: 'g', replace: '', showReplace: false });
  const save = () => store.set('regex-tester', st);
  const FLAGS = supportedFlags();
  const msg = msgBox();
  let job = null;

  const pat = h('input', { class: 'dt-input rx-pattern', value: st.pattern, placeholder: 'Regular expression, e.g. \\d{3}-\\d{4}', attrs: { 'aria-label': 'Pattern', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' } });
  const flagBtns = h('div', { class: 'rx-flags', attrs: { role: 'group', 'aria-label': 'Flags' } });
  for (const f of FLAGS) {
    const b = h('button', { type: 'button', class: 'rx-flag', dataset: { flag: f }, title: FLAG_INFO[f], attrs: { 'aria-pressed': st.flags.includes(f) ? 'true' : 'false' } }, f);
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', on);
      if (on && f === 'u') flagBtns.querySelector('[data-flag=v]')?.setAttribute('aria-pressed', 'false');
      if (on && f === 'v') flagBtns.querySelector('[data-flag=u]')?.setAttribute('aria-pressed', 'false');
      st.flags = FLAGS.filter((x) => flagBtns.querySelector(`[data-flag=${x}]`).getAttribute('aria-pressed') === 'true').join('');
      flagView.textContent = st.flags; save(); live();
    });
    flagBtns.appendChild(b);
  }
  const flagView = h('span', { class: 'rx-flagview' }, st.flags);
  const presetSel = select([['', 'Common patterns…'], ...PRESETS.map((p, i) => [String(i), p.name])], '', (v) => {
    if (v === '') return;
    const p = PRESETS[Number(v)]; pat.value = p.pattern; st.pattern = p.pattern;
    for (const b of flagBtns.children) b.setAttribute('aria-pressed', p.flags.includes(b.dataset.flag));
    st.flags = p.flags; flagView.textContent = p.flags; save(); presetSel.value = ''; run();
  });
  const text = editor({ label: 'Test string', rows: 9, clear: true, paste: true, file: { accept: '.txt,.log,.csv,.json,text/*', max: 20 * 1024 * 1024 }, value: 'Contact: ada.lovelace@example.com, alan@turing.org.uk\nSupport <help@bhaskar.solutions> · invalid: foo@bar' });
  const mirror = h('pre', { class: 'dt-pre rx-mirror', attrs: { tabindex: '0', 'aria-label': 'Matches highlighted' } });
  const status = h('div', { class: 'dt-stats', attrs: { 'aria-live': 'polite' } });
  const matchList = h('div', { class: 'rx-matches' });
  const replIn = h('input', { class: 'dt-input rx-repl', value: st.replace, placeholder: 'Replacement — $1, $<name>, $& (whole match), $$ (literal $)', attrs: { 'aria-label': 'Replacement', spellcheck: 'false' } });
  const replOut = h('pre', { class: 'dt-pre rx-replout', attrs: { tabindex: '0', 'aria-label': 'Replace result' } });
  const replCard = card('Replace', replIn, replOut, h('div', { class: 'dt-toolbar' }, btn('Copy result', (e) => { if (replOut.textContent) copyText(replOut.textContent, e.currentTarget); }, 'dt-mini')));

  function renderMirror(src, matches) {
    clear(mirror);
    if (!src) { mirror.appendChild(h('span', { class: 'dt-empty' }, 'Enter a test string.')); return; }
    const cap = src.length > 300000 ? 300000 : src.length;
    let last = 0, k = 0;
    for (const m of matches) {
      if (k >= HIGHLIGHT_MAX || m.index >= cap) break;
      if (m.index > last) mirror.appendChild(document.createTextNode(src.slice(last, m.index)));
      if (m.end === m.index) mirror.appendChild(h('mark', { class: 'dt-hit rx-empty', title: `Empty match at ${m.index}` }, '​'));
      else mirror.appendChild(h('mark', { class: 'dt-hit' + (k % 2 ? ' alt' : ''), title: `Match ${k + 1} · ${m.index}–${m.end}` }, src.slice(m.index, m.end)));
      last = Math.max(last, m.end); k++;
    }
    mirror.appendChild(document.createTextNode(src.slice(last, cap)));
    if (cap < src.length) mirror.appendChild(h('span', { class: 'dt-empty' }, `\n… preview limited to the first ${cap.toLocaleString()} characters`));
  }
  function renderMatches(r) {
    clear(matchList);
    if (!r.matches.length) { matchList.appendChild(note('No matches.')); return; }
    const rows = [];
    r.matches.slice(0, 500).forEach((m, i) => {
      const groups = m.groups.map((g, gi) => h('div', { class: 'rx-group' }, h('span', { class: 'dt-badge' }, '$' + (gi + 1)), ' ',
        g === undefined ? h('em', { class: 'dt-hint' }, 'undefined') : h('code', null, g),
        m.indices?.[gi + 1] ? h('span', { class: 'dt-hint' }, ` @${m.indices[gi + 1][0]}–${m.indices[gi + 1][1]}`) : null));
      const named = m.named ? Object.entries(m.named).map(([k, v]) => h('div', { class: 'rx-group' }, h('span', { class: 'dt-badge is-info' }, k), ' ',
        v === undefined ? h('em', { class: 'dt-hint' }, 'undefined') : h('code', null, v),
        m.namedIndices?.[k] ? h('span', { class: 'dt-hint' }, ` @${m.namedIndices[k][0]}–${m.namedIndices[k][1]}`) : null)) : [];
      rows.push(h('tr', null, h('td', null, String(i + 1)), h('td', { class: 'mono' }, `${m.index}–${m.end}`), h('td', { class: 'mono rx-mtext' }, m.text || h('em', { class: 'dt-hint' }, '(empty)')), h('td', null, named.length ? named : groups.length ? groups : h('span', { class: 'dt-hint' }, '—'))));
    });
    matchList.appendChild(h('div', { class: 'dt-table-wrap rx-table' }, h('table', { class: 'dt-table' },
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Position'), h('th', null, 'Match'), h('th', null, 'Groups'))), h('tbody', null, rows))));
    if (r.matches.length > 500) matchList.appendChild(note(`Showing the first 500 of ${r.total.toLocaleString()} matches in the table.`));
  }

  async function run() {
    st.pattern = pat.value; st.replace = replIn.value; save();
    if (job) job.cancel();
    msg.hide(); clear(status);
    const src = text.get();
    const pattern = pat.value;
    if (!pattern) { renderMirror(src, []); clear(matchList); matchList.appendChild(note('Enter a pattern.')); replOut.textContent = ''; return; }
    const bad = checkPattern(pattern, st.flags);
    if (bad) { msg.error('Invalid regular expression', bad); status.appendChild(h('span', { class: 'dt-badge is-err' }, '✕ Invalid')); renderMirror(src, []); clear(matchList); return; }
    const t0 = performance.now();
    status.appendChild(h('span', { class: 'dt-stat' }, 'Running…'));
    const thisJob = (job = runWorker(WORKER_URL, { pattern, flags: st.flags, text: src, replace: replIn.value === '' && !st.showReplace ? null : replIn.value, limit: 10000 }, { timeout: TIMEOUT }));
    try {
      const r = await thisJob.promise;
      if (thisJob !== job || !r) return;
      job = null;
      const ms = performance.now() - t0;
      clear(status);
      status.append(h('span', { class: 'dt-badge ' + (r.total ? 'is-ok' : 'is-warn') }, `${r.total.toLocaleString()} match${r.total === 1 ? '' : 'es'}`), h('span', { class: 'dt-stat' }, h('b', null, ms.toFixed(1)), ' ms'));
      if (r.truncated) msg.warn('Stopped at 10 000 matches', 'Only the first 10 000 matches are listed and highlighted.');
      renderMirror(src, r.matches);
      renderMatches(r);
      replOut.textContent = r.replaced ?? src;
    } catch (e) {
      if (e.cancelled || thisJob !== job) return;
      job = null; clear(status);
      if (e.timeout) {
        status.appendChild(h('span', { class: 'dt-badge is-err' }, '⏱ Stopped'));
        msg.error(`Stopped after ${TIMEOUT / 1000} s — this pattern is too slow on this input.`, 'This usually means catastrophic backtracking: nested quantifiers like (a+)+, (\\w*)* or (a|aa)+ followed by something that fails. Make the inner part possessive-like (e.g. [^…]+), anchor it, or remove the nesting. The page stays responsive because matching runs in a separate worker.');
      } else msg.error('Regex error', e.message);
      renderMirror(src, []); clear(matchList);
    }
  }
  const live = debounce(run, 180);
  pat.addEventListener('input', live);
  text.ta.addEventListener('input', live);
  replIn.addEventListener('input', () => { st.showReplace = true; live(); });

  const cheat = h('details', { class: 'rx-cheat' }, h('summary', null, 'Quick reference'),
    h('div', { class: 'dt-table-wrap' }, h('table', { class: 'dt-table' }, h('tbody', null, CHEATSHEET.map(([k, v]) => h('tr', null, h('td', { class: 'mono' }, k), h('td', null, v)))))),
    h('p', { class: 'dt-note' }, 'Flags: ' + FLAGS.map((f) => `${f} = ${FLAG_INFO[f]}`).join(' · ')));

  root.append(
    h('div', { class: 'rx-bar' }, h('span', { class: 'rx-slash' }, '/'), pat, h('span', { class: 'rx-slash' }, '/'), flagView),
    h('div', { class: 'dt-toolbar' }, flagBtns, presetSel, btn('Copy as literal', (e) => copyText(`/${pat.value.replace(/\//g, '\\/')}/${st.flags}`, e.currentTarget), 'dt-mini', { 'data-act': 'copy-regex' }),
      btn('Test', run, 'btn btn-primary btn-sm', { 'data-act': 'run' })),
    msg.el, status,
    h('div', { class: 'dt-grid2' }, text.el, h('div', { class: 'dt-panel' }, h('div', { class: 'dt-panel-head' }, h('span', { class: 'dt-panel-title' }, 'Highlighted matches')), mirror)),
    card('Match details', matchList),
    replCard,
    cheat,
    note('JavaScript (ECMAScript) regex flavour, as in browsers and Node.js. Matching runs in a Web Worker and is stopped after 1 second, so even a catastrophic pattern cannot freeze this page.'),
  );
  run();
  return () => { live.cancel(); if (job) job.cancel(); };
}
