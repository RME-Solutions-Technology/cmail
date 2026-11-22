// Exchange mirror, Graph source: the scheduled pull
// (docs/exchange-mirror.md#graph-source-recommended).
//
// Why it exists: journal reports carry the ORIGINAL sender in From, and
// Cloudflare Email Routing applies the sender's DMARC policy, so reports for
// mail from any p=reject sender are refused before Stanchion sees them. This
// source reads each mailbox from Microsoft 365 instead, so no SMTP hop and
// no sender DMARC is involved.
//
// Every tick:
// 1. Reads the Admin switch. Off = return at once: no Graph call, no write.
// 2. Checks the Worker settings (the Microsoft 365 sync's app), then takes a
//    short lease on graph_mirror_state so two invocations never pull
//    together, and skips if the last run was under MIN_INTERVAL_MS ago
//    (several crons may fire in the same minute). "Run now" skips that wait.
// 3. (After the live pull, below.) The finite "Import older mail" work, only
//    while one is active the live pull is held to 70% of the run, see import.ts.
// 4. Lists the mailboxes the Microsoft 365 sync linked (people and shared,
//    in scope, active, on an organisation domain), and works them round
//    robin from the saved cursor, so every mailbox is reached over a few
//    ticks however large the tenant.
// 5. Per mailbox and folder (Inbox, Sent Items, Archive): one Graph delta
//    query. A new folder starts from now minus the look-back (default 24
//    hours) with a cap on how many it files; a 410 or expired token starts
//    again from the newest message already seen (the watermark), never from
//    the beginning. Messages already in the mailbox (by Message-ID) are
//    counted as duplicates without downloading anything; the rest are read
//    as MIME and filed through the Exchange mirror's own filing code
//    (fileMirrorCopies), as Inbox, Archive or Sent copies.
// 6. Stops starting new work at the time, Graph-request or subrequest
//    budget and saves its place after every page, so the next tick resumes.
//
// Error classes:
// - whole run: credentials rejected (401 or token refused), the token
//   service throttled or unreachable, three network errors;
// - one mailbox: 429/503/504 for it (waits for Retry-After), 403 (outside
//   the RBAC scope, or no permission: retried hourly);
// - one folder: 404 (retried daily), unreadable answers (15 minutes).
//
// Logs and status carry counts and short codes only: never addresses,
// subjects, Graph ids or tokens.
import PostalMime, { type Email } from 'postal-mime';
import { emptyMirrorCounts, mirrorDay, type ExchangeMirrorCounts } from '@cmail/shared/exchange-mirror';
import {
  emptyGraphMirrorCounts,
  graphMirrorConfig,
  loadGraphMirrorSwitch,
  parseGraphMirrorStatus,
  type GraphMirrorConfig,
  type GraphMirrorCounts,
  type GraphMirrorEnv,
  type GraphMirrorFolder,
  type GraphMirrorStatus,
} from '@cmail/shared/graph-mirror';
import { GRAPH_IMPORT_LIVE_SHARE, GRAPH_IMPORT_MESSAGES_PER_RUN } from '@cmail/shared/graph-import';
import { orgDomains } from '@cmail/shared/org-domains';
import { GraphError } from '../m365-sync/graph';
import { fileMirrorCopies, prepareMirrorContent, sentCopyId, type InboundTools, type JournalEnv } from '../exchange-mirror/ingest';
import { headerValues } from '../exchange-mirror/verify';
import { GraphMirrorClient, initialDeltaUrl, type DeltaMessage } from './graph';
import { importHasWork, loadImportRecords, runImportPhase, type ImportRecords } from './import';

export const GRAPH_MIRROR_CRON = '*/5 * * * *';

