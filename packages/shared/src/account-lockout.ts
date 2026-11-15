// The lockout steps that go with pausing an account. Used by Admin > People
// (apps/web/src/routes/admin/users/+page.server.ts) and by the Microsoft 365
// sync (apps/email-worker/src/m365-sync/apply.ts), so both pause the same way.
//
// Each statement only acts while the account's status is 'paused', so it is
// safe in a batch whose status update may have changed nothing.

/** Revokes sessions, AI app (MCP) tokens and MCP grants of a paused account. */
export function pausedAccountLockoutStatements(db: D1Database, userId: string): D1PreparedStatement[] {
  return [
    db.prepare(
      `UPDATE sessions SET revoked = 1
       WHERE user_id = ? AND EXISTS (
         SELECT 1 FROM users WHERE id = ? AND status = 'paused'
       )`,
    ).bind(userId, userId),
    // Pausing also disconnects AI apps (MCP); reactivation does not restore them.
    db.prepare(
      `UPDATE mcp_tokens SET revoked_epoch = unixepoch()
       WHERE revoked_epoch IS NULL
         AND grant_id IN (SELECT id FROM mcp_grants WHERE user_id = ?)
         AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'paused')`,
    ).bind(userId, userId),
    db.prepare(
      `UPDATE mcp_grants SET revoked_epoch = unixepoch(), revoked_reason = 'paused'
       WHERE user_id = ? AND revoked_epoch IS NULL
         AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'paused')`,
    ).bind(userId, userId),
  ];
}
