// Exchange mirror, Graph source: "Import older mail" (finite import of old
// mail, docs/exchange-mirror.md#import-older-mail). The parts both the web app
// (Admin: slider, dry-run estimate, confirm, stop, progress) and the email
// Worker (the estimate and the import itself) need.
//
// No migration: three JSON values in org_settings, each with ONE writer, so
// the web app and the Worker never overwrite each other:
// - REQUEST  (web app)    "count this period" or "start, I confirmed these numbers"
// - ESTIMATE (Worker)     the dry run: counts and sizes, no mail written
// - JOB      (Worker)     the running import and its progress
// The only cross-writes are the manager's Stop (a guarded json_patch of the
// status, so a Worker progress write after it is a no-op) and the Worker's
// own guarded patches.

export const GRAPH_IMPORT_SETTING_REQUEST = 'graph_mirror_import_request';
export const GRAPH_IMPORT_SETTING_ESTIMATE = 'graph_mirror_import_estimate';
export const GRAPH_IMPORT_SETTING_JOB = 'graph_mirror_import_job';

/** The slider's stops, in order. `days: null` is "All". */
export const GRAPH_IMPORT_PERIODS = [
  { key: '1w', label: '1 week', days: 7 },
  { key: '1m', label: '1 month', days: 30 },
  { key: '2m', label: '2 months', days: 61 },
  { key: '3m', label: '3 months', days: 91 },
  { key: '6m', label: '6 months', days: 183 },
  { key: '12m', label: '12 months', days: 365 },
  { key: '2y', label: '2 years', days: 730 },
  { key: 'all', label: 'All mail', days: null },
] as const;
export type GraphImportPeriodKey = (typeof GRAPH_IMPORT_PERIODS)[number]['key'];

const DAY_MS = 24 * 60 * 60 * 1000;

export function graphImportPeriod(key: unknown): (typeof GRAPH_IMPORT_PERIODS)[number] | null {
  return GRAPH_IMPORT_PERIODS.find((period) => period.key === key) ?? null;
}

/** The slider's position (0 to 7) as a period, or null. */
export function graphImportPeriodAt(index: unknown): (typeof GRAPH_IMPORT_PERIODS)[number] | null {
  const position = typeof index === 'string' && /^\d$/.test(index.trim()) ? Number(index.trim()) : typeof index === 'number' ? index : -1;
  return Number.isInteger(position) ? GRAPH_IMPORT_PERIODS[position] ?? null : null;
}

/** Oldest receivedDateTime the period reaches back to (0 = no limit). */
export function graphImportSinceMs(key: GraphImportPeriodKey, now: number): number {
  const days = graphImportPeriod(key)?.days ?? null;
  return days === null ? 0 : Math.max(0, now - days * DAY_MS);
}

// ─── Figures the estimate uses (all "about") ─────────────────────────────

/**
 * D1 maximum size of one database on Workers Paid: 10 GB (Free: 500 MB).
 * https://developers.cloudflare.com/d1/platform/limits/ (read 17 Nov 2026).
 * Decimal bytes, the smaller reading of "GB".
 */
export const D1_MAX_DATABASE_BYTES = 10_000_000_000;
/** From this share of the limit the estimate warns "near the limit". */
export const D1_NEAR_FRACTION = 0.8;
/**
 * D1 bytes one filed message adds: the messages row (about 30 columns,
 * participants as JSON, a 200 character snippet) and its indexes. Stanchion keeps
 * the body and attachments in R2, not D1. An assumption from the row shape,
 * not a measurement; check it with the first real import (docs say how).
 */
export const D1_BYTES_PER_MESSAGE = 3_000;
/** R2 Standard storage: $0.015 per GB-month, first 10 GB-month free.
 * https://developers.cloudflare.com/r2/pricing/ (read 17 Nov 2026). */
export const R2_USD_PER_GB_MONTH = 0.015;
export const R2_FREE_GB_MONTH = 10;
const GB = 1_000_000_000;
/** Used for a folder whose messages could not be sized (no sample came back). */
export const ASSUMED_MESSAGE_BYTES = 75_000;
/** Sample size per mailbox folder: the newest this many messages' sizes. */
export const GRAPH_IMPORT_SAMPLE_SIZE = 50;
/**
 * Messages one scheduled run imports, at most. Each filed message costs one
 * Graph request and about 8 to 10 subrequests, so a run's budget (400 Graph
 * requests, 5,000 subrequests, 60 seconds) is reached at about 250 to 400.
 * The Worker enforces this number, so the time estimate matches what runs.
 */
