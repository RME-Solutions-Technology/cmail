// Passkey break-glass sign-in (docs/passkeys.md).
//
// A signed-in person registers one or more WebAuthn passkeys while the normal
// sign-in route (Microsoft, Google, an email code or the Cloudflare Access
// bridge) works. If that route is down, /auth/passkey signs them in with a
// passkey alone: nothing from Microsoft or Cloudflare Access is involved.
//
// Rules this module enforces (tests: passkeys.test.ts):
// - Off by default. A manager switch in Admin (org_settings
//   passkey_signin_enabled). Off means the sign-in routes answer 404, the
//   registration page is hidden, and every passkey session is refused.
// - The relying party is APP_URL: rpID is its hostname and the only accepted
//   origin is its origin. Requests on any other origin (for example the
//   *.pages.dev address) get 404.
// - Discoverable credentials only, user verification required, attestation
//   'none'. Only Ed25519, ES256 and RS256 keys, which Workers Web Crypto
//   verifies.
// - Challenges live in D1, are deleted when read (single use, even when the
//   response then fails) and expire after CHALLENGE_TTL_SECONDS.
// - A sign-in response must carry the userHandle stored with the credential,
//   and its signature counter must go up unless it is always 0. The stored
//   counter is moved with a compare-and-set, so two racing responses cannot
//   both win.
// - Every refusal on the unauthenticated endpoints returns the same message,
//   so they never reveal whether a credential or account exists or why it
//   was refused (the audit log has the reason). The country gate is the one
//   exception: it runs after the passkey is proven and says so, as for the
//   email code.
// - Paused and offboarded accounts cannot sign in. Managers can (break-glass):
//   their sign-ins are audited separately and the managers are emailed.
// - Adding or removing your own passkeys needs an ordinary session (never a
//   passkey session). Adding one also needs a session opened in the last
//   REGISTRATION_FRESH_MINUTES, so an old or stolen cookie cannot plant one.
// - A passkey session is marked by sessions.passkey_credential_id. Removing
//   the passkey or turning the feature off ends those sessions.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { Env, User } from '@cmail/shared/types';
import { audit } from './db';
import { maxSessionsPerUser, sessionTtlMs } from './config';
import { loadOrgSettings } from './org-settings';
import { notifyManagers } from './notify-managers';
import { detectProvider, sendEmail } from './outbound';
import { consumeRateLimit } from './rate-limit';
import { buildSessionCookie, createSessionToken, hashToken } from './session';
import { COUNTRY_PENDING_MESSAGE, recordTravelRequest, requestCountry, signInCountryGate } from './travel';
import { escapeHtml } from './validation';

export const PASSKEY_SETTING_ENABLED = 'passkey_signin_enabled';
export const CHALLENGE_TTL_SECONDS = 5 * 60;
export const MAX_PASSKEYS_PER_USER = 10;
export const REGISTRATION_FRESH_MINUTES = 15;
/** COSE ids: EdDSA (Ed25519), ES256, RS256. No post-quantum ids: Workers cannot verify them. */
export const SUPPORTED_ALGORITHM_IDS = [-8, -7, -257];
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_CREDENTIAL_ID_LENGTH = 1366;

/**
 * Rate limits; all refusals look the same. The global challenge cap is a
 * flood backstop only, set high on purpose: a low global cap would let one
 * attacker lock everyone out of break-glass sign-in during an outage.
 */
export const RATE_LIMITS = {
  optionsPerIp: { limit: 30, windowSeconds: 10 * 60 },
  optionsGlobal: { limit: 5000, windowSeconds: 10 * 60 },
  verifyPerIp: { limit: 10, windowSeconds: 10 * 60 },
  verifyPerCredential: { limit: 10, windowSeconds: 60 * 60 },
  registerPerUser: { limit: 10, windowSeconds: 60 * 60 },
} as const;

/** The single answer for every refused passkey sign-in. */
export const NEUTRAL_SIGNIN_FAILURE = "That passkey couldn't be used to sign in here. Try again, or use another sign-in method.";
export const RATE_LIMITED_MESSAGE = 'Too many attempts. Wait a few minutes and try again.';

type EnvLike = Record<string, unknown> & { DB: D1Database };
type SessionEnv = EnvLike & { SESSION_SECRET: string };

export interface RelyingParty {
  rpID: string;
  origin: string;
  name: string;
}

export interface PasskeySummary {
  id: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string | null;
  synced: boolean;
}

interface CredentialRow {
  id: string;
  user_id: string;
  user_handle: string;
  public_key: string;
  counter: number;
  transports: string;
  device_name: string;
}

