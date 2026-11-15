import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { D1_ID, DOMAIN, TEST_TOKEN, WORKER, exchangeMx } from './mock-cloudflare.mjs';
import { newMock, run, snapshotFiles, tempDir } from './harness.mjs';

const base = (dir) => ['--domain', DOMAIN, '--worker', WORKER, '--snapshot-dir', dir];
const withProbe = (dir) => [...base(dir), '--probe-d1', D1_ID];

test('dry run prints both change sets, writes a snapshot and changes nothing', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  const result = await run('switch', withProbe(dir), { mock });
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /DRY RUN/);
  assert.match(result.text, /- delete {2}MX {2}example\.com {2}0 example-com\.mail\.protection\.outlook\.test/);
  for (const host of ['route1', 'route2', 'route3']) assert.match(result.text, new RegExp(`\\+ add {5}MX {2}example\\.com {2}\\d+ ${host}\\.mx\\.cloudflare\\.net`));
  assert.match(result.text, /Reverse change set/);
  assert.match(result.text, /include:_spf\.mx\.cloudflare\.net include:spf\.protection\.outlook\.com -all/);
  assert.match(result.text, /Standby probe: GREEN/);
  assert.equal(result.prompted, false);
  assert.deepEqual(mock.writes(), [], 'a dry run makes no write calls');
  const files = await snapshotFiles(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^example\.com-\d{8}T\d{9}Z-switch-dry-run\.json$/);
  const snapshot = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
  assert.equal(snapshot.records.apexMx.length, 1);
  assert.equal(snapshot.records.apexMx[0].content, exchangeMx().content);
  assert.match(snapshot.checksum, /^[0-9a-f]{64}$/);
});

test('every request goes to api.cloudflare.com, never follows redirects, and the token is never printed', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  const result = await run('switch', withProbe(dir), { mock });
  assert.ok(mock.calls.length > 5);
  for (const call of mock.calls) {
    assert.equal(call.host, 'api.cloudflare.com');
    assert.equal(call.redirect, 'error');
  }
  assert.ok(!result.text.includes(TEST_TOKEN));
  const files = await snapshotFiles(dir);
  assert.ok(!(await readFile(join(dir, files[0]), 'utf8')).includes(TEST_TOKEN));
});

test('an API error that echoes the token is redacted', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  mock.errorFor.set('GET /zones', { status: 400, code: 1001, message: `bad header Bearer ${TEST_TOKEN}` });
  const result = await run('switch', base(dir), { mock });
  assert.equal(result.code, 1);
  assert.ok(!result.text.includes(TEST_TOKEN));
  assert.match(result.text, /\[redacted\]/);
});

test('apply with the typed domain makes one batch and points the apex at Cloudflare', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  const result = await run('switch', [...withProbe(dir), '--apply'], { mock, answer: 'example.com' });
  assert.equal(result.code, 0, result.text);
  assert.equal(result.prompted, true);
  const writes = mock.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.match(writes[0].path, /\/dns_records\/batch$/);
  assert.equal(writes[0].body.deletes.length, 1);
  assert.equal(writes[0].body.posts.length, 3);
  for (const post of writes[0].body.posts) {
    assert.equal(post.ttl, 1, 'Cloudflare MX use Auto TTL (300s)');
    assert.match(post.comment, /^cmail standby switch /);
  }
  assert.deepEqual(mock.apexMx(), ['13 route1.mx.cloudflare.net ttl 1', '24 route2.mx.cloudflare.net ttl 1', '86 route3.mx.cloudflare.net ttl 1']);
  assert.deepEqual(mock.spf(), ['"v=spf1 include:_spf.mx.cloudflare.net include:spf.protection.outlook.com -all"']);
  const files = await snapshotFiles(dir);
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => /-switch-apply\.json$/.test(f)));
  const resultFile = files.find((f) => f.endsWith('.result.json'));
  assert.equal(JSON.parse(await readFile(join(dir, resultFile), 'utf8')).verified, true);
  assert.match(result.text, /switch-back\.mjs --domain example\.com --snapshot/);
});

