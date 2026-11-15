// Standby test address and daily probe: the parts both the web app (Admin
// switch and status) and the email Worker (alias delivery and the probe)
// need. The design and its limits are in docs/standby-probe.md.
//
// The standby address of a mailbox is the same local part on a subdomain of
// MAIL_DOMAIN: alice@example.com is also alice@standby.example.com. It only
// ever delivers into a mailbox that already exists on MAIL_DOMAIN; it never
// forwards, relays or creates anything.

/** org_settings key for the manager switch. Absent = off. */
export const STANDBY_SETTING_ENABLED = 'standby_enabled';

/** Header the probe carries its one-time token in. */
export const STANDBY_PROBE_HEADER = 'X-Cmail-Standby-Probe';
/** Subject prefix of a probe; the token follows it, as a fallback to the header. */
export const STANDBY_PROBE_SUBJECT_PREFIX = 'cmail standby test ';

export const STANDBY_DEFAULT_LABEL = 'standby';
export const STANDBY_DEFAULT_PROBE_LOCAL_PART = 'cmail-standby-probe';
export const STANDBY_DEFAULT_TIMEOUT_MINUTES = 10;
/** Probe results are kept this long. */
export const STANDBY_RUN_RETENTION_DAYS = 30;
/** Probe messages in the system mailbox are pruned after this long. */
export const STANDBY_MESSAGE_RETENTION_DAYS = 7;
/** A delivery slower than this passes with a warning. */
export const STANDBY_SLOW_MS = 5 * 60 * 1000;
/** A last pass older than this is amber (the daily probe was missed). */
export const STANDBY_STALE_AMBER_MS = 26 * 60 * 60 * 1000;
/** A last pass older than this is red. */
export const STANDBY_STALE_RED_MS = 50 * 60 * 60 * 1000;

export async function loadStandbySwitch(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?')
    .bind(STANDBY_SETTING_ENABLED).first<{ value: string }>();
  return row?.value === 'true';
}

// ─── Configuration (email Worker vars) ───────────────────────────────────

export interface StandbyEnv {
  /** The one mail domain this deployment hosts, as in the web app. */
  MAIL_DOMAIN?: string;
  /** DNS label of the standby subdomain. Default "standby". */
  STANDBY_SUBDOMAIN_LABEL?: string;
  /** Local part of the dedicated probe mailbox. Default "cmail-standby-probe". */
  STANDBY_PROBE_LOCAL_PART?: string;
  /** Minutes a probe may take before it fails. Default 10, 2 to 60. */
  STANDBY_PROBE_TIMEOUT_MINUTES?: string | number;
}

export interface StandbyConfig {
  mailDomain: string;
  label: string;
  /** label.mailDomain */
  standbyDomain: string;
  /** probe@mailDomain: the system mailbox's own address, also the sender. */
  probeAddress: string;
  /** probe@standbyDomain: where the probe is sent. */
  probeStandbyAddress: string;
  timeoutMinutes: number;
}

export type StandbyConfigCheck =
  | { configured: true; config: StandbyConfig }
  | { configured: false; problems: string[] };

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Reads the Worker configuration. Problems name the setting only, never its
 * value, so the result is safe to show a manager or write to a log.
 */
