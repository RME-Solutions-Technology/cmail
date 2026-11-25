import { describe, expect, it, vi } from 'vitest';
import { loadGraphMirrorSwitch } from '@stanchion/shared/graph-mirror';
import {
  D1_MAX_DATABASE_BYTES,
  GRAPH_IMPORT_SETTING_ESTIMATE,
  GRAPH_IMPORT_SETTING_JOB,
  GRAPH_IMPORT_SETTING_REQUEST,
} from '@stanchion/shared/graph-import';
import { createTestDatabase } from './mcp/testing/harness';
import {
  applyExchangeMirrorAdminAction,
  graphMirrorWorkerConfig,
  loadExchangeMirrorOverview,
  parseExchangeMirrorAdminAction,
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

type Setup = ReturnType<typeof setup>;

function request(t: Setup): Record<string, any> | null {
  const row = t.sqlite.prepare('SELECT value FROM org_settings WHERE key = ?').get(GRAPH_IMPORT_SETTING_REQUEST) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as Record<string, any> : null;
}

/** The Worker's finished dry run (the web app only reads it). */
function putEstimate(t: Setup, fields: Record<string, unknown>): void {
  const value = {
    id: 'est-1', requestSeq: 'r-1', period: 'all', sinceMs: 0, startedAt: NOW, finishedAt: NOW, status: 'done', mailboxesTotal: 3, mailboxesDone: 3, cursor: '',
    messages: 100, bytes: 1_000_000, errors: 0, assumedSize: false, d1UsedBytes: 1_000_000, perMailbox: [], ...fields,
  };
  t.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(GRAPH_IMPORT_SETTING_ESTIMATE, JSON.stringify(value));
}

describe('Exchange mirror admin: Graph source', () => {
  it('is off by default and knows its actions', async () => {
    const { d1, env } = setup();
    expect(await loadGraphMirrorSwitch(d1)).toEqual({ enabled: false });
    for (const action of ['graph_enable', 'graph_disable', 'graph_run_now', 'graph_import_estimate', 'graph_import_start', 'graph_import_stop']) expect(parseExchangeMirrorAdminAction(action)).toBe(action);
    const overview = await loadExchangeMirrorOverview(env, NOW);
    expect(overview.graph).toMatchObject({ enabled: false, installed: true, config: { state: 'configured', folders: ['inbox', 'sentitems', 'archive'] }, import: { estimate: null, figures: null, mailboxes: [], job: null, requestPending: null } });
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

  it('"Import older mail": a dry run is requested from the slider, only while on, and only one at a time', async () => {
    const t = setup();
    const manager = { id: 'manager-1' };
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_estimate', { stop: '3', now: NOW })).toMatchObject({ ok: false, status: 409 });
    await applyExchangeMirrorAdminAction(t.env, manager, 'graph_enable');
    for (const bad of ['8', '-1', '1.5', '', null, 'all']) {
      expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_estimate', { stop: bad, now: NOW })).toMatchObject({ ok: false, status: 400 });
    }
    expect(request(t)).toBeNull();
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_estimate', { stop: '7', now: NOW })).toMatchObject({ ok: true });
    expect(request(t)).toMatchObject({ kind: 'estimate', period: 'all', at: NOW });
    expect((await loadExchangeMirrorOverview(t.env, NOW)).graph.import.requestPending).toBe('estimate');
    // A second request while the first is waiting for the Worker.
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_estimate', { stop: '1', now: NOW })).toMatchObject({ ok: false, status: 409 });
    expect(t.audits().at(-1)).toEqual({ event_type: 'org.graph_mirror_import_estimate', detail: 'Import older mail: estimate requested, All mail' });
    // The Worker has handled it; the estimate shows with its figures and the largest mailboxes by address.
    t.sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-1', 'sales@example.test', 'shared', 'active')`).run();
    putEstimate(t, { requestSeq: request(t)?.seq, perMailbox: [['mbx-1', 40, 400_000]] });
    const overview = (await loadExchangeMirrorOverview(t.env, NOW)).graph.import;
    expect(overview.requestPending).toBeNull();
    expect(overview.estimate).toMatchObject({ id: 'est-1', messages: 100, bytes: 1_000_000 });
    expect(overview.figures).toMatchObject({ messages: 100, d1Level: 'ok', blocked: false, runs: 1 });
    expect(overview.mailboxes).toEqual([{ address: 'sales@example.test', messages: 40, bytes: 400_000 }]);
  });

  it('"Import older mail": Start needs a finished estimate, the same numbers, the tick box and room in the database', async () => {
    const t = setup();
    const manager = { id: 'manager-1' };
    await applyExchangeMirrorAdminAction(t.env, manager, 'graph_enable');
    const start = (input: Record<string, unknown>) => applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_start', { now: NOW, ...input });
    const good = { estimateId: 'est-1', messages: '100', bytes: '1000000', confirmed: 'yes' };
    expect(await start(good)).toMatchObject({ ok: false, status: 409 });
    putEstimate(t, { status: 'running' });
    expect(await start(good)).toMatchObject({ ok: false, status: 409 });
    putEstimate(t, {});
    expect(await start({ ...good, estimateId: 'est-0' })).toMatchObject({ ok: false, status: 409 });
    expect(await start({ ...good, confirmed: undefined })).toMatchObject({ ok: false, status: 400 });
    expect(await start({ ...good, messages: '99' })).toMatchObject({ ok: false, status: 409 });
    expect(await start({ ...good, bytes: 'many' })).toMatchObject({ ok: false, status: 409 });
    expect(request(t)).toBeNull();
    // A database that would pass its limit cannot start.
    putEstimate(t, { messages: 4_000_000, d1UsedBytes: D1_MAX_DATABASE_BYTES - 1_000 });
    expect(await start({ ...good, messages: '4000000' })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('size limit') });
    // "All" with an unknown database size cannot start; a shorter period can.
    putEstimate(t, { d1UsedBytes: -1 });
    expect(await start(good)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('could not be read') });
    putEstimate(t, { d1UsedBytes: -1, period: '3m' });
    expect(await start(good)).toMatchObject({ ok: true });
    putEstimate(t, {});
    expect(request(t)).toMatchObject({ kind: 'start', period: '3m', confirm: { messages: 100, bytes: 1_000_000 } });
    expect(t.audits().at(-1)?.event_type).toBe('org.graph_mirror_import_start');
    // One import at a time.
    t.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES (?, ?)`).run(GRAPH_IMPORT_SETTING_JOB, JSON.stringify({ id: 'j1', period: '3m', status: 'running' }));
    expect(await start(good)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already running') });
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_estimate', { stop: '1', now: NOW })).toMatchObject({ ok: false, status: 409 });
  });

  it('"Import older mail": a recount that changed by more than 20% can be confirmed again; one that started cannot', async () => {
    const t = setup();
    const manager = { id: 'manager-1' };
    await applyExchangeMirrorAdminAction(t.env, manager, 'graph_enable');
    const input = { estimateId: 'est-1', messages: '100', bytes: '1000000', confirmed: 'yes', now: NOW };
    putEstimate(t, { then: { messages: 50, bytes: 500_000 } });
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_start', input)).toMatchObject({ ok: false, status: 409 });
    putEstimate(t, { then: { messages: 50, bytes: 500_000 }, changed: true });
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_start', input)).toMatchObject({ ok: true });
    putEstimate(t, { then: { messages: 100, bytes: 1_000_000 }, jobId: 'j1' });
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_start', input)).toMatchObject({ ok: false, status: 409 });
  });

  it('"Import older mail": Stop is immediate, guarded, withdraws a waiting request and works with the source off', async () => {
    const t = setup();
    const manager = { id: 'manager-1' };
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_stop', { now: NOW })).toEqual({ ok: true, message: 'Nothing was running.' });
    await applyExchangeMirrorAdminAction(t.env, manager, 'graph_enable');
    t.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES (?, ?)`).run(GRAPH_IMPORT_SETTING_JOB, JSON.stringify({ id: 'j1', period: '1m', status: 'running', filed: 7 }));
    t.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES (?, ?)`).run(GRAPH_IMPORT_SETTING_REQUEST, JSON.stringify({ seq: 'r1', kind: 'estimate', period: '1m', at: NOW }));
    await applyExchangeMirrorAdminAction(t.env, manager, 'graph_disable');
    expect(await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_stop', { now: NOW })).toMatchObject({ ok: true, message: expect.stringContaining('Stopped') });
    expect(JSON.parse(String((t.sqlite.prepare('SELECT value FROM org_settings WHERE key = ?').get(GRAPH_IMPORT_SETTING_JOB) as { value: string }).value)))
      .toMatchObject({ status: 'stopped', filed: 7, finishedAt: NOW });
    expect(request(t)).toBeNull();
    // A finished record is left as it is.
    t.sqlite.prepare('UPDATE org_settings SET value = ? WHERE key = ?').run(JSON.stringify({ id: 'j1', period: '1m', status: 'done', finishedAt: 5 }), GRAPH_IMPORT_SETTING_JOB);
    await applyExchangeMirrorAdminAction(t.env, manager, 'graph_import_stop', { now: NOW });
    expect(JSON.parse(String((t.sqlite.prepare('SELECT value FROM org_settings WHERE key = ?').get(GRAPH_IMPORT_SETTING_JOB) as { value: string }).value)))
      .toMatchObject({ status: 'done', finishedAt: 5 });
    expect(t.audits().map((row) => row.event_type)).toContain('org.graph_mirror_import_stopped');
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
