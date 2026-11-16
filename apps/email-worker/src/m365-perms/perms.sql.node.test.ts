import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadM365PermsState } from '@cmail/shared/m365-perms';
import { migratedDatabase } from '../testing/sqlite-d1';
import { MAX_BATCHES_PER_PASS, runM365PermsTick, type M365PermsDeps } from './sync';
import { ORGANIZATION, TENANT_ID, fakeCollector, snapshotOf, type FakeOutcome } from './testing/fake-collector';
import type { PermissionSnapshot, SnapshotGrant, SnapshotMailbox } from './snapshot';

// The access sync against every real migration (node:sqlite), a fake
// collector and a fake Graph. Placeholder GUIDs and example.test only.

const T0 = Date.parse('2026-11-15T01:00:00Z');
const HOUR = 60 * 60 * 1000;
const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const APP_ID = '22222222-2222-2222-2222-222222222222';

const id = (kind: string, n: number) => `00000000-0000-0000-${kind}-${String(n).padStart(12, '0')}`;
const MBX = (n: number) => id('aaaa', n);
const PERSON = (n: number) => id('bbbb', n);
const GROUP = (n: number) => id('cccc', n);
const grant = (trustee: string, fullAccess: boolean, sendAs: boolean, kind: SnapshotGrant['kind'] = 'user'): SnapshotGrant => ({ trustee, kind, fullAccess, sendAs });
const mailbox = (n: number, grants: SnapshotGrant[], complete = true): SnapshotMailbox => ({ id: MBX(n), address: `shared${n}@example.test`, complete, grants });

function fakeGraph(groups: Record<string, string[]>, options: { failGroups?: string[] } = {}) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/oauth2/v2.0/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    const match = /groups\/([0-9a-f-]{36})\/transitiveMembers\/microsoft\.graph\.user/.exec(url);
    if (match) {
      if (options.failGroups?.includes(match[1])) return new Response('{}', { status: 403 });
      return Response.json({ value: (groups[match[1]] ?? []).map((member) => ({ id: member })) });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}

