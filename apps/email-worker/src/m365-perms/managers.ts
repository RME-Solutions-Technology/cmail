// Optional: shared mailbox access for unlinked manager accounts
// (docs/m365-mailbox-permissions.md, "Manager accounts"). Off by default
// (org setting m365_perms_include_managers).
//
// The Microsoft 365 sync never adopts a manager account, so a manager has no
// person link and every Exchange grant to them is skipped as
// trusteeNotLinked. With the switch on, an unlinked, active manager is matched
// to the Entra user whose primary SMTP address equals the manager's Stanchion
// address exactly, on MAIL_DOMAIN: Graph `mail` must equal it and the user's
// proxyAddresses must hold it as the primary entry (`SMTP:`), and exactly one
// Entra member user and exactly one manager must match. Nothing is written
// here: no person link is created and the directory sync keeps ignoring
// managers. The diff then treats the match like a link, for additions and
// raises only.
import type { M365PermsManagerMatch, M365PermsReportItem } from '@stanchion/shared/m365-perms';
import { primaryAddress } from '../m365-sync/classify';
import { GraphError } from '../m365-sync/graph';
import type { PermsApplyContext } from './apply';
import type { PersonLink } from './diff';
import type { PermsGraphClient } from './groups';

/** Manager accounts looked up per round. With more, each round starts after the last one looked up. */
export const MAX_MANAGER_LOOKUPS = 20;
/** Unlinked manager accounts listed per round (the rotation works within these). */
const MAX_MANAGERS_LISTED = 500;
/** Report rows manager matching may add, so the diff's own rows keep their room. */
export const MAX_MANAGER_REPORT_ROWS = MAX_MANAGER_LOOKUPS + 1;

export type ManagerMatchOutcome =
  | 'matched'
  | 'graph_not_configured'
  | 'not_on_mail_domain'
  | 'no_entra_user'
  | 'ambiguous'
  | 'address_mismatch'
  | 'not_primary_smtp'
  | 'not_member'
  | 'account_disabled'
  | 'object_linked'
  | 'lookup_failed'
  | 'too_many_managers';

export interface ManagerMatchResult {
  matches: M365PermsManagerMatch[];
  /** Account ids of the managers looked at this round, matched or not. */
  lookedAt: string[];
  /** Where the next round starts ('' = from the first). */
  nextCursor: string;
  /** One row per manager looked at (the manager's own address, shown in Admin only). */
  report: M365PermsReportItem[];
  /** Counts by outcome: safe to log. */
  outcomes: Partial<Record<ManagerMatchOutcome, number>>;
}

interface ManagerRow { id: string; email: string }

/** Active manager accounts with no Microsoft 365 link. */
async function loadUnlinkedManagers(ctx: PermsApplyContext): Promise<ManagerRow[]> {
  ctx.ops += 1;
  const { results } = await ctx.db.prepare(
    `SELECT u.id, lower(u.email) AS email FROM users u
     WHERE u.role = 'manager' AND u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM m365_sync_links l WHERE l.user_id = u.id)
     ORDER BY u.id LIMIT ?`,
  ).bind(MAX_MANAGERS_LISTED).all<ManagerRow>();
  return results ?? [];
}

async function objectLinked(ctx: PermsApplyContext, objectId: string): Promise<boolean> {
  ctx.ops += 1;
  const row = await ctx.db.prepare('SELECT 1 AS n FROM m365_sync_links WHERE lower(object_id) = ? LIMIT 1').bind(objectId).first<{ n: number }>();
  return Boolean(row);
}

/** The managers this round looks up: up to MAX_MANAGER_LOOKUPS, starting after `cursor`, wrapping round. */
export function pickManagers<T extends { id: string }>(all: readonly T[], cursor: string): T[] {
  if (all.length <= MAX_MANAGER_LOOKUPS) return [...all];
  const start = Math.max(0, all.findIndex((manager) => manager.id > cursor));
  return [...all.slice(start), ...all.slice(0, start)].slice(0, MAX_MANAGER_LOOKUPS);
}

/**
 * Matches unlinked managers to Entra users. Read-only (D1 and Graph). A
 * failed lookup only leaves that manager unmatched this round.
 * `canContinue` is the tick's time and D1 budget; managers it leaves out are
 * `lookup_failed` this round.
 */