function clientIpOf(request: Request): string {
  return (request.headers.get('cf-connecting-ip') || '').slice(0, 64);
}

function cleanDeviceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 64) return null;
  return cleaned;
}

/**
 * The relying party comes from APP_URL alone: https, or http only on a
 * loopback host for local development. No APP_URL, no passkeys.
 */
export function relyingParty(env: Record<string, unknown>): RelyingParty | null {
  const raw = typeof env.APP_URL === 'string' ? env.APP_URL.trim() : '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    // WebAuthn rejects an IP address as an RP ID; localhost is allowed.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith('[')) return null;
    const name = typeof env.APP_NAME === 'string' && env.APP_NAME.trim() ? env.APP_NAME.trim().slice(0, 64) : 'cmail';
    return { rpID: url.hostname, origin: url.origin, name };
  } catch {
    return null;
  }
}

/** True when the manager switch is on. Any error (for example before migration 0025) reads as off. */
export async function passkeySigninEnabled(db: D1Database | undefined): Promise<boolean> {
  if (!db) return false;
  try {
    const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?')
      .bind(PASSKEY_SETTING_ENABLED).first<{ value: string }>();
    return row?.value === 'true';
  } catch {
    return false;
  }
}

/** True once migration 0025 is applied. */
export async function passkeysInstalled(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT id FROM passkey_credentials LIMIT 1').first();
    await db.prepare('SELECT passkey_credential_id FROM sessions LIMIT 1').first();
    return true;
  } catch {
    return false;
  }
}

/**
 * What the passkey routes need before doing anything: the switch on, a valid
 * relying party, and the request on that exact origin. Null means 404.
 */
export async function passkeyRouteContext(env: EnvLike | undefined, url: URL): Promise<RelyingParty | null> {
  if (!env) return null;
  const rp = relyingParty(env);
  if (!rp || url.origin !== rp.origin) return null;
  return await passkeySigninEnabled(env.DB) ? rp : null;
}

// ─── Challenges ──────────────────────────────────────────────────────────

interface ChallengeOwner {
  userId: string;
  sessionId: string;
}

