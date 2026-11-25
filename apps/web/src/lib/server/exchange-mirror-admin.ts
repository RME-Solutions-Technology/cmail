// Admin side of the Exchange mirror and the Microsoft 365 alias import
// (docs/exchange-mirror.md). The web app never reads journal reports itself:
// it flips the two manager switches in org_settings, asks the email Worker
// (over the private EMAIL_SERVICE binding) which settings it has, and reads
// the counts the Worker writes.
import {
  ALIAS_MAX_AGE_MS,
  EXCHANGE_MIRROR_SETTING_COLLEAGUE_SEND,
  EXCHANGE_MIRROR_SETTING_ENABLED,
  M365_ALIAS_SYNC_SETTING_APPROVE_REMOVALS,
  M365_ALIAS_SYNC_SETTING_ENABLED,
  loadAliasSyncState,
  loadAliasSyncSwitch,
  loadExchangeMirrorDays,
  loadExchangeMirrorSwitch,
  mirrorDay,
  type AliasSyncState,
  type ExchangeMirrorDay,
} from '@stanchion/shared/exchange-mirror';
import {
  GRAPH_IMPORT_SETTING_ESTIMATE,
  GRAPH_IMPORT_SETTING_JOB,
  GRAPH_IMPORT_SETTING_REQUEST,
  graphImportFigures,
  graphImportPeriod,
  graphImportPeriodAt,
  parseGraphImportEstimate,
  parseGraphImportJob,
  parseGraphImportRequest,
  type GraphImportEstimate,
  type GraphImportFigures,
  type GraphImportJob,
} from '@stanchion/shared/graph-import';
import {
  GRAPH_MIRROR_FOLDERS,
  GRAPH_MIRROR_SETTING_ENABLED,
  loadGraphMirrorStatus,
  loadGraphMirrorSwitch,
  type GraphMirrorFolder,
  type GraphMirrorStatus,
} from '@stanchion/shared/graph-mirror';
import { loadM365SyncSwitch } from '@stanchion/shared/m365-sync';
import { audit } from './db';

export type ExchangeMirrorWorkerConfig =
  | { state: 'configured'; maskedAddress: string; senderDomains: string[]; requireAuth: boolean; mirrorSent: boolean; tenantCheck: boolean }
  | { state: 'not_configured'; problems: string[] }
  /** No EMAIL_SERVICE binding, or the Worker did not answer. */
  | { state: 'unknown' };

export type GraphMirrorWorkerConfig =
  | { state: 'configured'; folders: GraphMirrorFolder[]; lookbackHours: number; initialCap: number }
  | { state: 'not_configured'; problems: string[] }
  | { state: 'unknown' };

export interface GraphMirrorOverview {
  enabled: boolean;
  /** False until migration 0033 is applied. */
  installed: boolean;
  config: GraphMirrorWorkerConfig;
  status: GraphMirrorStatus | null;
  import: GraphImportOverview;
}

/** "Import older mail" (docs/exchange-mirror.md#import-older-mail): what the Admin page shows. */
export interface GraphImportOverview {
  /** The last dry run (or the recount made when Start was pressed). */
  estimate: GraphImportEstimate | null;
  /** Its figures: Cloudflare storage impact, cost, time. */
  figures: GraphImportFigures | null;
  /** Largest mailboxes of the estimate, with their addresses. */
  mailboxes: Array<{ address: string; messages: number; bytes: number }>;
  job: GraphImportJob | null;
  /** A request the Worker has not picked up yet (its next run, within a few minutes). */
  requestPending: 'estimate' | 'start' | null;
}

export interface ExchangeMirrorOverview {
  /** The Graph source (recommended). */
  graph: GraphMirrorOverview;
  enabled: boolean;
  /** "Send colleague mail through Exchange": the stored switch (it acts only while the mirror is on). */
  colleagueSend: boolean;
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
  /** The mirror uses aliases now: import on and last full success under 3 days old. */
  aliasesFresh: boolean;
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

export async function graphMirrorWorkerConfig(service: unknown): Promise<GraphMirrorWorkerConfig> {
  if (!isFetcher(service)) return { state: 'unknown' };
  try {
    const response = await service.fetch(`${WORKER}/internal/graph-mirror/config`, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { state: 'unknown' };
    const body = await response.json() as Record<string, unknown>;
    if (body.configured === false) {
      const problems = Array.isArray(body.problems)
        ? body.problems.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 200)).slice(0, 10)
        : [];
      return { state: 'not_configured', problems };
    }
    if (body.configured !== true) return { state: 'unknown' };
    const known = new Set<string>(GRAPH_MIRROR_FOLDERS);
    const folders = Array.isArray(body.folders) ? body.folders.filter((item): item is GraphMirrorFolder => typeof item === 'string' && known.has(item)) : [];
    const lookbackHours = Number(body.lookbackHours);
    const initialCap = Number(body.initialCap);
    if (!folders.length || !Number.isSafeInteger(lookbackHours) || !Number.isSafeInteger(initialCap)) return { state: 'unknown' };
    return { state: 'configured', folders, lookbackHours, initialCap };
  } catch {
    return { state: 'unknown' };
  }
}

