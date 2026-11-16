/* Hashing — MD5, SHA-1, SHA-256, SHA-512.
 * SHA family uses the browser's Web Crypto (crypto.subtle) for text and files up to 256 MB.
 * MD5 (not in Web Crypto) and very large files use hash-wasm 4.12.0 (MIT, self-hosted), streamed in chunks
 * so a multi-GB file never has to fit in memory. Pure module: works in pages, workers and node. */
import { utf8Encode, bytesToBase64, bytesToHex } from './encode.js';

export const ALGORITHMS = ['MD5', 'SHA-1', 'SHA-256', 'SHA-512'];
export const INSECURE = new Set(['MD5', 'SHA-1']);
export const WEBCRYPTO_MAX = 256 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;

let hw = null;
async function hashWasm() {
  if (!hw) hw = import('../../vendor/hash-wasm-4.12.0/index.esm.min.js');
  return hw;
}
async function createHasher(alg) {
  const m = await hashWasm();
  switch (alg) {
    case 'MD5': return m.createMD5();
    case 'SHA-1': return m.createSHA1();
    case 'SHA-256': return m.createSHA256();
    case 'SHA-512': return m.createSHA512();
    default: throw new Error('Unsupported algorithm: ' + alg);
  }
}
function check(alg) { if (!ALGORITHMS.includes(alg)) throw new Error('Unsupported algorithm: ' + alg); }

/** hashBytes('SHA-256', Uint8Array) → Uint8Array digest */
export async function hashBytes(alg, bytes) {
  check(alg);
  if (alg !== 'MD5' && globalThis.crypto?.subtle) return new Uint8Array(await crypto.subtle.digest(alg, bytes));
  const h = await createHasher(alg);
  h.init(); h.update(bytes);
  return h.digest('binary');
}
export const hashText = (alg, text) => hashBytes(alg, utf8Encode(text));

/**
 * Hash a File/Blob with several algorithms in ONE read pass.
 * opts: { onProgress(fraction), signal (AbortSignal) } → { 'SHA-256': Uint8Array, ... }
 */
export async function hashBlob(blob, algs = ALGORITHMS, opts = {}) {
  algs.forEach(check);
  const useWebCrypto = blob.size <= WEBCRYPTO_MAX && !!globalThis.crypto?.subtle;
  const streamAlgs = algs.filter((a) => a === 'MD5' || !useWebCrypto);
  const subtleAlgs = algs.filter((a) => !streamAlgs.includes(a));
  const hashers = {};
  for (const a of streamAlgs) { hashers[a] = await createHasher(a); hashers[a].init(); }
  const keep = subtleAlgs.length ? new Uint8Array(blob.size) : null;
  let offset = 0;
  while (offset < blob.size) {
    if (opts.signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true, name: 'AbortError' });
    const chunk = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
    for (const a of streamAlgs) hashers[a].update(chunk);
    if (keep) keep.set(chunk, offset);
    offset += chunk.length;
    if (opts.onProgress) opts.onProgress(blob.size ? offset / blob.size : 1);
    if (!chunk.length) break;
  }
  if (opts.signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true, name: 'AbortError' });
  const out = {};
  for (const a of streamAlgs) out[a] = hashers[a].digest('binary');
  for (const a of subtleAlgs) out[a] = new Uint8Array(await crypto.subtle.digest(a, keep));
  if (!blob.size && opts.onProgress) opts.onProgress(1);
  return out;
}

export function digestToString(digest, format = 'hex') {
  if (format === 'HEX') return bytesToHex(digest, { upper: true });
  if (format === 'base64') return bytesToBase64(digest);
  return bytesToHex(digest);
}

/** Normalize a user-pasted checksum (hex any case, or base64) to lowercase hex for comparison; null if unrecognised. */
export function normalizeChecksum(s) {
  const t = String(s).trim().split(/\s+/)[0] || '';
  if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) return t.toLowerCase();
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) {
    try {
      const bin = atob(t.replace(/-/g, '+').replace(/_/g, '/'));
      let hex = '';
      for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
      return hex;
    } catch (e) { return null; }
  }
  return null;
}
/** Which algorithm produces a digest of this hex length? */
export function algForLength(hexLen) { return { 32: 'MD5', 40: 'SHA-1', 64: 'SHA-256', 128: 'SHA-512' }[hexLen] || null; }
