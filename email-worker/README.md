# tempmail-receiver — Cloudflare Email Worker

Receives inbound e-mail for the temp-mail feature and stores it in the shared D1 database (`MAIL_DB`),
which the website's Pages Functions (`/api/mail/*`) read from.

It must be deployed **separately** from the Pages site, because Cloudflare Email Routing can only deliver
to a standalone Worker, not to a Pages Function. Both bind the *same* D1 database.

See `../docs/DEPLOYMENT.md` → "Temp-mail" for the full one-time setup (domain, Email Routing, D1 binding).
