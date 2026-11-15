import { describe, expect, it, vi } from 'vitest';
import worker, { RECIPIENT_UNAVAILABLE_SMTP_RESPONSE } from '../index';
import { migratedDatabase } from '../testing/sqlite-d1';
import { GUARDS_OFF } from '../testing/delivery';
import { JOURNAL_REJECT_RESPONSE } from './ingest';
import { AUTHSERV, DOMAIN, JOURNAL, OTHER_TENANT, TENANT, defaultEnvelope, innerMessage, journalReport } from './fixtures';

// The Exchange mirror against every real migration (node:sqlite), driving
// the real inbound handler with journal reports shaped like Exchange
// Online's (fixtures.ts). Every test also proves nothing was sent.

type Row = Record<string, unknown>;

function setup(options: { enabled?: boolean; env?: Record<string, unknown> } = {}) {
  const { d1, sqlite } = migratedDatabase();
  const person = (id: string, status = 'active') => {
    sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES (?, ?, 'standard', 'active')`).run(id, `${id}@${DOMAIN}`);
    sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status, owner_user_id) VALUES (?, ?, 'personal', ?, ?)`).run(`mbx-${id}`, `${id}@${DOMAIN}`, status, id);
  };
  for (const id of ['alice', 'bob', 'carol', 'dave', 'erin']) person(id);
  person('olive', 'disabled');
  sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-support', ?, 'shared', 'active')`).run(`support@${DOMAIN}`);
  const setSwitch = (on: boolean) => sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('exchange_mirror_enabled', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(on ? 'true' : 'false');
  if (options.enabled ?? true) setSwitch(true);

  const r2 = new Map<string, unknown>();
  const storage = {
    put: vi.fn(async (key: string, value: unknown) => { r2.set(key, value); }),
    delete: vi.fn(async (key: string) => { r2.delete(key); }),
  };
  const send = vi.fn(async () => ({ messageId: '<never@example.test>' }));
  const env: Record<string, unknown> = {
    DB: d1,
    STORAGE: storage,
    EMAIL: { send },
    MAIL_DOMAIN: DOMAIN,
    INBOUND_AUTHSERV_ID: AUTHSERV,
    M365_JOURNAL_ADDRESS: JOURNAL,
    M365_TENANT_ID: TENANT,
    // Off by default in the product; most tests here exercise it.
    M365_JOURNAL_MIRROR_SENT: 'true',
    ...GUARDS_OFF,
    ...options.env,
  };
  const waitUntil = vi.fn();
  const outbound: unknown[] = [];

  let rawReads = 0;
  async function deliver(raw: string, envelope: { to?: string; from?: string; rawSize?: number } = {}) {
    // Email Routing exposes the top-level headers; the inbound path reads Message-ID from them.
    const messageId = /^Message-ID: (.*)$/im.exec(raw.split('\r\n\r\n')[0] ?? '')?.[1] ?? '';
    const message = {
      from: envelope.from ?? `bounce@${DOMAIN}`,
      to: envelope.to ?? JOURNAL,
      rawSize: envelope.rawSize ?? raw.length,
      headers: new Headers(messageId ? { 'message-id': messageId } : {}),
      get raw() {
        rawReads += 1;
        return new Blob([raw]).stream();
      },
      setReject: vi.fn(),
      forward: vi.fn(async (...args: unknown[]) => { outbound.push(['forward', ...args]); }),
      reply: vi.fn(async (...args: unknown[]) => { outbound.push(['reply', ...args]); }),
    };
    const error = await (worker as unknown as { email(m: unknown, e: unknown, c: unknown): Promise<void> })
      .email(message, env, { waitUntil })
      .then(() => null, (caught: unknown) => caught as Error);
    return { error, message };
  }

  const messages = () => sqlite.prepare(
    `SELECT id, mailbox_id, direction, folder, is_read, from_address, subject, to_addresses, bcc_addresses, message_id_header, body_r2_key
     FROM messages ORDER BY mailbox_id, direction`,
  ).all() as Row[];
  const days = () => sqlite.prepare('SELECT * FROM exchange_mirror_days').all() as Row[];
  const audits = () => sqlite.prepare(`SELECT event_type, detail FROM audit_log WHERE event_type LIKE 'exchange_mirror.%' ORDER BY rowid`).all() as Row[];
  const traces = () => sqlite.prepare('SELECT status, status_detail, envelope_to, subject FROM mail_trace ORDER BY rowid').all() as Row[];
  /** Nothing may ever leave: no Email Sending call, no forward, no reply. */
  const assertNothingSent = () => {
    expect(send).not.toHaveBeenCalled();
    expect(outbound).toEqual([]);
  };
  return { d1, sqlite, env, deliver, messages, days, audits, traces, r2, waitUntil, setSwitch, assertNothingSent, rawReads: () => rawReads, storage };
}

