/* Image4k PDF — security tools: Protect (add password) and Unlock (remove password).
 * Everything runs locally in the browser; the password never leaves the device.
 * This tool NEVER cracks or guesses passwords — Unlock only works once the PDF is open,
 * which needs the password the user already knows.
 */
import { PdfDoc } from './engine.js?v=pdf7';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const MAX_BYTES = 200 * 1024 * 1024;
let ui;   // { toast, busy, askPassword, showView, openInEditor }

// PDF permission bits (PDF spec, Table 22). BASE has the reserved bits set and allows nothing;
// OR in the flags you want to allow. "All allowed" is 0xFFFFFFFF.
const PERM = {
  BASE: 0xFFFFF0C0,
  print: 0x4, modify: 0x8, copy: 0x10, annotate: 0x20,
  fillForms: 0x100, accessibility: 0x200, assemble: 0x400, printHigh: 0x800
};

async function openPdf(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error(`${file.name} is not a PDF`);
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 200 MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let password = '';
  for (;;) {
    try {
      const doc = await PdfDoc.open(bytes, password);
      doc.fileName = file.name;
      doc.openPassword = password;
      return doc;
    } catch (e) {
      if (e.code !== 4) throw e;
      ui.busy(false);
      password = await ui.askPassword(!!password, file.name);
      if (password === null) return null;
      ui.busy(true, 'Opening PDF…');
    }
  }
}

function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const baseName = (n) => (n || 'document').replace(/\.pdf$/i, '');
function randomPassword(n = 24) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
  const r = crypto.getRandomValues(new Uint32Array(n));
  return Array.from(r, (v) => a[v % a.length]).join('');
}

// password strength: 0..4
function strength(pw) {
  if (!pw) return { score: 0, label: '' };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return { score: Math.min(4, s), label: ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][Math.min(4, s)] };
}

// =====================================================================
// PROTECT
// =====================================================================
const prot = { doc: null, name: '', show: false };

async function protectOpen(file) {
  ui.busy(true, 'Opening PDF…');
  try {
    const doc = await openPdf(file);
    if (!doc) return;
    if (prot.doc) prot.doc.destroy();
    prot.doc = doc; prot.name = baseName(file.name);
    $('#prName').textContent = `${file.name} · ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}`;
    $('#prPass').value = ''; $('#prConfirm').value = '';
    $$('#protect [data-perm]').forEach((c) => { c.checked = true; });
    $('#prOwnerWrap').hidden = true; $('#prOwner').value = '';
    protectSync();
    if (doc.isEncrypted()) ui.toast('This PDF is already protected — a new password will replace the old one.');
    ui.showView('protect');
  } catch (e) { ui.toast(e.message, true); } finally { ui.busy(false); }
}

function protectSync() {
  const pw = $('#prPass').value, cf = $('#prConfirm').value;
  const s = strength(pw);
  const bar = $('#prStrength');
  bar.className = 'pstrength s' + s.score;
  $('#prStrengthLabel').textContent = pw ? s.label : '';
  const restricted = $$('#protect [data-perm]').some((c) => !c.checked);
  $('#prOwnerHint').hidden = !restricted;
  const match = pw && pw === cf;
  $('#prMismatch').hidden = !cf || match;
  $('#prGo').disabled = !match;
}

async function protectGo() {
  const pw = $('#prPass').value;
  if (!pw) { ui.toast('Enter a password first.', true); return; }
  if (pw !== $('#prConfirm').value) { ui.toast('The two passwords do not match.', true); return; }
  const allow = {};
  $$('#protect [data-perm]').forEach((c) => { allow[c.dataset.perm] = c.checked; });
  const restricted = Object.values(allow).some((v) => !v);
  let perms = 0xFFFFFFFF;
  if (restricted) {
    perms = PERM.BASE;
    if (allow.print) perms |= PERM.print | PERM.printHigh;
    if (allow.copy) perms |= PERM.copy | PERM.accessibility;
    if (allow.modify) perms |= PERM.modify | PERM.assemble;
    if (allow.annotate) perms |= PERM.annotate | PERM.fillForms;
  }
  // If permissions are restricted, the owner password must differ from the open password,
  // otherwise anyone who opens the file has full rights. Use the given owner password or a random one.
  let ownerPw = $('#prOwner').value.trim();
  if (restricted && !ownerPw) ownerPw = randomPassword();
  if (!restricted) ownerPw = pw;
  ui.busy(true, 'Protecting PDF…');
  try {
    prot.doc.encrypt(pw, ownerPw, perms >>> 0);
    downloadBytes(prot.doc.save(), `${prot.name}-protected.pdf`);
    // reload a clean copy so the view can be used again
    ui.toast(restricted ? 'Protected — password and permissions applied.' : 'Protected — your PDF now needs this password to open.');
  } catch (e) { ui.toast('Could not protect this PDF: ' + e.message, true); } finally { ui.busy(false); }
}

function bindProtect() {
  $('#prPass').addEventListener('input', protectSync);
  $('#prConfirm').addEventListener('input', protectSync);
  $$('#protect [data-perm]').forEach((c) => c.addEventListener('change', protectSync));
  $('#prShow').addEventListener('click', () => {
    prot.show = !prot.show;
    const t = prot.show ? 'text' : 'password';
    $('#prPass').type = t; $('#prConfirm').type = t; $('#prOwner').type = t;
    $('#prShow').textContent = prot.show ? 'Hide' : 'Show';
    $('#prShow').setAttribute('aria-pressed', String(prot.show));
  });
  $('#prOwnerToggle').addEventListener('click', () => {
    const w = $('#prOwnerWrap'); w.hidden = !w.hidden;
    $('#prOwnerToggle').setAttribute('aria-expanded', String(!w.hidden));
    if (!w.hidden) $('#prOwner').focus();
  });
  $('#prGo').addEventListener('click', protectGo);
}

// =====================================================================
// UNLOCK (remove password / restrictions)
// =====================================================================
async function unlockOpen(file) {
  ui.busy(true, 'Opening PDF…');
  try {
    const doc = await openPdf(file);
    if (!doc) return;
    try {
      const encrypted = doc.isEncrypted();
      const hadOpenPw = !!doc.openPassword;
      if (!encrypted) {
        ui.toast('This PDF has no password or restrictions — nothing to remove.', true);
        return;
      }
      ui.busy(true, 'Removing protection…');
      doc.decrypt();
      downloadBytes(doc.save(), `${baseName(file.name)}-unlocked.pdf`);
      ui.toast(hadOpenPw ? 'Password removed — your unlocked PDF is downloading.' : 'Restrictions removed — your unlocked PDF is downloading.');
    } finally { doc.destroy(); }
  } catch (e) { ui.toast(e.message, true); } finally { ui.busy(false); }
}

// =====================================================================
// entry points
// =====================================================================
export function initSecureTools(helpers) {
  ui = helpers;
  bindProtect();
}
export const secureTools = {
  protect: (file) => protectOpen(file),
  unlock: (file) => unlockOpen(file)
};
window.__pdfSecure = { prot, PERM };
