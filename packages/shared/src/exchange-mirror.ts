// Exchange mirror (warm standby from Exchange Online journaling) and the
// Microsoft 365 alias import: the parts both the web app (Admin switches and
// status) and the email Worker (journal ingestion, alias import) need. The
// design, its limits and the Exchange setup are in docs/exchange-mirror.md.
//
// Both features are off by default. With the manager switch off, the journal
// address is treated like any unknown address: the Worker does not parse or
// file anything, and the normal inbound path is unchanged.

/** org_settings keys. Absent = off. */
export const EXCHANGE_MIRROR_SETTING_ENABLED = 'exchange_mirror_enabled';
export const M365_ALIAS_SYNC_SETTING_ENABLED = 'm365_alias_sync_enabled';

export async function loadExchangeMirrorSwitch(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?')
    .bind(EXCHANGE_MIRROR_SETTING_ENABLED).first<{ value: string }>();
  return row?.value === 'true';
}

export async function loadAliasSyncSwitch(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?')
    .bind(M365_ALIAS_SYNC_SETTING_ENABLED).first<{ value: string }>();
  return row?.value === 'true';
}

// ─── Configuration (email Worker vars) ───────────────────────────────────

export interface ExchangeMirrorEnv {
  /**
   * The one address Exchange sends journal reports to:
   * `journal-<token>@<domain>`, token 32 to 64 lower-case letters and digits.
   * Empty = the mirror is off whatever the switch says.
   */
  M365_JOURNAL_ADDRESS?: string;
  /**
   * Domains a journal report's From may authenticate as (DMARC) or be DKIM
   * signed by, comma separated. Default: MAIL_DOMAIN.
   */
  M365_JOURNAL_SENDER_DOMAINS?: string;
  /** "false" skips the SPF/DKIM/DMARC check (weaker; see docs). Default "true". */
  M365_JOURNAL_REQUIRE_AUTH?: string | boolean;
  /** "false" files recipients' copies only, never a Sent copy. Default "true". */
  M365_JOURNAL_MIRROR_SENT?: string | boolean;
  /** Shared with the Microsoft 365 sync. When set, tenant headers must match it. */
  M365_TENANT_ID?: string;
  MAIL_DOMAIN?: string;
  /** Trusted Authentication-Results identifier (mx.cloudflare.net). */
  INBOUND_AUTHSERV_ID?: string;
}

export interface ExchangeMirrorConfig {
  journalAddress: string;
  /** journal-abcd…@domain: safe to show in Admin and logs. */
  maskedAddress: string;
  senderDomains: string[];
  requireAuth: boolean;
  mirrorSent: boolean;
  tenantId: string | null;
  mailDomain: string;
  authservId: string;
}

export type ExchangeMirrorConfigCheck =
  | { configured: true; config: ExchangeMirrorConfig }
  | { configured: false; problems: string[] };

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOURNAL_LOCAL = /^journal-[a-z0-9]{32,64}$/;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : typeof value === 'boolean' ? String(value) : '';
}

/**
 * True only when `recipient` is exactly the configured journal address. A
 * plain string comparison with no I/O: with M365_JOURNAL_ADDRESS empty it is
 * always false, so the inbound path does nothing new.
 */
export function isJournalAddress(env: Pick<ExchangeMirrorEnv, 'M365_JOURNAL_ADDRESS'>, recipient: string): boolean {
  const configured = clean(env.M365_JOURNAL_ADDRESS);
  return configured.length > 0 && configured === recipient;
}

export function maskJournalAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return local.startsWith('journal-') && local.length > 12 ? `journal-${local.slice(8, 12)}…@${domain}` : `…@${domain}`;
}

/**
 * Reads the Worker configuration. Problems name the setting only, never its
 * value, so the result is safe to show a manager or write to a log.
 */
