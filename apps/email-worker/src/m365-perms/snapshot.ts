// The collector's JSON contract (version 1) and its strict validation.
// The collector (container/m365-perms/collect.ps1, or the same script run
// elsewhere) writes exactly this shape. Anything else is rejected whole and
// nothing is applied: a snapshot is trusted only if every field checks out.
// docs/m365-mailbox-permissions.md, "Snapshot contract".

export const SNAPSHOT_SCHEMA = 'cmail-exo-permissions';
export const SNAPSHOT_VERSION = 1;
/** Largest snapshot accepted, in bytes (UTF-8). */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_MAX_MAILBOXES = 20_000;
export const SNAPSHOT_MAX_GRANTS_PER_MAILBOX = 5_000;
export const SNAPSHOT_MAX_GRANTS = 200_000;
/** A snapshot older than this is never applied. */
export const SNAPSHOT_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 10 * 60 * 1000;

export const SKIP_KEYS = ['inherited', 'deny', 'system', 'orphaned', 'unresolved', 'otherKind'] as const;
export type SkipKey = (typeof SKIP_KEYS)[number];

export interface SnapshotGrant {
  /** Entra object id (Exchange ExternalDirectoryObjectId) of the user or group. */
  trustee: string;
  kind: 'user' | 'group';
  fullAccess: boolean;
  sendAs: boolean;
}

export interface SnapshotMailbox {
  /** Entra object id (ExternalDirectoryObjectId) of the shared mailbox. */
  id: string;
  /** Primary SMTP address, lower case. Shown in reports only; mapping uses `id`. */
  address: string;
  /** False when any query for this mailbox failed or a trustee could not be resolved. */
  complete: boolean;
  grants: SnapshotGrant[];
}

export interface PermissionSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  version: typeof SNAPSHOT_VERSION;
  tenantId: string;
  organization: string;
  collectedAt: string;
  /**
   * One batch of a pass: true when this batch reached the end of the
   * tenant's shared mailbox list (the pass is complete).
   */
  complete: boolean;
  /** Where the next batch starts: the last mailbox id read ('' when complete). */
  nextCursor: string;
  /** Shared mailboxes Exchange listed in total. */
  mailboxCount: number;
  mailboxes: SnapshotMailbox[];
  skipped: Record<SkipKey, number>;
  errors: Array<{ code: string; count: number }>;
}

