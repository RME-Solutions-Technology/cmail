import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { createTestDatabase } from '#lib/server/mcp/testing/harness';
import { actions, load } from './+page.server';
import Page from './+page.svelte';
import { GET as syncRedirect } from '../m365-sync/+server';
import { GET as accessRedirect } from '../m365-mailbox-access/+server';
import { GET as mirrorRedirect } from '../exchange-mirror/+server';

type User = { id: string; role: string } | null;

function platformFor(d1: unknown, fetch = vi.fn(async () => Response.json({ status: 'started' }))) {
  return { env: { DB: d1, EMAIL_SERVICE: { fetch } }, context: { waitUntil: vi.fn() }, caches: {} };
}

function post(section: 'sync' | 'access' | 'mirror', action: string, user: User, seedManager = false) {
  const { d1, sqlite } = createTestDatabase();
  if (seedManager) sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('manager-1', 'manager@example.test', 'manager', 'active')`).run();
  const fetch = vi.fn(async () => Response.json({ status: 'started' }));
  const body = new FormData();
  body.set('action', action);
  const request = new Request(`https://mail.example.test/admin/microsoft-365?/${section}`, { method: 'POST', body });
  const result = (actions[section] as any)({ request, locals: { user, sessionId: null }, platform: platformFor(d1, fetch) });
  return { result, sqlite, fetch };
}

function redirectOf(handler: () => unknown): { status: number; location: string } {
  try {
    handler();
  } catch (caught) {
    const redirected = caught as { status: number; location: string };
    return { status: redirected.status, location: redirected.location };
  }
  throw new Error('expected a redirect');
}

describe('Admin > Microsoft 365 actions', () => {
  it('refuses a standard user (403) in every section and changes nothing', async () => {
    for (const [section, action] of [['sync', 'enable'], ['access', 'enable'], ['mirror', 'enable'], ['mirror', 'alias_enable'], ['sync', 'welcome_enable']] as const) {
      const { result, sqlite, fetch } = post(section, action, { id: 'u1', role: 'standard' });
      expect(await result).toMatchObject({ status: 403, data: { section: action.startsWith('welcome_') ? 'welcome' : section } });
      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM org_settings WHERE key LIKE 'exchange_mirror%' OR key LIKE 'm365%'`).get()).toEqual({ n: 0 });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('refuses a signed-out request (401) and an unknown action (400) in every section', async () => {
    for (const section of ['sync', 'access', 'mirror'] as const) {
      expect(await post(section, 'enable', null).result).toMatchObject({ status: 401, data: { section } });
      expect(await post(section, 'drop_tables', { id: 'm1', role: 'manager' }).result).toMatchObject({ status: 400, data: { section } });
    }
  });

  it('keeps the same action names working: the three switches no longer collide', async () => {
    const sync = post('sync', 'dry_run_off', { id: 'manager-1', role: 'manager' }, true);
    const access = post('access', 'managers_on', { id: 'manager-1', role: 'manager' }, true);
    expect(await sync.result).toMatchObject({ section: 'sync' });
    expect(await access.result).toMatchObject({ section: 'access' });
  });
});

describe('Admin > Microsoft 365 old routes', () => {
  it('redirect permanently to the matching section', () => {
    expect(redirectOf(() => (syncRedirect as any)())).toEqual({ status: 301, location: '/admin/microsoft-365#directory-sync' });
    expect(redirectOf(() => (accessRedirect as any)())).toEqual({ status: 301, location: '/admin/microsoft-365#shared-mailbox-access' });
    expect(redirectOf(() => (mirrorRedirect as any)())).toEqual({ status: 301, location: '/admin/microsoft-365#mail-feed' });
  });
});

describe('Admin > Microsoft 365 page', () => {
  it('a section that fails to load shows as unavailable and the others still load', async () => {
    const broken = { prepare() { throw new Error('d1 down'); }, batch() { throw new Error('d1 down'); }, exec() { throw new Error('d1 down'); } };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = await (load as any)({ platform: platformFor(broken), locals: { user: { id: 'm1', role: 'manager' } } });
    quiet.mockRestore();
    expect(data).toEqual({ sync: null, welcome: null, access: null, feed: null });
  });

  it('loads nothing for a non-manager', async () => {
    const { d1 } = createTestDatabase();
    const data = await (load as any)({ platform: platformFor(d1), locals: { user: { id: 'u1', role: 'standard' } } });
    expect(data).toEqual({ sync: null, welcome: null, access: null, feed: null });
  });

  it('renders every section for a manager, with the legacy journal source collapsed', async () => {
    const { d1 } = createTestDatabase();
    const data = await (load as any)({ platform: platformFor(d1), locals: { user: { id: 'm1', role: 'manager' } } });
    const { body } = render(Page, { props: { data: { ...data, appName: 'Example Mail' }, form: null } as never });
    for (const heading of ['Connection', 'Directory sync', 'Shared mailbox access', 'Welcome emails', 'Mail feed', 'Standby']) {
      expect(body).toContain(`>${heading}</h2>`);
    }
    expect(body).toContain('Include manager accounts');
    expect(body).toContain('Graph source (recommended)');
    expect(body).toMatch(/<details class="[^"]*legacy[^"]*" data-testid="journal-source">/);
    expect(body).not.toMatch(/<details[^>]*data-testid="journal-source"[^>]*\sopen/);
    expect(body).toContain('not recommended with Cloudflare Email Routing');
    expect(body).toContain('href="/admin/standby"');
    expect(body).toContain('data-testid="standby-link-note"');
    expect(body).not.toMatch(/(?<![@/\w-])Stanchion(?![/\w-])/);
  });

  it('sends every form to a named action in its own section, and gives each heading id once', async () => {
    const { d1 } = createTestDatabase();
    const data = await (load as any)({ platform: platformFor(d1), locals: { user: { id: 'm1', role: 'manager' } } });
    const { body } = render(Page, { props: { data: { ...data, appName: 'Example Mail' }, form: null } as never });
    const forms = body.match(/<form [^>]*>/g) ?? [];
    expect(forms.length).toBeGreaterThan(5);
    for (const tag of forms) expect(tag).toMatch(/action="\?\/(sync|access|mirror)#[a-z-]+"/);
    const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('shows a result only in the section it came from', () => {
    const props = { data: { sync: null, welcome: null, access: null, feed: null, appName: 'Example Mail' }, form: { section: 'access', success: 'Done in access' } };
    const { body } = render(Page, { props: props as never });
    expect(body.match(/Done in access/g)?.length ?? 0).toBe(1);
    const sync = render(Page, { props: { ...props, form: { section: 'sync', success: 'Done in sync' } } as never }).body;
    expect(sync.match(/Done in sync/g)?.length ?? 0).toBe(1);
    const welcome = render(Page, { props: { ...props, form: { section: 'welcome', success: 'Done in welcome' } } as never }).body;
    expect(welcome.match(/Done in welcome/g)?.length ?? 0).toBe(1);
  });
});
