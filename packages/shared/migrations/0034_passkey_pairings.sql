-- "Add a phone" with a QR code (docs/passkeys.md, "Add a phone"). Nothing
-- reads or writes this table until a signed-in person presses Add a phone on
-- Mail > Settings > Passkeys, and only while passkey sign-in is on.
--
-- One row is one short-lived pairing offer made by a signed-in person for one
-- new device:
-- - token_hash is the SHA-256 (hex) of a random 256-bit token that is shown
--   once in the QR code's URL fragment. The token itself is never stored.
-- - session_id is the session that created the offer. Every step needs that
--   session to be live, and only it can approve or deny.
-- - state moves forward only, by one conditional UPDATE per step:
--   offered -> joined (the phone presented the token) -> approved (the
--   creator approved this phone) -> consumed (the passkey was stored).
--   denied and expired are terminal (expired also covers a cancelled offer).
-- - device_label is a friendly name worked out from the phone's user agent,
--   and country is the two-letter country Cloudflare saw for the phone. Both
--   are shown to the approver and are never trusted for anything else.
-- - joiner_hash is the SHA-256 (hex) of a second random secret handed only to
--   the phone that joined, so another holder of the token cannot take over
--   after the approval.
-- - approve_code is a two-digit number shown on the phone. The approver must
--   pick it from three choices; wrong_tries counts wrong picks (three end the
--   offer). It stops an approval of a phone that is not in front of them.
-- - challenge_id is the registration challenge issued to the approved phone.
--   Verify must present the same one, so a challenge from another flow cannot
--   finish this pairing. credential_id is the passkey the pairing stored.
-- - expires_at is unix seconds (10 minutes after creation).
-- - A person has at most one open offer (offered, joined or approved): a
--   partial unique index enforces it, so two simultaneous offers cannot both
--   stay open.
-- - Deleting the account deletes its pairings (ON DELETE CASCADE).
--
-- Upgrade note: additive only (one new table and three indexes). Apply with
-- the normal `pnpm db:migrate` before deploying the web app. No existing row
-- or table changes.

CREATE TABLE IF NOT EXISTS passkey_pairings (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('offered', 'joined', 'approved', 'consumed', 'denied', 'expired')),
  device_label TEXT CHECK (device_label IS NULL OR length(device_label) <= 64),
  country TEXT CHECK (country IS NULL OR length(country) = 2),
  joiner_hash TEXT CHECK (joiner_hash IS NULL OR length(joiner_hash) = 64),
  approve_code TEXT CHECK (approve_code IS NULL OR length(approve_code) = 2),
  wrong_tries INTEGER NOT NULL DEFAULT 0 CHECK (wrong_tries >= 0),
  challenge_id TEXT CHECK (challenge_id IS NULL OR length(challenge_id) = 36),
  credential_id TEXT CHECK (credential_id IS NULL OR length(credential_id) <= 1366),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_passkey_pairings_user_state
  ON passkey_pairings(user_id, state);
CREATE INDEX IF NOT EXISTS idx_passkey_pairings_expiry
  ON passkey_pairings(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_passkey_pairings_one_open
  ON passkey_pairings(user_id) WHERE state IN ('offered', 'joined', 'approved');