const LEASE_MS = 4 * 60_000;
/** Several crons can fire in one minute; one run per this interval is enough. */
const MIN_INTERVAL_MS = 90_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A resync starts this much before the watermark (clock skew, late arrivals); duplicates are filed once anyway. */
const RESYNC_OVERLAP_MS = HOUR_MS;
const DEFAULTS = {
  /** No new page starts after this much wall time. */
  timeMs: 60_000,
  /** Graph requests (token, delta pages, MIME) per tick. */
  graph: 400,
  /** All subrequests per tick (Graph, D1, R2), far inside the 10,000 Workers Paid limit. */
  subrequests: 5_000,
  /** Delta pages per folder per tick, so one busy mailbox cannot starve the rest. */
  pagesPerFolder: 4,
  /** "Import older mail": messages one run imports, at most (GRAPH_IMPORT_MESSAGES_PER_RUN). */
  importMessages: GRAPH_IMPORT_MESSAGES_PER_RUN,
};
const MAX_NETWORK_ERRORS = 3;
const DENIED_RETRY_MS = HOUR_MS;
const NOT_FOUND_RETRY_MS = DAY_MS;
const BAD_RESPONSE_RETRY_MS = 15 * 60_000;
const DEFAULT_THROTTLE_SECONDS = 60;
/** Audit rows per UTC day for skipped copies (one row per tick at most). */
const AUDIT_SKIPS_PER_DAY = 50;
const IN_CHUNK = 90;

export interface GraphMirrorWorkerEnv extends GraphMirrorEnv, JournalEnv {
  DB: D1Database;
  STORAGE: R2Bucket;
}

export interface GraphMirrorDeps {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** "Run now" from Admin: ignore the minimum interval. */
  force?: boolean;
  /** Tests shrink the budgets to prove resume. */
  budgets?: Partial<typeof DEFAULTS>;
}

export type GraphMirrorTickResult =
  | { status: 'off' | 'not_installed' | 'busy' | 'too_soon' }
  | { status: 'not_configured'; problems: string[] }
  | { status: 'worked'; mailboxes: number; visited: number; counts: GraphMirrorCounts; complete: boolean; error: string }
  | { status: 'error'; code: string };

export interface MailboxRow {
  mailbox_id: string;
  address: string;
  object_id: string;
}

export interface FolderRow {
  mailbox_id: string;
  folder: GraphMirrorFolder;
  link: string | null;
  link_kind: 'none' | 'next' | 'delta';
  since_ms: number;
  round_cap: number;
  round_filed: number;
  watermark_ms: number;
  retry_after_ms: number;
}

/** Ends the whole run; the code goes to the status. */
export class RunStop extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Ends work on one mailbox for this tick. */
class MailboxStop extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : '';
}

/** Message-IDs (normalized) this mailbox already holds for the copy's direction. */
async function alreadyFiled(db: D1Database, mailboxId: string, sent: boolean, headers: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < headers.length; start += IN_CHUNK) {
    const slice = headers.slice(start, start + IN_CHUNK);
    const marks = slice.map(() => '?').join(', ');
    // Inbound: the unique (mailbox_id, message_id_header) index of migration
    // 0001. Sent: Stanchion's own sends and earlier Sent copies, by the
    // (mailbox_id, folder) index; and our Sent copy ids wherever it was moved.
    const sql = sent
      ? `SELECT message_id_header AS h FROM messages WHERE mailbox_id = ? AND folder = 'sent' AND message_id_header IN (${marks})`
      : `SELECT message_id_header AS h FROM messages WHERE mailbox_id = ? AND direction = 'inbound' AND message_id_header IS NOT NULL AND message_id_header IN (${marks})`;
    const { results } = await db.prepare(sql).bind(mailboxId, ...slice).all<{ h: string }>();
    for (const row of results ?? []) found.add(row.h);
    if (sent) {
      const ids = await Promise.all(slice.map((header) => sentCopyId(mailboxId, header)));
      const moved = await db.prepare(`SELECT message_id_header AS h FROM messages WHERE id IN (${ids.map(() => '?').join(', ')})`)
        .bind(...ids).all<{ h: string }>();
      for (const row of moved.results ?? []) found.add(row.h);
    }
  }
  return found;
}

