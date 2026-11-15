// Test-only: an in-memory stand-in for the collector Durable Object's HTTP
// surface (begin / result / discard), so the tick driver can be tested
// without containers. Fixtures use placeholder GUIDs and example.test only.
import type { PermissionSnapshot } from '../snapshot';

export const TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const ORGANIZATION = 'example.onmicrosoft.com';

export type FakeOutcome =
  | { kind: 'snapshot'; snapshot: PermissionSnapshot | string }
  | { kind: 'failed'; code: string }
  | { kind: 'running' }
  | { kind: 'begin_error' };

export function fakeCollector() {
  let outcome: FakeOutcome = { kind: 'failed', code: 'not_set' };
  const runs = new Map<string, FakeOutcome>();
  const calls: string[] = [];
  const stub = {
    async fetch(input: string, init?: RequestInit): Promise<Response> {
      const url = new URL(input);
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/begin') {
        if (outcome.kind === 'begin_error') return new Response('boom', { status: 500 });
        const body = JSON.parse(String(init?.body)) as { runId: string };
        runs.set(body.runId, outcome);
        return Response.json({ status: 'started' }, { status: 202 });
      }
      if (url.pathname === '/result') {
        const run = runs.get(url.searchParams.get('runId') ?? '');
        if (!run) return Response.json({ status: 'unknown' }, { status: 404 });
        if (run.kind === 'running') return Response.json({ status: 'running' });
        if (run.kind === 'failed') return Response.json({ status: 'failed', code: run.code });
        if (run.kind === 'snapshot') {
          const text = typeof run.snapshot === 'string' ? run.snapshot : JSON.stringify(run.snapshot);
          return new Response(text, { headers: { 'x-collector-status': 'done' } });
        }
        return Response.json({ status: 'unknown' }, { status: 404 });
      }
      if (url.pathname === '/discard') {
        runs.delete(url.searchParams.get('runId') ?? '');
        return Response.json({ status: 'ok' });
      }
      return new Response('Not found', { status: 404 });
    },
  };
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => stub,
  } as unknown as DurableObjectNamespace;
  return {
    namespace,
    calls,
    /** What the next begun run will produce. */
    setOutcome(next: FakeOutcome) { outcome = next; },
    /** Change what an already begun run reports. */
    setAll(next: FakeOutcome) { for (const id of runs.keys()) runs.set(id, next); outcome = next; },
  };
}

export const oid = (n: number, prefix = '0') => `00000000-0000-0000-0000-${prefix.repeat(1)}${String(n).padStart(11, '0')}`;

export function snapshotOf(
  mailboxes: PermissionSnapshot['mailboxes'],
  options: Partial<Pick<PermissionSnapshot, 'complete' | 'nextCursor' | 'mailboxCount' | 'collectedAt'>> = {},
): PermissionSnapshot {
  return {
    schema: 'cmail-exo-permissions',
    version: 1,
    tenantId: TENANT_ID,
    organization: ORGANIZATION,
    collectedAt: options.collectedAt ?? '2026-11-15T00:00:00.000Z',
    complete: options.complete ?? true,
    nextCursor: options.nextCursor ?? '',
    mailboxCount: options.mailboxCount ?? mailboxes.length,
    mailboxes,
    skipped: { inherited: 0, deny: 0, system: 0, orphaned: 0, unresolved: 0, otherKind: 0 },
    errors: [],
  };
}
