import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { D1_ID, DOMAIN, WORKER } from './mock-cloudflare.mjs';
import { newMock, run, snapshotFiles, tempDir } from './harness.mjs';

/** Switches a fresh mock for real (against the mock) and returns it with the apply snapshot. */
async function switched(t, mutate) {
  const dir = await tempDir(t);
  const mock = newMock(mutate);
  const before = { mx: mock.apexMx(), spf: mock.spf() };
  const result = await run('switch', ['--domain', DOMAIN, '--worker', WORKER, '--snapshot-dir', dir, '--probe-d1', D1_ID, '--apply', '--spf-include'], { mock, answer: DOMAIN });
  assert.equal(result.code, 0, result.text);
  const files = await snapshotFiles(dir);
  const snapshot = join(dir, files.find((f) => f.endsWith('-switch-apply.json')));
  mock.calls.length = 0;
  return { dir, mock, snapshot, before };
}

const back = (dir, snapshot) => ['--domain', DOMAIN, '--snapshot', snapshot, '--snapshot-dir', dir];

test('round trip: switch then switch-back restores the exact MX and SPF', async (t) => {
  const { dir, mock, snapshot, before } = await switched(t);
  assert.notDeepEqual(mock.apexMx(), before.mx);
  const result = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(mock.apexMx(), before.mx);
  assert.deepEqual(mock.spf(), before.spf);
  const writes = mock.writes();
  assert.equal(writes.length, 1, 'already unlocked: one batch only');
  assert.equal(writes[0].body.deletes.length, 3);
  assert.equal(writes[0].body.posts.length, 1);
  assert.equal(writes[0].body.posts[0].ttl, 300, 'restores the original TTL');
  assert.ok(!('comment' in writes[0].body.posts[0]), 'no comment invented for a record that had none');
  assert.match(result.text, /Copy back to Exchange/);
  assert.match(result.text, /docs\/copy-back\.md/);
  assert.match(result.text, /window 2026-11-15T03:00:00\.000Z to 2026-11-15T04:00:00\.000Z/);
});

test('switch-back dry run changes nothing and lists the reverse change set', async (t) => {
  const { dir, mock, snapshot } = await switched(t);
  const result = await run('switch-back', back(dir, snapshot), { mock });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(mock.writes(), []);
  assert.match(result.text, /- delete {2}MX {2}example\.com {2}13 route1\.mx\.cloudflare\.net/);
  assert.match(result.text, /\+ add {5}MX {2}example\.com {2}0 example-com\.mail\.protection\.outlook\.test {2}ttl 300s/);
  assert.match(result.text, /SPF\n.*from "v=spf1 include:_spf\.mx\.cloudflare\.net/);
  assert.equal(result.prompted, false);
});

test('unlocks Email Routing records first when they are locked', async (t) => {
  const { dir, mock, snapshot, before } = await switched(t);
  mock.settings = { ...mock.settings, status: 'ready' };
  for (const record of mock.records.values()) if (record.name === DOMAIN && record.type === 'MX') record.locked = true;
  const result = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN });
  assert.equal(result.code, 0, result.text);
  const writes = mock.writes();
  assert.equal(writes.length, 2);
  assert.equal(writes[0].method, 'PATCH');
  assert.match(writes[0].path, /\/email\/routing\/dns$/);
  assert.match(writes[1].path, /\/dns_records\/batch$/);
  assert.deepEqual(mock.apexMx(), before.mx);
});

test('restores MX after Email Routing was disabled meanwhile (no MX left)', async (t) => {
  const { dir, mock, snapshot, before } = await switched(t);
  for (const [id, record] of mock.records) if (record.name === DOMAIN && record.type === 'MX') mock.records.delete(id);
  mock.settings = { enabled: false, status: 'unconfigured' };
  const result = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(mock.apexMx(), before.mx);
  assert.ok(!mock.writes().some((w) => w.method === 'PATCH'), 'no unlock when Email Routing is off');
});

test('leaves SPF alone if it was edited after the switch', async (t) => {
  const { dir, mock, snapshot } = await switched(t);
  for (const record of mock.records.values()) {
    if (record.type === 'TXT' && record.name === DOMAIN && /v=spf1/.test(record.content)) record.content = '"v=spf1 include:_spf.mx.cloudflare.net include:spf.protection.outlook.com include:other.example.net -all"';
  }
  const result = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN });
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /edited since the switch; left as it is/);
  assert.equal(mock.writes()[0].body.patches.length, 0);
});

