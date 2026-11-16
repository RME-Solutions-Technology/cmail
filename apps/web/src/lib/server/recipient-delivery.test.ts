import { describe, expect, it } from 'vitest';
import { exchangeHostedDomains, locallyDeliverable, planRecipientDelivery } from './recipient-delivery';

describe('recipient delivery planning', () => {
  it('keeps purely internal delivery on the direct local path', () => {
    expect(planRecipientDelivery(
      ['alice@example.com'],
      ['carol@example.com'],
      [],
      new Set(['alice@example.com', 'carol@example.com']),
    )).toEqual({
      externalRecipients: [],
      providerTo: [],
      providerCc: [],
      providerRecipients: [],
      localRecipients: ['alice@example.com', 'carol@example.com'],
    });
  });

  it('preserves To and Cc exactly for a mixed internal/external message', () => {
    expect(planRecipientDelivery(
      ['alice@example.com'],
      ['bob@example.net'],
      [],
      new Set(['alice@example.com']),
    )).toEqual({
      externalRecipients: ['bob@example.net'],
      providerTo: ['alice@example.com'],
      providerCc: ['bob@example.net'],
      providerRecipients: ['bob@example.net'],
      localRecipients: ['alice@example.com'],
    });
  });

  it('uses the provider for the complete visible list when any recipient is external', () => {
    expect(planRecipientDelivery(
      ['alice@example.com', 'bob@example.net'],
      ['carol@example.com', 'dave@example.net'],
      [],
      new Set(['alice@example.com', 'carol@example.com']),
    )).toMatchObject({
      externalRecipients: ['bob@example.net', 'dave@example.net'],
      providerTo: ['alice@example.com', 'bob@example.net'],
      providerCc: ['carol@example.com', 'dave@example.net'],
      providerRecipients: ['bob@example.net', 'dave@example.net'],
      localRecipients: ['alice@example.com', 'carol@example.com'],
    });
  });

  it('uses one all-recipient provider path when the transport cannot separate the envelope', () => {
    expect(planRecipientDelivery(
      ['alice@example.com'],
      ['bob@example.net'],
      [],
      new Set(['alice@example.com']),
      false,
    )).toEqual({
      externalRecipients: ['bob@example.net'],
      providerTo: ['alice@example.com'],
      providerCc: ['bob@example.net'],
      providerRecipients: ['alice@example.com', 'bob@example.net'],
      localRecipients: [],
    });
  });

  describe('Bcc', () => {
    it('keeps purely internal Bcc off the provider and out of every visible header', () => {
      expect(planRecipientDelivery(
        ['alice@example.com'],
        [],
        ['carol@example.com'],
        new Set(['alice@example.com', 'carol@example.com']),
      )).toEqual({
        externalRecipients: [],
        providerTo: [],
        providerCc: [],
        providerRecipients: [],
        localRecipients: ['alice@example.com', 'carol@example.com'],
      });
    });

    it('sends an external-only Bcc through the envelope without touching To/Cc', () => {
      expect(planRecipientDelivery(
        ['alice@example.com'],
        [],
        ['bob@example.net'],
        new Set(['alice@example.com']),
      )).toEqual({
        externalRecipients: [],
        providerTo: ['alice@example.com'],
        providerCc: [],
        providerRecipients: ['bob@example.net'],
        localRecipients: ['alice@example.com'],
      });
    });

    it('adds external Bcc to the envelope alongside visible external recipients', () => {
      expect(planRecipientDelivery(
        ['alice@example.com'],
        ['dana@example.net'],
        ['bob@example.net'],
        new Set(['alice@example.com']),
      )).toEqual({
        externalRecipients: ['dana@example.net'],
        providerTo: ['alice@example.com'],
        providerCc: ['dana@example.net'],
        providerRecipients: ['dana@example.net', 'bob@example.net'],
        localRecipients: ['alice@example.com'],
      });
    });

    it('delivers internal Bcc directly and never lumps it into providerTo/providerCc even without separated envelope', () => {
      expect(planRecipientDelivery(
        ['alice@example.com'],
        ['dana@example.net'],
        ['carol@example.com'],
        new Set(['alice@example.com', 'carol@example.com']),
        false,
      )).toEqual({
        externalRecipients: ['dana@example.net'],
        providerTo: ['alice@example.com'],
        providerCc: ['dana@example.net'],
        providerRecipients: ['alice@example.com', 'dana@example.net'],
        localRecipients: ['carol@example.com'],
      });
    });

    it('still routes external Bcc through the envelope when the transport cannot separate the visible envelope', () => {
      expect(planRecipientDelivery(
        ['alice@example.com'],
        [],
        ['bob@example.net'],
        new Set(['alice@example.com']),
        false,
      )).toEqual({
        externalRecipients: [],
        providerTo: ['alice@example.com'],
        providerCc: [],
        providerRecipients: ['alice@example.com', 'bob@example.net'],
        localRecipients: [],
      });
    });
  });
});

