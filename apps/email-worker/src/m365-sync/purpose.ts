// Shared mailbox detection for the Microsoft 365 sync (docs/m365-sync.md,
// "Shared mailboxes"). On only with M365_DETECT_SHARED_MAILBOXES = "true".
//
// Exchange Online's mailbox type (Graph mailboxSettings userPurpose) is read
// for every object whose `mail` is on an organisation domain, including disabled and
// unlicensed ones, and cached per object id in m365_sync_mailbox_purpose
// (migration 0026):
// - a delta round reads only objects with no cached answer;
// - a full reconciliation reads every object again once per round (the
//   cached row says which round checked it), then drops rows it never saw;
// - 'none' (404, no Exchange Online mailbox) is stored by a reconciliation
//   only. In a delta round it is not stored, so a mailbox still being
//   provisioned is asked again the next time the object is returned, and a
//   new, unlinked object is not created as a person on a 'none' answer from
//   a delta round (it waits for its mailbox, or for the reconciliation);
// - a failed or refused lookup stores no answer: the object is left exactly
//   as it is, and a reconciliation counts consecutive failures per object
//   (failed_reconciles) for the Admin alert and audit row;
// - throttled lookups keep the answers already read (live) and stop the run
//   with the longest Retry-After, like any other throttling;
// - switching detection on (again) clears the table and forces a full
//   reconciliation (sync.ts), so an answer from an earlier period is never used.
// Dry run reads Microsoft but never this table: every dry run is a full
// reconciliation, which reads every object anyway.
import { M365_PURPOSE_FAILURE_ALERT, type M365Round } from '@stanchion/shared/m365-sync';
import { GraphError, MAILBOX_PURPOSES, type GraphClient, type GraphUser, type MailboxPurpose, type PurposeLookup } from './graph';
import { needsPurposeCheck, type OrgDomainSet } from './classify';

/** D1 allows at most 100 bound parameters per statement. */
const IN_CHUNK = 90;
/** Cache rows written per D1 batch. */
const WRITE_CHUNK = 40;
const ANSWERS: ReadonlySet<string> = new Set(MAILBOX_PURPOSES);
const PURPOSE_FAILURE_ALERT = M365_PURPOSE_FAILURE_ALERT;
const TABLE = 'm365_sync_mailbox_purpose';

/**
 * True once migration 0026 is applied. Asks sqlite_master, so a real D1
 * error is thrown (and handled as an error), never mistaken for a missing
 * migration.
 */
export async function purposeCacheInstalled(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(TABLE).first<{ name: string }>();
  return row?.name === TABLE;
}

/** Detection switched on (again): forget every cached answer. */
export async function clearPurposes(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM ${TABLE}`).run();
}

/**
 * The lookup answer per object, as the rules see it. 'none' from a delta
 * round is marked so apply() does not create a new person on it.
 */
export type ResolvedPurpose = PurposeLookup | 'none_unconfirmed';

export interface PurposeResolution {
  /** Lower-case object id -> mailbox type, for every candidate on the page that has an answer. */
  purposes: Map<string, ResolvedPurpose>;
  /** D1 statements issued. */
  ops: number;
  /** False when the Graph budget ran out first: the page must not be applied yet. */
  complete: boolean;
}

async function loadCached(db: D1Database, ids: string[]): Promise<{ rows: Map<string, { purpose: string; round: string }>; ops: number }> {
  const rows = new Map<string, { purpose: string; round: string }>();
  let ops = 0;
  for (let start = 0; start < ids.length; start += IN_CHUNK) {
    const slice = ids.slice(start, start + IN_CHUNK);
    ops += 1;
    const { results } = await db.prepare(
      `SELECT object_id, purpose, checked_round FROM ${TABLE} WHERE object_id IN (${slice.map(() => '?').join(', ')})`,
    ).bind(...slice).all<{ object_id: string; purpose: string; checked_round: string }>();
    for (const row of results ?? []) rows.set(row.object_id, { purpose: row.purpose, round: row.checked_round });
  }
  return { rows, ops };
}

function answerStatement(db: D1Database, id: string, purpose: MailboxPurpose, roundId: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO ${TABLE} (object_id, purpose, checked_round, checked_at, failed_reconciles)
     VALUES (?, ?, ?, datetime('now'), 0)
     ON CONFLICT(object_id) DO UPDATE SET purpose = excluded.purpose, checked_round = excluded.checked_round,
       checked_at = excluded.checked_at, failed_reconciles = 0`,
  ).bind(id, purpose, roundId);
}

/**
 * A failed lookup: no answer is kept. A reconciliation adds one to the
 * consecutive-failure count, once per round (a page read again after
 * throttling does not count twice); a delta round only keeps the count.
 */
