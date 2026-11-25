// First sign-in for people the Microsoft 365 sync created
// (docs/m365-sync.md, "First sign-in").
//
// A synced account is pending with no sign-in identity. Without this module,
// "Sign in with Microsoft" admits only a bound identity or a manager
// invitation. With the sync switched on, the Microsoft callback may bind the
// person's Microsoft identity to their synced account, on these rules:
// - The decision rests on the ID token from the token endpoint, verified here
//   (RS256 signature against the tenant's published keys, exact v2.0 issuer
//   for the configured tenant, audience = our client id, time claims), never
//   on UserInfo, an email or a UPN.
// - `tid` must be the sync's tenant, `idp` (when present) must equal the
//   issuer (so guests never match), and the ID token's `sub` must equal the
//   UserInfo `sub` the callback binds and later looks up.
// - `oid` (the Entra object id the sync stores in m365_sync_links) must be a
//   linked person, in scope, whose account is standard, pending or active and
//   has no identity of any kind. Managers are never bound this way.
// - The identity row is inserted by one conditional statement that re-checks
//   all of that, in one batch with the auth_provider update, so a race with a
//   manager action or another sign-in binds nothing.
// - Sync off, or no tenant configured: nothing here runs and nothing changes.
// - The ID token must carry the OIDC nonce this browser's login request sent
//   (cookie, single use), so a token obtained elsewhere cannot be replayed.
// - Every bind is audited (auth.sync_link_bound). A refusal adds its reason to
//   the callback's single auth.sign_in_denied row (one row per denied sign-in).
import { M365_SYNC_SETTING_ENABLED } from '@stanchion/shared/m365-sync';
import { AccessKeyStore, base64UrlDecode, decodeJsonSegment } from './access-jwt';
import { audit } from './db';
import { validOidcNonce } from './auth';

/** Seconds of clock skew tolerated on exp, nbf and iat. */
export const ID_TOKEN_CLOCK_SKEW_SECONDS = 300;
const MAX_TOKEN_LENGTH = 16_384;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const defaultKeyStore = new AccessKeyStore();

export interface MicrosoftIdClaims {
  sub: string;
  oid: string;
  tid: string;
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The tenant whose object ids the sync stores: the web app's M365_TENANT_ID
 * (same value as the email Worker's), or MICROSOFT_TENANT_ID when that is a
 * single tenant GUID. Null when neither is a GUID or the two disagree.
 */
export function syncSignInTenant(env: Record<string, unknown>): string | null {
  const m365 = envString(env, 'M365_TENANT_ID');
  const microsoft = envString(env, 'MICROSOFT_TENANT_ID');
  const m365Ok = GUID.test(m365);
  const microsoftOk = GUID.test(microsoft);
  if (m365Ok && microsoftOk && m365 !== microsoft) return null;
  if (m365Ok) return m365;
  if (microsoftOk) return microsoft;
  return null;
}

function numericDate(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Verifies a Microsoft identity platform v2.0 ID token for one tenant and
 * client. Null for anything missing, malformed, mis-signed or out of time.
 * Claims are read only after the signature checks out.
 */
export async function verifyMicrosoftIdToken(
  token: unknown,
  expected: { tenantId: string; clientId: string; nonce: string },
  options: { nowMs?: number; keyStore?: AccessKeyStore } = {},
): Promise<MicrosoftIdClaims | null> {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return null;
  if (!GUID.test(expected.tenantId) || !expected.clientId || !validOidcNonce(expected.nonce)) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeJsonSegment(headerSegment);
  if (!header || header.alg !== 'RS256') return null;
  if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 256) return null;
  if (header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) return null;
  const payload = decodeJsonSegment(payloadSegment);
  const signature = base64UrlDecode(signatureSegment);
  if (!payload || !signature || signature.length === 0) return null;

  const nowMs = options.nowMs ?? Date.now();
  // The configured tenant's keys, never a URL taken from the token.
  // ?appid= as Microsoft documents, so app-specific signing keys are included.
  const keysUrl = `https://login.microsoftonline.com/${expected.tenantId}/discovery/v2.0/keys?appid=${encodeURIComponent(expected.clientId.toLowerCase())}`;
  const key = await (options.keyStore ?? defaultKeyStore).key(keysUrl, header.kid, nowMs);
  if (!key) return null;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, new TextEncoder().encode(`${headerSegment}.${payloadSegment}`));
  } catch {
    return null;
  }
  if (!valid) return null;

