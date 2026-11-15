import { describe, expect, it, vi } from 'vitest';
import worker, { RECIPIENT_UNAVAILABLE_SMTP_RESPONSE } from '../index';
import { migratedDatabase } from '../testing/sqlite-d1';
import { GUARDS_OFF } from '../testing/delivery';
import { STANDBY_PROBE_HEADER } from '@cmail/shared/standby';
import { STANDBY_PROBE_CRON, pruneStandby, runStandbyProbeNow, runStandbyProbeTick, type StandbyDeps } from './standby';

// The standby address and probe against every real migration (node:sqlite),
// driving the real inbound handler. Cloudflare Email Sending is a mock that
// records each send; the test then "delivers" what was sent, as Email Routing
// would. Fixtures use example.test addresses only.

const DOMAIN = 'example.test';
const STANDBY = 'standby.example.test';
const PROBE = 'cmail-standby-probe';
const T0 = Date.parse('2026-11-15T00:00:00Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

interface SentMessage {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
}

function setup(options: { enabled?: boolean; env?: Record<string, unknown>; send?: (message: SentMessage) => Promise<unknown> } = {}) {
  const { d1, sqlite } = migratedDatabase();
  const insertUser = (id: string, email: string, status: string) => {
    sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES (?, ?, 'standard', ?)`).run(id, email, status);
    sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status, owner_user_id) VALUES (?, ?, 'personal', 'active', ?)`).run(`mbx-${id}`, email, id);
  };
  insertUser('alice', `alice@${DOMAIN}`, 'active');
  insertUser('penny', `penny@${DOMAIN}`, 'pending');
  insertUser('paul', `paul@${DOMAIN}`, 'paused');
  insertUser('olive', `olive@${DOMAIN}`, 'offboarded');
  sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-team', ?, 'shared', 'active')`).run(`team@${DOMAIN}`);
  sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-old', ?, 'shared', 'disabled')`).run(`old@${DOMAIN}`);
  const setSwitch = (on: boolean) => sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('standby_enabled', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(on ? 'true' : 'false');
  if (options.enabled ?? true) setSwitch(true);

  const sent: SentMessage[] = [];
  const send = vi.fn(async (message: SentMessage) => {
    sent.push(message);
    if (options.send) return options.send(message);
    return { messageId: `<sent-${sent.length}@cf.example.test>` };
  });
  const r2 = new Map<string, unknown>();
  const deleted: string[] = [];
  const storage = {
    put: vi.fn(async (key: string, value: unknown) => { r2.set(key, value); }),
    delete: vi.fn(async (key: string) => { deleted.push(key); r2.delete(key); }),
  };
  const env: Record<string, unknown> = {
    DB: d1,
    STORAGE: storage,
    EMAIL: { send },
    MAIL_DOMAIN: DOMAIN,
    INBOUND_AUTHSERV_ID: 'mx.example.test',
    ...GUARDS_OFF,
    ...options.env,
  };
  let clock = T0;
  let ids = 0;
  let tokens = 0;
  const deps: StandbyDeps = {
    now: () => clock,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    newToken: () => `tok${String(++tokens).padStart(40, '0')}`,
  };
  const realNow = Date.now;
  // The inbound handler reads the clock through Date.now for the receipt.
  vi.spyOn(Date, 'now').mockImplementation(() => clock);

  async function deliver(input: { to: string; from?: string; subject?: string; headers?: Record<string, string>; messageId?: string }) {
    const messageId = input.messageId ?? `<m-${Math.random().toString(36).slice(2)}@sender.example.test>`;
    const extra = Object.entries(input.headers ?? {}).map(([key, value]) => `${key}: ${value}\r\n`).join('');
    const raw = `Authentication-Results: mx.example.test; spf=pass smtp.mailfrom=${DOMAIN}; dkim=pass header.d=${DOMAIN}; dmarc=pass header.from=${DOMAIN}\r\n`
      + `From: ${input.from ?? `sender@partner.example`}\r\nTo: ${input.to}\r\nSubject: ${input.subject ?? 'Hello'}\r\n`
      + `Message-ID: ${messageId}\r\n${extra}Content-Type: text/plain\r\n\r\nBody\r\n`;
    const headers = new Headers({ 'message-id': messageId, subject: input.subject ?? 'Hello', ...input.headers });
    const message = {
      from: input.from ?? 'sender@partner.example',
      to: input.to,
      rawSize: raw.length,
      headers,
      raw: new Blob([raw]).stream(),
      setReject: vi.fn(),
      forward: vi.fn(),
      reply: vi.fn(),
    };
    const error = await (worker as unknown as { email: (m: unknown, e: unknown, c: unknown) => Promise<void> })
      .email(message, env, { waitUntil: () => undefined })
      .then(() => null, (caught: unknown) => caught);
    return { error, rejected: message.setReject.mock.calls[0]?.[0] as string | undefined };
  }

  /** Deliver what the mock Email Sending sent, as Email Routing would. */
  const deliverSent = (index = sent.length - 1, messageId?: string) => {
    const message = sent[index]!;
    return deliver({ to: message.to, from: message.from.email, subject: message.subject, headers: message.headers, messageId: messageId ?? `<probe-${index}@cf.example.test>` });
  };

  const messagesIn = (mailboxId: string) => (sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ?').get(mailboxId) as { n: number }).n;
  const runs = () => sqlite.prepare('SELECT * FROM standby_probe_runs ORDER BY started_at, id').all() as Array<Record<string, unknown>>;
  const probeMailbox = () => sqlite.prepare('SELECT id, address, type, status, owner_user_id FROM mailboxes WHERE address = ?').get(`${PROBE}@${DOMAIN}`) as ({ id: string } & Record<string, unknown>) | undefined;
  const tick = () => runStandbyProbeTick(env as never, deps);
  const runNow = () => runStandbyProbeNow(env as never, deps);
  const advance = (ms: number) => { clock += ms; };
  const restore = () => { (Date.now as unknown as { mockRestore?: () => void }).mockRestore?.(); void realNow; };
  return { d1, sqlite, env, send, sent, storage, r2, deleted, deliver, deliverSent, messagesIn, runs, probeMailbox, tick, runNow, advance, setSwitch, restore, deps };
}

describe('standby address: delivery', () => {
  it('delivers name@standby.<domain> into the same mailbox as the primary address', async () => {
    const t = setup();
    const result = await t.deliver({ to: `alice@${STANDBY}` });
    expect(result).toEqual({ error: null, rejected: undefined });
    expect(t.messagesIn('mbx-alice')).toBe(1);
    // Mail trace keeps the address it was really sent to.
    expect(t.sqlite.prepare(`SELECT envelope_to FROM mail_trace WHERE direction = 'inbound'`).get()).toEqual({ envelope_to: `alice@${STANDBY}` });
    t.restore();
  });

  it('works for shared mailboxes and accounts still pending first sign-in', async () => {
    const t = setup();
    expect((await t.deliver({ to: `team@${STANDBY}` })).rejected).toBeUndefined();
    expect((await t.deliver({ to: `penny@${STANDBY}` })).rejected).toBeUndefined();
    expect(t.messagesIn('mbx-team')).toBe(1);
    expect(t.messagesIn('mbx-penny')).toBe(1);
    t.restore();
  });

  it('is not a catch-all: an unknown local part gets the neutral refusal and stores nothing', async () => {
    const t = setup();
    const result = await t.deliver({ to: `nobody@${STANDBY}` });
    expect(result.rejected).toBe(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM mail_trace').get()).toEqual({ n: 0 });
    t.restore();
  });

  it('answers exactly as the primary address does, so it reveals no account status', async () => {
    const t = setup();
    for (const local of ['paul', 'olive', 'old', 'alice']) {
      const primary = await t.deliver({ to: `${local}@${DOMAIN}` });
      const standby = await t.deliver({ to: `${local}@${STANDBY}` });
      expect(standby.rejected).toBe(primary.rejected);
    }
    // Disabled mailboxes are refused on both; paused and offboarded owners'
    // active mailboxes keep receiving on both, as the primary always has.
    expect((await t.deliver({ to: `old@${STANDBY}` })).rejected).toBe(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    expect(t.messagesIn('mbx-paul')).toBe(2);
    t.restore();
  });

  it('delivers to a legacy personal mailbox with no recorded owner, as the primary does', async () => {
    const t = setup();
    t.sqlite.exec('DROP TRIGGER trg_mailboxes_owner_insert');
    t.sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status, owner_user_id) VALUES ('mbx-legacy', ?, 'personal', 'active', NULL)`).run(`legacy@${DOMAIN}`);
    expect((await t.deliver({ to: `legacy@${STANDBY}` })).rejected).toBeUndefined();
    expect(t.messagesIn('mbx-legacy')).toBe(1);
    t.restore();
  });

  it('maps plus, quoted and Unicode local parts literally, so they reach no other mailbox', async () => {
    const t = setup();
    for (const to of [`alice+tag@${STANDBY}`, `"alice"@${STANDBY}`, `\u00e1lice@${STANDBY}`, `ALICE @${STANDBY}`]) {
      expect((await t.deliver({ to })).rejected).toBeDefined();
    }
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    t.restore();
  });

  it('matches only <label>.<MAIL_DOMAIN> exactly: no deeper subdomains or look-alikes', async () => {
    const t = setup();
    for (const to of [`alice@x.${STANDBY}`, `alice@standby.example.test.evil.example`, `alice@standby2.${DOMAIN}`, `alice@${STANDBY}.`]) {
      expect((await t.deliver({ to })).rejected).toBeDefined();
    }
    expect(t.messagesIn('mbx-alice')).toBe(0);
    t.restore();
  });

  it('refuses everything on the standby domain while the switch is off (the default); the primary still works', async () => {
    const t = setup({ enabled: false });
    expect((await t.deliver({ to: `alice@${STANDBY}` })).rejected).toBe(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    expect((await t.deliver({ to: `alice@${DOMAIN}` })).rejected).toBeUndefined();
    expect(t.messagesIn('mbx-alice')).toBe(1);
    t.restore();
  });

  it('is inactive without MAIL_DOMAIN, and follows a custom label', async () => {
    const off = setup({ env: { MAIL_DOMAIN: '' } });
    expect((await off.deliver({ to: `alice@${STANDBY}` })).rejected).toBe(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    off.restore();
    const custom = setup({ env: { STANDBY_SUBDOMAIN_LABEL: 'dr' } });
    expect((await custom.deliver({ to: `alice@${STANDBY}` })).rejected).toBe(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    expect((await custom.deliver({ to: `alice@dr.${DOMAIN}` })).rejected).toBeUndefined();
    custom.restore();
  });

  it('applies the same spam rules as the primary address (a blocked sender goes to Spam)', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO sender_rules (id, pattern, action) VALUES ('rule-1', 'partner.example', 'block')`).run();
    await t.deliver({ to: `alice@${STANDBY}` });
    expect(t.sqlite.prepare(`SELECT folder FROM messages WHERE mailbox_id = 'mbx-alice'`).get()).toEqual({ folder: 'spam' });
    t.restore();
  });

  it('dedupes the same message sent to both addresses', async () => {
    const t = setup();
    await t.deliver({ to: `alice@${DOMAIN}`, messageId: '<same@partner.example>' });
    await t.deliver({ to: `alice@${STANDBY}`, messageId: '<same@partner.example>' });
    expect(t.messagesIn('mbx-alice')).toBe(1);
    t.restore();
  });
});

describe('standby probe', () => {
  it('does nothing at all while the switch is off', async () => {
    const t = setup({ enabled: false });
    expect(await t.tick()).toEqual({ status: 'off' });
    expect(await t.runNow()).toEqual({ status: 'off' });
    expect(t.send).not.toHaveBeenCalled();
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM standby_probe_state').get()).toEqual({ n: 0 });
    expect(t.probeMailbox()).toBeUndefined();
    t.restore();
  });

  it('reports "not configured" by setting name and sends nothing', async () => {
    const t = setup({ env: { MAIL_DOMAIN: '' } });
    expect(await t.tick()).toMatchObject({ status: 'not_configured', problems: ['MAIL_DOMAIN is not set on the email Worker'] });
    expect(t.send).not.toHaveBeenCalled();
    t.restore();
  });

  it('sends one probe a day to the standby address of a dedicated system mailbox, and records a pass', async () => {
    const t = setup();
    expect(await t.tick()).toMatchObject({ status: 'started' });
    expect(t.probeMailbox()).toMatchObject({ address: `${PROBE}@${DOMAIN}`, type: 'shared', status: 'active', owner_user_id: null });
    expect(t.sqlite.prepare(`SELECT COUNT(*) AS n FROM mailbox_assignments WHERE mailbox_id = ?`).get(t.probeMailbox()!.id)).toEqual({ n: 0 });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ to: `${PROBE}@${STANDBY}`, from: { email: `${PROBE}@${DOMAIN}` } });
    expect(t.sent[0]!.headers[STANDBY_PROBE_HEADER]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.runs()[0]).toMatchObject({ status: 'waiting', in_flight: 1, kind: 'schedule' });
    // The token itself is never stored.
    expect(JSON.stringify(t.runs())).not.toContain(t.sent[0]!.headers[STANDBY_PROBE_HEADER]);

    t.advance(4000);
    expect((await t.deliverSent()).rejected).toBeUndefined();
    expect(t.runs()[0]).toMatchObject({ status: 'pass', in_flight: null, round_trip_ms: 4000, folder: 'inbox', dmarc_result: 'pass', warnings: '' });
    expect(t.messagesIn(t.probeMailbox()!.id as string)).toBe(1);
    // Nothing reached a real person's mailbox.
    expect(t.sqlite.prepare(`SELECT COUNT(*) AS n FROM messages WHERE mailbox_id <> ?`).get(t.probeMailbox()!.id)).toEqual({ n: 0 });

    t.advance(10 * MINUTE);
    expect(await t.tick()).toMatchObject({ status: 'idle' });
    t.advance(DAY);
    expect(await t.tick()).toMatchObject({ status: 'started' });
    expect(t.sent).toHaveLength(2);
    t.restore();
  });

  it('fails with reason "timeout" when nothing arrives in time, and marks a late arrival without storing it', async () => {
    const t = setup();
    await t.tick();
    t.advance(11 * MINUTE);
    expect(await t.tick()).toMatchObject({ status: 'idle', finalized: 1 });
    expect(t.runs()[0]).toMatchObject({ status: 'fail', reason: 'timeout', in_flight: null });
    t.advance(MINUTE);
    expect((await t.deliverSent()).rejected).toBeUndefined();
    expect(t.runs()[0]).toMatchObject({ status: 'fail', reason: 'late', late_ms: 12 * MINUTE });
    expect(t.messagesIn(t.probeMailbox()!.id as string)).toBe(0);
    t.restore();
  });

  it('a duplicate probe never changes the result or stores a second copy', async () => {
    const t = setup();
    await t.tick();
    t.advance(2000);
    await t.deliverSent(0, '<probe@cf.example.test>');
    t.advance(60_000);
    await t.deliverSent(0, '<probe@cf.example.test>');
    await t.deliverSent(0, '<probe-other-id@cf.example.test>');
    expect(t.runs()[0]).toMatchObject({ status: 'pass', round_trip_ms: 2000 });
    expect(t.messagesIn(t.probeMailbox()!.id as string)).toBe(1);
    t.restore();
  });

  it('the probe mailbox refuses anything but a live probe on the standby address', async () => {
    const t = setup();
    await t.tick();
    const token = t.sent[0]!.headers[STANDBY_PROBE_HEADER]!;
    // Right token, but to the primary address.
    expect((await t.deliver({ to: `${PROBE}@${DOMAIN}`, headers: { [STANDBY_PROBE_HEADER]: token } })).rejected).toBe(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    // Standby address, no or unknown token.
    expect((await t.deliver({ to: `${PROBE}@${STANDBY}` })).rejected).toBe(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    expect((await t.deliver({ to: `${PROBE}@${STANDBY}`, headers: { [STANDBY_PROBE_HEADER]: 'x'.repeat(43) } })).rejected).toBe(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    expect(t.messagesIn(t.probeMailbox()!.id as string)).toBe(0);
    expect(t.runs()[0]).toMatchObject({ status: 'waiting' });
    t.restore();
  });

  it('records the exact reason when Email Sending refuses the probe', async () => {
    const t = setup({ send: async () => { throw Object.assign(new Error('nope'), { code: 'E_SENDER_NOT_VERIFIED' }); } });
    expect(await t.tick()).toMatchObject({ status: 'failed', reason: 'send_rejected' });
    expect(t.runs()[0]).toMatchObject({ status: 'fail', reason: 'send_rejected', detail: 'E_SENDER_NOT_VERIFIED', in_flight: null });
    t.restore();
    const network = setup({ send: async () => { throw new Error('socket'); } });
    expect(await network.tick()).toMatchObject({ status: 'failed', reason: 'send_failed' });
    network.restore();
    const unbound = setup({ env: { EMAIL: undefined } });
    expect(await unbound.tick()).toMatchObject({ status: 'failed', reason: 'no_send_binding' });
    unbound.restore();
  });

  it('never adopts a real mailbox that already has the probe address, and leaves its mail alone', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-real', ?, 'shared', 'active')`).run(`${PROBE}@${DOMAIN}`);
    expect(await t.tick()).toMatchObject({ status: 'failed', reason: 'probe_address_in_use' });
    expect(t.send).not.toHaveBeenCalled();
    expect((await t.deliver({ to: `${PROBE}@${DOMAIN}` })).rejected).toBeUndefined();
    expect(t.messagesIn('mbx-real')).toBe(1);
    t.restore();
  });

  it('reports a probe mailbox a manager disabled', async () => {
    const t = setup();
    await t.tick();
    t.sqlite.prepare(`UPDATE mailboxes SET status = 'disabled' WHERE address = ?`).run(`${PROBE}@${DOMAIN}`);
    t.advance(DAY);
    expect(await t.tick()).toMatchObject({ status: 'failed', reason: 'probe_mailbox_disabled' });
    t.restore();
  });

  it('Run test now: one at a time, at most once a minute', async () => {
    const t = setup();
    expect(await t.runNow()).toMatchObject({ status: 'started' });
    expect(await t.runNow()).toEqual({ status: 'too_soon' });
    t.advance(2 * MINUTE);
    expect(await t.runNow()).toEqual({ status: 'busy' });
    expect(t.sent).toHaveLength(1);
    await t.deliverSent();
    t.advance(2 * MINUTE);
    expect(await t.runNow()).toMatchObject({ status: 'started' });
    expect(t.runs().map((run) => run.kind)).toEqual(['manual', 'manual']);
    t.restore();
  });

  it('turning the switch off stops tests and refuses a probe still on its way', async () => {
    const t = setup();
    await t.tick();
    t.setSwitch(false);
    expect((await t.deliverSent()).rejected).toBe(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    t.advance(DAY);
    expect(await t.tick()).toEqual({ status: 'off' });
    expect(t.sent).toHaveLength(1);
    t.restore();
  });

  it('fails closed when the probe state cannot be read: the delivery throws (and is retried), nothing is stored', async () => {
    const t = setup();
    await t.tick();
    t.sqlite.exec('DROP TABLE standby_probe_state');
    const result = await t.deliverSent();
    expect(result.error).toBeTruthy();
    expect(result.rejected).toBeUndefined();
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    t.restore();
  });

  it('a daily tick during a manual test waits, then sends the daily probe once that test finishes', async () => {
    const t = setup();
    expect(await t.runNow()).toMatchObject({ status: 'started' });
    t.advance(MINUTE);
    expect(await t.tick()).toEqual({ status: 'busy' });
    await t.deliverSent();
    t.advance(10 * MINUTE);
    expect(await t.tick()).toMatchObject({ status: 'started' });
    expect(t.runs().map((run) => run.kind)).toEqual(['manual', 'schedule']);
    t.restore();
  });

  it('a daily probe that could not be sent does not use up the day: it is retried after 30 minutes', async () => {
    let fail = true;
    const t = setup({ send: async () => { if (fail) throw new Error('socket'); return { messageId: '<ok@cf.example.test>' }; } });
    expect(await t.tick()).toMatchObject({ status: 'failed', reason: 'send_failed' });
    t.advance(10 * MINUTE);
    expect(await t.tick()).toMatchObject({ status: 'idle' });
    fail = false;
    t.advance(25 * MINUTE);
    expect(await t.tick()).toMatchObject({ status: 'started' });
    t.restore();
  });

  it('records a probe that arrives after an ambiguous send failure as late, not as a duplicate', async () => {
    const t = setup({ send: async () => { throw new Error('socket'); } });
    await t.tick();
    t.advance(30_000);
    await t.deliverSent();
    expect(t.runs()[0]).toMatchObject({ status: 'fail', reason: 'late', late_ms: 30_000 });
    expect(String(t.runs()[0]!.detail)).toContain('send reported a failure');
    t.restore();
  });

  it('throws a real database error instead of reporting busy', async () => {
    const t = setup();
    t.sqlite.exec(`CREATE TRIGGER t_fail BEFORE INSERT ON standby_probe_runs BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
    await expect(t.tick()).rejects.toThrow(/disk I\/O error/);
    t.restore();
  });

  it('disables the old probe mailbox when STANDBY_PROBE_LOCAL_PART changes, so it stops taking mail', async () => {
    const t = setup();
    await t.tick();
    await t.deliverSent();
    const oldId = t.probeMailbox()!.id;
    t.env.STANDBY_PROBE_LOCAL_PART = 'probe-two';
    t.advance(DAY);
    expect(await t.tick()).toMatchObject({ status: 'started' });
    expect(t.sqlite.prepare('SELECT status FROM mailboxes WHERE id = ?').get(oldId)).toEqual({ status: 'disabled' });
    expect(t.sent.at(-1)!.to).toBe(`probe-two@${STANDBY}`);
    expect((await t.deliver({ to: `${PROBE}@${DOMAIN}` })).rejected).toBe(RECIPIENT_UNAVAILABLE_SMTP_RESPONSE);
    expect(t.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'org.standby_probe_mailbox_disabled'`).get()).toEqual({ n: 1 });
    t.restore();
  });

  it('never prunes a message outside the probe mailbox, even if a run points at it', async () => {
    const t = setup();
    await t.deliver({ to: `alice@${DOMAIN}` });
    await t.tick();
    await t.deliverSent();
    const aliceMessage = (t.sqlite.prepare(`SELECT id FROM messages WHERE mailbox_id = 'mbx-alice'`).get() as { id: string }).id;
    t.sqlite.prepare('UPDATE standby_probe_runs SET message_id = ?').run(aliceMessage);
    expect(await pruneStandby(t.env as never, T0 + 8 * DAY)).toBe(0);
    expect(t.messagesIn('mbx-alice')).toBe(1);
    // The result row is kept while its (non-probe) message exists.
    await pruneStandby(t.env as never, T0 + 31 * DAY);
    expect(t.messagesIn('mbx-alice')).toBe(1);
    t.restore();
  });

  it('prunes probe messages after 7 days and results after 30, and nothing else', async () => {
    const t = setup();
    await t.deliver({ to: `alice@${DOMAIN}` });
    await t.tick();
    await t.deliverSent();
    const probeBox = t.probeMailbox()!.id as string;
    const bodyKey = (t.sqlite.prepare('SELECT body_r2_key FROM messages WHERE mailbox_id = ?').get(probeBox) as { body_r2_key: string }).body_r2_key;
    // An old message in the probe mailbox that no run recorded is never touched.
    t.sqlite.prepare(`INSERT INTO messages (id, mailbox_id, direction, from_address, subject, received_at, created_at)
      VALUES ('stray', ?, 'inbound', 'x@partner.example', 's', datetime('now', '-60 days'), datetime('now', '-60 days'))`).run(probeBox);

    t.advance(6 * DAY);
    expect(await pruneStandby(t.env as never, T0 + 6 * DAY)).toBe(0);
    t.advance(2 * DAY);
    expect(await pruneStandby(t.env as never, T0 + 8 * DAY)).toBe(1);
    expect(t.deleted).toContain(bodyKey);
    expect(t.sqlite.prepare('SELECT id FROM messages WHERE mailbox_id = ?').all(probeBox)).toEqual([{ id: 'stray' }]);
    expect(t.messagesIn('mbx-alice')).toBe(1);
    expect(t.runs()).toHaveLength(1);

    await pruneStandby(t.env as never, T0 + 31 * DAY);
    expect(t.runs()).toHaveLength(0);
    expect(t.messagesIn('mbx-alice')).toBe(1);
    t.restore();
  });
});

describe('standby wiring in the email Worker', () => {
  const configUrl = 'https://cmail-email-worker.internal/internal/standby/config';
  const runUrl = 'https://cmail-email-worker.internal/internal/standby/run';

  it('reports configuration by setting name, and whether it can send', async () => {
    const bad = await (await worker.fetch(new Request(configUrl), { MAIL_DOMAIN: 'not a domain' } as never)).json();
    expect(bad).toEqual({ configured: false, problems: ['MAIL_DOMAIN is not a valid domain'], canSend: false });
    const good = await (await worker.fetch(new Request(configUrl), { MAIL_DOMAIN: DOMAIN, EMAIL: {} } as never)).json();
    expect(good).toEqual({ configured: true, problems: [], canSend: true, standbyDomain: STANDBY, probeAddress: `${PROBE}@${STANDBY}`, timeoutMinutes: 10 });
  });

  it('is not reachable on a public hostname, and run needs POST', async () => {
    expect((await worker.fetch(new Request('https://mail.example.test/internal/standby/run', { method: 'POST' }), {} as never)).status).toBe(404);
    expect((await worker.fetch(new Request(runUrl), {} as never)).status).toBe(404);
  });

  it('Run test now over the binding starts a probe', async () => {
    const t = setup();
    const response = await worker.fetch(new Request(runUrl, { method: 'POST' }), t.env as never);
    expect(await response.json()).toMatchObject({ status: 'started' });
    expect(t.sent).toHaveLength(1);
    t.restore();
  });

  it('runs on its own cron and, while off, only reads the switch', async () => {
    const first = vi.fn(async () => null);
    const db = { prepare: vi.fn(() => ({ bind: () => ({ first }) })) };
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({ cron: STANDBY_PROBE_CRON } as ScheduledController, { DB: db } as never, { waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as never);
    await Promise.all(waits);
    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(String((db.prepare.mock.calls[0] as unknown[])[0])).toContain('org_settings');
  });
});
