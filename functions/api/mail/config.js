// GET /api/mail/config — is temp-mail switched on, and on which domain(s)?
import { getConfig } from '../../../server/mail-core.js';
export const onRequestGet = ({ request, env }) => getConfig(request, env);
