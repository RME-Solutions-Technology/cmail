import { describe, expect, it } from 'vitest';
import { loadM365SyncState } from '@cmail/shared/m365-sync';
import { migratedDatabase } from '../testing/sqlite-d1';
import { runM365SyncTick, type M365SyncDeps, type M365SyncWorkerEnv } from './sync';
import {
  CLIENT_ID,
  DOMAIN,
  SCOPE_GROUP,
  SHARED_GROUP,
  TENANT_ID,
  fakeGraph,
  oid,
  person,
  removed,
} from './testing/fake-graph';

// Shared mailbox detection from Exchange's mailbox type (Graph
// mailboxSettings userPurpose), M365_DETECT_SHARED_MAILBOXES = "true".
// Real migrations on node:sqlite, fake Graph. Placeholder GUIDs and
// example.test addresses only.

const T0 = Date.parse('2026-11-15T00:00:00Z');
const HOUR = 60 * 60 * 1000;

/** What a shared mailbox usually looks like in Entra: disabled and unlicensed. */
const sharedObject = (n: number, local: string) => person(n, local, { accountEnabled: false, assignedPlans: [], displayName: `Team ${n}` });

function setup(options: { dryRun?: boolean; env?: Record<string, string> } = {}) {
  const { d1, sqlite } = migratedDatabase();
  const fake = fakeGraph();
  let clock = T0;
  let ids = 0;
  const setting = (key: string, value: string) => sqlite.prepare(
    `INSERT INTO org_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
  setting('m365_sync_enabled', 'true');
  setting('m365_sync_dry_run', options.dryRun ? 'true' : 'false');
  const env: Record<string, unknown> & { DB: D1Database } = {
    DB: d1,
    M365_TENANT_ID: TENANT_ID,
    M365_CLIENT_ID: CLIENT_ID,
    M365_CLIENT_SECRET: 'test-secret',
    MAIL_DOMAIN: DOMAIN,
    M365_DETECT_SHARED_MAILBOXES: 'true',
    ...options.env,
  };
  const tick = (deps: M365SyncDeps = {}) => runM365SyncTick(env as M365SyncWorkerEnv, {
    fetcher: fake.fetch, sleep: async () => undefined, now: () => clock, newId: () => `id-${++ids}`, ...deps,
  });
  const users = () => sqlite.prepare('SELECT id, email, role, status FROM users ORDER BY email').all() as Array<Record<string, string>>;
  const user = (email: string) => sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email) as Record<string, string> | undefined;
  const mailboxes = () => sqlite.prepare('SELECT id, address, display_name, type, status, owner_user_id FROM mailboxes ORDER BY address').all() as Array<Record<string, string | null>>;
  const link = (n: number) => sqlite.prepare('SELECT * FROM m365_sync_links WHERE object_id = ?').get(oid(n)) as Record<string, unknown> | undefined;
  const cache = () => Object.fromEntries((sqlite.prepare('SELECT object_id, purpose FROM m365_sync_mailbox_purpose ORDER BY object_id').all() as Array<{ object_id: string; purpose: string }>)
    .map((row) => [row.object_id, row.purpose]));
  const audits = (type: string) => (sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE event_type = ?').get(type) as { n: number }).n;
  const assignments = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM mailbox_assignments a JOIN mailboxes m ON m.id = a.mailbox_id WHERE m.type = ?').get('shared') as { n: number }).n;
  return {
    sqlite, fake, tick, users, user, mailboxes, link, cache, audits, assignments, setting,
    /** The Worker's settings, as after a redeploy with new vars. */
    setEnv: (key: string, value: string) => { env[key] = value; },
    state: () => loadM365SyncState(d1),
    advance: (ms: number) => { clock += ms; },
    syncNow: () => setting('m365_sync_requested_at', new Date(clock).toISOString()),
  };
}

async function live(pages: Parameters<ReturnType<typeof fakeGraph>['setReconcile']>[0], options: Parameters<typeof setup>[0] = {}, purposes: Record<number, string> = {}) {
  const t = setup(options);
  for (const [n, value] of Object.entries(purposes)) t.fake.purposes.set(oid(Number(n)), value);
  t.fake.setReconcile(pages, 'tok-1');
  expect(await t.tick()).toMatchObject({ status: 'worked', round: 'reconcile', finished: true });
  return t;
}

describe('shared mailbox detection: off by default', () => {
  it('never reads mailbox types without M365_DETECT_SHARED_MAILBOXES', async () => {
    const t = await live([[person(1, 'alex'), sharedObject(9, 'team')]], { env: { M365_DETECT_SHARED_MAILBOXES: '' } }, { 9: 'shared' });
    expect(t.fake.purposeReads).toEqual([]);
    expect(t.mailboxes().map((mailbox) => mailbox.address)).toEqual(['alex@example.test']);
    expect((await t.state()).sharedDetection).toBe(false);
  });

  it('refuses a value other than true or false, by setting name, without calling Microsoft', async () => {
    const t = setup({ env: { M365_DETECT_SHARED_MAILBOXES: 'yes' } });
    expect(await t.tick()).toEqual({ status: 'not_configured' });
    expect(t.fake.calls).toHaveLength(0);
  });

  it('changes nothing when migration 0026 is missing', async () => {
    const t = setup();
    t.sqlite.exec('DROP TABLE m365_sync_mailbox_purpose');
    t.fake.setReconcile([[person(1, 'alex')]]);
    expect(await t.tick()).toEqual({ status: 'not_installed' });
    expect(t.fake.calls).toHaveLength(0);
    expect(t.users()).toEqual([]);
    expect((await t.state()).lastError?.code).toBe('migration_0026_missing');
  });
});

describe('shared mailbox detection: mailbox types', () => {
  it('creates a disabled, unlicensed shared mailbox as a cmail shared mailbox with nobody assigned', async () => {
    const t = await live([[person(1, 'alex'), sharedObject(9, 'team')]], {}, { 9: 'shared' });
    expect(t.mailboxes()).toEqual([
      expect.objectContaining({ address: 'alex@example.test', type: 'personal' }),
      expect.objectContaining({ address: 'team@example.test', type: 'shared', status: 'active', owner_user_id: null, display_name: 'Team 9' }),
    ]);
    expect(t.users().map((user) => user.email)).toEqual(['alex@example.test']);
    expect(t.link(9)).toMatchObject({ kind: 'shared', source_state: 'in_scope', user_id: null });
    expect(t.assignments()).toBe(0);
    const s = await t.state();
    expect(s.lastRound!.counts).toMatchObject({ created: 1, sharedFound: 1, sharedCreated: 1, typeUnknown: 0 });
    expect(s.lastRound!.report).toContainEqual({ action: 'create_shared', address: 'team@example.test', reason: 'shared_mailbox' });
    expect(s.sharedDetection).toBe(true);
    expect(t.cache()).toEqual({ [oid(1)]: 'user', [oid(9)]: 'shared' });
  });

  it('keeps the licensed-person rule for "user": a disabled or unlicensed user is not synced', async () => {
    const t = await live([[person(1, 'alex'), person(2, 'blair', { accountEnabled: false }), person(3, 'casey', { assignedPlans: [] })]]);
    expect(t.users().map((user) => user.email)).toEqual(['alex@example.test']);
    expect(t.mailboxes().filter((mailbox) => mailbox.type === 'shared')).toEqual([]);
    expect((await t.state()).lastRound!.counts).toMatchObject({ created: 1, ignored: 2, sharedFound: 0 });
  });

  it('ignores room and equipment mailboxes, even licensed and enabled ones', async () => {
    const t = await live([[person(1, 'alex'), person(5, 'boardroom'), sharedObject(6, 'projector')]], {}, { 5: 'room', 6: 'equipment' });
    expect(t.users().map((user) => user.email)).toEqual(['alex@example.test']);
    expect(t.mailboxes()).toHaveLength(1);
    expect((await t.state()).lastRound!.counts).toMatchObject({ created: 1, ignored: 2 });
  });

  it('reads an unknown future value as "others" (licensed-person rule), never as shared', async () => {
    const t = await live([[person(1, 'alex'), sharedObject(9, 'team')]], {}, { 1: 'unknownFutureValue', 9: 'somethingNew' });
    expect(t.users().map((user) => user.email)).toEqual(['alex@example.test']);
    expect(t.mailboxes().filter((mailbox) => mailbox.type === 'shared')).toEqual([]);
    expect(t.cache()).toEqual({ [oid(1)]: 'others', [oid(9)]: 'others' });
  });

  it('treats 404 (no Exchange Online mailbox) as "none": the licensed-person rule decides', async () => {
    const t = setup();
    const noMailbox = { status: 404, body: { error: { code: 'MailboxNotEnabledForRESTAPI', message: 'The mailbox is either inactive, soft-deleted, or is hosted on-premise.' } } };
    t.fake.purposes.set(oid(1), noMailbox);
    t.fake.purposes.set(oid(2), noMailbox);
    t.fake.setReconcile([[person(1, 'alex'), sharedObject(2, 'former')]]);
    await t.tick();
    expect(t.users().map((user) => user.email)).toEqual(['alex@example.test']);
    expect(t.cache()).toEqual({ [oid(1)]: 'none', [oid(2)]: 'none' });
  });

  it('only checks objects with an address on MAIL_DOMAIN', async () => {
    const t = await live([[person(1, 'alex'), person(2, 'x', { mail: 'x@other.example' }), person(3, 'y', { mail: null }), removed(4)]]);
    expect(t.fake.purposeReads).toEqual([oid(1)]);
  });
});

describe('shared mailbox detection: a failed lookup never pauses or creates', () => {
  it('leaves a linked person alone when the type cannot be read (403), and tries again next time', async () => {
    const t = await live([[person(1, 'alex'), person(2, 'blair')]]);
    // Next full reconciliation: blair is disabled (would normally be paused)
    // but the type lookup is denied; a new shared-looking object fails.
    t.fake.purposes.set(oid(2), { status: 403, body: { error: { code: 'ErrorAccessDenied' } } });
    t.fake.purposes.set(oid(9), { status: 500, body: { error: { code: 'InternalServerError' } } });
    t.fake.setReconcile([[person(1, 'alex'), person(2, 'blair', { accountEnabled: false }), sharedObject(9, 'team')]], 'tok-2');
    t.syncNow();
    t.advance(1000);
    expect(await t.tick()).toMatchObject({ status: 'worked', round: 'reconcile', finished: true });
    expect(t.user('blair@example.test')?.status).toBe('pending');
    expect(t.link(2)).toMatchObject({ source_state: 'in_scope', paused_by_sync: 0 });
    expect(t.mailboxes().map((mailbox) => mailbox.address)).not.toContain('team@example.test');
    const s = await t.state();
    expect(s.lastRound!.counts).toMatchObject({ typeUnknown: 2, paused: 0, sharedCreated: 0 });
    expect(s.lastRound!.report).toEqual(expect.arrayContaining([
      { action: 'type_unknown', address: 'blair@example.test', reason: 'mailbox_type_denied' },
      { action: 'type_unknown', address: 'team@example.test', reason: 'mailbox_type_failed' },
    ]));
    // No answer is kept for a failure (only a failure count), so both are asked again when next returned.
    expect(t.cache()).toEqual({ [oid(1)]: 'user', [oid(2)]: 'unknown', [oid(9)]: 'unknown' });

    // A delta round sees blair again: asked again, still denied, still left alone.
    t.advance(HOUR);
    t.fake.setDelta('tok-2', [[person(2, 'blair', { accountEnabled: false })]], 'tok-3');
    const reads = t.fake.purposeReads.length;
    await t.tick();
    expect(t.fake.purposeReads.slice(reads)).toEqual([oid(2)]);
    expect(t.user('blair@example.test')?.status).toBe('pending');

    // Next reconciliation: the lookups work again and the normal rules apply.
    t.fake.purposes.set(oid(2), 'user');
    t.fake.purposes.set(oid(9), 'shared');
    t.fake.setReconcile([[person(1, 'alex'), person(2, 'blair', { accountEnabled: false }), sharedObject(9, 'team')]], 'tok-4');
    t.syncNow();
    t.advance(1000);
    await t.tick();
    expect(t.user('blair@example.test')?.status).toBe('paused');
    expect(t.mailboxes().map((mailbox) => mailbox.address)).toContain('team@example.test');
  });

  it('a failed lookup still counts as seen: the reconciliation sweep does not pause it', async () => {
    const t = await live([[person(1, 'alex')]]);
    t.fake.purposes.set(oid(1), { status: 403 });
    t.fake.setReconcile([[person(1, 'alex')]], 'tok-2');
    t.syncNow();
    t.advance(1000);
    await t.tick();
    expect(t.user('alex@example.test')?.status).toBe('pending');
    expect(t.link(1)).toMatchObject({ source_state: 'in_scope' });
  });

  it('respects Retry-After on a throttled lookup, keeps the answers it read, and resumes', async () => {
    const t = setup();
    t.fake.purposes.set(oid(9), [{ status: 429, headers: { 'Retry-After': '120' } }, 'shared']);
    t.fake.setReconcile([[person(1, 'alex'), sharedObject(9, 'team')]]);
    expect(await t.tick()).toEqual({ status: 'error', code: 'throttled' });
    let s = await t.state();
    expect(s.lastResult).toBe('backoff');
    expect(Date.parse(s.backoffUntil!)).toBe(T0 + 120_000);
    // Nothing applied from the throttled page, but alex's answer is kept.
    expect(t.users()).toEqual([]);
    expect(t.mailboxes()).toEqual([]);
    expect(t.cache()).toEqual({ [oid(1)]: 'user' });

    expect(await t.tick()).toEqual({ status: 'backoff' });
    t.advance(121_000);
    const readsBefore = t.fake.purposeReads.length;
    expect(await t.tick()).toMatchObject({ status: 'worked', finished: true });
    // Only the throttled object is asked again in this round.
    expect(t.fake.purposeReads.slice(readsBefore)).toEqual([oid(9)]);
    s = await t.state();
    expect(s.lastRound!.counts).toMatchObject({ created: 1, sharedCreated: 1 });
  });

  it('a throttled $batch request itself backs off with its Retry-After', async () => {
    const t = setup();
    t.fake.setReconcile([[person(1, 'alex')]]);
    // The first $batch of the round is the userPurpose read (no groups set).
    t.fake.queue('https://graph.microsoft.com/v1.0/$batch', { status: 429, headers: { 'retry-after': '300' } });
    expect(await t.tick()).toEqual({ status: 'error', code: 'throttled' });
    expect(Date.parse((await t.state()).backoffUntil!)).toBe(T0 + 300_000);
    expect(t.users()).toEqual([]);
  });
});

describe('shared mailbox detection: the cache', () => {
  it('reads each object once, not on every delta round, and again at the daily reconciliation', async () => {
    const t = await live([[person(1, 'alex'), sharedObject(9, 'team')]], {}, { 9: 'shared' });
    expect(t.fake.purposeReads).toEqual([oid(1), oid(9)]);

    // Delta rounds: cached objects are not asked again; a new one is.
    t.advance(HOUR);
    t.fake.setDelta('tok-1', [[person(1, 'alex', { displayName: 'Alex' }), sharedObject(9, 'team'), person(2, 'blair')]], 'tok-2');
    await t.tick();
    expect(t.fake.purposeReads.slice(2)).toEqual([oid(2)]);
    t.advance(HOUR);
    t.fake.setDelta('tok-2', [[person(2, 'blair', { displayName: 'Blair' })]], 'tok-3');
    await t.tick();
    expect(t.fake.purposeReads).toHaveLength(3);

    // The daily reconciliation reads every object again, picks up a change
    // (alex's mailbox converted to shared) and drops rows it never saw.
    t.fake.purposes.set(oid(1), 'shared');
    t.fake.setReconcile([[person(1, 'alex', { accountEnabled: false }), sharedObject(9, 'team')]], 'tok-4');
    t.advance(25 * HOUR);
    expect(await t.tick()).toMatchObject({ status: 'worked', round: 'reconcile', finished: true });
    expect(t.fake.purposeReads.slice(3).sort()).toEqual([oid(1), oid(9)]);
    expect(t.cache()).toEqual({ [oid(1)]: 'shared', [oid(9)]: 'shared' });
    // A linked person whose mailbox became shared is paused as a person, never turned into a second mailbox.
    expect(t.user('alex@example.test')?.status).toBe('paused');
    expect(t.link(1)).toMatchObject({ kind: 'person', last_reason: 'shared_mailbox' });
    expect(t.mailboxes().filter((mailbox) => mailbox.address === 'alex@example.test')).toHaveLength(1);
  });

  it('forgets the cached type of an object deleted in Microsoft 365', async () => {
    const t = await live([[person(1, 'alex'), sharedObject(9, 'team')]], {}, { 9: 'shared' });
    t.advance(HOUR);
    t.fake.setDelta('tok-1', [[removed(9)]], 'tok-2');
    await t.tick();
    expect(t.cache()).toEqual({ [oid(1)]: 'user' });
  });
});

describe('shared mailbox detection: dry run', () => {
  it('reports what would be created and writes no mailbox, link or cache row', async () => {
    const t = setup({ dryRun: true });
    t.fake.purposes.set(oid(9), 'shared');
    t.fake.purposes.set(oid(5), 'room');
    t.fake.setReconcile([[person(1, 'alex'), sharedObject(9, 'team'), person(5, 'boardroom')]]);
    expect(await t.tick()).toMatchObject({ status: 'worked', mode: 'dry_run', finished: true });
    expect(t.mailboxes()).toEqual([]);
    expect(t.users()).toEqual([]);
    expect(t.cache()).toEqual({});
    const s = await t.state();
    expect(s.lastRound!.counts).toMatchObject({ created: 1, sharedFound: 1, sharedCreated: 1, ignored: 1 });
    expect(s.lastRound!.report).toEqual([
      { action: 'create', address: 'alex@example.test', reason: 'new_in_scope' },
      { action: 'create_shared', address: 'team@example.test', reason: 'shared_mailbox' },
    ]);
  });
});

describe('shared mailbox detection: existing cmail mailboxes and accounts', () => {
  it('links an existing shared mailbox with the same address instead of creating one', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO mailboxes (id, address, display_name, type) VALUES ('m-team', 'team@example.test', 'Team', 'shared')`).run();
    t.fake.purposes.set(oid(9), 'shared');
    t.fake.setReconcile([[sharedObject(9, 'team')]]);
    await t.tick();
    expect(t.mailboxes()).toEqual([expect.objectContaining({ id: 'm-team', type: 'shared' })]);
    expect(t.link(9)).toMatchObject({ kind: 'shared', mailbox_id: 'm-team' });
    expect(t.audits('m365_sync.shared_adopted')).toBe(1);
    expect(t.assignments()).toBe(0);
  });

  it('reports a personal mailbox or an account at that address as a conflict and changes nothing', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('u-owner', 'owner@example.test', 'standard', 'active')`).run();
    t.sqlite.prepare(`INSERT INTO mailboxes (id, address, type, owner_user_id) VALUES ('m-personal', 'team@example.test', 'personal', 'u-owner')`).run();
    t.sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('u-sales', 'sales@example.test', 'standard', 'active')`).run();
    t.fake.purposes.set(oid(9), 'shared');
    t.fake.purposes.set(oid(10), 'shared');
    t.fake.setReconcile([[sharedObject(9, 'team'), sharedObject(10, 'sales')]]);
    await t.tick();
    expect(t.mailboxes()).toEqual([expect.objectContaining({ id: 'm-personal', type: 'personal' })]);
    expect(t.link(9)).toBeUndefined();
    expect(t.link(10)).toBeUndefined();
    expect((await t.state()).lastRound!.report).toEqual(expect.arrayContaining([
      { action: 'conflict', address: 'team@example.test', reason: 'address_is_personal_mailbox' },
      { action: 'conflict', address: 'sales@example.test', reason: 'address_is_an_account' },
    ]));
  });
});