test('apply stops when the typed confirmation does not match', async (t) => {
  for (const answer of ['', 'yes', 'example.org', 'EXAMPLE.CO']) {
    const dir = await tempDir(t);
    const mock = newMock();
    const result = await run('switch', [...withProbe(dir), '--apply'], { mock, answer });
    assert.equal(result.code, 1);
    assert.match(result.text, /confirmation did not match/);
    assert.deepEqual(mock.writes(), []);
  }
});

test('apply is refused under CI before anything is read', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  const result = await run('switch', [...withProbe(dir), '--apply'], { mock, answer: DOMAIN, env: { CI: 'true' } });
  assert.equal(result.code, 1);
  assert.match(result.text, /CI is set/);
  assert.equal(mock.calls.length, 0);
});

test('apply needs a probe reading or an explicit skip', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  const refused = await run('switch', [...base(dir), '--apply'], { mock, answer: DOMAIN });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /--probe-d1/);
  assert.equal(refused.prompted, false);
  assert.deepEqual(mock.writes(), []);

  const skipped = await run('switch', [...base(dir), '--apply', '--skip-probe-check'], { mock, answer: DOMAIN });
  assert.equal(skipped.code, 0, skipped.text);
  assert.match(skipped.text, /NOT CHECKED/);
});

test('a probe that is not green is refused, even with --skip-probe-check', async (t) => {
  const cases = [
    ['red on a failed test', (s) => { s.d1.runs = [{ status: 'fail', reason: 'timeout', warnings: '' }]; }, /red \(timeout\)/],
    ['amber when stale', (s) => { s.probeAge = 30 * 60 * 60 * 1000; }, /amber \(stale\)/],
    ['amber when filed to spam', (s) => { s.d1.runs[0].warnings = 'spam_folder'; }, /amber \(spam_folder\)/],
    ['off when the standby address is off', (s) => { s.d1.enabled = 'false'; }, /off/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const dir = await tempDir(t);
    const mock = newMock(mutate);
    const result = await run('switch', [...withProbe(dir), '--apply', '--skip-probe-check'], { mock, answer: DOMAIN });
    assert.equal(result.code, 1, name);
    assert.match(result.text, pattern, name);
    assert.match(result.text, /not green/, name);
    assert.deepEqual(mock.writes(), [], name);
  }
});

test('an unreadable probe is refused unless --skip-probe-check', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock((s) => { s.d1 = null; });
  const refused = await run('switch', [...withProbe(dir), '--apply'], { mock, answer: DOMAIN });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /Could not read the standby probe/);
  assert.deepEqual(mock.writes(), []);
  const skipped = await run('switch', [...withProbe(dir), '--apply', '--skip-probe-check'], { mock, answer: DOMAIN });
  assert.equal(skipped.code, 0, skipped.text);
});

test('the probe needs CLOUDFLARE_ACCOUNT_ID', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  const result = await run('switch', withProbe(dir), { mock, env: { CLOUDFLARE_ACCOUNT_ID: '' } });
  assert.equal(result.code, 1);
  assert.match(result.text, /CLOUDFLARE_ACCOUNT_ID/);
});

