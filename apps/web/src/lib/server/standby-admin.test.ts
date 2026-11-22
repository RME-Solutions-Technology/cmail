import { describe, expect, it, vi } from 'vitest';
import { loadStandbySwitch } from '@stanchion/shared/standby';
import { createTestDatabase } from './mcp/testing/harness';
import { applyStandbyAdminAction, loadStandbyOverview, parseStandbyAdminAction, standbyWorkerConfig } from './standby-admin';

const CONFIGURED = { configured: true, problems: [], canSend: true, standbyDomain: 'standby.example.test', probeAddress: 'cmail-standby-probe@standby.example.test', timeoutMinutes: 10 };

function setup(config: Record<string, unknown> | 'none' | 'down' = CONFIGURED, runAnswer: Record<string, unknown> = { status: 'started', runId: 'r1' }) {
  const { d1, sqlite } = createTestDatabase();
  sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('manager-1', 'manager@example.test', 'manager', 'active')`).run();
  const fetch = vi.fn(async (url: string) => {
    if (config === 'down') return new Response('nope', { status: 500 });
    return Response.json(url.endsWith('/internal/standby/run') ? runAnswer : config);
  });
  const env = { DB: d1, EMAIL_SERVICE: config === 'none' ? undefined : ({ fetch } as unknown as Fetcher) };
  const audits = () => sqlite.prepare('SELECT event_type, detail FROM audit_log ORDER BY rowid').all() as Array<{ event_type: string; detail: string }>;
  return { d1, sqlite, env, fetch, audits };
}

describe('standby admin', () => {
  it('is off by default and parses only known actions', async () => {
    const { d1 } = setup();
    expect(await loadStandbySwitch(d1)).toBe(false);
    expect(parseStandbyAdminAction('run_now')).toBe('run_now');
    expect(parseStandbyAdminAction('delete_everything')).toBeNull();
  });

  it('asks the Worker over the private binding and keeps only well-formed fields', async () => {
    expect(await standbyWorkerConfig(undefined)).toEqual({ state: 'unknown' });
    expect(await standbyWorkerConfig({ fetch: async () => { throw new Error('down'); } })).toEqual({ state: 'unknown' });
    expect(await standbyWorkerConfig({ fetch: async () => Response.json({ ...CONFIGURED, standbyDomain: '<script>' }) })).toEqual({ state: 'unknown' });
    expect(await standbyWorkerConfig({ fetch: async () => Response.json({ configured: false, problems: ['MAIL_DOMAIN is not set on the email Worker', 7], canSend: false }) }))
      .toEqual({ state: 'not_configured', canSend: false, problems: ['MAIL_DOMAIN is not set on the email Worker'] });
    const { env, fetch } = setup();
    const overview = await loadStandbyOverview(env);
    expect(fetch).toHaveBeenCalledWith('https://cmail-email-worker.internal/internal/standby/config', expect.objectContaining({ method: 'GET' }));
    expect(overview).toMatchObject({ enabled: false, installed: true, view: { light: 'off' }, runs: [] });
  });

  it('refuses to turn on while the Worker reports missing settings', async () => {
    const { env, d1 } = setup({ configured: false, problems: ['MAIL_DOMAIN is not set on the email Worker'], canSend: true });
    expect(await applyStandbyAdminAction(env, { id: 'manager-1' }, 'enable')).toMatchObject({ ok: false, status: 409 });
    expect(await loadStandbySwitch(d1)).toBe(false);
  });

  it('turns on and off, runs a test now, and audits each step', async () => {
    const { env, d1, fetch, audits } = setup();
    expect(await applyStandbyAdminAction(env, { id: 'manager-1' }, 'run_now')).toMatchObject({ ok: false, status: 409 });
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/run'), expect.anything());
    expect(await applyStandbyAdminAction(env, { id: 'manager-1' }, 'enable')).toMatchObject({ ok: true });
    expect(await loadStandbySwitch(d1)).toBe(true);
    expect(await applyStandbyAdminAction(env, { id: 'manager-1' }, 'run_now')).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledWith('https://cmail-email-worker.internal/internal/standby/run', expect.objectContaining({ method: 'POST' }));
    expect(await applyStandbyAdminAction(env, { id: 'manager-1' }, 'disable')).toMatchObject({ ok: true });
    expect(await loadStandbySwitch(d1)).toBe(false);
    expect(audits().map((row) => row.event_type)).toEqual(['org.standby_toggled', 'org.standby_test_requested', 'org.standby_toggled']);
  });

  it('passes on the Worker answer for a busy or refused test', async () => {
    const busy = setup(CONFIGURED, { status: 'busy' });
    busy.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('standby_enabled', 'true')`).run();
    expect(await applyStandbyAdminAction(busy.env, { id: 'manager-1' }, 'run_now')).toMatchObject({ ok: false, status: 409 });
    const failed = setup(CONFIGURED, { status: 'failed', reason: 'send_rejected' });
    failed.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('standby_enabled', 'true')`).run();
    expect(await applyStandbyAdminAction(failed.env, { id: 'manager-1' }, 'run_now')).toMatchObject({ ok: false, status: 502 });
    expect(failed.audits().at(-1)?.detail).toContain('send_rejected');
  });

  it('audits Run test now when the email Worker does not answer', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('standby_enabled', 'true')`).run();
    t.fetch.mockImplementation(async () => { throw new Error('timeout'); });
    expect(await applyStandbyAdminAction(t.env, { id: 'manager-1' }, 'run_now')).toMatchObject({ ok: false, status: 503 });
    expect(t.audits().at(-1)).toMatchObject({ event_type: 'org.standby_test_requested', detail: expect.stringContaining('no answer') });
  });

  it('shows the latest result as the traffic light', async () => {
    const { env, sqlite } = setup();
    sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('standby_enabled', 'true')`).run();
    const now = Date.parse('2026-11-15T12:00:00Z');
    sqlite.prepare(`INSERT INTO standby_probe_runs (id, token_hash, kind, status, in_flight, reason, detail, started_at)
      VALUES ('r1', ?, 'schedule', 'fail', NULL, 'timeout', 'No arrival within 10 minutes', ?)`).run('a'.repeat(64), now - 60 * 60 * 1000);
    const overview = await loadStandbyOverview(env, now);
    expect(overview.view).toMatchObject({ light: 'red', reason: 'timeout' });
    expect(overview.runs).toHaveLength(1);
  });
});
