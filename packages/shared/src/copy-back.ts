// Copy standby mail back into Exchange Online: the parts both the web app
// (Admin page, dry run, status) and the email Worker (the scheduled copy) need.
// The design and its reasons are in docs/copy-back.md.
//
// Nothing here talks to Microsoft. The Worker holds the Entra credentials; the
// web app flips the switch, computes dry-run counts from D1, creates a job and
// reads progress counts. Status shown to managers is counts, mailbox addresses
// and short reason codes only: never subjects, senders or content.

/** org_settings keys. Absent = default. */
export const COPYBACK_SETTING_ENABLED = 'standby_copyback_enabled';
/** JSON of the last dry run: params, counts, time and manager. */
export const COPYBACK_SETTING_LAST_DRY_RUN = 'standby_copyback_last_dry_run';

/** cmail folders that may be copied. Drafts, Spam and Trash never are. */
export const COPYBACK_FOLDERS = ['archive', 'inbox', 'sent'] as const;
export type CopyBackFolder = (typeof COPYBACK_FOLDERS)[number];

/** Exchange well-known folder names (mailFolder resource) for each cmail folder. */
export const EXCHANGE_FOLDER: Readonly<Record<CopyBackFolder, string>> = {
  inbox: 'inbox',
  archive: 'archive',
  sent: 'sentitems',
};

/** A dry run older than this cannot be used to start a copy. */
export const DRY_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Longest window one job may cover. */
export const MAX_WINDOW_DAYS = 31;
/** Retries per item before it stays failed until a manager presses Retry failed. */
export const COPYBACK_MAX_ATTEMPTS = 6;
/**
 * Largest create request the Worker sends (JSON with base64 attachments).
 * Microsoft documents single-request attachments as "under 3 MB"; larger
 * files need an upload session on outlook.office.com, which this feature
 * deliberately never calls. Bigger messages are skipped as 'too_large'.
 */
export const COPYBACK_MAX_REQUEST_BYTES = 3 * 1024 * 1024;

export interface CopyBackSwitch {
  /** Off by default: the Worker does nothing and Start is refused. */
  enabled: boolean;
}

export async function loadCopyBackSwitch(db: D1Database): Promise<CopyBackSwitch> {
  const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?')
    .bind(COPYBACK_SETTING_ENABLED).first<{ value: string }>();
  return { enabled: row?.value === 'true' };
}

// ─── Parameters ──────────────────────────────────────────────────────────

