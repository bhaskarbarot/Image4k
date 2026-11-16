// GET /api/hooks/:id/requests?after=N — list recorded requests; DELETE — clear them (token required).
import { listRequests, clearRequests } from '../../../../server/hooks-core.js';
import { fail } from '../../../../server/limits.js';

export const onRequestGet = ({ request, env, params }) => listRequests(request, env, params.id);
export const onRequestDelete = ({ request, env, params }) => clearRequests(request, env, params.id);
export const onRequest = () => fail(405, 'method_not_allowed', 'Use GET or DELETE', { Allow: 'GET, DELETE' });
