// D1 reads and guarded writes for shared mailbox access. Every write is one
// batch with its audit row, and every statement re-checks what the diff read:
// - add: only if no assignment row exists for that person and mailbox (a
//   manager's row, even one added a moment ago, wins), the mailbox is shared
//   and the account is active or pending;
// - level change and remove: only while the row still carries the sync's
//   marker, level and no assigned_by, and the ledger agrees;
// - the audit row lands only with the change.
// A write that matched nothing is counted as changedConcurrently. Personal
// mailboxes are never written (the 0006 triggers would refuse anyway).
import type { M365PermsRound } from '@cmail/shared/m365-perms';
import { M365_PERMS_REPORT_LIMIT } from '@cmail/shared/m365-perms';
import { key, type CmailLevel, type DiffOp, type LedgerRow, type LiveAssignment, type PersonLink, type SharedLink } from './diff';

export interface PermsApplyContext {
  db: D1Database;
  round: M365PermsRound;
  /** D1 statements issued in this run. */
  ops: number;
  now: () => number;
}

const LEVELS: ReadonlySet<string> = new Set(['read', 'send-as', 'full']);
const IN_CHUNK = 90;

/**
 * A mailbox_assignments.assigned_at value for one sync write: a valid SQLite
 * datetime with milliseconds. Every other writer uses datetime('now'), which
 * has no fraction, so the two never compare equal.
 */
export function syncMarker(now: number): string {
  return new Date(now).toISOString().replace('T', ' ').replace('Z', '');
}

export async function loadSharedLinks(ctx: PermsApplyContext): Promise<Map<string, SharedLink>> {
  ctx.ops += 1;
  const { results } = await ctx.db.prepare(
    `SELECT l.object_id, m.id AS mailbox_id, lower(m.address) AS address
     FROM m365_sync_links l JOIN mailboxes m ON m.id = l.mailbox_id
     WHERE l.kind = 'shared' AND m.type = 'shared'`,
  ).all<{ object_id: string; mailbox_id: string; address: string }>();
  return new Map((results ?? []).map((row) => [row.object_id.toLowerCase(), { mailboxId: row.mailbox_id, address: row.address }]));
}

export async function loadPersonLinks(ctx: PermsApplyContext): Promise<Map<string, PersonLink>> {
  ctx.ops += 1;
  const { results } = await ctx.db.prepare(
    `SELECT l.object_id, u.id AS user_id, lower(u.email) AS email, u.status, l.source_state
     FROM m365_sync_links l JOIN users u ON u.id = l.user_id
     WHERE l.kind = 'person'`,
  ).all<{ object_id: string; user_id: string; email: string; status: string; source_state: string }>();
  return new Map((results ?? []).map((row) => [row.object_id.toLowerCase(), {
    userId: row.user_id,
    email: row.email,
    eligible: row.source_state === 'in_scope' && (row.status === 'active' || row.status === 'pending'),
  }]));
}

/** Assignments on linked shared mailboxes only. */
export async function loadAssignments(ctx: PermsApplyContext): Promise<Map<string, LiveAssignment>> {
  ctx.ops += 1;
  const { results } = await ctx.db.prepare(
    `SELECT a.mailbox_id, a.user_id, a.permissions, a.assigned_at, a.assigned_by
     FROM mailbox_assignments a
     JOIN m365_sync_links l ON l.mailbox_id = a.mailbox_id AND l.kind = 'shared'
     JOIN mailboxes m ON m.id = a.mailbox_id AND m.type = 'shared'`,
  ).all<{ mailbox_id: string; user_id: string; permissions: string; assigned_at: string; assigned_by: string | null }>();
  const map = new Map<string, LiveAssignment>();
  for (const row of results ?? []) {
    if (!LEVELS.has(row.permissions)) continue;
    map.set(key(row.mailbox_id, row.user_id), { permissions: row.permissions as CmailLevel, assignedAt: row.assigned_at, assignedBy: row.assigned_by ?? null });
  }
  return map;
}

export async function loadLedger(ctx: PermsApplyContext): Promise<Map<string, LedgerRow>> {
  ctx.ops += 1;
  const { results } = await ctx.db.prepare(
    'SELECT mailbox_id, user_id, level_written, assigned_at_written FROM m365_perm_ledger',
  ).all<{ mailbox_id: string; user_id: string; level_written: string; assigned_at_written: string }>();
  const map = new Map<string, LedgerRow>();
  for (const row of results ?? []) {
    if (!LEVELS.has(row.level_written)) continue;
    map.set(key(row.mailbox_id, row.user_id), { level: row.level_written as CmailLevel, assignedAt: row.assigned_at_written });
  }
  return map;
}

