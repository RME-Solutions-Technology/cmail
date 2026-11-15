// Microsoft 365 mailbox sync: the parts both the web app (Admin switch and
// status) and the email Worker (the scheduled sync) need. The design and its
// reasons are in docs/m365-sync.md.
//
// Nothing here talks to Microsoft. The Worker holds the Entra credentials; the
// web app only reads and writes the switch in org_settings and reads the
// status row the Worker writes.

/** org_settings keys. Absent = default. */
export const M365_SYNC_SETTING_ENABLED = 'm365_sync_enabled';
export const M365_SYNC_SETTING_DRY_RUN = 'm365_sync_dry_run';
export const M365_SYNC_SETTING_REQUESTED_AT = 'm365_sync_requested_at';

export interface M365SyncSwitch {
  /** Off by default: the cron does nothing until a manager turns it on. */
  enabled: boolean;
  /** On by default, so the first run after switching on only reports. */
  dryRun: boolean;
  /** ISO time of the last "Sync now" request, or ''. */
  requestedAt: string;
}

export function parseM365SyncSwitch(rows: Array<{ key: string; value: string }>): M365SyncSwitch {
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const requested = map.get(M365_SYNC_SETTING_REQUESTED_AT) ?? '';
  return {
    enabled: map.get(M365_SYNC_SETTING_ENABLED) === 'true',
    dryRun: map.get(M365_SYNC_SETTING_DRY_RUN) !== 'false',
    requestedAt: isIsoTime(requested) ? requested : '',
  };
}

export async function loadM365SyncSwitch(db: D1Database): Promise<M365SyncSwitch> {
  const { results } = await db.prepare(
    'SELECT key, value FROM org_settings WHERE key IN (?, ?, ?)',
  ).bind(M365_SYNC_SETTING_ENABLED, M365_SYNC_SETTING_DRY_RUN, M365_SYNC_SETTING_REQUESTED_AT)
    .all<{ key: string; value: string }>();
  return parseM365SyncSwitch(results ?? []);
}

// ─── Worker configuration ────────────────────────────────────────────────

export interface M365SyncEnv {
  M365_TENANT_ID?: string;
  M365_CLIENT_ID?: string;
  /** Wrangler secret. Never a var, never in a file. */
  M365_CLIENT_SECRET?: string;
  /** Optional: only members of this Entra group (transitive) get accounts. */
  M365_SCOPE_GROUP_ID?: string;
  /** Optional: members of this Entra group are treated as shared mailboxes. */
  M365_SHARED_GROUP_ID?: string;
  /** Minutes between delta runs. Default 60, minimum 15, maximum 1440. */
  M365_SYNC_INTERVAL_MINUTES?: string | number;
  /** The one mail domain this deployment hosts, as in the web app. */
  MAIL_DOMAIN?: string;
}

export interface M365SyncConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scopeGroupId: string | null;
  sharedGroupId: string | null;
  intervalMinutes: number;
  mailDomain: string;
}

export type M365SyncConfigCheck =
  | { configured: true; config: M365SyncConfig }
  | { configured: false; problems: string[] };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID.test(value);
}

