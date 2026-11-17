// DELETE /api/mail/inboxes/:id — drop a disposable inbox (token required).
import { deleteInbox } from '../../../../../server/mail-core.js';
import { fail } from '../../../../../server/limits.js';
export const onRequestDelete = ({ request, env, params }) => deleteInbox(request, env, params.id);
export const onRequest = () => fail(405, 'method_not_allowed', 'Use DELETE', { Allow: 'DELETE' });
