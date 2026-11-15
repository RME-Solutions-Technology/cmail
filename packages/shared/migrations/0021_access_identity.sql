-- Cloudflare Access bridge: allow 'access' in user_identities.provider.
--
-- The subject of an 'access' row is the Access `sub` claim, the stable user
-- id inside one Zero Trust organisation. See docs/staff-sign-in.md and
-- apps/web/src/lib/server/access-bridge.ts for the binding rules.
--
-- Uniqueness changes:
-- - (provider, subject) stays the primary key: one Access sub, one account.
-- - The old blanket UNIQUE(user_id) becomes two rules, so an account that
--   already signs in with Google, Microsoft or email can also hold exactly
--   one Access binding:
--     * UNIQUE(provider, user_id): at most one identity per provider.
--     * a partial unique index on user_id for every provider except
--       'access': at most one non-Access sign-in identity, as before.
--
-- This rebuilds user_identities only, the same safe pattern as 0013: no
-- other table has a foreign key to user_identities, so DROP TABLE here
-- cascades nowhere. `users` is not touched (see 0013 for why rebuilding
-- `users` on D1 would wipe sessions and assignments). users.auth_provider
-- keeps its narrow CHECK; Access-only accounts leave it at ''.
--
-- Upgrade note: apply with the normal `pnpm db:migrate`. Existing rows are
-- copied unchanged. Nothing uses 'access' until ACCESS_TEAM_DOMAIN and
-- ACCESS_AUD are configured.

CREATE TABLE user_identities_new (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft', 'email', 'access')),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, user_id)
);

INSERT INTO user_identities_new (provider, subject, user_id, created_at)
SELECT provider, subject, user_id, created_at FROM user_identities;

DROP TABLE user_identities;

ALTER TABLE user_identities_new RENAME TO user_identities;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_one_sign_in
  ON user_identities(user_id) WHERE provider <> 'access';
CREATE INDEX IF NOT EXISTS idx_user_identities_user
  ON user_identities(user_id);
