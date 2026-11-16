import { describe, expect, it } from 'vitest';
import { PermsGraphClient } from './groups';

const GROUP = '00000000-0000-0000-cccc-000000000001';
const USER = (n: number) => `00000000-0000-0000-bbbb-${String(n).padStart(12, '0')}`;

function client(pages: unknown[]) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  let page = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/oauth2/v2.0/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    requests.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return Response.json(pages[page++]);
  }) as typeof fetch;
  const graph = new PermsGraphClient({ tenantId: '00000000-0000-0000-0000-000000000000', clientId: '11111111-1111-1111-1111-111111111111', clientSecret: 'x', fetcher });
  return { graph, requests };
}

describe('group expansion', () => {
  it('uses the user cast as an advanced query (ConsistencyLevel: eventual and $count=true) on every page', async () => {
    const next = `https://graph.microsoft.com/v1.0/groups/${GROUP}/transitiveMembers/microsoft.graph.user?$skiptoken=abc`;
    const { graph, requests } = client([
      { value: [{ id: USER(1) }], '@odata.nextLink': next },
      { value: [{ id: USER(2).toUpperCase() }, { id: 'not-a-guid' }] },
    ]);
    expect(await graph.transitiveUserMembers(GROUP)).toEqual([USER(1), USER(2)]);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(`https://graph.microsoft.com/v1.0/groups/${GROUP}/transitiveMembers/microsoft.graph.user?$select=id&$top=999&$count=true`);
    for (const request of requests) expect(request.headers.consistencylevel).toBe('eventual');
  });

  it('refuses a next link off Graph and a group id that is not a GUID', async () => {
    const { graph } = client([{ value: [], '@odata.nextLink': 'https://graph.example.test/next' }]);
    await expect(graph.transitiveUserMembers(GROUP)).rejects.toMatchObject({ code: 'bad_response' });
    await expect(graph.transitiveUserMembers('../users')).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('users by primary address', () => {
  it("escapes a quote in the OData literal and keeps Graph's case except for the id", async () => {
    const { graph, requests } = client([
      { value: [{ id: USER(1).toUpperCase(), mail: "O'Brien@Example.Test", userType: 'Member', accountEnabled: true, proxyAddresses: ["SMTP:O'Brien@Example.Test", 'smtp:ob@example.test'] }] },
    ]);
    expect(await graph.usersByMail("o'brien@example.test")).toEqual([
      { id: USER(1), mail: "O'Brien@Example.Test", userType: 'Member', accountEnabled: true, proxyAddresses: ["SMTP:O'Brien@Example.Test", 'smtp:ob@example.test'] },
    ]);
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe('/v1.0/users');
    expect(url.searchParams.get('$filter')).toBe("mail eq 'o''brien@example.test'");
    expect(url.searchParams.get('$select')).toBe('id,mail,userType,accountEnabled,proxyAddresses');
    expect(url.searchParams.get('$top')).toBe('2');
  });

  it('treats a next link with fewer than two users, or a bad id, as a bad answer, and refuses a blank address', async () => {
    const next = 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc';
    const one = client([{ value: [{ id: USER(1), mail: 'a@example.test' }], '@odata.nextLink': next }]);
    await expect(one.graph.usersByMail('a@example.test')).rejects.toMatchObject({ code: 'bad_response' });
    const two = client([{ value: [{ id: USER(1), mail: 'a@example.test' }, { id: USER(2), mail: 'a@example.test' }], '@odata.nextLink': next }]);
    expect(await two.graph.usersByMail('a@example.test')).toHaveLength(2);
    const bad = client([{ value: [{ id: 'not-a-guid', mail: 'a@example.test' }] }]);
    await expect(bad.graph.usersByMail('a@example.test')).rejects.toMatchObject({ code: 'bad_response' });
    await expect(client([]).graph.usersByMail('a b@example.test')).rejects.toMatchObject({ code: 'bad_response' });
  });
});
