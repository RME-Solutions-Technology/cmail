// Admin side of copying standby mail back into Exchange Online
// (docs/copy-back.md). The web app never holds the copy-back app's Entra
// credentials and never calls Microsoft. It flips the manager switch, runs the
// dry run (counts from D1 only), creates a job for the email Worker, and reads
// progress counts. Every action is manager-only (checked by the route) and
// audited; audit details carry counts and the window, never mail content.
import {
  COPYBACK_SETTING_ENABLED,
  COPYBACK_SETTING_LAST_DRY_RUN,
  DRY_RUN_MAX_AGE_MS,
  copyBackDryRun,
  copyBackProblems,
  copyBackProgress,
  jobParams,
  loadCopyBackSwitch,
  paramsKey,
  parseCopyBackParams,
  parseDryRunRecord,
  selectionSql,
  type CopyBackDryRunRecord,
  type CopyBackJobRow,
  type CopyBackParams,
  type CopyBackProblemRow,
  type CopyBackProgress,
  type CopyBackSwitch,
} from '@cmail/shared/copy-back';
import { audit } from './db';

export type CopyBackConfigStatus =
  | { state: 'configured' }
  | { state: 'not_configured'; problems: string[] }
  | { state: 'unknown' };

export interface CopyBackJobView {
  id: string;
  status: CopyBackJobRow['status'];
  params: CopyBackParams;
  planned: boolean;
  lastTickAt: string | null;
  lastResult: string;
  lastErrorCode: string;
  backoffUntil: string | null;
  createdAt: string;
  finishedAt: string | null;
  progress: CopyBackProgress;
  problems: CopyBackProblemRow[];
}

export interface CopyBackOverview {
  toggle: CopyBackSwitch;
  config: CopyBackConfigStatus;
  /** False until migrations 0022 and 0024 are applied. */
  installed: boolean;
  /** Linked mailboxes for the scope list: Entra object id and cmail address only. */
  mailboxes: Array<{ objectId: string; address: string }>;
  lastDryRun: CopyBackDryRunRecord | null;
  job: CopyBackJobView | null;
}

const CONFIG_URL = 'https://cmail-email-worker.internal/internal/copy-back/config';
const MAX_PROBLEMS = 10;
const MAX_MAILBOXES = 500;

function isFetcher(value: unknown): value is Fetcher {
  return Boolean(value) && typeof (value as Fetcher).fetch === 'function';
}

export async function copyBackWorkerConfig(service: unknown): Promise<CopyBackConfigStatus> {
  if (!isFetcher(service)) return { state: 'unknown' };
  try {
    const response = await service.fetch(CONFIG_URL, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { state: 'unknown' };
    const body = await response.json() as { configured?: unknown; problems?: unknown };
    if (body.configured === true) return { state: 'configured' };
    if (body.configured !== false) return { state: 'unknown' };
    const problems = Array.isArray(body.problems)
      ? body.problems.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 200)).slice(0, MAX_PROBLEMS)
      : [];
    return { state: 'not_configured', problems };
  } catch {
    return { state: 'unknown' };
  }
}

async function latestJob(db: D1Database): Promise<CopyBackJobRow | null> {
  return db.prepare(
    `SELECT * FROM standby_copyback_jobs ORDER BY (status = 'running') DESC, created_at DESC, rowid DESC LIMIT 1`,
  ).first<CopyBackJobRow>();
}

async function lastDryRun(db: D1Database): Promise<CopyBackDryRunRecord | null> {
  const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?').bind(COPYBACK_SETTING_LAST_DRY_RUN).first<{ value: string }>();
  return parseDryRunRecord(row?.value);
}