const EMPTY_IMPORT: GraphImportOverview = { estimate: null, figures: null, mailboxes: [], job: null, requestPending: null };

async function loadImportRecords(db: D1Database): Promise<{ request: ReturnType<typeof parseGraphImportRequest>; estimate: GraphImportEstimate | null; job: GraphImportJob | null }> {
  const { results } = await db.prepare('SELECT key, value FROM org_settings WHERE key IN (?, ?, ?)')
    .bind(GRAPH_IMPORT_SETTING_REQUEST, GRAPH_IMPORT_SETTING_ESTIMATE, GRAPH_IMPORT_SETTING_JOB).all<{ key: string; value: string }>();
  const values = new Map((results ?? []).map((row) => [row.key, row.value]));
  return {
    request: parseGraphImportRequest(values.get(GRAPH_IMPORT_SETTING_REQUEST)),
    estimate: parseGraphImportEstimate(values.get(GRAPH_IMPORT_SETTING_ESTIMATE)),
    job: parseGraphImportJob(values.get(GRAPH_IMPORT_SETTING_JOB)),
  };
}

/** The figures an estimate shows (and Start checks): the same function the Worker uses at the recount. */
function estimateFigures(estimate: GraphImportEstimate): GraphImportFigures {
  return graphImportFigures({ messages: estimate.messages, bytes: estimate.bytes, d1UsedBytes: estimate.d1UsedBytes >= 0 ? estimate.d1UsedBytes : null, period: estimate.period });
}

async function loadImportOverview(db: D1Database): Promise<GraphImportOverview> {
  try {
    const { request, estimate, job } = await loadImportRecords(db);
    const top = estimate?.status === 'done' ? estimate.perMailbox.slice(0, 10) : [];
    const names = new Map<string, string>();
    if (top.length) {
      const { results } = await db.prepare(`SELECT id, address FROM mailboxes WHERE id IN (${top.map(() => '?').join(', ')})`)
        .bind(...top.map((row) => row[0])).all<{ id: string; address: string }>();
      for (const row of results ?? []) names.set(row.id, row.address);
    }
    const handled = Boolean(request && estimate && estimate.requestSeq === request.seq);
    return {
      estimate,
      figures: estimate ? estimateFigures(estimate) : null,
      mailboxes: top.map(([id, messages, bytes]) => ({ address: names.get(id) ?? 'a mailbox', messages, bytes })),
      job,
      requestPending: request && !handled && job?.status !== 'running' ? request.kind : null,
    };
  } catch {
    console.error('Import older mail: its records could not be read');
    return EMPTY_IMPORT;
  }
}

async function loadGraphMirrorOverview(env: { DB: D1Database; EMAIL_SERVICE?: unknown }): Promise<GraphMirrorOverview> {
  const [value, config] = await Promise.all([
    loadGraphMirrorSwitch(env.DB).catch(() => ({ enabled: false })),
    graphMirrorWorkerConfig(env.EMAIL_SERVICE),
  ]);
  let installed = true;
  let status: GraphMirrorStatus | null = null;
  try {
    status = await loadGraphMirrorStatus(env.DB);
  } catch {
    installed = false;
  }
  return { enabled: value.enabled, installed, config, status, import: installed ? await loadImportOverview(env.DB) : EMPTY_IMPORT };
}