export async function loadGroupMembers(ctx: PermsApplyContext, roundId: string): Promise<Map<string, Set<string>>> {
  ctx.ops += 1;
  const { results } = await ctx.db.prepare(
    'SELECT group_id, member_id FROM m365_perm_group_members WHERE round_id = ?',
  ).bind(roundId).all<{ group_id: string; member_id: string }>();
  const map = new Map<string, Set<string>>();
  for (const row of results ?? []) {
    const set = map.get(row.group_id) ?? new Set<string>();
    set.add(row.member_id.toLowerCase());
    map.set(row.group_id, set);
  }
  return map;
}

/** Stores one expanded group (an empty group gets no rows but is still known by the round). */
export async function saveGroupMembers(ctx: PermsApplyContext, roundId: string, groupId: string, members: string[]): Promise<void> {
  const rowsPerStatement = Math.floor(IN_CHUNK / 3);
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < members.length; start += rowsPerStatement) {
    const slice = members.slice(start, start + rowsPerStatement);
    statements.push(ctx.db.prepare(
      `INSERT OR IGNORE INTO m365_perm_group_members (round_id, group_id, member_id) VALUES ${slice.map(() => '(?, ?, ?)').join(', ')}`,
    ).bind(...slice.flatMap((member) => [roundId, groupId, member])));
  }
  for (let start = 0; start < statements.length; start += 50) {
    const chunk = statements.slice(start, start + 50);
    ctx.ops += chunk.length;
    await ctx.db.batch(chunk);
  }
}

export async function clearGroupMembers(db: D1Database, keepRoundId: string | null): Promise<void> {
  if (keepRoundId) await db.prepare('DELETE FROM m365_perm_group_members WHERE round_id <> ?').bind(keepRoundId).run();
  else await db.prepare('DELETE FROM m365_perm_group_members').run();
}

