-- Exchange mirror (docs/exchange-mirror.md). Optional and off by default:
-- nothing writes these tables until a manager turns the Exchange mirror or
-- the Microsoft 365 alias import on in Admin > Exchange mirror.
--
-- mailbox_aliases holds extra addresses that file into an existing mailbox.
-- Only the Exchange mirror reads it: the normal inbound path does not, so an
-- instance that never turns the alias import on behaves exactly as before.
-- Rows come only from the Microsoft 365 alias import (source 'm365'), keyed
-- by the Entra object id they were read from. An alias can never be another
-- mailbox's own address: the insert trigger refuses it, and creating or
-- renaming a mailbox to an alias address removes the alias (the real
-- mailbox always wins). ON DELETE CASCADE drops a mailbox's aliases with it.
--
-- exchange_mirror_days holds one row of counts per UTC day for Admin, and
-- the time of the last journal report. Rows older than 90 days are pruned by
-- the email Worker. It holds no address, subject or mail content.
--
-- m365_alias_sync_state is a single row: a short lease so two cron runs never
-- import together, and the last run's result and counts (JSON, no addresses).
--
-- Upgrade note: additive only (three new tables, two triggers). Apply with
-- the normal `pnpm db:migrate`. No existing row changes.

CREATE TABLE IF NOT EXISTS mailbox_aliases (
  address TEXT PRIMARY KEY CHECK (length(address) BETWEEN 3 AND 320 AND address = lower(address)),
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'm365' CHECK (source IN ('m365')),
  object_id TEXT NOT NULL CHECK (length(object_id) = 36),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mailbox_aliases_mailbox ON mailbox_aliases(mailbox_id);

CREATE TRIGGER IF NOT EXISTS trg_mailbox_aliases_not_primary_insert
BEFORE INSERT ON mailbox_aliases
WHEN EXISTS (SELECT 1 FROM mailboxes WHERE address = NEW.address)
BEGIN
  SELECT RAISE(ABORT, 'alias address belongs to a mailbox');
END;

CREATE TRIGGER IF NOT EXISTS trg_mailbox_aliases_not_primary_update
BEFORE UPDATE OF address ON mailbox_aliases
WHEN EXISTS (SELECT 1 FROM mailboxes WHERE address = NEW.address)
BEGIN
  SELECT RAISE(ABORT, 'alias address belongs to a mailbox');
END;

CREATE TRIGGER IF NOT EXISTS trg_mailboxes_insert_drops_alias
AFTER INSERT ON mailboxes
BEGIN
  DELETE FROM mailbox_aliases WHERE address = NEW.address;
END;

CREATE TRIGGER IF NOT EXISTS trg_mailboxes_address_drops_alias
AFTER UPDATE OF address ON mailboxes
WHEN NEW.address IS NOT OLD.address
BEGIN
  DELETE FROM mailbox_aliases WHERE address = NEW.address;
END;

CREATE TABLE IF NOT EXISTS exchange_mirror_days (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  received INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0),
  filed INTEGER NOT NULL DEFAULT 0 CHECK (filed >= 0),
  sent_filed INTEGER NOT NULL DEFAULT 0 CHECK (sent_filed >= 0),
  duplicates INTEGER NOT NULL DEFAULT 0 CHECK (duplicates >= 0),
  unmatched INTEGER NOT NULL DEFAULT 0 CHECK (unmatched >= 0),
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  last_report_at INTEGER,
  last_filed_at INTEGER,
  last_problem TEXT NOT NULL DEFAULT '' CHECK (length(last_problem) <= 64),
  last_problem_at INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS m365_alias_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT '{}' CHECK (length(state) <= 65536),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
