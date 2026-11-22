/**
 * Focused Inbox (docs/focused-inbox.md): Outlook-style Focused and Other tabs
 * over the Inbox, for any Stanchion mailbox.
 *
 * Off by default. With the organisation switch off nothing here touches a
 * message: decideFocusAtDelivery returns null after one settings read and the
 * delivery paths store exactly what they stored before.
 *
 * Classification is deterministic and explainable. Each Inbox message gets a
 * class ('focused' or 'other') and the short code of the one signal that
 * decided it, checked in a fixed order (classifyFocus). No content is read
 * beyond the sender address and a few standard headers, and nothing leaves
 * the database. Other is a view of the Inbox, never a folder: a message in
 * Other is still in the Inbox, still searchable and still counted.
 *
 * Inbox rules and spam quarantine come first: only a message that is still
 * bound for the Inbox after both is classified.
 *
 * Shared by the email Worker (normal delivery and the Exchange mirror), the
 * web app's internal delivery and the web app's one-off sort of recent mail.
 * This file has no imports so node --test can run its tests directly.
 */

/** org_settings key of the manager switch. Absent or anything but 'true' = off. */
export const ORG_SETTING_FOCUSED_INBOX = 'focused_inbox_enabled';

/**
 * org_settings key of the organisation's discovered domains: the same key as
 * ORG_DOMAINS_SETTING in org-domains.ts (a test keeps them equal; this file
 * has no imports).
 */
export const FOCUS_ORG_DOMAINS_SETTING = 'm365_verified_domains';

const FOCUS_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const FOCUS_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The organisation's discovered domains from that setting's JSON, by the same
 * rules as parseOrgDomainsCache + usableOrgDomainsCache in org-domains.ts
 * (a test checks they agree): valid lower-case domains, never
 * *.onmicrosoft.com, sorted, unique, at most 200; [] when malformed, when the
 * list names no tenant, or when `tenantId` (M365_TENANT_ID) names another.
 */
export function focusOrgDomains(raw: string | null | undefined, tenantId?: string | null): string[] {
  if (!raw) return [];
  let parsed: { domains?: unknown; tenantId?: unknown } | null;
  try {
    parsed = JSON.parse(raw) as { domains?: unknown; tenantId?: unknown } | null;
  } catch {
    // A corrupt value only means no extra domains (MAIL_DOMAIN alone).
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.domains)) return [];
  const listTenant = typeof parsed.tenantId === 'string' ? parsed.tenantId.trim().toLowerCase() : '';
  const expected = (tenantId || '').trim().toLowerCase();
  if (!FOCUS_GUID.test(listTenant) || (FOCUS_GUID.test(expected) && listTenant !== expected)) return [];
  const out = new Set<string>();
  for (const value of parsed.domains) {
    if (typeof value !== 'string') continue;
    const domain = value.trim().toLowerCase();
    if (!FOCUS_DOMAIN.test(domain) || domain === 'onmicrosoft.com' || domain.endsWith('.onmicrosoft.com')) continue;
    out.add(domain);
  }
  return [...out].sort().slice(0, 200);
}
export const FOCUS_CLASSES = ['focused', 'other'] as const;
export type FocusClass = (typeof FOCUS_CLASSES)[number];

/**
 * Why a message is where it is. Stored in messages.focus_reason (at most 32
 * characters). Order here is the order classifyFocus checks them in; 'moved'
 * is a person's own one-off move.
 */
export const FOCUS_REASONS = [
  'sender_override',
  'domain_override',
  'delivery_report',
  'auto_submitted',
  'correspondent',
  'mailing_list',
  'bulk_precedence',
  'internal',
  'automated_sender',
  'frequent_sender',
  'default',
  'moved',
] as const;
export type FocusReason = (typeof FOCUS_REASONS)[number];

/** Plain-language explanation of each reason, for the message view and docs. */
export const FOCUS_REASON_TEXT: Record<FocusReason, string> = {
  sender_override: 'You chose to always move messages from this sender here.',
  domain_override: 'This sender\'s domain is on your list for this tab.',
  delivery_report: 'It is a delivery report about mail you sent.',
  auto_submitted: 'It was sent automatically (Auto-Submitted header).',
  mailing_list: 'It came from a mailing list or newsletter (List-Id or List-Unsubscribe header).',
  bulk_precedence: 'It is marked as bulk mail (Precedence header).',
  correspondent: 'You have sent mail to this sender.',
  internal: 'The sender is in your organisation.',
  automated_sender: 'The sender address looks automated (for example noreply@).',
  frequent_sender: 'This sender has sent you many messages and you have not written to them.',
  default: 'No signal pointed to Other.',
  moved: 'You moved this message here.',
};

