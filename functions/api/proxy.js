// POST /api/proxy — secure, rate-limited HTTP proxy for the API tools (see server/proxy-core.js).
import { handleProxy } from '../../server/proxy-core.js';
import { fail } from '../../server/limits.js';

export const onRequestPost = ({ request, env }) => handleProxy(request, env);
export const onRequest = () => fail(405, 'method_not_allowed', 'Use POST', { Allow: 'POST' });