export const GRAPH_IMPORT_MESSAGES_PER_RUN = 250;
/** Minutes between the Graph source's scheduled runs (GRAPH_MIRROR_CRON, every fifth minute). */
export const GRAPH_IMPORT_RUN_MINUTES = 5;
/**
 * While a count or an import is active, the live pull is limited to this
 * share of a run's time, Graph requests and subrequests, and the rest is the
 * import's. Live mail still goes first and keeps most of the run. Without an
 * active import the live pull has the whole run, as before.
 */
export const GRAPH_IMPORT_LIVE_SHARE = 0.7;
/** The import stops itself when the database reaches this share of its limit. */
export const GRAPH_IMPORT_STOP_FRACTION = 0.9;
/** Runs in a row a mailbox may fail (throttled, unreachable) before it is skipped and counted. */
export const GRAPH_IMPORT_MAX_RETRIES = 6;
/** A recount at Start that differs from the confirmed count by more than this asks the manager again. */
export const GRAPH_IMPORT_RECHECK_TOLERANCE = 0.2;

export interface GraphImportTotals {
  messages: number;
  bytes: number;
}

export type D1Level = 'ok' | 'near' | 'over' | 'unknown';

export interface GraphImportFigures {
  messages: number;
  /** Approximate size of the mail (R2 holds about this much). */
  bytes: number;
  d1AddBytes: number;
  /** null when the Worker could not read the database size. */
  d1UsedBytes: number | null;
  d1AfterBytes: number | null;
  d1LimitBytes: number;
  d1Level: D1Level;
  /** Percent of the limit used after the import, one decimal; null when unknown. */
  d1AfterPercent: number | null;
  r2AddBytes: number;
  /** About, per month, for the added mail alone. */
  r2UsdPerMonth: number;
  /** The same, if nothing else uses the free 10 GB-month. */
  r2UsdPerMonthAfterFree: number;
  runs: number;
  hours: number;
  blocked: boolean;
  blockReason: '' | 'd1_over' | 'd1_unknown';
}

