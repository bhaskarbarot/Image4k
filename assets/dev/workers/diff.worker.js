/* Module worker: runs the text diff off the main thread (the page stays responsive and the
 * caller can terminate it on timeout). Messages: {op:'diff', a, b, opts} | {op:'patch', a, b, nameA, nameB} */
import { computeDiff, unifiedPatch } from '../lib/textdiff.js';

self.onmessage = (e) => {
  const m = e.data || {};
  try {
    if (m.op === 'patch') self.postMessage({ patch: unifiedPatch(m.a, m.b, m.nameA, m.nameB) });
    else self.postMessage(computeDiff(m.a, m.b, m.opts || {}));
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : String(err) });
  }
};
