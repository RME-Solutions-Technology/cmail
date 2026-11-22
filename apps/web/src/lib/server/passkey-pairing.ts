// "Add a phone" with a QR code (docs/passkeys.md, "Add a phone").
//
// A signed-in person (ordinary session, opened in the last few minutes) makes
// a one-time pairing offer. A phone that scans its QR code joins it, the
// person approves that phone on the page they are signed in on, and only then
// does the phone get registration options and create a passkey for the same
// account. Everything that stores a passkey is the existing
// startRegistration / finishRegistration in passkeys.ts; this module only
// decides whether the phone may call them.
//
// Rules (tests: passkey-pairing.test.ts):
// - The token is 256 random bits, shown once in the QR code's URL fragment
//   (never sent to a server by the browser), stored only as a SHA-256 hash,
//   valid PAIRING_TTL_SECONDS and usable once.
// - Every state change is ONE conditional UPDATE (state, expiry, owner and
//   live creator session in its WHERE clause), so a race binds nothing: of
//   two simultaneous calls, one changes a row and the other changes none.
// - The phone that joins gets a second random secret (stored hashed). Options
//   and verify need both the token and that secret, so someone who only saw
//   the QR code cannot ride along after the person approves the real phone.
// - The creator's session must be live at every step, and only that session
//   can approve or deny. A new offer cancels the old one.
// - The device label comes from the phone's user agent. It is only shown to
//   the approver; never trusted.
// - Rate limits count per address (IPv6 per /64) and per person.
// - Everything answers 404 while the manager switch is off (the routes use
//   passkeyRouteContext), and a failure on an unknown or used token says
//   nothing about why.
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import type { User } from '@cmail/shared/types';
import { audit } from './db';
import { consumeRateLimit, rateLimitCount } from './rate-limit';
import {
  MANAGE_REFUSAL_MESSAGES,
  MAX_PASSKEYS_PER_USER,
  RATE_LIMITED_MESSAGE,
  finishRegistration,
  manageRefusal,
  rateLimitAddressKey,
  startRegistration,
  type PasskeySummary,
  type RelyingParty,
} from './passkeys';

export const PAIRING_TTL_SECONDS = 10 * 60;
export const PAIRING_NEUTRAL_MESSAGE = 'This pairing link is not valid any more. Start again on your computer.';

/** Pairing rate limits; every refusal looks the same. */
export const PAIRING_RATE_LIMITS = {
  createPerUser: { limit: 10, windowSeconds: 60 * 60 },
  joinPerIp: { limit: 20, windowSeconds: 10 * 60 },
  /** Failed token or secret guesses per address (successes are free). */
  failuresPerIp: { limit: 10, windowSeconds: 10 * 60 },
  /** Phone-side status polls (every two seconds for ten minutes is 300). */
  pollPerIp: { limit: 400, windowSeconds: 10 * 60 },
  optionsPerIp: { limit: 20, windowSeconds: 10 * 60 },
  /** Signed-in side: creator status polls and approve/deny. */
  statusPerUser: { limit: 400, windowSeconds: 10 * 60 },
  decidePerUser: { limit: 30, windowSeconds: 10 * 60 },
} as const;

export type PairingState = 'offered' | 'joined' | 'approved' | 'consumed' | 'denied' | 'expired';
const OPEN_STATES = ['offered', 'joined', 'approved'] as const;

type EnvLike = Record<string, unknown> & { DB: D1Database };

interface PairingRow {
  id: string;
  user_id: string;
  session_id: string;
  state: PairingState;
  device_label: string | null;
  expires_at: number;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** True once migration 0034 is applied. Any error reads as "not installed". */
export async function pairingsInstalled(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT id FROM passkey_pairings LIMIT 1').first();
    return true;
  } catch {
    return false;
  }
}

