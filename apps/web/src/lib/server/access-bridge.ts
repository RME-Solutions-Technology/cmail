// Cloudflare Access bridge: turns a verified Access identity (access-jwt.ts)
// into a Stanchion account and session.
//
// Binding rules (see docs/staff-sign-in.md):
// - The authority is user_identities('access', <Access sub>). Returning
//   visits are looked up by sub only; the token's email is never a lookup
//   key once a binding exists.
// - A first visit may adopt an existing account by verified email only when
//   that account has no sign-in identity yet (an invited or synced account
//   that never signed in), is standard, and is pending or active. An account
//   that already signs in with Google, Microsoft or email, and every manager,
//   links instead by visiting once while signed in through that provider.
// - ACCESS_AUTO_PROVISION=true creates a standard account and personal
//   mailbox only for an email on MAIL_DOMAIN. Managers are never created.
// - The sign-in country gate runs before any binding, activation or account
//   creation.
// - Nothing happens before the first manager exists: /bootstrap stays the
//   only way to create that account.

import type { Env, User } from '@cmail/shared/types';
import type { AccessIdentity } from './access-jwt';
import { audit } from './db';
import { maxSessionsPerUser, sessionTtlMs } from './config';
import { buildSessionCookie, createSessionToken, hashToken } from './session';
import { loadOrgSettings } from './org-settings';
import { consumeRateLimit } from './rate-limit';
import { countryAllowed, recordTravelRequest, requestCountry, signInCountryGate } from './travel';
import { normalizeDomain, normalizeEmail, normalizeMailboxLocalPart } from './validation';

export type AccessDenyReason =
  | 'account_suspended'
  | 'identity_conflict'
  | 'link_required'
  | 'enrollment_required'
  | 'not_set_up'
  | 'country_pending';

export type AccessResolution =
  | { ok: true; user: User; how: 'returning' | 'bound_existing' | 'provisioned'; emailChanged: boolean }
  | { ok: false; reason: AccessDenyReason; userId?: string };

/** Country check run before anything is bound or created; null = no account yet. */
export type AccessCountryGate = (user: User | null) => Promise<boolean>;

const SUSPENDED = new Set(['paused', 'offboarded']);
/** Repeated denials and email-change notes for one person are audited once per window. */
export const ACCESS_AUDIT_DEDUPE_SECONDS = 10 * 60;

/** Paths where an Access identity must not open a session on its own. */
export function accessSignInPathAllowed(method: string, pathname: string): boolean {
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) return false;
  if (pathname === '/bootstrap' || pathname === '/mcp') return false;
  return !['/auth/', '/enroll/', '/oauth/token', '/oauth/register', '/oauth/revoke', '/.well-known/']
    .some((prefix) => pathname.startsWith(prefix));
}

export async function findAccessBoundUser(db: D1Database, subject: string): Promise<User | null> {
  return db.prepare(
    `SELECT u.* FROM user_identities identity
     INNER JOIN users u ON u.id = identity.user_id
     WHERE identity.provider = 'access' AND identity.subject = ?`,
  ).bind(subject).first<User>();
}

