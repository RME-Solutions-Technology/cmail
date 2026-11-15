// Test-only fake of the three Microsoft endpoints the sync uses: the token
// endpoint, users/delta and $batch (checkMemberGroups). Fixture data only:
// placeholder GUIDs and example.test addresses.
import { GRAPH_ROOT, INITIAL_DELTA_URL, type GraphUser } from '../graph';

export const TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const CLIENT_ID = '00000000-0000-0000-0000-000000000001';
export const SCOPE_GROUP = '00000000-0000-0000-0000-0000000000a1';
export const SHARED_GROUP = '00000000-0000-0000-0000-0000000000a2';
export const DOMAIN = 'example.test';

export const oid = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;

/** Public Microsoft service plan ids (licensing reference), not tenant data. */
export const PLAN_EXCHANGE_1 = '9aaf7827-d63c-4b61-89c3-182f06f82e5c';
export const PLAN_EXCHANGE_FOUNDATION = '113feb6c-3fe4-4440-bddc-54d774bf0318';
const EXCHANGE = [{ service: 'exchange', capabilityStatus: 'Enabled', servicePlanId: PLAN_EXCHANGE_1 }];

export function person(n: number, local: string, overrides: Partial<GraphUser> = {}): GraphUser {
  return {
    id: oid(n),
    displayName: `Person ${n}`,
    mail: `${local}@${DOMAIN}`,
    userPrincipalName: `${local}@${DOMAIN}`,
    accountEnabled: true,
    userType: 'Member',
    assignedPlans: EXCHANGE,
    ...overrides,
  };
}

export const removed = (n: number, reason: 'changed' | 'deleted' = 'deleted'): GraphUser => ({ id: oid(n), '@removed': { reason } });

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

export interface FakeGraph {
  fetch: typeof fetch;
  calls: string[];
  /** Pages for a full enumeration; the last one returns `deltaLink`. */
  setReconcile(pages: GraphUser[][], deltaToken?: string): void;
  /** Pages answered for a saved delta link. */
  setDelta(token: string, pages: GraphUser[][], nextToken: string): void;
  /** One-off replies for the next request to a URL (checked before pages). */
  queue(url: string, ...replies: Reply[]): void;
  memberships: Map<string, string[]>;
  tokenReplies: Reply[];
}

export function deltaUrl(token: string) {
  return `${GRAPH_ROOT}users/delta?$deltatoken=${token}`;
}

export function fakeGraph(): FakeGraph {
  const pages = new Map<string, Reply>();
  const queued = new Map<string, Reply[]>();
  const memberships = new Map<string, string[]>();
  const calls: string[] = [];
  const tokenReplies: Reply[] = [];

  function chain(start: string, data: GraphUser[][], prefix: string, finalToken: string) {
    data.forEach((value, index) => {
      const url = index === 0 ? start : `${GRAPH_ROOT}users/delta?$skiptoken=${prefix}-${index}`;
      const last = index === data.length - 1;
      pages.set(url, {
        status: 200,
        body: {
          value,
          ...(last
            ? { '@odata.deltaLink': deltaUrl(finalToken) }
            : { '@odata.nextLink': `${GRAPH_ROOT}users/delta?$skiptoken=${prefix}-${index + 1}` }),
        },
      });
    });
  }

  const respond = (reply: Reply) => new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json', ...reply.headers },
  });

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.startsWith('https://login.microsoftonline.com/')) {
      const next = tokenReplies.shift();
      return respond(next ?? { status: 200, body: { access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer' } });
    }
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== 'Bearer test-access-token') return respond({ status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } });
    const once = queued.get(url);
    if (once?.length) return respond(once.shift()!);
    if (url === `${GRAPH_ROOT}$batch`) {
      const body = JSON.parse(String(init?.body)) as { requests: Array<{ id: string; url: string; body: { groupIds: string[] } }> };
      return respond({
        status: 200,
        body: {
          responses: body.requests.map((request) => {
            const id = decodeURIComponent(request.url.split('/')[2]);
            const groups = memberships.get(id) ?? [];
            return { id: request.id, status: 200, body: { value: request.body.groupIds.filter((group) => groups.includes(group)) } };
          }),
        },
      });
    }
    const page = pages.get(url);
    if (page) return respond(page);
    return respond({ status: 404, body: { error: { code: 'Request_ResourceNotFound' } } });
  }) as typeof fetch;

  return {
    fetch: fetcher,
    calls,
    memberships,
    tokenReplies,
    setReconcile(data, deltaToken = 'delta-1') {
      chain(INITIAL_DELTA_URL, data, `full-${deltaToken}`, deltaToken);
    },
    setDelta(token, data, nextToken) {
      chain(deltaUrl(token), data, `delta-${token}`, nextToken);
    },
    queue(url, ...replies) {
      queued.set(url, [...(queued.get(url) ?? []), ...replies]);
    },
  };
}