test('nothing to do when the MX already match the snapshot', async (t) => {
  const { dir, mock, snapshot } = await switched(t);
  const first = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN });
  assert.equal(first.code, 0, first.text);
  mock.calls.length = 0;
  const second = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN });
  assert.equal(second.code, 0, second.text);
  assert.match(second.text, /Nothing to do/);
  assert.equal(second.prompted, false);
  assert.deepEqual(mock.writes(), []);
});

test('refuses a tampered, foreign or wrong snapshot', async (t) => {
  const { dir, mock, snapshot } = await switched(t);
  const original = await readFile(snapshot, 'utf8');

  const tampered = join(dir, 'tampered.json');
  await writeFile(tampered, original.replace('example-com.mail.protection.outlook.test', 'mx.attacker.test'));
  const r1 = await run('switch-back', back(dir, tampered), { mock });
  assert.equal(r1.code, 1);
  assert.match(r1.text, /checksum does not match/);

  const r2 = await run('switch-back', ['--domain', 'example.org', '--snapshot', snapshot, '--snapshot-dir', dir], { mock });
  assert.equal(r2.code, 1);
  assert.match(r2.text, /for example\.com, not example\.org/);

  const files = await snapshotFiles(dir);
  const notOurs = join(dir, 'not-ours.json');
  await writeFile(notOurs, '{"hello":1}');
  const r3 = await run('switch-back', back(dir, notOurs), { mock });
  assert.equal(r3.code, 1);
  assert.match(r3.text, /not a cmail-standby-switch-snapshot/);

  const r4 = await run('switch-back', back(dir, join(dir, 'missing.json')), { mock });
  assert.equal(r4.code, 1);
  assert.match(r4.text, /Cannot read the snapshot/);

  // A snapshot written by switch-back (after-switch state) cannot be used to switch back.
  const applied = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN });
  assert.equal(applied.code, 0, applied.text);
  mock.calls.length = 0;
  const own = (await snapshotFiles(dir)).find((f) => /-switch-back-apply\.json$/.test(f) && !files.includes(f));
  const r5 = await run('switch-back', back(dir, join(dir, own)), { mock });
  assert.equal(r5.code, 1);
  assert.match(r5.text, /written by switch-back/);
  assert.deepEqual(mock.writes(), []);
});

test('refuses when the zone was re-created or has unknown MX records', async (t) => {
  const { dir, mock, snapshot } = await switched(t);
  mock.add({ type: 'MX', name: DOMAIN, content: 'mx.unknown.example.net', priority: 5, ttl: 300 });
  const r1 = await run('switch-back', back(dir, snapshot), { mock });
  assert.equal(r1.code, 1);
  assert.match(r1.text, /neither Cloudflare's nor in the snapshot/);

  const other = await switched(t);
  other.mock.zones[0].id = 'ffffffffffffffffffffffffffffffff';
  const r2 = await run('switch-back', back(other.dir, other.snapshot), { mock: other.mock });
  assert.equal(r2.code, 1);
  assert.match(r2.text, /zone id differs/);
});

test('switch-back apply needs the typed domain and is refused under CI', async (t) => {
  const { dir, mock, snapshot } = await switched(t);
  const wrong = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: 'no' });
  assert.equal(wrong.code, 1);
  assert.deepEqual(mock.writes(), []);
  const ci = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN, env: { CI: '1' } });
  assert.equal(ci.code, 1);
  assert.match(ci.text, /CI is set/);
  assert.deepEqual(mock.writes(), []);
});

