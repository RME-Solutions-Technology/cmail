-- Exchange mirror, Graph source (docs/exchange-mirror.md#graph-source-recommended).
-- Optional and off by default: nothing writes these tables until a manager
-- turns the Graph source on in Admin > Exchange mirror and the email Worker
-- has the Microsoft 365 app settings.
--
-- graph_mirror_folders holds, per Stanchion mailbox and Exchange well-known
-- folder, where the Microsoft Graph delta query stands: the next page or
-- delta link (a Graph URL holding Microsoft's opaque state token, no mail
-- content), the receivedDateTime floor and the filing cap of the round in
-- progress, the newest receivedDateTime seen (the resync watermark after a
-- 410), and the last error code. ON DELETE CASCADE drops a mailbox's rows
-- with it. It holds no address, subject or mail content.
--
-- graph_mirror_state is a single row: a short lease so two cron runs never
-- pull together, the round-robin cursor (the last mailbox id worked), and
-- the status Admin shows (JSON: times, counts and codes only).
--
-- Upgrade note: additive only (two new tables). Apply with the normal
-- `pnpm db:migrate`. No existing row changes.

CREATE TABLE IF NOT EXISTS graph_mirror_folders (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sentitems', 'archive')),
  link TEXT CHECK (link IS NULL OR length(link) <= 8192),
  link_kind TEXT NOT NULL DEFAULT 'none' CHECK (link_kind IN ('none', 'next', 'delta')),
  since_ms INTEGER NOT NULL DEFAULT 0 CHECK (since_ms >= 0),
  round_cap INTEGER NOT NULL DEFAULT 0 CHECK (round_cap >= 0),
  round_filed INTEGER NOT NULL DEFAULT 0 CHECK (round_filed >= 0),
  watermark_ms INTEGER NOT NULL DEFAULT 0 CHECK (watermark_ms >= 0),
  last_ok_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '' CHECK (length(last_error) <= 64),
  retry_after_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mailbox_id, folder)
);

CREATE TABLE IF NOT EXISTS graph_mirror_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_until INTEGER NOT NULL DEFAULT 0,
  cursor TEXT NOT NULL DEFAULT '' CHECK (length(cursor) <= 64),
  import_older_done INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT '{}' CHECK (length(state) <= 65536),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