async function storeChallenge(
  db: D1Database,
  challenge: string,
  owner: (ChallengeOwner & { userHandle: string }) | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO passkey_challenges (id, challenge, purpose, user_id, session_id, user_handle, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch('now') + ?)`,
  ).bind(
    id,
    challenge,
    owner ? 'register' : 'authenticate',
    owner?.userId ?? null,
    owner?.sessionId ?? null,
    owner?.userHandle ?? null,
    CHALLENGE_TTL_SECONDS,
  ).run();
  return id;
}

/**
 * Deletes and returns the challenge in one statement, so it can be used once
 * at most, whatever happens next. Expired, unknown, wrong-purpose or
 * wrong-owner ids return null (the row is deleted all the same).
 */
async function consumeChallenge(
  db: D1Database,
  id: unknown,
  owner: ChallengeOwner | null,
): Promise<{ challenge: string; userHandle: string | null } | null> {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const row = await db.prepare(
    `DELETE FROM passkey_challenges WHERE id = ?
     RETURNING challenge, purpose, user_id, session_id, user_handle, expires_at`,
  ).bind(id).first<{
    challenge: string;
    purpose: string;
    user_id: string | null;
    session_id: string | null;
    user_handle: string | null;
    expires_at: number;
  }>();
  if (!row || row.expires_at <= Math.floor(Date.now() / 1000)) return null;
  if (owner) {
    if (row.purpose !== 'register' || row.user_id !== owner.userId || row.session_id !== owner.sessionId) return null;
  } else if (row.purpose !== 'authenticate') {
    return null;
  }
  return { challenge: row.challenge, userHandle: row.user_handle };
}

// ─── Registration (signed in by the normal route) ───────────────────────

export type ManageRefusal = 'passkey_session' | 'stale_session' | 'no_session';

/**
 * Passkeys may be added or removed only from an ordinary, live session.
 * Adding also needs a session opened in the last REGISTRATION_FRESH_MINUTES.
 */
export async function manageRefusal(
  db: D1Database,
  userId: string,
  sessionId: string | null,
  options: { requireFresh: boolean },
): Promise<ManageRefusal | null> {
  if (!sessionId) return 'no_session';
  const row = await db.prepare(
    `SELECT passkey_credential_id,
            issued_at > datetime('now', ?) AS fresh
     FROM sessions WHERE id = ? AND user_id = ? AND revoked = 0 AND expires_at > datetime('now')`,
  ).bind(`-${REGISTRATION_FRESH_MINUTES} minutes`, sessionId, userId).first<{ passkey_credential_id: string | null; fresh: number }>();
  if (!row) return 'no_session';
  if (row.passkey_credential_id) return 'passkey_session';
  if (options.requireFresh && !row.fresh) return 'stale_session';
  return null;
}

export const MANAGE_REFUSAL_MESSAGES: Record<ManageRefusal, string> = {
  passkey_session: 'You signed in with a passkey. To add or remove passkeys, sign in the normal way.',
  stale_session: `For safety, sign out and sign in again, then add the passkey within ${REGISTRATION_FRESH_MINUTES} minutes.`,
  no_session: 'Sign in again to manage passkeys.',
};

async function existingUserHandle(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare('SELECT user_handle FROM passkey_credentials WHERE user_id = ? LIMIT 1')
    .bind(userId).first<{ user_handle: string }>();
  return row?.user_handle ?? null;
}

export async function listPasskeys(db: D1Database, userId: string): Promise<PasskeySummary[]> {
  const rows = await db.prepare(
    `SELECT id, device_name, created_at, last_used_at, device_type, backed_up
     FROM passkey_credentials WHERE user_id = ? ORDER BY created_at ASC, rowid ASC`,
  ).bind(userId).all<{ id: string; device_name: string; created_at: string; last_used_at: string | null; device_type: string; backed_up: number }>();
  return (rows.results || []).map((row) => ({
    id: row.id,
    deviceName: row.device_name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    synced: row.device_type === 'multiDevice' || row.backed_up === 1,
  }));
}

export type RegistrationStart =
  | { ok: true; challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }
  | { ok: false; status: number; error: string };

export async function startRegistration(
  env: EnvLike,
  rp: RelyingParty,
  user: User,
  sessionId: string | null,
): Promise<RegistrationStart> {
  const db = env.DB;
  if (user.status !== 'active') return { ok: false, status: 403, error: 'This account cannot add passkeys.' };
  const refusal = await manageRefusal(db, user.id, sessionId, { requireFresh: true });
  if (refusal) return { ok: false, status: 403, error: MANAGE_REFUSAL_MESSAGES[refusal] };
  const limit = await consumeRateLimit(db, 'passkey_register', user.id, RATE_LIMITS.registerPerUser.limit, RATE_LIMITS.registerPerUser.windowSeconds);
  if (!limit.allowed) return { ok: false, status: 429, error: RATE_LIMITED_MESSAGE };

  const existing = await db.prepare('SELECT id, transports FROM passkey_credentials WHERE user_id = ?')
    .bind(user.id).all<{ id: string; transports: string }>();
  const credentials = existing.results || [];
  if (credentials.length >= MAX_PASSKEYS_PER_USER) {
    return { ok: false, status: 409, error: `You already have ${MAX_PASSKEYS_PER_USER} passkeys. Remove one first.` };
  }
  // Reuse the account's handle so an authenticator keeps one entry per
  // account; the first passkey gets 32 fresh random bytes.
  const userHandle = await existingUserHandle(db, user.id)
    ?? isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));

  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.display_name || user.email,
    userID: isoBase64URL.toBuffer(userHandle),
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: 'none',
    excludeCredentials: credentials.map((row) => ({ id: row.id, transports: parseTransports(row.transports) })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
  });
  const challengeId = await storeChallenge(db, options.challenge, { userId: user.id, sessionId: sessionId!, userHandle });
  return { ok: true, challengeId, options };
}

function parseTransports(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function serializeTransports(value: unknown): string {
  const allowed = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
  const list = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && allowed.has(item)) : [];
  return JSON.stringify([...new Set(list)]);
}

function isCredentialShape(value: unknown): value is { id: string; rawId: string; type: string; response: Record<string, unknown> } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && candidate.id.length >= 16 && candidate.id.length <= MAX_CREDENTIAL_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(candidate.id)
    && typeof candidate.rawId === 'string'
    && candidate.rawId === candidate.id
    && candidate.type === 'public-key'
    && !!candidate.response && typeof candidate.response === 'object';
}

export type RegistrationFinish =
  | { ok: true; passkey: PasskeySummary }
  | { ok: false; status: number; error: string };

export async function finishRegistration(
  env: EnvLike,
  rp: RelyingParty,
  user: User,
  sessionId: string | null,
  body: unknown,
  options: { clientIp: string; waitUntil?: (promise: Promise<unknown>) => void },
): Promise<RegistrationFinish> {
  const db = env.DB;
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const deviceName = cleanDeviceName(input.deviceName);
  if (!deviceName) return { ok: false, status: 400, error: 'Give the passkey a name of up to 64 characters.' };
  if (user.status !== 'active') return { ok: false, status: 403, error: 'This account cannot add passkeys.' };
  const refusal = await manageRefusal(db, user.id, sessionId, { requireFresh: true });
  if (refusal) return { ok: false, status: 403, error: MANAGE_REFUSAL_MESSAGES[refusal] };

  // Consumed before anything else can fail: a challenge is never reusable.
  const pending = await consumeChallenge(db, input.challengeId, { userId: user.id, sessionId: sessionId! });
  if (!pending?.userHandle) return { ok: false, status: 400, error: 'That request expired. Try again.' };
  if (!isCredentialShape(input.response)) return { ok: false, status: 400, error: "The passkey response wasn't valid. Try again." };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON,
      expectedChallenge: pending.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    });
  } catch (error) {
    await audit(db, {
      event_type: 'auth.passkey_register_failed',
      actor_id: user.id,
      actor_role: user.role,
      target: user.id,
      detail: `Passkey registration refused: ${error instanceof Error ? error.message.slice(0, 200) : 'verification error'}`,
      ip_address: options.clientIp,
    });
    return { ok: false, status: 400, error: "The passkey couldn't be verified. Try again." };
  }
  if (!verification.verified || !verification.registrationInfo.userVerified) {
    return { ok: false, status: 400, error: "The passkey couldn't be verified. Try again." };
  }
  const info = verification.registrationInfo;
  const credentialId = info.credential.id;
  // The handle this authenticator was given (stored with the challenge).
  const userHandle = pending.userHandle;

  try {
    const result = await db.prepare(
      `INSERT INTO passkey_credentials
         (id, user_id, user_handle, public_key, counter, transports, device_name, device_type, backed_up, aaguid, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
       WHERE (SELECT COUNT(*) FROM passkey_credentials WHERE user_id = ?) < ?`,
    ).bind(
      credentialId,
      user.id,
      userHandle,
      isoBase64URL.fromBuffer(info.credential.publicKey),
      info.credential.counter,
      serializeTransports((input.response as { response?: { transports?: unknown } }).response?.transports),
      deviceName,
      info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0,
      info.aaguid.slice(0, 36),
      user.id,
      MAX_PASSKEYS_PER_USER,
    ).run();
    if (!result.meta.changes) {
      return { ok: false, status: 409, error: `You already have ${MAX_PASSKEYS_PER_USER} passkeys. Remove one first.` };
    }
  } catch {
    // Primary-key clash: this credential id is already registered (to anyone).
    return { ok: false, status: 409, error: 'This passkey is already registered.' };
  }

  await audit(db, {
    event_type: 'auth.passkey_registered',
    actor_id: user.id,
    actor_role: user.role,
    target: user.id,
    detail: `Registered passkey "${deviceName}" (${info.credentialDeviceType === 'multiDevice' ? 'synced' : 'single device'})`,
    ip_address: options.clientIp,
    session_id: sessionId,
  });
  const notice = notifyPasskeyAdded(env, user, deviceName).catch(() => undefined);
  if (options.waitUntil) options.waitUntil(notice);
  else await notice;

  return {
    ok: true,
    passkey: {
      id: credentialId,
      deviceName,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      synced: info.credentialDeviceType === 'multiDevice' || info.credentialBackedUp,
    },
  };
}

async function notifyPasskeyAdded(env: EnvLike, user: User, deviceName: string): Promise<void> {
  const envRecord = env as Record<string, unknown>;
  const settings = await loadOrgSettings(envRecord);
  if (detectProvider(envRecord) === 'none' || !settings.systemEmail) return;
  const appName = settings.appName || 'cmail';
  const subject = `A passkey was added to your ${appName} account`;
  const text = `A passkey named "${deviceName}" was added to your ${appName} account. It can sign you in when the normal sign-in is unavailable.\n\nIf this wasn't you, tell a manager now so they can remove it.`;
  const html = `<p>A passkey named <strong>${escapeHtml(deviceName)}</strong> was added to your ${escapeHtml(appName)} account. It can sign you in when the normal sign-in is unavailable.</p><p>If this wasn't you, tell a manager now so they can remove it.</p>`;
  const result = await sendEmail({ from: settings.systemEmail, fromName: settings.systemFromName, to: user.email, subject, html, text }, envRecord);
  if (!result.success) {
    await audit(env.DB, { event_type: 'email.failed', actor_id: user.id, target: user.id, detail: 'Passkey-added notice not delivered' });
  }
}

export async function removeOwnPasskey(
  db: D1Database,
  user: User,
  sessionId: string | null,
  credentialId: unknown,
  clientIp: string,
): Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }> {
  const refusal = await manageRefusal(db, user.id, sessionId, { requireFresh: false });
  if (refusal) return { ok: false, status: 403, error: MANAGE_REFUSAL_MESSAGES[refusal] };
  if (typeof credentialId !== 'string' || credentialId.length > MAX_CREDENTIAL_ID_LENGTH) {
    return { ok: false, status: 400, error: 'Unknown passkey.' };
  }
  const removed = await db.prepare(
    'DELETE FROM passkey_credentials WHERE id = ? AND user_id = ? RETURNING device_name',
  ).bind(credentialId, user.id).first<{ device_name: string }>();
  if (!removed) return { ok: false, status: 404, error: 'Unknown passkey.' };
  // The FK cascade deletes the sessions it opened; revoke explicitly too in
  // case a database runs without foreign-key enforcement.
  await db.prepare('UPDATE sessions SET revoked = 1 WHERE passkey_credential_id = ?').bind(credentialId).run();
  await audit(db, {
    event_type: 'auth.passkey_removed',
    actor_id: user.id,
    actor_role: user.role,
    target: user.id,
    detail: `Removed passkey "${removed.device_name}"`,
    ip_address: clientIp,
    session_id: sessionId,
  });
  return { ok: true, message: `Removed "${removed.device_name}".` };
}

