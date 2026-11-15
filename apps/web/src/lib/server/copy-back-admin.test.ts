import { describe, expect, it, vi } from 'vitest';
import { loadCopyBackSwitch, parseCopyBackParams } from '@cmail/shared/copy-back';
import { createTestDatabase } from './mcp/testing/harness';
import { applyCopyBackAction, loadCopyBackOverview, parseCopyBackAction } from './copy-back-admin';

// Placeholder GUIDs and example.test addresses only.
const ALICE = '00000000-0000-0000-0000-00000000a11c';
const NOW = new Date('2026-11-15T00:00:00Z');
const WINDOW = { from: '2026-11-14T00:00', to: '2026-11-14T12:00', target: '', folders: ['inbox'] };

function setup(config: { configured: boolean; problems?: string[] } | 'none' = { configured: true }) {
  const { d1, sqlite } = createTestDatabase();
  sqlite.exec(`
    INSERT INTO users (id, email, role, status) VALUES ('manager-1', 'manager@example.test', 'manager', 'active'), ('u-alice', 'alice@example.test', 'standard', 'active');
    INSERT INTO mailboxes (id, address, type, owner_user_id) VALUES ('mb-alice', 'alice@example.test', 'personal', 'u-alice');
    INSERT INTO m365_sync_links (object_id, kind, user_id) VALUES ('${ALICE}', 'person', 'u-alice');
  `);
  const fetch = vi.fn(async () => Response.json(config));
  const env = { DB: d1, EMAIL_SERVICE: config === 'none' ? undefined : ({ fetch } as unknown as Fetcher) };
  let n = 0;
  const addMessage = (at: string, folder = 'inbox') => {
    const id = `msg-${++n}`;
    sqlite.prepare(`INSERT INTO messages (id, mailbox_id, direction, from_address, folder, received_at, size_bytes) VALUES (?, 'mb-alice', 'inbound', 'sender@example.test', ?, ?, 100)`)
      .run(id, folder, at);
    return id;
  };
  const audits = () => sqlite.prepare('SELECT event_type, detail FROM audit_log ORDER BY rowid').all() as Array<{ event_type: string; detail: string }>;
  const jobs = () => sqlite.prepare('SELECT id, status, window_from, window_to, folders FROM standby_copyback_jobs').all() as Array<Record<string, unknown>>;
  return { d1, sqlite, env, fetch, addMessage, audits, jobs };
}

const act = (t: ReturnType<typeof setup>, action: Parameters<typeof applyCopyBackAction>[2], input: Record<string, unknown> = {}, now = NOW) =>
  applyCopyBackAction(t.env, { id: 'manager-1' }, action, { ...WINDOW, ...input } as never, now, () => 'job-1');

describe('copy back to Exchange: input checks', () => {
  it('parses actions and rejects unknown ones', () => {
    expect(parseCopyBackAction('dry_run')).toBe('dry_run');
    expect(parseCopyBackAction('delete_everything')).toBeNull();
  });

  it('validates the window, scope and folders', () => {
    const now = NOW.getTime();
    expect(parseCopyBackParams({ ...WINDOW }, now)).toEqual({ ok: true, params: { from: '2026-11-14 00:00:00', to: '2026-11-14 12:00:00', target: null, folders: ['inbox'] } });
    expect(parseCopyBackParams({ ...WINDOW, to: '2026-11-13T00:00' }, now)).toMatchObject({ ok: false });
    expect(parseCopyBackParams({ ...WINDOW, from: 'yesterday' }, now)).toMatchObject({ ok: false });
    expect(parseCopyBackParams({ ...WINDOW, to: '2026-11-16T00:00' }, now)).toMatchObject({ ok: false, error: expect.stringContaining('future') });
    expect(parseCopyBackParams({ ...WINDOW, from: '2026-09-01T00:00' }, now)).toMatchObject({ ok: false });
    expect(parseCopyBackParams({ ...WINDOW, target: "x' OR 1=1" }, now)).toMatchObject({ ok: false });
    expect(parseCopyBackParams({ ...WINDOW, folders: ['drafts', 'trash'] }, now)).toMatchObject({ ok: false });
    expect(parseCopyBackParams({ ...WINDOW, folders: ['sent', 'inbox', 'sent', 'drafts'] }, now))
      .toMatchObject({ ok: true, params: { folders: ['inbox', 'sent'] } });
  });
});