describe('shared mailbox detection: lifecycle', () => {
  it('follows an address change and never disables the mailbox when it is deleted or converted back', async () => {
    const t = await live([[sharedObject(9, 'team'), sharedObject(10, 'sales')]], {}, { 9: 'shared', 10: 'shared' });
    t.advance(HOUR);
    t.fake.setDelta('tok-1', [[sharedObject(9, 'team.new')]], 'tok-2');
    await t.tick();
    expect(t.mailboxes().map((mailbox) => mailbox.address)).toEqual(['sales@example.test', 'team.new@example.test']);
    expect(t.audits('m365_sync.shared_updated')).toBe(1);

    // team is deleted in Microsoft 365; sales is converted back to a user mailbox.
    t.fake.purposes.set(oid(10), 'user');
    t.fake.setReconcile([[person(10, 'sales')]], 'tok-3');
    t.syncNow();
    t.advance(1000);
    await t.tick();
    expect(t.mailboxes()).toEqual([
      expect.objectContaining({ address: 'sales@example.test', type: 'shared', status: 'active' }),
      expect.objectContaining({ address: 'team.new@example.test', type: 'shared', status: 'active' }),
    ]);
    expect(t.link(9)).toMatchObject({ source_state: 'out_of_scope', last_reason: 'not_seen' });
    expect(t.link(10)).toMatchObject({ source_state: 'out_of_scope', last_reason: 'no_longer_shared' });
    // No account is created for the converted object: its address is a shared mailbox's.
    expect(t.users()).toEqual([]);
    const report = (await t.state()).lastRound!.report;
    expect(report).toContainEqual({ action: 'left_source_kept', address: 'sales@example.test', reason: 'no_longer_shared' });
    expect(report).toContainEqual({ action: 'left_source_kept', address: '', reason: 'not_seen' });
  });
});

