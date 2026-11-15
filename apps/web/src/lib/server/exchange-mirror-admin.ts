// Admin side of the Exchange mirror and the Microsoft 365 alias import
// (docs/exchange-mirror.md). The web app never reads journal reports itself:
// it flips the two manager switches in org_settings, asks the email Worker
// (over the private EMAIL_SERVICE binding) which settings it has, and reads
// the counts the Worker writes.
import {
  EXCHANGE_MIRROR_SETTING_ENABLED,
  M365_ALIAS_SYNC_SETTING_ENABLED,
  loadAliasSyncState,
  loadAliasSyncSwitch,
  loadExchangeMirrorDays,
  loadExchangeMirrorSwitch,
  mirrorDay,
  type AliasSyncState,
  type ExchangeMirrorDay,
} from '@cmail/shared/exchange-mirror';
import { loadM365SyncSwitch } from '@cmail/shared/m365-sync';
import { audit } from './db';

export type ExchangeMirrorWorkerConfig =
  | { state: 'configured'; maskedAddress: string; senderDomains: string[]; requireAuth: boolean; mirrorSent: boolean; tenantCheck: boolean }
  | { state: 'not_configured'; problems: string[] }
  /** No EMAIL_SERVICE binding, or the Worker did not answer. */
  | { state: 'unknown' };

export interface ExchangeMirrorOverview {
  enabled: boolean;
  aliasEnabled: boolean;
  /** False until migration 0027 is applied. */
  installed: boolean;
  config: ExchangeMirrorWorkerConfig;
  /** The last 7 UTC days, newest first. */
  days: ExchangeMirrorDay[];
  lastReportAt: number | null;
  sync: { enabled: boolean; dryRun: boolean };
  aliasState: AliasSyncState | null;
  aliasCount: number;
  now: number;
}

const WORKER = 'https://cmail-email-worker.internal';
const DAY_MS = 24 * 60 * 60 * 1000;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MASKED = /^(?:journal-[a-z0-9]{4})?…@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function isFetcher(value: unknown): value is Fetcher {
  return Boolean(value) && typeof (value as Fetcher).fetch === 'function';
}

export async function exchangeMirrorWorkerConfig(service: unknown): Promise<ExchangeMirrorWorkerConfig> {
  if (!isFetcher(service)) return { state: 'unknown' };
  try {
    const response = await service.fetch(`${WORKER}/internal/exchange-mirror/config`, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { state: 'unknown' };
    const body = await response.json() as Record<string, unknown>;
    if (body.configured === false) {
      const problems = Array.isArray(body.problems)
        ? body.problems.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 200)).slice(0, 10)
        : [];
      return { state: 'not_configured', problems };
    }
    if (body.configured !== true) return { state: 'unknown' };
    const maskedAddress = typeof body.maskedAddress === 'string' && MASKED.test(body.maskedAddress) ? body.maskedAddress : '';
    const senderDomains = Array.isArray(body.senderDomains)
      ? body.senderDomains.filter((item): item is string => typeof item === 'string' && DOMAIN.test(item)).slice(0, 10)
      : [];
    if (!maskedAddress || !senderDomains.length) return { state: 'unknown' };
    return {
      state: 'configured',
      maskedAddress,
      senderDomains,
      requireAuth: body.requireAuth !== false,
      mirrorSent: body.mirrorSent === true,
      tenantCheck: body.tenantCheck === true,
    };
  } catch {
    return { state: 'unknown' };
  }
}