export async function resolveManagerMatches(
  ctx: PermsApplyContext,
  graph: PermsGraphClient | null,
  options: { mailDomain: string; graphBudget: number; cursor: string; canContinue: () => boolean },
): Promise<ManagerMatchResult> {
  const outcomes: Partial<Record<ManagerMatchOutcome, number>> = {};
  const report: M365PermsReportItem[] = [];
  const decided = new Map<string, ManagerMatchOutcome>();
  const decide = (manager: ManagerRow, outcome: ManagerMatchOutcome) => decided.set(manager.id, outcome);

  const all = await loadUnlinkedManagers(ctx);
  // Two manager accounts with the same address (case aside): neither is matched.
  const byEmail = new Map<string, number>();
  for (const manager of all) byEmail.set(manager.email, (byEmail.get(manager.email) ?? 0) + 1);
  const managers = pickManagers(all, options.cursor);

  const candidates: Array<{ manager: ManagerRow; objectId: string }> = [];
  let stopLookups = !graph;
  for (const manager of managers) {
    if (!graph) { decide(manager, 'graph_not_configured'); continue; }
    if (!primaryAddress({ id: manager.id, mail: manager.email }, options.mailDomain).onDomain) { decide(manager, 'not_on_mail_domain'); continue; }
    if ((byEmail.get(manager.email) ?? 0) > 1) { decide(manager, 'ambiguous'); continue; }
    if (stopLookups || graph.requests >= options.graphBudget || !options.canContinue()) { decide(manager, 'lookup_failed'); continue; }
    let users;
    try {
      users = await graph.usersByMail(manager.email);
    } catch (caught) {
      if (!(caught instanceof GraphError)) throw caught;
      // Only a malformed answer is about this one manager; anything else
      // (throttled, refused, network) stops the lookups for this round.
      if (caught.code !== 'bad_response') stopLookups = true;
      decide(manager, 'lookup_failed');
      continue;
    }
    if (users.length === 0) { decide(manager, 'no_entra_user'); continue; }
    if (users.length > 1) { decide(manager, 'ambiguous'); continue; }
    const user = users[0];
    const primary = primaryAddress({ id: user.id, mail: user.mail }, options.mailDomain);
    if (!primary.onDomain || primary.address !== manager.email) { decide(manager, 'address_mismatch'); continue; }
    // `mail` is not guaranteed to be the primary SMTP address: the proxy list must say so.
    if (!user.proxyAddresses.some((proxy) => proxy.startsWith('SMTP:') && proxy.slice(5).trim().toLowerCase() === manager.email)) {
      decide(manager, 'not_primary_smtp');
      continue;
    }
    if (user.userType !== 'Member') { decide(manager, 'not_member'); continue; }
    if (!user.accountEnabled) { decide(manager, 'account_disabled'); continue; }
    // An object the Microsoft 365 sync already links (to a person or a shared mailbox) is that link's, never a manager's.
    if (await objectLinked(ctx, user.id)) { decide(manager, 'object_linked'); continue; }
    candidates.push({ manager, objectId: user.id });
  }

  // One Entra user for two managers: neither.
  const byObject = new Map<string, number>();
  for (const candidate of candidates) byObject.set(candidate.objectId, (byObject.get(candidate.objectId) ?? 0) + 1);
  const matches: M365PermsManagerMatch[] = [];
  for (const { manager, objectId } of candidates) {
    if ((byObject.get(objectId) ?? 0) > 1) { decide(manager, 'ambiguous'); continue; }
    decide(manager, 'matched');
    matches.push({ objectId, userId: manager.id, email: manager.email });
  }

  for (const manager of managers) {
    const outcome = decided.get(manager.id) ?? 'lookup_failed';
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    report.push({ action: outcome === 'matched' ? 'manager_matched' : 'manager_not_matched', mailbox: '', user: manager.email, reason: outcome });
  }
  if (all.length > managers.length) {
    outcomes.too_many_managers = all.length - managers.length;
    report.push({ action: 'manager_not_matched', mailbox: '', user: '', reason: 'too_many_managers' });
  }
  return {
    matches,
    lookedAt: managers.map((manager) => manager.id),
    nextCursor: all.length > managers.length ? managers[managers.length - 1].id : '',
    report: report.slice(0, MAX_MANAGER_REPORT_ROWS),
    outcomes,
  };
}

/**
 * The matches still valid now, keyed by Entra object id, as diff links. A
 * match counts only while the account is still an active manager with the
 * same address and still has no Microsoft 365 link.
 */
export async function loadManagerLinks(ctx: PermsApplyContext, matches: readonly M365PermsManagerMatch[]): Promise<Map<string, PersonLink>> {
  const links = new Map<string, PersonLink>();
  if (!matches.length) return links;
  ctx.ops += 1;
  const ids = matches.slice(0, MAX_MANAGER_LOOKUPS).map((match) => match.userId);
  const { results } = await ctx.db.prepare(
    `SELECT u.id, lower(u.email) AS email FROM users u
     WHERE u.role = 'manager' AND u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM m365_sync_links l WHERE l.user_id = u.id)
       AND u.id IN (${ids.map(() => '?').join(', ')})`,
  ).bind(...ids).all<ManagerRow>();
  const current = new Map((results ?? []).map((row) => [row.id, row.email]));
  for (const match of matches) {
    if (current.get(match.userId) !== match.email) continue;
    links.set(match.objectId, { userId: match.userId, email: match.email, eligible: true, manager: true });
  }
  return links;
}

/** An account that holds sync-made access but has no person link. */
export interface UnlinkedAccount { email: string; manager: boolean; activeManager: boolean }

/**
 * Accounts with sync-made access (a ledger row) and no person link: matched
 * managers, managers whose match is gone, and people whose link is gone.
 */
export async function loadUnlinkedLedgerAccounts(ctx: PermsApplyContext): Promise<Map<string, UnlinkedAccount>> {
  ctx.ops += 1;
  const { results } = await ctx.db.prepare(
    `SELECT DISTINCT u.id, lower(u.email) AS email, u.role, u.status
     FROM m365_perm_ledger g JOIN users u ON u.id = g.user_id
     WHERE NOT EXISTS (SELECT 1 FROM m365_sync_links l WHERE l.user_id = u.id AND l.kind = 'person')`,
  ).all<{ id: string; email: string; role: string; status: string }>();
  return new Map((results ?? []).map((row) => [row.id, { email: row.email, manager: row.role === 'manager', activeManager: row.role === 'manager' && row.status === 'active' }]));
}
