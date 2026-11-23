import { describe, expect, it } from 'vitest';
import { releaseInboundReservation, reserveInboundDelivery, reserveInboundDeliveryHolding, type InboundGuardEnv } from './inbound-guard';
import { migratedDatabase } from './testing/sqlite-d1';

// The inbound limits are enforced by the BEFORE INSERT trigger on
// mailbox_reservations (migration 0001), not by JavaScript. These tests run
// the real reservation SQL against every real migration.

const HASH_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const LIMITS_OFF = {
  INBOUND_MAILBOX_MESSAGES_PER_HOUR: 0,
  INBOUND_MAILBOX_BYTES_PER_HOUR: 0,
  INBOUND_SENDER_MESSAGES_PER_HOUR: 0,
  MAILBOX_STORAGE_QUOTA_BYTES: 0,
};

function setup(limits: Partial<InboundGuardEnv>) {
  const { d1, sqlite } = migratedDatabase();
  sqlite.prepare("INSERT INTO mailboxes (id, address, type) VALUES ('mailbox-1', 'mailbox@example.test', 'shared')").run();
  const env = { DB: d1, INBOUND_SENDER_HASH_KEY: HASH_KEY, ...LIMITS_OFF, ...limits } as InboundGuardEnv;
  const reserve = (deliveryKey: string, messageBytes = 10, senderAddress = 'sender@example.test') =>
    reserveInboundDelivery(env, { mailboxId: 'mailbox-1', senderAddress, deliveryKey, messageBytes });
  return { d1, sqlite, reserve };
}

