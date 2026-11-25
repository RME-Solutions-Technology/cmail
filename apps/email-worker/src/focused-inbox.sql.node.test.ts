import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import { migratedDatabase } from './testing/sqlite-d1';
import { GUARDS_OFF } from './testing/delivery';
import { AUTHSERV, JOURNAL, NDR, NDR_DOMAIN, TENANT, innerMessage, journalReport } from './exchange-mirror/fixtures';

// Focused Inbox at delivery (docs/focused-inbox.md), against every real
// migration (node:sqlite), driving the real inbound handler. Invented
// example.test / example.org addresses only.

const DOMAIN = 'example.test';
type Row = Record<string, unknown>;

function setup(options: { on?: boolean; env?: Record<string, unknown> } = {}) {
  const { d1, sqlite } = migratedDatabase();
  for (const id of ['alice', 'bob']) {
    sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES (?, ?, 'standard', 'active')`).run(id, `${id}@${DOMAIN}`);
    sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status, owner_user_id) VALUES (?, ?, 'personal', 'active', ?)`).run(`mbx-${id}`, `${id}@${DOMAIN}`, id);
  }
  sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-desk', ?, 'shared', 'active')`).run(`desk@${DOMAIN}`);
  const setSwitch = (key: string, on: boolean) => sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, on ? 'true' : 'false');
  if (options.on ?? true) setSwitch('focused_inbox_enabled', true);

  const storage = { put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
  const env: Record<string, unknown> = { DB: d1, STORAGE: storage, MAIL_DOMAIN: DOMAIN, INBOUND_AUTHSERV_ID: AUTHSERV, ...GUARDS_OFF, ...options.env };
  const seen: string[] = [];
  const prepare = d1.prepare.bind(d1);
  (d1 as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    seen.push(sql.replace(/\s+/g, ' ').trim());
    return prepare(sql);
  };

  let n = 0;
  /** dmarc: the verdict the trusted boundary records for the From (omitted = no record). */
  async function deliver(input: { from?: string; to?: string; headers?: string[]; contentType?: string; subject?: string; dmarc?: 'pass' | 'fail' } = {}) {
    n += 1;
    const from = input.from ?? 'pat@partner.example.org';
    const to = input.to ?? `alice@${DOMAIN}`;
    const messageId = `<m${n}@partner.example.org>`;
    const raw = [
      ...(input.dmarc ? [`Authentication-Results: ${AUTHSERV}; dmarc=${input.dmarc} header.from=${from.slice(from.lastIndexOf('@') + 1)}`] : []),
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${input.subject ?? `Message ${n}`}`,
      `Message-ID: ${messageId}`,
      'Date: Mon, 16 Nov 2026 09:00:00 +1100',
      ...(input.headers ?? []),
      'MIME-Version: 1.0',
      `Content-Type: ${input.contentType ?? 'text/plain; charset=utf-8'}`,
      '',
      'Hello.',
      '',
    ].join('\r\n');
    const message = {
      from,
      to,
      rawSize: raw.length,
      headers: new Headers({ 'message-id': messageId }),
      get raw() { return new Blob([raw]).stream(); },
      setReject: vi.fn(),
      forward: vi.fn(),
      reply: vi.fn(),
    };
    await (worker as unknown as { email(m: unknown, e: unknown, c: unknown): Promise<void> })
      .email(message, env, { waitUntil: vi.fn() });
    expect(message.setReject).not.toHaveBeenCalled();
    return sqlite.prepare('SELECT folder, focus_class, focus_reason FROM messages WHERE message_id_header = ?').get(messageId) as Row;
  }
  const sent = (mailboxId: string, to: string[], cc: string[] = []) => sqlite.prepare(
    `INSERT INTO messages (id, mailbox_id, direction, from_address, to_addresses, cc_addresses, folder, received_at)
     VALUES (?, ?, 'outbound', 'alice@example.test', ?, ?, 'sent', datetime('now', '-1 day'))`,
  ).run(`sent-${Math.random()}`, mailboxId, JSON.stringify(to), JSON.stringify(cc));
  const override = (mailboxId: string, kind: 'address' | 'domain', pattern: string, focusClass: 'focused' | 'other') => sqlite.prepare(
    'INSERT INTO focus_sender_overrides (mailbox_id, kind, pattern, focus_class) VALUES (?, ?, ?, ?)',
  ).run(mailboxId, kind, pattern, focusClass);
  return { sqlite, env, deliver, sent, override, setSwitch, seen };
}

describe('Focused Inbox at delivery: switched off', () => {
  it('stores nothing and runs no classification write when the organisation switch is off', async () => {
    const t = setup({ on: false });
    const row = await t.deliver({ headers: ['List-Unsubscribe: <mailto:leave@partner.example.org>'] });
    expect(row).toEqual({ folder: 'inbox', focus_class: null, focus_reason: null });
    // The single settings lookup is the only Focused Inbox statement; no write.
    expect(t.seen.filter((sql) => /focus_/.test(sql))).toEqual([expect.stringMatching(/^WITH cfg AS/)]);
  });

  it('stores nothing for a mailbox whose own setting is off, while others are sorted', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO focus_mailbox_settings (mailbox_id, enabled) VALUES ('mbx-desk', 0)`).run();
    expect(await t.deliver({ to: `desk@${DOMAIN}`, from: 'noreply@shop.example.org' })).toMatchObject({ focus_class: null });
    expect(await t.deliver({ to: `alice@${DOMAIN}`, from: 'noreply@shop.example.org' })).toMatchObject({ focus_class: 'other', focus_reason: 'automated_sender' });
  });

  it('a shared mailbox is sorted like any other when on', async () => {
    const t = setup();
    expect(await t.deliver({ to: `desk@${DOMAIN}`, headers: ['Precedence: bulk'] })).toMatchObject({ focus_class: 'other', focus_reason: 'bulk_precedence' });
  });
});

