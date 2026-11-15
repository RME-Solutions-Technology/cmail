import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, CloudflareError } from '../lib/cloudflare.mjs';
import { isCloudflareMxHost, planSpf, readTxt, spfTopLevelLookups, effectiveTtl } from '../lib/mail-dns.mjs';
import { probeLight } from '../lib/probe.mjs';
import { TEST_TOKEN } from './mock-cloudflare.mjs';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 15);

test('Cloudflare MX hosts are recognised strictly', () => {
  assert.equal(isCloudflareMxHost('route1.mx.cloudflare.net'), true);
  assert.equal(isCloudflareMxHost('Route1.MX.Cloudflare.Net.'), true);
  assert.equal(isCloudflareMxHost('amir.mx.cloudflare.net'), true);
  assert.equal(isCloudflareMxHost('mx.cloudflare.net'), false);
  assert.equal(isCloudflareMxHost('route1.mx.cloudflare.net.evil.test'), false);
  assert.equal(isCloudflareMxHost('evilmx.cloudflare.net'), false);
  assert.equal(isCloudflareMxHost('example-com.mail.protection.outlook.test'), false);
});

test('TXT content is read quoted or unquoted; several strings are never edited', () => {
  assert.deepEqual(readTxt('"v=spf1 -all"'), { text: 'v=spf1 -all', quoted: true, multi: false });
  assert.deepEqual(readTxt('v=spf1 -all'), { text: 'v=spf1 -all', quoted: false, multi: false });
  assert.equal(readTxt('"v=spf1 a" "-all"').multi, true);
  assert.equal(readTxt('"v=spf1 a" trailing').multi, true);
});

test('SPF lookup counting and merging', () => {
  assert.equal(spfTopLevelLookups('v=spf1 include:a.test a mx ip4:192.0.2.1 ~all'), 3);
  assert.equal(spfTopLevelLookups('v=spf1 +a:x.test -mx/24 exists:%{i}.x.test redirect=y.test'), 4);
  const plan = planSpf([{ id: 'x', type: 'TXT', content: '"v=spf1 include:spf.protection.outlook.com -all"' }]);
  assert.equal(plan.action, 'edit');
  assert.equal(plan.after, '"v=spf1 include:_spf.mx.cloudflare.net include:spf.protection.outlook.com -all"');
  assert.equal(planSpf([{ id: 'x', type: 'TXT', content: 'v=spf1 INCLUDE:_spf.mx.cloudflare.net -all' }]).action, 'none');
});

test('Auto TTL counts as 300 seconds', () => {
  assert.equal(effectiveTtl(1), 300);
  assert.equal(effectiveTtl(3600), 3600);
});

test('probe light follows the Admin traffic light rules', () => {
  const pass = (ageMs, warnings = '') => ({ status: 'pass', warnings, started_at: NOW - ageMs - 1000, received_at: NOW - ageMs });
  const light = (runs, enabled = true) => probeLight({ enabled, runs, now: NOW, timeoutMinutes: 10 }).light;
  assert.equal(light([pass(HOUR)]), 'green');
  assert.equal(light([pass(HOUR, 'auth_not_recorded')]), 'green');
  assert.equal(light([pass(HOUR, 'slow')]), 'amber');
  assert.equal(light([pass(27 * HOUR)]), 'amber');
  assert.equal(light([pass(51 * HOUR)]), 'red');
  assert.equal(light([]), 'amber');
  assert.equal(light([pass(HOUR)], false), 'off');
  assert.equal(light([{ status: 'fail', reason: 'timeout', started_at: NOW - HOUR }, pass(2 * HOUR)]), 'red');
  // A test in flight for longer than the timeout, newer than the last pass, is red.
  assert.equal(light([{ status: 'waiting', started_at: NOW - 20 * 60 * 1000 }, pass(2 * HOUR)]), 'red');
  // A test still within its time keeps the last result.
  assert.equal(light([{ status: 'waiting', started_at: NOW - 60 * 1000 }, pass(2 * HOUR)]), 'green');
});

test('the client refuses paths outside the API base and bad ids', async () => {
  const calls = [];
  const client = createClient({ token: TEST_TOKEN, fetch: async (url) => { calls.push(url); return new Response('{}'); } });
  for (const path of ['/zones', 'https://evil.test/x', '//evil.test/x', 'zones/../../x']) {
    await assert.rejects(client.request('GET', path), CloudflareError);
  }
  await assert.rejects(client.listRecords('../x', 'MX'), /malformed Cloudflare id/);
  assert.equal(calls.length, 0);
  assert.throws(() => createClient({ token: 'short' }), /CLOUDFLARE_API_TOKEN/);
});

test('the client treats success:false and non-JSON answers as errors', async () => {
  const client = createClient({ token: TEST_TOKEN, fetch: async () => new Response('<html>', { status: 502 }) });
  await assert.rejects(client.emailRoutingSettings('0123456789abcdef0123456789abcdef'), /HTTP 502: no error detail/);
  const client2 = createClient({ token: TEST_TOKEN, fetch: async () => new Response('{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}', { status: 200 }) });
  await assert.rejects(client2.emailRoutingSettings('0123456789abcdef0123456789abcdef'), /10000 Authentication error/);
  const client3 = createClient({ token: TEST_TOKEN, fetch: async () => { throw new Error(`socket closed ${TEST_TOKEN}`); } });
  await assert.rejects(client3.emailRoutingSettings('0123456789abcdef0123456789abcdef'), (error) => !error.message.includes(TEST_TOKEN) && /\[redacted\]/.test(error.message));
});
