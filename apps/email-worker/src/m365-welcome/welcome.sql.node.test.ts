import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import { migratedDatabase } from '../testing/sqlite-d1';
import {
  M365_WELCOME_SINCE_ALL,
  parseM365WelcomeState,
  renderWelcomeEmail,
  type WelcomeProfile,
} from '@cmail/shared/m365-welcome';
import { runWelcomeTick, welcomeConfigDiagnostic, type WelcomeDeps } from './welcome';

// Welcome emails against every real migration (node:sqlite). Cloudflare Email
// Sending is a mock that records each send. Fixtures use example.test only.

const DOMAIN = 'example.test';
const T0 = Date.parse('2026-11-16T00:00:00Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const PROFILE: WelcomeProfile = {
  v: 1,
  appUrl: 'https://mail.example.test',
  appName: 'cmail',
  orgName: 'Example Org',
  fromEmail: `noreply@${DOMAIN}`,
  fromName: 'Example Org Mail',
  contactEmail: `desk@${DOMAIN}`,
  brandColor: '#0078d4',
  accessBridge: true,
};

interface Sent { from: { email: string; name: string }; to: string; subject: string; text: string; html: string }

let objectIds = 0;
const objectId = () => `00000000-0000-4000-8000-${String(++objectIds).padStart(12, '0')}`;

