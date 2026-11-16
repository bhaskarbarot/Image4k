/* Catalog of every developer / API / data tool. Used by the page shells (sidebar + search)
 * and as the single source of truth for routes: /<page>#<id>.
 * Adding a tool = add an entry here + create assets/dev/tools/<id>.js exporting mount(root). */

export const CATEGORIES = {
  dev:  { id: 'dev',  name: 'Developer Tools',     page: '/dev',       blurb: 'Format, convert, encode, hash, diff and test — all in your browser.' },
  api:  { id: 'api',  name: 'API & Backend Tools', page: '/api-tools', blurb: 'Send real HTTP & GraphQL requests, receive webhooks, inspect headers and specs.' },
  data: { id: 'data', name: 'Data Workbench',      page: '/workbench', blurb: 'Chain encoding, hashing, text and data operations into a recipe.' },
};

// group = sidebar heading inside a category
export const TOOLS = [
  // ---------- Developer tools ----------
  { id: 'json-formatter', cat: 'dev', group: 'JSON', name: 'JSON Formatter', desc: 'Format, minify and validate JSON with exact error line & column.', keywords: 'beautify pretty print minify validate lint' },
  { id: 'json-to-ts',     cat: 'dev', group: 'JSON', name: 'JSON to TypeScript', desc: 'Generate TypeScript interfaces from JSON — nested objects, arrays, optional & nullable fields.', keywords: 'interface type typescript ts generate' },
  { id: 'json-diff',      cat: 'dev', group: 'JSON', name: 'JSON Diff', desc: 'Compare two JSON documents: added, removed and changed values with their paths.', keywords: 'compare difference' },
  { id: 'yaml-json',      cat: 'dev', group: 'JSON', name: 'YAML ⇄ JSON', desc: 'Convert YAML to JSON and JSON to YAML, with validation and clear errors.', keywords: 'yml convert' },
  { id: 'json-csv',       cat: 'dev', group: 'JSON', name: 'JSON ⇄ CSV', desc: 'Convert JSON arrays to CSV and CSV to JSON — quoted fields, commas and newlines handled.', keywords: 'excel spreadsheet table convert' },
  { id: 'xml-formatter',  cat: 'dev', group: 'XML',  name: 'XML Formatter', desc: 'Format, minify and validate XML. Entities are never expanded (XXE-safe).', keywords: 'beautify pretty minify validate' },
  { id: 'jwt-decoder',    cat: 'dev', group: 'JWT',  name: 'JWT Decoder', desc: 'Decode a JSON Web Token: header, claims, expiry and issued-at — with honest verification status.', keywords: 'json web token decode claims exp' },
  { id: 'jwt-generator',  cat: 'dev', group: 'JWT',  name: 'JWT Generator', desc: 'Sign JWTs with HS/RS/PS/ES algorithms using the browser\'s Web Crypto. Keys never leave your device.', keywords: 'json web token sign hmac rsa ecdsa' },
  { id: 'base64',         cat: 'dev', group: 'Encoding', name: 'Base64 Encode / Decode', desc: 'Encode and decode Base64 (standard & URL-safe) for UTF-8 text and files.', keywords: 'b64 encode decode file' },
  { id: 'url-encoder',    cat: 'dev', group: 'Encoding', name: 'URL Encode / Decode', desc: 'Encode or decode URL components, full URLs and query strings — with a query parameter breakdown.', keywords: 'percent encoding uri query' },
  { id: 'hash-generator', cat: 'dev', group: 'Encoding', name: 'Hash Generator', desc: 'MD5, SHA-1, SHA-256 and SHA-512 for text and files of any size.', keywords: 'md5 sha1 sha256 sha512 checksum digest' },
  { id: 'uuid-generator', cat: 'dev', group: 'Encoding', name: 'UUID Generator', desc: 'Generate RFC 9562 UUID v4 and time-ordered v7 — single or in bulk.', keywords: 'guid uuid4 uuid7 unique id' },
  { id: 'regex-tester',   cat: 'dev', group: 'Productivity', name: 'Regex Tester', desc: 'Test JavaScript regular expressions: live highlights, groups, positions — runaway patterns are stopped.', keywords: 'regexp regular expression match' },
  { id: 'sql-formatter',  cat: 'dev', group: 'Productivity', name: 'SQL Formatter', desc: 'Format or minify SQL for PostgreSQL, MySQL, SQLite, SQL Server and standard SQL. Never executed.', keywords: 'beautify postgres mysql sqlite query' },
  { id: 'cron',           cat: 'dev', group: 'Productivity', name: 'Cron Expression Generator', desc: 'Build and explain cron expressions and preview the next run times.', keywords: 'crontab schedule job' },
  { id: 'text-diff',      cat: 'dev', group: 'Productivity', name: 'Text Diff', desc: 'Compare two texts side-by-side or unified, with changed words highlighted.', keywords: 'compare difference patch' },
  { id: 'curl-to-code',   cat: 'dev', group: 'Productivity', name: 'cURL to Code', desc: 'Convert cURL commands to Fetch, Axios, Python, PHP, Go, Java and Ruby.', keywords: 'convert curl fetch axios requests guzzle' },

  // ---------- API & Backend ----------
  { id: 'rest-tester',        cat: 'api', group: 'Requests', name: 'REST API Tester', desc: 'Send real HTTP requests with headers, params, auth and bodies; inspect status, headers, timing and size.', keywords: 'postman http client request rest' },
  { id: 'graphql',            cat: 'api', group: 'Requests', name: 'GraphQL Playground', desc: 'Run GraphQL queries and mutations with variables and headers; explore the schema via introspection.', keywords: 'graphql query mutation introspection' },
  { id: 'webhook',            cat: 'api', group: 'Requests', name: 'Webhook Tester', desc: 'Get a temporary URL and watch real incoming requests — method, headers, query and body.', keywords: 'webhook receive inspect endpoint requestbin' },
  { id: 'header-checker',     cat: 'api', group: 'Inspect',  name: 'HTTP Header Checker', desc: 'Fetch a URL\'s response headers and grade its security, caching and CORS headers.', keywords: 'security headers csp hsts cors cache' },
  { id: 'curl-generator',     cat: 'api', group: 'Requests', name: 'cURL Generator', desc: 'Build a request visually and get a ready-to-run cURL command for bash, PowerShell or CMD.', keywords: 'curl command builder' },
  { id: 'openapi-viewer',     cat: 'api', group: 'Inspect',  name: 'OpenAPI / Swagger Viewer', desc: 'Load an OpenAPI 3.x or Swagger 2.0 spec (JSON/YAML) and browse endpoints, schemas and auth.', keywords: 'swagger openapi spec documentation' },
  { id: 'response-formatter', cat: 'api', group: 'Inspect',  name: 'API Response Formatter', desc: 'Paste any API response — JSON, XML or text is detected, validated and pretty-printed.', keywords: 'pretty print response json xml' },
  { id: 'mock-api',           cat: 'api', group: 'Data',     name: 'Mock API Generator', desc: 'Design a schema and generate realistic mock JSON or CSV datasets — repeatable with a seed.', keywords: 'fake data mock json generator faker' },
  { id: 'http-status',        cat: 'api', group: 'Data',     name: 'HTTP Status Codes', desc: 'Searchable reference of HTTP status codes with meaning, use cases and troubleshooting.', keywords: '404 500 status code reference' },

  // ---------- Data workbench ----------
  { id: 'workbench', cat: 'data', group: 'Workbench', name: 'Data Transformation Workbench', desc: 'Chain operations — encode, decode, hash, convert, extract — and run them in order on your input.', keywords: 'cyberchef recipe chain transform encode decode' },
];

export const toolById = (id) => TOOLS.find((t) => t.id === id);
export const toolUrl = (t) => CATEGORIES[t.cat].page + '#' + t.id;
