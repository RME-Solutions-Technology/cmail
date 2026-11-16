// Multi-domain discovery for the Microsoft 365 sync (docs/multi-domain.md).
//
// The sync reads the tenant's domains (Graph GET /domains) at most once a day
// (or on "Sync now") and caches the verified mail domains (isVerified, not
// isInitial, supportedServices includes "Email") in org_settings
// (ORG_DOMAINS_SETTING), with the tenant id they came from. Everything that
// asks "is this one of our domains?" reads that cache through orgDomains().
//
// A failed read never shrinks the list: the last good answer is kept and the
// problem is recorded for Admin (for example 'permission_missing' until the
// sync app is granted Domain.Read.All). A domain is removed only when two
// successful reads at least DOMAIN_DROP_AFTER_MS apart both leave it out, so
// one odd answer can never make the sync pause the people on it.
import {
  cleanDomainList,
  emptyOrgDomainsCache,
  loadOrgDomainsCache,
  saveOrgDomainsCache,
  type OrgDomainsCache,
} from '@cmail/shared/org-domains';
import { GraphError, type TenantDomain } from './graph';

/** A successful read is repeated after this long. */
export const DOMAIN_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A failed read is retried after this long. */
export const DOMAIN_RETRY_MS = 60 * 60 * 1000;
/** A domain left out of reads this far apart (the first and a later one) is removed. */
export const DOMAIN_DROP_AFTER_MS = 24 * 60 * 60 * 1000;

/** Graph failures that are not about this one call: the sync backs off on them. */
const SYNC_WIDE: ReadonlySet<string> = new Set(['throttled', 'network', 'credentials_rejected']);

export interface DomainReader {
  domainList(): Promise<TenantDomain[]>;
}

/** Whether a read is due now. */
export function domainRefreshDue(cache: OrgDomainsCache, now: number, force: boolean): boolean {
  if (force) return true;
  if (cache.problem && now - cache.attemptedAt < DOMAIN_RETRY_MS) return false;
  return now - cache.refreshedAt >= DOMAIN_REFRESH_MS;
}

/** The domains cmail may serve from one listing: verified, not initial, Email. */
export function mailDomainsOf(list: readonly TenantDomain[]): string[] {
  return cleanDomainList(list.filter((domain) => domain.isVerified && !domain.isInitial && domain.email).map((domain) => domain.name));
}

/**
 * The next cache after a successful read. A domain the read leaves out is
 * kept, marked missing; it goes only when a read at least
 * DOMAIN_DROP_AFTER_MS after the first one still leaves it out.
 */
export function nextOrgDomainsCache(previous: OrgDomainsCache, listed: readonly string[], tenantId: string, now: number): OrgDomainsCache {
  const keep = new Set(listed);
  const missingSince: Record<string, number> = {};
  for (const domain of previous.domains) {
    if (keep.has(domain)) continue;
    const since = previous.missingSince[domain] ?? now;
    if (now - since >= DOMAIN_DROP_AFTER_MS) continue;
    keep.add(domain);
    missingSince[domain] = since;
  }
  return { tenantId, domains: [...keep].sort(), missingSince, refreshedAt: now, attemptedAt: now, problem: '' };
}

function problemCode(caught: unknown): string {
  if (caught instanceof GraphError) return caught.code === 'unauthorized' ? 'permission_missing' : caught.code;
  return 'error';
}

async function auditChange(db: D1Database, added: string[], removed: string[]): Promise<void> {
  if (!added.length && !removed.length) return;
  await db.prepare(
    `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
     VALUES (?, datetime('now'), NULL, 'system', 'm365_sync.domains_changed', 'org_domains', ?)`,
  ).bind(
    crypto.randomUUID(),
    `Verified Microsoft 365 domains: ${added.length} added${added.length ? ` (${added.join(', ')})` : ''}, ${removed.length} removed${removed.length ? ` (${removed.join(', ')})` : ''}`.slice(0, 1000),
  ).run();
}

/**
 * Refreshes the cache when due and returns the cache to use. A cache from
 * another tenant is dropped first. Graph errors for this call are recorded,
 * not thrown (the sync carries on with the last good list); sync-wide Graph
 * failures and D1 errors are thrown to the sync's own error handling.
 */
export async function refreshOrgDomains(
  db: D1Database,
  reader: DomainReader,
  now: number,
  options: { tenantId: string; force?: boolean },
): Promise<OrgDomainsCache> {
  const tenantId = options.tenantId.trim().toLowerCase();
  const stored = await loadOrgDomainsCache(db);
  const otherTenant = stored.tenantId !== tenantId;
  const cache = otherTenant ? { ...emptyOrgDomainsCache(), tenantId } : stored;
  if (!otherTenant && !domainRefreshDue(cache, now, Boolean(options.force))) return cache;

  let list: TenantDomain[];
  try {
    list = await reader.domainList();
    // Every tenant has at least its initial domain: an empty answer is a fault.
    if (!list.length) throw new GraphError('bad_response', 200);
  } catch (caught) {
    const problem = problemCode(caught);
    console.warn('Microsoft 365 sync: verified domains could not be read; keeping the last list', { problem });
    const kept: OrgDomainsCache = { ...cache, attemptedAt: now, problem };
    await saveOrgDomainsCache(db, kept);
    // Throttling, network and sign-in failures would fail the sync's own
    // calls too: hand them to its backoff. A refused or odd answer for this
    // one call (missing Domain.Read.All, say) only keeps the last list.
    if (!(caught instanceof GraphError) || SYNC_WIDE.has(caught.code)) throw caught;
    return kept;
  }

  const listed = mailDomainsOf(list);
  if (!listed.length && cache.domains.length) {
    // No mail domain at all where some were listed before: more likely a
    // fault than every domain leaving at once.
    console.warn('Microsoft 365 sync: verified domains read back empty; keeping the last list');
    const kept: OrgDomainsCache = { ...cache, attemptedAt: now, problem: 'empty_result' };
    await saveOrgDomainsCache(db, kept);
    return kept;
  }
  const next = nextOrgDomainsCache(cache, listed, tenantId, now);
  await saveOrgDomainsCache(db, next);
  await auditChange(
    db,
    next.domains.filter((domain) => !stored.domains.includes(domain) || otherTenant),
    otherTenant ? stored.domains : stored.domains.filter((domain) => !next.domains.includes(domain)),
  );
  return next;
}
