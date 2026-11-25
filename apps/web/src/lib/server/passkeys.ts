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
// - A sign-in response must carry the userHandle stored with the credential.
//   The signature is verified first; only then is the signature counter
//   compared (it must go up unless it is always 0), so a forged response can
//   never raise the copied-passkey alarm. The stored counter is moved with a
//   compare-and-set, so two racing responses cannot both win.
// - Rate limits count failures only (per address, IPv6 per /64), so a busy
//   office NAT is not locked out by its own successful sign-ins. There is no
//   global cap: one host must not be able to lock everyone out.
// - Passkey sessions last PASSKEY_SESSION_TTL_HOURS (default 8) and are
//   never renewed by use. They are accepted only on the APP_URL origin.
// - Adding or removing a passkey, and turning the feature on or off, emails
//   the person and the managers. With no mail set up, that is audited and
//   shown in Admin.
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
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Env, User } from '@stanchion/shared/types';

// The WebAuthn library is loaded only when a passkey ceremony runs. This
// module is also imported by hooks.server.ts (for the session check), so a
// static import would put the library on every request's cold start.
const loadWebAuthn = () => import('@simplewebauthn/server');
const loadBase64Url = async () => (await import('@simplewebauthn/server/helpers')).isoBase64URL;
import { audit } from './db';
import { maxSessionsPerUser, passkeySessionTtlMs } from './config';
import { loadOrgSettings } from './org-settings';
import { notifyManagers } from './notify-managers';
import { detectProvider, sendEmail } from './outbound';
import { consumeRateLimit, rateLimitCount } from './rate-limit';
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
 * Rate limits; every refusal looks the same. Addresses are keyed per IPv4
 * address or per IPv6 /64. There is deliberately no global cap: it would let
 * one host lock everyone out of break-glass sign-in during an outage.
 * - optionsPerIp: challenge requests per address.
 * - verifyFailuresPerIp: FAILED sign-ins per address (successes are free).
 * - verifyPerCredential: sign-ins with a valid signature per passkey, counted
 *   only after the signature checks out, so nobody can exhaust it for a
 *   passkey they do not hold.
 */
export const RATE_LIMITS = {
  optionsPerIp: { limit: 30, windowSeconds: 10 * 60 },
  verifyFailuresPerIp: { limit: 10, windowSeconds: 10 * 60 },
  verifyPerCredential: { limit: 20, windowSeconds: 60 * 60 },
  registerPerUser: { limit: 10, windowSeconds: 60 * 60 },
  removePerUser: { limit: 10, windowSeconds: 60 * 60 },
} as const;
/**
 * Passkey security notices to managers have their own hourly budget, so a
 * flood of other manager notices (travel requests) can never hide them, and
 * they cannot crowd those out either.
 */
export const PASSKEY_NOTICE_BUDGET = { scope: 'mgr_notify_passkey', limit: 60 };
/** Unknown passkey ids are counted, and audited only at these counts per hour. */
const UNKNOWN_CREDENTIAL_AUDIT_AT = new Set([1, 10, 100, 1000, 10000]);

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

/**
 * Rate-limit key for an address: IPv4 as is, IPv6 cut to its /64 (one
 * customer network), IPv4-mapped IPv6 as the IPv4 address.
 */
