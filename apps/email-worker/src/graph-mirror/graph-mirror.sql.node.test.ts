import { describe, expect, it, vi } from 'vitest';
import worker, { INBOUND_TOOLS, stableInboundId } from '../index';
import { migratedDatabase } from '../testing/sqlite-d1';
import { GUARDS_OFF } from '../testing/delivery';
import { GRAPH_ROOT } from '../m365-sync/graph';
import { AUTHSERV, DOMAIN, JOURNAL, NDR, NDR_DOMAIN, TENANT, innerMessage, journalReport } from '../exchange-mirror/fixtures';
import { runGraphMirrorTick, GRAPH_MIRROR_CRON, type GraphMirrorDeps } from './run';

// The Exchange mirror's Graph source against every real migration
// (node:sqlite), with a fake Microsoft Graph: delta pages, $value MIME,
// throttling, expired tokens and refused mailboxes. Every test also proves
// nothing was sent. Fixture data only: placeholder GUIDs, example.test.

type Row = Record<string, unknown>;
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

const CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const oid = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const ALICE = oid(0xa1);
const BOB = oid(0xb0);
const SUPPORT = oid(0x50);
const NOW = Date.parse('2026-11-16T05:00:00Z');
const HOUR = 3_600_000;

const folderUrl = (object: string, folder: string) => `${GRAPH_ROOT}users/${object}/mailFolders/${folder}/messages/delta`;
const deltaLink = (object: string, folder: string, token: string) => `${folderUrl(object, folder)}?$deltatoken=${token}`;
const nextLink = (object: string, folder: string, token: string) => `${folderUrl(object, folder)}?$skiptoken=${token}`;

function item(id: string, messageId: string | null, receivedMs: number, extra: Record<string, unknown> = {}) {
  return { id, internetMessageId: messageId, receivedDateTime: new Date(receivedMs).toISOString(), isDraft: false, ...extra };
}

