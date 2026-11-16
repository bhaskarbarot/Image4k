/* Mock data generator — deterministic (seeded) so the same seed + schema always gives identical output.
 * All word lists below were written for this project (no third-party data sets). Output is FAKE data. */

/* ---------- seeded PRNG ---------- */
function hashSeed(str) {
  // cyrb128-style string hash → 32-bit seed
  let h1 = 1779033703, h2 = 3144134277;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ k, 597399067);
    h2 = Math.imul(h2 ^ k, 2869860233);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 18), 597399067) ^ Math.imul(h2 ^ (h2 >>> 22), 2869860233);
  return (h1 ^ (h1 >>> 16)) >>> 0;
}
/** createRng(seed) → { next() [0,1), int(min,max), pick(arr), chance(p) } — mulberry32 */
export function createRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(String(seed ?? ''));
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max) => next() * (max - min) + min,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}
export function randomSeed() {
  const b = new Uint32Array(1);
  (globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : (b[0] = Math.floor(Math.random() * 2 ** 32));
  return b[0].toString(36);
}

/* ---------- word lists (original) ---------- */
const FIRST = ['Aarav', 'Maya', 'Liam', 'Sofia', 'Kenji', 'Amara', 'Noah', 'Ishita', 'Mateo', 'Leila', 'Ethan', 'Priya', 'Lucas', 'Chloe', 'Omar', 'Hana', 'Daniel', 'Zara', 'Arjun', 'Elena', 'Kofi', 'Nina', 'Samuel', 'Aisha', 'Ravi', 'Grace', 'Diego', 'Mei', 'Jonas', 'Fatima', 'Leo', 'Anika', 'Tomas', 'Yara', 'Felix', 'Kavya', 'Hugo', 'Sara', 'Ivan', 'Nora', 'Bhavin', 'Olivia', 'Mason', 'Riya', 'Theo', 'Lina', 'Andre', 'Asha', 'Victor', 'Emma'];
const LAST = ['Patel', 'Garcia', 'Smith', 'Tanaka', 'Okafor', 'Müller', 'Rossi', 'Barot', 'Kim', 'Nguyen', 'Silva', 'Johnson', 'Haddad', 'Novak', 'Sharma', 'Larsen', 'Moreau', 'Kowalski', 'Mensah', 'Fischer', 'Ahmed', 'Brown', 'Costa', 'Ito', 'Desai', 'Lopez', 'Wilson', 'Petrov', 'Andersen', 'Mehta', 'Clarke', 'Dubois', 'Yilmaz', 'Reyes', 'Walker', 'Joshi', 'Schmidt', 'Okeke', 'Bianchi', 'Turner'];
const CO_A = ['Blue', 'Bright', 'North', 'Silver', 'Quantum', 'Green', 'Rapid', 'Clear', 'Prime', 'Urban', 'Solid', 'Swift', 'Lunar', 'Coral', 'Summit', 'Vertex', 'Pixel', 'Harbor', 'Cedar', 'Nova'];
const CO_B = ['Labs', 'Systems', 'Works', 'Logistics', 'Analytics', 'Studio', 'Foods', 'Energy', 'Networks', 'Health', 'Robotics', 'Media', 'Finance', 'Supply', 'Cloud', 'Motors', 'Designs', 'Ventures', 'Textiles', 'Software'];
const CO_SUFFIX = ['Inc.', 'Ltd', 'LLC', 'GmbH', 'Pvt Ltd', 'Co.', 'Group', ''];
const JOBS = ['Software Engineer', 'Product Manager', 'Data Analyst', 'UX Designer', 'DevOps Engineer', 'Accountant', 'Sales Manager', 'QA Engineer', 'Marketing Lead', 'Customer Success Manager', 'Data Scientist', 'Technical Writer', 'Security Analyst', 'HR Partner', 'Operations Manager', 'Solutions Architect', 'Mobile Developer', 'Support Specialist', 'Content Strategist', 'Finance Director'];
const STREET_A = ['Maple', 'Lake', 'Station', 'Market', 'Garden', 'Hill', 'River', 'Park', 'Church', 'Mill', 'Sunset', 'Oak', 'Harbour', 'King', 'Temple', 'Bridge', 'Forest', 'College', 'Spring', 'Victoria'];
const STREET_B = ['Street', 'Road', 'Avenue', 'Lane', 'Drive', 'Way', 'Boulevard', 'Court', 'Place', 'Terrace'];
// [city, state/region, country, country code, lat, lon]
const CITIES = [
  ['Ahmedabad', 'Gujarat', 'India', 'IN', 23.02, 72.57], ['Mumbai', 'Maharashtra', 'India', 'IN', 19.08, 72.88], ['Bengaluru', 'Karnataka', 'India', 'IN', 12.97, 77.59],
  ['Austin', 'Texas', 'United States', 'US', 30.27, -97.74], ['Seattle', 'Washington', 'United States', 'US', 47.61, -122.33], ['Boston', 'Massachusetts', 'United States', 'US', 42.36, -71.06],
  ['Toronto', 'Ontario', 'Canada', 'CA', 43.65, -79.38], ['Manchester', 'England', 'United Kingdom', 'GB', 53.48, -2.24], ['Berlin', 'Berlin', 'Germany', 'DE', 52.52, 13.4],
  ['Lyon', 'Auvergne-Rhône-Alpes', 'France', 'FR', 45.76, 4.84], ['Milan', 'Lombardy', 'Italy', 'IT', 45.46, 9.19], ['Valencia', 'Valencian Community', 'Spain', 'ES', 39.47, -0.38],
  ['Osaka', 'Osaka', 'Japan', 'JP', 34.69, 135.5], ['Seoul', 'Seoul', 'South Korea', 'KR', 37.57, 126.98], ['Sydney', 'New South Wales', 'Australia', 'AU', -33.87, 151.21],
  ['Auckland', 'Auckland', 'New Zealand', 'NZ', -36.85, 174.76], ['São Paulo', 'São Paulo', 'Brazil', 'BR', -23.55, -46.63], ['Nairobi', 'Nairobi County', 'Kenya', 'KE', -1.29, 36.82],
  ['Lagos', 'Lagos', 'Nigeria', 'NG', 6.52, 3.38], ['Dubai', 'Dubai', 'United Arab Emirates', 'AE', 25.2, 55.27], ['Singapore', 'Singapore', 'Singapore', 'SG', 1.35, 103.82],
  ['Amsterdam', 'North Holland', 'Netherlands', 'NL', 52.37, 4.9], ['Stockholm', 'Stockholm County', 'Sweden', 'SE', 59.33, 18.07], ['Mexico City', 'CDMX', 'Mexico', 'MX', 19.43, -99.13],
];
const TLDS = ['com', 'io', 'net', 'org', 'dev', 'co', 'app', 'tech'];
const MAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'mail.test', 'inbox.test'];
// pseudo-Latin filler (original list)
const LOREM = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'velit', 'magna', 'porta', 'nunc', 'tempor', 'lacus', 'vitae', 'fusce', 'nulla', 'orci', 'cursus', 'massa', 'ultra', 'quam', 'risus', 'sed', 'diam', 'erat', 'felis', 'justo', 'morbi', 'netus', 'odio', 'pede', 'sapien', 'turpis', 'urna', 'varius', 'augue', 'blandit', 'congue', 'dapibus', 'eget', 'gravida', 'luctus', 'mauris', 'nisi', 'pretium', 'rhoncus', 'semper', 'tellus', 'viverra', 'aliquet', 'cras', 'donec'];