export function exchangeMirrorConfig(env: ExchangeMirrorEnv): ExchangeMirrorConfigCheck {
  const problems: string[] = [];
  const address = clean(env.M365_JOURNAL_ADDRESS);
  const mailDomain = clean(env.MAIL_DOMAIN);
  const authservId = clean(env.INBOUND_AUTHSERV_ID);
  const tenantId = clean(env.M365_TENANT_ID);
  const requireAuthRaw = clean(env.M365_JOURNAL_REQUIRE_AUTH);
  const mirrorSentRaw = clean(env.M365_JOURNAL_MIRROR_SENT);

  if (!address) {
    problems.push('M365_JOURNAL_ADDRESS is not set on the email Worker');
  } else {
    const at = address.lastIndexOf('@');
    const local = at > 0 ? address.slice(0, at) : '';
    const domain = at > 0 ? address.slice(at + 1) : '';
    if (!JOURNAL_LOCAL.test(local) || !DOMAIN.test(domain) || address.indexOf('@') !== at) {
      problems.push('M365_JOURNAL_ADDRESS must be journal-<token>@<domain> with a random token of 32 to 64 lower-case letters and digits');
    }
  }
  if (!mailDomain) problems.push('MAIL_DOMAIN is not set on the email Worker');
  else if (!DOMAIN.test(mailDomain)) problems.push('MAIL_DOMAIN is not a valid domain');
  if (tenantId && !GUID.test(tenantId)) problems.push('M365_TENANT_ID must be the directory (tenant) ID, a GUID');
  if (requireAuthRaw && requireAuthRaw !== 'true' && requireAuthRaw !== 'false') problems.push('M365_JOURNAL_REQUIRE_AUTH must be "true" or "false"');
  if (mirrorSentRaw && mirrorSentRaw !== 'true' && mirrorSentRaw !== 'false') problems.push('M365_JOURNAL_MIRROR_SENT must be "true" or "false"');
  const requireAuth = requireAuthRaw !== 'false';
  if (requireAuth && !authservId) {
    problems.push('INBOUND_AUTHSERV_ID is not set, so journal reports cannot be authenticated (set it to mx.cloudflare.net)');
  }
  const listed = clean(env.M365_JOURNAL_SENDER_DOMAINS).split(',').map((item) => item.trim()).filter(Boolean);
  if (listed.some((item) => !DOMAIN.test(item))) problems.push('M365_JOURNAL_SENDER_DOMAINS must be comma-separated domains');
  if (problems.length) return { configured: false, problems };

  return {
    configured: true,
    config: {
      journalAddress: address,
      maskedAddress: maskJournalAddress(address),
      senderDomains: [...new Set(listed.length ? listed : [mailDomain])],
      requireAuth,
      mirrorSent: mirrorSentRaw !== 'false',
      tenantId: tenantId || null,
      mailDomain,
      authservId,
    },
  };
}

// ─── Daily counts (exchange_mirror_days, migration 0027) ─────────────────

export const EXCHANGE_MIRROR_COUNT_KEYS = ['received', 'filed', 'sentFiled', 'duplicates', 'unmatched', 'skipped', 'rejected'] as const;
export type ExchangeMirrorCountKey = (typeof EXCHANGE_MIRROR_COUNT_KEYS)[number];
export type ExchangeMirrorCounts = Record<ExchangeMirrorCountKey, number>;

export function emptyMirrorCounts(): ExchangeMirrorCounts {
  return { received: 0, filed: 0, sentFiled: 0, duplicates: 0, unmatched: 0, skipped: 0, rejected: 0 };
}

export interface ExchangeMirrorDay extends ExchangeMirrorCounts {
  day: string;
  lastReportAt: number | null;
  lastFiledAt: number | null;
  lastProblem: string;
  lastProblemAt: number | null;
}

interface DayRow {
  day: string;
  received: number;
  filed: number;
  sent_filed: number;
  duplicates: number;
  unmatched: number;
  skipped: number;
  rejected: number;
  last_report_at: number | null;
  last_filed_at: number | null;
  last_problem: string;
  last_problem_at: number | null;
}

/** UTC day key, YYYY-MM-DD. */
export function mirrorDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Days from `sinceDay` (inclusive), newest first, at most 90. */
export async function loadExchangeMirrorDays(db: D1Database, sinceDay: string): Promise<ExchangeMirrorDay[]> {
  const { results } = await db.prepare(
    `SELECT day, received, filed, sent_filed, duplicates, unmatched, skipped, rejected,
            last_report_at, last_filed_at, last_problem, last_problem_at
     FROM exchange_mirror_days WHERE day >= ? ORDER BY day DESC LIMIT 90`,
  ).bind(sinceDay).all<DayRow>();
  return (results ?? []).map((row) => ({
    day: row.day,
    received: Number(row.received) || 0,
    filed: Number(row.filed) || 0,
    sentFiled: Number(row.sent_filed) || 0,
    duplicates: Number(row.duplicates) || 0,
    unmatched: Number(row.unmatched) || 0,
    skipped: Number(row.skipped) || 0,
    rejected: Number(row.rejected) || 0,
    lastReportAt: row.last_report_at == null ? null : Number(row.last_report_at),
    lastFiledAt: row.last_filed_at == null ? null : Number(row.last_filed_at),
    lastProblem: row.last_problem || '',
    lastProblemAt: row.last_problem_at == null ? null : Number(row.last_problem_at),
  }));
}

