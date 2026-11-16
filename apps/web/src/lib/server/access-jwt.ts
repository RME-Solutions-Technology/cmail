// Cloudflare Access application-token verification (the "Access bridge").
//
// Access puts a signed JWT in the `Cf-Access-Jwt-Assertion` request header
// on every request it lets through. This module checks that token with no
// third-party code: RS256 only, keys from the team's own certs endpoint,
// exact issuer, this application's audience tag, and expiry / not-before
// with a small clock skew. Nothing here creates a session or touches the
// database; see access-bridge.ts for the account binding.
//
// References:
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/

import { normalizeEmail } from './validation';

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
/** Seconds of clock skew tolerated on exp, nbf and iat. */
export const ACCESS_CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 8192;
/** Fresh keys are refetched after this long. Cloudflare rotates every six weeks. */
const KEY_CACHE_TTL_MS = 60 * 60 * 1000;
/** If a refresh fails, cached keys stay usable for at most this long. */
const KEY_CACHE_STALE_MS = 24 * 60 * 60 * 1000;
/** At most one certs fetch per window: unknown `kid`, stale cache or failures alike. */
const KEY_REFRESH_MIN_INTERVAL_MS = 30 * 1000;
const KEY_FETCH_TIMEOUT_MS = 5000;
const MAX_KEYS = 16;

const TEAM_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com`, the exact expected `iss`. */
  issuer: string;
  certsUrl: string;
  /** The Access application's AUD tag. */
  audience: string;
  /** ACCESS_AUTO_PROVISION=true: create accounts for verified emails on MAIL_DOMAIN. */
  autoProvision: boolean;
}

export type AccessMode =
  | { mode: 'off' }
  /** One or both values are set but unusable: every request is treated as signed out. */
  | { mode: 'misconfigured'; reason: string }
  | { mode: 'on'; config: AccessConfig };

export interface AccessIdentity {
  /** Access `sub`: the stable user id inside the Zero Trust organisation. */
  subject: string;
  /** Normalised email from the verified token. Never a lookup key on its own. */
  email: string;
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Accepts `team.cloudflareaccess.com` or `https://team.cloudflareaccess.com[/]`. */
export function normalizeTeamDomain(value: string): string | null {
  const host = value.toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  return TEAM_DOMAIN_PATTERN.test(host) ? host : null;
}

/**
 * Off only when both ACCESS_TEAM_DOMAIN and ACCESS_AUD are unset. Setting
 * either one turns the bridge on, and a bad or missing partner value fails
 * closed rather than silently falling back to cookie-only sessions.
 */
