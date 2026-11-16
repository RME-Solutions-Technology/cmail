-- Focused Inbox (docs/focused-inbox.md). Optional and off by default: nothing
-- reads or writes these columns and tables until a manager turns "Focused
-- Inbox" on in Admin > Settings (org_settings key focused_inbox_enabled).
--
-- messages.focus_class is the tab an Inbox message belongs to: 'focused',
-- 'other', or NULL (never sorted: the feature was off when it arrived, or the
-- message is not in the Inbox). NULL is shown under Focused, so nothing is
-- ever hidden. focus_reason is the short code of the signal that decided it
-- (FOCUS_REASONS in packages/shared/src/focused-inbox.ts). Other is a view of
-- the Inbox, not a folder: folder stays 'inbox'.
--
-- focus_mailbox_settings holds one row per mailbox whose owner (or a person
-- with Full access to a shared mailbox) changed the setting, plus the state of
-- the one-off sort of recent mail. A missing row means "on" once the
-- organisation switch is on.
--
-- focus_sender_overrides is the per-mailbox list of senders and domains that
-- always go to Focused or Other ("Always move messages from this sender").
-- It is never shared between mailboxes.
--
-- Upgrade note: additive only (two nullable columns, one partial index, two
-- new tables, one trigger). Apply with the normal `pnpm db:migrate`. No
-- existing row changes. Building the partial index reads the messages table
-- once; on a large database run it outside busy hours.

ALTER TABLE messages ADD COLUMN focus_class TEXT
  CHECK (focus_class IS NULL OR focus_class IN ('focused', 'other'));
ALTER TABLE messages ADD COLUMN focus_reason TEXT
  CHECK (focus_reason IS NULL OR length(focus_reason) BETWEEN 1 AND 32);

-- The Other tab and its unread count: Inbox rows of one mailbox by class.
CREATE INDEX IF NOT EXISTS idx_messages_inbox_focus
  ON messages(mailbox_id, focus_class, received_at DESC)
  WHERE folder = 'inbox';

CREATE TABLE IF NOT EXISTS focus_mailbox_settings (
  mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- The one-off sort of recent Inbox mail (bounded; see BACKFILL_LIMIT).
  backfill_status TEXT NOT NULL DEFAULT 'none'
    CHECK (backfill_status IN ('none', 'running', 'done', 'failed')),
  backfill_lease_until INTEGER NOT NULL DEFAULT 0,
  backfill_count INTEGER NOT NULL DEFAULT 0 CHECK (backfill_count >= 0),
  backfilled_at TEXT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS focus_sender_overrides (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
  pattern TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 320 AND pattern = lower(pattern)),
  focus_class TEXT NOT NULL CHECK (focus_class IN ('focused', 'other')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mailbox_id, kind, pattern)
);

-- MAX_OVERRIDES_PER_MAILBOX in focused-inbox.ts; the app checks first, this
-- keeps a concurrent or scripted insert from going past it.
CREATE TRIGGER IF NOT EXISTS trg_focus_sender_overrides_limit
BEFORE INSERT ON focus_sender_overrides
WHEN (SELECT COUNT(*) FROM focus_sender_overrides WHERE mailbox_id = NEW.mailbox_id) >= 1000
BEGIN
  SELECT RAISE(ABORT, 'focus override limit reached');
END;
