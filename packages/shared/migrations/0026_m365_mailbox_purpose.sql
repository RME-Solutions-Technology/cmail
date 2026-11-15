-- Microsoft 365 sync: shared mailbox detection (docs/m365-sync.md, "Shared
-- mailboxes"). Used only when the email Worker has
-- M365_DETECT_SHARED_MAILBOXES = "true"; nothing reads or writes this table
-- otherwise.
--
-- m365_sync_mailbox_purpose caches Exchange Online's mailbox type (Microsoft
-- Graph mailboxSettings userPurpose) per Entra object id, so the sync asks
-- Microsoft once per object instead of on every delta round.
-- - purpose: the answer. 'none' means Graph answered that the object has no
--   Exchange Online mailbox (stored by a full reconciliation only).
--   'unknown' means the last lookup failed or was refused: such a row is
--   never used as an answer, it only carries the failure count.
-- - checked_round: the sync round that wrote the row. A full reconciliation
--   (daily, or Sync now) reads every object again once and then removes the
--   rows of objects it did not see.
-- - failed_reconciles: consecutive full reconciliations in which the lookup
--   failed; reset by any answer. Admin alerts (and an audit row is written)
--   when a linked object reaches 3.
-- The whole table is cleared when detection is switched on again, so an
-- answer from an earlier period is never used.
--
-- It holds no mail, no address and no name. Deleting rows is always safe
-- (they are looked up again). No foreign key to m365_sync_links: most cached
-- objects are never linked (rooms, equipment, former staff).
--
-- Upgrade note: additive only (one new table). Apply with the normal
-- `pnpm db:migrate`. No existing row changes.

CREATE TABLE IF NOT EXISTS m365_sync_mailbox_purpose (
  object_id TEXT PRIMARY KEY CHECK (length(object_id) = 36),
  purpose TEXT NOT NULL CHECK (purpose IN ('user', 'linked', 'shared', 'room', 'equipment', 'others', 'none', 'unknown')),
  checked_round TEXT NOT NULL DEFAULT '' CHECK (length(checked_round) <= 64),
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  failed_reconciles INTEGER NOT NULL DEFAULT 0 CHECK (failed_reconciles >= 0)
);
CREATE INDEX IF NOT EXISTS idx_m365_sync_mailbox_purpose_round
  ON m365_sync_mailbox_purpose(checked_round);