/** How many of the mailbox's newest Sent messages are searched for "you wrote to them". */
export const CORRESPONDENT_SCAN_SENT = 2_000;
/** How many of the mailbox's newest Inbox messages are counted for "frequent sender". */
export const FREQUENT_SCAN_INBOX = 500;
/** That many or more of those from one address (never written to) is "frequent". */
export const FREQUENT_SENDER_THRESHOLD = 20;
/** The one-off sort of recent mail looks at no more than this many Inbox messages. */
export const BACKFILL_LIMIT = 1_000;
/** Per mailbox, addresses and domains together. Migration 0031 enforces it too. */
export const MAX_OVERRIDES_PER_MAILBOX = 1_000;

export function isFocusClass(value: unknown): value is FocusClass {
  return value === 'focused' || value === 'other';
}

export function isFocusReason(value: unknown): value is FocusReason {
  return typeof value === 'string' && (FOCUS_REASONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Addresses and domains

const DOMAIN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A domain for a per-mailbox list, or null. Lower-cased; a leading "@" or "*."
 * is accepted and dropped. At least two labels, letters, digits and hyphens
 * only (an internationalised domain must be entered in its xn-- form).
 */
export function normalizeFocusDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase().replace(/^@/, '').replace(/^\*\./, '').replace(/\.$/, '');
  if (!domain || domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return null;
  return domain;
}

/**
 * A sender address for an override, or null: lower-cased, one "@", no
 * whitespace or control characters, at most 320 characters. Quoted local
 * parts are kept as stored on the message.
 */
export function normalizeFocusAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  if (!address || address.length > 320 || /[\s\u0000-\u001f\u007f]/.test(address)) return null;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return normalizeFocusDomain(address.slice(at + 1)) ? address : null;
}

/** The domain part of an address (after the final "@"), lower-cased; '' when none. */
export function senderDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}

/**
 * The domain and each parent domain with at least two labels, most specific
 * first: a list entry for example.org also covers news.example.org.
 */
export function focusDomainCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  const candidates: string[] = [];
  for (let start = 0; start <= labels.length - 2 && candidates.length < 10; start += 1) {
    candidates.push(labels.slice(start).join('.'));
  }
  return candidates;
}

/** Local parts that, after removing "+tag" and . _ -, mark an automated sender. */
const AUTOMATED_LOCAL_EXACT = new Set([
  'notification',
  'notifications',
  'newsletter',
  'newsletters',
  'news',
  'marketing',
  'mailer',
]);
const AUTOMATED_LOCAL_PREFIXES = ['noreply', 'donotreply'];

