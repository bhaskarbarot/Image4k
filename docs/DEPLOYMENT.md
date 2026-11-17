# Deployment — server-side features (API proxy & webhook tester)

> Written for: the site owner and anyone deploying this repository to Cloudflare Pages.

Almost everything on the site is static and runs in the visitor's browser. Two features need a server and run
as **Cloudflare Pages Functions** (the `functions/` folder, deployed automatically by the existing git integration —
no build-setting changes needed):

| Route | Purpose | Storage | Works without setup? |
|---|---|---|---|
| `POST /api/proxy` | “Secure proxy” for REST tester / GraphQL / HTTP header checker (APIs without CORS, full response headers) | none | **yes** |
| `POST /api/hooks` · `GET/DELETE /api/hooks/:id/requests` · `DELETE /api/hooks/:id` | create / read / delete temporary webhook endpoints | D1 | needs D1 binding (below) |
| `ANY /api/hook/:id[/…]` | the public webhook URL that records requests | D1 | needs D1 binding |
| `GET/POST/DELETE /api/mail/*` | temp-mail: create inbox, poll messages, read/delete | D1 | needs D1 + a mail domain |
| Email Worker (`email-worker/`) | receives inbound mail → D1 (deployed separately) | D1 | needs Email Routing |

Shared server code lives in `server/` (SSRF guard, limits, proxy and webhook logic). `functions/`, `server/`,
`migrations/`, `docs/`, `tests/` and `scripts/` are listed in `.assetsignore`, so they are never published as static files.

## One-time setup: enable the webhook tester (≈3 minutes, Cloudflare dashboard)

Until this is done the webhook tester shows *“not switched on for this website yet”*; every other tool works.

1. Cloudflare dashboard → **Storage & Databases → D1 SQL Database → Create**. Name it e.g. `bhaskar-webhooks`
   (pick the location closest to most users). Free plan is enough.
2. **Workers & Pages → your Pages project (image4k) → Settings → Bindings → Add → D1 database**.
   - Variable name: **`HOOKS_DB`** (exactly)
   - D1 database: `bhaskar-webhooks`
   - Add it for **Production** and also for **Preview** (the environment selector at the top of the Bindings page).
3. **Deployments → latest production deployment → ⋯ → Retry deployment** (bindings apply to new deployments only).
4. Test: open `https://<your-domain>/api-tools#webhook` → *Create webhook URL* → run the example cURL.

Tables are created automatically on first use (`CREATE TABLE IF NOT EXISTS`). To create them up-front instead
(optional, needs `npx wrangler login` once):

```bash
npx wrangler d1 execute bhaskar-webhooks --remote --file=migrations/0001_webhooks.sql
# roll back (deletes all webhook data):
npx wrangler d1 execute bhaskar-webhooks --remote --file=migrations/0001_webhooks.down.sql
```

## One-time setup: enable Temp Mail (receives real email + OTP codes)

Temp Mail needs three things: a **domain you control on Cloudflare**, **Cloudflare Email Routing** (to accept
inbound mail) pointed at a small **Email Worker** (`email-worker/`), and a **D1 database** shared by the Worker
and the website. Until this is done, `/mail` shows *"not switched on for this website yet"*; everything else works.

You cannot receive email on a `*.pages.dev` subdomain — you must use a real domain (e.g. `image4k.org`).

1. **Add your domain to Cloudflare** (Websites → Add a site) and point its nameservers to Cloudflare so DNS is
   managed there. A subdomain is nice for mail, e.g. use `mail.image4k.org` as the address domain.
2. **Create the D1 database:** Storage & Databases → D1 → Create → e.g. `bhaskar-tempmail` (free plan is fine).
3. **Deploy the Email Worker** (it receives the mail and writes it to D1):
   ```bash
   cd email-worker
   # edit wrangler.toml → uncomment the [[d1_databases]] block and paste the database_id from step 2
   npx wrangler deploy
   ```
4. **Turn on Email Routing:** your domain → Email → Email Routing → enable (Cloudflare adds the MX + SPF records
   automatically). Then **Routes → Catch-all address → Action: Send to a Worker → `tempmail-receiver`** (and Save).
   Verify a destination address if Cloudflare asks. (A catch-all is what lets `anything@mail.image4k.org` work.)
5. **Bind the same D1 + the domain to the Pages site:** Workers & Pages → image4k → Settings → Bindings →
   - **D1 database** → variable name **`MAIL_DB`** → `bhaskar-tempmail` (add for **Production** and **Preview**).
   - **Environment variable** → **`MAIL_DOMAIN`** → the address domain, e.g. `mail.image4k.org`
     (comma-separate several). Do **not** set `ALLOW_TEST_INGEST` in production — it must stay unset.
6. **Redeploy** the Pages project (Deployments → Retry) so the new bindings apply.
7. **Test for real:** open `/mail`, copy the address, and from any other email account send it a message — it
   appears within a few seconds. Then try a real signup (Groq, OpenAI, GitHub…): the verification code shows at
   the top of the message. `wrangler d1 execute bhaskar-tempmail --remote --command "SELECT COUNT(*) FROM mail_messages"`
   confirms storage.