describe('Focused Inbox at delivery: each signal', () => {
  it('defaults to Focused', async () => {
    expect(await setup().deliver()).toEqual({ folder: 'inbox', focus_class: 'focused', focus_reason: 'default' });
  });

  it('Auto-Submitted, List-Id, List-Unsubscribe and Precedence go to Other', async () => {
    const t = setup();
    expect(await t.deliver({ headers: ['Auto-Submitted: auto-replied'] })).toMatchObject({ focus_class: 'other', focus_reason: 'auto_submitted' });
    expect(await t.deliver({ headers: ['Auto-Submitted: no'] })).toMatchObject({ focus_class: 'focused', focus_reason: 'default' });
    expect(await t.deliver({ headers: ['List-Id: Parish news <news.partner.example.org>'] })).toMatchObject({ focus_class: 'other', focus_reason: 'mailing_list' });
    expect(await t.deliver({ headers: ['List-Unsubscribe: <https://partner.example.org/leave>'] })).toMatchObject({ focus_class: 'other', focus_reason: 'mailing_list' });
    expect(await t.deliver({ headers: ['Precedence: list'] })).toMatchObject({ focus_class: 'other', focus_reason: 'bulk_precedence' });
  });

  it('a delivery report stays in Focused', async () => {
    const t = setup();
    expect(await t.deliver({
      from: 'mailer-daemon@partner.example.org',
      headers: ['Auto-Submitted: auto-replied'],
      contentType: 'multipart/report; report-type=delivery-status; boundary="R"',
    })).toMatchObject({ focus_class: 'focused', focus_reason: 'delivery_report' });
  });

  it('someone this mailbox has written to (To, Cc) stays in Focused, even with an automated-looking address or list headers', async () => {
    const t = setup();
    t.sent('mbx-alice', ['noreply@partner.example.org']);
    t.sent('mbx-alice', [], ['Kim@Partner.Example.org']);
    expect(await t.deliver({ from: 'noreply@partner.example.org', dmarc: 'pass' })).toMatchObject({ focus_class: 'focused', focus_reason: 'correspondent' });
    expect(await t.deliver({ from: 'kim@partner.example.org', dmarc: 'pass', headers: ['List-Id: <club.partner.example.org>'] })).toMatchObject({ focus_class: 'focused', focus_reason: 'correspondent' });
    // Another mailbox's Sent mail does not count.
    expect(await t.deliver({ to: `bob@${DOMAIN}`, from: 'noreply@partner.example.org', dmarc: 'pass' })).toMatchObject({ focus_class: 'other', focus_reason: 'automated_sender' });
  });

  it('a forged From (no DMARC pass) is never a correspondent', async () => {
    const t = setup();
    t.sent('mbx-alice', ['kim@partner.example.org']);
    expect(await t.deliver({ from: 'kim@partner.example.org', headers: ['List-Unsubscribe: <mailto:x@partner.example.org>'] })).toMatchObject({ focus_class: 'other', focus_reason: 'mailing_list' });
    expect(await t.deliver({ from: 'kim@partner.example.org', dmarc: 'fail', headers: ['Precedence: bulk'] })).toMatchObject({ focus_class: 'other', focus_reason: 'bulk_precedence' });
  });

  it('a sender on MAIL_DOMAIN is internal only with a DMARC pass', async () => {
    const t = setup();
    expect(await t.deliver({ from: `notifications@${DOMAIN}`, dmarc: 'pass' })).toMatchObject({ focus_class: 'focused', focus_reason: 'internal' });
    // A forged colleague address gets no "in your organisation" reason.
    expect(await t.deliver({ from: `notifications@${DOMAIN}` })).toMatchObject({ focus_class: 'other', focus_reason: 'automated_sender' });
    expect(await t.deliver({ from: `ceo@${DOMAIN}`, dmarc: 'fail' })).toMatchObject({ focus_class: 'focused', focus_reason: 'default' });
  });

  it('a shared mailbox never uses the frequent-sender signal (its replies go from personal mailboxes)', async () => {
    const t = setup();
    for (let i = 0; i < 21; i += 1) await t.deliver({ to: `desk@${DOMAIN}`, from: 'updates@shop.example.org' });
    expect(await t.deliver({ to: `desk@${DOMAIN}`, from: 'updates@shop.example.org' })).toMatchObject({ focus_class: 'focused', focus_reason: 'default' });
  });

  it('a frequent sender never written to goes to Other at the threshold', async () => {
    const t = setup();
    for (let i = 0; i < 19; i += 1) await t.deliver({ from: 'updates@shop.example.org' });
    // 19 earlier in the Inbox: not yet.
    expect(await t.deliver({ from: 'updates@shop.example.org' })).toMatchObject({ focus_class: 'focused', focus_reason: 'default' });
    expect(await t.deliver({ from: 'updates@shop.example.org' })).toMatchObject({ focus_class: 'other', focus_reason: 'frequent_sender' });
  });

  it('per-mailbox entries: address beats domain, a parent domain covers subdomains, never across mailboxes', async () => {
    const t = setup();
    t.override('mbx-alice', 'domain', 'partner.example.org', 'other');
    t.override('mbx-alice', 'address', 'pat@partner.example.org', 'focused');
    expect(await t.deliver({ from: 'pat@partner.example.org', headers: ['List-Id: <x.partner.example.org>'] })).toMatchObject({ focus_class: 'focused', focus_reason: 'sender_override' });
    expect(await t.deliver({ from: 'lee@mail.partner.example.org' })).toMatchObject({ focus_class: 'other', focus_reason: 'domain_override' });
    expect(await t.deliver({ to: `bob@${DOMAIN}`, from: 'lee@mail.partner.example.org' })).toMatchObject({ focus_class: 'focused', focus_reason: 'default' });
  });
});

