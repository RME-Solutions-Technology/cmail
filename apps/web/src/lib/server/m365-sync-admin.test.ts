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
    expect(await loadM365SyncSwitch(d1)).toEqual({ enabled: false, dryRun: true, requestedAt: '', approvedRound: '' });
  });

  it('asks the Worker for its configuration over the private binding and keeps only setting names', async () => {
    const { env, fetch } = setup({ configured: false, problems: ['M365_CLIENT_SECRET is not set (wrangler secret put)'] });
    const overview = await loadM365SyncOverview(env);
    expect(fetch).toHaveBeenCalledWith('https://cmail-email-worker.internal/internal/m365-sync/config', expect.objectContaining({ method: 'GET' }));
    expect(overview.config).toEqual({ state: 'not_configured', problems: ['M365_CLIENT_SECRET is not set (wrangler secret put)'] });
    expect(overview.installed).toBe(true);
  });

  it('shows shared mailbox detection, linked shared mailboxes and the found/created counts, but no Graph link', async () => {
    const { env, sqlite } = setup();
    sqlite.prepare(`INSERT INTO mailboxes (id, address, type) VALUES ('m-team', 'team@example.test', 'shared')`).run();
    sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, mailbox_id) VALUES ('00000000-0000-0000-0000-000000000009', 'shared', 'm-team')`).run();
    const counts = { created: 0, adopted: 0, updated: 0, paused: 0, resumed: 0, sharedCreated: 1, sharedFound: 1, conflicts: 0, unchanged: 0, ignored: 0, typeUnknown: 0 };
    sqlite.prepare(`INSERT INTO m365_sync_state (id, state) VALUES (1, ?)`).run(JSON.stringify({
      deltaLink: 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=secret-token',
      sharedDetection: true,
      lastRound: { kind: 'reconcile', mode: 'live', startedAt: '2026-11-15T00:00:00Z', finishedAt: '2026-11-15T00:01:00Z', counts, report: [], brake: null },
    }));
    let overview = await loadM365SyncOverview(env);
    expect(overview.unreadableLinked).toBe(0);
    // Its mailbox type has been unreadable in 3 full reconciliations in a row: Admin alerts.
    sqlite.prepare(`INSERT INTO m365_sync_mailbox_purpose (object_id, purpose, checked_round, failed_reconciles) VALUES ('00000000-0000-0000-0000-000000000009', 'unknown', 'r', 3)`).run();
    // An unlinked object never counts.
    sqlite.prepare(`INSERT INTO m365_sync_mailbox_purpose (object_id, purpose, checked_round, failed_reconciles) VALUES ('00000000-0000-0000-0000-000000000010', 'unknown', 'r', 5)`).run();
    overview = await loadM365SyncOverview(env);
    expect(overview.unreadableLinked).toBe(1);
    expect(overview.linkedShared).toBe(1);
    expect(overview.status).toMatchObject({ sharedDetection: true, lastRound: { counts: { sharedFound: 1, sharedCreated: 1 } } });
    expect(JSON.stringify(overview)).not.toContain('secret-token');
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
    expect(await loadM365SyncSwitch(d1)).toEqual({ enabled: true, dryRun: false, requestedAt: '2026-11-15T01:00:00.000Z', approvedRound: '' });
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

  function seedHeld(sqlite: ReturnType<typeof setup>['sqlite']) {
    const state = {
      deltaLink: 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=secret-ish',
      round: {
        id: 'round-held-1', kind: 'delta', mode: 'live', phase: 'held', startedAt: '2026-11-15T00:00:00.000Z',
        nextLink: 'https://graph.microsoft.com/v1.0/users/delta?$skiptoken=abc', finalDeltaLink: null,
        pending: [{ id: 'x', kind: 'person', address: 'pending@example.test', displayName: '', reason: '' }],
        pauseQueue: [{ id: '00000000-0000-0000-0000-000000000001', address: 'gone@example.test', reason: 'disabled' }],
        fetched: 6, brake: { reason: 'too_many_pauses', pauses: 6, linked: 10, percent: 60 },
        counts: {}, report: [], restarts: 0,
      },
    };
    sqlite.prepare(`INSERT INTO m365_sync_state (id, state) VALUES (1, ?)`).run(JSON.stringify(state));
  }

  it('sends the page display fields only: no Graph links or unapplied page data', async () => {
    const { env, sqlite } = setup();
    seedHeld(sqlite);
    const overview = await loadM365SyncOverview(env);
    const text = JSON.stringify(overview);
    expect(text).not.toContain('deltatoken');
    expect(text).not.toContain('skiptoken');
    expect(text).not.toContain('pending@example.test');
    expect(overview.status?.round).toMatchObject({ id: 'round-held-1', phase: 'held', heldPauses: [{ address: 'gone@example.test', reason: 'disabled' }] });
  });

  it('approves only the round that is held now, by its exact id, and audits it', async () => {
    const { env, d1, sqlite, audits } = setup();
    expect(await applyM365AdminAction(env, { id: 'manager-1' }, 'approve_round', new Date(), 'round-held-1')).toMatchObject({ ok: false, status: 409 });
    seedHeld(sqlite);
    expect(await applyM365AdminAction(env, { id: 'manager-1' }, 'approve_round', new Date(), 'another-round')).toMatchObject({ ok: false });
    expect(await applyM365AdminAction(env, { id: 'manager-1' }, 'approve_round', new Date(), 'round-held-1')).toMatchObject({ ok: true });
    expect((await loadM365SyncSwitch(d1)).approvedRound).toBe('round-held-1');
    expect(audits().map((row) => (row as { event_type: string }).event_type)).toEqual(['org.m365_sync_approved']);
  });

  it('refuses on the server to approve a round held for an empty result', async () => {
    const { env, d1, sqlite } = setup();
    sqlite.prepare(`INSERT INTO m365_sync_state (id, state) VALUES (1, ?)`).run(JSON.stringify({
      round: { id: 'round-empty-1', kind: 'reconcile', mode: 'live', phase: 'held', startedAt: '2026-11-15T00:00:00.000Z',
        pauseQueue: [], pending: [], fetched: 0, brake: { reason: 'empty_result', pauses: 3, linked: 3, percent: 100 } },
    }));
    expect(await applyM365AdminAction(env, { id: 'manager-1' }, 'approve_round', new Date(), 'round-empty-1')).toMatchObject({ ok: false, status: 409 });
    expect((await loadM365SyncSwitch(d1)).approvedRound).toBe('');
  });

  it('accepts only known actions', () => {
    expect(parseM365AdminAction('enable')).toBe('enable');
    expect(parseM365AdminAction('drop_tables')).toBeNull();
    expect(parseM365AdminAction(null)).toBeNull();
  });
});
