// Shared mailbox access from Exchange Online: the parts both the web app
// (Admin switch and status) and the email Worker (the scheduled access sync)
// need. Design and reasons: docs/m365-mailbox-permissions.md.
//
// Nothing here talks to Microsoft. The Worker holds the certificate and runs
// the collector; the web app only flips the switch in org_settings and reads
// the status row the Worker writes (migration 0028).

/** org_settings keys. Absent = default. */
export const M365_PERMS_SETTING_ENABLED = 'm365_perms_enabled';
export const M365_PERMS_SETTING_DRY_RUN = 'm365_perms_dry_run';
export const M365_PERMS_SETTING_REQUESTED_AT = 'm365_perms_requested_at';
/** Round id a manager approved after the removal brake held it. */
export const M365_PERMS_SETTING_APPROVED_ROUND = 'm365_perms_approved_round';
/**
 * "true" lets the sync also give access to an unlinked manager account whose
 * address equals the Exchange trustee's primary SMTP address (add and raise
 * only). Absent or anything else = off.
 */
export const M365_PERMS_SETTING_INCLUDE_MANAGERS = 'm365_perms_include_managers';

export interface M365PermsSwitch {
  /** Off by default: the cron does nothing until a manager turns it on. */
  enabled: boolean;
  /** On by default, so the first runs only report. */
  dryRun: boolean;
  /** ISO time of the last "Sync access now" request, or ''. */
  requestedAt: string;
  /** Id of a held round a manager approved, or ''. */
  approvedRound: string;
  /** Off by default: manager accounts are matched only when a manager turns this on. */
  includeManagers: boolean;
}

function isIsoTime(value: string): boolean {
  return value.length <= 40 && !Number.isNaN(Date.parse(value));
}

export function parseM365PermsSwitch(rows: Array<{ key: string; value: string }>): M365PermsSwitch {
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const requested = map.get(M365_PERMS_SETTING_REQUESTED_AT) ?? '';
  return {
    enabled: map.get(M365_PERMS_SETTING_ENABLED) === 'true',
    dryRun: map.get(M365_PERMS_SETTING_DRY_RUN) !== 'false',
    requestedAt: isIsoTime(requested) ? requested : '',
    approvedRound: (map.get(M365_PERMS_SETTING_APPROVED_ROUND) ?? '').slice(0, 64),
    includeManagers: map.get(M365_PERMS_SETTING_INCLUDE_MANAGERS) === 'true',
  };
}

export async function loadM365PermsSwitch(db: D1Database): Promise<M365PermsSwitch> {
  const { results } = await db.prepare(
    'SELECT key, value FROM org_settings WHERE key IN (?, ?, ?, ?, ?)',
  ).bind(M365_PERMS_SETTING_ENABLED, M365_PERMS_SETTING_DRY_RUN, M365_PERMS_SETTING_REQUESTED_AT, M365_PERMS_SETTING_APPROVED_ROUND, M365_PERMS_SETTING_INCLUDE_MANAGERS)
    .all<{ key: string; value: string }>();
  return parseM365PermsSwitch(results ?? []);
}

// ─── Worker configuration ────────────────────────────────────────────────

export interface M365PermsEnv {
  /** Shared with the Microsoft 365 sync: the directory (tenant) id. */
  M365_TENANT_ID?: string;
  /** Application (client) id of the separate Exchange permission reader app. */
  M365_EXO_APP_ID?: string;
  /** The tenant's primary <name>.onmicrosoft.com domain (Connect-ExchangeOnline -Organization). */
  M365_EXO_ORGANIZATION?: string;
  /** Wrangler secret: the reader app's .pfx certificate, base64. Never a var. */
  M365_EXO_CERT_PFX_B64?: string;
  /** Wrangler secret: the .pfx password, if the .pfx has one. */
  M365_EXO_CERT_PASSWORD?: string;
  /** Hours between full collections. Default 24, minimum 6, maximum 24. */
  M365_PERMS_INTERVAL_HOURS?: string | number;
  /** Removal brake: hold removals and downgrades above this percent of sync-made grants. Default 20. */
  M365_PERMS_MAX_REMOVE_PERCENT?: string | number;
  /** "true" maps Full Access without Send As to cmail Full (default "false": Read). */
  M365_PERMS_FULLACCESS_IMPLIES_SEND?: string | boolean;
  /** Durable Object namespace that owns the collector container. */
  M365_PERMS_COLLECTOR?: DurableObjectNamespace;
}

