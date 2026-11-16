import { describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from './mcp/testing/harness';
import { callTool, connect } from './mcp/testing/flow';

// "Send colleague mail through Exchange" (docs/exchange-mirror.md) through the
// real send path (the MCP tools call the compose action), against every real
// migration, with a fake Cloudflare Email Sending service binding.

function withProvider(): { fixture: Fixture; sent: Array<{ to: string[]; cc?: string[] }> } {
  const sent: Array<{ to: string[]; cc?: string[] }> = [];
  const service = {
    async fetch(_url: string, init: RequestInit) {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ success: true, messageId: `cf-${sent.length}` });
    },
  };
  return { fixture: createFixture({ OUTBOUND_PROVIDER: 'cloudflare', EMAIL_SERVICE: service }), sent };
}

function setSwitches(fixture: Fixture, mirror: boolean, colleagueSend: boolean): void {
  const put = fixture.db.sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  put.run('exchange_mirror_enabled', String(mirror));
  put.run('exchange_mirror_colleague_send', String(colleagueSend));
}

const inbox = (fixture: Fixture, mailboxId: string) =>
  (fixture.db.sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ? AND folder = 'inbox'").get(mailboxId) as { n: number }).n;

const send = async (fixture: Fixture) => {
  const { tokens } = await connect(fixture, { scopes: ['mail.send'] });
  return callTool(fixture, tokens.access_token, 'send_message', { from: 'alice@example.test', to: ['bob@example.test'], subject: 'Hi', body: 'x' });
};

describe('Send colleague mail through Exchange', () => {
  it('is off by default and with the mirror alone: the colleague copy is local, nothing goes to the provider', async () => {
    for (const [mirror, colleague] of [[false, false], [true, false], [false, true]] as const) {
      const { fixture, sent } = withProvider();
      setSwitches(fixture, mirror, colleague);
      const result = await send(fixture);
      expect(result.isError, result.text).toBe(false);
      expect(inbox(fixture, 'mb-bob')).toBe(1);
      expect(sent).toEqual([]);
    }
  });

  it('with the mirror and the switch on, sends the colleague through the provider and files no local copy', async () => {
    const { fixture, sent } = withProvider();
    setSwitches(fixture, true, true);
    const result = await send(fixture);
    expect(result.isError, result.text).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['bob@example.test']);
    expect(inbox(fixture, 'mb-bob')).toBe(0);
    expect(fixture.db.sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = 'mb-alice' AND folder = 'sent'").get()).toEqual({ n: 1 });
  });

  it('fails the send with the draft kept when the switches cannot be read (503), delivering nothing', async () => {
    const { fixture, sent } = withProvider();
    const real = fixture.env.DB as D1Database;
    // Only the colleague-send switch read fails; everything else is the real database.
    fixture.env.DB = {
      ...real,
      prepare: (sql: string) => {
        const statement = real.prepare(sql);
        const bind = statement.bind.bind(statement);
        return Object.assign(statement, {
          bind: (...args: unknown[]) => {
            if (args.includes('exchange_mirror_colleague_send')) {
              return { all: async () => { throw new Error('D1 unavailable'); } } as unknown as D1PreparedStatement;
            }
            return bind(...args);
          },
        });
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    const result = await send(fixture);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Delivery settings are temporarily unavailable');
    expect(sent).toEqual([]);
    expect(inbox(fixture, 'mb-bob')).toBe(0);
  });
});