export function standbyConfig(env: StandbyEnv): StandbyConfigCheck {
  const problems: string[] = [];
  const mailDomain = clean(env.MAIL_DOMAIN);
  const label = clean(env.STANDBY_SUBDOMAIN_LABEL) || STANDBY_DEFAULT_LABEL;
  const localPart = clean(env.STANDBY_PROBE_LOCAL_PART) || STANDBY_DEFAULT_PROBE_LOCAL_PART;

  if (!mailDomain) problems.push('MAIL_DOMAIN is not set on the email Worker');
  else if (!DOMAIN.test(mailDomain)) problems.push('MAIL_DOMAIN is not a valid domain');
  if (!LABEL.test(label)) problems.push('STANDBY_SUBDOMAIN_LABEL must be one DNS label (letters, digits and hyphens)');
  if (!LOCAL_PART.test(localPart) || localPart.includes('..')) {
    problems.push('STANDBY_PROBE_LOCAL_PART must be a plain local part (letters, digits, dot, hyphen, underscore)');
  }
  const standbyDomain = `${label}.${mailDomain}`;
  if (mailDomain && DOMAIN.test(mailDomain) && LABEL.test(label) && !DOMAIN.test(standbyDomain)) {
    problems.push('STANDBY_SUBDOMAIN_LABEL makes the standby domain too long');
  }
  if (problems.length) return { configured: false, problems };

  const rawTimeout = Number(env.STANDBY_PROBE_TIMEOUT_MINUTES ?? STANDBY_DEFAULT_TIMEOUT_MINUTES);
  const timeoutMinutes = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(60, Math.max(2, Math.floor(rawTimeout)))
    : STANDBY_DEFAULT_TIMEOUT_MINUTES;
  return {
    configured: true,
    config: {
      mailDomain,
      label,
      standbyDomain,
      probeAddress: `${localPart}@${mailDomain}`,
      probeStandbyAddress: `${localPart}@${standbyDomain}`,
      timeoutMinutes,
    },
  };
}

/**
 * The primary address a standby address stands for, or null. Only an exact
 * `local@<label>.<MAIL_DOMAIN>` matches: no deeper subdomains, no other
 * domains, no empty local part. The caller still has to find an active
 * mailbox at the result; this function never invents one.
 */
export function standbyPrimaryAddress(recipient: string, config: Pick<StandbyConfig, 'mailDomain' | 'standbyDomain'>): string | null {
  const address = recipient.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || address.indexOf('@') !== at) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (domain !== config.standbyDomain) return null;
  if (local.length > 64 || /[\s\u0000-\u001f\u007f]/.test(local)) return null;
  return `${local}@${config.mailDomain}`;
}

// ─── Results (standby_probe_runs, migration 0023) ────────────────────────

export type StandbyRunStatus = 'sending' | 'waiting' | 'pass' | 'fail';