export interface M365PermsConfig {
  tenantId: string;
  appId: string;
  organization: string;
  intervalHours: number;
  maxRemovePercent: number;
  fullAccessImpliesSend: boolean;
}

export type M365PermsConfigCheck =
  | { configured: true; config: M365PermsConfig }
  | { configured: false; problems: string[] };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ONMICROSOFT = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onmicrosoft\.(?:com|us|de)$/;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Reads the Worker configuration. Problems name the setting only, never its
 * value, so the result is safe to show a manager or write to a log.
 */
export function m365PermsConfig(env: M365PermsEnv): M365PermsConfigCheck {
  const problems: string[] = [];
  const tenantId = clean(env.M365_TENANT_ID);
  const appId = clean(env.M365_EXO_APP_ID);
  const organization = clean(env.M365_EXO_ORGANIZATION);
  const pfx = typeof env.M365_EXO_CERT_PFX_B64 === 'string' ? env.M365_EXO_CERT_PFX_B64.trim() : '';
  if (!tenantId) problems.push('M365_TENANT_ID is not set');
  else if (!GUID.test(tenantId)) problems.push('M365_TENANT_ID must be the directory (tenant) ID, a GUID');
  if (!appId) problems.push('M365_EXO_APP_ID is not set');
  else if (!GUID.test(appId)) problems.push('M365_EXO_APP_ID must be the reader app\'s application (client) ID, a GUID');
  if (!organization) problems.push('M365_EXO_ORGANIZATION is not set');
  else if (!ONMICROSOFT.test(organization)) problems.push('M365_EXO_ORGANIZATION must be the tenant\'s <name>.onmicrosoft.com domain');
  if (!pfx) problems.push('M365_EXO_CERT_PFX_B64 is not set (wrangler secret put)');
  else if (pfx.length > 64 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(pfx)) problems.push('M365_EXO_CERT_PFX_B64 must be the .pfx file in base64 (at most 48 KB)');
  if (!env.M365_PERMS_COLLECTOR || typeof (env.M365_PERMS_COLLECTOR as { idFromName?: unknown }).idFromName !== 'function') {
    problems.push('M365_PERMS_COLLECTOR Durable Object binding is missing (the container block in wrangler.toml)');
  }
  const implies = typeof env.M365_PERMS_FULLACCESS_IMPLIES_SEND === 'boolean'
    ? String(env.M365_PERMS_FULLACCESS_IMPLIES_SEND)
    : clean(env.M365_PERMS_FULLACCESS_IMPLIES_SEND);
  if (implies && implies !== 'true' && implies !== 'false') problems.push('M365_PERMS_FULLACCESS_IMPLIES_SEND must be "true" or "false"');
  if (problems.length) return { configured: false, problems };

  const rawInterval = Number(env.M365_PERMS_INTERVAL_HOURS ?? 24);
  const intervalHours = Number.isFinite(rawInterval) ? Math.min(24, Math.max(6, Math.floor(rawInterval))) : 24;
  const rawPercent = Number(env.M365_PERMS_MAX_REMOVE_PERCENT ?? 20);
  const maxRemovePercent = Number.isFinite(rawPercent) ? Math.min(100, Math.max(1, Math.floor(rawPercent))) : 20;
  return {
    configured: true,
    config: { tenantId, appId, organization, intervalHours, maxRemovePercent, fullAccessImpliesSend: implies === 'true' },
  };
}

// ─── Status row (m365_perm_state, migration 0028) ────────────────────────

export type M365PermsMode = 'live' | 'dry_run';

