import { describe, expect, it } from 'vitest';
import { load as listLoad } from '../../routes/mail/+page.server';
import { actions as settingsActions, load as settingsLoad } from '../../routes/mail/settings/+page.server';
import { actions as adminActions } from '../../routes/admin/settings/+page.server';
import { POST as focusPost } from '../../routes/api/messages/focus/+server';
import { APP_URL, createFixture, seedMessage, type Fixture } from './mcp/testing/harness';
import {
  BACKFILL_LEASE_MS,
  focusViewCondition,
  loadFocusScope,
  moveMessagesFocus,
  runFocusBackfill,
  saveFocusOverride,
  setFocusedInboxOrgEnabled,
} from './focused-inbox';

// Focused Inbox in the web app (docs/focused-inbox.md), against every real
// migration. Fixture: Alice owns mb-alice and has Full access to the shared
// mb-desk; Bob owns mb-bob and can only read mb-desk. Invented addresses only.

type Row = Record<string, unknown>;

function on(fixture: Fixture, value = 'true') {
  fixture.db.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('focused_inbox_enabled', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
}

function locals(fixture: Fixture, userId: string) {
  return { user: fixture.db.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId), sessionId: 'session-1' };
}

function setClass(fixture: Fixture, id: string, focusClass: string | null, reason: string | null = focusClass ? 'default' : null) {
  fixture.db.sqlite.prepare('UPDATE messages SET focus_class = ?, focus_reason = ? WHERE id = ?').run(focusClass, reason, id);
}

function row(fixture: Fixture, id: string): Row {
  return fixture.db.sqlite.prepare('SELECT folder, focus_class, focus_reason FROM messages WHERE id = ?').get(id) as Row;
}

/** Records every SQL statement the code prepares. */
function recordSql(fixture: Fixture): string[] {
  const seen: string[] = [];
  const d1 = fixture.db.d1 as unknown as { prepare: (sql: string) => unknown };
  const prepare = d1.prepare.bind(d1);
  d1.prepare = (sql: string) => {
    seen.push(sql.replace(/\s+/g, ' ').trim());
    return prepare(sql);
  };
  return seen;
}

async function list(fixture: Fixture, userId: string, query = '') {
  return (listLoad as any)({
    locals: locals(fixture, userId),
    platform: fixture.platform,
    url: new URL(`${APP_URL}/mail${query}`),
  });
}

/** Alice's inbox: a person, a newsletter (other), never sorted, and the desk. */
function seedInbox(fixture: Fixture) {
  seedMessage(fixture, { id: 'm-person', mailboxId: 'mb-alice', from: 'pat@partner.example.org', subject: 'Lunch', receivedAt: '2026-11-10 09:00:00' });
  seedMessage(fixture, { id: 'm-news', mailboxId: 'mb-alice', from: 'news@shop.example.org', subject: 'Sale', receivedAt: '2026-11-10 08:00:00' });
  seedMessage(fixture, { id: 'm-old', mailboxId: 'mb-alice', from: 'kim@partner.example.org', subject: 'Old', receivedAt: '2026-11-01 08:00:00', isRead: 1 });
  seedMessage(fixture, { id: 'm-desk-news', mailboxId: 'mb-desk', from: 'news@shop.example.org', subject: 'Desk sale', receivedAt: '2026-11-10 07:00:00' });
  seedMessage(fixture, { id: 'm-archived', mailboxId: 'mb-alice', folder: 'archive', from: 'news@shop.example.org', subject: 'Archived sale', receivedAt: '2026-11-09 08:00:00' });
  setClass(fixture, 'm-person', 'focused', 'correspondent');
  setClass(fixture, 'm-news', 'other', 'mailing_list');
  setClass(fixture, 'm-desk-news', 'other', 'automated_sender');
  setClass(fixture, 'm-archived', 'other', 'mailing_list');
}

const ids = (result: { messages: Array<{ id: string }> }) => result.messages.map((message) => message.id);

