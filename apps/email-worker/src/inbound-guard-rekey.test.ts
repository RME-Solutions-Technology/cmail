import { describe, expect, it, vi } from 'vitest';

import {
  INBOUND_RATE_LIMIT_AUDIT_EVENT,
  recordInboundRateLimitAudit,
  rekeyInboundSenderToFrom,
  type InboundGuardEnv,
} from './inbound-guard';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const HASH_KEY = base64Url(new Uint8Array(32).fill(9));

/** A tiny model of the reservation ledger: just the rows, the re-key UPDATE and the count. */
class LedgerDb {
  readonly rows: Array<{ id: string; mailboxId: string; senderHash: string }> = [];
  failBatch = false;
  readonly batch = vi.fn();
  readonly prepare = vi.fn((query: string) => ({
    bind: (...values: unknown[]) => ({
      run: async () => {
        if (this.failBatch) throw new Error('D1 unavailable');
        const [first, id, mailboxId] = values as [string, string, string];
        if (query.includes("SET sender_hash = ''")) {
          const held = this.rows.find((candidate) => candidate.id === first && candidate.mailboxId === id);
          if (held) held.senderHash = '';
          return { meta: { changes: held ? 1 : 0 } };
        }
        const row = this.rows.find((candidate) => candidate.id === id && candidate.mailboxId === mailboxId);
        if (row) row.senderHash = first;
        this.batch();
        return { meta: { changes: row ? 1 : 0 } };
      },
      first: async () => {
        const [mailboxId, hash] = values as [string, string];
        return { total: this.rows.filter((candidate) => candidate.mailboxId === mailboxId && candidate.senderHash === hash).length };
      },
    }),
  }));

  /** One accepted delivery, keyed (as the first reservation is) on a rotating envelope sender. */
  accept(mailboxId: string, envelope: string): string {
    const id = `r-${this.rows.length}`;
    this.rows.push({ id, mailboxId, senderHash: `envelope:${envelope}`.padEnd(64, '0') });
    return id;
  }
}

function env(db: LedgerDb, extra: Partial<InboundGuardEnv> = {}): InboundGuardEnv {
  return { DB: db as unknown as D1Database, INBOUND_SENDER_HASH_KEY: HASH_KEY, ...extra };
}