describe('Exchange mirror: filing', () => {
  it('files the original (not the report) into every matched recipient once, as read, with no notification', async () => {
    const t = setup();
    const { error, message } = await t.deliver(journalReport({
      inner: innerMessage({ to: 'Bob <bob@example.test>, Team <team@example.test>', cc: 'carol@example.test' }),
      envelope: [
        'Sender: alice@example.test',
        'Subject: Quarterly plan',
        'Message-Id: <plan-1@example.test>',
        'To: bob@example.test',
        'To: DAVE@Example.Test, Expanded: team@example.test',
        'To: "Erin E" <erin@example.test>, Expanded: team@example.test',
        'Cc: carol@example.test',
        'Bcc: support@example.test',
        'To: frank@example.test, Forwarded: bob@example.test',
        'Recipient: partner@partner.example',
        'To: bob@example.test',
        'To: olive@example.test',
      ],
    }));
    expect(error).toBeNull();
    expect(message.setReject).not.toHaveBeenCalled();
    const rows = t.messages();
    const inbound = rows.filter((row) => row.direction === 'inbound');
    expect(inbound.map((row) => row.mailbox_id)).toEqual(['mbx-bob', 'mbx-carol', 'mbx-dave', 'mbx-erin', 'mbx-support']);
    for (const row of inbound) {
      expect(row).toMatchObject({ folder: 'inbox', is_read: 1, from_address: 'alice@example.test', subject: 'Quarterly plan', message_id_header: '<plan-1@example.test>', bcc_addresses: '[]' });
      // The stored body is the original's text, never the envelope.
      const body = String(t.r2.get(String(row.body_r2_key)));
      expect(body).toContain('Hello team');
      expect(body).not.toContain('Message-Id:');
    }
    // Inbound copies of a known sender go to its Sent too (see the Sent tests).
    expect(rows.filter((row) => row.direction === 'outbound').map((row) => row.mailbox_id)).toEqual(['mbx-alice']);
    // frank (unknown), partner (external), olive (disabled mailbox).
    expect(t.days()[0]).toMatchObject({ received: 1, filed: 5, sent_filed: 1, duplicates: 0, unmatched: 3, skipped: 0, rejected: 0 });
    expect(t.traces()).toEqual([expect.objectContaining({ status: 'delivered', envelope_to: null, subject: 'Quarterly plan' })]);
    expect(t.waitUntil).not.toHaveBeenCalled();
    t.assertNothingSent();
  });

  it('files to fresh imported aliases only, never to an alias of a disabled mailbox', async () => {
    const report = () => journalReport({ envelope: [...defaultEnvelope().slice(0, 3), 'To: Robert@example.test', 'To: ollie@example.test', 'To: carol@example.test'] });
    const withAliases = (options: { importOn: boolean; lastOkAgeMs: number | null }) => {
      const t = setup();
      t.sqlite.prepare(`INSERT INTO mailbox_aliases (address, mailbox_id, object_id) VALUES (?, 'mbx-bob', ?)`).run(`robert@${DOMAIN}`, TENANT);
      t.sqlite.prepare(`INSERT INTO mailbox_aliases (address, mailbox_id, object_id) VALUES (?, 'mbx-olive', ?)`).run(`ollie@${DOMAIN}`, TENANT);
      t.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('m365_alias_sync_enabled', ?)`).run(options.importOn ? 'true' : 'false');
      if (options.lastOkAgeMs !== null) {
        t.sqlite.prepare(`INSERT INTO m365_alias_sync_state (id, last_ok_at, last_run_at) VALUES (1, ?, ?)`).run(Date.now() - options.lastOkAgeMs, Date.now());
      }
      return t;
    };
    const fresh = withAliases({ importOn: true, lastOkAgeMs: 60 * 60 * 1000 });
    await fresh.deliver(report());
    expect(fresh.messages().filter((row) => row.direction === 'inbound').map((row) => row.mailbox_id)).toEqual(['mbx-bob', 'mbx-carol']);
    expect(fresh.days()[0]).toMatchObject({ filed: 2, unmatched: 1 });
    fresh.assertNothingSent();
    // Import switched off, never succeeded, or last success over 3 days ago: aliases are not used.
    for (const options of [{ importOn: false, lastOkAgeMs: 60_000 }, { importOn: true, lastOkAgeMs: null }, { importOn: true, lastOkAgeMs: 4 * 24 * 60 * 60 * 1000 }]) {
      const stale = withAliases(options);
      await stale.deliver(report());
      expect(stale.messages().filter((row) => row.direction === 'inbound').map((row) => row.mailbox_id), JSON.stringify(options)).toEqual(['mbx-carol']);
      expect(stale.days()[0]).toMatchObject({ filed: 1, unmatched: 2 });
    }
  });

  it('is idempotent: a repeated report and an overlapping split report file nothing twice', async () => {
    const t = setup();
    const envelope = [...defaultEnvelope().slice(0, 3), 'To: bob@example.test', 'Cc: carol@example.test'];
    await t.deliver(journalReport({ envelope }));
    await t.deliver(journalReport({ envelope }));
    await t.deliver(journalReport({ envelope: [...defaultEnvelope().slice(0, 3), 'Cc: carol@example.test', 'To: dave@example.test'] }));
    const inbound = t.messages().filter((row) => row.direction === 'inbound');
    expect(inbound.map((row) => row.mailbox_id)).toEqual(['mbx-bob', 'mbx-carol', 'mbx-dave']);
    expect(t.days()[0]).toMatchObject({ received: 3, filed: 3, sent_filed: 1, duplicates: 5 });
    t.assertNothingSent();
  });

  it('does not duplicate a message the normal inbound path already delivered', async () => {
    const t = setup();
    const inner = innerMessage({ messageId: '<direct-1@partner.example>', from: 'Pat <pat@partner.example>' });
    const direct = await t.deliver(inner, { to: `bob@${DOMAIN}`, from: 'pat@partner.example' });
    expect(direct.error).toBeNull();
    await t.deliver(journalReport({ inner, envelope: ['Sender: pat@partner.example', 'Subject: Quarterly plan', 'Message-Id: <direct-1@partner.example>', 'Recipient: bob@example.test'] }));
    expect(t.messages().filter((row) => row.mailbox_id === 'mbx-bob')).toHaveLength(1);
    expect(t.days()[0]).toMatchObject({ filed: 0, duplicates: 1 });
  });

  it('never runs inbox rules on a mirrored copy', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO inbox_rules (id, mailbox_id, name, position, definition) VALUES ('r1', 'mbx-bob', 'Everything to archive', 0, ?)`)
      .run(JSON.stringify({ appliesToAll: true, actions: { moveTo: 'archive' } }));
    await t.deliver(journalReport());
    expect(t.messages().find((row) => row.mailbox_id === 'mbx-bob')).toMatchObject({ folder: 'inbox' });
    // The rule itself is valid: the normal path applies it.
    await t.deliver(innerMessage({ from: 'pat@partner.example', messageId: '<r@partner.example>' }), { to: `bob@${DOMAIN}`, from: 'pat@partner.example' });
    expect(t.messages().filter((row) => row.mailbox_id === 'mbx-bob').map((row) => row.folder).sort()).toEqual(['archive', 'inbox']);
    t.assertNothingSent();
  });

  it('applies the organisation sender block rule (Spam), as the normal path does', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO sender_rules (id, pattern, action) VALUES ('s1', 'partner.example', 'block')`).run();
    await t.deliver(journalReport({ inner: innerMessage({ from: 'pat@partner.example', messageId: '<p@partner.example>' }), envelope: ['Sender: pat@partner.example', 'Subject: Quarterly plan', 'Message-Id: <p@partner.example>', 'Recipient: bob@example.test'] }));
    expect(t.messages()).toEqual([expect.objectContaining({ mailbox_id: 'mbx-bob', folder: 'spam' })]);
  });
});

describe('Exchange mirror: Sent copies', () => {
  it('files a Sent copy, with Bcc, for a cmail user who sent through Exchange', async () => {
    const t = setup();
    await t.deliver(journalReport({
      inner: innerMessage(),
      envelope: [...defaultEnvelope().slice(0, 3), 'To: bob@example.test', 'Bcc: carol@example.test', 'To: partner@partner.example'],
    }));
    const sent = t.messages().filter((row) => row.direction === 'outbound');
    expect(sent).toEqual([expect.objectContaining({ mailbox_id: 'mbx-alice', folder: 'sent', is_read: 1 })]);
    expect(JSON.parse(String(sent[0]?.bcc_addresses))).toEqual(['carol@example.test']);
    // Recipients' copies never show who was Bcc'd.
    for (const row of t.messages().filter((item) => item.direction === 'inbound')) expect(row.bcc_addresses).toBe('[]');
    t.assertNothingSent();
  });

  it('files no Sent copy unless every gate passes (fail closed), and none by default', async () => {
    const cases: Array<{ name: string; report: string; env?: Record<string, unknown> }> = [
      { name: 'Recipient lines only (internet mail)', report: journalReport({ envelope: [...defaultEnvelope().slice(0, 3), 'Recipient: bob@example.test'] }) },
      { name: 'no tenant headers on the original', report: journalReport({ inner: innerMessage({ internal: false }) }) },
      { name: 'AuthAs missing', report: journalReport({ inner: innerMessage({ internal: false, headers: { 'X-MS-Exchange-CrossTenant-Id': TENANT } }) }) },
      { name: 'tenant id missing', report: journalReport({ inner: innerMessage({ internal: false, headers: { 'X-MS-Exchange-CrossTenant-AuthAs': 'Internal' } }) }) },
      { name: 'a second AuthAs instance says Anonymous', report: journalReport({ inner: innerMessage({ headers: { 'X-MS-Exchange-CrossTenant-AuthAs': 'Anonymous' } }) }) },
      { name: 'a second tenant id instance is another tenant', report: journalReport({ inner: innerMessage({ headers: { 'X-MS-Exchange-CrossTenant-Id': OTHER_TENANT } }) }) },
      { name: 'sender is not the From', report: journalReport({ envelope: ['Sender: dave@example.test', ...defaultEnvelope().slice(1)] }) },
      { name: 'switched off', report: journalReport(), env: { M365_JOURNAL_MIRROR_SENT: 'false' } },
      { name: 'not set (default off)', report: journalReport(), env: { M365_JOURNAL_MIRROR_SENT: undefined } },
    ];
    for (const item of cases) {
      const t = setup({ env: item.env });
      await t.deliver(item.report);
      expect(t.messages().filter((row) => row.direction === 'outbound'), item.name).toEqual([]);
      expect(t.messages().filter((row) => row.direction === 'inbound'), item.name).toHaveLength(1);
    }
  });
});

describe('Exchange mirror: refused reports', () => {
  const forged: Array<{ name: string; reason: string; report: () => string; env?: Record<string, unknown> }> = [
    { name: 'no X-MS-Journal-Report header', reason: 'not_journal_report', report: () => journalReport({ journalHeader: false }) },
    { name: 'another tenant', reason: 'wrong_tenant', report: () => journalReport({ tenantHeader: OTHER_TENANT }) },
    { name: 'no trusted Authentication-Results', reason: 'auth_missing', report: () => journalReport({ authenticationResults: null }) },
    { name: 'a record from another boundary', reason: 'auth_missing', report: () => journalReport({ authenticationResults: `mx.attacker.example; dkim=pass header.d=${DOMAIN}; dmarc=pass` }) },
    { name: 'DMARC pass for a foreign From, DKIM for a foreign domain', reason: 'auth_failed', report: () => journalReport({ from: 'x@attacker.example', authenticationResults: `${AUTHSERV}; spf=pass; dkim=pass header.d=attacker.example; dmarc=pass` }) },
    { name: 'no DKIM or DMARC pass', reason: 'auth_failed', report: () => journalReport({ authenticationResults: `${AUTHSERV}; spf=pass; dkim=none; dmarc=fail` }) },
    { name: 'no attached original', reason: 'no_original', report: () => journalReport().replace('Content-Type: message/rfc822', 'Content-Type: text/plain') },
    { name: 'TNEF original', reason: 'tnef', report: () => journalReport({ tnef: true }) },
    { name: 'two originals', reason: 'ambiguous_original', report: () => journalReport({ twoOriginals: true }) },
    { name: 'empty envelope', reason: 'no_recipients', report: () => journalReport({ envelope: defaultEnvelope().slice(0, 3) }) },
    { name: 'mirror misconfigured (no tenant-checkable auth)', reason: 'not_configured', report: () => journalReport(), env: { INBOUND_AUTHSERV_ID: '' } },
    // A From domain that only starts with the tenant domain is not the tenant domain.
    { name: 'a From domain with the tenant domain as a prefix', reason: 'auth_failed', report: () => journalReport({ from: `x@${DOMAIN}_.evil.example`, authenticationResults: `${AUTHSERV}; spf=pass; dkim=none; dmarc=pass` }) },
    { name: 'a From on a subdomain of the tenant domain', reason: 'auth_failed', report: () => journalReport({ from: `x@${DOMAIN}.evil.example`, authenticationResults: `${AUTHSERV}; spf=pass; dkim=none; dmarc=pass` }) },
    { name: 'DMARC pass the boundary says was for another domain', reason: 'auth_failed', report: () => journalReport({ authenticationResults: `${AUTHSERV}; spf=pass; dkim=none; dmarc=pass header.from=evil.example` }) },
    { name: 'a DKIM domain with the tenant domain as a prefix', reason: 'auth_failed', report: () => journalReport({ from: 'x@evil.example', authenticationResults: `${AUTHSERV}; dkim=pass header.d=${DOMAIN}.evil.example; dmarc=pass` }) },
    { name: 'an envelope Message-Id for another message', reason: 'message_id_mismatch', report: () => journalReport({ envelope: ['Sender: alice@example.test', 'Subject: Quarterly plan', 'Message-Id: <other@example.test>', 'To: bob@example.test'] }) },
    { name: 'an original without a Message-ID', reason: 'message_id_mismatch', report: () => journalReport({ inner: innerMessage({ messageId: null }) }) },
    { name: 'a report larger than the inbound limit', reason: 'too_large', report: () => journalReport({ inner: innerMessage({ body: 'x'.repeat(1_100_000) }) }), env: { MAX_INBOUND_BYTES: '1000' } },
  ];

  for (const item of forged) {
    it(`refuses ${item.name}, files nothing and audits it`, async () => {
      const t = setup({ env: item.env });
      const { message, error } = await t.deliver(item.report(), { from: 'someone@attacker.example' });
      expect(error).toBeNull();
      expect(message.setReject).toHaveBeenCalledWith(JOURNAL_REJECT_RESPONSE);
      expect(t.messages()).toEqual([]);
      expect(t.days()[0]).toMatchObject({ received: 1, rejected: 1, filed: 0, last_problem: item.reason });
      expect(t.audits()).toEqual([{ event_type: 'exchange_mirror.report_rejected', detail: `Journal report refused: ${item.reason}; envelope sender domain attacker.example` }]);
      // A refused report's subject and From are never trusted into the trace.
      expect(t.traces()).toEqual([expect.objectContaining({ status: 'rejected', subject: null })]);
      t.assertNothingSent();
    });
  }

  it('refuses an envelope where the subject could have added lines', async () => {
    const injected: string[][] = [
      // A decoded line break in the subject followed by a fake Message-Id and recipient.
      ['Sender: alice@example.test', 'Subject: Hi', 'Message-Id: <x@y.example>', 'To: dave@example.test', 'Message-Id: <plan-1@example.test>', 'To: bob@example.test'],
      // A fake recipient line before the real Message-Id.
      ['Sender: alice@example.test', 'Subject: Hi', 'To: dave@example.test', 'Message-Id: <plan-1@example.test>', 'To: bob@example.test'],
    ];
    for (const envelope of injected) {
      const t = setup();
      const { message } = await t.deliver(journalReport({ envelope }));
      expect(message.setReject).toHaveBeenCalledWith(JOURNAL_REJECT_RESPONSE);
      expect(t.messages()).toEqual([]);
      expect(t.days()[0]).toMatchObject({ last_problem: 'unsafe_envelope' });
    }
  });

  it('accepts DKIM signed by a listed tenant domain when the From domain is not listed', async () => {
    const t = setup({ env: { M365_JOURNAL_SENDER_DOMAINS: `tenant.onmicrosoft.example, ${DOMAIN}` } });
    const { message } = await t.deliver(journalReport({
      from: 'MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@tenant.onmicrosoft.example',
      authenticationResults: `${AUTHSERV}; spf=none; dkim=pass header.d=tenant.onmicrosoft.example header.s=selector1; dmarc=none`,
    }));
    expect(message.setReject).not.toHaveBeenCalled();
    expect(t.messages().filter((row) => row.direction === 'inbound')).toHaveLength(1);
  });

  it('with M365_JOURNAL_REQUIRE_AUTH "false", still needs the journal header and this tenant id on the report', async () => {
    const t = setup({ env: { M365_JOURNAL_REQUIRE_AUTH: 'false', INBOUND_AUTHSERV_ID: '' } });
    expect((await t.deliver(journalReport({ authenticationResults: null }))).message.setReject).not.toHaveBeenCalled();
    expect((await t.deliver(journalReport({ authenticationResults: null, tenantHeader: OTHER_TENANT }))).message.setReject).toHaveBeenCalled();
    expect((await t.deliver(journalReport({ authenticationResults: null, tenantHeader: null }))).message.setReject).toHaveBeenCalled();
    expect((await t.deliver(journalReport({ authenticationResults: null, journalHeader: false }))).message.setReject).toHaveBeenCalled();
    // Not allowed at all without M365_TENANT_ID.
    const untied = setup({ env: { M365_JOURNAL_REQUIRE_AUTH: 'false', INBOUND_AUTHSERV_ID: '', M365_TENANT_ID: '' } });
    expect((await untied.deliver(journalReport({ authenticationResults: null }))).message.setReject).toHaveBeenCalledWith(JOURNAL_REJECT_RESPONSE);
    expect(untied.days()[0]).toMatchObject({ last_problem: 'not_configured' });
  });
});

describe('Exchange mirror: size is checked before anything is read', () => {
  it('refuses a report over the inbound limit (plus envelope room) without reading or parsing it, and audits it', async () => {
    const t = setup({ env: { MAX_INBOUND_BYTES: '1000' } });
    const { message } = await t.deliver(journalReport(), { rawSize: 1000 + 1024 * 1024 + 1 });
    expect(message.setReject).toHaveBeenCalledWith(JOURNAL_REJECT_RESPONSE);
    expect(t.rawReads()).toBe(0);
    expect(t.audits()).toEqual([expect.objectContaining({ event_type: 'exchange_mirror.report_rejected', detail: expect.stringContaining('too_large') })]);
  });

  it('refuses rejected-report trace rows beyond the daily cap, keeping the count', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO exchange_mirror_days (day, received, rejected) VALUES (?, 200, 200)`).run(new Date().toISOString().slice(0, 10));
    await t.deliver(journalReport({ journalHeader: false }));
    expect(t.traces()).toEqual([]);
    expect(t.days()[0]).toMatchObject({ rejected: 201 });
  });
});

