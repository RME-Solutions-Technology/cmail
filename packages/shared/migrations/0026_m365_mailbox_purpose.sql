-- Microsoft 365 sync: shared mailbox detection (docs/m365-sync.md, "Shared
-- mailboxes"). Used only when the email Worker has
-- M365_DETECT_SHARED_MAILBOXES = "true"; nothing reads or writes this table
-- otherwise.
--
-- m365_sync_mailbox_purpose caches Exchange Online's mailbox type (Microsoft
-- Graph mailboxSettings userPurpose) per Entra object id, so the sync asks
-- Microsoft once per object instead of on every delta round. Every row is
-- refreshed by the next full reconciliation (daily, or Sync now), which also
-- removes the rows of objects it no longer saw. 'none' means Graph answered
-- that the object has no Exchange Online mailbox. A failed lookup is never
-- stored, so it is tried again the next time the object is seen.
--
-- It holds no mail, no address and no name: an object id, a mailbox type
-- and when it was read. Deleting rows is always safe (they are looked up
-- again). No link to m365_sync_links: most cached objects are never linked
-- (rooms, equipment, former staff).
--
-- Upgrade note: additive only (one new table). Apply with the normal
-- `pnpm db:migrate`. No existing row changes.

CREATE TABLE IF NOT EXISTS m365_sync_mailbox_purpose (
  object_id TEXT PRIMARY KEY CHECK (length(object_id) = 36),
  purpose TEXT NOT NULL CHECK (purpose IN ('user', 'linked', 'shared', 'room', 'equipment', 'others', 'none')),
  checked_round TEXT NOT NULL DEFAULT '' CHECK (length(checked_round) <= 64),
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_m365_sync_mailbox_purpose_round
  ON m365_sync_mailbox_purpose(checked_round);
