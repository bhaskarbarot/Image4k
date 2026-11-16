import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, ipReason, parseIPv6, assertPublicUrl, SsrfError } from '../../server/ssrf.js';

const blockedV4 = ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.1.2.3',
  '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.10', '192.168.1.1', '198.18.0.1', '198.19.255.1',
  '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255'];
const publicV4 = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '169.253.1.1', '192.0.1.1', '198.17.255.255', '198.20.0.1', '223.255.255.255'];

for (const ip of blockedV4) test(`IPv4 blocked: ${ip}`, () => assert.ok(ipReason(ip), ip));
for (const ip of publicV4) test(`IPv4 public: ${ip}`, () => assert.equal(ipReason(ip), null, ip));

const blockedV6 = ['::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', 'ff00::',
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:8.8.8.8', '::127.0.0.1',
  '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '64:ff9b::8.8.8.8', '64:ff9b:1::1', '2001:db8::1', '2001:0db8:85a3::8a2e:370:7334', '100::1', '2001::1',
  '2002:7f00:0001::1', '2002:0a00:0001::', '2002:a9fe:a9fe::1', '3fff::1'.replace('3fff', '4000'), '1::1'];
const publicV6 = ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e', '2002:0808:0808::1'];
for (const ip of blockedV6) test(`IPv6 blocked: ${ip}`, () => assert.ok(ipReason(ip), ip));
for (const ip of publicV6) test(`IPv6 public: ${ip}`, () => assert.equal(ipReason(ip), null, ip));

test('IPv6 parser handles compression and embedded IPv4', () => {
  assert.deepEqual(parseIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.deepEqual(parseIPv6('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(parseIPv6('1::2::3'), null);
  assert.equal(parseIPv6('fe80::1%eth0'), null);
  assert.equal(parseIPv6('12345::'), null);
});

// The WHATWG URL parser normalises exotic IPv4 notations — make sure they are caught after normalisation.
const exotic = ['http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://0177.0.0.1/',
  'http://[::ffff:127.0.0.1]/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://0xA9FEA9FE/', 'http://[0:0:0:0:0:ffff:a9fe:a9fe]/', 'http://10.0.0.1/', 'http://0/'];
for (const u of exotic) test(`URL blocked: ${u}`, () => assert.throws(() => checkUrl(u), (e) => e instanceof SsrfError && e.code === 'blocked_destination'));

const badHosts = ['http://localhost/', 'http://LOCALHOST./', 'http://api.localhost/', 'http://printer.local/', 'http://db.internal/', 'http://metadata.google.internal/', 'http://router.lan/', 'http://intranet/', 'http://metadata/', 'http://x.home.arpa/', 'http://kubernetes.default/'];
for (const u of badHosts) test(`host blocked: ${u}`, () => assert.throws(() => checkUrl(u), SsrfError));

test('scheme, credentials and port rules', () => {
  assert.throws(() => checkUrl('ftp://example.com/'), (e) => e.code === 'invalid_scheme');
  assert.throws(() => checkUrl('file:///etc/passwd'), (e) => e.code === 'invalid_scheme');
  assert.throws(() => checkUrl('gopher://example.com/'), (e) => e.code === 'invalid_scheme');
  assert.throws(() => checkUrl('javascript:alert(1)'), (e) => e.code === 'invalid_scheme');
  assert.throws(() => checkUrl('not a url'), (e) => e.code === 'invalid_url');
  assert.throws(() => checkUrl('https://user:pw@example.com/'), (e) => e.code === 'credentials_in_url');
  assert.throws(() => checkUrl('http://example.com:22/'), (e) => e.code === 'port_not_allowed');
  assert.throws(() => checkUrl('http://example.com:6379/'), (e) => e.code === 'port_not_allowed');
  assert.equal(checkUrl('https://example.com:8443/x').hostname, 'example.com');
  assert.equal(checkUrl('http://example.com:8080/').port, '8080');
  assert.equal(checkUrl('https://api.github.com/users?x=1').hostname, 'api.github.com');
  assert.equal(checkUrl('https://8.8.8.8/').hostname, '8.8.8.8');
});
test('self requests are refused', () => {
  assert.throws(() => checkUrl('https://image4k.pages.dev/api/proxy', { selfHosts: ['image4k.pages.dev'] }), (e) => e.code === 'self_request');
  assert.throws(() => checkUrl('https://preview.image4k.pages.dev/', { selfHosts: ['image4k.pages.dev'] }), (e) => e.code === 'self_request');
});

const fakeResolve = (map) => async (host) => { if (!(host in map)) throw new SsrfError('Host not found', 'dns_not_found'); return map[host]; };
test('DNS answers are checked (rebinding mitigation)', async () => {
  const resolve = fakeResolve({ 'good.example': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'], 'evil.example': ['93.184.216.34', '127.0.0.1'], 'meta.example': ['169.254.169.254'], 'v6.example': ['::1'] });
  assert.equal((await assertPublicUrl('https://good.example/', { resolve })).hostname, 'good.example');
  await assert.rejects(assertPublicUrl('https://evil.example/', { resolve }), (e) => e.code === 'blocked_dns' && /127\.0\.0\.1/.test(e.message));
  await assert.rejects(assertPublicUrl('https://meta.example/', { resolve }), (e) => e.code === 'blocked_dns');
  await assert.rejects(assertPublicUrl('https://v6.example/', { resolve }), (e) => e.code === 'blocked_dns');
  await assert.rejects(assertPublicUrl('https://nx.example/', { resolve }), (e) => e.code === 'dns_not_found');
});
test('IP literal skips DNS', async () => {
  let called = false;
  await assertPublicUrl('https://1.1.1.1/', { resolve: async () => { called = true; return []; } });
  assert.equal(called, false);
});
test('resolveHost parses DoH JSON (fake fetch)', async () => {
  const { resolveHost } = await import('../../server/ssrf.js');
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('type=AAAA') ? { Status: 0, Answer: [{ type: 5, data: 'alias.' }] } : { Status: 0, Answer: [{ type: 5, data: 'x.' }, { type: 1, data: '10.1.2.3' }] }) });
  assert.deepEqual(await resolveHost('h.example', { fetchImpl }), ['10.1.2.3']);
  const nx = async () => ({ ok: true, json: async () => ({ Status: 3 }) });
  await assert.rejects(resolveHost('nx.example', { fetchImpl: nx }), /does not exist/);
});
