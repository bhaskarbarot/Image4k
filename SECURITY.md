# Security Policy

## Reporting a vulnerability

If you find a security issue, please report it **privately** — do not open a public issue or PR that
describes the exploit.

- Preferred: open a private **GitHub Security Advisory** on this repository
  (`Security` tab → `Report a vulnerability`).
- Or contact the maintainer through the details on https://image4k.org.

Please include steps to reproduce, the affected URL/endpoint, and the impact. We aim to acknowledge within
a few days. Please give us reasonable time to fix before any public disclosure.

## Scope

In scope: the website and its Cloudflare Pages Functions (`/api/proxy`, `/api/hook*`, `/api/mail/*`) and the
Email Worker. Out of scope: third-party services the tools talk to, the bundled third-party libraries'
own code, and denial-of-service via traffic volume (handled at the Cloudflare edge).

## Design notes (what is and isn't a security boundary)

- **Everything runs in the browser where possible.** Image, PDF, QR, OCR, watermark, and all developer/data
  tools process your input locally; it is not uploaded.
- **`/api/proxy`** is a same-origin-only relay for the API tools. It blocks private/loopback/link-local and
  cloud-metadata destinations (SSRF), follows redirects manually and re-validates every hop, caps request
  (1 MB) and response (5 MB) size and time (15 s), strips hop-by-hop and identity headers, never forwards the
  caller's cookies or IP, is rate-limited, and logs nothing. It requires a genuine same-origin browser request.
- **Webhook & temp-mail endpoints** are off until the owner configures storage (they return 503). When on,
  each inbox/endpoint is readable only with a secret token (only a SHA-256 of the token is stored, compared in
  constant time), ids are ≥128-bit random, inputs are size-capped, and data auto-expires.
- The `ConsentGate` password in `assets/js/consent-gate.js` is a **client-side deterrent, not access control**
  — it is visible in the page source by design and protects nothing on the server.
- Strict security headers are enforced site-wide (CSP without inline scripts, HSTS, COOP/COEP, nosniff,
  `frame-ancestors 'none'` + `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, Permissions-Policy).

See `docs/SECURITY_AUDIT.md` for the full audit, threat model, and residual risks.