function isIsoTime(value: string): boolean {
  return value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Reads the Worker configuration. Problems name the setting only, never its
 * value, so the result is safe to show a manager or write to a log.
 */
export function m365SyncConfig(env: M365SyncEnv): M365SyncConfigCheck {
  const problems: string[] = [];
  const tenantId = clean(env.M365_TENANT_ID);
  const clientId = clean(env.M365_CLIENT_ID);
  const clientSecret = typeof env.M365_CLIENT_SECRET === 'string' ? env.M365_CLIENT_SECRET.trim() : '';
  const scope = clean(env.M365_SCOPE_GROUP_ID);
  const shared = clean(env.M365_SHARED_GROUP_ID);
  const mailDomain = clean(env.MAIL_DOMAIN);

  if (!tenantId) problems.push('M365_TENANT_ID is not set');
  else if (!isGuid(tenantId)) problems.push('M365_TENANT_ID must be the directory (tenant) ID, a GUID');
  if (!clientId) problems.push('M365_CLIENT_ID is not set');
  else if (!isGuid(clientId)) problems.push('M365_CLIENT_ID must be the application (client) ID, a GUID');
  if (!clientSecret) problems.push('M365_CLIENT_SECRET is not set (wrangler secret put)');
  if (scope && !isGuid(scope)) problems.push('M365_SCOPE_GROUP_ID must be a group object ID (GUID) or empty');
  if (shared && !isGuid(shared)) problems.push('M365_SHARED_GROUP_ID must be a group object ID (GUID) or empty');
  if (scope && shared && scope === shared) problems.push('M365_SCOPE_GROUP_ID and M365_SHARED_GROUP_ID must be different groups');
  if (!mailDomain) problems.push('MAIL_DOMAIN is not set on the email Worker');
  else if (!DOMAIN.test(mailDomain)) problems.push('MAIL_DOMAIN is not a valid domain');

  if (problems.length) return { configured: false, problems };

  const rawInterval = Number(env.M365_SYNC_INTERVAL_MINUTES ?? 60);
  const intervalMinutes = Number.isFinite(rawInterval) ? Math.min(1440, Math.max(15, Math.floor(rawInterval))) : 60;
  return {
    configured: true,
    config: {
      tenantId,
      clientId,
      clientSecret,
      scopeGroupId: scope || null,
      sharedGroupId: shared || null,
      intervalMinutes,
      mailDomain,
    },
  };
}

// ─── Status row (m365_sync_state, migration 0022) ────────────────────────

export type M365RoundKind = 'delta' | 'reconcile';
export type M365RoundMode = 'live' | 'dry_run';

export const M365_COUNT_KEYS = [
  'created',
  'adopted',
  'updated',
  'paused',
  'resumed',
  'sharedCreated',
  'conflicts',
  'unchanged',
  'ignored',
] as const;
export type M365CountKey = (typeof M365_COUNT_KEYS)[number];
export type M365Counts = Record<M365CountKey, number>;

export interface M365ReportItem {
  /** What happened (live) or would happen (dry run). */
  action: string;
  /** The Microsoft 365 primary address, lower case, or '' when unknown. */
  address: string;
  /** Short machine reason, e.g. 'disabled', 'address_in_use'. */
  reason: string;
}

/** Report rows kept per round. Counts are always exact. */
export const M365_REPORT_LIMIT = 200;

/** One classified directory object from a fetched page, waiting to be applied. */
export interface M365PendingEntry {
  /** Entra object id. */
  id: string;
  kind: 'person' | 'shared' | 'out';
  address: string;
  displayName: string;
  reason: string;
}

export interface M365Round {
  id: string;
  kind: M365RoundKind;
  mode: M365RoundMode;
  phase: 'fetch' | 'sweep';
  /** Graph @odata.nextLink to fetch next, or null for the first page. */
  nextLink: string | null;
  /** Set once the last page has been fetched: the link for the next delta round. */
  finalDeltaLink: string | null;
  /** Objects from the last fetched page not yet applied (bounded work per run). */
  pending: M365PendingEntry[];
  startedAt: string;
  counts: M365Counts;
  report: M365ReportItem[];
  restarts: number;
}

export interface M365FinishedRound {
  kind: M365RoundKind;
  mode: M365RoundMode;
  startedAt: string;
  finishedAt: string;
  counts: M365Counts;
  report: M365ReportItem[];
}

export interface M365SyncState {
  /** Live rounds only: a dry run never moves this. */
  deltaLink: string | null;
  deltaLinkAt: string | null;
  lastDeltaAt: string | null;
  /** Last completed reconciliation of either mode. */
  lastReconcileAt: string | null;
  lastReconcileMode: M365RoundMode | null;
  /** The "Sync now" request already acted on. */
  handledRequestAt: string;
  round: M365Round | null;
  lastRound: M365FinishedRound | null;
  lastTickAt: string | null;
  lastResult: 'ok' | 'running' | 'error' | 'backoff' | 'not_configured' | null;
  lastError: { code: string; at: string } | null;
  backoffUntil: string | null;
  backoffStreak: number;
}

export function emptyCounts(): M365Counts {
  return Object.fromEntries(M365_COUNT_KEYS.map((key) => [key, 0])) as M365Counts;
}

export function emptyM365SyncState(): M365SyncState {
  return {
    deltaLink: null,
    deltaLinkAt: null,
    lastDeltaAt: null,
    lastReconcileAt: null,
    lastReconcileMode: null,
    handledRequestAt: '',
    round: null,
    lastRound: null,
    lastTickAt: null,
    lastResult: null,
    lastError: null,
    backoffUntil: null,
    backoffStreak: 0,
  };
}

/** A corrupt or older row falls back to an empty state: the next run is a full reconciliation. */
export function parseM365SyncState(raw: string | null | undefined): M365SyncState {
  if (!raw) return emptyM365SyncState();
  try {
    const parsed = JSON.parse(raw) as Partial<M365SyncState>;
    if (!parsed || typeof parsed !== 'object') return emptyM365SyncState();
    return { ...emptyM365SyncState(), ...parsed };
  } catch {
    return emptyM365SyncState();
  }
}

export async function loadM365SyncState(db: D1Database): Promise<M365SyncState> {
  const row = await db.prepare('SELECT state FROM m365_sync_state WHERE id = 1').first<{ state: string }>();
  return parseM365SyncState(row?.state);
}
