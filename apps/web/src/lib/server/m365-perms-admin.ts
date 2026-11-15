// Admin side of shared mailbox access from Exchange Online
// (docs/m365-mailbox-permissions.md). The web app never holds the certificate
// and never calls Microsoft: it flips the manager switch in org_settings, asks
// the email Worker (over the private EMAIL_SERVICE binding) whether its
// settings are present, and reads the status row the Worker writes.
import {
  M365_PERMS_SETTING_APPROVED_ROUND,
  M365_PERMS_SETTING_DRY_RUN,
  M365_PERMS_SETTING_ENABLED,
  M365_PERMS_SETTING_REQUESTED_AT,
  loadM365PermsState,
  loadM365PermsSwitch,
  m365PermsStatusView,
  type M365PermsStatusView,
  type M365PermsSwitch,
} from '@cmail/shared/m365-perms';
import { audit } from './db';

export type M365PermsConfigStatus =
  | { state: 'configured'; groups: boolean }
  | { state: 'not_configured'; problems: string[]; groups: boolean }
  | { state: 'unknown' };

export interface M365PermsOverview {
  toggle: M365PermsSwitch;
  config: M365PermsConfigStatus;
  /** False until migration 0028 is applied. */
  installed: boolean;
  status: M365PermsStatusView | null;
  /** Assignments the sync made and still owns. */
  syncOwned: number;
}

const CONFIG_URL = 'https://cmail-email-worker.internal/internal/m365-perms/config';
const MAX_PROBLEMS = 10;

function isFetcher(value: unknown): value is Fetcher {
  return Boolean(value) && typeof (value as Fetcher).fetch === 'function';
}

export async function permsWorkerConfigStatus(service: unknown): Promise<M365PermsConfigStatus> {
  if (!isFetcher(service)) return { state: 'unknown' };
  try {
    const response = await service.fetch(CONFIG_URL, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { state: 'unknown' };
    const body = await response.json() as { configured?: unknown; problems?: unknown; groups?: unknown };
    const groups = body.groups === true;
    if (body.configured === true) return { state: 'configured', groups };
    if (body.configured !== false) return { state: 'unknown' };
    const problems = Array.isArray(body.problems)
      ? body.problems.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 200)).slice(0, MAX_PROBLEMS)
      : [];
    return { state: 'not_configured', problems, groups };
  } catch {
    return { state: 'unknown' };
  }
}

export async function loadM365PermsOverview(env: { DB: D1Database; EMAIL_SERVICE?: unknown }): Promise<M365PermsOverview> {
  const [toggle, config] = await Promise.all([loadM365PermsSwitch(env.DB), permsWorkerConfigStatus(env.EMAIL_SERVICE)]);
  try {
    const [state, owned] = await Promise.all([
      loadM365PermsState(env.DB),
      env.DB.prepare('SELECT COUNT(*) AS n FROM m365_perm_ledger').first<{ n: number }>(),
    ]);
    return { toggle, config, installed: true, status: m365PermsStatusView(state), syncOwned: Number(owned?.n ?? 0) };
  } catch {
    return { toggle, config, installed: false, status: null, syncOwned: 0 };
  }
}

async function putSetting(db: D1Database, key: string, value: string, managerId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO org_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
  ).bind(key, value, managerId).run();
}

export type M365PermsAdminAction = 'enable' | 'disable' | 'dry_run_on' | 'dry_run_off' | 'sync_now' | 'approve_round';
const ACTIONS: readonly string[] = ['enable', 'disable', 'dry_run_on', 'dry_run_off', 'sync_now', 'approve_round'];

export function parseM365PermsAdminAction(value: unknown): M365PermsAdminAction | null {
  return typeof value === 'string' && ACTIONS.includes(value) ? value as M365PermsAdminAction : null;
}

export type M365PermsAdminResult = { ok: true; message: string } | { ok: false; status: number; error: string };

/**
 * Applies one manager action. The caller has already checked the manager
 * role. Turning it on is refused while the Worker reports missing settings or
 * the migration is missing; an unknown Worker state is allowed, because the
 * Worker then records "not configured" itself and changes nothing.
 */
