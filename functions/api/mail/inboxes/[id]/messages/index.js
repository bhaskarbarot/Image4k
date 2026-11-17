// GET /api/mail/inboxes/:id/messages?after=N — poll for new mail (token required).
import { listMessages } from '../../../../../../server/mail-core.js';
import { fail } from '../../../../../../server/limits.js';
export const onRequestGet = ({ request, env, params }) => listMessages(request, env, params.id);
export const onRequest = () => fail(405, 'method_not_allowed', 'Use GET', { Allow: 'GET' });