function setup(options: { enabled?: boolean; dryRun?: boolean; people?: number; mailboxes?: number; env?: Record<string, unknown>; groups?: Record<string, string[]>; failGroups?: string[]; personId?: (n: number) => string; mailboxId?: (n: number) => string } = {}) {
  const { d1, sqlite } = migratedDatabase();
  const collector = fakeCollector();
  const graph = fakeGraph(options.groups ?? {}, { failGroups: options.failGroups });
  let clock = T0;
  let ids = 0;
  const setting = (key: string, value: string) => sqlite.prepare(
    `INSERT INTO org_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
  setting('m365_perms_enabled', options.enabled === false ? 'false' : 'true');
  setting('m365_perms_dry_run', options.dryRun ? 'true' : 'false');

  // A manager, people linked by the Microsoft 365 sync, and shared mailboxes.
  sqlite.prepare(`INSERT INTO users (id, email, display_name, role, status) VALUES ('mgr', 'boss@example.test', 'Boss', 'manager', 'active')`).run();
  for (let n = 1; n <= (options.people ?? 3); n++) {
    sqlite.prepare(`INSERT INTO users (id, email, display_name, role, status) VALUES (?, ?, ?, 'standard', 'active')`).run(`u${n}`, `person${n}@example.test`, `Person ${n}`);
    sqlite.prepare(`INSERT INTO mailboxes (id, address, display_name, type, status, owner_user_id) VALUES (?, ?, ?, 'personal', 'active', ?)`).run(`pm${n}`, `person${n}@example.test`, `Person ${n}`, `u${n}`);
    sqlite.prepare(`INSERT INTO mailbox_assignments (mailbox_id, user_id, permissions) VALUES (?, ?, 'full')`).run(`pm${n}`, `u${n}`);
    sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, user_id) VALUES (?, 'person', ?)`).run((options.personId ?? PERSON)(n), `u${n}`);
  }
  for (let n = 1; n <= (options.mailboxes ?? 2); n++) linkShared(n);
  function linkShared(n: number) {
    sqlite.prepare(`INSERT INTO mailboxes (id, address, display_name, type, status) VALUES (?, ?, ?, 'shared', 'active')`).run(`sm${n}`, `shared${n}@example.test`, `Shared ${n}`);
    sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, mailbox_id) VALUES (?, 'shared', ?)`).run((options.mailboxId ?? MBX)(n), `sm${n}`);
  }

  const env = {
    DB: d1,
    M365_TENANT_ID: TENANT_ID,
    M365_EXO_APP_ID: APP_ID,
    M365_EXO_ORGANIZATION: ORGANIZATION,
    M365_EXO_CERT_PFX_B64: 'TUlJQ2VydGlmaWNhdGVQbGFjZWhvbGRlcg==',
    M365_PERMS_COLLECTOR: collector.namespace,
    M365_CLIENT_ID: CLIENT_ID,
    M365_CLIENT_SECRET: 'test-secret',
    MAIL_DOMAIN: 'example.test',
    ...options.env,
  };
  const tick = (deps: M365PermsDeps = {}) => runM365PermsTick(env as never, {
    fetcher: graph.fetcher,
    sleep: async () => undefined,
    now: () => clock,
    newId: () => `round-${++ids}`,
    ...deps,
  });
  /** Begin a round and finish it with this outcome (two ticks). */
  const round = async (outcome: FakeOutcome) => {
    clock += 25 * HOUR;
    collector.setOutcome(outcome);
    const first = await tick();
    if (first.status !== 'collecting') return first;
    clock += 5 * 60 * 1000;
    return tick();
  };
  const snapshotAt = (mailboxes: SnapshotMailbox[], extra: Parameters<typeof snapshotOf>[1] = {}): FakeOutcome => ({
    kind: 'snapshot',
    snapshot: snapshotOf(mailboxes, { collectedAt: new Date(clock + 25 * HOUR).toISOString(), ...extra }),
  });
  const assignments = () => sqlite.prepare(
    `SELECT mailbox_id, user_id, permissions, assigned_by FROM mailbox_assignments WHERE mailbox_id LIKE 'sm%' ORDER BY mailbox_id, user_id`,
  ).all() as Array<{ mailbox_id: string; user_id: string; permissions: string; assigned_by: string | null }>;
  const ledger = () => sqlite.prepare('SELECT mailbox_id, user_id, level_written FROM m365_perm_ledger ORDER BY mailbox_id, user_id').all();
  const audits = (type: string) => (sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE event_type = ?').get(type) as { n: number }).n;
  const managerAssign = (mailboxId: string, userId: string, level: string) => sqlite.prepare(
    `INSERT INTO mailbox_assignments (user_id, mailbox_id, permissions, assigned_at, assigned_by) VALUES (?, ?, ?, datetime('now'), 'mgr')
     ON CONFLICT(user_id, mailbox_id) DO UPDATE SET permissions = excluded.permissions, assigned_at = excluded.assigned_at, assigned_by = excluded.assigned_by`,
  ).run(userId, mailboxId, level);
  /** Every table's rows, hashed: proves "no write at all". */
  const dbHash = () => {
    const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>;
    const hash = createHash('sha256');
    for (const { name } of tables) hash.update(name).update(JSON.stringify(sqlite.prepare(`SELECT * FROM "${name}"`).all()));
    return hash.digest('hex');
  };
  const state = () => loadM365PermsState(d1);
  return { d1, sqlite, collector, graph, tick, round, snapshotAt, assignments, ledger, audits, managerAssign, dbHash, state, setting, linkShared, advance: (ms: number) => { clock += ms; }, clock: () => clock };
}

describe('Mailbox access sync: switch off', () => {
  it('makes no call and no write at all while off (the default), and primary mail rows are untouched', async () => {
    const t = setup({ enabled: false });
    t.collector.setOutcome(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    const before = t.dbHash();
    for (let i = 0; i < 3; i++) {
      t.advance(25 * HOUR);
      expect(await t.tick()).toEqual({ status: 'off' });
    }
    expect(t.collector.calls).toHaveLength(0);
    expect(t.graph.calls).toHaveLength(0);
    expect(t.dbHash()).toBe(before);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM m365_perm_state').get()).toEqual({ n: 0 });
  });

  it('is off when the setting is absent', async () => {
    const t = setup();
    t.sqlite.prepare(`DELETE FROM org_settings WHERE key = 'm365_perms_enabled'`).run();
    expect(await t.tick()).toEqual({ status: 'off' });
    expect(t.collector.calls).toHaveLength(0);
  });

  it('turning it off mid-round stops before the next write and keeps every assignment', async () => {
    const t = setup();
    const result = await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    expect(result).toMatchObject({ status: 'worked', finished: true });
    const before = t.assignments();
    t.setting('m365_perms_enabled', 'false');
    t.collector.setOutcome(t.snapshotAt([mailbox(1, [])]));
    t.advance(25 * HOUR);
    expect(await t.tick()).toEqual({ status: 'off' });
    expect(t.assignments()).toEqual(before);
  });

  it('records "not configured" by setting name and calls nothing', async () => {
    const t = setup({ env: { M365_EXO_CERT_PFX_B64: '' } });
    expect(await t.tick()).toEqual({ status: 'not_configured' });
    expect(t.collector.calls).toHaveLength(0);
    expect((await t.state()).lastResult).toBe('not_configured');
  });
});

describe('Mailbox access sync: mapping', () => {
  it('maps Full Access + Send As to Full, Full Access alone to Read, and Send As alone to nothing', async () => {
    const t = setup();
    const result = await t.round(t.snapshotAt([
      mailbox(1, [grant(PERSON(1), true, true), grant(PERSON(2), true, false), grant(PERSON(3), false, true)]),
    ]));
    expect(result).toMatchObject({ status: 'worked', finished: true, mode: 'live' });
    expect(t.assignments()).toEqual([
      { mailbox_id: 'sm1', user_id: 'u1', permissions: 'full', assigned_by: null },
      { mailbox_id: 'sm1', user_id: 'u2', permissions: 'read', assigned_by: null },
    ]);
    expect(t.ledger()).toHaveLength(2);
    expect(t.audits('mailbox.assigned')).toBe(2);
    const last = (await t.state()).lastRound!;
    expect(last.counts).toMatchObject({ added: 2, notRepresentable: 1 });
  });

  it('can map Full Access alone to Full when the option is on', async () => {
    const t = setup({ env: { M365_PERMS_FULLACCESS_IMPLIES_SEND: 'true' } });
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(2), true, false)])]));
    expect(t.assignments()).toEqual([{ mailbox_id: 'sm1', user_id: 'u2', permissions: 'full', assigned_by: null }]);
  });

  it('expands groups through Graph and combines rights with direct grants', async () => {
    const t = setup({ groups: { [GROUP(1)]: [PERSON(1), PERSON(2)] } });
    await t.round(t.snapshotAt([
      mailbox(1, [grant(GROUP(1), true, false, 'group'), grant(PERSON(1), false, true)]),
    ]));
    expect(t.assignments()).toEqual([
      { mailbox_id: 'sm1', user_id: 'u1', permissions: 'full', assigned_by: null },
      { mailbox_id: 'sm1', user_id: 'u2', permissions: 'read', assigned_by: null },
    ]);
  });

  it('gives access to a shared mailbox linked after an earlier run (the next run picks it up)', async () => {
    const t = setup({ mailboxes: 1 });
    const grants = [mailbox(1, [grant(PERSON(1), true, true)]), mailbox(2, [grant(PERSON(2), true, true)])];
    await t.round(t.snapshotAt(grants));
    expect(t.assignments().map((row) => row.mailbox_id)).toEqual(['sm1']);
    expect((await t.state()).lastRound!.counts.mailboxNotLinked).toBe(1);
    t.linkShared(2);
    await t.round(t.snapshotAt(grants));
    expect(t.assignments().map((row) => row.mailbox_id)).toEqual(['sm1', 'sm2']);
  });

  it('does not give new access to paused accounts or unlinked trustees', async () => {
    const t = setup();
    t.sqlite.prepare(`UPDATE users SET status = 'paused' WHERE id = 'u2'`).run();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(2), true, true), grant(id('eeee', 9), true, true)])]));
    expect(t.assignments()).toEqual([]);
  });
});

describe('Mailbox access sync: dry run', () => {
  it('reports what it would change and writes nothing but its status', async () => {
    const t = setup({ dryRun: true });
    const before = t.assignments();
    const result = await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    expect(result).toMatchObject({ status: 'worked', mode: 'dry_run', finished: true });
    expect(t.assignments()).toEqual(before);
    expect(t.ledger()).toEqual([]);
    expect(t.audits('mailbox.assigned')).toBe(0);
    const last = (await t.state()).lastRound!;
    expect(last.mode).toBe('dry_run');
    expect(last.counts.added).toBe(1);
    expect(last.report[0]).toMatchObject({ action: 'add', mailbox: 'shared1@example.test', user: 'person1@example.test' });
  });
});

describe('Mailbox access sync: manager assignments are never touched', () => {
  it('keeps a manager-made row even when Exchange grants more or nothing', async () => {
    const t = setup();
    t.managerAssign('sm1', 'u1', 'read');
    t.managerAssign('sm2', 'u2', 'full');
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)]), mailbox(2, [])]));
    expect(t.assignments()).toEqual([
      { mailbox_id: 'sm1', user_id: 'u1', permissions: 'read', assigned_by: 'mgr' },
      { mailbox_id: 'sm2', user_id: 'u2', permissions: 'full', assigned_by: 'mgr' },
    ]);
    expect((await t.state()).lastRound!.counts.managerKept).toBe(1);
    expect(t.ledger()).toEqual([]);
  });

  it('hands a row to the manager once a manager changes it, and never removes it afterwards', async () => {
    const t = setup();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    expect(t.ledger()).toHaveLength(1);
    t.managerAssign('sm1', 'u1', 'read');
    expect(t.ledger()).toEqual([]);
    await t.round(t.snapshotAt([mailbox(1, [])]));
    expect(t.assignments()).toEqual([{ mailbox_id: 'sm1', user_id: 'u1', permissions: 'read', assigned_by: 'mgr' }]);
  });

  it('does not give back access a manager removed while Exchange still grants it, and counts a later new grant again', async () => {
    const t = setup();
    const granted = t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]);
    await t.round(granted);
    expect(t.assignments()).toHaveLength(1);
    // The manager removes it in Admin > Mailboxes.
    t.sqlite.prepare(`DELETE FROM mailbox_assignments WHERE mailbox_id = 'sm1' AND user_id = 'u1'`).run();
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM m365_perm_released').get()).toEqual({ n: 1 });
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    expect(t.assignments()).toEqual([]);
    expect((await t.state()).lastRound!.report.some((item) => item.action === 'manager_removed')).toBe(true);
    // Exchange takes it away: the mark is forgotten. A new grant later counts again.
    await t.round(t.snapshotAt([mailbox(1, [])]));
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM m365_perm_released').get()).toEqual({ n: 0 });
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    expect(t.assignments()).toHaveLength(1);
  });

  it('never gives back a row a manager first edited and later removed', async () => {
    const t = setup();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    t.managerAssign('sm1', 'u1', 'read');
    expect(t.ledger()).toEqual([]);
    t.sqlite.prepare(`DELETE FROM mailbox_assignments WHERE mailbox_id = 'sm1' AND user_id = 'u1'`).run();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    expect(t.assignments()).toEqual([]);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM m365_perm_released').get()).toEqual({ n: 1 });
  });

  it('keeps the release mark while the manager row exists, even when Exchange stops granting', async () => {
    const t = setup();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    t.managerAssign('sm1', 'u1', 'read');
    await t.round(t.snapshotAt([mailbox(1, [])]));
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM m365_perm_released').get()).toEqual({ n: 1 });
    t.sqlite.prepare(`DELETE FROM mailbox_assignments WHERE mailbox_id = 'sm1' AND user_id = 'u1'`).run();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    expect(t.assignments()).toEqual([]);
  });

  it('a manager re-saving a sync-made row at the same level takes it over', async () => {
    const t = setup();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    t.managerAssign('sm1', 'u1', 'full');
    expect(t.ledger()).toEqual([]);
    await t.round(t.snapshotAt([mailbox(1, [])]));
    expect(t.assignments()).toEqual([{ mailbox_id: 'sm1', user_id: 'u1', permissions: 'full', assigned_by: 'mgr' }]);
  });

  it('never writes a personal mailbox', async () => {
    const t = setup();
    const before = t.sqlite.prepare(`SELECT * FROM mailbox_assignments WHERE mailbox_id LIKE 'pm%' ORDER BY mailbox_id`).all();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    expect(t.sqlite.prepare(`SELECT * FROM mailbox_assignments WHERE mailbox_id LIKE 'pm%' ORDER BY mailbox_id`).all()).toEqual(before);
  });
});

describe('Mailbox access sync: changes to sync-made rows', () => {
  it('upgrades, downgrades and removes only its own rows, with audit rows', async () => {
    const t = setup();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, false), grant(PERSON(2), true, true), grant(PERSON(3), true, true)])]));
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true), grant(PERSON(2), true, false)])]));
    expect(t.assignments()).toEqual([
      { mailbox_id: 'sm1', user_id: 'u1', permissions: 'full', assigned_by: null },
      { mailbox_id: 'sm1', user_id: 'u2', permissions: 'read', assigned_by: null },
    ]);
    expect(t.ledger()).toEqual([
      { mailbox_id: 'sm1', user_id: 'u1', level_written: 'full' },
      { mailbox_id: 'sm1', user_id: 'u2', level_written: 'read' },
    ]);
    expect(t.audits('mailbox.permission_changed')).toBe(2);
    expect(t.audits('mailbox.unassigned')).toBe(1);
    expect((await t.state()).lastRound!.counts).toMatchObject({ upgraded: 1, downgraded: 1, removed: 1 });
  });
});

describe('Mailbox access sync: link and eligibility rules', () => {
  it('does not remove access when the person is no longer linked (not an Exchange change)', async () => {
    const t = setup();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    t.sqlite.prepare(`DELETE FROM m365_sync_links WHERE user_id = 'u1'`).run();
    await t.round(t.snapshotAt([mailbox(1, [])]));
    expect(t.assignments()).toHaveLength(1);
  });

  it('does not raise access for a paused account', async () => {
    const t = setup();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, false)])]));
    t.sqlite.prepare(`UPDATE users SET status = 'paused' WHERE id = 'u1'`).run();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    expect(t.assignments()).toEqual([{ mailbox_id: 'sm1', user_id: 'u1', permissions: 'read', assigned_by: null }]);
  });

  it('treats an empty group as read (the mailbox is covered and stale grants go)', async () => {
    const t = setup({ groups: { [GROUP(1)]: [] } });
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    await t.round(t.snapshotAt([mailbox(1, [grant(GROUP(1), true, true, 'group')])]));
    expect(t.assignments()).toEqual([]);
  });
});

describe('Mailbox access sync: failures never remove access', () => {
  async function withAccess() {
    const t = setup();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)]), mailbox(2, [grant(PERSON(2), true, true)])]));
    expect(t.assignments()).toHaveLength(2);
    return t;
  }

  it('keeps every grant when the collector fails, and alerts after 3 failures in a row', async () => {
    const t = await withAccess();
    const before = t.assignments();
    for (let i = 1; i <= 3; i++) {
      expect(await t.round({ kind: 'failed', code: 'exchange_role_missing' })).toEqual({ status: 'failed', code: 'exchange_role_missing' });
      expect(t.assignments()).toEqual(before);
    }
    const state = await t.state();
    expect(state.consecutiveFailures).toBe(3);
    expect(state.lastError?.code).toBe('exchange_role_missing');
    expect(state.round).toBeNull();
    // A good run clears the alert.
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)]), mailbox(2, [grant(PERSON(2), true, true)])]));
    expect((await t.state()).consecutiveFailures).toBe(0);
  });

  it('keeps every grant when the collector times out', async () => {
    const t = await withAccess();
    const before = t.assignments();
    t.advance(25 * HOUR);
    t.collector.setOutcome({ kind: 'running' });
    expect(await t.tick()).toEqual({ status: 'collecting' });
    t.advance(10 * 60 * 1000);
    expect(await t.tick()).toEqual({ status: 'collecting' });
    t.advance(30 * 60 * 1000);
    expect(await t.tick()).toEqual({ status: 'failed', code: 'collector_timeout' });
    expect(t.assignments()).toEqual(before);
  });

  it('rejects a snapshot from another tenant and changes nothing', async () => {
    const t = await withAccess();
    const before = t.assignments();
    const bad = snapshotOf([mailbox(1, [])], { collectedAt: new Date(T0 + 100 * HOUR).toISOString() });
    bad.tenantId = '99999999-9999-9999-9999-999999999999';
    expect(await t.round({ kind: 'snapshot', snapshot: bad })).toEqual({ status: 'failed', code: 'bad_snapshot' });
    expect(t.assignments()).toEqual(before);
  });

  it('rejects malformed JSON and changes nothing', async () => {
    const t = await withAccess();
    const before = t.assignments();
    expect(await t.round({ kind: 'snapshot', snapshot: '{"schema":"cmail-exo-permissions"' })).toEqual({ status: 'failed', code: 'bad_snapshot' });
    expect(t.assignments()).toEqual(before);
  });

  it('keeps grants on a mailbox marked incomplete or missing from the snapshot', async () => {
    const t = await withAccess();
    const before = t.assignments();
    // Mailbox 1 incomplete (a query failed), mailbox 2 not in this pass at all
    // (for example an address the collector had to leave out).
    const result = await t.round(t.snapshotAt([mailbox(1, [], false)], { mailboxCount: 2 }));
    expect(result).toMatchObject({ status: 'worked', finished: true });
    expect(t.assignments()).toEqual(before);
    expect((await t.state()).lastRound!.counts.mailboxNotCovered).toBe(2);
  });

  it('keeps grants given through a group that could not be expanded', async () => {
    const t = setup({ groups: { [GROUP(1)]: [PERSON(1)] } });
    await t.round(t.snapshotAt([mailbox(1, [grant(GROUP(1), true, true, 'group')])]));
    expect(t.assignments()).toHaveLength(1);
    const failing = setup({ failGroups: [GROUP(1)] });
    // Same history in a second database, then a run whose group lookup fails.
    await failing.round(failing.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    const before = failing.assignments();
    await failing.round(failing.snapshotAt([mailbox(1, [grant(GROUP(1), true, true, 'group')])]));
    expect(failing.assignments()).toEqual(before);
  });
});

describe('Mailbox access sync: removal brake', () => {
  async function tenGrants() {
    const t = setup({ people: 10, mailboxes: 1 });
    const all = Array.from({ length: 10 }, (_, index) => grant(PERSON(index + 1), true, true));
    await t.round(t.snapshotAt([mailbox(1, all)]));
    expect(t.ledger()).toHaveLength(10);
    return t;
  }

  it('holds a round that would remove too many, still applies adds, and applies removals only after approval', async () => {
    const t = await tenGrants();
    t.linkShared(2);
    const snapshot = t.snapshotAt([
      mailbox(1, Array.from({ length: 4 }, (_, index) => grant(PERSON(index + 1), true, true))),
      mailbox(2, [grant(PERSON(1), true, true)]),
    ]);
    expect(await t.round(snapshot)).toEqual({ status: 'held' });
    // The add on mailbox 2 went ahead; the 6 removals wait.
    expect(t.assignments().filter((row) => row.mailbox_id === 'sm1')).toHaveLength(10);
    expect(t.assignments().filter((row) => row.mailbox_id === 'sm2')).toHaveLength(1);
    const held = (await t.state()).round!;
    expect(held.phase).toBe('held');
    expect(held.brake).toMatchObject({ reason: 'too_many_removals', removals: 6 });
    // Exactly the reviewed removals are recorded and shown.
    expect(held.removalKeys).toHaveLength(6);
    expect(held.heldItems).toHaveLength(6);
    // Without approval nothing more happens.
    t.advance(HOUR);
    expect(await t.tick()).toEqual({ status: 'held' });
    expect(t.assignments().filter((row) => row.mailbox_id === 'sm1')).toHaveLength(10);
    // Approval for exactly this round.
    t.setting('m365_perms_approved_round', held.id);
    expect(await t.tick()).toMatchObject({ status: 'worked', finished: true });
    expect(t.assignments().filter((row) => row.mailbox_id === 'sm1')).toHaveLength(4);
  });

  it('never applies an approval for another round id', async () => {
    const t = await tenGrants();
    await t.round(t.snapshotAt([mailbox(1, [grant(PERSON(1), true, true)])]));
    t.setting('m365_perms_approved_round', 'round-999');
    t.advance(HOUR);
    expect(await t.tick()).toEqual({ status: 'held' });
    expect(t.assignments()).toHaveLength(10);
  });

  it('holds when Exchange lists no shared mailboxes at all, and that hold cannot be approved', async () => {
    const t = await tenGrants();
    expect(await t.round(t.snapshotAt([], { mailboxCount: 0 }))).toEqual({ status: 'held' });
    const held = (await t.state()).round!;
    expect(held.brake?.reason).toBe('empty_snapshot');
    t.setting('m365_perms_approved_round', held.id);
    t.advance(HOUR);
    expect(await t.tick()).toEqual({ status: 'held' });
    expect(t.assignments()).toHaveLength(10);
  });

  it('"Sync access now" discards a held round and collects again', async () => {
    const t = await tenGrants();
    await t.round(t.snapshotAt([mailbox(1, [])]));
    expect((await t.state()).round?.phase).toBe('held');
    t.setting('m365_perms_requested_at', new Date(T0 + 1000 * HOUR).toISOString());
    t.collector.setOutcome(t.snapshotAt(Array.from({ length: 1 }, () => mailbox(1, Array.from({ length: 10 }, (_, index) => grant(PERSON(index + 1), true, true))))));
    t.advance(HOUR);
    expect(await t.tick()).toEqual({ status: 'collecting' });
    expect(t.assignments()).toHaveLength(10);
  });
});

describe('Mailbox access sync: a pass in batches (snapshots made by collect.ps1)', () => {
  // Written by container/m365-perms/collect.Tests.ps1 from the real script
  // with mocked cmdlets (batch size 2 over 4 shared mailboxes); CI checks the
  // files still match what the script produces.
  const fixture = (name: string) => JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'testing/fixtures', name), 'utf8')) as PermissionSnapshot;
  const harnessId = (prefix: string) => (n: number) => `00000000-0000-0000-0000-00000000${prefix}${String(n).padStart(3, '0')}`;

  function batches() {
    const t = setup({ people: 2, mailboxes: 2, personId: harnessId('b'), mailboxId: harnessId('a'), groups: { '00000000-0000-0000-0000-00000000c001': [] } });
    const at = (snapshot: PermissionSnapshot): FakeOutcome => ({ kind: 'snapshot', snapshot: { ...snapshot, collectedAt: new Date(t.clock() + 25 * HOUR).toISOString() } });
    return { t, batch1: at(fixture('pass-batch-1.json')), batch2: at(fixture('pass-batch-2.json')) };
  }

  it('applies nothing until the last batch, then applies the whole pass once and starts the next pass only after the interval', async () => {
    const { t, batch1, batch2 } = batches();
    t.advance(25 * HOUR);
    t.collector.setOutcome(batch1);
    expect(await t.tick()).toEqual({ status: 'collecting' });
    // Batch 1 is in: the next batch starts after its last mailbox; nothing is applied yet.
    t.collector.setOutcome(batch2);
    t.advance(15 * 60 * 1000);
    expect(await t.tick()).toEqual({ status: 'collecting' });
    expect(t.collector.begins.map((begin) => begin.cursor)).toEqual(['', harnessId('a')(2)]);
    expect(t.assignments()).toEqual([]);
    // Batch 2 completes the pass: applied once, from both batches.
    t.advance(15 * 60 * 1000);
    expect(await t.tick()).toMatchObject({ status: 'worked', finished: true });
    expect(t.assignments()).toEqual([
      { mailbox_id: 'sm1', user_id: 'u1', permissions: 'full', assigned_by: null },
      { mailbox_id: 'sm2', user_id: 'u2', permissions: 'read', assigned_by: null },
    ]);
    const last = (await t.state()).lastRound!;
    expect(last.snapshot).toMatchObject({ batches: 2, mailboxes: 4, complete: true });
    // No cursor is carried over: the next pass waits for the interval.
    t.advance(15 * 60 * 1000);
    expect(await t.tick()).toEqual({ status: 'idle' });
    expect(t.collector.begins).toHaveLength(2);
  });

  it('fails safely (nothing applied) when a pass needs more batches than allowed', async () => {
    const { t, batch1 } = batches();
    t.advance(25 * HOUR);
    t.collector.setOutcome(batch1);
    await t.tick();
    let result;
    // Every later batch comes back unfinished and empty (out of time at once).
    const stuck: FakeOutcome = { kind: 'snapshot', snapshot: { ...(batch1 as { snapshot: PermissionSnapshot }).snapshot, mailboxes: [], nextCursor: '' } };
    for (let i = 0; i < MAX_BATCHES_PER_PASS; i++) {
      t.collector.setAll(stuck);
      t.advance(15 * 60 * 1000);
      result = await t.tick();
      if (result.status !== 'collecting') break;
    }
    expect(result).toEqual({ status: 'failed', code: 'pass_too_long' });
    expect(t.assignments()).toEqual([]);
  });

  it('rejects batches that do not follow each other', async () => {
    const { t, batch1 } = batches();
    t.advance(25 * HOUR);
    t.collector.setOutcome(batch1);
    await t.tick();
    // The second batch repeats mailboxes from before the cursor.
    t.collector.setOutcome({ kind: 'snapshot', snapshot: { ...(batch1 as { snapshot: PermissionSnapshot }).snapshot, complete: true, nextCursor: '' } });
    t.advance(15 * 60 * 1000);
    await t.tick();
    t.advance(15 * 60 * 1000);
    expect(await t.tick()).toEqual({ status: 'failed', code: 'bad_snapshot' });
    expect(t.assignments()).toEqual([]);
  });
});