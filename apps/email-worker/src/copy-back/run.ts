// Scheduled driver for copying standby mail back into Exchange Online
// (docs/copy-back.md). Runs on the email Worker's */15 cron, beside the
// Microsoft 365 sync.
//
// Every tick:
// 1. Reads the Admin switch. Off = return at once: no Graph call, no write.
// 2. Finds the one running job (a manager started it after a dry run) and
//    takes a lease on it, so overlapping invocations never work it together.
// 3. Gets the app token first: a credential problem stops the run before any
//    mailbox is touched.
// 4. Plans: queues the job's frozen selection as 'pending' items in chunks,
//    keyed by (cmail message id, Entra object id). INSERT OR IGNORE plus the
//    0024 insert guard mean an existing item, above all a 'copied' one, is
//    never reset.
// 5. Works due items (pending, or failed with a retry due), fewest attempts
//    first, then oldest, so a stubborn item never holds up the rest. Before
//    each item it re-reads the job status and the switch, so Cancel and
//    switch-off take effect between items. For each item:
//      a. look for our marker: found = already copied (an earlier attempt
//         was cut off after Exchange accepted it);
//      b. look for the same Message-ID, ignoring our own copies: found =
//         Exchange already has it, skip;
//      c. build the message; too big for one request = skip;
//      d. create it, then restore "unread" if it was unread in cmail;
//      e. record the outcome. A copied item is final (triggers in 0024).
//    Draft canary: if Exchange says a copy (new or found) is a draft, the job
//    halts at once; nothing more is created until a manager has looked.
// 6. Marks the job done when nothing is left to try.
//
// Error classes:
// - whole run (stop, back off the job, the item stays due and untouched):
//   token or credential errors, 401 from Graph;
// - one mailbox, no attempt counted (throttling is not the item's fault):
//   429 for that mailbox; its other items wait for the next tick;
// - one item, counted as an attempt with backoff, giving up after
//   COPYBACK_MAX_ATTEMPTS: 403, 404, 5xx, network, 400/422, odd answers, and
//   any non-Graph error while reading or building the message. 403/404/5xx
//   and network also skip the rest of that mailbox for this tick. Several
//   network errors in one tick stop the tick (the network, not the item).
//
// Logs and status carry counts and short codes only: never subjects,
// addresses, bodies, Graph ids or tokens.
import {
  COPYBACK_MAX_ATTEMPTS,
  COPYBACK_SETTING_ENABLED,
  EXCHANGE_FOLDER,
  copyBackConfig,
  jobParams,
  loadCopyBackSwitch,
  selectionSql,
  type CopyBackEnv,
  type CopyBackJobRow,
  type CopyBackParams,
} from '@cmail/shared/copy-back';
import { GraphError } from '../m365-sync/graph';
import { buildGraphMessage, copyableMessageId, type CopyAttachmentRow, type CopyMessageRow } from './build';
import { CopyBackGraphClient } from './graph';

const LEASE_SECONDS = 14 * 60;
/** No new item starts after this much wall time (cron invocations may run 15 minutes). */
const TICK_TIME_BUDGET_MS = 5 * 60_000;
const TICK_ITEM_BUDGET = 300;
/** Far inside the Workers Paid subrequest limit, with D1 and R2 calls on top. */
const TICK_GRAPH_BUDGET = 1200;
const PLAN_CHUNK = 500;
const WORK_CHUNK = 50;
/** Network failures in one tick before the tick stops (a network problem, not an item problem). */
const MAX_NETWORK_ERRORS_PER_TICK = 3;
const ITEM_BACKOFF_BASE_MS = 5 * 60_000;
const MAX_BACKOFF_SECONDS = 60 * 60;
const AUTH_BACKOFF_SECONDS = 60 * 60;

export interface CopyBackWorkerEnv extends CopyBackEnv {
  DB: D1Database;
  STORAGE: R2Bucket;
}

export interface CopyBackDeps {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgets?: Partial<{ timeMs: number; items: number; graph: number; planChunk: number; workChunk: number; maxBytes: number }>;
}

export type CopyBackTickResult =
  | { status: 'off' | 'not_installed' | 'idle' | 'busy' | 'not_configured' | 'backoff' }
  | { status: 'worked' | 'stopped' | 'halted'; copied: number; skipped: number; failed: number; done: boolean }
  | { status: 'error'; code: string };

const iso = (ms: number) => new Date(ms).toISOString();
const dbTime = (ms: number) => iso(ms).slice(0, 19).replace('T', ' ');

interface DueItem {
  message_id: string;
  target_object_id: string;
  attempts: number;
  received_at: string;
}