export const FIELD_TYPES = [
  ['id', 'Auto-increment ID'], ['uuid', 'UUID v4'], ['firstName', 'First name'], ['lastName', 'Last name'], ['fullName', 'Full name'],
  ['username', 'Username'], ['email', 'Email'], ['phone', 'Phone'], ['company', 'Company'], ['jobTitle', 'Job title'],
  ['street', 'Street address'], ['city', 'City'], ['state', 'State / region'], ['country', 'Country'], ['zip', 'ZIP / postal code'],
  ['latitude', 'Latitude'], ['longitude', 'Longitude'], ['url', 'URL'], ['domain', 'Domain'], ['ipv4', 'IPv4'], ['ipv6', 'IPv6'],
  ['color', 'Hex colour'], ['boolean', 'Boolean'], ['integer', 'Integer'], ['float', 'Float'], ['price', 'Price'],
  ['date', 'Date'], ['datetime', 'Date-time (ISO)'], ['past', 'Past date-time'], ['future', 'Future date-time'], ['enum', 'One of (enum)'],
  ['word', 'Lorem word'], ['sentence', 'Lorem sentence'], ['paragraph', 'Lorem paragraph'], ['object', 'Nested object'], ['array', 'Array'],
];
const TYPE_SET = new Set(FIELD_TYPES.map((t) => t[0]));