export async function loadExchangeMirrorOverview(
  env: { DB: D1Database; EMAIL_SERVICE?: unknown },
  now = Date.now(),
): Promise<ExchangeMirrorOverview> {
  const db = env.DB;
  const [graph, enabled, colleagueSend, aliasEnabled, config, sync] = await Promise.all([
    loadGraphMirrorOverview(env),
    loadExchangeMirrorSwitch(db).catch(() => false),
    db.prepare('SELECT value FROM org_settings WHERE key = ?').bind(EXCHANGE_MIRROR_SETTING_COLLEAGUE_SEND)
      .first<{ value: string }>().then((row) => row?.value === 'true', () => false),
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
    graph,
    enabled,
    colleagueSend,
    aliasEnabled,
    installed,
    config,
    days,
    lastReportAt,
    sync: { enabled: sync.enabled, dryRun: sync.dryRun },
    aliasState,
    aliasCount,
    aliasesFresh: aliasEnabled && Boolean(aliasState?.lastOkAt && now - aliasState.lastOkAt <= ALIAS_MAX_AGE_MS),
    now,
  };
}

export type ExchangeMirrorAdminAction = 'enable' | 'disable' | 'alias_enable' | 'alias_disable' | 'alias_approve_removals'
  | 'colleague_send_enable' | 'colleague_send_disable'
  | 'graph_enable' | 'graph_disable' | 'graph_run_now' | 'graph_import_estimate' | 'graph_import_start' | 'graph_import_stop';

const ACTIONS: ReadonlySet<string> = new Set([
  'enable', 'disable', 'alias_enable', 'alias_disable', 'alias_approve_removals', 'colleague_send_enable', 'colleague_send_disable',
  'graph_enable', 'graph_disable', 'graph_run_now', 'graph_import_estimate', 'graph_import_start', 'graph_import_stop',
]);

export function parseExchangeMirrorAdminAction(value: unknown): ExchangeMirrorAdminAction | null {
  return typeof value === 'string' && ACTIONS.has(value) ? value as ExchangeMirrorAdminAction : null;
}

/** Form values for the import actions; every one is checked again here. */
export interface GraphImportInput {
  /** The slider position, 0 to 7. */
  stop?: unknown;
  /** Start: the estimate's id and the numbers the manager confirmed. */
  estimateId?: unknown;
  messages?: unknown;
  bytes?: unknown;
  confirmed?: unknown;
  now?: number;
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
  input: GraphImportInput = {},
): Promise<ExchangeMirrorAdminResult> {
  const db = env.DB;
  const actor = { actor_id: manager.id, actor_role: 'manager' as const };
  if (action.startsWith('graph_')) return applyGraphAction(env, manager, action, input);
  if (action === 'colleague_send_enable') {
    if (!await loadExchangeMirrorSwitch(db)) return { ok: false, status: 409, error: 'Turn the Exchange mirror on first' };
    await putSetting(db, EXCHANGE_MIRROR_SETTING_COLLEAGUE_SEND, true, manager.id);
    await audit(db, { event_type: 'org.exchange_mirror_colleague_send_toggled', ...actor, detail: 'Send colleague mail through Exchange turned on' });
    return { ok: true, message: 'Mail to colleagues on the mail domain now goes through Exchange, so it shows in Outlook; their Stanchion copy comes from the mirror.' };
  }
  if (action === 'colleague_send_disable') {
    await putSetting(db, EXCHANGE_MIRROR_SETTING_COLLEAGUE_SEND, false, manager.id);
    await audit(db, { event_type: 'org.exchange_mirror_colleague_send_toggled', ...actor, detail: 'Send colleague mail through Exchange turned off' });
    return { ok: true, message: 'Mail to colleagues is delivered straight into their Stanchion mailbox again (Outlook does not see it).' };
  }
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
    return { ok: true, message: 'The alias import is on. It runs with the Microsoft 365 sync (live, not dry run); the mirror uses aliases after its first full import.' };
  }
  if (action === 'alias_approve_removals') {
    await putSetting(db, M365_ALIAS_SYNC_SETTING_APPROVE_REMOVALS, true, manager.id);
    await audit(db, { event_type: 'org.m365_alias_removals_approved', ...actor, detail: 'Approved the held Microsoft 365 alias removals (next import run only)' });
    return { ok: true, message: 'Approved. The next alias import removes the held aliases, once.' };
  }
  if (action === 'disable') {
    await putSetting(db, EXCHANGE_MIRROR_SETTING_ENABLED, false, manager.id);
    await audit(db, { event_type: 'org.exchange_mirror_toggled', ...actor, detail: 'Exchange mirror turned off' });
    return { ok: true, message: 'The Exchange mirror is off. Mail to the journal address is refused like any unknown address.' };
  }
  await putSetting(db, M365_ALIAS_SYNC_SETTING_ENABLED, false, manager.id);
  await audit(db, { event_type: 'org.m365_alias_sync_toggled', ...actor, detail: 'Microsoft 365 alias import turned off' });
  return { ok: true, message: 'The alias import is off. The mirror stops using imported aliases at once; the rows stay until the import runs again.' };
}