describe('shared mailbox detection with the shared and scope groups', () => {
  it('uses both: group members without a lookup, detected ones besides', async () => {
    const t = setup({ env: { M365_SHARED_GROUP_ID: SHARED_GROUP } });
    t.fake.memberships.set(oid(8), [SHARED_GROUP]);
    t.fake.purposes.set(oid(9), 'shared');
    t.fake.setReconcile([[person(1, 'alex'), sharedObject(8, 'grouped'), sharedObject(9, 'detected')]]);
    await t.tick();
    expect(t.mailboxes().filter((mailbox) => mailbox.type === 'shared').map((mailbox) => mailbox.address)).toEqual(['detected@example.test', 'grouped@example.test']);
    expect(t.fake.purposeReads.sort()).toEqual([oid(1), oid(9)]);
    const s = await t.state();
    expect(s.lastRound!.counts).toMatchObject({ sharedFound: 2, sharedCreated: 2 });
    expect(s.lastRound!.report).toEqual(expect.arrayContaining([
      { action: 'create_shared', address: 'grouped@example.test', reason: 'in_shared_group' },
      { action: 'create_shared', address: 'detected@example.test', reason: 'shared_mailbox' },
    ]));
  });

  it('keeps a shared mailbox that leaves the group while Exchange still says shared', async () => {
    const t = setup({ env: { M365_SHARED_GROUP_ID: SHARED_GROUP } });
    t.fake.memberships.set(oid(8), [SHARED_GROUP]);
    t.fake.purposes.set(oid(8), 'shared');
    t.fake.setReconcile([[sharedObject(8, 'grouped')]]);
    await t.tick();
    t.fake.memberships.set(oid(8), []);
    t.fake.setReconcile([[sharedObject(8, 'grouped')]], 'tok-2');
    t.syncNow();
    t.advance(1000);
    await t.tick();
    expect(t.link(8)).toMatchObject({ kind: 'shared', source_state: 'in_scope' });
  });

  it('limits detected shared mailboxes to the scope group when one is set', async () => {
    const t = setup({ env: { M365_SCOPE_GROUP_ID: SCOPE_GROUP } });
    t.fake.memberships.set(oid(9), [SCOPE_GROUP]);
    t.fake.purposes.set(oid(9), 'shared');
    t.fake.purposes.set(oid(10), 'shared');
    t.fake.setReconcile([[sharedObject(9, 'inscope'), sharedObject(10, 'outscope')]]);
    await t.tick();
    expect(t.mailboxes().map((mailbox) => mailbox.address)).toEqual(['inscope@example.test']);
  });
});

