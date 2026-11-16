import { describe, expect, it, vi } from 'vitest';
import { INBOUND_TOOLS } from '../index';
import { migratedDatabase } from '../testing/sqlite-d1';
import { GUARDS_OFF } from '../testing/delivery';
import { GRAPH_ROOT } from '../m365-sync/graph';
import { DOMAIN, TENANT, innerMessage } from '../exchange-mirror/fixtures';
import {
  D1_MAX_DATABASE_BYTES,
  GRAPH_IMPORT_SETTING_ESTIMATE,
  GRAPH_IMPORT_SETTING_JOB,
  GRAPH_IMPORT_SETTING_REQUEST,
} from '@cmail/shared/graph-import';
import { runGraphMirrorTick, type GraphMirrorDeps } from './run';

// "Import older mail" (docs/exchange-mirror.md#import-older-mail) against every
// real migration (node:sqlite) and a fake Microsoft Graph that holds a small
// mailbox dataset: the dry-run count with size sample, bounded list pages,
// $value MIME, refused folders. Fixture data only: placeholder GUIDs and
// example.test addresses.

type Row = Record<string, unknown>;
interface Rec { id: string; mid: string; ms: number; size: number }

const oid = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const ALICE = oid(0xa1);
const BOB = oid(0xb0);
const SUPPORT = oid(0x50);
const NOW = Date.parse('2026-11-16T05:00:00Z');
const DAY = 86_400_000;
const FIVE_MIN = 5 * 60_000;
const SIZE_ID = 'Integer 0x0E08';

function fakeGraph() {
  const calls: string[] = [];
  /** "<object>/<folder>" to its messages. */
  const data = new Map<string, Rec[]>();
  /** "<object>/<folder>" to a status that list and count requests answer with. */
  const refuse = new Map<string, number>();
  /** The same, for the import's list pages only (the dry run's count still answers). */
  const refuseList = new Map<string, number>();
  const consistency: Array<string | null> = [];
  let sizes = true;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'test-token', expires_in: 3600 });
    const parsed = new URL(url);
    const mime = /^\/v1\.0\/users\/([^/]+)\/messages\/([^/]+)\/\$value$/.exec(parsed.pathname);
    if (mime) {
      const id = decodeURIComponent(mime[2] as string);
      const found = [...data.values()].flat().find((rec) => rec.id === id);
      return found
        ? new Response(innerMessage({ messageId: found.mid, subject: `Subject ${found.id}` }), { status: 200, headers: { 'content-type': 'text/plain' } })
        : json({ error: { code: 'ErrorItemNotFound' } }, 404);
    }
    const delta = /^\/v1\.0\/users\/([^/]+)\/mailFolders\/([^/]+)\/messages\/delta$/.exec(parsed.pathname);
    if (delta) return json({ value: [], '@odata.deltaLink': `${GRAPH_ROOT}users/${delta[1]}/mailFolders/${delta[2]}/messages/delta?$deltatoken=empty` });
    const list = /^\/v1\.0\/users\/([^/]+)\/mailFolders\/([^/]+)\/messages$/.exec(parsed.pathname);
    if (list) {
      const key = `${list[1]}/${list[2]}`;
      const status = refuse.get(key) ?? (parsed.searchParams.get('$count') === 'true' ? undefined : refuseList.get(key));
      if (status) return json({ error: { code: 'Denied' } }, status);
      const filter = decodeURIComponent(parsed.searchParams.get('$filter') ?? '');
      const bound = (op: string) => {
        const match = new RegExp(`receivedDateTime ${op} (\\S+)`).exec(filter);
        return match ? Date.parse(match[1] as string) : null;
      };
      const [ge, lt, le] = [bound('ge'), bound('lt'), bound('le')];
      const rows = [...(data.get(key) ?? [])]
        .filter((rec) => (ge === null || rec.ms >= ge) && (lt === null || rec.ms < lt) && (le === null || rec.ms <= le))
        .sort((a, b) => b.ms - a.ms);
      if (parsed.searchParams.get('$count') === 'true') {
        consistency.push(new Headers(init?.headers).get('ConsistencyLevel'));
        return json({
          '@odata.count': rows.length,
          value: rows.slice(0, Number(parsed.searchParams.get('$top'))).map((rec) => ({
            id: rec.id,
            singleValueExtendedProperties: sizes ? [{ id: SIZE_ID, value: String(rec.size) }] : [],
          })),
        });
      }
      const top = Number(parsed.searchParams.get('$top') ?? 50);
      const skip = Number(parsed.searchParams.get('$skip') ?? parsed.searchParams.get('skip') ?? 0);
      const page = rows.slice(skip, skip + top);
      const body: Record<string, unknown> = {
        value: page.map((rec) => ({ id: rec.id, internetMessageId: rec.mid, receivedDateTime: new Date(rec.ms).toISOString(), isDraft: false })),
      };
      if (skip + top < rows.length) {
        const next = new URL(url);
        next.searchParams.delete('$skip');
        next.searchParams.set('skip', String(skip + top));
        body['@odata.nextLink'] = next.toString();
      }
      return json(body);
    }
    return json({ error: { code: 'NotFound' } }, 404);
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    data,
    refuse,
    refuseList,
    consistency,
    noSizes() { sizes = false; },
    add(object: string, folder: string, recs: Rec[]) { data.set(`${object}/${folder}`, [...(data.get(`${object}/${folder}`) ?? []), ...recs]); },
    mimeCalls: () => calls.filter((call) => call.endsWith('/$value')),
    listCalls: () => calls.filter((call) => /\/messages\?/.test(call) && !call.includes('$count=true')),
    countCalls: () => calls.filter((call) => call.includes('$count=true')),
  };
}

