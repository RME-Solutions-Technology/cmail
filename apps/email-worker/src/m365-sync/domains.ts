// Multi-domain discovery for the Microsoft 365 sync (docs/multi-domain.md).
//
// The sync reads the tenant's verified domains (Graph GET /domains) at most
// once a day (or on "Sync now") and caches them in org_settings
// (ORG_DOMAINS_SETTING). Everything that asks "is this one of our domains?"
// reads that cache through orgDomains().
//
// A failed read never shrinks the list: the last good answer is kept and the
// problem is recorded for Admin (for example 'permission_missing' until the
// sync app is granted Domain.Read.All). Only a successful read that no longer
// lists a domain removes it.
import {
  cleanDomainList,
  loadOrgDomainsCache,
  saveOrgDomainsCache,
  type OrgDomainsCache,
} from '@cmail/shared/org-domains';
import { GraphError } from './graph';

/** A successful read is repeated after this long. */
export const DOMAIN_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A failed read is retried after this long. */
export const DOMAIN_RETRY_MS = 60 * 60 * 1000;

/** Graph failures that are not about this one call: the sync backs off on them. */
const SYNC_WIDE: ReadonlySet<string> = new Set(['throttled', 'network', 'credentials_rejected']);

export interface DomainReader {
  verifiedDomains(): Promise<string[]>;
}

/** Whether a read is due now. */
export function domainRefreshDue(cache: OrgDomainsCache, now: number, force: boolean): boolean {
  if (force) return true;
  if (cache.problem && now - cache.attemptedAt < DOMAIN_RETRY_MS) return false;
  return now - cache.refreshedAt >= DOMAIN_REFRESH_MS;
}

function problemCode(caught: unknown): string {
  if (caught instanceof GraphError) return caught.code === 'unauthorized' ? 'permission_missing' : caught.code;
  return 'error';
}

/**
 * Refreshes the cache when due and returns the cache to use. Graph errors are
 * recorded, never thrown (the sync itself carries on with the last good
 * list); a D1 error is thrown to the sync's own error handling.
 */
export async function refreshOrgDomains(
  db: D1Database,
  reader: DomainReader,
  now: number,
  options: { force?: boolean } = {},
): Promise<OrgDomainsCache> {
  const cache = await loadOrgDomainsCache(db);
  if (!domainRefreshDue(cache, now, Boolean(options.force))) return cache;

  let names: string[];
  try {
    names = await reader.verifiedDomains();
    // Every tenant has at least its initial domain: an empty answer is a fault.
    if (!names.length) throw new GraphError('bad_response', 200);
  } catch (caught) {
    const problem = problemCode(caught);
    console.warn('Microsoft 365 sync: verified domains could not be read; keeping the last list', { problem });
    const kept: OrgDomainsCache = { ...cache, attemptedAt: now, problem };
    await saveOrgDomainsCache(db, kept);
    // Throttling, network and sign-in failures would fail the sync's own
    // calls too: hand them to its backoff. A refused or odd answer for this
    // one call (missing Domain.Read.All, say) only keeps the last list.
    if (caught instanceof GraphError && SYNC_WIDE.has(caught.code)) throw caught;
    if (!(caught instanceof GraphError)) throw caught;
    return kept;
  }

  const domains = cleanDomainList(names);
  if (!domains.length && cache.domains.length) {
    // Only initial (*.onmicrosoft.com) domains where real ones were listed
    // before: more likely a fault than every domain leaving at once.
    console.warn('Microsoft 365 sync: verified domains read back empty; keeping the last list');
    const kept: OrgDomainsCache = { ...cache, attemptedAt: now, problem: 'empty_result' };
    await saveOrgDomainsCache(db, kept);
    return kept;
  }
  const next: OrgDomainsCache = { domains, refreshedAt: now, attemptedAt: now, problem: '' };
  await saveOrgDomainsCache(db, next);
  const added = domains.filter((domain) => !cache.domains.includes(domain));
  const removed = cache.domains.filter((domain) => !domains.includes(domain));
  if (added.length || removed.length) {
    await db.prepare(
      `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
       VALUES (?, datetime('now'), NULL, 'system', 'm365_sync.domains_changed', 'org_domains', ?)`,
    ).bind(
      crypto.randomUUID(),
      `Verified Microsoft 365 domains: ${added.length} added${added.length ? ` (${added.join(', ')})` : ''}, ${removed.length} removed${removed.length ? ` (${removed.join(', ')})` : ''}`.slice(0, 1000),
    ).run();
  }
  return next;
}
