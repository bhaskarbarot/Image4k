import { test } from 'node:test';
import assert from 'node:assert/strict';
import { url, text, email, phone, sms, whatsapp, wifi, vcard, custom, wifiEscape, vEscape, cleanPhone } from '../../assets/qr/payload.js';
import { PRESETS, contrastRatio, relLum, parseColor } from '../../assets/qr/style.js';

test('url: adds https, keeps valid URLs, rejects garbage', () => {
  assert.equal(url({ url: 'example.com/a?b=1' }).data, 'https://example.com/a?b=1');
  assert.equal(url({ url: '  https://x.org  ' }).data, 'https://x.org');
  assert.ok(url({ url: '' }).error);
  assert.ok(url({ url: 'http://exa mple.com' }).error);
  assert.ok(url({ url: 'intranet' }).warn);
});
test('text & custom keep content exactly (unicode)', () => {
  assert.equal(text({ text: 'नमस्ते 👋 ગુજરાતી' }).data, 'नमस्ते 👋 ગુજરાતી');
  assert.equal(custom({ text: 'upi://pay?pa=x@y&am=10' }).data, 'upi://pay?pa=x@y&am=10');
  assert.ok(text({ text: '' }).error);
});
test('email builds a mailto with encoded subject/body', () => {
  assert.equal(email({ to: 'a@b.co', subject: 'Hi & bye', body: 'Line 1\nLine 2' }).data, 'mailto:a@b.co?subject=Hi%20%26%20bye&body=Line%201%0ALine%202');
  assert.equal(email({ to: 'a@b.co' }).data, 'mailto:a@b.co');
  assert.ok(email({ to: 'nope' }).error);
});
test('phone / sms / whatsapp normalise numbers', () => {
  assert.equal(cleanPhone('+91 98765-43210'), '+919876543210');
  assert.equal(cleanPhone('0044 20 7946 0958'), '+442079460958');
  assert.equal(phone({ phone: '+91 98765 43210' }).data, 'tel:+919876543210');
  assert.ok(phone({ phone: '98765 43210' }).warn);
  assert.equal(sms({ phone: '+1 (555) 010-0000', message: 'Hello: there' }).data, 'SMSTO:+15550100000:Hello: there');
  assert.equal(whatsapp({ phone: '+91 98765 43210', message: 'Hi there!' }).data, 'https://wa.me/919876543210?text=Hi%20there!');
  assert.ok(whatsapp({ phone: '123' }).error);
});
test('wifi: escaping of special characters, auth types, hidden flag', () => {
  assert.equal(wifiEscape('a;b,c:d"e\\f'), 'a\\;b\\,c\\:d\\"e\\\\f');
  assert.equal(wifi({ ssid: 'Home;Net', password: 'p@ss:word', auth: 'WPA' }).data, 'WIFI:T:WPA;S:Home\\;Net;P:p@ss\\:word;;');
  assert.equal(wifi({ ssid: 'Cafe', auth: 'nopass', hidden: true }).data, 'WIFI:T:nopass;S:Cafe;H:true;;');
  assert.equal(wifi({ ssid: 'X', password: 'DEADBEEF', auth: 'WPA' }).data, 'WIFI:T:WPA;S:X;P:"DEADBEEF";;');
  assert.ok(wifi({ ssid: 'X', password: 'short', auth: 'WPA' }).warn);
  assert.ok(wifi({ ssid: '', password: 'x' }).error);
  assert.ok(wifi({ ssid: 'X', password: '', auth: 'WPA' }).error);
});
test('vcard 3.0: required lines, escaping, CRLF', () => {
  const v = vcard({ first: 'Zoë', last: 'Shah, Jr', org: 'A;B', mobile: '+91 98765 43210', email: 'z@x.io', website: 'x.io', note: 'line1\nline2', city: 'Ahmedabad', country: 'India' }).data;
  const lines = v.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCARD'); assert.equal(lines[1], 'VERSION:3.0'); assert.equal(lines.at(-1), 'END:VCARD');
  assert.ok(lines.includes('N:Shah\\, Jr;Zoë;;;'));
  assert.ok(lines.includes('FN:Zoë Shah\\, Jr'));
  assert.ok(lines.includes('ORG:A\\;B'));
  assert.ok(lines.includes('TEL;TYPE=CELL:+919876543210'));
  assert.ok(lines.includes('URL:https://x.io'));
  assert.ok(lines.includes('NOTE:line1\\nline2'));
  assert.ok(lines.includes('ADR;TYPE=WORK:;;;Ahmedabad;;;India'));
  assert.equal(vEscape('a\\b'), 'a\\\\b');
  assert.ok(vcard({}).error);
  assert.ok(vcard({ first: 'A', email: 'bad' }).error);
});
test('contrast maths matches WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrastRatio('#777777', '#ffffff').toFixed(2), '4.48');
  assert.equal(contrastRatio('#fff', '#ffffff').toFixed(1), '1.0');
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30]);
  assert.ok(relLum([255, 255, 255]) > 0.99);
});
test('every built-in style preset is dark-on-light with ≥ 4.5:1 contrast for all its colours', () => {
  for (const p of PRESETS) {
    for (const c of [p.fg, p.fg2, p.corner].filter(Boolean)) {
      assert.ok(contrastRatio(c, p.bg) >= 4.5, `${p.id} ${c} on ${p.bg} = ${contrastRatio(c, p.bg).toFixed(2)}`);
      assert.ok(relLum(parseColor(c)) < relLum(parseColor(p.bg)), `${p.id} must be dark on light`);
    }
  }
});
