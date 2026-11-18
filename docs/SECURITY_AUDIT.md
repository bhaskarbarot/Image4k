# Security Audit & Production Readiness

> Date: 2026-11-18 · Scope: the whole site — static pages, Cloudflare Pages Functions
> (`/api/proxy`, `/api/hook*`, `/api/mail/*`), the Email Worker, and the client tools.
> Method: adversarial whitebox review (two independent passes) + live probing + load test.

## Verdict

**Production-ready and abuse-resistant for legitimate use.** No critical, injection, SQLi, SSRF-bypass or
XSS vulnerabilities were found. The real risk was abuse of the public `/api/proxy` relay — now closed. One
owner action remains to make the per-IP limits hard rather than best-effort (a Cloudflare WAF rule).

## Architecture = most of the security

- **Everything runs in the visitor's browser where possible.** Image upscaling/resize/compress/BG-removal,
  QR, OCR, watermark, PDF, and every developer/data tool process input locally — nothing is uploaded. This
  means **zero server attack surface and zero server load** for those tools, at any number of users.
- The only server code is three small, SSRF/abuse-guarded Pages Functions + an Email Worker, all off or
  minimal until the owner enables webhooks/temp-mail.
- The live site sits behind **Cloudflare's edge** (automatic DDoS + bot management; non-browser probes get
  CF error 1010), which absorbs volumetric attacks before they reach any function.

## Findings & fixes

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **HIGH** | `/api/proxy` was an open relay for non-browser clients (`sameOriginOnly` allowed a missing `Origin`), usable to anonymize requests to third parties or burn bandwidth. | **FIXED** — the proxy now uses `strictSameOrigin`: it requires a real same-origin browser signal (`Origin` matching our origin, or `Sec-Fetch-Site: same-origin`). curl/scripts with neither are refused. `server/limits.js`, `server/proxy-core.js`. Covered by new unit tests. |
| 2 | MEDIUM | Per-IP rate limiting is per-Workers-isolate, not global, so nominal caps are soft. | **MITIGATED in code + OWNER ACTION.** Proxy caps tightened (below). A global cap needs a Cloudflare **WAF rate-limiting rule** on `/api/*` — see "Owner actions". |
| 3 | MEDIUM | Authenticated temp-mail reads (`listMessages`/`getMessage`) had no rate limit → a token holder could hammer D1 reads. | **FIXED** — added `rateLimit('mail-read:'+ip, 150/min)`. `server/mail-core.js`. |
| 4 | LOW | `clientIp()` fell back to the client-controllable `X-Real-IP`, letting an attacker rotate it to evade per-IP limits if ever run off-Cloudflare. | **FIXED** — now uses only `CF-Connecting-IP` (Cloudflare-set, unspoofable). `server/limits.js`. |
| 5 | LOW | The MIME parser ran regexes on up-to-2 MB untrusted input before per-field caps (CPU burn on hostile inbound mail). | **FIXED** — `From`/`Subject` capped to 2 KB and HTML to 512 KB before regex. `server/mime.js`. |
| 6 | LOW | DNS-rebinding TOCTOU between the DoH check and the connect. | **ACCEPTED** — Cloudflare's runtime also refuses subrequests to private IPs, closing the window on-platform. Documented; do not port the proxy to a runtime without that protection. |

Hardening also applied: `X-Frame-Options: DENY` added (with the existing `frame-ancestors 'none'`); proxy
`responseBody` 5 MB → **2 MB** and `perMinute` 60 → **30**.

## Verified strong (not changed)

- **No SQL injection** — every D1 query uses bound parameters.
- **SSRF** — exhaustive IPv4/IPv6 coverage (private/loopback/link-local/CGNAT/mapped/NAT64/6to4/Teredo, and
  decimal/octal/hex via WHATWG URL normalization), per-redirect re-validation, port allow-list, self-host
  block. **112 passing unit tests.**
- **No XSS** — user data reaches the DOM only via `textContent`, an HTML-escaper (`esc`/`escapeHTML`), or the
  `h()` DOM builder. Email bodies are converted to text server-side and rendered as text.
- **Tokens** — 256-bit random; only a SHA-256 is stored; constant-time comparison. Endpoint ids are 128-bit
  random (not enumerable).
- **Proxy hygiene** — strips hop-by-hop/`CF-*`/`X-Forwarded-*`/`Origin`/`Referer`/`Sec-*` headers; never
  forwards the caller's cookies or IP; redacts URLs from error messages; logs nothing.
- **DoS controls** — user regex and the data-workbench run in Web Workers with hard timeouts; request/response/
  body size caps; recursion-depth cap in the MIME parser.
- **Secrets/source not published** — `.assetsignore` excludes `functions/`, `server/`, `migrations/`,
  `email-worker/`, `tests/`, configs. The `ConsentGate` password is a documented client-side deterrent only.
- **Security headers** (site-wide): CSP (no inline scripts; `object-src 'none'`; `base-uri 'self'`;
  `frame-ancestors 'none'`), HSTS (preload), COOP + COEP, nosniff, `Referrer-Policy: no-referrer`,
  Permissions-Policy, `X-Frame-Options: DENY`.

## Load / ~100 concurrent users

- Static pages & assets → Cloudflare CDN (effectively unlimited).
- Heavy tools run 100% client-side → no server scaling concern regardless of user count.
- Functions are serverless and auto-scale; isolates are single-threaded with no shared mutable state (no
  races). **Local load test: 100 concurrent function requests → 100× HTTP 200 in ~0.6 s** on a single dev
  process; production scales far beyond this.
- The only capacity limit appears when temp-mail/webhooks go live: **D1 free-tier daily quotas** — mitigated
  by throttled `last_activity` writes, row pruning, and the new read rate-limit.

## Owner actions (recommended before promoting the API/webhook/mail tools widely)

1. **Add a Cloudflare WAF rate-limiting rule** on `/api/*` (e.g. 120 requests/min/IP → Block 1 min). This is
   the hard, global limit behind finding #2. Requires the site on a custom domain/zone (another reason to
   finish the domain step). Dashboard → Security → WAF → Rate limiting rules.
2. When enabling temp-mail/webhooks, also set D1 and keep an eye on the free-tier quota (see
   `docs/DEPLOYMENT.md`).

## Residual risk (honest)

No system is unhackable. With the fixes above and Cloudflare's edge, the realistic residual risks are:
bandwidth abuse of `/api/proxy` capped only per-isolate until the WAF rule is added (finding #2), and generic
third-party/service risks outside our code. These are low and bounded. For anything found later, see
`SECURITY.md` for private disclosure.
