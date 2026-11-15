import { describe, expect, it, vi } from 'vitest';
import { loadAliasSyncSwitch, loadExchangeMirrorSwitch } from '@cmail/shared/exchange-mirror';
import { createTestDatabase } from './mcp/testing/harness';
import {
  applyExchangeMirrorAdminAction,
  exchangeMirrorWorkerConfig,
  loadExchangeMirrorOverview,
  parseExchangeMirrorAdminAction,
} from './exchange-mirror-admin';

const CONFIGURED = {
  configured: true,
  maskedAddress: 'journal-0123…@standby.example.test',
  senderDomains: ['example.test'],
  requireAuth: true,
  mirrorSent: true,
  tenantCheck: true,
};
const NOW = Date.parse('2026-11-16T05:00:00Z');

function setup(config: Record<string, unknown> | 'none' | 'down' = CONFIGURED) {
  const { d1, sqlite } = createTestDatabase();
  sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('manager-1', 'manager@example.test', 'manager', 'active')`).run();
  const fetch = vi.fn(async () => (config === 'down' ? new Response('nope', { status: 500 }) : Response.json(config)));
  const env = { DB: d1, EMAIL_SERVICE: config === 'none' ? undefined : ({ fetch } as unknown as Fetcher) };
  const audits = () => sqlite.prepare(`SELECT event_type, detail FROM audit_log ORDER BY rowid`).all() as Array<{ event_type: string; detail: string }>;
  return { d1, sqlite, env, fetch, audits };
}

describe('Exchange mirror admin', () => {
  it('is off by default and parses only known actions', async () => {
    const { d1 } = setup();
    expect(await loadExchangeMirrorSwitch(d1)).toBe(false);
    expect(await loadAliasSyncSwitch(d1)).toBe(false);
    expect(parseExchangeMirrorAdminAction('alias_enable')).toBe('alias_enable');
    expect(parseExchangeMirrorAdminAction('purge')).toBeNull();
  });

  it('keeps only well-formed Worker fields and never a full journal address', async () => {
    expect(await exchangeMirrorWorkerConfig(undefined)).toEqual({ state: 'unknown' });
    expect(await exchangeMirrorWorkerConfig({ fetch: async () => { throw new Error('down'); } })).toEqual({ state: 'unknown' });
    expect(await exchangeMirrorWorkerConfig({ fetch: async () => Response.json({ ...CONFIGURED, maskedAddress: 'journal-0123456789abcdef0123456789abcdef@standby.example.test' }) }))
      .toEqual({ state: 'unknown' });
    expect(await exchangeMirrorWorkerConfig({ fetch: async () => Response.json({ configured: false, problems: ['M365_JOURNAL_ADDRESS is not set on the email Worker', 7] }) }))
      .toEqual({ state: 'not_configured', problems: ['M365_JOURNAL_ADDRESS is not set on the email Worker'] });
    expect(await exchangeMirrorWorkerConfig({ fetch: async () => Response.json(CONFIGURED) }))
      .toEqual({ state: 'configured', maskedAddress: CONFIGURED.maskedAddress, senderDomains: ['example.test'], requireAuth: true, mirrorSent: true, tenantCheck: true });
  });

  it('shows today\'s counts and the last report time', async () => {
    const { env, sqlite, fetch } = setup();
    sqlite.prepare(`INSERT INTO exchange_mirror_days (day, received, filed, sent_filed, duplicates, unmatched, skipped, rejected, last_report_at, last_problem, last_problem_at)
      VALUES ('2026-11-16', 9, 20, 3, 2, 5, 1, 1, ?, 'auth_failed', ?), ('2026-11-01', 1, 1, 0, 0, 0, 0, 0, 1, '', NULL)`).run(NOW - 60_000, NOW - 120_000);
    const overview = await loadExchangeMirrorOverview(env, NOW);
    expect(fetch).toHaveBeenCalledWith('https://cmail-email-worker.internal/internal/exchange-mirror/config', expect.objectContaining({ method: 'GET' }));
    expect(overview).toMatchObject({ enabled: false, aliasEnabled: false, installed: true, lastReportAt: NOW - 60_000, aliasCount: 0 });
    expect(overview.days).toEqual([expect.objectContaining({ day: '2026-11-16', received: 9, filed: 20, sentFiled: 3, lastProblem: 'auth_failed' })]);
  });

  it('refuses to turn the mirror on while the Worker reports missing settings', async () => {
    const { env, d1 } = setup({ configured: false, problems: ['M365_JOURNAL_ADDRESS is not set on the email Worker'] });
    expect(await applyExchangeMirrorAdminAction(env, { id: 'manager-1' }, 'enable')).toMatchObject({ ok: false, status: 409 });
    expect(await loadExchangeMirrorSwitch(d1)).toBe(false);
  });

  it('turns each switch on and off and audits it', async () => {
    const { env, d1, audits } = setup();
    expect(await applyExchangeMirrorAdminAction(env, { id: 'manager-1' }, 'enable')).toMatchObject({ ok: true });
    expect(await loadExchangeMirrorSwitch(d1)).toBe(true);
    expect(await applyExchangeMirrorAdminAction(env, { id: 'manager-1' }, 'alias_enable')).toMatchObject({ ok: true });
    expect(await loadAliasSyncSwitch(d1)).toBe(true);
    expect(await applyExchangeMirrorAdminAction(env, { id: 'manager-1' }, 'alias_disable')).toMatchObject({ ok: true });
    expect(await applyExchangeMirrorAdminAction(env, { id: 'manager-1' }, 'disable')).toMatchObject({ ok: true });
    expect(await loadExchangeMirrorSwitch(d1)).toBe(false);
    expect(await loadAliasSyncSwitch(d1)).toBe(false);
    expect(audits().map((row) => row.event_type)).toEqual([
      'org.exchange_mirror_toggled', 'org.m365_alias_sync_toggled', 'org.m365_alias_sync_toggled', 'org.exchange_mirror_toggled',
    ]);
  });

  it('approves held alias removals once, audited, and says whether aliases are in use', async () => {
    const { env, sqlite, audits } = setup();
    expect(await applyExchangeMirrorAdminAction(env, { id: 'manager-1' }, 'alias_approve_removals')).toMatchObject({ ok: true });
    expect(sqlite.prepare(`SELECT value FROM org_settings WHERE key = 'm365_alias_sync_approve_removals'`).get()).toEqual({ value: 'true' });
    expect(audits().map((row) => row.event_type)).toEqual(['org.m365_alias_removals_approved']);
    await applyExchangeMirrorAdminAction(env, { id: 'manager-1' }, 'alias_enable');
    expect((await loadExchangeMirrorOverview(env, NOW)).aliasesFresh).toBe(false);
    sqlite.prepare(`INSERT INTO m365_alias_sync_state (id, last_ok_at, last_run_at) VALUES (1, ?, ?)`).run(NOW - 60_000, NOW - 60_000);
    expect((await loadExchangeMirrorOverview(env, NOW)).aliasesFresh).toBe(true);
    expect((await loadExchangeMirrorOverview(env, NOW + 4 * 24 * 60 * 60 * 1000)).aliasesFresh).toBe(false);
  });

  it('refuses to turn anything on before migration 0027', async () => {
    const { env, sqlite } = setup();
    sqlite.exec('DROP TABLE exchange_mirror_days');
    expect(await applyExchangeMirrorAdminAction(env, { id: 'manager-1' }, 'enable')).toMatchObject({ ok: false, status: 409 });
    expect(await applyExchangeMirrorAdminAction(env, { id: 'manager-1' }, 'alias_enable')).toMatchObject({ ok: false, status: 409 });
  });
});
