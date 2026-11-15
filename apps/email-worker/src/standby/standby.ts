// Standby test address and daily probe (docs/standby-probe.md).
//
// 1. Alias: local@<label>.<MAIL_DOMAIN> delivers into the mailbox at
//    local@<MAIL_DOMAIN>, only while a manager has the switch on, only into
//    an active mailbox, and never for a paused or offboarded owner. It does
//    not forward, relay or create anything, and an unknown local part gets
//    the same neutral refusal as on the primary domain.
// 2. Probe: once a day (and on "Run test now") the Worker sends one message
//    through Cloudflare Email Sending to the probe mailbox's standby address,
//    so it goes out and back in through the public MX and Email Routing like
//    real mail. The inbound handler matches its one-time token, stores it in
//    the dedicated system mailbox through the normal delivery path, and
//    records the round trip here. No arrival within the timeout is a failure.
//
// Logs carry outcome codes only, never addresses or tokens.
import {
  STANDBY_MESSAGE_RETENTION_DAYS,
  STANDBY_PROBE_HEADER,
  STANDBY_PROBE_SUBJECT_PREFIX,
  STANDBY_RUN_RETENTION_DAYS,
  STANDBY_SETTING_ENABLED,
  STANDBY_SLOW_MS,
  loadStandbySwitch,
  standbyConfig,
  standbyPrimaryAddress,
  type StandbyConfig,
  type StandbyEnv,
} from '@cmail/shared/standby';

/** Its own cron, so the M365 sync and the probe never share a run budget. */
export const STANDBY_PROBE_CRON = '*/10 * * * *';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Scheduled probes start once a day; the slack keeps a 10-minute cron from drifting later each day. */
const SCHEDULE_EVERY_MS = DAY_MS - 10 * 60 * 1000;
/** Run test now: at most one start per minute. */
const MANUAL_MIN_GAP_MS = 60 * 1000;
const LEASE_MS = 60 * 1000;
const PRUNE_BATCH = 50;
const TOKEN_RX = /^[A-Za-z0-9_-]{43}$/;
const ENCODER = new TextEncoder();

export interface StandbyWorkerEnv extends StandbyEnv {
  DB: D1Database;
  STORAGE: R2Bucket;
  EMAIL?: SendEmail;
}