describe('shared mailbox detection and the mass-pause brake', () => {
  it('holds a first detection run that would pause many linked people (licensed shared mailboxes, rooms)', async () => {
    // Ten licensed, enabled objects synced as people before detection was on.
    const t = await live([Array.from({ length: 10 }, (_, index) => person(index + 1, `user${index + 1}`))], { env: { M365_DETECT_SHARED_MAILBOXES: 'false' } });
    expect(t.users()).toHaveLength(10);
    expect(t.fake.purposeReads).toEqual([]);
    // Detection turned on: Exchange says six of them are shared or room mailboxes.
    t.setEnv('M365_DETECT_SHARED_MAILBOXES', 'true');
    for (const n of [1, 2, 3, 4]) t.fake.purposes.set(oid(n), 'shared');
    for (const n of [5, 6]) t.fake.purposes.set(oid(n), 'room');
    t.fake.setReconcile([Array.from({ length: 10 }, (_, index) => person(index + 1, `user${index + 1}`))], 'tok-2');
    t.syncNow();
    t.advance(1000);
    expect(await t.tick()).toEqual({ status: 'held' });
    const s = await t.state();
    expect(s.round).toMatchObject({ phase: 'held', brake: { reason: 'too_many_pauses', pauses: 6, linked: 10 } });
    expect(s.round!.pauseQueue.map((item) => item.reason).sort()).toEqual(['resource_mailbox', 'resource_mailbox', 'shared_mailbox', 'shared_mailbox', 'shared_mailbox', 'shared_mailbox']);
    expect(t.users().every((user) => user.status === 'pending')).toBe(true);
    // No shared mailbox was created over a person's address.
    expect(t.mailboxes().every((mailbox) => mailbox.type === 'personal')).toBe(true);
  });
});