async function linkedMailboxes(db: D1Database): Promise<MailboxRow[]> {
  // The same join the standby copy-back uses: a person's personal mailbox,
  // or a linked shared mailbox; links in scope, mailboxes active.
  const { results } = await db.prepare(
    `SELECT mb.id AS mailbox_id, mb.address AS address, l.object_id AS object_id
     FROM m365_sync_links l
     JOIN mailboxes mb ON (l.kind = 'person' AND mb.type = 'personal' AND l.user_id = mb.owner_user_id)
                       OR (l.kind = 'shared' AND l.mailbox_id = mb.id)
     WHERE l.source_state = 'in_scope' AND mb.status = 'active'
     ORDER BY mb.id`,
  ).all<MailboxRow>();
  return results ?? [];
}

async function saveFolder(db: D1Database, row: FolderRow, fields: Partial<Omit<FolderRow, 'mailbox_id' | 'folder'>> & { last_error?: string; last_ok_at?: number }): Promise<void> {
  Object.assign(row, fields);
  await db.prepare(
    `INSERT INTO graph_mirror_folders (mailbox_id, folder, link, link_kind, since_ms, round_cap, round_filed, watermark_ms, last_ok_at, last_error, retry_after_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(mailbox_id, folder) DO UPDATE SET
       link = excluded.link, link_kind = excluded.link_kind, since_ms = excluded.since_ms,
       round_cap = excluded.round_cap, round_filed = excluded.round_filed, watermark_ms = excluded.watermark_ms,
       last_ok_at = CASE WHEN excluded.last_ok_at > 0 THEN excluded.last_ok_at ELSE last_ok_at END,
       last_error = excluded.last_error, retry_after_ms = excluded.retry_after_ms, updated_at = datetime('now')`,
  ).bind(
    row.mailbox_id, row.folder, row.link, row.link_kind, row.since_ms, row.round_cap, row.round_filed, row.watermark_ms,
    fields.last_ok_at ?? 0, (fields.last_error ?? '').slice(0, 64), row.retry_after_ms,
  ).run();
}

function newRound(row: FolderRow, sinceMs: number, cap: number): void {
  row.link = null;
  row.link_kind = 'none';
  row.since_ms = Math.max(0, Math.floor(sinceMs));
  row.round_cap = cap;
  row.round_filed = 0;
}

async function releaseLease(db: D1Database, fields: { cursor?: string; status?: GraphMirrorStatus }): Promise<void> {
  await db.prepare(
    `UPDATE graph_mirror_state SET lease_until = 0,
       cursor = COALESCE(?, cursor), state = COALESCE(?, state), updated_at = datetime('now')
     WHERE id = 1`,
  ).bind(fields.cursor ?? null, fields.status ? JSON.stringify(fields.status) : null).run();
}

function addCounts(target: GraphMirrorCounts, from: Partial<GraphMirrorCounts>): void {
  for (const key of Object.keys(target) as Array<keyof GraphMirrorCounts>) target[key] += from[key] ?? 0;
}

