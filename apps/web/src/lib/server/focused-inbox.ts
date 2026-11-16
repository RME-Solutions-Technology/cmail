// Focused Inbox in the web app (docs/focused-inbox.md): the switches, the
// Focused and Other views of the Inbox, moving and learning, and the one-off
// sort of recent mail. The classifier itself is shared with the email Worker
// (@cmail/shared/focused-inbox).
//
// Off by default. With the organisation switch off, loadFocusScope returns
// null after one settings read and every caller renders and queries exactly
// as it did before this feature existed.
import {
  BACKFILL_LIMIT,
  CORRESPONDENT_SCAN_SENT,
  FREQUENT_SCAN_INBOX,
  MAX_OVERRIDES_PER_MAILBOX,
  ORG_SETTING_FOCUSED_INBOX,
  classifyFocus,
  focusDomainCandidates,
  focusedInboxOrgEnabled,
  isFocusClass,
  normalizeFocusAddress,
  senderDomain,
  type FocusClass,
  type FocusDecision,
} from '@cmail/shared/focused-inbox';
import { loadOrgDomainsCache } from '@cmail/shared/org-domains';
import { messageOwnershipPredicate } from './message-access';

export { focusedInboxOrgEnabled };

export type FocusView = 'focused' | 'other';

/** The current time in epoch milliseconds, in SQL (lease times are epoch ms). */
const NOW_MS_SQL = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

/** The list view from the URL: anything but "other" is Focused. */
export function parseFocusView(value: string | null): FocusView {
  return value === 'other' ? 'other' : 'focused';
}

export async function setFocusedInboxOrgEnabled(db: D1Database, enabled: boolean, actorId: string): Promise<void> {
  const save = db.prepare(
    `INSERT INTO org_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`,
  ).bind(ORG_SETTING_FOCUSED_INBOX, enabled ? 'true' : 'false', actorId);
  if (!enabled) {
    await save.run();
    return;
  }
  // Mail that arrived while the switch was off is unsorted: queue the one-off
  // sort again for every mailbox (it only ever fills in unsorted mail).
  await db.batch([
    save,
    db.prepare(
      `UPDATE focus_mailbox_settings SET backfill_status = 'none', updated_at = datetime('now')
       WHERE backfill_status IN ('done', 'failed')`,
    ),
  ]);
}

/** SQL: the one-off sort is due (never run, or a run that died with its lease). */
const BACKFILL_DUE = `(COALESCE(fs.backfill_status, 'none') = 'none'
  OR (fs.backfill_status = 'running' AND fs.backfill_lease_until < ${NOW_MS_SQL}))`;

// ---------------------------------------------------------------------------
// Which mailboxes are sorted, for one person

export interface FocusScope {
  /** Active mailboxes assigned to the person with sorting on. */
  mailboxIds: string[];
  /** Of those, the ones whose recent mail has never been sorted. */
  needsBackfill: string[];
}

/**
 * The person's mailboxes with sorting on, or null when the organisation
 * switch is off (or the tables are not there yet). Every assignment level
 * counts: a person with read access to a shared mailbox sees its tabs too.
 */
export async function loadFocusScope(db: D1Database, userId: string): Promise<FocusScope | null> {
  if (!await focusedInboxOrgEnabled(db)) return null;
  try {
    const { results } = await db.prepare(
      `SELECT ma.mailbox_id AS id, ${BACKFILL_DUE} AS backfill_due
       FROM mailbox_assignments ma
       INNER JOIN mailboxes mb ON mb.id = ma.mailbox_id
       LEFT JOIN focus_mailbox_settings fs ON fs.mailbox_id = ma.mailbox_id
       WHERE ma.user_id = ? AND mb.status = 'active' AND COALESCE(fs.enabled, 1) = 1
       ORDER BY ma.mailbox_id`,
    ).bind(userId).all<{ id: string; backfill_due: number }>();
    const rows = results || [];
    return {
      mailboxIds: rows.map((row) => row.id),
      needsBackfill: rows.filter((row) => Number(row.backfill_due) === 1).map((row) => row.id),
    };
  } catch {
    console.error('Focused Inbox scope could not be read');
    return null;
  }
}