export interface StandbyDeps {
  now?: () => number;
  newId?: () => string;
  newToken?: () => string;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashProbeToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ENCODER.encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ─── Alias resolution (inbound) ──────────────────────────────────────────

export interface ResolvedMailbox {
  id: string;
  status: string;
  address: string;
}

/**
 * The mailbox a standby address delivers to, or null. Called only after the
 * exact address lookup found nothing. Every condition is in one query: the
 * switch is on, the primary mailbox is active, and it is shared or owned by
 * an active or pending (not paused or offboarded) account. A personal mailbox
 * with no recorded owner is refused. A database error is thrown, like the
 * exact lookup, so the delivery is retried rather than bounced.
 */
export async function resolveStandbyMailbox(
  db: D1Database,
  env: StandbyEnv,
  recipient: string,
): Promise<ResolvedMailbox | null> {
  const check = standbyConfig(env);
  if (!check.configured) return null;
  const primary = standbyPrimaryAddress(recipient, check.config);
  if (!primary) return null;
  return db.prepare(
    `SELECT m.id, m.status, m.address FROM mailboxes m
     LEFT JOIN users u ON u.id = m.owner_user_id
     WHERE m.address = ? AND m.status = 'active'
       AND (m.type = 'shared' OR (m.type = 'personal' AND u.status IN ('active', 'pending')))
       AND EXISTS (SELECT 1 FROM org_settings WHERE key = ? AND value = 'true')
     LIMIT 1`,
  ).bind(primary, STANDBY_SETTING_ENABLED).first<ResolvedMailbox>();
}

// ─── Inbound: is this the probe? ─────────────────────────────────────────

/** The token from the probe header, or from the subject as a fallback. */
export function probeTokenFrom(headers: { get(name: string): string | null }): string | null {
  const header = (headers.get(STANDBY_PROBE_HEADER) || '').trim();
  if (TOKEN_RX.test(header)) return header;
  const subject = (headers.get('subject') || '').trim();
  if (subject.startsWith(STANDBY_PROBE_SUBJECT_PREFIX)) {
    const candidate = subject.slice(STANDBY_PROBE_SUBJECT_PREFIX.length).trim();
    if (TOKEN_RX.test(candidate)) return candidate;
  }
  return null;
}

export type ProbeDecision =
  /** Not the probe mailbox: deliver as normal. */
  | { action: 'normal' }
  /** The probe mailbox, but not a live probe: refuse like an unknown address. */
  | { action: 'reject' }
  /** A probe already answered (duplicate) or one that arrived late (recorded): accept, store nothing. */
  | { action: 'drop'; why: 'duplicate' | 'late' }
  /** A live probe: deliver through the normal path, then call recordProbeReceipt. */
  | { action: 'deliver'; runId: string; startedAt: number };

/**
 * Decides what the inbound handler does with mail for the probe mailbox.
 * Only mail that arrived on the standby address and carries the token of a
 * known probe is stored; anything else for that mailbox is refused, so the
 * system mailbox never collects spam or real mail. Costs one query, and only
 * for mail to the probe mailbox's own address.
 */
export async function decideProbeDelivery(
  db: D1Database,
  env: StandbyEnv,
  input: { mailbox: ResolvedMailbox; viaStandby: boolean; headers: { get(name: string): string | null } },
  deps: StandbyDeps = {},
): Promise<ProbeDecision> {
  const check = standbyConfig(env);
  if (!check.configured || input.mailbox.address !== check.config.probeAddress) return { action: 'normal' };
  const state = await db.prepare('SELECT mailbox_id FROM standby_probe_state WHERE id = 1')
    .first<{ mailbox_id: string | null }>()
    .catch(() => null);
  // A real mailbox that happens to have this address is left alone.
  if (!state?.mailbox_id || state.mailbox_id !== input.mailbox.id) return { action: 'normal' };
  const token = probeTokenFrom(input.headers);
  if (!input.viaStandby || !token) return { action: 'reject' };
  const run = await db.prepare(
    'SELECT id, status, reason, started_at FROM standby_probe_runs WHERE token_hash = ?',
  ).bind(await hashProbeToken(token)).first<{ id: string; status: string; reason: string; started_at: number }>();
  if (!run) return { action: 'reject' };
  if (run.status === 'sending' || run.status === 'waiting') {
    return { action: 'deliver', runId: run.id, startedAt: Number(run.started_at) };
  }
  if (run.status === 'fail' && run.reason === 'timeout') {
    const now = (deps.now ?? Date.now)();
    await db.prepare(
      `UPDATE standby_probe_runs SET reason = 'late', late_ms = ?, detail = ?
       WHERE id = ? AND status = 'fail' AND reason = 'timeout'`,
    ).bind(now - Number(run.started_at), `Arrived after ${Math.round((now - Number(run.started_at)) / 1000)} s`, run.id).run();
    return { action: 'drop', why: 'late' };
  }
  return { action: 'drop', why: 'duplicate' };
}

/**
 * Records a stored probe. Conditional on the run still waiting, so a
 * duplicate never changes a result and a probe that timed out meanwhile is
 * marked late instead.
 */
export async function recordProbeReceipt(
  db: D1Database,
  input: {
    runId: string;
    startedAt: number;
    messageId: string;
    folder: string;
    auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  },
  deps: StandbyDeps = {},
): Promise<'pass' | 'late'> {
  const now = (deps.now ?? Date.now)();
  const roundTrip = Math.max(0, now - input.startedAt);
  const warnings: string[] = [];
  if (input.folder === 'spam') warnings.push('spam_folder');
  if (!input.auth.dmarc) warnings.push('auth_not_recorded');
  else if (input.auth.dmarc !== 'pass') warnings.push('dmarc_not_pass');
  if (roundTrip > STANDBY_SLOW_MS) warnings.push('slow');
  const result = await db.prepare(
    `UPDATE standby_probe_runs
     SET status = 'pass', in_flight = NULL, reason = '', received_at = ?, round_trip_ms = ?, message_id = ?,
         folder = ?, spf_result = ?, dkim_result = ?, dmarc_result = ?, warnings = ?
     WHERE id = ? AND status IN ('sending', 'waiting')`,
  ).bind(
    now, roundTrip, input.messageId.slice(0, 128), input.folder.slice(0, 32),
    input.auth.spf?.slice(0, 32) ?? null, input.auth.dkim?.slice(0, 32) ?? null, input.auth.dmarc?.slice(0, 32) ?? null,
    warnings.join(','), input.runId,
  ).run();
  if (result.meta.changes) return 'pass';
  // Timed out between the check and the store: keep the message id so the
  // stored copy is still pruned.
  await db.prepare(
    `UPDATE standby_probe_runs SET reason = 'late', late_ms = ?, message_id = COALESCE(message_id, ?),
       detail = ?
     WHERE id = ? AND status = 'fail'`,
  ).bind(roundTrip, input.messageId.slice(0, 128), `Arrived after ${Math.round(roundTrip / 1000)} s`, input.runId).run();
  return 'late';
}

// ─── Sending a probe ─────────────────────────────────────────────────────

export type ProbeStart =
  | { status: 'off' }
  | { status: 'not_configured'; problems: string[] }
  | { status: 'busy' }
  | { status: 'too_soon' }
  | { status: 'started'; runId: string }
  | { status: 'failed'; runId: string; reason: string };

async function ensureState(db: D1Database): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO standby_probe_state (id) VALUES (1)').run();
}