export async function runGraphMirrorTick(env: GraphMirrorWorkerEnv, tools: InboundTools, deps: GraphMirrorDeps = {}): Promise<GraphMirrorTickResult> {
  const db = env.DB;
  let enabled = false;
  try {
    const value = await loadGraphMirrorSwitch(db);
    enabled = value.enabled;
  } catch {
    console.error('Graph mirror switch could not be read; treated as off');
  }
  if (!enabled) return { status: 'off' };

  const now = (deps.now ?? Date.now)();
  const check = graphMirrorConfig(env);

  // Lease. The table is missing until migration 0033 is applied.
  let leased: { cursor: string; state: string } | null;
  try {
    await db.prepare('INSERT OR IGNORE INTO graph_mirror_state (id) VALUES (1)').run();
    leased = await db.prepare(
      `UPDATE graph_mirror_state SET lease_until = ?, updated_at = datetime('now')
       WHERE id = 1 AND lease_until < ? RETURNING cursor, state`,
    ).bind(now + LEASE_MS, now).first<{ cursor: string; state: string }>();
  } catch {
    console.warn('Graph mirror: migration 0033 is not applied');
    return { status: 'not_installed' };
  }
  if (!leased) return { status: 'busy' };
  const status = parseGraphMirrorStatus(leased.state);

  if (!check.configured) {
    await releaseLease(db, { status: { ...status, lastRunAt: now, lastError: 'not_configured', lastErrorAt: now } });
    return { status: 'not_configured', problems: check.problems };
  }
  if (!deps.force && status.lastRunAt && now - status.lastRunAt < MIN_INTERVAL_MS) {
    await releaseLease(db, {});
    return { status: 'too_soon' };
  }
  const config = check.config;
  const budgets = { ...DEFAULTS, ...deps.budgets };
  const day = mirrorDay(now);
  if (status.day !== day) {
    status.day = day;
    status.today = emptyGraphMirrorCounts();
    status.lastSkipReason = '';
  }
  // Audit rows are bounded by copies skipped today (each row covers at least one).
  const skippedBefore = status.today.skipped;
  const runSkipReason = { value: '' };

  const run: GraphMirrorCounts = emptyGraphMirrorCounts();
  let cursor = leased.cursor;
  let runError = '';
  let visited = 0;
  let mailboxes: MailboxRow[] = [];
  let complete = false;
  try {
    const domains = await orgDomains(env, db).then(
      (result) => (result.discovered ? new Set(result.domains) : null),
      () => {
        console.error('Graph mirror: organisation domains could not be read; using linked mailboxes as they are');
        return null;
      },
    );
    mailboxes = (await linkedMailboxes(db)).filter((row) => !domains || domains.has(domainOf(row.address)));
    status.mailboxes = mailboxes.length;
    if (!mailboxes.length) {
      complete = true;
    } else {
      const client = new GraphMirrorClient({
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        fetcher: deps.fetcher,
        sleep: deps.sleep,
        now: deps.now,
      });
      // One cheap read: is a count or an import active? Then the live pull
      // leaves part of the run for it (live mail still goes first).
      const importRecords: ImportRecords = await loadImportRecords(db).catch(() => ({ request: null, estimate: null, job: null }));
      const importActive = importHasWork(importRecords);
      const liveBudgets = importActive
        ? {
          ...budgets,
          timeMs: Math.floor(budgets.timeMs * GRAPH_IMPORT_LIVE_SHARE),
          graph: Math.floor(budgets.graph * GRAPH_IMPORT_LIVE_SHARE),
          subrequests: Math.floor(budgets.subrequests * GRAPH_IMPORT_LIVE_SHARE),
        }
        : budgets;
      const puller: Puller = {
        env,
        tools,
        client,
        config,
        now,
        budgets: liveBudgets,
        started: Date.now(),
        run,
        status,
        runSkipReason,
        subrequests: 0,
      };
      const outcome = await pullMailboxes(puller, mailboxes, cursor);
      cursor = outcome.cursor;
      visited = outcome.visited;
      complete = outcome.complete;
      runError = outcome.error;
      // Live mail first: the finite import (count or old mail) gets what the
      // live pull left, and the share held back for it.
      puller.budgets = budgets;
      if (!runError && importActive) runError = await runImportPhase(puller, mailboxes, importRecords);
    }
  } catch (caught) {
    runError = caught instanceof RunStop ? caught.code
      : caught instanceof GraphError ? (caught.code === 'unauthorized' ? 'credentials_rejected' : caught.code)
        : 'storage';
    if (!(caught instanceof RunStop) && !(caught instanceof GraphError)) {
      console.error('Graph mirror run failed', { error: caught instanceof Error ? caught.name : 'UnknownError' });
    }
  }

  // Status: counts and codes only.
  addCounts(status.today, run);
  status.lastRunAt = now;
  if (run.filed + run.sentFiled > 0) status.lastFiledAt = now;
  if (runError) {
    status.lastError = runError;
    status.lastErrorAt = now;
  } else {
    status.lastOkAt = now;
    status.lastError = '';
  }
  try {
    const covered = new Set(mailboxes.map((row) => row.mailbox_id));
    const { results } = await db.prepare(
      `SELECT mailbox_id, MAX(CASE WHEN last_error = 'denied' THEN 1 ELSE 0 END) AS denied,
              MAX(CASE WHEN last_ok_at > 0 THEN 1 ELSE 0 END) AS ok
       FROM graph_mirror_folders GROUP BY mailbox_id`,
    ).all<{ mailbox_id: string; denied: number; ok: number }>();
    const tried = (results ?? []).filter((row) => covered.has(row.mailbox_id));
    status.denied = tried.filter((row) => Number(row.denied) === 1).length;
    // "Missing" only once every covered mailbox was tried and refused: one
    // refused mailbox on a first, partial run is just outside the scope.
    status.permissionMissing = tried.length > 0 && tried.length === covered.size && status.denied === tried.length && tried.every((row) => Number(row.ok) === 0);
    if (status.permissionMissing && !runError) {
      status.lastError = 'permission_missing';
      status.lastErrorAt = now;
    }
    if (run.skipped > 0 && skippedBefore < AUDIT_SKIPS_PER_DAY) {
      await db.prepare(
        `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
         VALUES (?, datetime('now'), NULL, 'system', 'graph_mirror.copies_skipped', 'exchange-mirror', ?)`,
      ).bind(crypto.randomUUID(), `Graph mirror skipped ${run.skipped} cop${run.skipped === 1 ? 'y' : 'ies'}: ${runSkipReason.value || 'unknown'}`).run();
    }
  } catch {
    console.error('Graph mirror: status details could not be read');
  }
  await releaseLease(db, { cursor, status });
  if (runError && visited === 0 && run.filed + run.sentFiled + run.duplicates === 0) return { status: 'error', code: runError };
  return { status: 'worked', mailboxes: mailboxes.length, visited, counts: run, complete, error: runError };
}