function failureStatement(db: D1Database, id: string, round: M365Round): D1PreparedStatement {
  const reconcile = round.kind === 'reconcile' ? 1 : 0;
  return db.prepare(
    `INSERT INTO ${TABLE} (object_id, purpose, checked_round, checked_at, failed_reconciles)
     VALUES (?1, 'unknown', ?2, datetime('now'), ?3)
     ON CONFLICT(object_id) DO UPDATE SET
       failed_reconciles = CASE
         WHEN purpose <> 'unknown' THEN ?3
         WHEN ?3 = 1 AND checked_round <> ?2 THEN failed_reconciles + 1
         ELSE failed_reconciles END,
       purpose = 'unknown', checked_round = ?2, checked_at = datetime('now')`,
  ).bind(id, round.id, reconcile);
}

/** One audit row per linked object (deduplicated by target and round), in the reconciliation where it reaches the alert threshold. */
function alertAuditStatement(db: D1Database, id: string, roundId: string): D1PreparedStatement {
  const detail = `Microsoft 365 sync: the Exchange mailbox type of a linked object could not be read in ${PURPOSE_FAILURE_ALERT} full reconciliations in a row (round ${roundId}); it is left unchanged until it can be read`;
  return db.prepare(
    `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
     SELECT ?, datetime('now'), NULL, 'system', 'm365_sync.type_unreadable', COALESCE(l.user_id, l.mailbox_id), ?
     FROM m365_sync_links l JOIN ${TABLE} p ON p.object_id = l.object_id
     WHERE l.object_id = ? AND p.purpose = 'unknown' AND p.failed_reconciles = ? AND p.checked_round = ?
       AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.event_type = 'm365_sync.type_unreadable'
         AND a.target = COALESCE(l.user_id, l.mailbox_id) AND a.detail = ?)`,
  ).bind(crypto.randomUUID(), detail.slice(0, 1000), id, PURPOSE_FAILURE_ALERT, roundId, detail.slice(0, 1000));
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
  /** The organisation's mail domains (orgDomains), or MAIL_DOMAIN alone. */
  domains: OrgDomainSet;
  exclude: ReadonlySet<string>;
  /** Stop before a $batch once the Graph client has made this many requests. */
  maxRequests?: number;
}): Promise<PurposeResolution> {
  const { db, graph, round, users, domains, exclude } = options;
  const live = round.mode === 'live';
  const delta = round.kind === 'delta';
  let ops = 0;
  const purposes = new Map<string, ResolvedPurpose>();

  const candidates = [...new Set(users.filter((user) => needsPurposeCheck(user, domains)).map((user) => user.id.toLowerCase()))]
    .filter((id) => !exclude.has(id));
  // Objects deleted in Microsoft 365: forget their cached type (live only).
  const removedIds = users.filter((user) => user['@removed'] && typeof user.id === 'string').map((user) => user.id.toLowerCase())
    .filter((id) => /^[0-9a-f-]{36}$/.test(id));
  if (live && removedIds.length) {
    for (let start = 0; start < removedIds.length; start += IN_CHUNK) {
      const slice = removedIds.slice(start, start + IN_CHUNK);
      ops += 1;
      await db.prepare(`DELETE FROM ${TABLE} WHERE object_id IN (${slice.map(() => '?').join(', ')})`).bind(...slice).run();
    }
  }
  if (!candidates.length) return { purposes, ops, complete: true };

  let lookup = candidates;
  if (live) {
    const cached = await loadCached(db, candidates);
    ops += cached.ops;
    lookup = [];
    for (const id of candidates) {
      const row = cached.rows.get(id);
      // Delta: any stored answer stands. Reconciliation: only one read in
      // this round. A failure row ('unknown') is never an answer.
      if (row && row.purpose !== 'unknown' && ANSWERS.has(row.purpose) && (delta || row.round === round.id)) {
        purposes.set(id, row.purpose as MailboxPurpose);
      } else {
        lookup.push(id);
      }
    }
  }
  if (!lookup.length) return { purposes, ops, complete: true };

  const answer = await graph.mailboxPurposes(lookup, { maxRequests: options.maxRequests });
  for (const [id, value] of answer.purposes) purposes.set(id, delta && value === 'none' ? 'none_unconfirmed' : value);

  if (live) {
    const statements: D1PreparedStatement[] = [];
    for (const [id, value] of answer.purposes) {
      if (value === 'denied' || value === 'failed') {
        statements.push(failureStatement(db, id, round));
        if (round.kind === 'reconcile') statements.push(alertAuditStatement(db, id, round.id));
      } else if (!(delta && value === 'none')) {
        statements.push(answerStatement(db, id, value, round.id));
      }
    }
    for (let start = 0; start < statements.length; start += WRITE_CHUNK) {
      const slice = statements.slice(start, start + WRITE_CHUNK);
      ops += slice.length;
      await db.batch(slice);
    }
  }
  if (answer.throttled) throw new GraphError('throttled', 429, answer.retryAfterSeconds);
  return { purposes, ops, complete: !answer.incomplete };
}

/** After a live full reconciliation: drop cached rows of objects it never checked. */
export async function prunePurposes(db: D1Database, roundId: string): Promise<void> {
  await db.prepare(`DELETE FROM ${TABLE} WHERE checked_round <> ?`).bind(roundId).run();
}