function rec(id: string, ageDays: number, size: number): Rec {
  return { id, mid: `<${id}@example.test>`, ms: NOW - ageDays * DAY, size };
}

/** alice: 3 inbox (one 40 days old) and 1 sent; bob: 1 inbox and 1 archive (100 days old); support: 1. */
function dataset(graph: ReturnType<typeof fakeGraph>) {
  graph.add(ALICE, 'inbox', [rec('a1', 3, 10_000), rec('a2', 20, 20_000), rec('a3', 40, 30_000)]);
  graph.add(ALICE, 'sentitems', [rec('a4', 5, 5_000)]);
  graph.add(BOB, 'inbox', [rec('b1', 2, 8_000)]);
  graph.add(BOB, 'archive', [rec('b2', 100, 40_000)]);
  graph.add(SUPPORT, 'inbox', [rec('s1', 1, 6_000)]);
}

function setup(options: { d1Bytes?: number | null } = {}) {
  const { d1: inner, sqlite } = migratedDatabase();
  const d1Bytes = options.d1Bytes === undefined ? 123_456_789 : options.d1Bytes;
  // D1 reports the database size with every statement; the test adapter does not, so say it for SELECT 1.
  const d1 = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return (sql: string) => (sql === 'SELECT 1'
        ? { run: async () => ({ meta: d1Bytes === null ? {} : { size_after: d1Bytes } }) }
        : target.prepare(sql));
    },
  });
  for (const [id, object] of [['alice', ALICE], ['bob', BOB]] as const) {
    sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES (?, ?, 'standard', 'active')`).run(id, `${id}@${DOMAIN}`);
    sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status, owner_user_id) VALUES (?, ?, 'personal', 'active', ?)`).run(`mbx-${id}`, `${id}@${DOMAIN}`, id);
    sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, user_id) VALUES (?, 'person', ?)`).run(object, id);
  }
  sqlite.prepare(`INSERT INTO mailboxes (id, address, type, status) VALUES ('mbx-support', ?, 'shared', 'active')`).run(`support@${DOMAIN}`);
  sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, mailbox_id) VALUES (?, 'shared', 'mbx-support')`).run(SUPPORT);
  const setSetting = (key: string, value: string) => sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  setSetting('graph_mirror_enabled', 'true');
  const send = vi.fn(async () => ({ messageId: '<never@example.test>' }));
  const env: Record<string, unknown> = {
    DB: d1,
    STORAGE: { put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
    EMAIL: { send },
    MAIL_DOMAIN: DOMAIN,
    M365_TENANT_ID: TENANT,
    M365_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
    M365_CLIENT_SECRET: 'test-secret',
    ...GUARDS_OFF,
  };
  const graph = fakeGraph();
  dataset(graph);
  let clock = NOW;
  let seq = 0;
  const tick = (deps: Partial<GraphMirrorDeps> = {}) => runGraphMirrorTick(env as never, INBOUND_TOOLS, {
    fetcher: graph.fetch,
    sleep: async () => undefined,
    now: () => clock,
    force: true,
    ...deps,
  });
  /** A tick five minutes after the last one, as the cron would run. */
  const next = async (deps: Partial<GraphMirrorDeps> = {}) => {
    clock += FIVE_MIN;
    return tick(deps);
  };
  const read = (key: string) => {
    const row = sqlite.prepare('SELECT value FROM org_settings WHERE key = ?').get(key) as Row | undefined;
    return row ? JSON.parse(String(row.value)) as Record<string, any> : null;
  };
  const request = (kind: 'estimate' | 'start', period: string, confirm?: { messages: number; bytes: number }) => {
    seq += 1;
    setSetting(GRAPH_IMPORT_SETTING_REQUEST, JSON.stringify({ seq: `req-${seq}`, kind, period, at: clock, ...(confirm ? { confirm } : {}) }));
  };
  /** What the Admin Stop button does: one guarded statement. */
  const stop = () => sqlite.prepare(
    `UPDATE org_settings SET value = json_patch(value, '{"status":"stopped"}') WHERE key IN (?, ?) AND json_extract(value, '$.status') = 'running'`,
  ).run(GRAPH_IMPORT_SETTING_JOB, GRAPH_IMPORT_SETTING_ESTIMATE);
  const messages = () => sqlite.prepare(
    `SELECT mailbox_id, direction, folder, is_read, message_id_header FROM messages ORDER BY mailbox_id, message_id_header`,
  ).all() as Row[];
  const audits = () => (sqlite.prepare(`SELECT event_type FROM audit_log WHERE event_type LIKE 'graph_mirror.import%' ORDER BY rowid`).all() as Row[]).map((row) => row.event_type);
  const liveFolders = () => sqlite.prepare('SELECT mailbox_id, folder, link_kind FROM graph_mirror_folders ORDER BY mailbox_id, folder').all() as Row[];
  return { sqlite, env, graph, tick, next, read, request, stop, setSetting, messages, audits, liveFolders, send, advance: (ms: number) => { clock += ms; } };
}

