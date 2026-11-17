// TEST-ONLY inbound e-mail ingestion. Disabled unless env.ALLOW_TEST_INGEST is set — it is NEVER set in
// production, so this route returns 404 live. Real mail arrives through the Cloudflare Email Worker
// (email-worker/), which calls the same storeIncoming() in server/mail-core.js.
import { storeIncoming } from '../../../server/mail-core.js';
import { json, fail } from '../../../server/limits.js';

export const onRequestPost = async ({ request, env }) => {
  if (!env || !env.ALLOW_TEST_INGEST) return fail(404, 'not_found', 'Not found.');
  const to = request.headers.get('X-Test-To') || new URL(request.url).searchParams.get('to') || '';
  const raw = new Uint8Array(await request.arrayBuffer());
  const r = await storeIncoming(env, to, raw);
  return json({ ok: r.stored, ...r });
};
export const onRequest = () => fail(404, 'not_found', 'Not found.');
