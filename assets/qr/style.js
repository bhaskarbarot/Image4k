/* QR style presets + colour maths (WCAG contrast). Pure, unit-tested. */

// Every preset keeps dark-on-light and ≥ 4.5:1 contrast. All presets were rendered at 900/520/300 px across
// 13 content lengths and decoded with zxing-cpp (390 images; the only miss was 400-character content at 300 px,
// which is physically too dense — the in-page small-size check warns about exactly that). The e2e suite
// re-checks every preset (tests/e2e/qr.e2e.mjs).
export const PRESETS = [
  { id: 'classic',  name: 'Classic',  dots: 'square',         corners: 'square',        cornerDots: 'square', fg: '#000000', bg: '#ffffff' },
  { id: 'brand',    name: 'Magenta',  dots: 'classy-rounded', corners: 'extra-rounded', cornerDots: 'dot',    fg: '#b0129f', fg2: '#5b21b6', gradient: 'linear', rot: 45, bg: '#ffffff' },
  { id: 'rounded',  name: 'Rounded',  dots: 'rounded',        corners: 'dot',           cornerDots: 'dot',    fg: '#111827', bg: '#ffffff' },
  { id: 'dots',     name: 'Dots',     dots: 'dots',           corners: 'dot',           cornerDots: 'dot',    fg: '#1f2937', bg: '#ffffff' },
  { id: 'classy',   name: 'Classy',   dots: 'classy-rounded', corners: 'extra-rounded', cornerDots: 'square', fg: '#0f172a', corner: '#be185d', bg: '#ffffff' },
  { id: 'ocean',    name: 'Ocean',    dots: 'extra-rounded',  corners: 'dot',           cornerDots: 'dot',    fg: '#0369a1', fg2: '#1e3a8a', gradient: 'radial', bg: '#ffffff' },
  { id: 'forest',   name: 'Forest',   dots: 'classy',         corners: 'square',        cornerDots: 'square', fg: '#065f46', bg: '#f0fdf4' },
  { id: 'sunset',   name: 'Sunset',   dots: 'rounded',        corners: 'extra-rounded', cornerDots: 'dot',    fg: '#c2410c', fg2: '#be123c', gradient: 'linear', rot: 135, bg: '#fffbeb' },
  { id: 'royal',    name: 'Royal',    dots: 'extra-rounded',  corners: 'dot',           cornerDots: 'dot',    fg: '#3730a3', corner: '#b45309', bg: '#ffffff' },
  { id: 'mono',     name: 'Ink',      dots: 'square',         corners: 'extra-rounded', cornerDots: 'dot',    fg: '#18181b', bg: '#f4f4f5' },
];

export function parseColor(c) {
  let s = String(c).trim().toLowerCase();
  if (s === 'transparent') return [255, 255, 255];
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return m[1].split('').map((x) => parseInt(x + x, 16));
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) return m[1].split(',').slice(0, 3).map((x) => Math.round(Number(x.trim())));
  return [0, 0, 0];
}
/** WCAG 2.x relative luminance */
export function relLum([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrastRatio(a, b) {
  const l1 = relLum(parseColor(a)), l2 = relLum(parseColor(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
