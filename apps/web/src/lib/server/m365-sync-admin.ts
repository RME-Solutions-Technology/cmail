// Admin side of the Microsoft 365 mailbox sync (docs/m365-sync.md). The web
// app never holds the Entra credentials and never calls Microsoft: it only
// flips the manager switch in org_settings, asks the email Worker (over the
// private EMAIL_SERVICE binding) whether its settings are present, and reads
// the status row the Worker writes.
import {
  M365_SYNC_SETTING_APPROVED_ROUND,
  M365_SYNC_SETTING_DRY_RUN,
  M365_SYNC_SETTING_ENABLED,
  M365_SYNC_SETTING_REQUESTED_AT,
  loadM365SyncState,
  loadM365SyncSwitch,
  m365StatusView,
  type M365StatusView,
  type M365SyncSwitch,
} from '@cmail/shared/m365-sync';
import { audit } from './db';

export type M365ConfigStatus =
  | { state: 'configured' }
  | { state: 'not_configured'; problems: string[] }
  /** No EMAIL_SERVICE binding, or the Worker did not answer: the Worker reports on its next run. */
  | { state: 'unknown' };

export interface M365SyncOverview {
  toggle: M365SyncSwitch;
  config: M365ConfigStatus;
  /** False until migration 0022 is applied. */
  installed: boolean;
  /** Display fields only: no Graph links or unapplied page data reach the page. */
  status: M365StatusView | null;
  linkedPeople: number;
  linkedShared: number;
}

const CONFIG_URL = 'https://cmail-email-worker.internal/internal/m365-sync/config';
const MAX_PROBLEMS = 10;

function isFetcher(value: unknown): value is Fetcher {
  return Boolean(value) && typeof (value as Fetcher).fetch === 'function';
}

export async function workerConfigStatus(service: unknown): Promise<M365ConfigStatus> {
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

export async function loadM365SyncOverview(env: { DB: D1Database; EMAIL_SERVICE?: unknown }): Promise<M365SyncOverview> {
  const [toggle, config] = await Promise.all([loadM365SyncSwitch(env.DB), workerConfigStatus(env.EMAIL_SERVICE)]);
  try {
    const [status, counts] = await Promise.all([
      loadM365SyncState(env.DB),
      env.DB.prepare(
        `SELECT SUM(CASE WHEN kind = 'person' THEN 1 ELSE 0 END) AS people,
                SUM(CASE WHEN kind = 'shared' THEN 1 ELSE 0 END) AS shared
         FROM m365_sync_links`,
      ).first<{ people: number | null; shared: number | null }>(),
    ]);
    return { toggle, config, installed: true, status: m365StatusView(status), linkedPeople: counts?.people ?? 0, linkedShared: counts?.shared ?? 0 };
  } catch {
    return { toggle, config, installed: false, status: null, linkedPeople: 0, linkedShared: 0 };
  }
}

async function putSetting(db: D1Database, key: string, value: string, managerId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO org_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
  ).bind(key, value, managerId).run();
}

export type M365AdminAction = 'enable' | 'disable' | 'dry_run_on' | 'dry_run_off' | 'sync_now' | 'approve_round';

export function parseM365AdminAction(value: unknown): M365AdminAction | null {
  return typeof value === 'string' && ['enable', 'disable', 'dry_run_on', 'dry_run_off', 'sync_now', 'approve_round'].includes(value)
    ? value as M365AdminAction
    : null;
}

export type M365AdminResult = { ok: true; message: string } | { ok: false; status: number; error: string };

/**
 * Applies one manager action. The caller has already checked the manager
 * role. Turning the sync on is refused while the Worker reports missing
 * settings or the migration is missing; an unknown Worker state is allowed,
 * because the Worker then records "not configured" itself and changes nothing.
 */
export async function applyM365AdminAction(
  env: { DB: D1Database; EMAIL_SERVICE?: unknown },
  manager: { id: string },
  action: M365AdminAction,
  now = new Date(),
  roundId = '',
): Promise<M365AdminResult> {
  const db = env.DB;
  if (action === 'approve_round') {
    // Only the round that is held right now, named exactly: an old or guessed
    // id approves nothing.
    const state = await loadM365SyncState(db).catch(() => null);
    const held = state?.round?.phase === 'held' ? state.round : null;
    if (!held || !roundId || held.id !== roundId) return { ok: false, status: 409, error: 'There is no held change with that id. Reload the page.' };
    await putSetting(db, M365_SYNC_SETTING_APPROVED_ROUND, held.id, manager.id);
    await audit(db, {
      event_type: 'org.m365_sync_approved',
      actor_id: manager.id,
      actor_role: 'manager',
      detail: `Approved a held Microsoft 365 sync change: ${held.brake?.pauses ?? held.pauseQueue.length} pauses of ${held.brake?.linked ?? 0} linked people`,
    });
    return { ok: true, message: 'Approved. The held pauses are applied on the next run, within 15 minutes, each checked again first.' };
  }
  if (action === 'enable') {
    const overview = await loadM365SyncOverview(env);
    if (!overview.installed) return { ok: false, status: 409, error: 'Apply database migration 0022 before turning on Microsoft 365 sync' };
    if (overview.config.state === 'not_configured') {
      return { ok: false, status: 409, error: 'The email Worker is missing Microsoft 365 settings. See the list on this page.' };
    }
    await putSetting(db, M365_SYNC_SETTING_ENABLED, 'true', manager.id);
    await audit(db, {
      event_type: 'org.m365_sync_toggled',
      actor_id: manager.id,
      actor_role: 'manager',
      detail: `Microsoft 365 sync turned on (${overview.toggle.dryRun ? 'dry run' : 'live'})`,
    });
    return { ok: true, message: overview.toggle.dryRun
      ? 'Microsoft 365 sync is on in dry run. The first report appears within 15 minutes; nothing changes until you turn dry run off.'
      : 'Microsoft 365 sync is on. The first run starts within 15 minutes.' };
  }
  if (action === 'disable') {
    await putSetting(db, M365_SYNC_SETTING_ENABLED, 'false', manager.id);
    await audit(db, { event_type: 'org.m365_sync_toggled', actor_id: manager.id, actor_role: 'manager', detail: 'Microsoft 365 sync turned off' });
    return { ok: true, message: 'Microsoft 365 sync is off. Nothing runs until you turn it on again; accounts stay as they are.' };
  }
  if (action === 'dry_run_on' || action === 'dry_run_off') {
    const on = action === 'dry_run_on';
    await putSetting(db, M365_SYNC_SETTING_DRY_RUN, on ? 'true' : 'false', manager.id);
    await audit(db, {
      event_type: 'org.m365_sync_dry_run',
      actor_id: manager.id,
      actor_role: 'manager',
      detail: `Microsoft 365 sync dry run turned ${on ? 'on' : 'off'}`,
    });
    return { ok: true, message: on
      ? 'Dry run is on: the sync only reports what it would change.'
      : 'Dry run is off: the next run applies changes, starting with a full reconciliation.' };
  }
  const toggle = await loadM365SyncSwitch(db);
  if (!toggle.enabled) return { ok: false, status: 409, error: 'Turn Microsoft 365 sync on first' };
  await putSetting(db, M365_SYNC_SETTING_REQUESTED_AT, now.toISOString(), manager.id);
  await audit(db, { event_type: 'org.m365_sync_requested', actor_id: manager.id, actor_role: 'manager', detail: 'Requested a full Microsoft 365 reconciliation' });
  return { ok: true, message: 'A full reconciliation starts on the next run, within 15 minutes.' };
}