  const issuer = `https://login.microsoftonline.com/${expected.tenantId}/v2.0`;
  if (payload.iss !== issuer) return null;
  // The client id is a GUID: compare without case.
  if (typeof payload.aud !== 'string' || payload.aud.toLowerCase() !== expected.clientId.toLowerCase()) return null;
  // Ties the token to this browser's login request: no replay from elsewhere.
  if (payload.nonce !== expected.nonce) return null;
  if (payload.ver !== undefined && payload.ver !== '2.0') return null;
  // A guest signs in with an identity from another tenant: idp says so.
  if (payload.idp !== undefined && payload.idp !== issuer) return null;
  const now = Math.floor(nowMs / 1000);
  const exp = numericDate(payload.exp);
  if (exp === undefined || exp === null || now >= exp + ID_TOKEN_CLOCK_SKEW_SECONDS) return null;
  const nbf = numericDate(payload.nbf);
  if (nbf === null || (nbf !== undefined && now + ID_TOKEN_CLOCK_SKEW_SECONDS < nbf)) return null;
  const iat = numericDate(payload.iat);
  if (iat === null || (iat !== undefined && now + ID_TOKEN_CLOCK_SKEW_SECONDS < iat)) return null;

  const tid = typeof payload.tid === 'string' ? payload.tid.toLowerCase() : '';
  const oid = typeof payload.oid === 'string' ? payload.oid.toLowerCase() : '';
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!GUID.test(tid) || !GUID.test(oid) || sub.length < 1 || sub.length > 255) return null;
  return { sub, oid, tid };
}

export type SyncSignInRefusal =
  | 'nonce_missing'
  | 'id_token_invalid'
  | 'subject_mismatch'
  | 'wrong_tenant'
  | 'not_linked'
  | 'out_of_scope'
  | 'manager'
  | 'account_suspended'
  | 'already_bound'
  | 'bind_conflict';

export type SyncSignInResult =
  /** Sync off or no tenant configured: the callback carries on exactly as before. */
  | { status: 'not_applicable' }
  | { status: 'bound'; userId: string }
  | { status: 'refused'; reason: SyncSignInRefusal; deny: 'enrollment_required' | 'identity_conflict' | 'account_suspended'; userId?: string };

interface LinkedAccount {
  user_id: string;
  source_state: string;
  role: string;
  status: string;
  identities: number;
}

const DENY: Record<SyncSignInRefusal, 'enrollment_required' | 'identity_conflict' | 'account_suspended'> = {
  nonce_missing: 'enrollment_required',
  id_token_invalid: 'enrollment_required',
  subject_mismatch: 'enrollment_required',
  wrong_tenant: 'enrollment_required',
  not_linked: 'enrollment_required',
  out_of_scope: 'enrollment_required',
  manager: 'identity_conflict',
  account_suspended: 'account_suspended',
  already_bound: 'identity_conflict',
  bind_conflict: 'identity_conflict',
};

async function syncEnabled(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?').bind(M365_SYNC_SETTING_ENABLED).first<{ value: string }>();
    return row?.value === 'true';
  } catch {
    return false;
  }
}

/**
 * Called by the Microsoft callback only when no identity is bound to the
 * signed-in subject and there is no invitation or bootstrap proof.
 */
