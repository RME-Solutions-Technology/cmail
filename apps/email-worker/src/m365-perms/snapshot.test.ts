import { describe, expect, it } from 'vitest';
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_MAILBOXES, mergeBatches, parseSnapshot } from './snapshot';
import { ORGANIZATION, TENANT_ID, snapshotOf } from './testing/fake-collector';

const NOW = Date.parse('2026-11-15T01:00:00Z');
const expected = { tenantId: TENANT_ID, organization: ORGANIZATION, now: NOW };
const MBX = '00000000-0000-0000-aaaa-000000000001';
const USER = '00000000-0000-0000-bbbb-000000000001';

function good(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(snapshotOf([
    { id: MBX, address: 'shared1@example.test', complete: true, grants: [{ trustee: USER, kind: 'user', fullAccess: true, sendAs: false }] },
  ], { collectedAt: '2026-11-15T00:30:00.000Z' })));
}

const parse = (value: unknown) => parseSnapshot(typeof value === 'string' ? value : JSON.stringify(value), expected);

describe('snapshot schema', () => {
  it('accepts a well-formed snapshot', () => {
    const result = parse(good());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.mailboxes[0].grants[0]).toEqual({ trustee: USER, kind: 'user', fullAccess: true, sendAs: false });
  });

  it.each([
    ['not JSON', '{', 'not_json'],
    ['empty', '', 'empty'],
    ['an array', '[]', 'bad_shape'],
  ])('rejects %s', (_label, text, reason) => {
    expect(parseSnapshot(text, expected)).toEqual({ ok: false, reason });
  });

  const cases: Array<[string, (s: Record<string, any>) => void, string]> = [
    ['an unknown top-level key', (s) => { s.extra = 1; }, 'bad_shape'],
    ['a missing key', (s) => { delete s.errors; }, 'bad_shape'],
    ['another schema version', (s) => { s.version = 2; }, 'wrong_version'],
    ['another tenant', (s) => { s.tenantId = '99999999-9999-9999-9999-999999999999'; }, 'wrong_tenant'],
    ['another organization', (s) => { s.organization = 'other.onmicrosoft.com'; }, 'wrong_tenant'],
    ['a snapshot older than 36 hours', (s) => { s.collectedAt = '2026-11-13T00:00:00.000Z'; }, 'too_old'],
    ['a snapshot from the future', (s) => { s.collectedAt = '2026-11-15T02:00:00.000Z'; }, 'bad_time'],
    ['a bad cursor', (s) => { s.nextCursor = 'drop table'; }, 'bad_cursor'],
    ['more mailboxes than counted', (s) => { s.mailboxCount = 0; s.complete = true; }, 'bad_mailboxes'],
    ['a complete batch with a cursor', (s) => { s.nextCursor = MBX; }, 'bad_cursor'],
    ['an unfinished batch whose cursor is not its last mailbox', (s) => { s.complete = false; s.mailboxCount = 5; s.nextCursor = '00000000-0000-0000-aaaa-000000000009'; }, 'bad_cursor'],
    ['mailboxes out of order', (s) => { s.mailboxes.unshift({ ...s.mailboxes[0], id: '00000000-0000-0000-aaaa-000000000009', grants: [] }); s.mailboxCount = 2; }, 'unsorted_mailboxes'],
    ['a mailbox id that is not a GUID', (s) => { s.mailboxes[0].id = 'sales'; }, 'bad_mailbox'],
    ['a bad address', (s) => { s.mailboxes[0].address = 'not an address'; }, 'bad_mailbox'],
    ['a duplicate mailbox', (s) => { s.mailboxes.push(s.mailboxes[0]); s.mailboxCount = 2; }, 'duplicate_mailbox'],
    ['an extra mailbox key', (s) => { s.mailboxes[0].owner = 'x'; }, 'bad_mailbox'],
    ['a trustee that is not a GUID', (s) => { s.mailboxes[0].grants[0].trustee = 'alice@example.test'; }, 'bad_grant'],
    ['an unknown trustee kind', (s) => { s.mailboxes[0].grants[0].kind = 'room'; }, 'bad_grant'],
    ['a grant with no right', (s) => { s.mailboxes[0].grants[0].fullAccess = false; }, 'bad_grant'],
    ['a right that is not a boolean', (s) => { s.mailboxes[0].grants[0].sendAs = 'yes'; }, 'bad_grant'],
    ['a duplicate trustee', (s) => { s.mailboxes[0].grants.push(s.mailboxes[0].grants[0]); }, 'duplicate_grant'],
    ['a mailbox granted to itself', (s) => { s.mailboxes[0].grants[0].trustee = MBX; }, 'bad_grant'],
    ['a bad skipped block', (s) => { s.skipped.inherited = -1; }, 'bad_skipped'],
    ['a bad error code', (s) => { s.errors = [{ code: 'Bad <script>', count: 1 }]; }, 'bad_errors'],
  ];
  it.each(cases)('rejects %s', (_label, mutate, reason) => {
    const snapshot = good() as Record<string, any>;
    mutate(snapshot);
    expect(parse(snapshot)).toEqual({ ok: false, reason });
  });

  it('rejects a snapshot over the size cap before parsing it', () => {
    const big = `{"pad":"${'x'.repeat(SNAPSHOT_MAX_BYTES)}"}`;
    expect(parseSnapshot(big, expected)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('joining the batches of a pass', () => {
  const id = (n: number) => `00000000-0000-0000-aaaa-${String(n).padStart(12, '0')}`;
  const box = (n: number) => ({ id: id(n), address: `shared${n}@example.test`, complete: true, grants: [] });
  const batch = (ns: number[], complete: boolean) => snapshotOf(ns.map(box), { complete, mailboxCount: 99, nextCursor: complete ? '' : id(ns[ns.length - 1]) });

  it('joins batches that follow each other', () => {
    const merged = mergeBatches([{ startAfter: '', snapshot: batch([1, 2], false) }, { startAfter: id(2), snapshot: batch([3], true) }]);
    expect(merged?.mailboxes.map((m) => m.id)).toEqual([id(1), id(2), id(3)]);
  });

  it('refuses ids that are not ascending across batches', () => {
    const second = batch([3], true);
    second.mailboxes.unshift(box(2));
    expect(mergeBatches([{ startAfter: '', snapshot: batch([1, 2], false) }, { startAfter: id(1), snapshot: second }])).toBeNull();
  });

  it('refuses a pass over the total mailbox cap', () => {
    const big = Array.from({ length: SNAPSHOT_MAX_MAILBOXES }, (_, n) => n + 1);
    expect(mergeBatches([
      { startAfter: '', snapshot: batch(big, false) },
      { startAfter: id(big.length), snapshot: batch([big.length + 1], true) },
    ])).toBeNull();
  });
});