async function takeLease(db: D1Database, now: number): Promise<boolean> {
  const lease = await db.prepare(
    'UPDATE standby_probe_state SET lease_until = ? WHERE id = 1 AND lease_until < ?',
  ).bind(now + LEASE_MS, now).run();
  return lease.meta.changes > 0;
}

async function releaseLease(db: D1Database): Promise<void> {
  await db.prepare('UPDATE standby_probe_state SET lease_until = 0 WHERE id = 1').run().catch(() => undefined);
}

/** Overdue probes become failures with reason 'timeout'. */
export async function finalizeOverdue(db: D1Database, now: number, timeoutMinutes: number): Promise<number> {
  const result = await db.prepare(
    `UPDATE standby_probe_runs SET status = 'fail', in_flight = NULL, reason = 'timeout',
       detail = ?
     WHERE status IN ('sending', 'waiting') AND started_at < ?`,
  ).bind(`No arrival within ${timeoutMinutes} minutes`, now - timeoutMinutes * 60 * 1000).run();
  return result.meta.changes;
}

/**
 * The dedicated system mailbox: a shared mailbox at the probe address with
 * nobody assigned. Created on first use; never adopted if a manager already
 * made a mailbox at that address for something else.
 */
async function ensureProbeMailbox(
  db: D1Database,
  config: StandbyConfig,
  newId: () => string,
): Promise<{ ok: true; mailboxId: string } | { ok: false; reason: string }> {
  const state = await db.prepare('SELECT mailbox_id FROM standby_probe_state WHERE id = 1').first<{ mailbox_id: string | null }>();
  const existing = await db.prepare('SELECT id, status FROM mailboxes WHERE address = ?')
    .bind(config.probeAddress).first<{ id: string; status: string }>();
  if (existing) {
    if (existing.id !== state?.mailbox_id) return { ok: false, reason: 'probe_address_in_use' };
    if (existing.status !== 'active') return { ok: false, reason: 'probe_mailbox_disabled' };
    return { ok: true, mailboxId: existing.id };
  }
  const mailboxId = newId();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO mailboxes (id, address, display_name, type, status, owner_user_id, created_at)
         VALUES (?, ?, 'Standby probe (system)', 'shared', 'active', NULL, datetime('now'))`,
      ).bind(mailboxId, config.probeAddress),
      db.prepare(`UPDATE standby_probe_state SET mailbox_id = ?, updated_at = datetime('now') WHERE id = 1`).bind(mailboxId),
      db.prepare(
        `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
         VALUES (?, datetime('now'), NULL, 'system', 'org.standby_probe_mailbox_created', ?, ?)`,
      ).bind(newId(), mailboxId, 'Created the standby probe system mailbox'),
    ]);
  } catch {
    return { ok: false, reason: 'probe_mailbox_missing' };
  }
  return { ok: true, mailboxId };
}

function sendErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  return /^E_[A-Z_]{1,60}$/.test(code) ? code : '';
}

async function insertRun(
  db: D1Database,
  run: { id: string; tokenHash: string; kind: 'schedule' | 'manual'; status: 'sending' | 'fail'; reason?: string; detail?: string; startedAt: number },
): Promise<boolean> {
  try {
    await db.prepare(
      `INSERT INTO standby_probe_runs (id, token_hash, kind, status, in_flight, reason, detail, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      run.id, run.tokenHash, run.kind, run.status, run.status === 'sending' ? 1 : null,
      run.reason ?? '', (run.detail ?? '').slice(0, 200), run.startedAt,
    ).run();
    return true;
  } catch {
    // The UNIQUE in_flight column: another probe is already running.
    return false;
  }
}

/**
 * Starts one probe. The caller holds the lease and has checked the switch
 * and configuration. A failure before the message leaves (no binding, no
 * probe mailbox, a refused send) is recorded as a failed run, so Admin shows
 * the exact reason.
 */
