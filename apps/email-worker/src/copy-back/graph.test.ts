import { describe, expect, it, vi } from 'vitest';
import { GraphError } from '../m365-sync/graph';
import { CopyBackGraphClient, COPYBACK_MARKER_PROPERTY } from './graph';

const USER = '00000000-0000-0000-0000-00000000a11c';

function client(reply: (url: string) => Response = () => Response.json({ value: [] })) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://login.microsoftonline.com/')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    return reply(url);
  });
  const graph = new CopyBackGraphClient({
    tenantId: '00000000-0000-0000-0000-000000000000',
    clientId: '00000000-0000-0000-0000-0000000000c1',
    clientSecret: 'test-secret',
    fetcher: fetcher as unknown as typeof fetch,
    sleep: async () => undefined,
  });
  return { graph, fetcher };
}

describe('copy-back Graph client', () => {
  it('builds a v1.0 marker filter with the named property and value', async () => {
    const { graph, fetcher } = client();
    expect(await graph.findCopy(USER, '00000000-0000-4000-8000-000000000001')).toBeNull();
    const url = new URL(String(fetcher.mock.calls.at(-1)![0]));
    expect(url.origin + url.pathname).toBe(`https://graph.microsoft.com/v1.0/users/${USER}/messages`);
    expect(url.searchParams.get('$filter')).toBe(
      `singleValueExtendedProperties/Any(ep: ep/id eq '${COPYBACK_MARKER_PROPERTY}' and ep/value eq '00000000-0000-4000-8000-000000000001')`,
    );
    expect(url.searchParams.get('$select')).toBe('id,isDraft');
  });

  it('refuses unsafe ids and folders before any request', async () => {
    const { graph, fetcher } = client();
    await expect(graph.findCopy('not-a-guid', 'x')).rejects.toBeInstanceOf(GraphError);
    await expect(graph.findCopy(USER, "x' or 1 eq 1")).rejects.toBeInstanceOf(GraphError);
    await expect(graph.createMessage(USER, 'drafts', '{}')).rejects.toBeInstanceOf(GraphError);
    await expect(graph.createMessage(`${USER}/../../me`, 'inbox', '{}')).rejects.toBeInstanceOf(GraphError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns the created id and rejects a malformed answer', async () => {
    const { graph } = client(() => Response.json({ id: 'ex-1', isDraft: false }, { status: 201 }));
    expect(await graph.createMessage(USER, 'inbox', '{}')).toEqual({ id: 'ex-1', isDraft: false });
    // No isDraft in the answer: unknown, which the caller treats as a draft.
    const silent = client(() => Response.json({ id: 'ex-2' }, { status: 201 }));
    expect(await silent.graph.createMessage(USER, 'inbox', '{}')).toEqual({ id: 'ex-2', isDraft: null });
    const bad = client(() => Response.json({ value: [{ id: 42 }] }));
    await expect(bad.graph.findCopy(USER, 'abc')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('keeps the status of a per-mailbox error so the caller can decide', async () => {
    const { graph } = client(() => Response.json({ error: { code: 'ErrorInvalidUser' } }, { status: 404 }));
    await expect(graph.findCopy(USER, 'abc')).rejects.toMatchObject({ code: 'http_error', status: 404 });
    const denied = client(() => Response.json({ error: { code: 'ErrorAccessDenied' } }, { status: 403 }));
    await expect(denied.graph.findCopy(USER, 'abc')).rejects.toMatchObject({ code: 'unauthorized', status: 403 });
  });
});
