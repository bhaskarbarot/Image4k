/* Cron expressions — parse, validate, describe in English and compute upcoming run times. Pure module.
 * Supports standard 5-field Unix/Vixie cron, a 6-field form with leading seconds, @macros, month/day names,
 * ranges, lists and steps. Vixie semantics: if BOTH day-of-month and day-of-week are restricted (neither
 * starts with '*'), a day matches when EITHER matches; otherwise both must match. */

export class CronError extends Error {
  constructor(errors) {
    super(errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join(' · '));
    this.name = 'CronError'; this.errors = errors;
  }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const FIELDS = {
  second: { key: 'second', name: 'Second', min: 0, max: 59, unit: 'second' },
  minute: { key: 'minute', name: 'Minute', min: 0, max: 59, unit: 'minute' },
  hour: { key: 'hour', name: 'Hour', min: 0, max: 23, unit: 'hour' },
  dom: { key: 'dom', name: 'Day of month', min: 1, max: 31, unit: 'day' },
  month: { key: 'month', name: 'Month', min: 1, max: 12, unit: 'month', names: MONTHS },
  dow: { key: 'dow', name: 'Day of week', min: 0, max: 7, unit: 'day of the week', names: DAYS },
};

export const MACROS = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

function parseValue(tok, spec) {
  if (/^\d+$/.test(tok)) {
    const n = Number(tok);
    if (n < spec.min || n > spec.max) throw new Error(`${n} is out of range (${spec.min}–${spec.max})`);
    return n;
  }
  if (spec.names) {
    const i = spec.names.indexOf(tok.toUpperCase());
    if (i >= 0) return spec.key === 'month' ? i + 1 : i;
    throw new Error(`"${tok}" is not a valid ${spec.key === 'month' ? 'month name (JAN–DEC)' : 'day name (SUN–SAT)'}`);
  }
  throw new Error(`"${tok}" is not a number`);
}

/** parseField('1-5/2,10', spec) → { raw, star, parts:[{type,a,b,step}], values:number[], set:boolean[] } */
export function parseField(raw, spec) {
  if (raw === '') throw new Error('is empty');
  if (/[LW#]/i.test(raw.replace(/[A-Za-z]{3}/g, ''))) throw new Error(`"${raw}" uses L, W or # — those are Quartz extensions, not standard cron`);
  const set = new Array(spec.max + 1).fill(false);
  const parts = [];
  for (const part of raw.split(',')) {
    const m = /^(\*|\?|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not valid syntax (use *, n, a-b, */n, a-b/n or a list)`);
    let a, b, type;
    if (m[1] === '*' || m[1] === '?') {
      if (m[1] === '?' && spec.key !== 'dom' && spec.key !== 'dow') throw new Error('"?" is only allowed in day-of-month / day-of-week');
      a = spec.min; b = spec.key === 'dow' ? 6 : spec.max; type = 'all';
    } else if (m[1].includes('-')) {
      const [x, y] = m[1].split('-');
      a = parseValue(x, spec); b = parseValue(y, spec); type = 'range';
      if (spec.key === 'dow' && b === 7) b = 7;
      if (a > b) throw new Error(`range ${m[1]} is backwards (start must be ≤ end)`);
    } else {
      a = parseValue(m[1], spec); b = a; type = 'value';
      if (m[2]) { b = spec.key === 'dow' ? 6 : spec.max; type = 'from'; }
    }
    let step = 1;
    if (m[2] !== undefined) {
      step = Number(m[2]);
      if (step < 1) throw new Error('step must be at least 1');
      if (step > spec.max - spec.min + 1) throw new Error(`step ${step} is larger than the ${spec.name.toLowerCase()} range`);
      if (type === 'all') type = 'allStep'; else if (type === 'range') type = 'rangeStep';
    }
    for (let v = a; v <= b; v += step) set[spec.key === 'dow' && v === 7 ? 0 : v] = true;
    parts.push({ type, a, b, step });
  }
  if (spec.key === 'dow') set[7] = false;
  const values = [];
  for (let v = spec.min; v <= (spec.key === 'dow' ? 6 : spec.max); v++) if (set[v]) values.push(v);
  return { raw, star: raw[0] === '*' || raw[0] === '?', parts, values, set };
}

/** parseCron(expr) → { expr, normalized, hasSeconds, fields:{second,minute,hour,dom,month,dow}, macro } ; throws CronError */
export function parseCron(expr) {
  let s = String(expr || '').trim().replace(/\s+/g, ' ');
  if (!s) throw new CronError([{ message: 'Enter a cron expression, e.g. "*/5 * * * *".' }]);
  let macro = null;
  if (s[0] === '@') {
    const k = s.toLowerCase();
    if (k === '@reboot') throw new CronError([{ message: '@reboot runs once when the cron daemon starts — it has no schedule to preview.' }]);
    if (!MACROS[k]) throw new CronError([{ message: `Unknown macro "${s}". Use @yearly, @annually, @monthly, @weekly, @daily, @midnight or @hourly.` }]);
    macro = k; s = MACROS[k];
  }
  const toks = s.split(' ');
  if (toks.length === 7) throw new CronError([{ message: '7 fields (seconds … year) is the Quartz format. Use 5 fields (minute hour day month weekday) or 6 with leading seconds.' }]);
  if (toks.length !== 5 && toks.length !== 6) throw new CronError([{ message: `Expected 5 fields (minute hour day-of-month month day-of-week) — found ${toks.length}.` }]);
  const hasSeconds = toks.length === 6;
  const keys = hasSeconds ? ['second', 'minute', 'hour', 'dom', 'month', 'dow'] : ['minute', 'hour', 'dom', 'month', 'dow'];
  const fields = {}, errors = [];
  keys.forEach((k, i) => {
    try { fields[k] = parseField(toks[i], FIELDS[k]); } catch (e) { errors.push({ field: FIELDS[k].name, key: k, index: i, message: e.message }); }
  });
  if (errors.length) throw new CronError(errors);
  if (!hasSeconds) fields.second = parseField('0', FIELDS.second);
  return { expr: String(expr).trim(), normalized: s, hasSeconds, fields, macro };
}

/* ---------- schedule ---------- */
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

function dayMatches(f, date, dow) {
  const domOk = f.dom.set[date], dowOk = f.dow.set[dow];
  if (f.dom.star || f.dow.star) return domOk && dowOk;
  return domOk || dowOk;
}

/** True if the schedule can never fire (e.g. "0 0 31 2 *"). */
export function isImpossible(c) {
  const f = c.fields;
  if (!(f.dow.star && !f.dom.star)) return false;
  return !f.month.values.some((m) => f.dom.values.some((d) => d <= (m === 2 ? 29 : daysIn(2001, m))));
}

/**
 * nextRuns(parsed, { from: Date, count: 10, utc: false }) → { runs: Date[], never: boolean }
 * Skips by field (month → day → hour → minute → second) so even yearly schedules are fast.
 */
export function nextRuns(c, opts = {}) {
  const count = Math.max(1, Math.min(1000, opts.count || 10));
  const utc = !!opts.utc;
  const f = c.fields;
  if (isImpossible(c)) return { runs: [], never: true };
  const G = utc
    ? { Y: (d) => d.getUTCFullYear(), M: (d) => d.getUTCMonth(), D: (d) => d.getUTCDate(), W: (d) => d.getUTCDay(), h: (d) => d.getUTCHours(), m: (d) => d.getUTCMinutes(), s: (d) => d.getUTCSeconds(),
      setMonth: (d, mo) => d.setUTCMonth(mo, 1), setDate: (d, x) => d.setUTCDate(x), setHours: (d, h, m, s) => d.setUTCHours(h, m, s, 0), setMinutes: (d, m, s) => d.setUTCMinutes(m, s, 0), setSeconds: (d, s) => d.setUTCSeconds(s, 0) }
    : { Y: (d) => d.getFullYear(), M: (d) => d.getMonth(), D: (d) => d.getDate(), W: (d) => d.getDay(), h: (d) => d.getHours(), m: (d) => d.getMinutes(), s: (d) => d.getSeconds(),
      setMonth: (d, mo) => d.setMonth(mo, 1), setDate: (d, x) => d.setDate(x), setHours: (d, h, m, s) => d.setHours(h, m, s, 0), setMinutes: (d, m, s) => d.setMinutes(m, s, 0), setSeconds: (d, s) => d.setSeconds(s, 0) };
  const from = opts.from ? new Date(opts.from) : new Date();
  let d = new Date(Math.floor(from.getTime() / 1000) * 1000 + 1000);
  const limit = from.getTime() + 32 * 366 * 864e5; // 32 years covers every leap-day / weekday combination
  const runs = [];
  let guard = 0;
  while (runs.length < count && d.getTime() <= limit && ++guard < 2e6) {
    const before = d.getTime();
    if (!f.month.set[G.M(d) + 1]) { G.setMonth(d, G.M(d) + 1); G.setHours(d, 0, 0, 0); }
    else if (!dayMatches(f, G.D(d), G.W(d))) { G.setDate(d, G.D(d) + 1); G.setHours(d, 0, 0, 0); }
    else if (!f.hour.set[G.h(d)]) {
      const nh = f.hour.values.find((v) => v > G.h(d));
      if (nh === undefined) { G.setDate(d, G.D(d) + 1); G.setHours(d, 0, 0, 0); } else G.setHours(d, nh, 0, 0);
    } else if (!f.minute.set[G.m(d)]) {
      const nm = f.minute.values.find((v) => v > G.m(d));
      if (nm === undefined) G.setHours(d, G.h(d) + 1, 0, 0); else G.setMinutes(d, nm, 0);
    } else if (!f.second.set[G.s(d)]) {
      const ns = f.second.values.find((v) => v > G.s(d));
      if (ns === undefined) G.setMinutes(d, G.m(d) + 1, 0); else G.setSeconds(d, ns);
    } else {
      runs.push(new Date(d));
      G.setSeconds(d, G.s(d) + 1);
    }
    if (d.getTime() <= before) d = new Date(before + 1000); // DST safety: always move forward
  }
  return { runs, never: runs.length === 0 };
}

/* ---------- English description ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
const list = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

function partText(p, spec, label) {
  const nm = (v) => label(v);
  const plural = spec.unit === 'day of the week' ? 'days' : spec.unit + 's';
  switch (p.type) {
    case 'all': return `every ${spec.unit}`;
    case 'allStep': return `every ${p.step} ${plural}`;
    case 'value': return nm(p.a);
    case 'range': return `${nm(p.a)} through ${nm(p.b)}`;
    case 'rangeStep': return `every ${p.step} ${plural} from ${nm(p.a)} through ${nm(p.b)}`;
    case 'from': return `every ${p.step} ${plural} starting at ${nm(p.a)}`;
  }
}
const isSingle = (fl) => fl.parts.length === 1 && fl.parts[0].type === 'value';
const allValues = (fl) => fl.parts.every((p) => p.type === 'value');

export function describe(c) {
  const f = c.fields;
  const out = [];
  const secSingle = isSingle(f.second);
  // time of day
  if (secSingle && isSingle(f.minute) && allValues(f.hour) && f.hour.values.length <= 6) {
    const s = f.second.values[0];
    out.push('At ' + list(f.hour.values.map((h) => `${pad2(h)}:${pad2(f.minute.values[0])}${c.hasSeconds && s ? ':' + pad2(s) : ''}`)));
  } else {
    const bits = [];
    if (c.hasSeconds && !(secSingle && f.second.values[0] === 0)) {
      bits.push(f.second.parts.length === 1 && f.second.parts[0].type !== 'value' ? partText(f.second.parts[0], FIELDS.second, String) : `at second ${list(f.second.parts.map((p) => partText(p, FIELDS.second, String)))}`);
    }
    if (f.minute.raw === '*') { if (!bits.length) bits.push('every minute'); }
    else if (f.minute.parts.length === 1 && f.minute.parts[0].type !== 'value') bits.push(partText(f.minute.parts[0], FIELDS.minute, String));
    else bits.push(`at minute${f.minute.values.length > 1 ? 's' : ''} ${list(f.minute.parts.map((p) => partText(p, FIELDS.minute, String)))}`);
    if (f.hour.raw !== '*') {
      if (f.hour.parts.length === 1 && f.hour.parts[0].type === 'range') bits.push(`between ${pad2(f.hour.parts[0].a)}:00 and ${pad2(f.hour.parts[0].b)}:59`);
      else if (f.hour.parts.length === 1 && f.hour.parts[0].type !== 'value') bits.push('past ' + partText(f.hour.parts[0], FIELDS.hour, (h) => pad2(h) + ':00'));
      else bits.push(`past hour ${list(f.hour.parts.map((p) => partText(p, FIELDS.hour, (h) => pad2(h) + ':00')))}`);
    }
    const t = bits.join(', ');
    out.push(t[0].toUpperCase() + t.slice(1));
  }
  // days
  const domTxt = () => {
    if (f.dom.parts.length === 1 && f.dom.parts[0].type === 'allStep') return `every ${f.dom.parts[0].step} days (from the 1st)`;
    return `on the ${list(f.dom.parts.map((p) => partText(p, FIELDS.dom, ordinal)))} of the month`;
  };
  const dowTxt = () => {
    if (f.dow.parts.length === 1 && f.dow.parts[0].type === 'allStep') return `every ${f.dow.parts[0].step} days of the week (from Sunday)`;
    return 'on ' + list(f.dow.parts.map((p) => partText(p, FIELDS.dow, (v) => DAY_NAMES[v % 7])));
  };
  const domR = f.dom.raw !== '*' && f.dom.raw !== '?', dowR = f.dow.raw !== '*' && f.dow.raw !== '?';
  if (domR && dowR) out.push(!f.dom.star && !f.dow.star ? `${domTxt()} or ${dowTxt()}` : `${domTxt()}, if it is ${dowTxt().replace(/^on /, 'a ')}`);
  else if (domR) out.push(domTxt());
  else if (dowR) out.push(dowTxt());
  // months
  if (f.month.raw !== '*') {
    if (f.month.parts.length === 1 && f.month.parts[0].type === 'allStep') out.push(`every ${f.month.parts[0].step} months`);
    else out.push('in ' + list(f.month.parts.map((p) => partText(p, FIELDS.month, (v) => MONTH_NAMES[v - 1]))));
  }
  return out.join(', ') + '.';
}

export const PRESETS = [
  ['Every minute', '* * * * *'], ['Every 5 minutes', '*/5 * * * *'], ['Every 15 minutes', '*/15 * * * *'], ['Every hour', '0 * * * *'],
  ['Every day at midnight', '0 0 * * *'], ['Every day at 09:30', '30 9 * * *'], ['Weekdays at 09:00', '0 9 * * 1-5'],
  ['Every Sunday at 03:00', '0 3 * * SUN'], ['1st of every month', '0 0 1 * *'], ['Every quarter', '0 0 1 */3 *'],
  ['Every year (1 Jan)', '0 0 1 1 *'], ['Every 30 seconds (6-field)', '*/30 * * * * *'],
];
