// Shared mailbox detection for the Microsoft 365 sync (docs/m365-sync.md,
// "Shared mailboxes"). On only with M365_DETECT_SHARED_MAILBOXES = "true".
//
// Exchange Online's mailbox type (Graph mailboxSettings userPurpose) is read
// for every object whose `mail` is on MAIL_DOMAIN, including disabled and
// unlicensed ones, and cached per object id in m365_sync_mailbox_purpose
// (migration 0026):
// - a delta round reads only objects with no cached answer;
// - a full reconciliation reads every object again once per round (the
//   cached row says which round checked it), then drops rows it never saw;
// - only definite answers are stored. A failed or denied lookup is not, so it
//   is tried again the next time the object is seen, and the object is left
//   exactly as it is meanwhile;
// - throttled lookups keep the answers already read (live) and stop the run
//   with the longest Retry-After, like any other throttling.
// Dry run reads Microsoft but never this table: every dry run is a full
// reconciliation, which reads every object anyway.
import type { M365Round } from '@cmail/shared/m365-sync';
import { GraphError, MAILBOX_PURPOSES, type GraphClient, type GraphUser, type MailboxPurpose, type PurposeLookup } from './graph';
import { needsPurposeCheck } from './classify';

/** D1 allows at most 100 bound parameters per statement. */
const IN_CHUNK = 90;
/** Cache rows written per D1 batch. */
const WRITE_CHUNK = 50;
const STORED: ReadonlySet<string> = new Set(MAILBOX_PURPOSES);

/** True once migration 0026 is applied. */
export async function purposeCacheInstalled(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT 1 FROM m365_sync_mailbox_purpose LIMIT 1').first();
    return true;
  } catch {
    return false;
  }
}

export interface PurposeResolution {
  /** Lower-case object id -> mailbox type, for every candidate on the page that has an answer. */
  purposes: Map<string, PurposeLookup>;
  /** D1 statements issued. */
  ops: number;
}

async function loadCached(db: D1Database, ids: string[]): Promise<{ rows: Map<string, { purpose: MailboxPurpose; round: string }>; ops: number }> {
  const rows = new Map<string, { purpose: MailboxPurpose; round: string }>();
  let ops = 0;
  for (let start = 0; start < ids.length; start += IN_CHUNK) {
    const slice = ids.slice(start, start + IN_CHUNK);
    ops += 1;
    const { results } = await db.prepare(
      `SELECT object_id, purpose, checked_round FROM m365_sync_mailbox_purpose WHERE object_id IN (${slice.map(() => '?').join(', ')})`,
    ).bind(...slice).all<{ object_id: string; purpose: string; checked_round: string }>();
    for (const row of results ?? []) {
      if (STORED.has(row.purpose)) rows.set(row.object_id, { purpose: row.purpose as MailboxPurpose, round: row.checked_round });
    }
  }
  return { rows, ops };
}

/**
 * Mailbox types for the candidates on one fetched page. `exclude` holds ids
 * that need no lookup (members of the explicit shared group: always shared).
 * Throws GraphError('throttled') after saving the answers it did get.
 */
export async function resolvePurposes(options: {
  db: D1Database;
  graph: GraphClient;
  round: M365Round;
  users: GraphUser[];
  mailDomain: string;
  exclude: ReadonlySet<string>;
}): Promise<PurposeResolution> {
  const { db, graph, round, users, mailDomain, exclude } = options;
  const live = round.mode === 'live';
  let ops = 0;
  const purposes = new Map<string, PurposeLookup>();

  const candidates = [...new Set(users.filter((user) => needsPurposeCheck(user, mailDomain)).map((user) => user.id.toLowerCase()))]
    .filter((id) => !exclude.has(id));
  // Objects deleted in Microsoft 365: forget their cached type (live only).
  const removedIds = users.filter((user) => user['@removed'] && typeof user.id === 'string').map((user) => user.id.toLowerCase())
    .filter((id) => /^[0-9a-f-]{36}$/.test(id));
  if (live && removedIds.length) {
    for (let start = 0; start < removedIds.length; start += IN_CHUNK) {
      const slice = removedIds.slice(start, start + IN_CHUNK);
      ops += 1;
      await db.prepare(`DELETE FROM m365_sync_mailbox_purpose WHERE object_id IN (${slice.map(() => '?').join(', ')})`).bind(...slice).run();
    }
  }
  if (!candidates.length) return { purposes, ops };

  let lookup = candidates;
  if (live) {
    const cached = await loadCached(db, candidates);
    ops += cached.ops;
    lookup = [];
    for (const id of candidates) {
      const row = cached.rows.get(id);
      // Delta: any cached answer stands. Reconciliation: only one read in this round.
      if (row && (round.kind === 'delta' || row.round === round.id)) purposes.set(id, row.purpose);
      else lookup.push(id);
    }
  }
  if (!lookup.length) return { purposes, ops };

  const answer = await graph.mailboxPurposes(lookup);
  for (const [id, value] of answer.purposes) purposes.set(id, value);

  if (live) {
    const definite = [...answer.purposes].filter((entry): entry is [string, MailboxPurpose] => STORED.has(entry[1]));
    for (let start = 0; start < definite.length; start += WRITE_CHUNK) {
      const slice = definite.slice(start, start + WRITE_CHUNK);
      ops += slice.length;
      await db.batch(slice.map(([id, purpose]) => db.prepare(
        `INSERT INTO m365_sync_mailbox_purpose (object_id, purpose, checked_round, checked_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(object_id) DO UPDATE SET purpose = excluded.purpose, checked_round = excluded.checked_round, checked_at = excluded.checked_at`,
      ).bind(id, purpose, round.id)));
    }
  }
  if (answer.throttled) throw new GraphError('throttled', 429, answer.retryAfterSeconds);
  return { purposes, ops };
}

/** After a live full reconciliation: drop cached types of objects it never checked. */
export async function prunePurposes(db: D1Database, roundId: string): Promise<void> {
  await db.prepare('DELETE FROM m365_sync_mailbox_purpose WHERE checked_round <> ?').bind(roundId).run();
}
