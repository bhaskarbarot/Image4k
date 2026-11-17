// GET /api/mail/inboxes/:id/messages/:mid — full message; DELETE — remove it (token required).
import { getMessage, deleteMessage } from '../../../../../../server/mail-core.js';
import { fail } from '../../../../../../server/limits.js';
export const onRequestGet = ({ request, env, params }) => getMessage(request, env, params.id, params.mid);
export const onRequestDelete = ({ request, env, params }) => deleteMessage(request, env, params.id, params.mid);
export const onRequest = () => fail(405, 'method_not_allowed', 'Use GET or DELETE', { Allow: 'GET, DELETE' });