describe('shared mailbox detection: switching it on (review finding 1)', () => {
  it('forgets answers from an earlier period and runs a full reconciliation at once', async () => {
    // Detection off: alex is a licensed person, linked.
    const t = await live([[person(1, 'alex')]], { env: { M365_DETECT_SHARED_MAILBOXES: 'false' } });
    // An answer left from an earlier detection period: alex's mailbox was shared then.
    t.sqlite.prepare(`INSERT INTO m365_sync_mailbox_purpose (object_id, purpose, checked_round) VALUES (?, 'shared', 'old-round')`).run(oid(1));
    // Only a delta would be due now, and the delta returns alex.
    t.advance(HOUR);
    t.fake.setDelta('tok-1', [[person(1, 'alex', { displayName: 'Alex' })]], 'tok-2');
    t.fake.setReconcile([[person(1, 'alex'), sharedObject(9, 'team')]], 'tok-3');
    t.fake.purposes.set(oid(9), 'shared');
    t.setEnv('M365_DETECT_SHARED_MAILBOXES', 'true');
    expect(await t.tick()).toMatchObject({ status: 'worked', round: 'reconcile', finished: true });
    // The stale 'shared' answer was not used: alex was asked again and stays a person.
    expect(t.fake.purposeReads.sort()).toEqual([oid(1), oid(9)]);
    expect(t.user('alex@example.test')?.status).toBe('pending');
    expect(t.cache()).toEqual({ [oid(1)]: 'user', [oid(9)]: 'shared' });
    // Existing shared mailboxes are found at once.
    expect(t.mailboxes().map((mailbox) => mailbox.address)).toContain('team@example.test');
    const s = await t.state();
    expect(s).toMatchObject({ sharedDetection: true, detectionReconcilePending: false });
  });

  it('switching off and on again clears the cache again and drops a delta round in progress', async () => {
    const t = await live([[person(1, 'alex')]]);
    expect(t.cache()).toEqual({ [oid(1)]: 'user' });
    t.setEnv('M365_DETECT_SHARED_MAILBOXES', 'false');
    t.advance(HOUR);
    t.fake.setDelta('tok-1', [[]], 'tok-2');
    await t.tick();
    expect((await t.state()).sharedDetection).toBe(false);
    t.setEnv('M365_DETECT_SHARED_MAILBOXES', 'true');
    t.fake.setReconcile([[person(1, 'alex')]], 'tok-3');
    t.advance(HOUR);
    const reads = t.fake.purposeReads.length;
    expect(await t.tick()).toMatchObject({ round: 'reconcile', finished: true });
    expect(t.fake.purposeReads.slice(reads)).toEqual([oid(1)]);
  });
});

