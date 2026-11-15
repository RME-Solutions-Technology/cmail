// Applies classified Microsoft 365 directory objects to cmail. The rules are
// in docs/m365-sync.md, "What the sync changes in cmail". In short:
// - Keyed on the Entra object id (m365_sync_links), never on an address.
// - New in-scope people get a pending standard account and a personal
//   mailbox; an existing standard account with the same address is adopted.
// - Leaving scope (disabled, unlicensed, deleted, removed from the scope
//   group) pauses the account once, on that change. Pauses are queued and
//   applied only after the mass-pause brake check (sync.ts). Nothing is
//   deleted.
// - Coming back resumes only an account the sync itself paused and nobody
//   has touched since (the 0022 trigger clears the mark on any status change).
// - Managers are never created, adopted, paused, resumed or edited, and an
//   offboarded account is never edited.
// - Shared mailboxes come only from the explicit shared-mailbox group, and
//   are created or adopted, never disabled.
// - Dry run reads the same data and reports the same decisions, but writes
//   nothing except the link bookkeeping column `seen_round`.
// Every change is one D1 batch with its audit row. Status changes are
// conditional on the status the sync read, and the audit row and link mark
// are conditional on the change having landed, so a concurrent manager
// action is never overwritten. A unique-key clash becomes a reported conflict.
import { pausedAccountLockoutStatements } from '@cmail/shared/account-lockout';
import {
  M365_REPORT_LIMIT,
  type M365CountKey,
  type M365PendingEntry,
  type M365QueuedPause,
  type M365Round,
} from '@cmail/shared/m365-sync';

interface LinkRow {
  object_id: string;
  kind: 'person' | 'shared';
  user_id: string | null;
  mailbox_id: string | null;
  source_state: 'in_scope' | 'out_of_scope';
  paused_by_sync: number;
  status_before_pause: 'pending' | 'active' | null;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: 'standard' | 'manager';
  status: 'pending' | 'active' | 'paused' | 'offboarded';
  updated_at: string;
}

interface MailboxRow {
  id: string;
  address: string;
  type: 'personal' | 'shared';
  owner_user_id: string | null;
}

export interface ApplyContext {
  db: D1Database;
  round: M365Round;
  /** D1 statements issued so far in this run (reads and writes). */
  ops: number;
  newId: () => string;
  /** Wall clock, for the change marker written to users.updated_at. */
  now: () => number;
}

/** D1 allows at most 100 bound parameters per statement. */
const IN_CHUNK = 90;

function record(ctx: ApplyContext, count: M365CountKey, item?: { action: string; address: string; reason: string }) {
  ctx.round.counts[count] = (ctx.round.counts[count] ?? 0) + 1;
  if (item && ctx.round.report.length < M365_REPORT_LIMIT) ctx.round.report.push(item);
}

function auditStatement(db: D1Database, eventType: string, target: string, detail: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
     VALUES (?, datetime('now'), NULL, 'system', ?, ?, ?)`,
  ).bind(crypto.randomUUID(), eventType, target.slice(0, 256), detail.slice(0, 1000));
}

/**
 * The same audit row, written only if this batch's status change landed:
 * the sync stamps users.updated_at with `marker` (millisecond precision, which
 * datetime('now') elsewhere never produces), and the row is inserted only
 * while that stamp is still there.
 */
function markedAuditStatement(db: D1Database, eventType: string, userId: string, marker: string, detail: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
     SELECT ?, datetime('now'), NULL, 'system', ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND updated_at = ?)`,
  ).bind(crypto.randomUUID(), eventType, userId.slice(0, 256), detail.slice(0, 1000), userId, marker);
}

/** A users.updated_at value unique to one sync write: 'YYYY-MM-DD HH:MM:SS.mmm' plus a random suffix. */
function changeMarker(ctx: ApplyContext): string {
  const base = new Date(ctx.now()).toISOString().replace('T', ' ').replace('Z', '');
  return `${base}${crypto.randomUUID().slice(0, 8)}`;
}

async function runBatch(ctx: ApplyContext, statements: D1PreparedStatement[]): Promise<boolean> {
  ctx.ops += statements.length;
  try {
    await ctx.db.batch(statements);
    return true;
  } catch {
    // Unique keys and triggers are the final word: a clash means someone
    // else (a sign-in, a manager, another object) got there first.
    return false;
  }
}