function fakeGraph() {
  const calls: string[] = [];
  /** Delta replies: by "<object>/<folder>" for a round's first request, or by the exact next/delta link. Last reply repeats. */
  const routes = new Map<string, Reply[]>();
  const mimes = new Map<string, string>();
  const mimeReplies = new Map<string, Reply[]>();
  let tokenReply: Reply = { status: 200, body: { access_token: 'test-token', expires_in: 3600 } };
  const take = (list: Reply[] | undefined) => (list && list.length > 1 ? list.shift() : list?.[0]);
  const respond = (reply: Reply) => (reply.body === undefined
    ? new Response(null, { status: reply.status, headers: reply.headers })
    : Response.json(reply.body, { status: reply.status, headers: reply.headers }));
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://login.microsoftonline.com/')) return respond(tokenReply);
    const parsed = new URL(url);
    const mime = /^\/v1\.0\/users\/([^/]+)\/messages\/([^/]+)\/\$value$/.exec(parsed.pathname);
    if (mime) {
      const id = decodeURIComponent(mime[2] as string);
      // One-off replies, each answered once, before the stored MIME.
      const scripted = mimeReplies.get(id)?.shift();
      if (scripted) return respond(scripted);
      const raw = mimes.get(id);
      return raw === undefined ? respond({ status: 404, body: { error: { code: 'ErrorItemNotFound' } } }) : new Response(raw, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const delta = /^\/v1\.0\/users\/([^/]+)\/mailFolders\/([^/]+)\/messages\/delta$/.exec(parsed.pathname);
    if (delta) {
      const [, object, folder] = delta as unknown as [string, string, string];
      const key = parsed.searchParams.has('$filter') ? `${object}/${folder}` : url;
      const reply = take(routes.get(key));
      if (reply) return respond(reply);
      // Unscripted: an empty folder, caught up.
      return respond({ status: 200, body: { value: [], '@odata.deltaLink': deltaLink(object, folder, 'empty') } });
    }
    return respond({ status: 404, body: { error: { code: 'NotFound' } } });
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    routes,
    mimes,
    mimeReplies,
    setToken(reply: Reply) { tokenReply = reply; },
    /** A page of messages ending the round (a delta link) or continuing it (a next link). */
    page(object: string, folder: string, items: unknown[], link: { delta?: string; next?: string } = { delta: 'd1' }): Reply {
      return {
        status: 200,
        body: {
          value: items,
          ...(link.next ? { '@odata.nextLink': nextLink(object, folder, link.next) } : { '@odata.deltaLink': deltaLink(object, folder, link.delta ?? 'd1') }),
        },
      };
    },
    mimeCalls: () => calls.filter((call) => call.endsWith('/$value')),
    deltaCalls: () => calls.filter((call) => call.includes('/messages/delta')),
  };
}

function setup(options: { enabled?: boolean; env?: Record<string, unknown> } = {}) {
  const { d1, sqlite } = migratedDatabase();
  for (const [id, object] of [['alice', ALICE], ['bob', BOB]] as const) {
    sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES (?, ?, 'standard', 'active')`).run(id, `${id}@${DOMAIN}`);
    sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status, owner_user_id) VALUES (?, ?, 'personal', 'active', ?)`).run(`mbx-${id}`, `${id}@${DOMAIN}`, id);
    sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, user_id) VALUES (?, 'person', ?)`).run(object, id);
  }
  sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-support', ?, 'shared', 'active')`).run(`support@${DOMAIN}`);
  sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, mailbox_id) VALUES (?, 'shared', 'mbx-support')`).run(SUPPORT);
  const setSetting = (key: string, value: string) => sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  if (options.enabled ?? true) setSetting('graph_mirror_enabled', 'true');
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
    M365_TENANT_ID: TENANT,
    M365_CLIENT_ID: CLIENT_ID,
    M365_CLIENT_SECRET: 'test-secret',
    ...GUARDS_OFF,
    ...options.env,
  };
  const graph = fakeGraph();
  let clock = NOW;
  const tick = (deps: Partial<GraphMirrorDeps> = {}) => runGraphMirrorTick(env as never, INBOUND_TOOLS, {
    fetcher: graph.fetch,
    sleep: async () => undefined,
    now: () => clock,
    force: true,
    ...deps,
  });
  const messages = () => sqlite.prepare(
    `SELECT id, mailbox_id, direction, folder, is_read, from_address, subject, message_id_header, bcc_addresses
     FROM messages ORDER BY mailbox_id, direction, message_id_header`,
  ).all() as Row[];
  const folders = () => sqlite.prepare('SELECT * FROM graph_mirror_folders ORDER BY mailbox_id, folder').all() as Row[];
  const status = () => JSON.parse(String((sqlite.prepare('SELECT state FROM graph_mirror_state WHERE id = 1').get() as Row | undefined)?.state ?? '{}')) as Record<string, any>;
  const assertNothingSent = () => expect(send).not.toHaveBeenCalled();
  return {
    d1, sqlite, env, graph, tick, messages, folders, status, setSetting, r2, assertNothingSent,
    advance(ms: number) { clock += ms; },
    now: () => clock,
  };
}

describe('Graph mirror: switch and settings', () => {
  it('is inert when off: one settings read, no Graph call, no write (directly and from the cron)', async () => {
    const t = setup({ enabled: false });
    expect(await t.tick()).toEqual({ status: 'off' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const waits: Promise<unknown>[] = [];
    await (worker as unknown as { scheduled(c: unknown, e: unknown, x: unknown): Promise<void> })
      .scheduled({ cron: GRAPH_MIRROR_CRON }, t.env, { waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(t.graph.calls).toEqual([]);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM graph_mirror_state').get()).toEqual({ n: 0 });
    expect(t.messages()).toEqual([]);
  });

  it('reports missing settings by name and calls nothing', async () => {
    const t = setup({ env: { M365_CLIENT_SECRET: '', M365_GRAPH_MIRROR_LOOKBACK_HOURS: '9999' } });
    const result = await t.tick();
    expect(result).toMatchObject({ status: 'not_configured' });
    expect(JSON.stringify(result)).not.toContain('test-secret');
    expect((result as { problems: string[] }).problems.join(' ')).toMatch(/M365_CLIENT_SECRET.*M365_GRAPH_MIRROR_LOOKBACK_HOURS/);
    expect(t.graph.calls).toEqual([]);
    expect(t.status()).toMatchObject({ lastError: 'not_configured' });
  });

  it('says not_installed without migration 0033, busy under a lease, and too_soon within the interval', async () => {
    const t = setup();
    t.sqlite.exec('DROP TABLE graph_mirror_folders; DROP TABLE graph_mirror_state;');
    expect(await t.tick()).toEqual({ status: 'not_installed' });

    const u = setup();
    u.sqlite.prepare('INSERT INTO graph_mirror_state (id, lease_until) VALUES (1, ?)').run(NOW + 60_000);
    expect(await u.tick()).toEqual({ status: 'busy' });

    const v = setup();
    expect(await v.tick()).toMatchObject({ status: 'worked' });
    v.advance(30_000);
    expect(await v.tick({ force: false })).toEqual({ status: 'too_soon' });
    v.advance(120_000);
    expect(await v.tick({ force: false })).toMatchObject({ status: 'worked' });
  });
});

describe('Graph mirror: filing', () => {
  it('files Inbox, Archive and Sent copies into each linked mailbox once, as read, with no notification or send', async () => {
    const t = setup();
    const g = t.graph;
    g.routes.set(`${BOB}/inbox`, [g.page(BOB, 'inbox', [item('m-in', '<plan-1@example.test>', NOW - HOUR)])]);
    g.routes.set(`${BOB}/archive`, [g.page(BOB, 'archive', [item('m-arch', '<old-1@example.test>', NOW - 2 * HOUR)])]);
    g.routes.set(`${ALICE}/sentitems`, [g.page(ALICE, 'sentitems', [item('m-sent', '<plan-1@example.test>', NOW - HOUR)])]);
    g.routes.set(`${SUPPORT}/inbox`, [g.page(SUPPORT, 'inbox', [
      item('m-ext', '<ext-1@partner.example>', NOW - HOUR),
      item('m-draft', '<draft@example.test>', NOW - HOUR, { isDraft: true }),
      { id: 'm-gone', '@removed': { reason: 'deleted' } },
    ])]);
    g.mimes.set('m-in', innerMessage());
    g.mimes.set('m-arch', innerMessage({ messageId: '<old-1@example.test>', subject: 'Archived thing' }));
    g.mimes.set('m-sent', innerMessage({ headers: { Bcc: 'carol@example.test' } }));
    g.mimes.set('m-ext', innerMessage({ from: 'Partner <someone@partner.example>', to: `support@${DOMAIN}`, messageId: '<ext-1@partner.example>', subject: 'Hello support', internal: false }));

    const result = await t.tick();
    expect(result).toMatchObject({ status: 'worked', mailboxes: 3, visited: 3, complete: true, counts: { filed: 3, sentFiled: 1, duplicates: 0, skipped: 0, capped: 0 } });
    const rows = t.messages();
    expect(rows).toEqual([
      expect.objectContaining({ mailbox_id: 'mbx-alice', direction: 'outbound', folder: 'sent', is_read: 1, message_id_header: '<plan-1@example.test>', bcc_addresses: '["carol@example.test"]' }),
      expect.objectContaining({ mailbox_id: 'mbx-bob', direction: 'inbound', folder: 'archive', is_read: 1, subject: 'Archived thing' }),
      expect.objectContaining({ mailbox_id: 'mbx-bob', direction: 'inbound', folder: 'inbox', is_read: 1, from_address: 'alice@example.test', subject: 'Quarterly plan', bcc_addresses: '[]' }),
      expect.objectContaining({ mailbox_id: 'mbx-support', direction: 'inbound', folder: 'inbox', from_address: 'someone@partner.example' }),
    ]);
    // The Inbox copy has the same id the normal inbound path (and the journal source) gives it.
    expect(rows.find((row) => row.folder === 'inbox' && row.mailbox_id === 'mbx-bob')?.id).toBe(await stableInboundId('mbx-bob', '<plan-1@example.test>'));
    // The draft and the removed entry are never read.
    expect(g.mimeCalls().some((call) => call.includes('m-draft') || call.includes('m-gone'))).toBe(false);
    // Every folder of every mailbox now holds a delta link.
    expect(t.folders()).toHaveLength(9);
    expect(t.folders().every((row) => row.link_kind === 'delta' && row.last_error === '')).toBe(true);
    // First pull starts at now minus 24 hours (the default look-back).
    const first = g.deltaCalls().find((call) => call.includes(BOB) && call.includes('/inbox/'));
    expect(decodeURIComponent(String(first))).toContain('$filter=receivedDateTime ge 2026-11-15T05:00:00Z');
    expect(decodeURIComponent(String(first))).toContain('$select=internetMessageId,receivedDateTime,isDraft');
    // Newest first, so a capped first pull keeps the newest mail.
    expect(decodeURIComponent(String(first))).toContain('$orderby=receivedDateTime desc');
    // Copies keep the time Exchange received them, not the time of the pull.
    expect(t.sqlite.prepare(`SELECT received_at FROM messages WHERE mailbox_id = 'mbx-bob' AND folder = 'archive'`).get()).toEqual({ received_at: '2026-11-16 03:00:00' });
    expect(t.status()).toMatchObject({ mailboxes: 3, denied: 0, permissionMissing: false, lastError: '', today: { filed: 3, sentFiled: 1 } });
    // One trace row per filed copy; the trace never holds Graph ids.
    const traces = t.sqlite.prepare(`SELECT status_detail FROM mail_trace ORDER BY rowid`).all() as Row[];
    expect(traces.map((row) => row.status_detail)).toEqual(expect.arrayContaining(['Exchange mirror (Graph): filed to Inbox', 'Exchange mirror (Graph): filed to Sent', 'Exchange mirror (Graph): filed to Archive']));
    t.assertNothingSent();
  });

  it('counts replays and read-state changes as duplicates without downloading anything', async () => {
    const t = setup();
    const g = t.graph;
    const message = item('m-in', '<plan-1@example.test>', NOW - HOUR);
    g.routes.set(`${BOB}/inbox`, [g.page(BOB, 'inbox', [message], { delta: 'd1' })]);
    g.mimes.set('m-in', innerMessage());
    await t.tick();
    expect(g.mimeCalls()).toHaveLength(1);
    // The next round replays the same message (for example a read-state change) and one older than the round.
    g.routes.set(deltaLink(BOB, 'inbox', 'd1'), [g.page(BOB, 'inbox', [{ ...message, isRead: true }, item('m-older', '<older@example.test>', NOW - 48 * HOUR)], { delta: 'd2' })]);
    t.advance(5 * 60_000);
    const result = await t.tick();
    expect(result).toMatchObject({ counts: { filed: 0, duplicates: 1 } });
    expect(g.mimeCalls()).toHaveLength(1);
    expect(t.messages()).toHaveLength(1);
    expect(t.folders().find((row) => row.mailbox_id === 'mbx-bob' && row.folder === 'inbox')?.link).toBe(deltaLink(BOB, 'inbox', 'd2'));
  });

  it('files a message once whether the journal or the Graph source brings it first', async () => {
    const t = setup({ env: { M365_JOURNAL_ADDRESS: JOURNAL, INBOUND_AUTHSERV_ID: AUTHSERV, M365_JOURNAL_NDR_DOMAIN: NDR_DOMAIN, M365_JOURNAL_MIRROR_SENT: 'true' } });
    t.setSetting('exchange_mirror_enabled', 'true');
    const deliver = async (raw: string) => {
      const message = {
        from: NDR, to: JOURNAL, rawSize: raw.length, headers: new Headers(),
        get raw() { return new Blob([raw]).stream(); },
        setReject: vi.fn(), forward: vi.fn(), reply: vi.fn(),
      };
      await (worker as unknown as { email(m: unknown, e: unknown, c: unknown): Promise<void> }).email(message, t.env, { waitUntil: vi.fn() });
      return message;
    };
    // Journal first (bob's Inbox and alice's Sent), then Graph reads both.
    const report = await deliver(journalReport());
    expect(report.setReject).not.toHaveBeenCalled();
    expect(t.messages()).toHaveLength(2);
    const g = t.graph;
    g.routes.set(`${BOB}/inbox`, [g.page(BOB, 'inbox', [item('m-in', '<plan-1@example.test>', NOW - HOUR)])]);
    g.routes.set(`${ALICE}/sentitems`, [g.page(ALICE, 'sentitems', [item('m-sent', '<plan-1@example.test>', NOW - HOUR)])]);
    g.mimes.set('m-in', innerMessage());
    g.mimes.set('m-sent', innerMessage());
    expect(await t.tick()).toMatchObject({ counts: { filed: 0, sentFiled: 0, duplicates: 2 } });
    expect(g.mimeCalls()).toEqual([]);
    expect(t.messages()).toHaveLength(2);

    // Graph first, then the journal report: the report files nothing new.
    const u = setup({ env: { M365_JOURNAL_ADDRESS: JOURNAL, INBOUND_AUTHSERV_ID: AUTHSERV, M365_JOURNAL_NDR_DOMAIN: NDR_DOMAIN } });
    u.setSetting('exchange_mirror_enabled', 'true');
    const h = u.graph;
    h.routes.set(`${BOB}/inbox`, [h.page(BOB, 'inbox', [item('m-in', '<plan-1@example.test>', NOW - HOUR)])]);
    h.mimes.set('m-in', innerMessage());
    expect(await u.tick()).toMatchObject({ counts: { filed: 1 } });
    const raw = journalReport();
    const message = {
      from: NDR, to: JOURNAL, rawSize: raw.length, headers: new Headers(),
      get raw() { return new Blob([raw]).stream(); },
      setReject: vi.fn(), forward: vi.fn(), reply: vi.fn(),
    };
    await (worker as unknown as { email(m: unknown, e: unknown, c: unknown): Promise<void> }).email(message, u.env, { waitUntil: vi.fn() });
    expect(u.messages().filter((row) => row.mailbox_id === 'mbx-bob')).toHaveLength(1);
    expect(u.sqlite.prepare('SELECT duplicates, filed FROM exchange_mirror_days').get()).toEqual({ duplicates: 1, filed: 0 });
    t.assertNothingSent();
    u.assertNothingSent();
  });

  it('never files a second Sent copy of mail cmail itself sent (or copied back into Exchange)', async () => {
    const t = setup();
    t.sqlite.prepare(
      `INSERT INTO messages (id, mailbox_id, message_id_header, direction, from_address, to_addresses, cc_addresses, subject, folder)
       VALUES ('own-send', 'mbx-alice', '<own-1@example.test>', 'outbound', 'alice@example.test', '[]', '[]', 'Mine', 'sent')`,
    ).run();
    const g = t.graph;
    g.routes.set(`${ALICE}/sentitems`, [g.page(ALICE, 'sentitems', [item('m-own', '<own-1@example.test>', NOW - HOUR)])]);
    g.mimes.set('m-own', innerMessage({ messageId: '<own-1@example.test>' }));
    expect(await t.tick()).toMatchObject({ counts: { sentFiled: 0, duplicates: 1 } });
    expect(g.mimeCalls()).toEqual([]);
  });

  it('marks colleague mail from the tenant as authenticated for Focused Inbox, and internet mail not', async () => {
    const t = setup();
    t.setSetting('focused_inbox_enabled', 'true');
    const g = t.graph;
    g.routes.set(`${BOB}/inbox`, [g.page(BOB, 'inbox', [
      item('m-colleague', '<c-1@example.test>', NOW - HOUR),
      item('m-forged', '<f-1@example.test>', NOW - HOUR),
    ])]);
    g.mimes.set('m-colleague', innerMessage({ messageId: '<c-1@example.test>' }));
    g.mimes.set('m-forged', innerMessage({ messageId: '<f-1@example.test>', internal: false }));
    await t.tick();
    const focus = t.sqlite.prepare(`SELECT message_id_header, focus_reason FROM messages WHERE mailbox_id = 'mbx-bob' ORDER BY message_id_header`).all() as Row[];
    expect(focus).toHaveLength(2);
    expect(focus[0]).toEqual({ message_id_header: '<c-1@example.test>', focus_reason: 'internal' });
    expect(focus[1]?.focus_reason).not.toBe('internal');
    t.assertNothingSent();
  });

  it('skips what the inbound path would refuse: too large, no Message-ID, blocked attachment', async () => {
    const t = setup({ env: { MAX_INBOUND_BYTES: '2000' } });
    const g = t.graph;
    g.routes.set(`${BOB}/inbox`, [g.page(BOB, 'inbox', [
      item('m-big', '<big@example.test>', NOW - HOUR),
      item('m-noid', null, NOW - HOUR),
      item('m-exe', '<exe@example.test>', NOW - HOUR),
    ])]);
    g.mimes.set('m-big', innerMessage({ messageId: '<big@example.test>', body: 'x'.repeat(5000) }));
    g.mimes.set('m-noid', innerMessage({ messageId: null }));
    g.mimes.set('m-exe', innerMessage({ messageId: '<exe@example.test>', attachment: { filename: 'run.exe', type: 'application/octet-stream', base64: 'TVo=' } }));
    expect(await t.tick()).toMatchObject({ counts: { filed: 0, skipped: 3 } });
    expect(t.status().lastSkipReason).toBe('too_large');
    expect(t.messages()).toEqual([]);
    expect(t.sqlite.prepare(`SELECT detail FROM audit_log WHERE event_type = 'graph_mirror.copies_skipped'`).all()).toEqual([{ detail: 'Graph mirror skipped 3 copies: too_large' }]);
  });
});

describe('Graph mirror: limits, errors and resume', () => {
  it('files at most the first-pull cap per folder, then nothing older is lost silently: it is counted', async () => {
    const t = setup({ env: { M365_GRAPH_MIRROR_INITIAL_CAP: '2' } });
    const g = t.graph;
    g.routes.set(`${BOB}/inbox`, [g.page(BOB, 'inbox', [1, 2, 3].map((n) => item(`m-${n}`, `<n-${n}@example.test>`, NOW - n * HOUR)))]);
    for (const n of [1, 2, 3]) g.mimes.set(`m-${n}`, innerMessage({ messageId: `<n-${n}@example.test>` }));
    expect(await t.tick()).toMatchObject({ counts: { filed: 2, capped: 1 } });
    expect(g.mimeCalls()).toHaveLength(2);
    expect(t.status()).toMatchObject({ today: { capped: 1 }, lastSkipReason: 'capped' });
    // Once caught up (a delta link), new mail is no longer capped.
    g.routes.set(deltaLink(BOB, 'inbox', 'd1'), [g.page(BOB, 'inbox', [4, 5, 6].map((n) => item(`m-${n}`, `<n-${n}@example.test>`, NOW + n)), { delta: 'd2' })]);
    for (const n of [4, 5, 6]) g.mimes.set(`m-${n}`, innerMessage({ messageId: `<n-${n}@example.test>` }));
    t.advance(5 * 60_000);
    expect(await t.tick()).toMatchObject({ counts: { filed: 3, capped: 0 } });
  });

  it('a copy the budget cannot cover keeps its page: nothing is skipped for good', async () => {
    const t = setup();
    const g = t.graph;
    g.routes.set(`${ALICE}/inbox`, [g.page(ALICE, 'inbox', [item('m-a', '<a-1@example.test>', NOW - HOUR)])]);
    g.mimes.set('m-a', innerMessage({ messageId: '<a-1@example.test>', from: 'Bob <bob@example.test>', to: 'alice@example.test' }));
    expect(await t.tick({ budgets: { subrequests: 8 } })).toMatchObject({ counts: { filed: 0, skipped: 0 }, complete: false });
    expect(t.folders().find((row) => row.mailbox_id === 'mbx-alice' && row.folder === 'inbox')).toBeUndefined();
    t.advance(5 * 60_000);
    expect(await t.tick()).toMatchObject({ counts: { filed: 1, skipped: 0 } });
    expect(t.messages()).toHaveLength(1);
  });

  it('"Import older mail" reaches mailboxes not read yet as well', async () => {
    const t = setup();
    t.setSetting('graph_mirror_import_older', `10:${NOW}`);
    // A budget so small that only the first mailbox is reached on this tick.
    await t.tick({ budgets: { graph: 3 } });
    const support = t.folders().filter((row) => row.mailbox_id === 'mbx-support');
    expect(support).toHaveLength(3);
    expect(support.every((row) => Number(row.since_ms) === NOW - 10 * 24 * HOUR && Number(row.round_cap) === 20_000)).toBe(true);
  });

  it('"Import older mail" starts every folder again from that many days back, once', async () => {
    const t = setup();
    await t.tick();
    t.setSetting('graph_mirror_import_older', `30:${NOW}`);
    t.advance(5 * 60_000);
    t.graph.calls.length = 0;
    await t.tick();
    const first = t.graph.deltaCalls().find((call) => call.includes(BOB) && call.includes('/inbox/'));
    expect(decodeURIComponent(String(first))).toContain('receivedDateTime ge 2026-10-17T05:05:00Z');
    expect(t.folders().every((row) => Number(row.round_cap) === 0 && row.link_kind === 'delta')).toBe(true);
    // Applied once: the next run follows the delta links.
    t.advance(5 * 60_000);
    t.graph.calls.length = 0;
    await t.tick();
    expect(t.graph.deltaCalls().some((call) => call.includes('$filter'))).toBe(false);
  });

  it('honours 429 Retry-After per mailbox: the others go on, the throttled one waits, nothing is skipped', async () => {
    const t = setup();
    const g = t.graph;
    g.routes.set(`${BOB}/inbox`, [{ status: 429, headers: { 'Retry-After': '120' } }, g.page(BOB, 'inbox', [item('m-in', '<plan-1@example.test>', NOW - HOUR)])]);
    g.routes.set(`${SUPPORT}/inbox`, [g.page(SUPPORT, 'inbox', [item('m-s', '<s-1@example.test>', NOW - HOUR)])]);
    g.mimes.set('m-in', innerMessage());
    g.mimes.set('m-s', innerMessage({ messageId: '<s-1@example.test>' }));
    expect(await t.tick()).toMatchObject({ status: 'worked', counts: { filed: 1 }, error: '' });
    const bob = t.folders().find((row) => row.mailbox_id === 'mbx-bob' && row.folder === 'inbox');
    expect(bob).toMatchObject({ last_error: 'throttled', link_kind: 'none', retry_after_ms: NOW + 120_000 });
    t.advance(60_000);
    expect(await t.tick()).toMatchObject({ counts: { filed: 0 } });
    t.advance(90_000);
    expect(await t.tick()).toMatchObject({ counts: { filed: 1 } });
    expect(t.messages().map((row) => row.mailbox_id)).toEqual(['mbx-bob', 'mbx-support']);
  });

  it('a 429 while reading a message keeps the page, so it is read again and nothing is lost', async () => {
    const t = setup();
    const g = t.graph;
    g.routes.set(`${BOB}/inbox`, [g.page(BOB, 'inbox', [item('m-1', '<a-1@example.test>', NOW - HOUR), item('m-2', '<a-2@example.test>', NOW - HOUR)])]);
    g.mimes.set('m-1', innerMessage({ messageId: '<a-1@example.test>' }));
    g.mimes.set('m-2', innerMessage({ messageId: '<a-2@example.test>' }));
    g.mimeReplies.set('m-2', [{ status: 429, headers: { 'Retry-After': '30' } }]);
    await t.tick();
    expect(t.messages()).toHaveLength(1);
    expect(t.folders().find((row) => row.mailbox_id === 'mbx-bob' && row.folder === 'inbox')).toMatchObject({ link_kind: 'none', last_error: 'throttled' });
    t.advance(60_000);
    expect(await t.tick()).toMatchObject({ counts: { filed: 1, duplicates: 1 } });
    expect(t.messages()).toHaveLength(2);
  });

  it('410 (delta token expired) starts again from the watermark, never from the beginning', async () => {
    const t = setup();
    const g = t.graph;
    g.routes.set(`${BOB}/inbox`, [g.page(BOB, 'inbox', [item('m-in', '<plan-1@example.test>', NOW - 2 * HOUR)])]);
    g.mimes.set('m-in', innerMessage());
    await t.tick();
    g.routes.set(deltaLink(BOB, 'inbox', 'd1'), [{ status: 410 }]);
    t.advance(3 * 24 * HOUR);
    await t.tick();
    const row = t.folders().find((r) => r.mailbox_id === 'mbx-bob' && r.folder === 'inbox');
    expect(row).toMatchObject({ link_kind: 'none', last_error: 'resync_required', since_ms: NOW - 3 * HOUR });
    g.calls.length = 0;
    g.routes.set(`${BOB}/inbox`, [g.page(BOB, 'inbox', [item('m-in', '<plan-1@example.test>', NOW - 2 * HOUR)])]);
    t.advance(5 * 60_000);
    expect(await t.tick()).toMatchObject({ counts: { filed: 0, duplicates: 1 } });
    const restart = g.deltaCalls().find((call) => call.includes(BOB) && call.includes('/inbox/'));
    expect(decodeURIComponent(String(restart))).toContain('receivedDateTime ge 2026-11-16T02:00:00Z');
  });

  it('shows "permission missing" when every mailbox is refused, and counts a mailbox outside the RBAC scope', async () => {
    const t = setup();
    const forbidden = { status: 403, body: { error: { code: 'ErrorAccessDenied' } } };
    for (const object of [ALICE, BOB, SUPPORT]) for (const folder of ['inbox', 'sentitems', 'archive']) t.graph.routes.set(`${object}/${folder}`, [forbidden]);
    await t.tick();
    expect(t.status()).toMatchObject({ permissionMissing: true, denied: 3, lastError: 'permission_missing' });
    expect(t.messages()).toEqual([]);

    const u = setup();
    for (const folder of ['inbox', 'sentitems', 'archive']) u.graph.routes.set(`${SUPPORT}/${folder}`, [forbidden]);
    await u.tick();
    expect(u.status()).toMatchObject({ permissionMissing: false, denied: 1, lastError: '' });
    // Refused once per mailbox per tick, then left alone for an hour.
    expect(u.graph.deltaCalls().filter((call) => call.includes(SUPPORT))).toHaveLength(1);
  });

  it('stops the whole run on rejected credentials before reading any mailbox', async () => {
    const t = setup();
    t.graph.setToken({ status: 401, body: { error: 'invalid_client' } });
    expect(await t.tick()).toEqual({ status: 'error', code: 'credentials_rejected' });
    expect(t.graph.deltaCalls()).toEqual([]);
    expect(t.status()).toMatchObject({ lastError: 'credentials_rejected' });
    expect(JSON.stringify(t.status())).not.toContain('test-token');
  });

  it('stops at the Graph budget, saves its place and resumes on the next tick without repeating work', async () => {
    const t = setup();
    const g = t.graph;
    for (const [object, name] of [[ALICE, 'a'], [BOB, 'b'], [SUPPORT, 's']] as const) {
      g.routes.set(`${object}/inbox`, [g.page(object, 'inbox', [item(`m-${name}1`, `<${name}-1@example.test>`, NOW - HOUR)], { next: 'p2' })]);
      g.routes.set(nextLink(object, 'inbox', 'p2'), [g.page(object, 'inbox', [item(`m-${name}2`, `<${name}-2@example.test>`, NOW - HOUR)])]);
      g.mimes.set(`m-${name}1`, innerMessage({ messageId: `<${name}-1@example.test>` }));
      g.mimes.set(`m-${name}2`, innerMessage({ messageId: `<${name}-2@example.test>` }));
    }
    const first = await t.tick({ budgets: { graph: 6 } });
    expect(first).toMatchObject({ status: 'worked', complete: false });
    const filedFirst = t.messages().length;
    expect(filedFirst).toBeGreaterThan(0);
    expect(filedFirst).toBeLessThan(6);
    let rounds = 0;
    while (t.messages().length < 6 && rounds < 10) {
      t.advance(5 * 60_000);
      await t.tick({ budgets: { graph: 6 } });
      rounds += 1;
    }
    expect(t.messages()).toHaveLength(6);
    // Each message was downloaded exactly once across all ticks.
    const downloads = g.mimeCalls().map((call) => /messages\/([^/]+)\/\$value/.exec(call)?.[1]);
    expect(new Set(downloads).size).toBe(downloads.length);
    t.assertNothingSent();
  });
});
