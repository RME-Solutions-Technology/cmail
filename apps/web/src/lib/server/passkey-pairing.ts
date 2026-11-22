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
// - Number match: the phone shows a two-digit code; the approver must pick it
//   from three choices. Three wrong picks end the offer.
// - The creator's session must be live at every step, young enough that it
//   cannot go stale before the offer ends, and only it can approve or deny.
//   A person has one open offer (partial unique index); a new offer cancels
//   the old one.
// - The registration challenge issued to the approved phone is stored on the
//   offer, and verify must present exactly that one.
// - The device label and country are shown only to the approver; never trusted.
// - Rate limits count per address (IPv6 per /64) and per person. Phone
//   endpoints refuse a request with no address rather than share one bucket.
// - Secrets (token, phone secret, number) are never written to audit rows or logs.
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
  REGISTRATION_FRESH_MINUTES,
  finishRegistration,
  manageRefusal,
  rateLimitAddressKey,
  startRegistration,
  type PasskeySummary,
  type RelyingParty,
} from './passkeys';

export const PAIRING_TTL_SECONDS = 10 * 60;
/**
 * An offer may only start from a session this young, so that an approved
 * offer cannot outlive the registration freshness rule before the phone
 * finishes (the rule is checked again by startRegistration and
 * finishRegistration).
 */
export const PAIRING_MAX_SESSION_AGE_MINUTES = REGISTRATION_FRESH_MINUTES - PAIRING_TTL_SECONDS / 60;
export const PAIRING_MAX_WRONG_CODES = 3;
export const PAIRING_NEUTRAL_MESSAGE = 'This pairing link is not valid any more. Start again on your computer.';
const NO_ADDRESS_MESSAGE = 'Could not identify your connection. Try again from your phone browser.';

