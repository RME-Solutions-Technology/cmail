import { describe, expect, it } from 'vitest';
import { loadM365SyncState } from '@cmail/shared/m365-sync';
import { migratedDatabase } from '../testing/sqlite-d1';
import { runM365SyncTick, dueRound, type M365SyncDeps } from './sync';
import { INITIAL_DELTA_URL } from './graph';
import {
  CLIENT_ID,
  DOMAIN,
  SCOPE_GROUP,
  SHARED_GROUP,
  TENANT_ID,
  deltaUrl,
  fakeGraph,
  oid,
  person,
  removed,
} from './testing/fake-graph';

// The sync against every real migration (node:sqlite) and a fake Graph.
// Fixtures use placeholder GUIDs and example.test addresses only.

const T0 = Date.parse('2026-11-15T00:00:00Z');
const HOUR = 60 * 60 * 1000;

function setup(options: { enabled?: boolean; dryRun?: boolean; env?: Record<string, string> } = {}) {
  const { d1, sqlite } = migratedDatabase();
  const fake = fakeGraph();
  let clock = T0;
  let ids = 0;
  const setSwitch = (enabled: boolean, dryRun: boolean) => {
    sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('m365_sync_enabled', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(enabled ? 'true' : 'false');
    sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('m365_sync_dry_run', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(dryRun ? 'true' : 'false');
  };
  setSwitch(options.enabled ?? true, options.dryRun ?? false);
  const env = {
    DB: d1,
    M365_TENANT_ID: TENANT_ID,
    M365_CLIENT_ID: CLIENT_ID,
    M365_CLIENT_SECRET: 'test-secret',
    MAIL_DOMAIN: DOMAIN,
    ...options.env,
  };
  const tick = (deps: M365SyncDeps = {}) => runM365SyncTick(env, {
    fetcher: fake.fetch,
    sleep: async () => undefined,
    now: () => clock,
    newId: () => `id-${++ids}`,
    ...deps,
  });
  const users = () => sqlite.prepare('SELECT id, email, display_name, role, status FROM users ORDER BY email').all() as Array<Record<string, string>>;
  const mailboxes = () => sqlite.prepare('SELECT id, address, type, status, owner_user_id FROM mailboxes ORDER BY address').all() as Array<Record<string, string>>;
  const links = () => sqlite.prepare('SELECT * FROM m365_sync_links ORDER BY object_id').all() as Array<Record<string, unknown>>;
  const audits = (type: string) => (sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE event_type = ?').get(type) as { n: number }).n;
  const state = () => loadM365SyncState(d1);
  const advance = (ms: number) => { clock += ms; };
  const requestSyncNow = () => sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('m365_sync_requested_at', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(new Date(clock).toISOString());
  return { d1, sqlite, fake, tick, users, mailboxes, links, audits, state, advance, setSwitch, requestSyncNow };
}

async function liveWith(pages: Parameters<ReturnType<typeof fakeGraph>['setReconcile']>[0], token = 'tok-1') {
  const t = setup();
  t.fake.setReconcile(pages, token);
  expect(await t.tick()).toMatchObject({ status: 'worked', round: 'reconcile', finished: true });
  return t;
}

describe('Microsoft 365 sync: switch and configuration', () => {
  it('does nothing at all while the switch is off (the default)', async () => {
    const t = setup({ enabled: false });
    expect(await t.tick()).toEqual({ status: 'off' });
    expect(t.fake.calls).toHaveLength(0);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM m365_sync_state').get()).toEqual({ n: 0 });
  });

  it('records "not configured" by setting name, without calling Microsoft', async () => {
    const t = setup({ env: { M365_CLIENT_SECRET: '' } });
    expect(await t.tick()).toEqual({ status: 'not_configured' });
    expect(t.fake.calls).toHaveLength(0);
    expect((await t.state()).lastResult).toBe('not_configured');
  });

  it('skips the tick when another invocation holds the lease', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO m365_sync_state (id, state, lease_until) VALUES (1, '{}', ?)`).run(Math.floor(T0 / 1000) + 300);
    expect(await t.tick()).toEqual({ status: 'busy' });
    expect(t.fake.calls).toHaveLength(0);
  });
});

describe('Microsoft 365 sync: dry run', () => {
  it('reports what would change and writes no account, mailbox or link', async () => {
    const t = setup({ dryRun: true });
    t.fake.setReconcile([[person(1, 'alex'), person(2, 'blair', { accountEnabled: false })]]);
    expect(await t.tick()).toMatchObject({ status: 'worked', mode: 'dry_run', finished: true });
    expect(t.users()).toEqual([]);
    expect(t.mailboxes()).toEqual([]);
    expect(t.links()).toEqual([]);
    const s = await t.state();
    expect(s.lastRound).toMatchObject({ mode: 'dry_run', counts: { created: 1, ignored: 1 } });
    expect(s.lastRound!.report).toEqual([{ action: 'create', address: 'alex@example.test', reason: 'new_in_scope' }]);
    // A dry run never stores a delta link, so turning dry run off starts with a full reconciliation.
    expect(s.deltaLink).toBeNull();
  });

  it('switching dry run off makes the next run a live reconciliation', async () => {
    const t = setup({ dryRun: true });
    t.fake.setReconcile([[person(1, 'alex')]]);
    await t.tick();
    t.setSwitch(true, false);
    expect(await t.tick()).toMatchObject({ status: 'worked', round: 'reconcile', mode: 'live' });
    expect(t.users()).toHaveLength(1);
  });
});

describe('Microsoft 365 sync: live reconciliation', () => {
  it('pages the directory and creates pending accounts with personal mailboxes, keyed on object id', async () => {
    const t = await liveWith([[person(1, 'alex')], [person(2, 'blair'), person(3, 'casey', { assignedPlans: [] })]]);
    expect(t.users()).toEqual([
      expect.objectContaining({ email: 'alex@example.test', role: 'standard', status: 'pending', display_name: 'Person 1' }),
      expect.objectContaining({ email: 'blair@example.test', role: 'standard', status: 'pending' }),
    ]);
    expect(t.mailboxes()).toEqual([
      expect.objectContaining({ address: 'alex@example.test', type: 'personal', status: 'active' }),
      expect.objectContaining({ address: 'blair@example.test', type: 'personal', status: 'active' }),
    ]);
    expect(t.links().map((link) => link.object_id)).toEqual([oid(1), oid(2)]);
    expect(t.audits('user.provisioned')).toBe(2);
    expect(t.audits('mailbox.created')).toBe(2);
    const s = await t.state();
    expect(s.deltaLink).toBe(deltaUrl('tok-1'));
    expect(s.lastRound!.counts).toMatchObject({ created: 2, ignored: 1 });
  });

  it('is idempotent: a second reconciliation changes nothing', async () => {
    const t = await liveWith([[person(1, 'alex')]]);
    t.requestSyncNow();
    t.advance(1000);
    expect(await t.tick()).toMatchObject({ status: 'worked', round: 'reconcile' });
    expect(t.users()).toHaveLength(1);
    expect((await t.state()).lastRound!.counts).toMatchObject({ created: 0, unchanged: 1 });
  });

  it('adopts an existing standard account with the same address instead of creating one', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('u-existing', 'alex@example.test', 'standard', 'active')`).run();
    t.fake.setReconcile([[person(1, 'alex')]]);
    await t.tick();
    expect(t.users()).toHaveLength(1);
    expect(t.links()).toEqual([expect.objectContaining({ object_id: oid(1), user_id: 'u-existing', kind: 'person' })]);
    expect(t.audits('m365_sync.user_adopted')).toBe(1);
  });

  it('never adopts, creates or changes a manager', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('u-manager', 'alex@example.test', 'manager', 'active')`).run();
    t.fake.setReconcile([[person(1, 'alex')]]);
    await t.tick();
    expect(t.links()).toEqual([]);
    expect((await t.state()).lastRound!.report).toEqual([{ action: 'conflict', address: 'alex@example.test', reason: 'manager_not_adopted' }]);
  });

  it('reports a duplicate address on two Entra objects as a conflict and creates one account', async () => {
    const t = await liveWith([[person(1, 'alex'), person(2, 'alex', { displayName: 'Other' })]]);
    expect(t.users()).toHaveLength(1);
    expect(t.links()).toHaveLength(1);
    expect((await t.state()).lastRound!.report).toContainEqual({ action: 'conflict', address: 'alex@example.test', reason: 'duplicate_source_object' });
  });

  it('reports an address already used by a mailbox', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO mailboxes (id, address, type) VALUES ('m-shared', 'alex@example.test', 'shared')`).run();
    t.fake.setReconcile([[person(1, 'alex')]]);
    await t.tick();
    expect(t.users()).toEqual([]);
    expect((await t.state()).lastRound!.counts.conflicts).toBe(1);
  });

  it('pauses a linked account the full enumeration no longer returns (sweep)', async () => {
    const t = await liveWith([[person(1, 'alex'), person(2, 'blair')]]);
    t.fake.setReconcile([[person(1, 'alex')]], 'tok-2');
    t.requestSyncNow();
    t.advance(1000);
    await t.tick();
    expect(t.users().find((user) => user.email === 'blair@example.test')?.status).toBe('paused');
    expect(t.links().find((link) => link.object_id === oid(2))).toMatchObject({ source_state: 'out_of_scope', last_reason: 'not_seen', paused_by_sync: 1 });
    // Mail is never deleted: the mailbox stays.
    expect(t.mailboxes()).toHaveLength(2);
  });
});

