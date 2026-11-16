-- Microsoft 365 welcome emails (docs/m365-welcome-emails.md). Optional and
-- off by default: nothing writes these tables until a manager turns
-- "Welcome emails" on in Admin > Microsoft 365 sync, the sync is on and not
-- in dry run, and the email Worker can send.
--
-- m365_welcome_emails is the once-only record: at most one row per account
-- (user_id is the primary key). A row is created when the Worker queues the
-- person's welcome email, and it is never created twice, so a person is
-- emailed once unless a manager presses Resend (which re-queues the same row).
-- It holds delivery bookkeeping only: no subject, body, address or name.
--   status: queued (waiting to send, possibly after a failed attempt),
--           sending (claimed by one run; a run that dies mid-send leaves it
--           here and the next run marks it failed/outcome_unknown, never
--           sends it again on its own), sent, failed (gave up or permanent
--           refusal), skipped (no longer eligible when its turn came).
--   origin: auto (queued by the Worker under the switch's choice),
--           resend (a manager pressed Resend or Send).
--   Times are epoch milliseconds.
--
-- m365_welcome_state is a single row: the last run's result and problem,
-- the send times of the last hour (the hourly rate limit), the dry-run
-- report, and a lease so two overlapping cron runs never send together.
--
-- ON DELETE CASCADE only drops the bookkeeping row when a manager deletes
-- the account itself.
--
-- Upgrade note: additive only (two new tables, one seeded state row). Apply
-- with the normal `pnpm db:migrate`. No existing row changes. It does not
-- depend on 0023 to 0028; it needs 0022 (m365_sync_links) only at run time.

CREATE TABLE IF NOT EXISTS m365_welcome_emails (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  origin TEXT NOT NULL CHECK (origin IN ('auto', 'resend')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  sent_at INTEGER,
  last_error TEXT NOT NULL DEFAULT '' CHECK (length(last_error) <= 64),
  message_id TEXT CHECK (message_id IS NULL OR length(message_id) <= 256),
  requested_by TEXT CHECK (requested_by IS NULL OR length(requested_by) <= 64),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_m365_welcome_emails_due
  ON m365_welcome_emails(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS m365_welcome_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL DEFAULT '{}' CHECK (length(state) <= 65536),
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO m365_welcome_state (id) VALUES (1);