function setup(options: {
  welcome?: boolean;
  since?: string;
  sync?: boolean;
  dryRun?: boolean;
  passkeys?: boolean;
  profile?: Partial<WelcomeProfile> | null;
  email?: boolean;
  perHour?: string;
  send?: (message: Sent, count: number) => Promise<unknown>;
} = {}) {
  const { d1, sqlite } = migratedDatabase();
  const setting = (key: string, value: string) => sqlite.prepare(
    `INSERT INTO org_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
  if (options.welcome ?? true) {
    setting('m365_welcome_enabled', 'true');
    setting('m365_welcome_since', options.since ?? '2026-11-15 00:00:00');
  }
  if (options.sync ?? true) setting('m365_sync_enabled', 'true');
  setting('m365_sync_dry_run', options.dryRun ? 'true' : 'false');
  if (options.passkeys) setting('passkey_signin_enabled', 'true');
  if (options.profile !== null) setting('m365_welcome_profile', JSON.stringify({ ...PROFILE, ...options.profile }));

  /** A person the sync created: pending, never signed in, linked and in scope. */
  const person = (id: string, extra: { linkedAt?: string; status?: string; role?: string; name?: string; signedIn?: boolean; kind?: 'shared-address' } = {}) => {
    const email = `${id}@${DOMAIN}`;
    sqlite.prepare(`INSERT INTO users (id, email, display_name, role, status, last_sign_in) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, email, extra.name ?? `${id[0].toUpperCase()}${id.slice(1)} Example`, extra.role ?? 'standard', extra.status ?? 'pending', extra.signedIn ? '2026-11-15 10:00:00' : null);
    sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, user_id, source_state, created_at) VALUES (?, 'person', ?, 'in_scope', ?)`)
      .run(objectId(), id, extra.linkedAt ?? '2026-11-15 12:00:00');
    return email;
  };

  const sent: Sent[] = [];
  const send = vi.fn(async (message: Sent) => {
    sent.push(message);
    if (options.send) return options.send(message, sent.length);
    return { messageId: `<welcome-${sent.length}@cf.example.test>` };
  });
  const env = {
    DB: d1,
    MAIL_DOMAIN: DOMAIN,
    ...(options.email === false ? {} : { EMAIL: { send } as unknown as SendEmail }),
    ...(options.perHour ? { M365_WELCOME_MAX_PER_HOUR: options.perHour } : {}),
  };
  let clock = T0;
  const deps: WelcomeDeps = { now: () => clock };
  const tick = () => runWelcomeTick(env, deps);
  const rows = () => sqlite.prepare('SELECT user_id, status, origin, attempts, next_attempt_at, last_error FROM m365_welcome_emails ORDER BY user_id').all() as Array<Record<string, unknown>>;
  const row = (id: string) => rows().find((item) => item.user_id === id);
  const audits = () => sqlite.prepare(`SELECT event_type, target, detail FROM audit_log WHERE event_type LIKE 'm365_welcome.%' ORDER BY rowid`).all() as Array<{ event_type: string; target: string; detail: string }>;
  const state = () => parseM365WelcomeState((sqlite.prepare('SELECT state FROM m365_welcome_state WHERE id = 1').get() as { state: string }).state);
  return {
    d1, sqlite, env, send, sent, person, tick, rows, row, audits, state, setting,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('welcome emails: off means nothing', () => {
  it('sends, queues and writes nothing while the switch is off', async () => {
    const t = setup({ welcome: false });
    t.person('alice');
    const before = t.sqlite.prepare('SELECT state, lease_until FROM m365_welcome_state').get();
    const prepare = vi.spyOn(t.d1, 'prepare');
    expect(await t.tick()).toEqual({ status: 'off' });
    expect(t.send).not.toHaveBeenCalled();
    expect(t.rows()).toEqual([]);
    expect(t.sqlite.prepare('SELECT state, lease_until FROM m365_welcome_state').get()).toEqual(before);
    // One settings read, nothing else.
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('is off when the switch says true but was never given a since time', async () => {
    const t = setup({ welcome: false });
    t.setting('m365_welcome_enabled', 'true');
    t.person('alice');
    expect(await t.tick()).toEqual({ status: 'off' });
  });

  it('sends nothing while the Microsoft 365 sync is off', async () => {
    const t = setup({ sync: false });
    t.person('alice');
    expect(await t.tick()).toEqual({ status: 'sync_off' });
    expect(t.send).not.toHaveBeenCalled();
    expect(t.rows()).toEqual([]);
  });

  it('the cron path sends nothing with the switch off', async () => {
    const t = setup({ welcome: false });
    t.person('alice');
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({ cron: '*/15 * * * *' } as ScheduledController, t.env as never, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext);
    await Promise.allSettled(waits);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.rows()).toEqual([]);
  });

  it('reports not installed when migration 0029 is missing', async () => {
    const t = setup();
    t.sqlite.exec('DROP TABLE m365_welcome_state');
    expect(await t.tick()).toEqual({ status: 'not_installed' });
    expect(t.send).not.toHaveBeenCalled();
  });
});

describe('welcome emails: dry run', () => {
  it('never sends or queues in sync dry run, and reports who would be emailed', async () => {
    const t = setup({ dryRun: true });
    t.person('alice');
    t.person('bob');
    t.person('carol', { linkedAt: '2026-11-14 00:00:00' }); // before the switch's since time
    expect(await t.tick()).toEqual({ status: 'dry_run', wouldSend: 2 });
    expect(t.send).not.toHaveBeenCalled();
    expect(t.rows()).toEqual([]);
    expect(t.audits()).toEqual([]);
    expect(t.state().dryRun).toMatchObject({ count: 2, addresses: [`alice@${DOMAIN}`, `bob@${DOMAIN}`] });
  });

  it('does not send a manager Resend while in dry run', async () => {
    const t = setup({ dryRun: true });
    t.person('alice');
    t.sqlite.prepare(`INSERT INTO m365_welcome_emails (user_id, status, origin) VALUES ('alice', 'queued', 'resend')`).run();
    await t.tick();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.row('alice')).toMatchObject({ status: 'queued' });
  });
});

describe('welcome emails: who gets one', () => {
  it('emails sync-created pending people once, from the system address, to their work address', async () => {
    const t = setup();
    t.person('alice');
    expect(await t.tick()).toMatchObject({ status: 'worked', queued: 1, sent: 1 });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ from: { email: `noreply@${DOMAIN}`, name: 'Example Org Mail' }, to: `alice@${DOMAIN}`, subject: 'Your Example Org mail account is ready' });
    expect(t.row('alice')).toMatchObject({ status: 'sent', attempts: 1, origin: 'auto' });

    // Once only: later runs, even hours later, send nothing more.
    t.advance(20 * MINUTE);
    expect(await t.tick()).toMatchObject({ status: 'worked', queued: 0, sent: 0 });
    t.advance(2 * HOUR);
    await t.tick();
    expect(t.sent).toHaveLength(1);

    // Audited without content or address.
    expect(t.audits()).toEqual([{ event_type: 'm365_welcome.sent', target: 'alice', detail: 'Welcome email sent (attempt 1)' }]);
  });

  it('"only people created from now on" leaves earlier people alone; the epoch includes them', async () => {
    const t = setup({ since: '2026-11-15 00:00:00' });
    t.person('early', { linkedAt: '2026-11-14 23:59:59' });
    t.person('onTime', { linkedAt: '2026-11-15 00:00:00' });
    await t.tick();
    expect(t.sent.map((item) => item.to)).toEqual([`onTime@${DOMAIN}`]);

    const all = setup({ since: M365_WELCOME_SINCE_ALL });
    all.person('early', { linkedAt: '2026-11-14 23:59:59' });
    await all.tick();
    expect(all.sent.map((item) => item.to)).toEqual([`early@${DOMAIN}`]);
  });

  it('never emails shared mailboxes, managers, people who signed in or have an identity, or paused and out-of-scope people', async () => {
    const t = setup();
    // A shared mailbox is a mailbox, never a user: its link is kind 'shared'.
    t.sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('m-team', ?, 'shared', 'active')`).run(`team@${DOMAIN}`);
    t.sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, mailbox_id, created_at) VALUES (?, 'shared', 'm-team', '2026-11-15 12:00:00')`).run(objectId());
    // A pending account whose address is a shared mailbox's.
    t.person('team');
    t.person('boss', { role: 'manager' });
    t.person('active', { status: 'active', signedIn: true });
    t.person('signedin', { signedIn: true });
    t.person('bound');
    t.sqlite.prepare(`INSERT INTO user_identities (provider, subject, user_id) VALUES ('microsoft', 'sub-1', 'bound')`).run();
    t.person('paused', { status: 'paused' });
    t.person('gone');
    t.sqlite.prepare(`UPDATE m365_sync_links SET source_state = 'out_of_scope' WHERE user_id = 'gone'`).run();
    // An account the sync did not create is not emailed either.
    t.sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('manual', ?, 'standard', 'pending')`).run(`manual@${DOMAIN}`);
    t.person('alice');
    await t.tick();
    expect(t.sent.map((item) => item.to)).toEqual([`alice@${DOMAIN}`]);
  });

  it('skips a queued person who is no longer eligible when their turn comes', async () => {
    const t = setup();
    t.person('alice');
    t.sqlite.prepare(`INSERT INTO m365_welcome_emails (user_id, status, origin) VALUES ('alice', 'queued', 'resend')`).run();
    t.sqlite.prepare(`UPDATE users SET status = 'active', last_sign_in = '2026-11-16 00:00:00' WHERE id = 'alice'`).run();
    expect(await t.tick()).toMatchObject({ skipped: 1, sent: 0 });
    expect(t.row('alice')).toMatchObject({ status: 'skipped', last_error: 'not_eligible' });
  });
});

