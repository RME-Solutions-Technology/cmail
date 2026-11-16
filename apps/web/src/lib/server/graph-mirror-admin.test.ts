import { describe, expect, it, vi } from 'vitest';
import { loadGraphMirrorSwitch } from '@cmail/shared/graph-mirror';
import { createTestDatabase } from './mcp/testing/harness';
import {
  applyExchangeMirrorAdminAction,
  graphMirrorWorkerConfig,
  loadExchangeMirrorOverview,
  parseExchangeMirrorAdminAction,
  parseImportOlderDays,
} from './exchange-mirror-admin';

const GRAPH_CONFIGURED = { configured: true, folders: ['inbox', 'sentitems', 'archive'], lookbackHours: 24, initialCap: 500 };
const NOW = Date.parse('2026-11-16T05:00:00Z');

function setup(graphConfig: Record<string, unknown> = GRAPH_CONFIGURED, runReply: Record<string, unknown> = { status: 'worked', filed: 3, complete: true }) {
  const { d1, sqlite } = createTestDatabase();
  sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('manager-1', 'manager@example.test', 'manager', 'active')`).run();
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/internal/graph-mirror/config')) return Response.json(graphConfig);
    if (url.endsWith('/internal/graph-mirror/run')) return Response.json(runReply);
    return Response.json({ configured: false, problems: [] });
  });
  const env = { DB: d1, EMAIL_SERVICE: { fetch } as unknown as Fetcher };
  const audits = () => sqlite.prepare(`SELECT event_type, detail FROM audit_log ORDER BY rowid`).all() as Array<{ event_type: string; detail: string }>;
  return { d1, sqlite, env, fetch, audits };
}

describe('Exchange mirror admin: Graph source', () => {
  it('is off by default and knows its actions', async () => {
    const { d1, env } = setup();
    expect(await loadGraphMirrorSwitch(d1)).toEqual({ enabled: false, importOlder: null });
    for (const action of ['graph_enable', 'graph_disable', 'graph_run_now', 'graph_import_older']) expect(parseExchangeMirrorAdminAction(action)).toBe(action);
    const overview = await loadExchangeMirrorOverview(env, NOW);
    expect(overview.graph).toMatchObject({ enabled: false, installed: true, config: { state: 'configured', folders: ['inbox', 'sentitems', 'archive'] }, importOlderPending: null });
  });

  it('keeps only well-formed Worker fields', async () => {
    expect(await graphMirrorWorkerConfig(undefined)).toEqual({ state: 'unknown' });
    expect(await graphMirrorWorkerConfig({ fetch: async () => Response.json({ configured: true, folders: ['inbox', 'drafts'], lookbackHours: 24, initialCap: 500 }) }))
      .toEqual({ state: 'configured', folders: ['inbox'], lookbackHours: 24, initialCap: 500 });
    expect(await graphMirrorWorkerConfig({ fetch: async () => Response.json({ configured: false, problems: ['M365_CLIENT_SECRET is not set (wrangler secret put)', 4] }) }))
      .toEqual({ state: 'not_configured', problems: ['M365_CLIENT_SECRET is not set (wrangler secret put)'] });
  });

  it('turns on and off, audited; refuses to turn on with missing settings or before migration 0033', async () => {
    const t = setup();
    const manager = { id: 'manager-1' };
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_enable')).toMatchObject({ ok: true });
    expect((await loadGraphMirrorSwitch(t.d1)).enabled).toBe(true);
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_disable')).toMatchObject({ ok: true });
    expect((await loadGraphMirrorSwitch(t.d1)).enabled).toBe(false);
    expect(t.audits().map((row) => row.event_type)).toEqual(['org.graph_mirror_toggled', 'org.graph_mirror_toggled']);

    const missing = setup({ configured: false, problems: ['M365_CLIENT_ID is not set'] });
    expect(await applyExchangeMirrorAdminAction(missing.env, manager, 'graph_enable')).toMatchObject({ ok: false, status: 409 });

    const old = setup();
    old.sqlite.exec('DROP TABLE graph_mirror_folders; DROP TABLE graph_mirror_state;');
    expect(await applyExchangeMirrorAdminAction(old.env, manager, 'graph_enable')).toMatchObject({ ok: false, status: 409, error: 'Apply database migration 0033 first' });
    expect((await loadGraphMirrorSwitch(old.d1)).enabled).toBe(false);
  });

  it('"Import older mail" takes 1 to 90 whole days, only while on, and shows as pending until the Worker applies it', async () => {
    expect([parseImportOlderDays('7'), parseImportOlderDays('90'), parseImportOlderDays('0'), parseImportOlderDays('91'), parseImportOlderDays('7.5'), parseImportOlderDays(null)])
      .toEqual([7, 90, null, null, null, null]);
    const t = setup();
    const manager = { id: 'manager-1' };
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_older', { days: '7', now: NOW })).toMatchObject({ ok: false, status: 409 });
    await applyExchangeMirrorAdminAction(t.env, manager, 'graph_enable');
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_older', { days: '500', now: NOW })).toMatchObject({ ok: false, status: 400 });
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_older', { days: '30', now: NOW })).toMatchObject({ ok: true });
    expect((await loadExchangeMirrorOverview(t.env, NOW)).graph.importOlderPending).toEqual({ days: 30, requestedAt: NOW });
    t.sqlite.prepare('INSERT INTO graph_mirror_state (id, import_older_done) VALUES (1, ?)').run(NOW);
    expect((await loadExchangeMirrorOverview(t.env, NOW)).graph.importOlderPending).toBeNull();
    expect(t.audits().at(-1)).toEqual({ event_type: 'org.graph_mirror_import_older', detail: 'Exchange mirror Graph source: import older mail, 30 days' });
  });

  it('"Run now" asks the Worker for one run and reports the count; only while on', async () => {
    const t = setup();
    const manager = { id: 'manager-1' };
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_run_now')).toMatchObject({ ok: false, status: 409 });
    await applyExchangeMirrorAdminAction(t.env, manager, 'graph_enable');
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_run_now')).toEqual({ ok: true, message: 'Ran. 3 messages filed.' });
    expect(t.fetch).toHaveBeenCalledWith('https://cmail-email-worker.internal/internal/graph-mirror/run', expect.objectContaining({ method: 'POST' }));

    const busy = setup(GRAPH_CONFIGURED, { status: 'busy' });
    await applyExchangeMirrorAdminAction(busy.env, manager, 'graph_enable');
    expect(await applyExchangeMirrorAdminAction(busy.env, manager, 'graph_run_now')).toMatchObject({ ok: true, message: expect.stringContaining('already in progress') });
  });
});
