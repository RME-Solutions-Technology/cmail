// Exchange mirror: file the original message of each Exchange Online journal
// report into every recipient's cmail mailbox (docs/exchange-mirror.md).
//
// Called by the inbound handler only for mail to the exact configured
// journal address. With the manager switch off it returns false at once and
// the inbound handler treats the address like any unknown one.
//
// What a mirrored copy never does: it raises no new-mail notification (except
// cmail's own colleague mail coming back through Exchange: see
// recordedSendRecipients), runs no inbox rule, records no contact or calendar change, and nothing here can
// send mail (no reply, forward, bounce or read receipt). The only SMTP answer
// is Cloudflare's own reject of a report that fails the checks in verify.ts.
import PostalMime from 'postal-mime';
import {
  aliasImportState,
  emptyMirrorCounts,
  exchangeMirrorConfig,
  loadExchangeMirrorSwitch,
  mirrorDay,
  type ExchangeMirrorConfig,
  type ExchangeMirrorCounts,
  type ExchangeMirrorEnv,
} from '@cmail/shared/exchange-mirror';
import { decideInboundPlacement } from '@cmail/shared/inbound-risk';
import { orgDomains } from '@cmail/shared/org-domains';
import { decideFocusAtDelivery, focusUpdateStatement, focusedInboxOrgEnabled } from '@cmail/shared/focused-inbox';
import { parseMessageImportance } from '@cmail/shared/message-importance';
import {
  normalizeParticipants,
  serializeParticipants,
  type MessageParticipant,
} from '@cmail/shared/message-participants';
import { mailboxStorageQuotaBytes } from '@cmail/shared/mailbox-storage';
import { releaseInboundReservation, type InboundGuardEnv } from '../inbound-guard';
import { attachedOriginal, envelopeText, parseJournalEnvelope, type JournalEnvelope } from './report';
import { headerBlockWellFormed, headerValues, verifyJournalReport } from './verify';
import { MAX_DIAGNOSTIC, journalDiagnostic } from './diagnostic';

/** SMTP text for a refused report. Deliberately says nothing about why. */
export const JOURNAL_REJECT_RESPONSE = 'cmail: journal report refused';
/** Cloudflare Email Routing's inbound ceiling. */
const HARD_MAX_REPORT_BYTES = 25 * 1024 * 1024;
const DEFAULT_SUBREQUEST_BUDGET = 8_000;
const MAX_SUBREQUEST_BUDGET = 1_000_000;
/** Room for the report envelope around the original (5,000 recipient lines fit well inside). */
const ENVELOPE_ALLOWANCE_BYTES = 1024 * 1024;
/** Audit rows per UTC day for rejected reports and for skipped copies (each). */
const AUDIT_PER_DAY = 50;
/** Mail trace rows per UTC day for refused reports. */
const REJECT_TRACE_PER_DAY = 200;
/** How long a pending storage reservation lives, as on the normal path. */
const PENDING_STORAGE_SECONDS = 15 * 60;
const KEEP_DAYS = 90;
/** Copies stored at the same time. */
const PARALLEL = 6;
const IN_CHUNK = 90;
const ENCODER = new TextEncoder();
/** CR, LF, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR: anything a reader may treat as a new line. */
const UNSAFE_SUBJECT = new RegExp('[\\r\\n\\u0085\\u2028\\u2029]');

type Header = { key: string; originalKey?: string; value: string };
type ParsedMailbox = { address?: string; name?: string; group?: ReadonlyArray<{ address?: string; name?: string }> };
type ParsedAttachment = {
  filename?: string | null;
  mimeType?: string;
  contentId?: string;
  disposition?: string | null;
  related?: boolean;
  content: ArrayBuffer | Uint8Array | string;
};

/** The inbound handler's own helpers, passed in so both paths treat content the same way. */
export interface InboundTools {
  getInboundLimit(env: object): number;
  getAttachmentLimit(env: object): number;
  getDecodedBodyLimit(env: object): number;
  prepareInboundBody(html: string | undefined, text: string | undefined, maxBytes: number): { ok: true; html: string } | { ok: false; reason: string };
  flattenParsedParticipants(values: ReadonlyArray<ParsedMailbox> | undefined): MessageParticipant[];
  inboundFromParticipant(value: Pick<ParsedMailbox, 'address' | 'name'> | undefined, envelopeFrom: string, rawFromHeader?: string): MessageParticipant;
  normalizeMessageIdHeader(value: unknown): string | null;
  normalizeReferencesHeader(value: unknown): string | null;
  extractInboundSnippet(text: string | undefined, sanitizedHtml?: string, maxLen?: number): string;
  lookupSenderRule(db: D1Database, headerFrom: string): Promise<'allow' | 'block' | null>;
  messageBodyR2Key(namespace: string, objectId: string): string;
  attachmentR2Key(namespace: string, objectId: string): string;
  stableInboundId(mailboxId: string, messageIdHeader: string): Promise<string>;
  sanitizeFilename(value: unknown): string;
  sanitizeContentType(value: unknown): string;
  normalizeContentId(value: unknown): string | null;
  extractExtension(filename: string): string;
  blockedExtensions: ReadonlySet<string>;
  cleanHeaderValue(value: unknown, maxChars: number): string;
  deleteR2Objects(storage: R2Bucket, keys: string[]): Promise<void>;
  logTrace(db: D1Database, trace: {
    message_id_header?: string | null;
    direction: 'inbound';
    envelope_from?: string | null;
    envelope_to?: string | null;
    header_from?: string | null;
    subject?: string | null;
    size_bytes?: number | null;
    status: 'delivered' | 'rejected';
    status_detail?: string | null;
  }): Promise<void>;
  maxTotalAttachmentBytes: number;
  maxSubjectChars: number;
}

