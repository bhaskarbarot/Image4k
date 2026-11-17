# Temp Mail — going live for free with a eu.org domain

> Goal: make `/mail` receive **real** email + OTP codes, self-hosted, at **$0** — no paid domain.
> The whole system is already built, tested and deployed. This is the one-time setup to switch it on.
> Written for: the site owner (Bhaskar).

Real email needs a domain you control. [eu.org](https://nic.eu.org/) gives free domains (run by a nonprofit),
and Cloudflare Email Routing accepts them. The only cost is **time**: eu.org approves requests by hand, which
can take a few days to ~2 weeks. Everything else is ready and waiting.

Until this is done, `/mail` shows "not switched on yet" and the **Demo** button still lets anyone try it.

## Your chosen name

You wanted `professional.developer.eu.org`. Two things to know about eu.org + Cloudflare email:
- eu.org registers **one label** under `eu.org`, and Cloudflare's free Email Routing receives mail on that
  registered domain (the zone **root**), not on a deeper sub-subdomain.
- So the clean, working choice is **`professional-developer.eu.org`** (one registration, mail =
  `you@professional-developer.eu.org`). This guide uses that.
- Alternatives: register `developer.eu.org` (mail = `you@developer.eu.org`), or `professionaldeveloper.eu.org`.
  Whatever you register, you set `MAIL_DOMAIN` (Step 6) to exactly that — the code works with any domain.

---


---

## Step 1 — Add the (future) domain to Cloudflare first (2 min)

You do this *before* eu.org, so you know which nameservers to give eu.org.

1. Pick a name, e.g. `professional-developer.eu.org` (mail will be `anything@professional-developer.eu.org`).
2. Cloudflare dashboard → **Websites → Add a site** → enter `professional-developer.eu.org` → **Free** plan → Continue.
3. Cloudflare shows **two nameservers** like `ada.ns.cloudflare.com` and `rob.ns.cloudflare.com`.
   **Copy them** — you need them in Step 2. (The zone will sit "pending" until eu.org delegates to it.)

## Step 2 — Request the free eu.org domain (10 min + the wait)

1. Go to **https://nic.eu.org/** → create an account (it's free).
2. **Register a new domain** → enter your name (`professional-developer.eu.org`).
3. When it asks for **name servers / DNS**, enter the **two Cloudflare nameservers** from Step 1.
4. Submit. Now wait for the manual approval email from eu.org (days → ~2 weeks). You can't rush this part.
5. When approved, Cloudflare (Step 1's zone) flips from "Pending" to **Active** automatically within a few hours.

> Tip: eu.org sometimes rejects vague requests. Use a clear name and a real reason ("personal project / tools site").

## Step 3 — Create the database (1 min, can do now)

Cloudflare → **Storage & Databases → D1 → Create database** → name it `bhaskar-tempmail` (Free plan is enough).
Copy its **Database ID**.

## Step 4 — Deploy the Email Worker (2 min, do after Step 2 is Active)

From this repo:
```bash
cd email-worker
# edit wrangler.toml → uncomment the [[d1_databases]] block, paste the Database ID from Step 3
npx wrangler login       # once, opens the browser
npx wrangler deploy
```

## Step 5 — Turn on Email Routing (3 min, after the zone is Active)

1. Cloudflare → your `professional-developer.eu.org` zone → **Email → Email Routing → Enable** (it auto-adds MX + SPF records).
2. **Routes → Catch-all address → Edit → Action: Send to a Worker → `tempmail-receiver` → Save.**
   (Catch-all is what makes every `anything@…` address work.)
3. If it asks you to verify a destination address, do it (any inbox you own).

> Addresses will look like `name@professional-developer.eu.org`. Set `MAIL_DOMAIN` (Step 6) to exactly the
> domain you enabled here.

## Step 6 — Connect it to the website (2 min)

Cloudflare → **Workers & Pages → image4k → Settings → Bindings** (add to **Production** *and* **Preview**):
- **D1 database** → variable name **`MAIL_DB`** → `bhaskar-tempmail`.
- **Environment variable** → **`MAIL_DOMAIN`** → the domain you enabled, e.g. `professional-developer.eu.org`.
- Do **not** add `ALLOW_TEST_INGEST` (that's test-only).

Then **Deployments → Retry deployment** so the bindings take effect.

## Step 7 — Test it for real

1. Open `https://image4k.pages.dev/mail` → it now shows a real address (no "demo").
2. From any other email account, send a message to that address → it appears in a few seconds.
3. Real signup test: use the address on **Groq / OpenAI / GitHub** → the verification code shows at the top.

Done — real, private, self-hosted temp mail, for free.

---

### Notes
- The tables are created automatically on first email; `migrations/0002_tempmail.sql` is the explicit version.
- Limits (addresses/hour, message retention, expiry) are in `server/mail-core.js` → `MAIL_LIMITS`.
- To turn it off again: remove the `MAIL_DB` binding (the page returns to "not switched on" + Demo).
- If eu.org is too slow and you ever want it working *today*, the alternative is a free third-party mail API
  (e.g. mail.tm) wired client-side — real OTPs, no domain — but mail then passes through that third party
  (not private). Ask and I'll add it as an option.
