// Pure mapping and diff for shared mailbox access (no I/O). The rules are in
// docs/m365-mailbox-permissions.md, "Mapping" and "Safety rules". In short:
// - Exchange rights are combined per (shared mailbox, person), direct grants
//   and group grants together.
// - Full Access + Send As -> Stanchion Full. Full Access alone -> Stanchion Read (or
//   Full with M365_PERMS_FULLACCESS_IMPLIES_SEND). Send As alone has no Stanchion
//   equivalent (Stanchion Send as includes reading) and grants nothing.
// - Never more than Exchange grants.
// - Only rows the sync wrote (ledger row + live row still carrying the sync's
//   marker, level and no assigned_by) are ever raised, lowered or removed.
//   Every other row is a manager's and is left as it is.
// - Removals and downgrades only for mailboxes the snapshot fully covered.
// - A manager account matched by address (switch on, managers.ts) is only
//   ever given or raised access, never lowered or removed.
import {
  M365_PERMS_BRAKE_MIN,
  M365_PERMS_REPORT_LIMIT,
  emptyM365PermsCounts,
  type M365PermsBrake,
  type M365PermsCounts,
  type M365PermsReportItem,
} from '@stanchion/shared/m365-perms';
import type { PermissionSnapshot } from './snapshot';

export type StanchionLevel = 'read' | 'send-as' | 'full';
export const LEVEL_RANK: Record<StanchionLevel, number> = { read: 1, 'send-as': 2, full: 3 };

/** Bit flags kept in the ledger: what Exchange granted when the row was written. */
export const RIGHT_FULL_ACCESS = 1;
export const RIGHT_SEND_AS = 2;

export interface SharedLink { mailboxId: string; address: string }
export interface PersonLink {
  userId: string;
  email: string;
  /** Linked, in scope and active or pending: may receive new access. */
  eligible: boolean;
  /** An unlinked manager account matched by address: additions and raises only. */
  manager?: boolean;
}
export interface LiveAssignment { permissions: StanchionLevel; assignedAt: string; assignedBy: string | null }
export interface LedgerRow { level: StanchionLevel; assignedAt: string }

export interface DiffInput {
  snapshot: PermissionSnapshot;
  /** Entra object id -> linked Stanchion shared mailbox. */
  sharedLinks: Map<string, SharedLink>;
  /** Entra object id -> linked Stanchion person (and, switch on, matched manager accounts). */
  personLinks: Map<string, PersonLink>;
  /** Expanded group members (user object ids) by group object id. */
  groupMembers: Map<string, Set<string>>;
  /** Groups expanded this round (even when empty). Any other group leaves its mailboxes not covered. */
  expandedGroups: Set<string>;
  /** Groups that could not be expanded: mailboxes granting them are not covered. */
  failedGroups: Set<string>;
  /** `${mailboxId}|${userId}` pairs whose sync-made access a manager removed: never given back while Exchange grants it. */
  released: Set<string>;
  /** `${mailboxId}|${userId}` -> live assignment, for linked shared mailboxes. */
  assignments: Map<string, LiveAssignment>;
  /** `${mailboxId}|${userId}` -> ledger row. */
  ledger: Map<string, LedgerRow>;
  fullAccessImpliesSend: boolean;
  /**
   * Accounts with sync-made access, no person link and no manager match this
   * round whose state the sync can still judge (managers not looked up this
   * round are left out): their rows on a fully read mailbox are kept and
   * reported, never removed.
   */
  unlinkedAccounts?: Map<string, { email: string; manager: boolean; activeManager: boolean }>;
}

