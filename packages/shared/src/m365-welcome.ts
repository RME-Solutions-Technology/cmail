// Microsoft 365 welcome emails: the parts both the web app (Admin switch,
// counts, preview, Resend) and the email Worker (the scheduled sender) need.
// The design and its reasons are in docs/m365-welcome-emails.md.
//
// Who gets one: a person the Microsoft 365 sync created, or adopted while
// still pending, who has never signed in, has no sign-in identity, and whose
// address is not a shared mailbox. Exactly once, unless a manager presses
// Resend. Nothing is sent while the switch is off, while the sync is off or
// in dry run, or while the Worker cannot send.

/** org_settings keys. Absent = default (off, no note). */
export const M365_WELCOME_SETTING_ENABLED = 'm365_welcome_enabled';
/**
 * SQLite datetime ('YYYY-MM-DD HH:MM:SS', UTC). Sync links created at or
 * after it are emailed automatically. Set when the switch is turned on: "now"
 * for "only people created from now on", the epoch for "also the people
 * already waiting".
 */
export const M365_WELCOME_SETTING_SINCE = 'm365_welcome_since';
/** Optional plain-text sentence (the standby note). Empty = omitted. */
export const M365_WELCOME_SETTING_NOTE = 'm365_welcome_note';
/** JSON snapshot of the web app's branding and sign-in facts (WelcomeProfile). */
export const M365_WELCOME_SETTING_PROFILE = 'm365_welcome_profile';
/** The passkey feature's own switch (docs/passkeys.md), read at send time. */
export const PASSKEY_SIGNIN_SETTING = 'passkey_signin_enabled';

/**
 * The standby switches (docs/standby-switch.md: standby_enabled; docs/exchange-mirror.md:
 * exchange_mirror_enabled). When either is on, the email says in one sentence that
 * the organisation uses this service as an emergency standby.
 */
export const WELCOME_STANDBY_SETTINGS = ['standby_enabled', 'exchange_mirror_enabled'] as const;

export function standbyIsOn(settings: ReadonlyMap<string, string>): boolean {
  return WELCOME_STANDBY_SETTINGS.some((key) => settings.get(key) === 'true');
}

/** The public help page on the instance's own origin (no sign-in needed). */
export const WELCOME_HELP_PATH = '/help/first-sign-in';

export const M365_WELCOME_NOTE_MAX = 300;
/** Every link ever created counts as "on or after" this. */
export const M365_WELCOME_SINCE_ALL = '1970-01-01 00:00:00';
/** Rows shown in Admin and kept in the dry-run report. */
export const M365_WELCOME_LIST_LIMIT = 200;
/** Send attempts before a row is given up (failed). */
export const M365_WELCOME_MAX_ATTEMPTS = 5;
/** A row left in 'sending' this long belongs to a run that died mid-send. */
export const M365_WELCOME_SENDING_STALE_MS = 15 * 60 * 1000;
/** Most sends one cron run makes, whatever the hourly budget allows. */
export const M365_WELCOME_MAX_PER_RUN = 20;
export const M365_WELCOME_DEFAULT_PER_HOUR = 50;

export interface M365WelcomeSwitch {
  enabled: boolean;
  /** '' when never turned on. */
  since: string;
  note: string;
}

const SQLITE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function sqliteTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function cleanWelcomeNote(value: unknown): string {
  if (typeof value !== 'string') return '';
  // One plain paragraph: control characters (CR/LF included) become spaces.
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, M365_WELCOME_NOTE_MAX);
}

export function parseM365WelcomeSwitch(rows: Array<{ key: string; value: string }>): M365WelcomeSwitch {
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const since = map.get(M365_WELCOME_SETTING_SINCE) ?? '';
  return {
    enabled: map.get(M365_WELCOME_SETTING_ENABLED) === 'true' && SQLITE_TIME.test(since),
    since: SQLITE_TIME.test(since) ? since : '',
    note: cleanWelcomeNote(map.get(M365_WELCOME_SETTING_NOTE) ?? ''),
  };
}

// ─── Profile: what only the web app knows ───────────────────────────────

/**
 * The web app owns APP_URL, the organisation name and contact, the system
 * From address and whether synced people can sign in. It writes
 * this snapshot to org_settings (when Admin > Microsoft 365 sync is opened
 * and when welcome emails are turned on); the Worker renders from it.
 */