export const M365_PERMS_COUNT_KEYS = [
  /** New assignments the sync made (or would make). */
  'added',
  /** Sync-made assignments raised (Read to Full). */
  'upgraded',
  /** Sync-made assignments lowered (Full to Read). */
  'downgraded',
  /** Sync-made assignments removed because Exchange no longer grants them. */
  'removed',
  /** Exchange grants a manager-made assignment already covers or that a manager set differently: left as is. */
  'managerKept',
  /** Grants with no cmail equivalent (Send As alone). */
  'notRepresentable',
  /** Trustees that are not a linked, active cmail person. */
  'trusteeNotLinked',
  /** Exchange grants (shared mailbox, person) resolved to an unlinked manager account by address (switch on). */
  'managerMatched',
  /** A matched manager account's sync-made access that Exchange lowered or took away: never lowered or removed. */
  'managerAccountKept',
  /**
   * Sync-made access of an account with no link and no manager match this
   * round (a manager match that is gone, a lost link) on a fully read
   * mailbox: kept, because the sync can no longer tell whether Exchange still
   * grants it. Remove it in Admin > Mailboxes if it is not wanted.
   */
  'unlinkedKept',
  /** Shared mailboxes in the snapshot that the Microsoft 365 sync has not linked yet. */
  'mailboxNotLinked',
  /** Linked shared mailboxes this snapshot did not cover (fully): their removals wait. */
  'mailboxNotCovered',
  /** Writes that lost to a concurrent change (a manager wins). */
  'changedConcurrently',
  'unchanged',
] as const;
export type M365PermsCountKey = (typeof M365_PERMS_COUNT_KEYS)[number];
export type M365PermsCounts = Record<M365PermsCountKey, number>;

export interface M365PermsReportItem {
  /** add, upgrade, downgrade, remove, manager_kept, not_representable, ... */
  action: string;
  /** Shared mailbox address in cmail, lower case, or ''. */
  mailbox: string;
  /** cmail account address, lower case, or ''. */
  user: string;
  /** Short machine reason. */
  reason: string;
}

/** Report rows kept per round. Counts are always exact. */
export const M365_PERMS_REPORT_LIMIT = 200;
/** Consecutive failed runs before Admin shows an alert. */
export const M365_PERMS_FAILURE_ALERT = 3;
/** Removal brake: never held below this many removals plus downgrades. */
export const M365_PERMS_BRAKE_MIN = 5;
/** Removals and downgrades one round decides on; any beyond wait for the next round. */
export const M365_PERMS_REMOVAL_LIMIT = 5_000;

export interface M365PermsBrake {
  /**
   * too_many_removals: approvable. no_grants: the snapshot lists shared
   * mailboxes but not one grant while the sync owns grants; approvable.
   * empty_snapshot: no shared mailboxes at all; never approvable.
   */
  reason: 'too_many_removals' | 'no_grants' | 'empty_snapshot';
  removals: number;
  ledger: number;
  percent: number;
}

export type M365PermsPhase = 'collecting' | 'groups' | 'diff' | 'apply' | 'held';

export interface M365PermsRound {
  id: string;
  mode: M365PermsMode;
  phase: M365PermsPhase;
  startedAt: string;
  /** Group trustee ids still to expand, those expanded (even if empty), and those that could not be. */
  groupsPending: string[];
  groupsExpanded: string[];
  groupsFailed: string[];
  brake: M365PermsBrake | null;
  /** False while held: removals and downgrades wait. */
  removalsAllowed: boolean;
  /**
   * The removals and downgrades decided when the brake was checked
   * (`type|mailboxId|userId`, at most M365_PERMS_REMOVAL_LIMIT). Only these
   * are ever applied in this round, so an approval covers exactly what the
   * manager saw.
   */
  removalKeys: string[];
  counts: M365PermsCounts;
  report: M365PermsReportItem[];
  /** What a held round would remove or lower (at most M365_PERMS_REPORT_LIMIT rows), for Admin. */
  heldItems: M365PermsReportItem[];
  snapshot: M365PermsSnapshotSummary | null;
  /**
   * The collector batches of this pass, in order. Each starts after the
   * previous one's last mailbox; nothing is applied until the last batch
   * reaches the end of the list.
   */
  batches: Array<{ runId: string; startAfter: string }>;
  /** When the batch now running was started (its own timeout). */
  batchStartedAt: string;
  /**
   * Unlinked manager accounts matched to an Entra user this round (switch
   * on), resolved once before the diff. Absent = not resolved yet.
   */
  managerMatches?: M365PermsManagerMatch[];
  /** cmail account ids of the managers looked up this round (matched or not). */
  managerLookedAt?: string[];
}

/** One manager account matched to the Entra user whose primary SMTP address equals its address. */
export interface M365PermsManagerMatch {
  /** Entra user object id, lower case. */
  objectId: string;
  /** cmail account id of the manager. */
  userId: string;
  /** The manager's address when matched, lower case; checked again before every use. */
  email: string;
}

