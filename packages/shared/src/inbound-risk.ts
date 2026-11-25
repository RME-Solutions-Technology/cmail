/**
 * Inbound spam scoring and first-contact detection.
 *
 * Cloudflare Email Routing already refuses mail that fails both SPF and DKIM,
 * violates the sender's DMARC policy, or arrives from an IP on a realtime
 * block list. What reaches the Worker has therefore cleared the coarse gate.
 * Older notes said Email Routing stamps no `Authentication-Results` header
 * on Worker deliveries (cloudflare/workerd#6740). Live instances now trust one
 * stamped with the boundary's own id (`INBOUND_AUTHSERV_ID`, `mx.cloudflare.net`)
 * and record SPF/DKIM/DMARC from it; a second record claiming that id is a
 * forgery and voids every verdict (index.ts `parsedAuthenticationFacts`).
 *
 * A spam score does come through, on `X-CF-SpamH-Score`. Cloudflare does not
 * document its scale, so this module records the score unconditionally but
 * quarantines nothing unless an operator sets an explicit threshold. Silently
 * filing mail into Spam against an undocumented scale would lose real mail,
 * and losing mail is far worse than showing a score.
 *
 * A manager can also set organisation-wide sender allow/block rules (the
 * sender_rules table). decideInboundPlacement is the single place that
 * combines a resolved rule with the score/threshold pair into one inbound
 * folder decision; pickSenderRule is the pure helper the Worker uses to pick
 * a winner when a sender matches at more than one specificity.
 */

/**
 * Checked in order. The Cloudflare header is the one that actually arrives on
 * Email Routing deliveries; the others are conventional and cost nothing to
 * accept if the deployment sits behind a different boundary.
 */
export const SPAM_SCORE_HEADERS: readonly string[] = [
  'x-cf-spamh-score',
  'x-spam-score',
  'x-spamd-score',
];

/** Scores outside this range are malformed rather than extreme. */
const MIN_SCORE = -1000;
const MAX_SCORE = 1000;

/** Leading signed decimal, so `5.4/10` and `5.4 (spammy)` both parse. */
const SCORE_PATTERN = /^\s*([+-]?\d{1,4}(?:\.\d{1,4})?)/;

export function parseSpamScore(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = SCORE_PATTERN.exec(value);
  if (!match) return null;
  const score = Number(match[1]);
  if (!Number.isFinite(score) || score < MIN_SCORE || score > MAX_SCORE) return null;
  return score;
}

/** Reads the first spam score header present. Returns null when none is. */
export function readSpamScore(headers: { get(name: string): string | null }): number | null {
  for (const header of SPAM_SCORE_HEADERS) {
    const score = parseSpamScore(headers.get(header));
    if (score !== null) return score;
  }
  return null;
}

/**
 * Resolves the configured quarantine threshold. Returns null — meaning never
 * quarantine — for anything unset, blank, or unparseable. Requiring a
 * deliberate, valid number is the point: a typo must not start filing mail
 * into Spam.
 */
export function spamQuarantineThreshold(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= MIN_SCORE && value <= MAX_SCORE ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const threshold = Number(trimmed);
  if (!Number.isFinite(threshold) || threshold < MIN_SCORE || threshold > MAX_SCORE) return null;
  return threshold;
}

/** A message is quarantined only when both a score and a threshold exist. */
export function shouldQuarantine(score: number | null, threshold: number | null): boolean {
  if (score === null || threshold === null) return false;
  return score >= threshold;
}

export type SenderRuleAction = 'allow' | 'block';

/** One row returned by the Worker's sender_rules lookup query. */
export interface SenderRuleRow {
  pattern: string;
  action: string;
}

/**
 * Resolves the winning allow/block rule from every row that matched either
 * the sender's exact address or its bare domain. The Worker matches both
 * patterns in one prepared statement (`WHERE pattern = ?1 OR pattern = ?2`);
 * this is the pure part that picks a winner, so it can be tested without D1.
 *
 * An exact-address match always outranks a domain match. sender_rules.pattern
 * is UNIQUE, so at most one row can match the address and at most one can
 * match the domain — but a same-level tie is still resolved deliberately:
 * block wins, because silently delivering mail a manager meant to block is
 * worse than quarantining mail they meant to allow.
 */