/** Whether one mailbox is sorted (organisation switch and its own setting). */
export async function mailboxFocusEnabled(db: D1Database, mailboxId: string): Promise<boolean> {
  try {
    const row = await db.prepare(
      `SELECT (
         COALESCE((SELECT value FROM org_settings WHERE key = ?), '') = 'true'
         AND COALESCE((SELECT enabled FROM focus_mailbox_settings WHERE mailbox_id = ?), 1) = 1
       ) AS active`,
    ).bind(ORG_SETTING_FOCUSED_INBOX, mailboxId).first<{ active: number }>();
    return Number(row?.active) === 1;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The two views

/**
 * SQL for one view over Inbox rows aliased "m". Other is exactly the rows
 * sorted 'other' in a mailbox that is sorted now; Focused is everything else,
 * including mail that was never sorted. Together they are the whole Inbox.
 * Binds one JSON array of mailbox ids.
 */
export function focusViewCondition(view: FocusView): string {
  const sorted = 'm.mailbox_id IN (SELECT value FROM json_each(?))';
  return view === 'other'
    ? `(m.focus_class = 'other' AND ${sorted})`
    : `(m.focus_class IS NOT 'other' OR NOT ${sorted})`;
}

/** Unread Inbox messages in each view, within the same scope as the list. */
export async function focusUnreadCounts(
  db: D1Database,
  userId: string,
  sortedMailboxIds: readonly string[],
  mailboxId: string | null,
): Promise<{ focused: number; other: number }> {
  const ids = JSON.stringify(sortedMailboxIds);
  const row = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN ${focusViewCondition('other')} THEN 1 ELSE 0 END), 0) AS other,
       COUNT(*) AS total
     FROM messages m
     INNER JOIN mailbox_assignments ma ON ma.mailbox_id = m.mailbox_id
     INNER JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE ma.user_id = ? AND m.folder = 'inbox' AND m.is_read = 0 AND mb.status = 'active'
       AND ${messageOwnershipPredicate('m')}
       ${mailboxId ? 'AND m.mailbox_id = ?' : ''}`,
  ).bind(ids, userId, userId, ...(mailboxId ? [mailboxId] : [])).first<{ other: number; total: number }>();
  const other = Number(row?.other) || 0;
  const total = Number(row?.total) || 0;
  return { focused: Math.max(0, total - other), other };
}

// ---------------------------------------------------------------------------
// Settings for the mailboxes a person manages

export interface FocusOverride {
  kind: 'address' | 'domain';
  pattern: string;
  focusClass: FocusClass;
}

export interface FocusMailboxSettings {
  id: string;
  address: string;
  displayName: string;
  type: 'personal' | 'shared';
  enabled: boolean;
  backfill: { status: 'none' | 'running' | 'done' | 'failed'; count: number; at: string | null };
  overrides: FocusOverride[];
}

/**
 * Mailboxes whose setting this person may change: active ones they have Full
 * access to (their own mailbox, and shared mailboxes with Full access).
 */
export async function loadFocusSettings(db: D1Database, userId: string): Promise<FocusMailboxSettings[]> {
  const { results } = await db.prepare(
    `SELECT mb.id, mb.address, mb.display_name, mb.type,
            COALESCE(fs.enabled, 1) AS enabled,
            COALESCE(fs.backfill_status, 'none') AS backfill_status,
            COALESCE(fs.backfill_count, 0) AS backfill_count,
            fs.backfilled_at
     FROM mailbox_assignments ma
     INNER JOIN mailboxes mb ON mb.id = ma.mailbox_id
     LEFT JOIN focus_mailbox_settings fs ON fs.mailbox_id = mb.id
     WHERE ma.user_id = ? AND ma.permissions = 'full' AND mb.status = 'active'
     ORDER BY CASE mb.type WHEN 'personal' THEN 0 ELSE 1 END, mb.address`,
  ).bind(userId).all<{
    id: string; address: string; display_name: string; type: 'personal' | 'shared';
    enabled: number; backfill_status: string; backfill_count: number; backfilled_at: string | null;
  }>();
  const mailboxes = results || [];
  if (!mailboxes.length) return [];
  const overrides = await db.prepare(
    `SELECT mailbox_id, kind, pattern, focus_class FROM focus_sender_overrides
     WHERE mailbox_id IN (SELECT value FROM json_each(?))
     ORDER BY mailbox_id, kind DESC, pattern`,
  ).bind(JSON.stringify(mailboxes.map((mailbox) => mailbox.id))).all<{ mailbox_id: string; kind: 'address' | 'domain'; pattern: string; focus_class: string }>();
  return mailboxes.map((mailbox) => ({
    id: mailbox.id,
    address: mailbox.address,
    displayName: mailbox.display_name,
    type: mailbox.type,
    enabled: Number(mailbox.enabled) === 1,
    backfill: {
      status: (['none', 'running', 'done', 'failed'].includes(mailbox.backfill_status) ? mailbox.backfill_status : 'none') as FocusMailboxSettings['backfill']['status'],
      count: Number(mailbox.backfill_count) || 0,
      at: mailbox.backfilled_at,
    },
    overrides: (overrides.results || [])
      .filter((row) => row.mailbox_id === mailbox.id && isFocusClass(row.focus_class))
      .map((row) => ({ kind: row.kind, pattern: row.pattern, focusClass: row.focus_class as FocusClass })),
  }));
}

/** True when this person has Full access to this active mailbox. */
export async function canManageMailboxFocus(db: D1Database, userId: string, mailboxId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM mailbox_assignments ma
     INNER JOIN mailboxes mb ON mb.id = ma.mailbox_id
     WHERE ma.user_id = ? AND ma.mailbox_id = ? AND ma.permissions = 'full' AND mb.status = 'active'`,
  ).bind(userId, mailboxId).first<{ ok: number }>();
  return Boolean(row);
}