/** What one tick's pull shares. */
export interface Puller {
  env: GraphMirrorWorkerEnv;
  tools: InboundTools;
  client: GraphMirrorClient;
  config: GraphMirrorConfig;
  now: number;
  budgets: typeof DEFAULTS;
  /** Wall clock at the start (real time, not the injected clock). */
  started: number;
  run: GraphMirrorCounts;
  status: GraphMirrorStatus;
  /** This run's first skip reason (for its audit row). */
  runSkipReason: { value: string };
  /** D1 and R2 subrequests so far (Graph requests are counted by the client). */
  subrequests: number;
}

export function outOfBudget(p: Puller): boolean {
  return Date.now() - p.started >= p.budgets.timeMs
    || p.client.requests >= p.budgets.graph
    || p.subrequests + p.client.requests >= p.budgets.subrequests;
}

async function pullMailboxes(p: Puller, mailboxes: MailboxRow[], cursor: string): Promise<{ cursor: string; visited: number; complete: boolean; error: string }> {
  // A credential problem stops the run before any mailbox is read.
  await p.client.ensureToken();
  const startAt = Math.max(0, mailboxes.findIndex((row) => row.mailbox_id > cursor));
  const order = [...mailboxes.slice(startAt), ...mailboxes.slice(0, startAt)];
  let networkErrors = 0;
  let visited = 0;
  let error = '';
  for (const mailbox of order) {
    if (outOfBudget(p)) break;
    const { results } = await p.env.DB.prepare(
      `SELECT mailbox_id, folder, link, link_kind, since_ms, round_cap, round_filed, watermark_ms, retry_after_ms
       FROM graph_mirror_folders WHERE mailbox_id = ?`,
    ).bind(mailbox.mailbox_id).all<FolderRow>();
    p.subrequests += 1;
    const rows = new Map((results ?? []).map((row) => [row.folder, {
      ...row,
      since_ms: Number(row.since_ms),
      round_cap: Number(row.round_cap),
      round_filed: Number(row.round_filed),
      watermark_ms: Number(row.watermark_ms),
      retry_after_ms: Number(row.retry_after_ms),
    }]));
    let cut = false;
    try {
      for (const folder of p.config.folders) {
        if (outOfBudget(p)) {
          cut = true;
          break;
        }
        let row = rows.get(folder);
        if (!row) {
          row = { mailbox_id: mailbox.mailbox_id, folder, link: null, link_kind: 'none', since_ms: 0, round_cap: 0, round_filed: 0, watermark_ms: 0, retry_after_ms: 0 };
          newRound(row, p.now - p.config.lookbackHours * HOUR_MS, p.config.initialCap);
        }
        if (row.retry_after_ms > p.now) continue;
        // A folder with more pages than one turn allows continues on the next
        // visit; one stopped by the budget keeps the mailbox first in line.
        if (await pullFolder(p, mailbox, row) === 'budget') {
          cut = true;
          break;
        }
      }
    } catch (caught) {
      if (!(caught instanceof MailboxStop)) throw caught;
      // Throttled or refused: this mailbox waits; the others go on.
      if (caught.code === 'network') {
        networkErrors += 1;
        if (networkErrors >= MAX_NETWORK_ERRORS) {
          error = 'network';
          break;
        }
      }
    }
    // A mailbox cut short by the budget keeps its place and goes first next tick.
    if (cut) break;
    visited += 1;
    cursor = mailbox.mailbox_id;
  }
  return { cursor, visited, complete: visited === order.length, error };
}