export type WelcomeSignIn = 'microsoft' | 'access' | 'none';

export interface WelcomeProfile {
  v: 1;
  appUrl: string;
  appName: string;
  orgName: string;
  fromEmail: string;
  fromName: string;
  /** Who to contact with questions (Admin > Settings support email). '' = none. */
  contactEmail: string;
  /** #rrggbb */
  brandColor: string;
  /**
   * How people the sync created sign in on their own, which decides the
   * wording of step 2: 'access' when the Cloudflare Access bridge is on (the
   * Access login page appears, no cmail button), else 'microsoft' when
   * Microsoft sign-in has the sync's tenant (docs/m365-sync.md, First
   * sign-in), else 'none' (cannot send).
   */
  signIn: WelcomeSignIn;
}

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

export function isWelcomeEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value);
}

function cleanLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max) : '';
}

/** https only (http only for localhost), no credentials, no query or fragment. */
export function cleanAppUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !local) || url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** Null when the snapshot is missing or any field is unusable. */
export function parseWelcomeProfile(raw: string | null | undefined): WelcomeProfile | null {
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const profile: WelcomeProfile = {
    v: 1,
    appUrl: cleanAppUrl(parsed.appUrl),
    appName: cleanLine(parsed.appName, 80) || 'cmail',
    orgName: cleanLine(parsed.orgName, 200),
    fromEmail: typeof parsed.fromEmail === 'string' ? parsed.fromEmail.trim().toLowerCase() : '',
    fromName: cleanLine(parsed.fromName, 120),
    contactEmail: typeof parsed.contactEmail === 'string' ? parsed.contactEmail.trim().toLowerCase() : '',
    brandColor: typeof parsed.brandColor === 'string' && HEX.test(parsed.brandColor) ? parsed.brandColor.toLowerCase() : '#2563eb',
    signIn: parsed.signIn === 'microsoft' || parsed.signIn === 'access' ? parsed.signIn : 'none',
  };
  if (parsed.v !== 1 || !profile.appUrl || !profile.orgName || !isWelcomeEmailAddress(profile.fromEmail)) return null;
  if (profile.contactEmail && !isWelcomeEmailAddress(profile.contactEmail)) profile.contactEmail = '';
  return profile;
}

/**
 * Why welcome emails cannot be sent with this profile, as short codes. The
 * same list is shown in Admin and checked by the Worker before every run.
 */
export function welcomeProfileProblems(profile: WelcomeProfile | null, mailDomain = ''): string[] {
  if (!profile) return ['profile_missing'];
  const problems: string[] = [];
  if (profile.signIn === 'none') problems.push('sign_in_not_ready');
  const domain = mailDomain.trim().toLowerCase();
  // No MAIL_DOMAIN means the From address cannot be checked: never send.
  if (!domain) {
    problems.push('mail_domain_missing');
  } else {
    const fromDomain = profile.fromEmail.split('@')[1] ?? '';
    // Exactly MAIL_DOMAIN: the domain onboarded to Cloudflare Email Sending,
    // whose DKIM signature then aligns with the From domain so DMARC passes.
    if (fromDomain !== domain) problems.push('from_not_on_mail_domain');
  }
  return problems;
}

// ─── Who is eligible (one definition for Admin and the Worker) ──────────

/**
 * A person the sync created or adopted, still pending, never signed in, with
 * no sign-in identity of any kind, in scope in Microsoft 365, and not at an
 * address that is a shared mailbox. Aliases: l (link), u (user).
 */
export const WELCOME_ELIGIBLE_SQL = `
  FROM m365_sync_links l
  JOIN users u ON u.id = l.user_id
  WHERE l.kind = 'person'
    AND l.source_state = 'in_scope'
    AND u.role = 'standard'
    AND u.status = 'pending'
    AND u.last_sign_in IS NULL
    AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM mailboxes m WHERE m.type = 'shared' AND lower(m.address) = lower(u.email))`;

/**
 * What the person types at Microsoft sign-in: their userPrincipalName as the
 * sync last saw it (l.upn), else the account address. Aliases: l, u.
 */