/** Default options per type (used by the UI and when options are missing). */
export const DEFAULTS = {
  id: { start: 1 }, boolean: { truePct: 50 }, integer: { min: 0, max: 1000 }, float: { min: 0, max: 100, decimals: 2 },
  price: { min: 1, max: 500 }, date: { from: '2020-01-01', to: '2026-12-31' }, datetime: { from: '2020-01-01', to: '2026-12-31' },
  past: { days: 365 }, future: { days: 365 }, enum: { values: 'active, pending, disabled' }, array: { min: 1, max: 3 },
};

/* ---------- validation ---------- */
const MAX_COUNT = 10000;
/** validateSchema({fields, count}) → array of error strings ([] = valid) */
export function validateSchema(schema) {
  const errs = [];
  if (!schema || typeof schema !== 'object') return ['Schema must be an object with a "fields" array.'];
  const count = schema.count ?? 10;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) errs.push(`"count" must be a whole number from 1 to ${MAX_COUNT}.`);
  if (schema.now !== undefined && isNaN(Date.parse(schema.now))) errs.push(`"now" must be a date (e.g. 2026-01-31).`);
  const check = (fields, at, depth) => {
    if (!Array.isArray(fields) || !fields.length) { errs.push(`${at}: "fields" must be a non-empty array.`); return; }
    if (depth > 6) { errs.push(`${at}: nesting is limited to 6 levels.`); return; }
    const names = new Set();
    fields.forEach((f, i) => {
      const where = `${at}[${i}]${f && f.name ? ` "${f.name}"` : ''}`;
      if (!f || typeof f !== 'object') { errs.push(`${where}: field must be an object.`); return; }
      if (!f.name || typeof f.name !== 'string') errs.push(`${where}: field needs a "name".`);
      else if (names.has(f.name)) errs.push(`${where}: duplicate field name.`);
      names.add(f.name);
      checkType(f, where, depth);
    });
  };
  const checkType = (f, where, depth) => {
    if (!TYPE_SET.has(f.type)) { errs.push(`${where}: unknown type "${f.type}".`); return; }
    const o = { ...(DEFAULTS[f.type] || {}), ...f };
    if (f.nullable !== undefined && !(f.nullable >= 0 && f.nullable <= 100)) errs.push(`${where}: "nullable" must be a percentage 0–100.`);
    if (['integer', 'float', 'price'].includes(f.type)) {
      if (!Number.isFinite(Number(o.min)) || !Number.isFinite(Number(o.max))) errs.push(`${where}: min and max must be numbers.`);
      else if (Number(o.min) > Number(o.max)) errs.push(`${where}: min (${o.min}) is greater than max (${o.max}).`);
    }
    if (f.type === 'float' && !(Number(o.decimals) >= 0 && Number(o.decimals) <= 10)) errs.push(`${where}: decimals must be 0–10.`);
    if (f.type === 'boolean' && !(Number(o.truePct) >= 0 && Number(o.truePct) <= 100)) errs.push(`${where}: truePct must be 0–100.`);
    if (f.type === 'date' || f.type === 'datetime') {
      if (isNaN(Date.parse(o.from)) || isNaN(Date.parse(o.to))) errs.push(`${where}: "from" and "to" must be dates (YYYY-MM-DD).`);
      else if (Date.parse(o.from) > Date.parse(o.to)) errs.push(`${where}: "from" is after "to".`);
    }
    if ((f.type === 'past' || f.type === 'future') && !(Number(o.days) > 0)) errs.push(`${where}: "days" must be greater than 0.`);
    if (f.type === 'enum') {
      const vals = Array.isArray(o.values) ? o.values : String(o.values || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!vals.length) errs.push(`${where}: enum needs at least one value.`);
    }
    if (f.type === 'object') check(f.fields, where + '.fields', depth + 1);
    if (f.type === 'array') {
      if (!Number.isInteger(Number(o.min)) || !Number.isInteger(Number(o.max)) || Number(o.min) < 0 || Number(o.min) > Number(o.max) || Number(o.max) > 100) errs.push(`${where}: array min/max must be whole numbers with 0 ≤ min ≤ max ≤ 100.`);
      if (!f.of || typeof f.of !== 'object') errs.push(`${where}: array needs "of" (the item type).`);
      else checkType({ name: 'item', ...f.of }, where + '.of', depth + 1);
    }
  };
  check(schema.fields, 'fields', 0);
  return errs;
}

