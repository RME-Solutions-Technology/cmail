// Exchange mirror, Graph source: the finite "Import older mail"
// (docs/exchange-mirror.md#import-older-mail).
//
// Runs inside the Graph source's scheduled tick, AFTER the live pull, so live
// mail always goes first. While a count or an import is active the live pull is
// held to GRAPH_IMPORT_LIVE_SHARE of the run and the import gets the rest (all
// of what the live pull leaves, when it finishes early). It never touches the live mirror's delta links
// (graph_mirror_folders): the import has its own cursor in one org_settings
// record and reads plain, bounded list pages.
//
// Three records, one writer each (packages/shared/src/graph-import.ts):
// - request  (web app): "estimate this period" / "start, I confirmed these numbers"
// - estimate (here): the dry run. Counts and sizes per mailbox from Graph; no
//   mail is written. Started by a request, resumed over ticks.
// - job      (here): the import. Started only by a Start request, after a
//   recount of the confirmed period; if the count moved by more than 20% the
//   manager is asked again and nothing starts.
//
// A manager's Stop patches the record's status; every write here is a guarded
// patch (only while the status is 'running'), so nothing overwrites a Stop.
//
// Same filing as the live mirror (fileDeltaPage -> fileMirrorCopies): copies
// are filed as read, with no rules and no notifications, and a message already
// in the mailbox (by Message-ID) is counted, not downloaded or filed twice.
import {
  GRAPH_IMPORT_SETTING_ESTIMATE,
  GRAPH_IMPORT_SETTING_JOB,
  GRAPH_IMPORT_SETTING_REQUEST,
  ASSUMED_MESSAGE_BYTES,
  D1_MAX_DATABASE_BYTES,
  GRAPH_IMPORT_MAX_RETRIES,
  GRAPH_IMPORT_STOP_FRACTION,
  graphImportCountChanged,
  graphImportFigures,
  graphImportPeriod,
  graphImportSinceMs,
  parseGraphImportEstimate,
  parseGraphImportJob,
  parseGraphImportRequest,
  type GraphImportEstimate,
  type GraphImportJob,
  type GraphImportRequest,
} from '@cmail/shared/graph-import';
import { GraphError } from '../m365-sync/graph';
import { importCountUrl, importListUrl } from './graph';
import { fileDeltaPage, outOfBudget, RunStop, type FolderRow, type MailboxRow, type Puller } from './run';

const DEFAULT_THROTTLE_SECONDS = 60;
/** Mailboxes kept in a finished estimate's per-mailbox list (largest first). */
const PER_MAILBOX_KEPT = 500;
const PER_MAILBOX_WORKING = 2_000;

/** Ends the import for this run (it resumes next run) or skips one folder or mailbox. */
class ImportStop extends Error {
  constructor(readonly code: string, readonly kind: 'tick' | 'mailbox' | 'folder') {
    super(code);
  }
}

export interface ImportRecords {
  request: GraphImportRequest | null;
  estimate: GraphImportEstimate | null;
  job: GraphImportJob | null;
}

/** True while a request waits, a count runs or an import runs: the live pull then leaves room for it. */
export function importHasWork(records: ImportRecords): boolean {
  return records.request !== null || records.estimate?.status === 'running' || records.job?.status === 'running';
}

export async function loadImportRecords(db: D1Database): Promise<ImportRecords> {
  const { results } = await db.prepare('SELECT key, value FROM org_settings WHERE key IN (?, ?, ?)')
    .bind(GRAPH_IMPORT_SETTING_REQUEST, GRAPH_IMPORT_SETTING_ESTIMATE, GRAPH_IMPORT_SETTING_JOB).all<{ key: string; value: string }>();
  const values = new Map((results ?? []).map((row) => [row.key, row.value]));
  return {
    request: parseGraphImportRequest(values.get(GRAPH_IMPORT_SETTING_REQUEST)),
    estimate: parseGraphImportEstimate(values.get(GRAPH_IMPORT_SETTING_ESTIMATE)),
    job: parseGraphImportJob(values.get(GRAPH_IMPORT_SETTING_JOB)),
  };
}

async function putRecord(db: D1Database, key: string, value: object): Promise<void> {
  await db.prepare(
    `INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), NULL)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = NULL`,
  ).bind(key, JSON.stringify(value)).run();
}

