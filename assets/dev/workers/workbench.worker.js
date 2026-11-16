/* Runs a workbench recipe off the main thread; the page can terminate it (timeout / cancel). */
import { runRecipe } from '../lib/ops.js';

self.onmessage = async (e) => {
  const { input, steps } = e.data;
  try {
    const t0 = performance.now();
    const r = await runRecipe(input, steps, { onStep: (i) => self.postMessage({ progress: i }) });
    self.postMessage({ ok: true, type: r.type, value: r.value, steps: r.steps, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ error: err.message || String(err), details: { step: err.step ?? null, opName: err.opName ?? null, reason: err.reason ?? null } });
  }
};
