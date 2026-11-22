// The organisation's mail domains (docs/multi-domain.md).
//
// One instance serves one organisation, which may own several mail domains.
// Domains are never typed in by a manager; they are discovered and proven:
//   1. MAIL_DOMAIN, the primary domain (always first);
//   2. when the Microsoft 365 sync is connected, the tenant's verified mail
//      domains (Microsoft Graph GET /domains: isVerified, not isInitial,
//      supportedServices includes "Email"), refreshed by the sync and cached
//      in org_settings with the tenant id they were read from. The tenant's
//      *.onmicrosoft.com domains are never included.
//
// With no usable cache (no Microsoft 365 sync, the sync never read the
// domains, or the cache is from another tenant) the list is exactly
// [MAIL_DOMAIN], so a single-domain instance behaves as before. The cache is
// the last good answer from Microsoft: a failed refresh keeps it, turning the
// sync off freezes it, and a domain is removed only when two successful reads
// at least a day apart no longer list it (domains.ts in the email Worker).
//
// Keep FOCUS_ORG_DOMAINS_SETTING and focusOrgDomains in focused-inbox.ts in
// step with this file (that file has no imports; a test checks they agree).

/** org_settings key the Microsoft 365 sync writes. Absent = no extra domains. */
export const ORG_DOMAINS_SETTING = 'm365_verified_domains';
/** More than this many verified domains is refused as implausible. */
export const MAX_ORG_DOMAINS = 200;

/** Labels of letters, digits and hyphens; the last one alphabetic or an IDN (xn--) label. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isPlainDomain(value: unknown): value is string {
  return typeof value === 'string' && DOMAIN.test(value);
}

/** Microsoft's tenant routing domains: never a mail domain Stanchion serves. */
export function isMicrosoftInitialDomain(domain: string): boolean {
  return domain === 'onmicrosoft.com' || domain.endsWith('.onmicrosoft.com');
}

export interface OrgDomainsCache {
  /** The Entra tenant (directory) id the list was read from, lower case, or ''. */
  tenantId: string;
  /** Verified mail domains, lower case, sorted, unique. */
  domains: string[];
  /**
   * Domains a successful read no longer listed, with the epoch ms of the
   * first such read. They stay in `domains` until a read at least a day later
   * still leaves them out.
   */
  missingSince: Record<string, number>;
  /** Epoch ms of the last successful read from Microsoft, or 0. */
  refreshedAt: number;
  /** Epoch ms of the last attempt (successful or not), or 0. */
  attemptedAt: number;
  /** Short machine code of the last failed attempt ('' after a success). */
  problem: string;
}

export function emptyOrgDomainsCache(): OrgDomainsCache {
  return { tenantId: '', domains: [], missingSince: {}, refreshedAt: 0, attemptedAt: 0, problem: '' };
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
  const domains = Array.isArray(record.domains) ? cleanDomainList(record.domains) : [];
  const missingSince: Record<string, number> = {};
  if (record.missingSince && typeof record.missingSince === 'object') {
    for (const [domain, at] of Object.entries(record.missingSince as Record<string, unknown>)) {
      if (domains.includes(domain) && time(at)) missingSince[domain] = time(at);
    }
  }
  const tenantId = typeof record.tenantId === 'string' ? record.tenantId.trim().toLowerCase() : '';
  return {
    tenantId: GUID.test(tenantId) ? tenantId : '',
    domains,
    missingSince,
    refreshedAt: time(record.refreshedAt),
    attemptedAt: time(record.attemptedAt),
    problem: typeof record.problem === 'string' ? record.problem.slice(0, 64) : '',
  };
}

/**
 * The cache may be used only when it came from a tenant and, where the
 * deployment names its tenant (M365_TENANT_ID), from that same tenant. A list
 * read from another tenant is ignored, never trusted.
 */
export function usableOrgDomainsCache(cache: OrgDomainsCache, envTenantId: unknown): OrgDomainsCache {
  const expected = typeof envTenantId === 'string' ? envTenantId.trim().toLowerCase() : '';
  if (!cache.tenantId || (GUID.test(expected) && cache.tenantId !== expected)) return emptyOrgDomainsCache();
  return cache;
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
  /**
   * The sync has read this tenant's domains successfully at least once. From
   * then on the instance is multi-domain: the mirror files only organisation
   * domains and Stanchion sends only from MAIL_DOMAIN (phase 1).
   */
  discovered: boolean;
}

/** Pure: the domain list from MAIL_DOMAIN and a usable cache. */
export function orgDomainsFrom(mailDomain: unknown, cache: Pick<OrgDomainsCache, 'domains' | 'refreshedAt'>): OrgDomains {
  const primary = typeof mailDomain === 'string' ? mailDomain.trim().toLowerCase() : '';
  if (!isPlainDomain(primary)) return { primary: '', domains: [], discovered: false };
  return {
    primary,
    domains: [primary, ...cache.domains.filter((domain) => domain !== primary)],
    discovered: cache.refreshedAt > 0,
  };
}

/**
 * The organisation's mail domains. One org_settings read; throws if D1
 * fails, so each caller decides how to fail (never by guessing a wider list).
 */
export async function orgDomains(env: { MAIL_DOMAIN?: unknown; M365_TENANT_ID?: unknown }, db: D1Database): Promise<OrgDomains> {
  const primary = typeof env.MAIL_DOMAIN === 'string' ? env.MAIL_DOMAIN.trim().toLowerCase() : '';
  if (!isPlainDomain(primary)) return { primary: '', domains: [], discovered: false };
  return orgDomainsFrom(primary, usableOrgDomainsCache(await loadOrgDomainsCache(db), env.M365_TENANT_ID));
}

/** The domain part of an address, lower case ('' when there is none). */
export function addressDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1).trim().toLowerCase() : '';
}

/**
 * Why Stanchion will not send from this address, or null when it may. Multi-domain
 * phase 1: once the organisation's domains have been discovered, Stanchion sends
 * only from MAIL_DOMAIN, the domain set up for sending (a mailbox on another
 * domain, or one left on a domain that was dropped, can be read and filed but
 * not sent from). Before discovery, nothing changes.
 */
export function sendingDomainRefusal(fromAddress: string, domains: OrgDomains): string | null {
  if (!domains.discovered || !domains.primary) return null;
  const domain = addressDomain(fromAddress);
  if (domain === domains.primary) return null;
  const from = domain ? `@${domain}` : 'this address';
  return `Sending from ${from} isn't set up yet. You can read and file this mailbox's mail; send from an @${domains.primary} address for now.`;
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
