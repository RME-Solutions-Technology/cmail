import { describe, expect, it, vi } from 'vitest';
import { parseM365WelcomeSwitch, parseWelcomeProfile } from '@cmail/shared/m365-welcome';
import { createTestDatabase } from './mcp/testing/harness';
import {
  applyWelcomeAdminAction,
  buildWelcomeProfile,
  loadWelcomeOverview,
  parseWelcomeAdminAction,
  workerCanSend,
} from './m365-welcome-admin';

const DOMAIN = 'example.test';
const NOW = new Date('2026-11-16T03:04:05Z');
let objects = 0;

function setup(options: { canSend?: boolean | 'down' | 'none'; signIn?: 'microsoft' | 'access' | 'none'; outbound?: string } = {}) {
  const { d1, sqlite } = createTestDatabase();
  sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('manager-1', 'manager@example.test', 'manager', 'active')`).run();
  const canSend = options.canSend ?? true;
  const fetch = vi.fn(async (url: string) => {
    if (canSend === 'down') return new Response('nope', { status: 500 });
    if (url.endsWith('/internal/m365-welcome/config')) return Response.json({ canSend, problems: canSend ? [] : ['no binding'] });
    return Response.json({ configured: true, problems: [] });
  });
  const env: Record<string, unknown> & { DB: D1Database } = {
    DB: d1,
    APP_URL: 'https://mail.example.test',
    APP_NAME: 'cmail',
    MAIL_DOMAIN: DOMAIN,
    ORG_NAME: 'Example Org',
    SYSTEM_EMAIL: `noreply@${DOMAIN}`,
    SYSTEM_FROM_NAME: 'Example Org Mail',
    SUPPORT_EMAIL: `desk@${DOMAIN}`,
    BRAND_PRIMARY_COLOR: '#0078d4',
    OUTBOUND_PROVIDER: options.outbound ?? 'cloudflare',
    ...((options.signIn ?? 'microsoft') === 'microsoft' ? {
      SESSION_SECRET: 'test-session-value-0123456789abcdefghijklmnop',
      MICROSOFT_CLIENT_ID: '00000000-0000-4000-8000-0000000000cc',
      MICROSOFT_CLIENT_SECRET: 'test-client-value',
      MICROSOFT_TENANT_ID: 'organizations',
      M365_TENANT_ID: '00000000-0000-4000-8000-0000000000aa',
    } : {}),
    ...(options.signIn === 'access' ? { ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'aud-tag-0000000000000000' } : {}),
    ...(canSend === 'none' ? {} : { EMAIL_SERVICE: { fetch } as unknown as Fetcher }),
  };
  const person = (id: string, extra: { linkedAt?: string; status?: string; signedIn?: boolean } = {}) => {
    sqlite.prepare(`INSERT INTO users (id, email, display_name, role, status, last_sign_in) VALUES (?, ?, ?, 'standard', ?, ?)`)
      .run(id, `${id}@${DOMAIN}`, `${id} Example`, extra.status ?? 'pending', extra.signedIn ? '2026-11-15 00:00:00' : null);
    sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, user_id, created_at) VALUES (?, 'person', ?, ?)`)
      .run(`00000000-0000-4000-8000-${String(++objects).padStart(12, '0')}`, id, extra.linkedAt ?? '2026-11-15 12:00:00');
  };
  const settings = () => parseM365WelcomeSwitch(sqlite.prepare('SELECT key, value FROM org_settings').all() as Array<{ key: string; value: string }>);
  const audits = () => sqlite.prepare(`SELECT event_type, target, detail FROM audit_log ORDER BY rowid`).all() as Array<{ event_type: string; target: string | null; detail: string }>;
  const manager = { id: 'manager-1' };
  return { d1, sqlite, env, fetch, person, settings, audits, manager };
}

