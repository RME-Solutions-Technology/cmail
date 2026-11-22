import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@stanchion/shared/types';
import { createFixture, type Fixture } from './mcp/testing/harness';
import { SoftAuthenticator } from './testing/soft-authenticator';
import {
  NEUTRAL_SIGNIN_FAILURE,
  PASSKEY_SETTING_ENABLED,
  RATE_LIMITS,
  RATE_LIMITED_MESSAGE,
  __test,
  applyPasskeyAdminAction,
  finishAuthentication,
  finishRegistration,
  listPasskeys,
  bodyTooLarge,
  passkeyRouteContext,
  rateLimitAddressKey,
  relyingParty,
  removeOwnPasskey,
  startAuthentication,
  startRegistration,
  type RelyingParty,
} from './passkeys';
import { buildSessionCookie, createSessionToken } from './session';
import { accessSignInPathAllowed } from './access-bridge';
import { handle } from '../../hooks.server';
import { GET as signInPage } from '../../routes/auth/passkey/+server';
import { POST as optionsRoute } from '../../routes/auth/passkey/options/+server';
import { POST as verifyRoute } from '../../routes/auth/passkey/verify/+server';
import { POST as registerOptionsRoute } from '../../routes/api/passkeys/register/options/+server';
import { POST as registerVerifyRoute } from '../../routes/api/passkeys/register/verify/+server';
import { load as settingsPageLoad } from '../../routes/mail/passkeys/+page.server';

const ORIGIN = 'https://mail.example.test';
const SESSION_SECRET = 'test-only-session-secret-0123456789abcdef';

let fixture: Fixture;
let env: Record<string, unknown> & { DB: D1Database; SESSION_SECRET: string };
let rp: RelyingParty;
const softRp = () => ({ rpId: rp.rpID, origin: rp.origin });

function count(sql: string, ...args: (string | number)[]): number {
  return Number((fixture.db.sqlite.prepare(sql).get(...args) as { n: number }).n);
}

function userRow(id: string): User {
  return fixture.db.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User;
}

function enable(on = true): void {
  fixture.db.sqlite.prepare(
    `INSERT INTO org_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PASSKEY_SETTING_ENABLED, on ? 'true' : 'false');
}

/** An ordinary (non-passkey) session opened `minutesAgo` minutes ago. */
async function ordinarySession(userId: string, minutesAgo = 0): Promise<{ sessionId: string; cookie: string }> {
  const session = await createSessionToken(userId, SESSION_SECRET, 60 * 60 * 1000);
  fixture.db.sqlite.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, issued_at, expires_at, revoked)
     VALUES (?, ?, ?, datetime('now', ?), datetime('now', '+1 hour'), 0)`,
  ).run(session.sessionId, userId, session.hash, `-${minutesAgo} minutes`);
  return { sessionId: session.sessionId, cookie: buildSessionCookie(session.token, true).split(';', 1)[0] };
}

async function register(userId: string, authenticator: SoftAuthenticator, sessionId?: string, deviceName = 'Test phone') {
  const user = userRow(userId);
  const sid = sessionId ?? (await ordinarySession(userId)).sessionId;
  const start = await startRegistration(env, rp, user, sid);
  if (!start.ok) return start;
  const response = await authenticator.register(start.options, softRp());
  return finishRegistration(env, rp, user, sid, { challengeId: start.challengeId, deviceName, response }, { clientIp: '192.0.2.1' });
}

function verifyRequest(ip = '192.0.2.10'): Request {
  return new Request(`${ORIGIN}/auth/passkey/verify`, { method: 'POST', headers: { 'cf-connecting-ip': ip } });
}

async function signIn(
  authenticator: SoftAuthenticator,
  overrides: Parameters<SoftAuthenticator['authenticate']>[2] = {},
  ip = '192.0.2.10',
) {
  const request = verifyRequest(ip);
  const start = await startAuthentication(env, rp, request);
  if (!start.ok) throw new Error('options refused');
  const response = await authenticator.authenticate(start.options.challenge, softRp(), overrides);
  const body = { challengeId: start.challengeId, response };
  const result = await finishAuthentication(env, rp, request, body, { secureCookie: true });
  return { body, result, request };
}

beforeEach(() => {
  fixture = createFixture({ SESSION_SECRET });
  env = fixture.env as typeof env;
  fixture.db.sqlite.exec(`INSERT INTO users (id, email, display_name, role, status) VALUES
    ('user-manager', 'manager@example.test', 'Manager', 'manager', 'active');`);
  rp = relyingParty(env)!;
  enable();
});

