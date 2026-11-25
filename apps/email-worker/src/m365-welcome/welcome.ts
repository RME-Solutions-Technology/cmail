// Microsoft 365 welcome emails (docs/m365-welcome-emails.md). Runs on the
// Microsoft 365 sync cron, after nothing else: it reads the people the sync
// created (or adopted while pending) and emails each one once, through the
// Worker's own Cloudflare Email Sending binding.
//
// Rules this module enforces (tests: welcome.sql.node.test.ts):
// - Switch off: one org_settings read, then return. No other read or write.
// - Sync off: nothing. Sync in dry run: nothing is queued or sent; the run
//   only records who would be emailed.
// - Once only: m365_welcome_emails has one row per account (primary key), a
//   row is claimed (queued -> sending) by a conditional update before the
//   send, and a run that dies mid-send leaves 'sending', which the next run
//   marks failed/outcome_unknown instead of sending again.
// - Eligible = WELCOME_ELIGIBLE_SQL (shared with Admin), checked when queued
//   and again just before sending. Shared mailboxes never qualify.
// - Bounded: at most M365_WELCOME_MAX_PER_RUN sends per run and
//   M365_WELCOME_MAX_PER_HOUR (default 50) per rolling hour, under a lease.
// - Failures: a recipient refusal fails at once; a rate limit or sender
//   (domain) problem stops the run and retries later without using up an
//   attempt; anything else retries after 15, 30, 60 and 120 minutes, then
//   fails. A manager can Resend.
// - Every attempt is audited (no subject, body or address in the audit
//   detail); logs carry counts and codes only.
import {
  M365_SYNC_SETTING_DRY_RUN,
  M365_SYNC_SETTING_ENABLED,
} from '@stanchion/shared/m365-sync';
import {
  M365_WELCOME_DEFAULT_PER_HOUR,
  M365_WELCOME_LIST_LIMIT,
  M365_WELCOME_MAX_ATTEMPTS,
  M365_WELCOME_MAX_PER_RUN,
  M365_WELCOME_SENDING_STALE_MS,
  M365_WELCOME_SETTING_ENABLED,
  M365_WELCOME_SETTING_NOTE,
  M365_WELCOME_SETTING_PROFILE,
  M365_WELCOME_SETTING_SINCE,
  PASSKEY_SIGNIN_SETTING,
  WELCOME_ELIGIBLE_SQL,
  WELCOME_SIGNIN_NAME_NO_UPN_SQL,
  WELCOME_SIGNIN_NAME_SQL,
  WELCOME_STANDBY_SETTINGS,
  WELCOME_WAITING_SQL,
  hasUpnColumn,
  parseM365WelcomeState,
  parseM365WelcomeSwitch,
  parseWelcomeProfile,
  renderWelcomeEmail,
  standbyIsOn,
  welcomeProfileProblems,
  type M365WelcomeState,
} from '@stanchion/shared/m365-welcome';

export interface WelcomeWorkerEnv {
  DB: D1Database;
  EMAIL?: SendEmail;
  MAIL_DOMAIN?: string;
  /** Sends per rolling hour, 1 to 500. Default 50. */
  M365_WELCOME_MAX_PER_HOUR?: string | number;
}

export interface WelcomeDeps {
  now?: () => number;
}

export type WelcomeTickResult =
  | { status: 'off' | 'sync_off' | 'not_installed' | 'busy' }
  | { status: 'not_configured'; problems: string[] }
  | { status: 'dry_run'; wouldSend: number }
  | { status: 'worked'; queued: number; sent: number; retried: number; failed: number; skipped: number; limited: boolean; stopped: string };

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const LEASE_MS = 10 * MINUTE;
/** Retry waits after attempts 1..4 (the 5th failure is final). */
const RETRY_BASE_MS = 15 * MINUTE;
/** Cloudflare Email Sending codes that are about this recipient: no retry. */
const RECIPIENT_REFUSED = new Set(['E_RECIPIENT_SUPPRESSED', 'E_RECIPIENT_NOT_ALLOWED']);
/** Codes that are about the account or sender, not this person: stop the run, keep the attempt. */
const RUN_STOPPERS = new Set(['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE']);
const ERROR_CODE = /^E_[A-Z_]{1,60}$/;