export const WELCOME_SIGNIN_NAME_SQL = `COALESCE(NULLIF(l.upn, ''), u.email)`;

/** Eligible and never queued or sent: the "N people already waiting". */
export const WELCOME_WAITING_SQL = `${WELCOME_ELIGIBLE_SQL}
    AND NOT EXISTS (SELECT 1 FROM m365_welcome_emails w WHERE w.user_id = u.id)`;

// ─── Status row (m365_welcome_state, migration 0029) ────────────────────

export interface M365WelcomeState {
  lastTickAt: number | null;
  lastResult: 'ok' | 'dry_run' | 'not_configured' | 'rate_limited' | 'paused' | 'error' | null;
  /** A short code: why the last run did not send (configuration, sender refusal). */
  lastProblem: string;
  /** Epoch ms of send attempts in the last hour (the hourly limit). */
  attempts: number[];
  dryRun: { at: number; count: number; addresses: string[] } | null;
  lastRun: { at: number; sent: number; retried: number; failed: number; skipped: number; queued: number } | null;
}

export function emptyM365WelcomeState(): M365WelcomeState {
  return { lastTickAt: null, lastResult: null, lastProblem: '', attempts: [], dryRun: null, lastRun: null };
}

export function parseM365WelcomeState(raw: string | null | undefined): M365WelcomeState {
  if (!raw) return emptyM365WelcomeState();
  try {
    const parsed = JSON.parse(raw) as Partial<M365WelcomeState>;
    if (!parsed || typeof parsed !== 'object') return emptyM365WelcomeState();
    const state = { ...emptyM365WelcomeState(), ...parsed };
    state.attempts = Array.isArray(state.attempts) ? state.attempts.filter((value) => typeof value === 'number') : [];
    return state;
  } catch {
    return emptyM365WelcomeState();
  }
}

// ─── The email ──────────────────────────────────────────────────────────

export interface WelcomeEmailInput {
  profile: WelcomeProfile;
  /** The passkey feature is switched on (step 4 is shown only then). */
  passkeys: boolean;
  /** Optional standby sentence; '' omits it. */
  note: string;
  displayName: string;
  /** The mailbox address the email is sent to. */
  address: string;
  /** What the person types at Microsoft sign-in (their UPN). Defaults to address. */
  signInName?: string;
  /** A standby switch is on: say why the account exists. */
  standby?: boolean;
  /** A manager's own test: the subject starts with "[Test] ". */
  test?: boolean;
}

