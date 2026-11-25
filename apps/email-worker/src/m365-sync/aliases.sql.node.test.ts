import { describe, expect, it } from 'vitest';
import { loadAliasSyncState } from '@stanchion/shared/exchange-mirror';
import { migratedDatabase } from '../testing/sqlite-d1';
import { ALIAS_USERS_URL } from './graph';
import { runAliasSyncTick, smtpAliases } from './aliases';
import { CLIENT_ID, DOMAIN, TENANT_ID, fakeGraph, oid } from './testing/fake-graph';

// The alias import against every real migration (node:sqlite) and a fake
// Graph. Fixtures use placeholder GUIDs and example.test addresses only.

const T0 = Date.parse('2026-11-16T00:00:00Z');
const HOUR = 60 * 60 * 1000;

function setup(options: { aliasSwitch?: boolean; sync?: boolean; dryRun?: boolean } = {}) {
  const { d1, sqlite } = migratedDatabase();
  const fake = fakeGraph();
  let clock = T0;
  const setting = (key: string, value: boolean) => sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value ? 'true' : 'false');
  setting('m365_alias_sync_enabled', options.aliasSwitch ?? true);
  setting('m365_sync_enabled', options.sync ?? true);
  setting('m365_sync_dry_run', options.dryRun ?? false);

  // Linked people (personal mailboxes) and one linked shared mailbox.
  const person = (n: number, local: string) => {
    sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES (?, ?, 'standard', 'active')`).run(`u${n}`, `${local}@${DOMAIN}`);
    sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status, owner_user_id) VALUES (?, ?, 'personal', 'active', ?)`).run(`mbx-${local}`, `${local}@${DOMAIN}`, `u${n}`);
    sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, user_id) VALUES (?, 'person', ?)`).run(oid(n), `u${n}`);
  };
  person(1, 'alice');
  person(2, 'bob');
  sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-support', ?, 'shared', 'active')`).run(`support@${DOMAIN}`);
  sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, mailbox_id) VALUES (?, 'shared', 'mbx-support')`).run(oid(3));
  // A Stanchion-only mailbox that Microsoft 365 knows nothing about.
  sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-sales', ?, 'shared', 'active')`).run(`sales@${DOMAIN}`);

  const env = { DB: d1, M365_TENANT_ID: TENANT_ID, M365_CLIENT_ID: CLIENT_ID, M365_CLIENT_SECRET: 'test-secret', MAIL_DOMAIN: DOMAIN };
  const listing = (users: Array<{ id: string; proxyAddresses: string[] }>) => fake.queue(ALIAS_USERS_URL, { status: 200, body: { value: users } });
  const tick = () => runAliasSyncTick(env, { fetcher: fake.fetch, sleep: async () => undefined, now: () => clock });
  const aliases = () => sqlite.prepare('SELECT address, mailbox_id FROM mailbox_aliases ORDER BY address').all() as Array<{ address: string; mailbox_id: string }>;
  const advance = (ms: number) => { clock += ms; };
  return { d1, sqlite, fake, listing, tick, aliases, advance, setting };
}

const ALICE = { id: oid(1), proxyAddresses: [`SMTP:alice@${DOMAIN}`, `smtp:Ally@${DOMAIN}`, 'smtp:alice@other.example', 'SIP:alice@example.test', 'X500:/o=ExchangeLabs'] };
const BOB = { id: oid(2), proxyAddresses: [`SMTP:bob@${DOMAIN}`, `smtp:robert@${DOMAIN}`] };
const SUPPORT = { id: oid(3), proxyAddresses: [`SMTP:support@${DOMAIN}`, `smtp:help@${DOMAIN}`] };