/** True for noreply@, no-reply-x@, do_not_reply@, notifications@, newsletter@ and similar. */
export function isAutomatedSender(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at <= 0) return false;
  const local = address.slice(0, at).toLowerCase().replace(/^"|"$/g, '').split('+')[0]?.replace(/[._-]/g, '') ?? '';
  if (!local) return false;
  return AUTOMATED_LOCAL_EXACT.has(local) || AUTOMATED_LOCAL_PREFIXES.some((prefix) => local.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Header signals

export interface FocusHeaderSignals {
  /** multipart/report; report-type=delivery-status (RFC 3464): a bounce or delay notice. */
  deliveryReport: boolean;
  /** Auto-Submitted with any value other than "no" (RFC 3834). */
  autoSubmitted: boolean;
  /** List-Id (RFC 2919) or List-Unsubscribe (RFC 2369). */
  mailingList: boolean;
  /** Precedence: bulk, list or junk (widely used; not a standard). */
  bulkPrecedence: boolean;
}

type HeaderLike = { key: string; value: string };

/** Header values are only looked at up to this length. */
const MAX_SIGNAL_HEADER_CHARS = 512;

/**
 * Reads the four header signals from a parsed header list (postal-mime's
 * `headers`). Returns null when there are no headers to read, so a caller
 * that cannot see headers (internal delivery, the one-off sort) says so
 * rather than claiming "no list headers".
 */
export function focusHeaderSignals(headers: readonly HeaderLike[] | null | undefined): FocusHeaderSignals | null {
  if (!headers || !Array.isArray(headers)) return null;
  const signals: FocusHeaderSignals = { deliveryReport: false, autoSubmitted: false, mailingList: false, bulkPrecedence: false };
  let firstContentType = true;
  for (const header of headers) {
    if (!header || typeof header.key !== 'string' || typeof header.value !== 'string') continue;
    const key = header.key.toLowerCase();
    const value = header.value.slice(0, MAX_SIGNAL_HEADER_CHARS).trim().toLowerCase();
    if (key === 'auto-submitted') {
      const token = value.split(';')[0]?.trim() ?? '';
      if (token && token !== 'no') signals.autoSubmitted = true;
    } else if (key === 'list-id' || key === 'list-unsubscribe') {
      if (value) signals.mailingList = true;
    } else if (key === 'precedence') {
      if (['bulk', 'list', 'junk'].includes(value.split(/[\s;]/)[0] ?? '')) signals.bulkPrecedence = true;
    } else if (key === 'content-type' && firstContentType) {
      // Only the message's own (first) Content-Type counts.
      firstContentType = false;
      if (/^multipart\/report\s*;/.test(value) && /(?:^|;)\s*report-type\s*=\s*"?delivery-status"?\s*(?:;|$)/.test(value)) {
        signals.deliveryReport = true;
      }
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// The classifier

/**
 * The sender's domain is MAIL_DOMAIN or another organisation domain. Only
 * ever used together with a proven From (senderAuthenticated).
 */
export function isOrgSender(sender: string, mailDomain: string, orgDomains: readonly string[] = []): boolean {
  const domain = senderDomain(sender);
  if (!domain) return false;
  return (Boolean(mailDomain) && domain === mailDomain) || orgDomains.includes(domain);
}

export interface FocusFacts {
  /** Header From address, lower-cased. */
  sender: string;
  /** MAIL_DOMAIN, lower-cased; '' when not configured. */
  mailDomain: string;
  /**
   * The organisation's other mail domains (docs/multi-domain.md), lower
   * case. Absent or empty: MAIL_DOMAIN alone, as before.
   */
  orgDomains?: readonly string[];
  /** null when headers were not available (internal delivery, one-off sort). */
  signals: FocusHeaderSignals | null;
  /**
   * The From address is proven: a DMARC pass recorded by the trusted boundary
   * (INBOUND_AUTHSERV_ID), an Exchange-authenticated internal submission on
   * the mirror, or a Stanchion mailbox sending internally. Only then may the
   * sender count as a correspondent or as internal: a forged From must not
   * buy a place in Focused.
   */
  senderAuthenticated: boolean;
  /** This mailbox's override for the exact sender address. */
  addressOverride: FocusClass | null;
  /** This mailbox's override for the sender's domain (most specific match). */
  domainOverride: FocusClass | null;
  /** This mailbox has sent mail to the sender (in its newest CORRESPONDENT_SCAN_SENT Sent messages). */
  correspondent: boolean;
  /** A shared mailbox: its replies go out from personal mailboxes, so "never written to" says nothing. */
  sharedMailbox: boolean;
  /** Messages from this exact sender among the mailbox's newest FREQUENT_SCAN_INBOX Inbox messages. */
  recentFromSender: number;
}

export interface FocusDecision {
  focusClass: FocusClass;
  reason: FocusReason;
}

/**
 * First matching signal wins:
 *  1. the person's own choices (address beats domain);
 *  2. a delivery report about mail they sent stays in Focused;
 *  3. an automatic reply (Auto-Submitted) goes to Other;
 *  4. an authenticated sender this mailbox has written to stays in Focused,
 *     even when their mail carries list headers;
 *  5. list and bulk mail goes to Other (List-Id or List-Unsubscribe,
 *     Precedence bulk/list/junk);
 *  6. an authenticated colleague (any organisation domain) stays in Focused;
 *  7. automated-looking senders, then (personal mailboxes only) senders who
 *     write very often without ever being written to, go to Other;
 *  8. everything else stays in Focused.
 * Focused is the safe default: a wrong Other costs more than a wrong Focused.
 */
export function classifyFocus(facts: FocusFacts): FocusDecision {
  if (facts.addressOverride) return { focusClass: facts.addressOverride, reason: 'sender_override' };
  if (facts.domainOverride) return { focusClass: facts.domainOverride, reason: 'domain_override' };
  const signals = facts.signals;
  if (signals?.deliveryReport) return { focusClass: 'focused', reason: 'delivery_report' };
  if (signals?.autoSubmitted) return { focusClass: 'other', reason: 'auto_submitted' };
  if (facts.senderAuthenticated && facts.correspondent) return { focusClass: 'focused', reason: 'correspondent' };
  if (signals?.mailingList) return { focusClass: 'other', reason: 'mailing_list' };
  if (signals?.bulkPrecedence) return { focusClass: 'other', reason: 'bulk_precedence' };
  if (facts.senderAuthenticated && isOrgSender(facts.sender, facts.mailDomain, facts.orgDomains)) {
    return { focusClass: 'focused', reason: 'internal' };
  }
  if (isAutomatedSender(facts.sender)) return { focusClass: 'other', reason: 'automated_sender' };
  if (!facts.sharedMailbox && facts.recentFromSender >= FREQUENT_SENDER_THRESHOLD) return { focusClass: 'other', reason: 'frequent_sender' };
  return { focusClass: 'focused', reason: 'default' };
}

/**
 * Which per-mailbox scans can still change the answer once the headers and
 * the sender are known: the Sent scan only for an authenticated sender not
 * already decided by a delivery report or Auto-Submitted; the frequency count
 * only when no header, no automated-looking address and no internal match
 * decides first.
 */
export function focusScansNeeded(input: {
  sender: string;
  mailDomain: string;
  orgDomains?: readonly string[];
  signals: FocusHeaderSignals | null;
  senderAuthenticated: boolean;
}): { correspondent: boolean; frequent: boolean } {
  const s = input.signals;
  const headerDecides = Boolean(s && (s.deliveryReport || s.autoSubmitted || s.mailingList || s.bulkPrecedence));
  const internal = input.senderAuthenticated && isOrgSender(input.sender, input.mailDomain, input.orgDomains);
  return {
    correspondent: input.senderAuthenticated && !(s && (s.deliveryReport || s.autoSubmitted)),
    frequent: !headerDecides && !internal && !isAutomatedSender(input.sender),
  };
}

// ---------------------------------------------------------------------------
// Database lookups (D1)

/** A JSON column read through json_each only when it is valid JSON. */
const jsonOrEmpty = (column: string) => `CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END`;

/**
 * One statement: is sorting on for this mailbox, and (only when it is) the
 * per-mailbox facts about this sender. SQLite evaluates a CASE branch only
 * when it is taken, so with either switch off this reads two small rows, and
 * a scan the headers already made pointless (?5, ?6 = 0) is skipped.
 * ?1 mailbox id, ?2 sender address, ?3 JSON array of domain candidates,
 * ?4 the org_settings key, ?5 run the Sent scan, ?6 run the frequency count,
 * ?7 the org_settings key of the organisation's discovered domains (read only
 * while sorting is on, so multi-domain costs no extra statement).
 */
export const FOCUS_LOOKUP_SQL = `
WITH cfg AS (
  SELECT (
    COALESCE((SELECT value FROM org_settings WHERE key = ?4), '') = 'true'
    AND COALESCE((SELECT enabled FROM focus_mailbox_settings WHERE mailbox_id = ?1), 1) = 1
  ) AS active
)
SELECT
  cfg.active AS active,
  CASE WHEN cfg.active THEN (
    SELECT focus_class FROM focus_sender_overrides
    WHERE mailbox_id = ?1 AND kind = 'address' AND pattern = ?2
  ) END AS address_class,
  CASE WHEN cfg.active THEN (
    SELECT focus_class FROM focus_sender_overrides
    WHERE mailbox_id = ?1 AND kind = 'domain' AND pattern IN (SELECT value FROM json_each(?3))
    ORDER BY length(pattern) DESC LIMIT 1
  ) END AS domain_class,
  CASE WHEN cfg.active THEN (SELECT value FROM org_settings WHERE key = ?7) END AS org_domains,
  CASE WHEN cfg.active THEN (SELECT type = 'shared' FROM mailboxes WHERE id = ?1) ELSE 0 END AS shared_mailbox,
  CASE WHEN cfg.active AND ?5 THEN EXISTS (
    SELECT 1 FROM (
      SELECT to_addresses, cc_addresses, bcc_addresses FROM messages
      WHERE mailbox_id = ?1 AND folder = 'sent'
      ORDER BY received_at DESC LIMIT ${CORRESPONDENT_SCAN_SENT}
    ) sent
    WHERE EXISTS (SELECT 1 FROM json_each(${jsonOrEmpty('sent.to_addresses')}) WHERE lower(value) = ?2)
       OR EXISTS (SELECT 1 FROM json_each(${jsonOrEmpty('sent.cc_addresses')}) WHERE lower(value) = ?2)
       OR EXISTS (SELECT 1 FROM json_each(${jsonOrEmpty('sent.bcc_addresses')}) WHERE lower(value) = ?2)
  ) ELSE 0 END AS correspondent,
  CASE WHEN cfg.active AND ?6 AND COALESCE((SELECT type FROM mailboxes WHERE id = ?1), '') <> 'shared' THEN (
    SELECT COUNT(*) FROM (
      SELECT from_address FROM messages
      WHERE mailbox_id = ?1 AND folder = 'inbox' AND direction = 'inbound'
      ORDER BY received_at DESC LIMIT ${FREQUENT_SCAN_INBOX}
    ) recent
    WHERE lower(recent.from_address) = ?2
  ) ELSE 0 END AS recent_from_sender
FROM cfg`;

interface FocusLookupRow {
  active: number | null;
  address_class: string | null;
  domain_class: string | null;
  org_domains: string | null;
  shared_mailbox: number | null;
  correspondent: number | null;
  recent_from_sender: number | null;
}

export interface DeliveryFocusInput {
  mailboxId: string;
  /** Header From address. */
  sender: string;
  /** MAIL_DOMAIN of the deployment. */
  mailDomain?: string | null;
  /** M365_TENANT_ID of the deployment: a discovered domain list from another tenant is ignored. */
  tenantId?: string | null;
  /** Parsed header list, or null when the path has none. */
  headers: readonly HeaderLike[] | null | undefined;
  /** See FocusFacts.senderAuthenticated. Unproven senders are never correspondents or internal. */
  senderAuthenticated: boolean;
}

/** One log line per isolate when the lookup fails (for example, migration 0031 not applied). */
let lookupFailureLogged = false;

/**
 * The class for a message about to be filed in a mailbox's Inbox, or null
 * when sorting is off for that mailbox (or the lookup failed). null means
 * "store nothing": the message is then shown under Focused like any message
 * from before the feature was turned on. Never throws; delivery must not
 * depend on it.
 */
export async function decideFocusAtDelivery(db: D1Database, input: DeliveryFocusInput): Promise<FocusDecision | null> {
  try {
    const sender = normalizeFocusAddress(input.sender);
    if (!sender || !input.mailboxId) return null;
    const mailDomain = (input.mailDomain || '').trim().toLowerCase();
    const signals = focusHeaderSignals(input.headers);
    const senderAuthenticated = input.senderAuthenticated === true;
    const scans = focusScansNeeded({ sender, mailDomain, signals, senderAuthenticated });
    const row = await db.prepare(FOCUS_LOOKUP_SQL)
      .bind(
        input.mailboxId,
        sender,
        JSON.stringify(focusDomainCandidates(senderDomain(sender))),
        ORG_SETTING_FOCUSED_INBOX,
        scans.correspondent ? 1 : 0,
        scans.frequent ? 1 : 0,
        FOCUS_ORG_DOMAINS_SETTING,
      )
      .first<FocusLookupRow>();
    if (!row || Number(row.active) !== 1) return null;
    return classifyFocus({
      sender,
      mailDomain,
      orgDomains: focusOrgDomains(row.org_domains, input.tenantId),
      signals,
      senderAuthenticated,
      addressOverride: isFocusClass(row.address_class) ? row.address_class : null,
      domainOverride: isFocusClass(row.domain_class) ? row.domain_class : null,
      correspondent: Number(row.correspondent) === 1,
      sharedMailbox: Number(row.shared_mailbox) === 1,
      recentFromSender: Number(row.recent_from_sender) || 0,
    });
  } catch {
    // Once per isolate, with no addresses or content.
    if (!lookupFailureLogged) {
      lookupFailureLogged = true;
      console.error('Focused Inbox classification was skipped (lookup failed; is migration 0031 applied?)');
    }
    return null;
  }
}

/** The statement that stores a decision on a just-inserted message (same batch). */
export function focusUpdateStatement(db: D1Database, messageId: string, decision: FocusDecision): D1PreparedStatement {
  return db.prepare('UPDATE messages SET focus_class = ?, focus_reason = ? WHERE id = ?')
    .bind(decision.focusClass, decision.reason, messageId);
}

/** Whether the manager switch is on. A missing table or row reads as off. */
export async function focusedInboxOrgEnabled(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?')
      .bind(ORG_SETTING_FOCUSED_INBOX).first<{ value: string }>();
    return row?.value === 'true';
  } catch {
    return false;
  }
}
