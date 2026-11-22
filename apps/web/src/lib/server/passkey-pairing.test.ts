import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@cmail/shared/types';
import { createFixture, type Fixture } from './mcp/testing/harness';
import { SoftAuthenticator } from './testing/soft-authenticator';
import { PASSKEY_SETTING_ENABLED, relyingParty, listPasskeys, startRegistration, type RelyingParty } from './passkeys';
import {
  PAIRING_RATE_LIMITS,
  PAIRING_TTL_SECONDS,
  approvePairing,
  createPairing,
  denyPairing,
  deviceLabelFromUserAgent,
  finishPairing,
  joinPairing,
  pairingRegistrationOptions,
  pairingStatus,
  pairingWaitForPhone,
} from './passkey-pairing';
import { buildSessionCookie, createSessionToken } from './session';
import { handle } from '../../hooks.server';
import { GET as pairPage } from '../../routes/auth/passkey/pair/+server';
import { GET as pairClient } from '../../routes/auth/passkey/pair/client.js/+server';
import { POST as joinRoute } from '../../routes/auth/passkey/pair/join/+server';
import { POST as optionsRoute } from '../../routes/auth/passkey/pair/options/+server';
import { POST as verifyRoute } from '../../routes/auth/passkey/pair/verify/+server';
import { GET as creatorStatus, POST as creatorAction } from '../../routes/mail/passkeys/pair/+server';
import { load as settingsPageLoad } from '../../routes/mail/passkeys/+page.server';

const ORIGIN = 'https://mail.example.test';
const SESSION_SECRET = 'test-only-session-secret-0123456789abcdef';
const IP = '192.0.2.20';

let fixture: Fixture;
let env: Record<string, unknown> & { DB: D1Database; SESSION_SECRET: string };
let rp: RelyingParty;

function userRow(id: string): User {
  return fixture.db.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User;
}

function count(sql: string, ...args: (string | number)[]): number {
  return Number((fixture.db.sqlite.prepare(sql).get(...args) as { n: number }).n);
}

function enable(on = true): void {
  fixture.db.sqlite.prepare(
    `INSERT INTO org_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PASSKEY_SETTING_ENABLED, on ? 'true' : 'false');
}

async function ordinarySession(userId: string, minutesAgo = 0): Promise<string> {
  const session = await createSessionToken(userId, SESSION_SECRET, 60 * 60 * 1000);
  fixture.db.sqlite.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, issued_at, expires_at, revoked)
     VALUES (?, ?, ?, datetime('now', ?), datetime('now', '+1 hour'), 0)`,
  ).run(session.sessionId, userId, session.hash, `-${minutesAgo} minutes`);
  void buildSessionCookie;
  return session.sessionId;
}

function phoneRequest(userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'): Request {
  return new Request(`${ORIGIN}/auth/passkey/pair/join`, { method: 'POST', headers: { 'user-agent': userAgent } });
}

/** Alice makes an offer from a fresh session. */
async function offer(userId = 'user-alice') {
  const sessionId = await ordinarySession(userId);
  const created = await createPairing(env, userRow(userId), sessionId, { clientIp: IP });
  if (!created.ok) throw new Error(`create refused: ${created.error}`);
  return { sessionId, ...created, token: created.token };
}

async function joined(userId = 'user-alice') {
  const made = await offer(userId);
  const result = await joinPairing(env, phoneRequest(), { token: made.token }, IP);
  if (!result.ok) throw new Error(`join refused: ${result.message}`);
  return { ...made, joiner: result.joiner, label: result.deviceLabel, code: result.code };
}

async function approved(userId = 'user-alice') {
  const made = await joined(userId);
  const result = await approvePairing(env, userRow(userId), made.sessionId, made.pairingId, made.code, { clientIp: IP });
  if (!result.ok) throw new Error(`approve refused: ${result.error}`);
  return made;
}

function state(pairingId: string): string {
  return (fixture.db.sqlite.prepare('SELECT state FROM passkey_pairings WHERE id = ?').get(pairingId) as { state: string }).state;
}

beforeEach(() => {
  fixture = createFixture({ SESSION_SECRET });
  env = fixture.env as typeof env;
  rp = relyingParty(env)!;
  enable();
});

describe('migration 0034', () => {
  it('stores only a 64-character token hash and keeps it unique', () => {
    const insert = (id: string, hash: string, state = 'offered') => fixture.db.sqlite.prepare(
      `INSERT INTO passkey_pairings (id, user_id, session_id, token_hash, state, expires_at) VALUES (?, 'user-alice', 's', ?, ?, 99999999999)`,
    ).run(id, hash, state);
    insert('00000000-0000-0000-0000-000000000001', 'a'.repeat(64));
    expect(() => insert('00000000-0000-0000-0000-000000000002', 'a'.repeat(64))).toThrow();
    expect(() => insert('00000000-0000-0000-0000-000000000003', 'short')).toThrow();
    expect(() => insert('00000000-0000-0000-0000-000000000004', 'b'.repeat(64), 'bogus')).toThrow();
  });

  it('deletes pairings with the account', () => {
    fixture.db.sqlite.exec(`INSERT INTO users (id, email, display_name, role, status) VALUES ('user-cascade', 'cascade@example.test', 'Cascade', 'standard', 'active');
      INSERT INTO passkey_pairings (id, user_id, session_id, token_hash, state, expires_at)
      VALUES ('00000000-0000-0000-0000-000000000005', 'user-cascade', 's', '${'c'.repeat(64)}', 'offered', 99999999999)`);
    fixture.db.sqlite.exec(`DELETE FROM users WHERE id = 'user-cascade'`);
    expect(count('SELECT COUNT(*) AS n FROM passkey_pairings')).toBe(0);
  });
});