export function rateLimitAddressKey(ip: string): string {
  const value = ip.trim().toLowerCase().replace(/%.*$/, '');
  if (!value) return 'unknown';
  if (!value.includes(':')) return value.slice(0, 64);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return mapped[1];
  const halves = value.split('::');
  if (halves.length > 2) return value.slice(0, 64);
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return value.slice(0, 64);
  const groups = [...head, ...Array<string>(Math.max(0, missing)).fill('0'), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return value.slice(0, 64);
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::/64`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sendUserNotice(
  env: EnvLike,
  user: { id: string; email: string },
  message: { subject: string; text: string; html: string },
): Promise<void> {
  const envRecord = env as Record<string, unknown>;
  const settings = await loadOrgSettings(envRecord);
  if (detectProvider(envRecord) === 'none' || !settings.systemEmail) {
    await audit(env.DB, {
      event_type: 'email.failed',
      actor_id: user.id,
      target: user.id,
      detail: `Passkey notice not sent (no outbound provider or system From address): ${message.subject.slice(0, 120)}`,
    });
    return;
  }
  const result = await sendEmail({ from: settings.systemEmail, fromName: settings.systemFromName, to: user.email, ...message, system: true }, envRecord);
  if (!result.success) {
    await audit(env.DB, { event_type: 'email.failed', actor_id: user.id, target: user.id, detail: `Passkey notice not delivered: ${message.subject.slice(0, 120)}` });
  }
}

/**
 * Emails the person (when given) and every active manager about a passkey
 * change. Best effort; failures and missing mail settings are audited
 * (notifyManagers audits its own), never silent.
 */
async function passkeyNotice(
  env: EnvLike,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  notice: { user?: { id: string; email: string }; subject: string; text: string },
): Promise<void> {
  const html = notice.text.split('\n\n').map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('');
  const tasks: Promise<unknown>[] = [
    notifyManagers(env as unknown as Env, { subject: notice.subject, text: notice.text, html }, PASSKEY_NOTICE_BUDGET),
  ];
  if (notice.user) tasks.push(sendUserNotice(env, notice.user, { subject: notice.subject, text: notice.text, html }));
  const all = Promise.all(tasks.map((task) => task.catch((error: unknown) => {
    console.error('Passkey notice failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
  })));
  if (waitUntil) waitUntil(all);
  else await all;
}

/** True when outbound mail is set up, so passkey notices can be delivered. */
export async function passkeyMailConfigured(env: EnvLike): Promise<boolean> {
  const envRecord = env as Record<string, unknown>;
  if (detectProvider(envRecord) === 'none') return false;
  return !!(await loadOrgSettings(envRecord)).systemEmail;
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
    const name = typeof env.APP_NAME === 'string' && env.APP_NAME.trim() ? env.APP_NAME.trim().slice(0, 64) : 'Stanchion';
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
  const [{ generateRegistrationOptions }, isoBase64URL] = await Promise.all([loadWebAuthn(), loadBase64Url()]);
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

  const [{ verifyRegistrationResponse }, isoBase64URL] = await Promise.all([loadWebAuthn(), loadBase64Url()]);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // A primary-key clash means this credential id is already registered
    // (to anyone). Anything else is a real database error and says so.
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(message)) {
      return { ok: false, status: 409, error: 'This passkey is already registered.' };
    }
    console.error('Passkey registration insert failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
    return { ok: false, status: 503, error: "The passkey couldn't be saved. Try again shortly." };
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
  const appName = await appNameOf(env);
  await passkeyNotice(env, options.waitUntil, {
    user,
    subject: `Passkey added to ${user.email} on ${appName}`,
    text: `A passkey named "${deviceName}" was added to the ${appName} account ${user.email}. It can sign in to that account when the normal sign-in is unavailable.\n\nIf this wasn't expected, a manager can remove it in Admin > Passkey sign-in.`,
  });

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

async function appNameOf(env: EnvLike): Promise<string> {
  return (await loadOrgSettings(env as Record<string, unknown>)).appName || 'Stanchion';
}

export async function removeOwnPasskey(
  env: EnvLike,
  user: User,
  sessionId: string | null,
  credentialId: unknown,
  clientIp: string,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }> {
  const db = env.DB;
  const refusal = await manageRefusal(db, user.id, sessionId, { requireFresh: false });
  if (refusal) return { ok: false, status: 403, error: MANAGE_REFUSAL_MESSAGES[refusal] };
  if (typeof credentialId !== 'string' || credentialId.length > MAX_CREDENTIAL_ID_LENGTH) {
    return { ok: false, status: 400, error: 'Unknown passkey.' };
  }
  // Each removal emails the managers; cap them so one account cannot flood.
  const limit = await consumeRateLimit(db, 'passkey_remove', user.id, RATE_LIMITS.removePerUser.limit, RATE_LIMITS.removePerUser.windowSeconds);
  if (!limit.allowed) return { ok: false, status: 429, error: 'Too many changes. Wait a while and try again.' };
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
  const appName = await appNameOf(env);
  await passkeyNotice(env, waitUntil, {
    user,
    subject: `Passkey removed from ${user.email} on ${appName}`,
    text: `The passkey "${removed.device_name}" was removed from the ${appName} account ${user.email} by its owner. Any sessions it opened were signed out.`,
  });
  return { ok: true, message: `Removed "${removed.device_name}".` };
}

