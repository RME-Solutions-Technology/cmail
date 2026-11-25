-- Microsoft 365 mailbox sync (docs/m365-sync.md). Optional and off by
-- default: nothing writes these tables until a manager turns the sync on in
-- Admin > Microsoft 365 sync and the email Worker has its Entra settings.
--
-- m365_sync_links ties one Entra object (by its immutable object id, never a
-- UPN or address) to the Stanchion account or shared mailbox it feeds. An
-- address or name change in Microsoft 365 updates the linked row; it never
-- creates a second one. One object links to at most one account and one
-- mailbox, and the other way round.
--
-- m365_sync_state is a single row: the Worker's delta link, the round in
-- progress (so a run can stop and resume on the next cron), the last result
-- and a bounded change report for Admin. lease_until stops two overlapping
-- cron invocations from running a round at the same time.
--
-- Nothing here deletes mail or mailboxes. ON DELETE CASCADE only drops a
-- link when a manager deletes the account or mailbox itself.
--
-- Upgrade note: additive only (two new tables). Apply with the normal
-- `pnpm db:migrate`. No existing row changes.

CREATE TABLE IF NOT EXISTS m365_sync_links (
  object_id TEXT PRIMARY KEY CHECK (length(object_id) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('person', 'shared')),
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id TEXT UNIQUE REFERENCES mailboxes(id) ON DELETE CASCADE,
  source_state TEXT NOT NULL DEFAULT 'in_scope' CHECK (source_state IN ('in_scope', 'out_of_scope')),
  last_reason TEXT NOT NULL DEFAULT '' CHECK (length(last_reason) <= 64),
  paused_by_sync INTEGER NOT NULL DEFAULT 0 CHECK (paused_by_sync IN (0, 1)),
  status_before_pause TEXT CHECK (status_before_pause IS NULL OR status_before_pause IN ('pending', 'active')),
  seen_round TEXT NOT NULL DEFAULT '' CHECK (length(seen_round) <= 64),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (kind = 'person' AND user_id IS NOT NULL AND mailbox_id IS NULL)
    OR (kind = 'shared' AND user_id IS NULL AND mailbox_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_m365_sync_links_seen
  ON m365_sync_links(seen_round);

-- A manager's decision always wins over the sync. Any status change to an
-- account (Admin pause, reactivate or offboard, or any other writer) clears
-- the "paused by the sync" mark in the same statement, so the sync can never
-- later resume an account someone else has touched. The sync's own pause
-- sets the mark after its status change, in the same batch.
CREATE TRIGGER IF NOT EXISTS trg_m365_sync_status_change
AFTER UPDATE OF status ON users
WHEN NEW.status IS NOT OLD.status
BEGIN
  UPDATE m365_sync_links
  SET paused_by_sync = 0, status_before_pause = NULL, updated_at = datetime('now')
  WHERE user_id = NEW.id AND paused_by_sync = 1;
END;

CREATE TABLE IF NOT EXISTS m365_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL DEFAULT '{}' CHECK (length(state) <= 1048576),
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