export async function bindSyncLinkedMicrosoftIdentity(
  db: D1Database,
  env: Record<string, unknown>,
  input: { idToken: unknown; subject: string; nonce: string | undefined; clientIp: string },
  options: { nowMs?: number; keyStore?: AccessKeyStore } = {},
): Promise<SyncSignInResult> {
  if (!await syncEnabled(db)) return { status: 'not_applicable' };
  const tenantId = syncSignInTenant(env);
  const clientId = typeof env.MICROSOFT_CLIENT_ID === 'string' ? env.MICROSOFT_CLIENT_ID.trim() : '';
  if (!tenantId || !clientId) {
    // Configuration, not a person's mistake: the callback continues as before.
    console.warn('Microsoft 365 sync sign-in skipped: tenant not configured on the web app');
    return { status: 'not_applicable' };
  }

  // No audit row here: the callback's one denial row carries the reason.
  const refuse = (reason: SyncSignInRefusal, userId?: string): SyncSignInResult =>
    ({ status: 'refused', reason, deny: DENY[reason], userId });

  if (!validOidcNonce(input.nonce)) return refuse('nonce_missing');
  const claims = await verifyMicrosoftIdToken(input.idToken, { tenantId, clientId, nonce: input.nonce }, options);
  if (!claims) return refuse('id_token_invalid');
  // verifyMicrosoftIdToken already pins iss to the tenant; tid must agree.
  if (claims.tid !== tenantId) return refuse('wrong_tenant');
  if (claims.sub !== input.subject) return refuse('subject_mismatch');

  const linked = await db.prepare(
    `SELECT l.user_id, l.source_state, u.role, u.status,
            (SELECT COUNT(*) FROM user_identities i WHERE i.user_id = u.id) AS identities
     FROM m365_sync_links l JOIN users u ON u.id = l.user_id
     WHERE l.object_id = ? AND l.kind = 'person'`,
  ).bind(claims.oid).first<LinkedAccount>().catch(() => null);
  if (!linked) return refuse('not_linked');
  if (linked.role !== 'standard') return refuse('manager', linked.user_id);
  if (linked.status !== 'pending' && linked.status !== 'active') return refuse('account_suspended', linked.user_id);
  if (linked.source_state !== 'in_scope') return refuse('out_of_scope', linked.user_id);
  if (Number(linked.identities) > 0) return refuse('already_bound', linked.user_id);

  let results: D1Result[];
  try {
    results = await db.batch([
      // Every condition again, in the statement that binds: a manager change
      // or another sign-in landing in between makes this insert nothing.
      db.prepare(
        `INSERT INTO user_identities (provider, subject, user_id, created_at)
         SELECT 'microsoft', ?, u.id, datetime('now')
         FROM m365_sync_links l JOIN users u ON u.id = l.user_id
         WHERE l.object_id = ? AND l.kind = 'person' AND l.source_state = 'in_scope'
           AND u.id = ? AND u.role = 'standard' AND u.status IN ('pending', 'active')
           AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id)
           AND EXISTS (SELECT 1 FROM org_settings s WHERE s.key = ? AND s.value = 'true')`,
      ).bind(claims.sub, claims.oid, linked.user_id, M365_SYNC_SETTING_ENABLED),
      db.prepare(
        `UPDATE users SET auth_provider = 'microsoft', updated_at = datetime('now')
         WHERE id = ? AND changes() = 1`,
      ).bind(linked.user_id),
    ]);
  } catch {
    return refuse('bind_conflict', linked.user_id);
  }
  if (!results[0]?.meta.changes) return refuse('bind_conflict', linked.user_id);
  await audit(db, {
    event_type: 'auth.sync_link_bound',
    actor_id: linked.user_id,
    actor_role: 'standard',
    target: linked.user_id,
    detail: 'Bound a Microsoft identity to the account the Microsoft 365 sync created (verified ID token: tenant and object id)',
    ip_address: input.clientIp,
  });
  return { status: 'bound', userId: linked.user_id };
}