/**
 * Turns sorting on or off for one mailbox. Turning it on queues the one-off
 * sort of recent mail again (it only ever touches messages never sorted).
 */
export async function setMailboxFocusEnabled(db: D1Database, mailboxId: string, enabled: boolean, userId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO focus_mailbox_settings (mailbox_id, enabled, backfill_status, updated_by, updated_at)
     VALUES (?1, ?2, 'none', ?3, datetime('now'))
     ON CONFLICT(mailbox_id) DO UPDATE SET
       enabled = excluded.enabled,
       backfill_status = CASE WHEN excluded.enabled = 1
                                AND (focus_mailbox_settings.backfill_status <> 'running'
                                     OR focus_mailbox_settings.backfill_lease_until < ${NOW_MS_SQL})
                              THEN 'none' ELSE focus_mailbox_settings.backfill_status END,
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`,
  ).bind(mailboxId, enabled ? 1 : 0, userId).run();
}

export type OverrideResult = 'saved' | 'limit';

/**
 * Adds or changes one sender or domain entry for one mailbox. An existing
 * entry is updated in place (the limit trigger only sees new rows).
 */
export async function saveFocusOverride(
  db: D1Database,
  mailboxId: string,
  override: FocusOverride,
  userId: string,
): Promise<OverrideResult> {
  const [updated, inserted] = await db.batch([
    db.prepare(
      'UPDATE focus_sender_overrides SET focus_class = ? WHERE mailbox_id = ? AND kind = ? AND pattern = ?',
    ).bind(override.focusClass, mailboxId, override.kind, override.pattern),
    db.prepare(
      `INSERT INTO focus_sender_overrides (mailbox_id, kind, pattern, focus_class, created_by)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE NOT EXISTS (SELECT 1 FROM focus_sender_overrides WHERE mailbox_id = ?1 AND kind = ?2 AND pattern = ?3)
         AND (SELECT COUNT(*) FROM focus_sender_overrides WHERE mailbox_id = ?1) < ?6`,
    ).bind(mailboxId, override.kind, override.pattern, override.focusClass, userId, MAX_OVERRIDES_PER_MAILBOX),
  ]);
  const changed = Number(updated?.meta.changes || 0) + Number(inserted?.meta.changes || 0);
  return changed > 0 ? 'saved' : 'limit';
}

export async function removeFocusOverride(db: D1Database, mailboxId: string, kind: 'address' | 'domain', pattern: string): Promise<boolean> {
  const result = await db.prepare(
    'DELETE FROM focus_sender_overrides WHERE mailbox_id = ? AND kind = ? AND pattern = ?',
  ).bind(mailboxId, kind, pattern).run();
  return Number(result.meta.changes || 0) > 0;
}

// ---------------------------------------------------------------------------
// Moving and learning

export const MAX_FOCUS_MOVE_IDS = 100;

export type FocusMoveResult =
  | { ok: true; moved: number; learned: number }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

/**
 * Moves Inbox messages to Focused or Other for this person. Needs Full access
 * to every message's mailbox and sorting on for it. With `always`, each
 * distinct sender (per mailbox) also gets an address entry, and that sender's
 * other Inbox messages in the same mailbox move too (Outlook's "Always move").
 * Entries are per mailbox, never shared between mailboxes or people.
 */
export async function moveMessagesFocus(
  db: D1Database,
  userId: string,
  ids: readonly string[],
  to: FocusClass,
  always: boolean,
): Promise<FocusMoveResult> {
  const unique = [...new Set(ids)];
  const { results } = await db.prepare(
    `SELECT m.id, m.mailbox_id, m.folder, m.direction, m.from_address, ma.permissions
     FROM messages m
     INNER JOIN mailbox_assignments ma ON ma.mailbox_id = m.mailbox_id AND ma.user_id = ?
     INNER JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.id IN (SELECT value FROM json_each(?)) AND mb.status = 'active'
       AND ${messageOwnershipPredicate('m')}`,
  ).bind(userId, JSON.stringify(unique), userId).all<{
    id: string; mailbox_id: string; folder: string; direction: string; from_address: string; permissions: string;
  }>();
  const rows = results || [];
  if (rows.length !== unique.length) return { ok: false, status: 404, message: 'One or more messages are no longer available' };
  if (rows.some((row) => row.permissions !== 'full')) {
    return { ok: false, status: 403, message: 'Full mailbox permission is required to move messages' };
  }
  if (rows.some((row) => row.folder !== 'inbox' || row.direction === 'outbound')) {
    return { ok: false, status: 400, message: 'Only messages in the Inbox can be moved to Focused or Other' };
  }
  const mailboxIds = [...new Set(rows.map((row) => row.mailbox_id))];
  for (const mailboxId of mailboxIds) {
    if (!await mailboxFocusEnabled(db, mailboxId)) {
      return { ok: false, status: 409, message: 'Focused Inbox is off for this mailbox' };
    }
  }

  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE messages SET focus_class = ?, focus_reason = 'moved'
       WHERE id IN (SELECT value FROM json_each(?)) AND folder = 'inbox'`,
    ).bind(to, JSON.stringify(unique)),
  ];
  // Index pairs (update, insert) of each sender entry, to count what was saved.
  const entryStatements: Array<[number, number]> = [];
  if (always) {
    const senders = new Map<string, { mailboxId: string; address: string }>();
    for (const row of rows) {
      const address = normalizeFocusAddress(row.from_address);
      if (address) senders.set(`${row.mailbox_id}\u0000${address}`, { mailboxId: row.mailbox_id, address });
    }
    for (const { mailboxId, address } of senders.values()) {
      entryStatements.push([statements.length, statements.length + 1]);
      statements.push(
        db.prepare(
          'UPDATE focus_sender_overrides SET focus_class = ? WHERE mailbox_id = ? AND kind = \'address\' AND pattern = ?',
        ).bind(to, mailboxId, address),
        db.prepare(
          `INSERT INTO focus_sender_overrides (mailbox_id, kind, pattern, focus_class, created_by)
           SELECT ?1, 'address', ?2, ?3, ?4
           WHERE NOT EXISTS (SELECT 1 FROM focus_sender_overrides WHERE mailbox_id = ?1 AND kind = 'address' AND pattern = ?2)
             AND (SELECT COUNT(*) FROM focus_sender_overrides WHERE mailbox_id = ?1) < ?5`,
        ).bind(mailboxId, address, to, userId, MAX_OVERRIDES_PER_MAILBOX),
        // The rest of this sender's Inbox mail in this mailbox follows.
        db.prepare(
          `UPDATE messages SET focus_class = ?, focus_reason = 'sender_override'
           WHERE mailbox_id = ? AND folder = 'inbox' AND direction <> 'outbound' AND lower(from_address) = ?
             AND id NOT IN (SELECT value FROM json_each(?))`,
        ).bind(to, mailboxId, address, JSON.stringify(unique)),
      );
    }
  }
  const batchResults = await db.batch(statements);
  const changes = (index: number) => Number(batchResults[index]?.meta.changes || 0);
  // An entry is "learned" when it was saved; at the per-mailbox limit the
  // messages still move but no new entry is added.
  const learned = entryStatements.filter(([update, insert]) => changes(update) + changes(insert) > 0).length;
  return { ok: true, moved: changes(0), learned };
}