// ─── Sign-in (/auth/passkey, no Microsoft, no Access) ───────────────────

export type AuthenticationStart =
  | { ok: true; challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }
  | { ok: false; status: number; message: string };

export async function startAuthentication(env: EnvLike, rp: RelyingParty, request: Request): Promise<AuthenticationStart> {
  const db = env.DB;
  const clientIp = clientIpOf(request) || 'unknown';
  const [perIp, global] = await Promise.all([
    consumeRateLimit(db, 'passkey_options_ip', clientIp, RATE_LIMITS.optionsPerIp.limit, RATE_LIMITS.optionsPerIp.windowSeconds),
    consumeRateLimit(db, 'passkey_options', 'global', RATE_LIMITS.optionsGlobal.limit, RATE_LIMITS.optionsGlobal.windowSeconds),
  ]);
  if (!perIp.allowed || !global.allowed) return { ok: false, status: 429, message: RATE_LIMITED_MESSAGE };
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
    timeout: CEREMONY_TIMEOUT_MS,
    allowCredentials: [],
  });
  const challengeId = await storeChallenge(db, options.challenge, null);
  return { ok: true, challengeId, options };
}

export type AuthenticationFinish =
  | { ok: true; user: User; sessionId: string; cookie: string; location: string }
  | { ok: false; status: number; message: string };