describe('copy back to Exchange admin', () => {
  it('is off by default and turning on needs the Worker settings', async () => {
    const t = setup({ configured: false, problems: ['M365_COPYBACK_CLIENT_SECRET is not set (wrangler secret put)'] });
    expect(await loadCopyBackSwitch(t.d1)).toEqual({ enabled: false });
    const overview = await loadCopyBackOverview(t.env);
    expect(overview.config).toEqual({ state: 'not_configured', problems: ['M365_COPYBACK_CLIENT_SECRET is not set (wrangler secret put)'] });
    expect(t.fetch).toHaveBeenCalledWith('https://cmail-email-worker.internal/internal/copy-back/config', expect.objectContaining({ method: 'GET' }));
    expect(await act(t, 'enable')).toMatchObject({ ok: false, status: 409 });
    expect((await loadCopyBackSwitch(t.d1)).enabled).toBe(false);
  });

  it('dry run counts only, changes nothing and is audited', async () => {
    const t = setup();
    t.addMessage('2026-11-14 01:00:00');
    t.addMessage('2026-11-14 02:00:00');
    t.addMessage('2026-11-13 23:59:59');
    t.addMessage('2026-11-14 03:00:00', 'drafts');
    const result = await act(t, 'dry_run');
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('2 of 2') });
    expect(t.jobs()).toHaveLength(0);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM standby_copyback_items').get()).toEqual({ n: 0 });
    const overview = await loadCopyBackOverview(t.env);
    expect(overview.lastDryRun?.counts).toMatchObject({ selected: 2, toCopy: 2, mailboxes: 1, alreadyCopied: 0, unlinked: 0 });
    expect(overview.mailboxes).toEqual([{ objectId: ALICE, address: 'alice@example.test' }]);
    expect(t.audits().map((row) => row.event_type)).toEqual(['org.copyback_dry_run']);
    // Counts and window only: no addresses or subjects in the audit detail.
    expect(t.audits()[0]!.detail).not.toContain('@');
  });

  it('start needs the switch, a confirmation and a matching recent dry run', async () => {
    const t = setup();
    t.addMessage('2026-11-14 01:00:00');
    expect(await act(t, 'start', { confirm: 'yes' })).toMatchObject({ ok: false, error: expect.stringContaining('on first') });
    expect(await act(t, 'enable')).toMatchObject({ ok: true });
    expect(await act(t, 'start', { confirm: 'yes' })).toMatchObject({ ok: false, error: expect.stringContaining('dry run') });
    await act(t, 'dry_run');
    expect(await act(t, 'start')).toMatchObject({ ok: false, error: expect.stringContaining('confirm') });
    expect(await act(t, 'start', { confirm: 'yes', to: '2026-11-14T11:00' })).toMatchObject({ ok: false, error: expect.stringContaining('dry run') });
    expect(await act(t, 'start', { confirm: 'yes' }, new Date(NOW.getTime() + 25 * 60 * 60 * 1000))).toMatchObject({ ok: false, error: expect.stringContaining('24 hours') });
    expect(await act(t, 'start', { confirm: 'yes' })).toMatchObject({ ok: true });
    expect(t.jobs()).toEqual([{ id: 'job-1', status: 'running', window_from: '2026-11-14 00:00:00', window_to: '2026-11-14 12:00:00', folders: 'inbox' }]);
    // Only one job at a time.
    expect(await act(t, 'start', { confirm: 'yes' })).toMatchObject({ ok: false, status: 409 });
    expect(t.audits().map((row) => row.event_type)).toEqual(['org.copyback_toggled', 'org.copyback_dry_run', 'org.copyback_started']);
  });

  it('refuses to start when everything selected was already handled', async () => {
    const t = setup();
    const id = t.addMessage('2026-11-14 01:00:00');
    t.sqlite.prepare(`INSERT INTO standby_copyback_items (message_id, target_object_id, state, job_id) VALUES (?, ?, 'pending', 'old')`).run(id, ALICE);
    t.sqlite.prepare(`UPDATE standby_copyback_items SET state = 'copied'`).run();
    await act(t, 'enable');
    await act(t, 'dry_run');
    expect(await act(t, 'start', { confirm: 'yes' })).toMatchObject({ ok: false, error: expect.stringContaining('Nothing to copy') });
  });

  it('cancel stops the running job; retry failed resets only failed items and reopens the job', async () => {
    const t = setup();
    const a = t.addMessage('2026-11-14 01:00:00');
    const b = t.addMessage('2026-11-14 02:00:00');
    await act(t, 'enable');
    await act(t, 'dry_run');
    await act(t, 'start', { confirm: 'yes' });
    t.sqlite.prepare(`INSERT INTO standby_copyback_items (message_id, target_object_id, state, job_id) VALUES (?, ?, 'pending', 'job-1'), (?, ?, 'pending', 'job-1')`).run(a, ALICE, b, ALICE);
    t.sqlite.prepare(`UPDATE standby_copyback_items SET state = 'copied' WHERE message_id = ?`).run(a);
    t.sqlite.prepare(`UPDATE standby_copyback_items SET state = 'failed', attempts = 6, next_attempt_at = NULL, reason = 'rejected' WHERE message_id = ?`).run(b);
    t.sqlite.prepare(`UPDATE standby_copyback_jobs SET status = 'done', plan_done = 1`).run();

    const overview = await loadCopyBackOverview(t.env);
    expect(overview.job?.progress).toMatchObject({ selected: 2, copied: 1, failed: 1, failedFinal: 1 });
    expect(overview.job?.problems).toEqual([{ mailbox: 'alice@example.test', state: 'failed', reason: 'rejected', count: 1 }]);

    expect(await act(t, 'retry_failed')).toMatchObject({ ok: true });
    expect(t.sqlite.prepare('SELECT message_id, state, attempts FROM standby_copyback_items ORDER BY message_id').all())
      .toEqual([{ message_id: a, state: 'copied', attempts: 0 }, { message_id: b, state: 'pending', attempts: 0 }]);
    expect(t.jobs()[0]).toMatchObject({ status: 'running' });
    expect(await act(t, 'cancel')).toMatchObject({ ok: true });
    expect(t.jobs()[0]).toMatchObject({ status: 'cancelled' });
    expect(await act(t, 'cancel')).toMatchObject({ ok: false, status: 409 });
    expect(await act(t, 'retry_failed')).toMatchObject({ ok: false });
  });
});
