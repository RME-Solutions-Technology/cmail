import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@cmail/shared/types';
import { createTestDatabase, type TestDatabase } from './mcp/testing/harness';
import {
  accessSignInPathAllowed,
  confirmSessionAccessBinding,
  establishAccessSession,
  resolveAccessUser,
} from './access-bridge';
import { buildSessionCookie, createSessionToken } from './session';
import { findEnrollment, issueEnrollmentToken } from './identity';
import { handle } from '../../hooks.server';

const SUB_A = 'access-sub-a';
const SUB_B = 'access-sub-b';
const MAIL_DOMAIN = 'example.test';
const SESSION_SECRET = 'test-only-session-secret-0123456789abcdef';

let db: TestDatabase;

function seed(sql: string): void {
  db.sqlite.exec(sql);
}

function seedManager(): void {
  seed(`INSERT INTO users (id, email, role, status, auth_provider) VALUES
    ('manager-1', 'manager@example.test', 'manager', 'active', 'microsoft');
    INSERT INTO user_identities (provider, subject, user_id) VALUES ('microsoft', 'ms-manager', 'manager-1');`);
}

function count(sql: string, ...args: (string | number)[]): number {
  return Number((db.sqlite.prepare(sql).get(...args) as { n: number }).n);
}

function userRow(id: string): User {
  return db.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User;
}

const resolve = (subject: string, email: string, autoProvision = false) =>
  resolveAccessUser(db.d1, { subject, email }, { autoProvision, mailDomain: MAIL_DOMAIN });

beforeEach(() => {
  db = createTestDatabase();
});

describe('migration 0021 identity constraints', () => {
  beforeEach(() => {
    seed(`INSERT INTO users (id, email) VALUES ('u1', 'one@example.test'), ('u2', 'two@example.test');`);
  });

  it('allows one Access identity beside an existing sign-in identity', () => {
    seed(`INSERT INTO user_identities (provider, subject, user_id) VALUES
      ('microsoft', 'ms-1', 'u1'), ('access', 'acc-1', 'u1');`);
    expect(count('SELECT COUNT(*) AS n FROM user_identities WHERE user_id = ?', 'u1')).toBe(2);
  });

  it('refuses a second Access sub for one account and one sub for two accounts', () => {
    seed(`INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', 'acc-1', 'u1');`);
    expect(() => seed(`INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', 'acc-2', 'u1');`)).toThrow();
    expect(() => seed(`INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', 'acc-1', 'u2');`)).toThrow();
  });

  it('keeps one non-Access sign-in identity per account', () => {
    seed(`INSERT INTO user_identities (provider, subject, user_id) VALUES ('google', 'g-1', 'u1');`);
    expect(() => seed(`INSERT INTO user_identities (provider, subject, user_id) VALUES ('microsoft', 'ms-1', 'u1');`)).toThrow();
  });

  it('still rejects unknown providers', () => {
    expect(() => seed(`INSERT INTO user_identities (provider, subject, user_id) VALUES ('saml', 's-1', 'u1');`)).toThrow();
  });
});

