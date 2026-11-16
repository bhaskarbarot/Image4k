// DELETE /api/hooks/:id — delete an endpoint and its recorded requests (token required).
import { deleteHook } from '../../../../server/hooks-core.js';
import { fail } from '../../../../server/limits.js';

export const onRequestDelete = ({ request, env, params }) => deleteHook(request, env, params.id);
export const onRequest = () => fail(405, 'method_not_allowed', 'Use DELETE', { Allow: 'DELETE' });
