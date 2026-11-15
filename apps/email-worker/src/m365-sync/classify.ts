// Pure eligibility rules for the Microsoft 365 mailbox sync. See
// docs/m365-sync.md, "Which accounts are synced".
import { isGuid } from '@cmail/shared/m365-sync';
import type { GraphUser } from './graph';

export type OutReason =
  | 'deleted'
  | 'disabled'
  | 'guest'
  | 'no_mailbox_plan'
  | 'no_address'
  | 'other_domain'
  | 'not_in_scope_group'
  | 'in_shared_group'
  | 'not_seen';

export type Classification =
  | { kind: 'person'; address: string; displayName: string }
  | { kind: 'shared'; address: string; displayName: string }
  | { kind: 'out'; reason: OutReason; address: string };

/**
 * Exchange service plan states that still mean a working mailbox. Warning is
 * the licence grace period; Suspended, LockedOut and Deleted are not usable
 * (assignedPlan resource, capabilityStatus values).
 */
const USABLE_PLAN = new Set(['Enabled', 'Warning']);

/** Same rule as the web app's normalizeMailboxLocalPart, so every synced address is one Admin could create. */
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function hasExchangePlan(user: GraphUser): boolean {
  return Array.isArray(user.assignedPlans) && user.assignedPlans.some((plan) =>
    typeof plan?.service === 'string' && plan.service.toLowerCase() === 'exchange'
    && typeof plan.capabilityStatus === 'string' && USABLE_PLAN.has(plan.capabilityStatus));
}

/** The primary SMTP address (Graph `mail`), lower case, if it is a plain address on the mail domain. */
export function primaryAddress(user: GraphUser, mailDomain: string): { address: string; onDomain: boolean } {
  const raw = typeof user.mail === 'string' ? user.mail.trim().toLowerCase() : '';
  if (!raw || raw.length > 254 || /[\s<>"\u0000-\u001f\u007f]/.test(raw)) return { address: '', onDomain: false };
  const at = raw.lastIndexOf('@');
  if (at <= 0) return { address: '', onDomain: false };
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  return { address: raw, onDomain: domain === mailDomain && LOCAL_PART.test(local) && !local.includes('..') };
}

export function cleanDisplayName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';
}

/** True when a group membership check is needed to classify this object. */
export function needsGroupCheck(user: GraphUser, mailDomain: string, groups: { scope: string | null; shared: string | null }): boolean {
  if (user['@removed'] || !isGuid(user.id)) return false;
  if (!groups.scope && !groups.shared) return false;
  return primaryAddress(user, mailDomain).onDomain;
}

export function classify(
  user: GraphUser,
  mailDomain: string,
  groups: { scope: string | null; shared: string | null },
  memberOf: Set<string> | null,
): Classification {
  const { address, onDomain } = primaryAddress(user, mailDomain);
  if (user['@removed']) return { kind: 'out', reason: 'deleted', address };
  if (!address) return { kind: 'out', reason: 'no_address', address };
  if (!onDomain) return { kind: 'out', reason: 'other_domain', address };
  const displayName = cleanDisplayName(user.displayName);

  // An explicit shared-mailbox group is the only way to say "shared": Graph
  // has no reliable property for it. Membership wins over licences, because a
  // shared mailbox may carry a licence (archive, over 50 GB).
  if (groups.shared && memberOf?.has(groups.shared)) return { kind: 'shared', address, displayName };

  if (user.userType && user.userType !== 'Member') return { kind: 'out', reason: 'guest', address };
  if (user.accountEnabled !== true) return { kind: 'out', reason: 'disabled', address };
  if (!hasExchangePlan(user)) return { kind: 'out', reason: 'no_mailbox_plan', address };
  if (groups.scope && !memberOf?.has(groups.scope)) return { kind: 'out', reason: 'not_in_scope_group', address };
  return { kind: 'person', address, displayName };
}
