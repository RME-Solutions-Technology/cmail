import { describe, expect, it } from 'vitest';
import { migratedDatabase } from '../testing/sqlite-d1';
import { runCopyBackTick, type CopyBackDeps } from './run';
import { COPYBACK_MARKER_PROPERTY } from './graph';
import { COPYBACK_CATEGORY } from './build';

// Copy-back against every real migration (node:sqlite), a fake R2 and a fake
// Microsoft Graph. Fixtures: placeholder GUIDs and example.test addresses only.

const TENANT_ID = '00000000-0000-0000-0000-000000000000';
const CLIENT_ID = '00000000-0000-0000-0000-0000000000c1';
const ALICE = '00000000-0000-0000-0000-00000000a11c';
const BOB = '00000000-0000-0000-0000-000000000b0b';
const SHARED = '00000000-0000-0000-0000-00000000005a';
const T0 = Date.parse('2026-11-14T00:00:00Z');
const MINUTE = 60_000;

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
interface Call { method: string; url: string; auth: string | null; body: string | null }
interface Stored { id: string; marker: string; mid: string | null; folder: string; isRead: boolean; body: Record<string, unknown> }

function fakeGraph() {
  const calls: Call[] = [];
  const mailboxes = new Map<string, Stored[]>();
  /** Message-IDs Exchange already holds per user (delivered there natively). */
  const native = new Map<string, Set<string>>();
  const missing = new Set<string>();
  const denied = new Set<string>();
  const overrides: Array<{ match: (call: Call) => boolean; reply: Reply }> = [];
  let ids = 0;

  const json = (reply: Reply) => new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json', ...reply.headers },
  });

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = { method: init?.method ?? 'GET', url, auth: headers.get('authorization'), body: typeof init?.body === 'string' ? init.body : null };
    calls.push(call);
    if (url.startsWith('https://login.microsoftonline.com/')) return json({ status: 200, body: { access_token: 'test-token', expires_in: 3600 } });
    const index = overrides.findIndex((entry) => entry.match(call));
    if (index >= 0) return json(overrides.splice(index, 1)[0]!.reply);
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/v1\.0\/users\/([0-9a-f-]{36})\/(.*)$/);
    if (!match) return json({ status: 400, body: { error: { code: 'BadRequest' } } });
    const [, user, rest] = match as unknown as [string, string, string];
    if (missing.has(user)) return json({ status: 404, body: { error: { code: 'ErrorInvalidUser' } } });
    if (denied.has(user)) return json({ status: 403, body: { error: { code: 'ErrorAccessDenied' } } });
    const items = mailboxes.get(user) ?? [];
    mailboxes.set(user, items);
    if (call.method === 'GET' && rest === 'messages') {
      const filter = parsed.searchParams.get('$filter') ?? '';
      const markerMatch = filter.match(/ep\/value eq '([^']*)'/);
      if (filter.includes(COPYBACK_MARKER_PROPERTY) && markerMatch) {
        const found = items.find((item) => item.marker === markerMatch[1]);
        return json({ status: 200, body: { value: found ? [{ id: found.id }] : [] } });
      }
      const midMatch = filter.match(/^internetMessageId eq '(.*)'$/);
      if (midMatch) {
        const mid = midMatch[1]!.replace(/''/g, "'");
        const hit = native.get(user)?.has(mid) || items.some((item) => item.mid === mid);
        return json({ status: 200, body: { value: hit ? [{ id: 'native-1' }] : [] } });
      }
      return json({ status: 400, body: { error: { code: 'BadFilter' } } });
    }
    const create = rest.match(/^mailFolders\/(inbox|archive|sentitems)\/messages$/);
    if (call.method === 'POST' && create) {
      const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
      const props = (body.singleValueExtendedProperties as Array<{ id: string; value: string }>) ?? [];
      const stored: Stored = {
        id: `ex-${++ids}`,
        marker: props.find((prop) => prop.id === COPYBACK_MARKER_PROPERTY)?.value ?? '',
        mid: typeof body.internetMessageId === 'string' ? body.internetMessageId : null,
        folder: create[1]!,
        isRead: body.isRead !== false,
        body,
      };
      items.push(stored);
      return json({ status: 201, body: { id: stored.id } });
    }
    const patch = rest.match(/^messages\/(.+)$/);
    if (call.method === 'PATCH' && patch) {
      const target = items.find((item) => item.id === decodeURIComponent(patch[1]!));
      if (!target) return json({ status: 404, body: { error: { code: 'ErrorItemNotFound' } } });
      target.isRead = (JSON.parse(call.body ?? '{}') as { isRead?: boolean }).isRead !== false;
      return json({ status: 200, body: { id: target.id } });
    }
    return json({ status: 400, body: { error: { code: 'Unexpected' } } });
  }) as typeof fetch;

  const posts = () => calls.filter((call) => call.method === 'POST' && call.url.includes('/mailFolders/'));
  const queue = (match: (call: Call) => boolean, reply: Reply) => overrides.push({ match, reply });
  return { fetcher, calls, mailboxes, native, missing, denied, posts, queue };
}

