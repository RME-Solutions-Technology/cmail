// Optional: shared mailbox access for unlinked manager accounts
// (docs/m365-mailbox-permissions.md, "Manager accounts"). Off by default
// (org setting m365_perms_include_managers).
//
// The Microsoft 365 sync never adopts a manager account, so a manager has no
// person link and every Exchange grant to them is skipped as
// trusteeNotLinked. With the switch on, an unlinked, active manager is matched
// to the Entra user whose primary SMTP address (Graph `mail`) equals the
// manager's cmail address exactly, on MAIL_DOMAIN, when exactly one Entra
// member user and exactly one manager match. Nothing is written here: no
// person link is created and the directory sync keeps ignoring managers. The
// diff then treats the match like a link, for additions and raises only.
import type { M365PermsManagerMatch, M365PermsReportItem } from '@cmail/shared/m365-perms';
import { GraphError } from '../m365-sync/graph';
import type { PermsApplyContext } from './apply';
import type { PersonLink } from './diff';
import type { PermsGraphClient } from './groups';

/** Manager accounts looked up per round; any beyond are reported and skipped. */
export const MAX_MANAGER_LOOKUPS = 20;

export type ManagerMatchOutcome =
  | 'matched'
  | 'graph_not_configured'
  | 'not_on_mail_domain'
  | 'no_entra_user'
  | 'ambiguous'
  | 'address_mismatch'
  | 'not_member'
  | 'account_disabled'
  | 'object_linked'
  | 'lookup_failed'
  | 'too_many_managers';

export interface ManagerMatchResult {
  matches: M365PermsManagerMatch[];
  /** One row per manager looked at (the manager's own address, shown in Admin only). */
  report: M365PermsReportItem[];
  /** Counts by outcome: safe to log. */
  outcomes: Partial<Record<ManagerMatchOutcome, number>>;
}

interface ManagerRow { id: string; email: string }

/** Active manager accounts with no Microsoft 365 link, plus one more to detect "too many". */
async function loadUnlinkedManagers(ctx: PermsApplyContext): Promise<ManagerRow[]> {
  ctx.ops += 1;
  const { results } = await ctx.db.prepare(
    `SELECT u.id, lower(u.email) AS email FROM users u
     WHERE u.role = 'manager' AND u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM m365_sync_links l WHERE l.user_id = u.id)
     ORDER BY u.id LIMIT ?`,
  ).bind(MAX_MANAGER_LOOKUPS + 1).all<ManagerRow>();
  return results ?? [];
}

async function objectLinked(ctx: PermsApplyContext, objectId: string): Promise<boolean> {
  ctx.ops += 1;
  const row = await ctx.db.prepare('SELECT 1 AS n FROM m365_sync_links WHERE lower(object_id) = ? LIMIT 1').bind(objectId).first<{ n: number }>();
  return Boolean(row);
}

function onDomain(address: string, mailDomain: string): boolean {
  const at = address.lastIndexOf('@');
  return at > 0 && address.slice(at + 1) === mailDomain;
}

/**
 * Matches unlinked managers to Entra users. Read-only (D1 and Graph). A
 * failed lookup only leaves that manager unmatched this round.
 */
export async function resolveManagerMatches(
  ctx: PermsApplyContext,
  graph: PermsGraphClient | null,
  mailDomain: string,
  graphBudget: number,
): Promise<ManagerMatchResult> {
  const outcomes: Partial<Record<ManagerMatchOutcome, number>> = {};
  const report: M365PermsReportItem[] = [];
  const decided = new Map<string, ManagerMatchOutcome>();
  const decide = (manager: ManagerRow, outcome: ManagerMatchOutcome) => decided.set(manager.id, outcome);

  const all = await loadUnlinkedManagers(ctx);
  const managers = all.slice(0, MAX_MANAGER_LOOKUPS);
  const byEmail = new Map<string, number>();
  for (const manager of managers) byEmail.set(manager.email, (byEmail.get(manager.email) ?? 0) + 1);

  const candidates: Array<{ manager: ManagerRow; objectId: string }> = [];
  let stopLookups = !graph;
  for (const manager of managers) {
    if (!graph) { decide(manager, 'graph_not_configured'); continue; }
    if (!onDomain(manager.email, mailDomain)) { decide(manager, 'not_on_mail_domain'); continue; }
    // Two manager accounts with the same address (case aside): neither is matched.
    if ((byEmail.get(manager.email) ?? 0) > 1) { decide(manager, 'ambiguous'); continue; }
    if (stopLookups || graph.requests >= graphBudget) { decide(manager, 'lookup_failed'); continue; }
    let users;
    try {
      users = await graph.usersByMail(manager.email);
    } catch (caught) {
      if (!(caught instanceof GraphError)) throw caught;
      // Throttled or refused: no more lookups this round; nothing changes for these managers.
      if (caught.code === 'throttled' || caught.code === 'unauthorized') stopLookups = true;
      decide(manager, 'lookup_failed');
      continue;
    }
    if (users.length === 0) { decide(manager, 'no_entra_user'); continue; }
    if (users.length > 1) { decide(manager, 'ambiguous'); continue; }
    const user = users[0];
    if ((user.mail ?? '').trim().toLowerCase() !== manager.email) { decide(manager, 'address_mismatch'); continue; }
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
  if (all.length > MAX_MANAGER_LOOKUPS) {
    outcomes.too_many_managers = all.length - MAX_MANAGER_LOOKUPS;
    report.push({ action: 'manager_not_matched', mailbox: '', user: '', reason: 'too_many_managers' });
  }
  return { matches, report, outcomes };
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