async function markerLanded(ctx: ApplyContext, userId: string, marker: string): Promise<boolean> {
  ctx.ops += 1;
  return Boolean(await ctx.db.prepare('SELECT 1 AS found FROM users WHERE id = ? AND updated_at = ?').bind(userId, marker).first());
}

async function loadLinks(ctx: ApplyContext, ids: string[]): Promise<Map<string, LinkRow>> {
  const links = new Map<string, LinkRow>();
  for (let start = 0; start < ids.length; start += IN_CHUNK) {
    const slice = ids.slice(start, start + IN_CHUNK);
    ctx.ops += 1;
    const { results } = await ctx.db.prepare(
      `SELECT object_id, kind, user_id, mailbox_id, source_state, paused_by_sync, status_before_pause
       FROM m365_sync_links WHERE object_id IN (${slice.map(() => '?').join(', ')})`,
    ).bind(...slice).all<LinkRow>();
    for (const row of results ?? []) links.set(row.object_id, row);
  }
  return links;
}

async function markSeen(ctx: ApplyContext, ids: string[]): Promise<void> {
  if (ctx.round.kind !== 'reconcile') return;
  for (let start = 0; start < ids.length; start += IN_CHUNK) {
    const slice = ids.slice(start, start + IN_CHUNK);
    ctx.ops += 1;
    await ctx.db.prepare(
      `UPDATE m365_sync_links SET seen_round = ? WHERE object_id IN (${slice.map(() => '?').join(', ')})`,
    ).bind(ctx.round.id, ...slice).run();
  }
}

async function userById(ctx: ApplyContext, id: string): Promise<UserRow | null> {
  ctx.ops += 1;
  return ctx.db.prepare('SELECT id, email, display_name, role, status, updated_at FROM users WHERE id = ?').bind(id).first<UserRow>();
}

async function userByEmail(ctx: ApplyContext, email: string): Promise<UserRow | null> {
  ctx.ops += 1;
  return ctx.db.prepare('SELECT id, email, display_name, role, status, updated_at FROM users WHERE lower(email) = ? LIMIT 1')
    .bind(email).first<UserRow>();
}

async function mailboxByAddress(ctx: ApplyContext, address: string): Promise<MailboxRow | null> {
  ctx.ops += 1;
  return ctx.db.prepare('SELECT id, address, type, owner_user_id FROM mailboxes WHERE lower(address) = ? LIMIT 1')
    .bind(address).first<MailboxRow>();
}

async function linkedObjectForUser(ctx: ApplyContext, userId: string): Promise<boolean> {
  ctx.ops += 1;
  return Boolean(await ctx.db.prepare('SELECT 1 AS found FROM m365_sync_links WHERE user_id = ?').bind(userId).first());
}

async function linkedObjectForMailbox(ctx: ApplyContext, mailboxId: string): Promise<boolean> {
  ctx.ops += 1;
  return Boolean(await ctx.db.prepare('SELECT 1 AS found FROM m365_sync_links WHERE mailbox_id = ?').bind(mailboxId).first());
}

const live = (ctx: ApplyContext) => ctx.round.mode === 'live';

function linkStateStatement(db: D1Database, objectId: string, sourceState: 'in_scope' | 'out_of_scope', reason: string) {
  return db.prepare(
    `UPDATE m365_sync_links SET source_state = ?, last_reason = ?, updated_at = datetime('now') WHERE object_id = ?`,
  ).bind(sourceState, reason.slice(0, 64), objectId);
}

async function conflict(ctx: ApplyContext, entry: { address: string }, reason: string) {
  record(ctx, 'conflicts', { action: 'conflict', address: entry.address, reason });
}

function dequeuePause(ctx: ApplyContext, id: string) {
  if (ctx.round.pauseQueue.some((item) => item.id === id)) {
    ctx.round.pauseQueue = ctx.round.pauseQueue.filter((item) => item.id !== id);
  }
}

// ─── People ──────────────────────────────────────────────────────────────

/**
 * Decides what leaving scope means for a linked person. A pause is only
 * queued here; applyQueuedPause makes it after the brake check.
 */