/**
 * Works one folder for up to pagesPerFolder pages, saving its place after
 * each. 'budget' when it stopped for the tick's budget.
 */
async function pullFolder(p: Puller, mailbox: MailboxRow, row: FolderRow): Promise<'ok' | 'budget'> {
  for (let page = 0; page < p.budgets.pagesPerFolder; page += 1) {
    if (outOfBudget(p)) return 'budget';
    const url = row.link_kind === 'none' || !row.link ? initialDeltaUrl(mailbox.object_id, row.folder, row.since_ms) : row.link;
    const result = await p.client.messageDeltaPage(url).catch((caught: unknown) => folderError(p, row, caught));
    const filing = await fileDeltaPage(p, mailbox, row, result.messages);
    if (filing.outcome !== 'done') {
      // Out of budget, or a copy could not be stored: keep the link (and the
      // watermark), so this page is read again next tick; what was filed is
      // then a duplicate and is not downloaded again.
      if (filing.outcome === 'budget') return 'budget';
      await saveFolder(p.env.DB, row, { last_error: 'store_failed' });
      p.subrequests += 1;
      return 'ok';
    }
    // Only a finished page moves the watermark (the resync point after a 410).
    row.watermark_ms = Math.max(row.watermark_ms, filing.newestMs);
    if (result.deltaLink) {
      row.link = result.deltaLink;
      row.link_kind = 'delta';
      row.round_cap = 0;
      row.round_filed = 0;
    } else {
      row.link = result.nextLink;
      row.link_kind = 'next';
    }
    await saveFolder(p.env.DB, row, { last_ok_at: p.now, last_error: '', retry_after_ms: 0 });
    p.subrequests += 1;
    if (result.deltaLink) return 'ok';
  }
  return 'ok';
}