export function graphImportFigures(
  input: GraphImportTotals & { d1UsedBytes: number | null; period: GraphImportPeriodKey },
): GraphImportFigures {
  const messages = Math.max(0, Math.floor(input.messages));
  const bytes = Math.max(0, Math.floor(input.bytes));
  const d1AddBytes = messages * D1_BYTES_PER_MESSAGE;
  const d1UsedBytes = input.d1UsedBytes !== null && input.d1UsedBytes >= 0 ? input.d1UsedBytes : null;
  const d1AfterBytes = d1UsedBytes === null ? null : d1UsedBytes + d1AddBytes;
  let d1Level: D1Level = 'unknown';
  if (d1AfterBytes !== null) {
    d1Level = d1AfterBytes > D1_MAX_DATABASE_BYTES ? 'over' : d1AfterBytes >= D1_MAX_DATABASE_BYTES * D1_NEAR_FRACTION ? 'near' : 'ok';
  }
  const addGb = bytes / GB;
  const runs = Math.ceil(messages / GRAPH_IMPORT_MESSAGES_PER_RUN);
  // "All" is the one that can be huge: refuse it when the limit cannot be
  // checked. Any period that would pass the limit is refused.
  const blockReason = d1Level === 'over' ? 'd1_over' : d1Level === 'unknown' && input.period === 'all' ? 'd1_unknown' : '';
  return {
    messages,
    bytes,
    d1AddBytes,
    d1UsedBytes,
    d1AfterBytes,
    d1LimitBytes: D1_MAX_DATABASE_BYTES,
    d1Level,
    d1AfterPercent: d1AfterBytes === null ? null : Math.round((d1AfterBytes / D1_MAX_DATABASE_BYTES) * 1000) / 10,
    r2AddBytes: bytes,
    r2UsdPerMonth: addGb * R2_USD_PER_GB_MONTH,
    r2UsdPerMonthAfterFree: Math.max(0, addGb - R2_FREE_GB_MONTH) * R2_USD_PER_GB_MONTH,
    runs,
    hours: (runs * GRAPH_IMPORT_RUN_MINUTES) / 60,
    blocked: blockReason !== '',
    blockReason,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** "about 3 hours", "about 2 days". */
export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return 'under 5 minutes';
  if (hours < 1) return `about ${Math.max(5, Math.round((hours * 60) / 5) * 5)} minutes`;
  if (hours < 48) return `about ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  return `about ${Math.round(hours / 24)} days`;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  return value < 0.01 ? 'under $0.01' : `$${value.toFixed(2)}`;
}

// ─── Stored records ──────────────────────────────────────────────────────

export interface GraphImportRequest {
  /** New for every request; the Worker handles each once. */
  seq: string;
  kind: 'estimate' | 'start';
  period: GraphImportPeriodKey;
  at: number;
  /** start only: the numbers the manager confirmed. */
  confirm: GraphImportTotals | null;
}

export type GraphImportEstimateStatus = 'running' | 'done' | 'stopped';

export interface GraphImportEstimate {
  id: string;
  requestSeq: string;
  period: GraphImportPeriodKey;
  sinceMs: number;
  startedAt: number;
  finishedAt: number;
  status: GraphImportEstimateStatus;
  mailboxesTotal: number;
  mailboxesDone: number;
  /** Last mailbox id counted (mailboxes are counted in id order). */
  cursor: string;
  messages: number;
  bytes: number;
  /** Mailbox folders that could not be counted (refused or unreadable). */
  errors: number;
  /** Runs in a row the current mailbox failed (throttled or unreachable). */
  retries: number;
  /** Some folder had messages but no size came back, so ASSUMED_MESSAGE_BYTES was used. */
  assumedSize: boolean;
  /** Database size when the count finished; -1 when it could not be read. */
  d1UsedBytes: number;
  /** [mailbox id, messages, bytes], largest first once done. */
  perMailbox: Array<[string, number, number]>;
  /** A recount made because the manager pressed Start: the numbers they confirmed. */
  then: GraphImportTotals | null;
  /** The recount differed from the confirmed numbers by more than 20%: nothing started. */
  changed: boolean;
  /** Start refused after the recount, with the reason. */
  refused: '' | 'd1_over' | 'd1_unknown';
  /** The import this recount started. */
  jobId: string;
}

export type GraphImportJobStatus = 'running' | 'done' | 'stopped';

export interface GraphImportJob {
  id: string;
  period: GraphImportPeriodKey;
  sinceMs: number;
  /** Mail received at or after this is the live mirror's, not the import's. */
  untilMs: number;
  status: GraphImportJobStatus;
  startedAt: number;
  finishedAt: number;
  /** The confirmed numbers. */
  estMessages: number;
  estBytes: number;
  mailboxesTotal: number;
  mailboxesDone: number;
  /** done: last finished mailbox id; mid/folder/before: where the current mailbox stands. */
  cursor: { done: string; mid: string; folder: number; before: number; skip: number };
  /** Runs in a row the current folder failed (throttled or unreachable). */
  retries: number;
  filed: number;
  duplicates: number;
  skipped: number;
  /** Messages seen on finished pages (filed, already here or skipped). */
  processed: number;
  /** Mailboxes Graph refused or folders it could not read. */
  errors: number;
  lastProgressAt: number;
  pausedUntil: number;
  error: string;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const stamp = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const text = (value: unknown, max: number, pattern = /^[A-Za-z0-9_.:-]*$/): string => (typeof value === 'string' && value.length <= max && pattern.test(value) ? value : '');
const periodKey = (value: unknown): GraphImportPeriodKey | null => graphImportPeriod(value)?.key ?? null;

function record(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function totals(value: unknown): GraphImportTotals | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  return { messages: count(item.messages), bytes: count(item.bytes) };
}

export function parseGraphImportRequest(raw: string | null | undefined): GraphImportRequest | null {
  const item = record(raw);
  if (!item) return null;
  const period = periodKey(item.period);
  const seq = text(item.seq, 64);
  if (!period || !seq || (item.kind !== 'estimate' && item.kind !== 'start')) return null;
  return { seq, kind: item.kind, period, at: stamp(item.at), confirm: item.kind === 'start' ? totals(item.confirm) : null };
}

export function parseGraphImportEstimate(raw: string | null | undefined): GraphImportEstimate | null {
  const item = record(raw);
  if (!item) return null;
  const period = periodKey(item.period);
  const id = text(item.id, 64);
  if (!period || !id || !['running', 'done', 'stopped'].includes(String(item.status))) return null;
  const perMailbox = Array.isArray(item.perMailbox)
    ? item.perMailbox.slice(0, 5000).flatMap((row): Array<[string, number, number]> => (
      Array.isArray(row) && typeof row[0] === 'string' && row[0].length <= 64 ? [[row[0], count(row[1]), count(row[2])]] : []))
    : [];
  return {
    id,
    requestSeq: text(item.requestSeq, 64),
    period,
    sinceMs: count(item.sinceMs),
    startedAt: stamp(item.startedAt),
    finishedAt: stamp(item.finishedAt),
    status: item.status as GraphImportEstimateStatus,
    mailboxesTotal: count(item.mailboxesTotal),
    mailboxesDone: count(item.mailboxesDone),
    cursor: text(item.cursor, 64),
    messages: count(item.messages),
    bytes: count(item.bytes),
    errors: count(item.errors),
    retries: count(item.retries),
    assumedSize: item.assumedSize === true,
    d1UsedBytes: typeof item.d1UsedBytes === 'number' && Number.isFinite(item.d1UsedBytes) ? Math.floor(item.d1UsedBytes) : -1,
    perMailbox,
    then: totals(item.then),
    changed: item.changed === true,
    refused: item.refused === 'd1_over' || item.refused === 'd1_unknown' ? item.refused : '',
    jobId: text(item.jobId, 64),
  };
}

export function parseGraphImportJob(raw: string | null | undefined): GraphImportJob | null {
  const item = record(raw);
  if (!item) return null;
  const period = periodKey(item.period);
  const id = text(item.id, 64);
  if (!period || !id || !['running', 'done', 'stopped'].includes(String(item.status))) return null;
  const cursor = (item.cursor && typeof item.cursor === 'object' ? item.cursor : {}) as Record<string, unknown>;
  return {
    id,
    period,
    sinceMs: count(item.sinceMs),
    untilMs: count(item.untilMs),
    status: item.status as GraphImportJobStatus,
    startedAt: stamp(item.startedAt),
    finishedAt: stamp(item.finishedAt),
    estMessages: count(item.estMessages),
    estBytes: count(item.estBytes),
    mailboxesTotal: count(item.mailboxesTotal),
    mailboxesDone: count(item.mailboxesDone),
    cursor: { done: text(cursor.done, 64), mid: text(cursor.mid, 64), folder: count(cursor.folder), before: count(cursor.before), skip: count(cursor.skip) },
    retries: count(item.retries),
    filed: count(item.filed),
    duplicates: count(item.duplicates),
    skipped: count(item.skipped),
    processed: count(item.processed),
    errors: count(item.errors),
    lastProgressAt: stamp(item.lastProgressAt),
    pausedUntil: stamp(item.pausedUntil),
    error: text(item.error, 64),
  };
}

/** Messages left and about how long, from the confirmed count and what has been seen. */
export function graphImportProgress(job: GraphImportJob): { percent: number; remaining: number; etaHours: number } {
  const total = Math.max(job.estMessages, job.processed);
  const remaining = job.status === 'running' ? Math.max(0, job.estMessages - job.processed) : 0;
  const percent = job.status === 'done' ? 100 : total === 0 ? 0 : Math.min(99, Math.floor((job.processed / total) * 100));
  return { percent, remaining, etaHours: (Math.ceil(remaining / GRAPH_IMPORT_MESSAGES_PER_RUN) * GRAPH_IMPORT_RUN_MINUTES) / 60 };
}

/** True when `recount` differs from the confirmed count by more than the tolerance. */
export function graphImportCountChanged(confirmed: number, recount: number): boolean {
  return Math.abs(recount - confirmed) > Math.max(1, confirmed) * GRAPH_IMPORT_RECHECK_TOLERANCE;
}

/** Plain words for the import's own codes. */
export const GRAPH_IMPORT_ERROR_TEXT: Readonly<Record<string, string>> = {
  d1_limit: 'The import stopped itself: the database reached 90% of its size limit.',
  throttled: 'Microsoft Graph asked Stanchion to slow down; the import waits and continues.',
  network: 'Microsoft Graph could not be reached; the next run continues.',
  store_failed: 'A message could not be stored; the next run tries again.',
  credentials_rejected: 'Microsoft refused the app\'s credentials.',
};
