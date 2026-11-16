-- Secret vault and setup-wizard runs (docs/secret-vault.md). Optional and
-- off by default: nothing reads or writes these tables until a manager uses
-- the Microsoft 365 setup wizard (later releases) or the vault RPC, and every
-- existing env secret keeps winning over a vault value (env-first).
--
-- secret_vault holds AES-256-GCM ciphertext only. The data key is derived
-- with HKDF from the email Worker secret CMAIL_VAULT_KEY, which is never in
-- D1. A D1 export, Time Travel restore or backup therefore holds no usable
-- secret; restoring vault rows needs the same CMAIL_VAULT_KEY.
--   id:          random UUID, bound into the additional authenticated data
--                (AAD) together with name, version and purpose, so a row's
--                ciphertext cannot be moved to another row or name.
--   name:        one of the registered names (packages/shared/src/secret-vault.ts).
--   version:     1, 2, 3 ... per name; a new value is a new version.
--   purpose:     the registered purpose, also bound into the AAD.
--   kek_id:      fingerprint of the vault key that encrypted the row
--                ("v1-" + 16 hex), so a key change can re-encrypt (rewrap).
--   iv:          base64 96-bit GCM nonce, random per encryption.
--   ciphertext:  base64 ciphertext with the 128-bit GCM tag.
--   status:      active (at most one per name) or retired (kept for rollback).
--   not_after:   optional expiry of the secret itself (epoch ms), e.g. a
--                certificate's notAfter; informational in this release.
--   Times are epoch milliseconds; created_by is a cMail user id, never a value.
--
-- setup_run is one Microsoft 365 setup-wizard session (filled by a later
-- release): the manager who started it, the step state machine and plans
-- (no secrets), and the session's delegated tokens as one encrypted blob
-- under the same vault key (AAD = run id + purpose), deleted at finish,
-- disconnect or expiry (at most 90 minutes).
--
-- Upgrade note: additive only (two new tables and their indexes). Apply with
-- the normal `pnpm db:migrate`. No existing row changes. Does not depend on
-- 0022 to 0029.

CREATE TABLE IF NOT EXISTS secret_vault (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 64),
  kek_id TEXT NOT NULL CHECK (length(kek_id) BETWEEN 1 AND 32),
  iv TEXT NOT NULL CHECK (length(iv) BETWEEN 1 AND 32),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 1 AND 32768),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  not_after INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT CHECK (created_by IS NULL OR length(created_by) <= 64),
  retired_at INTEGER,
  rewrapped_at INTEGER,
  UNIQUE (name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_secret_vault_one_active
  ON secret_vault(name) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_secret_vault_kek ON secret_vault(kek_id);

CREATE TABLE IF NOT EXISTS setup_run (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 64),
  actor_oid TEXT CHECK (actor_oid IS NULL OR length(actor_oid) <= 64),
  tenant_id TEXT CHECK (tenant_id IS NULL OR length(tenant_id) <= 64),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished', 'cancelled', 'expired')),
  step TEXT NOT NULL DEFAULT 'preflight' CHECK (length(step) BETWEEN 1 AND 32),
  state TEXT NOT NULL DEFAULT '{}' CHECK (length(state) <= 65536),
  plans TEXT NOT NULL DEFAULT '{}' CHECK (length(plans) <= 262144),
  tokens_kek_id TEXT CHECK (tokens_kek_id IS NULL OR length(tokens_kek_id) <= 32),
  tokens_iv TEXT CHECK (tokens_iv IS NULL OR length(tokens_iv) <= 32),
  tokens_ciphertext TEXT CHECK (tokens_ciphertext IS NULL OR length(tokens_ciphertext) <= 65536),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_setup_run_status ON setup_run(status, expires_at);