/** Merges `patch` into the record only while it is 'running'. False once a manager stopped it (or it finished). */
async function patchRunning(db: D1Database, key: string, patch: object): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE org_settings SET value = json_patch(value, ?), updated_at = datetime('now')
     WHERE key = ? AND json_extract(value, '$.status') = 'running'`,
  ).bind(JSON.stringify(patch), key).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

async function auditSystem(db: D1Database, eventType: string, detail: string): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
     VALUES (?, datetime('now'), NULL, 'system', ?, 'exchange-mirror', ?)`,
  ).bind(crypto.randomUUID(), eventType, detail).run();
}

/** D1 reports the database size with every statement. Null when it does not. */
async function databaseBytes(db: D1Database): Promise<number | null> {
  const result = await db.prepare('SELECT 1').run();
  const size = (result.meta as { size_after?: unknown } | undefined)?.size_after;
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? Math.floor(size) : null;
}

/**
 * Entry point from the tick, after the live pull. Returns a short error code
 * for the run's status only when the credentials were refused; anything else
 * stays in the import's own record and the log.
 */
export async function runImportPhase(p: Puller, mailboxes: MailboxRow[], records: ImportRecords): Promise<string> {
  if (!importHasWork(records) || outOfBudget(p)) return '';
  try {
    await importWork(p, mailboxes, records);
    return '';
  } catch (caught) {
    if (caught instanceof RunStop) return caught.code;
    if (caught instanceof GraphError && (caught.code === 'credentials_rejected' || (caught.code === 'unauthorized' && caught.status === 401))) return 'credentials_rejected';
    console.error('Graph mirror import failed', { error: caught instanceof Error ? caught.name : caught instanceof GraphError ? `graph_${caught.code}` : 'UnknownError' });
    return '';
  }
}

async function importWork(p: Puller, mailboxes: MailboxRow[], records: ImportRecords): Promise<void> {
  const db = p.env.DB;
  const { request } = records;
  let { estimate, job } = records;

  if (request && request.seq !== estimate?.requestSeq) {
    if (job?.status === 'running' || (request.kind === 'start' && !request.confirm)) {
      // One import at a time, and a start without confirmed numbers is never trusted.
      await deleteRequest(db, request.seq);
      p.subrequests += 1;
    } else {
      const fresh: GraphImportEstimate = {
        id: crypto.randomUUID(),
        requestSeq: request.seq,
        period: request.period,
        sinceMs: graphImportSinceMs(request.period, p.now),
        startedAt: p.now,
        finishedAt: 0,
        status: 'running',
        mailboxesTotal: mailboxes.length,
        mailboxesDone: 0,
        cursor: '',
        messages: 0,
        bytes: 0,
        errors: 0,
        retries: 0,
        assumedSize: false,
        d1UsedBytes: -1,
        perMailbox: [],
        then: request.kind === 'start' ? request.confirm : null,
        changed: false,
        refused: '',
        jobId: '',
      };
      // Only while that very request is still there: a Stop that withdrew it in the meantime wins.
      const created = await db.prepare(
        `INSERT INTO org_settings (key, value, updated_at, updated_by)
         SELECT ?, ?, datetime('now'), NULL
         WHERE EXISTS (SELECT 1 FROM org_settings WHERE key = ? AND json_extract(value, '$.seq') = ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = NULL`,
      ).bind(GRAPH_IMPORT_SETTING_ESTIMATE, JSON.stringify(fresh), GRAPH_IMPORT_SETTING_REQUEST, request.seq).run();
      // The request is handled either way: never replay it.
      await deleteRequest(db, request.seq);
      p.subrequests += 2;
      estimate = Number(created.meta?.changes ?? 0) > 0 ? fresh : null;
    }
  }

  if (estimate?.status === 'running') {
    const outcome = await estimateStep(p, mailboxes, estimate);
    if (outcome.job) job = outcome.job;
  }
  if (job?.status === 'running' && !outOfBudget(p)) await importStep(p, mailboxes, job);
}

/** Removes the request only if it is still the one that was handled. */
async function deleteRequest(db: D1Database, seq: string): Promise<void> {
  await db.prepare(`DELETE FROM org_settings WHERE key = ? AND json_extract(value, '$.seq') = ?`).bind(GRAPH_IMPORT_SETTING_REQUEST, seq).run();
}

// ─── The dry run ─────────────────────────────────────────────────────────