async function startProbe(
  env: StandbyWorkerEnv,
  config: StandbyConfig,
  kind: 'schedule' | 'manual',
  deps: Required<StandbyDeps>,
): Promise<ProbeStart> {
  const db = env.DB;
  const now = deps.now();
  const runId = deps.newId();
  const token = deps.newToken();
  const tokenHash = await hashProbeToken(token);
  await db.prepare(
    kind === 'schedule'
      ? 'UPDATE standby_probe_state SET last_scheduled_at = ? WHERE id = 1'
      : 'UPDATE standby_probe_state SET last_manual_at = ? WHERE id = 1',
  ).bind(now).run();

  const inFlight = await db.prepare('SELECT 1 AS busy FROM standby_probe_runs WHERE in_flight = 1').first<{ busy: number }>();
  if (inFlight) return { status: 'busy' };

  const fail = async (reason: string, detail = ''): Promise<ProbeStart> => {
    await insertRun(db, { id: runId, tokenHash, kind, status: 'fail', reason, detail, startedAt: now });
    return { status: 'failed', runId, reason };
  };
  if (!env.EMAIL) return fail('no_send_binding');
  const mailbox = await ensureProbeMailbox(db, config, deps.newId);
  if (!mailbox.ok) return fail(mailbox.reason);

  if (!await insertRun(db, { id: runId, tokenHash, kind, status: 'sending', startedAt: now })) return { status: 'busy' };
  const sentAt = new Date(now).toISOString();
  try {
    await env.EMAIL.send({
      from: { email: config.probeAddress, name: 'cmail standby test' },
      to: config.probeStandbyAddress,
      subject: `${STANDBY_PROBE_SUBJECT_PREFIX}${token}`,
      text: `Automatic test of the standby address, sent ${sentAt}. It is stored in the standby probe system mailbox and removed after ${STANDBY_MESSAGE_RETENTION_DAYS} days.`,
      html: `<p>Automatic test of the standby address, sent ${sentAt}. It is stored in the standby probe system mailbox and removed after ${STANDBY_MESSAGE_RETENTION_DAYS} days.</p>`,
      headers: { [STANDBY_PROBE_HEADER]: token },
    });
  } catch (error) {
    const code = sendErrorCode(error);
    await db.prepare(
      `UPDATE standby_probe_runs SET status = 'fail', in_flight = NULL, reason = ?, detail = ?
       WHERE id = ? AND status = 'sending'`,
    ).bind(code ? 'send_rejected' : 'send_failed', code, runId).run();
    return { status: 'failed', runId, reason: code ? 'send_rejected' : 'send_failed' };
  }
  // The probe may already have arrived and passed; only move a run still sending.
  await db.prepare(
    `UPDATE standby_probe_runs
     SET sent_at = COALESCE(sent_at, ?), status = CASE WHEN status = 'sending' THEN 'waiting' ELSE status END
     WHERE id = ?`,
  ).bind(deps.now(), runId).run();
  return { status: 'started', runId };
}

function fullDeps(deps: StandbyDeps): Required<StandbyDeps> {
  return {
    now: deps.now ?? Date.now,
    newId: deps.newId ?? (() => crypto.randomUUID()),
    newToken: deps.newToken ?? randomToken,
  };
}

async function guarded(
  env: StandbyWorkerEnv,
  deps: Required<StandbyDeps>,
  work: (config: StandbyConfig) => Promise<ProbeStart | TickResult>,
): Promise<ProbeStart | TickResult> {
  if (!await loadStandbySwitch(env.DB)) return { status: 'off' };
  const check = standbyConfig(env);
  if (!check.configured) {
    await ensureState(env.DB);
    await env.DB.prepare('UPDATE standby_probe_state SET last_problem = ?, last_tick_at = ? WHERE id = 1')
      .bind(check.problems.join('; ').slice(0, 200), deps.now()).run();
    return { status: 'not_configured', problems: check.problems };
  }
  await ensureState(env.DB);
  if (!await takeLease(env.DB, deps.now())) return { status: 'busy' };
  try {
    return await work(check.config);
  } finally {
    await releaseLease(env.DB);
  }
}

/** "Run test now" from Admin, over the private service binding. */
export async function runStandbyProbeNow(env: StandbyWorkerEnv, deps: StandbyDeps = {}): Promise<ProbeStart> {
  const d = fullDeps(deps);
  return (await guarded(env, d, async (config) => {
    const now = d.now();
    await finalizeOverdue(env.DB, now, config.timeoutMinutes);
    const state = await env.DB.prepare('SELECT last_manual_at FROM standby_probe_state WHERE id = 1').first<{ last_manual_at: number }>();
    if (state && now - Number(state.last_manual_at) < MANUAL_MIN_GAP_MS) return { status: 'too_soon' };
    return startProbe(env, config, 'manual', d);
  })) as ProbeStart;
}