async function refuse(
  db: D1Database,
  reason: string,
  clientIp: string,
  userId?: string | null,
  status = 400,
): Promise<AuthenticationFinish> {
  await audit(db, {
    event_type: 'auth.passkey_failed',
    actor_id: userId ?? null,
    actor_role: 'system',
    target: userId ?? null,
    detail: `Passkey sign-in refused: ${reason}`,
    ip_address: clientIp,
  });
  return { ok: false, status, message: NEUTRAL_SIGNIN_FAILURE };
}

/**
 * Verifies a sign-in response and mints a session with the same lifetime,
 * cap, eviction, country gate and audit trail as every other sign-in, marked
 * as a passkey session.
 */
export async function finishAuthentication(
  env: SessionEnv,
  rp: RelyingParty,
  request: Request,
  body: unknown,
  options: { secureCookie: boolean; waitUntil?: (promise: Promise<unknown>) => void },
): Promise<AuthenticationFinish> {
  const db = env.DB;
  const clientIp = clientIpOf(request);
  const ipKey = clientIp || 'unknown';
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  const perIp = await consumeRateLimit(db, 'passkey_verify_ip', ipKey, RATE_LIMITS.verifyPerIp.limit, RATE_LIMITS.verifyPerIp.windowSeconds);
  if (!perIp.allowed) {
    await audit(db, { event_type: 'security.rate_limit', detail: 'Passkey sign-in rate limit (address)', ip_address: clientIp });
    return { ok: false, status: 429, message: RATE_LIMITED_MESSAGE };
  }

  // Single use: the challenge is gone from here on, whatever the outcome.
  // These two refusals involve no credential or account, so they are not
  // audited: anyone can send them, and the per-address limit bounds them.
  const neutral: AuthenticationFinish = { ok: false, status: 400, message: NEUTRAL_SIGNIN_FAILURE };
  const pending = await consumeChallenge(db, input.challengeId, null);
  if (!pending) return neutral;
  const expectedChallenge = pending.challenge;
  const response = input.response;
  if (!isCredentialShape(response)) return neutral;

  const credentialKey = (await hashToken(response.id)).slice(0, 32);
  const perCredential = await consumeRateLimit(db, 'passkey_verify_cred', credentialKey, RATE_LIMITS.verifyPerCredential.limit, RATE_LIMITS.verifyPerCredential.windowSeconds);
  if (!perCredential.allowed) {
    await audit(db, { event_type: 'security.rate_limit', detail: 'Passkey sign-in rate limit (credential)', ip_address: clientIp });
    return { ok: false, status: 429, message: RATE_LIMITED_MESSAGE };
  }

  const credential = await db.prepare(
    `SELECT id, user_id, user_handle, public_key, counter, transports, device_name
     FROM passkey_credentials WHERE id = ?`,
  ).bind(response.id).first<CredentialRow>();
  if (!credential) return refuse(db, 'unknown_credential', clientIp);

  // Discoverable credentials always return the user handle we issued.
  const userHandle = (response.response as { userHandle?: unknown }).userHandle;
  if (typeof userHandle !== 'string' || userHandle !== credential.user_handle) {
    return refuse(db, 'user_handle_mismatch', clientIp, credential.user_id);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: credential.counter,
        transports: parseTransports(credential.transports),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/counter value/i.test(message)) {
      // A counter that went backwards on a valid signature points to a
      // cloned authenticator. Refuse, audit loudly, and tell the managers.
      await audit(db, {
        event_type: 'auth.passkey_counter_rollback',
        actor_id: credential.user_id,
        actor_role: 'system',
        target: credential.user_id,
        detail: `Passkey "${credential.device_name}" sent a signature counter that did not increase; sign-in refused. Remove this passkey if it may be copied.`,
        ip_address: clientIp,
      });
      const notice = notifyManagers(env as unknown as Env, {
        subject: 'Passkey sign-in refused: possible copied passkey',
        text: 'A passkey sign-in was refused because the passkey\'s signature counter went backwards, which can mean the passkey was copied. Check Admin > Audit log (auth.passkey_counter_rollback) and remove the passkey in Admin > Passkey sign-in if needed.',
        html: '<p>A passkey sign-in was refused because the passkey\'s signature counter went backwards, which can mean the passkey was copied.</p><p>Check <strong>Admin &gt; Audit log</strong> (<code>auth.passkey_counter_rollback</code>) and remove the passkey in <strong>Admin &gt; Passkey sign-in</strong> if needed.</p>',
      }).catch(() => undefined);
      if (options.waitUntil) options.waitUntil(notice);
      else await notice;
      return { ok: false, status: 400, message: NEUTRAL_SIGNIN_FAILURE };
    }
    return refuse(db, `verification_failed (${message.slice(0, 120) || 'error'})`, clientIp, credential.user_id);
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return refuse(db, 'not_verified', clientIp, credential.user_id);
  }

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(credential.user_id).first<User>();
  if (!user || user.status !== 'active') return refuse(db, 'account_unavailable', clientIp, credential.user_id);

  // Compare-and-set the counter: of two responses verified against the same
  // stored value, only the first moves it.
  const newCounter = verification.authenticationInfo.newCounter;
  const moved = await db.prepare(
    `UPDATE passkey_credentials SET counter = ?, last_used_at = datetime('now')
     WHERE id = ? AND counter = ? AND (? > counter OR (? = 0 AND counter = 0))`,
  ).bind(newCounter, credential.id, credential.counter, newCounter, newCounter).run();
  if (!moved.meta.changes) return refuse(db, 'counter_race', clientIp, user.id);

  // Post-authentication country gate, as for every sign-in method. The
  // person has proven who they are, so the refusal says why.
  const settings = await loadOrgSettings(env);
  const country = requestCountry(request);
  const gate = await signInCountryGate(db, settings, { userId: user.id, country });
  if (!gate.allowed) {
    await recordTravelRequest(db, env as unknown as Env, { user, country, appUrl: settings.appUrl || rp.origin });
    await audit(db, {
      event_type: 'auth.sign_in_denied',
      actor_id: user.id,
      actor_role: user.role,
      target: user.id,
      detail: `Denied passkey sign-in: country_blocked (${country})`,
      ip_address: clientIp,
    });
    return { ok: false, status: 403, message: COUNTRY_PENDING_MESSAGE };
  }

  await db.prepare(
    `UPDATE users SET last_sign_in = datetime('now'), last_auth_country = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'active'`,
  ).bind(country, user.id).run();

  const ttlMs = sessionTtlMs(env);
  const { token, hash, expiresAt, sessionId } = await createSessionToken(user.id, env.SESSION_SECRET, ttlMs);
  await db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, issued_at, expires_at, ip_address, revoked, passkey_credential_id)
     VALUES (?, ?, ?, datetime('now'), ?, ?, 0, ?)`,
  ).bind(sessionId, user.id, hash, expiresAt.toISOString(), clientIp, credential.id).run();
  // Same eviction rule as every other sign-in: keep the most recently renewed.
  await db.prepare(
    `UPDATE sessions SET revoked = 1
     WHERE user_id = ? AND revoked = 0 AND id NOT IN (
       SELECT id FROM sessions WHERE user_id = ? AND revoked = 0 ORDER BY expires_at DESC, id DESC LIMIT ?
     )`,
  ).bind(user.id, user.id, maxSessionsPerUser(env)).run();

  await audit(db, {
    event_type: 'auth.sign_in',
    actor_id: user.id,
    actor_role: user.role,
    target: user.id,
    detail: `Signed in via passkey "${credential.device_name}"`,
    ip_address: clientIp,
    session_id: sessionId,
  });
  if (user.role === 'manager') {
    await audit(db, {
      event_type: 'auth.passkey_manager_sign_in',
      actor_id: user.id,
      actor_role: 'manager',
      target: user.id,
      detail: 'Manager break-glass sign-in with a passkey',
      ip_address: clientIp,
      session_id: sessionId,
    });
    const appName = settings.appName || 'cmail';
    const who = escapeHtml(user.email);
    const notice = notifyManagers(env as unknown as Env, {
      subject: `Manager signed in to ${appName} with a passkey`,
      text: `${user.email} signed in to ${appName} with a passkey (break-glass sign-in). If this wasn't expected, check Admin > Audit log and Admin > Passkey sign-in.`,
      html: `<p><strong>${who}</strong> signed in to ${escapeHtml(appName)} with a passkey (break-glass sign-in).</p><p>If this wasn't expected, check <strong>Admin &gt; Audit log</strong> and <strong>Admin &gt; Passkey sign-in</strong>.</p>`,
    }).catch(() => undefined);
    if (options.waitUntil) options.waitUntil(notice);
    else await notice;
  }

  const latestPolicy = await db.prepare(
    'SELECT id FROM ict_policy_versions ORDER BY published_at DESC, id DESC LIMIT 1',
  ).first<{ id: string }>();
  let location = '/mail';
  if (latestPolicy) {
    const signature = await db.prepare(
      'SELECT id FROM ict_policy_signatures WHERE user_id = ? AND policy_version_id = ?',
    ).bind(user.id, latestPolicy.id).first<{ id: string }>();
    if (!signature) location = '/policy';
  }
  return { ok: true, user, sessionId, cookie: buildSessionCookie(token, options.secureCookie), location };
}

