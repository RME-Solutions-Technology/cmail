import { describe, expect, it } from 'vitest';
import { load } from './+page.server';

interface QueryCall { sql: string; binds: unknown[] }

function fakeDb(calls: QueryCall[]) {
  return {
    prepare(sql: string) {
      const statement = {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return statement;
        },
        async all() { return { results: [] }; },
        async first() {
          if (sql.includes('SUM(kind')) return { trace: 0, audit: 0, failures: 0, quarantined: 0 };
          return { total: 0 };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe('investigation loader query wiring', () => {
  it('binds every filtered value consistently for rows, count, and summary', async () => {
    const calls: QueryCall[] = [];
    const url = new URL(
      'https://mail.example.com/admin/investigate?q=alice&source=trace&direction=inbound&status=bounced&event=auth.sign_in&outcome=failures&from=2026-09-01&to=2026-09-12&page=2&pageSize=100',
    );
    const result = await load({
      url,
      platform: { env: { DB: fakeDb(calls) } as never },
    } as never);

    expect((result as { unavailable: boolean }).unavailable).toBe(false);
    expect(calls).toHaveLength(3);
    const filterBinds = ['trace', 'inbound', 'bounced', 'auth.sign_in', '2026-09-01 00:00:00', '2026-09-12 23:59:59', ...Array(7).fill('%alice%')];
    expect(calls[0].binds).toEqual([...filterBinds, 100, 100]);
    expect(calls[1].binds).toEqual(filterBinds);
    expect(calls[2].binds).toEqual(filterBinds);
    for (const call of calls.slice(0, 3)) {
      expect((call.sql.match(/\?/g) || []).length).toBe(call.binds.length);
    }
  });

  it('records each search in the audit log: the filters and a hash, never the text typed (contractor review S14)', async () => {
    const calls: QueryCall[] = [];
    await load({
      url: new URL('https://mail.example.com/admin/investigate?q=secret-name&source=trace'),
      platform: { env: { DB: fakeDb(calls) } as never },
      locals: { user: { id: 'manager-1', role: 'manager' } },
    } as never);
    const logged = calls.find((call) => call.sql.includes('INSERT INTO audit_log'));
    expect(logged).toBeTruthy();
    expect(logged!.binds.join(' ')).toContain('admin.investigate_search');
    expect(logged!.binds.join(' ')).not.toContain('secret-name');
    // A bare page view (no filters) is not logged.
    const quiet: QueryCall[] = [];
    await load({ url: new URL('https://mail.example.com/admin/investigate'), platform: { env: { DB: fakeDb(quiet) } as never }, locals: { user: { id: 'manager-1', role: 'manager' } } } as never);
    expect(quiet.some((call) => call.sql.includes('INSERT INTO audit_log'))).toBe(false);
  });
});
