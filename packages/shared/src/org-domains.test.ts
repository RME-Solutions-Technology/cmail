import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ORG_DOMAINS,
  ORG_DOMAINS_SETTING,
  addressDomain,
  cleanDomainList,
  domainIn,
  isMicrosoftInitialDomain,
  orgDomains,
  orgDomainsFrom,
  parseOrgDomainsCache,
} from './org-domains.ts';
import { FOCUS_ORG_DOMAINS_SETTING } from './focused-inbox.ts';

// Invented example.* domains only.
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

describe('org domains', () => {
  it('is exactly [MAIL_DOMAIN] with no cache (single-domain instances unchanged)', async () => {
    const { db, seen } = settingsDb(null);
    assert.deepEqual(await orgDomains({ MAIL_DOMAIN: ' Example.COM ' }, db), { primary: 'example.com', domains: ['example.com'] });
    assert.equal(seen[0]?.[1], ORG_DOMAINS_SETTING);
  });

  it('adds the cached verified domains after the primary, sorted and without the primary twice', async () => {
    const cache = JSON.stringify({ domains: ['example.org', 'example.com', 'example.net'], refreshedAt: 1, attemptedAt: 1, problem: '' });
    assert.deepEqual(await orgDomains({ MAIL_DOMAIN: 'example.com' }, settingsDb(cache).db), {
      primary: 'example.com',
      domains: ['example.com', 'example.net', 'example.org'],
    });
  });

  it('has no domains at all without a valid MAIL_DOMAIN, and then never reads D1', async () => {
    const { db, seen } = settingsDb(JSON.stringify({ domains: ['example.org'] }));
    assert.deepEqual(await orgDomains({ MAIL_DOMAIN: '' }, db), { primary: '', domains: [] });
    assert.deepEqual(await orgDomains({ MAIL_DOMAIN: 'not a domain' }, db), { primary: '', domains: [] });
    assert.deepEqual(await orgDomains({}, db), { primary: '', domains: [] });
    assert.equal(seen.length, 0);
  });

  it('passes a D1 failure to the caller rather than guessing', async () => {
    await assert.rejects(orgDomains({ MAIL_DOMAIN: 'example.com' }, settingsDb(new Error('D1 down')).db), /D1 down/);
  });

  it('ignores a corrupt or hostile cache', () => {
    assert.deepEqual(parseOrgDomainsCache('not json').domains, []);
    assert.deepEqual(parseOrgDomainsCache('"x"').domains, []);
    assert.deepEqual(parseOrgDomainsCache(JSON.stringify({ domains: 'example.org' })).domains, []);
    const cleaned = parseOrgDomainsCache(JSON.stringify({
      domains: ['EXAMPLE.org', 'bad domain', 'contoso.onmicrosoft.com', 'contoso.mail.onmicrosoft.com', 'x@example.net', 42, 'example.org'],
      refreshedAt: 'soon',
      problem: 'p'.repeat(200),
    }));
    assert.deepEqual(cleaned.domains, ['example.org']);
    assert.equal(cleaned.refreshedAt, 0);
    assert.equal(cleaned.problem.length, 64);
  });

  it('never treats a Microsoft initial domain as a mail domain', () => {
    assert.equal(isMicrosoftInitialDomain('contoso.onmicrosoft.com'), true);
    assert.equal(isMicrosoftInitialDomain('onmicrosoft.com'), true);
    assert.equal(isMicrosoftInitialDomain('notonmicrosoft.com'), false);
    assert.deepEqual(cleanDomainList(['contoso.onmicrosoft.com']), []);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_ORG_DOMAINS + 50 }, (_, index) => `d${String(index).padStart(4, '0')}.example`);
    assert.equal(cleanDomainList(many).length, MAX_ORG_DOMAINS);
  });

  it('orgDomainsFrom keeps the primary first even when the cache omits it', () => {
    assert.deepEqual(orgDomainsFrom('example.com', { domains: ['example.org'] }).domains, ['example.com', 'example.org']);
  });

  it('domainIn treats a string as one domain, so old single-domain callers match exactly as before', () => {
    assert.equal(domainIn('example.com', 'example.com'), true);
    assert.equal(domainIn('example.org', 'example.com'), false);
    assert.equal(domainIn('', ''), false);
    assert.equal(domainIn('example.org', new Set(['example.com', 'example.org'])), true);
    assert.equal(domainIn('example.org', ['example.com']), false);
  });

  it('Focused Inbox reads the same setting key (it keeps no imports)', () => {
    assert.equal(FOCUS_ORG_DOMAINS_SETTING, ORG_DOMAINS_SETTING);
  });

  it('addressDomain is the part after the last @', () => {
    assert.equal(addressDomain('Pat@Example.ORG'), 'example.org');
    assert.equal(addressDomain('no-at'), '');
    assert.equal(addressDomain('@example.org'), '');
  });
});