/** Confirms the numbers of the finished estimate and runs the recount (and the first import run). */
async function confirmAndStart(t: ReturnType<typeof setup>, period: string, deps: Partial<GraphMirrorDeps> = {}) {
  const estimate = t.read(GRAPH_IMPORT_SETTING_ESTIMATE) as Record<string, any>;
  t.request('start', period, { messages: estimate.messages, bytes: estimate.bytes });
  return t.next(deps);
}

describe('Import older mail: the dry run', () => {
  it('counts messages and sizes per mailbox for the period, writes no mail, and asks for a consistent count', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    const estimate = t.read(GRAPH_IMPORT_SETTING_ESTIMATE);
    // a1, a2, a4, b1, s1 in the last 30 days; a3 (40 days) and b2 (100 days) are older.
    expect(estimate).toMatchObject({
      status: 'done', period: '1m', messages: 5, bytes: 49_000, mailboxesTotal: 3, mailboxesDone: 3, errors: 0, assumedSize: false, d1UsedBytes: 123_456_789,
    });
    expect(estimate?.perMailbox).toEqual([['mbx-alice', 3, 35_000], ['mbx-bob', 1, 8_000], ['mbx-support', 1, 6_000]]);
    expect(t.messages()).toEqual([]);
    expect(t.graph.mimeCalls()).toEqual([]);
    expect(t.graph.listCalls()).toEqual([]);
    // The request is handled once and then removed, so it can never be replayed.
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM org_settings WHERE key = ?').get(GRAPH_IMPORT_SETTING_REQUEST)).toEqual({ n: 0 });
    expect(t.graph.countCalls().length).toBe(9);
    expect(new Set(t.graph.consistency)).toEqual(new Set(['eventual']));
    expect(decodeURIComponent(t.graph.countCalls()[0] as string)).toContain(`singleValueExtendedProperties($filter=id eq '${SIZE_ID}')`);
    expect(t.send).not.toHaveBeenCalled();
  });

  it('All counts everything, with no date filter', async () => {
    const t = setup();
    t.request('estimate', 'all');
    await t.tick();
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ period: 'all', messages: 7, bytes: 119_000, sinceMs: 0 });
    expect(t.graph.countCalls().every((call) => !decodeURIComponent(call).includes('receivedDateTime'))).toBe(true);
  });

  it('samples sizes, so a folder larger than the sample is an average times the count', async () => {
    const t = setup();
    const big = Array.from({ length: 120 }, (_, i) => ({ ...rec(`x${i}`, 2, 1_000), size: i < 50 ? 2_000 : 9_999_999 }));
    t.graph.data.clear();
    t.graph.add(ALICE, 'inbox', big);
    t.request('estimate', '1m');
    await t.tick();
    // The newest 50 are the sample (all 2,000 bytes): 120 x 2,000. "About", not exact.
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ messages: 120, bytes: 240_000 });
  });

  it('uses an assumed size when no size comes back, and says so', async () => {
    const t = setup();
    t.graph.noSizes();
    t.request('estimate', '1w');
    await t.tick();
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ messages: 4, assumedSize: true, bytes: 4 * 75_000 });
  });

  it('carries on over runs within the request budget, and live mail is read first every run', async () => {
    const t = setup();
    t.request('estimate', '1m');
    // The live pull is held to 70% of the budget (11 of 16), which it needs 10 for; the dry run has the rest: two mailboxes a run.
    await t.tick({ budgets: { graph: 16 } });
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ status: 'running', mailboxesDone: 2, messages: 4 });
    await t.next({ budgets: { graph: 16 } });
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ status: 'done', mailboxesDone: 3, messages: 5, bytes: 49_000 });
    expect(t.graph.calls.filter((call) => call.includes('/messages/delta')).length).toBe(18);
  });

  it('keeps most of a run for live mail: with a small budget the live pull goes first and gets 70%, the count the rest', async () => {
    const t = setup();
    t.request('estimate', '1m');
    // 10 requests: live gets 7 (the token and two mailboxes), the count gets the other 3 (one mailbox).
    await t.tick({ budgets: { graph: 10 } });
    expect(t.graph.calls.filter((call) => call.includes('/messages/delta')).length).toBe(6);
    expect(t.graph.countCalls().length).toBe(3);
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ status: 'running', mailboxesDone: 1 });
    const lastDelta = t.graph.calls.map((call) => call.includes('/messages/delta')).lastIndexOf(true);
    expect(t.graph.calls.findIndex((call) => call.includes('$count=true'))).toBeGreaterThan(lastDelta);
    // The live pull is not starved: the next run starts with the mailbox it did not reach.
    await t.next({ budgets: { graph: 10 } });
    expect(t.graph.calls.filter((call) => call.includes(`users/${SUPPORT}/mailFolders/inbox/messages/delta`)).length).toBe(1);
  });

  it('gives up on a mailbox that keeps failing, after six runs, and counts it', async () => {
    const t = setup();
    t.graph.refuse.set(`${BOB}/inbox`, 503);
    t.request('estimate', '1m');
    for (let run = 0; run < 5; run += 1) {
      if (run > 0) await t.next(); else await t.tick();
      expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ status: 'running', mailboxesDone: 1, retries: run + 1 });
    }
    await t.next();
    // alice 3 and support 1; bob is left out and counted.
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ status: 'done', mailboxesDone: 3, messages: 4, errors: 1 });
  });

  it('leaves out a refused folder (counted as an error) and treats a missing one as empty', async () => {
    const t = setup();
    t.graph.refuse.set(`${BOB}/inbox`, 403);
    t.graph.refuse.set(`${BOB}/archive`, 404);
    t.request('estimate', '1m');
    await t.tick();
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ status: 'done', messages: 4, errors: 1 });
  });

  it('does nothing without a request, a record or a Graph call beyond the live pull', async () => {
    const t = setup();
    await t.tick();
    expect(t.graph.countCalls()).toEqual([]);
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toBeNull();
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toBeNull();
  });
});