// ─── Sessions (hooks.server.ts) ─────────────────────────────────────────

/**
 * For a session row carrying the passkey marker: 'live' while the feature is
 * on and the passkey still belongs to the account, 'dead' when either is no
 * longer true, 'error' when the check itself failed.
 */
export async function passkeySessionState(
  db: D1Database,
  credentialId: string,
  userId: string,
): Promise<'live' | 'dead' | 'error'> {
  try {
    const row = await db.prepare(
      `SELECT EXISTS (SELECT 1 FROM passkey_credentials WHERE id = ? AND user_id = ?) AS live,
              EXISTS (SELECT 1 FROM org_settings WHERE key = ? AND value = 'true') AS enabled`,
    ).bind(credentialId, userId, PASSKEY_SETTING_ENABLED).first<{ live: number; enabled: number }>();
    if (!row) return 'error';
    return Number(row.live) === 1 && Number(row.enabled) === 1 ? 'live' : 'dead';
  } catch {
    return 'error';
  }
}

// ─── Admin ──────────────────────────────────────────────────────────────

export interface PasskeyAdminOverview {
  enabled: boolean;
  installed: boolean;
  rp: RelyingParty | null;
  totalPasskeys: number;
  people: Array<{ userId: string; email: string; displayName: string; role: string; status: string; count: number; lastUsedAt: string | null }>;
}