/** Records a Graph error on the folder and ends the mailbox (or the run). Never returns. */
async function folderError(p: Puller, row: FolderRow, caught: unknown): Promise<never> {
  if (!(caught instanceof GraphError)) throw caught;
  const db = p.env.DB;
  p.subrequests += 1;
  switch (caught.code) {
    case 'throttled': {
      const seconds = caught.retryAfterSeconds ?? DEFAULT_THROTTLE_SECONDS;
      await saveFolder(db, row, { last_error: 'throttled', retry_after_ms: p.now + Math.max(1, seconds) * 1000 });
      throw new MailboxStop('throttled');
    }
    case 'resync_required': {
      // Start again, never from the beginning: from the newest message of the
      // last finished round, less an hour. A round still paging (pages are
      // newest first, so older ones may be unread) starts again from its own
      // floor instead. No cap: this is catch-up, not a first pull; mail
      // already filed is counted, not downloaded again.
      const since = row.link_kind === 'delta' && row.watermark_ms > 0
        ? Math.max(row.since_ms, row.watermark_ms - RESYNC_OVERLAP_MS)
        : row.since_ms || p.now - p.config.lookbackHours * HOUR_MS;
      newRound(row, since, 0);
      await saveFolder(db, row, { last_error: 'resync_required', retry_after_ms: 0 });
      throw new MailboxStop('resync_required');
    }
    case 'unauthorized':
      if (caught.status === 401) throw new RunStop('credentials_rejected');
      await saveFolder(db, row, { last_error: 'denied', retry_after_ms: p.now + DENIED_RETRY_MS });
      throw new MailboxStop('denied');
    case 'credentials_rejected':
      throw new RunStop('credentials_rejected');
    case 'network':
      await saveFolder(db, row, { last_error: 'network', retry_after_ms: 0 });
      throw new MailboxStop('network');
    case 'http_error': {
      const notFound = caught.status === 404;
      await saveFolder(db, row, { last_error: notFound ? 'not_found' : 'http_error', retry_after_ms: p.now + (notFound ? NOT_FOUND_RETRY_MS : BAD_RESPONSE_RETRY_MS) });
      throw new MailboxStop('http_error');
    }
    default:
      await saveFolder(db, row, { last_error: 'bad_response', retry_after_ms: p.now + BAD_RESPONSE_RETRY_MS });
      throw new MailboxStop('bad_response');
  }
}

function firstHeader(headers: Email['headers'], name: string): string | undefined {
  return headers.find((header) => header.key.toLowerCase() === name)?.value;
}

/**
 * Files one delta page's new messages into the mailbox. 'budget' or
 * 'store_failed': the page was not finished and must be read again.
 */
