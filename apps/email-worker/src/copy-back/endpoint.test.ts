import { describe, expect, it } from 'vitest';
import worker from '../index';

const configUrl = 'https://cmail-email-worker.internal/internal/copy-back/config';
const TENANT_ID = '00000000-0000-0000-0000-000000000000';
const CLIENT_ID = '00000000-0000-0000-0000-0000000000c1';

describe('standby copy-back wiring in the email Worker', () => {
  it('reports configuration by setting name only, never values', async () => {
    const env = { M365_TENANT_ID: TENANT_ID, M365_COPYBACK_CLIENT_ID: 'wrong-value' } as never;
    const body = await (await worker.fetch(new Request(configUrl), env)).json() as { configured: boolean; problems: string[] };
    expect(body.configured).toBe(false);
    expect(body.problems.join(' ')).toContain('M365_COPYBACK_CLIENT_ID');
    expect(body.problems.join(' ')).toContain('M365_COPYBACK_CLIENT_SECRET');
    expect(JSON.stringify(body)).not.toContain('wrong-value');
    expect(JSON.stringify(body)).not.toContain(TENANT_ID);
  });

  it('says configured without echoing the secret', async () => {
    const env = { M365_TENANT_ID: TENANT_ID, M365_COPYBACK_CLIENT_ID: CLIENT_ID, M365_COPYBACK_CLIENT_SECRET: 'test-secret-value' } as never;
    const text = await (await worker.fetch(new Request(configUrl), env)).text();
    expect(JSON.parse(text)).toEqual({ configured: true, problems: [] });
    expect(text).not.toContain('test-secret-value');
  });

  it('is not reachable on a public hostname or with POST', async () => {
    expect((await worker.fetch(new Request('https://mail.example.test/internal/copy-back/config'), {} as never)).status).toBe(404);
    expect((await worker.fetch(new Request(configUrl, { method: 'POST' }), {} as never)).status).toBe(404);
  });
});