export function accessMode(env: Record<string, unknown>): AccessMode {
  const rawTeam = envString(env, 'ACCESS_TEAM_DOMAIN');
  const rawAudience = envString(env, 'ACCESS_AUD');
  if (!rawTeam && !rawAudience) return { mode: 'off' };
  const team = rawTeam ? normalizeTeamDomain(rawTeam) : null;
  if (!team) return { mode: 'misconfigured', reason: 'ACCESS_TEAM_DOMAIN must be <team>.cloudflareaccess.com' };
  if (!AUDIENCE_PATTERN.test(rawAudience)) return { mode: 'misconfigured', reason: 'ACCESS_AUD must be the Access application AUD tag' };
  return {
    mode: 'on',
    config: {
      issuer: `https://${team}`,
      certsUrl: `https://${team}/cdn-cgi/access/certs`,
      audience: rawAudience,
      autoProvision: envString(env, 'ACCESS_AUTO_PROVISION').toLowerCase() === 'true',
    },
  };
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface KeySet {
  keys: Map<string, CryptoKey>;
  fetchedAtMs: number;
}

/**
 * Per-isolate cache of the team's signing keys. Exported as a class so tests
 * get a fresh store; production uses the shared default below.
 */
export class AccessKeyStore {
  private readonly sets = new Map<string, KeySet>();
  private readonly lastAttemptMs = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<KeySet | null>>();

  constructor(private readonly fetcher: FetchLike = (url, init) => fetch(url, init)) {}

  async key(certsUrl: string, kid: string, nowMs: number): Promise<CryptoKey | null> {
    let set = this.sets.get(certsUrl);
    const fresh = set && nowMs - set.fetchedAtMs < KEY_CACHE_TTL_MS;
    if (fresh && set!.keys.has(kid)) return set!.keys.get(kid)!;

    // One refetch per window whatever the reason (stale cache, unknown kid,
    // or a failing endpoint), so a certs outage is never hammered per request.
    const lastAttempt = this.lastAttemptMs.get(certsUrl) ?? -Infinity;
    if (nowMs - lastAttempt >= KEY_REFRESH_MIN_INTERVAL_MS) {
      const refreshed = await this.refresh(certsUrl, nowMs);
      if (refreshed) set = refreshed;
    }
    if (!set || nowMs - set.fetchedAtMs >= KEY_CACHE_STALE_MS) return null;
    return set.keys.get(kid) ?? null;
  }

  private refresh(certsUrl: string, nowMs: number): Promise<KeySet | null> {
    const pending = this.inflight.get(certsUrl);
    if (pending) return pending;
    this.lastAttemptMs.set(certsUrl, nowMs);
    const attempt = this.load(certsUrl, nowMs).finally(() => this.inflight.delete(certsUrl));
    this.inflight.set(certsUrl, attempt);
    return attempt;
  }

  private async load(certsUrl: string, nowMs: number): Promise<KeySet | null> {
    try {
      const response = await this.fetcher(certsUrl, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`certs endpoint returned ${response.status}`);
      const body = await response.json() as { keys?: unknown };
      if (!Array.isArray(body.keys)) throw new Error('certs response has no keys array');
      const keys = new Map<string, CryptoKey>();
      for (const candidate of body.keys.slice(0, MAX_KEYS)) {
        const jwk = candidate as Record<string, unknown>;
        if (
          jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid || jwk.kid.length > 256 ||
          typeof jwk.n !== 'string' || typeof jwk.e !== 'string' ||
          (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
          (jwk.use !== undefined && jwk.use !== 'sig')
        ) continue;
        try {
          const key = await crypto.subtle.importKey(
            'jwk',
            { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
          );
          keys.set(jwk.kid, key);
        } catch {
          // Skip a malformed key; the others may still be valid.
        }
      }
      if (keys.size === 0) throw new Error('certs response has no usable RS256 keys');
      const set = { keys, fetchedAtMs: nowMs };
      this.sets.set(certsUrl, set);
      return set;
    } catch (error) {
      // Also used for Microsoft ID token keys (m365-sync-signin.ts).
      console.error('Signing keys fetch failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return null;
    }
  }
}

const defaultKeyStore = new AccessKeyStore();

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  return Array.isArray(aud) && aud.length <= 16 && aud.some((value) => value === expected);
}

function optionalNumericDate(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Returns the verified identity, or null for any missing, malformed,
 * unsigned, mis-signed, wrong-issuer, wrong-audience or out-of-time token.
 * Callers must treat null as "not signed in", never as "skip the check".
 */
export async function verifyAccessJwt(
  token: string | null | undefined,
  config: Pick<AccessConfig, 'issuer' | 'certsUrl' | 'audience'>,
  options: { nowMs?: number; keyStore?: AccessKeyStore } = {},
): Promise<AccessIdentity | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const header = decodeJsonSegment(headerSegment);
  // RS256 only: this rejects "none", every HMAC algorithm (the classic
  // public-key-as-HMAC-secret confusion) and any other asymmetric algorithm.
  if (!header || header.alg !== 'RS256') return null;
  if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 256) return null;
  if (header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) return null;

  const payload = decodeJsonSegment(payloadSegment);
  const signature = base64UrlDecode(signatureSegment);
  if (!payload || !signature || signature.length === 0) return null;

  const nowMs = options.nowMs ?? Date.now();
  const key = await (options.keyStore ?? defaultKeyStore).key(config.certsUrl, header.kid, nowMs);
  if (!key) return null;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      signature,
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  // Claims are only read after the signature is known to be good.
  if (payload.iss !== config.issuer) return null;
  if (!audienceMatches(payload.aud, config.audience)) return null;
  // Cloudflare documents `type` as "app" (application token) or "org" (the
  // global session token) and shows it in its examples, but does not promise
  // it is always present. Refuse anything that says it is not an app token;
  // a missing `type` is still bound to this application by `aud`.
  if (payload.type !== undefined && payload.type !== 'app') return null;

  const now = Math.floor(nowMs / 1000);
  const exp = optionalNumericDate(payload.exp);
  if (exp === undefined || exp === null || now >= exp + ACCESS_CLOCK_SKEW_SECONDS) return null;
  const nbf = optionalNumericDate(payload.nbf);
  if (nbf === null || (nbf !== undefined && now + ACCESS_CLOCK_SKEW_SECONDS < nbf)) return null;
  const iat = optionalNumericDate(payload.iat);
  if (iat === null || (iat !== undefined && now + ACCESS_CLOCK_SKEW_SECONDS < iat)) return null;

  // Service tokens carry no user `sub` or email, so they never reach a mailbox.
  if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 255) return null;
  const email = normalizeEmail(payload.email);
  if (!email) return null;
  return { subject: payload.sub, email };
}
