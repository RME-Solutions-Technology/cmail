// Pure eligibility rules for the Microsoft 365 mailbox sync. See
// docs/m365-sync.md, "Which accounts are synced".
import { EXCHANGE_MAILBOX_PLANS, isGuid } from '@cmail/shared/m365-sync';
import type { GraphUser, PurposeLookup } from './graph';

export type OutReason =
  | 'deleted'
  | 'disabled'
  | 'guest'
  | 'no_mailbox_plan'
  | 'no_address'
  | 'other_domain'
  | 'not_in_scope_group'
  | 'in_shared_group'
  | 'shared_mailbox'
  | 'resource_mailbox'
  | 'not_seen';

/** Why a shared mailbox counts as one: the explicit group, or Exchange's mailbox type. */
export type SharedSource = 'in_shared_group' | 'shared_mailbox';

export type Classification =
  | { kind: 'person'; address: string; displayName: string; upn: string }
  | { kind: 'shared'; address: string; displayName: string; source: SharedSource }
  | { kind: 'out'; reason: OutReason; address: string }
  /** The mailbox type lookup failed: leave this object exactly as it is this round. */
  | { kind: 'skip'; reason: 'mailbox_type_denied' | 'mailbox_type_failed'; address: string };

/**
 * Exchange service plan states that still mean a working mailbox. Warning is
 * the licence grace period; Suspended, LockedOut and Deleted are not usable
 * (assignedPlan resource, capabilityStatus values).
 */
const USABLE_PLAN = new Set(['Enabled', 'Warning']);

/** Same rule as the web app's normalizeMailboxLocalPart, so every synced address is one Admin could create. */
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

const DEFAULT_PLANS: ReadonlySet<string> = new Set(Object.keys(EXCHANGE_MAILBOX_PLANS));

/**
 * True when the user has a usable Exchange Online service plan that includes
 * a mailbox, matched by service plan id (EXCHANGE_MAILBOX_PLANS). The service
 * name alone is not enough: EXCHANGE_S_FOUNDATION also reports service
 * 'exchange' and comes with many SKUs that have no mailbox.
 */
export function hasExchangePlan(user: GraphUser, planIds: ReadonlySet<string> = DEFAULT_PLANS): boolean {
  return Array.isArray(user.assignedPlans) && user.assignedPlans.some((plan) =>
    typeof plan?.servicePlanId === 'string' && planIds.has(plan.servicePlanId.toLowerCase())
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

/** The sign-in name (userPrincipalName) as a plain address, or '' when Graph gave nothing usable. */
export function cleanUpn(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw && raw.length <= 254 && /^[^\s<>"@\u0000-\u001f\u007f]+@[^\s<>"@\u0000-\u001f\u007f]+$/.test(raw) ? raw : '';
}

export function cleanDisplayName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';
}

/**
 * True when Exchange's mailbox type (userPurpose) is needed to classify this
 * object, with shared mailbox detection on: not deleted, a valid object id,
 * and a `mail` value on MAIL_DOMAIN. Disabled and unlicensed objects are
 * included on purpose: that is what a shared mailbox usually looks like.
 */
export function needsPurposeCheck(user: GraphUser, mailDomain: string): boolean {
  if (user['@removed'] || !isGuid(typeof user.id === 'string' ? user.id.toLowerCase() : user.id)) return false;
  return primaryAddress(user, mailDomain).onDomain;
}

/** True when a group membership check is needed to classify this object. */
export function needsGroupCheck(user: GraphUser, mailDomain: string, groups: { scope: string | null; shared: string | null }): boolean {
  if (user['@removed'] || !isGuid(user.id)) return false;
  if (!groups.scope && !groups.shared) return false;
  return primaryAddress(user, mailDomain).onDomain;
}

/**
 * `purpose` is Exchange's mailbox type when shared mailbox detection is on
 * and the object needed a check, else null (detection off: the rules are
 * exactly as before).
 */
export function classify(
  user: GraphUser,
  mailDomain: string,
  groups: { scope: string | null; shared: string | null },
  memberOf: Set<string> | null,
  planIds: ReadonlySet<string> = DEFAULT_PLANS,
  purpose: PurposeLookup | 'none_unconfirmed' | null = null,
): Classification {
  const { address, onDomain } = primaryAddress(user, mailDomain);
  if (user['@removed']) return { kind: 'out', reason: 'deleted', address };
  if (!address) return { kind: 'out', reason: 'no_address', address };
  if (!onDomain) return { kind: 'out', reason: 'other_domain', address };
  const displayName = cleanDisplayName(user.displayName);

  // The explicit shared-mailbox group always counts. Membership wins over
  // licences, because a shared mailbox may carry a licence (archive, over
  // 50 GB).
  if (groups.shared && memberOf?.has(groups.shared)) return { kind: 'shared', address, displayName, source: 'in_shared_group' };

  // Shared mailbox detection (M365_DETECT_SHARED_MAILBOXES). An unreadable
  // mailbox type changes nothing: no create, no pause, no update.
  if (purpose === 'denied') return { kind: 'skip', reason: 'mailbox_type_denied', address };
  if (purpose === 'failed') return { kind: 'skip', reason: 'mailbox_type_failed', address };
  if (purpose === 'shared') {
    // Exchange says shared: licence and sign-in state do not matter (shared
    // mailboxes are usually disabled and unlicensed). The scope group, when
    // set, limits detected shared mailboxes too.
    if (groups.scope && !memberOf?.has(groups.scope)) return { kind: 'out', reason: 'not_in_scope_group', address };
    return { kind: 'shared', address, displayName, source: 'shared_mailbox' };
  }
  // Room and equipment mailboxes are never people, even when licensed and
  // enabled (Teams Rooms resource accounts are).
  if (purpose === 'room' || purpose === 'equipment') return { kind: 'out', reason: 'resource_mailbox', address };
  // user, linked, others and none (also an unconfirmed 'none' from a delta
  // round): the licensed-person rule below, unchanged.

  if (user.userType && user.userType !== 'Member') return { kind: 'out', reason: 'guest', address };
  if (user.accountEnabled !== true) return { kind: 'out', reason: 'disabled', address };
  if (!hasExchangePlan(user, planIds)) return { kind: 'out', reason: 'no_mailbox_plan', address };
  if (groups.scope && !memberOf?.has(groups.scope)) return { kind: 'out', reason: 'not_in_scope_group', address };
  return { kind: 'person', address, displayName, upn: cleanUpn(user.userPrincipalName) };
}
