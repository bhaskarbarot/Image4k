// POST /api/hooks — create a temporary webhook endpoint (see server/hooks-core.js).
import { createHook } from '../../../server/hooks-core.js';
import { fail } from '../../../server/limits.js';

export const onRequestPost = ({ request, env }) => createHook(request, env);
export const onRequest = () => fail(405, 'method_not_allowed', 'Use POST', { Allow: 'POST' });
