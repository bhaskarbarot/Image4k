/* Runs a regex in isolation. The page terminates this worker after a timeout, which is the only reliable
 * way to stop catastrophic backtracking in JavaScript. */
import { runRegex } from '../lib/regex.js';

self.onmessage = (e) => {
  try {
    const r = runRegex(e.data);
    if (r.error) self.postMessage({ error: r.error, details: { invalid: true } });
    else self.postMessage(r);
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : String(err) });
  }
};