export interface M365PermsSnapshotSummary {
  collectedAt: string;
  mailboxes: number;
  mailboxesInTenant: number;
  grants: number;
  complete: boolean;
  /** Collector batches the pass took. */
  batches: number;
  skipped: Record<string, number>;
}

export interface M365PermsFinishedRound {
  id: string;
  mode: M365PermsMode;
  startedAt: string;
  finishedAt: string;
  counts: M365PermsCounts;
  report: M365PermsReportItem[];
  brake: M365PermsBrake | null;
  snapshot: M365PermsSnapshotSummary | null;
}

export interface M365PermsState {
  lastTickAt: string | null;
  lastResult: 'ok' | 'collecting' | 'running' | 'held' | 'error' | 'not_configured' | null;
  lastError: { code: string; at: string } | null;
  /** Failed runs in a row; Admin alerts at M365_PERMS_FAILURE_ALERT. */
  consecutiveFailures: number;
  backoffUntil: string | null;
  /** Last round that finished (any mode). */
  lastFinishedAt: string | null;
  /** Last round start, to space runs by the interval even when they fail. */
  lastStartedAt: string | null;
  handledRequestAt: string;
  /**
   * Manager matching: the last manager account id looked up. With more
   * unlinked managers than one round looks up, the next round starts after it.
   */
  managerCursor?: string;
  round: M365PermsRound | null;
  lastRound: M365PermsFinishedRound | null;
}

export function emptyM365PermsCounts(): M365PermsCounts {
  return Object.fromEntries(M365_PERMS_COUNT_KEYS.map((key) => [key, 0])) as M365PermsCounts;
}

export function emptyM365PermsState(): M365PermsState {
  return {
    lastTickAt: null,
    lastResult: null,
    lastError: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    lastFinishedAt: null,
    lastStartedAt: null,
    handledRequestAt: '',
    round: null,
    lastRound: null,
  };
}

/** A corrupt row falls back to an empty state: the next due run starts afresh. */
export function parseM365PermsState(raw: string | null | undefined): M365PermsState {
  if (!raw) return emptyM365PermsState();
  try {
    const parsed = JSON.parse(raw) as Partial<M365PermsState>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyM365PermsState();
    const state = { ...emptyM365PermsState(), ...parsed };
    // Counts saved before a count key existed read as 0, never NaN.
    if (state.round?.counts) state.round.counts = { ...emptyM365PermsCounts(), ...state.round.counts };
    if (state.lastRound?.counts) state.lastRound.counts = { ...emptyM365PermsCounts(), ...state.lastRound.counts };
    return state;
  } catch {
    return emptyM365PermsState();
  }
}

export async function loadM365PermsState(db: D1Database): Promise<M365PermsState> {
  const row = await db.prepare('SELECT state FROM m365_perm_state WHERE id = 1').first<{ state: string }>();
  return parseM365PermsState(row?.state);
}

/** Only what Admin displays. */
export interface M365PermsStatusView {
  lastTickAt: string | null;
  lastResult: M365PermsState['lastResult'];
  lastError: M365PermsState['lastError'];
  consecutiveFailures: number;
  alert: boolean;
  backoffUntil: string | null;
  lastFinishedAt: string | null;
  round: { id: string; mode: M365PermsMode; phase: M365PermsPhase; startedAt: string; brake: M365PermsBrake | null; counts: M365PermsCounts; report: M365PermsReportItem[] } | null;
  lastRound: M365PermsFinishedRound | null;
}

export function m365PermsStatusView(state: M365PermsState): M365PermsStatusView {
  const round = state.round;
  return {
    lastTickAt: state.lastTickAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    consecutiveFailures: state.consecutiveFailures,
    alert: state.consecutiveFailures >= M365_PERMS_FAILURE_ALERT,
    backoffUntil: state.backoffUntil,
    lastFinishedAt: state.lastFinishedAt,
    round: round
      ? { id: round.id, mode: round.mode, phase: round.phase, startedAt: round.startedAt, brake: round.brake ?? null, counts: round.counts, report: round.phase === 'held' ? (round.heldItems ?? []) : [] }
      : null,
    lastRound: state.lastRound,
  };
}
