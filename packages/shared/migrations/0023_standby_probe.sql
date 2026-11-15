-- Standby test address and daily probe (docs/standby-probe.md). Optional and
-- off by default: nothing writes these tables until a manager turns the
-- standby address on in Admin > Standby test.
--
-- standby_probe_runs holds one row per probe: when it started, whether it
-- arrived, the round trip, and a short machine reason when it failed. At most
-- one probe is in flight at a time: in_flight is 1 while a probe is sending
-- or waiting and NULL once it has a result, and it is UNIQUE (NULLs never
-- collide), so a second concurrent start fails instead of sending twice.
-- Only a SHA-256 hash of the probe's random token is stored. Rows older than
-- 30 days are pruned by the email Worker.
--
-- standby_probe_state is a single row: the id of the dedicated system mailbox
-- the probe delivers to, a short lease so two cron runs never start a probe
-- together, and the last schedule times. ON DELETE SET NULL: if a manager
-- deletes the probe mailbox, the next run reports it instead of failing.
--
-- Nothing here deletes or changes real mail. The Worker only prunes probe
-- messages that a row here recorded, in the probe mailbox, after 7 days.
--
-- Upgrade note: additive only (two new tables). Apply with the normal
-- `pnpm db:migrate`. No existing row changes.

CREATE TABLE IF NOT EXISTS standby_probe_runs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('sending', 'waiting', 'pass', 'fail')),
  in_flight INTEGER UNIQUE CHECK (in_flight IS NULL OR in_flight = 1),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 64),
  detail TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 200),
  warnings TEXT NOT NULL DEFAULT '' CHECK (length(warnings) <= 200),
  started_at INTEGER NOT NULL,
  sent_at INTEGER,
  received_at INTEGER,
  round_trip_ms INTEGER,
  late_ms INTEGER,
  folder TEXT CHECK (folder IS NULL OR length(folder) <= 32),
  spf_result TEXT CHECK (spf_result IS NULL OR length(spf_result) <= 32),
  dkim_result TEXT CHECK (dkim_result IS NULL OR length(dkim_result) <= 32),
  dmarc_result TEXT CHECK (dmarc_result IS NULL OR length(dmarc_result) <= 32),
  message_id TEXT CHECK (message_id IS NULL OR length(message_id) <= 128),
  CHECK (
    (status IN ('sending', 'waiting') AND in_flight = 1)
    OR (status IN ('pass', 'fail') AND in_flight IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_standby_probe_runs_started
  ON standby_probe_runs(started_at);

CREATE TABLE IF NOT EXISTS standby_probe_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mailbox_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  -- Last daily probe actually sent, and last daily start that failed before sending.
  last_scheduled_at INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_manual_at INTEGER NOT NULL DEFAULT 0,
  last_tick_at INTEGER NOT NULL DEFAULT 0,
  last_problem TEXT NOT NULL DEFAULT '' CHECK (length(last_problem) <= 200),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