describe('Import older mail: confirm, start, import', () => {
  it('starts only after a recount, files every message in the period once, as read, and audits it', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    expect(await confirmAndStart(t, '1m')).toMatchObject({ status: 'worked' });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({
      status: 'done', period: '1m', estMessages: 5, filed: 5, duplicates: 0, skipped: 0, processed: 5, errors: 0, mailboxesTotal: 3, mailboxesDone: 3,
    });
    expect(t.messages()).toEqual([
      expect.objectContaining({ mailbox_id: 'mbx-alice', direction: 'inbound', folder: 'inbox', is_read: 1, message_id_header: '<a1@example.test>' }),
      expect.objectContaining({ mailbox_id: 'mbx-alice', direction: 'inbound', folder: 'inbox', is_read: 1, message_id_header: '<a2@example.test>' }),
      expect.objectContaining({ mailbox_id: 'mbx-alice', direction: 'outbound', folder: 'sent', is_read: 1, message_id_header: '<a4@example.test>' }),
      expect.objectContaining({ mailbox_id: 'mbx-bob', direction: 'inbound', folder: 'inbox', is_read: 1, message_id_header: '<b1@example.test>' }),
      expect.objectContaining({ mailbox_id: 'mbx-support', direction: 'inbound', folder: 'inbox', is_read: 1, message_id_header: '<s1@example.test>' }),
    ]);
    // Nothing older than the period was read; the confirmed recount counted again first.
    expect(t.graph.mimeCalls().some((call) => call.includes('a3') || call.includes('b2'))).toBe(false);
    expect(t.graph.countCalls().length).toBe(18);
    expect(t.audits()).toEqual(['graph_mirror.import_started', 'graph_mirror.import_finished']);
    // No rules or notifications: nothing sent, no push.
    expect(t.send).not.toHaveBeenCalled();
    // The live mirror's delta links are the live pull's own and unchanged in kind.
    expect(t.liveFolders().every((row) => row.link_kind === 'delta')).toBe(true);
    // Import list pages are bounded above by the import's start: newest-first plain lists, never delta.
    const first = decodeURIComponent(t.graph.listCalls()[0] as string);
    expect(first).toContain('receivedDateTime ge 2026-10-17T05:05:00Z and receivedDateTime lt 2026-11-16T05:05:00Z');
    expect(first).toContain('$orderby=receivedDateTime desc');
    expect(t.graph.listCalls().every((call) => !call.includes('/delta'))).toBe(true);
  });

  it('files nothing twice: a second import of the same period counts every message as already here and downloads nothing', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    await confirmAndStart(t, '1m');
    const downloads = t.graph.mimeCalls().length;
    t.request('estimate', '1m');
    await t.next();
    await confirmAndStart(t, '1m');
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 0, duplicates: 5, processed: 5 });
    expect(t.graph.mimeCalls().length).toBe(downloads);
    expect(t.messages()).toHaveLength(5);
  });

  it('All reaches every folder, including Archive, and nothing else changes', async () => {
    const t = setup();
    t.request('estimate', 'all');
    await t.tick();
    await confirmAndStart(t, 'all');
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 7, estMessages: 7 });
    expect(t.messages().find((row) => row.message_id_header === '<b2@example.test>')).toMatchObject({ mailbox_id: 'mbx-bob', folder: 'archive' });
    expect(decodeURIComponent(t.graph.listCalls()[0] as string)).not.toContain('receivedDateTime ge');
  });

  it('asks again, and starts nothing, when the recount moved by more than 20%', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    const confirmed = t.read(GRAPH_IMPORT_SETTING_ESTIMATE) as Record<string, any>;
    // Three new messages arrive before Start is processed: 5 became 8.
    t.graph.add(ALICE, 'inbox', [rec('n1', 1, 1_000), rec('n2', 1, 1_000), rec('n3', 1, 1_000)]);
    t.request('start', '1m', { messages: confirmed.messages, bytes: confirmed.bytes });
    await t.next();
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ status: 'done', messages: 8, changed: true, then: { messages: 5, bytes: 49_000 }, jobId: '' });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toBeNull();
    expect(t.messages()).toEqual([]);
    expect(t.audits()).toEqual([]);
  });

  it('starts when the recount moved by 20% or less', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    const confirmed = t.read(GRAPH_IMPORT_SETTING_ESTIMATE) as Record<string, any>;
    t.graph.add(ALICE, 'inbox', [rec('n1', 1, 1_000)]);
    t.request('start', '1m', { messages: confirmed.messages, bytes: confirmed.bytes });
    await t.next();
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 6, estMessages: 5 });
  });

  it('refuses to start when the recount shows the database would pass its limit, or its size is unknown for All', async () => {
    const over = setup({ d1Bytes: D1_MAX_DATABASE_BYTES - 10_000 });
    over.request('estimate', 'all');
    await over.tick();
    await confirmAndStart(over, 'all');
    expect(over.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ status: 'done', refused: 'd1_over', jobId: '' });
    expect(over.read(GRAPH_IMPORT_SETTING_JOB)).toBeNull();
    expect(over.messages()).toEqual([]);

    const unknown = setup({ d1Bytes: null });
    unknown.request('estimate', 'all');
    await unknown.tick();
    expect(unknown.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ d1UsedBytes: -1 });
    await confirmAndStart(unknown, 'all');
    expect(unknown.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ refused: 'd1_unknown' });
    expect(unknown.read(GRAPH_IMPORT_SETTING_JOB)).toBeNull();
  });

  it('ignores a start request with no confirmed numbers', async () => {
    const t = setup();
    t.request('start', '1m');
    await t.tick();
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toBeNull();
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toBeNull();
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM org_settings WHERE key = ?').get(GRAPH_IMPORT_SETTING_REQUEST)).toEqual({ n: 0 });
  });
});