describe('creating an offer', () => {
  it('stores a hash, never the token, and audits it', async () => {
    const made = await offer();
    expect(made.secondsLeft).toBe(PAIRING_TTL_SECONDS);
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = fixture.db.sqlite.prepare('SELECT token_hash, state FROM passkey_pairings WHERE id = ?').get(made.pairingId) as { token_hash: string; state: string };
    expect(row.state).toBe('offered');
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(fixture.db.sqlite.prepare('SELECT * FROM passkey_pairings').all())).not.toContain(made.token);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_pair_started'`)).toBe(1);
  });

  it('needs a session opened in the last 15 minutes, and never a passkey session', async () => {
    const stale = await ordinarySession('user-alice', 20);
    const refused = await createPairing(env, userRow('user-alice'), stale, { clientIp: IP });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect(await createPairing(env, userRow('user-alice'), null, { clientIp: IP })).toMatchObject({ ok: false, status: 403 });

    fixture.db.sqlite.exec(`INSERT INTO passkey_credentials (id, user_id, user_handle, public_key, device_name)
      VALUES ('${'p'.repeat(22)}', 'user-alice', '${'h'.repeat(43)}', '${'k'.repeat(40)}', 'Old')`);
    const viaPasskey = await ordinarySession('user-alice');
    fixture.db.sqlite.prepare('UPDATE sessions SET passkey_credential_id = ? WHERE id = ?').run('p'.repeat(22), viaPasskey);
    expect(await createPairing(env, userRow('user-alice'), viaPasskey, { clientIp: IP })).toMatchObject({ ok: false, status: 403 });
    expect(count('SELECT COUNT(*) AS n FROM passkey_pairings')).toBe(0);
  });

  it('refuses an account that is not active', async () => {
    const sessionId = await ordinarySession('user-alice');
    fixture.db.sqlite.exec(`UPDATE users SET status = 'paused' WHERE id = 'user-alice'`);
    expect(await createPairing(env, userRow('user-alice'), sessionId, { clientIp: IP })).toMatchObject({ ok: false, status: 403 });
  });

  it('a new offer cancels the old one', async () => {
    const first = await offer();
    const second = await createPairing(env, userRow('user-alice'), first.sessionId, { clientIp: IP });
    expect(second.ok).toBe(true);
    expect(state(first.pairingId)).toBe('expired');
    expect(await joinPairing(env, phoneRequest(), { token: first.token }, IP)).toMatchObject({ ok: false, status: 404 });
  });

  it('is rate limited per person', async () => {
    const sessionId = await ordinarySession('user-alice');
    for (let index = 0; index < PAIRING_RATE_LIMITS.createPerUser.limit; index += 1) {
      expect((await createPairing(env, userRow('user-alice'), sessionId, { clientIp: IP })).ok).toBe(true);
    }
    expect(await createPairing(env, userRow('user-alice'), sessionId, { clientIp: IP })).toMatchObject({ ok: false, status: 429 });
  });
});

