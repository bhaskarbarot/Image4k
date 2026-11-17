// POST /api/mail/inboxes — allocate a disposable address (see server/mail-core.js).
import { createInbox } from '../../../../server/mail-core.js';
import { fail } from '../../../../server/limits.js';
export const onRequestPost = ({ request, env }) => createInbox(request, env);
export const onRequest = () => fail(405, 'method_not_allowed', 'Use POST', { Allow: 'POST' });