describe('Import older mail: resume, stop, one at a time, live first', () => {
  it('imports a few messages a run and resumes where it stopped, downloading nothing twice', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    await confirmAndStart(t, '1m', { budgets: { importMessages: 2 } });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'running', filed: 2, processed: 2 });
    for (let run = 0; run < 6 && t.read(GRAPH_IMPORT_SETTING_JOB)?.status === 'running'; run += 1) await t.next({ budgets: { importMessages: 2 } });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 5, duplicates: 0, processed: 5, mailboxesDone: 3 });
    expect(t.graph.mimeCalls().length).toBe(5);
    expect(t.messages()).toHaveLength(5);
  });

  it('pages through a large folder with a resume point, so a stop and restart repeats nothing it already filed', async () => {
    const t = setup();
    t.graph.data.clear();
    t.graph.add(ALICE, 'inbox', Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, mid: `<p${i}@example.test>`, ms: NOW - 2 * DAY - i * 60_000, size: 1_000 })));
    t.request('estimate', '1m');
    await t.tick();
    await confirmAndStart(t, '1m', { budgets: { importMessages: 50 } });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'running', filed: 50, cursor: { mid: 'mbx-alice', folder: 0 } });
    // The next run resumes at the oldest message seen (an inclusive, bounded list that skips the one it read), not from the start.
    await t.next({ budgets: { importMessages: 50 } });
    expect(decodeURIComponent(t.graph.listCalls().at(-1) as string)).toMatch(/receivedDateTime le 2026-11-1\dT\d\d:\d\d:\d\dZ.*&\$skip=1$/);
    for (let run = 0; run < 4 && t.read(GRAPH_IMPORT_SETTING_JOB)?.status === 'running'; run += 1) await t.next({ budgets: { importMessages: 50 } });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 120, duplicates: 0, processed: 120 });
    expect(t.messages()).toHaveLength(120);
    expect(t.graph.mimeCalls().length).toBe(120);
  });

  it('a burst of mail in one second is neither repeated nor skipped across runs', async () => {
    const t = setup();
    t.graph.data.clear();
    const burst = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, mid: `<b${i}@example.test>`, ms: NOW - 3 * DAY, size: 1_000 }));
    const older = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, mid: `<o${i}@example.test>`, ms: NOW - 4 * DAY - i * 60_000, size: 1_000 }));
    t.graph.add(ALICE, 'inbox', [...burst, ...older]);
    t.request('estimate', '1m');
    await t.tick();
    await confirmAndStart(t, '1m', { budgets: { importMessages: 50 } });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'running', filed: 50, cursor: { skip: 50 } });
    for (let run = 0; run < 4 && t.read(GRAPH_IMPORT_SETTING_JOB)?.status === 'running'; run += 1) await t.next({ budgets: { importMessages: 50 } });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 70, duplicates: 0 });
    expect(t.messages()).toHaveLength(70);
  });

  it('starts a folder again from its resume point when a page token expires', async () => {
    const t = setup();
    t.graph.data.clear();
    t.graph.add(ALICE, 'inbox', Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, mid: `<p${i}@example.test>`, ms: NOW - 2 * DAY - i * 60_000, size: 1_000 })));
    t.request('estimate', '1m');
    await t.tick();
    const original = t.graph.fetch;
    let expired = false;
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!expired && /[?&]skip=50/.test(String(input))) {
        expired = true;
        return Response.json({ error: { code: 'syncStateNotFound' } }, { status: 410 });
      }
      return original(input, init);
    }) as typeof fetch;
    await confirmAndStart(t, '1m', { fetcher: wrapped });
    expect(expired).toBe(true);
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 120, duplicates: 0, errors: 0 });
    expect(t.graph.mimeCalls().length).toBe(120);
  });

  it('stops itself before the database fills, and says why', async () => {
    const t = setup({ d1Bytes: D1_MAX_DATABASE_BYTES * 0.95 });
    t.request('estimate', 'all');
    await t.tick();
    // 95% is "near", not over: it may start, then the safety net stops it before anything is filed.
    await confirmAndStart(t, 'all');
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'stopped', error: 'd1_limit', filed: 0 });
    expect(t.graph.listCalls()).toEqual([]);
    expect(t.audits()).toEqual(['graph_mirror.import_started', 'graph_mirror.import_stopped_d1']);
  });

  it('gives up on a folder that keeps failing, after six runs, counts it and finishes the rest', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    t.graph.refuseList.set(`${BOB}/inbox`, 503);
    await confirmAndStart(t, '1m');
    for (let run = 0; run < 10 && t.read(GRAPH_IMPORT_SETTING_JOB)?.status === 'running'; run += 1) await t.next();
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 4, errors: 1 });
  });

  it('does not count a folder that does not exist (no Archive) as an error', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    t.graph.refuseList.set(`${ALICE}/archive`, 404);
    await confirmAndStart(t, '1m');
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 5, errors: 0 });
  });

  it('Stop ends it at once: no more lists or downloads, and a later run does not bring it back', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    await confirmAndStart(t, '1m', { budgets: { importMessages: 2 } });
    t.stop();
    const lists = t.graph.listCalls().length;
    const downloads = t.graph.mimeCalls().length;
    await t.next();
    await t.next();
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'stopped', filed: 2 });
    expect(t.graph.listCalls().length).toBe(lists);
    expect(t.graph.mimeCalls().length).toBe(downloads);
    expect(t.messages()).toHaveLength(2);
  });

  it('Stop during the dry run ends the count', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick({ budgets: { graph: 16 } });
    t.stop();
    const counts = t.graph.countCalls().length;
    await t.next();
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ status: 'stopped', mailboxesDone: 2 });
    expect(t.graph.countCalls().length).toBe(counts);
  });

  it('runs one import at a time: a request made while one runs is dropped', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    await confirmAndStart(t, '1m', { budgets: { importMessages: 2 } });
    const id = t.read(GRAPH_IMPORT_SETTING_JOB)?.id;
    t.request('estimate', 'all');
    await t.next({ budgets: { importMessages: 2 } });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ id, period: '1m' });
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ period: '1m' });
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM org_settings WHERE key = ?').get(GRAPH_IMPORT_SETTING_REQUEST)).toEqual({ n: 0 });
  });

  it('live mail goes first: a live message is filed in the same run, before and apart from the import', async () => {
    const t = setup();
    const live = { id: 'live1', internetMessageId: '<live1@example.test>', receivedDateTime: new Date(NOW - 60_000).toISOString(), isDraft: false };
    const original = t.graph.fetch;
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`users/${ALICE}/mailFolders/inbox/messages/delta`)) {
        return Response.json({ value: [live], '@odata.deltaLink': `${GRAPH_ROOT}users/${ALICE}/mailFolders/inbox/messages/delta?$deltatoken=d1` });
      }
      if (url.includes('/messages/live1/$value')) return new Response(innerMessage({ messageId: '<live1@example.test>' }), { status: 200 });
      return original(input, init);
    }) as typeof fetch;
    t.request('estimate', '1m');
    const result = await t.tick({ fetcher: wrapped });
    expect(result).toMatchObject({ status: 'worked', counts: { filed: 1 } });
    // The live message was filed in the live pull; the estimate ran after it, in the same run.
    expect(t.messages().map((row) => row.message_id_header)).toEqual(['<live1@example.test>']);
    expect(t.read(GRAPH_IMPORT_SETTING_ESTIMATE)).toMatchObject({ status: 'done' });
    const firstCount = t.graph.calls.findIndex((call) => call.includes('$count=true'));
    const lastDelta = t.graph.calls.map((call) => call.includes('/messages/delta')).lastIndexOf(true);
    expect(firstCount).toBeGreaterThan(lastDelta);
  });

  it('a throttled import waits for Retry-After and then carries on', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    const original = t.graph.fetch;
    let throttled = true;
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (throttled && /\/messages\?/.test(String(input)) && !String(input).includes('$count')) {
        return new Response(null, { status: 429, headers: { 'Retry-After': '600' } });
      }
      return original(input, init);
    }) as typeof fetch;
    await confirmAndStart(t, '1m', { fetcher: wrapped });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'running', filed: 0, error: 'throttled', retries: 1, pausedUntil: NOW + FIVE_MIN + 600_000 });
    throttled = false;
    await t.next({ fetcher: wrapped });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'running', filed: 0 });
    t.advance(10 * 60_000);
    await t.tick({ fetcher: wrapped });
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 5, error: '' });
  });

  it('skips a mailbox Graph refuses, counts it, and finishes the rest', async () => {
    const t = setup();
    t.request('estimate', '1m');
    await t.tick();
    t.graph.refuseList.set(`${BOB}/inbox`, 403);
    await confirmAndStart(t, '1m');
    expect(t.read(GRAPH_IMPORT_SETTING_JOB)).toMatchObject({ status: 'done', filed: 4, errors: 1 });
  });
});