export type TickResult =
  | ProbeStart
  | { status: 'idle'; finalized: number; pruned: number };

/**
 * The cron. Off: one org_settings read and nothing else. On: time out
 * overdue probes, prune, and start the daily probe when it is due.
 */
export async function runStandbyProbeTick(env: StandbyWorkerEnv, deps: StandbyDeps = {}): Promise<TickResult> {
  const d = fullDeps(deps);
  return guarded(env, d, async (config) => {
    const now = d.now();
    const finalized = await finalizeOverdue(env.DB, now, config.timeoutMinutes);
    const pruned = await pruneStandby(env, now);
    await env.DB.prepare(`UPDATE standby_probe_state SET last_tick_at = ?, last_problem = '' WHERE id = 1`).bind(now).run();
    const state = await env.DB.prepare('SELECT last_scheduled_at FROM standby_probe_state WHERE id = 1').first<{ last_scheduled_at: number }>();
    if (state && now - Number(state.last_scheduled_at) < SCHEDULE_EVERY_MS) return { status: 'idle', finalized, pruned };
    return startProbe(env, config, 'schedule', d);
  });
}

// ─── Pruning ─────────────────────────────────────────────────────────────

/**
 * Deletes probe messages older than 7 days and probe results older than 30.
 * Only messages a probe run recorded, and only in the probe mailbox, are
 * ever deleted: the join on both makes any other message unreachable here.
 */
export async function pruneStandby(env: Pick<StandbyWorkerEnv, 'DB' | 'STORAGE'>, now: number): Promise<number> {
  const db = env.DB;
  const state = await db.prepare('SELECT mailbox_id FROM standby_probe_state WHERE id = 1').first<{ mailbox_id: string | null }>();
  let pruned = 0;
  if (state?.mailbox_id) {
    const { results } = await db.prepare(
      `SELECT r.id AS run_id, m.id AS message_id, m.body_r2_key
       FROM standby_probe_runs r
       INNER JOIN messages m ON m.id = r.message_id AND m.mailbox_id = ?
       WHERE COALESCE(r.received_at, r.started_at) < ?
       ORDER BY r.started_at LIMIT ?`,
    ).bind(state.mailbox_id, now - STANDBY_MESSAGE_RETENTION_DAYS * DAY_MS, PRUNE_BATCH)
      .all<{ run_id: string; message_id: string; body_r2_key: string | null }>();
    const rows = results ?? [];
    if (rows.length) {
      const placeholders = rows.map(() => '?').join(',');
      const attachments = await db.prepare(`SELECT r2_key FROM attachments WHERE message_id IN (${placeholders})`)
        .bind(...rows.map((row) => row.message_id)).all<{ r2_key: string }>();
      const keys = [...rows.map((row) => row.body_r2_key), ...(attachments.results ?? []).map((row) => row.r2_key)]
        .filter((key): key is string => !!key);
      // R2 deletes are idempotent: if the D1 batch fails, the next run retries.
      await Promise.all(keys.map((key) => env.STORAGE.delete(key)));
      await db.batch(rows.flatMap((row) => [
        db.prepare('DELETE FROM messages WHERE id = ? AND mailbox_id = ?').bind(row.message_id, state.mailbox_id),
        db.prepare('UPDATE standby_probe_runs SET message_id = NULL WHERE id = ?').bind(row.run_id),
      ]));
      pruned = rows.length;
    }
  }
  // Results older than 30 days; a run whose message is still stored waits
  // for the message prune above.
  await db.prepare(
    `DELETE FROM standby_probe_runs
     WHERE started_at < ? AND in_flight IS NULL
       AND (message_id IS NULL OR NOT EXISTS (SELECT 1 FROM messages WHERE id = standby_probe_runs.message_id))`,
  ).bind(now - STANDBY_RUN_RETENTION_DAYS * DAY_MS).run();
  return pruned;
}

// ─── Private endpoint helpers ────────────────────────────────────────────

/** Read-only: whether this Worker can run the standby address and probe. Setting names only. */
export function standbyConfigDiagnostic(env: StandbyWorkerEnv): Record<string, unknown> {
  const check = standbyConfig(env);
  if (!check.configured) return { configured: false, problems: check.problems, canSend: Boolean(env.EMAIL) };
  return {
    configured: true,
    problems: [],
    canSend: Boolean(env.EMAIL),
    standbyDomain: check.config.standbyDomain,
    probeAddress: check.config.probeStandbyAddress,
    timeoutMinutes: check.config.timeoutMinutes,
  };
}