export function welcomeMaxPerHour(env: WelcomeWorkerEnv): number {
  const raw = Number(env.M365_WELCOME_MAX_PER_HOUR ?? M365_WELCOME_DEFAULT_PER_HOUR);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(500, Math.floor(raw)) : M365_WELCOME_DEFAULT_PER_HOUR;
}

/** Whether this Worker can send at all, by setting name only (Admin reads it). */
export function welcomeConfigDiagnostic(env: Partial<WelcomeWorkerEnv>): { canSend: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!env.EMAIL || typeof env.EMAIL.send !== 'function') problems.push('The email Worker has no EMAIL send binding (Cloudflare Email Sending)');
  if (!(typeof env.MAIL_DOMAIN === 'string' && env.MAIL_DOMAIN.trim())) problems.push('MAIL_DOMAIN is not set on the email Worker');
  return { canSend: problems.length === 0, problems };
}

function sendErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  return ERROR_CODE.test(code) ? code : '';
}

function auditStatement(db: D1Database, eventType: string, userId: string, detail: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
     VALUES (?, datetime('now'), NULL, 'system', ?, ?, ?)`,
  ).bind(crypto.randomUUID(), eventType, userId.slice(0, 256), detail.slice(0, 1000));
}

async function saveState(db: D1Database, state: M365WelcomeState): Promise<void> {
  // Writing the state also releases the lease.
  await db.prepare(`UPDATE m365_welcome_state SET state = ?, lease_until = 0, updated_at = datetime('now') WHERE id = 1`)
    .bind(JSON.stringify(state)).run();
}

interface DueRow {
  user_id: string;
  attempts: number;
  email: string;
  display_name: string;
  sign_in_name: string;
}

export async function runWelcomeTick(env: WelcomeWorkerEnv, deps: WelcomeDeps = {}): Promise<WelcomeTickResult> {
  const db = env.DB;
  const now = (deps.now ?? Date.now)();

  const { results } = await db.prepare(
    'SELECT key, value FROM org_settings WHERE key IN (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    M365_WELCOME_SETTING_ENABLED, M365_WELCOME_SETTING_SINCE, M365_WELCOME_SETTING_NOTE, M365_WELCOME_SETTING_PROFILE,
    M365_SYNC_SETTING_ENABLED, M365_SYNC_SETTING_DRY_RUN, PASSKEY_SIGNIN_SETTING, ...WELCOME_STANDBY_SETTINGS,
  ).all<{ key: string; value: string }>();
  const rows = results ?? [];
  const toggle = parseM365WelcomeSwitch(rows);
  if (!toggle.enabled) return { status: 'off' };
  const settings = new Map(rows.map((row) => [row.key, row.value]));
  if (settings.get(M365_SYNC_SETTING_ENABLED) !== 'true') return { status: 'sync_off' };
  const syncDryRun = settings.get(M365_SYNC_SETTING_DRY_RUN) !== 'false';

  // The lease doubles as the migration check.
  let leased: boolean;
  try {
    const lease = await db.prepare(
      'UPDATE m365_welcome_state SET lease_until = ? WHERE id = 1 AND lease_until < ?',
    ).bind(now + LEASE_MS, now).run();
    leased = lease.meta.changes === 1;
  } catch {
    return { status: 'not_installed' };
  }
  if (!leased) {
    const exists = await db.prepare('SELECT 1 AS found FROM m365_welcome_state WHERE id = 1').first();
    return exists ? { status: 'busy' } : { status: 'not_installed' };
  }

  const stateRow = await db.prepare('SELECT state FROM m365_welcome_state WHERE id = 1').first<{ state: string }>();
  const state = parseM365WelcomeState(stateRow?.state);
  state.lastTickAt = now;
  state.attempts = state.attempts.filter((at) => at > now - HOUR && at <= now);

  try {
    if (syncDryRun) {
      // Report only: who the switch would email right now. Nothing is queued.
      const count = await db.prepare(`SELECT COUNT(*) AS n ${WELCOME_WAITING_SQL} AND l.created_at >= ?`).bind(toggle.since).first<{ n: number }>();
      const sample = await db.prepare(
        `SELECT u.email AS email ${WELCOME_WAITING_SQL} AND l.created_at >= ? ORDER BY l.created_at, u.id LIMIT ?`,
      ).bind(toggle.since, M365_WELCOME_LIST_LIMIT).all<{ email: string }>();
      const wouldSend = Number(count?.n ?? 0);
      state.dryRun = { at: now, count: wouldSend, addresses: (sample.results ?? []).map((row) => row.email.slice(0, 254)) };
      state.lastResult = 'dry_run';
      state.lastProblem = '';
      await saveState(db, state);
      return { status: 'dry_run', wouldSend };
    }
    state.dryRun = null;

    const profile = parseWelcomeProfile(settings.get(M365_WELCOME_SETTING_PROFILE));
    const problems = [
      ...(env.EMAIL && typeof env.EMAIL.send === 'function' ? [] : ['no_send_binding']),
      ...welcomeProfileProblems(profile, env.MAIL_DOMAIN ?? ''),
    ];
    if (problems.length || !profile || !env.EMAIL) {
      state.lastResult = 'not_configured';
      state.lastProblem = problems.join(',').slice(0, 200);
      await saveState(db, state);
      return { status: 'not_configured', problems };
    }

    // A run that died between claiming and recording a send: the email may
    // have gone. Never send it again on our own; a manager can Resend.
    const stale = await db.prepare(
      `SELECT user_id FROM m365_welcome_emails WHERE status = 'sending' AND COALESCE(last_attempt_at, 0) < ? LIMIT 50`,
    ).bind(now - M365_WELCOME_SENDING_STALE_MS).all<{ user_id: string }>();
    for (const row of stale.results ?? []) {
      await db.batch([
        db.prepare(
          `UPDATE m365_welcome_emails SET status = 'failed', last_error = 'outcome_unknown', updated_at = datetime('now')
           WHERE user_id = ? AND status = 'sending'`,
        ).bind(row.user_id),
        auditStatement(db, 'm365_welcome.failed', row.user_id, 'Welcome email outcome unknown (the run stopped while sending); not sent again automatically'),
      ]);
    }

    // Queue people created (or adopted while pending) since the switch went on.
    const queued = await db.prepare(
      `INSERT OR IGNORE INTO m365_welcome_emails (user_id, status, origin, next_attempt_at)
       SELECT u.id, 'queued', 'auto', ?
       ${WELCOME_WAITING_SQL} AND l.created_at >= ?
       ORDER BY l.created_at, u.id LIMIT ?`,
    ).bind(now, toggle.since, M365_WELCOME_LIST_LIMIT).run();

    const counts = { queued: Number(queued.meta.changes ?? 0), sent: 0, retried: 0, failed: 0, skipped: 0 };
    const budget = Math.min(M365_WELCOME_MAX_PER_RUN, welcomeMaxPerHour(env) - state.attempts.length);
    let stopped = '';
    let limited = budget <= 0;

    if (!limited) {
      // Before migration 0032 there is no UPN: name the account address.
      const signInName = await hasUpnColumn(db) ? WELCOME_SIGNIN_NAME_SQL : WELCOME_SIGNIN_NAME_NO_UPN_SQL;
      const due = await db.prepare(
        `SELECT w.user_id, w.attempts, u.email, u.display_name,
                ${signInName} AS sign_in_name
         FROM m365_welcome_emails w JOIN users u ON u.id = w.user_id
         LEFT JOIN m365_sync_links l ON l.user_id = u.id
         WHERE w.status = 'queued' AND w.next_attempt_at <= ?
         ORDER BY w.next_attempt_at, w.user_id LIMIT ?`,
      ).bind(now, budget).all<DueRow>();
      const passkeys = settings.get(PASSKEY_SIGNIN_SETTING) === 'true';
      const standby = standbyIsOn(settings);

      for (const row of due.results ?? []) {
        // Still eligible? (signed in, paused, left Microsoft 365, became shared)
        const eligible = await db.prepare(`SELECT 1 AS found ${WELCOME_ELIGIBLE_SQL} AND u.id = ?`).bind(row.user_id).first();
        if (!eligible) {
          const skipped = await db.batch([
            db.prepare(
              `UPDATE m365_welcome_emails SET status = 'skipped', last_error = 'not_eligible', updated_at = datetime('now')
               WHERE user_id = ? AND status = 'queued'`,
            ).bind(row.user_id),
            auditStatement(db, 'm365_welcome.skipped', row.user_id, 'Welcome email not sent: the person is no longer eligible (signed in, paused, out of scope or a shared mailbox)'),
          ]);
          if (skipped[0]?.meta.changes) counts.skipped += 1;
          continue;
        }
        // Claim: only one run can move this row from queued to sending.
        const claim = await db.prepare(
          `UPDATE m365_welcome_emails SET status = 'sending', last_attempt_at = ?, updated_at = datetime('now')
           WHERE user_id = ? AND status = 'queued' AND next_attempt_at <= ?`,
        ).bind(now, row.user_id, now).run();
        if (claim.meta.changes !== 1) continue;

        const email = renderWelcomeEmail({ profile, passkeys, note: toggle.note, displayName: row.display_name ?? '', address: row.email, signInName: row.sign_in_name, standby });
        const attempt = row.attempts + 1;
        state.attempts.push(now);
        // Counted before the send, and saved at once (lease kept), so a run
        // that dies mid-way can never let the next one exceed the hourly limit.
        await db.prepare('UPDATE m365_welcome_state SET state = ? WHERE id = 1').bind(JSON.stringify(state)).run();
        let messageId = '';
        let code = '';
        let failed = false;
        try {
          const result = await env.EMAIL.send({
            from: { email: profile.fromEmail, name: profile.fromName || profile.orgName },
            to: row.email,
            subject: email.subject,
            text: email.text,
            html: email.html,
          });
          messageId = typeof result?.messageId === 'string' ? result.messageId.replace(/[\r\n\u0000]/g, '').slice(0, 256) : '';
        } catch (error) {
          failed = true;
          code = sendErrorCode(error);
        }

        if (!failed) {
          await db.batch([
            db.prepare(
              `UPDATE m365_welcome_emails SET status = 'sent', attempts = ?, sent_at = ?, message_id = ?, last_error = '', updated_at = datetime('now')
               WHERE user_id = ? AND status = 'sending'`,
            ).bind(attempt, now, messageId || null, row.user_id),
            auditStatement(db, 'm365_welcome.sent', row.user_id, `Welcome email sent (attempt ${attempt})`),
          ]);
          counts.sent += 1;
          continue;
        }

        if (RUN_STOPPERS.has(code)) {
          // Not this person's fault: retry later without using up an attempt.
          const wait = code.startsWith('E_SENDER') ? HOUR : (code === 'E_DAILY_LIMIT_EXCEEDED' ? 6 * HOUR : HOUR);
          await db.batch([
            db.prepare(
              `UPDATE m365_welcome_emails SET status = 'queued', next_attempt_at = ?, last_error = ?, updated_at = datetime('now')
               WHERE user_id = ? AND status = 'sending'`,
            ).bind(now + wait, code, row.user_id),
            auditStatement(db, 'm365_welcome.send_failed', row.user_id, `Welcome email not sent: ${code}; will retry (the run stopped)`),
          ]);
          counts.retried += 1;
          stopped = code;
          break;
        }

        const reason = code || 'send_failed';
        if (RECIPIENT_REFUSED.has(code) || attempt >= M365_WELCOME_MAX_ATTEMPTS) {
          await db.batch([
            db.prepare(
              `UPDATE m365_welcome_emails SET status = 'failed', attempts = ?, last_error = ?, updated_at = datetime('now')
               WHERE user_id = ? AND status = 'sending'`,
            ).bind(attempt, reason, row.user_id),
            auditStatement(db, 'm365_welcome.failed', row.user_id, `Welcome email failed: ${reason} (attempt ${attempt}); not retried`),
          ]);
          counts.failed += 1;
          continue;
        }
        const retryAt = now + RETRY_BASE_MS * 2 ** (attempt - 1);
        await db.batch([
          db.prepare(
            `UPDATE m365_welcome_emails SET status = 'queued', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = datetime('now')
             WHERE user_id = ? AND status = 'sending'`,
          ).bind(attempt, retryAt, reason, row.user_id),
          auditStatement(db, 'm365_welcome.send_failed', row.user_id, `Welcome email not sent: ${reason} (attempt ${attempt}); will retry`),
        ]);
        counts.retried += 1;
      }
      if (!stopped && state.attempts.length >= welcomeMaxPerHour(env)) limited = true;
    }

    state.lastRun = { at: now, ...counts };
    state.lastResult = stopped ? 'paused' : limited ? 'rate_limited' : 'ok';
    state.lastProblem = stopped;
    await saveState(db, state);
    return { status: 'worked', ...counts, limited, stopped };
  } catch (error) {
    state.lastResult = 'error';
    state.lastProblem = 'internal';
    await saveState(db, state).catch(() => undefined);
    throw error;
  }
}