/** Pairing rate limits; every refusal looks the same. */
export const PAIRING_RATE_LIMITS = {
  createPerUser: { limit: 10, windowSeconds: 60 * 60 },
  joinPerIp: { limit: 20, windowSeconds: 10 * 60 },
  /** Failed token or secret guesses per address (successes are free). */
  failuresPerIp: { limit: 10, windowSeconds: 10 * 60 },
  /** Phone-side status polls, their own bucket (one poll per 3 seconds for ten minutes is 200). */
  pollPerIp: { limit: 600, windowSeconds: 10 * 60 },
  optionsPerIp: { limit: 20, windowSeconds: 10 * 60 },
  /** Signed-in side: creator status polls and approve/deny. */
  statusPerUser: { limit: 600, windowSeconds: 10 * 60 },
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A uniform two-digit number, "00" to "99" (rejection sampling, no modulo bias). */
function randomCode(): string {
  const buffer = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < 200) return String(buffer[0] % 100).padStart(2, '0');
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The three numbers shown to the approver: the real one and two decoys. The
 * decoys come from a hash of the offer id, so they stay the same on every
 * poll, and the list is sorted so its order says nothing.
 */
async function codeChoices(pairingId: string, code: string): Promise<string[]> {
  const digest = await sha256Hex(`${pairingId}:${code}`);
  const choices = new Set<string>([code]);
  for (let index = 0; choices.size < 3 && index + 2 <= digest.length; index += 2) {
    const candidate = String(Number.parseInt(digest.slice(index, index + 2), 16) % 100).padStart(2, '0');
    choices.add(candidate);
  }
  // 32 hash bytes always give two distinct decoys in practice; this only
  // guards the impossible.
  for (let filler = 0; choices.size < 3; filler += 1) choices.add(String((Number(code) + 7 * (filler + 1)) % 100).padStart(2, '0'));
  return [...choices].sort();
}

const installedCache = new WeakMap<D1Database, { ok: boolean; at: number }>();
const INSTALLED_CACHE_MS = 60 * 1000;

/** True once migration 0034 is applied. Any error reads as "not installed". Cached for 60 s per isolate. */
export async function pairingsInstalled(db: D1Database): Promise<boolean> {
  const cached = installedCache.get(db);
  if (cached && Date.now() - cached.at < INSTALLED_CACHE_MS) return cached.ok;
  const ok = await db.prepare('SELECT id FROM passkey_pairings LIMIT 1').first().then(() => true, () => false);
  installedCache.set(db, { ok, at: Date.now() });
  return ok;
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

/** Two-letter country from Cloudflare's header, or null. Display only. */
export function countryFromRequest(request: Request): string | null {
  const value = (request.headers.get('cf-ipcountry') || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) && value !== 'XX' ? value : null;
}

function ipKey(ip: string): string {
  return rateLimitAddressKey(ip);
}

// ─── Signed-in side ─────────────────────────────────────────────────────

export type PairingCreate =
  | { ok: true; token: string; pairingId: string; expiresAt: number; secondsLeft: number }
  | { ok: false; status: number; error: string };

/**
 * Makes a new pairing offer. Same rule as adding a passkey (an ordinary live
 * session) but the session must be younger than PAIRING_MAX_SESSION_AGE_MINUTES,
 * so the offer cannot go stale before it ends. Cancels any offer this person
 * still has open, in the same batch (the partial unique index allows one).
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
  const young = await db.prepare(
    `SELECT 1 AS ok FROM sessions WHERE id = ? AND user_id = ? AND issued_at > datetime('now', ?)`,
  ).bind(sessionId, user.id, `-${PAIRING_MAX_SESSION_AGE_MINUTES} minutes`).first<{ ok: number }>();
  if (!young) {
    return {
      ok: false,
      status: 403,
      error: `For safety, sign out and sign in again, then press Add a phone within ${PAIRING_MAX_SESSION_AGE_MINUTES} minutes (an offer lasts ${PAIRING_TTL_SECONDS / 60} minutes and adding a passkey needs a session under ${REGISTRATION_FRESH_MINUTES} minutes old).`,
    };
  }
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

  const token = randomSecret();
  const pairingId = crypto.randomUUID();
  const expiresAt = nowSeconds() + PAIRING_TTL_SECONDS;
  const tokenHash = await sha256Hex(token);
  let cancelled: number;
  try {
    // One batch (one transaction): end the old offer, then open the new one.
    const results = await db.batch([
      db.prepare(`UPDATE passkey_pairings SET state = 'expired' WHERE user_id = ? AND state IN ('offered', 'joined', 'approved')`).bind(user.id),
      db.prepare(
        `INSERT INTO passkey_pairings (id, user_id, session_id, token_hash, state, expires_at)
         VALUES (?, ?, ?, ?, 'offered', ?)`,
      ).bind(pairingId, user.id, sessionId, tokenHash, expiresAt),
    ]);
    cancelled = Number(results[0]?.meta?.changes ?? 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/UNIQUE constraint failed/i.test(message)) {
      return { ok: false, status: 409, error: 'Another offer was just started. Try again.' };
    }
    console.error('Passkey pairing insert failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
    return { ok: false, status: 503, error: "The offer couldn't be saved. Try again shortly." };
  }
  if (cancelled > 0) {
    await audit(db, {
      event_type: 'auth.passkey_pair_expired',
      actor_id: user.id,
      actor_role: user.role,
      target: user.id,
      detail: 'An earlier phone pairing offer was cancelled by a new one',
      ip_address: options.clientIp,
      session_id: sessionId,
    });
  }
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
  /** `finishing`: the phone is storing its passkey and none is confirmed yet. */
  state: PairingState | 'finishing' | 'none';
  deviceLabel: string | null;
  /** Coarse country of the joining phone, two letters. */
  country: string | null;
  /** While `joined`: three numbers, one of which is shown on the phone. */
  choices: string[];
  secondsLeft: number;
  pairingId: string | null;
}

const NO_OFFER: PairingStatus = { state: 'none', deviceLabel: null, country: null, choices: [], secondsLeft: 0, pairingId: null };

/**
 * The newest offer made from this session. Past its expiry an open offer is
 * marked expired (once, audited once) so a late phone can never use it. A
 * consumed offer reads as consumed only once its passkey really exists.
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
  let row: (PairingRow & { country: string | null; approve_code: string | null; has_credential: number | null }) | null;
  try {
    row = await db.prepare(
      `SELECT id, user_id, session_id, state, device_label, country, approve_code, expires_at,
              (SELECT 1 FROM passkey_credentials WHERE passkey_credentials.id = passkey_pairings.credential_id) AS has_credential
       FROM passkey_pairings
       WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).bind(user.id, sessionId).first();
  } catch {
    row = null;
  }
  if (!row) return { ok: true, status: NO_OFFER };
  const now = nowSeconds();
  let state: PairingStatus['state'] = row.state;
  if ((OPEN_STATES as readonly string[]).includes(state) && row.expires_at <= now) {
    const result = await db.prepare(
      `UPDATE passkey_pairings SET state = 'expired' WHERE id = ? AND state IN ('offered', 'joined', 'approved')`,
    ).bind(row.id).run();
    state = 'expired';
    if (result.meta.changes) {
      await audit(db, { event_type: 'auth.passkey_pair_expired', actor_id: user.id, actor_role: user.role, target: user.id, detail: 'A phone pairing offer expired', ip_address: options.clientIp, session_id: sessionId });
    }
  }
  if (state === 'consumed' && !row.has_credential) state = 'finishing';
  const open = state === 'offered' || state === 'joined' || state === 'approved';
  const showPhone = state === 'joined' || state === 'approved' || state === 'consumed' || state === 'finishing';
  return {
    ok: true,
    status: {
      state,
      deviceLabel: showPhone ? row.device_label : null,
      country: showPhone ? row.country : null,
      choices: state === 'joined' && row.approve_code ? await codeChoices(row.id, row.approve_code) : [],
      secondsLeft: open ? Math.max(0, row.expires_at - now) : 0,
      pairingId: row.id,
    },
  };
}

export type PairingDecision =
  | { ok: true }
  | { ok: false; status: number; error: string };

function decisionInput(pairingId: unknown): string | null {
  return typeof pairingId === 'string' && UUID_PATTERN.test(pairingId) ? pairingId : null;
}

/**
 * Approves the phone that joined. Only the creating session may, only while
 * the offer is `joined`, and only with the number the phone shows. A wrong
 * number is counted in one conditional UPDATE and the third ends the offer.
 */
export async function approvePairing(
  env: EnvLike,
  user: User,
  sessionId: string | null,
  pairingId: unknown,
  code: unknown,
  options: { clientIp: string },
): Promise<PairingDecision> {
  const db = env.DB;
  const id = decisionInput(pairingId);
  if (!id || typeof code !== 'string' || !/^\d{2}$/.test(code)) return { ok: false, status: 400, error: 'That request was not valid.' };
  if (user.status !== 'active') return { ok: false, status: 403, error: 'This account cannot add passkeys.' };
  const refusal = await manageRefusal(db, user.id, sessionId, { requireFresh: false });
  if (refusal) return { ok: false, status: 403, error: MANAGE_REFUSAL_MESSAGES[refusal] };
  const limit = await consumeRateLimit(db, 'passkey_pair_decide', user.id, PAIRING_RATE_LIMITS.decidePerUser.limit, PAIRING_RATE_LIMITS.decidePerUser.windowSeconds);
  if (!limit.allowed) return { ok: false, status: 429, error: RATE_LIMITED_MESSAGE };
  const now = nowSeconds();
  const result = await db.prepare(
    `UPDATE passkey_pairings SET state = 'approved'
     WHERE id = ? AND user_id = ? AND session_id = ? AND state = 'joined' AND expires_at > ?
       AND approve_code = ? AND wrong_tries < ?`,
  ).bind(id, user.id, sessionId, now, code, PAIRING_MAX_WRONG_CODES).run();
  if (result.meta.changes) {
    await audit(db, { event_type: 'auth.passkey_pair_approved', actor_id: user.id, actor_role: user.role, target: user.id, detail: 'Approved a phone to add a passkey', ip_address: options.clientIp, session_id: sessionId });
    return { ok: true };
  }
  // Not approved. If the offer is still waiting on this person, count the wrong pick.
  const wrong = await db.prepare(
    `UPDATE passkey_pairings
     SET wrong_tries = wrong_tries + 1,
         state = CASE WHEN wrong_tries + 1 >= ? THEN 'denied' ELSE state END
     WHERE id = ? AND user_id = ? AND session_id = ? AND state = 'joined' AND expires_at > ?
     RETURNING state`,
  ).bind(PAIRING_MAX_WRONG_CODES, id, user.id, sessionId, now).first<{ state: PairingState }>();
  if (!wrong) return { ok: false, status: 409, error: 'That phone is no longer waiting. Start again.' };
  if (wrong.state === 'denied') {
    await audit(db, { event_type: 'auth.passkey_pair_denied', actor_id: user.id, actor_role: user.role, target: user.id, detail: `Phone pairing ended after ${PAIRING_MAX_WRONG_CODES} wrong number picks`, ip_address: options.clientIp, session_id: sessionId });
    return { ok: false, status: 409, error: 'Too many wrong numbers. The offer was cancelled. Start again.' };
  }
  return { ok: false, status: 409, error: 'That is not the number shown on the phone. Check the phone and pick again.' };
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
/**
 * No Cloudflare address header: refuse rather than put every such request in
 * one shared rate-limit bucket that one caller could fill for everyone.
 */
const NO_ADDRESS: PhoneRefusal = { ok: false, status: 400, message: NO_ADDRESS_MESSAGE };

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
  | { ok: true; joiner: string; deviceLabel: string; code: string; secondsLeft: number }
  | PhoneRefusal;

/**
 * The phone presents the token. One conditional UPDATE moves offered -> joined
 * and records the joiner secret's hash and the number to match; it changes no
 * row for an unknown, expired, used, ended or already-joined offer, an
 * inactive person, or a creator session that is no longer live.
 */
export async function joinPairing(
  env: EnvLike,
  request: Request,
  body: unknown,
  ip: string,
): Promise<PairingJoin> {
  const db = env.DB;
  if (!ip) return NO_ADDRESS;
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
  const code = randomCode();
  const label = deviceLabelFromUserAgent(request.headers.get('user-agent'));
  const row = await db.prepare(
    `UPDATE passkey_pairings SET state = 'joined', device_label = ?, country = ?, joiner_hash = ?, approve_code = ?
     WHERE token_hash = ? AND state = 'offered' AND expires_at > ?
       AND EXISTS (SELECT 1 FROM users WHERE users.id = passkey_pairings.user_id AND users.status = 'active')
       AND EXISTS (SELECT 1 FROM sessions
                   WHERE sessions.id = passkey_pairings.session_id AND sessions.user_id = passkey_pairings.user_id
                     AND sessions.revoked = 0 AND sessions.expires_at > datetime('now')
                     AND sessions.passkey_credential_id IS NULL)
     RETURNING id, user_id, session_id, expires_at`,
  ).bind(label, countryFromRequest(request), await sha256Hex(joiner), code, await sha256Hex(token), nowSeconds())
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
  return { ok: true, joiner, deviceLabel: label, code, secondsLeft: Math.max(0, row.expires_at - nowSeconds()) };
}

type PhoneRow = PairingRow & { joiner_hash: string; challenge_id: string | null };

/**
 * Loads the offer for a token + joiner secret pair. The secret is compared as
 * a hash inside the lookup, so a wrong guess and an unknown token are
 * indistinguishable and timing-neutral.
 */
async function loadForPhone(db: D1Database, token: string, joiner: string): Promise<PhoneRow | null> {
  return db.prepare(
    `SELECT id, user_id, session_id, state, device_label, expires_at, joiner_hash, challenge_id FROM passkey_pairings
     WHERE token_hash = ? AND joiner_hash = ?`,
  ).bind(await sha256Hex(token), await sha256Hex(joiner)).first<PhoneRow>();
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
  if (!ip) return NO_ADDRESS;
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
  if (!ip) return NO_ADDRESS;
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
  // Bind this challenge to this offer: verify must present exactly it.
  const bound = await db.prepare(
    `UPDATE passkey_pairings SET challenge_id = ? WHERE id = ? AND state = 'approved' AND expires_at > ?`,
  ).bind(start.challengeId, row.id, nowSeconds()).run();
  if (!bound.meta.changes) return INVALID;
  return { ok: true, challengeId: start.challengeId, options: start.options, deviceLabel: row.device_label || 'Phone' };
}

export type PairingFinish =
  | { ok: true; passkey: PasskeySummary }
  | PhoneRefusal;

/**
 * Finishes the pairing. The challenge must be the one issued to this offer.
 * The offer is claimed (approved -> consumed) by one conditional UPDATE before
 * anything is stored, so two verifies cannot both run; a failed attempt puts
 * the offer back to approved while it is unexpired (a new options request
 * asks for a new challenge).
 */
export async function finishPairing(
  env: EnvLike,
  rp: RelyingParty,
  body: unknown,
  options: { clientIp: string; waitUntil?: (promise: Promise<unknown>) => void },
): Promise<PairingFinish> {
  const db = env.DB;
  const ip = options.clientIp;
  if (!ip) return NO_ADDRESS;
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
  if (typeof input.challengeId !== 'string' || !row.challenge_id || input.challengeId !== row.challenge_id) {
    return { ok: false, status: 400, message: 'That request expired. Press Create passkey to try again.' };
  }

  const claim = await db.prepare(
    `UPDATE passkey_pairings SET state = 'consumed'
     WHERE id = ? AND state = 'approved' AND challenge_id = ? AND expires_at > ?`,
  ).bind(row.id, row.challenge_id, nowSeconds()).run();
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
    // bad response). The challenge was single use, so it must ask again.
    await db.prepare(
      `UPDATE passkey_pairings SET state = 'approved', challenge_id = NULL WHERE id = ? AND state = 'consumed' AND expires_at > ?`,
    ).bind(row.id, nowSeconds()).run();
    return { ok: false, status: result.status === 429 ? 429 : result.status === 409 ? 409 : 400, message: result.error };
  }
  // Record which passkey this offer stored, so the signed-in page can confirm it exists.
  await db.prepare(`UPDATE passkey_pairings SET credential_id = ? WHERE id = ?`).bind(result.passkey.id, row.id).run();
  return { ok: true, passkey: result.passkey };
}