describe('Focused Inbox at delivery: rules and spam come first', () => {
  it('a message an inbox rule files away is not sorted', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO inbox_rules (id, mailbox_id, name, position, definition) VALUES ('r1', 'mbx-alice', 'Shop', 0, ?)`).run(JSON.stringify({
      version: 1, appliesToAll: false, conditions: { from: ['shop.example.org'] }, exceptions: {}, actions: { moveTo: 'archive' },
    }));
    expect(await t.deliver({ from: 'noreply@shop.example.org' })).toEqual({ folder: 'archive', focus_class: null, focus_reason: null });
  });

  it('a message filed to Spam by a sender rule is not sorted', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO sender_rules (id, pattern, action) VALUES ('s1', 'spam.example.org', 'block')`).run();
    expect(await t.deliver({ from: 'x@spam.example.org' })).toEqual({ folder: 'spam', focus_class: null, focus_reason: null });
  });

  it('a failed lookup never fails the delivery', async () => {
    const t = setup();
    t.sqlite.exec('DROP TABLE focus_sender_overrides');
    expect(await t.deliver({ headers: ['Precedence: bulk'] })).toEqual({ folder: 'inbox', focus_class: null, focus_reason: null });
  });
});

describe('Focused Inbox: Exchange mirror filing', () => {
  function mirror(on: boolean) {
    const t = setup({
      on,
      env: { INBOUND_AUTHSERV_ID: AUTHSERV, M365_JOURNAL_ADDRESS: JOURNAL, M365_TENANT_ID: TENANT, M365_JOURNAL_NDR_DOMAIN: NDR_DOMAIN, M365_JOURNAL_MIRROR_SENT: 'true' },
    });
    t.setSwitch('exchange_mirror_enabled', true);
    return t;
  }
  async function file(t: ReturnType<typeof setup>, inner: string) {
    const raw = journalReport({ inner, envelope: ['Sender: alice@example.test', 'Subject: Quarterly plan', 'Message-Id: <plan-1@example.test>', 'To: bob@example.test'] });
    const message = {
      from: NDR, to: JOURNAL, rawSize: raw.length, headers: new Headers(),
      get raw() { return new Blob([raw]).stream(); }, setReject: vi.fn(), forward: vi.fn(), reply: vi.fn(),
    };
    await (worker as unknown as { email(m: unknown, e: unknown, c: unknown): Promise<void> }).email(message, t.env, { waitUntil: vi.fn() });
    expect(message.setReject).not.toHaveBeenCalled();
    return t.sqlite.prepare('SELECT mailbox_id, direction, folder, focus_class, focus_reason FROM messages ORDER BY mailbox_id').all() as Row[];
  }

  it('sorts the Inbox copy with the original\'s headers, never the Sent copy', async () => {
    const rows = await file(mirror(true), innerMessage({ headers: { 'List-Unsubscribe': '<mailto:leave@example.test>' } }));
    expect(rows).toEqual([
      { mailbox_id: 'mbx-alice', direction: 'outbound', folder: 'sent', focus_class: null, focus_reason: null },
      { mailbox_id: 'mbx-bob', direction: 'inbound', folder: 'inbox', focus_class: 'other', focus_reason: 'mailing_list' },
    ]);
  });

  it('a colleague is internal only when Exchange says it was an authenticated submission of this tenant', async () => {
    const internal = await file(mirror(true), innerMessage());
    expect(internal.find((row) => row.mailbox_id === 'mbx-bob')).toMatchObject({ focus_class: 'focused', focus_reason: 'internal' });
    // The same From from the internet (no AuthAs Internal / tenant id): no Sent copy, not internal.
    const forged = await file(mirror(true), innerMessage({ from: 'noreply@example.test', internal: false }));
    expect(forged).toEqual([{ mailbox_id: 'mbx-bob', direction: 'inbound', folder: 'inbox', focus_class: 'other', focus_reason: 'automated_sender' }]);
  });

  it('stores nothing with the Focused Inbox switch off', async () => {
    const rows = await file(mirror(false), innerMessage());
    expect(rows.every((row) => row.focus_class === null && row.focus_reason === null)).toBe(true);
    expect(rows.length).toBe(2);
  });
});