describe('switched off: the Inbox is exactly as before', () => {
  it('returns every Inbox message, no tabs, and runs no Focused Inbox query but the switch read', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    const seen = recordSql(fixture);
    const result = await list(fixture, 'user-alice');
    expect(result.focus).toBeNull();
    expect(ids(result)).toEqual(['m-person', 'm-news', 'm-desk-news', 'm-old']);
    const focusSql = seen.filter((sql) => /focus|org_settings/.test(sql));
    expect(focusSql).toEqual(['SELECT value FROM org_settings WHERE key = ?']);
    // The list query itself is the same text as with no feature at all.
    expect(seen.find((sql) => sql.startsWith('SELECT m.*'))).not.toMatch(/focus/);
    expect(fixture.waitUntil).toEqual([]);
  });

  it('ignores ?view=other while off', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    const result = await list(fixture, 'user-alice', '?view=other');
    expect(result.focus).toBeNull();
    expect(ids(result)).toEqual(['m-person', 'm-news', 'm-desk-news', 'm-old']);
  });

  it('treats any value but "true" as off, and a missing table as off', async () => {
    const fixture = createFixture();
    on(fixture, 'yes');
    expect(await loadFocusScope(fixture.db.d1, 'user-alice')).toBeNull();
    on(fixture);
    fixture.db.sqlite.exec('DROP TABLE focus_mailbox_settings');
    expect(await loadFocusScope(fixture.db.d1, 'user-alice')).toBeNull();
  });
});

describe('switched on: Focused and Other views', () => {
  it('splits the Inbox: Other is exactly the "other" rows, Focused is everything else, never-sorted included', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    on(fixture);
    const focused = await list(fixture, 'user-alice');
    expect(focused.focus).toEqual({ view: 'focused', mailboxIds: ['mb-alice', 'mb-desk'], unread: { focused: 1, other: 2 } });
    expect(ids(focused)).toEqual(['m-person', 'm-old']);
    const other = await list(fixture, 'user-alice', '?view=other');
    expect(other.focus.view).toBe('other');
    expect(ids(other)).toEqual(['m-news', 'm-desk-news']);
    // Together they are the whole Inbox: nothing is hidden.
    expect([...ids(focused), ...ids(other)].sort()).toEqual(['m-desk-news', 'm-news', 'm-old', 'm-person']);
  });

  it('a mailbox with its own setting off shows all its mail under Focused', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    on(fixture);
    fixture.db.sqlite.prepare(`INSERT INTO focus_mailbox_settings (mailbox_id, enabled, backfill_status) VALUES ('mb-desk', 0, 'done')`).run();
    expect(ids(await list(fixture, 'user-alice', '?view=other'))).toEqual(['m-news']);
    expect(ids(await list(fixture, 'user-alice'))).toEqual(['m-person', 'm-desk-news', 'm-old']);
    const desk = await list(fixture, 'user-alice', '?mailbox=mb-desk&view=other');
    expect(desk.focus).toBeNull();
    expect(ids(desk)).toEqual(['m-desk-news']);
  });

  it('search and other folders are never filtered', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    on(fixture);
    const search = await list(fixture, 'user-alice', '?q=sale&view=other');
    expect(search.focus).toBeNull();
    expect(ids(search)).toEqual(['m-news', 'm-desk-news']);
    const searchFocused = await list(fixture, 'user-alice', '?q=sale');
    expect(ids(searchFocused)).toEqual(['m-news', 'm-desk-news']);
    const archive = await list(fixture, 'user-alice', '?folder=archive&view=other');
    expect(archive.focus).toBeNull();
    expect(ids(archive)).toEqual(['m-archived']);
  });

  it('scopes to one mailbox, and read-only delegates see the shared mailbox\'s tabs too', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    on(fixture);
    const alice = await list(fixture, 'user-alice', '?mailbox=mb-alice&view=other');
    expect(ids(alice)).toEqual(['m-news']);
    expect(alice.focus.unread).toEqual({ focused: 1, other: 1 });
    const bob = await list(fixture, 'user-bob', '?view=other');
    expect(ids(bob)).toEqual(['m-desk-news']);
  });

  it('queues the one-off sort for never-sorted mailboxes after the response, at most two', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    on(fixture);
    await list(fixture, 'user-alice');
    expect(fixture.waitUntil).toHaveLength(1);
    await Promise.all(fixture.waitUntil);
    const states = fixture.db.sqlite.prepare('SELECT mailbox_id, backfill_status FROM focus_mailbox_settings ORDER BY mailbox_id').all();
    expect(states).toEqual([
      { mailbox_id: 'mb-alice', backfill_status: 'done' },
      { mailbox_id: 'mb-desk', backfill_status: 'done' },
    ]);
    // m-old was never sorted; kim is not automated: Focused by default.
    expect(row(fixture, 'm-old')).toEqual({ folder: 'inbox', focus_class: 'focused', focus_reason: 'default' });
    // Next load: nothing left to queue.
    await list(fixture, 'user-alice');
    expect(fixture.waitUntil).toHaveLength(1);
  });

  it('the view condition is NULL-safe', () => {
    expect(focusViewCondition('focused')).toContain('IS NOT \'other\'');
    expect(focusViewCondition('other')).toContain('= \'other\'');
  });
});

