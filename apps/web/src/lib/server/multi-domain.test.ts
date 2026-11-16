import { describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from './mcp/testing/harness';
import { callTool, connect } from './mcp/testing/flow';
import { loadPublicDirectory } from './public-directory';
import { sendEmail } from './outbound';
import { chooseOrgDomain, orgDomainsForDisplay } from './org-domains';
import { actions as mailboxActions } from '../../routes/admin/mailboxes/+page.server';

// Multi-domain (docs/multi-domain.md) through the real send path (the MCP
// tools call the compose action), the admin action and the public directory,
// against every real migration. example.test is MAIL_DOMAIN; example.org is
// a second organisation domain only once the sync has "discovered" it.

const OTHER = 'example.org';
const TENANT = '00000000-0000-0000-0000-000000000000';

function discover(fixture: Fixture, domains: string[]): void {
  fixture.db.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('m365_verified_domains', ?)`)
    .run(JSON.stringify({ tenantId: TENANT, domains, refreshedAt: 1, attemptedAt: 1, problem: '' }));
}

function mirrorAndColleagueSendOn(fixture: Fixture): void {
  fixture.db.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('exchange_mirror_enabled', 'true'), ('exchange_mirror_colleague_send', 'true')`);
}

function withProvider(): { fixture: Fixture; sent: Array<{ to: string[] }> } {
  const sent: Array<{ to: string[] }> = [];
  const service = {
    async fetch(_url: string, init: RequestInit) {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ success: true, messageId: `cf-${sent.length}` });
    },
  };
  return { fixture: createFixture({ OUTBOUND_PROVIDER: 'cloudflare', EMAIL_SERVICE: service }), sent };
}