function switchDb(settings: Record<string, string> | Error) {
  const binds: unknown[][] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        binds.push([sql, ...args]);
        return {
          all: async () => {
            if (settings instanceof Error) throw settings;
            return { results: Object.entries(settings).filter(([key]) => args.includes(key)).map(([key, value]) => ({ key, value })) };
          },
        };
      },
    }),
  } as unknown as D1Database;
  return { db, binds };
}

const BOTH_ON = { exchange_mirror_enabled: 'true', exchange_mirror_colleague_send: 'true' };

describe('Exchange-hosted recipients (mirror and "Send colleague mail through Exchange" on)', () => {
  it('reads no domain as Exchange-hosted unless both switches are on (exactly today otherwise)', async () => {
    for (const settings of <Array<Record<string, string>>>[
      {},
      { exchange_mirror_enabled: 'true' },
      { exchange_mirror_colleague_send: 'true' },
      { exchange_mirror_enabled: 'true', exchange_mirror_colleague_send: 'false' },
      { exchange_mirror_enabled: 'false', exchange_mirror_colleague_send: 'true' },
    ]) {
      expect([...await exchangeHostedDomains(switchDb(settings).db, 'example.com')]).toEqual([]);
    }
  });

  it('reads the mail domain as Exchange-hosted while both switches are on', async () => {
    const { db, binds } = switchDb(BOTH_ON);
    expect([...await exchangeHostedDomains(db, 'example.com')]).toEqual(['example.com']);
    expect(binds[0]?.slice(1)).toEqual(['exchange_mirror_enabled', 'exchange_mirror_colleague_send']);
  });

  it('never reads the switches without a mail domain', async () => {
    const { db, binds } = switchDb(BOTH_ON);
    expect([...await exchangeHostedDomains(db, '')]).toEqual([]);
    expect(binds).toEqual([]);
  });

  it('passes a switch read failure to the caller (the send fails closed, never delivers locally by guess)', async () => {
    await expect(exchangeHostedDomains(switchDb(new Error('D1 down')).db, 'example.com')).rejects.toThrow('D1 down');
  });
  const rows = [
    { address: 'alice@example.com', id: 'm1' },
    { address: 'Carol@Example.com', id: 'm2' },
    { address: 'desk@example.org', id: 'm3' },
  ];

  it('keeps every mailbox local when no domain is Exchange-hosted (mirror off: unchanged)', () => {
    expect(locallyDeliverable(rows, new Set())).toEqual(rows);
  });

  it('drops mailboxes on an Exchange-hosted domain, case-insensitively, and keeps the rest', () => {
    expect(locallyDeliverable(rows, new Set(['example.com']))).toEqual([{ address: 'desk@example.org', id: 'm3' }]);
  });

  it('sends Exchange-hosted cmail mailboxes through the provider, keeping the visible headers', () => {
    const local = new Set(locallyDeliverable(rows, new Set(['example.com'])).map((row) => row.address));
    expect(planRecipientDelivery(
      ['alice@example.com'],
      ['desk@example.org'],
      [],
      local,
    )).toEqual({
      externalRecipients: ['alice@example.com'],
      providerTo: ['alice@example.com'],
      providerCc: ['desk@example.org'],
      providerRecipients: ['alice@example.com'],
      localRecipients: ['desk@example.org'],
    });
  });

  it('turns an all-internal send into a provider send when every recipient lives in Exchange', () => {
    const local = new Set(locallyDeliverable(rows.slice(0, 1), new Set(['example.com'])).map((row) => row.address));
    expect(planRecipientDelivery(['alice@example.com'], [], [], local)).toEqual({
      externalRecipients: ['alice@example.com'],
      providerTo: ['alice@example.com'],
      providerCc: [],
      providerRecipients: ['alice@example.com'],
      localRecipients: [],
    });
  });
});
