// The organisation's mail domains in the web app (docs/multi-domain.md).
// The list itself comes from @cmail/shared/org-domains: MAIL_DOMAIN plus the
// tenant's verified domains the Microsoft 365 sync discovered. A manager can
// only choose from it; a domain is never typed in.
import { orgDomains, orgDomainsFrom, type OrgDomains } from '@cmail/shared/org-domains';

/**
 * For a page load that only shows choices: on a D1 failure it falls back to
 * MAIL_DOMAIN alone (narrower, never wider) and logs. Actions that create
 * anything use orgDomains() and fail instead.
 */
export async function orgDomainsForDisplay(env: { MAIL_DOMAIN?: unknown; M365_TENANT_ID?: unknown; DB: D1Database }): Promise<OrgDomains> {
  try {
    return await orgDomains(env, env.DB);
  } catch (caught) {
    console.error('Organisation domains could not be read; showing MAIL_DOMAIN only', caught instanceof Error ? caught.name : 'UnknownError');
    return orgDomainsFrom(env.MAIL_DOMAIN, { domains: [], refreshedAt: 0 });
  }
}

/**
 * The domain a manager picked in a form: one of the organisation's domains,
 * the primary when the field is empty or absent, or null when it is anything
 * else (a tampered or stale value).
 */
export function chooseOrgDomain(raw: FormDataEntryValue | null, domains: OrgDomains): string | null {
  if (!domains.primary) return null;
  if (raw === null || raw === '') return domains.primary;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return domains.primary;
  return domains.domains.includes(value) ? value : null;
}