describe('Exchange mirror: hourly inbound guard', () => {
  it('mirrored copies never use up the normal inbound allowance (guards on)', async () => {
    const t = setup({ env: { INBOUND_MAILBOX_MESSAGES_PER_HOUR: '1', MAILBOX_STORAGE_QUOTA_BYTES: String(1024 * 1024 * 1024) } });
    for (const id of ['m1', 'm2', 'm3']) {
      await t.deliver(journalReport({
        inner: innerMessage({ messageId: `<${id}@example.test>` }),
        envelope: ['Sender: alice@example.test', 'Subject: Quarterly plan', `Message-Id: <${id}@example.test>`, 'To: bob@example.test'],
      }));
    }
    expect(t.messages().filter((row) => row.mailbox_id === 'mbx-bob')).toHaveLength(3);
    const kinds = t.sqlite.prepare(`SELECT DISTINCT reservation_type FROM mailbox_reservations`).all();
    expect(kinds).toEqual([{ reservation_type: 'storage' }]);
    // The normal path still has its allowance of one, and enforces it.
    const first = await t.deliver(innerMessage({ from: 'pat@partner.example', messageId: '<n1@partner.example>' }), { to: `bob@${DOMAIN}`, from: 'pat@partner.example' });
    expect(first.message.setReject).not.toHaveBeenCalled();
    const second = await t.deliver(innerMessage({ from: 'pat@partner.example', messageId: '<n2@partner.example>' }), { to: `bob@${DOMAIN}`, from: 'pat@partner.example' });
    expect(second.message.setReject).toHaveBeenCalled();
    expect(t.messages().filter((row) => row.mailbox_id === 'mbx-bob')).toHaveLength(4);
  });
});