async function estimateStep(p: Puller, mailboxes: MailboxRow[], estimate: GraphImportEstimate): Promise<{ job: GraphImportJob | null }> {
  const db = p.env.DB;
  for (const mailbox of mailboxes.filter((row) => row.mailbox_id > estimate.cursor)) {
    if (outOfBudget(p)) return { job: null };
    let messages = 0;
    let bytes = 0;
    let errors = 0;
    let assumed = false;
    for (const folder of p.config.folders) {
      try {
        const found = await p.client.messageCount(importCountUrl(mailbox.object_id, folder, estimate.sinceMs));
        if (found.count === 0) continue;
        messages += found.count;
        if (!found.sizes.length) {
          assumed = true;
          bytes += found.count * ASSUMED_MESSAGE_BYTES;
        } else {
          const sum = found.sizes.reduce((total, size) => total + size, 0);
          // The whole folder fit in the sample: exact. Otherwise the average of the newest ones.
          bytes += found.sizes.length >= found.count ? sum : Math.round((sum / found.sizes.length) * found.count);
        }
      } catch (caught) {
        if (!(caught instanceof GraphError)) throw caught;
        if (caught.code === 'credentials_rejected' || (caught.code === 'unauthorized' && caught.status === 401)) throw new RunStop('credentials_rejected');
        // Throttled or unreachable: try this mailbox again next run; after
        // GRAPH_IMPORT_MAX_RETRIES runs in a row it is left out and counted, so one
        // failing mailbox cannot hold up the rest.
        if (caught.code === 'throttled' || caught.code === 'network') {
          estimate.retries += 1;
          if (estimate.retries < GRAPH_IMPORT_MAX_RETRIES) {
            await patchRunning(db, GRAPH_IMPORT_SETTING_ESTIMATE, { retries: estimate.retries });
            return { job: null };
          }
          errors += 1;
          break;
        }
        // No such folder (for example no Archive): nothing to count. Anything else: this folder is left out and said so.
        if (!(caught.code === 'http_error' && caught.status === 404)) errors += 1;
      }
    }
    p.subrequests += 1;
    estimate.cursor = mailbox.mailbox_id;
    estimate.retries = 0;
    estimate.mailboxesDone += 1;
    estimate.messages += messages;
    estimate.bytes += bytes;
    estimate.errors += errors;
    estimate.assumedSize ||= assumed;
    if (messages > 0) estimate.perMailbox.push([mailbox.mailbox_id, messages, bytes]);
    if (estimate.perMailbox.length > PER_MAILBOX_WORKING) {
      estimate.perMailbox.sort((a, b) => b[1] - a[1]);
      estimate.perMailbox.length = PER_MAILBOX_KEPT;
    }
    const alive = await patchRunning(db, GRAPH_IMPORT_SETTING_ESTIMATE, {
      cursor: estimate.cursor,
      mailboxesDone: estimate.mailboxesDone,
      messages: estimate.messages,
      bytes: estimate.bytes,
      errors: estimate.errors,
      retries: 0,
      assumedSize: estimate.assumedSize,
      perMailbox: estimate.perMailbox,
    });
    if (!alive) return { job: null };
  }

  // Every mailbox counted.
  const d1Used = await databaseBytes(db);
  p.subrequests += 1;
  estimate.perMailbox.sort((a, b) => b[1] - a[1]);
  const patch: Record<string, unknown> = {
    status: 'done',
    finishedAt: p.now,
    d1UsedBytes: d1Used ?? -1,
    perMailbox: estimate.perMailbox.slice(0, PER_MAILBOX_KEPT),
  };
  let job: GraphImportJob | null = null;
  if (estimate.then) {
    // Start was pressed: this recount is the check against what was confirmed.
    const figures = graphImportFigures({ messages: estimate.messages, bytes: estimate.bytes, d1UsedBytes: d1Used, period: estimate.period });
    if (graphImportCountChanged(estimate.then.messages, estimate.messages)) {
      patch.changed = true;
    } else if (figures.blocked) {
      patch.refused = figures.blockReason;
    } else {
      job = {
        id: crypto.randomUUID(),
        period: estimate.period,
        sinceMs: graphImportSinceMs(estimate.period, p.now),
        untilMs: p.now,
        status: 'running',
        startedAt: p.now,
        finishedAt: 0,
        estMessages: estimate.then.messages,
        estBytes: estimate.then.bytes,
        mailboxesTotal: mailboxes.length,
        mailboxesDone: 0,
        cursor: { done: '', mid: '', folder: 0, before: 0, skip: 0 },
        retries: 0,
        filed: 0,
        duplicates: 0,
        skipped: 0,
        processed: 0,
        errors: 0,
        lastProgressAt: p.now,
        pausedUntil: 0,
        error: '',
      };
      patch.jobId = job.id;
    }
  }
  // Claim the estimate first: a Stop that landed since the last mailbox keeps the import from starting.
  const claimed = await patchRunning(db, GRAPH_IMPORT_SETTING_ESTIMATE, patch);
  if (!claimed) return { job: null };
  if (job) {
    await putRecord(db, GRAPH_IMPORT_SETTING_JOB, job);
    await auditSystem(db, 'graph_mirror.import_started', `Import older mail started: ${graphImportPeriod(job.period)?.label ?? job.period}, about ${job.estMessages} messages in ${job.mailboxesTotal} mailboxes`);
    p.subrequests += 2;
  }
  return { job };
}