// ---------------------------------------------------------------------------
// The one-off sort of recent mail (backfill)

/** A run that has not finished after this long may be taken over. */
export const BACKFILL_LEASE_MS = 5 * 60 * 1000;
/** Ids per UPDATE statement. */
const BACKFILL_CHUNK = 200;

export type BackfillResult =
  | { status: 'done'; sorted: number }
  | { status: 'skipped'; reason: 'off' | 'busy' | 'done' }
  | { status: 'failed' };

/**
 * Sorts the newest BACKFILL_LIMIT never-sorted Inbox messages of one mailbox,
 * with the same classifier as delivery. Header signals are not available for
 * stored mail (cmail keeps no raw headers), so List-Id and similar cannot be
 * used here: only the person's entries, correspondence, internal senders,
 * automated-looking addresses and frequent senders. Bounded: a fixed number
 * of reads, at most BACKFILL_LIMIT rows changed, only rows still unsorted (a
 * delivery or a move during the run wins). A lease stops two runs at once.
 */
export async function runFocusBackfill(
  db: D1Database,
  mailboxId: string,
  options: { mailDomain?: string | null; now?: number; limit?: number } = {},
): Promise<BackfillResult> {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(BACKFILL_LIMIT, Math.floor(options.limit ?? BACKFILL_LIMIT)));
  if (!await mailboxFocusEnabled(db, mailboxId)) return { status: 'skipped', reason: 'off' };

  await db.prepare('INSERT OR IGNORE INTO focus_mailbox_settings (mailbox_id) VALUES (?)').bind(mailboxId).run();
  // The lease value is this run's token: the closing updates match it, so a
  // run whose lease expired cannot overwrite the run that took over.
  const lease = now + BACKFILL_LEASE_MS;
  const claim = await db.prepare(
    `UPDATE focus_mailbox_settings
     SET backfill_status = 'running', backfill_lease_until = ?, updated_at = datetime('now')
     WHERE mailbox_id = ? AND enabled = 1
       AND (backfill_status IN ('none', 'failed') OR (backfill_status = 'running' AND backfill_lease_until < ?))`,
  ).bind(lease, mailboxId, now).run();
  if (Number(claim.meta.changes || 0) !== 1) {
    const state = await db.prepare('SELECT backfill_status FROM focus_mailbox_settings WHERE mailbox_id = ?')
      .bind(mailboxId).first<{ backfill_status: string }>();
    return { status: 'skipped', reason: state?.backfill_status === 'done' ? 'done' : 'busy' };
  }

  try {
    const { results: messages } = await db.prepare(
      `SELECT id, from_address, direction FROM messages
       WHERE mailbox_id = ? AND folder = 'inbox' AND focus_class IS NULL AND direction <> 'outbound'
       ORDER BY received_at DESC LIMIT ?`,
    ).bind(mailboxId, limit).all<{ id: string; from_address: string; direction: string }>();
    // Stored mail keeps no authentication result, so only mail delivered
    // between cmail mailboxes (direction 'internal') counts as authenticated.
    const rows = (messages || []).map((row) => ({
      id: row.id,
      sender: normalizeFocusAddress(row.from_address),
      authenticated: row.direction === 'internal',
    }));
    const mailbox = await db.prepare('SELECT type FROM mailboxes WHERE id = ?').bind(mailboxId).first<{ type: string }>();
    const sharedMailbox = mailbox?.type === 'shared';
    const senders = [...new Set(rows.map((row) => row.sender).filter((sender): sender is string => Boolean(sender)))];

    let sorted = 0;
    if (senders.length) {
      const sendersJson = JSON.stringify(senders);
      const [overrides, correspondents, frequent] = await Promise.all([
        db.prepare('SELECT kind, pattern, focus_class FROM focus_sender_overrides WHERE mailbox_id = ?')
          .bind(mailboxId).all<{ kind: string; pattern: string; focus_class: string }>(),
        db.prepare(
          `SELECT DISTINCT lower(recipient.value) AS address
           FROM (
             SELECT to_addresses, cc_addresses, bcc_addresses FROM messages
             WHERE mailbox_id = ?1 AND folder = 'sent'
             ORDER BY received_at DESC LIMIT ${CORRESPONDENT_SCAN_SENT}
           ) sent,
           json_each(
             json_array(
               CASE WHEN json_valid(sent.to_addresses) THEN json(sent.to_addresses) ELSE json('[]') END,
               CASE WHEN json_valid(sent.cc_addresses) THEN json(sent.cc_addresses) ELSE json('[]') END,
               CASE WHEN json_valid(sent.bcc_addresses) THEN json(sent.bcc_addresses) ELSE json('[]') END
             )
           ) AS list,
           json_each(list.value) AS recipient
           WHERE lower(recipient.value) IN (SELECT value FROM json_each(?2))`,
        ).bind(mailboxId, sendersJson).all<{ address: string }>(),
        db.prepare(
          `SELECT lower(from_address) AS address, COUNT(*) AS n FROM (
             SELECT from_address FROM messages
             WHERE mailbox_id = ? AND folder = 'inbox' AND direction = 'inbound'
             ORDER BY received_at DESC LIMIT ${FREQUENT_SCAN_INBOX}
           ) GROUP BY lower(from_address)`,
        ).bind(mailboxId).all<{ address: string; n: number }>(),
      ]);
      const addressOverrides = new Map<string, FocusClass>();
      const domainOverrides = new Map<string, FocusClass>();
      for (const row of overrides.results || []) {
        if (!isFocusClass(row.focus_class)) continue;
        (row.kind === 'address' ? addressOverrides : domainOverrides).set(row.pattern, row.focus_class);
      }
      const correspondent = new Set((correspondents.results || []).map((row) => row.address));
      const counts = new Map((frequent.results || []).map((row) => [row.address, Number(row.n) || 0]));
      const mailDomain = (options.mailDomain || '').trim().toLowerCase();
      // The organisation's other domains (docs/multi-domain.md); a failed read
      // fails this run like any other lookup here.
      const orgDomains = (await loadOrgDomainsCache(db)).domains;

      const groups = new Map<string, { decision: FocusDecision; ids: string[] }>();
      for (const row of rows) {
        if (!row.sender) continue;
        const sender = row.sender;
        const domainOverride = focusDomainCandidates(senderDomain(sender))
          .map((domain) => domainOverrides.get(domain))
          .find((value): value is FocusClass => Boolean(value)) ?? null;
        const decision = classifyFocus({
          sender,
          mailDomain,
          orgDomains,
          signals: null,
          senderAuthenticated: row.authenticated,
          sharedMailbox,
          addressOverride: addressOverrides.get(sender) ?? null,
          domainOverride,
          correspondent: correspondent.has(sender),
          recentFromSender: counts.get(sender) ?? 0,
        });
        const key = `${decision.focusClass}:${decision.reason}`;
        const group = groups.get(key) ?? { decision, ids: [] };
        group.ids.push(row.id);
        groups.set(key, group);
      }

      const updates: D1PreparedStatement[] = [];
      for (const { decision, ids } of groups.values()) {
        for (let start = 0; start < ids.length; start += BACKFILL_CHUNK) {
          updates.push(db.prepare(
            `UPDATE messages SET focus_class = ?, focus_reason = ?
             WHERE mailbox_id = ? AND folder = 'inbox' AND focus_class IS NULL
               AND id IN (SELECT value FROM json_each(?))`,
          ).bind(decision.focusClass, decision.reason, mailboxId, JSON.stringify(ids.slice(start, start + BACKFILL_CHUNK))));
        }
      }
      if (updates.length) {
        const results = await db.batch(updates);
        sorted = results.reduce((total, result) => total + Number(result.meta.changes || 0), 0);
      }
    }

    await db.prepare(
      `UPDATE focus_mailbox_settings
       SET backfill_status = 'done', backfill_count = ?, backfilled_at = datetime('now'), backfill_lease_until = 0,
           updated_at = datetime('now')
       WHERE mailbox_id = ? AND backfill_status = 'running' AND backfill_lease_until = ?`,
    ).bind(sorted, mailboxId, lease).run();
    return { status: 'done', sorted };
  } catch {
    // Counts and codes only; never addresses.
    console.error('Focused Inbox sort of recent mail failed');
    await db.prepare(
      `UPDATE focus_mailbox_settings SET backfill_status = 'failed', backfill_lease_until = 0, updated_at = datetime('now')
       WHERE mailbox_id = ? AND backfill_status = 'running' AND backfill_lease_until = ?`,
    ).bind(mailboxId, lease).run().catch(() => undefined);
    return { status: 'failed' };
  }
}

/** At most this many mailboxes are sorted in the background of one page load. */
export const BACKFILLS_PER_REQUEST = 2;

/** Starts the one-off sort for mailboxes that never had it, after the response. */
export function scheduleFocusBackfills(
  platform: App.Platform | undefined,
  mailboxIds: readonly string[],
): void {
  if (!platform?.env || !platform.context?.waitUntil || !mailboxIds.length) return;
  const { env, context } = platform;
  const run = async () => {
    for (const mailboxId of mailboxIds.slice(0, BACKFILLS_PER_REQUEST)) {
      await runFocusBackfill(env.DB, mailboxId, { mailDomain: env.MAIL_DOMAIN });
    }
  };
  context.waitUntil(run().catch(() => undefined));
}