// ─── Sign-in (/auth/passkey, no Microsoft, no Access) ───────────────────

export type AuthenticationStart =
  | { ok: true; challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }
  | { ok: false; status: number; message: string };

export async function startAuthentication(env: EnvLike, rp: RelyingParty, request: Request): Promise<AuthenticationStart> {
  const db = env.DB;
  const addressKey = rateLimitAddressKey(clientIpOf(request));
  const perAddress = await consumeRateLimit(db, 'passkey_options_ip', addressKey, RATE_LIMITS.optionsPerIp.limit, RATE_LIMITS.optionsPerIp.windowSeconds);
  if (!perAddress.allowed) return { ok: false, status: 429, message: RATE_LIMITED_MESSAGE };
  const { generateAuthenticationOptions } = await loadWebAuthn();
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

const NEUTRAL: AuthenticationFinish = { ok: false, status: 400, message: NEUTRAL_SIGNIN_FAILURE };
const LIMITED: AuthenticationFinish = { ok: false, status: 429, message: RATE_LIMITED_MESSAGE };

/**
 * Verifies a sign-in response and mints a passkey session with the session
 * cap, eviction, country gate and audit trail of every other sign-in, but a
 * short lifetime that use never extends (PASSKEY_SESSION_TTL_HOURS).
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
  const addressKey = rateLimitAddressKey(clientIp);
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const failures = RATE_LIMITS.verifyFailuresPerIp;

  // Only failures count against an address, so many people signing in from
  // one office address during an outage are never locked out by success.
  if (await rateLimitCount(db, 'passkey_fail_ip', addressKey, failures.windowSeconds) >= failures.limit) return LIMITED;

  /** Records one failure for this address; audits only the one that hits the limit. */
  const fail = async (audited?: { reason: string; userId: string }): Promise<AuthenticationFinish> => {
    const counted = await consumeRateLimit(db, 'passkey_fail_ip', addressKey, failures.limit, failures.windowSeconds);
    if (counted.remaining === 0 && counted.allowed) {
      await audit(db, { event_type: 'security.rate_limit', detail: 'Passkey sign-in failure limit reached for an address', ip_address: clientIp });
    }
    if (audited) {
      await audit(db, {
        event_type: 'auth.passkey_failed',
        actor_id: audited.userId,
        actor_role: 'system',
        target: audited.userId,
        detail: `Passkey sign-in refused: ${audited.reason}`,
        ip_address: clientIp,
      });
    }
    return NEUTRAL;
  };

  // Single use: the challenge is gone from here on, whatever the outcome.
  // Refusals that involve no known passkey are never audited one by one:
  // anyone can send them.
  const pending = await consumeChallenge(db, input.challengeId, null);
  if (!pending) return fail();
  const response = input.response;
  if (!isCredentialShape(response)) return fail();

  const credential = await db.prepare(
    `SELECT id, user_id, user_handle, public_key, counter, transports, device_name
     FROM passkey_credentials WHERE id = ?`,
  ).bind(response.id).first<CredentialRow>();
  if (!credential) {
    // One counter for all unknown ids; audited at 1, 10, 100... per hour.
    const seen = await consumeRateLimit(db, 'passkey_unknown_cred', 'all', Number.MAX_SAFE_INTEGER, 60 * 60);
    const total = Number.MAX_SAFE_INTEGER - seen.remaining;
    if (UNKNOWN_CREDENTIAL_AUDIT_AT.has(total)) {
      await audit(db, { event_type: 'auth.passkey_failed', detail: `Passkey sign-in refused: unknown passkey (${total} this hour)`, ip_address: clientIp });
    }
    return fail();
  }

  // Discoverable credentials always return the user handle we issued.
  const userHandle = (response.response as { userHandle?: unknown }).userHandle;
  if (typeof userHandle !== 'string' || userHandle !== credential.user_handle) {
    return fail({ reason: 'user_handle_mismatch', userId: credential.user_id });
  }

  // The signature is verified with the library's counter check switched off
  // (stored counter passed as 0: it then never rejects on the counter). The
  // counter is compared below, only once the signature is known to be valid,
  // so a forged response can never raise the copied-passkey alarm.
  const [{ verifyAuthenticationResponse }, isoBase64URL] = await Promise.all([loadWebAuthn(), loadBase64Url()]);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: pending.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: 0,
        transports: parseTransports(credential.transports),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 120) : 'error';
    return fail({ reason: `verification_failed (${message})`, userId: credential.user_id });
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return fail({ reason: 'not_verified', userId: credential.user_id });
  }

  const newCounter = verification.authenticationInfo.newCounter;
  if ((credential.counter > 0 || newCounter > 0) && newCounter <= credential.counter) {
    // A valid signature with a counter that did not go up: the passkey may
    // have been copied. Refuse, audit loudly and tell the managers.
    await audit(db, {
      event_type: 'auth.passkey_counter_rollback',
      actor_id: credential.user_id,
      actor_role: 'system',
      target: credential.user_id,
      detail: `Passkey "${credential.device_name}" sent counter ${newCounter} after ${credential.counter} with a valid signature; sign-in refused. Remove this passkey if it may be copied.`,
      ip_address: clientIp,
    });
    await passkeyNotice(env, options.waitUntil, {
      subject: 'Passkey sign-in refused: possible copied passkey',
      text: 'A passkey sign-in was refused because the passkey\'s signature counter went backwards, which can mean the passkey was copied.\n\nCheck Admin > Audit log (auth.passkey_counter_rollback) and remove the passkey in Admin > Passkey sign-in if needed.',
    });
    return fail();
  }

  // Valid signatures per passkey, counted only now, so nobody without the
  // passkey can use up its allowance.
  const perCredential = await consumeRateLimit(
    db, 'passkey_verify_cred', (await hashToken(credential.id)).slice(0, 32),
    RATE_LIMITS.verifyPerCredential.limit, RATE_LIMITS.verifyPerCredential.windowSeconds,
  );
  if (!perCredential.allowed) {
    // Audited once per passkey and window, not per request.
    const first = await consumeRateLimit(db, 'passkey_cred_limit_audit', credential.id.slice(0, 64), 1, RATE_LIMITS.verifyPerCredential.windowSeconds);
    if (first.allowed) {
      await audit(db, { event_type: 'security.rate_limit', actor_id: credential.user_id, target: credential.user_id, detail: 'Passkey sign-in limit reached for one passkey', ip_address: clientIp });
    }
    return LIMITED;
  }

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(credential.user_id).first<User>();
  if (!user || user.status !== 'active') return fail({ reason: 'account_unavailable', userId: credential.user_id });

  // Compare-and-set the counter: of two responses verified against the same
  // stored value, only the first moves it.
  const moved = await db.prepare(
    `UPDATE passkey_credentials SET counter = ?
     WHERE id = ? AND counter = ? AND (? > counter OR (? = 0 AND counter = 0))`,
  ).bind(newCounter, credential.id, credential.counter, newCounter, newCounter).run();
  if (!moved.meta.changes) return fail({ reason: 'counter_race', userId: user.id });

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

  await db.batch([
    db.prepare(`UPDATE passkey_credentials SET last_used_at = datetime('now') WHERE id = ?`).bind(credential.id),
    db.prepare(
      `UPDATE users SET last_sign_in = datetime('now'), last_auth_country = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'active'`,
    ).bind(country, user.id),
  ]);

  const ttlMs = passkeySessionTtlMs(env);
  const { token, hash, sessionId } = await createSessionToken(user.id, env.SESSION_SECRET, ttlMs);
  // expires_at is written by SQLite's datetime() ('YYYY-MM-DD HH:MM:SS'),
  // the same text format hooks.server.ts compares it with, so the fixed
  // lifetime ends exactly on time. (An ISO 'T...Z' value would compare as
  // later than any same-day datetime('now') text and live until midnight.)
  await db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, issued_at, expires_at, ip_address, revoked, passkey_credential_id)
     VALUES (?, ?, ?, datetime('now'), datetime('now', '+' || ? || ' seconds'), ?, 0, ?)`,
  ).bind(sessionId, user.id, hash, Math.round(ttlMs / 1000), clientIp, credential.id).run();
  // Same eviction rule as every other sign-in: keep the latest-expiring.
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
    const appName = settings.appName || 'Stanchion';
    await passkeyNotice(env, options.waitUntil, {
      subject: `Manager signed in to ${appName} with a passkey`,
      text: `${user.email} signed in to ${appName} with a passkey (break-glass sign-in).\n\nIf this wasn't expected, check Admin > Audit log and Admin > Passkey sign-in.`,
    });
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

