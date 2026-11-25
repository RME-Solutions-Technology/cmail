import { describe, expect, it } from 'vitest';
import { loadM365SyncState } from '@stanchion/shared/m365-sync';
import { pausedAccountLockoutStatements } from '@stanchion/shared/account-lockout';
import { migratedDatabase } from '../testing/sqlite-d1';
import { runM365SyncTick, brakeCheck, type M365SyncDeps } from './sync';
import { CLIENT_ID, DOMAIN, SHARED_GROUP, TENANT_ID, fakeGraph, oid, person } from './testing/fake-graph';

// Safety rules from the PR 108 review: managers win, conditional pauses,
// the mass-pause brake, offboarded accounts, dry run over existing links and
// shared-mailbox renames. Real migrations on node:sqlite, fake Graph.

const T0 = Date.parse('2026-11-15T00:00:00Z');
const HOUR = 60 * 60 * 1000;

function setup(env: Record<string, string> = {}) {
  const { d1, sqlite } = migratedDatabase();
  const fake = fakeGraph();
  let clock = T0;
  let ids = 0;
  /** Runs once, just before the next D1 batch: simulates a concurrent manager. */
  let beforeBatch: (() => void) | null = null;
  const db = new Proxy(d1, {
    get(target, key) {
      if (key === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const hook = beforeBatch;
          beforeBatch = null;
          hook?.();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
  const setting = (key: string, value: string) => sqlite.prepare(
    `INSERT INTO org_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
  setting('m365_sync_enabled', 'true');
  setting('m365_sync_dry_run', 'false');
  const fullEnv = { DB: db, M365_TENANT_ID: TENANT_ID, M365_CLIENT_ID: CLIENT_ID, M365_CLIENT_SECRET: 'test-secret', MAIL_DOMAIN: DOMAIN, ...env };
  const tick = (deps: M365SyncDeps = {}) => runM365SyncTick(fullEnv, {
    fetcher: fake.fetch, sleep: async () => undefined, now: () => clock, newId: () => `id-${++ids}`, ...deps,
  });
  const user = (email: string) => sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email) as Record<string, string> | undefined;
  const link = (n: number) => sqlite.prepare('SELECT * FROM m365_sync_links WHERE object_id = ?').get(oid(n)) as Record<string, unknown> | undefined;
  const audits = (type: string) => (sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE event_type = ?').get(type) as { n: number }).n;
  /** What Admin > People > Pause or Reactivate does: status change, then the shared lockout steps. */
  const managerSetStatus = (email: string, status: string) => {
    const id = user(email)!.id;
    sqlite.prepare(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
    if (status === 'paused') {
      for (const statement of pausedAccountLockoutStatements(d1, id)) void statement.run();
    }
  };
  return {
    sqlite, fake, tick, user, link, audits, setting, managerSetStatus,
    state: () => loadM365SyncState(d1),
    advance: (ms: number) => { clock += ms; },
    onNextBatch: (hook: () => void) => { beforeBatch = hook; },
    syncNow: () => setting('m365_sync_requested_at', new Date(clock).toISOString()),
  };
}

const people = (count: number, start = 1) => Array.from({ length: count }, (_, index) => person(start + index, `user${start + index}`));

async function linked(count: number, env: Record<string, string> = {}) {
  const t = setup(env);
  t.fake.setReconcile([people(count)], 'tok-1');
  expect(await t.tick()).toMatchObject({ status: 'worked', finished: true });
  for (let n = 1; n <= count; n += 1) t.sqlite.prepare(`UPDATE users SET status = 'active' WHERE email = ?`).run(`user${n}@${DOMAIN}`);
  t.advance(HOUR);
  return t;
}

describe('a manager decision always wins (finding 1)', () => {
  it('never resumes an account a manager reactivated and then paused again', async () => {
    const t = await linked(3);
    t.fake.setDelta('tok-1', [[person(1, 'user1', { accountEnabled: false })]], 'tok-2');
    await t.tick();
    expect(t.user('user1@example.test')?.status).toBe('paused');
    expect(t.link(1)).toMatchObject({ paused_by_sync: 1 });

    t.managerSetStatus('user1@example.test', 'active');
    // The 0022 trigger cleared the sync's mark with the manager's change.
    expect(t.link(1)).toMatchObject({ paused_by_sync: 0, status_before_pause: null });
    t.managerSetStatus('user1@example.test', 'paused');

    t.advance(HOUR);
    t.fake.setDelta('tok-2', [[person(1, 'user1')]], 'tok-3');
    await t.tick();
    expect(t.user('user1@example.test')?.status).toBe('paused');
    expect(t.audits('m365_sync.user_resumed')).toBe(0);
  });
});

describe('pauses are conditional (finding 3)', () => {
  it('does not overwrite or claim a manager pause that lands at the same moment', async () => {
    const t = await linked(3);
    t.fake.setDelta('tok-1', [[person(2, 'user2', { accountEnabled: false })]], 'tok-2');
    // The manager pauses user2 just before the sync's pause batch runs.
    t.onNextBatch(() => t.managerSetStatus('user2@example.test', 'paused'));
    await t.tick();
    expect(t.user('user2@example.test')?.status).toBe('paused');
    expect(t.link(2)).toMatchObject({ paused_by_sync: 0 });
    expect(t.audits('m365_sync.user_paused')).toBe(0);
    expect((await t.state()).lastRound!.report).toContainEqual({ action: 'conflict', address: 'user2@example.test', reason: 'changed_concurrently' });

    // Back in scope later: the manager's pause stands.
    t.advance(HOUR);
    t.fake.setDelta('tok-2', [[person(2, 'user2')]], 'tok-3');
    await t.tick();
    expect(t.user('user2@example.test')?.status).toBe('paused');
  });

  it('keeps a leaver in scope when the pause did not land, and pauses them on the next reconciliation', async () => {
    const t = await linked(3);
    t.fake.setDelta('tok-1', [[person(1, 'user1', { accountEnabled: false })]], 'tok-2');
    // Some other writer changes the status between the sync's read and its write.
    t.onNextBatch(() => t.sqlite.prepare(`UPDATE users SET status = 'pending', updated_at = datetime('now') WHERE email = 'user1@example.test'`).run());
    await t.tick();
    expect(t.user('user1@example.test')?.status).toBe('pending');
    expect(t.link(1)).toMatchObject({ source_state: 'in_scope', paused_by_sync: 0 });

    t.fake.setReconcile([[person(1, 'user1', { accountEnabled: false }), person(2, 'user2'), person(3, 'user3')]], 'tok-3');
    t.advance(1000);
    t.syncNow();
    await t.tick();
    expect(t.user('user1@example.test')?.status).toBe('paused');
    expect(t.link(1)).toMatchObject({ source_state: 'out_of_scope', paused_by_sync: 1, status_before_pause: 'pending' });
  });

  it('writes a valid datetime as its change marker', async () => {
    const t = await linked(2);
    t.fake.setDelta('tok-1', [[person(1, 'user1', { accountEnabled: false })]], 'tok-2');
    await t.tick();
    const updated = t.user('user1@example.test')!.updated_at;
    expect(updated).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(t.sqlite.prepare(`SELECT datetime(?) IS NOT NULL AS ok`).get(updated)).toEqual({ ok: 1 });
  });

  it('only pauses from the status it read', async () => {
    const t = await linked(3);
    t.fake.setDelta('tok-1', [[person(3, 'user3', { accountEnabled: false })]], 'tok-2');
    t.onNextBatch(() => t.managerSetStatus('user3@example.test', 'offboarded'));
    await t.tick();
    expect(t.user('user3@example.test')?.status).toBe('offboarded');
  });
});

describe('mass-pause brake (finding 4)', () => {
  it('applies a small number of pauses normally', async () => {
    const t = await linked(10);
    t.fake.setDelta('tok-1', [[1, 2, 3, 4].map((n) => person(n, `user${n}`, { accountEnabled: false }))], 'tok-2');
    expect(await t.tick()).toMatchObject({ status: 'worked', finished: true });
    expect(t.user('user4@example.test')?.status).toBe('paused');
  });

  it('holds a round that would pause too many, until a manager approves that round', async () => {
    const t = await linked(10);
    t.fake.setDelta('tok-1', [[1, 2, 3, 4, 5, 6].map((n) => person(n, `user${n}`, { assignedPlans: [] }))], 'tok-2');
    expect(await t.tick()).toEqual({ status: 'held' });
    let s = await t.state();
    expect(s.lastResult).toBe('held');
    expect(s.round).toMatchObject({ phase: 'held', brake: { reason: 'too_many_pauses', pauses: 6, linked: 10, percent: 60 } });
    expect(t.user('user1@example.test')?.status).toBe('active');
    expect(t.audits('m365_sync.user_paused')).toBe(0);

    // Still held on later ticks; a wrong approval does nothing.
    t.setting('m365_sync_approved_round', 'some-other-round');
    t.advance(HOUR);
    expect(await t.tick()).toEqual({ status: 'held' });

    t.setting('m365_sync_approved_round', s.round!.id);
    expect(await t.tick()).toMatchObject({ status: 'worked', finished: true });
    expect(t.user('user6@example.test')?.status).toBe('paused');
    expect(t.audits('m365_sync.user_paused')).toBe(6);
    s = await t.state();
    expect(s.lastRound?.brake).toMatchObject({ reason: 'too_many_pauses' });
  });

  it('holds a reconciliation that returns nothing while people are linked', async () => {
    const t = await linked(3);
    t.fake.setReconcile([[]], 'tok-empty');
    t.syncNow();
    expect(await t.tick()).toEqual({ status: 'held' });
    expect((await t.state()).round?.brake).toMatchObject({ reason: 'empty_result', linked: 3 });
    expect(t.user('user1@example.test')?.status).toBe('active');
  });

  it('Sync now discards a held round and starts over', async () => {
    const t = await linked(3);
    t.fake.setReconcile([[]], 'tok-empty');
    t.syncNow();
    await t.tick();
    const heldId = (await t.state()).round!.id;
    // The directory answers properly again.
    t.fake.setReconcile([people(3)], 'tok-good');
    t.advance(1000);
    t.syncNow();
    expect(await t.tick()).toMatchObject({ status: 'worked', finished: true });
    const s = await t.state();
    expect(s.round).toBeNull();
    expect(s.lastRound?.brake).toBeNull();
    expect(s.lastRound?.startedAt).not.toBe(heldId);
    expect(t.user('user1@example.test')?.status).toBe('active');
  });

  it('in dry run reports that it would hold, and changes nothing', async () => {
    const t = await linked(10);
    t.setting('m365_sync_dry_run', 'true');
    t.fake.setReconcile([people(10).map((user, index) => (index < 7 ? { ...user, accountEnabled: false } : user))], 'tok-2');
    expect(await t.tick()).toMatchObject({ status: 'worked', mode: 'dry_run', finished: true });
    const s = await t.state();
    expect(s.lastRound).toMatchObject({ mode: 'dry_run', brake: { reason: 'too_many_pauses', pauses: 7 }, counts: { paused: 7 } });
    expect(t.user('user1@example.test')?.status).toBe('active');
  });

  it('brakeCheck needs at least five pauses and more than the percentage', () => {
    const round = (pauses: number, fetched = 10, kind: 'delta' | 'reconcile' = 'delta') => ({
      kind, fetched, pauseQueue: Array.from({ length: pauses }, (_, i) => ({ id: oid(i), address: '', reason: 'disabled' })),
    }) as unknown as Parameters<typeof brakeCheck>[0];
    expect(brakeCheck(round(4), 4, 20)).toBeNull();
    expect(brakeCheck(round(5), 100, 20)).toBeNull();
    expect(brakeCheck(round(21), 100, 20)).toMatchObject({ reason: 'too_many_pauses' });
    expect(brakeCheck(round(0, 0, 'reconcile'), 2, 20)).toMatchObject({ reason: 'empty_result' });
    expect(brakeCheck(round(0, 0, 'reconcile'), 0, 20)).toBeNull();
  });
});

describe('more cases from the review (finding 12)', () => {
  it('never edits a linked account a manager offboarded', async () => {
    const t = await linked(2);
    t.managerSetStatus('user1@example.test', 'offboarded');
    t.fake.setDelta('tok-1', [[person(1, 'renamed', { displayName: 'New Name' })]], 'tok-2');
    await t.tick();
    expect(t.user('user1@example.test')).toMatchObject({ status: 'offboarded', display_name: 'Person 1' });
    expect(t.user('renamed@example.test')).toBeUndefined();
  });

  it('dry run over existing links writes only seen_round', async () => {
    const t = await linked(3);
    t.setting('m365_sync_dry_run', 'true');
    const before = t.sqlite.prepare(`SELECT id, email, display_name, status, updated_at FROM users ORDER BY id`).all();
    const linksBefore = t.sqlite.prepare(`SELECT object_id, source_state, paused_by_sync, last_reason FROM m365_sync_links ORDER BY object_id`).all();
    const auditCount = (t.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    const seenBefore = (t.sqlite.prepare('SELECT seen_round FROM m365_sync_links LIMIT 1').get() as { seen_round: string }).seen_round;
    t.fake.setReconcile([[person(1, 'user1', { accountEnabled: false }), person(2, 'user2.new')]], 'tok-dry');
    await t.tick();
    expect(t.sqlite.prepare(`SELECT id, email, display_name, status, updated_at FROM users ORDER BY id`).all()).toEqual(before);
    expect(t.sqlite.prepare(`SELECT object_id, source_state, paused_by_sync, last_reason FROM m365_sync_links ORDER BY object_id`).all()).toEqual(linksBefore);
    expect((t.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(auditCount);
    const round = (await t.state()).lastRound!;
    expect(round.report).toEqual(expect.arrayContaining([
      { action: 'pause', address: 'user1@example.test', reason: 'disabled' },
      { action: 'update_address', address: 'user2.new@example.test', reason: 'primary_address_changed' },
      { action: 'pause', address: 'user3@example.test', reason: 'not_seen' },
    ]));
    // The only write: the bookkeeping mark.
    const seen = t.sqlite.prepare('SELECT DISTINCT seen_round FROM m365_sync_links').all() as Array<{ seen_round: string }>;
    expect(seen).toHaveLength(1);
    expect(seen[0].seen_round).not.toBe(seenBefore);
  });

  it('follows a shared mailbox address change and audits it', async () => {
    const t = setup({ M365_SHARED_GROUP_ID: SHARED_GROUP });
    t.fake.memberships.set(oid(9), [SHARED_GROUP]);
    t.fake.setReconcile([[person(9, 'team', { accountEnabled: false, assignedPlans: [] })]], 'tok-1');
    await t.tick();
    t.advance(HOUR);
    t.fake.setDelta('tok-1', [[person(9, 'helpdesk', { accountEnabled: false, assignedPlans: [] })]], 'tok-2');
    await t.tick();
    const mailboxes = t.sqlite.prepare(`SELECT address, type, status FROM mailboxes`).all();
    expect(mailboxes).toEqual([{ address: 'helpdesk@example.test', type: 'shared', status: 'active' }]);
    expect(t.audits('m365_sync.shared_updated')).toBe(1);
  });

  it('audits a display-name-only change', async () => {
    const t = await linked(1);
    t.fake.setDelta('tok-1', [[person(1, 'user1', { displayName: 'Changed' })]], 'tok-2');
    await t.tick();
    expect(t.user('user1@example.test')?.display_name).toBe('Changed');
    expect(t.audits('m365_sync.user_updated')).toBe(1);
  });
});