export type DiffOp =
  | { type: 'add'; mailboxId: string; userId: string; level: StanchionLevel; rights: number; mailbox: string; user: string }
  | { type: 'upgrade' | 'downgrade'; mailboxId: string; userId: string; from: StanchionLevel; level: StanchionLevel; marker: string; rights: number; mailbox: string; user: string }
  | { type: 'remove'; mailboxId: string; userId: string; from: StanchionLevel; marker: string; mailbox: string; user: string }
  /** Ledger row whose assignment is no longer the sync's: forget it (no assignment change). */
  | { type: 'release'; mailboxId: string; userId: string; mailbox: string; user: string }
  /** Exchange no longer grants a pair a manager had removed: forget that mark (no assignment change). */
  | { type: 'unblock'; mailboxId: string; userId: string; mailbox: string; user: string };

export interface DiffResult {
  ops: DiffOp[];
  counts: M365PermsCounts;
  report: M365PermsReportItem[];
  /** Ledger rows the sync still owns (the brake's base). */
  owned: number;
  /** Total grants in the snapshot. */
  grants: number;
}

export const key = (mailboxId: string, userId: string) => `${mailboxId}|${userId}`;

export function levelFor(rights: number, fullAccessImpliesSend: boolean): StanchionLevel | null {
  const fa = (rights & RIGHT_FULL_ACCESS) !== 0;
  const sa = (rights & RIGHT_SEND_AS) !== 0;
  if (fa && sa) return 'full';
  if (fa) return fullAccessImpliesSend ? 'full' : 'read';
  return null;
}

export function isOwned(live: LiveAssignment | undefined, ledger: LedgerRow | undefined): boolean {
  return Boolean(live && ledger && live.assignedBy === null && live.permissions === ledger.level && live.assignedAt === ledger.assignedAt);
}