export async function fileDeltaPage(
  p: Puller,
  mailbox: MailboxRow,
  row: FolderRow,
  messages: DeltaMessage[],
  fail: (caught: unknown) => Promise<never> = (caught) => folderError(p, row, caught),
): Promise<{ outcome: 'done' | 'budget' | 'store_failed'; newestMs: number }> {
  const { env, tools, run, status } = p;
  const sent = row.folder === 'sentitems';
  // Deleted or moved entries, drafts, and change events for mail older than
  // the round (read-state changes) are never filed.
  const candidates = messages.filter((item) => !item.removed && !item.isDraft && item.receivedMs !== null && item.receivedMs >= row.since_ms);
  const newestMs = candidates.reduce((max, item) => Math.max(max, item.receivedMs ?? 0), 0);
  const finish = (outcome: 'done' | 'budget' | 'store_failed') => ({ outcome, newestMs });
  if (!candidates.length) return finish('done');
  const headerOf = new Map(candidates.map((item) => [item, tools.normalizeMessageIdHeader(item.internetMessageId ?? '')]));
  const known = [...new Set([...headerOf.values()].filter((value): value is string => Boolean(value)))];
  const existing = known.length ? await alreadyFiled(env.DB, mailbox.mailbox_id, sent, known) : new Set<string>();
  p.subrequests += Math.ceil(known.length / IN_CHUNK) * (sent ? 2 : 1);
  const inboundLimit = tools.getInboundLimit(env);
  const skip = (reason: string) => {
    run.skipped += 1;
    status.lastSkipReason ||= reason;
    p.runSkipReason.value ||= reason;
  };
  for (const item of candidates) {
    const graphHeader = headerOf.get(item) ?? null;
    if (graphHeader && existing.has(graphHeader)) {
      run.duplicates += 1;
      continue;
    }
    if (row.round_cap > 0 && row.round_filed >= row.round_cap) {
      run.capped += 1;
      status.lastSkipReason ||= 'capped';
      continue;
    }
    if (outOfBudget(p)) return finish('budget');
    let mime: Uint8Array | null;
    try {
      mime = await p.client.messageMime(mailbox.object_id, item.id, inboundLimit);
    } catch (caught) {
      // Deleted between the delta page and now: nothing to file.
      if (caught instanceof GraphError && caught.code === 'http_error' && caught.status === 404) continue;
      if (caught instanceof GraphError && caught.code === 'http_error') {
        skip('http_error');
        continue;
      }
      // Throttling, refusal, network or an unreadable answer: stop the
      // mailbox without moving the link, so the page is read again.
      return fail(caught);
    }
    if (!mime) {
      skip('too_large');
      continue;
    }
    let inner: Email;
    try {
      inner = await new PostalMime().parse(mime);
    } catch {
      skip('original_unparseable');
      continue;
    }
    const mimeIds = headerValues(inner.headers, 'message-id');
    const messageIdHeader = graphHeader ?? (mimeIds.length === 1 ? tools.normalizeMessageIdHeader(mimeIds[0]) : null);
    if (!messageIdHeader) {
      skip('no_message_id');
      continue;
    }
    if (!graphHeader && (await alreadyFiled(env.DB, mailbox.mailbox_id, sent, [messageIdHeader])).size) {
      run.duplicates += 1;
      continue;
    }
    const content = prepareMirrorContent(inner, env, tools, inboundLimit);
    if (!content.ok) {
      skip(content.reason);
      continue;
    }
    const parsedFrom = tools.inboundFromParticipant(inner.from as { address?: string; name?: string } | undefined, '', firstHeader(inner.headers, 'from'));
    const headerFrom = parsedFrom.address;
    const subject = tools.cleanHeaderValue(inner.subject, tools.maxSubjectChars) || '(no subject)';
    let fromMailbox: string | undefined;
    if (!sent && headerFrom) {
      // Only for colleague mail this instance sent (recordedSendRecipients).
      const found = await env.DB.prepare(`SELECT id FROM mailboxes WHERE status = 'active' AND address = ?`).bind(headerFrom).first<{ id: string }>();
      fromMailbox = found?.id;
      p.subrequests += 1;
    }
    const counts: ExchangeMirrorCounts = emptyMirrorCounts();
    const result = await fileMirrorCopies(env, tools, {
      inner,
      raw: mime,
      size: mime.byteLength,
      messageIdHeader,
      headerFrom,
      fromName: parsedFrom.name,
      subject,
      content: content.content,
      receivedAt: new Date(item.receivedMs ?? p.now).toISOString().slice(0, 19).replace('T', ' '),
    }, {
      targets: [{ mailboxId: mailbox.mailbox_id, address: mailbox.address, role: sent ? 'sent' : 'inbound' }],
      // The mailbox's own Sent copy is the one place a Bcc list belongs.
      bccForSent: sent ? tools.flattenParsedParticipants(inner.bcc as Array<{ address?: string; name?: string }> | undefined) : [],
      fromMailbox,
      tenantId: p.config.tenantId,
      budget: Math.max(0, p.budgets.subrequests - p.subrequests - p.client.requests),
      reservedSubrequests: 0,
      archive: row.folder === 'archive',
    }, counts);
    p.subrequests += 6 + content.content.attachments.length;
    // Not enough budget left for this copy: stop here, the page is read again.
    if (result.skipReason === 'budget') return finish('budget');
    run.filed += counts.filed;
    run.sentFiled += counts.sentFiled;
    run.duplicates += counts.duplicates;
    run.skipped += counts.skipped;
    if (result.skipReason) {
      status.lastSkipReason ||= result.skipReason;
      p.runSkipReason.value ||= result.skipReason;
    }
    row.round_filed += counts.filed + counts.sentFiled;
    if (counts.filed + counts.sentFiled > 0) {
      await tools.logTrace(env.DB, {
        message_id_header: messageIdHeader,
        direction: 'inbound',
        envelope_from: null,
        header_from: headerFrom || null,
        subject,
        size_bytes: mime.byteLength,
        status: 'delivered',
        status_detail: `Exchange mirror (Graph): filed to ${sent ? 'Sent' : row.folder === 'archive' ? 'Archive' : 'Inbox'}`,
      });
      p.subrequests += 1;
    }
    if (result.incomplete) return finish('store_failed');
  }
  return finish('done');
}