describe('resolveAccessUser', () => {
  it('does nothing before the first manager exists', async () => {
    seed(`INSERT INTO users (id, email) VALUES ('u1', 'person@example.test');`);
    expect(await resolve(SUB_A, 'person@example.test', true)).toEqual({ ok: false, reason: 'not_set_up' });
    expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access'`)).toBe(0);
  });

  describe('with a manager', () => {
    beforeEach(seedManager);

    it('finds a returning user by sub, never by email', async () => {
      seed(`INSERT INTO users (id, email, status) VALUES
          ('bound', 'old@example.test', 'active'),
          ('same-email', 'new@example.test', 'active');
        INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', '${SUB_A}', 'bound');`);
      const result = await resolve(SUB_A, 'new@example.test');
      expect(result.ok && result.user.id).toBe('bound');
      expect(result.ok && result.emailChanged).toBe(true);
      expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE user_id = 'same-email'`)).toBe(0);
    });

    it('refuses a returning user who is paused or offboarded', async () => {
      seed(`INSERT INTO users (id, email, status) VALUES ('p', 'p@example.test', 'paused'), ('o', 'o@example.test', 'offboarded');
        INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', 'sub-p', 'p'), ('access', 'sub-o', 'o');`);
      expect(await resolve('sub-p', 'p@example.test')).toMatchObject({ ok: false, reason: 'account_suspended' });
      expect(await resolve('sub-o', 'o@example.test')).toMatchObject({ ok: false, reason: 'account_suspended' });
    });

    it('binds a pending invited account by verified email and activates it', async () => {
      seed(`INSERT INTO users (id, email, status) VALUES ('invitee', 'invitee@example.test', 'pending');`);
      const result = await resolve(SUB_A, 'invitee@example.test');
      expect(result).toMatchObject({ ok: true, how: 'bound_existing' });
      expect(userRow('invitee').status).toBe('active');
      expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access' AND subject = ? AND user_id = 'invitee'`, SUB_A)).toBe(1);
      expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.identity_bound' AND target = 'invitee'`)).toBe(1);
    });

    it('adopts an active account that has no sign-in identity yet (for example a synced account)', async () => {
      seed(`INSERT INTO users (id, email, status) VALUES ('synced', 'synced@example.test', 'active');`);
      expect(await resolve(SUB_A, 'synced@example.test')).toMatchObject({ ok: true, how: 'bound_existing' });
      expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access' AND user_id = 'synced'`)).toBe(1);
    });

    it('never adopts by email an account that already signs in with Microsoft or email', async () => {
      seed(`INSERT INTO users (id, email, status, auth_provider) VALUES
          ('ms-user', 'staff@example.test', 'active', 'microsoft'),
          ('otp-user', 'otp@example.test', 'active', '');
        INSERT INTO user_identities (provider, subject, user_id) VALUES
          ('microsoft', 'ms-sub', 'ms-user'), ('email', 'otp@example.test', 'otp-user');`);
      expect(await resolve(SUB_A, 'staff@example.test')).toMatchObject({ ok: false, reason: 'link_required' });
      expect(await resolve(SUB_B, 'otp@example.test')).toMatchObject({ ok: false, reason: 'link_required' });
      expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access'`)).toBe(0);
    });

    it('links an account with a Microsoft identity once its owner visits while signed in', async () => {
      seed(`INSERT INTO users (id, email, status, auth_provider) VALUES ('ms-user', 'staff@example.test', 'active', 'microsoft');
        INSERT INTO user_identities (provider, subject, user_id) VALUES ('microsoft', 'ms-sub', 'ms-user');`);
      expect(await confirmSessionAccessBinding(db.d1, userRow('ms-user'), { subject: SUB_A, email: 'staff@example.test' }, '')).toBe(true);
      expect(await resolve(SUB_A, 'staff@example.test')).toMatchObject({ ok: true, how: 'returning' });
    });

    it('runs the country gate before binding, activating or creating anything', async () => {
      seed(`INSERT INTO users (id, email, status) VALUES ('invitee', 'invitee@example.test', 'pending');`);
      const deny = vi.fn(async () => false);
      const options = { autoProvision: true, mailDomain: MAIL_DOMAIN, countryGate: deny };
      expect(await resolveAccessUser(db.d1, { subject: SUB_A, email: 'invitee@example.test' }, options))
        .toMatchObject({ ok: false, reason: 'country_pending' });
      expect(userRow('invitee').status).toBe('pending');
      expect(await resolveAccessUser(db.d1, { subject: SUB_B, email: 'brand.new@example.test' }, options))
        .toMatchObject({ ok: false, reason: 'country_pending' });
      expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access'`)).toBe(0);
      expect(count(`SELECT COUNT(*) AS n FROM users WHERE email = 'brand.new@example.test'`)).toBe(0);
      expect(deny).toHaveBeenCalledTimes(2);
    });

    it('never binds a paused or offboarded account', async () => {
      seed(`INSERT INTO users (id, email, status) VALUES ('p', 'p@example.test', 'paused'), ('o', 'o@example.test', 'offboarded');`);
      expect(await resolve(SUB_A, 'p@example.test')).toMatchObject({ ok: false, reason: 'account_suspended' });
      expect(await resolve(SUB_B, 'o@example.test')).toMatchObject({ ok: false, reason: 'account_suspended' });
      expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access'`)).toBe(0);
    });

    it('never binds an account already bound to a different Access sub', async () => {
      seed(`INSERT INTO users (id, email, status) VALUES ('taken', 'taken@example.test', 'active');
        INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', '${SUB_A}', 'taken');`);
      expect(await resolve(SUB_B, 'taken@example.test')).toMatchObject({ ok: false, reason: 'identity_conflict' });
      expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE subject = ?`, SUB_B)).toBe(0);
    });

    it('never binds a manager by email alone', async () => {
      expect(await resolve(SUB_A, 'manager@example.test', true)).toMatchObject({ ok: false, reason: 'link_required' });
      expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access'`)).toBe(0);
    });

    it('requires an existing account when auto-provisioning is off', async () => {
      expect(await resolve(SUB_A, 'new@example.test', false)).toEqual({ ok: false, reason: 'enrollment_required' });
      expect(count(`SELECT COUNT(*) AS n FROM users`)).toBe(1);
    });

    it('auto-provisions a standard account and personal mailbox on MAIL_DOMAIN', async () => {
      const result = await resolve(SUB_A, 'new.person@example.test', true);
      expect(result).toMatchObject({ ok: true, how: 'provisioned' });
      if (!result.ok) throw new Error('expected success');
      expect(result.user).toMatchObject({ email: 'new.person@example.test', role: 'standard', status: 'active', auth_provider: '' });
      expect(count(`SELECT COUNT(*) AS n FROM mailboxes WHERE address = 'new.person@example.test' AND type = 'personal' AND owner_user_id = ?`, result.user.id)).toBe(1);
      expect(count(`SELECT COUNT(*) AS n FROM mailbox_assignments WHERE user_id = ? AND permissions = 'full'`, result.user.id)).toBe(1);
      expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access' AND subject = ? AND user_id = ?`, SUB_A, result.user.id)).toBe(1);
    });

    it('never auto-provisions an email off MAIL_DOMAIN', async () => {
      expect(await resolve(SUB_A, 'person@elsewhere.example', true)).toEqual({ ok: false, reason: 'enrollment_required' });
      expect(await resolve(SUB_A, 'person@sub.example.test', true)).toEqual({ ok: false, reason: 'enrollment_required' });
      expect(count(`SELECT COUNT(*) AS n FROM users`)).toBe(1);
    });

    it('never takes over an existing mailbox address, and leaves nothing half-made', async () => {
      seed(`INSERT INTO mailboxes (id, address, type, display_name, status) VALUES ('desk', 'desk@example.test', 'shared', 'Desk', 'active');`);
      expect(await resolve(SUB_A, 'desk@example.test', true)).toEqual({ ok: false, reason: 'enrollment_required' });
      expect(count(`SELECT COUNT(*) AS n FROM users`)).toBe(1);
      expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access'`)).toBe(0);
    });

    it('returns the same account on the second visit', async () => {
      const first = await resolve(SUB_A, 'new@example.test', true);
      const second = await resolve(SUB_A, 'new@example.test', true);
      expect(first.ok && second.ok && first.user.id === second.user.id).toBe(true);
      expect(second).toMatchObject({ how: 'returning' });
      expect(count(`SELECT COUNT(*) AS n FROM users WHERE email = 'new@example.test'`)).toBe(1);
    });
  });
});

