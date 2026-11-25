// Exchange mirror, Graph source (docs/exchange-mirror.md#graph-source-recommended):
// the parts both the web app (Admin switch, status, "Run now", "Import
// older mail") and the email Worker (the scheduled pull) need.
//
// Off by default. With the switch off the Worker reads one setting and
// returns: no Graph call, no write. The Graph source and the journal source
// can be on together: both file through the same code, keyed by mailbox and
// Message-ID, so a message that arrives by both is filed once.

/** org_settings keys. Absent = off. */
export const GRAPH_MIRROR_SETTING_ENABLED = 'graph_mirror_enabled';

/** Well-known Exchange folders the Graph source reads, and where each copy is filed. */
export const GRAPH_MIRROR_FOLDERS = ['inbox', 'sentitems', 'archive'] as const;
export type GraphMirrorFolder = (typeof GRAPH_MIRROR_FOLDERS)[number];

export const GRAPH_MIRROR_DEFAULT_LOOKBACK_HOURS = 24;
export const GRAPH_MIRROR_MAX_LOOKBACK_HOURS = 24 * 7;
export const GRAPH_MIRROR_DEFAULT_INITIAL_CAP = 500;
export const GRAPH_MIRROR_MAX_INITIAL_CAP = 5_000;

/**
 * Shown beside the standby switch and in the docs (Rob's words, 16 Nov 2026).
 * The Graph source reads from Microsoft 365, so while Exchange is down
 * nothing new arrives here until the switch-over.
 */
export const STANDBY_SWITCH_SOONER_NOTE =
  'If Exchange is down, switch as soon as you can: until you switch, new mail is not received here either (the mirror reads from Microsoft 365). Mail sent to you during an Exchange outage is held and retried by the sender\'s server for a few days, so it arrives once the switch is done.';

export interface GraphMirrorSwitch {
  enabled: boolean;
}

export async function loadGraphMirrorSwitch(db: D1Database): Promise<GraphMirrorSwitch> {
  const { results } = await db.prepare('SELECT key, value FROM org_settings WHERE key = ?')
    .bind(GRAPH_MIRROR_SETTING_ENABLED).all<{ key: string; value: string }>();
  return { enabled: (results ?? []).some((row) => row.key === GRAPH_MIRROR_SETTING_ENABLED && row.value === 'true') };
}

// ─── Configuration (email Worker vars) ───────────────────────────────────

export interface GraphMirrorEnv {
  /** Shared with the Microsoft 365 sync (the same app registration). */
  M365_TENANT_ID?: string;
  M365_CLIENT_ID?: string;
  /** Wrangler secret. */
  M365_CLIENT_SECRET?: string;
  /** Hours back the first pull of each folder starts. Default 24, at most 168. */
  M365_GRAPH_MIRROR_LOOKBACK_HOURS?: string | number;
  /** Most messages the first pull of one folder files. Default 500, at most 5,000. */
  M365_GRAPH_MIRROR_INITIAL_CAP?: string | number;
  /** "false" leaves out the Archive folder. Default "true". */
  M365_GRAPH_MIRROR_ARCHIVE?: string | boolean;
}

export interface GraphMirrorConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  lookbackHours: number;
  initialCap: number;
  folders: GraphMirrorFolder[];
}

export type GraphMirrorConfigCheck =
  | { configured: true; config: GraphMirrorConfig }
  | { configured: false; problems: string[] };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : typeof value === 'boolean' || typeof value === 'number' ? String(value) : '';
}