describe('migration 0025', () => {
  it('keeps credential ids unique across accounts', () => {
    const insert = `INSERT INTO passkey_credentials (id, user_id, user_handle, public_key, device_name)
      VALUES ('${'c'.repeat(22)}', ?, '${'h'.repeat(43)}', '${'k'.repeat(40)}', 'Phone')`;
    fixture.db.sqlite.prepare(insert).run('user-alice');
    expect(() => fixture.db.sqlite.prepare(insert).run('user-bob')).toThrow();
  });

  it('ends passkey sessions when the passkey is deleted', () => {
    fixture.db.sqlite.exec(`
      INSERT INTO passkey_credentials (id, user_id, user_handle, public_key, device_name)
        VALUES ('${'d'.repeat(22)}', 'user-alice', '${'h'.repeat(43)}', '${'k'.repeat(40)}', 'Phone');
      INSERT INTO sessions (id, user_id, token_hash, expires_at, passkey_credential_id)
        VALUES ('s-pk', 'user-alice', 'hash-pk', datetime('now', '+1 hour'), '${'d'.repeat(22)}');
      DELETE FROM passkey_credentials WHERE id = '${'d'.repeat(22)}';`);
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE id = 's-pk'`)).toBe(0);
  });

  it('refuses a challenge whose owner columns do not match its purpose', () => {
    expect(() => fixture.db.sqlite.exec(`INSERT INTO passkey_challenges (id, challenge, purpose, expires_at)
      VALUES ('00000000-0000-0000-0000-000000000000', '${'a'.repeat(43)}', 'register', 1)`)).toThrow();
  });
});

describe('relying party', () => {
  it('comes from APP_URL only, https or loopback http', () => {
    expect(relyingParty({ APP_URL: 'https://mail.example.test' })).toMatchObject({ rpID: 'mail.example.test', origin: 'https://mail.example.test' });
    expect(relyingParty({ APP_URL: 'http://localhost:5173' })).toMatchObject({ rpID: 'localhost', origin: 'http://localhost:5173' });
    expect(relyingParty({ APP_URL: 'http://mail.example.test' })).toBeNull();
    expect(relyingParty({ APP_URL: 'https://192.0.2.1' })).toBeNull();
    expect(relyingParty({})).toBeNull();
  });

  it('answers only on the APP_URL origin and only when switched on', async () => {
    expect(await passkeyRouteContext(env, new URL(`${ORIGIN}/auth/passkey`))).not.toBeNull();
    expect(await passkeyRouteContext(env, new URL('https://cmail-example.pages.dev/auth/passkey'))).toBeNull();
    enable(false);
    expect(await passkeyRouteContext(env, new URL(`${ORIGIN}/auth/passkey`))).toBeNull();
  });
});

describe('registration', () => {
  it('stores a passkey from a fresh ordinary session, with a random user handle', async () => {
    const authenticator = await SoftAuthenticator.create();
    const result = await register('user-alice', authenticator);
    expect(result).toMatchObject({ ok: true, passkey: { id: authenticator.id, deviceName: 'Test phone' } });
    const row = fixture.db.sqlite.prepare('SELECT * FROM passkey_credentials WHERE id = ?').get(authenticator.id) as Record<string, unknown>;
    expect(row.user_id).toBe('user-alice');
    expect(String(row.user_handle)).toHaveLength(43); // 32 random bytes
    expect(row.user_handle).not.toContain('alice');
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_registered' AND target = 'user-alice'`)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM passkey_challenges')).toBe(0);
  });

  it('reuses the account user handle for a second passkey and lists both', async () => {
    const first = await SoftAuthenticator.create();
    const second = await SoftAuthenticator.create();
    await register('user-alice', first);
    expect(await register('user-alice', second, undefined, 'Laptop')).toMatchObject({ ok: true });
    const handles = fixture.db.sqlite.prepare(`SELECT DISTINCT user_handle FROM passkey_credentials WHERE user_id = 'user-alice'`).all();
    expect(handles).toHaveLength(1);
    expect((await listPasskeys(env.DB, 'user-alice')).map((item) => item.deviceName)).toEqual(['Test phone', 'Laptop']);
  });

  it('refuses a passkey session, and a session older than the fresh window', async () => {
    const authenticator = await SoftAuthenticator.create();
    await register('user-alice', authenticator);
    const { sessionId: stale } = await ordinarySession('user-alice', 30);
    expect(await startRegistration(env, rp, userRow('user-alice'), stale)).toMatchObject({ ok: false, status: 403 });

    const { result } = await signIn(authenticator);
    expect(result.ok).toBe(true);
    const passkeySessionId = result.ok ? result.sessionId : '';
    expect(await startRegistration(env, rp, userRow('user-alice'), passkeySessionId)).toMatchObject({ ok: false, status: 403 });
    expect(await removeOwnPasskey(env, userRow('user-alice'), passkeySessionId, authenticator.id, '')).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a response from another origin or for another RP ID', async () => {
    for (const forged of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }]) {
      const authenticator = await SoftAuthenticator.create();
      const { sessionId } = await ordinarySession('user-alice');
      const user = userRow('user-alice');
      const start = await startRegistration(env, rp, user, sessionId);
      if (!start.ok) throw new Error('start refused');
      const response = await authenticator.register(start.options, softRp(), forged);
      const result = await finishRegistration(env, rp, user, sessionId, { challengeId: start.challengeId, deviceName: 'X', response }, { clientIp: '' });
      expect(result).toMatchObject({ ok: false, status: 400 });
    }
    expect(count('SELECT COUNT(*) AS n FROM passkey_credentials')).toBe(0);
  });

  it('refuses a registration without user verification', async () => {
    const authenticator = await SoftAuthenticator.create();
    const { sessionId } = await ordinarySession('user-alice');
    const user = userRow('user-alice');
    const start = await startRegistration(env, rp, user, sessionId);
    if (!start.ok) throw new Error('start refused');
    const response = await authenticator.register(start.options, softRp(), { flags: 0x41 }); // UP | AT, no UV
    expect(await finishRegistration(env, rp, user, sessionId, { challengeId: start.challengeId, deviceName: 'X', response }, { clientIp: '' }))
      .toMatchObject({ ok: false });
  });

  it('uses each challenge once, and only for the session that asked for it', async () => {
    const authenticator = await SoftAuthenticator.create();
    const { sessionId } = await ordinarySession('user-alice');
    const { sessionId: otherSession } = await ordinarySession('user-alice');
    const user = userRow('user-alice');
    const start = await startRegistration(env, rp, user, sessionId);
    if (!start.ok) throw new Error('start refused');
    const response = await authenticator.register(start.options, softRp());
    const body = { challengeId: start.challengeId, deviceName: 'X', response };
    expect(await finishRegistration(env, rp, user, otherSession, body, { clientIp: '' })).toMatchObject({ ok: false, status: 400 });
    // The wrong-session attempt consumed it: the right session cannot use it now either.
    expect(await finishRegistration(env, rp, user, sessionId, body, { clientIp: '' })).toMatchObject({ ok: false, status: 400 });
  });

  it('registers and signs in with Ed25519 and RS256 passkeys too', async () => {
    for (const algorithm of ['Ed25519', 'RS256'] as const) {
      const authenticator = await SoftAuthenticator.create(algorithm);
      expect(await register('user-alice', authenticator, undefined, algorithm)).toMatchObject({ ok: true });
      expect((await signIn(authenticator)).result.ok).toBe(true);
      expect((await signIn(authenticator, { tamper: true })).result.ok).toBe(false);
    }
  });

  it('tells the person and the managers, and audits when mail is not set up', async () => {
    await register('user-alice', await SoftAuthenticator.create());
    // The fixture has no outbound provider: both notices are audited as undeliverable, never skipped silently.
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'email.failed' AND detail LIKE 'Passkey notice not sent%'`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'email.failed' AND detail LIKE 'Manager notification undeliverable%'`)).toBe(1);
  });

  it('passkey notices use their own manager budget, not the shared one', async () => {
    // Shared budget already spent (for example by travel requests).
    fixture.db.sqlite.prepare('INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 999, ?)')
      .run(`mgr_notify:global:${Math.floor(Math.floor(Date.now() / 1000) / 3600)}`, Math.floor(Date.now() / 1000) + 3600);
    await register('user-alice', await SoftAuthenticator.create());
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'security.rate_limit' AND detail LIKE 'Manager notification suppressed%'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'mgr_notify_passkey:global:%'`)).toBe(1);
  });

  it('rate-limits passkey removals per person', async () => {
    const { sessionId } = await ordinarySession('user-alice');
    for (let attempt = 0; attempt < RATE_LIMITS.removePerUser.limit; attempt += 1) {
      await removeOwnPasskey(env, userRow('user-alice'), sessionId, 'x'.repeat(22), '');
    }
    expect(await removeOwnPasskey(env, userRow('user-alice'), sessionId, 'x'.repeat(22), '')).toMatchObject({ ok: false, status: 429 });
  });

  it('measures request bodies in bytes', () => {
    expect(bodyTooLarge('a'.repeat(10), 10)).toBe(false);
    expect(bodyTooLarge('é'.repeat(6), 10)).toBe(true);
  });

  it('refuses a credential id that is already registered to anyone', async () => {
    const authenticator = await SoftAuthenticator.create();
    await register('user-alice', authenticator);
    expect(await register('user-bob', authenticator)).toMatchObject({ ok: false, status: 409 });
    expect(count(`SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = 'user-bob'`)).toBe(0);
  });
});

describe('sign-in', () => {
  let authenticator: SoftAuthenticator;
  beforeEach(async () => {
    authenticator = await SoftAuthenticator.create();
    const result = await register('user-alice', authenticator);
    if (!result.ok) throw new Error('registration failed');
  });

  it('signs in with a passkey alone: a marked session, cookie, counter and audit', async () => {
    const { result } = await signIn(authenticator);
    expect(result).toMatchObject({ ok: true, location: '/mail' });
    if (!result.ok) return;
    expect(result.cookie).toMatch(/^cmail_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
    const session = fixture.db.sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(result.sessionId) as Record<string, unknown>;
    expect(session.passkey_credential_id).toBe(authenticator.id);
    expect(session.revoked).toBe(0);
    const credential = fixture.db.sqlite.prepare('SELECT counter, last_used_at FROM passkey_credentials WHERE id = ?').get(authenticator.id) as Record<string, unknown>;
    expect(credential.counter).toBe(1);
    expect(credential.last_used_at).not.toBeNull();
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.sign_in' AND actor_id = 'user-alice' AND detail LIKE 'Signed in via passkey%'`)).toBe(1);
  });

  it('applies the session cap like every other sign-in', async () => {
    for (let index = 0; index < 6; index += 1) await signIn(authenticator);
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'user-alice' AND revoked = 0`)).toBe(5);
  });

  it('refuses a replayed response (the challenge is single use)', async () => {
    const { body, request } = await signIn(authenticator);
    const replay = await finishAuthentication(env, rp, request, body, { secureCookie: true });
    expect(replay).toEqual({ ok: false, status: 400, message: NEUTRAL_SIGNIN_FAILURE });
  });

  it('refuses an expired challenge', async () => {
    const request = verifyRequest();
    const start = await startAuthentication(env, rp, request);
    if (!start.ok) throw new Error('options refused');
    fixture.db.sqlite.prepare('UPDATE passkey_challenges SET expires_at = unixepoch() - 1 WHERE id = ?').run(start.challengeId);
    const response = await authenticator.authenticate(start.options.challenge, softRp());
    expect(await finishAuthentication(env, rp, request, { challengeId: start.challengeId, response }, { secureCookie: true }))
      .toMatchObject({ ok: false, message: NEUTRAL_SIGNIN_FAILURE });
  });

  it('refuses the wrong origin, the wrong RP ID, a registration-type response and a missing UV flag', async () => {
    for (const forged of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { type: 'webauthn.create' }, { flags: 0x01 }]) {
      const { result } = await signIn(authenticator, forged);
      expect(result).toEqual({ ok: false, status: 400, message: NEUTRAL_SIGNIN_FAILURE });
    }
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE passkey_credential_id IS NOT NULL`)).toBe(0);
  });

  it('refuses a tampered signature and a signature from another key, without a counter alarm', async () => {
    const other = await SoftAuthenticator.create();
    fixture.db.sqlite.prepare('UPDATE passkey_credentials SET counter = 10 WHERE id = ?').run(authenticator.id);
    for (const forged of [{ tamper: true, counter: 5 }, { signWith: other, counter: 5 }, { tamper: true }]) {
      const { result } = await signIn(authenticator, forged);
      expect(result).toEqual({ ok: false, status: 400, message: NEUTRAL_SIGNIN_FAILURE });
    }
    // A forged response with a lower counter must never look like a copied passkey.
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_counter_rollback'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_failed' AND target = 'user-alice' AND (detail LIKE '%not_verified%' OR detail LIKE '%verification_failed%')`)).toBe(3);
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE passkey_credential_id IS NOT NULL`)).toBe(0);
  });

  it('refuses a counter that goes backwards on a valid signature, and audits it as a possible copied passkey', async () => {
    fixture.db.sqlite.prepare('UPDATE passkey_credentials SET counter = 10 WHERE id = ?').run(authenticator.id);
    const { result } = await signIn(authenticator, { counter: 5 });
    expect(result).toEqual({ ok: false, status: 400, message: NEUTRAL_SIGNIN_FAILURE });
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_counter_rollback'`)).toBe(1);
    const { result: equal } = await signIn(authenticator, { counter: 10 });
    expect(equal.ok).toBe(false);
    expect((fixture.db.sqlite.prepare('SELECT counter FROM passkey_credentials WHERE id = ?').get(authenticator.id) as { counter: number }).counter).toBe(10);
  });

  it('accepts an authenticator that always reports counter 0 (synced passkeys)', async () => {
    expect((await signIn(authenticator, { counter: 0 })).result.ok).toBe(true);
    expect((await signIn(authenticator, { counter: 0 })).result.ok).toBe(true);
  });

  it('refuses a missing or different user handle', async () => {
    expect((await signIn(authenticator, { userHandle: null })).result.ok).toBe(false);
    expect((await signIn(authenticator, { userHandle: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).result.ok).toBe(false);
  });

  it('gives the same answer for an unknown passkey, a paused account and an offboarded one (no enumeration)', async () => {
    const stranger = await SoftAuthenticator.create();
    stranger.userHandle = new Uint8Array(32);
    const unknown = (await signIn(stranger)).result;
    fixture.db.sqlite.exec(`UPDATE users SET status = 'paused' WHERE id = 'user-alice'`);
    const paused = (await signIn(authenticator)).result;
    fixture.db.sqlite.exec(`UPDATE users SET status = 'offboarded' WHERE id = 'user-alice'`);
    const offboarded = (await signIn(authenticator)).result;
    expect(unknown).toEqual({ ok: false, status: 400, message: NEUTRAL_SIGNIN_FAILURE });
    expect(paused).toEqual(unknown);
    expect(offboarded).toEqual(unknown);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_failed' AND detail LIKE '%account_unavailable%'`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE passkey_credential_id IS NOT NULL`)).toBe(0);
  });

  it('audits unknown passkey ids as an aggregate count, not once per request', async () => {
    for (let index = 0; index < 5; index += 1) {
      const stranger = await SoftAuthenticator.create();
      stranger.userHandle = new Uint8Array(32);
      await signIn(stranger, {}, `192.0.2.${120 + index}`);
    }
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_failed' AND detail LIKE '%unknown passkey%'`)).toBe(1);
  });

  it('lets a manager in (break-glass) and audits it separately', async () => {
    const managerKey = await SoftAuthenticator.create();
    expect((await register('user-manager', managerKey)).ok).toBe(true);
    const { result } = await signIn(managerKey);
    expect(result).toMatchObject({ ok: true });
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_manager_sign_in' AND actor_id = 'user-manager'`)).toBe(1);
  });

  it('applies the sign-in country gate after the passkey is proven', async () => {
    fixture.db.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('sign_in_countries', '["AU"]')`);
    const request = new Request(`${ORIGIN}/auth/passkey/verify`, { method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.10', 'cf-ipcountry': 'NZ' } });
    const start = await startAuthentication(env, rp, request);
    if (!start.ok) throw new Error('options refused');
    const response = await authenticator.authenticate(start.options.challenge, softRp());
    const result = await finishAuthentication(env, rp, request, { challengeId: start.challengeId, response }, { secureCookie: true });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE passkey_credential_id IS NOT NULL`)).toBe(0);
    // Not "used" until it actually opened a session.
    expect(count('SELECT COUNT(*) AS n FROM passkey_credentials WHERE id = ? AND last_used_at IS NULL', authenticator.id)).toBe(1);
  });

  it('counts only failures per address: then answers the same for everyone from it', async () => {
    for (let attempt = 0; attempt < RATE_LIMITS.verifyFailuresPerIp.limit; attempt += 1) {
      await finishAuthentication(env, rp, verifyRequest('192.0.2.99'), {}, { secureCookie: true });
    }
    const limited = await finishAuthentication(env, rp, verifyRequest('192.0.2.99'), {}, { secureCookie: true });
    expect(limited).toEqual({ ok: false, status: 429, message: RATE_LIMITED_MESSAGE });
    expect((await signIn(authenticator, {}, '192.0.2.99')).result).toEqual(limited);
    // The limit was audited once, not per request.
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'security.rate_limit'`)).toBe(1);
    // Another address is unaffected.
    expect((await signIn(authenticator, {}, '192.0.2.100')).result.ok).toBe(true);
  });

  it('successful sign-ins from one office address never use up its limit', async () => {
    for (let attempt = 0; attempt < RATE_LIMITS.verifyFailuresPerIp.limit + 5; attempt += 1) {
      expect((await signIn(authenticator, {}, '192.0.2.50')).result.ok).toBe(true);
    }
  });

  it('keys IPv6 addresses on their /64', async () => {
    expect(rateLimitAddressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(rateLimitAddressKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitAddressKey('2001:DB8:0001:0002:0:0:0:ffff')).toBe('2001:db8:1:2::/64');
    expect(rateLimitAddressKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(rateLimitAddressKey('192.0.2.1')).toBe('192.0.2.1');
    for (let attempt = 0; attempt < RATE_LIMITS.verifyFailuresPerIp.limit; attempt += 1) {
      await finishAuthentication(env, rp, verifyRequest(`2001:db8:1:2::${attempt + 1}`), {}, { secureCookie: true });
    }
    expect(await finishAuthentication(env, rp, verifyRequest('2001:db8:1:2:ffff::9'), {}, { secureCookie: true }))
      .toMatchObject({ status: 429 });
    expect((await signIn(authenticator, {}, '2001:db8:1:3::1')).result.ok).toBe(true);
  });

  it('rate-limits challenge requests per address without draining anyone else', async () => {
    const request = new Request(`${ORIGIN}/auth/passkey/options`, { method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.77' } });
    for (let attempt = 0; attempt < RATE_LIMITS.optionsPerIp.limit + 50; attempt += 1) {
      await startAuthentication(env, rp, request);
    }
    expect(await startAuthentication(env, rp, request)).toEqual({ ok: false, status: 429, message: RATE_LIMITED_MESSAGE });
    // No global cap: refused requests from one host leave everyone else able to start.
    for (let index = 0; index < 20; index += 1) {
      const other = new Request(`${ORIGIN}/auth/passkey/options`, { method: 'POST', headers: { 'cf-connecting-ip': `198.51.100.${index}` } });
      expect((await startAuthentication(env, rp, other)).ok).toBe(true);
    }
  });

  it('limits valid sign-ins per passkey, counted only after the signature checks out', async () => {
    // Forged attempts against this passkey do not use up its allowance.
    for (let attempt = 0; attempt < 8; attempt += 1) await signIn(authenticator, { tamper: true }, `198.51.100.${attempt}`);
    for (let attempt = 0; attempt < RATE_LIMITS.verifyPerCredential.limit; attempt += 1) {
      expect((await signIn(authenticator, {}, '192.0.2.60')).result.ok).toBe(true);
    }
    expect((await signIn(authenticator, {}, '192.0.2.61')).result).toEqual({ ok: false, status: 429, message: RATE_LIMITED_MESSAGE });
  });

  it('removing a passkey ends the sessions it opened', async () => {
    const { result } = await signIn(authenticator);
    if (!result.ok) throw new Error('sign-in failed');
    const { sessionId } = await ordinarySession('user-alice');
    expect(await removeOwnPasskey(env, userRow('user-alice'), sessionId, authenticator.id, '')).toMatchObject({ ok: true });
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE id = ? AND revoked = 0`, result.sessionId)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_removed'`)).toBe(1);
  });

  it('a person cannot remove someone else\'s passkey', async () => {
    const { sessionId } = await ordinarySession('user-bob');
    expect(await removeOwnPasskey(env, userRow('user-bob'), sessionId, authenticator.id, '')).toMatchObject({ ok: false, status: 404 });
    expect(count('SELECT COUNT(*) AS n FROM passkey_credentials WHERE id = ?', authenticator.id)).toBe(1);
  });
});