describe('confirmSessionAccessBinding', () => {
  beforeEach(seedManager);

  it('accepts the bound sub and refuses a different one', async () => {
    seed(`INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', '${SUB_A}', 'manager-1');`);
    const manager = userRow('manager-1');
    expect(await confirmSessionAccessBinding(db.d1, manager, { subject: SUB_A, email: 'manager@example.test' }, '')).toBe(true);
    expect(await confirmSessionAccessBinding(db.d1, manager, { subject: SUB_B, email: 'manager@example.test' }, '')).toBe(false);
  });

  it('links a signed-in manager whose email matches the token', async () => {
    const manager = userRow('manager-1');
    expect(await confirmSessionAccessBinding(db.d1, manager, { subject: SUB_A, email: 'manager@example.test' }, '')).toBe(true);
    expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access' AND subject = ? AND user_id = 'manager-1'`, SUB_A)).toBe(1);
  });

  it('refuses to link when the token email is someone else', async () => {
    const manager = userRow('manager-1');
    expect(await confirmSessionAccessBinding(db.d1, manager, { subject: SUB_A, email: 'other@example.test' }, '')).toBe(false);
    expect(count(`SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'access'`)).toBe(0);
  });

  it('refuses to link when the sub already belongs to another account', async () => {
    seed(`INSERT INTO users (id, email, status) VALUES ('other', 'other@example.test', 'active');
      INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', '${SUB_A}', 'other');`);
    const manager = userRow('manager-1');
    expect(await confirmSessionAccessBinding(db.d1, manager, { subject: SUB_A, email: 'manager@example.test' }, '')).toBe(false);
  });
});

