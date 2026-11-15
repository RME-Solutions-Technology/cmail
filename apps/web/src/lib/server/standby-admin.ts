// Admin side of the standby test address and daily probe
// (docs/standby-probe.md). The web app never sends the probe itself: it flips
// the manager switch in org_settings, asks the email Worker (over the private
// EMAIL_SERVICE binding) for its settings or to run a test now, and reads the
// results the Worker writes.
import {
  STANDBY_DEFAULT_TIMEOUT_MINUTES,
  STANDBY_SETTING_ENABLED,
  loadStandbyRuns,
  loadStandbySwitch,
  standbyStatusView,
  type StandbyRun,
  type StandbyStatusView,
} from '@cmail/shared/standby';
import { audit } from './db';

export type StandbyWorkerConfig =
  | { state: 'configured'; canSend: boolean; standbyDomain: string; probeAddress: string; timeoutMinutes: number }
  | { state: 'not_configured'; canSend: boolean; problems: string[] }
  /** No EMAIL_SERVICE binding, or the Worker did not answer. */
  | { state: 'unknown' };

export interface StandbyOverview {
  enabled: boolean;
  config: StandbyWorkerConfig;
  /** False until migration 0023 is applied. */
  installed: boolean;
  view: StandbyStatusView;
  /** The last 7 days, newest first. */
  runs: StandbyRun[];
  timeoutMinutes: number;
  now: number;
}

const WORKER = 'https://cmail-email-worker.internal';
const DAY_MS = 24 * 60 * 60 * 1000;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function isFetcher(value: unknown): value is Fetcher {
  return Boolean(value) && typeof (value as Fetcher).fetch === 'function';
}

export async function standbyWorkerConfig(service: unknown): Promise<StandbyWorkerConfig> {
  if (!isFetcher(service)) return { state: 'unknown' };
  try {
    const response = await service.fetch(`${WORKER}/internal/standby/config`, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { state: 'unknown' };
    const body = await response.json() as Record<string, unknown>;
    const canSend = body.canSend === true;
    if (body.configured === false) {
      const problems = Array.isArray(body.problems)
        ? body.problems.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 200)).slice(0, 10)
        : [];
      return { state: 'not_configured', canSend, problems };
    }
    if (body.configured !== true) return { state: 'unknown' };
    const standbyDomain = typeof body.standbyDomain === 'string' && DOMAIN.test(body.standbyDomain) ? body.standbyDomain : '';
    const probeAddress = typeof body.probeAddress === 'string' && body.probeAddress.length <= 320 && body.probeAddress.endsWith(`@${standbyDomain}`)
      ? body.probeAddress
      : '';
    const timeout = Number(body.timeoutMinutes);
    if (!standbyDomain || !probeAddress) return { state: 'unknown' };
    return {
      state: 'configured',
      canSend,
      standbyDomain,
      probeAddress,
      timeoutMinutes: Number.isInteger(timeout) && timeout >= 2 && timeout <= 60 ? timeout : STANDBY_DEFAULT_TIMEOUT_MINUTES,
    };
  } catch {
    return { state: 'unknown' };
  }
}

export async function loadStandbyOverview(
  env: { DB: D1Database; EMAIL_SERVICE?: unknown },
  now = Date.now(),
): Promise<StandbyOverview> {
  const [enabled, config] = await Promise.all([
    loadStandbySwitch(env.DB).catch(() => false),
    standbyWorkerConfig(env.EMAIL_SERVICE),
  ]);
  const timeoutMinutes = config.state === 'configured' ? config.timeoutMinutes : STANDBY_DEFAULT_TIMEOUT_MINUTES;
  let runs: StandbyRun[] = [];
  let installed = true;
  try {
    runs = await loadStandbyRuns(env.DB, now - 7 * DAY_MS);
  } catch {
    installed = false;
  }
  return { enabled, config, installed, view: standbyStatusView({ enabled, runs, now, timeoutMinutes }), runs, timeoutMinutes, now };
}

