import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ORG_DOMAINS,
  ORG_DOMAINS_SETTING,
  addressDomain,
  cleanDomainList,
  domainIn,
  isMicrosoftInitialDomain,
  isPlainDomain,
  orgDomains,
  orgDomainsFrom,
  parseOrgDomainsCache,
  sendingDomainRefusal,
  usableOrgDomainsCache,
} from './org-domains.ts';
import { FOCUS_ORG_DOMAINS_SETTING, focusOrgDomains } from './focused-inbox.ts';

// Invented example.* domains and placeholder GUIDs only.
const TENANT = '00000000-0000-0000-0000-000000000000';
const OTHER_TENANT = '00000000-0000-0000-0000-00000000beef';

function settingsDb(value: string | null | Error) {
  const seen: unknown[][] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        seen.push([sql, ...args]);
        return {
          first: async () => {
            if (value instanceof Error) throw value;
            return value === null ? null : { value };
          },
        };
      },
    }),
  } as unknown as D1Database;
  return { db, seen };
}

const cacheJson = (domains: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ tenantId: TENANT, domains, refreshedAt: 1, attemptedAt: 1, problem: '', ...extra });

describe('org domains', () => {
  it('is exactly [MAIL_DOMAIN], not discovered, with no cache (single-domain instances unchanged)', async () => {
    const { db, seen } = settingsDb(null);
    assert.deepEqual(await orgDomains({ MAIL_DOMAIN: ' Example.COM ' }, db), { primary: 'example.com', domains: ['example.com'], discovered: false });
    assert.equal(seen[0]?.[1], ORG_DOMAINS_SETTING);
  });

  it('adds the cached verified domains after the primary, sorted and without the primary twice', async () => {
    const cache = cacheJson(['example.org', 'example.com', 'example.net']);
    assert.deepEqual(await orgDomains({ MAIL_DOMAIN: 'example.com' }, settingsDb(cache).db), {
      primary: 'example.com',
      domains: ['example.com', 'example.net', 'example.org'],
      discovered: true,
    });
  });

  it('ignores a cache from another tenant, or one that names no tenant', async () => {
    const env = { MAIL_DOMAIN: 'example.com', M365_TENANT_ID: TENANT };
    const ours = { primary: 'example.com', domains: ['example.com', 'example.org'], discovered: true };
    const none = { primary: 'example.com', domains: ['example.com'], discovered: false };
    assert.deepEqual(await orgDomains(env, settingsDb(cacheJson(['example.org'])).db), ours);
    assert.deepEqual(await orgDomains(env, settingsDb(cacheJson(['example.org'], { tenantId: OTHER_TENANT })).db), none);
    assert.deepEqual(await orgDomains(env, settingsDb(cacheJson(['example.org'], { tenantId: '' })).db), none);
    // Without M365_TENANT_ID on this side, a list from some tenant is used.
    assert.deepEqual(await orgDomains({ MAIL_DOMAIN: 'example.com' }, settingsDb(cacheJson(['example.org'], { tenantId: OTHER_TENANT })).db), ours);
  });

  it('has no domains at all without a valid MAIL_DOMAIN, and then never reads D1', async () => {
    const { db, seen } = settingsDb(cacheJson(['example.org']));
    const empty = { primary: '', domains: [], discovered: false };
    assert.deepEqual(await orgDomains({ MAIL_DOMAIN: '' }, db), empty);
    assert.deepEqual(await orgDomains({ MAIL_DOMAIN: 'not a domain' }, db), empty);
    assert.deepEqual(await orgDomains({}, db), empty);
    assert.equal(seen.length, 0);
  });

  it('passes a D1 failure to the caller rather than guessing', async () => {
    await assert.rejects(orgDomains({ MAIL_DOMAIN: 'example.com' }, settingsDb(new Error('D1 down')).db), /D1 down/);
  });

  it('ignores a corrupt or hostile cache', () => {
    assert.deepEqual(parseOrgDomainsCache('not json').domains, []);
    assert.deepEqual(parseOrgDomainsCache('"x"').domains, []);
    assert.deepEqual(parseOrgDomainsCache(cacheJson('example.org')).domains, []);
    const cleaned = parseOrgDomainsCache(cacheJson(
      ['EXAMPLE.org', 'bad domain', 'contoso.onmicrosoft.com', 'contoso.mail.onmicrosoft.com', 'x@example.net', 42, 'example.org'],
      { refreshedAt: 'soon', problem: 'p'.repeat(200), missingSince: { 'example.org': 5, 'example.net': 5 } },
    ));
    assert.deepEqual(cleaned.domains, ['example.org']);
    assert.deepEqual(cleaned.missingSince, { 'example.org': 5 });
    assert.equal(cleaned.refreshedAt, 0);
    assert.equal(cleaned.problem.length, 64);
    assert.equal(parseOrgDomainsCache(cacheJson([], { tenantId: 'not-a-guid' })).tenantId, '');
  });

  it('never treats a Microsoft initial domain as a mail domain', () => {
    assert.equal(isMicrosoftInitialDomain('contoso.onmicrosoft.com'), true);
    assert.equal(isMicrosoftInitialDomain('onmicrosoft.com'), true);
    assert.equal(isMicrosoftInitialDomain('notonmicrosoft.com'), false);
    assert.deepEqual(cleanDomainList(['contoso.onmicrosoft.com']), []);
  });

  it('accepts IDN top-level domains (xn--)', () => {
    assert.equal(isPlainDomain('example.xn--p1ai'), true);
    assert.equal(isPlainDomain('xn--d1acufc.xn--p1ai'), true);
    assert.equal(isPlainDomain('example.c0m'), false);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_ORG_DOMAINS + 50 }, (_, index) => `d${String(index).padStart(4, '0')}.example`);
    assert.equal(cleanDomainList(many).length, MAX_ORG_DOMAINS);
  });

  it('orgDomainsFrom keeps the primary first even when the cache omits it', () => {
    assert.deepEqual(orgDomainsFrom('example.com', { domains: ['example.org'], refreshedAt: 1 }).domains, ['example.com', 'example.org']);
  });

  it('domainIn treats a string as one domain, so old single-domain callers match exactly as before', () => {
    assert.equal(domainIn('example.com', 'example.com'), true);
    assert.equal(domainIn('example.org', 'example.com'), false);
    assert.equal(domainIn('', ''), false);
    assert.equal(domainIn('example.org', new Set(['example.com', 'example.org'])), true);
    assert.equal(domainIn('example.org', ['example.com']), false);
  });

  it('addressDomain is the part after the last @', () => {
    assert.equal(addressDomain('Pat@Example.ORG'), 'example.org');
    assert.equal(addressDomain('no-at'), '');
    assert.equal(addressDomain('@example.org'), '');
  });
});