test('a dry-run snapshot of the original records works for First-time setup', async (t) => {
  // 1. Before onboarding: a dry run records the Exchange MX (refused, as Email Routing is off).
  const dir = await tempDir(t);
  const mock = newMock((s) => { s.settings = { enabled: false, status: 'unconfigured' }; s.requiredDns = []; s.catchAll = null; });
  const before = mock.apexMx();
  const spfBefore = mock.spf();
  const dry = await run('switch', ['--domain', DOMAIN, '--worker', WORKER, '--snapshot-dir', dir, '--spf-include'], { mock });
  assert.equal(dry.code, 1);
  const snapshot = join(dir, (await snapshotFiles(dir))[0]);
  // 2. A person onboards Email Routing in the dashboard: Exchange MX deleted, Cloudflare's added and locked.
  for (const [id, record] of mock.records) if (record.name === DOMAIN && record.type === 'MX') mock.records.delete(id);
  for (const [content, priority] of [['route1.mx.cloudflare.net', 13], ['route2.mx.cloudflare.net', 24]]) {
    const id = mock.add({ type: 'MX', name: DOMAIN, content, priority, ttl: 1 });
    mock.records.get(id).locked = true;
  }
  mock.settings = { enabled: true, status: 'ready' };
  // ... and adds Cloudflare's SPF include by hand, right after v=spf1.
  for (const record of mock.records.values()) {
    if (record.type === 'TXT' && record.name === DOMAIN && /v=spf1/.test(record.content)) {
      record.content = record.content.replace('v=spf1 ', 'v=spf1 include:_spf.mx.cloudflare.net ');
    }
  }
  // 3. switch-back from the dry-run snapshot puts Exchange back.
  const refused = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /--allow-dry-run-snapshot/);
  const result = await run('switch-back', [...back(dir, snapshot), '--apply', '--allow-dry-run-snapshot'], { mock, answer: DOMAIN });
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /\(dry-run, taken/);
  assert.deepEqual(mock.apexMx(), before);
  assert.deepEqual(mock.spf(), spfBefore);
  assert.equal(mock.settings.status, 'unlocked');
});

test('unlock: only when the status says locked; a refused unlock is tolerated; --skip-unlock', async (t) => {
  // "ready" but nothing locked (records the switch created): the unlock is refused, the batch still works.
  const a = await switched(t);
  a.mock.settings = { ...a.mock.settings, status: 'ready' };
  for (const record of a.mock.records.values()) delete record.locked;
  const ra = await run('switch-back', [...back(a.dir, a.snapshot), '--apply'], { mock: a.mock, answer: DOMAIN });
  assert.equal(ra.code, 0, ra.text);
  assert.match(ra.text, /Unlock was refused/);
  assert.deepEqual(a.mock.apexMx(), a.before.mx);

  // "misconfigured" is not a locked status: no unlock call, and locked records make the batch refuse cleanly.
  const b = await switched(t);
  b.mock.settings = { ...b.mock.settings, status: 'misconfigured' };
  for (const record of b.mock.records.values()) if (record.name === DOMAIN && record.type === 'MX') record.locked = true;
  const rb = await run('switch-back', [...back(b.dir, b.snapshot), '--apply'], { mock: b.mock, answer: DOMAIN });
  assert.equal(rb.code, 1, rb.text);
  assert.ok(!b.mock.writes().some((w) => w.method === 'PATCH'));
  assert.match(rb.text, /Nothing was changed/);

  // --skip-unlock never calls unlock, even when the status says locked.
  const c = await switched(t);
  c.mock.settings = { ...c.mock.settings, status: 'ready' };
  const rc = await run('switch-back', [...back(c.dir, c.snapshot), '--apply', '--skip-unlock'], { mock: c.mock, answer: DOMAIN });
  assert.equal(rc.code, 0, rc.text);
  assert.ok(!c.mock.writes().some((w) => w.method === 'PATCH'));
});

test('exit 4 when records were unlocked but the batch was refused', async (t) => {
  const { dir, mock, snapshot, before } = await switched(t);
  mock.settings = { ...mock.settings, status: 'ready' };
  for (const record of mock.records.values()) if (record.name === DOMAIN && record.type === 'MX') record.locked = true;
  mock.failBatch = { code: 9000, message: 'Invalid record.' };
  const result = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN });
  assert.equal(result.code, 4, result.text);
  assert.match(result.text, /unlocked before the refusal; that is the only change/);
  assert.notDeepEqual(mock.apexMx(), before.mx);
});

test('switch-back batch with no clear answer is exit 3 with the command to finish', async (t) => {
  for (const [lost, pattern] of [['before', /does not look applied/], ['after', /It looks APPLIED/]]) {
    const { dir, mock, snapshot } = await switched(t);
    mock.batchLost = lost;
    mock.batched = false;
    const result = await run('switch-back', [...back(dir, snapshot), '--apply'], { mock, answer: DOMAIN });
    assert.equal(result.code, 3, result.text);
    assert.match(result.text, /OUTCOME UNKNOWN/);
    assert.match(result.text, pattern);
    assert.match(result.text, /switch-back\.mjs --domain example\.com --snapshot ".*-switch-apply\.json"/);
  }
});