// ─── The import ──────────────────────────────────────────────────────────

interface ImportRun {
  /** Messages seen this run, against the per-run limit. */
  processed: number;
}

async function saveProgress(p: Puller, job: GraphImportJob, extra: object = {}): Promise<boolean> {
  p.subrequests += 1;
  return patchRunning(p.env.DB, GRAPH_IMPORT_SETTING_JOB, {
    mailboxesDone: job.mailboxesDone,
    cursor: job.cursor,
    filed: job.filed,
    duplicates: job.duplicates,
    skipped: job.skipped,
    processed: job.processed,
    errors: job.errors,
    lastProgressAt: p.now,
    pausedUntil: job.pausedUntil,
    retries: job.retries,
    error: job.error,
    ...extra,
  });
}

async function importFail(p: Puller, job: GraphImportJob, caught: unknown): Promise<never> {
  if (!(caught instanceof GraphError)) throw caught;
  switch (caught.code) {
    case 'throttled':
    case 'network': {
      // Wait and try again; after GRAPH_IMPORT_MAX_RETRIES runs in a row this folder is left out and counted.
      job.retries += 1;
      if (job.retries >= GRAPH_IMPORT_MAX_RETRIES) {
        job.retries = 0;
        throw new ImportStop(caught.code, 'folder');
      }
      if (caught.code === 'throttled') job.pausedUntil = p.now + Math.max(1, caught.retryAfterSeconds ?? DEFAULT_THROTTLE_SECONDS) * 1000;
      job.error = caught.code;
      await saveProgress(p, job);
      throw new ImportStop(caught.code, 'tick');
    }
    case 'unauthorized':
      if (caught.status === 401) throw new RunStop('credentials_rejected');
      throw new ImportStop('denied', 'mailbox');
    case 'credentials_rejected':
      throw new RunStop('credentials_rejected');
    case 'http_error':
      throw new ImportStop(caught.status === 404 ? 'not_found' : 'http_error', 'folder');
    default:
      throw new ImportStop('bad_response', 'folder');
  }
}

const secondOf = (ms: number): number => Math.floor(ms / 1000) * 1000;

/**
 * One folder, page by page. 'paused': out of budget or not finished; the
 * cursor says where. The resume point is the second of the oldest message read
 * plus how many messages of that very second were read (`$skip`), so a burst
 * of mail in one second is neither repeated nor skipped.
 */