type Outcome =
  | { state: 'copied'; reason: 'created' | 'found_marker' }
  | { state: 'skipped'; reason: string }
  | { state: 'failed'; reason: string; skipTarget: boolean; final?: boolean; network?: boolean }
  /** Not recorded: the mailbox is throttled; try its items next tick. */
  | { state: 'deferred' }
  /** Exchange holds a copy as a draft: stop the whole job. */
  | { state: 'halt' };

/** Errors that stop the run. The item is not touched. */
class RunStop extends Error {
  constructor(readonly cause: GraphError) {
    super(cause.message);
  }
}

async function setJob(db: D1Database, id: string, fields: Partial<Record<keyof CopyBackJobRow, string | number | null>>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  await db.prepare(`UPDATE standby_copyback_jobs SET ${assignments}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...keys.map((key) => fields[key as keyof CopyBackJobRow] ?? null), id).run();
}

/** Queues up to `chunk` more items. Returns true when the selection is fully queued. */
async function planChunk(db: D1Database, job: CopyBackJobRow, params: CopyBackParams, chunk: number): Promise<boolean> {
  const sel = selectionSql(params);
  const [r, id, o] = job.plan_cursor ? job.plan_cursor.split('|') : ['', '', ''];
  const cursor = [r ?? '', id ?? '', o ?? ''];
  const boundary = await db.prepare(
    `SELECT m.received_at AS r, m.id AS id, l.object_id AS o FROM ${sel.from}
     WHERE ${sel.where} AND (m.received_at, m.id, l.object_id) > (?, ?, ?)
     ORDER BY m.received_at, m.id, l.object_id LIMIT 1 OFFSET ?`,
  ).bind(...sel.binds, ...cursor, chunk - 1).first<{ r: string; id: string; o: string }>();
  const upper = boundary ? 'AND (m.received_at, m.id, l.object_id) <= (?, ?, ?)' : '';
  await db.prepare(
    `INSERT OR IGNORE INTO standby_copyback_items (message_id, target_object_id, state, job_id)
     SELECT m.id, l.object_id, 'pending', ? FROM ${sel.from}
     WHERE ${sel.where} AND (m.received_at, m.id, l.object_id) > (?, ?, ?) ${upper}`,
  ).bind(job.id, ...sel.binds, ...cursor, ...(boundary ? [boundary.r, boundary.id, boundary.o] : [])).run();
  if (boundary) {
    job.plan_cursor = `${boundary.r}|${boundary.id}|${boundary.o}`;
    await setJob(db, job.id, { plan_cursor: job.plan_cursor });
    return false;
  }
  job.plan_done = 1;
  await setJob(db, job.id, { plan_done: 1 });
  return true;
}

type Cursor = [number, string, string, string] | null;

/** Due items after `cursor`, fewest attempts first, then oldest: a stuck item never blocks others. */
async function dueItems(db: D1Database, params: CopyBackParams, nowDb: string, limit: number, cursor: Cursor): Promise<DueItem[]> {
  const sel = selectionSql(params);
  const after = cursor ? 'AND (i.attempts, m.received_at, m.id, l.object_id) > (?, ?, ?, ?)' : '';
  const { results } = await db.prepare(
    `SELECT i.message_id, i.target_object_id, i.attempts, m.received_at FROM ${sel.from}
     JOIN standby_copyback_items i ON i.message_id = m.id AND i.target_object_id = l.object_id
     WHERE ${sel.where}
       AND (i.state = 'pending' OR (i.state = 'failed' AND i.next_attempt_at IS NOT NULL AND i.next_attempt_at <= ?))
       ${after}
     ORDER BY i.attempts, m.received_at, m.id, l.object_id
     LIMIT ?`,
  ).bind(...sel.binds, nowDb, ...(cursor ?? []), limit).all<DueItem>();
  return results ?? [];
}

async function remainingWork(db: D1Database, params: CopyBackParams): Promise<number> {
  const sel = selectionSql(params);
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM ${sel.from}
     JOIN standby_copyback_items i ON i.message_id = m.id AND i.target_object_id = l.object_id
     WHERE ${sel.where} AND (i.state = 'pending' OR (i.state = 'failed' AND i.next_attempt_at IS NOT NULL))`,
  ).bind(...sel.binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Still allowed to work? Cancel and switch-off are honoured between items. */
async function stillRunning(db: D1Database, jobId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT j.status AS status, (SELECT value FROM org_settings WHERE key = ?) AS enabled
     FROM standby_copyback_jobs j WHERE j.id = ?`,
  ).bind(COPYBACK_SETTING_ENABLED, jobId).first<{ status: string; enabled: string | null }>();
  return row?.status === 'running' && row.enabled === 'true';
}

async function recordOutcome(db: D1Database, jobId: string, item: DueItem, outcome: Outcome, now: number): Promise<void> {
  const where = `WHERE message_id = ? AND target_object_id = ? AND state IN ('pending', 'failed')`;
  if (outcome.state === 'copied') {
    await db.prepare(`UPDATE standby_copyback_items SET state = 'copied', reason = ?, job_id = ?, next_attempt_at = NULL,
      copied_at = datetime('now'), updated_at = datetime('now') ${where}`)
      .bind(outcome.reason, jobId, item.message_id, item.target_object_id).run();
  } else if (outcome.state === 'skipped') {
    await db.prepare(`UPDATE standby_copyback_items SET state = 'skipped', reason = ?, job_id = ?, next_attempt_at = NULL,
      updated_at = datetime('now') ${where}`)
      .bind(outcome.reason.slice(0, 64), jobId, item.message_id, item.target_object_id).run();
  } else if (outcome.state === 'failed') {
    const attempts = outcome.final ? Math.max(item.attempts + 1, COPYBACK_MAX_ATTEMPTS) : item.attempts + 1;
    const next = attempts >= COPYBACK_MAX_ATTEMPTS ? null : dbTime(now + ITEM_BACKOFF_BASE_MS * 2 ** (attempts - 1));
    await db.prepare(`UPDATE standby_copyback_items SET state = 'failed', reason = ?, job_id = ?, attempts = ?, next_attempt_at = ?,
      updated_at = datetime('now') ${where}`)
      .bind(outcome.reason.slice(0, 64), jobId, attempts, next, item.message_id, item.target_object_id).run();
  }
}

/** Classifies one Graph failure for an item. `step` names the call, for clear reason codes. */
function graphFailure(caught: unknown, step: 'lookup' | 'create' | 'unread'): Outcome {
  if (!(caught instanceof GraphError)) return { state: 'failed', reason: 'internal', skipTarget: false };
  const { code, status } = caught;
  if (code === 'credentials_rejected' || (code === 'unauthorized' && status === 401)) throw new RunStop(caught);
  if (code === 'unauthorized' && status === 403) return { state: 'failed', reason: 'access_denied', skipTarget: true };
  if (code === 'throttled' && status === 429) return { state: 'deferred' };
  if (code === 'throttled') return { state: 'failed', reason: 'server_error', skipTarget: true };
  if (code === 'network') return { state: 'failed', reason: 'network', skipTarget: true, network: true };
  if (code === 'http_error' && status === 404) {
    // After a create, a 404 on the unread update means the new copy itself is gone.
    return step === 'unread'
      ? { state: 'failed', reason: 'copy_not_found', skipTarget: false }
      : { state: 'failed', reason: 'mailbox_not_found', skipTarget: true };
  }
  if (code === 'http_error' && status === 413) return { state: 'skipped', reason: 'too_large' };
  if (code === 'http_error' && (status === 400 || status === 422)) return { state: 'failed', reason: 'rejected', skipTarget: false };
  if (code === 'http_error') return { state: 'failed', reason: `http_${status}`, skipTarget: false };
  return { state: 'failed', reason: 'bad_response', skipTarget: false };
}

async function copyOne(
  env: CopyBackWorkerEnv,
  graph: CopyBackGraphClient,
  item: DueItem,
  maxBytes: number | undefined,
): Promise<Outcome> {
  const db = env.DB;
  let message: CopyMessageRow | null;
  let attachments: CopyAttachmentRow[];
  try {
    message = await db.prepare(
      `SELECT id, folder, from_address, from_name, to_participants, cc_participants, reply_to_participants,
              to_addresses, cc_addresses, subject, body_r2_key, is_read, importance, message_id_header,
              in_reply_to, references_header, received_at, size_bytes
       FROM messages WHERE id = ?`,
    ).bind(item.message_id).first<CopyMessageRow>();
    if (!message) return { state: 'skipped', reason: 'message_gone' };
    const rows = await db.prepare(
      `SELECT filename, content_type, size_bytes, r2_key, content_id, disposition FROM attachments WHERE message_id = ? ORDER BY id`,
    ).bind(item.message_id).all<CopyAttachmentRow>();
    attachments = rows.results ?? [];
  } catch {
    return { state: 'failed', reason: 'internal', skipTarget: false };
  }
  const folder = EXCHANGE_FOLDER[message.folder];
  if (!folder) return { state: 'skipped', reason: 'folder_not_in_scope' };
  const restoreUnread = !message.is_read;
  const unread = async (id: string): Promise<Outcome | null> => {
    if (!restoreUnread) return null;
    try {
      await graph.markUnread(item.target_object_id, id);
      return null;
    } catch (caught) {
      return graphFailure(caught, 'unread');
    }
  };

  // a. Our own earlier copy (a cut-off attempt that Exchange accepted).
  let existing;
  try {
    existing = await graph.findCopy(item.target_object_id, message.id);
  } catch (caught) {
    return graphFailure(caught, 'lookup');
  }
  if (existing) {
    if (existing.isDraft) return { state: 'halt' };
    return (await unread(existing.id)) ?? { state: 'copied', reason: 'found_marker' };
  }

  // b. The same message already in Exchange (delivered there as well), ignoring our copies.
  const internetMessageId = message.folder === 'sent' ? null : copyableMessageId(message.message_id_header);
  if (internetMessageId) {
    try {
      if (await graph.hasNativeMessage(item.target_object_id, internetMessageId)) return { state: 'skipped', reason: 'already_in_exchange' };
    } catch (caught) {
      return graphFailure(caught, 'lookup');
    }
  }

  // c. Build (reads R2; a storage error counts as an attempt on this item only).
  let built;
  try {
    built = await buildGraphMessage(env.STORAGE, message, attachments, { maxBytes });
  } catch {
    return { state: 'failed', reason: 'internal', skipTarget: false };
  }
  if (!built.ok) return { state: 'skipped', reason: built.reason };

  // d. Create, check the draft canary, then restore unread.
  let created;
  try {
    created = await graph.createMessage(item.target_object_id, folder, built.json);
  } catch (caught) {
    return graphFailure(caught, 'create');
  }
  if (created.isDraft) return { state: 'halt' };
  return (await unread(created.id)) ?? { state: 'copied', reason: 'created' };
}

export async function runCopyBackTick(env: CopyBackWorkerEnv, deps: CopyBackDeps = {}): Promise<CopyBackTickResult> {
  const db = env.DB;
  const now = deps.now ?? Date.now;
  const budgets = {
    timeMs: TICK_TIME_BUDGET_MS,
    items: TICK_ITEM_BUDGET,
    graph: TICK_GRAPH_BUDGET,
    planChunk: PLAN_CHUNK,
    workChunk: WORK_CHUNK,
    maxBytes: undefined as number | undefined,
    ...deps.budgets,
  };

  const toggle = await loadCopyBackSwitch(db);
  if (!toggle.enabled) return { status: 'off' };

  let job: CopyBackJobRow | null;
  try {
    job = await db.prepare(`SELECT * FROM standby_copyback_jobs WHERE status = 'running' LIMIT 1`).first<CopyBackJobRow>();
  } catch {
    // Migration 0024 has not been applied to this database.
    return { status: 'not_installed' };
  }
  if (!job) return { status: 'idle' };

  const startedAt = now();
  const nowSeconds = Math.floor(startedAt / 1000);
  const lease = await db.prepare(
    `UPDATE standby_copyback_jobs SET lease_until = ? WHERE id = ? AND status = 'running' AND lease_until < ?`,
  ).bind(nowSeconds + LEASE_SECONDS, job.id, nowSeconds).run();
  if (!lease.meta.changes) return { status: 'busy' };

  const counts = { copied: 0, skipped: 0, failed: 0 };
  try {
    await setJob(db, job.id, { last_tick_at: iso(startedAt) });
    const check = copyBackConfig(env);
    if (!check.configured) {
      await setJob(db, job.id, { last_result: 'not_configured', last_error_code: 'not_configured' });
      return { status: 'not_configured' };
    }
    if (job.backoff_until && Date.parse(job.backoff_until) > startedAt) return { status: 'backoff' };

    const params = jobParams(job);
    const graph = new CopyBackGraphClient({
      tenantId: check.config.tenantId,
      clientId: check.config.clientId,
      clientSecret: check.config.clientSecret,
      fetcher: deps.fetcher,
      sleep: deps.sleep,
      now,
    });
    const withinTime = () => now() - startedAt < budgets.timeMs;

    while (!job.plan_done && withinTime()) await planChunk(db, job, params, budgets.planChunk);
    if (!job.plan_done) {
      await setJob(db, job.id, { last_result: 'running', last_error_code: '' });
      return { status: 'worked', ...counts, done: false };
    }

    try {
      await graph.ensureToken();
    } catch (caught) {
      if (caught instanceof GraphError) throw new RunStop(caught);
      throw caught;
    }

    let processed = 0;
    let networkErrors = 0;
    // Mailboxes that were throttled or failed this tick: their other items wait for the next one.
    const skippedTargets = new Set<string>();
    let cursor: Cursor = null;
    let exhausted = false;
    let stopped = false;
    let halted = false;
    const nowDb = dbTime(startedAt);
    work: while (withinTime() && processed < budgets.items && graph.requests < budgets.graph) {
      const batch = await dueItems(db, params, nowDb, budgets.workChunk, cursor);
      if (!batch.length) {
        exhausted = true;
        break;
      }
      for (const item of batch) {
        cursor = [item.attempts, item.received_at, item.message_id, item.target_object_id];
        if (skippedTargets.has(item.target_object_id)) continue;
        if (!withinTime() || processed >= budgets.items || graph.requests >= budgets.graph) break work;
        if (!await stillRunning(db, job.id)) {
          stopped = true;
          break work;
        }
        const outcome = await copyOne(env, graph, item, budgets.maxBytes);
        if (outcome.state === 'halt') {
          // Draft canary: record this item as given up and stop the job.
          await recordOutcome(db, job.id, item, { state: 'failed', reason: 'created_as_draft', skipTarget: true, final: true }, now());
          counts.failed += 1;
          await db.prepare(`UPDATE standby_copyback_jobs SET status = 'halted', finished_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ? AND status = 'running'`).bind(job.id).run();
          console.error('Standby copy-back halted: Exchange created a draft instead of a received item');
          halted = true;
          break work;
        }
        if (outcome.state === 'deferred') {
          skippedTargets.add(item.target_object_id);
          continue;
        }
        await recordOutcome(db, job.id, item, outcome, now());
        processed += 1;
        counts[outcome.state] += 1;
        if (outcome.state === 'failed' && outcome.skipTarget) skippedTargets.add(item.target_object_id);
        if (outcome.state === 'failed' && outcome.network && ++networkErrors >= MAX_NETWORK_ERRORS_PER_TICK) {
          throw new RunStop(new GraphError('network', 0));
        }
      }
    }

    if (halted) {
      await setJob(db, job.id, { last_result: 'halted', last_error_code: 'created_as_draft' });
      return { status: 'halted', ...counts, done: false };
    }
    if (stopped) {
      await setJob(db, job.id, { last_result: 'stopped', last_error_code: '' });
      return { status: 'stopped', ...counts, done: false };
    }
    let done = false;
    if (exhausted && await remainingWork(db, params) === 0) {
      done = (await db.prepare(`UPDATE standby_copyback_jobs SET status = 'done', finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'running'`).bind(job.id).run()).meta.changes > 0;
    }
    await setJob(db, job.id, { last_result: done ? 'done' : 'running', last_error_code: '', backoff_streak: 0, backoff_until: null });
    return { status: 'worked', ...counts, done };
  } catch (caught) {
    const at = now();
    const graphError = caught instanceof RunStop ? caught.cause : caught instanceof GraphError ? caught : null;
    let code = 'internal';
    let wait: number | null = null;
    if (graphError) {
      code = graphError.code;
      if (graphError.code === 'throttled' || graphError.code === 'network') wait = graphError.retryAfterSeconds;
      else if (graphError.code === 'unauthorized' || graphError.code === 'credentials_rejected') wait = AUTH_BACKOFF_SECONDS;
    }
    const streak = job.backoff_streak ?? 0;
    const seconds = Math.max(1, Math.min(MAX_BACKOFF_SECONDS, wait ?? 60 * 2 ** Math.min(streak, 6)));
    // Codes only: no response bodies, tokens or addresses.
    console.error('Standby copy-back tick failed', { code, status: graphError?.status ?? 0 });
    await setJob(db, job.id, {
      last_result: graphError && (graphError.code === 'throttled' || graphError.code === 'network') ? 'backoff' : 'error',
      last_error_code: code,
      backoff_streak: streak + 1,
      backoff_until: iso(at + seconds * 1000),
    }).catch(() => undefined);
    return { status: 'error', code };
  } finally {
    await db.prepare('UPDATE standby_copyback_jobs SET lease_until = 0 WHERE id = ?').bind(job.id).run().catch(() => undefined);
  }
}

/** Read-only check for Admin over the private service binding: setting names only, never values. */
export function copyBackConfigDiagnostic(env: CopyBackEnv): { configured: boolean; problems: string[] } {
  const check = copyBackConfig(env);
  return check.configured ? { configured: true, problems: [] } : { configured: false, problems: check.problems };
}