export async function applyM365PermsAdminAction(
  env: { DB: D1Database; EMAIL_SERVICE?: unknown },
  manager: { id: string },
  action: M365PermsAdminAction,
  now = new Date(),
  roundId = '',
): Promise<M365PermsAdminResult> {
  const db = env.DB;
  if (action === 'approve_round') {
    const state = await loadM365PermsState(db).catch(() => null);
    const held = state?.round?.phase === 'held' ? state.round : null;
    if (!held || !roundId || held.id !== roundId) return { ok: false, status: 409, error: 'There is no held change with that id. Reload the page.' };
    if (held.brake?.reason === 'empty_snapshot') {
      return { ok: false, status: 409, error: 'Exchange listed no shared mailboxes at all. Fix the cause and use Discard and collect again.' };
    }
    await putSetting(db, M365_PERMS_SETTING_APPROVED_ROUND, held.id, manager.id);
    await audit(db, {
      event_type: 'org.m365_perms_approved',
      actor_id: manager.id,
      actor_role: 'manager',
      detail: `Approved a held shared mailbox access change: ${held.brake?.removals ?? 0} removals or downgrades of ${held.brake?.ledger ?? 0} sync-made grants`,
    });
    return { ok: true, message: 'Approved. The held removals are applied on the next run, within 15 minutes, each checked again first.' };
  }
  if (action === 'enable') {
    const overview = await loadM365PermsOverview(env);
    if (!overview.installed) return { ok: false, status: 409, error: 'Apply database migration 0028 before turning on shared mailbox access' };
    if (overview.config.state === 'not_configured') {
      return { ok: false, status: 409, error: 'The email Worker is missing settings for the collector. See the list on this page.' };
    }
    await putSetting(db, M365_PERMS_SETTING_ENABLED, 'true', manager.id);
    await audit(db, {
      event_type: 'org.m365_perms_toggled',
      actor_id: manager.id,
      actor_role: 'manager',
      detail: `Shared mailbox access from Microsoft 365 turned on (${overview.toggle.dryRun ? 'dry run' : 'live'})`,
    });
    return { ok: true, message: overview.toggle.dryRun
      ? 'Shared mailbox access is on in dry run. The first report appears within about 30 minutes; nothing changes until you turn dry run off.'
      : 'Shared mailbox access is on. The first collection starts within 15 minutes.' };
  }
  if (action === 'disable') {
    await putSetting(db, M365_PERMS_SETTING_ENABLED, 'false', manager.id);
    await audit(db, { event_type: 'org.m365_perms_toggled', actor_id: manager.id, actor_role: 'manager', detail: 'Shared mailbox access from Microsoft 365 turned off' });
    return { ok: true, message: 'Shared mailbox access is off. Nothing runs; every assignment stays as it is.' };
  }
  if (action === 'dry_run_on' || action === 'dry_run_off') {
    const on = action === 'dry_run_on';
    await putSetting(db, M365_PERMS_SETTING_DRY_RUN, on ? 'true' : 'false', manager.id);
    await audit(db, {
      event_type: 'org.m365_perms_dry_run',
      actor_id: manager.id,
      actor_role: 'manager',
      detail: `Shared mailbox access dry run turned ${on ? 'on' : 'off'}`,
    });
    return { ok: true, message: on
      ? 'Dry run is on: runs only report what they would change.'
      : 'Dry run is off: the next run applies changes.' };
  }
  const toggle = await loadM365PermsSwitch(db);
  if (!toggle.enabled) return { ok: false, status: 409, error: 'Turn shared mailbox access on first' };
  await putSetting(db, M365_PERMS_SETTING_REQUESTED_AT, now.toISOString(), manager.id);
  await audit(db, { event_type: 'org.m365_perms_requested', actor_id: manager.id, actor_role: 'manager', detail: 'Requested a shared mailbox access collection now' });
  return { ok: true, message: 'A collection starts on the next run, within 15 minutes.' };
}
