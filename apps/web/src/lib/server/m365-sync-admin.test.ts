import { describe, expect, it, vi } from 'vitest';
import { loadM365SyncSwitch } from '@cmail/shared/m365-sync';
import { createTestDatabase } from './mcp/testing/harness';
import { applyM365AdminAction, loadM365SyncOverview, parseM365AdminAction, workerConfigStatus } from './m365-sync-admin';

function setup(config: { configured: boolean; problems?: string[] } | 'none' | 'down' = { configured: true }) {
  const { d1, sqlite } = createTestDatabase();
  sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('manager-1', 'manager@example.test', 'manager', 'active')`).run();
  const fetch = vi.fn(async () => (config === 'down'
    ? new Response('nope', { status: 500 })
    : Response.json(config)));
  const env = { DB: d1, EMAIL_SERVICE: config === 'none' ? undefined : ({ fetch } as unknown as Fetcher) };
  const audits = () => sqlite.prepare('SELECT event_type, detail FROM audit_log ORDER BY rowid').all();
  return { d1, sqlite, env, fetch, audits };
}

describe('Microsoft 365 sync admin', () => {
  it('is off with dry run on by default', async () => {
    const { d1 } = setup();
    expect(await loadM365SyncSwitch(d1)).toEqual({ enabled: false, dryRun: true, requestedAt: '' });
  });

  it('asks the Worker for its configuration over the private binding and keeps only setting names', async () => {
    const { env, fetch } = setup({ configured: false, problems: ['M365_CLIENT_SECRET is not set (wrangler secret put)'] });
    const overview = await loadM365SyncOverview(env);
    expect(fetch).toHaveBeenCalledWith('https://cmail-email-worker.internal/internal/m365-sync/config', expect.objectContaining({ method: 'GET' }));
    expect(overview.config).toEqual({ state: 'not_configured', problems: ['M365_CLIENT_SECRET is not set (wrangler secret put)'] });
    expect(overview.installed).toBe(true);
  });

  it('reports unknown when there is no binding or the Worker fails', async () => {
    expect(await workerConfigStatus(undefined)).toEqual({ state: 'unknown' });
    expect(await workerConfigStatus({ fetch: async () => new Response('x', { status: 500 }) })).toEqual({ state: 'unknown' });
    expect(await workerConfigStatus({ fetch: async () => { throw new Error('down'); } })).toEqual({ state: 'unknown' });
  });

  it('refuses to turn on while the Worker reports missing settings', async () => {
    const { env, d1 } = setup({ configured: false, problems: ['M365_TENANT_ID is not set'] });
    const result = await applyM365AdminAction(env, { id: 'manager-1' }, 'enable');
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((await loadM365SyncSwitch(d1)).enabled).toBe(false);
  });

  it('turns on, toggles dry run, requests a run and audits each step', async () => {
    const { env, d1, audits } = setup();
    expect(await applyM365AdminAction(env, { id: 'manager-1' }, 'sync_now')).toMatchObject({ ok: false });
    expect(await applyM365AdminAction(env, { id: 'manager-1' }, 'enable')).toMatchObject({ ok: true });
    expect(await applyM365AdminAction(env, { id: 'manager-1' }, 'dry_run_off')).toMatchObject({ ok: true });
    expect(await applyM365AdminAction(env, { id: 'manager-1' }, 'sync_now', new Date('2026-11-15T01:00:00Z'))).toMatchObject({ ok: true });
    expect(await loadM365SyncSwitch(d1)).toEqual({ enabled: true, dryRun: false, requestedAt: '2026-11-15T01:00:00.000Z' });
    expect(await applyM365AdminAction(env, { id: 'manager-1' }, 'disable')).toMatchObject({ ok: true });
    expect((await loadM365SyncSwitch(d1)).enabled).toBe(false);
    expect(audits().map((row) => (row as { event_type: string }).event_type)).toEqual([
      'org.m365_sync_toggled', 'org.m365_sync_dry_run', 'org.m365_sync_requested', 'org.m365_sync_toggled',
    ]);
  });

  it('allows turning on when the Worker state is unknown (the Worker then reports for itself)', async () => {
    const { env } = setup('none');
    expect(await applyM365AdminAction(env, { id: 'manager-1' }, 'enable')).toMatchObject({ ok: true });
  });

  it('accepts only known actions', () => {
    expect(parseM365AdminAction('enable')).toBe('enable');
    expect(parseM365AdminAction('drop_tables')).toBeNull();
    expect(parseM365AdminAction(null)).toBeNull();
  });
});
