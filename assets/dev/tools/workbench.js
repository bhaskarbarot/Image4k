/* Data Transformation Workbench — chain operations (a "recipe") and run them in order in a worker. */
import { h, editor, output, msgBox, btn, primary, store, debounce, toast, download, pickFile, formatBytes, copyText, checkbox, clear, looksLikeText, runWorker } from '../ui.js';
import { OPS, CATEGORIES, opById, defaultArgs, sanitizeRecipe, encodeRecipe, decodeRecipe } from '../lib/ops.js';
import { isProbablyText, utf8Decode, sniffType } from '../lib/encode.js';

const WORKER_URL = new URL('../workers/workbench.worker.js', import.meta.url);
const TIMEOUT = 30000;
const MAX_FILE = 100 * 1024 * 1024;

function hexPreview(bytes, max = 4096) {
  const out = [];
  const n = Math.min(bytes.length, max);
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    out.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}|`);
  }
  if (bytes.length > max) out.push(`… ${formatBytes(bytes.length)} total — download to get everything`);
  return out.join('\n');
}

export function mount(root) {
  const saved = store.get('workbench', { steps: [{ op: 'base64-encode' }], input: 'Hello, Professional Developer! 👋', auto: true });
  const fromHash = location.hash.startsWith('#recipe=') ? decodeRecipe(location.hash.slice(8)) : null;
  let steps = sanitizeRecipe(fromHash && fromHash.length ? fromHash : saved.steps);
  let inputBytes = null, inputName = '';
  let result = null; // { type, value }
  let job = null;
  const persist = () => store.set('workbench', { steps, input: input.get().length < 200000 ? input.get() : '', auto: auto.input.checked });

  const msg = msgBox();
  /* ---------- palette ---------- */
  const search = h('input', { type: 'search', class: 'dt-input wb-search', placeholder: 'Search operations…', attrs: { 'aria-label': 'Search operations', spellcheck: 'false' } });
  const palette = h('div', { class: 'wb-palette', attrs: { role: 'list' } });
  function renderPalette() {
    clear(palette);
    const q = search.value.trim().toLowerCase();
    let any = false;
    for (const cat of CATEGORIES) {
      const ops = OPS.filter((o) => o.category === cat && (!q || (o.name + ' ' + o.desc + ' ' + o.id).toLowerCase().includes(q)));
      if (!ops.length) continue;
      any = true;
      palette.appendChild(h('div', { class: 'wb-cat' }, cat));
      for (const o of ops) palette.appendChild(h('button', { type: 'button', class: 'wb-op', title: o.desc, dataset: { op: o.id }, attrs: { role: 'listitem' }, on: { click: () => addStep(o.id) } }, h('span', null, o.name), h('span', { class: 'wb-plus', attrs: { 'aria-hidden': 'true' } }, '+')));
    }
    if (!any) palette.appendChild(h('p', { class: 'dt-note' }, 'No operation matches.'));
  }
  search.addEventListener('input', renderPalette);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const f = palette.querySelector('.wb-op'); if (f) { f.click(); search.select(); } } });

  /* ---------- recipe ---------- */
  const recipeEl = h('ol', { class: 'wb-recipe', attrs: { 'aria-label': 'Recipe' } });
  let dragFrom = null;
  function addStep(id) {
    const op = opById(id);
    steps.push({ op: id, args: defaultArgs(op), disabled: false });
    renderRecipe(); changed();
    toast(`Added “${op.name}”`);
    const last = recipeEl.lastElementChild; if (last) last.scrollIntoView({ block: 'nearest' });
  }
  function move(i, d) {
    const j = i + d; if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    renderRecipe(); changed();
    recipeEl.children[j]?.querySelector(d < 0 ? '.wb-up' : '.wb-down')?.focus();
  }
  function argControl(step, a) {
    const val = step.args[a.id];
    const set = (v) => { step.args[a.id] = v; changed(); };
    let c;
    if (a.type === 'bool') {
      c = h('input', { type: 'checkbox', checked: !!val });
      c.addEventListener('change', () => set(c.checked));
      return h('label', { class: 'dt-check wb-arg' }, c, h('span', null, a.label));
    }
    if (a.type === 'select') {
      c = h('select', { class: 'dt-input' }, a.options.map(([v, l]) => h('option', { value: v }, l)));
      c.value = String(val);
      c.addEventListener('change', () => set(c.value));
    } else {
      c = h('input', { class: 'dt-input', type: a.type === 'number' ? 'number' : 'text', value: String(val ?? ''), attrs: { spellcheck: 'false' } });
      c.addEventListener('input', debounce(() => set(a.type === 'number' ? Number(c.value) : c.value), 250));
    }
    return h('label', { class: 'dt-field wb-arg' }, h('span', { class: 'dt-label' }, a.label), c);
  }
  function renderRecipe(errStep = null) {
    clear(recipeEl);
    if (!steps.length) { recipeEl.appendChild(h('li', { class: 'wb-empty' }, 'Your recipe is empty. Click an operation on the left (or search and press Enter) to add it.')); return; }
    steps.forEach((s, i) => {
      const op = opById(s.op);
      const li = h('li', { class: 'wb-step' + (s.disabled ? ' is-off' : '') + (errStep === i ? ' is-err' : ''), draggable: 'true', dataset: { i: String(i) } },
        h('div', { class: 'wb-step-head' },
          h('span', { class: 'wb-grip', title: 'Drag to reorder', attrs: { 'aria-hidden': 'true' } }, '⋮⋮'),
          h('span', { class: 'wb-num' }, String(i + 1)),
          h('strong', { class: 'wb-name', title: op.desc }, op.name),
          h('span', { class: 'wb-step-btns' },
            h('button', { type: 'button', class: 'wb-ibtn wb-up', title: 'Move up', attrs: { 'aria-label': `Move step ${i + 1} up` }, disabled: i === 0, on: { click: () => move(i, -1) } }, '↑'),
            h('button', { type: 'button', class: 'wb-ibtn wb-down', title: 'Move down', attrs: { 'aria-label': `Move step ${i + 1} down` }, disabled: i === steps.length - 1, on: { click: () => move(i, 1) } }, '↓'),
            h('button', { type: 'button', class: 'wb-ibtn wb-toggle', title: s.disabled ? 'Enable step' : 'Disable step', attrs: { 'aria-pressed': s.disabled ? 'true' : 'false', 'aria-label': `${s.disabled ? 'Enable' : 'Disable'} step ${i + 1}` }, on: { click: () => { s.disabled = !s.disabled; renderRecipe(); changed(); } } }, s.disabled ? '▶' : '⏸'),
            h('button', { type: 'button', class: 'wb-ibtn wb-del', title: 'Remove step', attrs: { 'aria-label': `Remove step ${i + 1}` }, on: { click: () => { steps.splice(i, 1); renderRecipe(); changed(); } } }, '✕'))),
        op.args.length ? h('div', { class: 'wb-args' }, op.args.map((a) => argControl(s, a))) : null);
      li.addEventListener('dragstart', (e) => { dragFrom = i; li.classList.add('is-drag'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (x) { /* ignore */ } });
      li.addEventListener('dragend', () => { li.classList.remove('is-drag'); dragFrom = null; });
      li.addEventListener('dragover', (e) => { if (dragFrom === null) return; e.preventDefault(); li.classList.add('is-over'); });
      li.addEventListener('dragleave', () => li.classList.remove('is-over'));
      li.addEventListener('drop', (e) => {
        e.preventDefault(); li.classList.remove('is-over');
        if (dragFrom === null || dragFrom === i) return;
        const [s2] = steps.splice(dragFrom, 1); steps.splice(i, 0, s2); dragFrom = null;
        renderRecipe(); changed();
      });
      // inputs inside a draggable card should still be selectable
      li.querySelectorAll('input,select').forEach((el) => { el.addEventListener('mousedown', () => { li.draggable = false; }); el.addEventListener('blur', () => { li.draggable = true; }); });
      recipeEl.appendChild(li);
    });
  }

  /* ---------- input / output ---------- */
  const input = editor({ label: 'Input', placeholder: 'Type or paste input…', paste: true, clear: true, rows: 10 });
  input.set(saved.input || '');
  const fileChip = h('div', { class: 'wb-file', hidden: true });
  const loadBtn = btn('Open file', async () => {
    const f = await pickFile(); if (!f) return;
    if (f.size > MAX_FILE) return toast(`File too large (${formatBytes(f.size)}). Limit ${formatBytes(MAX_FILE)}.`, 'err');
    if (f.size < 20 * 1024 * 1024 && (await looksLikeText(f))) { clearFile(); input.set(await f.text()); toast('Loaded ' + f.name); changed(); return; }
    inputBytes = new Uint8Array(await f.arrayBuffer()); inputName = f.name;
    input.ta.disabled = true; input.ta.value = ''; input.setMeta('');
    fileChip.hidden = false;
    fileChip.replaceChildren(h('span', null, `Binary input: ${f.name} · ${formatBytes(f.size)}`), btn('✕ Remove', () => { clearFile(); changed(); }, 'dt-mini'));
    changed();
  }, 'dt-mini', { 'data-act': 'open-file' });
  input.actions.prepend(loadBtn);
  function clearFile() { inputBytes = null; inputName = ''; fileChip.hidden = true; input.ta.disabled = false; }

  const out = output({ label: 'Output', copy: false, empty: 'Output appears here.' });
  const outInfo = h('div', { class: 'dt-stats wb-info', attrs: { 'aria-live': 'polite' } });
  out.actions.append(
    btn('Copy', (e) => {
      if (!result) return toast('Nothing to copy yet', 'err');
      if (result.type === 'bytes' && !isProbablyText(result.value)) return toast('Output is binary — use Download', 'err');
      copyText(result.type === 'bytes' ? utf8Decode(result.value) : result.value, e.currentTarget);
    }, 'dt-mini', { 'data-act': 'copy-output' }),
    btn('Download', () => {
      if (!result) return toast('Nothing to download yet', 'err');
      if (result.type === 'bytes') { const t = sniffType(result.value); download('output.' + t.ext, new Blob([result.value], { type: t.mime })); }
      else download('output.txt', result.value);
    }, 'dt-mini', { 'data-act': 'download-output' }),
    btn('→ Use as input', () => {
      if (!result) return;
      if (result.type === 'bytes' && !isProbablyText(result.value)) { inputBytes = result.value; inputName = 'previous output'; input.ta.disabled = true; input.ta.value = ''; fileChip.hidden = false; fileChip.replaceChildren(h('span', null, `Binary input: previous output · ${formatBytes(result.value.length)}`), btn('✕ Remove', () => { clearFile(); changed(); }, 'dt-mini')); }
      else { clearFile(); input.set(result.type === 'bytes' ? utf8Decode(result.value) : result.value); }
      changed();
    }, 'dt-mini', { 'data-act': 'use-output' }),
  );

  /* ---------- run ---------- */
  const auto = checkbox('Auto-run', saved.auto !== false, () => persist());
  const cancelBtn = btn('Cancel', () => { if (job) job.cancel(); }, 'dt-mini', { hidden: true, 'data-act': 'cancel' });
  cancelBtn.hidden = true;
  async function run() {
    if (job) { const old = job; job = null; old.cancel(); } // superseded run: ignore its result silently
    msg.hide();
    const active = steps.filter((s) => !s.disabled);
    const src = inputBytes || input.get();
    recipeEl.querySelectorAll('.wb-step.is-err').forEach((el) => el.classList.remove('is-err')); // keep focus in arg fields
    if (!steps.length) { result = null; out.set(''); outInfo.replaceChildren(h('span', { class: 'dt-note' }, 'Add an operation to transform the input.')); return; }
    if (!active.length) { result = null; out.set(''); outInfo.replaceChildren(h('span', { class: 'dt-note' }, 'All steps are disabled.')); return; }
    outInfo.replaceChildren(h('span', { class: 'dt-stat' }, 'Running…'));
    cancelBtn.hidden = false;
    const thisJob = (job = runWorker(WORKER_URL, { input: src, steps }, {
      timeout: TIMEOUT,
      onProgress: (i) => { outInfo.replaceChildren(h('span', { class: 'dt-stat' }, `Running step ${i + 2 > steps.length ? steps.length : i + 2} of ${steps.length}…`)); },
    }));
    try {
      const r = await thisJob.promise;
      if (thisJob !== job) return;
      result = { type: r.type, value: r.value };
      const size = r.type === 'bytes' ? r.value.length : new TextEncoder().encode(r.value).length;
      if (r.type === 'bytes' && !isProbablyText(r.value)) {
        const t = sniffType(r.value);
        out.set(hexPreview(r.value));
        outInfo.replaceChildren(h('span', { class: 'dt-badge is-ok' }, `✓ ${r.steps} step${r.steps === 1 ? '' : 's'}`), h('span', { class: 'dt-stat' }, 'Binary · ', h('b', null, t.mime)), h('span', { class: 'dt-stat' }, h('b', null, formatBytes(size))), h('span', { class: 'dt-stat' }, h('b', null, r.ms.toFixed(0)), ' ms'));
      } else {
        out.set(r.type === 'bytes' ? utf8Decode(r.value) : r.value);
        outInfo.replaceChildren(h('span', { class: 'dt-badge is-ok' }, `✓ ${r.steps} step${r.steps === 1 ? '' : 's'}`), h('span', { class: 'dt-stat' }, h('b', null, formatBytes(size))), h('span', { class: 'dt-stat' }, h('b', null, r.ms.toFixed(0)), ' ms'));
      }
    } catch (e) {
      if (thisJob !== job) return;
      result = null; out.set('');
      if (e.cancelled) { outInfo.replaceChildren(h('span', { class: 'dt-badge is-warn' }, 'Cancelled')); return; }
      if (e.timeout) { msg.error('Stopped after 30 s', 'The recipe took too long on this input. Try a smaller input or fewer steps.'); outInfo.replaceChildren(h('span', { class: 'dt-badge is-err' }, '⏱ Timed out')); return; }
      outInfo.replaceChildren(h('span', { class: 'dt-badge is-err' }, '✕ Failed'));
      msg.error(e.message, e.step != null ? 'Fix the input or this step’s settings. Earlier steps ran fine; later steps were not run.' : '');
      if (e.step != null) recipeEl.children[e.step]?.classList.add('is-err');
    } finally {
      if (thisJob === job) { job = null; cancelBtn.hidden = true; }
    }
  }
  const autoRun = debounce(() => { if (auto.input.checked) run(); }, 300);
  function changed() {
    persist();
    try { history.replaceState(null, '', location.pathname + location.search + (steps.length ? '#recipe=' + encodeRecipe(steps) : '')); } catch (e) { /* ignore */ }
    autoRun();
  }
  input.ta.addEventListener('input', changed);

  const shareBtn = btn('Copy share link', (e) => {
    if (!steps.length) return toast('Add operations first', 'err');
    copyText(location.origin + location.pathname + '#recipe=' + encodeRecipe(steps), e.currentTarget);
  }, 'dt-mini', { 'data-act': 'share' });
  const resetBtn = btn('Clear recipe', () => { steps = []; renderRecipe(); changed(); result = null; out.set(''); outInfo.replaceChildren(); }, 'dt-mini', { 'data-act': 'reset' });

  root.append(
    msg.el,
    h('div', { class: 'wb' },
      h('section', { class: 'wb-col wb-ops', attrs: { 'aria-label': 'Operations' } }, h('h2', { class: 'wb-h' }, 'Operations ', h('span', { class: 'dt-hint' }, `(${OPS.length})`)), search, palette),
      h('section', { class: 'wb-col wb-mid', attrs: { 'aria-label': 'Recipe' } },
        h('div', { class: 'wb-h-row' }, h('h2', { class: 'wb-h' }, 'Recipe'), h('div', { class: 'dt-actions' }, shareBtn, resetBtn)),
        recipeEl,
        h('div', { class: 'dt-toolbar wb-runbar' }, primary('Run recipe', run, { 'data-act': 'run' }), auto, cancelBtn)),
      h('section', { class: 'wb-col wb-io', attrs: { 'aria-label': 'Input and output' } }, input.el, fileChip, outInfo, out.el)),
    h('p', { class: 'dt-note' }, 'Steps run top to bottom in a background worker — your data never leaves this browser. Text is passed between steps as UTF-8; byte-producing steps (Base64 Decode, Hex → Bytes…) can be downloaded as files. Recipes are saved in this browser and can be shared as a link.'),
  );
  renderPalette();
  renderRecipe();
  run();
  return () => { autoRun.cancel(); if (job) job.cancel(); };
}