/** Request bodies are measured in bytes, not characters. */
export function bodyTooLarge(raw: string, maxBytes: number): boolean {
  return raw.length > maxBytes || byteLength(raw) > maxBytes;
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
  /** False when passkey notices cannot be emailed (no provider or From address). */
  mailConfigured: boolean;
  totalPasskeys: number;
  people: Array<{ userId: string; email: string; displayName: string; role: string; status: string; count: number; lastUsedAt: string | null }>;
  /** The newest passkeys first, so managers can review what was added. */
  recent: Array<{ email: string; deviceName: string; createdAt: string; lastUsedAt: string | null }>;
}

export async function loadPasskeyAdminOverview(env: EnvLike): Promise<PasskeyAdminOverview> {
  const db = env.DB;
  const [enabled, installed, mailConfigured] = await Promise.all([passkeySigninEnabled(db), passkeysInstalled(db), passkeyMailConfigured(env)]);
  const rp = relyingParty(env);
  if (!installed) return { enabled, installed, rp, mailConfigured, totalPasskeys: 0, people: [], recent: [] };
  const recentRows = await db.prepare(
    `SELECT u.email, c.device_name, c.created_at, c.last_used_at
     FROM passkey_credentials c INNER JOIN users u ON u.id = c.user_id
     ORDER BY c.created_at DESC, c.rowid DESC LIMIT 50`,
  ).all<{ email: string; device_name: string; created_at: string; last_used_at: string | null }>();
  const recent = (recentRows.results || []).map((row) => ({
    email: row.email, deviceName: row.device_name, createdAt: row.created_at, lastUsedAt: row.last_used_at,
  }));
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
  return { enabled, installed, rp, mailConfigured, totalPasskeys: people.reduce((sum, person) => sum + person.count, 0), people, recent };
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
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }> {
  const db = env.DB;
  const appName = await appNameOf(env);
  const managerEmail = (await db.prepare('SELECT email FROM users WHERE id = ?').bind(manager.id).first<{ email: string }>())?.email || 'A manager';
  if (action === 'enable') {
    if (!await passkeysInstalled(db)) return { ok: false, status: 409, error: 'Apply database migration 0025 before turning on passkey sign-in.' };
    if (!relyingParty(env)) return { ok: false, status: 409, error: 'APP_URL must be set to this site\'s https address before passkeys can work.' };
    await putSetting(db, 'true', manager.id);
    await audit(db, { event_type: 'org.passkey_signin_toggled', actor_id: manager.id, actor_role: 'manager', detail: 'Passkey sign-in turned on', ip_address: clientIp });
    await passkeyNotice(env, waitUntil, {
      subject: `Passkey sign-in turned on for ${appName}`,
      text: `${managerEmail} turned on passkey break-glass sign-in for ${appName}. People can now add passkeys, and each one added is emailed to the managers.`,
    });
    const warning = await passkeyMailConfigured(env) ? '' : ' Warning: outbound mail is not set up, so passkey notices cannot be emailed; review new passkeys on this page.';
    return { ok: true, message: `Passkey sign-in is on. People can now add passkeys under Mail > Settings > Passkeys.${warning}` };
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
    await passkeyNotice(env, waitUntil, {
      subject: `Passkey sign-in turned off for ${appName}`,
      text: `${managerEmail} turned off passkey break-glass sign-in for ${appName}. ${ended} passkey sessions were signed out.`,
    });
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
  await passkeyNotice(env, waitUntil, {
    user: target,
    subject: `Passkeys removed from ${target.email} on ${appName}`,
    text: `${managerEmail} removed all ${removed.meta.changes ?? 0} passkeys from the ${appName} account ${target.email} and signed out its passkey sessions. The account holder can add new passkeys the next time they sign in the normal way.`,
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