export interface JournalEnv extends InboundGuardEnv, ExchangeMirrorEnv {
  STORAGE: R2Bucket;
  MAX_INBOUND_BYTES?: string | number;
  MAX_ATTACHMENTS_PER_MESSAGE?: string | number;
  MAX_INBOUND_DECODED_BODY_BYTES?: string | number;
  /** Subrequests one report may use for filing. Default 8000 (Workers Paid allows 10,000 unless raised). */
  M365_JOURNAL_SUBREQUEST_BUDGET?: string | number;
}

export interface JournalDeps {
  now?: () => number;
  /**
   * New-mail notification for a filed Inbox copy of mail this instance sent
   * (see recordedSendRecipients). Absent: no notification, as for every other
   * mirrored copy.
   */
  notify?: (mailboxId: string, messageId: string) => void;
}

type Rejected = { kind: 'rejected'; reason: string; diagnostic?: string };
interface Processed {
  kind: 'processed';
  counts: ExchangeMirrorCounts;
  /** First reason a copy was not filed, or ''. */
  skipReason: string;
  /** A problem worth showing that filed nothing less (e.g. 'aliases_stale'), or ''. */
  notice: string;
  /** A copy failed for a reason a later redelivery may fix. */
  incomplete: boolean;
  messageIdHeader: string | null;
  headerFrom: string;
  subject: string;
  size: number;
}

interface Target {
  mailboxId: string;
  address: string;
  role: 'inbound' | 'sent';
}

function budget(env: JournalEnv): number {
  const value = Number(env.M365_JOURNAL_SUBREQUEST_BUDGET);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SUBREQUEST_BUDGET;
  return Math.min(MAX_SUBREQUEST_BUDGET, Math.max(100, Math.floor(value)));
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).slice(0, 253) : '';
}

function firstHeader(headers: readonly Header[] | undefined, name: string): string | undefined {
  return headers?.find((header) => header.key.toLowerCase() === name)?.value;
}