The D1 tables are created automatically on first use; `migrations/0002_tempmail.sql` is the explicit version.

## Limits (edit in `server/`)

| Feature | Limit | Where |
|---|---|---|
| Proxy request body | 1 MB | `server/proxy-core.js` `LIMITS` |
| Proxy response body | 5 MB (then `truncated: true`) | same |
| Proxy total time | 15 s (DNS + all redirects) | same |
| Proxy redirects | 5, each hop re-validated | same |
| Proxy rate | 60 requests / minute / IP (best effort, per isolate) | same |
| Proxy ports | 80, 443, 8080, 8443, 8000, 8008, 8888, 3000, 4000, 5000, 9000 | `server/ssrf.js` `ALLOWED_PORTS` |
| Temp-mail address | 1 h idle, 24 h max; 50 messages kept; 40 addresses/hour per IP | `server/mail-core.js` `MAIL_LIMITS` |
| Temp-mail e-mail | ignored above 2 MB; 128 KB of text/html kept per body | same |
| Webhook body | > 1 MB rejected with 413 (not stored); first 256 KB stored | `server/hooks-core.js` `HOOK_LIMITS` |
| Webhook storage | newest 100 requests per endpoint | same |
| Webhook burst | 30 requests / 10 s per endpoint (429) | same |
| Endpoint creation | 20 per IP per hour (stored as a SHA-256 hash of the IP) | same |
| Webhook expiry | 24 h after last activity, 7 days maximum; expired rows purged when new endpoints are created | same |

**Recommended hard limit:** the in-code rate limiter lives in one Cloudflare isolate (best effort). For a global
limit add a dashboard rule: *Security → WAF → Rate limiting rules → Create* — “URI Path starts with `/api/`”,
e.g. 120 requests per 1 minute per IP → Block for 1 minute. (Requires the site to be on a custom domain zone;
on `*.pages.dev` only the in-code limits apply.)

D1 free-plan budget: each received webhook = 3 writes (insert, activity update, prune); polling reads only and
updates activity at most every 10 minutes per endpoint.

## Security model

- **SSRF:** only `http`/`https`; no `user:pass@`; IP literals in every private/reserved range refused (IPv4 + IPv6,
  incl. IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo); local host names (`localhost`, `*.local`, `*.internal`,
  `metadata`, single-label names…) refused; the site's own host refused; hostnames resolved via DNS-over-HTTPS and
  refused if **any** A/AAAA answer is private; redirects followed manually with every hop re-checked; credentials
  (`Authorization`, `Cookie`) dropped on cross-origin redirects. Residual risk: DNS can change between our check and
  the runtime's own lookup (TOCTOU); Cloudflare's Workers runtime does not route subrequests to private networks,
  which closes that window in production.
- **Not an open proxy for other websites:** requests with a foreign `Origin` are refused and no
  `Access-Control-Allow-Origin` header is sent, so other sites' pages cannot use it. Non-browser clients can still
  call it, but only for public URLs and within the rate limits.
- **Privacy:** functions never log URLs, headers or bodies. The proxy strips hop-by-hop, `CF-*`, `X-Forwarded-*`,
  `Forwarded`, `X-Real-IP`, `Origin`, `Referer` and `Sec-*` headers, and never forwards the visitor's cookies or IP.
- **Webhooks:** 128-bit random endpoint ids, 256-bit random access tokens (only SHA-256 stored, constant-time
  compare), data readable only with the token, every response `Cache-Control: no-store` + `X-Robots-Tag: noindex`.
  Stored payloads are only ever displayed as text (never rendered as HTML).

## Disable a feature

- Webhook tester only: remove the `HOOKS_DB` binding (endpoints answer 503 and the UI explains it).
- Proxy / all functions: delete the `functions/` folder (or the specific file) and push. The REST tester keeps
  working in *Direct* mode; the header checker needs the proxy.

## Rollback

Pages keeps every deployment: **Deployments → pick an earlier one → ⋯ → Rollback to this deployment**.
Git: `git revert <commit>` and push. D1 data is independent of deployments; drop it with the down migration.

## Local development

```bash
python3 serve.py 8093                     # static pages only (functions are not available → proxy/webhooks show errors)
npx wrangler@4.156.2 pages dev . --port 8852 --d1 HOOKS_DB=local-hooks   # static + functions + local D1
```

Note: the repository root also contains `wrangler.jsonc`, a *Workers* (static assets) config from an earlier
deployment. It has no `pages_build_output_dir`, so `wrangler pages dev` ignores it (verified with wrangler 4.156.2:
no warning, functions and the D1 binding load normally). Cloudflare's Pages build likewise skips a config file
without `pages_build_output_dir` (it may log a warning) and uses the dashboard settings and bindings — which is
why the D1 binding is added in the dashboard, not in that file.