describe('moving and learning', () => {
  it('moves selected Inbox messages and marks them as moved', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    on(fixture);
    const result = await moveMessagesFocus(fixture.db.d1, 'user-alice', ['m-news'], 'focused', false);
    expect(result).toEqual({ ok: true, moved: 1, learned: 0 });
    expect(row(fixture, 'm-news')).toEqual({ folder: 'inbox', focus_class: 'focused', focus_reason: 'moved' });
    expect(fixture.db.sqlite.prepare('SELECT COUNT(*) AS n FROM focus_sender_overrides').get()).toEqual({ n: 0 });
  });

  it('"always" saves a per-mailbox sender entry and moves that sender\'s other Inbox mail in that mailbox only', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    on(fixture);
    seedMessage(fixture, { id: 'm-news-2', mailboxId: 'mb-alice', from: 'News@Shop.Example.org', subject: 'Sale 2' });
    setClass(fixture, 'm-news-2', 'other', 'mailing_list');
    const result = await moveMessagesFocus(fixture.db.d1, 'user-alice', ['m-news'], 'focused', true);
    expect(result).toEqual({ ok: true, moved: 1, learned: 1 });
    expect(fixture.db.sqlite.prepare('SELECT mailbox_id, kind, pattern, focus_class, created_by FROM focus_sender_overrides').all()).toEqual([
      { mailbox_id: 'mb-alice', kind: 'address', pattern: 'news@shop.example.org', focus_class: 'focused', created_by: 'user-alice' },
    ]);
    expect(row(fixture, 'm-news-2')).toEqual({ folder: 'inbox', focus_class: 'focused', focus_reason: 'sender_override' });
    // Never across mailboxes: the desk copy and the archived one stay.
    expect(row(fixture, 'm-desk-news').focus_class).toBe('other');
    expect(row(fixture, 'm-archived').focus_class).toBe('other');
    // Changing its mind updates the same entry.
    await moveMessagesFocus(fixture.db.d1, 'user-alice', ['m-news'], 'other', true);
    expect(fixture.db.sqlite.prepare('SELECT focus_class FROM focus_sender_overrides').all()).toEqual([{ focus_class: 'other' }]);
  });

  it('refuses without Full access, outside the Inbox, and when the mailbox is not sorted', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    on(fixture);
    expect(await moveMessagesFocus(fixture.db.d1, 'user-bob', ['m-desk-news'], 'focused', true)).toMatchObject({ ok: false, status: 403 });
    expect(await moveMessagesFocus(fixture.db.d1, 'user-bob', ['m-news'], 'focused', false)).toMatchObject({ ok: false, status: 404 });
    expect(await moveMessagesFocus(fixture.db.d1, 'user-alice', ['m-archived'], 'focused', false)).toMatchObject({ ok: false, status: 400 });
    fixture.db.sqlite.prepare(`INSERT INTO focus_mailbox_settings (mailbox_id, enabled) VALUES ('mb-desk', 0)`).run();
    expect(await moveMessagesFocus(fixture.db.d1, 'user-alice', ['m-desk-news'], 'focused', false)).toMatchObject({ ok: false, status: 409 });
    on(fixture, 'false');
    expect(await moveMessagesFocus(fixture.db.d1, 'user-alice', ['m-news'], 'focused', false)).toMatchObject({ ok: false, status: 409 });
    expect(fixture.db.sqlite.prepare('SELECT COUNT(*) AS n FROM focus_sender_overrides').get()).toEqual({ n: 0 });
  });

  it('stops adding entries at the per-mailbox limit but still moves the message', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    on(fixture);
    const insert = fixture.db.sqlite.prepare(`INSERT INTO focus_sender_overrides (mailbox_id, kind, pattern, focus_class) VALUES ('mb-alice', 'domain', ?, 'other')`);
    for (let i = 0; i < 1000; i += 1) insert.run(`d${i}.example.org`);
    expect(() => insert.run('one-more.example.org')).toThrow(/focus override limit/);
    expect(await saveFocusOverride(fixture.db.d1, 'mb-alice', { kind: 'domain', pattern: 'new.example.org', focusClass: 'other' }, 'user-alice')).toBe('limit');
    // An existing entry can still be changed at the limit.
    expect(await saveFocusOverride(fixture.db.d1, 'mb-alice', { kind: 'domain', pattern: 'd1.example.org', focusClass: 'focused' }, 'user-alice')).toBe('saved');
    expect(await moveMessagesFocus(fixture.db.d1, 'user-alice', ['m-news'], 'focused', true)).toEqual({ ok: true, moved: 1, learned: 0 });
  });
});