async function sentCopyId(mailboxId: string, messageIdHeader: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ENCODER.encode(`exchange-mirror-sent\u0000${mailboxId}\u0000${messageIdHeader}`));
  return `mirror-sent-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/**
 * Active mailbox per address: primary addresses first, then imported aliases,
 * the latter only when `useAliases` (the import is on and fresh).
 */
async function resolveMailboxes(db: D1Database, addresses: readonly string[], useAliases: boolean): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const slice of chunks(addresses, IN_CHUNK)) {
    const marks = slice.map(() => '?').join(', ');
    const { results } = await db.prepare(
      `SELECT address, id FROM mailboxes WHERE status = 'active' AND address IN (${marks})`,
    ).bind(...slice).all<{ address: string; id: string }>();
    for (const row of results ?? []) found.set(row.address, row.id);
    const missing = slice.filter((address) => !found.has(address));
    if (!missing.length || !useAliases) continue;
    const aliasMarks = missing.map(() => '?').join(', ');
    const aliases = await db.prepare(
      `SELECT a.address AS address, m.id AS id FROM mailbox_aliases a
       JOIN mailboxes m ON m.id = a.mailbox_id
       WHERE m.status = 'active' AND a.address IN (${aliasMarks})`,
    ).bind(...missing).all<{ address: string; id: string }>();
    for (const row of aliases.results ?? []) found.set(row.address, row.id);
  }
  return found;
}

type MirrorReservation =
  | { status: 'accepted'; reservationId: string | null }
  | { status: 'duplicate' | 'quota' | 'unavailable'; reservationId: null };

/**
 * Reserves storage for one mirrored copy as reservation_type 'storage'. The
 * hourly inbound guard (migration 0001 trg_mailbox_reservations_guard) only
 * counts 'inbound' rows, so mirrored copies never use up a mailbox's normal
 * inbound allowance, while the storage quota check (which counts pending
 * reservations of every type) still applies. The row is completed by the
 * message insert (trg_message_reservation_complete, keyed on the message id)
 * like any other. With no quota configured nothing is reserved.
 */
export async function reserveMirrorStorage(
  db: D1Database,
  input: { mailboxId: string; deliveryKey: string; messageBytes: number; quotaBytes: number },
): Promise<MirrorReservation> {
  if (input.quotaBytes <= 0) return { status: 'accepted', reservationId: null };
  const reservationId = crypto.randomUUID();
  try {
    await db.prepare(
      `INSERT INTO mailbox_reservations (
         id, delivery_key, reservation_type, mailbox_id, sender_hash, message_bytes,
         mailbox_message_limit, mailbox_byte_limit, sender_message_limit, storage_quota_bytes,
         storage_pending, pending_expires_at, created_epoch
       ) VALUES (?, ?, 'storage', ?, '', ?, 0, 0, 0, ?, 1, unixepoch() + ?, unixepoch())`,
    ).bind(reservationId, input.deliveryKey, input.mailboxId, input.messageBytes, input.quotaBytes, PENDING_STORAGE_SECONDS).run();
    return { status: 'accepted', reservationId };
  } catch (caught) {
    // The storage trigger aborts with 'mailbox reservation denied' when the
    // mailbox is full; a unique delivery key means the copy is in flight or done.
    const text = caught instanceof Error ? caught.message : '';
    if (/mailbox reservation denied/.test(text)) return { status: 'quota', reservationId: null };
    try {
      const row = await db.prepare('SELECT id FROM mailbox_reservations WHERE delivery_key = ? OR id = ? LIMIT 1')
        .bind(input.deliveryKey, reservationId).first<{ id: string }>();
      if (row?.id === reservationId) return { status: 'accepted', reservationId };
      if (row) return { status: 'duplicate', reservationId: null };
      // The error text is not a contract: work out whether it was the quota.
      const usage = await db.prepare(
        `SELECT COALESCE((SELECT TOTAL(CASE WHEN size_bytes > 0 THEN size_bytes ELSE 0 END) FROM messages WHERE mailbox_id = ?), 0)
              + COALESCE((SELECT TOTAL(message_bytes) FROM mailbox_reservations
                          WHERE mailbox_id = ? AND storage_pending = 1 AND pending_expires_at > unixepoch()), 0) AS used`,
      ).bind(input.mailboxId, input.mailboxId).first<{ used: number }>();
      if (usage && Number(usage.used) + input.messageBytes > input.quotaBytes) return { status: 'quota', reservationId: null };
    } catch {
      // Fall through: unknown state.
    }
    return { status: 'unavailable', reservationId: null };
  }
}

/** A recorded send proves a mirrored copy only within this window. */
export const OWN_SEND_WINDOW_DAYS = 2;

/**
 * The visible recipients (To and Cc) of a message this instance sent from
 * `mailboxId` in the last OWN_SEND_WINDOW_DAYS days, with this Message-ID
 * (as the provider reported it) and this subject, or null when there is
 * none. A mirrored copy for one of them is cmail's own colleague mail coming
 * back through Exchange ("Send colleague mail through Exchange"), so it is
 * treated as proven. Read from the sender's Sent copy (indexed by mailbox,
 * folder and time). A copy that fails the original's authentication
 * (`ownSendSpoofSignals`) is never proven.
 */
export async function recordedSendRecipients(
  db: D1Database,
  mailboxId: string,
  messageIdHeader: string,
  subject: string,
): Promise<Set<string> | null> {
  const row = await db.prepare(
    `SELECT to_addresses, cc_addresses, subject FROM messages
     WHERE mailbox_id = ? AND folder = 'sent' AND direction = 'outbound'
       AND julianday(received_at) >= julianday('now') - ?
       AND message_id_header = ?
     LIMIT 1`,
  ).bind(mailboxId, OWN_SEND_WINDOW_DAYS, messageIdHeader).first<{ to_addresses: string; cc_addresses: string; subject: string }>();
  if (!row || row.subject !== subject) return null;
  const out = new Set<string>();
  for (const column of [row.to_addresses, row.cc_addresses]) {
    try {
      const list = JSON.parse(column) as unknown;
      if (Array.isArray(list)) for (const item of list) if (typeof item === 'string') out.add(item.trim().toLowerCase());
    } catch {
      // A malformed column proves nothing for its recipients.
      continue;
    }
  }
  return out.size ? out : null;
}

/**
 * Exchange's own verdict on the original, when it recorded one: an explicit
 * DMARC or composite-authentication failure means the From was not proven,
 * whatever else matches.
 */
export function ownSendSpoofSignals(innerHeaders: readonly Header[] | undefined): boolean {
  return headerValues(innerHeaders, 'authentication-results')
    .some((value) => /\b(?:dmarc|compauth)\s*=\s*fail\b/i.test(value));
}
async function existingIds(db: D1Database, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const slice of chunks(ids, IN_CHUNK)) {
    const { results } = await db.prepare(
      `SELECT id FROM messages WHERE id IN (${slice.map(() => '?').join(', ')})`,
    ).bind(...slice).all<{ id: string }>();
    for (const row of results ?? []) found.add(row.id);
  }
  return found;
}

/**
 * A Sent copy is filed only for mail a cmail user really sent through
 * Exchange, and only when M365_JOURNAL_MIRROR_SENT is "true" (off by
 * default): the envelope sender is a cmail mailbox, Exchange knew the
 * addressing (To/Cc/Bcc lines, which it writes for authenticated
 * submissions; internet mail gets "Recipient:" lines), the sender is the
 * original's From or Sender, and the original carries
 * X-MS-Exchange-CrossTenant-AuthAs "Internal" and
 * X-MS-Exchange-CrossTenant-Id equal to M365_TENANT_ID, on every instance of
 * each and at least one of each. A missing header refuses the Sent copy (fail
 * closed). A forged From from the internet therefore never lands in anyone's
 * Sent folder.
 */
export function sentCopyAllowed(input: {
  config: Pick<ExchangeMirrorConfig, 'mirrorSent' | 'tenantId'>;
  envelope: JournalEnvelope;
  innerHeaders: readonly Header[] | undefined;
  innerFrom: string | null;
  innerSender: string | null;
  /** headerBlockWellFormed() of the original: a dropped line could have hidden a header. */
  innerHeaderBlockOk: boolean;
}): boolean {
  const { config, envelope } = input;
  if (!config.mirrorSent || !config.tenantId || !envelope.sender || !envelope.addressingKnown) return false;
  if (!input.innerHeaderBlockOk) return false;
  if (envelope.sender !== input.innerFrom && envelope.sender !== input.innerSender) return false;
  const authAs = headerValues(input.innerHeaders, 'x-ms-exchange-crosstenant-authas').map((value) => value.trim().toLowerCase());
  if (!authAs.length || authAs.some((value) => value !== 'internal')) return false;
  const tenants = headerValues(input.innerHeaders, 'x-ms-exchange-crosstenant-id').map((value) => value.trim().toLowerCase());
  if (!tenants.length || tenants.some((value) => value !== config.tenantId)) return false;
  return true;
}

/**
 * For Focused Inbox: the original was submitted by an authenticated user of
 * this tenant (X-MS-Exchange-CrossTenant-AuthAs "Internal" and this tenant's
 * id on every instance, at least one of each, and a well-formed header
 * block), the same proof sentCopyAllowed uses. Anything else, including all
 * internet mail, is treated as unauthenticated.
 */
export function mirroredSenderAuthenticated(input: {
  tenantId: string | null | undefined;
  innerHeaders: readonly Header[] | undefined;
  innerHeaderBlockOk: boolean;
}): boolean {
  if (!input.tenantId || !input.innerHeaderBlockOk) return false;
  const authAs = headerValues(input.innerHeaders, 'x-ms-exchange-crosstenant-authas').map((value) => value.trim().toLowerCase());
  if (!authAs.length || authAs.some((value) => value !== 'internal')) return false;
  const tenants = headerValues(input.innerHeaders, 'x-ms-exchange-crosstenant-id').map((value) => value.trim().toLowerCase());
  return tenants.length > 0 && tenants.every((value) => value === input.tenantId);
}

async function processReport(
  message: ForwardableEmailMessage,
  env: JournalEnv,
  tools: InboundTools,
  now: number,
  notify?: JournalDeps['notify'],
): Promise<Rejected | Processed> {
  const check = exchangeMirrorConfig(env);
  if (!check.configured) return { kind: 'rejected', reason: 'not_configured' };
  const config = check.config;
  const inboundLimit = tools.getInboundLimit(env);
  // Size first, before anything is read or parsed: the original must fit the
  // inbound limit, and the report is the original plus a small envelope.
  const reportLimit = Math.min(HARD_MAX_REPORT_BYTES, inboundLimit + ENVELOPE_ALLOWANCE_BYTES);
  if (!Number.isSafeInteger(message.rawSize) || message.rawSize < 0 || message.rawSize > reportLimit) {
    return { kind: 'rejected', reason: 'too_large' };
  }

  let outer;
  try {
    const raw = await new Response(message.raw).arrayBuffer();
    // The original must stay one message/rfc822 attachment, not be inlined.
    outer = await new PostalMime({ forceRfc822Attachments: true }).parse(raw);
  } catch {
    return { kind: 'rejected', reason: 'unparseable' };
  }

  // From here on a refusal carries the safe header diagnostic (diagnostic.ts).
  const parsedOuter = outer;
  const original = attachedOriginal(outer.attachments as ParsedAttachment[] | undefined);
  const reject = (reason: string): Rejected => ({
    kind: 'rejected',
    reason,
    diagnostic: journalDiagnostic(parsedOuter.headers, original.ok ? original.raw : null),
  });

  // Only the outer report's own headers and the SMTP envelope are read here.
  const verdict = verifyJournalReport(outer.headers, config, message.from || null);
  if (!verdict.ok) return reject(verdict.reason);
  if (!original.ok) return reject(original.reason);

  const counts = emptyMirrorCounts();
  const skipAll = (reason: string, size: number): Processed => ({
    kind: 'processed', counts: { ...counts, skipped: 1 }, skipReason: reason, notice: '', incomplete: false,
    messageIdHeader: null, headerFrom: '', subject: '', size,
  });
  if (original.raw.byteLength > inboundLimit) return skipAll('too_large', original.raw.byteLength);

  let inner;
  try {
    inner = await new PostalMime().parse(original.raw);
  } catch {
    return skipAll('original_unparseable', original.raw.byteLength);
  }
  // The envelope's Subject line is the original subject. A decoded line
  // break in it could fake envelope lines, so such a report is refused.
  if (UNSAFE_SUBJECT.test(inner.subject ?? '')) return reject('unsafe_subject');

  const parsedEnvelope = parseJournalEnvelope(envelopeText(outer));
  if (!parsedEnvelope.ok) return reject(parsedEnvelope.reason);
  const envelope = parsedEnvelope.envelope;

  const size = original.raw.byteLength;
  // The envelope must describe this original: its Message-Id must be the
  // original's own Message-ID. A report whose original has none, or another
  // one, is refused (it could not be filed exactly once anyway).
  const innerMessageIds = headerValues(inner.headers as Header[], 'message-id');
  const messageIdHeader = innerMessageIds.length === 1 ? tools.normalizeMessageIdHeader(innerMessageIds[0]) : null;
  const envelopeMessageId = tools.normalizeMessageIdHeader(envelope.messageId ?? '');
  if (!messageIdHeader || !envelopeMessageId || messageIdHeader.toLowerCase() !== envelopeMessageId.toLowerCase()) {
    return reject('message_id_mismatch');
  }
  const rawFromHeader = firstHeader(inner.headers as Header[], 'from');
  const parsedFrom = tools.inboundFromParticipant(inner.from as ParsedMailbox | undefined, envelope.sender ?? '', rawFromHeader);
  const headerFrom = parsedFrom.address;
  const subject = tools.cleanHeaderValue(inner.subject, tools.maxSubjectChars) || '(no subject)';
  const describe = { messageIdHeader, headerFrom, subject, size };

  // The same content limits as the normal inbound path.
  const preparedBody = tools.prepareInboundBody(inner.html, inner.text, tools.getDecodedBodyLimit(env));
  if (!preparedBody.ok) return { ...skipAll('body_limit', size), ...describe };
  const attachments = (inner.attachments ?? []) as ParsedAttachment[];
  if (attachments.length > tools.getAttachmentLimit(env)) return { ...skipAll('attachment_count', size), ...describe };
  const prepared = attachments.map((attachment) => ({
    filename: tools.sanitizeFilename(attachment.filename),
    contentType: tools.sanitizeContentType(attachment.mimeType),
    contentId: tools.normalizeContentId(attachment.contentId),
    disposition: attachment.disposition === 'inline' || attachment.related ? 'inline' as const : 'attachment' as const,
    content: attachment.content,
    size: typeof attachment.content === 'string' ? ENCODER.encode(attachment.content).byteLength : attachment.content.byteLength,
  }));
  const totalBytes = prepared.reduce((total, attachment) => total + attachment.size, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > Math.min(tools.maxTotalAttachmentBytes, inboundLimit)) {
    return { ...skipAll('attachment_bytes', size), ...describe };
  }
  if (prepared.some((attachment) => tools.blockedExtensions.has(tools.extractExtension(attachment.filename)))) {
    return { ...skipAll('blocked_attachment', size), ...describe };
  }

  // Map recipients (and the sender, for a Sent copy) to active mailboxes by
  // primary address or imported alias. Unknown addresses are only counted.
  const lookups = [...new Set([...envelope.recipients.map((item) => item.address), ...(envelope.sender ? [envelope.sender] : []), ...(headerFrom ? [headerFrom] : [])])];
  const aliasState = await aliasImportState(env.DB, now).catch(() => 'stale' as const);
  const mailboxes = await resolveMailboxes(env.DB, lookups, aliasState === 'fresh');
  // Once the sync has read this tenant's domains successfully (docs/multi-domain.md),
  // only the organisation's domains are filed: a mailbox on a domain that is
  // not (or no longer) one of them is counted, not filed. Before that, or if
  // the list cannot be read, filing goes on by address exactly as before.
  const domains = await orgDomains(env, env.DB).then(
    (result) => (result.discovered ? new Set(result.domains) : null),
    () => {
      console.error('Exchange mirror: organisation domains could not be read; filing by address only');
      return null;
    },
  );
  const onOrgDomain = (address: string) => !domains || domains.has(domainOf(address));
  let offDomain = 0;
  const targets: Target[] = [];
  const seenInbound = new Set<string>();
  for (const recipient of envelope.recipients) {
    const mailboxId = mailboxes.get(recipient.address);
    if (!mailboxId) {
      counts.unmatched += 1;
      continue;
    }
    if (!onOrgDomain(recipient.address)) {
      counts.unmatched += 1;
      offDomain += 1;
      continue;
    }
    if (seenInbound.has(mailboxId)) continue;
    seenInbound.add(mailboxId);
    targets.push({ mailboxId, address: recipient.address, role: 'inbound' });
  }
  const innerSender = tools.inboundFromParticipant(inner.sender as ParsedMailbox | undefined, '', firstHeader(inner.headers as Header[], 'sender')).address || null;
  const senderMailbox = envelope.sender && onOrgDomain(envelope.sender) ? mailboxes.get(envelope.sender) : undefined;
  if (senderMailbox && sentCopyAllowed({
    config,
    envelope,
    innerHeaders: inner.headers as Header[],
    innerFrom: headerFrom || null,
    innerSender,
    innerHeaderBlockOk: headerBlockWellFormed(original.raw),
  })) {
    targets.push({ mailboxId: senderMailbox, address: envelope.sender as string, role: 'sent' });
  }

  // Shared, per-message facts.
  const toParticipants = tools.flattenParsedParticipants(inner.to as ParsedMailbox[] | undefined);
  const ccParticipants = tools.flattenParsedParticipants(inner.cc as ParsedMailbox[] | undefined);
  const replyToParticipants = tools.flattenParsedParticipants(inner.replyTo as ParsedMailbox[] | undefined);
  const bccParticipants = normalizeParticipants(envelope.recipients.filter((item) => item.field === 'bcc').map((item) => ({ address: item.address, name: '' })));
  const inReplyTo = tools.normalizeMessageIdHeader(firstHeader(inner.headers as Header[], 'in-reply-to'));
  const referencesHeader = tools.normalizeReferencesHeader(firstHeader(inner.headers as Header[], 'references'));
  const importance = parseMessageImportance(inner.headers as Header[]);
  const threadId = referencesHeader?.split(' ')[0] || inReplyTo || messageIdHeader;
  const snippet = tools.extractInboundSnippet(inner.text, preparedBody.html);
  const hasAttachments = prepared.some((attachment) => attachment.disposition === 'attachment') ? 1 : 0;
  const placement = decideInboundPlacement({ spamScore: null, threshold: null, senderRule: await tools.lookupSenderRule(env.DB, headerFrom) });
  // Focused Inbox (docs/focused-inbox.md): read the switch once per report;
  // when it is on, each Inbox copy costs one more lookup (counted below).
  const focusOn = placement.folder === 'inbox' && await focusedInboxOrgEnabled(env.DB);
  const innerHeaders = inner.headers as Header[];
  const innerSenderAuthenticated = focusOn && mirroredSenderAuthenticated({
    tenantId: config.tenantId,
    innerHeaders,
    innerHeaderBlockOk: headerBlockWellFormed(original.raw),
  });
  // Colleague mail this instance sent through Exchange: proven for the
  // recipients the send recorded (unread, notified, a colleague for Focused).
  const fromMailbox = headerFrom ? mailboxes.get(headerFrom) : undefined;
  const sentHere = fromMailbox && !ownSendSpoofSignals(innerHeaders)
    ? await recordedSendRecipients(env.DB, fromMailbox, messageIdHeader, subject).catch(() => {
      console.error('Exchange mirror: recorded sends could not be read; filing as a normal mirrored copy');
      return null;
    })
    : null;
  const sentHereFor = (target: Target) => target.role === 'inbound' && Boolean(sentHere?.has(target.address));

  // Ids and duplicates, then the subrequest budget.
  const ids = await Promise.all(targets.map((target) => target.role === 'inbound'
    ? tools.stableInboundId(target.mailboxId, messageIdHeader)
    : sentCopyId(target.mailboxId, messageIdHeader)));
  const already = ids.length ? await existingIds(env.DB, ids) : new Set<string>();
  const pending: Array<{ target: Target; id: string }> = [];
  targets.forEach((target, index) => {
    const id = ids[index] as string;
    if (already.has(id)) counts.duplicates += 1;
    else pending.push({ target, id });
  });
  const perCopy = 4 + prepared.length + (focusOn ? 1 : 0);
  const allowed = Math.max(0, Math.floor((budget(env) - 20 - Math.ceil(lookups.length / IN_CHUNK) * 2 - Math.ceil(ids.length / IN_CHUNK)) / perCopy));
  let skipReason = '';
  if (pending.length > allowed) {
    counts.skipped += pending.length - allowed;
    skipReason = 'budget';
    pending.length = allowed;
  }

  const quotaBytes = mailboxStorageQuotaBytes(env);
  let incomplete = false;

  async function fileOne(item: { target: Target; id: string }): Promise<'filed' | 'duplicate' | 'quota' | 'guard_unavailable' | 'store_failed'> {
    const { target, id } = item;
    const reservation = await reserveMirrorStorage(env.DB, { mailboxId: target.mailboxId, deliveryKey: id, messageBytes: size, quotaBytes });
    if (reservation.status === 'duplicate') return 'duplicate';
    if (reservation.status === 'quota') return 'quota';
    if (reservation.status !== 'accepted') return 'guard_unavailable';
    const namespace = crypto.randomUUID();
    const bodyKey = tools.messageBodyR2Key(namespace, crypto.randomUUID());
    const stored = prepared.map((attachment) => {
      const attachmentId = crypto.randomUUID();
      return { ...attachment, id: attachmentId, key: tools.attachmentR2Key(namespace, attachmentId) };
    });
    const keys = [bodyKey, ...stored.map((attachment) => attachment.key)];
    const release = async () => {
      try {
        await releaseInboundReservation(env.DB, reservation.reservationId);
      } catch {
        console.error('Failed to release an incomplete mirror reservation');
      }
    };
    try {
      await env.STORAGE.put(bodyKey, preparedBody.ok ? preparedBody.html : '');
      for (const attachment of stored) await env.STORAGE.put(attachment.key, attachment.content);
    } catch {
      await tools.deleteR2Objects(env.STORAGE, keys);
      await release();
      return 'store_failed';
    }

    const sent = target.role === 'sent';
    const ownSend = sentHereFor(target);
    // Only an Inbox copy is sorted; null stores nothing (switch off for the
    // mailbox, or the lookup failed) and the copy is filed as before.
    const focus = !sent && focusOn
      ? await decideFocusAtDelivery(env.DB, { mailboxId: target.mailboxId, sender: headerFrom, mailDomain: env.MAIL_DOMAIN, tenantId: env.M365_TENANT_ID, headers: innerHeaders, senderAuthenticated: innerSenderAuthenticated || ownSend })
      : null;
    const to = toParticipants.length ? toParticipants : [{ address: target.address, name: '' }];
    const insert = env.DB.prepare(
      `INSERT INTO messages (id, mailbox_id, message_id_header, direction, from_address, from_name, to_addresses, cc_addresses, reply_to_addresses, bcc_addresses, to_participants, cc_participants, reply_to_participants, bcc_participants, subject, snippet, body_r2_key, has_attachments, size_bytes, folder, is_read, is_starred, importance, in_reply_to, references_header, thread_id, spam_score, sender_first_contact, quarantine_reason, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, 0, ?, datetime('now'), datetime('now'))`,
    ).bind(
      id,
      target.mailboxId,
      messageIdHeader,
      sent ? 'outbound' : 'inbound',
      headerFrom,
      parsedFrom.name,
      JSON.stringify(to.map((entry) => entry.address)),
      JSON.stringify(ccParticipants.map((entry) => entry.address)),
      JSON.stringify(replyToParticipants.map((entry) => entry.address)),
      // Only the sender's own copy may know who was Bcc'd (as in migration 0015).
      JSON.stringify(sent ? bccParticipants.map((entry) => entry.address) : []),
      serializeParticipants(to),
      serializeParticipants(ccParticipants),
      serializeParticipants(replyToParticipants),
      serializeParticipants(sent ? bccParticipants : []),
      subject,
      snippet,
      bodyKey,
      hasAttachments,
      size,
      sent ? 'sent' : placement.folder,
      // Mirrored copies are filed as read; cmail's own colleague mail is new mail.
      ownSend && placement.folder === 'inbox' ? 0 : 1,
      importance,
      inReplyTo,
      referencesHeader,
      threadId,
      sent ? null : placement.reason,
    );
    const attachmentInserts = stored.map((attachment) => env.DB.prepare(
      `INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, disposition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(attachment.id, id, attachment.filename, attachment.contentType, attachment.size, attachment.key, attachment.contentId, attachment.disposition));
    try {
      await env.DB.batch([insert, ...(focus ? [focusUpdateStatement(env.DB, id, focus)] : []), ...attachmentInserts]);
      if (ownSend && placement.folder === 'inbox') notify?.(target.mailboxId, id);
      return 'filed';
    } catch {
      // A concurrent delivery of the same message (another report, or the
      // normal inbound path) may have won the unique id or index.
      let winner: { body_r2_key: string | null } | null = null;
      let checked = false;
      try {
        winner = await env.DB.prepare(
          `SELECT body_r2_key FROM messages
           WHERE id = ? OR (mailbox_id = ? AND message_id_header = ? AND direction = ?)
           LIMIT 1`,
        ).bind(id, target.mailboxId, messageIdHeader, sent ? 'outbound' : 'inbound').first<{ body_r2_key: string | null }>();
        checked = true;
      } catch {
        // Unknown commit state: keep the objects.
      }
      if (winner?.body_r2_key === bodyKey) return 'filed';
      if (checked) await tools.deleteR2Objects(env.STORAGE, keys);
      await release();
      return winner ? 'duplicate' : 'store_failed';
    }
  }

  for (const group of chunks(pending, PARALLEL)) {
    const results = await Promise.all(group.map((item) => fileOne(item).catch(() => 'store_failed' as const)));
    results.forEach((result, index) => {
      const role = group[index]?.target.role;
      if (result === 'filed') {
        if (role === 'sent') counts.sentFiled += 1;
        else counts.filed += 1;
      } else if (result === 'duplicate') {
        counts.duplicates += 1;
      } else {
        counts.skipped += 1;
        skipReason ||= result;
        if (result === 'store_failed' || result === 'guard_unavailable') incomplete = true;
      }
    });
  }
  // Unmatched recipients while the alias import is on but stale: say why.
  const notice = offDomain > 0 ? 'unmatched_domain' : aliasState === 'stale' && counts.unmatched > 0 ? 'aliases_stale' : '';
  return { kind: 'processed', counts, skipReason, notice, incomplete, messageIdHeader, headerFrom, subject, size };
}