describe('shared mailbox detection: 404 in a delta round (review finding 2)', () => {
  it('does not store a delta 404, so a shared mailbox still provisioning is found when next returned', async () => {
    const t = await live([[person(1, 'alex')]]);
    t.fake.purposes.set(oid(9), [{ status: 404, body: { error: { code: 'MailboxNotEnabledForRESTAPI' } } }, 'shared']);
    t.advance(HOUR);
    t.fake.setDelta('tok-1', [[sharedObject(9, 'team')]], 'tok-2');
    await t.tick();
    expect(t.mailboxes().map((mailbox) => mailbox.address)).toEqual(['alex@example.test']);
    expect(t.cache()).toEqual({ [oid(1)]: 'user' });
    t.advance(HOUR);
    t.fake.setDelta('tok-2', [[sharedObject(9, 'team')]], 'tok-3');
    await t.tick();
    expect(t.mailboxes()).toContainEqual(expect.objectContaining({ address: 'team@example.test', type: 'shared' }));
    expect(t.cache()).toEqual({ [oid(1)]: 'user', [oid(9)]: 'shared' });
  });

  it('does not create a person for a new licensed room whose mailbox is not there yet', async () => {
    const t = await live([[person(1, 'alex')]]);
    t.fake.purposes.set(oid(5), [{ status: 404, body: { error: { code: 'MailboxNotEnabledForRESTAPI' } } }, 'room']);
    t.advance(HOUR);
    t.fake.setDelta('tok-1', [[person(5, 'boardroom')]], 'tok-2');
    await t.tick();
    expect(t.users().map((user) => user.email)).toEqual(['alex@example.test']);
    expect((await t.state()).lastRound!.report).toEqual([{ action: 'wait_for_mailbox', address: 'boardroom@example.test', reason: 'mailbox_not_provisioned' }]);
    t.advance(HOUR);
    t.fake.setDelta('tok-2', [[person(5, 'boardroom')]], 'tok-3');
    await t.tick();
    expect(t.users().map((user) => user.email)).toEqual(['alex@example.test']);
    expect(t.cache()).toMatchObject({ [oid(5)]: 'room' });
  });

  it('still pauses a linked person whose mailbox is gone (404) in a delta round, by the licence rule', async () => {
    const t = await live([[person(1, 'alex'), person(2, 'blair')]]);
    t.fake.purposes.set(oid(3), { status: 404 });
    t.advance(HOUR);
    // casey is new, licensed, 404: waits. blair (cached 'user') lost the licence: paused.
    t.fake.setDelta('tok-1', [[person(2, 'blair', { assignedPlans: [] }), person(3, 'casey')]], 'tok-2');
    await t.tick();
    expect(t.user('blair@example.test')?.status).toBe('paused');
    expect(t.user('casey@example.test')).toBeUndefined();
  });

  it('a reconciliation stores 404 as "none" and the licensed-person rule creates the account', async () => {
    const t = setup();
    t.fake.purposes.set(oid(3), { status: 404 });
    t.fake.setReconcile([[person(3, 'casey')]]);
    await t.tick();
    expect(t.user('casey@example.test')).toBeDefined();
    expect(t.cache()).toEqual({ [oid(3)]: 'none' });
  });
});