async function personOut(ctx: ApplyContext, entry: M365PendingEntry, link: LinkRow, reason: string) {
  if (link.source_state === 'out_of_scope') {
    // Already handled when it left scope. A manager may since have
    // reactivated the account by hand; that choice stands.
    record(ctx, 'unchanged');
    return;
  }
  const user = link.user_id ? await userById(ctx, link.user_id) : null;
  if (!user) {
    record(ctx, 'unchanged');
    return;
  }
  if (user.role === 'manager') {
    record(ctx, 'conflicts', { action: 'conflict', address: entry.address || user.email, reason: 'manager_not_paused' });
    if (live(ctx)) await runBatch(ctx, [linkStateStatement(ctx.db, link.object_id, 'out_of_scope', reason)]);
    return;
  }
  if (user.status !== 'pending' && user.status !== 'active') {
    record(ctx, 'unchanged');
    if (live(ctx)) await runBatch(ctx, [linkStateStatement(ctx.db, link.object_id, 'out_of_scope', reason)]);
    return;
  }
  dequeuePause(ctx, link.object_id);
  ctx.round.pauseQueue.push({ id: link.object_id, address: (entry.address || user.email).slice(0, 254), reason: reason.slice(0, 64) });
}

/** Applies (live) or reports (dry run) one queued pause, re-checking cmail first. */
export async function applyQueuedPause(ctx: ApplyContext, item: M365QueuedPause): Promise<void> {
  const links = await loadLinks(ctx, [item.id]);
  const link = links.get(item.id);
  const user = link?.kind === 'person' && link.user_id ? await userById(ctx, link.user_id) : null;
  if (!link || !user || link.source_state === 'out_of_scope' || user.role !== 'standard'
    || (user.status !== 'pending' && user.status !== 'active')) {
    record(ctx, 'unchanged');
    return;
  }
  if (!live(ctx)) {
    record(ctx, 'paused', { action: 'pause', address: item.address, reason: item.reason });
    return;
  }
  const marker = changeMarker(ctx);
  const ok = await runBatch(ctx, [
    // Only from the status the sync read: a concurrent manager change wins.
    ctx.db.prepare(
      `UPDATE users SET status = 'paused', updated_at = ?
       WHERE id = ? AND role = 'standard' AND status = ?`,
    ).bind(marker, user.id, user.status),
    // The mark, the earlier status and the audit row land only with that change.
    ctx.db.prepare(
      `UPDATE m365_sync_links
       SET paused_by_sync = 1, status_before_pause = ?, updated_at = datetime('now')
       WHERE object_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND updated_at = ? AND status = 'paused')`,
    ).bind(user.status, link.object_id, user.id, marker),
    ...pausedAccountLockoutStatements(ctx.db, user.id),
    linkStateStatement(ctx.db, link.object_id, 'out_of_scope', item.reason),
    markedAuditStatement(ctx.db, 'm365_sync.user_paused', user.id, marker, `Paused by Microsoft 365 sync: ${item.reason}`),
  ]);
  if (ok && await markerLanded(ctx, user.id, marker)) {
    record(ctx, 'paused', { action: 'pause', address: item.address, reason: item.reason });
  } else {
    await conflict(ctx, item, 'changed_concurrently');
  }
}

