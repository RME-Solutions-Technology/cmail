import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '#lib/server/mcp/testing/harness';
import { load } from './+page.server';

// The public first-sign-in help page: no sign-in needed, so its load reads
// nothing about the visitor. It only mirrors the passkey and Access settings.
const headers: Record<string, string> = {};
function run(env: Record<string, unknown> | undefined, user: unknown = null) {
  return (load as unknown as (event: unknown) => Promise<{ passkeys: boolean; viaAccess: boolean }>)({
    platform: env ? { env } : undefined,
    locals: { user },
    setHeaders: (value: Record<string, string>) => Object.assign(headers, value),
  });
}

describe('first sign-in help page loader', () => {
  it('works with no session and shows the passkey step only when passkey sign-in is on', async () => {
    const { d1, sqlite } = createTestDatabase();
    expect(await run({ DB: d1 })).toEqual({ passkeys: false, viaAccess: false });
    sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('passkey_signin_enabled', 'true')`).run();
    expect(await run({ DB: d1 })).toEqual({ passkeys: true, viaAccess: false });
  });

  it('mirrors the Cloudflare Access login page wording, and survives a missing database', async () => {
    const { d1 } = createTestDatabase();
    expect(await run({ DB: d1, ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'aud-tag-0000000000000000' }))
      .toEqual({ passkeys: false, viaAccess: true });
    expect(await run(undefined)).toEqual({ passkeys: false, viaAccess: false });
    expect(await run({})).toEqual({ passkeys: false, viaAccess: false });
  });

  it('caches for a minute: shared for an anonymous visitor, private for a signed-in one', async () => {
    const { d1 } = createTestDatabase();
    await run({ DB: d1 });
    expect(headers['cache-control']).toBe('public, max-age=60');
    await run({ DB: d1 }, { id: 'u1' });
    expect(headers['cache-control']).toBe('private, max-age=60');
  });

  it('is not behind sign-in (the hook protects only /mail, /admin and /api)', async () => {
    const hooks = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../../hooks.server.ts', import.meta.url), 'utf8'));
    expect(hooks).toContain("event.url.pathname.startsWith('/mail')");
    expect(hooks).not.toContain("startsWith('/help')");
  });
});