test('refuses a zone that is not on Cloudflare DNS, not active, or not the apex', async (t) => {
  const cases = [
    ['partial zone', (s) => { s.zones[0].type = 'partial'; }, /not "full"/],
    ['secondary zone', (s) => { s.zones[0].type = 'secondary'; }, /not "full"/],
    ['pending zone', (s) => { s.zones[0].status = 'pending'; }, /not active/],
    ['no zone', (s) => { s.zones = []; }, /No Cloudflare zone/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const dir = await tempDir(t);
    const mock = newMock(mutate);
    const result = await run('switch', withProbe(dir), { mock });
    assert.equal(result.code, 1, name);
    assert.match(result.text, pattern, name);
  }
  const dir = await tempDir(t);
  const sub = await run('switch', ['--domain', `mail.${DOMAIN}`, '--worker', WORKER, '--snapshot-dir', dir], { mock: newMock() });
  assert.equal(sub.code, 1);
  assert.match(sub.text, /zone apex/);
});

test('refuses MX TTLs above the limit and says how to lower them', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock((s) => { s.records[0] = exchangeMx({ ttl: 3600 }); });
  const result = await run('switch', withProbe(dir), { mock });
  assert.equal(result.code, 1);
  assert.match(result.text, /TTL above 300 seconds/);
  assert.match(result.text, /Wait at least 3600 seconds/);
  // A higher limit lets it through.
  const relaxed = await run('switch', [...withProbe(dir), '--max-ttl', '3600'], { mock });
  assert.equal(relaxed.code, 0, relaxed.text);
  // Auto TTL counts as 300 seconds.
  const auto = await run('switch', withProbe(dir), { mock: newMock((s) => { s.records[0] = exchangeMx({ ttl: 1 }); }) });
  assert.equal(auto.code, 0, auto.text);
});

test('refuses when Email Routing is not enabled (first-time setup is by hand) or locked', async (t) => {
  const cases = [
    ['not enabled', (s) => { s.settings = { enabled: false, status: 'unconfigured' }; }, /error 2008/],
    ['locked', (s) => { s.settings.status = 'misconfigured/locked'; }, /Unlock them/],
    ['unknown status', (s) => { s.settings.status = 'something-new'; }, /does not know how to handle/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const dir = await tempDir(t);
    const mock = newMock(mutate);
    const result = await run('switch', [...withProbe(dir), '--apply'], { mock, answer: DOMAIN });
    assert.equal(result.code, 1, name);
    assert.match(result.text, pattern, name);
    assert.equal(result.prompted, false, name);
    assert.deepEqual(mock.writes(), [], name);
    // The original MX is still recorded, for First-time setup.
    const files = await snapshotFiles(dir);
    assert.equal(files.length, 1, name);
    assert.match(files[0], /-switch-dry-run\.json$/, name);
  }
});

test('refuses unless the catch-all is enabled and sends to the named Worker', async (t) => {
  const cases = [
    ['missing', (s) => { s.catchAll = null; }],
    ['empty answer', (s) => { s.catchAll = undefined; }],
    ['disabled', (s) => { s.catchAll.enabled = false; }],
    ['drop', (s) => { s.catchAll.actions = [{ type: 'drop', value: [] }]; }],
    ['another worker', (s) => { s.catchAll.actions = [{ type: 'worker', value: ['other-worker'] }]; }],
    ['forward', (s) => { s.catchAll.actions = [{ type: 'forward', value: ['someone@example.net'] }]; }],
  ];
  for (const [name, mutate] of cases) {
    const dir = await tempDir(t);
    const mock = newMock(mutate);
    const result = await run('switch', withProbe(dir), { mock });
    assert.equal(result.code, 1, name);
    assert.match(result.text, /catch-all|Catch-all/, name);
  }
});

test('warns about literal rules that route apex addresses elsewhere', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock((s) => {
    s.rules = [{ id: 'r1', name: 'info', enabled: true, matchers: [{ type: 'literal', field: 'to', value: `info@${DOMAIN}` }], actions: [{ type: 'forward', value: ['someone@example.net'] }] }];
  });
  const result = await run('switch', withProbe(dir), { mock });
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /info@example\.com does not go to the Worker/);
});

test('already switched: nothing to do', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock((s) => {
    s.records[0] = { ...exchangeMx(), content: 'route1.mx.cloudflare.net', priority: 13 };
  });
  const result = await run('switch', [...withProbe(dir), '--apply'], { mock, answer: DOMAIN });
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /already on the standby/);
  assert.equal(result.prompted, false);
  assert.deepEqual(mock.writes(), []);
});

