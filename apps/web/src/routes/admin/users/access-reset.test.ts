import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@stanchion/shared/types';
import { createTestDatabase, type TestDatabase } from '#lib/server/mcp/testing/harness';
import { resolveAccessUser } from '#lib/server/access-bridge';
import { actions } from './+page.server';

let db: TestDatabase;

function count(sql: string, ...args: string[]): number {
  return Number((db.sqlite.prepare(sql).get(...args) as { n: number }).n);
}

function manager(): User {
  return db.sqlite.prepare(`SELECT * FROM users WHERE id = 'manager-1'`).get() as unknown as User;
}

async function resetAccess(userId: string, locals: { user: User | null } = { user: manager() }) {
  const body = new FormData();
  body.set('user_id', userId);
  const request = new Request('https://mail.example.test/admin/users?/resetAccess', { method: 'POST', body });
  return (actions.resetAccess as any)({
    request,
    locals: { ...locals, sessionId: null },
    platform: { env: { DB: db.d1 }, context: { waitUntil: vi.fn() }, caches: {} },
  });
}

beforeEach(() => {
  db = createTestDatabase();
  db.sqlite.exec(`
    INSERT INTO users (id, email, role, status, auth_provider) VALUES
      ('manager-1', 'manager@example.test', 'manager', 'active', 'microsoft'),
      ('u1', 'person@example.test', 'standard', 'active', '');
    INSERT INTO user_identities (provider, subject, user_id) VALUES
      ('microsoft', 'ms-manager', 'manager-1'), ('access', 'old-sub', 'u1');
    INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked) VALUES
      ('s1', 'u1', 'h1', datetime('now', '+1 day'), 0);
  `);
});

describe('admin resetAccess', () => {
  it('lets a re-added person with a new Access sub bind again', async () => {
    const identity = { subject: 'new-sub', email: 'person@example.test' };
    const options = { autoProvision: false, mailDomain: 'example.test' };
    expect(await resolveAccessUser(db.d1, identity, options)).toMatchObject({ ok: false, reason: 'identity_conflict' });

    const result = await resetAccess('u1');
    expect(result).toMatchObject({ success: expect.stringContaining('reset') });
    expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access' AND user_id = 'u1'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u1' AND revoked = 0`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.identity_reset' AND target = 'u1' AND actor_id = 'manager-1'`)).toBe(1);

    expect(await resolveAccessUser(db.d1, identity, options)).toMatchObject({ ok: true, how: 'bound_existing' });
  });

  it('keeps other identities and refuses accounts with no Access link', async () => {
    const result = await resetAccess('manager-1');
    expect(result.status).toBe(409);
    expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE user_id = 'manager-1'`)).toBe(1);
    db.sqlite.exec(`INSERT INTO users (id, email) VALUES ('u2', 'unlinked@example.test');
      INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked) VALUES ('s2', 'u2', 'h2', datetime('now', '+1 day'), 0);`);
    expect((await resetAccess('u2')).status).toBe(404);
    // No link: the person is not signed out and nothing is audited as a reset.
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u2' AND revoked = 0`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.identity_reset'`)).toBe(0);
  });

  it('is for managers only', async () => {
    const standard = db.sqlite.prepare(`SELECT * FROM users WHERE id = 'u1'`).get() as unknown as User;
    expect((await resetAccess('u1', { user: standard })).status).toBe(403);
    expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access' AND user_id = 'u1'`)).toBe(1);
  });
});
