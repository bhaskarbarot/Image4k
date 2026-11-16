// ANY /api/hook/:id[/anything] — the public webhook URL. Records the request (see server/hooks-core.js).
import { receiveHook } from '../../../server/hooks-core.js';
import { fail } from '../../../server/limits.js';

export const onRequest = ({ request, env, params }) => {
  const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  if (!parts.length) return fail(404, 'not_found', 'Missing webhook id.');
  return receiveHook(request, env, parts[0], parts.slice(1).join('/'));
};