const inboxCount = (fixture: Fixture, mailboxId: string) =>
  (fixture.db.sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ? AND folder = 'inbox'").get(mailboxId) as { n: number }).n;

describe('multi-domain: sending', () => {
  it('without discovered domains or the mirror, a send between colleagues is local exactly as before', async () => {
    const fixture = createFixture();
    const { tokens } = await connect(fixture, { scopes: ['mail.send'] });
    const sent = await callTool(fixture, tokens.access_token, 'send_message', { from: 'alice@example.test', to: ['bob@example.test'], subject: 'Hi', body: 'x' });
    expect(sent.isError, sent.text).toBe(false);
    expect(inboxCount(fixture, 'mb-bob')).toBe(1);
  });

  it('refuses a From on another organisation domain with a clear message, sending nothing', async () => {
    const fixture = createFixture();
    fixture.db.sqlite.prepare(`UPDATE mailboxes SET address = ? WHERE id = 'mb-desk'`).run(`desk@${OTHER}`);
    discover(fixture, [OTHER]);
    const { tokens } = await connect(fixture, { scopes: ['mail.send'] });
    const sent = await callTool(fixture, tokens.access_token, 'send_message', { from: `desk@${OTHER}`, to: ['bob@example.test'], subject: 'Hi', body: 'x' });
    expect(sent.isError).toBe(true);
    expect(sent.text).toContain(`Sending from @${OTHER} isn't set up yet`);
    expect(fixture.db.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('still delivers locally to a colleague on another organisation domain while the mirror is off', async () => {
    const fixture = createFixture();
    fixture.db.sqlite.prepare(`UPDATE mailboxes SET address = ? WHERE id = 'mb-bob'`).run(`bob@${OTHER}`);
    discover(fixture, [OTHER]);
    const { tokens } = await connect(fixture, { scopes: ['mail.send'] });
    const sent = await callTool(fixture, tokens.access_token, 'send_message', { from: 'alice@example.test', to: [`bob@${OTHER}`], subject: 'Hi', body: 'x' });
    expect(sent.isError, sent.text).toBe(false);
    expect(inboxCount(fixture, 'mb-bob')).toBe(1);
  });

  it('with the mirror and colleague send on, sends colleagues on every organisation domain through the provider, none locally', async () => {
    for (const bobAddress of ['bob@example.test', `bob@${OTHER}`]) {
      const { fixture, sent } = withProvider();
      fixture.db.sqlite.prepare(`UPDATE mailboxes SET address = ? WHERE id = 'mb-bob'`).run(bobAddress);
      discover(fixture, [OTHER]);
      mirrorAndColleagueSendOn(fixture);
      const { tokens } = await connect(fixture, { scopes: ['mail.send'] });
      const result = await callTool(fixture, tokens.access_token, 'send_message', { from: 'alice@example.test', to: [bobAddress], subject: 'Hi', body: 'x' });
      expect(result.isError, result.text).toBe(false);
      expect(sent.map((payload) => payload.to)).toEqual([[bobAddress]]);
      expect(inboxCount(fixture, 'mb-bob')).toBe(0);
    }
  });

  it('a mailbox left on a dropped domain cannot start sending again', async () => {
    const { fixture, sent } = withProvider();
    // example.net was an organisation domain once; the sync no longer lists it.
    fixture.db.sqlite.prepare(`UPDATE mailboxes SET address = 'desk@example.net' WHERE id = 'mb-desk'`).run();
    discover(fixture, [OTHER]);
    const { tokens } = await connect(fixture, { scopes: ['mail.send'] });
    const result = await callTool(fixture, tokens.access_token, 'send_message', { from: 'desk@example.net', to: ['someone@example.com'], subject: 'Hi', body: 'x' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Sending from @example.net isn\'t set up yet');
    expect(sent).toEqual([]);
  });

  it('before discovery, a mailbox on another domain sends exactly as before', async () => {
    const { fixture, sent } = withProvider();
    fixture.db.sqlite.prepare(`UPDATE mailboxes SET address = 'desk@example.net' WHERE id = 'mb-desk'`).run();
    const { tokens } = await connect(fixture, { scopes: ['mail.send'] });
    const result = await callTool(fixture, tokens.access_token, 'send_message', { from: 'desk@example.net', to: ['someone@example.com'], subject: 'Hi', body: 'x' });
    expect(result.isError, result.text).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('never stops system mail (sign-in codes, invitations, notices), whatever its From', async () => {
    const { fixture, sent } = withProvider();
    discover(fixture, [OTHER]);
    const base = { to: 'someone@example.com', subject: 'Code', html: '<p>x</p>', text: 'x' };
    expect((await sendEmail({ ...base, from: `noreply@${OTHER}`, system: true }, fixture.env)).success).toBe(true);
    const refused = await sendEmail({ ...base, from: `desk@${OTHER}` }, fixture.env);
    expect(refused).toMatchObject({ success: false, error: expect.stringContaining('isn\'t set up yet') });
    expect(sent).toHaveLength(1);
  });
  it('ignores a domain list read from another tenant', async () => {
    const fixture = createFixture({ M365_TENANT_ID: '00000000-0000-0000-0000-00000000beef' });
    fixture.db.sqlite.prepare(`UPDATE mailboxes SET address = ? WHERE id = 'mb-desk'`).run(`desk@${OTHER}`);
    discover(fixture, [OTHER]);
    expect((await orgDomainsForDisplay(fixture.env as never)).domains).toEqual(['example.test']);
  });
});
describe('multi-domain: admin choices come only from discovered domains', () => {
  const manager = { id: 'user-alice', role: 'manager' as const, display_name: 'Alice Example', email: 'alice@example.test' };
  const create = (fixture: Fixture, fields: Record<string, string>) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return (mailboxActions.create as never as (event: unknown) => Promise<unknown>)({
      request: new Request('https://mail.example.test/admin/mailboxes?/create', { method: 'POST', body: form }),
      platform: fixture.platform,
      locals: { user: manager },
    });
  };
  const exists = (fixture: Fixture, address: string) =>
    Boolean(fixture.db.sqlite.prepare('SELECT 1 FROM mailboxes WHERE address = ?').get(address));

  it('creates a shared mailbox on a discovered domain, picked or typed', async () => {
    const fixture = createFixture();
    discover(fixture, [OTHER]);
    expect(await create(fixture, { address: 'sales', domain: OTHER, display_name: 'Sales' })).toMatchObject({ success: expect.any(String) });
    expect(exists(fixture, `sales@${OTHER}`)).toBe(true);
    expect(await create(fixture, { address: `info@${OTHER}`, display_name: 'Info' })).toMatchObject({ success: expect.any(String) });
    expect(exists(fixture, `info@${OTHER}`)).toBe(true);
  });

  it('refuses a domain the organisation has not proven, picked or typed', async () => {
    const fixture = createFixture();
    for (const fields of <Array<Record<string, string>>>[
      { address: 'sales', domain: OTHER, display_name: 'Sales' },
      { address: `sales@${OTHER}`, display_name: 'Sales' },
      { address: 'sales', domain: 'tenant.onmicrosoft.com', display_name: 'Sales' },
    ]) {
      expect(await create(fixture, fields)).toMatchObject({ status: 400 });
    }
    expect(fixture.db.sqlite.prepare("SELECT COUNT(*) AS n FROM mailboxes WHERE address LIKE 'sales@%'").get()).toEqual({ n: 0 });
  });

  it('defaults to MAIL_DOMAIN when no domain is picked (single-domain forms unchanged)', async () => {
    const fixture = createFixture();
    expect(await create(fixture, { address: 'sales', display_name: 'Sales' })).toMatchObject({ success: expect.any(String) });
    expect(exists(fixture, 'sales@example.test')).toBe(true);
  });

  it('chooseOrgDomain accepts only listed domains', async () => {
    const fixture = createFixture();
    discover(fixture, [OTHER]);
    const domains = await orgDomainsForDisplay(fixture.env as never);
    expect(domains.domains).toEqual(['example.test', OTHER]);
    expect(chooseOrgDomain(null, domains)).toBe('example.test');
    expect(chooseOrgDomain(` ${OTHER.toUpperCase()} `, domains)).toBe(OTHER);
    expect(chooseOrgDomain('example.net', domains)).toBeNull();
  });
});

describe('multi-domain: public directory', () => {
  it('lists public work emails on discovered domains, and only those', async () => {
    const fixture = createFixture();
    fixture.db.sqlite.exec(`
      UPDATE organization_directory_settings SET enabled = 1 WHERE singleton_id = 1;
      INSERT INTO organization_layers (id, name) VALUES ('layer-1', 'Teams');
      INSERT INTO organization_units (id, layer_id, name) VALUES ('unit-1', 'layer-1', 'Office');
      INSERT INTO organization_roles (id, title) VALUES ('role-1', 'Coordinator');
      UPDATE mailboxes SET address = 'bob@${OTHER}' WHERE id = 'mb-bob';
      INSERT INTO organization_positions (id, unit_id, role_id, user_id, occupant_display_name, work_email, visibility)
        VALUES ('pos-1', 'unit-1', 'role-1', 'user-bob', 'Bob Example', 'bob@${OTHER}', 'public');
    `);
    expect((await loadPublicDirectory(fixture.db.d1, 'example.test')).entries).toEqual([]);
    discover(fixture, [OTHER]);
    expect((await loadPublicDirectory(fixture.db.d1, 'example.test')).entries).toEqual([
      { occupantDisplayName: 'Bob Example', workEmail: `bob@${OTHER}`, positionTitle: 'Coordinator' },
    ]);
  });
});
