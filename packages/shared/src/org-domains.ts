// The organisation's mail domains (docs/multi-domain.md).
//
// One instance serves one organisation, which may own several mail domains.
// Domains are never typed in by a manager; they are discovered and proven:
//   1. MAIL_DOMAIN, the primary domain (always first);
//   2. when the Microsoft 365 sync is connected, the tenant's verified domains
//      (Microsoft Graph GET /domains, isVerified), refreshed by the sync and
//      cached in org_settings. The tenant's initial *.onmicrosoft.com domain
//      is never included.
//
// With no cache (no Microsoft 365 sync, or the sync never read the domains)
// the list is exactly [MAIL_DOMAIN], so a single-domain instance behaves as
// before. The cache is the last good answer from Microsoft: a failed refresh
// keeps it, and turning the sync off freezes it (like the sync's links). Only
// a successful read that no longer lists a domain removes it.

/** org_settings key the Microsoft 365 sync writes. Absent = no extra domains. */
export const ORG_DOMAINS_SETTING = 'm365_verified_domains';
/** More than this many verified domains is refused as implausible. */
export const MAX_ORG_DOMAINS = 200;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isPlainDomain(value: unknown): value is string {
  return typeof value === 'string' && DOMAIN.test(value);
}

/** Microsoft's tenant routing domains: never a mail domain cmail serves. */
export function isMicrosoftInitialDomain(domain: string): boolean {
  return domain === 'onmicrosoft.com' || domain.endsWith('.onmicrosoft.com');
}

export interface OrgDomainsCache {
  /** Verified, non-initial domains, lower case, sorted, unique. */
  domains: string[];
  /** Epoch ms of the last successful read from Microsoft, or 0. */
  refreshedAt: number;
  /** Epoch ms of the last attempt (successful or not), or 0. */
  attemptedAt: number;
  /** Short machine code of the last failed attempt ('' after a success). */
  problem: string;
}

export function emptyOrgDomainsCache(): OrgDomainsCache {
  return { domains: [], refreshedAt: 0, attemptedAt: 0, problem: '' };
}

/** Cleans a domain list: lower case, valid, no Microsoft initial domains, unique, sorted, capped. */
export function cleanDomainList(values: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const domain = value.trim().toLowerCase();
    if (!isPlainDomain(domain) || isMicrosoftInitialDomain(domain)) continue;
    out.add(domain);
  }
  return [...out].sort().slice(0, MAX_ORG_DOMAINS);
}

export function parseOrgDomainsCache(raw: string | null | undefined): OrgDomainsCache {
  if (!raw) return emptyOrgDomainsCache();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt cache is treated as none: MAIL_DOMAIN alone, never wider.
    return emptyOrgDomainsCache();
  }
  if (!parsed || typeof parsed !== 'object') return emptyOrgDomainsCache();
  const record = parsed as Record<string, unknown>;
  const time = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  return {
    domains: Array.isArray(record.domains) ? cleanDomainList(record.domains) : [],
    refreshedAt: time(record.refreshedAt),
    attemptedAt: time(record.attemptedAt),
    problem: typeof record.problem === 'string' ? record.problem.slice(0, 64) : '',
  };
}

export async function loadOrgDomainsCache(db: D1Database): Promise<OrgDomainsCache> {
  const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?')
    .bind(ORG_DOMAINS_SETTING).first<{ value: string }>();
  return parseOrgDomainsCache(row?.value);
}

export async function saveOrgDomainsCache(db: D1Database, cache: OrgDomainsCache): Promise<void> {
  await db.prepare(
    `INSERT INTO org_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(ORG_DOMAINS_SETTING, JSON.stringify(cache)).run();
}

export interface OrgDomains {
  /** MAIL_DOMAIN, lower case, or '' when it is not set. */
  primary: string;
  /** Primary first, then the discovered domains, sorted. Empty without a primary. */
  domains: string[];
}

/** Pure: the domain list from MAIL_DOMAIN and the cache. */
export function orgDomainsFrom(mailDomain: unknown, cache: Pick<OrgDomainsCache, 'domains'>): OrgDomains {
  const primary = typeof mailDomain === 'string' ? mailDomain.trim().toLowerCase() : '';
  if (!isPlainDomain(primary)) return { primary: '', domains: [] };
  return { primary, domains: [primary, ...cache.domains.filter((domain) => domain !== primary)] };
}

/**
 * The organisation's mail domains. One org_settings read; throws if D1
 * fails, so each caller decides how to fail (never by guessing a wider list).
 */
export async function orgDomains(env: { MAIL_DOMAIN?: unknown }, db: D1Database): Promise<OrgDomains> {
  const primary = typeof env.MAIL_DOMAIN === 'string' ? env.MAIL_DOMAIN.trim().toLowerCase() : '';
  if (!isPlainDomain(primary)) return { primary: '', domains: [] };
  return orgDomainsFrom(primary, await loadOrgDomainsCache(db));
}

/** The domain part of an address, lower case ('' when there is none). */
export function addressDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1).trim().toLowerCase() : '';
}

/**
 * True when `domain` is one of `domains`. A string is a single domain, so
 * callers that still pass MAIL_DOMAIN alone keep their exact behaviour.
 */
export function domainIn(domain: string, domains: string | ReadonlySet<string> | readonly string[]): boolean {
  if (!domain) return false;
  if (typeof domains === 'string') return domain === domains;
  if (domains instanceof Set) return domains.has(domain);
  return (domains as readonly string[]).includes(domain);
}
