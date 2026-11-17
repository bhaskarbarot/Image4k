// Generates dev.html, api-tools.html and workbench.html from assets/dev/registry.js so the
// header, footer, SEO tool list and JSON-LD stay consistent.  Run:  node scripts/gen-pages.mjs
// (repo-only script — excluded from the website by .assetsignore)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, TOOLS } from '../assets/dev/registry.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const V = process.env.DEV_V || 'dev1';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const NAV = [
  ['/', 'Home'], ['/image', 'Image'], ['/qr', 'QR code'], ['/mail', 'Temp mail'], ['/pdf', 'PDF'],
  ['/dev', 'Developer'], ['/api-tools', 'API'], ['/workbench', 'Workbench'],
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
      <ul class="nav-links">
${NAV.map(([href, label]) => `        <li><a href="${href}"${href === active ? ' class="is-active" aria-current="page"' : ''}>${label}</a></li>`).join('\n')}
      </ul>
    </div>
  </header>`;
}
const footer = `  <footer class="site-footer">
    <div class="wrap foot">
      <a class="logo" href="/"><span class="logo-mark" aria-hidden="true">PD</span>Professional<small>Developer</small></a>
      <nav aria-label="Footer"><a href="/image">Image tools</a><a href="/mail">Temp mail</a><a href="/pdf">PDF tools</a><a href="/dev">Developer tools</a><a href="/api-tools">API tools</a><a href="/workbench">Workbench</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
      <span>© 2026 Professional Developer</span>
    </div>
  </footer>`;

for (const [cat, p] of Object.entries(PAGES)) {
  const c = CATEGORIES[cat];
  const tools = TOOLS.filter((t) => t.cat === cat);
  const ld = {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: c.name, url: 'https://image4k.org' + c.page,
    hasPart: tools.map((t) => ({ '@type': 'WebApplication', name: t.name, url: 'https://image4k.org' + c.page + '#' + t.id, applicationCategory: 'DeveloperApplication', operatingSystem: 'Any', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } })),
  };
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(p.title)}</title>
  <meta name="description" content="${esc(p.desc)}">
  <link rel="canonical" href="https://image4k.org${c.page}">
  <meta name="theme-color" content="#111111">
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
  <link rel="stylesheet" href="/assets/css/style.css?v=20261114h">
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
  <script type="module" src="/assets/dev/shell.js?v=${V}"></script>
</body>
</html>
`;
  writeFileSync(ROOT + p.file, html);
  console.log('wrote', p.file, tools.length, 'tools');
}