describe('welcome emails admin: defaults and readiness', () => {
  it('is off by default and parses only known actions', async () => {
    const { env } = setup();
    const overview = await loadWelcomeOverview(env, 'manager-1');
    expect(overview.toggle).toEqual({ enabled: false, since: '', note: '' });
    expect(overview.canSend).toBe(true);
    expect(parseWelcomeAdminAction('welcome_enable')).toBe('welcome_enable');
    expect(parseWelcomeAdminAction('enable')).toBeNull();
  });

  it('cannot send (and stays off) when outbound mail is not configured', async () => {
    for (const options of [{ outbound: 'none' }, { canSend: false }, { canSend: 'down' as const }, { canSend: 'none' as const }]) {
      const t = setup(options);
      const overview = await loadWelcomeOverview(t.env, 'manager-1');
      expect(overview.canSend).toBe(false);
      expect(overview.problems.some((code) => ['outbound_not_configured', 'no_send_binding', 'worker_unknown'].includes(code))).toBe(true);
      const result = await applyWelcomeAdminAction(t.env, t.manager, 'welcome_enable', {}, NOW);
      expect(result).toMatchObject({ ok: false, status: 409 });
      if (!result.ok) expect(result.error).toContain('Cannot send: outbound mail not configured');
      expect(t.settings().enabled).toBe(false);
    }
  });

  it('works with Microsoft sign-in for the sync tenant, or the Access bridge, and refuses when synced people cannot sign in', async () => {
    expect((await loadWelcomeOverview(setup({ signIn: 'microsoft' }).env, 'manager-1')).problems).toEqual([]);
    expect((await loadWelcomeOverview(setup({ signIn: 'access' }).env, 'manager-1')).problems).toEqual([]);
    const t = setup({ signIn: 'none' });
    const overview = await loadWelcomeOverview(t.env, 'manager-1');
    expect(overview.problems).toContain('sign_in_not_ready');
    expect(await applyWelcomeAdminAction(t.env, t.manager, 'welcome_enable', {}, NOW)).toMatchObject({ ok: false, status: 409 });
    // Microsoft sign-in on, but no tenant for the sync: not ready either.
    const noTenant = setup();
    delete noTenant.env.M365_TENANT_ID;
    expect((await loadWelcomeOverview(noTenant.env, 'manager-1')).problems).toContain('sign_in_not_ready');
  });

  it('shows what sending needs, and a refusal of the sender from the last run', async () => {
    const t = setup();
    t.sqlite.prepare('UPDATE m365_welcome_state SET state = ? WHERE id = 1').run(JSON.stringify({ lastProblem: 'E_SENDER_NOT_VERIFIED' }));
    const overview = await loadWelcomeOverview(t.env, 'manager-1');
    expect(overview.sender).toEqual({ fromEmail: `noreply@${DOMAIN}`, mailDomain: DOMAIN });
    expect(overview.senderRefused).toBe('E_SENDER_NOT_VERIFIED');
  });

  it('asks the Worker over the private binding only; unknown means cannot send', async () => {
    const t = setup();
    await workerCanSend(t.env.EMAIL_SERVICE);
    expect(t.fetch).toHaveBeenCalledWith('https://cmail-email-worker.internal/internal/m365-welcome/config', expect.objectContaining({ method: 'GET' }));
    expect(await workerCanSend(undefined)).toEqual({ canSend: false, known: false });
    expect(await workerCanSend({ fetch: async () => { throw new Error('down'); } })).toEqual({ canSend: false, known: false });
  });

  it('saves the organisation snapshot the Worker renders from, with the invitation From rules', async () => {
    const t = setup();
    await loadWelcomeOverview(t.env, 'manager-1');
    const row = t.sqlite.prepare(`SELECT value FROM org_settings WHERE key = 'm365_welcome_profile'`).get() as { value: string };
    expect(parseWelcomeProfile(row.value)).toEqual({
      v: 1, appUrl: 'https://mail.example.test', appName: 'cmail', orgName: 'Example Org', fromEmail: `noreply@${DOMAIN}`,
      fromName: 'Example Org Mail', contactEmail: `desk@${DOMAIN}`, brandColor: '#0078d4', signInReady: true,
    });
    const offDomain = await buildWelcomeProfile({ ...t.env, SYSTEM_EMAIL: 'someone@other.test' });
    expect(offDomain.profile.fromEmail).toBe(`noreply@${DOMAIN}`);
  });
});

