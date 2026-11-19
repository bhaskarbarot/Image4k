// GET /api/signal-config — tells the /send page where the WebRTC signaling worker lives.
// Set the SIGNAL_URL environment variable on the Pages project to the deployed worker's
// WebSocket endpoint, e.g.  wss://pd-signaling.<your-subdomain>.workers.dev/ws
// With no SIGNAL_URL set, the page reports that file transfer isn't configured yet.
export const onRequestGet = ({ env }) => {
  const url = (env && env.SIGNAL_URL) ? String(env.SIGNAL_URL) : null;
  return new Response(JSON.stringify({ url }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
};
export const onRequest = () => new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { 'Content-Type': 'application/json', 'Allow': 'GET' } });
