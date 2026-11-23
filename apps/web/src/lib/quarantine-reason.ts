/**
 * Maps a stored `messages.quarantine_reason` code to a short, lowercase,
 * human phrase ("blocked sender", "spam score 7.5"). Returns null for an
 * unset or unrecognised reason so callers choose their own fallback wording.
 */
export function quarantineReasonPhrase(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === 'blocked-sender') return 'blocked sender';
  if (reason === 'rate-limit') return 'held: too much mail arrived at once';
  const scoreMatch = /^spam-score:(.+)$/.exec(reason);
  if (scoreMatch) return `spam score ${scoreMatch[1]}`;
  return null;
}