describe('inbound reservation SQL (real migrations)', () => {
  it('enforces the hourly message count per mailbox', async () => {
    const { reserve } = setup({ INBOUND_MAILBOX_MESSAGES_PER_HOUR: 2 });
    expect((await reserve('m1')).status).toBe('accepted');
    expect((await reserve('m2')).status).toBe('accepted');
    expect((await reserve('m3')).status).toBe('rejected');
  });

  it('enforces the hourly byte budget, allowing exactly the limit', async () => {
    const { reserve } = setup({ INBOUND_MAILBOX_BYTES_PER_HOUR: 100 });
    expect((await reserve('b1', 60)).status).toBe('accepted');
    expect((await reserve('b2', 40)).status).toBe('accepted');
    expect((await reserve('b3', 1)).status).toBe('rejected');
  });

  it('limits each sender separately, keyed by the sender hash', async () => {
    const { reserve, sqlite } = setup({ INBOUND_SENDER_MESSAGES_PER_HOUR: 1 });
    expect((await reserve('s1', 10, 'first@example.test')).status).toBe('accepted');
    expect((await reserve('s2', 10, 'first@example.test')).status).toBe('rejected');
    expect((await reserve('s3', 10, 'second@example.test')).status).toBe('accepted');
    // The address itself never reaches the table.
    const hashes = sqlite.prepare('SELECT sender_hash FROM mailbox_reservations').all() as Array<{ sender_hash: string }>;
    expect(hashes.every((row) => /^[0-9a-f]{64}$/.test(row.sender_hash))).toBe(true);
  });

  // A settled earlier delivery, `age` seconds old, holding `pending` bytes until `pendingFor` seconds from now.
  function earlier(sqlite: ReturnType<typeof setup>['sqlite'], age: number, options: { bytes?: number; pending?: boolean; pendingFor?: number } = {}) {
    sqlite.prepare(
      `INSERT INTO mailbox_reservations (id, delivery_key, mailbox_id, message_bytes, mailbox_message_limit, mailbox_byte_limit,
         sender_message_limit, storage_quota_bytes, storage_pending, pending_expires_at, created_epoch)
       VALUES (?, NULL, 'mailbox-1', ?, 0, 0, 0, 0, ?, unixepoch() + ?, unixepoch() - ?)`,
    ).run(`earlier-${age}-${options.pendingFor ?? 0}`, options.bytes ?? 10, options.pending ? 1 : 0, options.pendingFor ?? 0, age);
  }

  it('counts the last hour exactly: 3599 seconds ago counts, 3600 does not', async () => {
    const inside = setup({ INBOUND_MAILBOX_MESSAGES_PER_HOUR: 1 });
    earlier(inside.sqlite, 3599);
    expect((await inside.reserve('fresh')).status).toBe('rejected');

    const outside = setup({ INBOUND_MAILBOX_MESSAGES_PER_HOUR: 1 });
    earlier(outside.sqlite, 3600);
    expect((await outside.reserve('fresh')).status).toBe('accepted');
  });

  it('stops charging an abandoned pending delivery once its hold expires', async () => {
    const live = setup({ MAILBOX_STORAGE_QUOTA_BYTES: 100 });
    earlier(live.sqlite, 60, { bytes: 95, pending: true, pendingFor: 60 });
    expect((await live.reserve('next', 10)).status).toBe('rejected');

    const expired = setup({ MAILBOX_STORAGE_QUOTA_BYTES: 100 });
    earlier(expired.sqlite, 60, { bytes: 95, pending: true, pendingFor: 0 });
    expect((await expired.reserve('next', 10)).status).toBe('accepted');
  });

  it('charges pending deliveries and stored mail against the storage quota until released', async () => {
    const { reserve, d1, sqlite } = setup({ MAILBOX_STORAGE_QUOTA_BYTES: 100 });
    const first = await reserve('q1', 80);
    expect(first.status).toBe('accepted');
    // 80 pending + 30 would exceed 100.
    expect((await reserve('q2', 30)).status).toBe('rejected');
    // A failed delivery releases its pending charge.
    await releaseInboundReservation(d1, first.reservationId);
    expect((await reserve('q3', 30)).status).toBe('accepted');

    // Stored messages count too.
    sqlite.prepare(
      `INSERT INTO messages (id, mailbox_id, direction, from_address, to_addresses, subject, snippet, body_r2_key, size_bytes, folder)
       VALUES ('stored-1', 'mailbox-1', 'inbound', 'a@example.test', '[]', 's', 's', 'k', 60, 'inbox')`,
    ).run();
    // 30 pending + 60 stored + 11 = 101.
    expect((await reserve('q4', 11)).status).toBe('rejected');
    expect((await reserve('q5', 10)).status).toBe('accepted');
  });

  it('turns a pending charge into the stored message when the message row is inserted', async () => {
    const { reserve, sqlite } = setup({ MAILBOX_STORAGE_QUOTA_BYTES: 1000 });
    const reservation = await reserve('message-9', 50);
    sqlite.prepare(
      `INSERT INTO messages (id, mailbox_id, direction, from_address, to_addresses, subject, snippet, body_r2_key, size_bytes, folder)
       VALUES ('message-9', 'mailbox-1', 'inbound', 'a@example.test', '[]', 's', 's', 'k', 50, 'inbox')`,
    ).run();
    const row = sqlite.prepare('SELECT storage_pending FROM mailbox_reservations WHERE id = ?').get(reservation.reservationId!) as { storage_pending: number };
    expect(row.storage_pending).toBe(0);
  });

  it('reports a second delivery of the same key as a duplicate', async () => {
    const { reserve } = setup({ INBOUND_MAILBOX_MESSAGES_PER_HOUR: 10 });
    expect((await reserve('same-key')).status).toBe('accepted');
    expect(await reserve('same-key')).toEqual({ status: 'duplicate', reservationId: null });
  });

  it('lets a retry through once a failed delivery has released its key', async () => {
    const { reserve, d1 } = setup({ INBOUND_MAILBOX_MESSAGES_PER_HOUR: 10 });
    const first = await reserve('retry-key');
    await releaseInboundReservation(d1, first.reservationId);
    expect((await reserve('retry-key')).status).toBe('accepted');
  });
});