function fakeR2(objects: Map<string, Uint8Array>) {
  return {
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { size: bytes.byteLength, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
    },
  } as unknown as R2Bucket;
}

function setup(options: { enabled?: boolean; env?: Record<string, string> } = {}) {
  const { d1, sqlite } = migratedDatabase();
  const graph = fakeGraph();
  const objects = new Map<string, Uint8Array>();
  let clock = T0 + 24 * 60 * MINUTE;
  sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('standby_copyback_enabled', ?)`).run(options.enabled === false ? 'false' : 'true');
  sqlite.exec(`
    INSERT INTO users (id, email, role, status) VALUES ('u-alice', 'alice@example.test', 'standard', 'active'), ('u-bob', 'bob@example.test', 'standard', 'active'), ('u-carol', 'carol@example.test', 'standard', 'active');
    INSERT INTO mailboxes (id, address, type, owner_user_id) VALUES ('mb-alice', 'alice@example.test', 'personal', 'u-alice'), ('mb-bob', 'bob@example.test', 'personal', 'u-bob'), ('mb-carol', 'carol@example.test', 'personal', 'u-carol');
    INSERT INTO mailboxes (id, address, type) VALUES ('mb-team', 'team@example.test', 'shared');
    INSERT INTO m365_sync_links (object_id, kind, user_id) VALUES ('${ALICE}', 'person', 'u-alice'), ('${BOB}', 'person', 'u-bob');
    INSERT INTO m365_sync_links (object_id, kind, mailbox_id) VALUES ('${SHARED}', 'shared', 'mb-team');
  `);
  let n = 0;
  const addMessage = (fields: Partial<{ id: string; mailbox: string; folder: string; at: number; isRead: number; mid: string | null; body: string | null; attachments: Array<{ name: string; bytes: Uint8Array; inline?: string }> }> = {}) => {
    const id = fields.id ?? `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;
    const bodyKey = fields.body === null ? null : `messages/ns/${id}`;
    if (bodyKey) objects.set(bodyKey, new TextEncoder().encode(fields.body ?? '<p>Hello</p>'));
    const at = new Date(fields.at ?? T0 + 60 * MINUTE).toISOString().slice(0, 19).replace('T', ' ');
    const mid = fields.mid === undefined ? `<${id}@sender.example.test>` : fields.mid;
    sqlite.prepare(`INSERT INTO messages (id, mailbox_id, message_id_header, direction, from_address, from_name, to_addresses, to_participants,
        subject, body_r2_key, folder, is_read, received_at, size_bytes, has_attachments)
      VALUES (?, ?, ?, 'inbound', 'sender@example.test', 'Sender Person', '["alice@example.test"]', '[{"address":"alice@example.test","name":"Alice"}]',
        'Subject line', ?, ?, ?, ?, 100, ?)`)
      .run(id, fields.mailbox ?? 'mb-alice', mid, bodyKey, fields.folder ?? 'inbox', fields.isRead ?? 0, at, fields.attachments?.length ? 1 : 0);
    for (const [index, file] of (fields.attachments ?? []).entries()) {
      const key = `attachments/ns/${id}-${index}`;
      objects.set(key, file.bytes);
      sqlite.prepare(`INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, disposition)
        VALUES (?, ?, ?, 'application/pdf', ?, ?, ?, ?)`)
        .run(`${id}-a${index}`, id, file.name, file.bytes.byteLength, key, file.inline ?? null, file.inline ? 'inline' : 'attachment');
    }
    return id;
  };
  let jobs = 0;
  const startJob = (fields: Partial<{ from: number; to: number; target: string | null; folders: string }> = {}) => {
    const id = `job-${++jobs}`;
    sqlite.prepare(`UPDATE standby_copyback_jobs SET status = 'done' WHERE status = 'running'`).run();
    sqlite.prepare(`INSERT INTO standby_copyback_jobs (id, window_from, window_to, target_object_id, folders) VALUES (?, ?, ?, ?, ?)`)
      .run(id, new Date(fields.from ?? T0).toISOString().slice(0, 19).replace('T', ' '),
        new Date(fields.to ?? T0 + 12 * 60 * MINUTE).toISOString().slice(0, 19).replace('T', ' '),
        fields.target ?? null, fields.folders ?? 'inbox');
    return id;
  };
  const env = {
    DB: d1,
    STORAGE: fakeR2(objects),
    M365_TENANT_ID: TENANT_ID,
    M365_COPYBACK_CLIENT_ID: CLIENT_ID,
    M365_COPYBACK_CLIENT_SECRET: 'test-secret',
    ...options.env,
  };
  const tick = (deps: CopyBackDeps = {}) => runCopyBackTick(env, { fetcher: graph.fetcher, sleep: async () => undefined, now: () => clock, ...deps });
  const items = () => sqlite.prepare('SELECT message_id, target_object_id, state, reason, attempts, next_attempt_at FROM standby_copyback_items ORDER BY message_id').all() as Array<Record<string, unknown>>;
  const job = (id: string) => sqlite.prepare('SELECT * FROM standby_copyback_jobs WHERE id = ?').get(id) as Record<string, unknown>;
  const advance = (ms: number) => { clock += ms; };
  return { d1, sqlite, graph, objects, addMessage, startJob, tick, items, job, advance, env };
}