export async function loadCopyBackOverview(env: { DB: D1Database; EMAIL_SERVICE?: unknown }): Promise<CopyBackOverview> {
  const db = env.DB;
  const [toggle, config] = await Promise.all([loadCopyBackSwitch(db), copyBackWorkerConfig(env.EMAIL_SERVICE)]);
  try {
    const [job, dry, linked] = await Promise.all([
      latestJob(db),
      lastDryRun(db),
      db.prepare(
        `SELECT l.object_id AS objectId, mb.address AS address
         FROM m365_sync_links l
         JOIN mailboxes mb ON (l.kind = 'shared' AND mb.id = l.mailbox_id)
           OR (l.kind = 'person' AND mb.type = 'personal' AND mb.owner_user_id = l.user_id)
         WHERE l.source_state = 'in_scope'
         ORDER BY mb.address LIMIT ?`,
      ).bind(MAX_MAILBOXES).all<{ objectId: string; address: string }>(),
    ]);
    let jobView: CopyBackJobView | null = null;
    if (job) {
      const params = jobParams(job);
      const [progress, problems] = await Promise.all([copyBackProgress(db, params), copyBackProblems(db, params)]);
      jobView = {
        id: job.id,
        status: job.status,
        params,
        planned: job.plan_done === 1,
        lastTickAt: job.last_tick_at,
        lastResult: job.last_result,
        lastErrorCode: job.last_error_code,
        backoffUntil: job.backoff_until,
        createdAt: job.created_at,
        finishedAt: job.finished_at,
        progress,
        problems,
      };
    }
    return { toggle, config, installed: true, mailboxes: linked.results ?? [], lastDryRun: dry, job: jobView };
  } catch {
    return { toggle, config, installed: false, mailboxes: [], lastDryRun: null, job: null };
  }
}

async function putSetting(db: D1Database, key: string, value: string, managerId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO org_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
  ).bind(key, value, managerId).run();
}

export type CopyBackAdminAction = 'enable' | 'disable' | 'dry_run' | 'start' | 'cancel' | 'retry_failed';
const ACTIONS: CopyBackAdminAction[] = ['enable', 'disable', 'dry_run', 'start', 'cancel', 'retry_failed'];

export function parseCopyBackAction(value: unknown): CopyBackAdminAction | null {
  return typeof value === 'string' && (ACTIONS as string[]).includes(value) ? value as CopyBackAdminAction : null;
}

export interface CopyBackFormInput {
  from: unknown;
  to: unknown;
  target: unknown;
  folders: unknown[];
  confirm?: unknown;
}

export type CopyBackAdminResult = { ok: true; message: string } | { ok: false; status: number; error: string };

const describe = (params: CopyBackParams) =>
  `${params.from} to ${params.to} UTC, ${params.target ? 'one mailbox' : 'all linked mailboxes'}, folders ${params.folders.join('+')}`;

/**
 * Applies one manager action. The caller has already checked the manager role.
 * Start is refused unless the switch is on, the Worker is not missing
 * settings, no job is running, and a dry run of exactly these parameters was
 * made in the last 24 hours (and the manager ticked the confirmation).
 */