export function computeDiff(input: DiffInput): DiffResult {
  const counts = emptyM365PermsCounts();
  const report: M365PermsReportItem[] = [];
  const note = (countKey: keyof M365PermsCounts, item?: M365PermsReportItem) => {
    counts[countKey] += 1;
    if (item && report.length < M365_PERMS_REPORT_LIMIT) report.push(item);
  };

  // Which linked mailboxes this snapshot covers fully (removals allowed).
  const inSnapshot = new Map<string, { mailboxId: string; address: string; covered: boolean }>();
  let grants = 0;
  // `${mailboxId}|${userId}` -> combined rights.
  const wanted = new Map<string, { mailboxId: string; userId: string; rights: number; mailbox: string; user: string }>();

  for (const mailbox of input.snapshot.mailboxes) {
    grants += mailbox.grants.length;
    const link = input.sharedLinks.get(mailbox.id);
    if (!link) {
      // Not linked yet (the Microsoft 365 sync creates it on its next run).
      note('mailboxNotLinked', { action: 'mailbox_not_linked', mailbox: mailbox.address, user: '', reason: 'mailbox_not_linked' });
      continue;
    }
    let covered = mailbox.complete;
    const unlinked = new Set<string>();
    for (const grant of mailbox.grants) {
      const rights = (grant.fullAccess ? RIGHT_FULL_ACCESS : 0) | (grant.sendAs ? RIGHT_SEND_AS : 0);
      let members: Iterable<string>;
      if (grant.kind === 'group') {
        if (!input.expandedGroups.has(grant.trustee) || input.failedGroups.has(grant.trustee)) {
          covered = false;
          continue;
        }
        members = input.groupMembers.get(grant.trustee) ?? [];
      } else {
        members = [grant.trustee];
      }
      for (const objectId of members) {
        const person = input.personLinks.get(objectId);
        if (!person) {
          if (grant.kind === 'user') unlinked.add(objectId);
          continue;
        }
        const k = key(link.mailboxId, person.userId);
        if (person.manager && !wanted.has(k)) note('managerMatched');
        const entry = wanted.get(k) ?? { mailboxId: link.mailboxId, userId: person.userId, rights: 0, mailbox: link.address, user: person.email };
        entry.rights |= rights;
        wanted.set(k, entry);
      }
    }
    for (const _ of unlinked) note('trusteeNotLinked');
    inSnapshot.set(link.mailboxId, { mailboxId: link.mailboxId, address: link.address, covered });
  }

  const persons = new Map<string, PersonLink>();
  for (const person of input.personLinks.values()) persons.set(person.userId, person);

  const adds: DiffOp[] = [];
  const lowers: DiffOp[] = [];
  const releases: DiffOp[] = [];

  for (const [k, entry] of wanted) {
    const level = levelFor(entry.rights, input.fullAccessImpliesSend);
    const live = input.assignments.get(k);
    const ledger = input.ledger.get(k);
    if (!level) {
      // Send As without Full Access: Stanchion cannot send without reading.
      note('notRepresentable', { action: 'not_representable', mailbox: entry.mailbox, user: entry.user, reason: 'sendas_without_read' });
      // A sync-made row stays until the snapshot covers the mailbox; then it goes like any other.
      continue;
    }
    if (!live) {
      if (input.released.has(k)) {
        // A manager removed the access the sync gave: it stays removed.
        note('managerKept', { action: 'manager_removed', mailbox: entry.mailbox, user: entry.user, reason: 'removed_by_manager' });
        continue;
      }
      if (!persons.get(entry.userId)?.eligible) {
        note('trusteeNotLinked', { action: 'skipped', mailbox: entry.mailbox, user: entry.user, reason: 'account_not_active' });
        continue;
      }
      adds.push({ type: 'add', mailboxId: entry.mailboxId, userId: entry.userId, level, rights: entry.rights, mailbox: entry.mailbox, user: entry.user });
      continue;
    }
    if (!isOwned(live, ledger)) {
      if (ledger) releases.push({ type: 'release', mailboxId: entry.mailboxId, userId: entry.userId, mailbox: entry.mailbox, user: entry.user });
      if (live.permissions !== level) {
        note('managerKept', { action: 'manager_kept', mailbox: entry.mailbox, user: entry.user, reason: `manager_set_${live.permissions}_exchange_${level}` });
      } else {
        note('unchanged');
      }
      continue;
    }
    if (live.permissions === level) {
      note('unchanged');
      continue;
    }
    const raise = LEVEL_RANK[level] > LEVEL_RANK[live.permissions];
    if (!raise && persons.get(entry.userId)?.manager) {
      // A manager account's access is never lowered by the sync.
      note('managerAccountKept', { action: 'manager_account_kept', mailbox: entry.mailbox, user: entry.user, reason: 'manager_account_not_lowered' });
    } else if (raise && !persons.get(entry.userId)?.eligible) {
      note('trusteeNotLinked', { action: 'skipped', mailbox: entry.mailbox, user: entry.user, reason: 'account_not_active' });
    } else if (raise) {
      adds.push({ type: 'upgrade', mailboxId: entry.mailboxId, userId: entry.userId, from: live.permissions, level, marker: live.assignedAt, rights: entry.rights, mailbox: entry.mailbox, user: entry.user });
    } else if (inSnapshot.get(entry.mailboxId)?.covered) {
      lowers.push({ type: 'downgrade', mailboxId: entry.mailboxId, userId: entry.userId, from: live.permissions, level, marker: live.assignedAt, rights: entry.rights, mailbox: entry.mailbox, user: entry.user });
    } else {
      note('unchanged');
    }
  }

  let owned = 0;
  for (const [k, ledger] of input.ledger) {
    const live = input.assignments.get(k);
    const [mailboxId, userId] = k.split('|');
    const isMine = isOwned(live, ledger);
    if (isMine) owned += 1;
    if (wanted.has(k) && levelFor(wanted.get(k)!.rights, input.fullAccessImpliesSend)) continue;
    const mailbox = inSnapshot.get(mailboxId);
    const user = persons.get(userId)?.email ?? '';
    if (!isMine) {
      releases.push({ type: 'release', mailboxId, userId, mailbox: mailbox?.address ?? '', user });
      continue;
    }
    // Exchange no longer grants it (or grants only Send As). Removed only when
    // the snapshot fully covered this mailbox, and only for a person still
    // linked (a lost link is not Exchange taking access away); otherwise kept.
    if (!mailbox?.covered) continue;
    if (!persons.has(userId)) {
      // No link and no manager match: the sync cannot tell whether Exchange
      // still grants this account anything, so the row stays, but it is
      // reported rather than kept silently.
      const unlinked = input.unlinkedAccounts?.get(userId);
      if (unlinked) {
        note('unlinkedKept', {
          action: 'unlinked_kept',
          mailbox: mailbox.address,
          user: unlinked.email,
          reason: unlinked.manager ? 'manager_account_not_matched' : 'account_not_linked',
        });
      }
      continue;
    }
    // A manager account's access is never removed by the sync.
    if (persons.get(userId)?.manager) {
      note('managerAccountKept', { action: 'manager_account_kept', mailbox: mailbox.address, user, reason: 'manager_account_not_removed' });
      continue;
    }
    lowers.push({ type: 'remove', mailboxId, userId, from: live!.permissions, marker: live!.assignedAt, mailbox: mailbox.address, user });
  }

  // Manager-removed marks whose grant Exchange has since taken away: forget
  // them, so a later new grant in Exchange counts again.
  const unblocks: DiffOp[] = [];
  for (const k of input.released) {
    const [mailboxId, userId] = k.split('|');
    const mailbox = inSnapshot.get(mailboxId);
    // Kept while the manager's row exists, or while Exchange still grants it.
    if (!mailbox?.covered || input.assignments.has(k)) continue;
    const want = wanted.get(k);
    if (want && levelFor(want.rights, input.fullAccessImpliesSend)) continue;
    unblocks.push({ type: 'unblock', mailboxId, userId, mailbox: mailbox.address, user: persons.get(userId)?.email ?? '' });
  }

  // Linked shared mailboxes this snapshot did not (fully) cover.
  const linkedMailboxIds = new Set([...input.sharedLinks.values()].map((link) => link.mailboxId));
  for (const mailboxId of linkedMailboxIds) {
    const seen = inSnapshot.get(mailboxId);
    if (!seen || !seen.covered) counts.mailboxNotCovered += 1;
  }

  // Releases dedupe (a row can be met from both sides).
  const seenRelease = new Set<string>();
  const uniqueReleases = releases.filter((op) => {
    const k = key(op.mailboxId, op.userId);
    if (seenRelease.has(k)) return false;
    seenRelease.add(k);
    return true;
  });

  return { ops: [...adds, ...uniqueReleases, ...unblocks, ...lowers], counts, report, owned, grants };
}