describe('shared mailbox detection: a cached "user" in a delta round', () => {
  it('pauses a linked person who is disabled, without asking Exchange again', async () => {
    const t = await live([[person(1, 'alex'), person(2, 'blair')]]);
    const reads = t.fake.purposeReads.length;
    t.advance(HOUR);
    t.fake.setDelta('tok-1', [[person(2, 'blair', { accountEnabled: false })]], 'tok-2');
    await t.tick();
    expect(t.fake.purposeReads.length).toBe(reads);
    expect(t.user('blair@example.test')?.status).toBe('paused');
    expect(t.link(2)).toMatchObject({ last_reason: 'disabled' });
  });
});

describe('shared mailbox detection: repeated failures (review finding 3)', () => {
  const failures = (t: ReturnType<typeof setup>, n: number) =>
    (t.sqlite.prepare('SELECT failed_reconciles AS f FROM m365_sync_mailbox_purpose WHERE object_id = ?').get(oid(n)) as { f: number } | undefined)?.f;

  async function reconcileAgain(t: ReturnType<typeof setup>, token: string) {
    t.fake.setReconcile([[person(1, 'alex', { accountEnabled: false })]], token);
    t.syncNow();
    t.advance(1000);
    expect(await t.tick()).toMatchObject({ round: 'reconcile', finished: true });
  }

  it('counts consecutive failed reconciliations per object, alerts once at 3, and resets on an answer', async () => {
    const t = await live([[person(1, 'alex')]]);
    t.fake.purposes.set(oid(1), { status: 403, body: { error: { code: 'ErrorAccessDenied' } } });
    await reconcileAgain(t, 'tok-2');
    expect(failures(t, 1)).toBe(1);
    // A failed delta lookup does not count, and does not reset.
    t.advance(HOUR);
    t.fake.setDelta('tok-2', [[person(1, 'alex', { accountEnabled: false })]], 'tok-3');
    await t.tick();
    expect(failures(t, 1)).toBe(1);
    await reconcileAgain(t, 'tok-4');
    expect(t.audits('m365_sync.type_unreadable')).toBe(0);
    await reconcileAgain(t, 'tok-5');
    expect(failures(t, 1)).toBe(3);
    expect(t.audits('m365_sync.type_unreadable')).toBe(1);
    await reconcileAgain(t, 'tok-6');
    expect(failures(t, 1)).toBe(4);
    expect(t.audits('m365_sync.type_unreadable')).toBe(1);
    // Never paused meanwhile, though disabled in Microsoft 365.
    expect(t.user('alex@example.test')?.status).toBe('pending');
    // Readable again: the count resets and the normal rules apply.
    t.fake.purposes.set(oid(1), 'user');
    await reconcileAgain(t, 'tok-7');
    expect(failures(t, 1)).toBe(0);
    expect(t.user('alex@example.test')?.status).toBe('paused');
  });

  it('a page read again after throttling does not count a reconciliation twice', async () => {
    const t = await live([[person(1, 'alex'), person(2, 'blair')]]);
    t.fake.purposes.set(oid(1), { status: 403 });
    t.fake.purposes.set(oid(2), [{ status: 429, headers: { 'retry-after': '60' } }, 'user']);
    t.fake.setReconcile([[person(1, 'alex'), person(2, 'blair')]], 'tok-2');
    t.syncNow();
    t.advance(1000);
    expect(await t.tick()).toEqual({ status: 'error', code: 'throttled' });
    t.advance(61_000);
    expect(await t.tick()).toMatchObject({ finished: true });
    expect(failures(t, 1)).toBe(1);
  });
});

