-- Passkey break-glass sign-in (docs/passkeys.md). Optional and off by
-- default: nothing reads or writes these tables until a manager turns
-- passkey sign-in on in Admin > Passkey sign-in.
--
-- passkey_credentials holds one row per registered WebAuthn credential.
-- - id is the credential id (base64url), the primary key, so one credential
--   id can belong to only one account. Comparisons are binary (case-sensitive),
--   as base64url requires.
-- - user_handle is the random WebAuthn user.id given to the authenticator
--   (base64url of 32 random bytes, never an email or account id). An
--   account's later passkeys reuse it; sign-in checks the authenticator's
--   userHandle against the value stored on that credential.
-- - public_key is the COSE public key (base64url). counter is the last
--   signature counter seen; sign-in refuses a counter that does not go up
--   (unless the authenticator always reports 0, as synced passkeys do).
-- - Deleting the account deletes its passkeys (ON DELETE CASCADE).
--
-- passkey_challenges holds server-side WebAuthn challenges. Each is used at
-- most once (deleted when read) and expires after a few minutes. A
-- registration challenge is tied to the account and session that asked for
-- it and carries the user handle given to the authenticator; a sign-in
-- challenge is tied to nobody (discoverable credentials).
--
-- sessions.passkey_credential_id is the session's auth-method marker: set
-- only on sessions minted by a passkey sign-in, NULL for every other sign-in.
-- The Access bridge uses it to tell a passkey session from an ordinary cookie
-- session (docs/passkeys.md, "Cloudflare Access"). Removing the passkey ends
-- the sessions it opened (ON DELETE CASCADE; hooks.server.ts also checks).
--
-- Upgrade note: additive only (two new tables, one nullable column and two
-- indexes). Apply with the normal `pnpm db:migrate` before deploying the web
-- app. No existing row changes: every existing session keeps a NULL marker.
-- D1 records applied migrations, so the ALTER runs once, like 0020.

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 1366),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_handle TEXT NOT NULL CHECK (length(user_handle) BETWEEN 16 AND 128),
  public_key TEXT NOT NULL CHECK (length(public_key) BETWEEN 16 AND 4096),
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT NOT NULL DEFAULT '[]' CHECK (length(transports) <= 256),
  device_name TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 64),
  device_type TEXT NOT NULL DEFAULT 'singleDevice' CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  aaguid TEXT NOT NULL DEFAULT '' CHECK (length(aaguid) <= 36),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user
  ON passkey_credentials(user_id);

CREATE TABLE IF NOT EXISTS passkey_challenges (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  challenge TEXT NOT NULL UNIQUE CHECK (length(challenge) BETWEEN 32 AND 128),
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  user_handle TEXT CHECK (user_handle IS NULL OR length(user_handle) BETWEEN 16 AND 128),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (purpose = 'register' AND user_id IS NOT NULL AND session_id IS NOT NULL AND user_handle IS NOT NULL)
    OR (purpose = 'authenticate' AND user_id IS NULL AND session_id IS NULL AND user_handle IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expiry
  ON passkey_challenges(expires_at);

ALTER TABLE sessions
  ADD COLUMN passkey_credential_id TEXT REFERENCES passkey_credentials(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_sessions_passkey_credential
  ON sessions(passkey_credential_id) WHERE passkey_credential_id IS NOT NULL;
