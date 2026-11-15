import { describe, expect, it, vi } from 'vitest';
import worker from '../index';
import { M365_SYNC_CRON } from './sync';
import { CLIENT_ID, DOMAIN, TENANT_ID } from './testing/fake-graph';

const configUrl = 'https://cmail-email-worker.internal/internal/m365-sync/config';

describe('Microsoft 365 sync wiring in the email Worker', () => {
  it('reports configuration by setting name only, never values', async () => {
    const env = { M365_TENANT_ID: TENANT_ID, M365_CLIENT_ID: 'wrong-value', MAIL_DOMAIN: DOMAIN } as never;
    const response = await worker.fetch(new Request(configUrl), env);
    const body = await response.json() as { configured: boolean; problems: string[] };
    expect(body.configured).toBe(false);
    expect(body.problems.join(' ')).toContain('M365_CLIENT_ID');
    expect(JSON.stringify(body)).not.toContain('wrong-value');
    expect(JSON.stringify(body)).not.toContain(TENANT_ID);
  });

  it('says configured without echoing the secret', async () => {
    const env = { M365_TENANT_ID: TENANT_ID, M365_CLIENT_ID: CLIENT_ID, M365_CLIENT_SECRET: 'test-secret-value', MAIL_DOMAIN: DOMAIN } as never;
    const body = await (await worker.fetch(new Request(configUrl), env)).text();
    expect(JSON.parse(body)).toEqual({ configured: true, problems: [] });
    expect(body).not.toContain('test-secret-value');
  });

  it('is not reachable on a public hostname or with POST', async () => {
    expect((await worker.fetch(new Request('https://mail.example.test/internal/m365-sync/config'), {} as never)).status).toBe(404);
    expect((await worker.fetch(new Request(configUrl, { method: 'POST' }), {} as never)).status).toBe(404);
  });

  it('runs the sync (and the shared mailbox access sync and standby copy-back) on its own cron and nothing else there', async () => {
    const all = vi.fn(async () => ({ results: [] }));
    const first = vi.fn(async () => null);
    const db = { prepare: vi.fn(() => ({ bind: () => ({ all, first }) })) };
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({ cron: M365_SYNC_CRON } as ScheduledController, { DB: db } as never, { waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as never);
    await Promise.all(waits);
    // Only the three switches were read: all are off by default.
    expect(db.prepare).toHaveBeenCalledTimes(3);
    for (const call of db.prepare.mock.calls) expect(String((call as unknown[])[0])).toContain('org_settings');
  });
});