export async function loadPasskeyAdminOverview(env: EnvLike): Promise<PasskeyAdminOverview> {
  const db = env.DB;
  const [enabled, installed] = await Promise.all([passkeySigninEnabled(db), passkeysInstalled(db)]);
  const rp = relyingParty(env);
  if (!installed) return { enabled, installed, rp, totalPasskeys: 0, people: [] };
  const rows = await db.prepare(
    `SELECT u.id AS user_id, u.email, u.display_name, u.role, u.status,
            COUNT(c.id) AS count, MAX(c.last_used_at) AS last_used_at
     FROM passkey_credentials c INNER JOIN users u ON u.id = c.user_id
     GROUP BY u.id ORDER BY lower(u.email) ASC LIMIT 1000`,
  ).all<{ user_id: string; email: string; display_name: string; role: string; status: string; count: number; last_used_at: string | null }>();
  const people = (rows.results || []).map((row) => ({
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    count: Number(row.count),
    lastUsedAt: row.last_used_at,
  }));
  return { enabled, installed, rp, totalPasskeys: people.reduce((sum, person) => sum + person.count, 0), people };
}

export type PasskeyAdminAction = 'enable' | 'disable' | 'remove_user';

export function parsePasskeyAdminAction(value: unknown): PasskeyAdminAction | null {
  return value === 'enable' || value === 'disable' || value === 'remove_user' ? value : null;
}

