import { describe, expect, it } from 'vitest';
import worker from '../index';

const configUrl = 'https://cmail-email-worker.internal/internal/m365-perms/config';
const collector = { idFromName: () => ({}), get: () => ({}) };

describe('Shared mailbox access wiring in the email Worker', () => {
  it('reports missing settings by name only, never values', async () => {
    const env = { M365_TENANT_ID: '00000000-0000-0000-0000-000000000000', M365_EXO_APP_ID: 'wrong-value', M365_EXO_CERT_PFX_B64: 'c2VjcmV0LXBmeA==' } as never;
    const response = await worker.fetch(new Request(configUrl), env);
    const text = await response.text();
    const body = JSON.parse(text) as { configured: boolean; problems: string[] };
    expect(body.configured).toBe(false);
    expect(body.problems.join(' ')).toContain('M365_EXO_APP_ID');
    expect(body.problems.join(' ')).toContain('M365_PERMS_COLLECTOR');
    expect(text).not.toContain('wrong-value');
    expect(text).not.toContain('c2VjcmV0LXBmeA==');
  });

  it('says configured, and whether groups can be expanded, without echoing the certificate', async () => {
    const env = {
      M365_TENANT_ID: '00000000-0000-0000-0000-000000000000',
      M365_EXO_APP_ID: '22222222-2222-2222-2222-222222222222',
      M365_EXO_ORGANIZATION: 'example.onmicrosoft.com',
      M365_EXO_CERT_PFX_B64: 'c2VjcmV0LXBmeA==',
      M365_PERMS_COLLECTOR: collector,
    } as never;
    const text = await (await worker.fetch(new Request(configUrl), env)).text();
    expect(JSON.parse(text)).toEqual({ configured: true, problems: [], groups: false });
    expect(text).not.toContain('c2VjcmV0LXBmeA==');
  });

  it('is not reachable on a public hostname or with POST', async () => {
    expect((await worker.fetch(new Request('https://mail.example.test/internal/m365-perms/config'), {} as never)).status).toBe(404);
    expect((await worker.fetch(new Request(configUrl, { method: 'POST' }), {} as never)).status).toBe(404);
  });
});