describe('establishAccessSession', () => {
  beforeEach(seedManager);

  it('opens a session and audits the sign-in', async () => {
    seed(`INSERT INTO users (id, email, status) VALUES ('u1', 'person@example.test', 'active');
      INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', '${SUB_A}', 'u1');`);
    const result = await establishAccessSession(
      { DB: db.d1, SESSION_SECRET, MAIL_DOMAIN },
      { subject: SUB_A, email: 'person@example.test' },
      new Request('https://mail.example.test/mail', { headers: { 'cf-connecting-ip': '192.0.2.10' } }),
      { autoProvision: false, secureCookie: true },
    );
    expect(result?.user.id).toBe('u1');
    expect(result?.cookie).toMatch(/^cmail_session=.+; Secure$/);
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u1' AND revoked = 0`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.sign_in' AND detail = 'Signed in via access'`)).toBe(1);
  });

  it('audits an email change but keeps the binding', async () => {
    seed(`INSERT INTO users (id, email, status) VALUES ('u1', 'old@example.test', 'active');
      INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', '${SUB_A}', 'u1');`);
    const result = await establishAccessSession(
      { DB: db.d1, SESSION_SECRET, MAIL_DOMAIN },
      { subject: SUB_A, email: 'renamed@example.test' },
      new Request('https://mail.example.test/mail'),
      { autoProvision: false, secureCookie: true },
    );
    expect(result?.user.id).toBe('u1');
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.access_email_changed' AND target = 'u1'`)).toBe(1);
  });

  it('returns null and audits a denial for an unknown person', async () => {
    const result = await establishAccessSession(
      { DB: db.d1, SESSION_SECRET, MAIL_DOMAIN },
      { subject: SUB_A, email: 'stranger@example.test' },
      new Request('https://mail.example.test/mail'),
      { autoProvision: false, secureCookie: true },
    );
    expect(result).toBeNull();
    expect(count(`SELECT COUNT(*) AS n FROM sessions`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.sign_in_denied'`)).toBe(1);
  });

  const establish = (subject: string, email: string) => establishAccessSession(
    { DB: db.d1, SESSION_SECRET, MAIL_DOMAIN },
    { subject, email },
    new Request('https://mail.example.test/mail'),
    { autoProvision: false, secureCookie: true },
  );

  it('audits a repeated denial for the same person once per window', async () => {
    for (let index = 0; index < 5; index += 1) await establish(SUB_A, 'stranger@example.test');
    await establish(SUB_B, 'other.stranger@example.test');
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.sign_in_denied'`)).toBe(2);
    // The throttle key is hashed: no sub or email is stored in rate_limits.
    expect(count(`SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE ? OR key LIKE ?`, `%${SUB_A}%`, '%stranger%')).toBe(0);
  });

  it('mints a session per sign-in and keeps other device sessions within the normal cap', async () => {
    seed(`INSERT INTO users (id, email, status) VALUES ('u1', 'person@example.test', 'active');
      INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', '${SUB_A}', 'u1');
      INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked) VALUES
        ('s1', 'u1', 'h1', datetime('now', '+1 day'), 0), ('s2', 'u1', 'h2', datetime('now', '+2 days'), 0);`);
    const result = await establish(SUB_A, 'person@example.test');
    expect(result?.cookie).toMatch(/^cmail_session=/);
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u1' AND revoked = 0`)).toBe(3);
  });
  it('audits an email change once per window, not on every visit', async () => {
    seed(`INSERT INTO users (id, email, status) VALUES ('u1', 'old@example.test', 'active');
      INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', '${SUB_A}', 'u1');`);
    for (let index = 0; index < 4; index += 1) await establish(SUB_A, 'renamed@example.test');
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.access_email_changed'`)).toBe(1);
  });
});

describe('findEnrollment with two identity rows', () => {
  it('reports the sign-in identity, not the Access one, every time', async () => {
    seedManager();
    seed(`INSERT INTO users (id, email, status) VALUES ('u1', 'person@example.test', 'active');
      INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', '${SUB_A}', 'u1'), ('microsoft', 'ms-1', 'u1');`);
    const { token } = await issueEnrollmentToken(db.d1, 'u1', 'manager-1');
    for (let index = 0; index < 3; index += 1) {
      expect((await findEnrollment(db.d1, token))?.bound_provider).toBe('microsoft');
    }
  });
});

describe('accessSignInPathAllowed', () => {
  it('opens sessions only on ordinary GET pages', () => {
    expect(accessSignInPathAllowed('GET', '/mail')).toBe(true);
    expect(accessSignInPathAllowed('GET', '/oauth/authorize')).toBe(true);
    expect(accessSignInPathAllowed('POST', '/mail')).toBe(false);
    for (const path of ['/bootstrap', '/enroll/abc', '/auth/callback/google', '/mcp', '/oauth/token', '/.well-known/oauth-authorization-server']) {
      expect(accessSignInPathAllowed('GET', path)).toBe(false);
    }
  });
});

// ─── hooks.server.ts integration ────────────────────────────────────────

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ACCESS_ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function accessToken(subject: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const input = `${base64Url(JSON.stringify({ alg: 'RS256', kid: 'hooks-kid' }))}.${base64Url(JSON.stringify({
    aud: [AUD], email, exp: now + 600, iat: now, nbf: now, iss: `https://${TEAM}`, type: 'app', sub: subject,
  }))}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
  return `${input}.${base64Url(signature)}`;
}