/**
 * The removal brake (same style as the mass-pause brake of the Microsoft 365
 * sync). Holds removals and downgrades (adds still apply) when:
 * - the snapshot lists no shared mailbox at all while the sync owns grants
 *   (never approvable: a wrong tenant or a lost role, not "nobody has access");
 * - it lists mailboxes but not a single grant while removals are due;
 * - removals plus downgrades are at least M365_PERMS_BRAKE_MIN and more than
 *   `maxPercent` of the grants the sync owns.
 */
export function brakeCheck(diff: DiffResult, snapshot: PermissionSnapshot, maxPercent: number): M365PermsBrake | null {
  const removals = diff.ops.filter((op) => op.type === 'remove' || op.type === 'downgrade').length;
  const percent = diff.owned ? Math.round((removals / diff.owned) * 100) : 0;
  if (snapshot.mailboxCount === 0 && diff.owned > 0) return { reason: 'empty_snapshot', removals, ledger: diff.owned, percent };
  if (diff.grants === 0 && removals > 0) return { reason: 'no_grants', removals, ledger: diff.owned, percent };
  if (removals >= M365_PERMS_BRAKE_MIN && removals * 100 > diff.owned * maxPercent) {
    return { reason: 'too_many_removals', removals, ledger: diff.owned, percent };
  }
  return null;
}
