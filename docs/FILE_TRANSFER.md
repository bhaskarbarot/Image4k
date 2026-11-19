# P2P File Transfer (`/send`) — how it works & how to deploy

A browser-to-browser file transfer. The sender picks a file (up to **2 GB**), gets a short one-time code,
and the receiver types that code on another device. The file then streams **directly device-to-device over
an encrypted WebRTC data channel** — it never touches our servers and is never stored. There is no download
link and no database; both people must be online at the same time.

## Pieces

| Piece | Path | Role |
|-------|------|------|
| Page | `send.html` + `assets/send/*` | UI (Send / Receive tabs, drop zone, code, progress) + WebRTC logic |
| Config endpoint | `functions/api/signal-config.js` | Tells the page the signaling WebSocket URL (from the `SIGNAL_URL` env var) |
| Signaling server | `signaling-worker/` | A Cloudflare **Durable Object** that relays only the WebRTC handshake (SDP + ICE) between the two browsers. Free tier. |

The signaling server only passes the tiny handshake so the two browsers can find each other. Once connected,
it is out of the loop — the file does **not** pass through it.

## Deploy (one time, ~3 minutes)

The static site auto-deploys from the repo on Cloudflare Pages. The signaling server is a **separate Worker**
you deploy once, then point the site at it with an environment variable.

```bash
# 0. Log in once (opens a browser to authorize your Cloudflare account)
cd signaling-worker
npx wrangler login

# 1. Deploy the signaling Worker.
#    IMPORTANT: pass -c wrangler.toml. Without it wrangler walks UP to the repo's
#    root wrangler.jsonc (the Pages/static-assets config) and deploys the wrong thing.
npx wrangler deploy -c wrangler.toml      # or:  npm run deploy
#   → prints a URL like:  https://pd-signaling.<your-subdomain>.workers.dev
```

```bash
# 2. Tell the Pages site where it lives (note wss:// and the /ws path)
#    Dashboard → Pages → image4k → Settings → Variables and Secrets → add:
#       SIGNAL_URL = wss://pd-signaling.<your-subdomain>.workers.dev/ws
#    then redeploy the Pages project (or push any commit).
```

That's it. With `SIGNAL_URL` set, `/send` works for everyone. Until it's set, `/api/signal-config` returns
`{"url":null}` and the page shows a friendly "not configured yet" message instead of half-working.

## TURN relay (makes it work across strict networks)

With STUN only, transfers work when the two devices can reach each other directly (same Wi-Fi, friendly
routers). Across different networks — e.g. **laptop on Wi-Fi + phone on mobile data**, or strict corporate
NAT — there's often no direct path and the connection fails. A **TURN relay** fixes that by forwarding the
(still end-to-end-encrypted) packets.

`functions/api/ice.js` mints Cloudflare TURN credentials. To enable it:

1. Cloudflare Dashboard → **Realtime** → **TURN** → **Create** an app. It gives you a **Turn Token ID** and
   an **API Token**.
2. On the Pages project (**image4k → Settings → Variables and Secrets**) add:
   - `TURN_KEY_ID` = the Turn Token ID
   - `TURN_KEY_API_TOKEN` = the API Token (add it as an **encrypted Secret**)
3. Redeploy. `/api/ice` now returns STUN **+** TURN, and strict-network transfers connect.

Free tier: Cloudflare TURN includes ~1000 GB/month. Without these vars, `/api/ice` returns STUN only and
the tool behaves exactly as before (direct-P2P, strict networks fail with a clear message).

## Cost / limits

- Durable Objects (SQLite-backed) are **free** on the Workers free plan: 100k requests/day, well beyond what
  signaling needs (a handful of tiny messages per transfer).
- Direct P2P works for the large majority of users. A small share on very strict networks (some corporate /
  mobile-carrier NATs) can't open a direct path; v1 has no TURN relay, so those transfers fail with a clear
  message. Adding Cloudflare TURN later would cover them (see the VPN/R&D notes).

## Test locally

```bash
# terminal 1 — signaling server
cd signaling-worker && npx wrangler dev --local --port 8787 -c wrangler.toml   # or: npm run dev

# terminal 2 — the site + the e2e transfer test (real 2-browser WebRTC transfer, verifies bytes match)
NODE_PATH=<playwright-core+ws> node --test tests/e2e/send.e2e.mjs
```

The page reads the signaling URL from `window.__SIGNAL_URL__` if set (used by the test), otherwise from
`/api/signal-config`.
