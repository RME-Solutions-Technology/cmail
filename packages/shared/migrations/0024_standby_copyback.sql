-- Copy standby mail back into Exchange Online (docs/copy-back.md). Optional
-- and off by default: nothing writes these tables until a manager turns the
-- copy-back switch on in Admin > Copy back to Exchange, runs a dry run and
-- presses Start.
--
-- standby_copyback_jobs: one row per copy job a manager started (time window,
-- one mailbox or all, folders). At most one job runs at a time. lease_until
-- stops two overlapping cron invocations from working the same job.
--
-- standby_copyback_items: one row per (Stanchion message id, Entra object id of
-- the target mailbox). It is the memory that makes the copy idempotent: a row
-- in state 'copied' is final (the triggers below refuse to change it back or
-- delete it), so a message is never copied to the same mailbox twice, even by
-- a later job with an overlapping window. There is deliberately no foreign key
-- to messages: retention or a manager may delete a message in Stanchion, and that
-- must neither be blocked by this table nor erase the "already copied" record.
--
-- Nothing here deletes or changes mail. The rows hold ids, states and short
-- reason codes only: no subjects, addresses or content.
--
-- Stanchion message ids come in more than one shape (a UUID for most mail,
-- 'inbound-' + 64 hex characters for inbound mail with a Message-ID), so ids
-- here allow up to 128 characters.
--
-- Upgrade note: additive only (two new tables, three new indexes, one of them
-- on messages.received_at, and four triggers). Apply with the normal
-- `pnpm db:migrate`. No existing row changes.

CREATE TABLE IF NOT EXISTS standby_copyback_jobs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  -- halted: the Worker stopped the job itself (an Exchange create came back
  -- as a draft); a manager must look before anything else is copied.
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'cancelled', 'halted')),
  -- UTC 'YYYY-MM-DD HH:MM:SS', the same format as messages.received_at.
  -- window_from is inclusive, window_to exclusive.
  window_from TEXT NOT NULL CHECK (length(window_from) = 19),
  window_to TEXT NOT NULL CHECK (length(window_to) = 19 AND window_to > window_from),
  -- NULL = every linked mailbox; otherwise one Entra object id.
  target_object_id TEXT CHECK (target_object_id IS NULL OR length(target_object_id) = 36),
  -- The selection is frozen at Start: messages and Microsoft 365 links
  -- created after this time are not part of the job.
  as_of TEXT NOT NULL CHECK (length(as_of) = 19),
  folders TEXT NOT NULL DEFAULT 'inbox'
    CHECK (folders IN ('inbox', 'archive', 'sent', 'archive,inbox', 'inbox,sent', 'archive,sent', 'archive,inbox,sent')),
  -- Planning cursor: the last (received_at, message id, object id) queued.
  plan_cursor TEXT NOT NULL DEFAULT '' CHECK (length(plan_cursor) <= 256),
  plan_done INTEGER NOT NULL DEFAULT 0 CHECK (plan_done IN (0, 1)),
  lease_until INTEGER NOT NULL DEFAULT 0,
  backoff_until TEXT,
  backoff_streak INTEGER NOT NULL DEFAULT 0,
  last_tick_at TEXT,
  last_result TEXT NOT NULL DEFAULT '' CHECK (length(last_result) <= 32),
  last_error_code TEXT NOT NULL DEFAULT '' CHECK (length(last_error_code) <= 64),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_standby_copyback_one_running
  ON standby_copyback_jobs(status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS standby_copyback_items (
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 128),
  target_object_id TEXT NOT NULL CHECK (length(target_object_id) = 36),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'copied', 'failed', 'skipped')),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 64),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- failed: when the next retry is due, or NULL once retries are used up.
  next_attempt_at TEXT,
  job_id TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 64),
  copied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, target_object_id)
);
CREATE INDEX IF NOT EXISTS idx_standby_copyback_items_state
  ON standby_copyback_items(state, next_attempt_at);

-- The window selection reads messages by received time across mailboxes.
CREATE INDEX IF NOT EXISTS idx_messages_received_at
  ON messages(received_at);

-- A copied item is final: never back to pending, failed or skipped.
CREATE TRIGGER IF NOT EXISTS trg_standby_copyback_copied_final
BEFORE UPDATE OF state ON standby_copyback_items
WHEN OLD.state = 'copied' AND NEW.state IS NOT 'copied'
BEGIN
  SELECT RAISE(ABORT, 'standby copy-back: a copied item is final');
END;

-- No item is ever re-keyed (so UPDATE OR REPLACE cannot overwrite a copied row).
CREATE TRIGGER IF NOT EXISTS trg_standby_copyback_no_rekey
BEFORE UPDATE OF message_id, target_object_id ON standby_copyback_items
WHEN NEW.message_id IS NOT OLD.message_id OR NEW.target_object_id IS NOT OLD.target_object_id
BEGIN
  SELECT RAISE(ABORT, 'standby copy-back: items are never re-keyed');
END;

-- The "already copied" record is never deleted.
CREATE TRIGGER IF NOT EXISTS trg_standby_copyback_copied_kept
BEFORE DELETE ON standby_copyback_items
WHEN OLD.state = 'copied'
BEGIN
  SELECT RAISE(ABORT, 'standby copy-back: a copied item is kept');
END;

-- An insert can never claim a message was copied without the Worker saying
-- so through an update, and an insert of any kind (plain, OR IGNORE or OR
-- REPLACE) for a key that is already copied is dropped before conflict
-- handling runs. REPLACE's implicit delete does not fire delete triggers, so
-- this is the guard that stops INSERT OR REPLACE from resetting a copied row.
CREATE TRIGGER IF NOT EXISTS trg_standby_copyback_insert_guard
BEFORE INSERT ON standby_copyback_items
BEGIN
  SELECT RAISE(ABORT, 'standby copy-back: new items start pending')
  WHERE NEW.state IS NOT 'pending';
  SELECT RAISE(IGNORE)
  WHERE EXISTS (
    SELECT 1 FROM standby_copyback_items
    WHERE message_id = NEW.message_id AND target_object_id = NEW.target_object_id AND state = 'copied'
  );
END;