function audit(db: D1Database, eventType: string, mailboxId: string, detail: string, condition: { sql: string; args: unknown[] }): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
     SELECT ?, datetime('now'), NULL, 'system', ?, ?, ? WHERE ${condition.sql}`,
  ).bind(crypto.randomUUID(), eventType, mailboxId.slice(0, 256), detail.slice(0, 1000), ...condition.args);
}

function rightsText(rights: number): string {
  const parts = [];
  if (rights & 1) parts.push('Full Access');
  if (rights & 2) parts.push('Send As');
  return parts.join(' + ') || 'none';
}

function record(ctx: PermsApplyContext, op: DiffOp, landed: boolean) {
  const counts = ctx.round.counts;
  if (!landed) {
    counts.changedConcurrently += 1;
    if (ctx.round.report.length < M365_PERMS_REPORT_LIMIT) ctx.round.report.push({ action: 'conflict', mailbox: op.mailbox, user: op.user, reason: 'changed_concurrently' });
    return;
  }
  if (op.type === 'release') return;
  const countKey = op.type === 'add' ? 'added' : op.type === 'upgrade' ? 'upgraded' : op.type === 'downgrade' ? 'downgraded' : 'removed';
  counts[countKey] += 1;
  if (ctx.round.report.length < M365_PERMS_REPORT_LIMIT) {
    const reason = op.type === 'remove' ? `exchange_no_longer_grants_${op.from}` : `${'from' in op ? `${op.from}_to_` : ''}${op.level}`;
    ctx.round.report.push({ action: op.type, mailbox: op.mailbox, user: op.user, reason });
  }
}

/** Reports one op in dry run: no write at all. */
export function reportOp(ctx: PermsApplyContext, op: DiffOp): void {
  record(ctx, op, true);
}

/** Applies one op (live). Returns true when it landed. */
export async function applyOp(ctx: PermsApplyContext, op: DiffOp): Promise<boolean> {
  const db = ctx.db;
  const marker = syncMarker(ctx.now());
  let statements: D1PreparedStatement[];
  let landedCheck: { sql: string; args: unknown[] };
  /** Which statement's row count says the assignment change landed. */
  let changeIndex = 0;

  if (op.type === 'add') {
    landedCheck = {
      sql: 'EXISTS (SELECT 1 FROM mailbox_assignments WHERE mailbox_id = ? AND user_id = ? AND assigned_at = ? AND assigned_by IS NULL AND permissions = ?)',
      args: [op.mailboxId, op.userId, marker, op.level],
    };
    statements = [
      db.prepare(
        `INSERT INTO mailbox_assignments (user_id, mailbox_id, permissions, assigned_at, assigned_by)
         SELECT u.id, m.id, ?, ?, NULL
         FROM mailboxes m JOIN users u ON u.id = ?
         WHERE m.id = ? AND m.type = 'shared' AND u.status IN ('active', 'pending')
           AND NOT EXISTS (SELECT 1 FROM mailbox_assignments a WHERE a.mailbox_id = m.id AND a.user_id = u.id)`,
      ).bind(op.level, marker, op.userId, op.mailboxId),
      db.prepare(
        `INSERT INTO m365_perm_ledger (mailbox_id, user_id, level_written, assigned_at_written, exchange_rights, round_id, written_at)
         SELECT ?, ?, ?, ?, ?, ?, datetime('now') WHERE ${landedCheck.sql}
         ON CONFLICT(mailbox_id, user_id) DO UPDATE SET level_written = excluded.level_written,
           assigned_at_written = excluded.assigned_at_written, exchange_rights = excluded.exchange_rights,
           round_id = excluded.round_id, written_at = excluded.written_at`,
      ).bind(op.mailboxId, op.userId, op.level, marker, op.rights, ctx.round.id, ...landedCheck.args),
      audit(db, 'mailbox.assigned', op.mailboxId,
        `Granted ${op.level} access to account ${op.userId} (Microsoft 365 shared mailbox access sync; Exchange grants ${rightsText(op.rights)})`, landedCheck),
    ];
  } else if (op.type === 'upgrade' || op.type === 'downgrade') {
    // The ledger moves to the new marker first, so the update trigger keeps it.
    const ledgerMoved = 'EXISTS (SELECT 1 FROM m365_perm_ledger WHERE mailbox_id = ? AND user_id = ? AND assigned_at_written = ? AND level_written = ?)';
    landedCheck = {
      sql: 'EXISTS (SELECT 1 FROM mailbox_assignments WHERE mailbox_id = ? AND user_id = ? AND assigned_at = ? AND assigned_by IS NULL AND permissions = ?)',
      args: [op.mailboxId, op.userId, marker, op.level],
    };
    statements = [
      db.prepare(
        `UPDATE m365_perm_ledger SET level_written = ?, assigned_at_written = ?, exchange_rights = ?, round_id = ?, written_at = datetime('now')
         WHERE mailbox_id = ? AND user_id = ? AND level_written = ? AND assigned_at_written = ?
           AND EXISTS (SELECT 1 FROM mailbox_assignments a JOIN mailboxes m ON m.id = a.mailbox_id AND m.type = 'shared'
             WHERE a.mailbox_id = ? AND a.user_id = ? AND a.permissions = ? AND a.assigned_at = ? AND a.assigned_by IS NULL)`,
      ).bind(op.level, marker, op.rights, ctx.round.id, op.mailboxId, op.userId, op.from, op.marker, op.mailboxId, op.userId, op.from, op.marker),
      db.prepare(
        `UPDATE mailbox_assignments SET permissions = ?, assigned_at = ?
         WHERE mailbox_id = ? AND user_id = ? AND permissions = ? AND assigned_at = ? AND assigned_by IS NULL
           AND ${ledgerMoved}`,
      ).bind(op.level, marker, op.mailboxId, op.userId, op.from, op.marker, op.mailboxId, op.userId, marker, op.level),
      audit(db, 'mailbox.permission_changed', op.mailboxId,
        `Changed account ${op.userId} from ${op.from} to ${op.level} access (Microsoft 365 shared mailbox access sync; Exchange grants ${rightsText(op.rights)})`, landedCheck),
    ];
    changeIndex = 1;
  } else if (op.type === 'remove') {
    statements = [
      db.prepare(
        `DELETE FROM mailbox_assignments
         WHERE mailbox_id = ? AND user_id = ? AND permissions = ? AND assigned_at = ? AND assigned_by IS NULL
           AND EXISTS (SELECT 1 FROM mailboxes m WHERE m.id = ? AND m.type = 'shared')
           AND EXISTS (SELECT 1 FROM m365_perm_ledger WHERE mailbox_id = ? AND user_id = ? AND level_written = ? AND assigned_at_written = ?)`,
      ).bind(op.mailboxId, op.userId, op.from, op.marker, op.mailboxId, op.mailboxId, op.userId, op.from, op.marker),
      // changes() is the previous statement's direct row count (the ledger
      // row the delete trigger removes is not counted).
      audit(db, 'mailbox.unassigned', op.mailboxId,
        `Removed ${op.from} access for account ${op.userId} (Microsoft 365 shared mailbox access sync; Exchange no longer grants Full Access)`,
        { sql: 'changes() > 0', args: [] }),
    ];
  } else {
    statements = [
      db.prepare('DELETE FROM m365_perm_ledger WHERE mailbox_id = ? AND user_id = ?').bind(op.mailboxId, op.userId),
    ];
    ctx.ops += 1;
    await db.batch(statements);
    return true;
  }

  ctx.ops += statements.length;
  let landed = false;
  try {
    const results = await db.batch(statements);
    // The assignment statement's own row count: 0 means a guard did not match.
    landed = Number(results[changeIndex]?.meta?.changes ?? 0) > 0;
  } catch {
    // A unique key or trigger said no: someone else changed it first.
    landed = false;
  }
  record(ctx, op, landed);
  return landed;
}
