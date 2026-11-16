// Is this really a journal report from our own Exchange Online tenant?
// (docs/exchange-mirror.md, "How a report is trusted")
//
// What a live Exchange Online journal report looks like (seen on a real
// tenant, 16 Nov 2026; Microsoft does not document it):
// - The report's From is the ORIGINAL message's sender, which for internet
//   mail is someone outside the tenant. So DMARC on the From domain says
//   nothing about our tenant and is not used.
// - The envelope MAIL FROM is the JournalingReportNdrTo address.
// - Only the outer report's own headers are read here, never the attached
//   original's: the original carries headers stamped for its sender.
//
// THE SECURITY BOUNDARY IS THE TOKEN in the journal address (layer 1).
// Everything below raises the bar for someone who has the address; none of
// it alone proves a report came from our tenant.
//
// Layers, all required (fail closed):
// 1. It arrived at the configured journal address, whose local part holds a
//    random token (checked by the caller before anything is read). If the
//    token leaks, rotate it (docs/exchange-mirror.md, "Rotating the journal
//    token").
// 2. It carries the X-MS-Journal-Report header. Any sender can add it.
// 3. Tenant: the outer report's X-MS-Exchange-CrossTenant-Id headers. A
//    report can carry more than one (seen live: the original sender's tenant
//    and ours), so the report passes when OUR id is among them, and a report
//    with only other tenants' ids is refused. This header is
//    ATTACKER-SETTABLE: anyone sending to the journal address can write our
//    tenant id into it. It filters honest mistakes (another tenant's journal
//    rule pointed here); it is not proof. X-MS-Exchange-Organization-*
//    headers are removed by the header firewall when a message leaves an
//    Exchange organization, so they are not used either:
//    https://learn.microsoft.com/en-us/exchange/header-firewall-exchange-2013-help
// 4. Unless M365_JOURNAL_REQUIRE_AUTH is "false", Cloudflare Email Routing's
//    own Authentication-Results record (the first one, from
//    INBOUND_AUTHSERV_ID;
//    https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#authentication-results)
//    shows either
//    a. a DKIM pass whose signing domain (header.d) is in
//       M365_JOURNAL_SENDER_DOMAINS, whatever the From says. Limit: DKIM
//       proves only that the domain signed SOME message; a message the
//       tenant signed can be replayed to the journal address by whoever has
//       the token. Or
//    b. an SPF pass recorded for the envelope MAIL FROM (smtp.mailfrom in
//       that record; the SMTP envelope must agree) whose domain is
//       M365_JOURNAL_NDR_DOMAIN, plus our tenant id on the report. This
//       holds only if Exchange Online refuses to let other tenants send with
//       a MAIL FROM on our NDR domain, which Microsoft does not document
//       (unverified); its sending IPs are shared by every tenant, and the
//       tenant id header (3) is attacker-settable.
//    With "false", only 1-3 apply and our tenant id must be on the report:
//    then the token is the only real protection.
import { parseAuthenticationIdentities, parseAuthenticationResults } from '../authentication-results';
import type { ExchangeMirrorConfig } from '@cmail/shared/exchange-mirror';

type Header = { key: string; value: string };

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_journal_report' | 'wrong_tenant' | 'auth_missing' | 'auth_failed' };

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL = /^[^\s@<>",;:()[\]\\]{1,64}$/;

export function headerValues(headers: readonly Header[] | undefined, name: string): string[] {
  // Keys are trimmed: `From :` (space before the colon) is still From.
  return (headers ?? []).filter((header) => header.key.trim().toLowerCase() === name).map((header) => header.value ?? '');
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

/**
 * Whether a raw message's header block is well formed: every line up to the
 * first empty line is a field (`name:` with printable name characters, space
 * allowed before the colon) or a folded continuation. postal-mime silently
 * drops a line without a colon, so headers read from a message with one
 * cannot be trusted to be all the headers it carries.
 */
export function headerBlockWellFormed(raw: Uint8Array): boolean {
  const limit = Math.min(raw.byteLength, 512 * 1024);
  // Find the empty line that ends the header block (LF LF or LF CR LF).
  let end = -1;
  for (let index = 1; index < limit; index += 1) {
    if (raw[index] !== 0x0a) continue;
    if (raw[index - 1] === 0x0a) { end = index - 1; break; }
    if (raw[index - 1] === 0x0d && index >= 2 && raw[index - 2] === 0x0a) { end = index - 2; break; }
  }
  if (end < 0 && raw.byteLength > limit) return false;
  const stop = end < 0 ? limit : end;
  let block = '';
  for (let index = 0; index < stop; index += 1) block += String.fromCharCode(raw[index] as number);
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (/^[ \t]/.test(line)) {
      if (index === 0) return false;
      continue;
    }
    if (!/^[!-9;-~]+[ \t]*:/.test(line)) return false;
  }
  return true;
}

/** Domain of an envelope address (or of a bare domain), lower case, or null. */
function envelopeDomain(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  const domain = (at >= 0 ? text.slice(at + 1) : text).replace(/\.$/, '');
  return DOMAIN.test(domain) ? domain : null;
}

/**
 * @param headers The OUTER journal report's parsed headers only.
 * @param envelopeFrom The SMTP envelope MAIL FROM Email Routing reported.
 */
export function verifyJournalReport(
  headers: readonly Header[] | undefined,
  config: Pick<ExchangeMirrorConfig, 'tenantId' | 'requireAuth' | 'authservId' | 'senderDomains' | 'ndrDomain'>,
  envelopeFrom: string | null = null,
): VerifyResult {
  if (!headerValues(headers, 'x-ms-journal-report').length) return { ok: false, reason: 'not_journal_report' };

  const tenants = headerValues(headers, 'x-ms-exchange-crosstenant-id').map((value) => value.trim().toLowerCase());
  const ourTenant = Boolean(config.tenantId) && tenants.includes(config.tenantId as string);
  if (config.tenantId && tenants.length && !ourTenant) return { ok: false, reason: 'wrong_tenant' };

  if (!config.requireAuth) {
    // The configuration refuses this mode without M365_TENANT_ID; our id is required.
    return ourTenant ? { ok: true } : { ok: false, reason: 'wrong_tenant' };
  }
  // Only the first Authentication-Results header is the boundary's own.
  const first = headerValues(headers, 'authentication-results')[0];
  const identities = parseAuthenticationIdentities(first ?? null, config.authservId);
  const verdicts = parseAuthenticationResults(first ?? null, config.authservId);
  if (!verdicts.spf && !verdicts.dkim && !verdicts.dmarc && !verdicts.arc) return { ok: false, reason: 'auth_missing' };
  // a. The tenant's own DKIM, independent of the From header.
  const allowed = new Set(config.senderDomains);
  if (identities.dkimPassDomains.some((item) => allowed.has(item))) return { ok: true };
  // b. SPF for the configured NDR domain, plus our tenant id. The domain the
  //    SPF verdict is about must also be the envelope's, when both are known.
  if (config.ndrDomain && identities.spf === 'pass' && ourTenant) {
    // The domain must be the one Cloudflare's record says SPF was checked
    // for: no fallback to the envelope (the verdict is about the record's).
    const recorded = identities.spfMailFromDomain;
    const envelope = envelopeDomain(envelopeFrom);
    if (recorded === config.ndrDomain && (envelope === null || envelope === recorded)) return { ok: true };
  }
  return { ok: false, reason: 'auth_failed' };
}
