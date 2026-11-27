// Usage events (docs/usage-events.md): one Workers Analytics Engine data point per web request
// and per inbound message, so "does mail flow, do people get through?" can be counted without
// reading logs. Content-free by construction: only fixed words (a route template, an outcome
// code, a status class) and three numbers. The dataset lives in the operator's own Cloudflare
// account; nothing is sent anywhere else. Never throws, never delays the caller, and with no
// USAGE binding it does nothing.

export interface UsageDataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface UsageEvent {
  /** A route template such as /mail/[id], or a fixed event name such as mail.inbound. */
  name: string;
  /** A fixed outcome word: ok, error, accepted, or a reject code. */
  outcome: string;
  /** HTTP-style status number; reduced to a class such as 2xx. */
  status: number;
  ms?: number;
  bytes?: number;
  count?: number;
}

export function statusClass(status: number): string {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : '0xx';
}

export function recordUsage(env: object | undefined, event: UsageEvent): void {
  try {
    const dataset = (env as { USAGE?: UsageDataset } | undefined)?.USAGE;
    if (!dataset || typeof dataset.writeDataPoint !== 'function') return;
    const raw = String(event.name || 'other');
    const name = /^[A-Za-z0-9_.\/\[\]-]{1,96}$/.test(raw) ? raw : 'other';
    dataset.writeDataPoint({
      indexes: [name],
      blobs: [name, String(event.outcome || 'ok').slice(0, 48), statusClass(event.status)],
      doubles: [Number(event.ms) || 0, Number(event.bytes) || 0, Number(event.count) || 0],
    });
  } catch {
    // A usage write must never break a request or a delivery.
  }
}

/** Our own fixed inbound reject texts, mapped to fixed codes. Anything else becomes rejected_other. */
const REJECT_CODES: Array<[string, string]> = [
  ['Stanchion: journal report refused', 'journal_refused'],
  ['Invalid envelope address', 'invalid_address'],
  ['Message exceeds the configured size limit', 'size_limit'],
  ['Message metadata exceeds the configured limit', 'metadata_limit'],
  ['Message cannot be accepted at this time', 'cannot_accept'],
  ['Message could not be parsed', 'unparseable'],
  ['Message exceeds the attachment count limit', 'attachment_count'],
  ['Message exceeds the attachment size limit', 'attachment_size'],
  ['Attachment type not allowed', 'attachment_type'],
  ['Message exceeds the recipient metadata limit', 'recipient_limit'],
];

export function mailRejectCode(reason: unknown): string {
  if (typeof reason !== 'string') return 'rejected_other';
  for (const [text, code] of REJECT_CODES) if (reason === text) return code;
  // The recipient-unavailable text is a prefix of a longer fixed response.
  if (reason.startsWith('Stanchion: recipient unavailable')) return 'unknown_recipient';
  return 'rejected_other';
}