describe('Microsoft 365 sync: delta rounds', () => {
  async function linked() {
    const t = await liveWith([[person(1, 'alex'), person(2, 'blair'), person(3, 'casey')]]);
    // alex signs in later and has a session
    t.sqlite.prepare(`UPDATE users SET status = 'active' WHERE email = 'alex@example.test'`).run();
    const alex = t.users().find((user) => user.email === 'alex@example.test')!;
    t.sqlite.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('s-1', ?, 'hash-1', '2099-01-01')`).run(alex.id);
    t.advance(HOUR);
    return { ...t, alexId: alex.id };
  }

  it('uses the saved delta link once the interval has passed', async () => {
    const t = await linked();
    t.fake.setDelta('tok-1', [[]], 'tok-2');
    expect(await t.tick()).toMatchObject({ status: 'worked', round: 'delta', finished: true });
    expect(t.fake.calls).toContain(deltaUrl('tok-1'));
    expect((await t.state()).deltaLink).toBe(deltaUrl('tok-2'));
  });

  it('updates the account and mailbox on a primary address change instead of recreating', async () => {
    const t = await linked();
    t.fake.setDelta('tok-1', [[person(1, 'alex.new', { displayName: 'Alex New' })]], 'tok-2');
    await t.tick();
    const alex = t.users().find((user) => user.id === t.alexId)!;
    expect(alex).toMatchObject({ email: 'alex.new@example.test', display_name: 'Alex New', status: 'active' });
    expect(t.mailboxes().map((mailbox) => mailbox.address)).toContain('alex.new@example.test');
    expect(t.users()).toHaveLength(3);
    // One audit row for the address, one for the name.
    expect(t.audits('m365_sync.user_updated')).toBe(2);
  });

  it('pauses a disabled account once, revokes its sessions, and keeps the mailbox', async () => {
    const t = await linked();
    t.fake.setDelta('tok-1', [[person(1, 'alex', { accountEnabled: false })]], 'tok-2');
    await t.tick();
    expect(t.users().find((user) => user.id === t.alexId)?.status).toBe('paused');
    expect(t.sqlite.prepare(`SELECT revoked FROM sessions WHERE id = 's-1'`).get()).toEqual({ revoked: 1 });
    expect(t.mailboxes().find((mailbox) => mailbox.address === 'alex@example.test')?.status).toBe('active');
    expect(t.audits('m365_sync.user_paused')).toBe(1);
  });

  it('pauses an unlicensed or deleted account', async () => {
    const t = await linked();
    t.fake.setDelta('tok-1', [[person(2, 'blair', { assignedPlans: [] }), removed(3, 'changed')]], 'tok-2');
    await t.tick();
    const status = Object.fromEntries(t.users().map((user) => [user.email, user.status]));
    expect(status).toMatchObject({ 'blair@example.test': 'paused', 'casey@example.test': 'paused' });
    expect(t.links().find((link) => link.object_id === oid(3))).toMatchObject({ last_reason: 'deleted' });
  });

  it('resumes an account the sync paused, to its earlier status, when it is back in scope', async () => {
    const t = await linked();
    t.fake.setDelta('tok-1', [[person(1, 'alex', { accountEnabled: false })]], 'tok-2');
    await t.tick();
    t.advance(HOUR);
    t.fake.setDelta('tok-2', [[person(1, 'alex')]], 'tok-3');
    await t.tick();
    expect(t.users().find((user) => user.id === t.alexId)?.status).toBe('active');
    expect(t.audits('m365_sync.user_resumed')).toBe(1);
  });

  it('never resumes an account a manager paused', async () => {
    const t = await linked();
    t.sqlite.prepare(`UPDATE users SET status = 'paused' WHERE id = ?`).run(t.alexId);
    t.fake.setDelta('tok-1', [[person(1, 'alex', { displayName: 'Alex' })]], 'tok-2');
    await t.tick();
    expect(t.users().find((user) => user.id === t.alexId)?.status).toBe('paused');
  });

  it('restarts with a full reconciliation when the delta link is gone (410)', async () => {
    const t = await linked();
    t.fake.queue(deltaUrl('tok-1'), { status: 410, headers: { location: INITIAL_DELTA_URL } });
    t.fake.setReconcile([[person(1, 'alex'), person(2, 'blair'), person(3, 'casey')]], 'tok-fresh');
    expect(await t.tick()).toMatchObject({ status: 'worked', round: 'reconcile', finished: true });
    const s = await t.state();
    expect(s.deltaLink).toBe(deltaUrl('tok-fresh'));
    expect(t.users()).toHaveLength(3);
  });

  it('runs a reconciliation instead of a delta when the link is close to its 7-day limit', () => {
    const state = { deltaLink: deltaUrl('x'), deltaLinkAt: new Date(T0).toISOString(), lastDeltaAt: new Date(T0).toISOString(), lastReconcileAt: new Date(T0).toISOString(), lastReconcileMode: 'live' } as Parameters<typeof dueRound>[0];
    expect(dueRound(state, { mode: 'live', requested: false, intervalMinutes: 60, now: T0 + 2 * HOUR })).toBe('delta');
    expect(dueRound(state, { mode: 'live', requested: false, intervalMinutes: 60, now: T0 + 30 * 60 * 1000 })).toBeNull();
    expect(dueRound(state, { mode: 'live', requested: false, intervalMinutes: 60, now: T0 + 25 * HOUR })).toBe('reconcile');
    expect(dueRound({ ...state, lastReconcileAt: new Date(T0 + 6.5 * 24 * HOUR).toISOString() }, { mode: 'live', requested: false, intervalMinutes: 60, now: T0 + 6.6 * 24 * HOUR })).toBe('reconcile');
    expect(dueRound(state, { mode: 'live', requested: true, intervalMinutes: 60, now: T0 + 1 })).toBe('reconcile');
  });
});

describe('Microsoft 365 sync: throttling and bounded, resumable work', () => {
  it('backs off on a long Retry-After, keeps its place, and resumes from the saved page', async () => {
    const t = setup();
    t.fake.setReconcile([[person(1, 'alex')], [person(2, 'blair')]], 'tok-1');
    const second = `https://graph.microsoft.com/v1.0/users/delta?$skiptoken=full-tok-1-1`;
    t.fake.queue(second, { status: 429, headers: { 'retry-after': '120' } });
    expect(await t.tick()).toEqual({ status: 'error', code: 'throttled' });
    let s = await t.state();
    expect(s.lastResult).toBe('backoff');
    expect(Date.parse(s.backoffUntil!)).toBe(T0 + 120_000);
    expect(s.round?.nextLink).toBe(second);
    expect(t.users()).toHaveLength(1);

    expect(await t.tick()).toEqual({ status: 'backoff' });
    t.advance(121_000);
    const before = t.fake.calls.length;
    expect(await t.tick()).toMatchObject({ status: 'worked', finished: true });
    // Resumed at page 2: the first page was not fetched again.
    expect(t.fake.calls.slice(before)).not.toContain(INITIAL_DELTA_URL);
    s = await t.state();
    expect(s.backoffStreak).toBe(0);
    expect(t.users()).toHaveLength(2);
  });

  it('spreads a large page over several ticks within its budget, then finishes', async () => {
    const t = setup();
    t.fake.setReconcile([Array.from({ length: 12 }, (_, index) => person(10 + index, `user${index}`))]);
    const budgets = { chunk: 2, d1: 20 };
    let ticks = 0;
    for (;;) {
      ticks += 1;
      const result = await t.tick({ budgets });
      if (result.status === 'worked' && result.finished) break;
      expect(result.status).toBe('worked');
      expect(ticks).toBeLessThan(30);
    }
    expect(ticks).toBeGreaterThan(1);
    expect(t.users()).toHaveLength(12);
    expect((await t.state()).lastRound!.counts.created).toBe(12);
  });

  it('reports a rejected secret and waits an hour before trying again', async () => {
    const t = setup();
    t.fake.tokenReplies.push({ status: 401, body: { error: 'invalid_client' } });
    expect(await t.tick()).toEqual({ status: 'error', code: 'credentials_rejected' });
    const s = await t.state();
    expect(s.lastError?.code).toBe('credentials_rejected');
    expect(Date.parse(s.backoffUntil!)).toBe(T0 + HOUR);
  });
});