// A rate limit must never become a permanent bounce of real mail (contractor
// review S2): it is held for Junk instead. Only the storage quota still rejects.
describe('holding instead of bouncing (real migrations)', () => {
  function holding(limits: Partial<InboundGuardEnv>) {
    const { d1, sqlite } = migratedDatabase();
    sqlite.prepare("INSERT INTO mailboxes (id, address, type) VALUES ('mailbox-1', 'mailbox@example.test', 'shared')").run();
    const env = { DB: d1, INBOUND_SENDER_HASH_KEY: HASH_KEY, ...LIMITS_OFF, ...limits } as InboundGuardEnv;
    const reserve = (deliveryKey: string, senderAddress = 'sender@example.test', messageBytes = 10) =>
      reserveInboundDeliveryHolding(env, { mailboxId: 'mailbox-1', senderAddress, deliveryKey, messageBytes });
    return { sqlite, reserve };
  }

  it('flood of 200 messages from made-up senders: none rejected, the rest held, a later one still gets in', async () => {
    const { reserve, sqlite } = holding({ INBOUND_MAILBOX_MESSAGES_PER_HOUR: 120 });
    const results = [];
    for (let i = 0; i < 200; i += 1) results.push(await reserve(`flood-${i}`, `fake-${i}@spam.example`));
    expect(results.filter((r) => r.status === 'rejected' || r.status === 'unavailable')).toHaveLength(0);
    expect(results.filter((r) => r.status === 'accepted')).toHaveLength(120);
    expect(results.filter((r) => r.status === 'held')).toHaveLength(80);
    // The next real message is held (the caller files it to Junk unless sender is known and DMARC passes), never refused.
    expect((await reserve('real-1', 'colleague@example.test')).status).toBe('held');
    const stored = sqlite.prepare("SELECT COUNT(*) AS c FROM mailbox_reservations WHERE reservation_type = 'inbound'").get() as { c: number };
    expect(stored.c).toBe(201);
  });

  it('holds a busy sender over the per-sender limit instead of bouncing it', async () => {
    const { reserve } = holding({ INBOUND_SENDER_MESSAGES_PER_HOUR: 2 });
    expect((await reserve('a1')).status).toBe('accepted');
    expect((await reserve('a2')).status).toBe('accepted');
    expect((await reserve('a3')).status).toBe('held');
    expect((await reserve('b1', 'other@example.test')).status).toBe('accepted');
  });

  it('holds over the hourly byte budget', async () => {
    const { reserve } = holding({ INBOUND_MAILBOX_BYTES_PER_HOUR: 100 });
    expect((await reserve('x1', 'a@example.test', 100)).status).toBe('accepted');
    expect((await reserve('x2', 'a@example.test', 50)).status).toBe('held');
  });

  it('still rejects when the storage quota is full (cannot be waived)', async () => {
    const { reserve } = holding({ MAILBOX_STORAGE_QUOTA_BYTES: 100 });
    expect((await reserve('q1', 'a@example.test', 100)).status).toBe('accepted');
    expect((await reserve('q2', 'a@example.test', 1)).status).toBe('rejected');
  });

  it('a missing or malformed hash key skips the per-sender limit instead of rejecting all mail', async () => {
    for (const key of [undefined, 'not-a-key']) {
      const { d1, sqlite } = migratedDatabase();
      sqlite.prepare("INSERT INTO mailboxes (id, address, type) VALUES ('mailbox-1', 'mailbox@example.test', 'shared')").run();
      const env = { DB: d1, ...LIMITS_OFF, INBOUND_SENDER_MESSAGES_PER_HOUR: 1, INBOUND_SENDER_HASH_KEY: key } as InboundGuardEnv;
      const input = { mailboxId: 'mailbox-1', senderAddress: 'a@example.test', messageBytes: 10 };
      const one = await reserveInboundDeliveryHolding(env, { ...input, deliveryKey: 'k1' });
      const two = await reserveInboundDeliveryHolding(env, { ...input, deliveryKey: 'k2' });
      expect(one).toMatchObject({ status: 'accepted', senderLimitSkipped: true });
      expect(two).toMatchObject({ status: 'accepted', senderLimitSkipped: true });
    }
  });

  it('a duplicate delivery is still a duplicate, even while held', async () => {
    const { reserve } = holding({ INBOUND_MAILBOX_MESSAGES_PER_HOUR: 1 });
    expect((await reserve('d1')).status).toBe('accepted');
    expect((await reserve('d2')).status).toBe('held');
    expect(await reserve('d2')).toEqual({ status: 'duplicate', reservationId: null });
  });
});

describe('holding with a broken hash key and a tripped mailbox limit', () => {
  it('holds (and notes the skipped sender limit) rather than rejecting', async () => {
    const { d1, sqlite } = migratedDatabase();
    sqlite.prepare("INSERT INTO mailboxes (id, address, type) VALUES ('mailbox-1', 'mailbox@example.test', 'shared')").run();
    const env = { DB: d1, ...LIMITS_OFF, INBOUND_MAILBOX_MESSAGES_PER_HOUR: 1, INBOUND_SENDER_MESSAGES_PER_HOUR: 5, INBOUND_SENDER_HASH_KEY: undefined } as InboundGuardEnv;
    const input = { mailboxId: 'mailbox-1', senderAddress: 'a@example.test', messageBytes: 10 };
    expect(await reserveInboundDeliveryHolding(env, { ...input, deliveryKey: 'k1' })).toMatchObject({ status: 'accepted', senderLimitSkipped: true });
    expect(await reserveInboundDeliveryHolding(env, { ...input, deliveryKey: 'k2' })).toMatchObject({ status: 'held', senderLimitSkipped: true });
  });
});