describe('welcome emails: content', () => {
  it('includes the passkey step only when passkey sign-in is on', async () => {
    const off = setup({ passkeys: false });
    off.person('alice');
    await off.tick();
    expect(off.sent[0].text).not.toMatch(/passkey/i);
    expect(off.sent[0].html).not.toMatch(/passkey/i);

    const on = setup({ passkeys: true });
    on.person('alice');
    await on.tick();
    expect(on.sent[0].text).toContain('4. Add a passkey: in the left menu choose Settings > Passkeys, then Add passkey.');
    expect(on.sent[0].html).toContain('Settings &gt; Passkeys');
  });

  it('has no images, tracking, tokens or external resources', () => {
    const email = renderWelcomeEmail({ profile: PROFILE, passkeys: true, note: '', displayName: 'Alice Example', address: `alice@${DOMAIN}` });
    expect(email.html).not.toMatch(/<img|<script|<link|<iframe|url\(|background-image/i);
    const links = [...email.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(links).toEqual(['https://mail.example.test', `mailto:desk@${DOMAIN}`]);
    expect(email.text).toContain('1. Open https://mail.example.test\n');
    expect(email.html).toContain('<html lang="en">');
    expect(email.html).toContain('<ol');
  });

  it('escapes names and the note, and keeps headers on one line', () => {
    const email = renderWelcomeEmail({
      profile: { ...PROFILE, orgName: 'Org <b>"x"</b>' },
      passkeys: false,
      note: 'Line one\r\nBcc: evil@example.test <script>',
      displayName: '<img src=x>',
      address: `alice@${DOMAIN}`,
    });
    expect(email.html).not.toContain('<b>');
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img');
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.text).toContain('Line one Bcc: evil@example.test <script>');
  });

  it('uses the standby sentence only when set, and the brand colour only when readable', () => {
    const plain = renderWelcomeEmail({ profile: { ...PROFILE, brandColor: '#ffff00' }, passkeys: false, note: '', displayName: '', address: `alice@${DOMAIN}` });
    expect(plain.text).toContain('Hello,\n\nYou now have a mail account at Example Org in cmail.\n');
    expect(plain.html).toContain('color:#1d4ed8');
    const note = renderWelcomeEmail({ profile: PROFILE, passkeys: false, note: 'This is our standby mailbox.', displayName: 'Alice Example', address: `alice@${DOMAIN}` });
    expect(note.text).toContain('Hello Alice,\n\nYou now have a mail account at Example Org in cmail. This is our standby mailbox.\n');
    expect(note.html).toContain('color:#0078d4');
  });
});

describe('welcome emails: failures and retries', () => {
  it('retries a failed send with backoff, then succeeds', async () => {
    const t = setup({ send: async (_message, count) => { if (count === 1) throw Object.assign(new Error('x'), { code: 'E_INTERNAL_SERVER_ERROR' }); return { messageId: '<ok@cf.example.test>' }; } });
    t.person('alice');
    expect(await t.tick()).toMatchObject({ sent: 0, retried: 1 });
    expect(t.row('alice')).toMatchObject({ status: 'queued', attempts: 1, last_error: 'E_INTERNAL_SERVER_ERROR', next_attempt_at: T0 + 15 * MINUTE });
    t.advance(14 * MINUTE);
    await t.tick();
    expect(t.sent).toHaveLength(1);
    t.advance(MINUTE);
    expect(await t.tick()).toMatchObject({ sent: 1 });
    expect(t.row('alice')).toMatchObject({ status: 'sent', attempts: 2 });
    expect(t.audits().map((item) => item.event_type)).toEqual(['m365_welcome.send_failed', 'm365_welcome.sent']);
  });

  it('gives up after 5 attempts with growing waits', async () => {
    const t = setup({ send: async () => { throw new Error('network'); } });
    t.person('alice');
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await t.tick();
      const current = t.row('alice')!;
      if (current.status === 'queued') {
        const wait = Number(current.next_attempt_at) - t.now();
        waits.push(wait);
        t.advance(wait);
      }
    }
    expect(waits).toEqual([15 * MINUTE, 30 * MINUTE, 60 * MINUTE, 120 * MINUTE]);
    expect(t.row('alice')).toMatchObject({ status: 'failed', attempts: 5, last_error: 'send_failed' });
    expect(t.sent).toHaveLength(5);
    t.advance(24 * HOUR);
    await t.tick();
    expect(t.sent).toHaveLength(5);
  });

  it('fails at once when the recipient is refused', async () => {
    const t = setup({ send: async () => { throw Object.assign(new Error('x'), { code: 'E_RECIPIENT_SUPPRESSED' }); } });
    t.person('alice');
    expect(await t.tick()).toMatchObject({ failed: 1 });
    expect(t.row('alice')).toMatchObject({ status: 'failed', attempts: 1, last_error: 'E_RECIPIENT_SUPPRESSED' });
  });

  it('stops the run on a rate limit or sender problem without using up an attempt', async () => {
    const t = setup({ send: async () => { throw Object.assign(new Error('x'), { code: 'E_SENDER_NOT_VERIFIED' }); } });
    t.person('alice');
    t.person('bob');
    expect(await t.tick()).toMatchObject({ retried: 1, stopped: 'E_SENDER_NOT_VERIFIED' });
    expect(t.sent).toHaveLength(1);
    expect(t.row('alice')).toMatchObject({ status: 'queued', attempts: 0, next_attempt_at: T0 + HOUR });
    expect(t.row('bob')).toMatchObject({ status: 'queued', attempts: 0 });
    expect(t.state()).toMatchObject({ lastResult: 'paused', lastProblem: 'E_SENDER_NOT_VERIFIED' });
  });

  it('never sends again after a run died mid-send', async () => {
    const t = setup();
    t.person('alice');
    t.sqlite.prepare(`INSERT INTO m365_welcome_emails (user_id, status, origin, attempts, last_attempt_at) VALUES ('alice', 'sending', 'auto', 0, ?)`).run(T0 - 16 * MINUTE);
    await t.tick();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.row('alice')).toMatchObject({ status: 'failed', last_error: 'outcome_unknown' });
  });

  it('does not send while another run holds the lease', async () => {
    const t = setup();
    t.person('alice');
    t.sqlite.prepare('UPDATE m365_welcome_state SET lease_until = ?').run(T0 + MINUTE);
    expect(await t.tick()).toEqual({ status: 'busy' });
    expect(t.send).not.toHaveBeenCalled();
  });
});