describe('standby copy-back: switch, config and selection', () => {
  it('does nothing while the switch is off (the default)', async () => {
    const t = setup({ enabled: false });
    t.addMessage();
    t.startJob();
    expect(await t.tick()).toEqual({ status: 'off' });
    expect(t.graph.calls).toHaveLength(0);
    expect(t.items()).toHaveLength(0);
  });

  it('is idle without a running job, and reports missing settings by name only', async () => {
    const t = setup({ env: { M365_COPYBACK_CLIENT_SECRET: '' } });
    expect(await t.tick()).toEqual({ status: 'idle' });
    const id = t.startJob();
    expect(await t.tick()).toEqual({ status: 'not_configured' });
    expect(t.job(id)).toMatchObject({ last_result: 'not_configured', last_error_code: 'not_configured' });
    expect(t.graph.calls).toHaveLength(0);
  });

  it('copies only received Inbox mail inside the window, for linked mailboxes', async () => {
    const t = setup();
    const inside = t.addMessage({ at: T0 + 30 * MINUTE });
    t.addMessage({ at: T0 - MINUTE }); // before the window
    t.addMessage({ at: T0 + 12 * 60 * MINUTE }); // window end is exclusive
    t.addMessage({ folder: 'sent' });
    t.addMessage({ folder: 'drafts' });
    t.addMessage({ folder: 'spam' });
    t.addMessage({ folder: 'trash' });
    t.addMessage({ folder: 'archive' });
    t.addMessage({ mailbox: 'mb-carol' }); // no Microsoft 365 link
    const shared = t.addMessage({ mailbox: 'mb-team' });
    const id = t.startJob();
    expect(await t.tick()).toMatchObject({ status: 'worked', copied: 2, failed: 0, done: true });
    expect(t.items().map((row) => row.message_id).sort()).toEqual([inside, shared].sort());
    expect(t.graph.mailboxes.get(ALICE)?.map((item) => item.folder)).toEqual(['inbox']);
    expect(t.graph.mailboxes.get(SHARED)).toHaveLength(1);
    expect(t.job(id)).toMatchObject({ status: 'done', last_result: 'done' });
  });

  it('copies Archive and Sent only when chosen, into the matching Exchange folders', async () => {
    const t = setup();
    t.addMessage({ folder: 'archive' });
    t.addMessage({ folder: 'sent' });
    t.addMessage({ folder: 'drafts' });
    t.startJob({ folders: 'archive,inbox,sent' });
    await t.tick();
    expect(t.graph.mailboxes.get(ALICE)?.map((item) => item.folder).sort()).toEqual(['archive', 'sentitems']);
  });

  it('honours a one-mailbox scope', async () => {
    const t = setup();
    t.addMessage({ mailbox: 'mb-alice' });
    t.addMessage({ mailbox: 'mb-bob' });
    t.startJob({ target: BOB });
    await t.tick();
    expect(t.graph.mailboxes.get(ALICE)).toBeUndefined();
    expect(t.graph.mailboxes.get(BOB)).toHaveLength(1);
  });
});

