// Is this really a journal report from our own Exchange Online tenant?
// (docs/exchange-mirror.md, "How a report is trusted")
//
// Layers, all required (fail closed):
// 1. It arrived at the configured journal address, whose local part holds a
//    random token (checked by the caller before anything is read).
// 2. It carries the X-MS-Journal-Report header Exchange puts on every
//    journal report.
// 3. When M365_TENANT_ID is set, every X-MS-Exchange-CrossTenant-Id header
//    on the report equals it. (Microsoft does not document that the header
//    is always present on a journal report, so its absence is allowed; a
//    different tenant's id is refused.)
// 4. Unless M365_JOURNAL_REQUIRE_AUTH is "false": Cloudflare Email Routing's
//    own Authentication-Results record (the first one, from
//    INBOUND_AUTHSERV_ID) shows either DMARC pass for a From domain in
//    M365_JOURNAL_SENDER_DOMAINS, or a DKIM pass signed by one of them.
//    Cloudflare documents that record:
//    https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#authentication-results
import { parseAuthenticationIdentities } from '../authentication-results';
import type { ExchangeMirrorConfig } from '@cmail/shared/exchange-mirror';

type Header = { key: string; value: string };

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_journal_report' | 'wrong_tenant' | 'auth_missing' | 'auth_failed' };

function headerValues(headers: readonly Header[] | undefined, name: string): string[] {
  return (headers ?? []).filter((header) => header.key.toLowerCase() === name).map((header) => header.value ?? '');
}

/** Domain of the single address in a From header, lower case, or null. */
export function fromDomain(fromHeader: string | undefined): string | null {
  if (!fromHeader) return null;
  const addresses = fromHeader.match(/[^\s<>",;:@]+@([a-z0-9.-]+)/gi) ?? [];
  if (addresses.length !== 1) return null;
  const domain = (addresses[0] ?? '').split('@').pop()?.toLowerCase().replace(/\.$/, '') ?? '';
  return domain || null;
}

export function verifyJournalReport(
  headers: readonly Header[] | undefined,
  config: Pick<ExchangeMirrorConfig, 'tenantId' | 'requireAuth' | 'authservId' | 'senderDomains'>,
): VerifyResult {
  if (!headerValues(headers, 'x-ms-journal-report').length) return { ok: false, reason: 'not_journal_report' };

  if (config.tenantId) {
    const tenants = headerValues(headers, 'x-ms-exchange-crosstenant-id').map((value) => value.trim().toLowerCase());
    if (tenants.some((value) => value !== config.tenantId)) return { ok: false, reason: 'wrong_tenant' };
  }

  if (!config.requireAuth) return { ok: true };
  // Only the first Authentication-Results header is the boundary's own.
  const first = headerValues(headers, 'authentication-results')[0];
  const identities = parseAuthenticationIdentities(first ?? null, config.authservId);
  const facts = identities.dmarc !== null || identities.dkimPassDomains.length > 0;
  if (!facts) return { ok: false, reason: 'auth_missing' };
  const allowed = new Set(config.senderDomains);
  const froms = headerValues(headers, 'from');
  const domain = froms.length === 1 ? fromDomain(froms[0]) : null;
  // DMARC is evaluated on the RFC 5322 From domain, so a pass ties the From
  // domain to an aligned SPF or DKIM result.
  if (identities.dmarc === 'pass' && domain && allowed.has(domain)) return { ok: true };
  if (identities.dkimPassDomains.some((item) => allowed.has(item))) return { ok: true };
  return { ok: false, reason: 'auth_failed' };
}