describe('sending (multi-domain phase 1)', () => {
  const discovered = { primary: 'example.com', domains: ['example.com', 'example.org'], discovered: true };
  it('allows MAIL_DOMAIN only once domains are discovered', () => {
    assert.equal(sendingDomainRefusal('Pat@Example.COM', discovered), null);
    assert.equal(
      sendingDomainRefusal('desk@example.org', discovered),
      "Sending from @example.org isn't set up yet. You can read and file this mailbox's mail; send from an @example.com address for now.",
    );
    // A mailbox left on a domain that was dropped cannot start sending again.
    assert.match(String(sendingDomainRefusal('desk@example.net', discovered)), /@example\.net isn't set up yet/);
  });

  it('changes nothing before discovery', () => {
    assert.equal(sendingDomainRefusal('desk@example.net', { primary: 'example.com', domains: ['example.com'], discovered: false }), null);
  });
});

describe('Focused Inbox reads the same list by the same rules (it keeps no imports)', () => {
  it('uses the same setting key', () => {
    assert.equal(FOCUS_ORG_DOMAINS_SETTING, ORG_DOMAINS_SETTING);
  });

  it('agrees with parseOrgDomainsCache + usableOrgDomainsCache on every case', () => {
    const raws: Array<string | null> = [
      null,
      '',
      'not json',
      '"x"',
      cacheJson('example.org'),
      cacheJson(['Example.ORG', 'example.org', 'bad domain', 'a.onmicrosoft.com', 7, 'example.xn--p1ai', 'b.example.net']),
      cacheJson(['example.org'], { tenantId: OTHER_TENANT }),
      cacheJson(['example.org'], { tenantId: '' }),
      JSON.stringify({ domains: ['example.org'] }),
      cacheJson(Array.from({ length: 250 }, (_, index) => `d${String(index).padStart(4, '0')}.example`)),
    ];
    for (const raw of raws) {
      for (const tenant of [null, TENANT, OTHER_TENANT]) {
        assert.deepEqual(
          focusOrgDomains(raw, tenant),
          usableOrgDomainsCache(parseOrgDomainsCache(raw), tenant).domains,
          `raw ${String(raw).slice(0, 60)} tenant ${tenant}`,
        );
      }
    }
  });
});