describe('joining', () => {
  it('moves offered to joined once and records a label from the user agent', async () => {
    const made = await offer();
    const result = await joinPairing(env, phoneRequest(), { token: made.token }, IP);
    expect(result).toMatchObject({ ok: true, deviceLabel: 'iPhone (Safari)' });
    expect(state(made.pairingId)).toBe('joined');
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_pair_joined'`)).toBe(1);
  });

  it('refuses reuse: a second phone with the same token gets nothing', async () => {
    const made = await offer();
    expect((await joinPairing(env, phoneRequest(), { token: made.token }, IP)).ok).toBe(true);
    expect(await joinPairing(env, phoneRequest(), { token: made.token }, IP)).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses an expired, unknown or malformed token the same way', async () => {
    const made = await offer();
    fixture.db.sqlite.prepare('UPDATE passkey_pairings SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, made.pairingId);
    const expired = await joinPairing(env, phoneRequest(), { token: made.token }, IP);
    const unknown = await joinPairing(env, phoneRequest(), { token: 'A'.repeat(43) }, IP);
    const malformed = await joinPairing(env, phoneRequest(), { token: 'nope' }, IP);
    const missing = await joinPairing(env, phoneRequest(), {}, IP);
    for (const result of [expired, unknown, malformed, missing]) expect(result).toMatchObject({ ok: false, status: 404 });
    expect(new Set([expired, unknown, malformed, missing].map((result) => JSON.stringify(result))).size).toBe(1);
    expect(state(made.pairingId)).toBe('offered');
  });

  it('refuses when the creator session is revoked or expired, or the account is paused', async () => {
    const revoked = await offer();
    fixture.db.sqlite.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(revoked.sessionId);
    expect(await joinPairing(env, phoneRequest(), { token: revoked.token }, IP)).toMatchObject({ ok: false, status: 404 });

    const paused = await offer();
    fixture.db.sqlite.exec(`UPDATE users SET status = 'paused' WHERE id = 'user-alice'`);
    expect(await joinPairing(env, phoneRequest(), { token: paused.token }, IP)).toMatchObject({ ok: false, status: 404 });
  });

  it('only one of two simultaneous joins wins', async () => {
    const made = await offer();
    const results = await Promise.all([
      joinPairing(env, phoneRequest(), { token: made.token }, '192.0.2.31'),
      joinPairing(env, phoneRequest(), { token: made.token }, '192.0.2.32'),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('locks an address out after repeated bad tokens, with the same 429 for everything', async () => {
    for (let index = 0; index < PAIRING_RATE_LIMITS.failuresPerIp.limit; index += 1) {
      expect(await joinPairing(env, phoneRequest(), { token: 'B'.repeat(43) }, '192.0.2.40')).toMatchObject({ status: 404 });
    }
    const made = await offer();
    expect(await joinPairing(env, phoneRequest(), { token: made.token }, '192.0.2.40')).toMatchObject({ ok: false, status: 429 });
    // Another address is unaffected.
    expect((await joinPairing(env, phoneRequest(), { token: made.token }, '192.0.2.41')).ok).toBe(true);
  });
});

describe('approving and denying', () => {
  it('approves once, only from the creating session', async () => {
    const made = await joined();
    const otherSession = await ordinarySession('user-alice');
    expect(await approvePairing(env, userRow('user-alice'), otherSession, made.pairingId, made.code, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(await approvePairing(env, userRow('user-bob'), await ordinarySession('user-bob'), made.pairingId, made.code, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(state(made.pairingId)).toBe('joined');
    expect((await approvePairing(env, userRow('user-alice'), made.sessionId, made.pairingId, made.code, { clientIp: IP })).ok).toBe(true);
    expect(await approvePairing(env, userRow('user-alice'), made.sessionId, made.pairingId, made.code, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_pair_approved'`)).toBe(1);
  });

  it('cannot approve before a phone joined, after expiry, or with a revoked session', async () => {
    const early = await offer();
    expect(await approvePairing(env, userRow('user-alice'), early.sessionId, early.pairingId, '00', { clientIp: IP })).toMatchObject({ ok: false, status: 409 });

    const late = await joined();
    fixture.db.sqlite.prepare('UPDATE passkey_pairings SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, late.pairingId);
    expect(await approvePairing(env, userRow('user-alice'), late.sessionId, late.pairingId, late.code, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });

    const dead = await joined();
    fixture.db.sqlite.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(dead.sessionId);
    expect(await approvePairing(env, userRow('user-alice'), dead.sessionId, dead.pairingId, dead.code, { clientIp: IP })).toMatchObject({ ok: false, status: 403 });
  });

  it('only one of two simultaneous approvals changes anything', async () => {
    const made = await joined();
    const results = await Promise.all([
      approvePairing(env, userRow('user-alice'), made.sessionId, made.pairingId, made.code, { clientIp: IP }),
      approvePairing(env, userRow('user-alice'), made.sessionId, made.pairingId, made.code, { clientIp: IP }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_pair_approved'`)).toBe(1);
  });

  it('deny ends the offer and the phone sees it', async () => {
    const made = await joined();
    expect((await denyPairing(env, userRow('user-alice'), made.sessionId, made.pairingId, { clientIp: IP })).ok).toBe(true);
    expect(state(made.pairingId)).toBe('denied');
    expect(await pairingWaitForPhone(env, { token: made.token, joiner: made.joiner }, IP)).toMatchObject({ ok: true, state: 'denied' });
    expect(await approvePairing(env, userRow('user-alice'), made.sessionId, made.pairingId, made.code, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(await denyPairing(env, userRow('user-alice'), made.sessionId, made.pairingId, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(await denyPairing(env, userRow('user-bob'), await ordinarySession('user-bob'), made.pairingId, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
  });

  it('rejects a malformed id', async () => {
    const sessionId = await ordinarySession('user-alice');
    expect(await approvePairing(env, userRow('user-alice'), sessionId, "1' OR '1'='1", '00', { clientIp: IP })).toMatchObject({ ok: false, status: 400 });
  });
});

describe('status', () => {
  it('reports the newest offer for this session only', async () => {
    const made = await joined();
    const status = await pairingStatus(env, userRow('user-alice'), made.sessionId, { clientIp: IP });
    expect(status).toMatchObject({ ok: true, status: { state: 'joined', deviceLabel: 'iPhone (Safari)', pairingId: made.pairingId } });
    const other = await pairingStatus(env, userRow('user-alice'), await ordinarySession('user-alice'), { clientIp: IP });
    expect(other).toMatchObject({ ok: true, status: { state: 'none' } });
  });

  it('marks an expired offer expired once and audits it once', async () => {
    const made = await offer();
    fixture.db.sqlite.prepare('UPDATE passkey_pairings SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, made.pairingId);
    expect(await pairingStatus(env, userRow('user-alice'), made.sessionId, { clientIp: IP })).toMatchObject({ ok: true, status: { state: 'expired', secondsLeft: 0 } });
    await pairingStatus(env, userRow('user-alice'), made.sessionId, { clientIp: IP });
    expect(state(made.pairingId)).toBe('expired');
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_pair_expired'`)).toBe(1);
  });
});

describe('the phone gets nothing until approved', () => {
  it('refuses options before approval and creates no challenge', async () => {
    const made = await joined();
    const before = count('SELECT COUNT(*) AS n FROM passkey_challenges');
    expect(await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, IP)).toMatchObject({ ok: false, status: 404 });
    expect(count('SELECT COUNT(*) AS n FROM passkey_challenges')).toBe(before);
    expect(await pairingWaitForPhone(env, { token: made.token, joiner: made.joiner }, IP)).toMatchObject({ ok: true, state: 'joined' });
  });

  it('refuses anyone who has the token but not the phone secret', async () => {
    const made = await approved();
    const body = { token: made.token, joiner: 'C'.repeat(43) };
    expect(await pairingRegistrationOptions(env, rp, body, '192.0.2.50')).toMatchObject({ ok: false, status: 404 });
    expect(await pairingWaitForPhone(env, body, '192.0.2.50')).toMatchObject({ ok: false, status: 404 });
    expect(await finishPairing(env, rp, { ...body, challengeId: 'x', response: {} }, { clientIp: '192.0.2.50' })).toMatchObject({ ok: false, status: 404 });
    expect(state(made.pairingId)).toBe('approved');
  });

  it('refuses options when the creator session has ended', async () => {
    const made = await approved();
    fixture.db.sqlite.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(made.sessionId);
    expect(await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, IP)).toMatchObject({ ok: false, status: 403 });
  });
});

describe('the whole pairing', () => {
  it('adds the passkey to the same account and then cannot be used again', async () => {
    const made = await approved();
    const phone = await SoftAuthenticator.create();
    const start = await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, IP);
    if (!start.ok) throw new Error(start.message);
    const response = await phone.register(start.options, { rpId: rp.rpID, origin: rp.origin });
    const finished = await finishPairing(env, rp, { token: made.token, joiner: made.joiner, challengeId: start.challengeId, response }, { clientIp: IP });
    expect(finished).toMatchObject({ ok: true, passkey: { deviceName: 'iPhone (Safari)' } });
    expect(state(made.pairingId)).toBe('consumed');
    expect(await listPasskeys(env.DB, 'user-alice')).toHaveLength(1);
    expect(count(`SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = 'user-alice'`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_registered'`)).toBe(1);

    // Used up: options, verify and status all refuse.
    expect(await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, IP)).toMatchObject({ ok: false, status: 404 });
    expect(await finishPairing(env, rp, { token: made.token, joiner: made.joiner, challengeId: start.challengeId, response }, { clientIp: IP })).toMatchObject({ ok: false, status: 404 });
    expect(await pairingStatus(env, userRow('user-alice'), made.sessionId, { clientIp: IP })).toMatchObject({ ok: true, status: { state: 'consumed' } });
  });

  it('puts the offer back to approved after a failed attempt, so the phone can try again', async () => {
    const made = await approved();
    const start = await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, IP);
    if (!start.ok) throw new Error(start.message);
    const failed = await finishPairing(env, rp, { token: made.token, joiner: made.joiner, challengeId: start.challengeId, response: { id: 'x' } }, { clientIp: IP });
    expect(failed).toMatchObject({ ok: false, status: 400 });
    expect(state(made.pairingId)).toBe('approved');
    expect(count('SELECT COUNT(*) AS n FROM passkey_credentials')).toBe(0);
  });

  it('two simultaneous verifies store one passkey at most', async () => {
    const made = await approved();
    const phone = await SoftAuthenticator.create();
    const start = await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, IP);
    if (!start.ok) throw new Error(start.message);
    const response = await phone.register(start.options, { rpId: rp.rpID, origin: rp.origin });
    const body = { token: made.token, joiner: made.joiner, challengeId: start.challengeId, response };
    const results = await Promise.all([
      finishPairing(env, rp, body, { clientIp: IP }),
      finishPairing(env, rp, body, { clientIp: IP }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(count('SELECT COUNT(*) AS n FROM passkey_credentials')).toBe(1);
  });

  it('refuses to store a passkey once the account has ten', async () => {
    for (let index = 0; index < 10; index += 1) {
      fixture.db.sqlite.prepare(`INSERT INTO passkey_credentials (id, user_id, user_handle, public_key, device_name)
        VALUES (?, 'user-alice', '${'h'.repeat(43)}', '${'k'.repeat(40)}', 'Key')`).run(`${'z'.repeat(21)}${index}`);
    }
    const sessionId = await ordinarySession('user-alice');
    expect(await createPairing(env, userRow('user-alice'), sessionId, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
  });
});

describe('device labels', () => {
  it('are short and come only from known words', () => {
    expect(deviceLabelFromUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('Android phone (Chrome)');
    expect(deviceLabelFromUserAgent('<script>alert(1)</script>')).toBe('Phone');
    expect(deviceLabelFromUserAgent(null)).toBe('Phone');
    expect(deviceLabelFromUserAgent('x'.repeat(5000)).length).toBeLessThanOrEqual(64);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────

function routeEvent(path: string, method = 'GET', body?: unknown, user: User | null = null, sessionId: string | null = null, headers: Record<string, string> = {}) {
  const url = new URL(path, ORIGIN);
  return {
    url,
    request: new Request(url, {
      method,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP, ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
    platform: fixture.platform,
    locals: { user, sessionId },
    setHeaders: () => undefined,
  } as never;
}

describe('routes', () => {
  it('answer 404 everywhere while the manager switch is off', async () => {
    enable(false);
    const sessionId = await ordinarySession('user-alice');
    const alice = userRow('user-alice');
    for (const call of [
      () => pairPage(routeEvent('/auth/passkey/pair')),
      () => pairClient(routeEvent('/auth/passkey/pair/client.js')),
      () => joinRoute(routeEvent('/auth/passkey/pair/join', 'POST', {})),
      () => optionsRoute(routeEvent('/auth/passkey/pair/options', 'POST', {})),
      () => verifyRoute(routeEvent('/auth/passkey/pair/verify', 'POST', {})),
      () => creatorStatus(routeEvent('/mail/passkeys/pair', 'GET', undefined, alice, sessionId)),
      () => creatorAction(routeEvent('/mail/passkeys/pair', 'POST', { action: 'create' }, alice, sessionId)),
      () => creatorAction(routeEvent('/mail/passkeys/pair', 'POST', { action: 'create' })),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
    }
  });

  it('answer 404 on any other origin', async () => {
    const other = (path: string) => ({ ...(routeEvent(path, 'POST', {}) as object), url: new URL(path, 'https://cmail-example.pages.dev') }) as never;
    await expect(joinRoute(other('/auth/passkey/pair/join'))).rejects.toMatchObject({ status: 404 });
  });

  it('serve the phone page with a strict CSP and no token or remote file', async () => {
    const response = await pairPage(routeEvent('/auth/passkey/pair'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).toContain('/auth/passkey/pair/client.js');
    expect(html).toContain('<noscript>');
    expect(html).not.toMatch(/\/_app\//);
    const script = await (await pairClient(routeEvent('/auth/passkey/pair/client.js'))).text();
    expect(script).toContain('location.hash');
    expect(script).toContain('replaceState');
  });

  it('creator side: 401 signed out, 403 stale session, 429 over the limit, 400 on junk', async () => {
    expect((await creatorAction(routeEvent('/mail/passkeys/pair', 'POST', { action: 'create' }))).status).toBe(401);
    expect((await creatorStatus(routeEvent('/mail/passkeys/pair'))).status).toBe(401);

    const alice = userRow('user-alice');
    const stale = await ordinarySession('user-alice', 30);
    expect((await creatorAction(routeEvent('/mail/passkeys/pair', 'POST', { action: 'create' }, alice, stale))).status).toBe(403);

    const fresh = await ordinarySession('user-alice');
    expect((await creatorAction(routeEvent('/mail/passkeys/pair', 'POST', { action: 'nope' }, alice, fresh))).status).toBe(400);
    expect((await creatorAction(routeEvent('/mail/passkeys/pair', 'POST', '{not json', alice, fresh))).status).toBe(400);
    const created = await creatorAction(routeEvent('/mail/passkeys/pair', 'POST', { action: 'create' }, alice, fresh));
    expect(created.status).toBe(200);
    const body = await created.json() as { pairUrl: string; pairingId: string };
    expect(body.pairUrl).toMatch(new RegExp(`^${ORIGIN}/auth/passkey/pair#[A-Za-z0-9_-]{43}$`));
    expect(created.headers.get('cache-control')).toContain('no-store');

    for (let index = 1; index < PAIRING_RATE_LIMITS.createPerUser.limit; index += 1) {
      expect((await creatorAction(routeEvent('/mail/passkeys/pair', 'POST', { action: 'create' }, alice, fresh))).status).toBe(200);
    }
    expect((await creatorAction(routeEvent('/mail/passkeys/pair', 'POST', { action: 'create' }, alice, fresh))).status).toBe(429);
  });

  it('phone side: 404 for a bad token, 429 after repeated misses, 400 for junk bodies', async () => {
    expect((await joinRoute(routeEvent('/auth/passkey/pair/join', 'POST', '{nope'))).status).toBe(400);
    expect((await joinRoute(routeEvent('/auth/passkey/pair/join', 'POST', { token: 'D'.repeat(43) }))).status).toBe(404);
    expect((await optionsRoute(routeEvent('/auth/passkey/pair/options', 'POST', { token: 'D'.repeat(43), joiner: 'D'.repeat(43) }))).status).toBe(404);
    expect((await verifyRoute(routeEvent('/auth/passkey/pair/verify', 'POST', { token: 'D'.repeat(43) }))).status).toBe(404);
    const big = JSON.stringify({ token: 'x'.repeat(10_000) });
    expect((await joinRoute(routeEvent('/auth/passkey/pair/join', 'POST', big))).status).toBe(413);
    let last = 0;
    for (let index = 0; index < PAIRING_RATE_LIMITS.failuresPerIp.limit + 1; index += 1) {
      last = (await joinRoute(routeEvent('/auth/passkey/pair/join', 'POST', { token: 'E'.repeat(43) }))).status;
    }
    expect(last).toBe(429);
  });

  it('the routes drive a whole pairing end to end', async () => {
    const alice = userRow('user-alice');
    const sessionId = await ordinarySession('user-alice');
    const created = await (await creatorAction(routeEvent('/mail/passkeys/pair', 'POST', { action: 'create' }, alice, sessionId))).json() as { pairUrl: string; pairingId: string };
    const token = created.pairUrl.split('#')[1];

    const joinedBody = await (await joinRoute(routeEvent('/auth/passkey/pair/join', 'POST', { token }, null, null, { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1' }))).json() as { joiner: string; code: string };
    const waiting = await (await optionsRoute(routeEvent('/auth/passkey/pair/options', 'POST', { token, joiner: joinedBody.joiner, wait: true }))).json() as { state: string };
    expect(waiting.state).toBe('joined');
    expect((await optionsRoute(routeEvent('/auth/passkey/pair/options', 'POST', { token, joiner: joinedBody.joiner }))).status).toBe(404);

    const seen = await (await creatorStatus(routeEvent('/mail/passkeys/pair', 'GET', undefined, alice, sessionId))).json() as { state: string; deviceLabel: string };
    expect(seen).toMatchObject({ state: 'joined', deviceLabel: 'iPhone (Safari)' });
    expect((await creatorAction(routeEvent('/mail/passkeys/pair', 'POST', { action: 'approve', pairingId: created.pairingId, code: joinedBody.code }, alice, sessionId))).status).toBe(200);

    const start = await (await optionsRoute(routeEvent('/auth/passkey/pair/options', 'POST', { token, joiner: joinedBody.joiner }))).json() as { challengeId: string; options: Parameters<SoftAuthenticator['register']>[0] };
    const phone = await SoftAuthenticator.create();
    const response = await phone.register(start.options, { rpId: rp.rpID, origin: rp.origin });
    const finished = await verifyRoute(routeEvent('/auth/passkey/pair/verify', 'POST', { token, joiner: joinedBody.joiner, challengeId: start.challengeId, response }));
    expect(finished.status).toBe(200);
    expect(count(`SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = 'user-alice'`)).toBe(1);

    const page = await settingsPageLoad(routeEvent('/mail/passkeys', 'GET', undefined, alice, sessionId)) as unknown as { pairingAvailable: boolean; passkeys: unknown[] };
    expect(page.pairingAvailable).toBe(true);
    expect(page.passkeys).toHaveLength(1);
  });
});

// ─── Review fixes: number match, freshness, one open offer, challenge binding ──

describe('number match', () => {
  it('shows the phone a two-digit code and the approver three stable choices that include it', async () => {
    const made = await joined();
    expect(made.code).toMatch(/^\d{2}$/);
    const first = await pairingStatus(env, userRow('user-alice'), made.sessionId, { clientIp: IP });
    const second = await pairingStatus(env, userRow('user-alice'), made.sessionId, { clientIp: IP });
    if (!first.ok || !second.ok) throw new Error('status refused');
    expect(first.status.choices).toHaveLength(3);
    expect(new Set(first.status.choices).size).toBe(3);
    expect(first.status.choices).toContain(made.code);
    expect(second.status.choices).toEqual(first.status.choices);
    expect([...first.status.choices].sort()).toEqual(first.status.choices);
    // No choices before a phone joins.
    const early = await offer();
    expect(await pairingStatus(env, userRow('user-alice'), early.sessionId, { clientIp: IP })).toMatchObject({ ok: true, status: { choices: [] } });
  });

  it('approves only with the right number', async () => {
    const made = await joined();
    const wrong = ['00', '01', '02', '03'].find((value) => value !== made.code)!;
    expect(await approvePairing(env, userRow('user-alice'), made.sessionId, made.pairingId, wrong, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(state(made.pairingId)).toBe('joined');
    expect((await approvePairing(env, userRow('user-alice'), made.sessionId, made.pairingId, made.code, { clientIp: IP })).ok).toBe(true);
    expect(state(made.pairingId)).toBe('approved');
  });

  it('three wrong picks cancel the offer, and the right number then does nothing', async () => {
    const made = await joined();
    const wrong = ['00', '01'].find((value) => value !== made.code)!;
    for (let index = 0; index < 2; index += 1) {
      expect(await approvePairing(env, userRow('user-alice'), made.sessionId, made.pairingId, wrong, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
      expect(state(made.pairingId)).toBe('joined');
    }
    expect(await approvePairing(env, userRow('user-alice'), made.sessionId, made.pairingId, wrong, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(state(made.pairingId)).toBe('denied');
    expect(await approvePairing(env, userRow('user-alice'), made.sessionId, made.pairingId, made.code, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_pair_denied'`)).toBe(1);
    expect(await pairingWaitForPhone(env, { token: made.token, joiner: made.joiner }, IP)).toMatchObject({ ok: true, state: 'denied' });
  });

  it('rejects a missing or malformed number and shows the phone country to the approver', async () => {
    const sessionId = await ordinarySession('user-alice');
    const created = await createPairing(env, userRow('user-alice'), sessionId, { clientIp: IP });
    if (!created.ok) throw new Error('create');
    const request = new Request(`${ORIGIN}/auth/passkey/pair/join`, { method: 'POST', headers: { 'user-agent': 'iPhone Safari/604.1', 'cf-ipcountry': 'au' } });
    expect((await joinPairing(env, request, { token: created.token }, IP)).ok).toBe(true);
    for (const bad of [undefined, '', '1', '123', 'ab', 12]) {
      expect(await approvePairing(env, userRow('user-alice'), sessionId, created.pairingId, bad, { clientIp: IP })).toMatchObject({ ok: false, status: 400 });
    }
    expect(await pairingStatus(env, userRow('user-alice'), sessionId, { clientIp: IP })).toMatchObject({ ok: true, status: { state: 'joined', country: 'AU' } });
  });
});

describe('session freshness at create', () => {
  it('refuses a session too old to outlast the offer (minute 14) and accepts a young one (minute 4)', async () => {
    const old = await ordinarySession('user-alice', 14);
    const refused = await createPairing(env, userRow('user-alice'), old, { clientIp: IP });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect(refused.ok ? '' : refused.error).toContain('within 5 minutes');
    expect(count('SELECT COUNT(*) AS n FROM passkey_pairings')).toBe(0);
    const young = await ordinarySession('user-alice', 4);
    expect((await createPairing(env, userRow('user-alice'), young, { clientIp: IP })).ok).toBe(true);
  });
});

describe('one open offer per person', () => {
  it('the database refuses a second open offer, and allows closed ones', () => {
    const insert = (id: string, hash: string, stateName: string) => fixture.db.sqlite.prepare(
      `INSERT INTO passkey_pairings (id, user_id, session_id, token_hash, state, expires_at) VALUES (?, 'user-alice', 's', ?, ?, 99999999999)`,
    ).run(id, hash, stateName);
    insert('00000000-0000-0000-0000-0000000000a1', '1'.repeat(64), 'joined');
    expect(() => insert('00000000-0000-0000-0000-0000000000a2', '2'.repeat(64), 'offered')).toThrow();
    insert('00000000-0000-0000-0000-0000000000a3', '3'.repeat(64), 'denied');
    insert('00000000-0000-0000-0000-0000000000a4', '4'.repeat(64), 'consumed');
  });

  it('two simultaneous creates leave exactly one open offer and audit the cancel', async () => {
    const one = await ordinarySession('user-alice');
    const two = await ordinarySession('user-alice');
    const results = await Promise.all([
      createPairing(env, userRow('user-alice'), one, { clientIp: IP }),
      createPairing(env, userRow('user-alice'), two, { clientIp: IP }),
    ]);
    expect(results.filter((result) => result.ok).length).toBeGreaterThanOrEqual(1);
    expect(count(`SELECT COUNT(*) AS n FROM passkey_pairings WHERE user_id = 'user-alice' AND state IN ('offered', 'joined', 'approved')`)).toBe(1);
    if (results.every((result) => result.ok)) {
      expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'auth.passkey_pair_expired' AND detail LIKE '%cancelled by a new one%'`)).toBe(1);
    }
  });
});

describe('challenge binding', () => {
  it('verify must present the challenge issued to this offer', async () => {
    const made = await approved();
    const phone = await SoftAuthenticator.create();
    const start = await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, IP);
    if (!start.ok) throw new Error(start.message);
    // A challenge from a different flow (an ordinary registration by the same person).
    const other = await startRegistration(env, rp, userRow('user-alice'), made.sessionId);
    if (!other.ok) throw new Error(other.error);
    const foreign = await phone.register(other.options, { rpId: rp.rpID, origin: rp.origin });
    const refused = await finishPairing(env, rp, { token: made.token, joiner: made.joiner, challengeId: other.challengeId, response: foreign }, { clientIp: IP });
    expect(refused).toMatchObject({ ok: false, status: 400 });
    expect(await finishPairing(env, rp, { token: made.token, joiner: made.joiner, response: foreign }, { clientIp: IP })).toMatchObject({ ok: false, status: 400 });
    expect(state(made.pairingId)).toBe('approved');
    expect(count('SELECT COUNT(*) AS n FROM passkey_credentials')).toBe(0);
    const response = await phone.register(start.options, { rpId: rp.rpID, origin: rp.origin });
    expect(await finishPairing(env, rp, { token: made.token, joiner: made.joiner, challengeId: start.challengeId, response }, { clientIp: IP })).toMatchObject({ ok: true });
  });

  it('a new options request replaces the bound challenge, so the old one cannot finish', async () => {
    const made = await approved();
    const phone = await SoftAuthenticator.create();
    const first = await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, IP);
    const second = await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, IP);
    if (!first.ok || !second.ok) throw new Error('options');
    const response = await phone.register(first.options, { rpId: rp.rpID, origin: rp.origin });
    expect(await finishPairing(env, rp, { token: made.token, joiner: made.joiner, challengeId: first.challengeId, response }, { clientIp: IP })).toMatchObject({ ok: false, status: 400 });
  });
});

describe('consumed means a passkey exists', () => {
  it('reads as finishing until the stored passkey is confirmed', async () => {
    const made = await approved();
    fixture.db.sqlite.prepare(`UPDATE passkey_pairings SET state = 'consumed' WHERE id = ?`).run(made.pairingId);
    expect(await pairingStatus(env, userRow('user-alice'), made.sessionId, { clientIp: IP })).toMatchObject({ ok: true, status: { state: 'finishing' } });
    fixture.db.sqlite.prepare(`UPDATE passkey_pairings SET credential_id = ? WHERE id = ?`).run('x'.repeat(22), made.pairingId);
    expect(await pairingStatus(env, userRow('user-alice'), made.sessionId, { clientIp: IP })).toMatchObject({ ok: true, status: { state: 'finishing' } });
    fixture.db.sqlite.exec(`INSERT INTO passkey_credentials (id, user_id, user_handle, public_key, device_name)
      VALUES ('${'x'.repeat(22)}', 'user-alice', '${'h'.repeat(43)}', '${'k'.repeat(40)}', 'Phone')`);
    expect(await pairingStatus(env, userRow('user-alice'), made.sessionId, { clientIp: IP })).toMatchObject({ ok: true, status: { state: 'consumed' } });
  });
});

describe('no address, no shared bucket', () => {
  it('the phone endpoints refuse a request with no connecting address', async () => {
    const made = await approved();
    expect(await joinPairing(env, phoneRequest(), { token: made.token }, '')).toMatchObject({ ok: false, status: 400 });
    expect(await pairingWaitForPhone(env, { token: made.token, joiner: made.joiner }, '')).toMatchObject({ ok: false, status: 400 });
    expect(await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, '')).toMatchObject({ ok: false, status: 400 });
    expect(await finishPairing(env, rp, { token: made.token, joiner: made.joiner }, { clientIp: '' })).toMatchObject({ ok: false, status: 400 });
    const noHeader = { 'cf-connecting-ip': '' };
    expect((await joinRoute(routeEvent('/auth/passkey/pair/join', 'POST', { token: made.token }, null, null, noHeader))).status).toBe(400);
    expect((await optionsRoute(routeEvent('/auth/passkey/pair/options', 'POST', { token: made.token, joiner: made.joiner, wait: true }, null, null, noHeader))).status).toBe(400);
    expect(count(`SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE '%unknown%'`)).toBe(0);
  });
});

describe('polling', () => {
  it('has its own, larger bucket than failed guesses', () => {
    expect(PAIRING_RATE_LIMITS.pollPerIp.limit).toBeGreaterThanOrEqual(600);
    expect(PAIRING_RATE_LIMITS.pollPerIp.limit).toBeGreaterThan(PAIRING_RATE_LIMITS.failuresPerIp.limit * 10);
  });

  it('the phone script retries network errors and 429 with a growing delay and words every end state', async () => {
    const script = await (await pairClient(routeEvent('/auth/passkey/pair/client.js'))).text();
    expect(script).toContain('error.status === 429');
    expect(script).toContain('error.status === undefined');
    expect(script).toContain('Math.min(30000, delay * 2)');
    expect(script).toContain('already used');
    expect(script).toContain('has expired');
    expect(script).toContain('pair-code');
  });
});

describe('secrets stay out of audit rows and console output', () => {
  it('a whole pairing writes no token or phone secret to audit detail or the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
    const made = await approved();
    const phone = await SoftAuthenticator.create();
    const start = await pairingRegistrationOptions(env, rp, { token: made.token, joiner: made.joiner }, IP);
    if (!start.ok) throw new Error(start.message);
    const response = await phone.register(start.options, { rpId: rp.rpID, origin: rp.origin });
    await finishPairing(env, rp, { token: made.token, joiner: made.joiner, challengeId: start.challengeId, response }, { clientIp: IP });
    await joinPairing(env, phoneRequest(), { token: made.token }, IP); // a refused reuse
    const auditRows = JSON.stringify(fixture.db.sqlite.prepare('SELECT event_type, target, detail, ip_address, session_id FROM audit_log').all());
    expect(auditRows).not.toContain(made.token);
    expect(auditRows).not.toContain(made.joiner);
    expect(auditRows).not.toMatch(/token_hash|joiner_hash|approve_code/);
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(made.token);
    expect(logged).not.toContain(made.joiner);
    for (const spy of spies) spy.mockRestore();
  });
});

describe('creator-side refusals', () => {
  it('another session or person cannot approve or deny', async () => {
    const made = await joined();
    const otherSession = await ordinarySession('user-alice');
    const bob = await ordinarySession('user-bob');
    expect(await denyPairing(env, userRow('user-alice'), otherSession, made.pairingId, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(await denyPairing(env, userRow('user-bob'), bob, made.pairingId, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(await approvePairing(env, userRow('user-bob'), bob, made.pairingId, made.code, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(await approvePairing(env, userRow('user-alice'), otherSession, made.pairingId, made.code, { clientIp: IP })).toMatchObject({ ok: false, status: 409 });
    expect(state(made.pairingId)).toBe('joined');
  });

  it('the status GET is no-store and a different person sees nothing of the offer', async () => {
    const made = await joined();
    const alice = userRow('user-alice');
    const response = await creatorStatus(routeEvent('/mail/passkeys/pair', 'GET', undefined, alice, made.sessionId));
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await response.json() as { state: string }).state).toBe('joined');
    const bob = await creatorStatus(routeEvent('/mail/passkeys/pair', 'GET', undefined, userRow('user-bob'), await ordinarySession('user-bob')));
    expect((await bob.json() as { state: string }).state).toBe('none');
  });
});

// ─── Through hooks.server.ts: the real Origin check and headers ─────────────

describe('through hooks handle', () => {
  async function viaHooks(path: string, method: string, headers: Record<string, string>, body: unknown, route: (event: never) => Promise<Response> | Response, user: User | null = null, sessionId: string | null = null) {
    const url = new URL(path, ORIGIN);
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const event = {
      url,
      request,
      locals: { user, sessionId, passkeySession: false as boolean | undefined },
      platform: { env, context: { waitUntil: vi.fn() }, caches: {} },
      setHeaders: () => undefined,
    };
    return await (handle as never as (input: unknown) => Promise<Response>)({ event, resolve: async () => route(event as never) });
  }
  const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

  it('the phone POSTs get past the Origin check with the real same-origin Origin', async () => {
    const fresh = await offer();
    const joinResponse = await viaHooks('/auth/passkey/pair/join', 'POST', same, { token: fresh.token }, joinRoute);
    expect(joinResponse.status).toBe(200);
    const { joiner } = await joinResponse.json() as { joiner: string };
    const waitResponse = await viaHooks('/auth/passkey/pair/options', 'POST', same, { token: fresh.token, joiner, wait: true }, optionsRoute);
    expect(waitResponse.status).toBe(200);
    expect(await waitResponse.json()).toMatchObject({ state: 'joined' });
    // Options and verify before approval are refused by the server (404), never by the Origin check (403).
    const optionsResponse = await viaHooks('/auth/passkey/pair/options', 'POST', same, { token: fresh.token, joiner }, optionsRoute);
    const verifyResponse = await viaHooks('/auth/passkey/pair/verify', 'POST', same, { token: fresh.token, joiner, challengeId: 'x', response: {} }, verifyRoute);
    expect(optionsResponse.status).toBe(404);
    expect(verifyResponse.status).toBe(400);
  });

  it('would refuse Origin: null, which is what a no-referrer page sends', async () => {
    const fresh = await offer();
    const response = await viaHooks('/auth/passkey/pair/join', 'POST', { origin: 'null' }, { token: fresh.token }, joinRoute);
    expect(response.status).toBe(403);
  });

  it('refuses a cross-origin POST to the signed-in route and allows the same origin', async () => {
    const session = await createSessionToken('user-alice', SESSION_SECRET, 60 * 60 * 1000);
    fixture.db.sqlite.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, issued_at, expires_at, revoked) VALUES (?, 'user-alice', ?, datetime('now'), datetime('now', '+1 hour'), 0)`,
    ).run(session.sessionId, session.hash);
    const cookie = buildSessionCookie(session.token, true).split(';', 1)[0];
    const sessionId = session.sessionId;
    const alice = userRow('user-alice');
    const evil = await viaHooks('/mail/passkeys/pair', 'POST', { origin: 'https://evil.example.test', 'sec-fetch-site': 'cross-site' }, { action: 'create' }, creatorAction, alice, sessionId);
    expect(evil.status).toBe(403);
    expect(count('SELECT COUNT(*) AS n FROM passkey_pairings')).toBe(0);
    // Through hooks the person comes from the session cookie, as in production.
    const ok = await viaHooks('/mail/passkeys/pair', 'POST', { ...same, cookie }, { action: 'create' }, creatorAction);
    expect(ok.status).toBe(200);
    expect(count('SELECT COUNT(*) AS n FROM passkey_pairings')).toBe(1);
  });

  it('sends the Referrer-Policy hooks really sets, and the phone page asks for no other', async () => {
    const response = await viaHooks('/auth/passkey/pair', 'GET', {}, undefined, pairPage);
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    const html = await response.text();
    expect(html).not.toMatch(/name="referrer"/);
  });
});
