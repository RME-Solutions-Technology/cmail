import { describe, expect, it, vi } from 'vitest';
import { createTestDatabase } from '#lib/server/mcp/testing/harness';
import { actions } from './+page.server';

function post(action: string, user: { id: string; role: string } | null) {
  const { d1, sqlite } = createTestDatabase();
  const fetch = vi.fn(async () => Response.json({ status: 'started' }));
  const body = new FormData();
  body.set('action', action);
  const request = new Request('https://mail.example.test/admin/exchange-mirror', { method: 'POST', body });
  const result = (actions.default as any)({
    request,
    locals: { user, sessionId: null },
    platform: { env: { DB: d1, EMAIL_SERVICE: { fetch } }, context: { waitUntil: vi.fn() }, caches: {} },
  });
  return { result, sqlite, fetch };
}

describe('Admin > Exchange mirror route', () => {
  it('refuses a standard user (403) and changes nothing', async () => {
    for (const action of ['enable', 'alias_enable']) {
      const { result, sqlite, fetch } = post(action, { id: 'u1', role: 'standard' });
      expect(await result).toMatchObject({ status: 403 });
      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM org_settings WHERE key IN ('exchange_mirror_enabled', 'm365_alias_sync_enabled')`).get()).toEqual({ n: 0 });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('refuses a signed-out request (401) and an unknown action (400)', async () => {
    expect(await post('enable', null).result).toMatchObject({ status: 401 });
    expect(await post('drop_tables', { id: 'm1', role: 'manager' }).result).toMatchObject({ status: 400 });
  });
});