describe('welcome emails: rate limit and bounded runs', () => {
  it('sends at most 20 per run and 50 per rolling hour', async () => {
    const t = setup();
    for (let index = 0; index < 60; index += 1) t.person(`p${String(index).padStart(2, '0')}`);
    expect(await t.tick()).toMatchObject({ sent: 20 });
    t.advance(15 * MINUTE);
    expect(await t.tick()).toMatchObject({ sent: 20 });
    t.advance(15 * MINUTE);
    expect(await t.tick()).toMatchObject({ sent: 10, limited: true });
    expect(t.state().lastResult).toBe('rate_limited');
    t.advance(15 * MINUTE);
    expect(await t.tick()).toMatchObject({ sent: 0, limited: true });
    t.advance(16 * MINUTE); // the first 20 are now over an hour old
    expect(await t.tick()).toMatchObject({ sent: 10 });
    expect(t.sent).toHaveLength(60);
    expect(new Set(t.sent.map((item) => item.to)).size).toBe(60);
  });

  it('honours a lower hourly limit', async () => {
    const t = setup({ perHour: '3' });
    for (let index = 0; index < 5; index += 1) t.person(`p${index}`);
    expect(await t.tick()).toMatchObject({ sent: 3, limited: true });
  });
});

describe('welcome emails: cannot send', () => {
  it('sends nothing without the EMAIL binding, a profile, or the Access bridge', async () => {
    for (const options of [{ email: false }, { profile: null }, { profile: { accessBridge: false } }, { profile: { fromEmail: 'noreply@other.test' } }] as const) {
      const t = setup(options);
      t.person('alice');
      const result = await t.tick();
      expect(result.status).toBe('not_configured');
      expect(t.send).not.toHaveBeenCalled();
      expect(t.rows()).toEqual([]);
    }
  });

  it('tells Admin over the private binding whether it can send, by name only', async () => {
    expect(welcomeConfigDiagnostic({ MAIL_DOMAIN: DOMAIN })).toEqual({ canSend: false, problems: ['The email Worker has no EMAIL send binding (Cloudflare Email Sending)'] });
    const response = await worker.fetch(new Request('https://cmail-email-worker.internal/internal/m365-welcome/config'), { MAIL_DOMAIN: DOMAIN, EMAIL: { send: vi.fn() } } as never);
    expect(await response.json()).toEqual({ canSend: true, problems: [] });
    expect((await worker.fetch(new Request('https://mail.example.test/internal/m365-welcome/config'), {} as never)).status).toBe(404);
  });
});