test('refuses a half-switched apex and an apex without MX', async (t) => {
  const half = newMock((s) => { s.records.push({ ...exchangeMx(), content: 'route1.mx.cloudflare.net', priority: 13 }); });
  const r1 = await run('switch', withProbe(await tempDir(t)), { mock: half });
  assert.equal(r1.code, 1);
  assert.match(r1.text, /half-switched/);
  const none = newMock((s) => { s.records.shift(); });
  const r2 = await run('switch', withProbe(await tempDir(t)), { mock: none });
  assert.equal(r2.code, 1);
  assert.match(r2.text, /no MX records at the apex/);
});

test('Cloudflare MX come from Cloudflare, or from --cloudflare-mx only when Cloudflare lists none', async (t) => {
  const listsNone = (s) => { s.requiredDns = []; };
  const r1 = await run('switch', withProbe(await tempDir(t)), { mock: newMock(listsNone) });
  assert.equal(r1.code, 1);
  assert.match(r1.text, /listed no Email Routing MX/);

  const mock = newMock(listsNone);
  const r2 = await run('switch', [...withProbe(await tempDir(t)), '--cloudflare-mx', 'amir.mx.cloudflare.net:13,linda.mx.cloudflare.net:86', '--apply'], { mock, answer: DOMAIN });
  assert.equal(r2.code, 0, r2.text);
  assert.deepEqual(mock.apexMx(), ['13 amir.mx.cloudflare.net ttl 1', '86 linda.mx.cloudflare.net ttl 1']);

  const r3 = await run('switch', [...withProbe(await tempDir(t)), '--cloudflare-mx', 'route1.mx.cloudflare.net:13'], { mock: newMock() });
  assert.equal(r3.code, 1);
  assert.match(r3.text, /remove --cloudflare-mx/);

  for (const bad of ['mx.example.net:10', 'route1.mx.cloudflare.net', 'route1.mx.cloudflare.net:70000', 'x.mx.cloudflare.net.evil.test:1']) {
    const r = await run('switch', [...withProbe(await tempDir(t)), '--cloudflare-mx', bad], { mock: newMock(listsNone) });
    assert.equal(r.code, 1, bad);
    assert.match(r.text, /--cloudflare-mx entries must look like/, bad);
  }

  const evil = newMock((s) => { s.requiredDns = [{ type: 'MX', name: DOMAIN, content: 'mx.attacker.test', priority: 1, ttl: 1 }]; });
  const r4 = await run('switch', withProbe(await tempDir(t)), { mock: evil });
  assert.equal(r4.code, 1);
  assert.match(r4.text, /not a valid \*\.mx\.cloudflare\.net host/);
});

test('SPF: keeps Exchange, adds Cloudflare once, and refuses what it cannot edit safely', async (t) => {
  const spfAt = (content) => (s) => { s.records[1] = { ...s.records[1], content }; };

  const already = newMock(spfAt('"v=spf1 include:_spf.mx.cloudflare.net include:spf.protection.outlook.com -all"'));
  const a = await run('switch', [...withProbe(await tempDir(t)), '--apply'], { mock: already, answer: DOMAIN });
  assert.equal(a.code, 0, a.text);
  assert.equal(already.writes()[0].body.patches.length, 0);

  const unquoted = newMock(spfAt('v=spf1 include:spf.protection.outlook.com ~all'));
  const u = await run('switch', [...withProbe(await tempDir(t)), '--apply'], { mock: unquoted, answer: DOMAIN });
  assert.equal(u.code, 0, u.text);
  assert.deepEqual(unquoted.spf(), ['v=spf1 include:_spf.mx.cloudflare.net include:spf.protection.outlook.com ~all']);

  const split = newMock(spfAt('"v=spf1 include:spf.protection.outlook.com " "-all"'));
  const sp = await run('switch', withProbe(await tempDir(t)), { mock: split });
  assert.equal(sp.code, 1);
  assert.match(sp.text, /split into several strings/);
  const spNo = await run('switch', [...withProbe(await tempDir(t)), '--no-spf-change'], { mock: split });
  assert.equal(spNo.code, 0, spNo.text);

  const two = newMock((s) => { s.records.push({ type: 'TXT', name: DOMAIN, content: '"v=spf1 -all"', ttl: 1 }); });
  const tw = await run('switch', withProbe(await tempDir(t)), { mock: two });
  assert.equal(tw.code, 1);
  assert.match(tw.text, /2 SPF records/);

  const many = newMock(spfAt(`"v=spf1 ${Array.from({ length: 10 }, (_, i) => `include:s${i}.example.net`).join(' ')} -all"`));
  const m = await run('switch', withProbe(await tempDir(t)), { mock: many });
  assert.equal(m.code, 1);
  assert.match(m.text, /11 top-level SPF lookups/);

  const none = newMock((s) => { s.records.splice(1, 1); });
  const n = await run('switch', [...withProbe(await tempDir(t)), '--apply'], { mock: none, answer: DOMAIN });
  assert.equal(n.code, 0, n.text);
  assert.match(n.text, /does not create one/);
  assert.deepEqual(none.spf(), []);

  const noChange = newMock();
  const nc = await run('switch', [...withProbe(await tempDir(t)), '--apply', '--no-spf-change'], { mock: noChange, answer: DOMAIN });
  assert.equal(nc.code, 0, nc.text);
  assert.deepEqual(noChange.spf(), ['"v=spf1 include:spf.protection.outlook.com -all"']);
});