export async function accessSubjectForUser(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT subject FROM user_identities WHERE provider = 'access' AND user_id = ?`,
  ).bind(userId).first<{ subject: string }>();
  return row?.subject ?? null;
}

/**
 * Writes the audit row only once per person, reason and window, so a
 * refused user browsing around cannot flood audit_log. The rate-limit key is
 * a hash, so the table never holds the sub or email. If the throttle itself
 * fails the row is written anyway: losing the record is worse than a repeat.
 */
async function auditDeduped(
  db: D1Database,
  key: string,
  event: Parameters<typeof audit>[1],
): Promise<void> {
  try {
    const hashed = (await hashToken(key)).slice(0, 32);
    const slot = await consumeRateLimit(db, 'access-audit', hashed, 1, ACCESS_AUDIT_DEDUPE_SECONDS);
    if (!slot.allowed) return;
  } catch {
    // Fall through and audit.
  }
  await audit(db, event);
}

/**
 * Inserts the binding only if this account still has no Access identity and
 * is still eligible. `requireNoIdentity` is the first-visit adoption rule:
 * the account must have no identity of any kind. The (provider, subject)
 * primary key stops one sub binding twice; the (provider, user_id) unique key
 * from migration 0021 stops one account holding two subs.
 */
async function bindAccessIdentity(
  db: D1Database,
  userId: string,
  subject: string,
  options: { allowManager: boolean; requireNoIdentity: boolean },
): Promise<boolean> {
  try {
    const result = await db.prepare(
      `INSERT INTO user_identities (provider, subject, user_id, created_at)
       SELECT 'access', ?, u.id, datetime('now') FROM users u
       WHERE u.id = ?
         AND u.status IN ('pending', 'active')
         AND (? = 1 OR u.role = 'standard')
         AND NOT EXISTS (
           SELECT 1 FROM user_identities i
           WHERE i.user_id = u.id AND (i.provider = 'access' OR ? = 1)
         )`,
    ).bind(subject, userId, options.allowManager ? 1 : 0, options.requireNoIdentity ? 1 : 0).run();
    if (!result.meta.changes) return false;
  } catch {
    // A primary-key or unique violation means another request or account
    // already holds this binding.
    return false;
  }
  await db.prepare(
    `UPDATE users SET status = 'active', updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`,
  ).bind(userId).run();
  return true;
}

function provisionableAddress(identity: AccessIdentity, mailDomain: string): { localPart: string } | null {
  const [localPart, domain] = identity.email.split('@');
  if (domain !== mailDomain || normalizeMailboxLocalPart(localPart) !== localPart) return null;
  return { localPart };
}

async function provisionAccessUser(
  db: D1Database,
  identity: AccessIdentity,
  localPart: string,
): Promise<User | null> {
  const userId = crypto.randomUUID();
  const mailboxId = crypto.randomUUID();
  try {
    // Plain INSERTs: any unique clash (email, sub, mailbox address) throws
    // and the batch rolls back whole, so no half-made account remains.
    await db.batch([
      db.prepare(
        `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
         VALUES (?, ?, '', 'standard', 'active', datetime('now'), datetime('now'))`,
      ).bind(userId, identity.email),
      db.prepare(
        `INSERT INTO user_identities (provider, subject, user_id, created_at)
         VALUES ('access', ?, ?, datetime('now'))`,
      ).bind(identity.subject, userId),
      db.prepare(
        `INSERT INTO mailboxes (id, address, display_name, type, status, owner_user_id, created_at)
         VALUES (?, ?, ?, 'personal', 'active', ?, datetime('now'))`,
      ).bind(mailboxId, identity.email, localPart, userId),
      db.prepare(
        `INSERT INTO mailbox_assignments (mailbox_id, user_id, permissions, assigned_at, assigned_by)
         VALUES (?, ?, 'full', datetime('now'), ?)`,
      ).bind(mailboxId, userId, userId),
    ]);
  } catch {
    return null;
  }
  await audit(db, {
    event_type: 'user.provisioned',
    actor_role: 'system',
    target: userId,
    detail: 'Provisioned standard account from a Cloudflare Access sign-in',
  });
  await audit(db, {
    event_type: 'mailbox.created',
    actor_role: 'system',
    target: mailboxId,
    detail: 'Provisioned personal mailbox with full owner assignment',
  });
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<User>();
}

const allowAll: AccessCountryGate = async () => true;

/** Finds or binds the account for a verified Access identity. Creates no session. */
export async function resolveAccessUser(
  db: D1Database,
  identity: AccessIdentity,
  options: { autoProvision: boolean; mailDomain: string; countryGate?: AccessCountryGate },
): Promise<AccessResolution> {
  const countryGate = options.countryGate ?? allowAll;
  const bound = await findAccessBoundUser(db, identity.subject);
  if (bound) {
    if (SUSPENDED.has(bound.status)) return { ok: false, reason: 'account_suspended', userId: bound.id };
    if (!await countryGate(bound)) return { ok: false, reason: 'country_pending', userId: bound.id };
    return { ok: true, user: bound, how: 'returning', emailChanged: normalizeEmail(bound.email) !== identity.email };
  }

  const manager = await db.prepare(`SELECT id FROM users WHERE role = 'manager' LIMIT 1`).first<{ id: string }>();
  if (!manager) return { ok: false, reason: 'not_set_up' };

  const candidate = await db.prepare(
    `SELECT u.*,
            EXISTS (SELECT 1 FROM user_identities i WHERE i.provider = 'access' AND i.user_id = u.id) AS has_access,
            EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id) AS has_identity
     FROM users u WHERE lower(u.email) = ? LIMIT 1`,
  ).bind(identity.email).first<User & { has_access: number; has_identity: number }>();

  if (candidate) {
    if (SUSPENDED.has(candidate.status)) return { ok: false, reason: 'account_suspended', userId: candidate.id };
    if (candidate.has_access) return { ok: false, reason: 'identity_conflict', userId: candidate.id };
    // Email alone never adopts an account someone already signs in to, or a manager.
    if (candidate.role !== 'standard' || candidate.has_identity) {
      return { ok: false, reason: 'link_required', userId: candidate.id };
    }
    if (!await countryGate(candidate)) return { ok: false, reason: 'country_pending', userId: candidate.id };
    if (!await bindAccessIdentity(db, candidate.id, identity.subject, { allowManager: false, requireNoIdentity: true })) {
      return { ok: false, reason: 'identity_conflict', userId: candidate.id };
    }
    await audit(db, {
      event_type: 'auth.identity_bound',
      actor_id: candidate.id,
      actor_role: candidate.role,
      target: candidate.id,
      detail: 'Bound a Cloudflare Access identity to an account with no sign-in identity, by verified email',
    });
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(candidate.id).first<User>();
    if (!user) return { ok: false, reason: 'identity_conflict' };
    return { ok: true, user, how: 'bound_existing', emailChanged: false };
  }

  const mailDomain = normalizeDomain(options.mailDomain);
  const address = options.autoProvision && mailDomain ? provisionableAddress(identity, mailDomain) : null;
  if (!address) return { ok: false, reason: 'enrollment_required' };
  if (!await countryGate(null)) return { ok: false, reason: 'country_pending' };
  const created = await provisionAccessUser(db, identity, address.localPart);
  if (created) {
    await audit(db, {
      event_type: 'auth.identity_bound',
      actor_id: created.id,
      actor_role: created.role,
      target: created.id,
      detail: 'Bound a Cloudflare Access identity to a newly provisioned account',
    });
    return { ok: true, user: created, how: 'provisioned', emailChanged: false };
  }
  // A concurrent first request may have won the race; honour its binding.
  const raced = await findAccessBoundUser(db, identity.subject);
  if (raced && !SUSPENDED.has(raced.status)) return { ok: true, user: raced, how: 'returning', emailChanged: false };
  return { ok: false, reason: 'enrollment_required' };
}

/**
 * For a request that already has a valid Stanchion session: true when the
 * session's account is bound to this Access sub, or when it has no Access
 * binding yet, its email matches the verified token, and the binding is
 * made now. This is how managers and existing Google, Microsoft or email
 * users link: one visit while signed in the normal way. False means the
 * session belongs to someone else and must not be used.
 */
export async function confirmSessionAccessBinding(
  db: D1Database,
  user: User,
  identity: AccessIdentity,
  clientIp: string,
): Promise<boolean> {
  const subject = await accessSubjectForUser(db, user.id);
  if (subject !== null) return subject === identity.subject;
  if (normalizeEmail(user.email) !== identity.email) return false;
  if (!await bindAccessIdentity(db, user.id, identity.subject, { allowManager: true, requireNoIdentity: false })) {
    return false;
  }
  await audit(db, {
    event_type: 'auth.identity_bound',
    actor_id: user.id,
    actor_role: user.role,
    target: user.id,
    detail: 'Bound a Cloudflare Access identity to the signed-in account',
    ip_address: clientIp,
  });
  return true;
}

async function denyAccess(
  db: D1Database,
  identity: AccessIdentity,
  reason: AccessDenyReason,
  clientIp: string,
  userId?: string,
): Promise<null> {
  await auditDeduped(db, `deny:${reason}:${identity.subject}:${identity.email}`, {
    event_type: 'auth.sign_in_denied',
    actor_id: userId ?? null,
    actor_role: 'system',
    target: userId ?? null,
    detail: `Denied access sign-in: ${reason}`,
    ip_address: clientIp,
  });
  return null;
}

/**
 * Resolves the account and mints a session and cookie for this browser,
 * with the same country gate, session cap, eviction and audit trail as an
 * OAuth sign-in. hooks.server.ts calls this only when the request has no
 * valid Stanchion cookie, so a browser mints once and then reuses its own
 * cookie. Returns null (signed out) on any refusal.
 */
export async function establishAccessSession(
  env: Record<string, unknown> & { DB: D1Database; SESSION_SECRET: string },
  identity: AccessIdentity,
  request: Request,
  options: { autoProvision: boolean; secureCookie: boolean },
): Promise<{ user: User; sessionId: string; cookie: string } | null> {
  const db = env.DB;
  const clientIp = (request.headers.get('cf-connecting-ip') || '').slice(0, 64);
  const country = requestCountry(request);
  const settings = await loadOrgSettings(env);
  const countryGate: AccessCountryGate = async (user) => {
    if (!user) return countryAllowed(country, settings.signInCountries);
    const gate = await signInCountryGate(db, settings, { userId: user.id, country });
    if (!gate.allowed) {
      await recordTravelRequest(db, env as unknown as Env, { user, country, appUrl: settings.appUrl || String(env.APP_URL || '') });
    }
    return gate.allowed;
  };

  const resolution = await resolveAccessUser(db, identity, {
    autoProvision: options.autoProvision,
    mailDomain: typeof env.MAIL_DOMAIN === 'string' ? env.MAIL_DOMAIN : '',
    countryGate,
  });
  if (!resolution.ok) {
    // Before the first manager exists there is nothing to deny; stay quiet.
    if (resolution.reason === 'not_set_up') return null;
    return denyAccess(db, identity, resolution.reason, clientIp, resolution.userId);
  }
  const user = resolution.user;

  if (resolution.emailChanged) {
    await auditDeduped(db, `email-changed:${user.id}:${identity.email}`, {
      event_type: 'auth.access_email_changed',
      actor_id: user.id,
      actor_role: user.role,
      target: user.id,
      detail: 'Cloudflare Access email differs from the account email; binding kept by subject',
      ip_address: clientIp,
    });
  }

  await db.prepare(
    `UPDATE users
     SET last_sign_in = datetime('now'),
         status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
         updated_at = datetime('now')
     WHERE id = ? AND status IN ('pending', 'active')`,
  ).bind(user.id).run();

  const ttlMs = sessionTtlMs(env);
  const { token, hash, expiresAt, sessionId } = await createSessionToken(user.id, env.SESSION_SECRET, ttlMs);
  await db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, issued_at, expires_at, ip_address, revoked)
     VALUES (?, ?, ?, datetime('now'), ?, ?, 0)`,
  ).bind(sessionId, user.id, hash, expiresAt.toISOString(), clientIp).run();
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
    detail: 'Signed in via access',
    ip_address: clientIp,
    session_id: sessionId,
  });

  const fresh = await db.prepare(
    `SELECT * FROM users WHERE id = ? AND status IN ('active', 'pending')`,
  ).bind(user.id).first<User>();
  if (!fresh) return null;
  return { user: fresh, sessionId, cookie: buildSessionCookie(token, options.secureCookie) };
}