/* ---------- generators ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const hex = (rng, n) => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[rng.int(0, 15)]; return s; };
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function person(rng, ctx) {
  if (!ctx.person) {
    const first = rng.pick(FIRST), last = rng.pick(LAST);
    ctx.person = { first, last, user: slug(first) + (rng.chance(0.5) ? '.' : '_') + slug(last) + (rng.chance(0.5) ? rng.int(1, 99) : '') };
  }
  return ctx.person;
}
function place(rng, ctx) { if (!ctx.place) ctx.place = rng.pick(CITIES); return ctx.place; }
function company(rng, ctx) { if (!ctx.company) { const s = rng.pick(CO_SUFFIX); ctx.company = rng.pick(CO_A) + ' ' + rng.pick(CO_B) + (s ? ' ' + s : ''); } return ctx.company; }
function sentence(rng) {
  const n = rng.int(6, 14);
  const w = Array.from({ length: n }, () => rng.pick(LOREM));
  return cap(w.join(' ')) + '.';
}

function value(f, rng, ctx, index, now) {
  const o = { ...(DEFAULTS[f.type] || {}), ...f };
  if (f.nullable && rng.next() * 100 < Number(f.nullable)) return null;
  switch (f.type) {
    case 'id': return Number(o.start ?? 1) + index;
    case 'uuid': {
      const b = Array.from({ length: 16 }, () => rng.int(0, 255));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const h = b.map((x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
    case 'firstName': return person(rng, ctx).first;
    case 'lastName': return person(rng, ctx).last;
    case 'fullName': { const p = person(rng, ctx); return p.first + ' ' + p.last; }
    case 'username': return person(rng, ctx).user;
    case 'email': { const p = person(rng, ctx); return `${slug(p.first)}.${slug(p.last)}@${ctx.company ? slug(ctx.company.split(' ').slice(0, 2).join('')) + '.example.com' : rng.pick(MAIL_DOMAINS)}`; }
    case 'phone': return `+1-${rng.int(201, 989)}-555-01${pad2(rng.int(0, 99))}`; // 555-01xx numbers are reserved for fiction
    case 'company': return company(rng, ctx);
    case 'jobTitle': return rng.pick(JOBS);
    case 'street': return `${rng.int(1, 9999)} ${rng.pick(STREET_A)} ${rng.pick(STREET_B)}`;
    case 'city': return place(rng, ctx)[0];
    case 'state': return place(rng, ctx)[1];
    case 'country': return place(rng, ctx)[2];
    case 'zip': return String(rng.int(10000, 99999));
    case 'latitude': return Math.round((place(rng, ctx)[4] + rng.float(-0.2, 0.2)) * 1e5) / 1e5;
    case 'longitude': return Math.round((place(rng, ctx)[5] + rng.float(-0.2, 0.2)) * 1e5) / 1e5;
    case 'domain': return `${slug(rng.pick(CO_A) + rng.pick(CO_B))}.${rng.pick(TLDS)}`;
    case 'url': return `https://${slug(rng.pick(CO_A) + rng.pick(CO_B))}.${rng.pick(TLDS)}/${rng.pick(LOREM)}${rng.chance(0.5) ? '/' + rng.int(1, 999) : ''}`;
    case 'ipv4': return [rng.int(1, 223), rng.int(0, 255), rng.int(0, 255), rng.int(1, 254)].join('.');
    case 'ipv6': return '2001:db8:' + Array.from({ length: 6 }, () => rng.int(0, 0xffff).toString(16)).join(':'); // 2001:db8::/32 = documentation range
    case 'color': return '#' + hex(rng, 6);
    case 'boolean': return rng.next() * 100 < Number(o.truePct);
    case 'integer': return rng.int(Math.ceil(Number(o.min)), Math.floor(Number(o.max)));
    case 'float': { const d = Number(o.decimals); return Number(rng.float(Number(o.min), Number(o.max)).toFixed(d)); }
    case 'price': return Math.round(rng.float(Number(o.min), Number(o.max)) * 100) / 100;
    case 'date': return iso(rng.float(Date.parse(o.from), Date.parse(o.to) + 864e5 - 1)).slice(0, 10); // "to" day inclusive
    case 'datetime': return iso(Math.floor(rng.float(Date.parse(o.from), Date.parse(o.to) + 864e5) / 1000) * 1000);
    case 'past': return iso(Math.floor((now - rng.float(0, Number(o.days) * 864e5)) / 1000) * 1000);
    case 'future': return iso(Math.floor((now + rng.float(0, Number(o.days) * 864e5)) / 1000) * 1000);
    case 'enum': { const vals = Array.isArray(o.values) ? o.values : String(o.values).split(',').map((s) => s.trim()).filter(Boolean); return rng.pick(vals); }
    case 'word': return rng.pick(LOREM);
    case 'sentence': return sentence(rng);
    case 'paragraph': return Array.from({ length: rng.int(3, 6) }, () => sentence(rng)).join(' ');
    case 'object': return record(f.fields, rng, index, now);
    case 'array': {
      const n = rng.int(Number(o.min), Number(o.max));
      return Array.from({ length: n }, (_, k) => value({ name: 'item', ...f.of }, rng, f.of && f.of.type === 'object' ? {} : ctx, k, now));
    }
    default: return null;
  }
}
function record(fields, rng, index, now) {
  const ctx = {};
  const o = {};
  for (const f of fields) o[f.name] = value(f, rng, ctx, index, now);
  return o;
}

/**
 * generateMock({ fields, count=10, seed='demo', now='2026-01-01' }) → array of records.
 * Throws an Error listing all schema problems if the schema is invalid.
 */
