-- Shared mailbox access from Exchange Online (docs/m365-mailbox-permissions.md).
-- Optional and off by default: nothing reads or writes these tables until a
-- manager turns "Shared mailbox access" on in Admin and the email Worker has
-- the collector binding and settings.
--
-- m365_perm_ledger records every mailbox_assignments row the access sync
-- itself wrote: which level it wrote and the exact assigned_at marker it
-- stamped (millisecond precision, which datetime('now') elsewhere never
-- produces). The sync changes or removes an assignment only while the live
-- row still carries that marker, that level and no assigned_by. Anything else
-- is a manager's assignment and is never touched.
--
-- The two triggers make that hand-over automatic: any delete of the
-- assignment (Admin unassign, offboarding, a cascade) drops the ledger row,
-- and any update that leaves the row with a different assigned_at (a
-- manager's re-assign stamps datetime('now') and their own id) drops it too.
-- The sync's own level change moves the ledger marker first, in the same
-- batch, so its update keeps the row.
--
-- m365_perm_state is a single row: switch-independent run state (last run,
-- result, consecutive failures, the round in progress, a bounded report).
-- m365_perm_group_members holds the expanded members of groups that were
-- granted access, per round, and is cleared when the round ends.
--
-- Nothing here deletes mail or mailboxes, and no existing row changes.
--
-- Upgrade note: additive only (three new tables, two new triggers). Apply
-- with the normal `pnpm db:migrate`.

CREATE TABLE IF NOT EXISTS m365_perm_ledger (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level_written TEXT NOT NULL CHECK (level_written IN ('read', 'send-as', 'full')),
  assigned_at_written TEXT NOT NULL CHECK (length(assigned_at_written) BETWEEN 19 AND 32),
  exchange_rights INTEGER NOT NULL DEFAULT 0 CHECK (exchange_rights BETWEEN 0 AND 3),
  round_id TEXT NOT NULL DEFAULT '' CHECK (length(round_id) <= 64),
  written_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_m365_perm_ledger_user ON m365_perm_ledger(user_id);

CREATE TRIGGER IF NOT EXISTS trg_m365_perm_assignment_delete
AFTER DELETE ON mailbox_assignments
BEGIN
  DELETE FROM m365_perm_ledger WHERE mailbox_id = OLD.mailbox_id AND user_id = OLD.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_m365_perm_assignment_update
AFTER UPDATE ON mailbox_assignments
BEGIN
  DELETE FROM m365_perm_ledger
  WHERE mailbox_id = OLD.mailbox_id AND user_id = OLD.user_id
    AND (assigned_at_written IS NOT NEW.assigned_at OR NEW.assigned_by IS NOT NULL
      OR NEW.mailbox_id IS NOT OLD.mailbox_id OR NEW.user_id IS NOT OLD.user_id);
END;

CREATE TABLE IF NOT EXISTS m365_perm_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL DEFAULT '{}' CHECK (length(state) <= 1048576),
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS m365_perm_group_members (
  round_id TEXT NOT NULL CHECK (length(round_id) <= 64),
  group_id TEXT NOT NULL CHECK (length(group_id) = 36),
  member_id TEXT NOT NULL CHECK (length(member_id) = 36),
  PRIMARY KEY (round_id, group_id, member_id)
);