export function pickSenderRule(
  rows: readonly SenderRuleRow[],
  address: string,
  domain: string,
): SenderRuleAction | null {
  let addressAction: SenderRuleAction | null = null;
  let domainAction: SenderRuleAction | null = null;
  for (const row of rows) {
    if (row.action !== 'allow' && row.action !== 'block') continue;
    if (row.pattern === address) {
      if (row.action === 'block' || addressAction === null) addressAction = row.action;
    } else if (row.pattern === domain) {
      if (row.action === 'block' || domainAction === null) domainAction = row.action;
    }
  }
  return addressAction ?? domainAction;
}

export interface InboundPlacementInput {
  /** From {@link readSpamScore}; null when no header carried a parseable score. */
  spamScore: number | null;
  /** From {@link spamQuarantineThreshold}; null when scoring is not acted on. */
  threshold: number | null;
  /** From {@link pickSenderRule}; null when no organisation rule matched. */
  senderRule: SenderRuleAction | null;
  /**
   * True only when the trusted boundary recorded a DMARC pass for the header
   * From. An allow rule trusts the From address, so without this anyone could
   * type an allowed address and skip the spam check (contractor review S4).
   * A block rule applies either way.
   */
  senderAuthenticated: boolean;
}

export interface InboundPlacementResult {
  folder: 'inbox' | 'spam';
  /** Recorded in messages.quarantine_reason. Null when delivered normally. */
  reason: string | null;
  /** True when an allow rule matched but was not applied because the sender was not authenticated. */
  allowIgnored?: boolean;
}

/**
 * Combines a manager's explicit sender rule with the spam-score threshold
 * into one inbound folder decision.
 *
 * A block rule always wins, ahead of any score: it is a deliberate decision
 * and a noisy score must not override it. An allow rule beats the score too
 * — someone explicitly trusted should not be re-filed because of one noisy
 * message — but loses to a block, so correcting a mistake by blocking a
 * previously allowed sender takes effect immediately. With no matching rule,
 * the score decides only when both it and a threshold are present; either
 * one being absent means deliver to Inbox, matching shouldQuarantine above.
 */
export function decideInboundPlacement(input: InboundPlacementInput): InboundPlacementResult {
  if (input.senderRule === 'block') return { folder: 'spam', reason: 'blocked-sender' };
  const allowIgnored = input.senderRule === 'allow' && !input.senderAuthenticated;
  if (input.senderRule === 'allow' && input.senderAuthenticated) return { folder: 'inbox', reason: null };
  if (input.threshold !== null && input.spamScore !== null && input.spamScore >= input.threshold) {
    return { folder: 'spam', reason: `spam-score:${input.spamScore}`, ...(allowIgnored ? { allowIgnored } : {}) };
  }
  return { folder: 'inbox', reason: null, ...(allowIgnored ? { allowIgnored } : {}) };
}

/**
 * Applies a rate-limit hold to a placement. A message the inbound guard held
 * (an hourly limit tripped) goes to Junk with reason `rate-limit`, so nothing
 * is bounced and nothing is lost. The exception: a correspondent this mailbox
 * already knows, whose DMARC result is a pass recorded by the trusted
 * boundary, keeps the normal placement, so a flood of made-up senders cannot
 * push real conversations out of the Inbox. An existing Junk decision wins.
 */
export function applyRateHold(
  placement: InboundPlacementResult,
  input: { held: boolean; senderAuthenticated: boolean; firstContact: boolean },
): InboundPlacementResult {
  if (!input.held || placement.folder === 'spam') return placement;
  if (input.senderAuthenticated && !input.firstContact) return placement;
  return { folder: 'spam', reason: 'rate-limit' };
}
