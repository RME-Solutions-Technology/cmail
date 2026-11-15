import { describe, expect, it, vi } from 'vitest';
import { loadM365PermsSwitch } from '@cmail/shared/m365-perms';
import { createTestDatabase } from './mcp/testing/harness';
import { applyM365PermsAdminAction, loadM365PermsOverview, parseM365PermsAdminAction, permsWorkerConfigStatus } from './m365-perms-admin';

function setup(config: { configured: boolean; problems?: string[]; groups?: boolean } | 'none' = { configured: true, groups: true }) {
  const { d1, sqlite } = createTestDatabase();
  sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('manager-1', 'manager@example.test', 'manager', 'active')`).run();
  const fetch = vi.fn(async () => Response.json(config));
  const env = { DB: d1, EMAIL_SERVICE: config === 'none' ? undefined : ({ fetch } as unknown as Fetcher) };
  const audits = () => sqlite.prepare('SELECT event_type FROM audit_log ORDER BY rowid').all();
  const setting = (key: string) => (sqlite.prepare('SELECT value FROM org_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  return { d1, sqlite, env, fetch, audits, setting };
}

const manager = { id: 'manager-1' };

describe('Shared mailbox access admin', () => {
  it('is off with dry run on by default', async () => {
    const { d1 } = setup();
    expect(await loadM365PermsSwitch(d1)).toEqual({ enabled: false, dryRun: true, requestedAt: '', approvedRound: '' });
  });

  it('asks the Worker for its configuration over the private binding', async () => {
    const { env, fetch } = setup({ configured: false, problems: ['M365_EXO_CERT_PFX_B64 is not set (wrangler secret put)'], groups: false });
    const overview = await loadM365PermsOverview(env);
    expect(fetch).toHaveBeenCalledWith('https://cmail-email-worker.internal/internal/m365-perms/config', expect.objectContaining({ method: 'GET' }));
    expect(overview.config).toEqual({ state: 'not_configured', problems: ['M365_EXO_CERT_PFX_B64 is not set (wrangler secret put)'], groups: false });
    expect(overview.installed).toBe(true);
  });

  it('reports unknown when there is no binding or the Worker fails', async () => {
    expect(await permsWorkerConfigStatus(undefined)).toEqual({ state: 'unknown' });
    expect(await permsWorkerConfigStatus({ fetch: async () => { throw new Error('down'); } })).toEqual({ state: 'unknown' });
  });

  it('refuses to turn on while settings are missing, and turns on (dry run) when configured', async () => {
    const missing = setup({ configured: false, problems: ['x'] });
    expect(await applyM365PermsAdminAction(missing.env, manager, 'enable')).toMatchObject({ ok: false, status: 409 });
    expect(missing.setting('m365_perms_enabled')).toBeUndefined();

    const ready = setup();
    expect(await applyM365PermsAdminAction(ready.env, manager, 'enable')).toMatchObject({ ok: true });
    expect(ready.setting('m365_perms_enabled')).toBe('true');
    expect(await loadM365PermsSwitch(ready.d1)).toMatchObject({ enabled: true, dryRun: true });
    expect(ready.audits()).toEqual([{ event_type: 'org.m365_perms_toggled' }]);
  });

  it('only accepts known actions and asks for a collection only while on', async () => {
    expect(parseM365PermsAdminAction('drop')).toBeNull();
    const t = setup();
    expect(await applyM365PermsAdminAction(t.env, manager, 'sync_now')).toMatchObject({ ok: false, status: 409 });
    await applyM365PermsAdminAction(t.env, manager, 'enable');
    expect(await applyM365PermsAdminAction(t.env, manager, 'sync_now', new Date('2026-11-16T00:00:00Z'))).toMatchObject({ ok: true });
    expect(t.setting('m365_perms_requested_at')).toBe('2026-11-16T00:00:00.000Z');
  });

  it('says when a Sync access now inside the hourly limit will run', async () => {
    const t = setup();
    await applyM365PermsAdminAction(t.env, manager, 'enable');
    t.sqlite.prepare(`INSERT INTO m365_perm_state (id, state) VALUES (1, ?)`).run(JSON.stringify({ lastStartedAt: '2026-11-16T00:00:00.000Z', handledRequestAt: '' }));
    const result = await applyM365PermsAdminAction(t.env, manager, 'sync_now', new Date('2026-11-16T00:20:00Z'));
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('2026-11-16 01:00 UTC') });
    expect((await loadM365PermsOverview(t.env)).queuedUntil).toBe('2026-11-16T01:00:00.000Z');
  });

  it('approves only the held round named exactly, and never an empty-snapshot hold', async () => {
    const t = setup();
    const held = (reason: string) => JSON.stringify({ round: { id: 'round-7', mode: 'live', phase: 'held', startedAt: '2026-11-16T00:00:00Z', brake: { reason, removals: 6, ledger: 10, percent: 60 }, counts: {}, report: [], groupsPending: [], groupsFailed: [], removalsAllowed: false, removalBudget: 6, snapshot: null } });
    t.sqlite.prepare(`INSERT INTO m365_perm_state (id, state) VALUES (1, ?)`).run(held('too_many_removals'));
    expect(await applyM365PermsAdminAction(t.env, manager, 'approve_round', new Date(), 'round-8')).toMatchObject({ ok: false, status: 409 });
    expect(await applyM365PermsAdminAction(t.env, manager, 'approve_round', new Date(), 'round-7')).toMatchObject({ ok: true });
    expect(t.setting('m365_perms_approved_round')).toBe('round-7');
    t.sqlite.prepare(`UPDATE m365_perm_state SET state = ? WHERE id = 1`).run(held('empty_snapshot'));
    t.sqlite.prepare(`DELETE FROM org_settings WHERE key = 'm365_perms_approved_round'`).run();
    expect(await applyM365PermsAdminAction(t.env, manager, 'approve_round', new Date(), 'round-7')).toMatchObject({ ok: false, status: 409 });
    expect(t.setting('m365_perms_approved_round')).toBeUndefined();
  });
});