describe('per-sender limit keyed on the DMARC-passed From address', () => {
  it('holds the message that passes the limit even when the envelope sender changes every time', async () => {
    const db = new LedgerDb();
    const results: string[] = [];
    for (let index = 0; index < 31; index += 1) {
      const id = db.accept('mb1', `bounce-${index}@evil.example`);
      results.push(await rekeyInboundSenderToFrom(env(db), {
        reservationId: id, mailboxId: 'mb1', fromAddress: 'Boss@Example.com', dmarc: 'pass',
      }));
    }
    expect(results.slice(0, 30).every((result) => result === 'ok')).toBe(true);
    expect(results[30]).toBe('over');
  });

  it('does not keep charging a held message, and treats plus-addressing as one sender', async () => {
    const db = new LedgerDb();
    let last = 'ok';
    for (let index = 0; index < 32; index += 1) {
      last = await rekeyInboundSenderToFrom(env(db), {
        reservationId: db.accept('mb1', `e${index}@evil.example`), mailboxId: 'mb1', fromAddress: `boss+${index}@example.com`, dmarc: 'pass',
      });
    }
    expect(last).toBe('over');
    // 30 stay counted; the two held ones were released from the sender's count.
    expect(db.rows.filter((row) => row.senderHash === '').length).toBe(2);
  });

  it('does not put every sender at one big provider in one bucket', async () => {
    const db = new LedgerDb();
    for (let index = 0; index < 40; index += 1) {
      const id = db.accept('mb1', `x${index}@gmail.com`);
      expect(await rekeyInboundSenderToFrom(env(db), {
        reservationId: id, mailboxId: 'mb1', fromAddress: `person${index}@gmail.com`, dmarc: 'pass',
      })).toBe('ok');
    }
  });

  it('keeps one mailbox from using another mailbox allowance', async () => {
    const db = new LedgerDb();
    for (let index = 0; index < 30; index += 1) {
      await rekeyInboundSenderToFrom(env(db), {
        reservationId: db.accept('mb1', `a${index}@x.example`), mailboxId: 'mb1', fromAddress: 'a@x.example', dmarc: 'pass',
      });
    }
    expect(await rekeyInboundSenderToFrom(env(db), {
      reservationId: db.accept('mb2', 'a@x.example'), mailboxId: 'mb2', fromAddress: 'a@x.example', dmarc: 'pass',
    })).toBe('ok');
  });

  it.each([['fail'], ['none'], ['softfail'], [null]])('ignores a From that did not pass DMARC (%s): a forged From cannot move or frame anyone', async (dmarc) => {
    const db = new LedgerDb();
    const id = db.accept('mb1', 'x@evil.example');
    const before = db.rows[0].senderHash;
    expect(await rekeyInboundSenderToFrom(env(db), { reservationId: id, mailboxId: 'mb1', fromAddress: 'ceo@victim.example', dmarc })).toBe('skipped');
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.rows[0].senderHash).toBe(before);
  });

  it('skips when there is no usable From, no reservation, or the per-sender limit is off', async () => {
    const db = new LedgerDb();
    const id = db.accept('mb1', 'x@evil.example');
    for (const fromAddress of ['', '   ', 'not-an-address']) {
      expect(await rekeyInboundSenderToFrom(env(db), { reservationId: id, mailboxId: 'mb1', fromAddress, dmarc: 'pass' })).toBe('skipped');
    }
    expect(await rekeyInboundSenderToFrom(env(db), { reservationId: null, mailboxId: 'mb1', fromAddress: 'a@b.example', dmarc: 'pass' })).toBe('skipped');
    expect(await rekeyInboundSenderToFrom(env(db, { INBOUND_SENDER_MESSAGES_PER_HOUR: 0 }), { reservationId: id, mailboxId: 'mb1', fromAddress: 'a@b.example', dmarc: 'pass' })).toBe('skipped');
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('stays on the first (envelope) key and never goes unlimited when the key or the database is unavailable', async () => {
    const db = new LedgerDb();
    const id = db.accept('mb1', 'x@evil.example');
    const before = db.rows[0].senderHash;
    expect(await rekeyInboundSenderToFrom(env(db, { INBOUND_SENDER_HASH_KEY: 'short' }), { reservationId: id, mailboxId: 'mb1', fromAddress: 'a@b.example', dmarc: 'pass' })).toBe('skipped');
    db.failBatch = true;
    expect(await rekeyInboundSenderToFrom(env(db), { reservationId: id, mailboxId: 'mb1', fromAddress: 'a@b.example', dmarc: 'pass' })).toBe('skipped');
    expect(db.rows[0].senderHash).toBe(before);
  });
});

describe('one audit row per mailbox per hour when a limit holds mail', () => {
  function auditDb(changes: number | Error) {
    const run = vi.fn(async () => {
      if (changes instanceof Error) throw changes;
      return { meta: { changes } };
    });
    const bind = vi.fn((..._values: unknown[]) => ({ run }));
    const prepare = vi.fn((_query: string) => ({ bind }));
    return { db: { prepare } as unknown as D1Database, prepare, bind, run };
  }

  it('writes to the existing audit_log table only, guarded so a flood writes one row an hour', async () => {
    const { db, prepare, bind } = auditDb(1);
    expect(await recordInboundRateLimitAudit(db, 'mb1', 'mailbox')).toBe(true);
    const sql = String(prepare.mock.calls[0][0]);
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("datetime('now', '-1 hour')");
    const bound = bind.mock.calls[0];
    expect(bound).toContain(INBOUND_RATE_LIMIT_AUDIT_EVENT);
    expect(bound).toContain('mb1');
    expect(bound.join(' ')).not.toMatch(/@/);
  });

  it('reports false when an hour already has a row, and never throws on a database error', async () => {
    expect(await recordInboundRateLimitAudit(auditDb(0).db, 'mb1', 'x')).toBe(false);
    expect(await recordInboundRateLimitAudit(auditDb(new Error('D1 down')).db, 'mb1', 'x')).toBe(false);
  });
});