describe('admin switch', () => {
  it('turning off signs out passkey sessions but keeps passkeys; managers can remove all of a person\'s passkeys', async () => {
    const authenticator = await SoftAuthenticator.create();
    await register('user-alice', authenticator);
    const { result } = await signIn(authenticator);
    if (!result.ok) throw new Error('sign-in failed');
    expect(await applyPasskeyAdminAction(env, { id: 'user-manager' }, 'disable', null, '')).toMatchObject({ ok: true });
    expect(count(`SELECT COUNT(*) AS n FROM sessions WHERE id = ? AND revoked = 1`, result.sessionId)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM passkey_credentials')).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'org.passkey_signin_toggled'`)).toBe(1);

    expect(await applyPasskeyAdminAction(env, { id: 'user-manager' }, 'enable', null, '')).toMatchObject({ ok: true });
    expect(await applyPasskeyAdminAction(env, { id: 'user-manager' }, 'remove_user', 'user-alice', '')).toMatchObject({ ok: true });
    expect(count('SELECT COUNT(*) AS n FROM passkey_credentials')).toBe(0);
  });

  it('refuses to turn on without a usable APP_URL', async () => {
    enable(false);
    const noUrl = { ...env, APP_URL: '' };
    expect(await applyPasskeyAdminAction(noUrl, { id: 'user-manager' }, 'enable', null, '')).toMatchObject({ ok: false, status: 409 });
  });
});

describe('routes when switched off', () => {
  beforeEach(() => enable(false));

  function routeEvent(path: string, method = 'GET', body?: string, user: User | null = null, sessionId: string | null = null) {
    const url = new URL(path, ORIGIN);
    return {
      url,
      request: new Request(url, body === undefined ? { method } : { method, body, headers: { 'content-type': 'application/json' } }),
      platform: fixture.platform,
      locals: { user, sessionId },
      setHeaders: () => undefined,
    } as never;
  }

  it('answers 404 on the page, the challenge and the verify endpoints', async () => {
    for (const call of [
      () => signInPage(routeEvent('/auth/passkey')),
      () => optionsRoute(routeEvent('/auth/passkey/options', 'POST', '{}')),
      () => verifyRoute(routeEvent('/auth/passkey/verify', 'POST', '{}')),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
    }
  });

  it('answers 404 on registration and hides Mail > Settings > Passkeys, even for a signed-in person', async () => {
    const { sessionId } = await ordinarySession('user-alice');
    const alice = userRow('user-alice');
    await expect(registerOptionsRoute(routeEvent('/api/passkeys/register/options', 'POST', '{}', alice, sessionId))).rejects.toMatchObject({ status: 404 });
    await expect(registerVerifyRoute(routeEvent('/api/passkeys/register/verify', 'POST', '{}', alice, sessionId))).rejects.toMatchObject({ status: 404 });
    await expect(settingsPageLoad(routeEvent('/mail/passkeys', 'GET', undefined, alice, sessionId))).rejects.toMatchObject({ status: 404 });
    // 404 before 401: signed out, the endpoints still do not exist.
    await expect(registerOptionsRoute(routeEvent('/api/passkeys/register/options', 'POST', '{}'))).rejects.toMatchObject({ status: 404 });
    await expect(registerVerifyRoute(routeEvent('/api/passkeys/register/verify', 'POST', '{}'))).rejects.toMatchObject({ status: 404 });
    await expect(settingsPageLoad(routeEvent('/mail/passkeys'))).rejects.toMatchObject({ status: 404 });
  });

  it('serves the page with a strict CSP when on', async () => {
    enable(true);
    const response = await signInPage(routeEvent('/auth/passkey'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).toContain('/auth/passkey/client.js');
    expect(html).not.toMatch(/\/_app\//);
  });
});

// ─── hooks.server.ts: the Access bridge and passkey sessions ──────────────

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ACCESS_ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
let privateKey: CryptoKey;
let publicJwk: JsonWebKey;

function b64(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function accessToken(subject: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64(JSON.stringify({ alg: 'RS256', kid: 'passkey-kid' }))}.${b64(JSON.stringify({
    aud: [AUD], email, exp: now + 600, iat: now, nbf: now, iss: `https://${TEAM}`, type: 'app', sub: subject,
  }))}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
  return `${input}.${b64(signature)}`;
}

async function invokeHooks(
  extraEnv: Record<string, unknown>,
  headers: Record<string, string>,
  path = '/mail',
  resolveResponse: () => Response = () => new Response('ok'),
) {
  const url = new URL(path, ORIGIN);
  const event = {
    url,
    request: new Request(url, { headers }),
    locals: { user: null as User | null, sessionId: null as string | null, passkeySession: false as boolean | undefined },
    platform: { env: { ...env, ...extraEnv }, context: { waitUntil: vi.fn() }, caches: {} },
  };
  const response: Response = await (handle as never as (input: unknown) => Promise<Response>)({ event, resolve: async () => resolveResponse() });
  return { response, locals: event.locals };
}

describe('hooks: passkey sessions and the Access bridge', () => {
  let authenticator: SoftAuthenticator;
  let passkeyCookie: string;
  let passkeySessionId: string;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'passkey-kid' } as JsonWebKey;
  });

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [publicJwk] })));
    fixture.db.sqlite.exec(`INSERT INTO user_identities (provider, subject, user_id) VALUES
      ('access', 'sub-alice', 'user-alice'), ('access', 'sub-bob', 'user-bob');`);
    authenticator = await SoftAuthenticator.create();
    await register('user-alice', authenticator);
    const { result } = await signIn(authenticator);
    if (!result.ok) throw new Error('sign-in failed');
    passkeyCookie = result.cookie.split(';', 1)[0];
    passkeySessionId = result.sessionId;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Access on, no Access token: a passkey session is let through', async () => {
    const { locals, response } = await invokeHooks(ACCESS_ENV, { cookie: passkeyCookie });
    expect(locals.user?.id).toBe('user-alice');
    expect(locals.passkeySession).toBe(true);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('Access on, no Access token: an ordinary session still fails closed', async () => {
    const { cookie } = await ordinarySession('user-alice');
    const { locals, response } = await invokeHooks(ACCESS_ENV, { cookie });
    expect(locals.user).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('Access on, a forged Access token does not upgrade an ordinary session', async () => {
    const { cookie } = await ordinarySession('user-alice');
    const token = await accessToken('sub-alice', 'alice@example.test');
    const { locals } = await invokeHooks(ACCESS_ENV, { cookie, 'cf-access-jwt-assertion': `${token.slice(0, -4)}AAAA` });
    expect(locals.user).toBeNull();
  });

  it('Access misconfigured: passkey sessions work, ordinary sessions stay signed out', async () => {
    const { cookie } = await ordinarySession('user-alice');
    expect((await invokeHooks({ ACCESS_TEAM_DOMAIN: TEAM }, { cookie: passkeyCookie })).locals.user?.id).toBe('user-alice');
    expect((await invokeHooks({ ACCESS_TEAM_DOMAIN: TEAM }, { cookie })).locals.user).toBeNull();
  });

  it('Access on, token for the same person: the passkey session is used as is', async () => {
    const { locals, response } = await invokeHooks(ACCESS_ENV, {
      cookie: passkeyCookie,
      'cf-access-jwt-assertion': await accessToken('sub-alice', 'alice@example.test'),
    });
    expect(locals.user?.id).toBe('user-alice');
    expect(locals.sessionId).toBe(passkeySessionId);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('Access on, token for someone else, no new session: the passkey session is set aside, not revoked', async () => {
    // /auth/* never opens an Access session, so the passkey cookie stays in place.
    const { locals, response } = await invokeHooks(ACCESS_ENV, {
      cookie: passkeyCookie,
      'cf-access-jwt-assertion': await accessToken('sub-bob', 'bob@example.test'),
    }, '/auth/email');
    expect(locals.user).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE id = ? AND revoked = 0', passkeySessionId)).toBe(1);
  });

  it('Access on, token for someone else: Access signs them in and the overwritten passkey session is revoked', async () => {
    const { locals, response } = await invokeHooks(ACCESS_ENV, {
      cookie: passkeyCookie,
      'cf-access-jwt-assertion': await accessToken('sub-bob', 'bob@example.test'),
    });
    expect(locals.user?.id).toBe('user-bob');
    expect(response.headers.get('set-cookie')).toMatch(/^cmail_session=/);
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE id = ? AND revoked = 1', passkeySessionId)).toBe(1);
    // And an ordinary session in the same position is still revoked.
    const { cookie, sessionId } = await ordinarySession('user-alice');
    await invokeHooks(ACCESS_ENV, { cookie, 'cf-access-jwt-assertion': await accessToken('sub-bob', 'bob@example.test') });
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE id = ? AND revoked = 1', sessionId)).toBe(1);
  });

  it('a passkey session is refused on any origin but APP_URL (for example *.pages.dev), and left alone', async () => {
    const url = new URL('/mail', 'https://cmail-example.pages.dev');
    const event = {
      url,
      request: new Request(url, { headers: { cookie: passkeyCookie } }),
      locals: { user: null as User | null, sessionId: null as string | null, passkeySession: false as boolean | undefined },
      platform: { env, context: { waitUntil: vi.fn() }, caches: {} },
    };
    await (handle as never as (input: unknown) => Promise<Response>)({ event, resolve: async () => new Response('ok') });
    expect(event.locals.user).toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE id = ? AND revoked = 0', passkeySessionId)).toBe(1);
    // An ordinary session on that origin is unaffected by this rule (Access off).
    const { cookie } = await ordinarySession('user-alice');
    event.request = new Request(url, { headers: { cookie } });
    await (handle as never as (input: unknown) => Promise<Response>)({ event, resolve: async () => new Response('ok') });
    expect(event.locals.user?.id).toBe('user-alice');
  });

  it('a passkey session has a short fixed lifetime that use never extends', async () => {
    // Stored in datetime() text format and compared as text, exactly as the
    // hook does: live now, gone by 8 hours and a second from now.
    const row = fixture.db.sqlite.prepare(
      `SELECT expires_at,
              expires_at > datetime('now') AS live_now,
              expires_at > datetime('now', '+8 hours', '-5 seconds') AS live_before_8h,
              expires_at > datetime('now', '+8 hours', '+1 second') AS live_after_8h
       FROM sessions WHERE id = ?`,
    ).get(passkeySessionId) as { expires_at: string; live_now: number; live_before_8h: number; live_after_8h: number };
    expect(row.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect([row.live_now, row.live_before_8h, row.live_after_8h]).toEqual([1, 1, 0]);
    fixture.db.sqlite.prepare(`UPDATE sessions SET expires_at = datetime('now', '+1 hour') WHERE id = ?`).run(passkeySessionId);
    const waitUntil = vi.fn();
    const url = new URL('/mail', ORIGIN);
    const event = {
      url,
      request: new Request(url, { headers: { cookie: passkeyCookie } }),
      locals: { user: null as User | null, sessionId: null as string | null, passkeySession: false as boolean | undefined },
      platform: { env: { ...env, SESSION_TTL_HOURS: '720' }, context: { waitUntil }, caches: {} },
    };
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5); // no maintenance sweep
    await (handle as never as (input: unknown) => Promise<Response>)({ event, resolve: async () => new Response('ok') });
    random.mockRestore();
    expect(event.locals.user?.id).toBe('user-alice');
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('a passkey session ends at its real expiry boundary, not later the same day', async () => {
    fixture.db.sqlite.prepare(`UPDATE sessions SET expires_at = datetime('now', '+2 seconds') WHERE id = ?`).run(passkeySessionId);
    expect((await invokeHooks({}, { cookie: passkeyCookie })).locals.user?.id).toBe('user-alice');
    fixture.db.sqlite.prepare(`UPDATE sessions SET expires_at = datetime('now', '-1 second') WHERE id = ?`).run(passkeySessionId);
    expect((await invokeHooks({}, { cookie: passkeyCookie })).locals.user).toBeNull();
  });

  it('a passkey session is refused for a pending account (active only)', async () => {
    fixture.db.sqlite.exec(`UPDATE users SET status = 'pending' WHERE id = 'user-alice'`);
    expect((await invokeHooks({}, { cookie: passkeyCookie })).locals.user).toBeNull();
  });

  it('/auth/passkey never opens a session from an Access token', () => {
    expect(accessSignInPathAllowed('GET', '/auth/passkey')).toBe(false);
    expect(accessSignInPathAllowed('POST', '/auth/passkey/verify')).toBe(false);
  });

  it('switching passkey sign-in off ends the passkey session on its next request', async () => {
    enable(false);
    const { locals, response } = await invokeHooks(ACCESS_ENV, { cookie: passkeyCookie });
    expect(locals.user).toBeNull();
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE id = ? AND revoked = 1', passkeySessionId)).toBe(1);
  });

  it('a removed passkey or a paused account ends the passkey session', async () => {
    fixture.db.sqlite.exec(`UPDATE users SET status = 'paused' WHERE id = 'user-alice'`);
    expect((await invokeHooks({}, { cookie: passkeyCookie })).locals.user).toBeNull();
    fixture.db.sqlite.exec(`UPDATE users SET status = 'active' WHERE id = 'user-alice'`);
    fixture.db.sqlite.prepare('DELETE FROM passkey_credentials WHERE id = ?').run(authenticator.id);
    expect((await invokeHooks({}, { cookie: passkeyCookie })).locals.user).toBeNull();
  });

  it('a fresh session cookie from a sign-in route is not cleared by a stale one', async () => {
    const fresh = 'cmail_session=fresh-token; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure';
    const { response } = await invokeHooks({}, { cookie: 'cmail_session=stale.value.1700000000000.00' }, '/auth/passkey/verify', () => {
      const headers = new Headers();
      headers.append('Set-Cookie', fresh);
      return new Response('{}', { headers });
    });
    expect(response.headers.getSetCookie()).toEqual([fresh]);
  });
});

describe('challenge store', () => {
  it('deletes a challenge when it is read, valid or not', async () => {
    const id = await __test.storeChallenge(env.DB, 'x'.repeat(43), null);
    expect(await __test.consumeChallenge(env.DB, id, { userId: 'user-alice', sessionId: 's' })).toBeNull();
    expect(await __test.consumeChallenge(env.DB, id, null)).toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM passkey_challenges')).toBe(0);
  });
});
