import { describe, expect, it } from 'vitest';
import { m365SyncConfig } from '@cmail/shared/m365-sync';
import { classify, needsGroupCheck } from './classify';
import { CLIENT_ID, DOMAIN, SCOPE_GROUP, SHARED_GROUP, TENANT_ID, person, removed } from './testing/fake-graph';

const none = { scope: null, shared: null };

describe('classify', () => {
  it('accepts an enabled member with an Exchange plan on the mail domain', () => {
    expect(classify(person(1, 'alex'), DOMAIN, none, null)).toEqual({ kind: 'person', address: 'alex@example.test', displayName: 'Person 1' });
  });

  it.each([
    ['disabled', person(1, 'alex', { accountEnabled: false }), 'disabled'],
    ['a guest', person(1, 'alex', { userType: 'Guest' }), 'guest'],
    ['unlicensed', person(1, 'alex', { assignedPlans: [] }), 'no_mailbox_plan'],
    ['a suspended Exchange plan', person(1, 'alex', { assignedPlans: [{ service: 'exchange', capabilityStatus: 'Suspended' }] }), 'no_mailbox_plan'],
    ['only a non-Exchange plan', person(1, 'alex', { assignedPlans: [{ service: 'SharePoint', capabilityStatus: 'Enabled' }] }), 'no_mailbox_plan'],
    ['no mail address', person(1, 'alex', { mail: null }), 'no_address'],
    ['another domain', person(1, 'alex', { mail: 'alex@other.example' }), 'other_domain'],
    ['a local part Admin could not create', person(1, 'alex', { mail: 'a+b@example.test' }), 'other_domain'],
    ['deleted', removed(1), 'deleted'],
  ])('leaves out %s', (_label, user, reason) => {
    expect(classify(user, DOMAIN, none, null)).toMatchObject({ kind: 'out', reason });
  });

  it('keeps a licence in its grace period (Warning)', () => {
    const user = person(1, 'alex', { assignedPlans: [{ service: 'exchange', capabilityStatus: 'Warning' }] });
    expect(classify(user, DOMAIN, none, null).kind).toBe('person');
  });

  it('lower-cases the address', () => {
    expect(classify(person(1, 'alex', { mail: 'Alex@Example.Test' }), DOMAIN, none, null)).toMatchObject({ address: 'alex@example.test' });
  });

  it('requires the scope group when one is set', () => {
    const groups = { scope: SCOPE_GROUP, shared: null };
    expect(classify(person(1, 'alex'), DOMAIN, groups, new Set())).toMatchObject({ kind: 'out', reason: 'not_in_scope_group' });
    expect(classify(person(1, 'alex'), DOMAIN, groups, new Set([SCOPE_GROUP])).kind).toBe('person');
  });

  it('treats shared-group members as shared mailboxes even when disabled and unlicensed', () => {
    const groups = { scope: SCOPE_GROUP, shared: SHARED_GROUP };
    const user = person(9, 'team', { accountEnabled: false, assignedPlans: [] });
    expect(classify(user, DOMAIN, groups, new Set([SHARED_GROUP]))).toMatchObject({ kind: 'shared', address: 'team@example.test' });
  });

  it('only asks for group membership when a group is configured and the address is on the domain', () => {
    expect(needsGroupCheck(person(1, 'alex'), DOMAIN, none)).toBe(false);
    expect(needsGroupCheck(person(1, 'alex'), DOMAIN, { scope: SCOPE_GROUP, shared: null })).toBe(true);
    expect(needsGroupCheck(person(1, 'alex', { mail: 'alex@other.example' }), DOMAIN, { scope: SCOPE_GROUP, shared: null })).toBe(false);
    expect(needsGroupCheck(removed(1), DOMAIN, { scope: SCOPE_GROUP, shared: null })).toBe(false);
  });
});

describe('m365SyncConfig', () => {
  const base = { M365_TENANT_ID: TENANT_ID, M365_CLIENT_ID: CLIENT_ID, M365_CLIENT_SECRET: 'test-secret', MAIL_DOMAIN: DOMAIN };

  it('accepts a complete configuration with defaults', () => {
    const check = m365SyncConfig(base);
    expect(check).toMatchObject({ configured: true, config: { intervalMinutes: 60, scopeGroupId: null, sharedGroupId: null, mailDomain: DOMAIN } });
  });

  it('names missing or malformed settings without echoing values', () => {
    const check = m365SyncConfig({ M365_TENANT_ID: 'not-a-guid', M365_CLIENT_SECRET: '', MAIL_DOMAIN: '' });
    expect(check.configured).toBe(false);
    const problems = check.configured ? [] : check.problems;
    expect(problems.join(' ')).toContain('M365_TENANT_ID');
    expect(problems.join(' ')).toContain('M365_CLIENT_ID');
    expect(problems.join(' ')).toContain('M365_CLIENT_SECRET');
    expect(problems.join(' ')).toContain('MAIL_DOMAIN');
    expect(problems.join(' ')).not.toContain('not-a-guid');
  });

  it('clamps the interval to 15..1440 minutes', () => {
    expect(m365SyncConfig({ ...base, M365_SYNC_INTERVAL_MINUTES: '1' })).toMatchObject({ config: { intervalMinutes: 15 } });
    expect(m365SyncConfig({ ...base, M365_SYNC_INTERVAL_MINUTES: '99999' })).toMatchObject({ config: { intervalMinutes: 1440 } });
  });

  it('refuses the same group for scope and shared', () => {
    expect(m365SyncConfig({ ...base, M365_SCOPE_GROUP_ID: SCOPE_GROUP, M365_SHARED_GROUP_ID: SCOPE_GROUP }).configured).toBe(false);
  });
});
