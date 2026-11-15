// Scheduled driver for copying standby mail back into Exchange Online
// (docs/copy-back.md). Runs on the email Worker's */15 cron, beside the
// Microsoft 365 sync.
//
// Every tick:
// 1. Reads the Admin switch. Off = return at once: no Graph call, no write.
// 2. Finds the one running job (a manager started it after a dry run) and
//    takes a lease on it, so overlapping invocations never work it together.
// 3. Plans: queues the job's messages as 'pending' items in chunks, keyed by
//    (cmail message id, Entra object id). INSERT OR IGNORE means an item that
//    already exists, above all one already 'copied', is never reset.
// 4. Works due items (pending, or failed with a retry due), bounded by time,
//    item count and Graph requests. For each item:
//      a. look for our marker in the mailbox: found = already copied (the
//         last attempt was cut off after Exchange accepted it);
//      b. look for the same Message-ID: found = Exchange already has it, skip;
//      c. build the message; too big for one request = skip;
//      d. create it, then restore "unread" if it was unread in cmail;
//      e. record the outcome. A copied item is final (triggers in 0024).
//    Throttling, network and credential errors stop the tick and back off the
//    whole job; the item stays due and is retried next tick, where step (a)
//    makes the retry safe. A 403/404 on one mailbox fails that item with a
//    backoff and skips the rest of that mailbox for this tick.
// 5. Marks the job done when nothing is left to try.
//
// Logs and status carry counts and short codes only: never subjects,
// addresses, bodies, Graph ids or tokens.
import {
  COPYBACK_MAX_ATTEMPTS,
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
/** D1 allows 100 bound parameters per statement; stop the tick before the exclusion list nears it. */
const MAX_SKIPPED_TARGETS = 40;
const WORK_CHUNK = 50;
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
  | { status: 'worked'; copied: number; skipped: number; failed: number; done: boolean }
  | { status: 'error'; code: string };

const iso = (ms: number) => new Date(ms).toISOString();
const dbTime = (ms: number) => iso(ms).slice(0, 19).replace('T', ' ');

interface DueItem {
  message_id: string;
  target_object_id: string;
  attempts: number;
}

type Outcome =
  | { state: 'copied'; reason: 'created' | 'found_marker' }
  | { state: 'skipped'; reason: string }
  | { state: 'failed'; reason: string; skipTarget: boolean };

async function setJob(db: D1Database, id: string, fields: Partial<Record<keyof CopyBackJobRow, string | number | null>>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  await db.prepare(`UPDATE standby_copyback_jobs SET ${assignments}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...keys.map((key) => fields[key as keyof CopyBackJobRow] ?? null), id).run();
}

/** Queues up to PLAN_CHUNK more items. Returns true when the selection is fully queued. */
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

async function dueItems(db: D1Database, params: CopyBackParams, nowDb: string, limit: number, excluded: string[]): Promise<DueItem[]> {
  const sel = selectionSql(params);
  const exclude = excluded.length ? `AND l.object_id NOT IN (${excluded.map(() => '?').join(', ')})` : '';
  const { results } = await db.prepare(
    `SELECT i.message_id, i.target_object_id, i.attempts FROM ${sel.from}
     JOIN standby_copyback_items i ON i.message_id = m.id AND i.target_object_id = l.object_id
     WHERE ${sel.where} ${exclude}
       AND (i.state = 'pending' OR (i.state = 'failed' AND i.next_attempt_at IS NOT NULL AND i.next_attempt_at <= ?))
     ORDER BY l.object_id, m.received_at, m.id
     LIMIT ?`,
  ).bind(...sel.binds, ...excluded, nowDb, limit).all<DueItem>();
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
  } else {
    const attempts = item.attempts + 1;
    const next = attempts >= COPYBACK_MAX_ATTEMPTS ? null : dbTime(now + ITEM_BACKOFF_BASE_MS * 2 ** (attempts - 1));
    await db.prepare(`UPDATE standby_copyback_items SET state = 'failed', reason = ?, job_id = ?, attempts = ?, next_attempt_at = ?,
      updated_at = datetime('now') ${where}`)
      .bind(outcome.reason.slice(0, 64), jobId, attempts, next, item.message_id, item.target_object_id).run();
  }
}

/** Per-item Graph failures. Anything that affects the whole run is rethrown. */
function itemFailure(caught: unknown): Outcome {
  if (!(caught instanceof GraphError)) throw caught;
  if (caught.code === 'unauthorized' && caught.status === 403) return { state: 'failed', reason: 'access_denied', skipTarget: true };
  if (caught.code === 'http_error' && caught.status === 404) return { state: 'failed', reason: 'mailbox_not_found', skipTarget: true };
  if (caught.code === 'http_error' && caught.status === 413) return { state: 'skipped', reason: 'too_large' };
  if (caught.code === 'http_error' && (caught.status === 400 || caught.status === 422)) return { state: 'failed', reason: 'rejected', skipTarget: false };
  if (caught.code === 'http_error') return { state: 'failed', reason: `http_${caught.status}`, skipTarget: false };
  if (caught.code === 'bad_response') return { state: 'failed', reason: 'bad_response', skipTarget: false };
  // throttled, network, credentials_rejected, 401, resync_required: whole run.
  throw caught;
}

async function copyOne(
  env: CopyBackWorkerEnv,
  graph: CopyBackGraphClient,
  item: DueItem,
  maxBytes: number | undefined,
): Promise<Outcome> {
  const db = env.DB;
  const message = await db.prepare(
    `SELECT id, folder, from_address, from_name, to_participants, cc_participants, reply_to_participants,
            to_addresses, cc_addresses, subject, body_r2_key, is_read, importance, message_id_header,
            in_reply_to, references_header, received_at, size_bytes
     FROM messages WHERE id = ?`,
  ).bind(item.message_id).first<CopyMessageRow>();
  if (!message) return { state: 'skipped', reason: 'message_gone' };
  const folder = EXCHANGE_FOLDER[message.folder];
  if (!folder) return { state: 'skipped', reason: 'folder_not_in_scope' };
  const { results: attachments } = await db.prepare(
    `SELECT filename, content_type, size_bytes, r2_key, content_id, disposition FROM attachments WHERE message_id = ? ORDER BY id`,
  ).bind(item.message_id).all<CopyAttachmentRow>();
  const restoreUnread = !message.is_read;

  try {
    // a. Our own earlier copy (a cut-off attempt that Exchange accepted).
    const existing = await graph.findCopy(item.target_object_id, message.id);
    if (existing) {
      if (restoreUnread) await graph.markUnread(item.target_object_id, existing);
      return { state: 'copied', reason: 'found_marker' };
    }
    // b. The same message already in Exchange (delivered there as well).
    const internetMessageId = message.folder === 'sent' ? null : copyableMessageId(message.message_id_header);
    if (internetMessageId && await graph.findByInternetMessageId(item.target_object_id, internetMessageId)) {
      return { state: 'skipped', reason: 'already_in_exchange' };
    }
    // c. Build. d. Create, then restore unread.
    const built = await buildGraphMessage(env.STORAGE, message, attachments ?? [], { maxBytes });
    if (!built.ok) return { state: 'skipped', reason: built.reason };
    const created = await graph.createMessage(item.target_object_id, folder, built.json);
    if (restoreUnread) await graph.markUnread(item.target_object_id, created);
    return { state: 'copied', reason: 'created' };
  } catch (caught) {
    return itemFailure(caught);
  }
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

    let processed = 0;
    // Mailboxes that answered 403/404 this tick: their other items wait for the next one.
    const skippedTargets = new Set<string>();
    let exhausted = false;
    while (job.plan_done && withinTime() && processed < budgets.items && graph.requests < budgets.graph
      && skippedTargets.size <= MAX_SKIPPED_TARGETS) {
      const batch = await dueItems(db, params, dbTime(now()), budgets.workChunk, [...skippedTargets]);
      if (!batch.length) {
        exhausted = true;
        break;
      }
      for (const item of batch) {
        if (!withinTime() || processed >= budgets.items || graph.requests >= budgets.graph) break;
        if (skippedTargets.has(item.target_object_id)) continue;
        const outcome = await copyOne(env, graph, item, budgets.maxBytes);
        await recordOutcome(db, job.id, item, outcome, now());
        processed += 1;
        counts[outcome.state] += 1;
        if (outcome.state === 'failed' && outcome.skipTarget) skippedTargets.add(item.target_object_id);
      }
    }

    let done = false;
    if (job.plan_done && exhausted && await remainingWork(db, params) === 0) {
      done = true;
      await db.prepare(`UPDATE standby_copyback_jobs SET status = 'done', finished_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'running'`).bind(job.id).run();
    }
    await setJob(db, job.id, { last_result: done ? 'done' : 'running', last_error_code: '', backoff_streak: 0, backoff_until: null });
    return { status: 'worked', ...counts, done };
  } catch (caught) {
    const at = now();
    let code = 'internal';
    let wait: number | null = null;
    if (caught instanceof GraphError) {
      code = caught.code === 'unauthorized' ? 'unauthorized' : caught.code;
      if (caught.code === 'throttled' || caught.code === 'network') wait = caught.retryAfterSeconds;
      else if (caught.code === 'unauthorized' || caught.code === 'credentials_rejected') wait = AUTH_BACKOFF_SECONDS;
    }
    const streak = job.backoff_streak ?? 0;
    const seconds = Math.max(1, Math.min(MAX_BACKOFF_SECONDS, wait ?? 60 * 2 ** Math.min(streak, 6)));
    // Codes only: no response bodies, tokens or addresses.
    console.error('Standby copy-back tick failed', { code, status: caught instanceof GraphError ? caught.status : 0 });
    await setJob(db, job.id, {
      last_result: caught instanceof GraphError && (caught.code === 'throttled' || caught.code === 'network') ? 'backoff' : 'error',
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