export type SnapshotCheck =
  | { ok: true; snapshot: PermissionSnapshot }
  | { ok: false; reason: string };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CODE = /^[a-z_]{1,48}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function count(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

const TOP_KEYS = ['schema', 'version', 'tenantId', 'organization', 'collectedAt', 'complete', 'nextCursor', 'mailboxCount', 'mailboxes', 'skipped', 'errors'] as const;
const MAILBOX_KEYS = ['id', 'address', 'complete', 'grants'] as const;
const GRANT_KEYS = ['trustee', 'kind', 'fullAccess', 'sendAs'] as const;

/**
 * Parses and checks a snapshot. `expected` binds it to this deployment's
 * tenant and organization, so a snapshot from another tenant is refused.
 * Reasons are short codes, safe to log and show.
 */
export function parseSnapshot(
  text: string,
  expected: { tenantId: string; organization: string; now: number },
): SnapshotCheck {
  if (typeof text !== 'string' || !text) return { ok: false, reason: 'empty' };
  if (new TextEncoder().encode(text).byteLength > SNAPSHOT_MAX_BYTES) return { ok: false, reason: 'too_large' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (!isRecord(raw) || !exactKeys(raw, TOP_KEYS)) return { ok: false, reason: 'bad_shape' };
  if (raw.schema !== SNAPSHOT_SCHEMA || raw.version !== SNAPSHOT_VERSION) return { ok: false, reason: 'wrong_version' };
  if (typeof raw.tenantId !== 'string' || raw.tenantId.toLowerCase() !== expected.tenantId) return { ok: false, reason: 'wrong_tenant' };
  if (typeof raw.organization !== 'string' || raw.organization.toLowerCase() !== expected.organization) return { ok: false, reason: 'wrong_tenant' };
  if (typeof raw.collectedAt !== 'string' || raw.collectedAt.length > 40) return { ok: false, reason: 'bad_time' };
  const collected = Date.parse(raw.collectedAt);
  if (Number.isNaN(collected) || collected > expected.now + FUTURE_SKEW_MS) return { ok: false, reason: 'bad_time' };
  if (expected.now - collected > SNAPSHOT_MAX_AGE_MS) return { ok: false, reason: 'too_old' };
  if (typeof raw.complete !== 'boolean') return { ok: false, reason: 'bad_shape' };
  if (typeof raw.nextCursor !== 'string' || (raw.nextCursor !== '' && !GUID.test(raw.nextCursor))) return { ok: false, reason: 'bad_cursor' };
  if (!count(raw.mailboxCount, SNAPSHOT_MAX_MAILBOXES * 10)) return { ok: false, reason: 'bad_shape' };
  if (!Array.isArray(raw.mailboxes) || raw.mailboxes.length > SNAPSHOT_MAX_MAILBOXES || raw.mailboxes.length > raw.mailboxCount) {
    return { ok: false, reason: 'bad_mailboxes' };
  }
  // A batch that completes the pass has no cursor; one that does not points
  // at its own last mailbox (or is empty because it ran out of time at once).
  if (raw.complete && raw.nextCursor !== '') return { ok: false, reason: 'bad_cursor' };

  if (!isRecord(raw.skipped) || !exactKeys(raw.skipped, SKIP_KEYS)) return { ok: false, reason: 'bad_skipped' };
  const skipped = {} as Record<SkipKey, number>;
  for (const key of SKIP_KEYS) {
    if (!count(raw.skipped[key], 10_000_000)) return { ok: false, reason: 'bad_skipped' };
    skipped[key] = raw.skipped[key] as number;
  }
  if (!Array.isArray(raw.errors) || raw.errors.length > 50) return { ok: false, reason: 'bad_errors' };
  const errors: Array<{ code: string; count: number }> = [];
  for (const item of raw.errors) {
    if (!isRecord(item) || !exactKeys(item, ['code', 'count']) || typeof item.code !== 'string' || !CODE.test(item.code) || !count(item.count, 10_000_000)) {
      return { ok: false, reason: 'bad_errors' };
    }
    errors.push({ code: item.code, count: item.count });
  }

  const seenMailboxes = new Set<string>();
  const mailboxes: SnapshotMailbox[] = [];
  let totalGrants = 0;
  for (const item of raw.mailboxes) {
    if (!isRecord(item) || !exactKeys(item, MAILBOX_KEYS)) return { ok: false, reason: 'bad_mailbox' };
    if (typeof item.id !== 'string' || !GUID.test(item.id)) return { ok: false, reason: 'bad_mailbox' };
    if (seenMailboxes.has(item.id)) return { ok: false, reason: 'duplicate_mailbox' };
    seenMailboxes.add(item.id);
    if (typeof item.address !== 'string' || item.address.length > 254 || !EMAIL.test(item.address)) return { ok: false, reason: 'bad_mailbox' };
    if (typeof item.complete !== 'boolean') return { ok: false, reason: 'bad_mailbox' };
    if (!Array.isArray(item.grants) || item.grants.length > SNAPSHOT_MAX_GRANTS_PER_MAILBOX) return { ok: false, reason: 'bad_grants' };
    totalGrants += item.grants.length;
    if (totalGrants > SNAPSHOT_MAX_GRANTS) return { ok: false, reason: 'too_many_grants' };
    const seenTrustees = new Set<string>();
    const grants: SnapshotGrant[] = [];
    for (const grant of item.grants) {
      if (!isRecord(grant) || !exactKeys(grant, GRANT_KEYS)) return { ok: false, reason: 'bad_grant' };
      if (typeof grant.trustee !== 'string' || !GUID.test(grant.trustee)) return { ok: false, reason: 'bad_grant' };
      if (grant.trustee === item.id) return { ok: false, reason: 'bad_grant' };
      if (seenTrustees.has(grant.trustee)) return { ok: false, reason: 'duplicate_grant' };
      seenTrustees.add(grant.trustee);
      if (grant.kind !== 'user' && grant.kind !== 'group') return { ok: false, reason: 'bad_grant' };
      if (typeof grant.fullAccess !== 'boolean' || typeof grant.sendAs !== 'boolean') return { ok: false, reason: 'bad_grant' };
      if (!grant.fullAccess && !grant.sendAs) return { ok: false, reason: 'bad_grant' };
      grants.push({ trustee: grant.trustee, kind: grant.kind, fullAccess: grant.fullAccess, sendAs: grant.sendAs });
    }
    if (mailboxes.length && item.id <= mailboxes[mailboxes.length - 1].id) return { ok: false, reason: 'unsorted_mailboxes' };
    mailboxes.push({ id: item.id, address: item.address, complete: item.complete, grants });
  }
  if (!raw.complete && mailboxes.length && raw.nextCursor !== mailboxes[mailboxes.length - 1].id) return { ok: false, reason: 'bad_cursor' };

  return {
    ok: true,
    snapshot: {
      schema: SNAPSHOT_SCHEMA,
      version: SNAPSHOT_VERSION,
      tenantId: expected.tenantId,
      organization: expected.organization,
      collectedAt: new Date(collected).toISOString(),
      complete: raw.complete,
      nextCursor: raw.nextCursor,
      mailboxCount: raw.mailboxCount,
      mailboxes,
      skipped,
      errors,
    },
  };
}

/** Group trustee ids in a snapshot, each once, sorted. */
export function groupTrustees(snapshot: PermissionSnapshot): string[] {
  const groups = new Set<string>();
  for (const mailbox of snapshot.mailboxes) for (const grant of mailbox.grants) if (grant.kind === 'group') groups.add(grant.trustee);
  return [...groups].sort();
}

/**
 * Joins the batches of one pass, in order, into one snapshot. Each batch must
 * start after the previous batch's cursor (ids ascending, no overlap), only
 * the last may be complete, and the last must be. Returns null when they do
 * not fit together.
 */
export function mergeBatches(batches: Array<{ startAfter: string; snapshot: PermissionSnapshot }>): PermissionSnapshot | null {
  if (!batches.length) return null;
  const mailboxes: SnapshotMailbox[] = [];
  const skipped = Object.fromEntries(SKIP_KEYS.map((k) => [k, 0])) as Record<SkipKey, number>;
  const errors = new Map<string, number>();
  let previous = '';
  let grants = 0;
  let collectedAt = batches[0].snapshot.collectedAt;
  for (const [index, { startAfter, snapshot }] of batches.entries()) {
    const last = index === batches.length - 1;
    if (startAfter !== previous) return null;
    if (snapshot.complete !== last) return null;
    for (const mailbox of snapshot.mailboxes) {
      if (startAfter && mailbox.id <= startAfter) return null;
      // Globally ascending across batches: no overlap, no reordering.
      if (mailboxes.length && mailbox.id <= mailboxes[mailboxes.length - 1].id) return null;
      mailboxes.push(mailbox);
      grants += mailbox.grants.length;
      if (mailboxes.length > SNAPSHOT_MAX_MAILBOXES || grants > SNAPSHOT_MAX_GRANTS) return null;
    }
    for (const k of SKIP_KEYS) skipped[k] += snapshot.skipped[k];
    for (const error of snapshot.errors) errors.set(error.code, (errors.get(error.code) ?? 0) + error.count);
    if (snapshot.collectedAt < collectedAt) collectedAt = snapshot.collectedAt;
    previous = snapshot.nextCursor || previous;
  }
  const lastBatch = batches[batches.length - 1].snapshot;
  return {
    ...lastBatch,
    collectedAt,
    complete: true,
    nextCursor: '',
    mailboxCount: Math.max(lastBatch.mailboxCount, mailboxes.length),
    mailboxes,
    skipped,
    errors: [...errors].sort(([a], [b]) => a.localeCompare(b)).slice(0, 50).map(([code, count]) => ({ code, count })),
  };
}