async function personIn(ctx: ApplyContext, entry: M365PendingEntry, link: LinkRow) {
  dequeuePause(ctx, link.object_id);
  const user = link.user_id ? await userById(ctx, link.user_id) : null;
  if (!user || user.status === 'offboarded' || user.role !== 'standard') {
    // An offboarded account is a manager's closed record, and managers are
    // never edited by the sync.
    record(ctx, 'unchanged');
    if (live(ctx) && link.source_state === 'out_of_scope') {
      await runBatch(ctx, [linkStateStatement(ctx.db, link.object_id, 'in_scope', '')]);
    }
    return;
  }

  // Resume: only an account the sync paused and nobody has touched since.
  if (link.source_state === 'out_of_scope' && link.paused_by_sync && user.status === 'paused') {
    const restore = link.status_before_pause ?? 'pending';
    if (!live(ctx)) {
      record(ctx, 'resumed', { action: 'resume', address: entry.address, reason: 'back_in_scope' });
    } else {
      const marker = changeMarker(ctx);
      const ok = await runBatch(ctx, [
        ctx.db.prepare(
          `UPDATE users SET status = ?, updated_at = ?
           WHERE id = ? AND status = 'paused' AND role = 'standard'
             AND EXISTS (SELECT 1 FROM m365_sync_links WHERE user_id = ? AND paused_by_sync = 1)`,
        ).bind(restore, marker, user.id, user.id),
        markedAuditStatement(ctx.db, 'm365_sync.user_resumed', user.id, marker, `Resumed by Microsoft 365 sync (status ${restore}); sign-in is needed again`),
      ]);
      if (ok && await markerLanded(ctx, user.id, marker)) {
        record(ctx, 'resumed', { action: 'resume', address: entry.address, reason: 'back_in_scope' });
      } else {
        await conflict(ctx, entry, 'changed_concurrently');
      }
    }
  }

  const statements: D1PreparedStatement[] = [];
  let changed = false;
  if (link.source_state === 'out_of_scope') {
    statements.push(
      ctx.db.prepare(
        `UPDATE m365_sync_links SET source_state = 'in_scope', last_reason = '', paused_by_sync = 0, status_before_pause = NULL,
           updated_at = datetime('now') WHERE object_id = ?`,
      ).bind(link.object_id),
    );
  }

  if (user.email.toLowerCase() !== entry.address) {
    const [owner, mailbox] = await Promise.all([userByEmail(ctx, entry.address), mailboxByAddress(ctx, entry.address)]);
    if ((owner && owner.id !== user.id) || (mailbox && !(mailbox.type === 'personal' && mailbox.owner_user_id === user.id))) {
      await conflict(ctx, entry, 'address_in_use');
    } else {
      record(ctx, 'updated', { action: 'update_address', address: entry.address, reason: 'primary_address_changed' });
      statements.push(
        ctx.db.prepare(`UPDATE users SET email = ?, updated_at = datetime('now') WHERE id = ? AND role = 'standard' AND status <> 'offboarded'`)
          .bind(entry.address, user.id),
        // Only the mailbox that carried the old address follows it; a
        // mailbox a manager named differently stays as it is.
        ctx.db.prepare(
          `UPDATE mailboxes SET address = ? WHERE owner_user_id = ? AND type = 'personal' AND lower(address) = ?`,
        ).bind(entry.address, user.id, user.email.toLowerCase()),
        auditStatement(ctx.db, 'm365_sync.user_updated', user.id, 'Primary address changed in Microsoft 365; account and matching personal mailbox address updated'),
      );
      changed = true;
    }
  }

  if (entry.displayName && entry.displayName !== user.display_name) {
    if (!changed) record(ctx, 'updated', { action: 'update_name', address: entry.address, reason: 'display_name_changed' });
    statements.push(
      ctx.db.prepare(`UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ? AND role = 'standard' AND status <> 'offboarded'`)
        .bind(entry.displayName, user.id),
      auditStatement(ctx.db, 'm365_sync.user_updated', user.id, 'Display name changed in Microsoft 365; account display name updated'),
    );
    changed = true;
  }

  if (!changed) record(ctx, 'unchanged');
  if (!live(ctx) || !statements.length) return;
  if (!await runBatch(ctx, statements)) await conflict(ctx, entry, 'write_conflict');
}