describe('welcome emails admin: the switch and its warning', () => {
  it('counts the people already waiting: sync-created, pending, never signed in, never sent one', async () => {
    const t = setup();
    t.person('alice');
    t.person('bob');
    t.person('active', { status: 'active', signedIn: true });
    t.person('sent');
    t.sqlite.prepare(`INSERT INTO m365_welcome_emails (user_id, status, origin) VALUES ('sent', 'sent', 'auto')`).run();
    t.person('team');
    t.sqlite.prepare(`INSERT INTO mailboxes (id, address, type) VALUES ('m-team', ?, 'shared')`).run(`team@${DOMAIN}`);
    t.sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('manual', ?, 'standard', 'pending')`).run(`manual@${DOMAIN}`);
    const overview = await loadWelcomeOverview(t.env, 'manager-1');
    expect(overview.waitingNow).toBe(2);
    expect(overview.counts).toMatchObject({ sent: 1, notSent: 2 });
  });

  it('"only people created from now on" is the default and records now as the cut-off', async () => {
    const t = setup();
    t.person('alice');
    expect(await applyWelcomeAdminAction(t.env, t.manager, 'welcome_enable', {}, NOW)).toMatchObject({ ok: true });
    expect(t.settings()).toEqual({ enabled: true, since: '2026-11-16 03:04:05', note: '' });
    expect(t.audits().at(-1)).toMatchObject({ event_type: 'org.m365_welcome_toggled', detail: expect.stringContaining('(1 already waiting are not emailed)') });
  });

  it('"also the N already waiting" needs the N the manager was shown', async () => {
    const t = setup();
    t.person('alice');
    t.person('bob');
    const stale = await applyWelcomeAdminAction(t.env, t.manager, 'welcome_enable', { scope: 'include_waiting', expected: '1' }, NOW);
    expect(stale).toMatchObject({ ok: false, status: 409 });
    expect(t.settings().enabled).toBe(false);
    expect(await applyWelcomeAdminAction(t.env, t.manager, 'welcome_enable', { scope: 'include_waiting', expected: '2' }, NOW)).toMatchObject({ ok: true });
    expect(t.settings()).toMatchObject({ enabled: true, since: '1970-01-01 00:00:00' });
  });

  it('turning off cancels unsent emails and keeps sent ones', async () => {
    const t = setup();
    t.person('alice');
    t.person('bob');
    await applyWelcomeAdminAction(t.env, t.manager, 'welcome_enable', {}, NOW);
    t.sqlite.prepare(`INSERT INTO m365_welcome_emails (user_id, status, origin) VALUES ('alice', 'queued', 'auto'), ('bob', 'sent', 'auto')`).run();
    expect(await applyWelcomeAdminAction(t.env, t.manager, 'welcome_disable', {}, NOW)).toMatchObject({ ok: true, message: expect.stringContaining('1 unsent email was cancelled') });
    expect(t.settings().enabled).toBe(false);
    expect(t.sqlite.prepare('SELECT user_id, status FROM m365_welcome_emails').all()).toEqual([{ user_id: 'bob', status: 'sent' }]);
  });

  it('keeps the standby sentence to one plain paragraph', async () => {
    const t = setup();
    await applyWelcomeAdminAction(t.env, t.manager, 'welcome_note', { note: '  This is our standby mailbox.\r\n<b>Really</b>  ' }, NOW);
    expect(t.settings().note).toBe('This is our standby mailbox. <b>Really</b>');
    const overview = await loadWelcomeOverview(t.env, 'manager-1');
    expect(overview.preview?.text).toContain('This is our standby mailbox. <b>Really</b>');
    await applyWelcomeAdminAction(t.env, t.manager, 'welcome_note', { note: '' }, NOW);
    expect(t.settings().note).toBe('');
  });

  it('previews the passkey step only when passkey sign-in is on', async () => {
    const t = setup();
    expect((await loadWelcomeOverview(t.env, 'manager-1')).preview?.text).not.toMatch(/passkey/i);
    t.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('passkey_signin_enabled', 'true')`).run();
    expect((await loadWelcomeOverview(t.env, 'manager-1')).preview?.text).toContain('Settings > Passkeys');
  });
});

describe('welcome emails admin: Resend', () => {
  it('re-queues one eligible person once, audited, and refuses when not eligible or already queued', async () => {
    const t = setup();
    t.person('alice');
    t.person('active', { status: 'active', signedIn: true });
    expect(await applyWelcomeAdminAction(t.env, t.manager, 'welcome_resend', { userId: 'alice' }, NOW)).toMatchObject({ ok: false, status: 409 });
    await applyWelcomeAdminAction(t.env, t.manager, 'welcome_enable', {}, NOW);
    t.sqlite.prepare(`INSERT INTO m365_welcome_emails (user_id, status, origin, attempts) VALUES ('alice', 'failed', 'auto', 5)`).run();
    expect(await applyWelcomeAdminAction(t.env, t.manager, 'welcome_resend', { userId: 'alice' }, NOW)).toMatchObject({ ok: true });
    expect(t.sqlite.prepare(`SELECT status, origin, attempts, requested_by FROM m365_welcome_emails WHERE user_id = 'alice'`).get())
      .toEqual({ status: 'queued', origin: 'resend', attempts: 0, requested_by: 'manager-1' });
    expect(await applyWelcomeAdminAction(t.env, t.manager, 'welcome_resend', { userId: 'alice' }, NOW)).toMatchObject({ ok: false, status: 409 });
    expect(await applyWelcomeAdminAction(t.env, t.manager, 'welcome_resend', { userId: 'active' }, NOW)).toMatchObject({ ok: false, status: 409 });
    expect(await applyWelcomeAdminAction(t.env, t.manager, 'welcome_resend', { userId: "x' OR 1=1" }, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(t.audits().filter((row) => row.event_type === 'm365_welcome.resend_requested')).toEqual([
      { event_type: 'm365_welcome.resend_requested', target: 'alice', detail: 'Manager asked to send the welcome email (again)' },
    ]);
  });

  it('lists recorded people and those never queued, with Resend only where it applies', async () => {
    const t = setup();
    t.person('alice');
    t.person('bob');
    t.sqlite.prepare(`INSERT INTO m365_welcome_emails (user_id, status, origin) VALUES ('alice', 'sent', 'auto')`).run();
    const overview = await loadWelcomeOverview(t.env, 'manager-1');
    expect(overview.people.map((person) => [person.userId, person.status, person.canResend])).toEqual([
      ['alice', 'sent', true],
      ['bob', 'not_sent', true],
    ]);
  });
});
