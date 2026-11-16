// Admin side of Microsoft 365 welcome emails (docs/m365-welcome-emails.md).
// The web app never sends a welcome email itself. It:
// - writes the manager switch, the "since" choice and the optional standby
//   sentence to org_settings;
// - writes the branding snapshot (WelcomeProfile) the Worker renders from,
//   because APP_URL, the organisation details, the From address and the
//   Access bridge settings live only here;
// - asks the email Worker over the private EMAIL_SERVICE binding whether it
//   can send (by setting name only);
// - reads the once-only records and the status row the Worker writes, and
//   re-queues one person when a manager presses Resend.
import { M365_SYNC_SETTING_DRY_RUN, M365_SYNC_SETTING_ENABLED } from '@cmail/shared/m365-sync';
import {
  M365_WELCOME_LIST_LIMIT,
  M365_WELCOME_SETTING_ENABLED,
  M365_WELCOME_SETTING_NOTE,
  M365_WELCOME_SETTING_PROFILE,
  M365_WELCOME_SETTING_SINCE,
  M365_WELCOME_SINCE_ALL,
  PASSKEY_SIGNIN_SETTING,
  WELCOME_ELIGIBLE_SQL,
  WELCOME_WAITING_SQL,
  cleanAppUrl,
  cleanWelcomeNote,
  isWelcomeEmailAddress,
  parseM365WelcomeState,
  parseM365WelcomeSwitch,
  parseWelcomeProfile,
  renderWelcomeEmail,
  sqliteTime,
  welcomeProfileProblems,
  type M365WelcomeState,
  type M365WelcomeSwitch,
  type WelcomeProfile,
} from '@cmail/shared/m365-welcome';
import { accessMode } from './access-jwt';
import { publicRuntimeConfig } from './config';
import { audit } from './db';
import { loadOrgSettings } from './org-settings';
import { detectProvider } from './outbound';
import { isAddressAtDomain, normalizeDomain, normalizeEmail } from './validation';

const CONFIG_URL = 'https://cmail-email-worker.internal/internal/m365-welcome/config';
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Plain-language text for each readiness code, shown as "Cannot send: ...". */
export const WELCOME_PROBLEM_TEXT: Record<string, string> = {
  not_installed: 'database migration 0029 has not been applied (run pnpm db:migrate).',
  outbound_not_configured: 'outbound mail not configured.',
  worker_unknown: 'outbound mail not configured (the email Worker could not be asked whether it can send).',
  no_send_binding: 'outbound mail not configured (the email Worker has no Cloudflare Email Sending binding).',
  access_bridge_off: 'people created by the sync can only sign in through the Cloudflare Access bridge, which is not set up on this deployment (ACCESS_TEAM_DOMAIN and ACCESS_AUD). Without it they need an invitation (Admin > People > Send invitation).',
  app_url_missing: 'APP_URL is not set to an https address.',
  from_missing: 'there is no valid system From address on MAIL_DOMAIN (Admin > Settings).',
  from_not_on_mail_domain: 'the system From address is not on MAIL_DOMAIN.',
  org_name_missing: 'the organisation name is not set (Admin > Settings).',
  profile_missing: 'the organisation details have not been saved for the email Worker yet. Reload this page.',
};

export function welcomeProblemText(code: string): string {
  return WELCOME_PROBLEM_TEXT[code] ?? code;
}

function isFetcher(value: unknown): value is Fetcher {
  return Boolean(value) && typeof (value as Fetcher).fetch === 'function';
}