async function personNew(ctx: ApplyContext, entry: M365PendingEntry) {
  const existing = await userByEmail(ctx, entry.address);
  if (existing) {
    if (existing.role !== 'standard') return conflict(ctx, entry, 'manager_not_adopted');
    if (existing.status !== 'pending' && existing.status !== 'active') return conflict(ctx, entry, 'account_paused_or_offboarded');
    if (await linkedObjectForUser(ctx, existing.id)) return conflict(ctx, entry, 'duplicate_source_object');
    record(ctx, 'adopted', { action: 'adopt', address: entry.address, reason: 'existing_account' });
    if (!live(ctx)) return;
    const ok = await runBatch(ctx, [
      ctx.db.prepare(
        `INSERT INTO m365_sync_links (object_id, kind, user_id, source_state, seen_round) VALUES (?, 'person', ?, 'in_scope', ?)`,
      ).bind(entry.id, existing.id, ctx.round.id),
      auditStatement(ctx.db, 'm365_sync.user_adopted', existing.id, 'Linked an existing standard account to its Microsoft 365 user'),
    ]);
    if (!ok) await conflict(ctx, entry, 'write_conflict');
    return;
  }
  if (await mailboxByAddress(ctx, entry.address)) return conflict(ctx, entry, 'address_in_use');

  record(ctx, 'created', { action: 'create', address: entry.address, reason: 'new_in_scope' });
  if (!live(ctx)) return;
  const userId = ctx.newId();
  const mailboxId = ctx.newId();
  const localPart = entry.address.split('@')[0];
  const ok = await runBatch(ctx, [
    ctx.db.prepare(
      `INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'standard', 'pending', datetime('now'), datetime('now'))`,
    ).bind(userId, entry.address, entry.displayName),
    ctx.db.prepare(
      `INSERT INTO mailboxes (id, address, display_name, type, status, owner_user_id, created_at)
       VALUES (?, ?, ?, 'personal', 'active', ?, datetime('now'))`,
    ).bind(mailboxId, entry.address, entry.displayName || localPart, userId),
    ctx.db.prepare(
      `INSERT INTO mailbox_assignments (mailbox_id, user_id, permissions, assigned_at, assigned_by)
       VALUES (?, ?, 'full', datetime('now'), NULL)`,
    ).bind(mailboxId, userId),
    ctx.db.prepare(
      `INSERT INTO m365_sync_links (object_id, kind, user_id, source_state, seen_round) VALUES (?, 'person', ?, 'in_scope', ?)`,
    ).bind(entry.id, userId, ctx.round.id),
    auditStatement(ctx.db, 'user.provisioned', userId, 'Provisioned pending standard account from Microsoft 365 sync'),
    auditStatement(ctx.db, 'mailbox.created', mailboxId, 'Provisioned personal mailbox with full owner assignment (Microsoft 365 sync)'),
  ]);
  if (!ok) await conflict(ctx, entry, 'write_conflict');
}

// ─── Shared mailboxes ────────────────────────────────────────────────────

async function sharedNew(ctx: ApplyContext, entry: M365PendingEntry) {
  const mailbox = await mailboxByAddress(ctx, entry.address);
  if (mailbox) {
    if (mailbox.type !== 'shared') return conflict(ctx, entry, 'address_is_personal_mailbox');
    if (await linkedObjectForMailbox(ctx, mailbox.id)) return conflict(ctx, entry, 'duplicate_source_object');
    record(ctx, 'adopted', { action: 'adopt_shared', address: entry.address, reason: 'existing_shared_mailbox' });
    if (!live(ctx)) return;
    const ok = await runBatch(ctx, [
      ctx.db.prepare(
        `INSERT INTO m365_sync_links (object_id, kind, mailbox_id, source_state, seen_round) VALUES (?, 'shared', ?, 'in_scope', ?)`,
      ).bind(entry.id, mailbox.id, ctx.round.id),
      auditStatement(ctx.db, 'm365_sync.shared_adopted', mailbox.id, 'Linked an existing shared mailbox to its Microsoft 365 object'),
    ]);
    if (!ok) await conflict(ctx, entry, 'write_conflict');
    return;
  }
  if (await userByEmail(ctx, entry.address)) return conflict(ctx, entry, 'address_is_an_account');
  record(ctx, 'sharedCreated', { action: 'create_shared', address: entry.address, reason: 'in_shared_group' });
  if (!live(ctx)) return;
  const mailboxId = ctx.newId();
  const ok = await runBatch(ctx, [
    ctx.db.prepare(
      `INSERT INTO mailboxes (id, address, display_name, type, status, owner_user_id, created_at)
       VALUES (?, ?, ?, 'shared', 'active', NULL, datetime('now'))`,
    ).bind(mailboxId, entry.address, entry.displayName || entry.address.split('@')[0]),
    ctx.db.prepare(
      `INSERT INTO m365_sync_links (object_id, kind, mailbox_id, source_state, seen_round) VALUES (?, 'shared', ?, 'in_scope', ?)`,
    ).bind(entry.id, mailboxId, ctx.round.id),
    auditStatement(ctx.db, 'mailbox.created', mailboxId, 'Created shared mailbox from Microsoft 365 sync; no one is assigned yet'),
  ]);
  if (!ok) await conflict(ctx, entry, 'write_conflict');
}