describe('standby copy-back: what a copy keeps', () => {
  it('creates a non-draft item with original time, sender, recipients, marker, category and attachments', async () => {
    const t = setup();
    const pdf = new Uint8Array([37, 80, 68, 70]);
    const id = t.addMessage({ isRead: 1, at: Date.parse('2026-11-14T03:04:05Z'), attachments: [{ name: 'report.pdf', bytes: pdf }, { name: 'logo.png', bytes: pdf, inline: '<logo@x>' }] });
    t.startJob();
    await t.tick();
    const [copy] = t.graph.mailboxes.get(ALICE)!;
    const body = copy!.body;
    const props = Object.fromEntries((body.singleValueExtendedProperties as Array<{ id: string; value: string }>).map((p) => [p.id, p.value]));
    expect(props['Integer 0x0E07']).toBe('1');
    expect(props['SystemTime 0x0E06']).toBe('2026-11-14T03:04:05.000Z');
    expect(props['SystemTime 0x0039']).toBe('2026-11-14T03:04:05.000Z');
    expect(props[COPYBACK_MARKER_PROPERTY]).toBe(id);
    expect(body).toMatchObject({
      subject: 'Subject line',
      body: { contentType: 'html', content: '<p>Hello</p>' },
      from: { emailAddress: { address: 'sender@example.test', name: 'Sender Person' } },
      toRecipients: [{ emailAddress: { address: 'alice@example.test', name: 'Alice' } }],
      categories: [COPYBACK_CATEGORY],
      internetMessageId: `<${id}@sender.example.test>`,
      isRead: true,
    });
    const files = body.attachments as Array<Record<string, unknown>>;
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'report.pdf', contentBytes: 'JVBERg==', isInline: false });
    expect(files[1]).toMatchObject({ isInline: true, contentId: 'logo@x' });
    expect(copy!.isRead).toBe(true);
    expect(t.graph.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('restores unread with a PATCH after creating a read (non-draft) item', async () => {
    const t = setup();
    t.addMessage({ isRead: 0 });
    t.startJob();
    await t.tick();
    expect(t.graph.mailboxes.get(ALICE)![0]!.isRead).toBe(false);
    expect(t.graph.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('skips a message too large for one request, without calling create', async () => {
    const t = setup();
    t.addMessage({ attachments: [{ name: 'big.bin', bytes: new Uint8Array(4000) }] });
    t.startJob();
    expect(await t.tick({ budgets: { maxBytes: 2000 } })).toMatchObject({ skipped: 1, done: true });
    expect(t.items()[0]).toMatchObject({ state: 'skipped', reason: 'too_large' });
    expect(t.graph.posts()).toHaveLength(0);
  });

  it('sends the token only to graph.microsoft.com/v1.0', async () => {
    const t = setup();
    t.addMessage();
    t.startJob();
    await t.tick();
    const withToken = t.graph.calls.filter((call) => call.auth);
    expect(withToken.length).toBeGreaterThan(0);
    for (const call of withToken) expect(call.url.startsWith('https://graph.microsoft.com/v1.0/')).toBe(true);
  });
});

describe('standby copy-back: idempotency and duplicates', () => {
  it('never copies a message twice, even in a later job with an overlapping window', async () => {
    const t = setup();
    t.addMessage();
    t.addMessage({ mailbox: 'mb-bob' });
    t.startJob();
    await t.tick();
    expect(t.graph.posts()).toHaveLength(2);
    t.startJob({ from: T0 - 60 * MINUTE });
    expect(await t.tick()).toMatchObject({ status: 'worked', copied: 0, done: true });
    expect(t.graph.posts()).toHaveLength(2);
    expect(t.items().every((row) => row.state === 'copied')).toBe(true);
  });

  it('refuses to reset or delete a copied item (database triggers)', async () => {
    const t = setup();
    const id = t.addMessage();
    t.startJob();
    await t.tick();
    expect(() => t.sqlite.prepare(`UPDATE standby_copyback_items SET state = 'pending' WHERE message_id = ?`).run(id)).toThrow(/final/);
    expect(() => t.sqlite.prepare(`DELETE FROM standby_copyback_items WHERE message_id = ?`).run(id)).toThrow(/kept/);
    expect(() => t.sqlite.prepare(`INSERT OR REPLACE INTO standby_copyback_items (message_id, target_object_id, state, job_id) VALUES (?, ?, 'copied', 'x')`).run(id, ALICE)).toThrow();
  });

  it('finds its own earlier copy by marker instead of creating a second one', async () => {
    const t = setup();
    const id = t.addMessage();
    t.graph.mailboxes.set(ALICE, [{ id: 'ex-earlier', marker: id, mid: null, folder: 'inbox', isRead: true, body: {} }]);
    t.startJob();
    await t.tick();
    expect(t.graph.posts()).toHaveLength(0);
    expect(t.items()[0]).toMatchObject({ state: 'copied', reason: 'found_marker' });
    // Unread in cmail: the found copy is set unread too.
    expect(t.graph.mailboxes.get(ALICE)![0]!.isRead).toBe(false);
  });

  it('skips a message Exchange already holds (same Message-ID)', async () => {
    const t = setup();
    const id = t.addMessage();
    t.graph.native.set(ALICE, new Set([`<${id}@sender.example.test>`]));
    t.startJob();
    await t.tick();
    expect(t.graph.posts()).toHaveLength(0);
    expect(t.items()[0]).toMatchObject({ state: 'skipped', reason: 'already_in_exchange' });
  });

  it('escapes quotes in a Message-ID filter', async () => {
    const t = setup();
    t.addMessage({ mid: "<o'brien@example.test>" });
    t.startJob();
    await t.tick();
    const lookup = t.graph.calls.find((call) => call.url.includes('internetMessageId'));
    expect(new URL(lookup!.url).searchParams.get('$filter')).toBe("internetMessageId eq '<o''brien@example.test>'");
  });
});

describe('standby copy-back: failures, throttling and bounded work', () => {
  it('backs off on 429 with Retry-After and resumes without duplicates', async () => {
    const t = setup();
    t.addMessage();
    t.addMessage();
    const id = t.startJob();
    // Longer than the in-place retry limit (5 s): the run stops at once.
    t.graph.queue((call) => call.method === 'POST' && call.url.includes('/mailFolders/'), { status: 429, headers: { 'retry-after': '120' } });
    expect(await t.tick()).toEqual({ status: 'error', code: 'throttled' });
    expect(t.job(id)).toMatchObject({ last_result: 'backoff', last_error_code: 'throttled', status: 'running' });
    expect(t.items().every((row) => row.state === 'pending' && row.attempts === 0)).toBe(true);
    expect(await t.tick()).toEqual({ status: 'backoff' });
    t.advance(121_000);
    expect(await t.tick()).toMatchObject({ status: 'worked', copied: 2, done: true });
    expect(t.graph.mailboxes.get(ALICE)).toHaveLength(2);
  });

  it('a create that Exchange accepted but the run lost is found on retry, not created again', async () => {
    const t = setup();
    t.addMessage({ isRead: 0 });
    t.startJob();
    // Create succeeds, then the unread PATCH is throttled: the run stops before recording.
    t.graph.queue((call) => call.method === 'PATCH', { status: 503, headers: { 'retry-after': '60' } });
    expect(await t.tick()).toMatchObject({ status: 'error' });
    expect(t.items()[0]).toMatchObject({ state: 'pending' });
    t.advance(61_000);
    expect(await t.tick()).toMatchObject({ copied: 1, done: true });
    expect(t.graph.posts()).toHaveLength(1);
    expect(t.items()[0]).toMatchObject({ state: 'copied', reason: 'found_marker' });
    expect(t.graph.mailboxes.get(ALICE)![0]!.isRead).toBe(false);
  });

  it('a 404 mailbox fails that mailbox with a retry later while others are copied', async () => {
    const t = setup();
    t.addMessage({ mailbox: 'mb-alice' });
    t.addMessage({ mailbox: 'mb-alice' });
    t.addMessage({ mailbox: 'mb-bob' });
    const id = t.startJob();
    t.graph.missing.add(ALICE);
    expect(await t.tick()).toMatchObject({ status: 'worked', copied: 1, failed: 1, done: false });
    const rows = t.items();
    expect(rows.filter((row) => row.state === 'failed')).toEqual([expect.objectContaining({ reason: 'mailbox_not_found', attempts: 1, next_attempt_at: expect.any(String) })]);
    // The second Alice item was not tried this tick.
    expect(rows.filter((row) => row.target_object_id === ALICE && row.state === 'pending')).toHaveLength(1);
    expect(t.job(id)).toMatchObject({ status: 'running' });
    t.graph.missing.delete(ALICE);
    t.advance(6 * MINUTE);
    expect(await t.tick()).toMatchObject({ copied: 2, done: true });
  });

  it('a 403 (mailbox outside the access scope) fails with backoff; retries stop after the limit', async () => {
    const t = setup();
    t.addMessage();
    const id = t.startJob();
    t.graph.denied.add(ALICE);
    for (let i = 0; i < 6; i += 1) {
      await t.tick();
      t.advance(24 * 60 * MINUTE);
    }
    expect(t.items()[0]).toMatchObject({ state: 'failed', reason: 'access_denied', attempts: 6, next_attempt_at: null });
    // Nothing left to try: the job finished on the last attempt and stays done.
    expect(t.job(id)).toMatchObject({ status: 'done' });
    expect(await t.tick()).toEqual({ status: 'idle' });
  });

  it('stops on a rejected credential and waits an hour', async () => {
    const t = setup();
    t.addMessage();
    const id = t.startJob();
    t.graph.queue((call) => call.method === 'GET', { status: 401 });
    expect(await t.tick()).toEqual({ status: 'error', code: 'unauthorized' });
    expect(t.job(id)).toMatchObject({ last_result: 'error', last_error_code: 'unauthorized' });
    expect(Date.parse(String(t.job(id).backoff_until))).toBeGreaterThanOrEqual(T0 + 25 * 60 * MINUTE - 1000);
  });

  it('does bounded work per tick and resumes where it stopped', async () => {
    const t = setup();
    for (let i = 0; i < 5; i += 1) t.addMessage({ at: T0 + (i + 1) * MINUTE });
    t.startJob();
    expect(await t.tick({ budgets: { items: 2, planChunk: 2, workChunk: 2 } })).toMatchObject({ copied: 2, done: false });
    expect(await t.tick({ budgets: { items: 2, planChunk: 2, workChunk: 2 } })).toMatchObject({ copied: 2, done: false });
    expect(await t.tick({ budgets: { items: 2, planChunk: 2, workChunk: 2 } })).toMatchObject({ copied: 1, done: true });
    expect(t.graph.posts()).toHaveLength(5);
    expect(t.items()).toHaveLength(5);
  });

  it('a second overlapping invocation is refused by the lease', async () => {
    const t = setup();
    t.addMessage();
    const id = t.startJob();
    t.sqlite.prepare('UPDATE standby_copyback_jobs SET lease_until = ? WHERE id = ?').run(Math.floor((T0 + 25 * 60 * MINUTE) / 1000), id);
    expect(await t.tick()).toEqual({ status: 'busy' });
    expect(t.graph.calls).toHaveLength(0);
  });

  it('never deletes or changes mail in cmail', async () => {
    const t = setup();
    t.addMessage();
    t.addMessage({ mailbox: 'mb-bob' });
    const before = t.sqlite.prepare('SELECT * FROM messages ORDER BY id').all();
    t.startJob();
    await t.tick();
    expect(t.sqlite.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before);
    expect(t.graph.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});