export async function applyCopyBackAction(
  env: { DB: D1Database; EMAIL_SERVICE?: unknown },
  manager: { id: string },
  action: CopyBackAdminAction,
  input: CopyBackFormInput = { from: '', to: '', target: '', folders: [] },
  now = new Date(),
  newId: () => string = () => crypto.randomUUID(),
): Promise<CopyBackAdminResult> {
  const db = env.DB;
  if (action === 'enable' || action === 'disable') {
    if (action === 'enable') {
      const overview = await loadCopyBackOverview(env);
      if (!overview.installed) return { ok: false, status: 409, error: 'Apply database migrations 0022 and 0024 before turning on copy-back.' };
      if (overview.config.state === 'not_configured') return { ok: false, status: 409, error: 'The email Worker is missing copy-back settings. See the list on this page.' };
    }
    await putSetting(db, COPYBACK_SETTING_ENABLED, action === 'enable' ? 'true' : 'false', manager.id);
    await audit(db, { event_type: 'org.copyback_toggled', actor_id: manager.id, actor_role: 'manager', detail: `Copy back to Exchange turned ${action === 'enable' ? 'on' : 'off'}` });
    return { ok: true, message: action === 'enable'
      ? 'Copy-back is on. Nothing is copied until you run a dry run and press Start.'
      : 'Copy-back is off. A running job pauses where it is and continues if you turn it on again.' };
  }

  if (action === 'cancel') {
    const result = await db.prepare(
      `UPDATE standby_copyback_jobs SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now') WHERE status = 'running'`,
    ).run();
    if (!result.meta.changes) return { ok: false, status: 409, error: 'No copy job is running.' };
    await audit(db, { event_type: 'org.copyback_cancelled', actor_id: manager.id, actor_role: 'manager', detail: 'Cancelled the running copy-back job. Copies already made stay in Exchange.' });
    return { ok: true, message: 'Cancelled. Messages already copied stay in Exchange; nothing else is copied.' };
  }

  if (action === 'retry_failed') {
    const job = await latestJob(db).catch(() => null);
    if (!job) return { ok: false, status: 409, error: 'There is no copy job.' };
    if (job.status === 'cancelled') return { ok: false, status: 409, error: 'That job was cancelled. Start a new one instead.' };
    const params = jobParams(job);
    const sel = selectionSql(params);
    const reset = await db.prepare(
      `UPDATE standby_copyback_items SET state = 'pending', attempts = 0, next_attempt_at = NULL, reason = '', updated_at = datetime('now')
       WHERE state = 'failed' AND (message_id, target_object_id) IN (SELECT m.id, l.object_id FROM ${sel.from} WHERE ${sel.where})`,
    ).bind(...sel.binds).run();
    if (!reset.meta.changes) return { ok: false, status: 409, error: 'There are no failed messages to retry.' };
    if (job.status === 'done') {
      try {
        await db.prepare(`UPDATE standby_copyback_jobs SET status = 'running', finished_at = NULL, backoff_until = NULL, backoff_streak = 0, updated_at = datetime('now')
          WHERE id = ? AND status = 'done'`).bind(job.id).run();
      } catch {
        return { ok: false, status: 409, error: 'Another copy job is running. Retry when it has finished.' };
      }
    }
    await audit(db, { event_type: 'org.copyback_retry', actor_id: manager.id, actor_role: 'manager', detail: `Retrying ${reset.meta.changes} failed copy-back messages` });
    return { ok: true, message: `${reset.meta.changes} failed messages will be tried again within 15 minutes.` };
  }

  const parsed = parseCopyBackParams(input, now.getTime());
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const params = parsed.params;
  let installed = true;

  if (action === 'dry_run') {
    let counts;
    try {
      counts = await copyBackDryRun(db, params);
    } catch {
      installed = false;
    }
    if (!installed || !counts) return { ok: false, status: 409, error: 'Apply database migrations 0022 and 0024 first.' };
    const record: CopyBackDryRunRecord = { key: paramsKey(params), params, counts, at: now.toISOString() };
    await putSetting(db, COPYBACK_SETTING_LAST_DRY_RUN, JSON.stringify(record), manager.id);
    await audit(db, {
      event_type: 'org.copyback_dry_run',
      actor_id: manager.id,
      actor_role: 'manager',
      detail: `Copy-back dry run (${describe(params)}): ${counts.selected} selected, ${counts.toCopy} to copy, ${counts.alreadyCopied} already copied, ${counts.unlinked} not linked`,
    });
    return { ok: true, message: `Dry run: ${counts.toCopy} of ${counts.selected} messages would be copied to ${counts.mailboxes} mailboxes. Nothing was changed.` };
  }

  // start
  const toggle = await loadCopyBackSwitch(db);
  if (!toggle.enabled) return { ok: false, status: 409, error: 'Turn copy-back on first.' };
  if (input.confirm !== 'yes') return { ok: false, status: 400, error: 'Tick the box to confirm the copy.' };
  const config = await copyBackWorkerConfig(env.EMAIL_SERVICE);
  if (config.state === 'not_configured') return { ok: false, status: 409, error: 'The email Worker is missing copy-back settings.' };
  const dry = await lastDryRun(db).catch(() => null);
  if (!dry || dry.key !== paramsKey(params) || now.getTime() - Date.parse(dry.at) > DRY_RUN_MAX_AGE_MS || Date.parse(dry.at) > now.getTime()) {
    return { ok: false, status: 409, error: 'Run a dry run with exactly these settings first (it is valid for 24 hours).' };
  }
  const counts = await copyBackDryRun(db, params);
  if (counts.toCopy === 0) return { ok: false, status: 409, error: 'Nothing to copy: every selected message was already handled.' };
  const id = newId();
  try {
    await db.prepare(
      `INSERT INTO standby_copyback_jobs (id, status, window_from, window_to, target_object_id, folders, created_by)
       VALUES (?, 'running', ?, ?, ?, ?, ?)`,
    ).bind(id, params.from, params.to, params.target, params.folders.join(','), manager.id).run();
  } catch {
    return { ok: false, status: 409, error: 'A copy job is already running. Cancel it or wait for it to finish.' };
  }
  await audit(db, {
    event_type: 'org.copyback_started',
    actor_id: manager.id,
    actor_role: 'manager',
    target: id,
    detail: `Started copy back to Exchange (${describe(params)}): ${counts.toCopy} messages to copy`,
  });
  return { ok: true, message: `Started. ${counts.toCopy} messages are copied in the background, starting within 15 minutes.` };
}