/** Whether the email Worker has its send binding. Unknown counts as "cannot send". */
export async function workerCanSend(service: unknown): Promise<{ canSend: boolean; known: boolean }> {
  if (!isFetcher(service)) return { canSend: false, known: false };
  try {
    const response = await service.fetch(CONFIG_URL, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { canSend: false, known: false };
    const body = await response.json() as { canSend?: unknown };
    if (typeof body.canSend !== 'boolean') return { canSend: false, known: false };
    return { canSend: body.canSend, known: true };
  } catch {
    return { canSend: false, known: false };
  }
}

type WelcomeEnv = { DB: D1Database; EMAIL_SERVICE?: unknown } & Record<string, unknown>;

/**
 * The branding and sign-in facts the Worker needs, from this app's settings:
 * the same values (and the same From fallback) manager invitations use.
 */
export async function buildWelcomeProfile(env: Record<string, unknown>): Promise<{ profile: WelcomeProfile; problems: string[] }> {
  const runtime = publicRuntimeConfig(env);
  const settings = await loadOrgSettings(env);
  const mailDomain = normalizeDomain(runtime.mailDomain) || '';
  const appUrl = cleanAppUrl(settings.appUrl || runtime.appUrl);
  const configuredFrom = normalizeEmail(settings.systemEmail) || '';
  const fromEmail = configuredFrom && mailDomain && isAddressAtDomain(configuredFrom, mailDomain)
    ? configuredFrom
    : (mailDomain ? `noreply@${mailDomain}` : '');
  const contact = normalizeEmail(settings.supportEmail) || '';
  const profile: WelcomeProfile = {
    v: 1,
    appUrl,
    appName: settings.appName || 'cmail',
    orgName: settings.orgName,
    fromEmail,
    fromName: settings.systemFromName,
    contactEmail: isWelcomeEmailAddress(contact) ? contact : '',
    brandColor: runtime.brandPrimaryColor,
    accessBridge: accessMode(env).mode === 'on',
  };
  const problems: string[] = [];
  if (!appUrl) problems.push('app_url_missing');
  if (!settings.orgName) problems.push('org_name_missing');
  if (!isWelcomeEmailAddress(fromEmail)) problems.push('from_missing');
  if (!profile.accessBridge) problems.push('access_bridge_off');
  return { profile, problems };
}

async function putSetting(db: D1Database, key: string, value: string, managerId: string | null): Promise<void> {
  await db.prepare(
    `INSERT INTO org_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
  ).bind(key, value, managerId).run();
}

/** Stores the snapshot only when it changed. */
export async function saveWelcomeProfile(db: D1Database, profile: WelcomeProfile, managerId: string | null): Promise<void> {
  const value = JSON.stringify(profile);
  const row = await db.prepare('SELECT value FROM org_settings WHERE key = ?').bind(M365_WELCOME_SETTING_PROFILE).first<{ value: string }>();
  if (row?.value === value) return;
  await putSetting(db, M365_WELCOME_SETTING_PROFILE, value, managerId);
}

export interface WelcomePerson {
  userId: string;
  email: string;
  displayName: string;
  /** 'not_sent' = eligible, never queued (waiting from before the switch, or the switch is off). */
  status: 'not_sent' | 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  lastAttemptAt: number | null;
  sentAt: number | null;
  lastError: string;
  /** Resend (or Send) is offered: eligible now and not already queued or sending. */
  canResend: boolean;
}

export interface WelcomeOverview {
  installed: boolean;
  toggle: M365WelcomeSwitch;
  syncEnabled: boolean;
  syncDryRun: boolean;
  passkeys: boolean;
  /** Empty = can send. Codes; see WELCOME_PROBLEM_TEXT. */
  problems: string[];
  canSend: boolean;
  /** Eligible people with no record: the warning's N. */
  waitingNow: number;
  counts: { sent: number; queued: number; failed: number; skipped: number; notSent: number };
  people: WelcomePerson[];
  state: M365WelcomeState;
  preview: { subject: string; text: string; from: string } | null;
}

async function readinessProblems(env: WelcomeEnv, profileProblems: string[], profile: WelcomeProfile): Promise<string[]> {
  const problems: string[] = [];
  if (detectProvider(env) === 'none') problems.push('outbound_not_configured');
  const worker = await workerCanSend(env.EMAIL_SERVICE);
  if (!problems.length && !worker.known) problems.push('worker_unknown');
  if (!problems.length && worker.known && !worker.canSend) problems.push('no_send_binding');
  for (const code of profileProblems) if (!problems.includes(code)) problems.push(code);
  const mailDomain = normalizeDomain(publicRuntimeConfig(env).mailDomain) || '';
  for (const code of welcomeProfileProblems(profile, mailDomain)) if (!problems.includes(code)) problems.push(code);
  return problems;
}

export async function loadWelcomeOverview(env: WelcomeEnv, managerId: string | null = null): Promise<WelcomeOverview> {
  const db = env.DB;
  const { results } = await db.prepare(
    'SELECT key, value FROM org_settings WHERE key IN (?, ?, ?, ?, ?, ?)',
  ).bind(M365_WELCOME_SETTING_ENABLED, M365_WELCOME_SETTING_SINCE, M365_WELCOME_SETTING_NOTE, M365_SYNC_SETTING_ENABLED, M365_SYNC_SETTING_DRY_RUN, PASSKEY_SIGNIN_SETTING)
    .all<{ key: string; value: string }>();
  const settings = new Map((results ?? []).map((row) => [row.key, row.value]));
  const toggle = parseM365WelcomeSwitch(results ?? []);
  const passkeys = settings.get(PASSKEY_SIGNIN_SETTING) === 'true';
  const built = await buildWelcomeProfile(env);
  const base = {
    toggle,
    syncEnabled: settings.get(M365_SYNC_SETTING_ENABLED) === 'true',
    syncDryRun: settings.get(M365_SYNC_SETTING_DRY_RUN) !== 'false',
    passkeys,
  };

  let installed = true;
  let state: M365WelcomeState;
  try {
    const row = await db.prepare('SELECT state FROM m365_welcome_state WHERE id = 1').first<{ state: string }>();
    state = parseM365WelcomeState(row?.state);
  } catch {
    installed = false;
    state = parseM365WelcomeState(null);
  }
  const problems = installed ? await readinessProblems(env, built.problems, built.profile) : ['not_installed'];
  // Keep the Worker's copy of the organisation details current.
  if (installed && !built.problems.includes('app_url_missing') && !built.problems.includes('org_name_missing') && !built.problems.includes('from_missing')) {
    await saveWelcomeProfile(db, built.profile, managerId);
  }

  const preview = parseWelcomeProfile(JSON.stringify(built.profile));
  const sample = preview
    ? renderWelcomeEmail({ profile: preview, passkeys, note: toggle.note, displayName: 'Alex Example', address: `alex@${normalizeDomain(publicRuntimeConfig(env).mailDomain) || 'example.com'}` })
    : null;
  const previewView = sample && preview ? { subject: sample.subject, text: sample.text, from: `${preview.fromName || preview.orgName} <${preview.fromEmail}>` } : null;

  if (!installed) {
    return { ...base, installed, problems, canSend: false, waitingNow: 0, counts: { sent: 0, queued: 0, failed: 0, skipped: 0, notSent: 0 }, people: [], state, preview: previewView };
  }

  let waitingNow = 0;
  const counts = { sent: 0, queued: 0, failed: 0, skipped: 0, notSent: 0 };
  let people: WelcomePerson[] = [];
  try {
    const waiting = await db.prepare(`SELECT COUNT(*) AS n ${WELCOME_WAITING_SQL}`).first<{ n: number }>();
    waitingNow = Number(waiting?.n ?? 0);
    counts.notSent = waitingNow;
    const grouped = await db.prepare('SELECT status, COUNT(*) AS n FROM m365_welcome_emails GROUP BY status').all<{ status: string; n: number }>();
    for (const row of grouped.results ?? []) {
      const n = Number(row.n);
      if (row.status === 'sent') counts.sent += n;
      else if (row.status === 'queued' || row.status === 'sending') counts.queued += n;
      else if (row.status === 'failed') counts.failed += n;
      else if (row.status === 'skipped') counts.skipped += n;
    }
    // Records first (newest change first), then eligible people never queued.
    const recorded = await db.prepare(
      `SELECT w.user_id, u.email, u.display_name, w.status, w.attempts, w.last_attempt_at, w.sent_at, w.last_error,
              EXISTS (SELECT 1 ${WELCOME_ELIGIBLE_SQL} AND u.id = w.user_id) AS eligible
       FROM m365_welcome_emails w JOIN users u ON u.id = w.user_id
       ORDER BY w.updated_at DESC, w.user_id LIMIT ?`,
    ).bind(M365_WELCOME_LIST_LIMIT).all<{
      user_id: string; email: string; display_name: string; status: WelcomePerson['status']; attempts: number;
      last_attempt_at: number | null; sent_at: number | null; last_error: string; eligible: number;
    }>();
    people = (recorded.results ?? []).map((row) => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name ?? '',
      status: row.status,
      attempts: Number(row.attempts),
      lastAttemptAt: row.last_attempt_at === null ? null : Number(row.last_attempt_at),
      sentAt: row.sent_at === null ? null : Number(row.sent_at),
      lastError: row.last_error ?? '',
      canResend: Number(row.eligible) === 1 && row.status !== 'queued' && row.status !== 'sending',
    }));
    const room = M365_WELCOME_LIST_LIMIT - people.length;
    if (room > 0) {
      const never = await db.prepare(
        `SELECT u.id AS user_id, u.email, u.display_name ${WELCOME_WAITING_SQL} ORDER BY l.created_at, u.id LIMIT ?`,
      ).bind(room).all<{ user_id: string; email: string; display_name: string }>();
      for (const row of never.results ?? []) {
        people.push({ userId: row.user_id, email: row.email, displayName: row.display_name ?? '', status: 'not_sent', attempts: 0, lastAttemptAt: null, sentAt: null, lastError: '', canResend: true });
      }
    }
  } catch {
    // Migration 0022 missing: the sync page already says so.
  }
  return { ...base, installed, problems, canSend: problems.length === 0, waitingNow, counts, people, state, preview: previewView };
}

export type WelcomeAdminAction = 'welcome_enable' | 'welcome_disable' | 'welcome_note' | 'welcome_resend';

export function parseWelcomeAdminAction(value: unknown): WelcomeAdminAction | null {
  return typeof value === 'string' && ['welcome_enable', 'welcome_disable', 'welcome_note', 'welcome_resend'].includes(value)
    ? value as WelcomeAdminAction
    : null;
}

export interface WelcomeActionInput {
  /** welcome_enable: 'new_only' (default) or 'include_waiting'. */
  scope?: string;
  /** welcome_enable with include_waiting: the N the manager was shown. */
  expected?: string;
  note?: string;
  userId?: string;
}

export type WelcomeAdminResult = { ok: true; message: string } | { ok: false; status: number; error: string };

/** Applies one manager action. The caller has already checked the manager role. */
export async function applyWelcomeAdminAction(
  env: WelcomeEnv,
  manager: { id: string },
  action: WelcomeAdminAction,
  input: WelcomeActionInput,
  now = new Date(),
): Promise<WelcomeAdminResult> {
  const db = env.DB;
  const overview = await loadWelcomeOverview(env, manager.id);
  if (!overview.installed) return { ok: false, status: 409, error: 'Apply database migration 0029 first.' };

  if (action === 'welcome_enable') {
    if (overview.toggle.enabled) return { ok: false, status: 409, error: 'Welcome emails are already on.' };
    if (!overview.canSend) {
      return { ok: false, status: 409, error: `Cannot send: ${overview.problems.map(welcomeProblemText).join(' ')}` };
    }
    const scope = input.scope === 'include_waiting' ? 'include_waiting' : 'new_only';
    if (scope === 'include_waiting') {
      const expected = Number(input.expected);
      if (!Number.isInteger(expected) || expected !== overview.waitingNow) {
        return { ok: false, status: 409, error: `The number of people waiting has changed (now ${overview.waitingNow}). Nothing was turned on. Review the number and confirm again.` };
      }
    }
    const since = scope === 'include_waiting' ? M365_WELCOME_SINCE_ALL : sqliteTime(now);
    await db.batch([
      db.prepare(
        `INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
      ).bind(M365_WELCOME_SETTING_SINCE, since, manager.id),
      db.prepare(
        `INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES (?, 'true', datetime('now'), ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
      ).bind(M365_WELCOME_SETTING_ENABLED, manager.id),
    ]);
    const detail = scope === 'include_waiting'
      ? `Microsoft 365 welcome emails turned on, including the ${overview.waitingNow} people already waiting`
      : `Microsoft 365 welcome emails turned on for people created from now on (${overview.waitingNow} already waiting are not emailed)`;
    await audit(db, { event_type: 'org.m365_welcome_toggled', actor_id: manager.id, actor_role: 'manager', detail });
    const when = !overview.syncEnabled
      ? ' Nothing is sent while Microsoft 365 sync is off.'
      : overview.syncDryRun
        ? ' The sync is in dry run, so nothing is sent: the next run lists who would be emailed.'
        : ' The first emails go within 15 minutes.';
    return { ok: true, message: `Welcome emails are on${scope === 'include_waiting' ? `, including the ${overview.waitingNow} people already waiting` : ' for people created from now on'}.${when}` };
  }

  if (action === 'welcome_disable') {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES (?, 'false', datetime('now'), ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
      ).bind(M365_WELCOME_SETTING_ENABLED, manager.id),
      // Emails not sent yet are cancelled: those people count as waiting again.
      db.prepare(`DELETE FROM m365_welcome_emails WHERE status = 'queued'`),
    ]);
    const cancelled = Number(results[1]?.meta.changes ?? 0);
    await audit(db, { event_type: 'org.m365_welcome_toggled', actor_id: manager.id, actor_role: 'manager', detail: `Microsoft 365 welcome emails turned off (${cancelled} unsent cancelled)` });
    return { ok: true, message: `Welcome emails are off.${cancelled ? ` ${cancelled} unsent ${cancelled === 1 ? 'email was' : 'emails were'} cancelled.` : ''}` };
  }

  if (action === 'welcome_note') {
    const raw = typeof input.note === 'string' ? input.note : '';
    if (raw.length > 2000) return { ok: false, status: 400, error: 'The sentence is too long.' };
    const note = cleanWelcomeNote(raw);
    await putSetting(db, M365_WELCOME_SETTING_NOTE, note, manager.id);
    await audit(db, { event_type: 'org.m365_welcome_note', actor_id: manager.id, actor_role: 'manager', detail: note ? 'Welcome email standby sentence updated' : 'Welcome email standby sentence removed' });
    return { ok: true, message: note ? 'Saved. New welcome emails include the sentence.' : 'Removed. Welcome emails no longer include a standby sentence.' };
  }

  // welcome_resend
  if (!overview.toggle.enabled) return { ok: false, status: 409, error: 'Turn welcome emails on first.' };
  if (!overview.canSend) return { ok: false, status: 409, error: `Cannot send: ${overview.problems.map(welcomeProblemText).join(' ')}` };
  const userId = typeof input.userId === 'string' && USER_ID.test(input.userId) ? input.userId : '';
  if (!userId) return { ok: false, status: 400, error: 'Unknown person.' };
  const eligible = await db.prepare(`SELECT 1 AS found ${WELCOME_ELIGIBLE_SQL} AND u.id = ?`).bind(userId).first();
  if (!eligible) return { ok: false, status: 409, error: 'This person cannot get a welcome email: they have signed in, are paused or offboarded, are not linked to Microsoft 365, or the address is a shared mailbox.' };
  const result = await db.prepare(
    `INSERT INTO m365_welcome_emails (user_id, status, origin, attempts, next_attempt_at, last_error, requested_by)
     VALUES (?, 'queued', 'resend', 0, ?, '', ?)
     ON CONFLICT(user_id) DO UPDATE SET status = 'queued', origin = 'resend', attempts = 0, next_attempt_at = excluded.next_attempt_at,
       last_error = '', requested_by = excluded.requested_by, updated_at = datetime('now')
     WHERE m365_welcome_emails.status IN ('sent', 'failed', 'skipped')`,
  ).bind(userId, now.getTime(), manager.id).run();
  if (!result.meta.changes) return { ok: false, status: 409, error: 'A welcome email for this person is already waiting to be sent.' };
  await audit(db, { event_type: 'm365_welcome.resend_requested', actor_id: manager.id, actor_role: 'manager', target: userId, detail: 'Manager asked to send the welcome email (again)' });
  const when = overview.syncEnabled && !overview.syncDryRun ? ' It goes within 15 minutes.' : ' It is sent once Microsoft 365 sync is on and out of dry run.';
  return { ok: true, message: `Queued.${when}` };
}