export function generateMock(schema) {
  const errs = validateSchema(schema);
  if (errs.length) { const e = new Error(errs.join('\n')); e.errors = errs; throw e; }
  const rng = createRng(String(schema.seed ?? 'demo'));
  const now = Date.parse(schema.now ?? '2026-01-01T00:00:00Z');
  const count = schema.count ?? 10;
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = record(schema.fields, rng, i, now);
  return out;
}

export const SAMPLE_SCHEMA = {
  seed: 'demo', count: 5,
  fields: [
    { name: 'id', type: 'id', start: 1 },
    { name: 'uuid', type: 'uuid' },
    { name: 'name', type: 'fullName' },
    { name: 'email', type: 'email' },
    { name: 'company', type: 'company' },
    { name: 'active', type: 'boolean', truePct: 80 },
    { name: 'plan', type: 'enum', values: 'free, pro, team' },
    { name: 'created_at', type: 'past', days: 365 },
    { name: 'address', type: 'object', fields: [{ name: 'street', type: 'street' }, { name: 'city', type: 'city' }, { name: 'country', type: 'country' }, { name: 'zip', type: 'zip' }] },
    { name: 'tags', type: 'array', min: 1, max: 3, of: { type: 'word' } },
    { name: 'score', type: 'float', min: 0, max: 5, decimals: 1, nullable: 10 },
  ],
};
