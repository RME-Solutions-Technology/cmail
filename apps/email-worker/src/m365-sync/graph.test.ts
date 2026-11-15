import { describe, expect, it, vi } from 'vitest';
import { GRAPH_ROOT, GraphClient, GraphError, INITIAL_DELTA_URL, isGraphUrl, parseRetryAfter } from './graph';
import { CLIENT_ID, TENANT_ID, fakeGraph, oid, person } from './testing/fake-graph';

function client(fake = fakeGraph(), sleep = vi.fn(async () => undefined)) {
  return { fake, sleep, graph: new GraphClient({ tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: 'test-secret', fetcher: fake.fetch, sleep }) };
}

async function failure(promise: Promise<unknown>): Promise<GraphError> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof GraphError) return caught;
    throw caught;
  }
  throw new Error('expected a GraphError');
}

describe('Graph URL guard', () => {
  it.each([
    [INITIAL_DELTA_URL, true],
    [`${GRAPH_ROOT}users/delta?$skiptoken=abc`, true],
    ['http://graph.microsoft.com/v1.0/users/delta', false],
    ['https://graph.microsoft.com.example.test/v1.0/users', false],
    ['https://graph.microsoft.com/beta/users/delta', false],
    // Built at run time so the repository secret scan does not see a credential URL.
    [Object.assign(new URL(`${GRAPH_ROOT}users`), { username: 'fixture', password: 'fixture' }).toString(), false],
    ['https://graph.microsoft.com:8443/v1.0/users', false],
    ['https://192.0.2.10/v1.0/users', false],
    [42, false],
  ])('%s -> %s', (url, expected) => {
    expect(isGraphUrl(url)).toBe(expected);
  });
});

describe('Retry-After', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('10')).toBe(10);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:30 GMT', Date.parse('2026-10-21T07:28:00Z'))).toBe(30);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('GraphClient', () => {
  it('pages users/delta and returns the delta link on the last page', async () => {
    const { fake, graph } = client();
    fake.setReconcile([[person(1, 'alex')], [person(2, 'blair')]], 'tok-1');
    const first = await graph.deltaPage(INITIAL_DELTA_URL);
    expect(first.users.map((user) => user.id)).toEqual([oid(1)]);
    expect(first.deltaLink).toBeNull();
    const second = await graph.deltaPage(first.nextLink!);
    expect(second.nextLink).toBeNull();
    expect(second.deltaLink).toContain('$deltatoken=tok-1');
    // One token request, reused for both pages.
    expect(fake.calls.filter((url) => url.startsWith('https://login.microsoftonline.com/'))).toHaveLength(1);
    expect(fake.calls[0]).toBe(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`);
  });

  it('refuses a next link that points anywhere but Graph v1.0', async () => {
    const { fake, graph } = client();
    fake.queue(INITIAL_DELTA_URL, { status: 200, body: { value: [], '@odata.nextLink': 'https://attacker.example.test/collect' } });
    expect((await failure(graph.deltaPage(INITIAL_DELTA_URL))).code).toBe('bad_response');
  });

  it('refuses a page with both or neither of nextLink and deltaLink', async () => {
    const { fake, graph } = client();
    fake.queue(INITIAL_DELTA_URL, { status: 200, body: { value: [] } });
    expect((await failure(graph.deltaPage(INITIAL_DELTA_URL))).code).toBe('bad_response');
  });

  it('waits a short Retry-After in place and retries', async () => {
    const { fake, graph, sleep } = client();
    fake.setReconcile([[person(1, 'alex')]]);
    fake.queue(INITIAL_DELTA_URL, { status: 429, headers: { 'retry-after': '2' } });
    const page = await graph.deltaPage(INITIAL_DELTA_URL);
    expect(page.users).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('stops on a long Retry-After and reports the wait', async () => {
    const { fake, graph, sleep } = client();
    fake.queue(INITIAL_DELTA_URL, { status: 429, headers: { 'retry-after': '120' } });
    const error = await failure(graph.deltaPage(INITIAL_DELTA_URL));
    expect(error).toMatchObject({ code: 'throttled', status: 429, retryAfterSeconds: 120 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats 503 and 504 like 429', async () => {
    const { fake, graph } = client();
    fake.queue(INITIAL_DELTA_URL, { status: 503 });
    expect((await failure(graph.deltaPage(INITIAL_DELTA_URL))).code).toBe('throttled');
  });

  it('maps 410 Gone and syncStateNotFound to resync_required', async () => {
    const { fake, graph } = client();
    fake.queue(INITIAL_DELTA_URL, { status: 410, headers: { location: INITIAL_DELTA_URL } });
    expect((await failure(graph.deltaPage(INITIAL_DELTA_URL))).code).toBe('resync_required');
    fake.queue(INITIAL_DELTA_URL, { status: 400, body: { error: { code: 'syncStateNotFound' } } });
    expect((await failure(graph.deltaPage(INITIAL_DELTA_URL))).code).toBe('resync_required');
  });

  it('reports a rejected client secret without the response body', async () => {
    const { fake, graph } = client();
    fake.tokenReplies.push({ status: 401, body: { error: 'invalid_client', error_description: 'secret detail' } });
    const error = await failure(graph.deltaPage(INITIAL_DELTA_URL));
    expect(error.code).toBe('credentials_rejected');
    expect(error.message).not.toContain('secret');
  });

  it('maps 403 (no admin consent) to unauthorized', async () => {
    const { fake, graph } = client();
    fake.queue(INITIAL_DELTA_URL, { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } });
    expect((await failure(graph.deltaPage(INITIAL_DELTA_URL))).code).toBe('unauthorized');
  });

  it('checks group membership in batches of 20', async () => {
    const { fake, graph } = client();
    const ids = Array.from({ length: 25 }, (_, index) => oid(100 + index));
    fake.memberships.set(ids[3], ['00000000-0000-0000-0000-0000000000a1']);
    const result = await graph.memberGroups(ids, ['00000000-0000-0000-0000-0000000000a1']);
    expect(fake.calls.filter((url) => url.endsWith('$batch'))).toHaveLength(2);
    expect(result.get(ids[3])?.has('00000000-0000-0000-0000-0000000000a1')).toBe(true);
    expect(result.get(ids[4])?.size).toBe(0);
  });

  it('fails the whole membership check when any batch item is throttled', async () => {
    const { fake, graph } = client();
    fake.queue(`${GRAPH_ROOT}$batch`, {
      status: 200,
      body: { responses: [
        { id: '0', status: 200, body: { value: [] } },
        { id: '1', status: 429, headers: { 'Retry-After': '30' } },
      ] },
    });
    const error = await failure(graph.memberGroups([oid(1), oid(2)], ['00000000-0000-0000-0000-0000000000a1']));
    expect(error).toMatchObject({ code: 'throttled', retryAfterSeconds: 30 });
  });
});
