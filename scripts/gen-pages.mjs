// Generates dev.html, api-tools.html and workbench.html from assets/dev/registry.js so the
// header, footer, SEO tool list and JSON-LD stay consistent.  Run:  node scripts/gen-pages.mjs
// (repo-only script — excluded from the website by .assetsignore)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, TOOLS } from '../assets/dev/registry.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const V = process.env.DEV_V || 'dev3';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const NAV = [
  ['/', 'Home', 'home', '<svg class="nav-ico" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>'],
  ['/image', 'Image', 'image', '<svg class="nav-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>'],
  ['/pdf', 'PDF', 'pdf', '<svg class="nav-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'],
  ['/dev', 'Developer', 'dev', '<svg class="nav-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'],
  ['/api-tools', 'API', 'api', '<svg class="nav-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>'],
  ['/workbench', 'Workbench', 'workbench', '<svg class="nav-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/></svg>'],
  ['/send', 'Send file', 'send', '<svg class="nav-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>'],
  ['/mail', 'Temp mail', 'mail', '<svg class="nav-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/></svg>'],
];

const PAGES = {
  dev: {
    file: 'dev.html', title: 'Free Developer Tools – JSON, JWT, Regex, Hash, Diff & more | Professional Developer',
    desc: 'Free, private developer tools that run in your browser: JSON formatter, JSON to TypeScript, JSON diff, YAML/CSV converters, XML formatter, JWT decoder & generator, Base64, URL encode, hashes, UUID, regex tester, SQL formatter, cron, text diff and cURL to code.',
  },
  api: {
    file: 'api-tools.html', title: 'Free API Tools – REST & GraphQL Tester, Webhook Tester, Headers | Professional Developer',
    desc: 'Free online API tools: REST API tester, GraphQL playground, webhook tester with real temporary endpoints, HTTP header checker, cURL generator, OpenAPI/Swagger viewer, response formatter, mock data generator and HTTP status codes.',
  },
  data: {
    file: 'workbench.html', title: 'Data Transformation Workbench – Encode, Decode, Hash, Convert | Professional Developer',
    desc: 'Chain data operations in your browser: Base64, URL, hex, binary and HTML entity encoding, MD5/SHA hashes, text clean-up, JSON/CSV/YAML/XML conversion and extraction of URLs, emails, IPs and domains.',
    single: 'workbench',
  },
};

function header(active) {
  return `  <header class="site-header">
    <div class="wrap nav">
      <a class="logo" href="/" aria-label="Professional Developer home"><span class="logo-mark" aria-hidden="true">PD</span>Professional<small>Developer</small></a>
      <nav class="nav-pill-wrapper" aria-label="Primary navigation">
        <ul class="nav-links">
${NAV.map(([href, label, id, ico]) => `          <li class="nav-tab nav-tab-${id}"><a href="${href}"${href === active ? ' class="is-active" aria-current="page"' : ''}>${ico}<span>${label}</span></a></li>`).join('\n')}
        </ul>
      </nav>
      <button type="button" class="theme-toggle-btn" id="themeToggle" aria-label="Toggle theme" title="Toggle theme">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
      </button>
    </div>
  </header>`;
}

const footer = `  <footer class="site-footer">
    <div class="wrap foot">
      <a class="logo" href="/" aria-label="Professional Developer home"><span class="logo-mark" aria-hidden="true">PD</span>Professional<small>Developer</small></a>
      <nav aria-label="Footer"><a href="/image">Image</a><a href="/pdf">PDF</a><a href="/dev">Developer</a><a href="/api-tools">API</a><a href="/workbench">Workbench</a><a href="/send">Send file</a><a href="/mail">Temp mail</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
      <span>© 2026 Professional Developer</span>
    </div>
  </footer>`;

for (const [cat, p] of Object.entries(PAGES)) {
  const c = CATEGORIES[cat];
  const tools = TOOLS.filter((t) => t.cat === cat);
  const serviceAttr = cat === 'data' ? 'workbench' : (cat === 'dev' ? 'dev' : 'api');
  const ld = {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: c.name, url: 'https://image4k.org' + c.page,
    hasPart: tools.map((t) => ({ '@type': 'WebApplication', name: t.name, url: 'https://image4k.org' + c.page + '#' + t.id, applicationCategory: 'DeveloperApplication', operatingSystem: 'Any', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } })),
  };
  const html = `<!doctype html>
<html lang="en" data-service="${serviceAttr}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(p.title)}</title>
  <meta name="description" content="${esc(p.desc)}">
  <link rel="canonical" href="https://image4k.org${c.page}">
  <meta name="theme-color" content="#180F21">
  <meta name="color-scheme" content="dark">
  <meta name="robots" content="index, follow">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Professional Developer">
  <meta property="og:url" content="https://image4k.org${c.page}">
  <meta property="og:title" content="${esc(c.name)} – free &amp; private | Professional Developer">
  <meta property="og:description" content="${esc(c.blurb)}">
  <meta property="og:image" content="https://image4k.org/assets/img/og-image.png">
  <link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/assets/img/favicon-32.png" sizes="32x32" type="image/png">
  <link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Urbanist:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/css/style.css?v=20261120c">
  <link rel="stylesheet" href="/assets/dev/dev.css?v=${V}">
${['json', 'encode', 'productivity', 'api'].map((g) => `  <link rel="stylesheet" href="/assets/dev/css/${g}.css?v=${V}">`).join('\n')}
  <script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body>
${header(c.page)}

  <main id="dt-app" class="wrap dt-app" data-cat="${cat}"${p.single ? ` data-single="${p.single}"` : ''}>
    <div class="dt-main">
      <header class="dt-tool-head"><h1>${esc(c.name)}</h1><p>${esc(c.blurb)}</p></header>
      <div class="dt-overview">
${tools.map((t) => `        <a class="dt-ov-card" href="${c.page}#${t.id}"><span class="dt-ov-group">${esc(t.group)}</span><strong>${esc(t.name)}</strong><span>${esc(t.desc)}</span></a>`).join('\n')}
      </div>
      <noscript><p class="dt-note">These tools run in your browser and need JavaScript enabled.</p></noscript>
    </div>
  </main>

${footer}
  <script src="/assets/js/theme.js" defer></script>
  <script type="module" src="/assets/dev/shell.js?v=${V}"></script>
</body>
</html>
`;
  writeFileSync(ROOT + p.file, html);
  console.log('wrote', p.file, tools.length, 'tools');
}