describe('Microsoft 365 sync: groups and shared mailboxes', () => {
  it('limits accounts to the scope group and creates shared mailboxes from the shared group only', async () => {
    const t = setup({ env: { M365_SCOPE_GROUP_ID: SCOPE_GROUP, M365_SHARED_GROUP_ID: SHARED_GROUP } });
    t.fake.memberships.set(oid(1), [SCOPE_GROUP]);
    t.fake.memberships.set(oid(9), [SHARED_GROUP]);
    t.fake.setReconcile([[
      person(1, 'alex'),
      person(2, 'blair'),
      person(9, 'team', { accountEnabled: false, assignedPlans: [] }),
      person(10, 'room', { accountEnabled: false, assignedPlans: [] }),
    ]]);
    await t.tick();
    expect(t.users().map((user) => user.email)).toEqual(['alex@example.test']);
    expect(t.mailboxes()).toContainEqual(expect.objectContaining({ address: 'team@example.test', type: 'shared', owner_user_id: null }));
    expect(t.mailboxes().map((mailbox) => mailbox.address)).not.toContain('room@example.test');
    // No one is assigned to a synced shared mailbox: delegation stays a manager's decision.
    expect(t.sqlite.prepare(`SELECT COUNT(*) AS n FROM mailbox_assignments a JOIN mailboxes m ON m.id = a.mailbox_id WHERE m.type = 'shared'`).get()).toEqual({ n: 0 });
  });

  it('never disables a shared mailbox that leaves the group', async () => {
    const t = setup({ env: { M365_SHARED_GROUP_ID: SHARED_GROUP } });
    t.fake.memberships.set(oid(9), [SHARED_GROUP]);
    t.fake.setReconcile([[person(9, 'team', { accountEnabled: false, assignedPlans: [] })]]);
    await t.tick();
    t.fake.memberships.set(oid(9), []);
    t.fake.setReconcile([[person(9, 'team', { accountEnabled: false, assignedPlans: [] })]], 'tok-2');
    t.requestSyncNow();
    t.advance(1000);
    await t.tick();
    expect(t.mailboxes()).toEqual([expect.objectContaining({ address: 'team@example.test', status: 'active' })]);
    expect((await t.state()).lastRound!.report).toContainEqual({ action: 'left_source_kept', address: 'team@example.test', reason: 'disabled' });
  });

  it('pauses a person whose mailbox was converted to shared, without creating a second mailbox', async () => {
    const t = setup({ env: { M365_SHARED_GROUP_ID: SHARED_GROUP } });
    t.fake.setReconcile([[person(1, 'alex')]]);
    await t.tick();
    t.fake.memberships.set(oid(1), [SHARED_GROUP]);
    t.fake.setReconcile([[person(1, 'alex', { accountEnabled: false })]], 'tok-2');
    t.requestSyncNow();
    t.advance(1000);
    await t.tick();
    expect(t.users()[0].status).toBe('paused');
    expect(t.mailboxes()).toHaveLength(1);
  });
});