describe('POST /api/messages/focus', () => {
  async function call(fixture: Fixture, userId: string, body: unknown, contentType = 'application/json') {
    try {
      const response = await (focusPost as any)({
        locals: locals(fixture, userId),
        platform: fixture.platform,
        request: new Request(`${APP_URL}/api/messages/focus`, { method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    } catch (caught) {
      return { status: (caught as { status: number }).status, body: (caught as { body: unknown }).body };
    }
  }

  it('validates input and writes a content-free audit entry', async () => {
    const fixture = createFixture();
    seedInbox(fixture);
    on(fixture);
    expect((await call(fixture, 'user-alice', { ids: ['m-news'], to: 'Other' })).status).toBe(400);
    expect((await call(fixture, 'user-alice', { ids: [], to: 'other' })).status).toBe(400);
    expect((await call(fixture, 'user-alice', { ids: ['m-news'], to: 'other', always: 'yes' })).status).toBe(400);
    expect((await call(fixture, 'user-alice', { ids: Array.from({ length: 101 }, (_, i) => `x${i}`), to: 'other' })).status).toBe(400);
    expect((await call(fixture, 'user-alice', { ids: ['m-news'], to: 'other' }, 'text/plain')).status).toBe(415);
    const ok = await call(fixture, 'user-alice', { ids: ['m-person'], to: 'other', always: true });
    expect(ok).toEqual({ status: 200, body: { ok: true, moved: 1, learned: 1 } });
    const audits = fixture.db.sqlite.prepare(`SELECT event_type, detail FROM audit_log WHERE event_type LIKE 'focus.%'`).all() as Row[];
    expect(audits).toEqual([{ event_type: 'focus.messages_moved', detail: 'Moved 1 message to Other; always move 1 sender' }]);
    expect(JSON.stringify(audits)).not.toMatch(/@/);
  });
});

describe('the one-off sort of recent mail', () => {
  function many(fixture: Fixture, count: number) {
    for (let i = 0; i < count; i += 1) {
      seedMessage(fixture, { id: `b${String(i).padStart(3, '0')}`, mailboxId: 'mb-alice', from: i % 2 ? 'noreply@shop.example.org' : 'pat@partner.example.org', receivedAt: `2026-11-01 00:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}` });
    }
  }

  it('sorts only the newest N never-sorted Inbox messages, with the delivery classifier', async () => {
    const fixture = createFixture();
    on(fixture);
    many(fixture, 8);
    seedMessage(fixture, { id: 'pre', mailboxId: 'mb-alice', from: 'noreply@shop.example.org', receivedAt: '2026-11-02 00:00:00' });
    setClass(fixture, 'pre', 'focused', 'moved');
    const result = await runFocusBackfill(fixture.db.d1, 'mb-alice', { mailDomain: 'example.test', limit: 5, now: 1_000 });
    expect(result).toEqual({ status: 'done', sorted: 5 });
    const sorted = fixture.db.sqlite.prepare(`SELECT id, focus_class, focus_reason FROM messages WHERE id LIKE 'b%' AND focus_class IS NOT NULL ORDER BY id`).all();
    // The five newest (b003..b007); odd ones are noreply@.
    expect(sorted).toEqual([
      { id: 'b003', focus_class: 'other', focus_reason: 'automated_sender' },
      { id: 'b004', focus_class: 'focused', focus_reason: 'default' },
      { id: 'b005', focus_class: 'other', focus_reason: 'automated_sender' },
      { id: 'b006', focus_class: 'focused', focus_reason: 'default' },
      { id: 'b007', focus_class: 'other', focus_reason: 'automated_sender' },
    ]);
    // A message already sorted (here, moved by its owner) is never touched.
    expect(row(fixture, 'pre')).toMatchObject({ focus_class: 'focused', focus_reason: 'moved' });
    expect(fixture.db.sqlite.prepare(`SELECT backfill_status, backfill_count FROM focus_mailbox_settings WHERE mailbox_id = 'mb-alice'`).get())
      .toEqual({ backfill_status: 'done', backfill_count: 5 });
    // Done is done: a second call changes nothing.
    expect(await runFocusBackfill(fixture.db.d1, 'mb-alice', { limit: 5 })).toEqual({ status: 'skipped', reason: 'done' });
  });

  it('caps the run at 1,000 messages whatever is asked', async () => {
    const fixture = createFixture();
    on(fixture);
    const insert = fixture.db.sqlite.prepare(`INSERT INTO messages (id, mailbox_id, direction, from_address, folder, received_at) VALUES (?, 'mb-alice', 'inbound', 'pat@partner.example.org', 'inbox', datetime('now', ?))`);
    for (let i = 0; i < 1005; i += 1) insert.run(`c${i}`, `-${i} minutes`);
    expect(await runFocusBackfill(fixture.db.d1, 'mb-alice', { limit: 50_000 })).toEqual({ status: 'done', sorted: 1000 });
    expect(fixture.db.sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE focus_class IS NULL').get()).toEqual({ n: 5 });
  });

  it('uses the mailbox\'s entries; correspondents and internal only for mail between Stanchion mailboxes (stored mail has no DMARC result)', async () => {
    const fixture = createFixture();
    on(fixture);
    seedMessage(fixture, { id: 'e1', mailboxId: 'mb-alice', from: 'noreply@written.example.org' });
    seedMessage(fixture, { id: 'e2', mailboxId: 'mb-alice', from: 'kim@lists.example.org' });
    seedMessage(fixture, { id: 'e3', mailboxId: 'mb-alice', from: 'noreply@example.test' });
    seedMessage(fixture, { id: 'e5', mailboxId: 'mb-alice', from: 'bob@example.test' });
    fixture.db.sqlite.prepare(`UPDATE messages SET direction = 'internal' WHERE id = 'e5'`).run();
    fixture.db.sqlite.prepare(`INSERT INTO messages (id, mailbox_id, direction, from_address, to_addresses, folder) VALUES ('s2', 'mb-alice', 'outbound', 'alice@example.test', '["bob@example.test"]', 'sent')`).run();
    seedMessage(fixture, { id: 'e4', mailboxId: 'mb-alice', from: 'lee@mail.shop.example.org' });
    fixture.db.sqlite.prepare(`INSERT INTO messages (id, mailbox_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, folder) VALUES ('s1', 'mb-alice', 'outbound', 'alice@example.test', '["x@example.org"]', '["NoReply@Written.example.org"]', '[]', 'sent')`).run();
    await saveFocusOverride(fixture.db.d1, 'mb-alice', { kind: 'address', pattern: 'kim@lists.example.org', focusClass: 'other' }, 'user-alice');
    await saveFocusOverride(fixture.db.d1, 'mb-alice', { kind: 'domain', pattern: 'shop.example.org', focusClass: 'other' }, 'user-alice');
    expect(await runFocusBackfill(fixture.db.d1, 'mb-alice', { mailDomain: 'example.test' })).toEqual({ status: 'done', sorted: 5 });
    // Written to, but received from outside: the From is unproven, so no "correspondent".
    expect(row(fixture, 'e1')).toMatchObject({ focus_class: 'other', focus_reason: 'automated_sender' });
    expect(row(fixture, 'e2')).toMatchObject({ focus_class: 'other', focus_reason: 'sender_override' });
    // A MAIL_DOMAIN address received from outside is not "in your organisation".
    expect(row(fixture, 'e3')).toMatchObject({ focus_class: 'other', focus_reason: 'automated_sender' });
    // Mail from another Stanchion mailbox is authenticated.
    expect(row(fixture, 'e5')).toMatchObject({ focus_class: 'focused', focus_reason: 'correspondent' });
    expect(row(fixture, 'e4')).toMatchObject({ focus_class: 'other', focus_reason: 'domain_override' });
  });

  it('one run at a time: a live lease blocks, an expired one is taken over', async () => {
    const fixture = createFixture();
    on(fixture);
    many(fixture, 2);
    fixture.db.sqlite.prepare(`INSERT INTO focus_mailbox_settings (mailbox_id, backfill_status, backfill_lease_until) VALUES ('mb-alice', 'running', ?)`).run(10_000 + BACKFILL_LEASE_MS);
    expect(await runFocusBackfill(fixture.db.d1, 'mb-alice', { now: 10_000 })).toEqual({ status: 'skipped', reason: 'busy' });
    expect(await runFocusBackfill(fixture.db.d1, 'mb-alice', { now: 20_000 + BACKFILL_LEASE_MS })).toEqual({ status: 'done', sorted: 2 });
  });

  it('a run that died with its lease is queued again; a late run cannot close the run that took over', async () => {
    const fixture = createFixture();
    on(fixture);
    many(fixture, 2);
    fixture.db.sqlite.prepare(`INSERT INTO focus_mailbox_settings (mailbox_id, backfill_status, backfill_lease_until) VALUES ('mb-alice', 'running', 1), ('mb-desk', 'running', ?)`).run(Date.now() + BACKFILL_LEASE_MS);
    expect((await loadFocusScope(fixture.db.d1, 'user-alice'))?.needsBackfill).toEqual(['mb-alice']);
    // The newer claim holds the lease: an older run's closing update matches nothing.
    fixture.db.sqlite.prepare(`UPDATE focus_mailbox_settings SET backfill_lease_until = 999 WHERE mailbox_id = 'mb-alice'`).run();
    await fixture.db.d1.prepare(`UPDATE focus_mailbox_settings SET backfill_status = 'done' WHERE mailbox_id = ? AND backfill_status = 'running' AND backfill_lease_until = ?`).bind('mb-alice', 1).run();
    expect(fixture.db.sqlite.prepare(`SELECT backfill_status FROM focus_mailbox_settings WHERE mailbox_id = 'mb-alice'`).get()).toEqual({ backfill_status: 'running' });
  });

  it('turning the organisation switch on again queues the sort for mail that arrived while it was off', async () => {
    const fixture = createFixture();
    on(fixture);
    fixture.db.sqlite.prepare(`INSERT INTO focus_mailbox_settings (mailbox_id, backfill_status) VALUES ('mb-alice', 'done'), ('mb-desk', 'failed')`).run();
    await setFocusedInboxOrgEnabled(fixture.db.d1, false, 'user-alice');
    expect(fixture.db.sqlite.prepare(`SELECT backfill_status FROM focus_mailbox_settings ORDER BY mailbox_id`).all()).toEqual([{ backfill_status: 'done' }, { backfill_status: 'failed' }]);
    await setFocusedInboxOrgEnabled(fixture.db.d1, true, 'user-alice');
    expect(fixture.db.sqlite.prepare(`SELECT backfill_status FROM focus_mailbox_settings ORDER BY mailbox_id`).all()).toEqual([{ backfill_status: 'none' }, { backfill_status: 'none' }]);
  });

  it('does nothing while off, and records a failure without touching mail', async () => {
    const fixture = createFixture();
    many(fixture, 2);
    expect(await runFocusBackfill(fixture.db.d1, 'mb-alice')).toEqual({ status: 'skipped', reason: 'off' });
    on(fixture);
    fixture.db.sqlite.exec('DROP TABLE focus_sender_overrides');
    expect(await runFocusBackfill(fixture.db.d1, 'mb-alice')).toEqual({ status: 'failed' });
    expect(fixture.db.sqlite.prepare(`SELECT backfill_status FROM focus_mailbox_settings`).get()).toEqual({ backfill_status: 'failed' });
    expect(fixture.db.sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE focus_class IS NOT NULL').get()).toEqual({ n: 0 });
  });
});

describe('switches', () => {
  async function action(fixture: Fixture, userId: string, fn: unknown, path: string, fields: Record<string, string>) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return (fn as (event: unknown) => Promise<any>)({
      request: new Request(`${APP_URL}${path}`, { method: 'POST', body: form }),
      locals: locals(fixture, userId),
      platform: fixture.platform,
      url: new URL(`${APP_URL}${path}`),
    });
  }

  it('only a manager can turn the organisation switch on or off, and it is audited', async () => {
    const fixture = createFixture();
    const refused = await action(fixture, 'user-alice', adminActions.focusedInbox, '/admin/settings?/focusedInbox', { focused_inbox_enabled: 'true' });
    expect(refused.status).toBe(403);
    fixture.db.sqlite.prepare(`UPDATE users SET role = 'manager' WHERE id = 'user-alice'`).run();
    expect((await action(fixture, 'user-alice', adminActions.focusedInbox, '/admin/settings?/focusedInbox', { focused_inbox_enabled: 'maybe' })).status).toBe(400);
    await action(fixture, 'user-alice', adminActions.focusedInbox, '/admin/settings?/focusedInbox', { focused_inbox_enabled: 'true' });
    expect(fixture.db.sqlite.prepare(`SELECT value FROM org_settings WHERE key = 'focused_inbox_enabled'`).get()).toEqual({ value: 'true' });
    expect(fixture.db.sqlite.prepare(`SELECT detail FROM audit_log WHERE event_type = 'org.focused_inbox_toggled'`).all()).toEqual([{ detail: 'Focused Inbox turned on' }]);
  });

  it('Mail settings shows the section only while the organisation switch is on, for Full-access mailboxes', async () => {
    const fixture = createFixture();
    const off = await (settingsLoad as any)({ locals: locals(fixture, 'user-bob'), platform: fixture.platform });
    expect(off.focusedInbox).toBeNull();
    on(fixture);
    const bob = await (settingsLoad as any)({ locals: locals(fixture, 'user-bob'), platform: fixture.platform });
    expect(bob.focusedInbox.mailboxes.map((mailbox: { id: string }) => mailbox.id)).toEqual(['mb-bob']);
    const alice = await (settingsLoad as any)({ locals: locals(fixture, 'user-alice'), platform: fixture.platform });
    expect(alice.focusedInbox.mailboxes.map((mailbox: { id: string; enabled: boolean }) => [mailbox.id, mailbox.enabled])).toEqual([['mb-alice', true], ['mb-desk', true]]);
  });

  it('a person turns a mailbox off and on; turning on queues the sort; no access, no change', async () => {
    const fixture = createFixture();
    on(fixture);
    seedMessage(fixture, { id: 'n1', mailboxId: 'mb-desk', from: 'noreply@shop.example.org' });
    const denied = await action(fixture, 'user-bob', settingsActions.focusToggle, '/mail/settings?/focusToggle', { mailbox_id: 'mb-desk', enabled: 'false' });
    expect(denied.status).toBe(403);
    await action(fixture, 'user-alice', settingsActions.focusToggle, '/mail/settings?/focusToggle', { mailbox_id: 'mb-desk', enabled: 'false' });
    expect(await loadFocusScope(fixture.db.d1, 'user-bob')).toEqual({ mailboxIds: ['mb-bob'], needsBackfill: ['mb-bob'] });
    expect(fixture.waitUntil).toHaveLength(0);
    await action(fixture, 'user-alice', settingsActions.focusToggle, '/mail/settings?/focusToggle', { mailbox_id: 'mb-desk', enabled: 'true' });
    expect(fixture.waitUntil).toHaveLength(1);
    await Promise.all(fixture.waitUntil);
    expect(row(fixture, 'n1')).toMatchObject({ focus_class: 'other', focus_reason: 'automated_sender' });
    on(fixture, 'false');
    expect((await action(fixture, 'user-alice', settingsActions.focusToggle, '/mail/settings?/focusToggle', { mailbox_id: 'mb-desk', enabled: 'true' })).status).toBe(409);
  });

  it('adds and removes sender and domain entries, validating them', async () => {
    const fixture = createFixture();
    on(fixture);
    const add = (pattern: string, focusClass = 'other') => action(fixture, 'user-alice', settingsActions.focusAddEntry, '/mail/settings?/focusAddEntry', { mailbox_id: 'mb-alice', pattern, focus_class: focusClass });
    expect((await add('not a domain')).status).toBe(400);
    expect((await add('example.org', 'inbox')).status).toBe(400);
    expect(await add('@News.Example.org')).toMatchObject({ focusSuccess: expect.stringContaining('news.example.org') });
    expect(await add('Pat@Partner.Example.org', 'focused')).toMatchObject({ focusSuccess: expect.stringContaining('Focused') });
    expect(fixture.db.sqlite.prepare('SELECT kind, pattern, focus_class FROM focus_sender_overrides ORDER BY kind').all()).toEqual([
      { kind: 'address', pattern: 'pat@partner.example.org', focus_class: 'focused' },
      { kind: 'domain', pattern: 'news.example.org', focus_class: 'other' },
    ]);
    await action(fixture, 'user-alice', settingsActions.focusRemoveEntry, '/mail/settings?/focusRemoveEntry', { mailbox_id: 'mb-alice', kind: 'domain', pattern: 'news.example.org' });
    expect(fixture.db.sqlite.prepare('SELECT COUNT(*) AS n FROM focus_sender_overrides').get()).toEqual({ n: 1 });
    const bob = await action(fixture, 'user-bob', settingsActions.focusAddEntry, '/mail/settings?/focusAddEntry', { mailbox_id: 'mb-alice', pattern: 'x.example.org', focus_class: 'other' });
    expect(bob.status).toBe(403);
  });
});
