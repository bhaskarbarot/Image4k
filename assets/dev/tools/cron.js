/* Cron Expression Generator — build, explain and preview cron schedules. */
import { h, msgBox, seg, select, btn, store, debounce, card, note, copyText, clear, checkbox, toolbar } from '../ui.js';
import { parseCron, nextRuns, describe, FIELDS, PRESETS, MONTH_NAMES, DAY_NAMES, CronError } from '../lib/cron.js';
import { relativeTime } from '../lib/jwt.js';

const ALLOWED = {
  second: '0–59', minute: '0–59', hour: '0–23', dom: '1–31', month: '1–12 or JAN–DEC', dow: '0–7 or SUN–SAT (0 and 7 = Sunday)',
};
const CHIP_LABEL = {
  hour: (v) => String(v).padStart(2, '0'), dom: String, month: (v) => MONTH_NAMES[v - 1].slice(0, 3), dow: (v) => DAY_NAMES[v].slice(0, 3),
};

export function mount(root) {
  const st = store.get('cron', { expr: '*/15 9-17 * * 1-5', utc: false, count: 10 });
  const save = () => store.set('cron', st);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const msg = msgBox();

  const exprIn = h('input', { class: 'dt-input cron-expr', value: st.expr, attrs: { 'aria-label': 'Cron expression', spellcheck: 'false', autocomplete: 'off' } });
  const descEl = h('p', { class: 'cron-desc', attrs: { 'aria-live': 'polite' } });
  const presetSel = select([['', 'Presets…'], ...PRESETS.map(([n, e]) => [e, `${n}  —  ${e}`])], '', (v) => { if (v) { setExpr(v); presetSel.value = ''; } });
  const tzSeg = seg([['local', `Local (${zone})`], ['utc', 'UTC']], st.utc ? 'utc' : 'local', (v) => { st.utc = v === 'utc'; save(); update(); }, 'Time zone');
  const countSel = select([['5', 'Next 5'], ['10', 'Next 10'], ['20', 'Next 20'], ['50', 'Next 50']], String(st.count), (v) => { st.count = Number(v); save(); update(); });
  const fieldTable = h('div');
  const runsEl = h('ol', { class: 'cron-runs' });
  const secToggle = checkbox('Include seconds (6-field)', false, (on) => {
    const toks = exprIn.value.trim().split(/\s+/);
    if (on && toks.length === 5) setExpr('0 ' + toks.join(' '));
    else if (!on && toks.length === 6) setExpr(toks.slice(1).join(' '));
  });

  function setExpr(v) { exprIn.value = v; update(); }

  /* ---- visual builder ---- */
  const builder = h('div', { class: 'cron-builder' });
  const rows = {};
  function buildRow(key) {
    const spec = FIELDS[key];
    const mode = select([['every', `Every ${spec.unit}`], ['step', `Every N ${spec.unit === 'day of the week' ? 'days' : spec.unit + 's'}`], ['specific', 'Specific values'], ['range', 'Range'], ['custom', 'Custom']], 'every');
    const stepIn = h('input', { type: 'number', class: 'dt-input cron-num', min: '1', max: String(spec.max), value: key === 'minute' ? '15' : '2', attrs: { 'aria-label': spec.name + ' step' } });
    const max = key === 'dow' ? 6 : spec.max;
    const opts = []; for (let v = spec.min; v <= max; v++) opts.push([String(v), CHIP_LABEL[key] ? CHIP_LABEL[key](v) : String(v)]);
    const from = select(opts, String(spec.min)), to = select(opts, String(max));
    let chips = null, listIn = null;
    if (CHIP_LABEL[key]) {
      chips = h('div', { class: 'cron-chips', attrs: { role: 'group', 'aria-label': spec.name + ' values' } });
      for (const [v, l] of opts) chips.appendChild(h('button', { type: 'button', class: 'cron-chip', dataset: { v }, attrs: { 'aria-pressed': 'false' }, on: { click: (e) => { const b = e.currentTarget; b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); compose(); } } }, l));
    } else {
      listIn = h('input', { class: 'dt-input cron-list', placeholder: 'e.g. 0,15,30,45', attrs: { 'aria-label': spec.name + ' values', spellcheck: 'false' } });
      listIn.addEventListener('input', debounce(compose, 300));
    }
    const rawIn = h('input', { class: 'dt-input cron-raw', attrs: { 'aria-label': spec.name + ' custom', spellcheck: 'false' } });
    rawIn.addEventListener('input', debounce(compose, 300));
    const extra = h('div', { class: 'cron-extra' });
    const showExtra = () => {
      clear(extra);
      if (mode.value === 'step') extra.append('every ', stepIn, ' ', spec.unit === 'day of the week' ? 'days' : spec.unit + 's');
      else if (mode.value === 'specific') extra.append(chips || listIn);
      else if (mode.value === 'range') extra.append('from ', from, ' to ', to);
      else if (mode.value === 'custom') extra.append(rawIn);
    };
    mode.addEventListener('change', () => { showExtra(); compose(); });
    for (const x of [stepIn, from, to]) x.addEventListener('change', compose);
    stepIn.addEventListener('input', debounce(compose, 300));
    const el = h('div', { class: 'cron-row', dataset: { key } }, h('span', { class: 'cron-row-name' }, spec.name), mode, extra);
    const api = {
      el,
      value() {
        switch (mode.value) {
          case 'every': return '*';
          case 'step': return '*/' + Math.max(1, Math.min(spec.max, Number(stepIn.value) || 1));
          case 'specific': {
            const vals = chips ? Array.from(chips.children).filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.v) : listIn.value.split(',').map((x) => x.trim()).filter(Boolean);
            return vals.length ? vals.join(',') : '*';
          }
          case 'range': return Number(from.value) <= Number(to.value) ? `${from.value}-${to.value}` : `${to.value}-${from.value}`;
          default: return rawIn.value.trim() || '*';
        }
      },
      set(raw) {
        let m;
        // reset stale selections so switching modes later never resurrects values from an older expression
        if (chips) for (const b of chips.children) b.setAttribute('aria-pressed', 'false'); else listIn.value = '';
        if (raw === '*' || raw === '?') mode.value = 'every';
        else if ((m = /^\*\/(\d+)$/.exec(raw))) { mode.value = 'step'; stepIn.value = m[1]; }
        else if ((m = /^(\d+)-(\d+)$/.exec(raw)) && opts.some(([v]) => v === m[1]) && opts.some(([v]) => v === m[2])) { mode.value = 'range'; from.value = m[1]; to.value = m[2]; }
        else if (/^\d+(,\d+)*$/.test(raw)) {
          mode.value = 'specific';
          const set = new Set(raw.split(',').map((x) => String(key === 'dow' && x === '7' ? 0 : Number(x))));
          if (chips) for (const b of chips.children) b.setAttribute('aria-pressed', set.has(b.dataset.v)); else listIn.value = raw;
        } else { mode.value = 'custom'; rawIn.value = raw; }
        showExtra();
      },
    };
    showExtra();
    return api;
  }
  for (const k of ['second', 'minute', 'hour', 'dom', 'month', 'dow']) { rows[k] = buildRow(k); builder.appendChild(rows[k].el); }

  let syncing = false;
  function compose() {
    if (syncing) return;
    const keys = secToggle.input.checked ? ['second', 'minute', 'hour', 'dom', 'month', 'dow'] : ['minute', 'hour', 'dom', 'month', 'dow'];
    exprIn.value = keys.map((k) => rows[k].value()).join(' ');
    update(true);
  }

  function update(fromBuilder) {
    st.expr = exprIn.value; save();
    msg.hide(); clear(fieldTable); clear(runsEl);
    exprIn.classList.remove('is-bad');
    let c;
    try { c = parseCron(exprIn.value); } catch (e) {
      exprIn.classList.add('is-bad');
      descEl.textContent = '—';
      if (e instanceof CronError) {
        msg.error('Invalid cron expression', e.errors.map((x) => (x.field ? `${x.field}: ${x.message}` : x.message)).join('\n'));
        renderFieldTable(null, e.errors);
      } else msg.error('Invalid cron expression', e.message);
      return;
    }
    descEl.textContent = describe(c);
    if (c.macro) msg.info(`${c.macro} = ${c.normalized}`);
    renderFieldTable(c, []);
    if (!fromBuilder) {
      syncing = true;
      secToggle.input.checked = c.hasSeconds;
      rows.second.el.hidden = !c.hasSeconds;
      const toks = c.normalized.split(' ');
      const keys = c.hasSeconds ? ['second', 'minute', 'hour', 'dom', 'month', 'dow'] : ['minute', 'hour', 'dom', 'month', 'dow'];
      keys.forEach((k, i) => rows[k].set(toks[i]));
      syncing = false;
    } else rows.second.el.hidden = !secToggle.input.checked;
    const r = nextRuns(c, { count: st.count, utc: st.utc });
    if (r.never) { runsEl.appendChild(h('li', { class: 'cron-never' }, 'This schedule never runs — no date matches (for example, 31 February).')); return; }
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: c.hasSeconds ? '2-digit' : undefined, hourCycle: 'h23', timeZone: st.utc ? 'UTC' : undefined });
    const now = Date.now();
    for (const d of r.runs) runsEl.appendChild(h('li', null, h('time', { dateTime: d.toISOString() }, fmt.format(d)), h('span', { class: 'dt-hint' }, ' · ' + relativeTime(d.getTime() - now))));
  }
  function renderFieldTable(c, errors) {
    const toks = exprIn.value.trim().replace(/^@\w+$/, (m) => (c ? c.normalized : m)).split(/\s+/);
    const keys = toks.length === 6 ? ['second', 'minute', 'hour', 'dom', 'month', 'dow'] : ['minute', 'hour', 'dom', 'month', 'dow'];
    const tb = h('tbody');
    keys.forEach((k, i) => {
      const err = errors.find((e) => e.key === k);
      const vals = c && c.fields[k].values;
      const shown = vals ? (vals.length === FIELDS[k].max - FIELDS[k].min + 1 || (k === 'dow' && vals.length === 7) ? 'every value' : vals.map((v) => (k === 'month' ? MONTH_NAMES[v - 1].slice(0, 3) : k === 'dow' ? DAY_NAMES[v].slice(0, 3) : v)).join(', ')) : '';
      tb.appendChild(h('tr', { class: err ? 'cron-bad' : '' }, h('th', { attrs: { scope: 'row' } }, FIELDS[k].name), h('td', { class: 'mono' }, toks[i] ?? ''), h('td', null, err ? h('span', { class: 'cron-err' }, err.message) : shown), h('td', { class: 'dt-hint' }, ALLOWED[k])));
    });
    fieldTable.appendChild(h('div', { class: 'dt-table-wrap' }, h('table', { class: 'dt-table' }, h('thead', null, h('tr', null, h('th', null, 'Field'), h('th', null, 'Value'), h('th', null, 'Matches'), h('th', null, 'Allowed'))), tb)));
  }
  const live = debounce(() => update(false), 200);
  exprIn.addEventListener('input', live);

  root.append(
    h('div', { class: 'cron-top' }, exprIn, btn('Copy', (e) => copyText(exprIn.value.trim(), e.currentTarget), 'btn btn-primary btn-sm', { 'data-act': 'copy' })),
    descEl,
    toolbar(presetSel, secToggle),
    msg.el,
    card('Fields', fieldTable),
    h('div', { class: 'dt-grid2' },
      card('Build visually', builder),
      card('Next runs', toolbar(tzSeg, countSel), runsEl,
        h('p', { class: 'dt-note' }, `Times are calculated in ${st.utc ? 'UTC' : zone} for preview. Cron runs in the time zone of the machine (or the service setting, e.g. CRON_TZ / Kubernetes timeZone / GitHub Actions = UTC), which is often UTC on servers — check yours.`))),
    note('Standard Unix (Vixie) cron: minute hour day-of-month month day-of-week. If both day fields are restricted, a day matches when EITHER matches. A leading 6th field means seconds (Spring, node-cron style). Quartz extensions (L, W, #, year) are not supported.'),
  );
  update(false);
  return () => live.cancel();
}