/** Plain-language text for each machine reason a report is rejected or a copy skipped. */
export const EXCHANGE_MIRROR_REASON_TEXT: Readonly<Record<string, string>> = {
  not_configured: 'The email Worker is missing Exchange mirror settings.',
  too_large: 'The message is larger than the inbound size limit (MAX_INBOUND_BYTES).',
  unparseable: 'The journal report could not be read as an email.',
  not_journal_report: 'The message has no X-MS-Journal-Report header, so it is not a journal report.',
  wrong_tenant: 'The tenant header does not match M365_TENANT_ID.',
  auth_missing: 'No trusted SPF/DKIM/DMARC result was found (check INBOUND_AUTHSERV_ID).',
  auth_failed: 'The report did not authenticate as one of M365_JOURNAL_SENDER_DOMAINS.',
  no_original: 'The report has no attached original message (message/rfc822).',
  tnef: 'The original is attached as TNEF (winmail.dat): turn TNEF off for the journal domain in Exchange.',
  ambiguous_original: 'The report has more than one attached message.',
  unsafe_subject: 'The original subject contains a line break, so the report envelope cannot be trusted.',
  unsafe_envelope: 'The report envelope has lines in an order Exchange does not write (possible injected text).',
  no_recipients: 'The report envelope lists no recipients.',
  too_many_recipients: 'The report envelope lists more recipients than cmail files at once.',
  original_unparseable: 'The attached original message could not be read.',
  no_message_id: 'The original message has no Message-ID, so it cannot be filed exactly once.',
  body_limit: 'The message body is over the processing limit.',
  attachment_count: 'The message has more attachments than the inbound limit.',
  attachment_bytes: 'The attachments are larger than the inbound limit.',
  blocked_attachment: 'The message has an attachment type cmail never accepts.',
  quota: 'A mailbox is full (storage quota).',
  guard_unavailable: 'The mailbox storage check was unavailable.',
  budget: 'The message had more recipients than one report can file within the Worker limits.',
  store_failed: 'Storing a copy failed; it is filed if Exchange delivers the report again.',
};

// ─── Alias import state (m365_alias_sync_state, migration 0027) ──────────

export interface AliasSyncCounts {
  /** Aliases held after the run. */
  total: number;
  added: number;
  moved: number;
  removed: number;
  /** Addresses refused: another mailbox's own address, or claimed by two mailboxes. */
  conflicts: number;
  /** Microsoft 365 objects with addresses that have no linked cmail mailbox. */
  unlinked: number;
}

export interface AliasSyncState {
  lastRunAt: number | null;
  lastResult: 'ok' | 'dry_run' | 'held' | 'error' | 'not_configured' | 'sync_off' | null;
  lastError: string | null;
  counts: AliasSyncCounts | null;
}

export function emptyAliasCounts(): AliasSyncCounts {
  return { total: 0, added: 0, moved: 0, removed: 0, conflicts: 0, unlinked: 0 };
}

export function parseAliasSyncState(raw: string | null | undefined, lastRunAt: number | null): AliasSyncState {
  const base: AliasSyncState = { lastRunAt, lastResult: null, lastError: null, counts: null };
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Partial<AliasSyncState>;
    if (!parsed || typeof parsed !== 'object') return base;
    return {
      lastRunAt,
      lastResult: parsed.lastResult ?? null,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError.slice(0, 64) : null,
      counts: parsed.counts && typeof parsed.counts === 'object' ? { ...emptyAliasCounts(), ...parsed.counts } : null,
    };
  } catch {
    return base;
  }
}

export async function loadAliasSyncState(db: D1Database): Promise<AliasSyncState> {
  const row = await db.prepare('SELECT state, last_run_at FROM m365_alias_sync_state WHERE id = 1')
    .first<{ state: string; last_run_at: number }>();
  return parseAliasSyncState(row?.state, row && Number(row.last_run_at) > 0 ? Number(row.last_run_at) : null);
}