export type StandbyAdminAction = 'enable' | 'disable' | 'run_now';

export function parseStandbyAdminAction(value: unknown): StandbyAdminAction | null {
  return value === 'enable' || value === 'disable' || value === 'run_now' ? value : null;
}

export type StandbyAdminResult = { ok: true; message: string } | { ok: false; status: number; error: string };

async function putSwitch(db: D1Database, on: boolean, managerId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO org_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
  ).bind(STANDBY_SETTING_ENABLED, on ? 'true' : 'false', managerId).run();
}

const RUN_MESSAGES: Record<string, StandbyAdminResult> = {
  started: { ok: true, message: 'Test sent. The result appears here when it arrives, usually within a minute.' },
  busy: { ok: false, status: 409, error: 'A test is already running. Wait for its result.' },
  too_soon: { ok: false, status: 429, error: 'A test was started less than a minute ago. Try again shortly.' },
  off: { ok: false, status: 409, error: 'Turn the standby address on first.' },
  not_configured: { ok: false, status: 409, error: 'The email Worker is missing standby settings. See the list on this page.' },
};

/**
 * Applies one manager action. The caller has already checked the manager
 * role. Turning on is refused while the migration is missing or the Worker
 * reports missing settings; an unknown Worker state is allowed, because the
 * Worker then records "not configured" itself and delivers nothing.
 */
export async function applyStandbyAdminAction(
  env: { DB: D1Database; EMAIL_SERVICE?: unknown },
  manager: { id: string },
  action: StandbyAdminAction,
): Promise<StandbyAdminResult> {
  const db = env.DB;
  if (action === 'enable') {
    const overview = await loadStandbyOverview(env);
    if (!overview.installed) return { ok: false, status: 409, error: 'Apply database migration 0023 before turning on the standby address' };
    if (overview.config.state === 'not_configured') {
      return { ok: false, status: 409, error: 'The email Worker is missing standby settings. See the list on this page.' };
    }
    await putSwitch(db, true, manager.id);
    await audit(db, { event_type: 'org.standby_toggled', actor_id: manager.id, actor_role: 'manager', detail: 'Standby address and daily test turned on' });
    return { ok: true, message: 'The standby address is on. The first test runs within 10 minutes, or use Run test now.' };
  }
  if (action === 'disable') {
    await putSwitch(db, false, manager.id);
    await audit(db, { event_type: 'org.standby_toggled', actor_id: manager.id, actor_role: 'manager', detail: 'Standby address and daily test turned off' });
    return { ok: true, message: 'The standby address is off. Mail to it is refused and no tests run.' };
  }
  if (!await loadStandbySwitch(db).catch(() => false)) return RUN_MESSAGES.off as StandbyAdminResult;
  if (!isFetcher(env.EMAIL_SERVICE)) return { ok: false, status: 503, error: 'The email Worker cannot be reached from this site (no EMAIL_SERVICE binding).' };
  let status: string;
  try {
    const response = await env.EMAIL_SERVICE.fetch(`${WORKER}/internal/standby/run`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as { status?: unknown; reason?: unknown };
    status = typeof body.status === 'string' ? body.status : '';
    await audit(db, {
      event_type: 'org.standby_test_requested',
      actor_id: manager.id,
      actor_role: 'manager',
      detail: `Ran the standby test now: ${status || 'no answer'}${typeof body.reason === 'string' ? ` (${body.reason.slice(0, 64)})` : ''}`,
    });
  } catch {
    await audit(db, {
      event_type: 'org.standby_test_requested',
      actor_id: manager.id,
      actor_role: 'manager',
      detail: 'Ran the standby test now: no answer from the email Worker',
    });
    return { ok: false, status: 503, error: 'The email Worker did not answer. Try again in a minute.' };
  }
  if (status === 'failed') return { ok: false, status: 502, error: 'The test failed before it left. The reason is shown below.' };
  return RUN_MESSAGES[status] ?? { ok: false, status: 502, error: 'The email Worker gave an unexpected answer.' };
}