async function putValue(db: D1Database, key: string, value: string, managerId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO org_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
  ).bind(key, value, managerId).run();
}

/** The Graph source's switch, "Run now" and "Import older mail". The caller has checked the manager role. */
async function applyGraphAction(
  env: { DB: D1Database; EMAIL_SERVICE?: unknown },
  manager: { id: string },
  action: ExchangeMirrorAdminAction,
  input: GraphImportInput,
): Promise<ExchangeMirrorAdminResult> {
  const db = env.DB;
  const actor = { actor_id: manager.id, actor_role: 'manager' as const };
  if (action === 'graph_disable') {
    await putSetting(db, GRAPH_MIRROR_SETTING_ENABLED, false, manager.id);
    await audit(db, { event_type: 'org.graph_mirror_toggled', ...actor, detail: 'Exchange mirror Graph source turned off' });
    return { ok: true, message: 'The Graph source is off. Nothing more is read from Microsoft 365; mail already filed stays.' };
  }
  const graph = await loadGraphMirrorOverview(env);
  if (!graph.installed) return { ok: false, status: 409, error: 'Apply database migration 0033 first' };
  if (action === 'graph_enable') {
    if (graph.config.state === 'not_configured') {
      return { ok: false, status: 409, error: 'The email Worker is missing the Microsoft 365 app settings. See the list on this page.' };
    }
    await putSetting(db, GRAPH_MIRROR_SETTING_ENABLED, true, manager.id);
    await audit(db, { event_type: 'org.graph_mirror_toggled', ...actor, detail: 'Exchange mirror Graph source turned on' });
    return { ok: true, message: 'The Graph source is on. Within a few minutes Stanchion starts reading new mail from each linked mailbox.' };
  }
  // Stop always works, even with the source off.
  if (action === 'graph_import_stop') return applyImportAction(env, manager, action, input);
  if (!graph.enabled) return { ok: false, status: 409, error: 'Turn the Graph source on first' };
  if (action === 'graph_import_estimate' || action === 'graph_import_start') return applyImportAction(env, manager, action, input);
  // graph_run_now: one bounded run in the Worker; the lease still applies.
  if (!isFetcher(env.EMAIL_SERVICE)) return { ok: false, status: 503, error: 'The email Worker is not reachable from this app' };
  await audit(db, { event_type: 'org.graph_mirror_run_now', ...actor, detail: 'Exchange mirror Graph source: run now' });
  try {
    const response = await env.EMAIL_SERVICE.fetch(`${WORKER}/internal/graph-mirror/run`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => ({})) as { status?: unknown; filed?: unknown; complete?: unknown };
    if (body.status === 'worked') {
      const filed = Number(body.filed) || 0;
      return { ok: true, message: `Ran. ${filed} message${filed === 1 ? '' : 's'} filed${body.complete === true ? '' : '; the next scheduled run continues where this one stopped'}.` };
    }
    if (body.status === 'busy') return { ok: true, message: 'A run is already in progress. Check the status in a minute.' };
    return { ok: false, status: 503, error: 'The run did not complete. See the status on this page.' };
  } catch {
    return { ok: false, status: 503, error: 'The email Worker did not answer in time. The scheduled run continues.' };
  }
}

const COUNT = /^\d{1,15}$/;

/**
 * "Import older mail": ask for a dry run, confirm and start, or stop. Nothing
 * here reads Microsoft 365; the email Worker does the work on its next run
 * (within a few minutes) and writes the results back. Stop acts at once.
 */