export async function loadExchangeMirrorOverview(
  env: { DB: D1Database; EMAIL_SERVICE?: unknown },
  now = Date.now(),
): Promise<ExchangeMirrorOverview> {
  const db = env.DB;
  const [enabled, aliasEnabled, config, sync] = await Promise.all([
    loadExchangeMirrorSwitch(db).catch(() => false),
    loadAliasSyncSwitch(db).catch(() => false),
    exchangeMirrorWorkerConfig(env.EMAIL_SERVICE),
    loadM365SyncSwitch(db).catch(() => ({ enabled: false, dryRun: true })),
  ]);
  let installed = true;
  let days: ExchangeMirrorDay[] = [];
  let aliasState: AliasSyncState | null = null;
  let aliasCount = 0;
  try {
    days = await loadExchangeMirrorDays(db, mirrorDay(now - 6 * DAY_MS));
    aliasState = await loadAliasSyncState(db);
    const row = await db.prepare('SELECT COUNT(*) AS n FROM mailbox_aliases').first<{ n: number }>();
    aliasCount = Number(row?.n ?? 0);
  } catch {
    installed = false;
  }
  let lastReportAt: number | null = null;
  if (installed) {
    const row = await db.prepare('SELECT MAX(last_report_at) AS at FROM exchange_mirror_days').first<{ at: number | null }>().catch(() => null);
    lastReportAt = row?.at == null ? null : Number(row.at);
  }
  return {
    enabled,
    aliasEnabled,
    installed,
    config,
    days,
    lastReportAt,
    sync: { enabled: sync.enabled, dryRun: sync.dryRun },
    aliasState,
    aliasCount,
    now,
  };
}

export type ExchangeMirrorAdminAction = 'enable' | 'disable' | 'alias_enable' | 'alias_disable';

export function parseExchangeMirrorAdminAction(value: unknown): ExchangeMirrorAdminAction | null {
  return value === 'enable' || value === 'disable' || value === 'alias_enable' || value === 'alias_disable' ? value : null;
}

export type ExchangeMirrorAdminResult = { ok: true; message: string } | { ok: false; status: number; error: string };

async function putSetting(db: D1Database, key: string, on: boolean, managerId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO org_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
  ).bind(key, on ? 'true' : 'false', managerId).run();
}

/**
 * Applies one manager action. The caller has already checked the manager
 * role. Turning the mirror on is refused while the migration is missing or
 * the Worker reports missing settings; an unknown Worker state is allowed,
 * because the Worker then refuses every report itself ('not_configured').
 */
export async function applyExchangeMirrorAdminAction(
  env: { DB: D1Database; EMAIL_SERVICE?: unknown },
  manager: { id: string },
  action: ExchangeMirrorAdminAction,
): Promise<ExchangeMirrorAdminResult> {
  const db = env.DB;
  const actor = { actor_id: manager.id, actor_role: 'manager' as const };
  if (action === 'enable' || action === 'alias_enable') {
    const overview = await loadExchangeMirrorOverview(env);
    if (!overview.installed) return { ok: false, status: 409, error: 'Apply database migration 0027 first' };
    if (action === 'enable') {
      if (overview.config.state === 'not_configured') {
        return { ok: false, status: 409, error: 'The email Worker is missing Exchange mirror settings. See the list on this page.' };
      }
      await putSetting(db, EXCHANGE_MIRROR_SETTING_ENABLED, true, manager.id);
      await audit(db, { event_type: 'org.exchange_mirror_toggled', ...actor, detail: 'Exchange mirror turned on' });
      return { ok: true, message: 'The Exchange mirror is on. Journal reports to the journal address are filed into mailboxes.' };
    }
    await putSetting(db, M365_ALIAS_SYNC_SETTING_ENABLED, true, manager.id);
    await audit(db, { event_type: 'org.m365_alias_sync_toggled', ...actor, detail: 'Microsoft 365 alias import turned on' });
    return { ok: true, message: 'The alias import is on. It runs with the Microsoft 365 sync (live, not dry run).' };
  }
  if (action === 'disable') {
    await putSetting(db, EXCHANGE_MIRROR_SETTING_ENABLED, false, manager.id);
    await audit(db, { event_type: 'org.exchange_mirror_toggled', ...actor, detail: 'Exchange mirror turned off' });
    return { ok: true, message: 'The Exchange mirror is off. Mail to the journal address is refused like any unknown address.' };
  }
  await putSetting(db, M365_ALIAS_SYNC_SETTING_ENABLED, false, manager.id);
  await audit(db, { event_type: 'org.m365_alias_sync_toggled', ...actor, detail: 'Microsoft 365 alias import turned off' });
  return { ok: true, message: 'The alias import is off. Aliases already imported stay until you remove them or turn it on again.' };
}