async function sessionCookieFor(userId: string): Promise<string> {
  const session = await createSessionToken(userId, SESSION_SECRET, 60 * 60 * 1000);
  db.sqlite.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked) VALUES (?, ?, ?, datetime('now', '+1 hour'), 0)`,
  ).run(session.sessionId, userId, session.hash);
  return buildSessionCookie(session.token, true).split(';', 1)[0];
}

async function invokeHooks(env: Record<string, unknown>, headers: Record<string, string>, path = '/mail', method = 'GET') {
  const url = new URL(path, 'https://mail.example.test');
  const event = {
    url,
    request: new Request(url, method === 'GET' ? { headers } : { method, headers: { ...headers, origin: url.origin, 'content-type': 'application/json' }, body: '{}' }),
    locals: { user: null as User | null, sessionId: null as string | null },
    platform: {
      env: { DB: db.d1, SESSION_SECRET, MAIL_DOMAIN, APP_URL: 'https://mail.example.test', ...env },
      context: { waitUntil: vi.fn() },
      caches: {},
    },
  };
  const response: Response = await (handle as any)({ event, resolve: async () => new Response('ok') });
  return { response, locals: event.locals };
}

describe('hooks with the Access bridge', () => {
  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'hooks-kid' } as JsonWebKey;
  });

  beforeEach(() => {
    seedManager();
    seed(`INSERT INTO users (id, email, status) VALUES ('u1', 'person@example.test', 'active'), ('u2', 'second@example.test', 'active');
      INSERT INTO user_identities (provider, subject, user_id) VALUES ('access', '${SUB_A}', 'u1'), ('access', '${SUB_B}', 'u2');`);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [publicJwk] })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves cookie sessions unchanged when Access is not configured', async () => {
    const { locals } = await invokeHooks({}, { cookie: await sessionCookieFor('u1') });
    expect(locals.user?.id).toBe('u1');
  });

  it('fails closed: a valid cookie session without an Access token gets no user', async () => {
    const { locals, response } = await invokeHooks(ACCESS_ENV, { cookie: await sessionCookieFor('u1') });
    expect(locals.user).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('fails closed: a forged Access token gets no user', async () => {
    const token = await accessToken(SUB_A, 'person@example.test');
    const forged = `${token.slice(0, -4)}AAAA`;
    const { locals } = await invokeHooks(ACCESS_ENV, { cookie: await sessionCookieFor('u1'), 'cf-access-jwt-assertion': forged });
    expect(locals.user).toBeNull();
  });

  it('fails closed when only one Access value is set', async () => {
    const token = await accessToken(SUB_A, 'person@example.test');
    const { locals } = await invokeHooks(
      { ACCESS_TEAM_DOMAIN: TEAM },
      { cookie: await sessionCookieFor('u1'), 'cf-access-jwt-assertion': token },
    );
    expect(locals.user).toBeNull();
  });

  it('signs a bound user in from the Access token alone and sets a session cookie', async () => {
    const { locals, response } = await invokeHooks(ACCESS_ENV, { 'cf-access-jwt-assertion': await accessToken(SUB_A, 'person@example.test') });
    expect(locals.user?.id).toBe('u1');
    expect(response.headers.get('set-cookie')).toMatch(/^cmail_session=/);
  });

  it('keeps a cookie session whose account matches the Access sub', async () => {
    const { locals, response } = await invokeHooks(ACCESS_ENV, {
      cookie: await sessionCookieFor('u1'),
      'cf-access-jwt-assertion': await accessToken(SUB_A, 'person@example.test'),
    });
    expect(locals.user?.id).toBe('u1');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it("revokes another person's cookie session and signs in the Access user instead", async () => {
    const cookie = await sessionCookieFor('u1');
    const { locals } = await invokeHooks(ACCESS_ENV, {
      cookie,
      'cf-access-jwt-assertion': await accessToken(SUB_B, 'second@example.test'),
    });
    expect(locals.user?.id).toBe('u2');
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u1' AND revoked = 0`)).toBe(0);
  });

  it('leaves /mcp bearer requests to their own auth: no Access gate, no session, no cookie', async () => {
    const url = new URL('/mcp', 'https://mail.example.test');
    const event = {
      url,
      request: new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer example-test-token', 'content-type': 'application/json' },
        body: '{}',
      }),
      locals: { user: null as User | null, sessionId: null as string | null },
      platform: {
        env: { DB: db.d1, SESSION_SECRET, MAIL_DOMAIN, APP_URL: 'https://mail.example.test', ...ACCESS_ENV },
        context: { waitUntil: vi.fn() },
        caches: {},
      },
    };
    const resolveRoute = vi.fn(async () => new Response('mcp handler'));
    const response: Response = await (handle as any)({ event, resolve: resolveRoute });
    expect(resolveRoute).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe('mcp handler');
    expect(event.locals.user).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('gives two cookie-less browsers their own working cookies, then reuses each without minting', async () => {
    const header = { 'cf-access-jwt-assertion': await accessToken(SUB_A, 'person@example.test') };
    const first = await invokeHooks(ACCESS_ENV, header);
    const second = await invokeHooks(ACCESS_ENV, header);
    const cookieA = first.response.headers.get('set-cookie')?.split(';', 1)[0];
    const cookieB = second.response.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookieA).toMatch(/^cmail_session=/);
    expect(cookieB).toMatch(/^cmail_session=/);
    expect(cookieA).not.toBe(cookieB);
    expect(first.locals.sessionId).not.toBe(second.locals.sessionId);

    const browsers: Array<[string, string | null]> = [[cookieA!, first.locals.sessionId], [cookieB!, second.locals.sessionId]];
    for (const [cookie, sessionId] of browsers) {
      const post = await invokeHooks(ACCESS_ENV, { ...header, cookie }, '/mail', 'POST');
      expect(post.locals.user?.id).toBe('u1');
      expect(post.locals.sessionId).toBe(sessionId);
      expect(post.response.headers.get('set-cookie')).toBeNull();
    }
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u1' AND revoked = 0`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.sign_in'`)).toBe(2);
  });
  it('does not open an Access session on the bootstrap page', async () => {
    const { locals } = await invokeHooks(ACCESS_ENV, { 'cf-access-jwt-assertion': await accessToken(SUB_A, 'person@example.test') }, '/bootstrap');
    expect(locals.user).toBeNull();
  });
});
