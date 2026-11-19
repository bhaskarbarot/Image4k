// GET /api/ice — WebRTC ICE servers for the /send file transfer.
//
// Returns STUN (for direct connections) PLUS a Cloudflare TURN relay, which lets transfers succeed
// across strict networks (mobile-carrier / corporate NAT) where a direct peer-to-peer link can't be
// opened. The file still travels encrypted end-to-end; TURN only forwards the packets when needed.
//
// To enable TURN, set two variables on the Pages project (Cloudflare Dashboard → Realtime → TURN →
// create an app gives you both):
//     TURN_KEY_ID          = the Turn Token ID
//     TURN_KEY_API_TOKEN    = the Turn Token's API token   (store as an encrypted Secret)
// Without them this returns STUN only (direct-P2P, same as before) — nothing breaks, strict networks
// just can't connect.

const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

export const onRequestGet = async ({ env }) => {
  const id = env && env.TURN_KEY_ID;
  const token = env && env.TURN_KEY_API_TOKEN;
  if (!id || !token) return reply(STUN, false);

  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!r.ok) return reply(STUN, false, 'turn_api_' + r.status);
    const data = await r.json();
    // Cloudflare returns iceServers as an object {urls, username, credential}; normalise to an array.
    let turn = data && data.iceServers;
    if (turn && !Array.isArray(turn)) turn = [turn];
    if (!Array.isArray(turn) || !turn.length) return reply(STUN, false, 'turn_empty');
    return reply([...STUN, ...turn], true);
  } catch (e) {
    return reply(STUN, false, 'turn_fetch_failed');
  }
};

function reply(iceServers, turn, error) {
  const body = { iceServers, turn };
  if (error) body.error = error;
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}

export const onRequest = () => new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { ...JSON_HEADERS, 'Allow': 'GET' } });