export interface WelcomeEmail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function channel(hex: string, start: number): number {
  const value = parseInt(hex.slice(start, start + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG contrast ratio of a #rrggbb colour against white. */
export function contrastOnWhite(hex: string): number {
  if (!HEX.test(hex)) return 1;
  const luminance = 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  return 1.05 / (luminance + 0.05);
}

/** The brand colour for text and links only when it is readable on white (WCAG AA, 4.5:1). */
export function accessibleAccent(hex: string): string {
  return contrastOnWhite(hex) >= 4.5 ? hex : '#1d4ed8';
}

/** A sign-in name for the text: a plain single-line address, else ''. */
function cleanUpnText(value: unknown): string {
  const raw = cleanLine(value, 254).toLowerCase();
  return isWelcomeEmailAddress(raw) ? raw : '';
}

function firstName(displayName: string, address: string): string {
  const cleaned = cleanLine(displayName, 120);
  if (!cleaned || cleaned.includes('@') || cleaned.toLowerCase() === address.toLowerCase()) return '';
  return cleaned.split(/\s+/)[0].slice(0, 60);
}

/**
 * The welcome email: plain, short, no images, no tracking, no token. Sign-in
 * goes through Microsoft (the sync's first sign-in, or the Access bridge), so the link is
 * only the app's address.
 */
export function renderWelcomeEmail(input: WelcomeEmailInput): WelcomeEmail {
  const { profile, passkeys } = input;
  const address = input.address.trim().toLowerCase();
  const note = cleanWelcomeNote(input.note);
  const name = firstName(input.displayName, address);
  const org = profile.orgName;
  const app = profile.appName;
  const accent = accessibleAccent(profile.brandColor);
  const signInName = cleanUpnText(input.signInName) || address;
  const subject = cleanLine(`${input.test ? '[Test] ' : ''}Your ${org} mail account is ready`, 200);
  const helpUrl = `${profile.appUrl}${WELCOME_HELP_PATH}`;

  const greeting = name ? `Hello ${name},` : 'Hello,';
  const why = input.standby
    ? `${org} uses ${app} as a standby for email emergencies. Nothing changes day to day.`
    : 'Signing in once now means your account is ready if you ever need it.';
  const intro = `You now have a mail account at ${org} in ${app}. ${why}`;
  const steps = [
    { text: `Open ${profile.appUrl}`, html: `Open <a href="${escapeHtml(profile.appUrl)}" style="color:${accent};text-decoration:underline;">${escapeHtml(profile.appUrl)}</a>` },
    profile.signIn === 'access'
      // Behind the Cloudflare Access bridge there is no cmail sign-in button:
      // the Access login page asks for the work account.
      ? { text: `Sign in with your work account (${signInName}) when asked.`, html: `Sign in with your work account (${escapeHtml(signInName)}) when asked.` }
      : { text: `Choose Sign in with Microsoft and use your work account (${signInName}).`, html: `Choose <strong>Sign in with Microsoft</strong> and use your work account (${escapeHtml(signInName)}).` },
    { text: 'If you are asked to accept the IT policy, read it and accept it.', html: 'If you are asked to accept the IT policy, read it and accept it.' },
  ];
  if (passkeys) {
    steps.push({
      text: 'Add a passkey: in the left menu choose Settings > Passkeys, then Add passkey. Do this soon after you sign in. A passkey lets you sign in with your fingerprint, face or PIN if Microsoft sign-in is ever unavailable.',
      html: 'Add a passkey: in the left menu choose <strong>Settings &gt; Passkeys</strong>, then <strong>Add passkey</strong>. Do this soon after you sign in. A passkey lets you sign in with your fingerprint, face or PIN if Microsoft sign-in is ever unavailable.',
    });
  }
  const contact = profile.contactEmail;
  const safety = `${org} will never ask for your password by email.`;
  const footer = `Sent by ${org} with ${app}.`;

  const text = [
    org,
    '',
    greeting,
    '',
    note ? `${intro} ${note}` : intro,
    '',
    'To sign in for the first time:',
    '',
    ...steps.map((step, index) => `${index + 1}. ${step.text}`),
    '',
    `Step-by-step help: ${helpUrl}`,
    '',
    ...(contact ? [`Questions? Contact ${contact}.`, ''] : []),
    safety,
    '',
    '--',
    footer,
    '',
  ].join('\n');

  const p = 'margin:0 0 16px;';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f6f8;">
<div role="article" aria-label="${escapeHtml(subject)}" lang="en" style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1f2937;">
<div style="background:#ffffff;border:1px solid #e5e7eb;border-top:4px solid ${escapeHtml(profile.brandColor)};border-radius:8px;padding:24px;">
<p style="margin:0 0 20px;font-size:18px;font-weight:600;color:${accent};">${escapeHtml(org)}</p>
<p style="${p}">${escapeHtml(greeting)}</p>
<p style="${p}">${escapeHtml(intro)}${note ? ` ${escapeHtml(note)}` : ''}</p>
<h1 style="margin:0 0 8px;font-size:16px;font-weight:600;color:#111827;">To sign in for the first time</h1>
<ol style="margin:0 0 16px;padding-left:24px;">
${steps.map((step) => `<li style="margin:0 0 8px;">${step.html}</li>`).join('\n')}
</ol>
<p style="${p}">Step-by-step help: <a href="${escapeHtml(helpUrl)}" style="color:${accent};text-decoration:underline;">${escapeHtml(helpUrl)}</a></p>
${contact ? `<p style="${p}">Questions? Contact <a href="mailto:${escapeHtml(contact)}" style="color:${accent};text-decoration:underline;">${escapeHtml(contact)}</a>.</p>\n` : ''}<p style="margin:0;color:#4b5563;font-size:14px;">${escapeHtml(safety)}</p>
</div>
<p style="margin:16px 0 0;text-align:center;color:#4b5563;font-size:13px;">${escapeHtml(footer)}</p>
</div>
</body>
</html>
`;
  return { subject, text, html };
}