/** A short friendly label from a user agent. Display only, never trusted. */
export function deviceLabelFromUserAgent(userAgent: string | null): string {
  const agent = (userAgent || '').slice(0, 512);
  let device = 'Phone';
  if (/iPhone/.test(agent)) device = 'iPhone';
  else if (/iPad/.test(agent)) device = 'iPad';
  else if (/Android/.test(agent)) device = /Mobile/.test(agent) ? 'Android phone' : 'Android tablet';
  else if (/Macintosh/.test(agent)) device = 'Mac';
  else if (/Windows/.test(agent)) device = 'Windows PC';
  else if (/CrOS/.test(agent)) device = 'Chromebook';
  else if (/Linux/.test(agent)) device = 'Linux computer';
  let browser = '';
  if (/(?:EdgiOS|EdgA|Edg)\//.test(agent)) browser = 'Edge';
  else if (/(?:OPR|Opera)\//.test(agent)) browser = 'Opera';
  else if (/SamsungBrowser\//.test(agent)) browser = 'Samsung Internet';
  else if (/(?:FxiOS|Firefox)\//.test(agent)) browser = 'Firefox';
  else if (/(?:CriOS|Chrome)\//.test(agent)) browser = 'Chrome';
  else if (/Safari\//.test(agent)) browser = 'Safari';
  return (browser ? `${device} (${browser})` : device).slice(0, 64);
}

function ipKey(ip: string): string {
  return rateLimitAddressKey(ip);
}

// ─── Signed-in side ─────────────────────────────────────────────────────

export type PairingCreate =
  | { ok: true; token: string; pairingId: string; expiresAt: number; secondsLeft: number }
  | { ok: false; status: number; error: string };

/**
 * Makes a new pairing offer. Same rule as adding a passkey: an ordinary live
 * session opened in the last REGISTRATION_FRESH_MINUTES. Cancels any offer
 * this person still has open.
 */
export async function createPairing(
  env: EnvLike,
  user: User,
  sessionId: string | null,
  options: { clientIp: string },
): Promise<PairingCreate> {
  const db = env.DB;
  if (user.status !== 'active') return { ok: false, status: 403, error: 'This account cannot add passkeys.' };
  const refusal = await manageRefusal(db, user.id, sessionId, { requireFresh: true });
  if (refusal) return { ok: false, status: 403, error: MANAGE_REFUSAL_MESSAGES[refusal] };
  if (!await pairingsInstalled(db)) return { ok: false, status: 503, error: 'Adding a phone is not set up yet. Ask a manager to apply the latest database update.' };
  const limit = await consumeRateLimit(db, 'passkey_pair_create', user.id, PAIRING_RATE_LIMITS.createPerUser.limit, PAIRING_RATE_LIMITS.createPerUser.windowSeconds);
  if (!limit.allowed) {
    await audit(db, { event_type: 'security.rate_limit', actor_id: user.id, actor_role: user.role, target: user.id, detail: 'Passkey pairing creation rate limit hit', ip_address: options.clientIp });
    return { ok: false, status: 429, error: RATE_LIMITED_MESSAGE };
  }
  const count = await db.prepare('SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = ?').bind(user.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PASSKEYS_PER_USER) {
    return { ok: false, status: 409, error: `You already have ${MAX_PASSKEYS_PER_USER} passkeys. Remove one first.` };
  }

  const now = nowSeconds();
  // One open offer per person: a new one ends the old one.
  await db.prepare(
    `UPDATE passkey_pairings SET state = 'expired'
     WHERE user_id = ? AND state IN ('offered', 'joined', 'approved')`,
  ).bind(user.id).run();

  const token = randomSecret();
  const pairingId = crypto.randomUUID();
  const expiresAt = now + PAIRING_TTL_SECONDS;
  await db.prepare(
    `INSERT INTO passkey_pairings (id, user_id, session_id, token_hash, state, expires_at)
     VALUES (?, ?, ?, ?, 'offered', ?)`,
  ).bind(pairingId, user.id, sessionId, await sha256Hex(token), expiresAt).run();
  await audit(db, {
    event_type: 'auth.passkey_pair_started',
    actor_id: user.id,
    actor_role: user.role,
    target: user.id,
    detail: 'Started adding a phone (QR pairing)',
    ip_address: options.clientIp,
    session_id: sessionId,
  });
  return { ok: true, token, pairingId, expiresAt, secondsLeft: PAIRING_TTL_SECONDS };
}

export interface PairingStatus {
  state: PairingState | 'none';
  deviceLabel: string | null;
  secondsLeft: number;
  pairingId: string | null;
}

/**
 * The newest offer made from this session. Past its expiry an open offer is
 * marked expired (once, audited once) so a late phone can never use it.
 */
export async function pairingStatus(
  env: EnvLike,
  user: User,
  sessionId: string | null,
  options: { clientIp: string },
): Promise<{ ok: true; status: PairingStatus } | { ok: false; status: number; error: string }> {
  const db = env.DB;
  if (!sessionId) return { ok: false, status: 403, error: MANAGE_REFUSAL_MESSAGES.no_session };
  const limit = await consumeRateLimit(db, 'passkey_pair_status', user.id, PAIRING_RATE_LIMITS.statusPerUser.limit, PAIRING_RATE_LIMITS.statusPerUser.windowSeconds);
  if (!limit.allowed) return { ok: false, status: 429, error: RATE_LIMITED_MESSAGE };
  let row: PairingRow | null;
  try {
    row = await db.prepare(
      `SELECT id, user_id, session_id, state, device_label, expires_at FROM passkey_pairings
       WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).bind(user.id, sessionId).first<PairingRow>();
  } catch {
    row = null;
  }
  if (!row) return { ok: true, status: { state: 'none', deviceLabel: null, secondsLeft: 0, pairingId: null } };
  const now = nowSeconds();
  let state = row.state;
  if ((OPEN_STATES as readonly string[]).includes(state) && row.expires_at <= now) {
    const result = await db.prepare(
      `UPDATE passkey_pairings SET state = 'expired' WHERE id = ? AND state IN ('offered', 'joined', 'approved')`,
    ).bind(row.id).run();
    state = 'expired';
    if (result.meta.changes) {
      await audit(db, { event_type: 'auth.passkey_pair_expired', actor_id: user.id, actor_role: user.role, target: user.id, detail: 'A phone pairing offer expired', ip_address: options.clientIp, session_id: sessionId });
    }
  }
  return {
    ok: true,
    status: {
      state,
      deviceLabel: state === 'joined' || state === 'approved' || state === 'consumed' ? row.device_label : null,
      secondsLeft: (OPEN_STATES as readonly string[]).includes(state) ? Math.max(0, row.expires_at - now) : 0,
      pairingId: row.id,
    },
  };
}

export type PairingDecision =
  | { ok: true }
  | { ok: false; status: number; error: string };

function decisionInput(pairingId: unknown): string | null {
  return typeof pairingId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pairingId) ? pairingId : null;
}

/** Approves the phone that joined. Only the creating session may, only while the offer is `joined`. */
export async function approvePairing(
  env: EnvLike,
  user: User,
  sessionId: string | null,
  pairingId: unknown,
  options: { clientIp: string },
): Promise<PairingDecision> {
  const db = env.DB;
  const id = decisionInput(pairingId);
  if (!id) return { ok: false, status: 400, error: 'That request was not valid.' };
  if (user.status !== 'active') return { ok: false, status: 403, error: 'This account cannot add passkeys.' };
  const refusal = await manageRefusal(db, user.id, sessionId, { requireFresh: false });
  if (refusal) return { ok: false, status: 403, error: MANAGE_REFUSAL_MESSAGES[refusal] };
  const limit = await consumeRateLimit(db, 'passkey_pair_decide', user.id, PAIRING_RATE_LIMITS.decidePerUser.limit, PAIRING_RATE_LIMITS.decidePerUser.windowSeconds);
  if (!limit.allowed) return { ok: false, status: 429, error: RATE_LIMITED_MESSAGE };
  const result = await db.prepare(
    `UPDATE passkey_pairings SET state = 'approved'
     WHERE id = ? AND user_id = ? AND session_id = ? AND state = 'joined' AND expires_at > ?`,
  ).bind(id, user.id, sessionId, nowSeconds()).run();
  if (!result.meta.changes) return { ok: false, status: 409, error: 'That phone is no longer waiting. Start again.' };
  await audit(db, { event_type: 'auth.passkey_pair_approved', actor_id: user.id, actor_role: user.role, target: user.id, detail: 'Approved a phone to add a passkey', ip_address: options.clientIp, session_id: sessionId });
  return { ok: true };
}

/** Ends the offer from the signed-in side (Deny, or Cancel before anyone joined). */
export async function denyPairing(
  env: EnvLike,
  user: User,
  sessionId: string | null,
  pairingId: unknown,
  options: { clientIp: string },
): Promise<PairingDecision> {
  const db = env.DB;
  const id = decisionInput(pairingId);
  if (!id) return { ok: false, status: 400, error: 'That request was not valid.' };
  if (!sessionId) return { ok: false, status: 403, error: MANAGE_REFUSAL_MESSAGES.no_session };
  const limit = await consumeRateLimit(db, 'passkey_pair_decide', user.id, PAIRING_RATE_LIMITS.decidePerUser.limit, PAIRING_RATE_LIMITS.decidePerUser.windowSeconds);
  if (!limit.allowed) return { ok: false, status: 429, error: RATE_LIMITED_MESSAGE };
  const result = await db.prepare(
    `UPDATE passkey_pairings SET state = 'denied'
     WHERE id = ? AND user_id = ? AND session_id = ? AND state IN ('offered', 'joined', 'approved')`,
  ).bind(id, user.id, sessionId).run();
  if (!result.meta.changes) return { ok: false, status: 409, error: 'That offer has already ended.' };
  await audit(db, { event_type: 'auth.passkey_pair_denied', actor_id: user.id, actor_role: user.role, target: user.id, detail: 'Ended a phone pairing offer', ip_address: options.clientIp, session_id: sessionId });
  return { ok: true };
}

// ─── Phone side (no sign-in) ────────────────────────────────────────────

export type PhoneRefusal = { ok: false; status: number; message: string };
const LIMITED: PhoneRefusal = { ok: false, status: 429, message: RATE_LIMITED_MESSAGE };
const INVALID: PhoneRefusal = { ok: false, status: 404, message: PAIRING_NEUTRAL_MESSAGE };

async function overFailureLimit(db: D1Database, ip: string): Promise<boolean> {
  const failures = await rateLimitCount(db, 'passkey_pair_fail', ipKey(ip), PAIRING_RATE_LIMITS.failuresPerIp.windowSeconds);
  return failures >= PAIRING_RATE_LIMITS.failuresPerIp.limit;
}

async function noteFailure(db: D1Database, ip: string, detail: string): Promise<void> {
  const result = await consumeRateLimit(db, 'passkey_pair_fail', ipKey(ip), PAIRING_RATE_LIMITS.failuresPerIp.limit, PAIRING_RATE_LIMITS.failuresPerIp.windowSeconds);
  if (!result.allowed) {
    // Audited once per window: the first count over the limit.
    const count = await rateLimitCount(db, 'passkey_pair_fail', ipKey(ip), PAIRING_RATE_LIMITS.failuresPerIp.windowSeconds);
    if (count === PAIRING_RATE_LIMITS.failuresPerIp.limit + 1) {
      await audit(db, { event_type: 'security.rate_limit', actor_role: 'system', detail: `Passkey pairing rate limit hit: ${detail}`, ip_address: ip });
    }
  }
}

function tokenOf(value: unknown): string | null {
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null;
}

export type PairingJoin =
  | { ok: true; joiner: string; deviceLabel: string; secondsLeft: number }
  | PhoneRefusal;

/**
 * The phone presents the token. One conditional UPDATE moves offered -> joined
 * and records the joiner secret's hash; it changes no row for an unknown,
 * expired, used, ended or already-joined offer, an inactive person, or a
 * creator session that is no longer live.
 */
export async function joinPairing(
  env: EnvLike,
  request: Request,
  body: unknown,
  ip: string,
): Promise<PairingJoin> {
  const db = env.DB;
  if (!await pairingsInstalled(db)) return INVALID;
  if (await overFailureLimit(db, ip)) return LIMITED;
  const joinLimit = await consumeRateLimit(db, 'passkey_pair_join', ipKey(ip), PAIRING_RATE_LIMITS.joinPerIp.limit, PAIRING_RATE_LIMITS.joinPerIp.windowSeconds);
  if (!joinLimit.allowed) return LIMITED;
  const token = tokenOf((body as { token?: unknown } | null)?.token);
  if (!token) {
    await noteFailure(db, ip, 'bad token shape');
    return INVALID;
  }
  const joiner = randomSecret();
  const label = deviceLabelFromUserAgent(request.headers.get('user-agent'));
  const row = await db.prepare(
    `UPDATE passkey_pairings SET state = 'joined', device_label = ?, joiner_hash = ?
     WHERE token_hash = ? AND state = 'offered' AND expires_at > ?
       AND EXISTS (SELECT 1 FROM users WHERE users.id = passkey_pairings.user_id AND users.status = 'active')
       AND EXISTS (SELECT 1 FROM sessions
                   WHERE sessions.id = passkey_pairings.session_id AND sessions.user_id = passkey_pairings.user_id
                     AND sessions.revoked = 0 AND sessions.expires_at > datetime('now')
                     AND sessions.passkey_credential_id IS NULL)
     RETURNING id, user_id, session_id, expires_at`,
  ).bind(label, await sha256Hex(joiner), await sha256Hex(token), nowSeconds())
    .first<{ id: string; user_id: string; session_id: string; expires_at: number }>();
  if (!row) {
    await noteFailure(db, ip, 'unknown or used token');
    return INVALID;
  }
  await audit(db, {
    event_type: 'auth.passkey_pair_joined',
    actor_role: 'system',
    target: row.user_id,
    detail: `A phone scanned the pairing code: ${label}`,
    ip_address: ip,
    session_id: row.session_id,
  });
  return { ok: true, joiner, deviceLabel: label, secondsLeft: Math.max(0, row.expires_at - nowSeconds()) };
}

/**
 * Loads the offer for a token + joiner secret pair, in `wanted` state. The
 * secret is compared as a hash inside the lookup, so a wrong guess and an
 * unknown token are indistinguishable and timing-neutral.
 */
async function loadForPhone(
  db: D1Database,
  token: string,
  joiner: string,
): Promise<(PairingRow & { joiner_hash: string }) | null> {
  const row = await db.prepare(
    `SELECT id, user_id, session_id, state, device_label, expires_at, joiner_hash FROM passkey_pairings
     WHERE token_hash = ? AND joiner_hash = ?`,
  ).bind(await sha256Hex(token), await sha256Hex(joiner)).first<PairingRow & { joiner_hash: string }>();
  return row;
}

function joinerOf(value: unknown): string | null {
  return tokenOf(value);
}

export type PairingWait =
  | { ok: true; state: PairingState; secondsLeft: number }
  | PhoneRefusal;

/** The phone polls this while it waits for the person to approve it. */
export async function pairingWaitForPhone(env: EnvLike, body: unknown, ip: string): Promise<PairingWait> {
  const db = env.DB;
  if (await overFailureLimit(db, ip)) return LIMITED;
  const poll = await consumeRateLimit(db, 'passkey_pair_poll', ipKey(ip), PAIRING_RATE_LIMITS.pollPerIp.limit, PAIRING_RATE_LIMITS.pollPerIp.windowSeconds);
  if (!poll.allowed) return LIMITED;
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const token = tokenOf(input.token);
  const joiner = joinerOf(input.joiner);
  if (!token || !joiner) {
    await noteFailure(db, ip, 'bad shape');
    return INVALID;
  }
  const row = await loadForPhone(db, token, joiner);
  if (!row) {
    await noteFailure(db, ip, 'unknown token or secret');
    return INVALID;
  }
  const now = nowSeconds();
  let state = row.state;
  if ((OPEN_STATES as readonly string[]).includes(state) && row.expires_at <= now) {
    const result = await db.prepare(
      `UPDATE passkey_pairings SET state = 'expired' WHERE id = ? AND state IN ('offered', 'joined', 'approved')`,
    ).bind(row.id).run();
    state = 'expired';
    if (result.meta.changes) {
      await audit(db, { event_type: 'auth.passkey_pair_expired', actor_role: 'system', target: row.user_id, detail: 'A phone pairing offer expired', ip_address: ip, session_id: row.session_id });
    }
  }
  return { ok: true, state, secondsLeft: Math.max(0, row.expires_at - now) };
}

export type PairingOptions =
  | { ok: true; challengeId: string; options: PublicKeyCredentialCreationOptionsJSON; deviceLabel: string }
  | PhoneRefusal;

/** Registration options for an approved phone. Nothing is released before approval. */
export async function pairingRegistrationOptions(
  env: EnvLike,
  rp: RelyingParty,
  body: unknown,
  ip: string,
): Promise<PairingOptions> {
  const db = env.DB;
  if (await overFailureLimit(db, ip)) return LIMITED;
  const limit = await consumeRateLimit(db, 'passkey_pair_options', ipKey(ip), PAIRING_RATE_LIMITS.optionsPerIp.limit, PAIRING_RATE_LIMITS.optionsPerIp.windowSeconds);
  if (!limit.allowed) return LIMITED;
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const token = tokenOf(input.token);
  const joiner = joinerOf(input.joiner);
  if (!token || !joiner) {
    await noteFailure(db, ip, 'bad shape');
    return INVALID;
  }
  const row = await loadForPhone(db, token, joiner);
  if (!row || row.state !== 'approved' || row.expires_at <= nowSeconds()) {
    await noteFailure(db, ip, 'options for a pairing that is not approved');
    return INVALID;
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first<User>();
  if (!user || user.status !== 'active') return INVALID;
  // The creator's session id goes on the challenge, so the challenge table is unchanged.
  const start = await startRegistration(env, rp, user, row.session_id);
  if (!start.ok) return { ok: false, status: start.status === 429 ? 429 : 403, message: start.error };
  return { ok: true, challengeId: start.challengeId, options: start.options, deviceLabel: row.device_label || 'Phone' };
}

export type PairingFinish =
  | { ok: true; passkey: PasskeySummary }
  | PhoneRefusal;

/**
 * Finishes the pairing. The offer is claimed (approved -> consumed) by one
 * conditional UPDATE before anything is stored, so two verifies cannot both
 * run; a failed attempt puts the offer back to approved while it is unexpired.
 */
export async function finishPairing(
  env: EnvLike,
  rp: RelyingParty,
  body: unknown,
  options: { clientIp: string; waitUntil?: (promise: Promise<unknown>) => void },
): Promise<PairingFinish> {
  const db = env.DB;
  const ip = options.clientIp;
  if (await overFailureLimit(db, ip)) return LIMITED;
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const token = tokenOf(input.token);
  const joiner = joinerOf(input.joiner);
  if (!token || !joiner) {
    await noteFailure(db, ip, 'bad shape');
    return INVALID;
  }
  const row = await loadForPhone(db, token, joiner);
  if (!row) {
    await noteFailure(db, ip, 'unknown token or secret');
    return INVALID;
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first<User>();
  if (!user || user.status !== 'active') return INVALID;

  const claim = await db.prepare(
    `UPDATE passkey_pairings SET state = 'consumed'
     WHERE id = ? AND state = 'approved' AND expires_at > ?`,
  ).bind(row.id, nowSeconds()).run();
  if (!claim.meta.changes) {
    await noteFailure(db, ip, 'verify for a pairing that is not approved');
    return INVALID;
  }
  const result = await finishRegistration(
    env,
    rp,
    user,
    row.session_id,
    { challengeId: input.challengeId, response: input.response, deviceName: row.device_label || 'Phone' },
    { clientIp: ip, waitUntil: options.waitUntil },
  );
  if (!result.ok) {
    // Let the phone try again while the offer lasts (a cancelled prompt, a
    // bad response). The challenge itself is single use, so it asks again.
    await db.prepare(
      `UPDATE passkey_pairings SET state = 'approved' WHERE id = ? AND state = 'consumed' AND expires_at > ?`,
    ).bind(row.id, nowSeconds()).run();
    return { ok: false, status: result.status === 429 ? 429 : result.status === 409 ? 409 : 400, message: result.error };
  }
  return { ok: true, passkey: result.passkey };
}