describe('Exchange mirror: content limits (accepted, nothing filed)', () => {
  it('skips an original over MAX_INBOUND_BYTES', async () => {
    const t = setup({ env: { MAX_INBOUND_BYTES: '600' } });
    const { message } = await t.deliver(journalReport({ inner: innerMessage({ body: 'x'.repeat(2_000) }) }));
    expect(message.setReject).not.toHaveBeenCalled();
    expect(t.messages()).toEqual([]);
    expect(t.days()[0]).toMatchObject({ received: 1, skipped: 1, rejected: 0, last_problem: 'too_large' });
    expect(t.audits()).toEqual([expect.objectContaining({ event_type: 'exchange_mirror.copies_skipped' })]);
    t.assertNothingSent();
  });

  it('skips an original with a blocked attachment type', async () => {
    const t = setup();
    await t.deliver(journalReport({ inner: innerMessage({ attachment: { filename: 'invoice.exe', type: 'application/octet-stream', base64: 'TVqQAAMAAAAEAAAA' } }) }));
    expect(t.messages()).toEqual([]);
    expect(t.days()[0]).toMatchObject({ skipped: 1, last_problem: 'blocked_attachment' });
  });

  it('stores attachments for each copy separately, so deleting one copy never affects another', async () => {
    const t = setup();
    await t.deliver(journalReport({
      inner: innerMessage({ attachment: { filename: 'plan.pdf', type: 'application/pdf', base64: 'JVBERi0xLjQK' } }),
      envelope: [...defaultEnvelope().slice(0, 3), 'To: bob@example.test', 'To: carol@example.test'],
    }));
    const keys = t.sqlite.prepare('SELECT r2_key FROM attachments').all() as Array<{ r2_key: string }>;
    expect(keys).toHaveLength(3);
    expect(new Set(keys.map((row) => row.r2_key)).size).toBe(3);
  });

  it('enforces the mailbox storage quota on mirrored copies', async () => {
    const t = setup({ env: { MAILBOX_STORAGE_QUOTA_BYTES: '10' } });
    const { message } = await t.deliver(journalReport());
    expect(message.setReject).not.toHaveBeenCalled();
    expect(t.messages()).toEqual([]);
    expect(t.days()[0]).toMatchObject({ skipped: 2, last_problem: 'quota' });
  });

  it('files only what fits the subrequest budget and counts the rest', async () => {
    const t = setup({ env: { M365_JOURNAL_SUBREQUEST_BUDGET: '100' } });
    const many = Array.from({ length: 40 }, (_, index) => `To: user${index}@example.test`);
    for (let index = 0; index < 40; index += 1) {
      t.sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES (?, ?, 'shared', 'active')`).run(`mbx-u${index}`, `user${index}@${DOMAIN}`);
    }
    await t.deliver(journalReport({ envelope: [...defaultEnvelope().slice(0, 3), ...many] }));
    const day = t.days()[0] as Row;
    expect(Number(day.filed) + Number(day.sent_filed)).toBeGreaterThan(0);
    expect(Number(day.filed) + Number(day.sent_filed) + Number(day.skipped)).toBe(41);
    expect(day.last_problem).toBe('budget');
  });
});

describe('Exchange mirror: off means unchanged', () => {
  it('with the switch off, the journal address is refused like any unknown address and nothing is read or written', async () => {
    const t = setup({ enabled: false });
    const { message } = await t.deliver(journalReport());
    expect(message.setReject).toHaveBeenCalledWith(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    expect(t.messages()).toEqual([]);
    expect(t.days()).toEqual([]);
    expect(t.audits()).toEqual([]);
    expect(t.traces()).toEqual([]);
  });

  it('a near-miss address (wrong token) never reaches the mirror', async () => {
    const t = setup();
    const { message } = await t.deliver(journalReport(), { to: JOURNAL.replace('0123', '9999') });
    expect(message.setReject).toHaveBeenCalledWith(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    expect(t.days()).toEqual([]);
  });

  it('the normal delivery path runs exactly the same SQL, binds and R2 writes with or without the mirror configured and on', async () => {
    // Random ids (UUIDs) differ between any two runs; everything else must match.
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const stable = (value: unknown) => (typeof value === 'string' ? value.replace(UUID, '<uuid>') : value);
    const run = async (env: Record<string, unknown> | undefined, enabled: boolean) => {
      const t = setup({ enabled, env });
      const seen: Array<{ sql: string; binds: unknown[] }> = [];
      const prepare = t.d1.prepare.bind(t.d1);
      (t.d1 as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        const entry = { sql: sql.replace(/\s+/g, ' ').trim(), binds: [] as unknown[] };
        seen.push(entry);
        const statement = prepare(sql) as unknown as { bind: (...values: unknown[]) => unknown };
        const bind = statement.bind.bind(statement);
        statement.bind = (...values: unknown[]) => {
          entry.binds = values.map(stable);
          return bind(...values);
        };
        return statement;
      };
      const { error, message } = await t.deliver(innerMessage({ from: 'pat@partner.example', messageId: '<n@partner.example>' }), { to: `bob@${DOMAIN}`, from: 'pat@partner.example' });
      expect(error).toBeNull();
      expect(message.setReject).not.toHaveBeenCalled();
      const writes = t.storage.put.mock.calls.map(([key, value]) => [stable(key), value]);
      return { seen, writes };
    };
    const plain = await run({ M365_JOURNAL_ADDRESS: '', M365_TENANT_ID: '' }, false);
    const configuredOn = await run(undefined, true);
    expect(configuredOn.seen).toEqual(plain.seen);
    expect(configuredOn.writes).toEqual(plain.writes);
    expect(plain.writes.length).toBeGreaterThan(0);
    expect(plain.seen.some((entry) => /org_settings|exchange_mirror|mailbox_aliases/.test(entry.sql))).toBe(false);
  });
});