async function audit(db: D1Database, eventType: string, detail: string): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
     VALUES (?, datetime('now'), NULL, 'system', ?, 'exchange-mirror', ?)`,
  ).bind(crypto.randomUUID(), eventType, detail.slice(0, 200 + MAX_DIAGNOSTIC)).run();
}

/** One row per UTC day; returns the day's running totals for the audit cap. */
async function recordDay(db: D1Database, now: number, counts: ExchangeMirrorCounts, problem: string): Promise<{ received: number; rejected: number; skipped: number } | null> {
  const filedAny = counts.filed + counts.sentFiled > 0;
  return db.prepare(
    `INSERT INTO exchange_mirror_days (day, received, filed, sent_filed, duplicates, unmatched, skipped, rejected, last_report_at, last_filed_at, last_problem, last_problem_at, updated_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(day) DO UPDATE SET
       received = received + 1,
       filed = filed + excluded.filed,
       sent_filed = sent_filed + excluded.sent_filed,
       duplicates = duplicates + excluded.duplicates,
       unmatched = unmatched + excluded.unmatched,
       skipped = skipped + excluded.skipped,
       rejected = rejected + excluded.rejected,
       last_report_at = excluded.last_report_at,
       last_filed_at = COALESCE(excluded.last_filed_at, last_filed_at),
       last_problem = CASE WHEN excluded.last_problem <> '' THEN excluded.last_problem ELSE last_problem END,
       last_problem_at = COALESCE(excluded.last_problem_at, last_problem_at),
       updated_at = datetime('now')
     RETURNING received, rejected, skipped`,
  ).bind(
    mirrorDay(now),
    counts.filed,
    counts.sentFiled,
    counts.duplicates,
    counts.unmatched,
    counts.skipped,
    counts.rejected,
    now,
    filedAny ? now : null,
    problem.slice(0, 64),
    problem ? now : null,
  ).first<{ received: number; rejected: number; skipped: number }>();
}

/**
 * Handles a message to the journal address. Returns false, having read
 * nothing but the switch, when the Exchange mirror is off; the caller then
 * continues exactly as for any other address. Returns true when it handled
 * the report (filed, skipped or refused).
 */
export async function handleJournalDelivery(
  message: ForwardableEmailMessage,
  env: JournalEnv,
  tools: InboundTools,
  deps: JournalDeps = {},
): Promise<boolean> {
  let enabled = false;
  try {
    enabled = await loadExchangeMirrorSwitch(env.DB);
  } catch {
    // Unreadable switch = off: the normal path then answers as for any address.
    console.error('Exchange mirror switch could not be read');
    enabled = false;
  }
  if (!enabled) return false;

  const now = (deps.now ?? Date.now)();
  const envelopeFrom = (message.from || '').trim().toLowerCase();
  const outcome = await processReport(message, env, tools, now, deps.notify);

  if (outcome.kind === 'rejected') {
    message.setReject(JOURNAL_REJECT_RESPONSE);
    const counts = { ...emptyMirrorCounts(), rejected: 1 };
    let rejectedToday = 0;
    try {
      const day = await recordDay(env.DB, now, counts, outcome.reason);
      rejectedToday = Number(day?.rejected ?? 0);
      if (day && Number(day.received) === 1) await env.DB.prepare('DELETE FROM exchange_mirror_days WHERE day < ?').bind(mirrorDay(now - KEEP_DAYS * 86_400_000)).run();
      if (!day || Number(day.rejected) <= AUDIT_PER_DAY) {
        // The envelope sender of a refused report is unverified: its domain only.
        // Only the envelope sender's domain, and the safe header diagnostic.
        await audit(env.DB, 'exchange_mirror.report_rejected', `Journal report refused: ${outcome.reason}; envelope sender domain ${domainOf(envelopeFrom) || 'none'}${outcome.diagnostic ? `; ${outcome.diagnostic}` : ''}`);
      }
    } catch {
      console.error('Exchange mirror status could not be recorded');
    }
    // Nothing from a refused report is trusted, so the trace keeps no subject
    // or From, and at most REJECT_TRACE_PER_DAY rows a day (the day row keeps
    // the full count), so refused mail cannot grow the trace without bound.
    if (rejectedToday <= REJECT_TRACE_PER_DAY) {
      await tools.logTrace(env.DB, {
        direction: 'inbound',
        envelope_from: envelopeFrom || null,
        status: 'rejected',
        status_detail: `Exchange mirror: journal report refused (${outcome.reason})`,
        size_bytes: Number.isSafeInteger(message.rawSize) ? message.rawSize : null,
      });
    }
    console.warn('Exchange mirror refused a journal report', { reason: outcome.reason });
    return true;
  }

  const { counts } = outcome;
  try {
    const day = await recordDay(env.DB, now, counts, outcome.skipReason || outcome.notice);
    if (day && Number(day.received) === 1) await env.DB.prepare('DELETE FROM exchange_mirror_days WHERE day < ?').bind(mirrorDay(now - KEEP_DAYS * 86_400_000)).run();
    if (counts.skipped > 0 && (!day || Number(day.skipped) - counts.skipped < AUDIT_PER_DAY)) {
      await audit(env.DB, 'exchange_mirror.copies_skipped', `Exchange mirror skipped ${counts.skipped} cop${counts.skipped === 1 ? 'y' : 'ies'}: ${outcome.skipReason || 'unknown'}`);
    }
  } catch {
    console.error('Exchange mirror status could not be recorded');
  }
  await tools.logTrace(env.DB, {
    message_id_header: outcome.messageIdHeader,
    direction: 'inbound',
    envelope_from: envelopeFrom || null,
    header_from: outcome.headerFrom || null,
    subject: outcome.subject || null,
    size_bytes: outcome.size,
    status: 'delivered',
    status_detail: `Exchange mirror: filed ${counts.filed}, sent ${counts.sentFiled}, duplicates ${counts.duplicates}, unmatched ${counts.unmatched}, skipped ${counts.skipped}${outcome.skipReason ? ` (${outcome.skipReason})` : ''}`,
  });
  if (outcome.incomplete) {
    // Some copies hit a storage error. Throwing lets Email Routing treat the
    // delivery as failed; a redelivered report files only what is missing.
    throw new Error('Exchange mirror filing incomplete');
  }
  return true;
}

/** Read-only: configuration by setting name for Admin. Never returns the full journal address. */
export function exchangeMirrorConfigDiagnostic(env: ExchangeMirrorEnv): Record<string, unknown> {
  const check = exchangeMirrorConfig(env);
  if (!check.configured) return { configured: false, problems: check.problems };
  const { config } = check;
  return {
    configured: true,
    maskedAddress: config.maskedAddress,
    senderDomains: config.senderDomains,
    requireAuth: config.requireAuth,
    mirrorSent: config.mirrorSent,
    tenantCheck: Boolean(config.tenantId),
  };
}