test('a failed batch changes nothing', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  mock.failBatch = { code: 81053, message: 'An identical record already exists.' };
  const before = mock.apexMx();
  const result = await run('switch', [...withProbe(dir), '--apply'], { mock, answer: DOMAIN });
  assert.equal(result.code, 1);
  assert.match(result.text, /STOPPED: POST .*dns_records\/batch: HTTP 400: 81053/);
  assert.deepEqual(mock.apexMx(), before);
});

test('refuses to apply when records changed while waiting for the confirmation', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  const answer = { toString() { mock.add(exchangeMx({ content: 'backup.example.net', priority: 10 })); return DOMAIN; } };
  const result = await run('switch', [...withProbe(dir), '--apply'], { mock, answer });
  assert.equal(result.code, 1);
  assert.match(result.text, /changed since they were read/);
  assert.deepEqual(mock.writes(), []);
});

test('reports a mismatch after apply with exit code 2', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  const realBatch = mock.batch.bind(mock);
  mock.batch = (body) => realBatch({ ...body, posts: body.posts.slice(0, 2) });
  const result = await run('switch', [...withProbe(dir), '--apply'], { mock, answer: DOMAIN });
  assert.equal(result.code, 2);
  assert.match(result.text, /missing MX: route3\.mx\.cloudflare\.net\|86/);
  assert.match(result.text, /To undo: node scripts\/standby\/switch-back\.mjs/);
});

test('input checks', async (t) => {
  const dir = await tempDir(t);
  const mock = newMock();
  const cases = [
    [['--worker', WORKER], /--domain/],
    [['--domain', DOMAIN], /--worker/],
    [['--domain', DOMAIN, '--worker', 'Bad Name'], /--worker/],
    [['--domain', DOMAIN, '--worker', WORKER, '--max-ttl', '10'], /--max-ttl/],
    [['--domain', DOMAIN, '--worker', WORKER, '--probe-d1', '../x'], /--probe-d1/],
    [['--domain', DOMAIN, '--worker', WORKER, '--bogus'], /Unknown option/],
  ];
  for (const [argv, pattern] of cases) {
    const result = await run('switch', [...argv, '--snapshot-dir', dir], { mock });
    assert.equal(result.code, 1, argv.join(' '));
    assert.match(result.text, pattern, argv.join(' '));
  }
  const noToken = await run('switch', base(dir), { mock, env: { CLOUDFLARE_API_TOKEN: '' } });
  assert.equal(noToken.code, 1);
  assert.match(noToken.text, /CLOUDFLARE_API_TOKEN/);
  assert.equal(mock.calls.length, 0);
});