async function importFolder(p: Puller, job: GraphImportJob, mailbox: MailboxRow, folderIdx: number, resume: { before: number; skip: number }, run: ImportRun): Promise<'done' | 'paused'> {
  const folder = p.config.folders[folderIdx];
  if (!folder) return 'done';
  let edgeSec = resume.before;
  let edgeCount = resume.skip;
  const listUrl = () => importListUrl(mailbox.object_id, folder, { sinceMs: job.sinceMs, untilMs: job.untilMs, beforeMs: edgeSec, skip: edgeCount });
  let url = listUrl();
  let restarted = false;
  // fileDeltaPage reads the floor and the folder from a round's row; the import has no cap and no live link.
  const row: FolderRow = { mailbox_id: mailbox.mailbox_id, folder, link: null, link_kind: 'none', since_ms: job.sinceMs, round_cap: 0, round_filed: 0, watermark_ms: 0, retry_after_ms: 0 };
  for (;;) {
    if (outOfBudget(p) || run.processed >= p.budgets.importMessages) return 'paused';
    const page = await p.client.messageListPage(url).catch((caught: unknown) => {
      // An expired page token: start the folder again from the resume point.
      if (!restarted && caught instanceof GraphError && caught.code === 'resync_required') {
        restarted = true;
        url = listUrl();
        return p.client.messageListPage(url).catch((again: unknown) => importFail(p, job, again));
      }
      return importFail(p, job, caught);
    });
    const before0 = { ...p.run };
    const filing = await fileDeltaPage(p, mailbox, row, page.messages, (caught) => importFail(p, job, caught));
    job.filed += p.run.filed - before0.filed + p.run.sentFiled - before0.sentFiled;
    if (filing.outcome !== 'done') {
      // The page is read again next run; what was filed is then counted as already here.
      if (filing.outcome === 'store_failed') {
        job.error = 'store_failed';
        await saveProgress(p, job);
        throw new ImportStop('store_failed', 'tick');
      }
      await saveProgress(p, job);
      return 'paused';
    }
    job.duplicates += p.run.duplicates - before0.duplicates;
    job.skipped += p.run.skipped - before0.skipped;
    job.processed += page.messages.length;
    run.processed += page.messages.length;
    job.error = '';
    job.pausedUntil = 0;
    job.retries = 0;
    for (const message of page.messages) {
      if (message.receivedMs === null) continue;
      const sec = secondOf(message.receivedMs);
      if (sec === edgeSec) {
        edgeCount += 1;
      } else {
        edgeSec = sec;
        edgeCount = 1;
      }
    }
    if (page.nextLink) {
      job.cursor = { done: job.cursor.done, mid: mailbox.mailbox_id, folder: folderIdx, before: edgeSec, skip: edgeCount };
      url = page.nextLink;
    } else {
      job.cursor = { done: job.cursor.done, mid: mailbox.mailbox_id, folder: folderIdx + 1, before: 0, skip: 0 };
    }
    if (!await saveProgress(p, job)) throw new ImportStop('stopped', 'tick');
    if (!page.nextLink) return 'done';
  }
}

async function importStep(p: Puller, mailboxes: MailboxRow[], job: GraphImportJob): Promise<void> {
  if (job.pausedUntil > p.now) return;
  // A safety net on top of the estimate (which used a per-message guess): the import stops itself
  // before the database fills, so live mail can always be stored.
  const size = await databaseBytes(p.env.DB);
  p.subrequests += 1;
  if (size !== null && size >= D1_MAX_DATABASE_BYTES * GRAPH_IMPORT_STOP_FRACTION) {
    if (await patchRunning(p.env.DB, GRAPH_IMPORT_SETTING_JOB, { status: 'stopped', finishedAt: p.now, error: 'd1_limit' })) {
      await auditSystem(p.env.DB, 'graph_mirror.import_stopped_d1', `Import older mail stopped itself: the database reached ${Math.round((size / D1_MAX_DATABASE_BYTES) * 100)}% of its size limit; ${job.filed} filed`);
    }
    return;
  }
  const run: ImportRun = { processed: 0 };
  const folders = p.config.folders;
  try {
    for (const mailbox of mailboxes.filter((row) => row.mailbox_id > job.cursor.done)) {
      const resumed = job.cursor.mid === mailbox.mailbox_id;
      let folderIdx = resumed ? job.cursor.folder : 0;
      let resume = { before: resumed ? job.cursor.before : 0, skip: resumed ? job.cursor.skip : 0 };
      let skipMailbox = false;
      while (folderIdx < folders.length && !skipMailbox) {
        try {
          if (await importFolder(p, job, mailbox, folderIdx, resume, run) === 'paused') return;
        } catch (caught) {
          if (!(caught instanceof ImportStop) || caught.kind === 'tick') throw caught;
          // A folder that does not exist (no Archive) is not an error.
          if (caught.code !== 'not_found') job.errors += 1;
          if (caught.kind === 'mailbox') skipMailbox = true;
        }
        folderIdx += 1;
        resume = { before: 0, skip: 0 };
      }
      job.mailboxesDone += 1;
      job.cursor = { done: mailbox.mailbox_id, mid: '', folder: 0, before: 0, skip: 0 };
      if (!await saveProgress(p, job)) return;
    }
  } catch (caught) {
    // Stopped by a manager, throttled, unreachable or could not store: it resumes next run (or stays stopped).
    if (caught instanceof ImportStop) return;
    throw caught;
  }
  // Every mailbox done.
  job.status = 'done';
  job.finishedAt = p.now;
  if (await saveProgress(p, job, { status: 'done', finishedAt: p.now })) {
    await auditSystem(p.env.DB, 'graph_mirror.import_finished', `Import older mail finished: ${job.filed} filed, ${job.duplicates} already here, ${job.skipped} skipped, ${job.errors} folders or mailboxes not read`);
    p.subrequests += 1;
  }
}
