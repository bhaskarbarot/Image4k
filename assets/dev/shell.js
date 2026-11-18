/* Page shell for /dev, /api-tools and /workbench: sidebar + search + hash routing.
 * Each tool lives in assets/dev/tools/<id>.js and is imported only when opened (lazy). */
import { CATEGORIES, TOOLS, toolById, toolUrl } from './registry.js';
import { h, clear, toast } from './ui.js';

const app = document.getElementById('dt-app');
const CAT = app.dataset.cat;
const SINGLE = app.dataset.single || null; // workbench page shows one tool, no sidebar
const baseTitle = document.title;
const baseDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
let current = null; // { id, cleanup }
let navToken = 0;

const catTools = TOOLS.filter((t) => t.cat === CAT);

/* ---------- layout ---------- */
const search = h('input', {
  type: 'search', class: 'dt-input dt-search', placeholder: 'Search all tools…',
  attrs: { 'aria-label': 'Search tools', autocomplete: 'off', spellcheck: 'false' },
});
const nav = h('nav', { class: 'dt-nav', attrs: { 'aria-label': CATEGORIES[CAT].name } });
const sideToggle = h('button', { type: 'button', class: 'dt-side-toggle', attrs: { 'aria-expanded': 'false' } }, 'All tools ▾');
const side = h('aside', { class: 'dt-side' }, search, nav);
const main = h('div', { class: 'dt-main', attrs: { tabindex: '-1' } });

clear(app);
if (SINGLE) {
  app.classList.add('is-single');
  app.appendChild(main);
} else {
  app.append(sideToggle, side, main);
}
sideToggle.addEventListener('click', () => {
  const open = !side.classList.contains('is-open');
  side.classList.toggle('is-open', open);
  sideToggle.setAttribute('aria-expanded', open);
});

function renderNav(q = '') {
  clear(nav);
  const query = q.trim().toLowerCase();
  const match = (t) => !query || (t.name + ' ' + t.desc + ' ' + (t.keywords || '') + ' ' + t.id).toLowerCase().includes(query);
  const groups = new Map();
  for (const t of catTools.filter(match)) {
    if (!groups.has(t.group)) groups.set(t.group, []);
    groups.get(t.group).push(t);
  }
  for (const [g, list] of groups) {
    nav.appendChild(h('div', { class: 'dt-nav-group' }, g));
    for (const t of list) nav.appendChild(navLink(t, t.id === current?.id));
  }
  if (query) {
    const others = TOOLS.filter((t) => t.cat !== CAT && match(t));
    if (others.length) {
      nav.appendChild(h('div', { class: 'dt-nav-group' }, 'Other categories'));
      for (const t of others) nav.appendChild(navLink(t, false, true));
    }
    if (!groups.size && !others.length) nav.appendChild(h('p', { class: 'dt-nav-empty' }, 'No tool matches “' + q.trim() + '”.'));
  } else {
    nav.appendChild(h('div', { class: 'dt-nav-group' }, 'More from Professional Developer'));
    for (const c of Object.values(CATEGORIES)) if (c.id !== CAT) nav.appendChild(h('a', { class: 'dt-nav-link is-ext', href: c.page }, c.name));
    nav.appendChild(h('a', { class: 'dt-nav-link is-ext', href: '/qr' }, 'QR Code Generator'));
    nav.appendChild(h('a', { class: 'dt-nav-link is-ext', href: '/image' }, 'Image tools'));
    nav.appendChild(h('a', { class: 'dt-nav-link is-ext', href: '/pdf' }, 'PDF tools'));
  }
}
function navLink(t, active, ext) {
  return h('a', {
    class: 'dt-nav-link' + (active ? ' is-active' : '') + (ext ? ' is-ext' : ''),
    href: ext ? toolUrl(t) : '#' + t.id,
    attrs: { 'aria-current': active ? 'page' : null },
    on: { click: () => { side.classList.remove('is-open'); sideToggle.setAttribute('aria-expanded', 'false'); } },
  }, t.name);
}
search.addEventListener('input', () => renderNav(search.value));
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = nav.querySelector('a.dt-nav-link'); if (first) { first.click(); if (!first.classList.contains('is-ext')) location.hash = first.getAttribute('href'); } }
});
// "/" focuses search (like many dev tools), unless typing in a field
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !SINGLE && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    e.preventDefault(); search.focus();
  }
});

/* ---------- overview (no tool selected) ---------- */
function renderOverview() {
  const c = CATEGORIES[CAT];
  const grid = h('div', { class: 'dt-overview' });
  for (const t of catTools) {
    grid.appendChild(h('a', { class: 'dt-ov-card', href: '#' + t.id },
      h('span', { class: 'dt-ov-group' }, t.group), h('strong', null, t.name), h('span', null, t.desc)));
  }
  return h('div', null,
    h('header', { class: 'dt-tool-head' }, h('h1', null, c.name), h('p', null, c.blurb)),
    grid);
}

/* ---------- routing ---------- */
async function route() {
  const id = SINGLE || decodeURIComponent(location.hash.slice(1));
  const t = id && toolById(id);
  const token = ++navToken;
  if (current?.cleanup) { try { current.cleanup(); } catch (e) { /* ignore */ } }
  current = null;
  clear(main);
  if (!t || t.cat !== CAT) {
    if (id && t) { location.replace(toolUrl(t)); return; } // tool lives on another page
    document.title = baseTitle;
    setDesc(baseDesc);
    main.appendChild(renderOverview());
    renderNav(search.value);
    return;
  }
  current = { id: t.id };
  renderNav(search.value);
  document.title = t.name + ' – Free Online Tool | Professional Developer';
  setDesc(t.desc);
  const root = h('div', { class: 'dt-tool', id: 'tool-' + t.id });
  main.append(
    h('header', { class: 'dt-tool-head' }, h('h1', null, t.name), h('p', null, t.desc)),
    root);
  root.appendChild(h('div', { class: 'dt-loading' }, 'Loading tool…'));
  try {
    const mod = await import('./tools/' + t.id + '.js');
    if (token !== navToken) return; // user navigated away while loading
    clear(root);
    const cleanup = await mod.mount(root, { tool: t, toast });
    if (token === navToken) current.cleanup = typeof cleanup === 'function' ? cleanup : null;
    else if (typeof cleanup === 'function') cleanup();
  } catch (err) {
    if (token !== navToken) return;
    console.error(err);
    clear(root);
    root.appendChild(h('div', { class: 'dt-msg is-err', attrs: { role: 'alert' } },
      h('strong', null, 'This tool could not be loaded.'),
      h('div', { class: 'dt-msg-detail' }, String(err && err.message || err)),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: { marginTop: '10px' }, on: { click: () => location.reload() } }, 'Reload page')));
  }
  if (!SINGLE && window.matchMedia('(max-width: 899px)').matches) main.scrollIntoView({ block: 'start' });
}
function setDesc(d) { const m = document.querySelector('meta[name="description"]'); if (m) m.setAttribute('content', d); }

window.addEventListener('hashchange', route);
// Last-resort error boundary: unexpected errors inside a tool surface as a toast instead of failing silently.
window.addEventListener('error', (e) => { if (e.error) toast('Unexpected error: ' + (e.error.message || e.message), 'err', 5000); });
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason; if (r && (r.cancelled || r.name === 'AbortError')) return;
  toast('Unexpected error: ' + (r && r.message || r), 'err', 5000);
});
renderNav();
route();
// test hook
window.__devShell = { route, TOOLS };
