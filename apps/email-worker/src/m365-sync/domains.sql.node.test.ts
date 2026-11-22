import { describe, expect, it } from 'vitest';
import { ORG_DOMAINS_SETTING, loadOrgDomainsCache, orgDomains } from '@stanchion/shared/org-domains';
import { migratedDatabase } from '../testing/sqlite-d1';
import { runM365SyncTick, type M365SyncDeps } from './sync';
import { DOMAINS_URL } from './graph';
import { DOMAIN_DROP_AFTER_MS, DOMAIN_REFRESH_MS, domainRefreshDue, mailDomainsOf, nextOrgDomainsCache, refreshOrgDomains } from './domains';
import { CLIENT_ID, DOMAIN, TENANT_ID, fakeGraph, person } from './testing/fake-graph';

// Multi-domain discovery (docs/multi-domain.md) against every real migration
// (node:sqlite) and a fake Graph. Placeholder GUIDs and example.* only.

const T0 = Date.parse('2026-11-16T00:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OTHER = 'example.org';
const OTHER_TENANT = '00000000-0000-0000-0000-00000000beef';
const mailDomain = (id: string) => ({ id, isVerified: true, supportedServices: ['Email', 'OfficeCommunicationsOnline'] });

function setup(options: { dryRun?: boolean } = {}) {
  const { d1, sqlite } = migratedDatabase();
  const fake = fakeGraph();
  let clock = T0;
  let ids = 0;
  sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('m365_sync_enabled', 'true')`).run();
  sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('m365_sync_dry_run', ?)`).run(options.dryRun ? 'true' : 'false');
  const env = { DB: d1, M365_TENANT_ID: TENANT_ID, M365_CLIENT_ID: CLIENT_ID, M365_CLIENT_SECRET: 'test-secret', MAIL_DOMAIN: DOMAIN };
  const tick = (deps: M365SyncDeps = {}) => runM365SyncTick(env, {
    fetcher: fake.fetch, sleep: async () => undefined, now: () => clock, newId: () => `id-${++ids}`, ...deps,
  });
  const mailboxes = () => sqlite.prepare('SELECT address, type, status FROM mailboxes ORDER BY address').all() as Array<Record<string, string>>;
  const users = () => sqlite.prepare('SELECT email, status FROM users ORDER BY email').all() as Array<Record<string, string>>;
  const audits = (type: string) => sqlite.prepare('SELECT detail FROM audit_log WHERE event_type = ? ORDER BY rowid').all(type) as Array<{ detail: string }>;
  const domainReads = () => fake.calls.filter((url) => url === DOMAINS_URL).length;
  const advance = (ms: number) => { clock += ms; };
  const syncNow = () => sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('m365_sync_requested_at', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(new Date(clock).toISOString());
  /** A full reconciliation with these people, run now. */
  const reconcile = async (people: ReturnType<typeof person>[], token: string) => {
    t.fake.setReconcile([people], token);
    syncNow();
    return tick();
  };
  const t = { d1, sqlite, env, fake, tick, mailboxes, users, audits, domainReads, advance, syncNow, reconcile };
  return t;
}

describe('multi-domain: discovery off or unchanged', () => {
  it('with only MAIL_DOMAIN verified, an object on another domain stays out exactly as before', async () => {
    const t = setup();
    t.fake.setReconcile([[person(1, 'alex'), person(2, 'blair', { mail: `blair@${OTHER}` })]]);
    expect(await t.tick()).toMatchObject({ status: 'worked', finished: true });
    expect(t.users()).toEqual([{ email: `alex@${DOMAIN}`, status: 'pending' }]);
    expect(await orgDomains(t.env, t.d1)).toEqual({ primary: DOMAIN, domains: [DOMAIN], discovered: true });
    // The first read is audited like any change (here: only MAIL_DOMAIN itself).
    expect(t.audits('m365_sync.domains_changed')).toHaveLength(1);
  });

  it('writes nothing and reads no domains while the sync switch is off', async () => {
    const t = setup();
    t.sqlite.prepare(`UPDATE org_settings SET value = 'false' WHERE key = 'm365_sync_enabled'`).run();
    expect(await t.tick()).toEqual({ status: 'off' });
    expect(t.domainReads()).toBe(0);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM org_settings WHERE key = ?').get(ORG_DOMAINS_SETTING)).toEqual({ n: 0 });
  });
});

describe('multi-domain: verified tenant mail domains', () => {
  it('syncs every verified, non-initial Email domain, and nothing else', async () => {
    const t = setup();
    t.fake.domains.push(
      mailDomain(OTHER),
      { id: 'pending.example.net', isVerified: false, supportedServices: ['Email'] },
      { id: 'sso.example.net', isVerified: true, supportedServices: ['OrgIdAuthentication'] },
      { id: 'initial.example.net', isVerified: true, isInitial: true, supportedServices: ['Email'] },
    );
    t.fake.setReconcile([[
      person(1, 'alex'),
      person(2, 'blair', { mail: `blair@${OTHER}` }),
      person(3, 'casey', { mail: 'casey@pending.example.net' }),
      person(4, 'drew', { mail: 'drew@tenant.onmicrosoft.com' }),
      person(5, 'emery', { mail: 'emery@sso.example.net' }),
      person(6, 'finn', { mail: 'finn@initial.example.net' }),
    ]]);
    expect(await t.tick()).toMatchObject({ status: 'worked', finished: true });
    expect(t.users()).toEqual([
      { email: `alex@${DOMAIN}`, status: 'pending' },
      { email: `blair@${OTHER}`, status: 'pending' },
    ]);
    expect(t.mailboxes().map((row) => row.address)).toEqual([`alex@${DOMAIN}`, `blair@${OTHER}`]);
    expect(await orgDomains(t.env, t.d1)).toEqual({ primary: DOMAIN, domains: [DOMAIN, OTHER], discovered: true });
    expect(t.audits('m365_sync.domains_changed')[0]?.detail).toContain('2 added (example.org, example.test)');
  });

  it('dry run reports other-domain creates without writing any account', async () => {
    const t = setup({ dryRun: true });
    t.fake.domains.push(mailDomain(OTHER));
    t.fake.setReconcile([[person(2, 'blair', { mail: `blair@${OTHER}` })]]);
    expect(await t.tick()).toMatchObject({ status: 'worked', mode: 'dry_run', finished: true });
    expect(t.users()).toEqual([]);
  });

  it('reads the domains at most daily, and again on Sync now', async () => {
    const t = setup();
    t.fake.setReconcile([[person(1, 'alex')]]);
    await t.tick();
    expect(t.domainReads()).toBe(1);
    t.advance(2 * HOUR);
    await t.reconcile([person(1, 'alex')], 'tok-2');
    expect(t.domainReads()).toBe(2);
    t.advance(2 * HOUR);
    await t.tick();
    expect(t.domainReads()).toBe(2);
  });

  it('ties the list to the tenant: a list from another tenant is replaced, and never read as ours', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES (?, ?)`).run(ORG_DOMAINS_SETTING, JSON.stringify({
      tenantId: OTHER_TENANT, domains: ['foreign.example.net'], refreshedAt: T0, attemptedAt: T0, problem: '',
    }));
    expect(await orgDomains(t.env, t.d1)).toEqual({ primary: DOMAIN, domains: [DOMAIN], discovered: false });
    t.fake.setReconcile([[person(1, 'alex'), person(7, 'gale', { mail: 'gale@foreign.example.net' })]]);
    await t.tick();
    // Read at once despite a fresh-looking cache, because it was another tenant's.
    expect(t.domainReads()).toBe(1);
    expect(await loadOrgDomainsCache(t.d1)).toMatchObject({ tenantId: TENANT_ID, domains: [DOMAIN] });
    expect(t.users().map((row) => row.email)).toEqual([`alex@${DOMAIN}`]);
  });
});

describe('multi-domain: a dropped domain never pauses people at once', () => {
  it('keeps a domain one read leaves out, and removes it (then pauses) only after a read a day later', async () => {
    const t = setup();
    t.fake.domains.push(mailDomain(OTHER));
    await t.reconcile([person(1, 'alex'), person(2, 'blair', { mail: `blair@${OTHER}` })], 'tok-1');
    expect(t.users()).toEqual([{ email: `alex@${DOMAIN}`, status: 'pending' }, { email: `blair@${OTHER}`, status: 'pending' }]);

    // One read without example.org: kept, marked missing, nobody paused.
    t.fake.domains.pop();
    t.advance(2 * HOUR);
    await t.reconcile([person(1, 'alex'), person(2, 'blair', { mail: `blair@${OTHER}` })], 'tok-2');
    expect(await loadOrgDomainsCache(t.d1)).toMatchObject({ domains: [OTHER, DOMAIN], missingSince: { [OTHER]: T0 + 2 * HOUR } });
    expect(t.users().map((row) => row.status)).toEqual(['pending', 'pending']);

    // It comes back: no longer missing.
    t.fake.domains.push(mailDomain(OTHER));
    t.advance(2 * HOUR);
    await t.reconcile([person(1, 'alex'), person(2, 'blair', { mail: `blair@${OTHER}` })], 'tok-3');
    expect((await loadOrgDomainsCache(t.d1)).missingSince).toEqual({});

    // Gone in two reads at least a day apart: removed (audited), and only then out of scope.
    t.fake.domains.pop();
    t.advance(2 * HOUR);
    await t.reconcile([person(1, 'alex'), person(2, 'blair', { mail: `blair@${OTHER}` })], 'tok-4');
    expect(t.users().map((row) => row.status)).toEqual(['pending', 'pending']);
    t.advance(DOMAIN_DROP_AFTER_MS);
    await t.reconcile([person(1, 'alex'), person(2, 'blair', { mail: `blair@${OTHER}` })], 'tok-5');
    expect(await orgDomains(t.env, t.d1)).toEqual({ primary: DOMAIN, domains: [DOMAIN], discovered: true });
    expect(t.audits('m365_sync.domains_changed').at(-1)?.detail).toContain('1 removed (example.org)');
    expect(t.users()).toEqual([{ email: `alex@${DOMAIN}`, status: 'pending' }, { email: `blair@${OTHER}`, status: 'paused' }]);
  });

  it('nextOrgDomainsCache (pure)', () => {
    const base = { tenantId: TENANT_ID, domains: [DOMAIN, OTHER], missingSince: {}, refreshedAt: T0, attemptedAt: T0, problem: '' };
    const once = nextOrgDomainsCache(base, [DOMAIN], TENANT_ID, T0 + HOUR);
    expect(once).toMatchObject({ domains: [OTHER, DOMAIN], missingSince: { [OTHER]: T0 + HOUR } });
    expect(nextOrgDomainsCache(once, [DOMAIN], TENANT_ID, T0 + HOUR + DAY - 1).domains).toEqual([OTHER, DOMAIN]);
    expect(nextOrgDomainsCache(once, [DOMAIN], TENANT_ID, T0 + HOUR + DAY).domains).toEqual([DOMAIN]);
  });
});

describe('multi-domain: failures never shrink the list', () => {
  it('without Domain.Read.All (403) the sync carries on with the last good list and records the problem', async () => {
    const t = setup();
    t.fake.domains.push(mailDomain(OTHER));
    t.fake.setReconcile([[person(2, 'blair', { mail: `blair@${OTHER}` })]]);
    await t.tick();
    expect(t.users()).toEqual([{ email: `blair@${OTHER}`, status: 'pending' }]);

    t.advance(DOMAIN_REFRESH_MS + HOUR);
    t.fake.queue(DOMAINS_URL, { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } });
    expect(await t.reconcile([person(2, 'blair', { mail: `blair@${OTHER}` })], 'tok-2')).toMatchObject({ status: 'worked', finished: true });
    expect(t.users()).toEqual([{ email: `blair@${OTHER}`, status: 'pending' }]);
    expect(await loadOrgDomainsCache(t.d1)).toMatchObject({ domains: [OTHER, DOMAIN], problem: 'permission_missing' });
  });

  it('an empty answer is a fault, not "no domains"', async () => {
    const t = setup();
    t.fake.domains.push(mailDomain(OTHER));
    t.fake.setReconcile([[person(1, 'alex')]]);
    await t.tick();
    t.fake.domains.splice(0, t.fake.domains.length);
    t.advance(DOMAIN_REFRESH_MS + HOUR);
    await t.reconcile([person(1, 'alex')], 'tok-2');
    expect(await loadOrgDomainsCache(t.d1)).toMatchObject({ domains: [OTHER, DOMAIN], problem: 'bad_response' });
  });

  it('an answer with no mail domain at all, where some were listed, is a fault too', async () => {
    const t = setup();
    t.fake.domains.push(mailDomain(OTHER));
    t.fake.setReconcile([[person(1, 'alex')]]);
    await t.tick();
    t.fake.domains.splice(0, t.fake.domains.length, { id: 'tenant.onmicrosoft.com', isVerified: true, isInitial: true, supportedServices: ['Email'] });
    t.advance(DOMAIN_REFRESH_MS + HOUR);
    await t.reconcile([person(1, 'alex')], 'tok-2');
    expect(await loadOrgDomainsCache(t.d1)).toMatchObject({ domains: [OTHER, DOMAIN], problem: 'empty_result' });
  });

  it('throttling on the domain read backs the whole sync off and keeps the list', async () => {
    const t = setup();
    t.fake.queue(DOMAINS_URL, { status: 429, headers: { 'retry-after': '120' } }, { status: 429, headers: { 'retry-after': '120' } }, { status: 429, headers: { 'retry-after': '120' } });
    t.fake.setReconcile([[person(1, 'alex')]]);
    expect(await t.tick()).toEqual({ status: 'error', code: 'throttled' });
    expect(await loadOrgDomainsCache(t.d1)).toMatchObject({ domains: [], problem: 'throttled' });
    expect(t.users()).toEqual([]);
  });
});

describe('multi-domain: pure rules', () => {
  const base = { tenantId: TENANT_ID, domains: [], missingSince: {}, refreshedAt: T0, attemptedAt: T0, problem: '' };
  it('is due after a day, or at once when forced', () => {
    expect(domainRefreshDue(base, T0 + HOUR, false)).toBe(false);
    expect(domainRefreshDue(base, T0 + DOMAIN_REFRESH_MS, false)).toBe(true);
    expect(domainRefreshDue(base, T0 + HOUR, true)).toBe(true);
  });
  it('waits an hour after a failed attempt', () => {
    const failed = { ...base, refreshedAt: 0, attemptedAt: T0, problem: 'throttled' };
    expect(domainRefreshDue(failed, T0 + 30 * 60 * 1000, false)).toBe(false);
    expect(domainRefreshDue(failed, T0 + HOUR, false)).toBe(true);
  });
  it('keeps only verified, non-initial Email domains, never *.onmicrosoft.com', () => {
    expect(mailDomainsOf([
      { name: 'a.example', isVerified: true, isInitial: false, email: true },
      { name: 'b.example', isVerified: false, isInitial: false, email: true },
      { name: 'c.example', isVerified: true, isInitial: true, email: true },
      { name: 'd.example', isVerified: true, isInitial: false, email: false },
      { name: 'x.onmicrosoft.com', isVerified: true, isInitial: false, email: true },
    ])).toEqual(['a.example']);
  });
  it('rethrows a D1 failure instead of recording a problem', async () => {
    const db = { prepare: () => { throw new Error('D1 down'); } } as unknown as D1Database;
    await expect(refreshOrgDomains(db, { domainList: async () => [] }, T0, { tenantId: TENANT_ID })).rejects.toThrow('D1 down');
  });
});