describe('Microsoft 365 alias import', () => {
  it('keeps only smtp entries on MAIL_DOMAIN', () => {
    expect(smtpAliases(ALICE.proxyAddresses, DOMAIN)).toEqual([`alice@${DOMAIN}`, `ally@${DOMAIN}`]);
    expect(smtpAliases(['smtp:bad address@example.test', 'smtp:x@sub.example.test'], DOMAIN)).toEqual([]);
    // Graph's own example writes a space after the prefix.
    expect(smtpAliases([`SMTP: bob@${DOMAIN}`, `smtp: bob@sales.${DOMAIN}`, `smtp: Bobby@${DOMAIN}`], DOMAIN)).toEqual([`bob@${DOMAIN}`, `bobby@${DOMAIN}`]);
  });

  it('keeps smtp entries on every organisation domain once the sync has discovered them (docs/multi-domain.md)', async () => {
    expect(smtpAliases(ALICE.proxyAddresses, new Set([DOMAIN, 'other.example']))).toEqual([`alice@${DOMAIN}`, `ally@${DOMAIN}`, 'alice@other.example']);
    const t = setup();
    // Unchanged without a discovered domain: other.example is ignored.
    t.listing([ALICE, BOB, SUPPORT]);
    await t.tick();
    expect(t.aliases().map((row) => row.address)).not.toContain('alice@other.example');
    // The sync discovered other.example as a verified tenant domain.
    t.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('m365_verified_domains', ?)`)
      .run(JSON.stringify({ tenantId: TENANT_ID, domains: ['other.example'], refreshedAt: T0, attemptedAt: T0, problem: '' }));
    t.advance(2 * HOUR);
    t.listing([ALICE, BOB, SUPPORT]);
    await t.tick();
    expect(t.aliases()).toContainEqual({ address: 'alice@other.example', mailbox_id: 'mbx-alice' });
  });

  it('does nothing, and calls nothing, while its switch or the sync is off, or the sync is in dry run without writes', async () => {
    for (const options of [{ aliasSwitch: false }, { sync: false }]) {
      const t = setup(options);
      expect((await t.tick()).status).toBe(options.aliasSwitch === false ? 'off' : 'sync_off');
      expect(t.fake.calls).toEqual([]);
      expect(t.aliases()).toEqual([]);
    }
    const dry = setup({ dryRun: true });
    dry.listing([ALICE, BOB]);
    expect(await dry.tick()).toMatchObject({ status: 'dry_run', counts: { added: 2 } });
    expect(dry.aliases()).toEqual([]);
  });

  it('imports aliases of linked people and shared mailboxes, never a mailbox\'s own address', async () => {
    const t = setup();
    t.listing([ALICE, BOB, SUPPORT, { id: oid(9), proxyAddresses: [`smtp:ghost@${DOMAIN}`] }, { id: oid(2 + 0x100), proxyAddresses: [] }]);
    expect(await t.tick()).toMatchObject({ status: 'worked', counts: { total: 3, added: 3, conflicts: 0, unlinked: 1 } });
    expect(t.aliases()).toEqual([
      { address: `ally@${DOMAIN}`, mailbox_id: 'mbx-alice' },
      { address: `help@${DOMAIN}`, mailbox_id: 'mbx-support' },
      { address: `robert@${DOMAIN}`, mailbox_id: 'mbx-bob' },
    ]);
    expect((await loadAliasSyncState(t.d1))).toMatchObject({ lastResult: 'ok', lastRunAt: T0 });
    const audit = t.sqlite.prepare(`SELECT detail FROM audit_log WHERE event_type = 'm365_sync.aliases_changed'`).all();
    expect(audit).toEqual([{ detail: 'Microsoft 365 alias import: 3 added, 0 moved, 0 removed, 0 refused (conflict)' }]);
  });

  it('refuses an alias that is another mailbox\'s address or that two objects claim', async () => {
    const t = setup();
    t.listing([
      { id: oid(1), proxyAddresses: [`smtp:sales@${DOMAIN}`, `smtp:shared-name@${DOMAIN}`] },
      { id: oid(2), proxyAddresses: [`smtp:shared-name@${DOMAIN}`, `smtp:bobby@${DOMAIN}`] },
    ]);
    expect(await t.tick()).toMatchObject({ status: 'worked', counts: { added: 1, conflicts: 2 } });
    expect(t.aliases()).toEqual([{ address: `bobby@${DOMAIN}`, mailbox_id: 'mbx-bob' }]);
    // The database refuses it too, whoever writes.
    expect(() => t.sqlite.prepare(`INSERT INTO mailbox_aliases (address, mailbox_id, object_id) VALUES (?, 'mbx-bob', ?)`).run(`sales@${DOMAIN}`, oid(2))).toThrow(/belongs to a mailbox/);
  });

  it('a new mailbox at an alias address takes it over: the alias is dropped', async () => {
    const t = setup();
    t.listing([BOB]);
    await t.tick();
    t.sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-robert', ?, 'shared', 'active')`).run(`robert@${DOMAIN}`);
    expect(t.aliases()).toEqual([]);
  });

  it('moves an alias Microsoft 365 moved, removes one it dropped, and runs at most once per interval', async () => {
    const t = setup();
    t.listing([ALICE, BOB]);
    await t.tick();
    t.listing([{ id: oid(1), proxyAddresses: [`SMTP:alice@${DOMAIN}`, `smtp:robert@${DOMAIN}`] }, { id: oid(2), proxyAddresses: [`SMTP:bob@${DOMAIN}`] }]);
    expect((await t.tick()).status).toBe('idle');
    t.advance(HOUR);
    expect(await t.tick()).toMatchObject({ status: 'worked', counts: { total: 1, added: 0, moved: 1, removed: 1 } });
    expect(t.aliases()).toEqual([{ address: `robert@${DOMAIN}`, mailbox_id: 'mbx-alice' }]);
  });

  it('holds a mass removal until a manager approves it, and only a full successful run counts as fresh', async () => {
    const t = setup();
    const many = Array.from({ length: 10 }, (_, index) => `smtp:a${index}@${DOMAIN}`);
    t.listing([{ id: oid(1), proxyAddresses: many }]);
    await t.tick();
    expect(t.aliases()).toHaveLength(10);
    expect(await loadAliasSyncState(t.d1)).toMatchObject({ lastResult: 'ok', lastOkAt: T0 });

    // A listing that drops 6 of 10 (over 20 percent and over 5): additions apply, removals wait.
    t.advance(HOUR);
    t.listing([{ id: oid(1), proxyAddresses: [...many.slice(0, 4), `smtp:new@${DOMAIN}`] }]);
    expect(await t.tick()).toMatchObject({ status: 'held', counts: { added: 1, removed: 0, heldRemovals: 6 } });
    expect(t.aliases()).toHaveLength(11);
    expect(await loadAliasSyncState(t.d1)).toMatchObject({ lastResult: 'held', lastError: 'mass_removal', lastOkAt: T0 });

    // A manager approves: the next run removes them and clears the approval.
    t.setting('m365_alias_sync_approve_removals', true);
    t.advance(HOUR);
    t.listing([{ id: oid(1), proxyAddresses: [...many.slice(0, 4), `smtp:new@${DOMAIN}`] }]);
    expect(await t.tick()).toMatchObject({ status: 'worked', counts: { removed: 6, heldRemovals: 0 } });
    expect(t.aliases()).toHaveLength(5);
    expect(t.sqlite.prepare(`SELECT value FROM org_settings WHERE key = 'm365_alias_sync_approve_removals'`).get()).toEqual({ value: 'false' });
    expect(await loadAliasSyncState(t.d1)).toMatchObject({ lastResult: 'ok', lastOkAt: T0 + 2 * HOUR });
  });

  it('an approval is good for one run only: an unused one never authorises a later mass removal', async () => {
    const t = setup();
    const many = Array.from({ length: 10 }, (_, index) => `smtp:a${index}@${DOMAIN}`);
    t.listing([{ id: oid(1), proxyAddresses: many }]);
    await t.tick();
    // Approved, but the next run removes nothing: the approval is still used up.
    t.setting('m365_alias_sync_approve_removals', true);
    t.advance(HOUR);
    t.listing([{ id: oid(1), proxyAddresses: many }]);
    expect(await t.tick()).toMatchObject({ status: 'worked', counts: { removed: 0 } });
    expect(t.sqlite.prepare(`SELECT value FROM org_settings WHERE key = 'm365_alias_sync_approve_removals'`).get()).toEqual({ value: 'false' });
    // A later mass removal is held.
    t.advance(HOUR);
    t.listing([{ id: oid(1), proxyAddresses: many.slice(0, 2) }]);
    expect(await t.tick()).toMatchObject({ status: 'held', counts: { heldRemovals: 8 } });
    expect(t.aliases()).toHaveLength(10);
    // Also cleared by a run that fails.
    t.setting('m365_alias_sync_approve_removals', true);
    t.advance(HOUR);
    t.fake.queue(ALIAS_USERS_URL, { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } });
    expect(await t.tick()).toEqual({ status: 'error' });
    expect(t.sqlite.prepare(`SELECT value FROM org_settings WHERE key = 'm365_alias_sync_approve_removals'`).get()).toEqual({ value: 'false' });
  });

  it('holds instead of removing everything when the listing comes back empty, and records a Graph failure', async () => {
    const t = setup();
    t.listing([ALICE, BOB]);
    await t.tick();
    t.advance(HOUR);
    t.listing([]);
    expect(await t.tick()).toMatchObject({ status: 'held' });
    expect(t.aliases()).toHaveLength(2);
    t.advance(HOUR);
    t.fake.queue(ALIAS_USERS_URL, { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } });
    expect(await t.tick()).toEqual({ status: 'error' });
    expect(await loadAliasSyncState(t.d1)).toMatchObject({ lastResult: 'error', lastError: 'unauthorized' });
    expect(t.aliases()).toHaveLength(2);
  });
});