export interface StandbyRun {
  id: string;
  kind: 'schedule' | 'manual';
  status: StandbyRunStatus;
  reason: string;
  detail: string;
  warnings: string[];
  startedAt: number;
  sentAt: number | null;
  receivedAt: number | null;
  roundTripMs: number | null;
  lateMs: number | null;
  folder: string | null;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

interface StandbyRunRow {
  id: string;
  kind: string;
  status: string;
  reason: string;
  detail: string;
  warnings: string;
  started_at: number;
  sent_at: number | null;
  received_at: number | null;
  round_trip_ms: number | null;
  late_ms: number | null;
  folder: string | null;
  spf_result: string | null;
  dkim_result: string | null;
  dmarc_result: string | null;
}

function toRun(row: StandbyRunRow): StandbyRun {
  return {
    id: row.id,
    kind: row.kind === 'manual' ? 'manual' : 'schedule',
    status: (['sending', 'waiting', 'pass', 'fail'].includes(row.status) ? row.status : 'fail') as StandbyRunStatus,
    reason: row.reason || '',
    detail: row.detail || '',
    warnings: (row.warnings || '').split(',').map((item) => item.trim()).filter(Boolean),
    startedAt: Number(row.started_at),
    sentAt: row.sent_at == null ? null : Number(row.sent_at),
    receivedAt: row.received_at == null ? null : Number(row.received_at),
    roundTripMs: row.round_trip_ms == null ? null : Number(row.round_trip_ms),
    lateMs: row.late_ms == null ? null : Number(row.late_ms),
    folder: row.folder,
    spf: row.spf_result,
    dkim: row.dkim_result,
    dmarc: row.dmarc_result,
  };
}

/** Runs started since `sinceMs`, newest first (at most 200). */
export async function loadStandbyRuns(db: D1Database, sinceMs: number): Promise<StandbyRun[]> {
  const { results } = await db.prepare(
    `SELECT id, kind, status, reason, detail, warnings, started_at, sent_at, received_at, round_trip_ms,
            late_ms, folder, spf_result, dkim_result, dmarc_result
     FROM standby_probe_runs WHERE started_at >= ? ORDER BY started_at DESC, id DESC LIMIT 200`,
  ).bind(sinceMs).all<StandbyRunRow>();
  return (results ?? []).map(toRun);
}

/** Warnings that turn a pass amber. Others are shown but stay green. */
export const STANDBY_AMBER_WARNINGS = new Set(['spam_folder', 'dmarc_not_pass', 'slow']);

/** Plain-language text for each machine reason and warning. */
export const STANDBY_REASON_TEXT: Readonly<Record<string, string>> = {
  timeout: 'The test message did not arrive in time.',
  late: 'The test message arrived, but only after the time limit.',
  not_configured: 'The email Worker is missing standby settings.',
  no_send_binding: 'The email Worker has no Email Sending binding (EMAIL), so it cannot send the test.',
  send_rejected: 'Cloudflare Email Sending refused the test message.',
  send_failed: 'Sending the test message failed or timed out at Cloudflare Email Sending.',
  probe_address_in_use: 'The probe address already belongs to another mailbox.',
  probe_mailbox_disabled: 'The probe mailbox has been disabled.',
  probe_mailbox_missing: 'The probe mailbox could not be created.',
  spam_folder: 'Delivered, but filed to Spam.',
  dmarc_not_pass: 'Delivered, but DMARC did not pass.',
  slow: 'Delivered, but it took more than 5 minutes.',
  auth_not_recorded: 'SPF, DKIM and DMARC were not recorded (INBOUND_AUTHSERV_ID is not set).',
  stale: 'No passing test in the last day: the daily test may not be running.',
  never: 'No test has run yet.',
  running: 'A test is running.',
};

export type StandbyLight = 'off' | 'green' | 'amber' | 'red';

export interface StandbyStatusView {
  light: StandbyLight;
  /** Machine reason behind the colour, '' for a clean green. */
  reason: string;
  /** Latest finished run, if any. */
  last: StandbyRun | null;
  /** A run in flight that is not yet overdue. */
  running: StandbyRun | null;
}

/**
 * The traffic light. Green: the newest finished test passed within the last
 * 26 hours with no warning that matters. Amber: a pass with a warning, a pass
 * older than 26 hours, or no finished test yet. Red: the newest finished test
 * failed, a test is overdue, or no pass for 50 hours. Off: switched off.
 */
export function standbyStatusView(input: {
  enabled: boolean;
  runs: StandbyRun[];
  now: number;
  timeoutMinutes: number;
}): StandbyStatusView {
  const sorted = [...input.runs].sort((a, b) => b.startedAt - a.startedAt);
  const timeoutMs = input.timeoutMinutes * 60 * 1000;
  const inFlight = sorted.find((run) => run.status === 'sending' || run.status === 'waiting') ?? null;
  const overdue = inFlight && input.now - inFlight.startedAt > timeoutMs ? inFlight : null;
  const running = inFlight && !overdue ? inFlight : null;
  const last = sorted.find((run) => run.status === 'pass' || run.status === 'fail') ?? null;
  if (!input.enabled) return { light: 'off', reason: '', last, running: null };
  // An overdue probe newer than the last result is a failure now; the Worker
  // records it as 'timeout' on its next run.
  if (overdue && (!last || overdue.startedAt > last.startedAt)) return { light: 'red', reason: 'timeout', last, running: null };
  if (!last) return { light: 'amber', reason: running ? 'running' : 'never', last: null, running };
  if (last.status === 'fail') return { light: 'red', reason: last.reason || 'timeout', last, running };
  const age = input.now - (last.receivedAt ?? last.startedAt);
  if (age > STANDBY_STALE_RED_MS) return { light: 'red', reason: 'stale', last, running };
  if (age > STANDBY_STALE_AMBER_MS) return { light: 'amber', reason: 'stale', last, running };
  const warning = last.warnings.find((item) => STANDBY_AMBER_WARNINGS.has(item));
  if (warning) return { light: 'amber', reason: warning, last, running };
  return { light: 'green', reason: '', last, running };
}
