/* Signaling server for the peer-to-peer file transfer (/send). A Durable Object per room-code relays the
 * tiny WebRTC handshake (SDP offer/answer + ICE candidates) between exactly two browsers. It NEVER sees the
 * file — once the two browsers are connected, the file streams directly device-to-device over WebRTC.
 * Deploy standalone:  cd signaling-worker && npx wrangler deploy   (free tier; no domain needed). */

const CODE_RE = /^[A-Z0-9]{4,10}$/;
const MAX_MSG = 256 * 1024; // signaling messages are a few KB; cap to stop abuse

export class Room {
  constructor(state) { this.state = state; this.peers = new Map(); } // role -> WebSocket
  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role');
    if (role !== 'sender' && role !== 'receiver') return new Response('bad role', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    if (this.peers.has(role)) { try { server.send(JSON.stringify({ type: 'error', error: 'role_taken' })); server.close(1008, 'role taken'); } catch (e) {} return new Response(null, { status: 101, webSocket: client }); }
    const peerRole = role === 'sender' ? 'receiver' : 'sender';
    this.peers.set(role, server);
    server.send(JSON.stringify({ type: 'ready', role, peerPresent: this.peers.has(peerRole) }));
    const peer = this.peers.get(peerRole);
    if (peer) try { peer.send(JSON.stringify({ type: 'peer-joined' })); } catch (e) {}
    server.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > MAX_MSG) return;
      const other = this.peers.get(peerRole);
      if (other) try { other.send(ev.data); } catch (e) {}
    });
    const bye = () => { if (this.peers.get(role) === server) this.peers.delete(role); const o = this.peers.get(peerRole); if (o) try { o.send(JSON.stringify({ type: 'peer-left' })); } catch (e) {} };
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return new Response('ok', { headers: cors });
    if (url.pathname === '/ws') {
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!CODE_RE.test(code)) return new Response('bad code', { status: 400, headers: cors });
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
    }
    return new Response('not found', { status: 404, headers: cors });
  },
};