/** The caller has already checked the manager role. */
export async function applyPasskeyAdminAction(
  env: EnvLike,
  manager: { id: string },
  action: PasskeyAdminAction,
  targetUserId: unknown,
  clientIp: string,
): Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }> {
  const db = env.DB;
  if (action === 'enable') {
    if (!await passkeysInstalled(db)) return { ok: false, status: 409, error: 'Apply database migration 0025 before turning on passkey sign-in.' };
    if (!relyingParty(env)) return { ok: false, status: 409, error: 'APP_URL must be set to this site\'s https address before passkeys can work.' };
    await putSetting(db, 'true', manager.id);
    await audit(db, { event_type: 'org.passkey_signin_toggled', actor_id: manager.id, actor_role: 'manager', detail: 'Passkey sign-in turned on', ip_address: clientIp });
    return { ok: true, message: 'Passkey sign-in is on. People can now add passkeys under Mail > Settings > Passkeys.' };
  }
  if (action === 'disable') {
    await putSetting(db, 'false', manager.id);
    let ended = 0;
    try {
      const result = await db.prepare(
        'UPDATE sessions SET revoked = 1 WHERE passkey_credential_id IS NOT NULL AND revoked = 0',
      ).run();
      ended = result.meta.changes ?? 0;
    } catch {
      // Before migration 0025 there are no passkey sessions to end.
    }
    await audit(db, { event_type: 'org.passkey_signin_toggled', actor_id: manager.id, actor_role: 'manager', detail: `Passkey sign-in turned off; ${ended} passkey sessions ended`, ip_address: clientIp });
    return { ok: true, message: 'Passkey sign-in is off. Passkey sessions were signed out; registered passkeys are kept for when it is turned on again.' };
  }
  if (typeof targetUserId !== 'string' || !targetUserId || targetUserId.length > 64) {
    return { ok: false, status: 400, error: 'Unknown person.' };
  }
  const target = await db.prepare('SELECT id, email FROM users WHERE id = ?').bind(targetUserId).first<{ id: string; email: string }>();
  if (!target) return { ok: false, status: 404, error: 'Unknown person.' };
  await db.prepare(
    'UPDATE sessions SET revoked = 1 WHERE user_id = ? AND passkey_credential_id IS NOT NULL AND revoked = 0',
  ).bind(target.id).run();
  const removed = await db.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').bind(target.id).run();
  await audit(db, {
    event_type: 'auth.passkey_removed',
    actor_id: manager.id,
    actor_role: 'manager',
    target: target.id,
    detail: `Manager removed all ${removed.meta.changes ?? 0} passkeys of this account and ended its passkey sessions`,
    ip_address: clientIp,
  });
  return { ok: true, message: `Removed ${removed.meta.changes ?? 0} passkeys for ${target.email}.` };
}

async function putSetting(db: D1Database, value: string, managerId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO org_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
  ).bind(PASSKEY_SETTING_ENABLED, value, managerId).run();
}

export const __test = { consumeChallenge, storeChallenge };