function boundedInt(raw: string, fallback: number, min: number, max: number): number | null {
  if (!raw) return fallback;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/** Problems name the setting only, never its value. */
export function graphMirrorConfig(env: GraphMirrorEnv): GraphMirrorConfigCheck {
  const problems: string[] = [];
  const tenantId = clean(env.M365_TENANT_ID);
  const clientId = clean(env.M365_CLIENT_ID);
  const clientSecret = typeof env.M365_CLIENT_SECRET === 'string' ? env.M365_CLIENT_SECRET.trim() : '';
  if (!tenantId) problems.push('M365_TENANT_ID is not set');
  else if (!GUID.test(tenantId)) problems.push('M365_TENANT_ID must be the directory (tenant) ID, a GUID');
  if (!clientId) problems.push('M365_CLIENT_ID is not set');
  else if (!GUID.test(clientId)) problems.push('M365_CLIENT_ID must be the application (client) ID, a GUID');
  if (!clientSecret) problems.push('M365_CLIENT_SECRET is not set (wrangler secret put)');
  const lookbackHours = boundedInt(clean(env.M365_GRAPH_MIRROR_LOOKBACK_HOURS), GRAPH_MIRROR_DEFAULT_LOOKBACK_HOURS, 1, GRAPH_MIRROR_MAX_LOOKBACK_HOURS);
  if (lookbackHours === null) problems.push(`M365_GRAPH_MIRROR_LOOKBACK_HOURS must be a whole number from 1 to ${GRAPH_MIRROR_MAX_LOOKBACK_HOURS}`);
  const initialCap = boundedInt(clean(env.M365_GRAPH_MIRROR_INITIAL_CAP), GRAPH_MIRROR_DEFAULT_INITIAL_CAP, 1, GRAPH_MIRROR_MAX_INITIAL_CAP);
  if (initialCap === null) problems.push(`M365_GRAPH_MIRROR_INITIAL_CAP must be a whole number from 1 to ${GRAPH_MIRROR_MAX_INITIAL_CAP}`);
  const archive = clean(env.M365_GRAPH_MIRROR_ARCHIVE);
  if (archive && archive !== 'true' && archive !== 'false') problems.push('M365_GRAPH_MIRROR_ARCHIVE must be "true" or "false"');
  if (problems.length || lookbackHours === null || initialCap === null) return { configured: false, problems };
  return {
    configured: true,
    config: {
      tenantId,
      clientId,
      clientSecret,
      lookbackHours,
      initialCap,
      folders: archive === 'false' ? ['inbox', 'sentitems'] : [...GRAPH_MIRROR_FOLDERS],
    },
  };
}

// ─── Status (graph_mirror_state, migration 0033) ─────────────────────────

export interface GraphMirrorCounts {
  filed: number;
  sentFiled: number;
  duplicates: number;
  skipped: number;
  /** Older messages left out by the first-pull cap. */
  capped: number;
}

export function emptyGraphMirrorCounts(): GraphMirrorCounts {
  return { filed: 0, sentFiled: 0, duplicates: 0, skipped: 0, capped: 0 };
}

export interface GraphMirrorStatus {
  lastRunAt: number | null;
  /** Last run that read every due folder without a whole-run error. */
  lastOkAt: number | null;
  lastFiledAt: number | null;
  /** Short code ('' when the last run was clean). */
  lastError: string;
  lastErrorAt: number | null;
  /** Mailboxes linked to Microsoft 365 that the mirror covers. */
  mailboxes: number;
  /** Mailboxes Graph refused (403) on their last attempt: outside the RBAC scope, or no permission. */
  denied: number;
  /** Every mailbox tried was refused: Mail.Read is missing or not assigned. */
  permissionMissing: boolean;
  /** UTC day of `today`. */
  day: string;
  today: GraphMirrorCounts;
  /** First skip reason today, if any. */
  lastSkipReason: string;
}

export function emptyGraphMirrorStatus(): GraphMirrorStatus {
  return {
    lastRunAt: null, lastOkAt: null, lastFiledAt: null, lastError: '', lastErrorAt: null,
    mailboxes: 0, denied: 0, permissionMissing: false, day: '', today: emptyGraphMirrorCounts(), lastSkipReason: '',
  };
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const code = (value: unknown): string => (typeof value === 'string' && /^[a-z0-9_]{0,64}$/.test(value) ? value : '');

export function parseGraphMirrorStatus(raw: string | null | undefined): GraphMirrorStatus {
  const base = emptyGraphMirrorStatus();
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return base;
    const today = (parsed.today && typeof parsed.today === 'object' ? parsed.today : {}) as Record<string, unknown>;
    return {
      lastRunAt: num(parsed.lastRunAt),
      lastOkAt: num(parsed.lastOkAt),
      lastFiledAt: num(parsed.lastFiledAt),
      lastError: code(parsed.lastError),
      lastErrorAt: num(parsed.lastErrorAt),
      mailboxes: count(parsed.mailboxes),
      denied: count(parsed.denied),
      permissionMissing: parsed.permissionMissing === true,
      day: typeof parsed.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.day) ? parsed.day : '',
      today: {
        filed: count(today.filed), sentFiled: count(today.sentFiled), duplicates: count(today.duplicates),
        skipped: count(today.skipped), capped: count(today.capped),
      },
      lastSkipReason: code(parsed.lastSkipReason),
    };
  } catch {
    return base;
  }
}

export async function loadGraphMirrorStatus(db: D1Database): Promise<GraphMirrorStatus> {
  const row = await db.prepare('SELECT state FROM graph_mirror_state WHERE id = 1').first<{ state: string }>();
  return parseGraphMirrorStatus(row?.state);
}

/** Plain words for the Graph source's own codes (skip reasons are in EXCHANGE_MIRROR_REASON_TEXT). */
export const GRAPH_MIRROR_REASON_TEXT: Readonly<Record<string, string>> = {
  not_configured: 'The email Worker is missing the Microsoft 365 app settings.',
  credentials_rejected: 'Microsoft refused the app\'s credentials (check M365_CLIENT_ID and M365_CLIENT_SECRET).',
  permission_missing: 'Microsoft Graph refused every mailbox: assign "Application Mail.Read" to the app in Exchange Online (see the guide).',
  denied: 'Microsoft Graph refused some mailboxes: they are outside the app\'s Exchange RBAC scope.',
  throttled: 'Microsoft Graph asked Stanchion to slow down; the next run continues where this one stopped.',
  network: 'Microsoft Graph could not be reached.',
  bad_response: 'Microsoft Graph gave an answer Stanchion could not read.',
  http_error: 'Microsoft Graph returned an error.',
  resync_required: 'A change token expired; that folder starts again from the newest mail already filed.',
  no_message_id: 'A message had no Message-ID, so it could not be filed exactly once.',
  too_large: 'The message is larger than the inbound size limit (MAX_INBOUND_BYTES).',
  capped: 'Older mail was left out by the first-pull cap. Use "Import older mail" (finite, with an estimate first) to bring in more.',
  domains: 'The organisation\'s domains could not be read.',
};