describe('Microsoft 365 sync: sign-in name (UPN) for the welcome email', () => {
  const upnOf = (t: { links: () => Array<Record<string, unknown>> }, n: number) => t.links().find((link) => link.object_id === oid(n))?.upn;

  it('records the UPN with the person, including when it differs from the primary address', async () => {
    const t = await liveWith([[
      person(1, 'alex'),
      person(2, 'blair', { userPrincipalName: 'Blair.Smith@Corp.Example.Test' }),
      person(3, 'casey', { userPrincipalName: null }),
    ]]);
    expect(upnOf(t, 1)).toBe('alex@example.test');
    expect(upnOf(t, 2)).toBe('blair.smith@corp.example.test');
    // Nothing usable from Graph: left empty, the email falls back to the account address.
    expect(upnOf(t, 3)).toBe('');
    // The account address is the primary SMTP address, never the UPN.
    expect(t.users().map((user) => user.email)).toEqual(['alex@example.test', 'blair@example.test', 'casey@example.test']);
  });

  it('follows a UPN change without touching the account, and never lists unlicensed people', async () => {
    const t = await liveWith([[person(1, 'alex'), person(4, 'dana', { assignedPlans: [] })]]);
    t.advance(60 * 60 * 1000);
    t.fake.setDelta('tok-1', [[person(1, 'alex', { userPrincipalName: 'alex@new.example.test' })]], 'tok-2');
    await t.tick();
    expect(upnOf(t, 1)).toBe('alex@new.example.test');
    expect(t.users().map((user) => user.email)).toEqual(['alex@example.test']);
    // The unlicensed person was never linked, so no welcome email can name them.
    expect(t.links().map((link) => link.object_id)).toEqual([oid(1)]);
  });
});