async function sharedLinked(ctx: ApplyContext, entry: M365PendingEntry, link: LinkRow) {
  if (entry.kind !== 'shared') {
    // Shared mailboxes are never disabled by the sync: that would bounce mail.
    if (link.source_state === 'in_scope') {
      record(ctx, 'unchanged', { action: 'left_source_kept', address: entry.address, reason: entry.reason || 'not_in_shared_group' });
      if (live(ctx)) await runBatch(ctx, [linkStateStatement(ctx.db, link.object_id, 'out_of_scope', entry.reason || 'not_in_shared_group')]);
    } else {
      record(ctx, 'unchanged');
    }
    return;
  }
  const statements: D1PreparedStatement[] = [];
  if (link.source_state === 'out_of_scope') statements.push(linkStateStatement(ctx.db, link.object_id, 'in_scope', ''));
  ctx.ops += 1;
  const mailbox = link.mailbox_id
    ? await ctx.db.prepare('SELECT id, address, type, owner_user_id FROM mailboxes WHERE id = ?').bind(link.mailbox_id).first<MailboxRow>()
    : null;
  if (mailbox && mailbox.address.toLowerCase() !== entry.address) {
    const [taken, account] = await Promise.all([mailboxByAddress(ctx, entry.address), userByEmail(ctx, entry.address)]);
    if (taken || account) {
      await conflict(ctx, entry, 'address_in_use');
    } else {
      record(ctx, 'updated', { action: 'update_address', address: entry.address, reason: 'primary_address_changed' });
      statements.push(
        ctx.db.prepare(`UPDATE mailboxes SET address = ? WHERE id = ? AND type = 'shared'`).bind(entry.address, mailbox.id),
        auditStatement(ctx.db, 'm365_sync.shared_updated', mailbox.id, 'Primary address changed in Microsoft 365; shared mailbox address updated'),
      );
    }
  } else {
    record(ctx, 'unchanged');
  }
  if (live(ctx) && statements.length && !await runBatch(ctx, statements)) await conflict(ctx, entry, 'write_conflict');
}

// ─── Entry point ─────────────────────────────────────────────────────────

export async function applyEntries(ctx: ApplyContext, entries: M365PendingEntry[]): Promise<void> {
  const links = await loadLinks(ctx, entries.map((entry) => entry.id));
  for (const entry of entries) {
    const link = links.get(entry.id) ?? null;
    if (link?.kind === 'shared') {
      await sharedLinked(ctx, entry, link);
    } else if (link) {
      if (entry.kind === 'person') await personIn(ctx, entry, link);
      else if (entry.kind === 'shared') await personOut(ctx, entry, link, 'in_shared_group');
      else await personOut(ctx, entry, link, entry.reason);
    } else if (entry.kind === 'person') {
      await personNew(ctx, entry);
    } else if (entry.kind === 'shared') {
      await sharedNew(ctx, entry);
    } else {
      record(ctx, 'ignored');
    }
  }
  // Bookkeeping, also in dry run: which links this reconciliation has seen.
  await markSeen(ctx, entries.filter((entry) => links.has(entry.id)).map((entry) => entry.id));
}

/** Reconciliation sweep: linked objects the full enumeration never returned. */
export async function sweepUnseen(ctx: ApplyContext, limit: number): Promise<number> {
  ctx.ops += 1;
  const { results } = await ctx.db.prepare(
    `SELECT object_id FROM m365_sync_links WHERE seen_round <> ? AND source_state = 'in_scope' ORDER BY object_id LIMIT ?`,
  ).bind(ctx.round.id, limit).all<{ object_id: string }>();
  const ids = (results ?? []).map((row) => row.object_id);
  if (!ids.length) return 0;
  await applyEntries(ctx, ids.map((id) => ({ id, kind: 'out', address: '', displayName: '', reason: 'not_seen' })));
  return ids.length;
}

/** People currently linked and in scope: the base for the mass-pause brake. */
export async function linkedPeopleInScope(ctx: ApplyContext): Promise<number> {
  ctx.ops += 1;
  const row = await ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM m365_sync_links WHERE kind = 'person' AND source_state = 'in_scope'`,
  ).first<{ n: number }>();
  return Number(row?.n ?? 0);
}