export interface CopyBackParams {
  /** UTC 'YYYY-MM-DD HH:MM:SS', inclusive. */
  from: string;
  /** UTC 'YYYY-MM-DD HH:MM:SS', exclusive. */
  to: string;
  /** One Entra object id, or null for every linked mailbox. */
  target: string | null;
  /** Sorted, distinct, non-empty subset of COPYBACK_FOLDERS. */
  folders: CopyBackFolder[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DB_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** D1 datetime text ('YYYY-MM-DD HH:MM:SS', UTC) for a millisecond time. */
export function dbTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Parses a form time ('YYYY-MM-DDTHH:MM' or with seconds, read as UTC). */
export function parseFormTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/.test(trimmed)) return null;
  const ms = Date.parse(`${trimmed.replace(' ', 'T')}${trimmed.length === 16 ? ':00' : ''}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export function normalizeFolders(values: unknown[]): CopyBackFolder[] {
  const set = new Set(values.filter((value): value is CopyBackFolder =>
    typeof value === 'string' && (COPYBACK_FOLDERS as readonly string[]).includes(value)));
  return COPYBACK_FOLDERS.filter((folder) => set.has(folder));
}

export type ParamsResult = { ok: true; params: CopyBackParams } | { ok: false; error: string };

/**
 * Validates manager input. Every value is untrusted: times must parse, the
 * window must be forward, at most MAX_WINDOW_DAYS long and not in the future,
 * the target must be a GUID or empty, and folders a non-empty known subset.
 */
export function parseCopyBackParams(input: { from: unknown; to: unknown; target: unknown; folders: unknown[] }, now: number): ParamsResult {
  const from = parseFormTime(input.from);
  const to = parseFormTime(input.to);
  if (from === null || to === null) return { ok: false, error: 'Enter a start and end time (UTC).' };
  if (to <= from) return { ok: false, error: 'The end time must be after the start time.' };
  if (to - from > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) return { ok: false, error: `The window can be at most ${MAX_WINDOW_DAYS} days.` };
  // A fixed, past window: the same input always selects the same messages,
  // so Start can insist on a dry run of exactly these parameters.
  if (to > now) return { ok: false, error: 'The end time is in the future. Copy back after the outage has ended.' };
  const rawTarget = typeof input.target === 'string' ? input.target.trim().toLowerCase() : '';
  if (rawTarget && !GUID.test(rawTarget)) return { ok: false, error: 'Choose a mailbox from the list, or All.' };
  const folders = normalizeFolders(input.folders);
  if (!folders.length) return { ok: false, error: 'Choose at least one folder.' };
  return { ok: true, params: { from: dbTime(from), to: dbTime(to), target: rawTarget || null, folders } };
}

export function paramsKey(params: CopyBackParams): string {
  return `${params.from}|${params.to}|${params.target ?? '*'}|${params.folders.join(',')}`;
}

export function foldersFromColumn(value: string): CopyBackFolder[] {
  return normalizeFolders(value.split(','));
}

export function isValidParams(params: CopyBackParams): boolean {
  return DB_TIME.test(params.from) && DB_TIME.test(params.to) && params.to > params.from
    && (params.target === null || GUID.test(params.target)) && params.folders.length > 0
    && normalizeFolders(params.folders).join(',') === params.folders.join(',');
}

// ─── Selection ───────────────────────────────────────────────────────────

/**
 * The messages a job covers, joined to the Microsoft 365 link of their
 * mailbox (migration 0022): a person's personal mailbox, or a linked shared
 * mailbox. Only links still in scope count. Drafts are never selected.
 * Aliases: m = messages, mb = mailboxes, l = m365_sync_links.
 */
export function selectionSql(params: CopyBackParams): { from: string; where: string; binds: unknown[] } {
  const folderMarks = params.folders.map(() => '?').join(', ');
  const from = `messages m
    JOIN mailboxes mb ON mb.id = m.mailbox_id
    JOIN m365_sync_links l ON l.source_state = 'in_scope' AND (
      (l.kind = 'person' AND mb.type = 'personal' AND l.user_id = mb.owner_user_id)
      OR (l.kind = 'shared' AND l.mailbox_id = mb.id))`;
  const where = `m.received_at >= ? AND m.received_at < ?
    AND m.folder IN (${folderMarks}) AND m.folder <> 'drafts' AND m.draft_owner_id IS NULL
    ${params.target ? 'AND l.object_id = ?' : ''}`;
  const binds: unknown[] = [params.from, params.to, ...params.folders, ...(params.target ? [params.target] : [])];
  return { from, where, binds };
}

export interface CopyBackDryRunCounts {
  /** Messages in the window and folders whose mailbox is linked. */
  selected: number;
  /** Distinct target mailboxes among them. */
  mailboxes: number;
  /** Not copied before: what Start would try. */
  toCopy: number;
  /** Of toCopy, raw size suggests over the request cap (checked exactly when copying). */
  likelyTooLarge: number;
  alreadyCopied: number;
  previouslySkipped: number;
  previouslyFailed: number;
  pending: number;
  /** Messages in the window and folders whose mailbox has no Microsoft 365 link (never copied). */
  unlinked: number;
}

/** Counts only. Reads D1, writes nothing, never calls Microsoft. */
export async function copyBackDryRun(db: D1Database, params: CopyBackParams): Promise<CopyBackDryRunCounts> {
  const sel = selectionSql(params);
  // Base64 grows content by a third; the raw MIME size is a fair first guess.
  const largeRaw = Math.floor(COPYBACK_MAX_REQUEST_BYTES * 3 / 4);
  const row = await db.prepare(
    `SELECT COUNT(*) AS selected,
            COUNT(DISTINCT l.object_id) AS mailboxes,
            SUM(CASE WHEN i.state IS NULL THEN 1 ELSE 0 END) AS to_copy,
            SUM(CASE WHEN i.state IS NULL AND m.size_bytes > ? THEN 1 ELSE 0 END) AS likely_too_large,
            SUM(CASE WHEN i.state = 'copied' THEN 1 ELSE 0 END) AS already_copied,
            SUM(CASE WHEN i.state = 'skipped' THEN 1 ELSE 0 END) AS previously_skipped,
            SUM(CASE WHEN i.state = 'failed' THEN 1 ELSE 0 END) AS previously_failed,
            SUM(CASE WHEN i.state = 'pending' THEN 1 ELSE 0 END) AS pending
     FROM ${sel.from}
     LEFT JOIN standby_copyback_items i ON i.message_id = m.id AND i.target_object_id = l.object_id
     WHERE ${sel.where}`,
  ).bind(largeRaw, ...sel.binds).first<Record<string, number | null>>();
  let unlinked = 0;
  if (!params.target) {
    const folderMarks = params.folders.map(() => '?').join(', ');
    const other = await db.prepare(
      `SELECT COUNT(*) AS n FROM messages m
       JOIN mailboxes mb ON mb.id = m.mailbox_id
       WHERE m.received_at >= ? AND m.received_at < ? AND m.folder IN (${folderMarks}) AND m.draft_owner_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM m365_sync_links l WHERE l.source_state = 'in_scope' AND (
           (l.kind = 'person' AND mb.type = 'personal' AND l.user_id = mb.owner_user_id)
           OR (l.kind = 'shared' AND l.mailbox_id = mb.id)))`,
    ).bind(params.from, params.to, ...params.folders).first<{ n: number }>();
    unlinked = other?.n ?? 0;
  }
  const n = (key: string) => Number(row?.[key] ?? 0);
  return {
    selected: n('selected'),
    mailboxes: n('mailboxes'),
    toCopy: n('to_copy'),
    likelyTooLarge: n('likely_too_large'),
    alreadyCopied: n('already_copied'),
    previouslySkipped: n('previously_skipped'),
    previouslyFailed: n('previously_failed'),
    pending: n('pending'),
    unlinked,
  };
}

export interface CopyBackDryRunRecord {
  key: string;
  params: CopyBackParams;
  counts: CopyBackDryRunCounts;
  at: string;
}

export function parseDryRunRecord(raw: string | null | undefined): CopyBackDryRunRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CopyBackDryRunRecord;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.key !== 'string' || !parsed.params || !parsed.counts || typeof parsed.at !== 'string') return null;
    if (!isValidParams(parsed.params) || parsed.key !== paramsKey(parsed.params)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Worker configuration ────────────────────────────────────────────────

export interface CopyBackEnv {
  /** Shared with the Microsoft 365 sync: the directory (tenant) id. */
  M365_TENANT_ID?: string;
  /** A separate Entra app for copy-back, so the read-only sync secret can never write mail. */
  M365_COPYBACK_CLIENT_ID?: string;
  /** Wrangler secret. Never a var, never in a file. */
  M365_COPYBACK_CLIENT_SECRET?: string;
}

export interface CopyBackConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export type CopyBackConfigCheck = { configured: true; config: CopyBackConfig } | { configured: false; problems: string[] };

/** Problems name the setting only, never its value. */
export function copyBackConfig(env: CopyBackEnv): CopyBackConfigCheck {
  const problems: string[] = [];
  const tenantId = typeof env.M365_TENANT_ID === 'string' ? env.M365_TENANT_ID.trim().toLowerCase() : '';
  const clientId = typeof env.M365_COPYBACK_CLIENT_ID === 'string' ? env.M365_COPYBACK_CLIENT_ID.trim().toLowerCase() : '';
  const clientSecret = typeof env.M365_COPYBACK_CLIENT_SECRET === 'string' ? env.M365_COPYBACK_CLIENT_SECRET.trim() : '';
  if (!tenantId) problems.push('M365_TENANT_ID is not set');
  else if (!GUID.test(tenantId)) problems.push('M365_TENANT_ID must be the directory (tenant) ID, a GUID');
  if (!clientId) problems.push('M365_COPYBACK_CLIENT_ID is not set');
  else if (!GUID.test(clientId)) problems.push('M365_COPYBACK_CLIENT_ID must be the application (client) ID, a GUID');
  if (!clientSecret) problems.push('M365_COPYBACK_CLIENT_SECRET is not set (wrangler secret put)');
  if (problems.length) return { configured: false, problems };
  return { configured: true, config: { tenantId, clientId, clientSecret } };
}

// ─── Jobs and progress ───────────────────────────────────────────────────

export type CopyBackJobStatus = 'running' | 'done' | 'cancelled';

export interface CopyBackJobRow {
  id: string;
  status: CopyBackJobStatus;
  window_from: string;
  window_to: string;
  target_object_id: string | null;
  folders: string;
  plan_cursor: string;
  plan_done: number;
  lease_until: number;
  backoff_until: string | null;
  backoff_streak: number;
  last_tick_at: string | null;
  last_result: string;
  last_error_code: string;
  created_at: string;
  finished_at: string | null;
}

export function jobParams(job: Pick<CopyBackJobRow, 'window_from' | 'window_to' | 'target_object_id' | 'folders'>): CopyBackParams {
  return { from: job.window_from, to: job.window_to, target: job.target_object_id, folders: foldersFromColumn(job.folders) };
}

export interface CopyBackProgress {
  /** Messages in the job's selection. */
  selected: number;
  /** Not yet queued (planning still running). */
  unplanned: number;
  pending: number;
  copied: number;
  failed: number;
  /** Failed, with no retry left. */
  failedFinal: number;
  skipped: number;
}

export async function copyBackProgress(db: D1Database, params: CopyBackParams): Promise<CopyBackProgress> {
  const sel = selectionSql(params);
  const row = await db.prepare(
    `SELECT COUNT(*) AS selected,
            SUM(CASE WHEN i.state IS NULL THEN 1 ELSE 0 END) AS unplanned,
            SUM(CASE WHEN i.state = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN i.state = 'copied' THEN 1 ELSE 0 END) AS copied,
            SUM(CASE WHEN i.state = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN i.state = 'failed' AND i.next_attempt_at IS NULL THEN 1 ELSE 0 END) AS failed_final,
            SUM(CASE WHEN i.state = 'skipped' THEN 1 ELSE 0 END) AS skipped
     FROM ${sel.from}
     LEFT JOIN standby_copyback_items i ON i.message_id = m.id AND i.target_object_id = l.object_id
     WHERE ${sel.where}`,
  ).bind(...sel.binds).first<Record<string, number | null>>();
  const n = (key: string) => Number(row?.[key] ?? 0);
  return { selected: n('selected'), unplanned: n('unplanned'), pending: n('pending'), copied: n('copied'), failed: n('failed'), failedFinal: n('failed_final'), skipped: n('skipped') };
}

export interface CopyBackProblemRow {
  /** The target mailbox address in cmail (not mail content). */
  mailbox: string;
  state: 'failed' | 'skipped';
  reason: string;
  count: number;
}

/** Failures and skips grouped by mailbox and reason code: counts only. */
export async function copyBackProblems(db: D1Database, params: CopyBackParams, limit = 50): Promise<CopyBackProblemRow[]> {
  const sel = selectionSql(params);
  const { results } = await db.prepare(
    `SELECT mb.address AS mailbox, i.state AS state, i.reason AS reason, COUNT(*) AS count
     FROM ${sel.from}
     JOIN standby_copyback_items i ON i.message_id = m.id AND i.target_object_id = l.object_id
     WHERE ${sel.where} AND i.state IN ('failed', 'skipped')
     GROUP BY mb.address, i.state, i.reason
     ORDER BY count DESC, mb.address
     LIMIT ?`,
  ).bind(...sel.binds, Math.max(1, Math.min(200, limit))).all<CopyBackProblemRow>();
  return (results ?? []).map((row) => ({ mailbox: String(row.mailbox), state: row.state, reason: String(row.reason).slice(0, 64), count: Number(row.count) }));
}
