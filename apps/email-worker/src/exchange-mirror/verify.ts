// Is this really a journal report from our own Exchange Online tenant?
// (docs/exchange-mirror.md, "How a report is trusted")
//
// Layers, all required (fail closed):
// 1. It arrived at the configured journal address, whose local part holds a
//    random token (checked by the caller before anything is read).
// 2. It carries the X-MS-Journal-Report header Exchange puts on every
//    journal report.
// 3. When M365_TENANT_ID is set, every X-MS-Exchange-CrossTenant-Id header
//    on the report equals it. Microsoft does not document that the header is
//    always present on a journal report, so with authentication on its
//    absence is allowed (a different tenant's id is refused). With
//    authentication off (M365_JOURNAL_REQUIRE_AUTH "false") the header is
//    required: the tenant id is then the only tie to the tenant.
// 4. Unless M365_JOURNAL_REQUIRE_AUTH is "false": Cloudflare Email Routing's
//    own Authentication-Results record (the first one, from
//    INBOUND_AUTHSERV_ID) shows either DMARC pass for a From domain in
//    M365_JOURNAL_SENDER_DOMAINS (whole-domain match; if the record names
//    header.from it must be the same domain), or a DKIM pass signed by one
//    of them. Cloudflare documents that record:
//    https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#authentication-results
import { parseAuthenticationIdentities } from '../authentication-results';
import type { ExchangeMirrorConfig } from '@cmail/shared/exchange-mirror';

type Header = { key: string; value: string };

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_journal_report' | 'wrong_tenant' | 'auth_missing' | 'auth_failed' };

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL = /^[^\s@<>",;:()[\]\\]{1,64}$/;

export function headerValues(headers: readonly Header[] | undefined, name: string): string[] {
  return (headers ?? []).filter((header) => header.key.toLowerCase() === name).map((header) => header.value ?? '');
}

/**
 * Domain of the one address in a From header, or null. The whole addr-spec
 * must be plain: one `@`, a plain local part and a domain that is a valid
 * domain name from its first character to its last. Anything else (two
 * addresses, a comment, `x@tenant.example_.evil.example`) gives null, so a
 * prefix of a domain can never pass for the domain.
 */
export function fromDomain(fromHeader: string | undefined): string | null {
  if (!fromHeader) return null;
  const value = fromHeader.trim();
  if (value.length > 998 || /[\r\n()]/.test(value)) return null;
  let spec = value;
  const open = value.lastIndexOf('<');
  if (open >= 0) {
    if (!value.endsWith('>') || value.indexOf('>') !== value.length - 1 || value.indexOf('<') !== open) return null;
    spec = value.slice(open + 1, -1);
    const name = value.slice(0, open).trim();
    // A display name may be quoted (and then hold anything but a quote) or
    // plain words; it may not hold another address.
    if (name && !/^"[^"]*"$/.test(name) && /[@<>,;:"]/.test(name)) return null;
  }
  spec = spec.trim();
  const at = spec.indexOf('@');
  if (at <= 0 || at !== spec.lastIndexOf('@')) return null;
  const local = spec.slice(0, at);
  const domain = spec.slice(at + 1).toLowerCase();
  if (!LOCAL.test(local) || !DOMAIN.test(domain)) return null;
  return domain;
}

export function verifyJournalReport(
  headers: readonly Header[] | undefined,
  config: Pick<ExchangeMirrorConfig, 'tenantId' | 'requireAuth' | 'authservId' | 'senderDomains'>,
): VerifyResult {
  if (!headerValues(headers, 'x-ms-journal-report').length) return { ok: false, reason: 'not_journal_report' };

  const tenants = headerValues(headers, 'x-ms-exchange-crosstenant-id').map((value) => value.trim().toLowerCase());
  if (config.tenantId && tenants.some((value) => value !== config.tenantId)) return { ok: false, reason: 'wrong_tenant' };

  if (!config.requireAuth) {
    // The configuration refuses this mode without M365_TENANT_ID; check again.
    if (!config.tenantId || !tenants.length) return { ok: false, reason: 'wrong_tenant' };
    return { ok: true };
  }
  // Only the first Authentication-Results header is the boundary's own.
  const first = headerValues(headers, 'authentication-results')[0];
  const identities = parseAuthenticationIdentities(first ?? null, config.authservId);
  const facts = identities.dmarc !== null || identities.dkimPassDomains.length > 0;
  if (!facts) return { ok: false, reason: 'auth_missing' };
  const allowed = new Set(config.senderDomains);
  const froms = headerValues(headers, 'from');
  const domain = froms.length === 1 ? fromDomain(froms[0]) : null;
  // DMARC is evaluated on the RFC 5322 From domain, so a pass ties the From
  // domain to an aligned SPF or DKIM result. When the boundary also names
  // the domain it evaluated, it must be the same one.
  const dmarcDomainOk = identities.dmarcHeaderFrom === null || identities.dmarcHeaderFrom === domain;
  if (identities.dmarc === 'pass' && domain && allowed.has(domain) && dmarcDomainOk) return { ok: true };
  if (identities.dkimPassDomains.some((item) => allowed.has(item))) return { ok: true };
  return { ok: false, reason: 'auth_failed' };
}