async function applyImportAction(
  env: { DB: D1Database },
  manager: { id: string },
  action: 'graph_import_estimate' | 'graph_import_start' | 'graph_import_stop',
  input: GraphImportInput,
): Promise<ExchangeMirrorAdminResult> {
  const db = env.DB;
  const actor = { actor_id: manager.id, actor_role: 'manager' as const };
  const at = input.now ?? Date.now();
  const { request, estimate, job } = await loadImportRecords(db);

  if (action === 'graph_import_stop') {
    // One statement: only a 'running' record changes, so a Worker write after this is a no-op.
    const stopped = await db.prepare(
      `UPDATE org_settings SET value = json_patch(value, ?), updated_at = datetime('now'), updated_by = ?
       WHERE key IN (?, ?) AND json_extract(value, '$.status') = 'running'`,
    ).bind(JSON.stringify({ status: 'stopped', finishedAt: at }), manager.id, GRAPH_IMPORT_SETTING_JOB, GRAPH_IMPORT_SETTING_ESTIMATE).run();
    // A request the Worker has not picked up is withdrawn too.
    await db.prepare('DELETE FROM org_settings WHERE key = ?').bind(GRAPH_IMPORT_SETTING_REQUEST).run();
    if (Number(stopped.meta?.changes ?? 0) === 0 && !request) return { ok: true, message: 'Nothing was running.' };
    await audit(db, { event_type: 'org.graph_mirror_import_stopped', ...actor, detail: 'Import older mail: stopped' });
    return { ok: true, message: 'Stopped. Mail already imported stays; nothing more is read. You can run a new estimate and start again; mail already in Stanchion is not filed twice.' };
  }

  if (job?.status === 'running') return { ok: false, status: 409, error: 'An import is already running. Stop it first, or wait for it to finish.' };
  if (estimate?.status === 'running' || (request && request.seq !== estimate?.requestSeq)) {
    return { ok: false, status: 409, error: 'A count is already in progress. Wait for it to finish, or stop it.' };
  }

  if (action === 'graph_import_estimate') {
    const period = graphImportPeriodAt(input.stop);
    if (!period) return { ok: false, status: 400, error: 'Choose a period on the slider' };
    await putValue(db, GRAPH_IMPORT_SETTING_REQUEST, JSON.stringify({ seq: crypto.randomUUID(), kind: 'estimate', period: period.key, at }), manager.id);
    await audit(db, { event_type: 'org.graph_mirror_import_estimate', ...actor, detail: `Import older mail: estimate requested, ${period.label}` });
    return { ok: true, message: `Counting ${period.label.toLowerCase()} of mail in every mirrored mailbox. Nothing is imported or written. It starts on the next scheduled run (within about 5 minutes) and shows its progress here.` };
  }

  // graph_import_start
  if (!estimate || estimate.status !== 'done' || (estimate.then && !estimate.changed) || estimate.jobId || estimate.refused) {
    return { ok: false, status: 409, error: 'Run an estimate first, and wait for it to finish.' };
  }
  if (typeof input.estimateId !== 'string' || input.estimateId !== estimate.id) {
    return { ok: false, status: 409, error: 'That estimate is out of date. Review the new numbers.' };
  }
  const figures = estimateFigures(estimate);
  if (figures.blocked) {
    return { ok: false, status: 409, error: figures.blockReason === 'd1_over'
      ? 'This import would take the database past its size limit, so it cannot start. Choose a shorter period.'
      : 'The database size could not be read, so the storage limit cannot be checked. "All mail" cannot start; choose a shorter period.' };
  }
  const messages = typeof input.messages === 'string' && COUNT.test(input.messages) ? Number(input.messages) : -1;
  const bytes = typeof input.bytes === 'string' && COUNT.test(input.bytes) ? Number(input.bytes) : -1;
  if (input.confirmed !== 'yes') return { ok: false, status: 400, error: 'Tick the box to confirm you have read the warning and the numbers' };
  if (messages !== estimate.messages || bytes !== estimate.bytes) {
    return { ok: false, status: 409, error: 'The numbers on the page are not the current estimate. Review them and confirm again.' };
  }
  await putValue(db, GRAPH_IMPORT_SETTING_REQUEST, JSON.stringify({
    seq: crypto.randomUUID(), kind: 'start', period: estimate.period, at, confirm: { messages, bytes },
  }), manager.id);
  await audit(db, {
    event_type: 'org.graph_mirror_import_start',
    ...actor,
    detail: `Import older mail: confirmed ${graphImportPeriod(estimate.period)?.label ?? estimate.period}, about ${messages} messages and ${bytes} bytes; the Worker recounts first`,
  });
  return { ok: true, message: 'Confirmed. On its next run (within about 5 minutes) Stanchion counts again to check the numbers; if they moved by more than 20% it asks you again, otherwise the import starts. You can stop it at any time.' };
}
