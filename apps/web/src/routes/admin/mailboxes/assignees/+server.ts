import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchEligibleMailboxAssignees } from '#lib/server/mailbox-assignees.js';
import { orgDomainsForDisplay } from '#lib/server/org-domains.js';
import { normalizeDomain } from '#lib/server/validation.js';

const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store' };

export const GET: RequestHandler = async ({ locals, platform, url }) => {
  if (!locals.user) {
    return json({ error: 'Authentication required' }, { status: 401, headers: PRIVATE_NO_STORE });
  }
  if (locals.user.role !== 'manager') {
    return json({ error: 'Manager role required' }, { status: 403, headers: PRIVATE_NO_STORE });
  }

  const env = platform?.env;
  if (!env?.DB || !normalizeDomain(env?.MAIL_DOMAIN)) {
    return json({ error: 'Mailbox configuration is unavailable' }, { status: 503, headers: PRIVATE_NO_STORE });
  }

  const rawQuery = url.searchParams.get('q') || '';
  const query = rawQuery.trim();
  if (!query || query.length > 100) {
    return json(
      { error: 'Search text must contain between 1 and 100 characters' },
      { status: 400, headers: PRIVATE_NO_STORE },
    );
  }

  // Every organisation domain (docs/multi-domain.md); MAIL_DOMAIN alone if
  // the list cannot be read (narrower, never wider).
  const { domains } = await orgDomainsForDisplay(env);
  const assignees = await searchEligibleMailboxAssignees(env.DB, domains, query, 8);
  return json(assignees, { headers: PRIVATE_NO_STORE });
};