describe('shared mailbox detection: bounded work', () => {
  it('checks the Graph budget before every $batch and resumes the page next run without asking twice', async () => {
    const t = setup();
    t.fake.setReconcile([Array.from({ length: 45 }, (_, index) => person(10 + index, `user${index}`))]);
    const budgets = { graph: 2 };
    const first = await t.tick({ budgets });
    expect(first).toMatchObject({ status: 'worked', finished: false });
    expect(t.users()).toEqual([]);
    // Token, page and two batches: the ceiling (twice the budget) stops the third batch.
    expect(t.fake.purposeReads).toHaveLength(40);
    let ticks = 1;
    for (;;) {
      const result = await t.tick({ budgets });
      ticks += 1;
      if (result.status === 'worked' && result.finished) break;
      expect(ticks).toBeLessThan(20);
    }
    expect(t.users()).toHaveLength(45);
    expect(t.fake.purposeReads).toHaveLength(45);
  });
});

describe('shared mailbox group without detection (wording unchanged)', () => {
  it('reports a licensed member leaving the shared group as not_in_shared_group', async () => {
    const t = setup({ env: { M365_DETECT_SHARED_MAILBOXES: 'false', M365_SHARED_GROUP_ID: SHARED_GROUP } });
    t.fake.memberships.set(oid(8), [SHARED_GROUP]);
    t.fake.setReconcile([[person(8, 'team')]]);
    await t.tick();
    t.fake.memberships.set(oid(8), []);
    t.fake.setReconcile([[person(8, 'team')]], 'tok-2');
    t.syncNow();
    t.advance(1000);
    await t.tick();
    expect((await t.state()).lastRound!.report).toContainEqual({ action: 'left_source_kept', address: 'team@example.test', reason: 'not_in_shared_group' });
  });
});
